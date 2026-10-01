// Liefert den Pfad zu einem Electron, das die App starten kann.
//
// Unter Windows starten die sandboxed Prozesse von Chromium (Renderer, GPU) nicht, wenn electron.exe auf einem Netzlaufwerk
// liegt: sie laufen mit eingeschränktem Token und verlieren dort den Zugriff ("launch-failed", Code 18, schwarzes Fenster).
// Liegt node_modules auf einem Netzlaufwerk, wird deshalb einmalig eine lokale Kopie angelegt. Die App selbst (dist/,
// node_modules) darf weiter auf dem Netzlaufwerk liegen, sie wird vom unsandboxed Hauptprozess geladen.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function electronExe(appDir) {
  const exeName = process.platform === 'win32' ? 'electron.exe' : 'electron';
  const dist = path.join(appDir, 'node_modules', 'electron', 'dist');
  const direct = path.join(dist, exeName);
  if (process.platform !== 'win32') return direct;
  if (!fs.realpathSync.native(dist).startsWith('\\\\')) return direct; // lokale Platte

  const version = JSON.parse(fs.readFileSync(path.join(appDir, 'node_modules', 'electron', 'package.json'), 'utf8')).version;
  const local = path.join(process.env.LOCALAPPDATA ?? os.tmpdir(), 'soma-dev', `electron-${version}`);
  const stamp = path.join(local, '.kopiert');
  if (!fs.existsSync(stamp)) {
    console.log(`Electron liegt auf einem Netzlaufwerk. Lokale Kopie nach ${local} (einmalig, rund 370 MB) ...`);
    fs.rmSync(local, { recursive: true, force: true });
    fs.cpSync(dist, local, { recursive: true });
    fs.writeFileSync(stamp, version);
  }
  return path.join(local, exeName);
}
