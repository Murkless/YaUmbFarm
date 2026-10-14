import { CookieJar } from 'tough-cookie';
import { inspectPage, discoverActions, normalizeProgress } from './site.mjs';
import { parseFlight, resolveFlight } from './flight.mjs';
import { readJson, writePrivate } from './storage.mjs';

export function retryAfter(value, now = Date.now()) {
  if (!value) return null;
  const seconds = /^\d+$/.test(value) ? Number(value) : (Date.parse(value) - now) / 1000;
  return Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : null;
}

export class HttpFailure extends Error {
  constructor(code, delaySeconds = null) {
    super(code); this.code = code; this.delaySeconds = delaySeconds;
  }
}

export class WeatherClient {
  constructor(config, session, fetchImpl = fetch) {
    this.config = config;
    this.jar = session?.jar ? CookieJar.fromJSON(session.jar) : new CookieJar();
    this.userAgent = session?.userAgent ?? 'Mozilla/5.0';
    this.fetch = fetchImpl;
    this.actionCache = new Map();
  }

  static async create(config) {
    return new WeatherClient(config, await readJson(config.sessionFile, null));
  }

  async saveSession() {
    await writePrivate(this.config.sessionFile, { userAgent: this.userAgent, jar: this.jar.toJSON() });
  }

  async request(url, options = {}) {
    let current = new URL(url);
    let method = options.method ?? 'GET';
    let body = options.body;
    for (let redirects = 0; redirects < 6; redirects++) {
      const asset = current.origin === 'https://weather.yastatic.net';
      if (!asset && current.origin !== 'https://yandex.ru') throw new HttpFailure('UNEXPECTED_REDIRECT');
      const cookie = await this.jar.getCookieString(current.href);
      const response = await this.fetch(current.href, {
        ...options, method, body, redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
        headers: { 'user-agent': this.userAgent, ...options.headers, ...(cookie ? { cookie } : {}) },
      });
      for (const item of response.headers.getSetCookie()) await this.jar.setCookie(item, current.href);
      await this.saveSession();
      if (response.status === 429) throw new HttpFailure('RATE_LIMITED', retryAfter(response.headers.get('retry-after')) ?? 3600);
      if ([401, 403].includes(response.status)) throw new HttpFailure('AUTH_OR_CHALLENGE');
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = new URL(response.headers.get('location'), current);
        if (method === 'POST') throw new HttpFailure('ACTION_REDIRECT');
        current = next;
        await response.body?.cancel();
        continue;
      }
      if (!response.ok) throw new HttpFailure(`HTTP_${response.status}`, retryAfter(response.headers.get('retry-after')));
      return response;
    }
    throw new HttpFailure('TOO_MANY_REDIRECTS');
  }

  async loadPage() {
    const response = await this.request(this.config.pageUrl);
    const html = await response.text();
    let page;
    try { page = inspectPage(html); }
    catch { throw new HttpFailure('PAGE_CHANGED_OR_CHALLENGE'); }
    const actions = {};
    for (const url of page.scripts) {
      if (new URL(url).origin !== 'https://weather.yastatic.net') continue;
      let found = this.actionCache.get(url);
      if (!found) {
        found = discoverActions(await (await this.request(url)).text());
        this.actionCache.set(url, found);
      }
      Object.assign(actions, found);
      if (actions.userReport && actions.getReportsConfigClient) break;
    }
    if (!actions.userReport || !actions.getReportsConfigClient) throw new HttpFailure('ACTIONS_CHANGED');
    return { ...page, actions };
  }

  async action(page, name, argument) {
    const response = await this.request(this.config.pageUrl, {
      method: 'POST',
      headers: {
        accept: 'text/x-component', 'content-type': 'text/plain;charset=UTF-8',
        'next-action': page.actions[name],
        'next-router-state-tree': encodeURIComponent(JSON.stringify(page.routerTree)),
        origin: 'https://yandex.ru', referer: this.config.pageUrl,
      },
      body: JSON.stringify([argument]),
    });
    if (response.headers.get('x-nextjs-action-not-found') === '1') throw new HttpFailure('ACTION_CHANGED');
    if (response.headers.has('x-action-redirect')) throw new HttpFailure('ACTION_REDIRECT');
    if (!response.headers.get('content-type')?.startsWith('text/x-component')) {
      throw new HttpFailure('UNEXPECTED_ACTION_RESPONSE');
    }
    const records = parseFlight(await response.text());
    const result = resolveFlight(records.get('0')?.a, records);
    if (result?.errors?.length) throw new HttpFailure('ACTION_REJECTED');
    return result;
  }

  async collection(page, afterReport = false) {
    const result = await this.action(page, 'getReportsConfigClient', {
      ...page.context, afterReport, is404: false,
    });
    if (!result?.data) throw new HttpFailure('COLLECTION_RESPONSE_CHANGED');
    return normalizeProgress(result.data);
  }
}
