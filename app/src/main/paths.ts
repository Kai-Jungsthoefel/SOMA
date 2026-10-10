import { app } from 'electron';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { SkillDirs } from './skills';

/** App-Daten. Fuer Tests per SOMA_USER_DATA umleitbar, damit nichts im echten Profil landet. */
export function userDataDir(): string {
  return process.env.SOMA_USER_DATA || app.getPath('userData');
}

export const workspacesDir = () => path.join(userDataDir(), 'workspaces');
/** Zweite Kopie des Projektzustands ausserhalb des Arbeitsordners (E27). */
export const projectStateDir = () => path.join(userDataDir(), 'projects');
export const appStateFile = () => path.join(userDataDir(), 'state.json');
/** Einstellungen des Nutzers (E81), getrennt vom Zustand der App in state.json. */
export const settingsFile = () => path.join(userDataDir(), 'settings.json');
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
/**
 * Leerer Startordner der vorgewärmten Python-Prozesse (build.ts). Python setzt ihn vorn in den Suchpfad, also darf dort
 * nichts liegen, was Module überdeckt. Ein Projektordner geht nicht: Windows hielte ihn als aktuelles Verzeichnis fest.
 */
export const warmDir = () => path.join(userDataDir(), 'python-start');

/** Vorlage fuer neue Projekte (liegt neben dem Programm, spaeter im Installationspaket). */
export const templateDir = () => path.join(app.getAppPath(), 'resources', 'template');

/** Mitgelieferte Skills (E17), je einer als Markdown. */
export const skillsDir = () => path.join(app.getAppPath(), 'resources', 'skills');
/** Bilder der Anleitung (E83), der Text ist der mitgelieferte Skill `soma-app.md`. */
export const helpDir = () => path.join(app.getAppPath(), 'resources', 'help');
/** Eigene und bearbeitete Skills des Nutzers (E78), gelten für die ganze App. */
export const userSkillsDir = () => path.join(userDataDir(), 'skills');
/** Beide Ordner der Bibliothek der Skills. */
export const skillDirs = (): SkillDirs => ({ bundled: skillsDir(), user: userSkillsDir() });
/** Sicherungen eigener Skills (gelöscht, zurückgesetzt, beim Import ersetzt oder außerhalb der App geändert). */
export const libraryBackupsDir = () => path.join(backupsDir(), 'skills-library');

/** App-Icon (E44) für Fenster und Taskleiste. Windows nimmt die ICO mit allen Größen, andere Systeme das PNG. */
export const appIcon = () => path.join(app.getAppPath(), 'resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

/**
 * Mitgelieferte Basisumgebung im Installationspaket: eigenständiges Python mit soma, gebaut von
 * python/scripts/build_runtime.py, von electron-builder nach resources/python gelegt. Nur in der installierten App.
 */
export function bundledPythonDir(): string | null {
  if (!app.isPackaged) return null;
  const dir = path.join(process.resourcesPath, 'python');
  return fs.existsSync(path.join(dir, process.platform === 'win32' ? 'python.exe' : path.join('bin', 'python3'))) ? dir : null;
}

/**
 * Python der Basisumgebung. Reihenfolge: SOMA_PYTHON, mitgelieferte Basisumgebung, Entwicklungs-Umgebung
 * (python/scripts/setup_env.ps1), sonst `python` im PATH.
 */
export function pythonExe(): string {
  if (process.env.SOMA_PYTHON) return process.env.SOMA_PYTHON;
  const bundled = bundledPythonDir();
  if (bundled) return path.join(bundled, process.platform === 'win32' ? 'python.exe' : path.join('bin', 'python3'));
  if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const dev = path.join(process.env.LOCALAPPDATA, 'soma-dev', 'venv', 'Scripts', 'python.exe');
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

/**
 * Ordner mit python und den Startprogrammen (soma, pip), kommen bei Terminals an den Anfang von PATH. In der venv der
 * Entwicklung liegt alles in einem Ordner, im eigenständigen Python unter Windows die Startprogramme in Scripts\.
 */
export function pythonBinDirs(): string[] {
  const exe = pythonExe();
  if (!path.isAbsolute(exe)) return [];
  const dir = path.dirname(exe);
  return process.platform === 'win32' && !process.env.SOMA_PYTHON && dir === bundledPythonDir() ? [path.join(dir, 'Scripts'), dir] : [dir];
}

/**
 * Programme aus der App heraus sehen unter macOS (und je nach Desktop unter Linux) nur einen knappen PATH ohne
 * /opt/homebrew/bin, ~/.local/bin oder die Ordner von npm. Agenten würden weder erkannt noch in den Terminals gefunden.
 * Deshalb einmal beim Start den PATH einer Login-Shell übernehmen. Nur in der installierten App: Aus einem Terminal
 * gestartet stimmt der PATH schon. Scheitert die Shell (Zeitlimit, ungewohnte Ausgabe), bleibt der PATH, wie er ist.
 */
export function adoptLoginShellPath(): void {
  if (process.platform === 'win32' || !app.isPackaged) return;
  const shell = process.env.SHELL || '/bin/bash';
  try {
    const r = spawnSync(shell, ['-ilc', 'printf "\\n__SOMA_PATH__=%s\\n" "$PATH"'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const found = /__SOMA_PATH__=(.*)/.exec(r.stdout ?? '')?.[1]?.trim();
    // fish gibt PATH als Liste mit Leerzeichen aus, das passt nicht ins Format: dann lieber nichts ändern
    if (!found || !found.includes('/') || (found.includes(' ') && !found.includes(':'))) return;
    const merged = [...found.split(':'), ...(process.env.PATH ?? '').split(':')].filter((p) => p);
    process.env.PATH = [...new Set(merged)].join(':');
  } catch { /* PATH bleibt */ }
}
