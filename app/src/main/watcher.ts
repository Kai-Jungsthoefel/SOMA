import fs from 'node:fs';
import { affectsAnimation, affectsBuild } from '../shared/editable';

/** Ordner, die nie einen Build oder eine Neuanzeige der Dateiliste ausloesen (Ausgaben wuerden sich sonst selbst anstossen). */
const IGNORED_TOP = new Set(['.git', '.soma', 'output', 'exports', '__pycache__', 'node_modules', '.venv', 'venv', 'env']);

const topSegment = (rel: string) => rel.split(/[\\/]/)[0] ?? '';
/** Markierungen (E16) stehen im Dateibaum: Änderungen dort frischen die Liste auf, bauen aber nie. */
const isFeedback = (rel: string) => /^\.soma[\\/]feedback([\\/]|$)/i.test(rel);
const isIgnored = (rel: string) => IGNORED_TOP.has(topSegment(rel)) || rel.split(/[\\/]/).includes('__pycache__');
/** Quelltext-Aenderung: dieselbe Regel wie beim Speichern im Editor (src/shared/editable.ts). */
const isSource = affectsBuild;

/**
 * Beobachtet den Projektordner. `onSource` bei relevanten Aenderungen (fuer Auto-Build), `onFiles` fuer die Dateiliste,
 * `onAnim` bei Aenderungen an animations/*.py (E58). Gibt eine Funktion zum Beenden zurueck. Fehler des Watchers werden
 * verschluckt: ohne Watcher bleibt der Knopf.
 */
export function watchProject(dir: string, onSource: (rel: string | null) => void, onFiles: () => void, onAnim: (rel: string) => void = () => {}): () => void {
  let filesTimer: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(dir, { recursive: true }, (_evt, filename) => {
      const rel = filename ? String(filename) : '';
      if (rel && isIgnored(rel) && !isFeedback(rel)) return;
      if (rel && affectsAnimation(rel)) onAnim(rel.replace(/\\/g, '/'));
      else if (!rel || (isSource(rel) && !isFeedback(rel))) onSource(rel || null);
      if (filesTimer) clearTimeout(filesTimer);
      filesTimer = setTimeout(onFiles, 250);
    });
    watcher.on('error', () => { /* Projektordner weg oder gesperrt: nichts zu tun */ });
  } catch { /* Watcher nicht verfuegbar */ }
  return () => { if (filesTimer) clearTimeout(filesTimer); watcher?.close(); };
}
