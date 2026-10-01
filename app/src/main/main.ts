import { app, BrowserWindow, dialog, ipcMain, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { detectAgents } from './agents';
import { choose, setTestAnswers } from './dialogs';
import { backupText, importInputs, listFiles, resolveInside, saveFeedbackImage, writeProjectText } from './files';
import { ProjectController } from './projects';
import { terminalEnv } from './terminals';
import { appIcon, editBackupsDir, thumbnailsDir } from './paths';
import { createProject, getLastProject, isProjectId } from './workspace';

// App-Daten (Arbeitsordner, Caches) gehören auf die lokale Platte. Das Roaming-Profil (%APPDATA%) kann in Firmennetzen
// umgeleitet oder synchronisiert sein, das ist für Arbeitsordner und GPU-Cache ungeeignet. Tests leiten alles um.
if (process.env.SOMA_USER_DATA) app.setPath('userData', process.env.SOMA_USER_DATA);
else if (process.platform === 'win32' && process.env.LOCALAPPDATA) app.setPath('userData', path.join(process.env.LOCALAPPDATA, 'soma'));

let win: BrowserWindow | null = null;

function registerIpc(ctl: ProjectController): void {
  const dir = () => ctl.need().dir;

  ipcMain.handle('project:current', () => ctl.info());
  ipcMain.handle('project:create', () => ctl.create());
  ipcMain.handle('project:list', async () => (await import('./workspace')).listProjects());
  ipcMain.handle('project:open', (_e, id: string) => ctl.open(id));
  ipcMain.handle('project:saveState', () => ctl.saveState());
  ipcMain.handle('project:save', (_e, saveAs?: boolean) => ctl.save(!!saveAs));
  ipcMain.handle('project:openZip', () => ctl.openZip());
  ipcMain.handle('project:reveal', () => ctl.reveal());
  ipcMain.handle('project:setThumb', (_e, dataUrl: string) => {
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
    if (!m || m[1].length > 2_000_000 || !ctl.session) return;
    fs.mkdirSync(thumbnailsDir(), { recursive: true });
    fs.writeFileSync(path.join(thumbnailsDir(), `${ctl.session.id}.jpg`), Buffer.from(m[1], 'base64'));
  });
  ipcMain.handle('project:thumb', (_e, id: string) => {
    if (!isProjectId(String(id))) return null;
    try { return `data:image/jpeg;base64,${fs.readFileSync(path.join(thumbnailsDir(), `${id}.jpg`)).toString('base64')}`; } catch { return null; }
  });

  ipcMain.handle('versions:log', () => ctl.gitLog());
  ipcMain.handle('versions:preview', (_e, hash: string) => ctl.preview(hash));
  ipcMain.handle('versions:restore', (_e, hash: string) => ctl.restore(hash));

  ipcMain.handle('build:run', () => ctl.need().builds.start('manuell'));
  ipcMain.handle('build:cancel', () => ctl.need().builds.cancel());
  ipcMain.handle('build:setAuto', (_e, on: boolean) => ctl.need().builds.setAuto(!!on));
  ipcMain.handle('build:status', () => ctl.need().builds.status);
  ipcMain.handle('build:export', (_e, format: string, part: string | null) => ctl.exportModel(String(format), part ? String(part) : null));

  ipcMain.handle('fs:list', () => listFiles(dir()));
  ipcMain.handle('fs:import', (_e, paths: string[]) => importInputs(dir(), Array.isArray(paths) ? paths.map(String) : []));
  ipcMain.handle('fs:saveFeedback', (_e, png: unknown) => saveFeedbackImage(dir(), png));
  ipcMain.handle('fs:writeText', (_e, id: string, rel: string, text: string, base: string | null, force?: boolean) => {
    const s = ctl.session;
    // Späte Eingabe aus einem schon gewechselten Modell: nicht ins falsche Projekt schreiben, aber auch nicht verlieren
    if (!s || s.id !== id) {
      if (!isProjectId(String(id))) return { ok: false, error: 'Unbekanntes Modell.' };
      return { ok: false, error: `Das Modell wurde inzwischen gewechselt. Die Änderung liegt als Sicherung unter ${backupText(editBackupsDir(id), String(rel), String(text))}` };
    }
    return writeProjectText(s.dir, String(rel), String(text), base == null ? null : String(base), !!force, editBackupsDir(s.id));
  });
  ipcMain.handle('fs:backupText', (_e, id: string, rel: string, text: string) => {
    if (!isProjectId(String(id))) throw new Error('Unbekanntes Modell.');
    return backupText(editBackupsDir(String(id)), String(rel), String(text));
  });
  ipcMain.handle('fs:readText', (_e, rel: string) => fs.readFileSync(resolveInside(dir(), rel), 'utf8'));
  ipcMain.handle('fs:readBinary', (_e, rel: string) => {
    const b = fs.readFileSync(resolveInside(dir(), rel));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  });

  ipcMain.handle('term:create', (_e, opts?: { command?: string }) => ctl.need().terminals.create(opts));
  ipcMain.on('term:write', (_e, id: number, data: string) => ctl.session?.terminals.write(id, data));
  ipcMain.on('term:resize', (_e, id: number, cols: number, rows: number) => ctl.session?.terminals.resize(id, cols, rows));
  ipcMain.on('term:kill', (_e, id: number) => ctl.session?.terminals.kill(id));

  ipcMain.handle('agents:detect', () => detectAgents(terminalEnv(dir())));
  ipcMain.handle('measure:query', (_e, source: unknown, req: unknown) => ctl.measure(source, req));
  ipcMain.handle('skills:list', () => ctl.skills());
  ipcMain.handle('skills:set', (_e, id: unknown, on: unknown) => ctl.setSkill(id, !!on));
  ipcMain.handle('skills:configure', (_e, id: unknown, values: unknown) => ctl.configureSkill(id, values));
  // Rückfragen aus dem Renderer (etwa ungespeicherte Eingaben im Editor) laufen über dieselben Dialoge wie im Hauptprozess
  ipcMain.handle('dialog:choose', (_e, o: { title?: unknown; message?: unknown; detail?: unknown; buttons?: unknown }) => {
    const buttons = Array.isArray(o?.buttons) ? o.buttons.slice(0, 4).map(String) : [];
    if (!buttons.length) return -1;
    return choose(win, { title: String(o.title ?? 'SOMA'), message: String(o.message ?? ''), detail: o.detail == null ? undefined : String(o.detail), buttons });
  });

  // Nur im Testmodus: vorbereitete Antworten für Dialoge (siehe dialogs.ts)
  if (process.env.SOMA_TEST === '1') {
    ipcMain.handle('test:answers', (_e, a: unknown[]) => setTestAnswers(a));
    // Screenshot auch aus unsichtbaren Fenstern (CDP liefert dort kein Bild)
    ipcMain.handle('test:screenshot', async (e, file: string) => {
      const img = await e.sender.capturePage();
      fs.writeFileSync(file, img.toPNG());
      return img.getSize();
    });
  }
}

function onRendererGone(wc: WebContents, reason: string, exitCode: number): void {
  console.error(`[soma] Renderer-Prozess beendet: Grund=${reason} Code=${exitCode}`);
  if (reason === 'launch-failed' && process.env.SOMA_HIDDEN !== '1') {
    // Häufigste Ursache unter Windows: das Programm liegt auf einem Netzlaufwerk. Die sandboxed Prozesse laufen mit
    // eingeschränktem Token, verlieren dort den Zugriff und starten nicht. Ohne Meldung bliebe nur ein schwarzes Fenster.
    dialog.showErrorBox('SOMA kann die Oberfläche nicht starten',
      `Der Anzeigeprozess ließ sich nicht starten (Code ${exitCode}).\n\nHäufige Ursache: Das Programm liegt auf einem Netzlaufwerk. ` +
      'Installiere oder starte es von einer lokalen Platte (z. B. C:).');
    app.quit();
  }
  void wc;
}

let editorReq = 0;
/**
 * Fragt den Editor im Renderer: `status` (welche Dateien ungespeichert sind), `save` (speichern), `discard` (verwerfen,
 * vorher sichern). Antwortet er nicht in 5 s, gilt `fallback`.
 */
function askEditor<T>(wc: WebContents, action: 'status' | 'save' | 'discard', fallback: T): Promise<T> {
  return new Promise((resolve) => {
    if (wc.isDestroyed()) { resolve(fallback); return; }
    const id = ++editorReq;
    const done = (_e: unknown, rid: number, result: unknown) => {
      if (rid !== id) return;
      clearTimeout(timer);
      ipcMain.removeListener('editor:res', done);
      resolve((result ?? fallback) as T);
    };
    const timer = setTimeout(() => { ipcMain.removeListener('editor:res', done); resolve(fallback); }, 5000);
    ipcMain.on('editor:res', done);
    wc.send('editor:req', id, action);
  });
}

/** Tests: SOMA_HIDDEN=1 unsichtbar (zeichnet nicht neu), =offscreen angezeigt, aber weit außerhalb des Bildschirms und ohne Fokus. */
const testWindowMode = process.env.SOMA_HIDDEN;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1600, height: 950, title: 'SOMA', icon: appIcon(), backgroundColor: '#121417', show: testWindowMode !== '1' && testWindowMode !== 'offscreen',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: !testWindowMode || testWindowMode === '0', // Testfenster sollen trotzdem zeichnen
    },
  });
  win.setMenuBarVisibility(false);
  if (testWindowMode === 'offscreen') { win.setBounds({ x: -20000, y: -20000, width: 1600, height: 950 }); win.showInactive(); }
  const wc = win.webContents;
  const ctl = new ProjectController(() => win, wc);
  registerIpc(ctl);
  // Stürzt der Anzeigeprozess ab, steht der Grund im Protokoll (sonst bliebe nur ein schwarzes Fenster).
  wc.on('render-process-gone', (_e, d) => onRendererGone(wc, d.reason, d.exitCode));
  wc.on('unresponsive', () => console.error('[soma] Renderer reagiert nicht'));
  wc.on('console-message', (_e, level, message, line, source) => { if (level >= 2) console.error(`[renderer] ${message} (${source}:${line})`); });
  wc.once('did-finish-load', () => {
    // Zuletzt geöffnetes Projekt (ungespeicherter Arbeitsstand bleibt so nach einem Absturz erhalten), sonst ein neues.
    void (async () => {
      try { await ctl.open(getLastProject() ?? (await createProject()).id); }
      catch (e) { console.error('[soma] Projekt konnte nicht geöffnet werden:', e); }
    })();
  });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Schließen: bei ungespeicherten Änderungen (im Modell oder im Editor) nachfragen. Der Arbeitsstand bleibt in jedem Fall erhalten.
  let allowClose = false;
  win.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    void (async () => {
      const st = await askEditor<{ dirty?: string[] }>(wc, 'status', {});
      const ok = await ctl.confirmClose({
        dirty: Array.isArray(st.dirty) ? st.dirty.map(String) : [],
        save: async () => !!(await askEditor<{ ok?: boolean }>(wc, 'save', { ok: false })).ok,
        discard: async () => { await askEditor(wc, 'discard', {}); },
      });
      if (ok) { allowClose = true; win?.close(); }
    })();
  });
  win.on('closed', () => { ctl.close(); win = null; });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
