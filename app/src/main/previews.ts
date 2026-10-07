import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ModelMap } from '../shared/types';
import { readLastBuild, type LastBuild } from './build';

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
