import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/** App-Daten. Fuer Tests per CADIDE_USER_DATA umleitbar, damit nichts im echten Profil landet. */
export function userDataDir(): string {
  return process.env.CADIDE_USER_DATA || app.getPath('userData');
}

export const workspacesDir = () => path.join(userDataDir(), 'workspaces');
/** Zweite Kopie des Projektzustands ausserhalb des Arbeitsordners (E27). */
export const projectStateDir = () => path.join(userDataDir(), 'projects');
export const appStateFile = () => path.join(userDataDir(), 'state.json');

/** Vorlage fuer neue Projekte (liegt neben dem Programm, spaeter im Installationspaket). */
export const templateDir = () => path.join(app.getAppPath(), 'resources', 'template');

/**
 * Python der Basisumgebung. Reihenfolge: CADIDE_PYTHON, Entwicklungs-Umgebung aus Phase 0, sonst `python` im PATH.
 * Die mitgelieferte Basisumgebung ersetzt das spaeter (Auslieferung ist noch offen).
 */
export function pythonExe(): string {
  if (process.env.CADIDE_PYTHON) return process.env.CADIDE_PYTHON;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const dev = path.join(process.env.LOCALAPPDATA, 'cadide-phase0', 'venv-full', 'Scripts', 'python.exe');
    if (fs.existsSync(dev)) return dev;
  }
  return process.platform === 'win32' ? 'python.exe' : 'python3';
}

/** Ordner mit python und cadide-Startprogramm, kommt bei Terminals an den Anfang von PATH. */
export function pythonBinDir(): string | null {
  const exe = pythonExe();
  return path.isAbsolute(exe) ? path.dirname(exe) : null;
}
