import fs from 'node:fs';
import path from 'node:path';
import type { FileNode, ImportResult } from '../shared/types';

const HIDDEN = new Set(['.git', '.cadide', '__pycache__', 'node_modules', '.venv', 'venv', 'env']);
const MAX_ENTRIES = 2000;
const MAX_DEPTH = 5;
const MAX_IMPORT_BYTES = 500 * 1024 * 1024;

/**
 * Kopiert gezogene Dateien nach inputs/ (E33). Der Agent bindet sie danach im Skript ein.
 * Nichts wird überschrieben: bei gleichem Namen entsteht „name (2).ext“. Ordner werden nicht übernommen.
 */
export function importInputs(root: string, sources: string[]): ImportResult {
  const res: ImportResult = { files: [], errors: [] };
  for (const src of sources) {
    const base = path.basename(src);
    try {
      const st = fs.statSync(src);
      if (!st.isFile()) { res.errors.push(`${base}: Nur einzelne Dateien lassen sich übernehmen, keine Ordner.`); continue; }
      if (st.size > MAX_IMPORT_BYTES) { res.errors.push(`${base}: größer als 500 MB, nicht übernommen.`); continue; }
      const dest = resolveInside(root, 'inputs');
      fs.mkdirSync(dest, { recursive: true });
      const ext = path.extname(base), stem = base.slice(0, base.length - ext.length);
      let name = base;
      for (let i = 2; fs.existsSync(path.join(dest, name)); i++) name = `${stem} (${i})${ext}`;
      // COPYFILE_EXCL: falls zwischen Prüfung und Kopie doch eine Datei entsteht, schlägt die Kopie fehl statt zu überschreiben
      fs.copyFileSync(src, resolveInside(root, `inputs/${name}`), fs.constants.COPYFILE_EXCL);
      res.files.push(`inputs/${name}`);
    } catch (e) { res.errors.push(`${base}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return res;
}

/**
 * Loest einen Pfad relativ zum Projektordner auf und lehnt alles ab, was ausserhalb landet
 * (auch ueber Symlinks). Der Renderer bekommt so nie Zugriff auf andere Dateien des Rechners.
 */
export function resolveInside(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  const realRoot = fs.realpathSync(root);
  const real = fs.existsSync(abs) ? fs.realpathSync(abs) : abs;
  const inside = (p: string, r: string) => p === r || p.startsWith(r + path.sep);
  if (!inside(abs, path.resolve(root)) || !inside(real, realRoot)) throw new Error(`Pfad liegt ausserhalb des Projekts: ${rel}`);
  return abs;
}

export function listFiles(root: string): FileNode[] {
  let count = 0;
  const walk = (dir: string, rel: string, depth: number): FileNode[] => {
    if (depth > MAX_DEPTH || count > MAX_ENTRIES) return [];
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
    const nodes: FileNode[] = [];
    for (const e of entries) {
      if (HIDDEN.has(e.name) || e.isSymbolicLink()) continue;
      count++;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      nodes.push(e.isDirectory()
        ? { name: e.name, path: childRel, dir: true, children: walk(path.join(dir, e.name), childRel, depth + 1) }
        : { name: e.name, path: childRel, dir: false });
    }
    return nodes.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
  };
  return walk(root, '', 0);
}
