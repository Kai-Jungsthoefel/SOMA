import fs from 'node:fs';
import path from 'node:path';
import { fileOpBlockReason, readOnlyReason } from '../shared/editable';
import type { FeedbackResult, FileNode, FileOpResult, ImportResult, WriteResult } from '../shared/types';

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
      if (st.isSymbolicLink()) { res.errors.push(`${base}: links are not copied.`); continue; }
      if (!st.isFile() && !st.isDirectory()) { res.errors.push(`${base}: neither a file nor a folder, not copied.`); continue; }
      const dest = resolveInside(root, 'inputs');
      fs.mkdirSync(dest, { recursive: true });
      if (st.isFile()) {
        if (st.size > MAX_IMPORT_BYTES) { res.errors.push(`${base}: larger than 500 MB, not copied.`); continue; }
        const ext = path.extname(base), stem = base.slice(0, base.length - ext.length);
        let name = base;
        for (let i = 2; fs.existsSync(path.join(dest, name)); i++) name = `${stem} (${i})${ext}`;
        // COPYFILE_EXCL: falls zwischen Prüfung und Kopie doch eine Datei entsteht, schlägt die Kopie fehl statt zu überschreiben
        fs.copyFileSync(src, resolveInside(root, `inputs/${name}`), fs.constants.COPYFILE_EXCL);
        res.files.push(`inputs/${name}`);
      } else {
        // Erst ganz durchsehen, dann kopieren: Ist der Ordner zu groß, landet gar nichts statt einer halben Kopie
        const scan = scanFolder(src);
        if (scan.tooBig) { res.errors.push(`${base}: ${scan.tooBig}, not copied.`); continue; }
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
      if (e.isSymbolicLink()) scan.skipped.push(`${shown}: link, not copied.`);
      else if (e.isDirectory() && e.name === '.git') scan.skipped.push(`${shown}: its own Git history, not copied.`);
      else if (e.isDirectory()) { scan.dirs.push(childRel); walk(childRel); }
      else if (e.isFile()) {
        scan.files.push(childRel);
        bytes += fs.statSync(path.join(src, childRel)).size;
        if (bytes > MAX_IMPORT_BYTES) scan.tooBig = 'larger than 500 MB in total';
        else if (scan.files.length > MAX_IMPORT_FILES) scan.tooBig = `more than ${MAX_IMPORT_FILES} files`;
      } else scan.skipped.push(`${shown}: neither a file nor a folder, not copied.`);
    }
  };
  walk('');
  return scan;
}

// ---- Dateibaum: anlegen, umbenennen, löschen, öffnen ---------------------------------------------------------

/** Unter Windows verbotene Namen (auch mit Endung, etwa „con.txt“). */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
/**
 * Dateien, die beim Öffnen mit dem Standardprogramm etwas ausführen würden. Der Arbeitsordner ist nicht vertrauenswürdig
 * (der Agent schreibt dort), ein Klick im Dateibaum darf kein Programm starten. Python-Dateien öffnet das Code-Panel.
 */
