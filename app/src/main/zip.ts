import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import yazl from 'yazl';

/**
 * Marker, den die App beim Speichern in die Modelldatei legt (eine .soma ist eine ZIP, E79). Damit erkennt sie beim Öffnen,
 * ob der Arbeitsordner abweicht (E21). `dirty`: Beim Export als ZIP gab es Änderungen seit dem letzten Commit, die Datei
 * entspricht dann keinem Stand im Verlauf.
 */
export interface ZipInfo { savedAt: string; head: string | null; id: string; name: string; dirty?: boolean }
export const ZIP_INFO_PATH = '.soma/zip-info.json';

/** Wird nie gepackt: Umgebungen und Caches (Umgebung wird aus requirements.txt neu gebaut, Cache neu erzeugt). */
const SKIP_DIRS = new Set(['.venv', 'venv', 'env', '__pycache__', 'node_modules']);
const SKIP_FILES = new Set(['.soma/model.glb', '.soma/model.map.json', '.soma/build.json']);
/**
 * Ganze Ordner, die nie gepackt werden (Pfad relativ zum Projekt): die Geometrie für das Messen entsteht beim Bauen neu,
 * Animationen baut die App beim Öffnen neu (fehlende, siehe Projects.open). Ergebnisse von soma analyze: siehe ONLY_FILES.
 * Die Projektumgebung (E67) legt die App beim Öffnen an und installiert dabei requirements.txt. Bilder und Videos von
 * soma render entstehen aus dem Code neu (E75, beim Hotwire 41 % der ZIP). Die Bilder der Anleitung kopiert die App beim
 * Öffnen ins Projekt (E83).
 */
const SKIP_PATHS = new Set(['.soma/geometry', '.soma/anim', '.soma/env', '.soma/help', '.soma/component-backups', 'renders']);
/**
 * Folders of which only these files are packed. The drawings index (E97) is what the "Drawings" view lists and links to
 * the model. Without it the view was empty after opening the file, although the PDFs in output/drawings were there.
 * The pictures of the sheets for the agent stay out (E76), `soma drawing build` writes them again.
 */
const ONLY_FILES = new Map([['.soma/drawings', new Set(['index.json'])],
  // Results of soma analyze are large (up to 70 MB each): only their index goes along, the Analysis tab lists them with
  // their values and computes them again on request
  ['.soma/results', new Set(['index.json'])]]);
/** Schon gepackt (Git-Objekte sind zlib, Bilder und Videos komprimiert): nur ablegen, nochmal Deflate kostet nur Zeit. */
const STORED = /^\.git\/objects\/|\.(png|jpe?g|webp|mp4|webm|zip|soma|gz|7z|pack)$/i;
const MAX_UNPACKED = 2 * 1024 ** 3;

function collect(root: string, withGit: boolean): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    const only = ONLY_FILES.get(rel);
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (only) { if (e.isFile() && only.has(e.name)) out.push(r); continue; }
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !SKIP_PATHS.has(r) && (withGit || r !== '.git')) walk(path.join(dir, e.name), r); continue; }
      if (SKIP_FILES.has(r) || (r.startsWith('.git/') && r.endsWith('.lock'))) continue;
      out.push(r);
    }
  };
  walk(root, '');
  return out;
}

/** Packt den Projektordner (inklusive .git) atomar in `zipPath`: erst eine .part-Datei, dann umbenennen. */
/** `withGit`: false für einen geöffneten Ordner (Ordner-Modus): Sein Repository gehört dem Nutzer und geht nicht mit. */
export async function saveProjectZip(dir: string, zipPath: string, info: ZipInfo, withGit = true): Promise<{ files: number; bytes: number }> {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  // Ändert sich eine Datei beim Packen (Agent, Build, OneDrive), ist sie meist beim zweiten Versuch wieder still
  try { return await packOnce(dir, zipPath, info, withGit); }
  catch (e) {
    if (!(e instanceof FileChangedError)) throw e;
    console.warn(`[zip] ${e.cause instanceof Error ? e.cause.message : String(e.cause)}, packing again`);
    return await packOnce(dir, zipPath, info, withGit);
  }
}

/** Eine Datei hat sich zwischen Auflisten und Lesen geändert oder ist verschwunden. */
class FileChangedError extends Error {
  constructor(cause: unknown) { super('A file of the model changed while it was being saved. Please save again.', { cause }); }
}

