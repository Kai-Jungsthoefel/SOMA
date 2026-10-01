import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/** App-Daten. Fuer Tests per SOMA_USER_DATA umleitbar, damit nichts im echten Profil landet. */
export function userDataDir(): string {
  return process.env.SOMA_USER_DATA || app.getPath('userData');
}

export const workspacesDir = () => path.join(userDataDir(), 'workspaces');
/** Zweite Kopie des Projektzustands ausserhalb des Arbeitsordners (E27). */
export const projectStateDir = () => path.join(userDataDir(), 'projects');
export const appStateFile = () => path.join(userDataDir(), 'state.json');
/** Gesicherte Arbeitsordner (wenn eine ZIP den Arbeitsstand ersetzt). */
export const backupsDir = () => path.join(userDataDir(), 'workspace-backups');
/** Sicherungen aus dem Editor (Fassungen, die bei einem Konflikt ersetzt wurden), je Projekt. */
export const editBackupsDir = (id: string) => path.join(backupsDir(), `${id}-editor`);
/** Sicherungen von Skill-Kopien, die beim Ein- oder Ausschalten ersetzt oder entfernt wurden, je Projekt. */
export const skillBackupsDir = (id: string) => path.join(backupsDir(), `${id}-skills`);
/** Vorschauen alter Stände (aus dem Verlauf erzeugt, jederzeit neu erzeugbar). */
export const previewsDir = () => path.join(userDataDir(), 'previews');
/** Vorschaubilder für die Startseite (vom Viewer nach dem Laden des Modells, jederzeit neu erzeugbar). */
export const thumbnailsDir = () => path.join(userDataDir(), 'thumbnails');

/** Vorlage fuer neue Projekte (liegt neben dem Programm, spaeter im Installationspaket). */
export const templateDir = () => path.join(app.getAppPath(), 'resources', 'template');

/** Mitgelieferte Skills (E17), je einer als Markdown. */
export const skillsDir = () => path.join(app.getAppPath(), 'resources', 'skills');

/** App-Icon (E44) für Fenster und Taskleiste. Windows nimmt die ICO mit allen Größen, andere Systeme das PNG. */
export const appIcon = () => path.join(app.getAppPath(), 'resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

/**
 * Python der Basisumgebung. Reihenfolge: SOMA_PYTHON, Entwicklungs-Umgebung aus Phase 0, sonst `python` im PATH.
 * Die mitgelieferte Basisumgebung ersetzt das spaeter (Auslieferung ist noch offen).
 */
export function pythonExe(): string {
  if (process.env.SOMA_PYTHON) return process.env.SOMA_PYTHON;
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const dev = path.join(process.env.LOCALAPPDATA, 'cadide-phase0', 'venv-full', 'Scripts', 'python.exe');
    if (fs.existsSync(dev)) return dev;
  }
  return process.platform === 'win32' ? 'python.exe' : 'python3';
}

/** Ordner des mitgelieferten Git (dugite). Kommt in die Terminals, damit Agent und App dasselbe Git benutzen (E31). */
export function gitCmdDir(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return path.dirname((require('dugite') as typeof import('dugite')).resolveGitBinary());
  } catch { return null; }
}

/** Ordner mit python und soma-Startprogramm, kommt bei Terminals an den Anfang von PATH. */
export function pythonBinDir(): string | null {
  const exe = pythonExe();
  return path.isAbsolute(exe) ? path.dirname(exe) : null;
}
