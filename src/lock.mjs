import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { hostname } from 'node:os';

export async function acquireLock(path) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let file;
  try { file = await open(path, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const owner = JSON.parse(await readFile(path, 'utf8'));
    if (owner.host !== hostname()) throw new Error('SESSION_LOCKED');
    try { process.kill(owner.pid, 0); throw new Error('SESSION_LOCKED'); }
    catch (probe) {
      if (probe.code !== 'ESRCH') throw probe;
      await unlink(path);
      return acquireLock(path);
    }
  }
  await file.writeFile(JSON.stringify({ pid: process.pid, host: hostname() }));
  await file.close();
  return () => unlink(path);
}
