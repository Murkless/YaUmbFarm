import { WeatherClient, HttpFailure } from './http.mjs';
import { loadConfig } from './storage.mjs';
import { cycle, run } from './runner.mjs';
import { acquireLock } from './lock.mjs';

const log = value => console.log(JSON.stringify({ time: new Date().toISOString(), ...value }));
let release;
try {
  const command = process.argv[2] ?? 'status';
  if (!['status', 'once', 'run', 'locate'].includes(command)) throw new Error('UNKNOWN_COMMAND');
  const config = await loadConfig();
  release = await acquireLock(`${config.sessionFile}.lock`);
  const client = await WeatherClient.create(config);
  if (command === 'locate') {
    const [lat, lon, accuracy] = process.argv.slice(3).map(Number);
    if (![lat, lon, accuracy].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || accuracy <= 0 || accuracy > 2000) {
      throw new Error('Use locate LAT LON ACCURACY_METERS (accuracy 1..2000).');
    }
    const page = await client.loadPage();
    if (!page.authenticated) throw new HttpFailure('AUTH_REQUIRED');
    const url = new URL('https://yandex.ru/gpsave');
    url.search = new URLSearchParams({ device: '1', format: 'json', lat: String(lat),
      lon: String(lon), precision: String(accuracy), persistent: '0', sk: page.context.sk }).toString();
    await (await client.request(url.href, { headers: { referer: config.pageUrl } })).body?.cancel();
    log(await cycle(client, config));
  } else if (command === 'run') {
    const abort = new AbortController();
    process.once('SIGINT', () => abort.abort());
    process.once('SIGTERM', () => abort.abort());
    const result = await run(client, config, abort.signal, log);
    if (['AUTH_REQUIRED', 'REGION_MISMATCH'].includes(result.status)) process.exitCode = 2;
  } else {
    const result = await cycle(client, config, { send: command === 'once' });
    log(result);
    if (['AUTH_REQUIRED', 'REGION_MISMATCH'].includes(result.status)) process.exitCode = 2;
  }
} catch (error) {
  log({
    status: 'STOPPED', reason: error.code ?? error.message,
    ...(['EACCES', 'EPERM', 'EROFS'].includes(error.code)
      ? { path: error.path, operation: error.syscall } : {}),
  });
  process.exitCode = 2;
} finally {
  if (release) await release();
}
