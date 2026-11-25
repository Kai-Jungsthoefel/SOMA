import fs from 'node:fs';
import path from 'node:path';
import { userDataDir } from './paths';

/**
 * Several SOMA windows are separate processes with the same app data ("Open the original" of a component starts one).
 * Two of them on the same model would build, commit and save the same working folder against each other. So a window
 * marks the model it has open: a file with its process id. A mark of a process that is gone (crash) does not count.
 */
const dir = () => path.join(userDataDir(), 'open-models');
const file = (id: string) => path.join(dir(), `${id}.pid`);

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** The process that has the model open, other than this one, or null. */
export function openElsewhere(id: string): number | null {
  try {
    const pid = Number(fs.readFileSync(file(id), 'utf8').trim());
    return pid !== process.pid && alive(pid) ? pid : null;
  } catch { return null; }
}

export function markOpen(id: string): void {
  try { fs.mkdirSync(dir(), { recursive: true }); fs.writeFileSync(file(id), String(process.pid)); }
  catch (e) { console.warn('[soma] Could not mark the model as open:', e); }
}

/** Only our own mark: another window may have the model open by now. */
export function markClosed(id: string): void {
  try { if (Number(fs.readFileSync(file(id), 'utf8').trim()) === process.pid) fs.rmSync(file(id), { force: true }); } catch { /* none */ }
}

export const OPEN_ELSEWHERE = 'This model is open in another SOMA window. Switch to that window, or close the model there first.';
