import { app, BrowserWindow, dialog, ipcMain, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectInfo } from '../shared/types';
import { detectAgents } from './agents';
import { BuildManager } from './build';
import { listFiles, resolveInside } from './files';
import { TerminalManager, terminalEnv } from './terminals';
import { watchProject } from './watcher';
import { createProject, getLastProject, inspectProject, listProjects, projectDir, setLastProject } from './workspace';

// App-Daten (Arbeitsordner, Caches) gehören auf die lokale Platte. Das Roaming-Profil (%APPDATA%) kann in Firmennetzen
// umgeleitet oder synchronisiert sein, das ist für Arbeitsordner und GPU-Cache ungeeignet. Tests leiten alles um.
if (process.env.CADIDE_USER_DATA) app.setPath('userData', process.env.CADIDE_USER_DATA);
else if (process.platform === 'win32' && process.env.LOCALAPPDATA) app.setPath('userData', path.join(process.env.LOCALAPPDATA, 'cadide'));

/** Alles, was zu einem geoeffneten Projekt gehoert. Beim Wechsel wird es vollstaendig abgebaut. */
interface Session {
  id: string;
  dir: string;
  builds: BuildManager;
  terminals: TerminalManager;
  stopWatch: () => void;
}

let win: BrowserWindow | null = null;
let session: Session | null = null;

function info(): ProjectInfo {
  if (!session) throw new Error('Kein Projekt geöffnet');
  const { name, problems } = inspectProject(session.id);
  return { id: session.id, name, dir: session.dir, problems, autoBuild: session.builds.autoBuild };
}

function closeSession(): void {
  if (!session) return;
  session.stopWatch();
  session.builds.dispose();
  session.terminals.killAll();
  session = null;
}

function openSession(id: string, wc: WebContents): ProjectInfo {
  closeSession();
  const dir = projectDir(id);
  const builds = new BuildManager(dir);
  const terminals = new TerminalManager(wc, dir);
  builds.on('status', (s) => { if (!wc.isDestroyed()) wc.send('build:status', s); });
  const stopWatch = watchProject(dir, () => builds.sourceChanged(), () => { if (!wc.isDestroyed()) wc.send('fs:changed'); });
  session = { id, dir, builds, terminals, stopWatch };
  setLastProject(id);
  // Erster Build direkt beim Öffnen, damit der Viewer nicht leer ist (der Nutzer kann Auto-Build danach abschalten).
  builds.start('Projekt geöffnet');
  return info();
}

function registerIpc(wc: WebContents): void {
  const need = (): Session => { if (!session) throw new Error('Kein Projekt geöffnet'); return session; };

  ipcMain.handle('project:current', () => info());
  ipcMain.handle('project:create', () => { const { id } = createProject(); const p = openSession(id, wc); wc.send('project:changed', p); return p; });
  ipcMain.handle('project:list', () => listProjects());
  ipcMain.handle('project:open', (_e, id: string) => { const p = openSession(id, wc); wc.send('project:changed', p); return p; });

  ipcMain.handle('build:run', () => need().builds.start('manuell'));
  ipcMain.handle('build:cancel', () => need().builds.cancel());
  ipcMain.handle('build:setAuto', (_e, on: boolean) => { need().builds.autoBuild = !!on; });
  ipcMain.handle('build:status', () => need().builds.status);

  ipcMain.handle('fs:list', () => listFiles(need().dir));
  ipcMain.handle('fs:readText', (_e, rel: string) => fs.readFileSync(resolveInside(need().dir, rel), 'utf8'));
  ipcMain.handle('fs:readBinary', (_e, rel: string) => {
    const b = fs.readFileSync(resolveInside(need().dir, rel));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  });

  ipcMain.handle('term:create', (_e, opts?: { command?: string }) => need().terminals.create(opts));
  ipcMain.on('term:write', (_e, id: number, data: string) => session?.terminals.write(id, data));
  ipcMain.on('term:resize', (_e, id: number, cols: number, rows: number) => session?.terminals.resize(id, cols, rows));
  ipcMain.on('term:kill', (_e, id: number) => session?.terminals.kill(id));

  ipcMain.handle('agents:detect', () => detectAgents(terminalEnv(need().dir)));
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1600, height: 950, title: 'CAD-IDE', backgroundColor: '#1e2227', show: process.env.CADIDE_HIDDEN !== '1',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: process.env.CADIDE_HIDDEN !== '1', // unsichtbare Testfenster sollen trotzdem zeichnen
    },
  });
  win.setMenuBarVisibility(false);
  const wc = win.webContents;
  registerIpc(wc);
  // Stürzt der Anzeigeprozess ab, steht der Grund im Protokoll (sonst bliebe nur ein schwarzes Fenster).
  wc.on('render-process-gone', (_e, d) => {
    console.error(`[cadide] Renderer-Prozess beendet: Grund=${d.reason} Code=${d.exitCode}`);
    if (d.reason === 'launch-failed' && process.env.CADIDE_HIDDEN !== '1') {
      // Häufigste Ursache unter Windows: das Programm liegt auf einem Netzlaufwerk. Die sandboxed Prozesse laufen mit
      // eingeschränktem Token, verlieren dort den Zugriff und starten nicht. Ohne Meldung bliebe nur ein schwarzes Fenster.
      dialog.showErrorBox('CAD-IDE kann die Oberfläche nicht starten',
        `Der Anzeigeprozess ließ sich nicht starten (Code ${d.exitCode}).

Häufige Ursache: Das Programm liegt auf einem Netzlaufwerk. ` +
        'Installiere oder starte es von einer lokalen Platte (z. B. C:).');
      app.quit();
    }
  });
  wc.on('unresponsive', () => console.error('[cadide] Renderer reagiert nicht'));
  wc.on('console-message', (_e, level, message, line, source) => { if (level >= 2) console.error(`[renderer] ${message} (${source}:${line})`); });
  wc.once('did-finish-load', () => {
    // Zuletzt geöffnetes Projekt, sonst ein neues. Vor dem Öffnen kann der Renderer schon fragen, daher hier zuerst.
    const last = getLastProject();
    const id = last ?? createProject().id;
    const p = openSession(id, wc);
    wc.send('project:changed', p);
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.on('closed', () => { closeSession(); win = null; });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { closeSession(); app.quit(); });
