import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseFlight, resolveFlight, flightFromHtml } from '../src/flight.mjs';
import { buildReport, discoverActions, inspectPage } from '../src/site.mjs';
import { WeatherClient, retryAfter } from '../src/http.mjs';
import { cycle, run } from '../src/runner.mjs';
import { readJson, writePrivate } from '../src/storage.mjs';

function pageModel() {
  return {
    authenticated: true, login: 'test-account', context: { sk: 'test-csrf' },
    form: {
      shouldHideReportFormFromServer: false, isUserRegion: true,
      reports: { positive: { text: 'Да', isWet: true } },
      variants: { negative: [null, { text: 'Ясно', cloudiness: 'CLEAR' }] },
      fact: { temperature: 3, precType: 'SLEET', precStrength: 'WEAK', cloudiness: 'PARTLY' },
      nowcastStep: { genTime: 42 }, userLocation: { lat: 0, lon: 0 },
      meta: { reportFrom: 'main' }, weatherApiExps: 'experiments=test',
    },
    progress: { totalReports: 20, unlocked: [], calendar: [] },
  };
}

test('CLI reports inaccessible file path without its contents', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weather-permissions-'));
  const path = join(dir, 'config.json');
  try {
    await writePrivate(path, { secret: 'must-not-be-logged' });
    await chmod(path, 0o000);
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), 'status'], {
      env: { ...process.env, WEATHER_CONFIG: path }, encoding: 'utf8', timeout: 10000,
    });
    assert.equal(result.status, 2);
    const message = JSON.parse(result.stdout);
    assert.equal(message.reason, 'EACCES');
    assert.equal(message.path, path);
    assert.equal(message.operation, 'open');
    assert.equal(result.stdout.includes('must-not-be-logged'), false);
  } finally {
    await chmod(path, 0o600);
    await rm(dir, { recursive: true });
  }
});

test('permission errors stop the runner without retries masking the cause', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weather-permissions-run-'));
  try {
    const error = Object.assign(new Error('permission denied'), { code: 'EACCES', path: 'session.json', syscall: 'open' });
    const client = { loadPage: async () => { throw error; } };
    await assert.rejects(run(client, { stateFile: join(dir, 'state.json') }, new AbortController().signal,
      () => assert.fail('Permission errors must not enter backoff')), value => value === error);
  } finally { await rm(dir, { recursive: true }); }
});

test('Flight resolves promises, element prop paths and UTF-8 byte-framed text', () => {
  const value = 'дождь\n';
  const wire = `:HL["asset"]\n0:{"a":"$@1"}\n1:{"data":"$2:props:value"}\n2:["$","$L9",null,{"value":"$3"}]\n3:T${Buffer.byteLength(value).toString(16)},${value}4:{"other":true}\n`;
  const records = parseFlight(wire);
  assert.deepEqual(resolveFlight(records.get('0').a, records), { data: value });
  assert.deepEqual(records.get('4'), { other: true });
});