const RUNNABLE = /\.(exe|com|bat|cmd|ps1|psm1|psd1|vbs|vbe|js|jse|mjs|wsf|wsh|msi|msp|scr|pif|lnk|url|hta|cpl|jar|reg|py|pyw|pyz|sh|appref-ms|application|msc|scf|inf|settingcontent-ms)$/i;

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Fehler im Namen einer neuen oder umbenannten Datei, sonst null. Nur ein Name, kein Pfad. */
export function nameError(name: string): string | null {
  if (!name.trim()) return 'The name is empty.';
  if (name !== name.trim()) return 'The name starts or ends with a space.';
  if (/[\\/:*?"<>|\x00-\x1f]/.test(name)) return 'These characters are not allowed in names: \\ / : * ? " < > |';
  if (name === '.' || name === '..') return 'This name is not allowed.';
  if (/\.$/.test(name)) return 'The name must not end with a dot.';
  if (RESERVED.test(name)) return `“${name}” is a reserved name on Windows.`;
  if (name.length > 200) return 'The name is too long.';
  return null;
}

/** Pfad aus dem Renderer in die feste Form „a/b“ bringen. „..“ wird abgelehnt, damit die Regeln nicht umgangen werden. */
function cleanRel(rel: string): string {
  // normalize nimmt „./“ vorne schon weg. Nur „.“ allein ist der Projektordner, „.soma“ bleibt „.soma“.
  const p = path.posix.normalize(String(rel).replace(/\\/g, '/')).replace(/\/$/, '');
  if (p === '.' || p === '') return '';
  if (p === '..' || p.startsWith('../') || path.posix.isAbsolute(p) || /^[a-z]:/i.test(p)) throw new Error(`Path is outside the project: ${rel}`);
  return p;
}

const joinRel = (parent: string, name: string) => (parent ? `${parent}/${name}` : name);

/** Neue, leere Datei oder neuer Ordner. Gibt es den Namen schon, wird nichts angelegt. */
export function createEntry(root: string, parent: string, name: string, dir: boolean): FileOpResult {
  try {
    const base = cleanRel(parent);
    const bad = nameError(name);
    if (bad) return { ok: false, error: bad };
    const rel = joinRel(base, name);
    const block = fileOpBlockReason(base, 'create') ?? fileOpBlockReason(rel, 'create');
    if (block) return { ok: false, error: `Nothing can be created here. ${block}` };
    const parentAbs = resolveInside(root, base || '.');
    if (!fs.statSync(parentAbs).isDirectory()) return { ok: false, error: `${base} is not a folder.` };
    const abs = resolveInside(root, rel);
    // Ohne recursive bzw. mit „wx“: Entsteht der Name gleichzeitig, schlägt das fehl statt zu überschreiben
    if (dir) fs.mkdirSync(abs); else fs.writeFileSync(abs, '', { flag: 'wx' });
    return { ok: true, path: rel };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return { ok: false, error: `“${name}” already exists there.` };
    return { ok: false, error: errMsg(e) };
  }
}

/** Umbenennen im selben Ordner. Gibt es den neuen Namen schon, bleibt alles, wie es ist. Nur Groß-/Kleinschreibung ändern geht. */
export function renameEntry(root: string, rel: string, name: string): FileOpResult {
  try {
    const from = cleanRel(rel);
    const block = fileOpBlockReason(from, 'rename');
    if (block) return { ok: false, error: `${from} cannot be renamed. ${block}` };
    const bad = nameError(name);
    if (bad) return { ok: false, error: bad };
    const old = path.posix.basename(from);
    const to = joinRel(path.posix.dirname(from) === '.' ? '' : path.posix.dirname(from), name);
    if (name === old) return { ok: true, path: from };
    const blockTo = fileOpBlockReason(to, 'create');
    if (blockTo) return { ok: false, error: `This name is not allowed here. ${blockTo}` };
    const abs = resolveInside(root, from);
    if (fs.lstatSync(abs).isSymbolicLink()) return { ok: false, error: 'Links cannot be renamed here.' };
    const target = resolveInside(root, to);
    // Windows und macOS unterscheiden Groß und klein nicht: „Teil.py“ → „teil.py“ findet sich selbst als vorhanden
    const caseOnly = name.toLowerCase() === old.toLowerCase();
    if (!caseOnly && exists(target)) return { ok: false, error: `“${name}” already exists there.` };
    fs.renameSync(abs, target);
    return { ok: true, path: to };
  } catch (e) { return { ok: false, error: errMsg(e) }; }
}

/**
 * Verschiebt in den Papierkorb (`trash`, im Hauptprozess `shell.trashItem`). Klappt das nicht, wird nichts gelöscht:
 * endgültiges Löschen gibt es im Dateibaum nicht (Grundsatz: nichts still löschen).
 */
export async function trashEntry(root: string, rel: string, trash: (abs: string) => Promise<void>): Promise<FileOpResult> {
  try {
    const p = cleanRel(rel);
    const block = fileOpBlockReason(p, 'delete');
    if (block) return { ok: false, error: `${p} cannot be deleted. ${block}` };
    const abs = resolveInside(root, p);
    fs.lstatSync(abs);
    try { await trash(abs); } catch (e) { return { ok: false, error: `Could not move ${p} to the Recycle Bin, nothing was deleted: ${errMsg(e)}` }; }
    return { ok: true, path: p };
  } catch (e) { return { ok: false, error: errMsg(e) }; }
}

/** Prüft einen Pfad zum Zeigen oder Öffnen und gibt den absoluten Pfad zurück. */
export function entryPath(root: string, rel: string, forOpen: boolean): { abs?: string; error?: string } {
  try {
    const p = cleanRel(rel);
    const abs = resolveInside(root, p || '.');
    const st = fs.statSync(abs);
    if (forOpen && st.isFile() && RUNNABLE.test(p)) return { error: `${path.posix.basename(p)} could start a program when opened. SOMA does not open such files, “Show in Explorer” works.` };
    return { abs };
  } catch (e) { return { error: errMsg(e) }; }
}

/**
 * Legt ein Bild der Markierung in .soma/feedback/ ab (E16). Dort ist es nicht in Git (E11), wandert aber mit der ZIP.
 * Der Name trägt Datum und Uhrzeit, bei Gleichstand kommt „-2“ dazu. Vorhandenes wird nie überschrieben.
 */
export function saveFeedbackImage(root: string, png: unknown, when = new Date()): FeedbackResult {
  const bytes = png instanceof Uint8Array ? png : png instanceof ArrayBuffer ? new Uint8Array(png) : null;
  if (!bytes || bytes.length < PNG_SIGNATURE.length || !PNG_SIGNATURE.equals(bytes.subarray(0, PNG_SIGNATURE.length))) return { ok: false, error: 'This is not a PNG image.' };
  if (bytes.length > MAX_FEEDBACK_BYTES) return { ok: false, error: 'The image is larger than 64 MB.' };
  const two = (n: number) => String(n).padStart(2, '0');
  const stem = `markup-${when.getFullYear()}${two(when.getMonth() + 1)}${two(when.getDate())}-${two(when.getHours())}${two(when.getMinutes())}`;
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
    if (locked) return { ok: false, error: `${rel} cannot be edited here. ${locked}` };
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
  const outside = () => new Error(`Path is outside the project: ${rel}`);
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
  const nodes = walk(root, '', 0);
  // Aus .soma/ kommen nur zwei Ordner mit, der Rest sind Zwischenstände und die Umgebung des Projekts (tausende Dateien).
  // Markierungen (E16), damit der Nutzer sie wiederfindet und erneut an den Agenten geben kann, neueste zuerst (der Name
  // beginnt mit Datum und Uhrzeit). Die Kopien der Skills (E17) zum Nachlesen, umgestellt wird im Panel „Skills“.
  try { if (!fs.lstatSync(path.join(root, '.soma')).isDirectory()) return nodes; } catch { return nodes; }
  for (const [name, newestFirst] of [['feedback', true], ['skills', false]] as const) {
    const dir = path.join(root, '.soma', name);
    try { if (!fs.lstatSync(dir).isDirectory()) continue; } catch { continue; }
    const children = walk(dir, `.soma/${name}`, 1);
    nodes.push({ name, path: `.soma/${name}`, dir: true, children: newestFirst ? children.reverse() : children });
  }
  return nodes;
}
