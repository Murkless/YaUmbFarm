import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { loadConfig, writePrivate } from './storage.mjs';
import { acquireLock } from './lock.mjs';
import { launchBrowser } from './browser.mjs';
import { sessionFromCookies } from './login-session.mjs';

let browser, release;
const abort = new AbortController();
const interrupted = () => abort.abort();
process.once('SIGINT', interrupted);
process.once('SIGTERM', interrupted);
try {
  const config = await loadConfig();
  release = await acquireLock(`${config.sessionFile}.lock`);
  browser = await launchBrowser({ signal: abort.signal });
  browser.closed.then(() => abort.abort());
  const url = new URL('https://passport.yandex.ru/auth');
  url.searchParams.set('retpath', config.pageUrl);
  await browser.cdp.send('Target.createTarget', { url: url.href });
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    await prompt.question('Выполните вход в открывшемся браузере, вернитесь на страницу Яндекс Погоды и нажмите Enter. ', { signal: abort.signal });
  } finally { prompt.close(); }
  const { targetInfos } = await browser.cdp.send('Target.getTargets');
  const weatherTab = targetInfos.some(target => {
    if (target.type !== 'page') return false;
    try {
      const page = new URL(target.url);
      return page.origin === 'https://yandex.ru' && page.pathname.startsWith('/pogoda/ru');
    } catch { return false; }
  });
  if (!weatherTab) throw new Error('Вернитесь на страницу Яндекс Погоды перед сохранением сессии.');
  const { cookies } = await browser.cdp.send('Storage.getCookies');
  const { userAgent } = await browser.cdp.send('Browser.getVersion');
  await writePrivate(config.sessionFile, await sessionFromCookies(cookies, userAgent));
  console.log('Сессия сохранена. Проверка: npm run status');
} catch (error) {
  if (error.code === 'BROWSER_NOT_FOUND') {
    console.error('Браузер не найден. Установите Chrome, Edge или Chromium либо задайте WEATHER_BROWSER_PATH.');
  } else {
    console.error(`Ошибка входа: ${error.code ?? error.message}`);
  }
  process.exitCode = abort.signal.aborted ? 130 : 2;
} finally {
  try { await browser?.close(); }
  finally {
    if (release) await release();
    process.removeListener('SIGINT', interrupted);
    process.removeListener('SIGTERM', interrupted);
  }
}
