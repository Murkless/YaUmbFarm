import { CookieJar, Cookie } from 'tough-cookie';

export async function sessionFromCookies(cookies, userAgent) {
  const jar = new CookieJar();
  for (const item of cookies) {
    const host = item.domain.replace(/^\./, '').toLowerCase();
    if (host !== 'yandex.ru' && !host.endsWith('.yandex.ru')) continue;
    const cookie = new Cookie({ key: item.name, value: item.value, domain: host,
      hostOnly: !item.domain.startsWith('.'), path: item.path, secure: item.secure,
      httpOnly: item.httpOnly, sameSite: item.sameSite?.toLowerCase(),
      ...(item.expires > 0 ? { expires: new Date(item.expires * 1000) } : {}),
    });
    await jar.setCookie(cookie, `https://${host}${item.path}`);
  }
  return { userAgent, jar: jar.toJSON() };
}
