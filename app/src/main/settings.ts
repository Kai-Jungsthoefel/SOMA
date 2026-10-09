import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS, applyPatch, cleanSettings, type SettingsResult, type SettingsState } from '../shared/settings';
import { backupsDir, settingsFile } from './paths';
import { writeAtomic } from './skills';

/**
 * Einstellungen der App (E81) in `<App-Daten>/settings.json`. Die Datei ist nicht vertrauenswürdig (von Hand bearbeitet,
 * von einer neueren App geschrieben): Was nicht passt, gilt mit der Vorgabe und wird in den Einstellungen gemeldet. Bevor
 * eine solche Datei beim nächsten Ändern ersetzt wird, kommt sie in die Sicherung (nichts still überschreiben).
 */
export function readSettings(): SettingsState {
  let text: string;
  try { text = fs.readFileSync(settingsFile(), 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { settings: DEFAULT_SETTINGS };
    return { settings: DEFAULT_SETTINGS, problem: `settings.json cannot be read (${(e as Error).message}). The defaults apply.` };
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch {
    return { settings: DEFAULT_SETTINGS, problem: 'settings.json is not valid JSON. The defaults apply. Changing a setting writes a new file, the old one goes into the backup.' };
  }
  const { settings, ignored } = cleanSettings(raw);
  return ignored.length
    ? { settings, problem: `settings.json contains values this app does not know (${ignored.join(', ')}). The defaults apply for them. Changing a setting writes a new file, the old one goes into the backup.` }
    : { settings };
}

/** Ändert Einstellungen (nur die genannten Werte). Ungültiges wird abgelehnt, nichts geschrieben. */
export function writeSettings(patch: unknown): SettingsResult {
  const cur = readSettings();
  const r = applyPatch(cur.settings, patch);
  if ('error' in r) return { ok: false, error: r.error, ...cur };
  let backup: string | null = null;
  const file = settingsFile();
  if (cur.problem && fs.existsSync(file)) {
    fs.mkdirSync(backupsDir(), { recursive: true });
    backup = path.join(backupsDir(), `settings-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.copyFileSync(file, backup);
  }
  writeAtomic(file, `${JSON.stringify(r.settings, null, 2)}\n`);
  return { ok: true, settings: r.settings, backup };
}
