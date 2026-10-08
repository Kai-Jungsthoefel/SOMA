import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import yazl from 'yazl';

/** Marker, den die App beim Speichern in die ZIP legt. Damit erkennt sie beim Öffnen, ob der Arbeitsordner abweicht (E21). */
export interface ZipInfo { savedAt: string; head: string | null; id: string; name: string }
export const ZIP_INFO_PATH = '.soma/zip-info.json';

/** Wird nie gepackt: Umgebungen und Caches (Umgebung wird aus requirements.txt neu gebaut, Cache neu erzeugt). */
const SKIP_DIRS = new Set(['.venv', 'venv', 'env', '__pycache__', 'node_modules']);
const SKIP_FILES = new Set(['.soma/model.glb', '.soma/model.map.json', '.soma/build.json']);
/**
 * Ganze Ordner, die nie gepackt werden (Pfad relativ zum Projekt): die Geometrie für das Messen entsteht beim Bauen neu,
 * Animationen baut die App beim Öffnen neu, Ergebnisse von soma analyze (bis zu 70 MB je Auswertung) rechnet man neu.
 * Die Projektumgebung (E67) legt die App beim Öffnen an und installiert dabei requirements.txt. Bilder und Videos von
 * soma render entstehen aus dem Code neu (E75, beim Hotwire 41 % der ZIP).
 */
const SKIP_PATHS = new Set(['.soma/geometry', '.soma/anim', '.soma/results', '.soma/drawings', '.soma/env', 'renders']);
/** Schon gepackt (Git-Objekte sind zlib, Bilder und Videos komprimiert): nur ablegen, nochmal Deflate kostet nur Zeit. */
const STORED = /^\.git\/objects\/|\.(png|jpe?g|webp|mp4|webm|zip|gz|7z|pack)$/i;
const MAX_UNPACKED = 2 * 1024 ** 3;

function collect(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !SKIP_PATHS.has(r)) walk(path.join(dir, e.name), r); continue; }
      if (SKIP_FILES.has(r) || (r.startsWith('.git/') && r.endsWith('.lock'))) continue;
      out.push(r);
    }
  };
  walk(root, '');
  return out;
}

/** Packt den Projektordner (inklusive .git) atomar in `zipPath`: erst eine .part-Datei, dann umbenennen. */
export async function saveProjectZip(dir: string, zipPath: string, info: ZipInfo): Promise<{ files: number; bytes: number }> {
  const files = collect(dir);
  const zip = new yazl.ZipFile();
  for (const rel of files) if (rel !== ZIP_INFO_PATH) zip.addFile(path.join(dir, rel), rel, { compress: !STORED.test(rel) });
  zip.addBuffer(Buffer.from(JSON.stringify(info, null, 2)), ZIP_INFO_PATH);
  zip.end();
  const tmp = zipPath + '.part';
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  try {
    await pipeline(zip.outputStream, fs.createWriteStream(tmp));
    fs.renameSync(tmp, zipPath);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
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
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) { reject(err ?? new Error('Entry not readable')); return; }
        pipeline(stream, fs.createWriteStream(target)).then(() => { count++; zip.readEntry(); }, reject);
      });
    });
    zip.readEntry();
  });
}
