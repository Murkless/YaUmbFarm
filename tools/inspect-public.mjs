import { readFile } from 'node:fs/promises';

const pageUrl = 'https://yandex.ru/pogoda/ru';
const localPage = process.argv[2];
const localAssets = process.argv[3];

async function download(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(25_000) });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response.text();
}

const html = localPage ? await readFile(localPage, 'utf8') : await download(pageUrl);
const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)/g)].map(match => match[1]);
const actions = new Map();
for (const [index, url] of scripts.entries()) {
  const source = localAssets
    ? await readFile(`${localAssets}/${index}.js`, 'utf8')
    : await download(url);
  for (const match of source.matchAll(/createServerReference\)\("([a-f0-9]+)",[^;]*?findSourceMapURL,"([^"]+)"\)/g)) {
    if (['userReport', 'getReportsConfigClient', 'skinChange'].includes(match[2])) {
      actions.set(match[2], { name: match[2], id: match[1], source: url });
    }
  }
}

// Next.js embeds JSON records in separate script chunks; join them before parsing records.
const records = [...html.matchAll(/self\.__next_f\.push\((\[.*?\])\)<\/script>/gs)]
  .map(match => JSON.parse(match[1]))
  .filter(chunk => chunk[0] === 1)
  .map(chunk => chunk[1])
  .join('');
const skins = new Map();
function visit(value) {
  if (!value || typeof value !== 'object') return;
  if (value.translationTitleSlug && value.title && !skins.has(value.id)) {
    skins.set(value.id, {
      id: value.id,
      title: value.title,
      reportsCount: value.reportsCount,
      streakDays: value.streakDays,
      descriptions: value.descriptions,
    });
  }
  Object.values(value).forEach(visit);
}
for (const record of records.split('\n')) {
  const separator = record.indexOf(':');
  if (separator < 0) continue;
  let value;
  try { value = JSON.parse(record.slice(separator + 1)); }
  catch { continue; }
  visit(value);
}
if (!actions.has('userReport') || !skins.size) {
  throw new Error('Expected report action or collection missing; inspect the current site format.');
}
console.log(JSON.stringify({
  pageUrl,
  actions: [...actions.values()],
  skins: [...skins.values()],
  serverCooldownSeconds: null,
  authenticationVerified: false,
}, null, 2));
