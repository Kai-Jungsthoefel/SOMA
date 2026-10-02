import fs from 'node:fs';
import path from 'node:path';
import { readOnlyReason } from '../shared/editable';
import type { FeedbackResult, FileNode, ImportResult, WriteResult } from '../shared/types';

const HIDDEN = new Set(['.git', '.soma', '__pycache__', 'node_modules', '.venv', 'venv', 'env']);
const MAX_ENTRIES = 2000;
const MAX_DEPTH = 5;
const MAX_IMPORT_BYTES = 500 * 1024 * 1024;
const MAX_IMPORT_FILES = 10000;
const MAX_FEEDBACK_BYTES = 64 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Kopiert gezogene Dateien und Ordner nach inputs/ (E33). Der Agent bindet sie danach im Skript ein.
 * Nichts wird überschrieben: bei gleichem Namen entsteht „name (2).ext“ bzw. „ordner (2)“. Ein Ordner kommt mit
 * allem darin, nur Verknüpfungen und .git-Ordner nicht (siehe scanFolder). Ergebnis: Dateien als Pfad, Ordner mit „/“ am Ende.
 */
export function importInputs(root: string, sources: string[]): ImportResult {
  const res: ImportResult = { files: [], errors: [] };
  for (const src of sources) {
    const base = path.basename(src);
    try {
      const st = fs.lstatSync(src);
      if (st.isSymbolicLink()) { res.errors.push(`${base}: Verknüpfungen werden nicht übernommen.`); continue; }
      if (!st.isFile() && !st.isDirectory()) { res.errors.push(`${base}: weder Datei noch Ordner, nicht übernommen.`); continue; }
      const dest = resolveInside(root, 'inputs');
      fs.mkdirSync(dest, { recursive: true });
      if (st.isFile()) {
        if (st.size > MAX_IMPORT_BYTES) { res.errors.push(`${base}: größer als 500 MB, nicht übernommen.`); continue; }
        const ext = path.extname(base), stem = base.slice(0, base.length - ext.length);
        let name = base;
        for (let i = 2; fs.existsSync(path.join(dest, name)); i++) name = `${stem} (${i})${ext}`;
        // COPYFILE_EXCL: falls zwischen Prüfung und Kopie doch eine Datei entsteht, schlägt die Kopie fehl statt zu überschreiben
        fs.copyFileSync(src, resolveInside(root, `inputs/${name}`), fs.constants.COPYFILE_EXCL);
        res.files.push(`inputs/${name}`);
      } else {
        // Erst ganz durchsehen, dann kopieren: Ist der Ordner zu groß, landet gar nichts statt einer halben Kopie
        const scan = scanFolder(src);
        if (scan.tooBig) { res.errors.push(`${base}: ${scan.tooBig}, nicht übernommen.`); continue; }
        let name = base;
        for (let i = 2; fs.existsSync(path.join(dest, name)); i++) name = `${base} (${i})`;
        const target = resolveInside(root, `inputs/${name}`);
        // ohne recursive: gibt es den Ordner inzwischen doch, schlägt das fehl statt in einen fremden Ordner zu kopieren
        fs.mkdirSync(target);
        try {
          for (const d of scan.dirs) fs.mkdirSync(path.join(target, d));
          for (const f of scan.files) fs.copyFileSync(path.join(src, f), path.join(target, f), fs.constants.COPYFILE_EXCL);
        } catch (e) {
          // Der Ordner ist eben erst entstanden und gehört nur zu diesem Import, eine halbe Kopie würde den Agenten irreführen
          fs.rmSync(target, { recursive: true, force: true });
          throw e;
        }
        res.files.push(`inputs/${name}/`);
        for (const s of scan.skipped) res.errors.push(`${base}/${s}`);
      }
    } catch (e) { res.errors.push(`${base}: ${e instanceof Error ? e.message : String(e)}`); }
  }
  return res;
}

interface FolderScan { dirs: string[]; files: string[]; skipped: string[]; tooBig?: string }

/**
 * Sammelt Unterordner und Dateien eines gezogenen Ordners (relative Pfade, Eltern vor Kindern).
 * Verknüpfungen werden nicht verfolgt (sie könnten auf beliebige Stellen des Rechners zeigen). .git-Ordner bleiben
 * draußen: Git im Projekt würde ein eingebettetes Repository nur als Verweis ablegen, der Inhalt fehlte dann im Verlauf.
 */
function scanFolder(src: string): FolderScan {
  const scan: FolderScan = { dirs: [], files: [], skipped: [] };
  let bytes = 0;
  const walk = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(src, rel), { withFileTypes: true })) {
      if (scan.tooBig) return;
      const childRel = rel ? path.join(rel, e.name) : e.name;
      const shown = childRel.split(path.sep).join('/');
      if (e.isSymbolicLink()) scan.skipped.push(`${shown}: Verknüpfung, nicht übernommen.`);
      else if (e.isDirectory() && e.name === '.git') scan.skipped.push(`${shown}: eigener Git-Verlauf, nicht übernommen.`);
      else if (e.isDirectory()) { scan.dirs.push(childRel); walk(childRel); }
      else if (e.isFile()) {
        scan.files.push(childRel);
        bytes += fs.statSync(path.join(src, childRel)).size;
        if (bytes > MAX_IMPORT_BYTES) scan.tooBig = 'zusammen größer als 500 MB';
        else if (scan.files.length > MAX_IMPORT_FILES) scan.tooBig = `mehr als ${MAX_IMPORT_FILES} Dateien`;
      } else scan.skipped.push(`${shown}: weder Datei noch Ordner, nicht übernommen.`);
    }
  };
  walk('');
  return scan;
}