test('Flight rejects malformed text lengths without hanging', () => {
  const malformed = [
    '0:T-6,', '0:T-1,a', '0:T+1,a', '0:T,', '0:T 1,a', '0:T1 ,a',
    '0:T1g,a', '0:T0x1,a', '0:T1.5,a', '0:T20000000000000,',
    `0:T${'f'.repeat(300)},`, '0:T1', '0:T2,a',
  ];
  // A synchronous parser loop cannot be interrupted by a node:test timeout.
  const source = `
    import assert from 'node:assert/strict';
    import { parseFlight } from ${JSON.stringify(new URL('../src/flight.mjs', import.meta.url).href)};
    for (const wire of ${JSON.stringify(malformed)}) {
      assert.throws(() => parseFlight(wire), /Invalid Flight text length|Incomplete Flight text record/);
    }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    encoding: 'utf8', timeout: 5000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('Flight accepts empty text and uppercase hex lengths before adjacent records', () => {
  const records = parseFlight('0:T0,1:TA,01234567892:{"ok":true}\n');
  assert.equal(records.get('0'), '');
  assert.equal(records.get('1'), '0123456789');
  assert.deepEqual(records.get('2'), { ok: true });
});

test('Flight error, missing data, and cyclic references fail closed', () => {
  assert.throws(() => resolveFlight('$@1', parseFlight('0:{"a":"$@1"}\n1:E{"digest":"private"}\n')));
  assert.throws(() => resolveFlight('$9', new Map()));
  assert.throws(() => resolveFlight('$1', new Map([['1', '$1']])));
});

test('HTML extraction joins split Flight chunks', () => {
  const chunks = ['0:{"a":', '123}\n'];
  const html = chunks.map(c => `<script>self.__next_f.push(${JSON.stringify([1, c])})</script>`).join('');
  assert.equal(flightFromHtml(html).get('0').a, 123);
});

test('page inspection follows route and location references without traversing children', () => {
  const form = pageModel().form;
  const wire = [
    '0:{"f":[[["",{}]]]}',
    '1:["$","$L1",null,{"csrfToken":"test-csrf","children":"$1"}]',
    '2:["$","$L2",null,{"page":"main","routeParams":{"localeRoute":"ru"},"searchParams":{}}]',
    '3:["$","$L3",null,{"yandexLogin":"test-account"}]',
    '4:["$","$L4",null,{"initialTotalReports":20,"initialCollections":[],"initialCalendar":[]}]',
    `5:["$","$L5",null,${JSON.stringify(form)}]`,
  ].join('\n') + '\n';
  const html = `<script>self.__next_f.push(${JSON.stringify([1, wire])})</script>`;
  const page = inspectPage(html);
  assert.equal(page.authenticated, true);
  assert.equal(page.progress.totalReports, 20);
  assert.equal(page.form.userLocation.lat, 0);
});

test('report mappings match web client, including sleet at +3 and PARTLY remapping', () => {
  const payload = buildReport(pageModel(), 'confirm');
  assert.equal(payload.user_prec_type, 2);
  assert.equal(payload.cloudiness, 1);
  assert.equal(payload.user_cloudiness, 2);
  assert.equal(payload.prec_strength, 1);
  assert.equal(payload.precision, 15000);
  assert.equal(buildReport(pageModel(), 'Ясно').user_cloudiness, 0);
});

test('report cannot be built for unauthenticated, wrong-region, or hidden form', () => {
  const page = pageModel();
  assert.throws(() => buildReport({ ...page, authenticated: false }, 'random'), /AUTH_REQUIRED/);
  page.form.isUserRegion = false;
  assert.throws(() => buildReport(page, 'random'), /FORM_UNAVAILABLE/);
  page.form.isUserRegion = true;
  page.form.shouldHideReportFormFromServer = true;
  assert.throws(() => buildReport(page, 'random'), /FORM_UNAVAILABLE/);
});

test('action discovery follows current bundle identifiers', () => {
  assert.deepEqual(discoverActions('let x=(0,r.createServerReference)("40abc",r.callServer,void 0,r.findSourceMapURL,"userReport");'), { userReport: '40abc' });
});

test('Retry-After accepts seconds and HTTP date', () => {
  assert.equal(retryAfter('120'), 120);
  assert.equal(retryAfter('Thu, 01 Jan 1970 00:02:00 GMT', 0), 120);
  assert.equal(retryAfter('invalid'), null);
});

test('HTTP cookies stay scoped, redirects do not leak session to other hosts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weather-http-'));
  try {
    const config = { sessionFile: join(dir, 'session.json') };
    const requests = [];
    const client = new WeatherClient(config, null, async (url, options) => {
      requests.push({ url, cookie: options.headers.cookie });
      return new Response('ok', { headers: url.includes('yandex.ru') ? { 'set-cookie': 'session=test; Path=/; Secure; HttpOnly' } : {} });
    });
    await client.request('https://yandex.ru/pogoda/ru');
    await client.request('https://weather.yastatic.net/script.js');
    assert.equal(requests[1].cookie, undefined);
    if (process.platform !== 'win32') assert.equal((await stat(config.sessionFile)).mode & 0o777, 0o600);
    client.fetch = async () => new Response(null, { status: 302, headers: { location: 'https://example.org/' } });
    await assert.rejects(client.request('https://yandex.ru/pogoda/ru'), /UNEXPECTED_REDIRECT/);
  } finally { await rm(dir, { recursive: true }); }
});

test('failed POST persists a ten-minute pause across restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weather-state-'));
  try {
    const config = { stateFile: join(dir, 'state.json'), checkIntervalSeconds: 600, afterReportSeconds: 600, answer: 'confirm' };
    let submissions = 0;
    const client = {
      loadPage: async () => pageModel(),
      collection: async () => ({ totalReports: 20, unlocked: [] }),
      action: async () => { submissions++; throw new Error('timeout'); },
    };
    await assert.rejects(cycle(client, config, { send: true, now: () => 1000 }), /timeout/);
    const state = await readJson(config.stateFile);
    assert.equal(state.status, 'SUBMISSION_PENDING');
    assert.equal(state.nextSendAt, 601000);
    assert.equal((await cycle(client, config, { send: true, now: () => 2000 })).status, 'WAIT');
    assert.equal((await cycle(client, config, { send: true, now: () => 600999 })).status, 'WAIT');
    assert.equal(submissions, 1);
    await assert.rejects(cycle(client, config, { send: true, now: () => 601000 }), /timeout/);
    assert.equal(submissions, 2);
  } finally { await rm(dir, { recursive: true }); }
});

test('HTTP success without increased counter is not credited', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weather-counter-'));
  try {
    const config = { stateFile: join(dir, 'state.json'), checkIntervalSeconds: 900, afterReportSeconds: 3600, answer: 'confirm' };
    const client = { loadPage: async () => pageModel(), collection: async () => ({ totalReports: 20, unlocked: [], calendarState: null }), action: async () => ({}) };
    assert.equal((await cycle(client, config, { send: true })).status, 'NOT_CREDITED');
    await writePrivate(config.stateFile, {});
    let calls = 0;
    client.collection = async () => ({ totalReports: calls++ ? 21 : 20, unlocked: calls === 2 ? [{ id: 5, title: 'Листва' }] : [], calendarState: null });
    const result = await cycle(client, config, { send: true });
    assert.equal(result.status, 'CREDITED');
    assert.equal(result.newSkins.length, 1);
  } finally { await rm(dir, { recursive: true }); }
});
