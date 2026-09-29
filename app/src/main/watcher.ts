import fs from 'node:fs';

/** Ordner, die nie einen Build oder eine Neuanzeige der Dateiliste ausloesen (Ausgaben wuerden sich sonst selbst anstossen). */
const IGNORED_TOP = new Set(['.git', '.cadide', 'output', 'exports', '__pycache__', 'node_modules', '.venv', 'venv', 'env']);

const topSegment = (rel: string) => rel.split(/[\\/]/)[0] ?? '';
const isIgnored = (rel: string) => IGNORED_TOP.has(topSegment(rel)) || rel.split(/[\\/]/).includes('__pycache__');
/** Quelltext-Aenderung: Python-Dateien und alles in inputs/ (mitgebrachte STEP-Dateien). */
const isSource = (rel: string) => rel.endsWith('.py') || topSegment(rel) === 'inputs';

/**
 * Beobachtet den Projektordner. `onSource` bei relevanten Aenderungen (fuer Auto-Build), `onFiles` fuer die Dateiliste.
 * Gibt eine Funktion zum Beenden zurueck. Fehler des Watchers werden verschluckt: ohne Watcher bleibt der Knopf.
 */
export function watchProject(dir: string, onSource: () => void, onFiles: () => void): () => void {
  let filesTimer: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(dir, { recursive: true }, (_evt, filename) => {
      const rel = filename ? String(filename) : '';
      if (rel && isIgnored(rel)) return;
      if (!rel || isSource(rel)) onSource();
      if (filesTimer) clearTimeout(filesTimer);
      filesTimer = setTimeout(onFiles, 250);
    });
    watcher.on('error', () => { /* Projektordner weg oder gesperrt: nichts zu tun */ });
  } catch { /* Watcher nicht verfuegbar */ }
  return () => { if (filesTimer) clearTimeout(filesTimer); watcher?.close(); };
}
