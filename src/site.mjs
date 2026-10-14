import { randomInt } from 'node:crypto';
import { flightFromHtml, findObject, resolveFlight } from './flight.mjs';

function selectProps(object, keys, records) {
  if (!object) throw new Error('Required site data missing.');
  return Object.fromEntries(keys.map(key => [key, resolveFlight(object[key], records)]));
}

export function inspectPage(html) {
  const records = flightFromHtml(html);
  const csrf = findObject(records, obj => Object.hasOwn(obj, 'csrfToken'));
  const route = findObject(records, obj => obj.page === 'main' && Object.hasOwn(obj, 'routeParams'));
  const collection = findObject(records, obj => Object.hasOwn(obj, 'initialTotalReports'));
  const form = findObject(records, obj => obj.reports && obj.fact && obj.nowcastStep);
  const account = findObject(records, obj => Object.hasOwn(obj, 'yandexLogin'));
  const ctx = selectProps(route, ['page', 'routeParams', 'searchParams'], records);
  ctx.sk = resolveFlight(csrf?.csrfToken, records);
  if (typeof ctx.sk !== 'string' || !ctx.sk) throw new Error('CSRF token missing.');
  const login = resolveFlight(account?.yandexLogin, records);
  const progress = selectProps(collection, [
    'initialTotalReports', 'initialCollections', 'initialCalendar', 'initialCalendarState',
  ], records);
  return {
    context: ctx,
    authenticated: typeof login === 'string' && login.length > 0,
    login,
    form: form ? selectProps(form, [
      'reports', 'variants', 'fact', 'meta', 'userLocation', 'nowcastStep',
      'weatherApiExps', 'isUserRegion', 'shouldHideReportFormFromServer',
    ], records) : null,
    progress: normalizeProgress(progress),
    routerTree: resolveFlight(records.get('0')?.f?.[0]?.[0], records),
    scripts: [...html.matchAll(/<script[^>]+src="([^"]+)/g)].map(match => match[1]),
  };
}

export function normalizeProgress(data) {
  const collections = data.initialCollections ?? data.collections?.skinPackCollections;
  const total = data.initialTotalReports ?? data.totalReports;
  if (!Number.isInteger(total) || total < 0 || !Array.isArray(collections)) {
    throw new Error('Unrecognized collection data.');
  }
  return {
    totalReports: total,
    unlocked: collections.flatMap(collection => collection.skins ?? [])
      .filter(skin => skin.isAvailable).map(skin => ({ id: skin.id, title: skin.title })),
    calendar: data.initialCalendar ?? data.collections?.calendar ?? [],
    calendarState: data.initialCalendarState ?? data.collections?.calendarState ?? null,
  };
}

export function discoverActions(source) {
  const found = {};
  for (const match of source.matchAll(/createServerReference\)\("([a-f0-9]+)",[^;]*?findSourceMapURL,"([^"]+)"\)/g)) {
    if (['userReport', 'getReportsConfigClient'].includes(match[2])) found[match[2]] = match[1];
  }
  return found;
}

export function buildReport(page, mode) {
  if (!page.authenticated) throw new Error('AUTH_REQUIRED');
  const form = page.form;
  if (!form || form.shouldHideReportFormFromServer !== false || form.isUserRegion !== true) {
    throw new Error('FORM_UNAVAILABLE');
  }
  const variants = form.variants?.negative?.filter(Boolean) ?? [];
  const choices = [form.reports.positive, ...variants];
  let choice;
  if (mode === 'random') choice = choices[randomInt(choices.length)];
  else if (mode === 'confirm') choice = form.reports.positive;
  else choice = variants.find(item => item.text === mode);
  if (!choice) throw new Error('Answer is absent from the current form.');
  const location = form.userLocation;
  if (!Number.isFinite(location?.lat) || !Number.isFinite(location?.lon)) {
    throw new Error('Location missing from form.');
  }
  const fact = form.fact;
  const wet = choice.isWet === true;
  const precType = { NO_TYPE: 0, RAIN: 1, SLEET: 2, SNOW: 3, HAIL: 4 };
  const precStrength = { ZERO: 0, WEAK: 1, AVERAGE: 2, STRONG: 3, VERY_STRONG: 4 };
  const cloudiness = { CLEAR: 0, PARTLY: 1, SIGNIFICANT: 2, CLOUDY: 3, OVERCAST: 4 };
  for (const [table, key] of [[precType, fact.precType], [precStrength, fact.precStrength], [cloudiness, fact.cloudiness]]) {
    if (!Object.hasOwn(table, key)) throw new Error('Unknown forecast enum; inspect the current client.');
  }
  const originalCloudiness = choice.cloudiness ?? (choice === form.reports.positive ? fact.cloudiness : undefined);
  const chosenCloudiness = originalCloudiness === 'PARTLY' ? 'SIGNIFICANT' : originalCloudiness;
  return {
    ...page.context,
    temp: fact.temperature,
    cloudiness: cloudiness[fact.cloudiness],
    prec_strength: precStrength[fact.precStrength],
    prec_type: precType[fact.precType],
    nowcast_gen_time: Number(form.nowcastStep.genTime ?? 0),
    lat: location.lat, lon: location.lon,
    // Matches the web client's fallback when browser geolocation is unavailable.
    precision: 15000,
    user_prec_type: wet ? (fact.temperature > 4 ? 1 : fact.temperature < -2 ? 3 : 2) : 0,
    ...(Number.isFinite(choice.precStrength) ? { user_prec_strength: choice.precStrength } : {}),
    ...(Object.hasOwn(cloudiness, chosenCloudiness) ? { user_cloudiness: cloudiness[chosenCloudiness] } : {}),
    meta: { yandexLogin: page.login, reportId: Date.now().toString(36) + Math.random().toString(36), ...form.meta },
    expFlags: form.weatherApiExps,
  };
}