async function packOnce(dir: string, zipPath: string, info: ZipInfo, withGit: boolean): Promise<{ files: number; bytes: number }> {
  const files = collect(dir, withGit);
  const zip = new yazl.ZipFile();
  // yazl merkt sich die Größe beim addFile und meldet eine Abweichung beim Lesen als 'error' am ZipFile, nicht am Stream.
  // Ohne Listener wäre das eine Uncaught Exception im Main-Prozess, und der Stream endete nie (Speichern hinge).
  let failure: FileChangedError | null = null;
  zip.on('error', (e: unknown) => { failure ??= new FileChangedError(e); (zip.outputStream as Readable).destroy(failure); });
  for (const rel of files) if (rel !== ZIP_INFO_PATH) zip.addFile(path.join(dir, rel), rel, { compress: !STORED.test(rel) });
  zip.addBuffer(Buffer.from(JSON.stringify(info, null, 2)), ZIP_INFO_PATH);
  zip.end();
  const tmp = zipPath + '.part';
  const out = fs.createWriteStream(tmp);
  try {
    await pipeline(zip.outputStream, out);
    fs.renameSync(tmp, zipPath);
  } catch (e) {
    // Unter Windows lässt sich die Datei erst löschen, wenn der Stream sie geschlossen hat
    if (!out.closed) await new Promise<void>((r) => out.once('close', () => r()));
    fs.rmSync(tmp, { force: true });
    throw failure ?? e;
  }
  return { files: files.length + 1, bytes: fs.statSync(zipPath).size };
}

function openZip(zipPath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, z) => (err || !z ? reject(err ?? new Error('ZIP not readable')) : resolve(z)));
  });
}

/** Ein Eintrag ist nur sicher, wenn er relativ ist und den Zielordner nicht verlässt (Zip-Slip). */
export function isSafeEntryName(name: string): boolean {
  if (!name || name.startsWith('/') || name.startsWith('\\') || /^[a-zA-Z]:/.test(name) || name.includes('\0')) return false;
  return !name.split(/[\\/]/).includes('..');
}

/** Liest einzelne Textdateien aus der ZIP, ohne sie zu entpacken. Fehlende Dateien liefern null. */
export async function readZipTexts(zipPath: string, names: string[]): Promise<Record<string, string | null>> {
  const zip = await openZip(zipPath);
  const found: Record<string, string | null> = Object.fromEntries(names.map((n) => [n, null]));
  return new Promise((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', () => resolve(found));
    zip.on('entry', (entry: yauzl.Entry) => {
      if (!names.includes(entry.fileName) || entry.uncompressedSize > 5 * 1024 * 1024) { zip.readEntry(); return; }
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) { reject(err ?? new Error('Entry not readable')); return; }
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => { found[entry.fileName] = Buffer.concat(chunks).toString('utf8'); zip.readEntry(); });
        stream.on('error', reject);
      });
    });
    zip.readEntry();
  });
}

/** Entpackt nach `dest` (muss leer bzw. neu sein). Unsichere Pfade und zu große Archive werden abgelehnt. */
export async function extractZip(zipPath: string, dest: string): Promise<number> {
  const zip = await openZip(zipPath);
  const root = path.resolve(dest);
  fs.mkdirSync(root, { recursive: true });
  let count = 0, total = 0;
  return new Promise((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', () => resolve(count));
    zip.on('entry', (entry: yauzl.Entry) => {
      total += entry.uncompressedSize;
      if (total > MAX_UNPACKED) { reject(new Error('Unpacked, the ZIP is larger than 2 GB and will not be opened.')); zip.close(); return; }
      if (!isSafeEntryName(entry.fileName)) { reject(new Error(`Unsafe path in the ZIP: ${entry.fileName}`)); zip.close(); return; }
      const target = path.resolve(root, entry.fileName);
      if (target !== root && !target.startsWith(root + path.sep)) { reject(new Error(`Unsafe path in the ZIP: ${entry.fileName}`)); zip.close(); return; }
      if (entry.fileName.endsWith('/')) { fs.mkdirSync(target, { recursive: true }); zip.readEntry(); return; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // Keep the modification time from the file (to the second). The app and soma compare times to tell what is out of
      // date ("older than the code"). With the time of unpacking, a file packed after the PDFs, such as parameters.json,
      // made every drawing look out of date.
      const mtime = entry.getLastModDate();
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) { reject(err ?? new Error('Entry not readable')); return; }
        pipeline(stream, fs.createWriteStream(target)).then(() => {
          if (Number.isFinite(mtime.getTime())) try { fs.utimesSync(target, mtime, mtime); } catch { /* the time is only a hint */ }
          count++;
          zip.readEntry();
        }, reject);
      });
    });
    zip.readEntry();
  });
}
