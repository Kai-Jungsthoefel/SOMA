import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ModelMap } from '../shared/types';
import { readLastBuild, runSoma, type LastBuild } from './build';

/** Eine GLB-Datei ist vollständig, wenn ihr Kopf passt und die angegebene Gesamtlänge der Dateigröße entspricht. */
function completeGlb(file: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(12);
    if (fs.readSync(fd, head, 0, 12, 0) !== 12 || head.readUInt32LE(0) !== 0x46546c67) return false;
    return head.readUInt32LE(8) === fs.fstatSync(fd).size;
  } catch { return false; } finally { if (fd !== null) fs.closeSync(fd); }
}

/**
 * Legt den aktuellen Build (`last`, aus .soma/) als Vorschau eines Standes im Verlauf nach `target`, in derselben Form wie
 * `soma glb` sie schreibt: model.glb, model.map.json und geometry/<build>.brep zum Messen. Der Aufrufer stellt sicher, dass
 * der Build genau diesen Stand zeigt (Arbeitsordner sauber, Build aktuell).
 *
 * Bleibt etwas nicht stehen, während kopiert wird (neuer Build, `stillValid` meldet false), wird die Kopie verworfen: eine
 * halbe Vorschau wäre schlimmer als keine, die entsteht dann wie bisher aus der STEP-Datei. Erst ein fertiger Ordner wird
 * umbenannt. Liefert true, wenn die Vorschau angelegt wurde.
 */
export async function storeBuildAsPreview(dir: string, target: string, last: LastBuild, stillValid: () => boolean): Promise<boolean> {
  const soma = path.join(dir, '.soma');
  const tmp = `${target}.tmp-${randomUUID()}`;
  try {
    const map = JSON.parse(await fs.promises.readFile(path.join(soma, 'model.map.json'), 'utf8')) as ModelMap;
    if (typeof map.build !== 'string' || !/^[0-9a-f]{32}$/.test(map.build) || !Array.isArray(map.parts)) return false;
    // Ohne Verweise auf den Code: In der Vorschau zeigt der Editor den aktuellen Code, dessen Zeilen passen womöglich nicht
    const parts = map.parts.map(({ file: _f, line: _l, end_line: _e, ...rest }) => rest);
    await fs.promises.mkdir(path.join(tmp, 'geometry'), { recursive: true });
    await fs.promises.copyFile(path.join(soma, 'model.glb'), path.join(tmp, 'model.glb'));
    await fs.promises.copyFile(path.join(soma, 'geometry', `${map.build}.brep`), path.join(tmp, 'geometry', `${map.build}.brep`));
    await fs.promises.writeFile(path.join(tmp, 'model.map.json'), JSON.stringify({ ...map, parts }, null, 1));
    // Inzwischen neu gebaut (auch vom Agenten im Terminal, den die App nicht mitbekommt)? Dann könnte die Kopie gemischt sein
    const now = readLastBuild(dir);
    const again = JSON.parse(await fs.promises.readFile(path.join(soma, 'model.map.json'), 'utf8')) as ModelMap;
    if (!stillValid() || now?.finished !== last.finished || again.build !== map.build || !completeGlb(path.join(tmp, 'model.glb'))) {
      await fs.promises.rm(tmp, { recursive: true, force: true });
      return false;
    }
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.rename(tmp, target);
    return true;
  } catch {
    // Gibt es die Vorschau schon (gleichzeitig angelegt) oder fehlt eine Datei: nichts zu tun, ohne Cache geht es wie bisher
    await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {});
    return false;
  }
}

// ---- STEP-Dateien aus dem Projekt im Viewer ------------------------------------------------------------------------

/** Große Baugruppen einzulesen und zu vernetzen dauert Minuten, aber nicht ewig: danach gilt die Datei als zu groß. */
export const STEP_VIEW_TIMEOUT_MS = 10 * 60 * 1000;
/** Übrig gebliebene Arbeitsordner (App abgestürzt) älter als das werden beim nächsten Umwandeln entfernt. */
const STALE_TMP_MS = 24 * 60 * 60 * 1000;

/** Vorschau-Ordner vollständig: Zuordnung lesbar, GLB ganz und die Geometrie zum Messen da. */
export function previewComplete(dir: string): boolean {
  try {
    const map = JSON.parse(fs.readFileSync(path.join(dir, 'model.map.json'), 'utf8')) as ModelMap;
    return typeof map.build === 'string' && /^[0-9a-f]{32}$/.test(map.build) && Array.isArray(map.parts)
      && completeGlb(path.join(dir, 'model.glb')) && fs.statSync(path.join(dir, 'geometry', `${map.build}.brep`)).isFile();
  } catch { return false; }
}

function sha1File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha1');
    fs.createReadStream(file).on('error', reject).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex')));
  });
}

/** Größe und Zeitstempel einer Datei, deren Inhalt schon gehasht wurde: Unverändert muss sie nicht neu gelesen werden. */
export interface StepStamp { size: number; mtimeMs: number; key: string }

