import fs from 'node:fs';
import { affectsAnimation, affectsBuild } from '../shared/editable';

/** Ordner, die nie einen Build oder eine Neuanzeige der Dateiliste ausloesen (Ausgaben wuerden sich sonst selbst anstossen). */
export const IGNORED_TOP = new Set(['.git', '.soma', 'output', 'exports', '__pycache__', 'node_modules', '.venv', 'venv', 'env']);

const topSegment = (rel: string) => rel.split(/[\\/]/)[0] ?? '';
/** Markierungen (E16) und Kopien der Skills stehen im Dateibaum: Änderungen dort frischen die Liste auf, bauen aber nie. */
const isShown = (rel: string) => /^\.soma[\\/](feedback|skills)([\\/]|$)/i.test(rel);
const isIgnored = (rel: string) => IGNORED_TOP.has(topSegment(rel)) || rel.split(/[\\/]/).includes('__pycache__');
/** `soma build` schreibt build.json als Letztes, auch wenn der Agent im Terminal baut statt die App. */
const isBuildResult = (rel: string) => /^\.soma[\\/]build\.json$/i.test(rel);
/** Zeichnungen (E76): neuer Index von `soma drawing build` (auch aus dem Terminal) oder eine geänderte Zeichnungsdatei. */
const isDrawing = (rel: string) => /^\.soma[\\/]drawings[\\/]index\.json$/i.test(rel) || /^drawings[\\/][^\\/]+\.py$/i.test(rel);
/** Quelltext-Aenderung: dieselbe Regel wie beim Speichern im Editor (src/shared/editable.ts). */
const isSource = affectsBuild;

/**
 * Beobachtet den Projektordner. `onSource` bei relevanten Aenderungen (fuer Auto-Build), `onFiles` fuer die Dateiliste,
 * `onAnim` bei Aenderungen an animations/*.py (E58), `onBuilt` bei einem neuen Build-Ergebnis, `onDrawings` bei neuen
 * Zeichnungen (entprellt). Gibt eine Funktion zum Beenden zurueck. Fehler des Watchers werden verschluckt: ohne Watcher bleibt der Knopf.
 */
export function watchProject(dir: string, onSource: (rel: string | null) => void, onFiles: () => void, onAnim: (rel: string) => void = () => {},
  onBuilt: () => void = () => {}, onDrawings: () => void = () => {}): () => void {
  let filesTimer: NodeJS.Timeout | null = null;
  let drawTimer: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(dir, { recursive: true }, (_evt, filename) => {
      const rel = filename ? String(filename) : '';
      if (rel && isBuildResult(rel)) { onBuilt(); return; }
      if (rel && isDrawing(rel)) {
        if (drawTimer) clearTimeout(drawTimer);
        drawTimer = setTimeout(onDrawings, 300);
      }
      if (rel && isIgnored(rel) && !isShown(rel)) return;
      if (rel && affectsAnimation(rel)) onAnim(rel.replace(/\\/g, '/'));
      else if (!rel || (isSource(rel) && !isShown(rel))) onSource(rel || null);
      if (filesTimer) clearTimeout(filesTimer);
      filesTimer = setTimeout(onFiles, 250);
    });
    watcher.on('error', () => { /* Projektordner weg oder gesperrt: nichts zu tun */ });
  } catch { /* Watcher nicht verfuegbar */ }
  return () => { if (filesTimer) clearTimeout(filesTimer); if (drawTimer) clearTimeout(drawTimer); watcher?.close(); };
}
