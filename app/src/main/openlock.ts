import fs from 'node:fs';
import path from 'node:path';
import { userDataDir } from './paths';

/**
 * Several SOMA windows are separate processes with the same app data ("Open the original" of a component starts one).
 * Two of them on the same model would build, commit and save the same working folder against each other. So a window
 * marks the model it has open: a file with its process id. A mark of a process that is gone (crash) does not count.
 *
 * Windows hands out process ids again soon: after a crash an unrelated program may carry the id of the mark. So a window
 * renews its marks every minute, and a mark that was not renewed for a few minutes is stale whatever its id says.
 */
const dir = () => path.join(userDataDir(), 'open-models');
const file = (id: string) => path.join(dir(), `${id}.pid`);
const RENEW_MS = 60_000;
const STALE_MS = 3 * RENEW_MS;

/** The marks of this process, renewed while it runs. */
const own = new Set<string>();
let renewer: NodeJS.Timeout | null = null;

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** The process that has the model open, other than this one, or null. */
export function openElsewhere(id: string): number | null {
  try {
    const f = file(id);
    const pid = Number(fs.readFileSync(f, 'utf8').trim());
    if (pid === process.pid || !alive(pid)) return null;
    return Date.now() - fs.statSync(f).mtimeMs < STALE_MS ? pid : null;
  } catch { return null; }
}

/**
 * Takes the mark for this window. False when another window holds it. Creating the file exclusively means two windows
 * opening the same model at the same moment (a double double-click) cannot both get it.
 */
export function claimOpen(id: string): boolean {
  try { fs.mkdirSync(dir(), { recursive: true }); } catch { /* writing says why */ }
  try {
    fs.writeFileSync(file(id), String(process.pid), { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') { console.warn('[soma] Could not mark the model as open:', e); return true; }
    if (openElsewhere(id)) return false;
    markOpen(id); // a stale mark or our own
    return true;
  }
  keep(id);
  return true;
}

export function markOpen(id: string): void {
  try { fs.mkdirSync(dir(), { recursive: true }); fs.writeFileSync(file(id), String(process.pid)); keep(id); }
  catch (e) { console.warn('[soma] Could not mark the model as open:', e); }
}

function keep(id: string): void {
  own.add(id);
  renewer ??= setInterval(() => {
    const now = new Date();
    for (const m of own) { try { fs.utimesSync(file(m), now, now); } catch { /* gone: claimOpen writes it again */ } }
  }, RENEW_MS);
  renewer.unref();
}

/** Only our own mark: another window may have the model open by now. */
export function markClosed(id: string): void {
  own.delete(id);
  try { if (Number(fs.readFileSync(file(id), 'utf8').trim()) === process.pid) fs.rmSync(file(id), { force: true }); } catch { /* none */ }
}

export const OPEN_ELSEWHERE = 'This model is open in another SOMA window. Switch to that window, or close the model there first.';
