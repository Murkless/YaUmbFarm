import { setTimeout as delay } from 'node:timers/promises';
import { buildReport } from './site.mjs';
import { readJson, writePrivate } from './storage.mjs';

export async function cycle(client, config, { send = false, now = Date.now } = {}) {
  const state = await readJson(config.stateFile, {});
  if (send && state.nextCheckAt > now()) return { status: 'WAIT', nextCheckAt: state.nextCheckAt };
  const page = await client.loadPage();
  if (!send) return {
    status: !page.authenticated ? 'AUTH_REQUIRED' : page.form?.isUserRegion !== true
      ? 'REGION_MISMATCH' : page.form?.shouldHideReportFormFromServer !== false
        ? 'FORM_UNAVAILABLE' : 'READY',
    authenticated: page.authenticated,
    formAvailable: page.form?.shouldHideReportFormFromServer === false,
    isUserRegion: page.form?.isUserRegion === true,
    answers: ['confirm', ...(page.form?.variants?.negative?.filter(Boolean).map(v => v.text) ?? [])],
    ...page.progress,
  };
  if (!page.authenticated) return { status: 'AUTH_REQUIRED' };
  if (page.form?.isUserRegion !== true) return { status: 'REGION_MISMATCH' };
  const checkpoint = async (seconds, status, details = {}) => {
    state.nextCheckAt = now() + seconds * 1000;
    state.status = status;
    Object.assign(state, details);
    await writePrivate(config.stateFile, state);
    return { status, nextCheckAt: state.nextCheckAt, ...details };
  };
  if (page.form?.shouldHideReportFormFromServer !== false) {
    return checkpoint(config.checkIntervalSeconds, 'FORM_UNAVAILABLE');
  }
  if (state.nextSendAt > now()) {
    return checkpoint(Math.min(config.checkIntervalSeconds, Math.ceil((state.nextSendAt - now()) / 1000)), 'WAIT');
  }
  const report = buildReport(page, config.answer);
  const before = await client.collection(page);
  const attemptedAt = now();
  // Persist before POST: timeout or crash must not cause an immediate duplicate.
  await checkpoint(config.afterReportSeconds, 'SUBMISSION_PENDING', {
    attemptedAt, nextSendAt: attemptedAt + config.afterReportSeconds * 1000,
    beforeReports: before.totalReports,
  });
  await client.action(page, 'userReport', report);
  const after = await client.collection(page, true);
  const credited = after.totalReports > before.totalReports;
  return checkpoint(config.afterReportSeconds, credited ? 'CREDITED' : 'NOT_CREDITED', {
    beforeReports: before.totalReports, afterReports: after.totalReports,
    newSkins: after.unlocked.filter(s => !before.unlocked.some(old => old.id === s.id)),
    calendarState: after.calendarState,
  });
}

export async function run(client, config, signal, log) {
  let failures = 0;
  while (!signal.aborted) {
    let result;
    try {
      result = await cycle(client, config, { send: true });
      failures = 0;
    } catch (error) {
      if (['EACCES', 'EPERM', 'EROFS', 'AUTH_OR_CHALLENGE', 'PAGE_CHANGED_OR_CHALLENGE', 'ACTION_REDIRECT',
        'UNEXPECTED_REDIRECT', 'ACTIONS_CHANGED', 'ACTION_CHANGED', 'ACTION_REJECTED',
        'UNEXPECTED_ACTION_RESPONSE', 'COLLECTION_RESPONSE_CHANGED'].includes(error.code)) throw error;
      failures++;
      if (failures >= 5) throw new Error('REPEATED_FAILURES');
      const seconds = Math.max(error.delaySeconds ?? 0, config.checkIntervalSeconds * 2 ** failures);
      const state = await readJson(config.stateFile, {});
      result = { status: 'BACKOFF', nextCheckAt: Date.now() + seconds * 1000 };
      await writePrivate(config.stateFile, { ...state, ...result });
    }
    log(result);
    if (['AUTH_REQUIRED', 'REGION_MISMATCH'].includes(result.status)) return result;
    const milliseconds = Math.max(1000, (result.nextCheckAt ?? Date.now()) - Date.now());
    try { await delay(milliseconds, undefined, { signal }); }
    catch (error) { if (error.name !== 'AbortError') throw error; }
  }
  return { status: 'STOPPED' };
}
