import { mkdir, open, readFile, rename, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

export async function writePrivate(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  const file = await open(temporary, 'w', 0o600);
  try { await file.writeFile(JSON.stringify(value, null, 2)); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
  await chmod(path, 0o600);
}

export async function loadConfig() {
  const path = resolve(process.env.WEATHER_CONFIG ?? 'config.json');
  const config = await readJson(path, null) ?? await readJson('config.example.json', null);
  if (!config) throw new Error('Config missing.');
  const url = new URL(config.pageUrl);
  if (url.origin !== 'https://yandex.ru' || !url.pathname.startsWith('/pogoda/ru')) {
    throw new Error('pageUrl must be a https://yandex.ru/pogoda/ru URL.');
  }
  for (const key of ['checkIntervalSeconds', 'afterReportSeconds']) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`Invalid ${key}.`);
  }
  if (typeof config.answer !== 'string' || !config.answer) throw new Error('Answer missing.');
  return config;
}
