import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CookieJar } from 'tough-cookie';
import { browserCandidates, debuggerEndpoint, findBrowser, launchBrowser } from '../src/browser.mjs';
import { CdpConnection } from '../src/cdp.mjs';
import { sessionFromCookies } from '../src/login-session.mjs';

test('browser discovery covers macOS system and per-user applications', () => {
  const candidates = browserCandidates({ platform: 'darwin', env: {}, home: '/home/test' });
  assert(candidates.includes('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'));
  assert(candidates.includes('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'));
  assert(candidates.includes('/home/test/Applications/Chromium.app/Contents/MacOS/Chromium'));
});

test('Windows browser paths cover user, 64-bit and 32-bit installations', () => {
  const candidates = browserCandidates({ platform: 'win32', home: 'C:\\Users\\test', env: {
    LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local', PROGRAMFILES: 'C:\\Program Files',
    'PROGRAMFILES(X86)': 'C:\\Program Files (x86)', PATH: 'C:\\tools;D:\\browsers',
  } });
  assert(candidates.includes('C:\\Users\\test\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe'));
  assert(candidates.includes('C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'));
  assert(candidates.includes('C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'));
  assert(candidates.includes('D:\\browsers\\msedge.exe'));
});

test('Linux discovery uses PATH and respects an explicit browser family', () => {
  const candidates = browserCandidates({ platform: 'linux', env: { PATH: '/usr/bin:/snap/bin', WEATHER_BROWSER_CHANNEL: 'chromium' } });
  assert.deepEqual(candidates, ['/usr/bin/chromium', '/snap/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium-browser']);
});

test('an explicit executable overrides discovery without parsing shell arguments', () => {
  assert.deepEqual(browserCandidates({ platform: 'win32', env: { WEATHER_BROWSER_PATH: 'D:\\Custom Browser\\chrome.exe' } }),
    ['D:\\Custom Browser\\chrome.exe']);
  assert.deepEqual(browserCandidates({ platform: 'linux', env: { WEATHER_BROWSER_PATH: '/opt/browser with spaces/chrome' } }),
    ['/opt/browser with spaces/chrome']);
  assert.deepEqual(browserCandidates({ platform: 'win32', env: { WEATHER_BROWSER_PATH: 'msedge', PATH: 'C:\\tools' } }),
    ['C:\\tools\\msedge.exe']);
});

test('browser discovery rejects missing executables and directories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'weather-discovery-'));
  try {
    await assert.rejects(findBrowser({ env: { WEATHER_BROWSER_PATH: join(dir, 'missing') } }), { code: 'BROWSER_NOT_FOUND' });
    await assert.rejects(findBrowser({ env: { WEATHER_BROWSER_PATH: dir } }), { code: 'BROWSER_NOT_FOUND' });
    const path = join(dir, 'fake-browser');
    await writeFile(path, '', { mode: 0o700 });
    await chmod(path, 0o700);
    assert.equal(await findBrowser({ env: { WEATHER_BROWSER_PATH: path } }), path);
  } finally { await rm(dir, { recursive: true }); }
});

test('unsupported browser families and operating systems produce actionable codes', () => {
  assert.throws(() => browserCandidates({ platform: 'linux', env: { WEATHER_BROWSER_CHANNEL: 'firefox' } }), { code: 'UNSUPPORTED_BROWSER' });
  assert.throws(() => browserCandidates({ platform: 'other', env: {} }), { code: 'UNSUPPORTED_PLATFORM' });
});

test('debugger endpoint always uses loopback and validates the startup file', () => {
  assert.equal(debuggerEndpoint('12345\r\n/devtools/browser/test-id\r\n'), 'ws://127.0.0.1:12345/devtools/browser/test-id');
  for (const content of ['0\n/devtools/browser/id', '65536\n/devtools/browser/id', 'abc\n/devtools/browser/id',
    '1234\n//example.org', '1234\n/devtools/browser/id?token=secret']) {
    assert.throws(() => debuggerEndpoint(content), { code: 'INVALID_DEBUG_ENDPOINT' });
  }
});

class FakeSocket extends EventTarget {
  readyState = 1;
  messages = [];
  send(value) { this.messages.push(JSON.parse(value)); }
  receive(value) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) })); }
  close() { this.readyState = 3; this.dispatchEvent(new Event('close')); }
}