/**
 * Wandelt eine STEP-Datei aus dem Projekt (`abs`, schon über resolveInside geprüft) mit `soma glb` für den Viewer um. Der
 * Cache liegt unter `root/<SHA-1 des Inhalts>`, in derselben Form wie die Vorschau alter Stände (model.glb, model.map.json,
 * geometry/), damit Messen, Schnitt und Explosion genauso gehen. Eine unveränderte Datei wird nicht neu umgewandelt.
 *
 * Umgewandelt wird eine Kopie: Schreibt der Agent die Datei währenddessen neu, passte das Ergebnis sonst nicht zum Hash.
 * Alles entsteht in einem Arbeitsordner und wird erst fertig umbenannt, ein halber Cache-Ordner bleibt nie stehen.
 * `cwd`: Projektordner für den Python-Prozess. Kein Wurf, Fehler stehen verständlich in `error`.
 */
export async function stepPreview(abs: string, root: string, cwd: string, memo: Map<string, StepStamp>): Promise<{ key: string; dir: string } | { error: string }> {
  let st: fs.Stats;
  try { st = await fs.promises.stat(abs); } catch { return { error: 'The file no longer exists.' }; }
  if (!st.isFile()) return { error: 'This is not a file.' };
  if (st.size === 0) return { error: 'The file is empty.' };
  const known = memo.get(abs);
  if (known && known.size === st.size && known.mtimeMs === st.mtimeMs && previewComplete(path.join(root, known.key))) return { key: known.key, dir: path.join(root, known.key) };

  await fs.promises.mkdir(root, { recursive: true });
  void removeStaleTmp(root);
  const tmp = path.join(root, `.tmp-${randomUUID()}`);
  const drop = () => fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  try {
    await fs.promises.mkdir(tmp);
    const copy = path.join(tmp, `source${path.extname(abs).toLowerCase()}`);
    try { await fs.promises.copyFile(abs, copy); } catch (e) { await drop(); return { error: `The file could not be read: ${e instanceof Error ? e.message : String(e)}` }; }
    const key = await sha1File(copy);
    // Nur merken, wenn die Datei beim Kopieren stillstand: Sonst gehört der Hash zu einem anderen Zeitstempel
    const after = await fs.promises.stat(abs).catch(() => null);
    if (after && after.size === st.size && after.mtimeMs === st.mtimeMs) memo.set(abs, { size: st.size, mtimeMs: st.mtimeMs, key });
    const target = path.join(root, key);
    if (previewComplete(target)) { await drop(); return { key, dir: target }; }

    const t0 = Date.now();
    const r = await runSoma(['glb', copy, '--out', tmp], cwd, STEP_VIEW_TIMEOUT_MS);
    if (!r.ok) {
      await drop();
      if (Date.now() - t0 >= STEP_VIEW_TIMEOUT_MS - 1000) return { error: `Reading the file took longer than ${STEP_VIEW_TIMEOUT_MS / 60000} minutes and was stopped. The file may be too large for the viewer.` };
      // Die Meldung nennt sonst den Pfad der Arbeitskopie, mit dem der Nutzer nichts anfangen kann
      const last = ((r.err || r.out).trim().split(/\r?\n/).pop() ?? '').replace(/^Conversion failed:\s*/, '').replace(/^\w+(Error|Exception):\s*/, '')
        .split(copy).join(path.basename(abs));
      if (/Error reading STEP file|could not be loaded/i.test(last)) return { error: 'The file is not a valid STEP file or it is damaged.' };
      return { error: `The STEP file could not be read${last ? `: ${last}` : '.'}` };
    }
    await fs.promises.rm(copy, { force: true });
    if (!previewComplete(tmp)) { await drop(); return { error: 'The conversion did not produce a complete result.' }; }
    // Inzwischen gleichzeitig fertig geworden (zweiter Aufruf für dieselbe Datei): dessen Ergebnis nehmen
    if (previewComplete(target)) { await drop(); return { key, dir: target }; }
    try {
      // Steht ein unvollständiger Rest unter dem Namen (etwa von einer älteren Fassung), weicht er erst
      if (fs.existsSync(target)) await fs.promises.rm(target, { recursive: true, force: true });
      await fs.promises.rename(tmp, target);
    } catch {
      // Gleichzeitig dieselbe Datei umgewandelt: Dann gilt die, die zuerst fertig war
      await drop();
      if (!previewComplete(target)) return { error: 'The result could not be stored in the preview cache.' };
    }
    return { key, dir: target };
  } catch (e) {
    await drop();
    return { error: `The file could not be shown: ${e instanceof Error ? e.message : String(e)}` };
  }
}

async function removeStaleTmp(root: string): Promise<void> {
  try {
    for (const n of await fs.promises.readdir(root)) {
      if (!n.startsWith('.tmp-')) continue;
      const p = path.join(root, n);
      const st = await fs.promises.stat(p).catch(() => null);
      if (st && Date.now() - st.mtimeMs > STALE_TMP_MS) await fs.promises.rm(p, { recursive: true, force: true }).catch(() => {});
    }
  } catch { /* Aufräumen ist verzichtbar */ }
}