/**
 * Legt ein Bild der Markierung in .soma/feedback/ ab (E16). Dort ist es nicht in Git (E11), wandert aber mit der ZIP.
 * Der Name trägt Datum und Uhrzeit, bei Gleichstand kommt „-2“ dazu. Vorhandenes wird nie überschrieben.
 */
export function saveFeedbackImage(root: string, png: unknown, when = new Date()): FeedbackResult {
  const bytes = png instanceof Uint8Array ? png : png instanceof ArrayBuffer ? new Uint8Array(png) : null;
  if (!bytes || bytes.length < PNG_SIGNATURE.length || !PNG_SIGNATURE.equals(bytes.subarray(0, PNG_SIGNATURE.length))) return { ok: false, error: 'Das ist kein PNG-Bild.' };
  if (bytes.length > MAX_FEEDBACK_BYTES) return { ok: false, error: 'Das Bild ist größer als 64 MB.' };
  const two = (n: number) => String(n).padStart(2, '0');
  const stem = `markierung-${when.getFullYear()}${two(when.getMonth() + 1)}${two(when.getDate())}-${two(when.getHours())}${two(when.getMinutes())}`;
  try {
    fs.mkdirSync(resolveInside(root, '.soma/feedback'), { recursive: true });
    for (let i = 1; ; i++) {
      const rel = `.soma/feedback/${stem}${i > 1 ? `-${i}` : ''}.png`;
      try {
        // „wx“: entsteht die Datei zwischen Prüfung und Schreiben, schlägt das Schreiben fehl statt zu überschreiben
        fs.writeFileSync(resolveInside(root, rel), bytes, { flag: 'wx' });
        return { ok: true, path: rel };
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || i > 999) throw e; }
    }
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

/**
 * Schreibt eine Datei aus dem Editor. Agent und Nutzer arbeiten an denselben Dateien: Weicht der Inhalt auf der Platte
 * von `base` ab (dem Stand, den der Editor zuletzt gelesen oder geschrieben hat), wird nicht geschrieben, sondern
 * der Konflikt gemeldet. Mit `force` wird trotzdem geschrieben, die Fassung auf der Platte wandert vorher nach `backupDir`.
 */
export function writeProjectText(root: string, rel: string, text: string, base: string | null, force: boolean, backupDir: string): WriteResult {
  try {
    const abs = resolveInside(root, rel);
    const clean = path.relative(fs.realpathSync(root), path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs)));
    const locked = readOnlyReason(clean);
    if (locked) return { ok: false, error: `${rel} lässt sich hier nicht bearbeiten. ${locked}` };
    let disk: string | null = null;
    try { disk = fs.readFileSync(abs, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (disk !== base && !force) return { ok: false, conflict: true, disk };
    let backup: string | undefined;
    if (force && disk !== null && disk !== text) backup = backupText(backupDir, rel, disk);
    // Erst in eine Nebendatei, dann umbenennen: Ein Build liest so nie eine halb geschriebene Datei.
    // Hält ein anderes Programm die Datei offen (Windows), klappt das Umbenennen nicht, dann direkt schreiben.
    const tmp = `${abs}.soma-tmp`;
    try {
      fs.writeFileSync(tmp, text, 'utf8');
      fs.renameSync(tmp, abs);
    } catch {
      try { fs.rmSync(tmp, { force: true }); } catch { /* bleibt liegen, stört nicht */ }
      fs.writeFileSync(abs, text, 'utf8');
    }
    return { ok: true, backup };
  } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

/** Legt einen Text als Sicherung ab (Name mit Zeitstempel und Pfad) und gibt den Pfad zurück. Nichts wird überschrieben. */
export function backupText(backupDir: string, rel: string, text: string): string {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const name = rel.replace(/[\\/:*?"<>|]/g, '_');
  for (let i = 1; ; i++) {
    const file = path.join(backupDir, `${stamp}${i > 1 ? `-${i}` : ''}-${name}`);
    try { fs.writeFileSync(file, text, { encoding: 'utf8', flag: 'wx' }); return file; } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST' || i > 99) throw e;
    }
  }
}

const exists = (p: string) => { try { fs.lstatSync(p); return true; } catch { return false; } };

/**
 * Loest einen Pfad relativ zum Projektordner auf und lehnt alles ab, was ausserhalb landet
 * (auch ueber Symlinks). Der Renderer bekommt so nie Zugriff auf andere Dateien des Rechners.
 */
export function resolveInside(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  const inside = (p: string, r: string) => p === r || p.startsWith(r + path.sep);
  const outside = () => new Error(`Pfad liegt ausserhalb des Projekts: ${rel}`);
  if (!inside(abs, path.resolve(root))) throw outside();
  // Gibt es das Ziel noch nicht, zählt der nächste vorhandene Ordner darüber. Sonst könnte ein Verweis weiter oben
  // (etwa .soma als Verknüpfung nach außen) neue Dateien außerhalb des Projekts landen lassen.
  let probe = abs, rest = '';
  while (!exists(probe) && path.dirname(probe) !== probe) { rest = rest ? path.join(path.basename(probe), rest) : path.basename(probe); probe = path.dirname(probe); }
  const real = rest ? path.join(fs.realpathSync(probe), rest) : fs.realpathSync(probe);
  if (!inside(real, fs.realpathSync(root))) throw outside();
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