test('CDP requests resolve by ID even when responses arrive out of order', async () => {
  const socket = new FakeSocket();
  const cdp = new CdpConnection(socket);
  try {
    const first = cdp.send('Browser.getVersion');
    const second = cdp.send('Storage.getCookies');
    socket.receive({ method: 'Target.targetCreated', params: {} });
    socket.receive({ id: socket.messages[1].id, result: { cookies: [] } });
    socket.receive({ id: socket.messages[0].id, result: { userAgent: 'test-agent' } });
    assert.deepEqual(await first, { userAgent: 'test-agent' });
    assert.deepEqual(await second, { cookies: [] });
    assert.equal(cdp.pending.size, 0);
  } finally { cdp.close(); }
});

test('CDP failures do not expose response details or leave pending requests', async () => {
  const socket = new FakeSocket();
  const cdp = new CdpConnection(socket);
  const request = cdp.send('Storage.getCookies');
  const rejected = assert.rejects(request, error => error.code === 'BROWSER_COMMAND_FAILED' && !error.message.includes('private'));
  socket.receive({ id: socket.messages[0].id, error: { message: 'private-cookie-value' } });
  await rejected;
  const pending = cdp.send('Browser.getVersion');
  const closed = assert.rejects(pending, { code: 'BROWSER_CLOSED' });
  cdp.close();
  await closed;
  assert.equal(cdp.pending.size, 0);
});

test('CDP request timeout frees its pending entry', async () => {
  const cdp = new CdpConnection(new FakeSocket());
  try {
    await assert.rejects(cdp.send('Browser.getVersion', {}, { timeoutMs: 10 }), { code: 'BROWSER_COMMAND_TIMEOUT' });
    assert.equal(cdp.pending.size, 0);
  } finally { cdp.close(); }
});

test('CDP connections reject non-local endpoints before opening a socket', async () => {
  for (const url of ['ws://example.org:1234/devtools/browser/id', 'wss://127.0.0.1:1234/devtools/browser/id',
    'ws://user:password@127.0.0.1:1234/devtools/browser/id']) {
    await assert.rejects(CdpConnection.connect(url), { code: 'INVALID_DEBUG_ENDPOINT' });
  }
});

test('session export keeps Yandex cookies, HttpOnly, host scope and expiry', async () => {
  const make = (domain, name, options = {}) => ({ domain, name, value: 'fixture', path: '/',
    secure: true, httpOnly: true, expires: -1, sameSite: 'Lax', ...options });
  const session = await sessionFromCookies([
    make('.yandex.ru', 'shared', { expires: 4102444800 }), make('passport.yandex.ru', 'host-only'),
    make('.example.org', 'unrelated'), make('.evilyandex.ru', 'lookalike'), make('.yandex.ru.example.org', 'suffix'),
  ], 'test-user-agent');
  assert.equal(session.userAgent, 'test-user-agent');
  assert.equal(session.jar.cookies.length, 2);
  assert.equal(session.jar.cookies[0].httpOnly, true);
  assert.equal(session.jar.cookies[0].sameSite, 'lax');
  assert.equal(session.jar.cookies[0].expires, '2100-01-01T00:00:00.000Z');
  const jar = CookieJar.fromJSON(session.jar);
  assert.equal(await jar.getCookieString('https://yandex.ru/'), 'shared=fixture');
  assert.equal(await jar.getCookieString('https://passport.yandex.ru/'), 'shared=fixture; host-only=fixture');
  assert.equal(await jar.getCookieString('https://example.org/'), '');
});

test('browser startup failure is bounded and cleans up', async () => {
  await assert.rejects(launchBrowser({ executable: join(tmpdir(), 'nonexistent-weather-browser'), timeoutMs: 1000 }), { code: 'BROWSER_LAUNCH_FAILED' });
});

test('real installed browser supports CDP export and temporary-profile cleanup', {
  skip: !process.env.WEATHER_TEST_BROWSER_PATH,
}, async () => {
  const browser = await launchBrowser({ executable: process.env.WEATHER_TEST_BROWSER_PATH, headless: true });
  try {
    const version = await browser.cdp.send('Browser.getVersion');
    assert.equal(typeof version.userAgent, 'string');
    await browser.cdp.send('Storage.setCookies', { cookies: [
      { name: 'weather-test', value: 'synthetic-only', domain: '.yandex.ru', path: '/', secure: true, httpOnly: true },
    ] });
    const { cookies } = await browser.cdp.send('Storage.getCookies');
    const session = await sessionFromCookies(cookies, version.userAgent);
    assert(session.jar.cookies.some(cookie => cookie.key === 'weather-test' && cookie.httpOnly));
    const { targetId } = await browser.cdp.send('Target.createTarget', { url: 'about:blank' });
    const { targetInfos } = await browser.cdp.send('Target.getTargets');
    assert(targetInfos.some(target => target.targetId === targetId));
  } finally { await browser.close(); }
  await assert.rejects(stat(browser.profile), { code: 'ENOENT' });
});
