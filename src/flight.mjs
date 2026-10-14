export function flightFromHtml(html) {
  const chunks = [...html.matchAll(/self\.__next_f\.push\((\[.*?\])\)<\/script>/gs)]
    .map(match => JSON.parse(match[1]))
    .filter(chunk => chunk[0] === 1)
    .map(chunk => chunk[1]);
  if (!chunks.length) throw new Error('Page has no Next.js data (login, challenge or changed site).');
  return parseFlight(chunks.join(''));
}

export function parseFlight(text) {
  const buffer = Buffer.from(text);
  const records = new Map();
  let offset = 0;
  while (offset < buffer.length) {
    const colon = buffer.indexOf(58, offset);
    if (colon < 0) break;
    const id = buffer.subarray(offset, colon).toString();
    if (id === '') {
      const end = buffer.indexOf(10, colon);
      offset = end < 0 ? buffer.length : end + 1;
      continue;
    }
    if (!/^[a-f\d]+$/i.test(id)) throw new Error('Invalid Flight record.');
    let start = colon + 1;
    if (buffer[start] === 84) {
      // Text records use a hexadecimal byte length, and may contain newlines.
      const comma = buffer.indexOf(44, start);
      if (comma < 0) throw new Error('Incomplete Flight text record.');
      const length = buffer.subarray(start + 1, comma).toString();
      if (!/^[a-f\d]+$/i.test(length)) throw new Error('Invalid Flight text length.');
      const size = Number.parseInt(length, 16);
      if (!Number.isSafeInteger(size) || size > buffer.length - comma - 1) {
        throw new Error('Incomplete Flight text record.');
      }
      records.set(id, buffer.subarray(comma + 1, comma + 1 + size).toString());
      offset = comma + 1 + size;
      if (buffer[offset] === 10) offset++;
      continue;
    }
    let end = buffer.indexOf(10, start);
    if (end < 0) end = buffer.length;
    const payload = buffer.subarray(start, end).toString();
    offset = end + 1;
    if (payload.startsWith('E')) {
      records.set(id, { flightError: true });
      continue;
    }
    // Module imports, hints and diagnostics do not contain the data we consume.
    if (/^[A-Z]/.test(payload)) continue;
    try { records.set(id, JSON.parse(payload)); }
    catch { throw new Error('Unsupported Flight data record.'); }
  }
  return records;
}

export function resolveFlight(value, records, stack = new Set()) {
  if (typeof value === 'string') {
    if (value === '$undefined') return undefined;
    if (value.startsWith('$$')) return value.slice(1);
    const match = value.match(/^\$(?:@)?([a-f\d]+)(?::(.*))?$/i);
    if (!match) return value;
    if (stack.has(value)) throw new Error('Cyclic Flight data reference.');
    if (!records.has(match[1])) throw new Error('Missing Flight data reference.');
    const next = new Set(stack).add(value);
    let result = records.get(match[1]);
    for (const key of match[2]?.split(':') ?? []) {
      if (typeof result === 'string') result = resolveFlight(result, records, next);
      result = key === 'props' && Array.isArray(result) && result[0] === '$'
        ? result[3] : result?.[key];
    }
    return resolveFlight(result, records, next);
  }
  if (Array.isArray(value)) return value.map(item => resolveFlight(item, records, stack));
  if (value && typeof value === 'object') {
    if (value.flightError) throw new Error('Server action returned a Flight error.');
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, resolveFlight(item, records, stack)]));
  }
  return value;
}

export function findObject(records, predicate) {
  function visit(value) {
    if (!value || typeof value !== 'object') return null;
    if (!Array.isArray(value) && predicate(value)) return value;
    for (const child of Object.values(value)) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  }
  for (const record of records.values()) {
    const found = visit(record);
    if (found) return found;
  }
  return null;
}
