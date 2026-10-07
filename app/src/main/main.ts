import { app, BrowserWindow, dialog, ipcMain, shell, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { detectAgents } from './agents';
import { bridgeEnv, startBridge, stopBridge } from './bridge';
import { stopWarm, warmUp } from './build';
import { choose, setTestAnswers } from './dialogs';
import { backupText, createEntry, entryPath, importInputs, listFiles, renameEntry, resolveInside, saveFeedbackImage, trashEntry, writeProjectText } from './files';
import { ProjectController } from './projects';
import { terminalEnv } from './terminals';
import { appIcon, editBackupsDir, thumbnailsDir } from './paths';
import { fileOpBlockReason } from '../shared/editable';
import type { FileOpResult } from '../shared/types';
import { createProject, getLastProject, isProjectId } from './workspace';

// App-Daten (Arbeitsordner, Caches) gehören auf die lokale Platte. Das Roaming-Profil (%APPDATA%) kann in Firmennetzen
// umgeleitet oder synchronisiert sein, das ist für Arbeitsordner und GPU-Cache ungeeignet. Tests leiten alles um.
if (process.env.SOMA_USER_DATA) app.setPath('userData', process.env.SOMA_USER_DATA);
else if (process.platform === 'win32' && process.env.LOCALAPPDATA) app.setPath('userData', path.join(process.env.LOCALAPPDATA, 'soma'));

let win: BrowserWindow | null = null;
/** Für Anfragen aus den Terminals (bridge.ts): das Projekt des Fensters. */
let controller: ProjectController | null = null;

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
  ipcMain.handle('fs:create', (_e, parent: string, name: string, isDir: boolean) => createEntry(dir(), String(parent ?? ''), String(name ?? ''), !!isDir));
  ipcMain.handle('fs:rename', (_e, rel: string, name: string) => renameEntry(dir(), String(rel ?? ''), String(name ?? '')));
  ipcMain.handle('fs:trash', async (_e, rel: string): Promise<FileOpResult> => {
    const root = dir();
    const r = entryPath(root, String(rel ?? ''), false);
    if (!r.abs) return { ok: false, error: r.error };
    // Gesperrtes gar nicht erst zur Rückfrage bringen (trashEntry prüft danach noch einmal mit bereinigtem Pfad)
    const block = fileOpBlockReason(String(rel), 'delete');
    if (block) return { ok: false, error: `${rel} lässt sich nicht löschen. ${block}` };
    const isDir = fs.statSync(r.abs).isDirectory();
    // Die Rückfrage stellt der Hauptprozess: So beantworten Tests sie wie alle anderen Dialoge (dialogs.ts)
    const c = await choose(win, {
      title: 'Löschen',
      message: isDir ? `Den Ordner „${path.basename(r.abs)}“ mit allem darin in den Papierkorb verschieben?` : `„${path.basename(r.abs)}“ in den Papierkorb verschieben?`,
      detail: 'Aus dem Papierkorb lässt es sich wiederherstellen. Gespeicherte Stände im Verlauf bleiben ohnehin erhalten.',
      buttons: ['In den Papierkorb', 'Abbrechen'],
    });
    if (c !== 0) return { ok: false, canceled: true };
    return trashEntry(root, String(rel), (abs) => trashItem(abs));
  });
  ipcMain.handle('fs:reveal', (_e, rel: string): FileOpResult => {
    const r = entryPath(dir(), String(rel ?? ''), false);
    if (!r.abs) return { ok: false, error: r.error };
    if (process.env.SOMA_TEST !== '1') shell.showItemInFolder(r.abs);
    return { ok: true, path: String(rel ?? '') };
  });
  ipcMain.handle('fs:openExternal', async (_e, rel: string): Promise<FileOpResult> => {
    const r = entryPath(dir(), String(rel ?? ''), true);
    if (!r.abs) return { ok: false, error: r.error };
    if (process.env.SOMA_TEST === '1') return { ok: true, path: String(rel ?? '') };
    const err = await shell.openPath(r.abs);
    return err ? { ok: false, error: err } : { ok: true, path: String(rel ?? '') };
  });
  // Links aus Markdown-Dateien (E51). Nur Web und Mail: file:, Programme und eigene Protokolle könnten etwas ausführen.
  ipcMain.handle('app:openUrl', async (_e, url: unknown): Promise<FileOpResult> => {
    const u = String(url ?? '');
    if (!/^(https?:\/\/|mailto:)/i.test(u)) return { ok: false, error: `Nur Web- und Mail-Adressen lassen sich öffnen: ${u.slice(0, 100)}` };
    if (process.env.SOMA_TEST === '1') return { ok: true, path: u };
    try { await shell.openExternal(u); return { ok: true, path: u }; } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  });
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
  ipcMain.handle('measure:start', () => ctl.measureStart());
  ipcMain.handle('measure:prepare', (_e, source: unknown, build: unknown) => ctl.measurePrepare(source, build));
  ipcMain.handle('skills:list', () => ctl.skills());
  ipcMain.handle('skills:set', (_e, id: unknown, mode: unknown) => ctl.setSkill(id, mode));
  ipcMain.handle('skills:configure', (_e, id: unknown, values: unknown) => ctl.configureSkill(id, values));
  ipcMain.handle('skills:setDefault', (_e, id: unknown, mode: unknown) => ctl.setSkillDefault(id, mode));
  ipcMain.handle('anim:list', () => ctl.animList());
  ipcMain.handle('anim:build', (_e, file: unknown) => ctl.animBuild(file));
  ipcMain.handle('results:list', () => ctl.results());
  ipcMain.handle('results:rerun', (_e, id: unknown) => ctl.rerunResult(id));
  ipcMain.handle('render:video', (_e, id: unknown) => ctl.renderVideo(id));
  // Rückfragen aus dem Renderer (etwa ungespeicherte Eingaben im Editor) laufen über dieselben Dialoge wie im Hauptprozess
  ipcMain.handle('dialog:choose', (_e, o: { title?: unknown; message?: unknown; detail?: unknown; buttons?: unknown }) => {
    const buttons = Array.isArray(o?.buttons) ? o.buttons.slice(0, 4).map(String) : [];
    if (!buttons.length) return -1;
    return choose(win, { title: String(o.title ?? 'SOMA'), message: String(o.message ?? ''), detail: o.detail == null ? undefined : String(o.detail), buttons });
  });

  // Nur im Testmodus: vorbereitete Antworten für Dialoge (siehe dialogs.ts)
  if (process.env.SOMA_TEST === '1') {
    ipcMain.handle('test:answers', (_e, a: unknown[]) => setTestAnswers(a));
    // Adresse und Schlüssel für soma render, damit Tests es auch außerhalb eines Terminals aufrufen können
    ipcMain.handle('test:bridge', () => bridgeEnv());
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

/**
 * Papierkorb. Im Testmodus ein eigener Ordner in den App-Daten: Tests sollen den Papierkorb des Nutzers nicht füllen
 * und prüfen können, was dort gelandet ist.
 */
async function trashItem(abs: string): Promise<void> {
  if (process.env.SOMA_TEST !== '1') { await shell.trashItem(abs); return; }
  const bin = path.join(app.getPath('userData'), 'test-papierkorb');
  fs.mkdirSync(bin, { recursive: true });
  fs.renameSync(abs, path.join(bin, `${Date.now()}-${path.basename(abs)}`));
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
  controller = ctl;
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
  win.on('closed', () => { ctl.close(); ctl.renders.close(); controller = null; win = null; });
}

// Erst die Verbindung für `soma render` (E58), dann das Fenster: Die Terminals bekommen Adresse und Schlüssel beim Anlegen
app.whenReady().then(async () => {
  // Python schon jetzt vorwärmen: Bis das Fenster steht und das letzte Modell offen ist, ist cadquery geladen (build.ts)
  warmUp();
  await startBridge(async (route, body) => {
    if (!controller) return { status: 503, body: { ok: false, error: 'Die App hat gerade kein Fenster.' } };
    if (route === 'render') return controller.renderForAgent(body);
    return { status: 404, body: { ok: false, error: `Unbekannte Anfrage: ${route}` } };
  });
  createWindow();
});
app.on('window-all-closed', () => { stopBridge(); stopWarm(); app.quit(); });
