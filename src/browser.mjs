import { access, chmod, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { CdpConnection } from './cdp.mjs';

function failure(code) {
  return Object.assign(new Error(code), { code });
}

export function browserCandidates({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  const pathApi = platform === 'win32' ? win32 : posix;
  const pathEntries = (env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const onPath = name => pathEntries.map(dir => pathApi.join(dir, name));
  if (env.WEATHER_BROWSER_PATH) {
    const value = env.WEATHER_BROWSER_PATH;
    if (value.includes('/') || value.includes('\\')) return [value];
    return onPath(platform === 'win32' && !value.toLowerCase().endsWith('.exe') ? `${value}.exe` : value);
  }
  let candidates;
  if (platform === 'darwin') {
    candidates = ['/Applications', posix.join(home, 'Applications')].flatMap(root => [
      ['chrome', posix.join(root, 'Google Chrome.app/Contents/MacOS/Google Chrome')],
      ['msedge', posix.join(root, 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge')],
      ['chromium', posix.join(root, 'Chromium.app/Contents/MacOS/Chromium')],
    ]);
  } else if (platform === 'win32') {
    const roots = [env.LOCALAPPDATA ?? win32.join(home, 'AppData', 'Local'),
      env.PROGRAMFILES ?? env.ProgramFiles ?? 'C:\\Program Files',
      env['PROGRAMFILES(X86)'] ?? env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'];
    candidates = roots.flatMap(root => [
      ['chrome', win32.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')],
      ['msedge', win32.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
      ['chromium', win32.join(root, 'Chromium', 'Application', 'chrome.exe')],
    ]);
    for (const [family, name] of [['chrome', 'chrome.exe'], ['msedge', 'msedge.exe'], ['chromium', 'chromium.exe']]) {
      candidates.push(...onPath(name).map(path => [family, path]));
    }
  } else if (platform === 'linux') {
    candidates = [['chrome', 'google-chrome-stable'], ['chrome', 'google-chrome'],
      ['chromium', 'chromium'], ['chromium', 'chromium-browser'],
      ['msedge', 'microsoft-edge-stable'], ['msedge', 'microsoft-edge']]
      .flatMap(([family, name]) => onPath(name).map(path => [family, path]));
  } else { throw failure('UNSUPPORTED_PLATFORM'); }
  const channel = env.WEATHER_BROWSER_CHANNEL;
  if (channel && !['chrome', 'msedge', 'chromium'].includes(channel)) throw failure('UNSUPPORTED_BROWSER');
  return [...new Set(candidates.filter(([family]) => !channel || family === channel).map(([, path]) => path))];
}

export async function findBrowser(options = {}) {
  const platform = options.platform ?? process.platform;
  for (const path of browserCandidates(options)) {
    try {
      await access(path, platform === 'win32' ? constants.F_OK : constants.X_OK);
      if ((await stat(path)).isFile()) return path;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    }
  }
  throw failure('BROWSER_NOT_FOUND');
}

export function debuggerEndpoint(contents) {
  const [port, path] = contents.trim().split(/\r?\n/);
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535
    || !/^\/devtools\/browser\/[a-zA-Z0-9_-]+$/.test(path ?? '')) {
    throw failure('INVALID_DEBUG_ENDPOINT');
  }
  return `ws://127.0.0.1:${port}${path}`;
}

export async function launchBrowser({ executable, headless = false, signal, timeoutMs = 20000 } = {}) {
  executable ??= await findBrowser();
  const profile = await mkdtemp(join(tmpdir(), 'weather-login-'));
  let child, cdp, launchError, exited = false, closed;
  const close = async () => {
    try {
      if (cdp) {
        try { await cdp.send('Browser.close', {}, { timeoutMs: 1000 }); } catch { /* Browser may close before replying. */ }
        cdp.close();
      }
      if (child && !exited) {
        await Promise.race([closed, delay(3000, undefined, { ref: false })]);
        if (!exited) {
          child.kill('SIGKILL');
          await Promise.race([closed, delay(3000, undefined, { ref: false })]);
        }
      }
    } finally {
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  };
  try {
    await chmod(profile, 0o700);
    signal?.throwIfAborted();
    child = spawn(executable, [
      `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
      '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--disable-component-update', '--disable-sync', ...(headless ? ['--headless=new'] : []), 'about:blank',
    ], { stdio: 'ignore', shell: false });
    closed = new Promise(resolve => {
      child.once('error', error => { launchError = error; exited = true; resolve(); });
      child.once('exit', () => { exited = true; resolve(); });
    });
    const deadline = Date.now() + timeoutMs;
    let endpoint;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (launchError || exited) throw failure('BROWSER_LAUNCH_FAILED');
      try {
        endpoint = debuggerEndpoint(await readFile(join(profile, 'DevToolsActivePort'), 'utf8'));
        break;
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'INVALID_DEBUG_ENDPOINT') throw error;
      }
      await delay(100, undefined, { signal });
    }
    if (!endpoint) throw failure('BROWSER_START_TIMEOUT');
    cdp = await CdpConnection.connect(endpoint, { signal });
    return { cdp, close, closed, profile };
  } catch (error) { await close(); throw error; }
}
