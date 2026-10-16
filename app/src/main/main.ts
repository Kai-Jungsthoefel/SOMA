import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell, type WebContents } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { aboutInfo, aboutText } from './about';
import { detectAgents } from './agents';
import { bridgeEnv, startBridge, stopBridge } from './bridge';
import { stopWarm, warmUp } from './build';
import { choose, chooseInputFiles, chooseSkillFiles, setDialogHost, setTestAnswers, trashItem, type ChooseOptions } from './dialogs';
import { viewDxf } from './dxf';
import { backupText, createEntry, entryPath, importInputs, listFiles, renameEntry, resolveInside, saveFeedbackImage, trashEntry, writeProjectText } from './files';
import { ProjectController } from './projects';
import { terminalEnv } from './terminals';
import { readHelp, readHelpImage } from './help';
import { adoptLoginShellPath, appIcon, editBackupsDir, helpDir, libraryBackupsDir, skillDirs, skillsDir, thumbnailsDir, userSkillsDir } from './paths';
import { readSettings, writeSettings } from './settings';
import { checkUpdate } from './updates';
import { areaDir, clearPreviews, isStorageArea, storageStats } from './storage';
import { checkLibraryText, createLibrarySkill, importLibrarySkills, libraryState, ownFile, readLibrarySkill, removeLibrarySkill, renameOldSkillFiles, saveLibrarySkill } from './skilllibrary';
import { isSkillId, isSkillMode, librarySkill } from './skills';
import { fileOpBlockReason } from '../shared/editable';
import type { FileOpResult, LibraryResult, StorageClear } from '../shared/types';
import { createProject, getLastProject, getSkillBases, getSkillDefaults, isProjectId, setSkillBase, setSkillDefault, sweepDiscarded } from './workspace';

// App-Daten (Arbeitsordner, Caches) gehören auf die lokale Platte. Das Roaming-Profil (%APPDATA%) kann in Firmennetzen
// umgeleitet oder synchronisiert sein, das ist für Arbeitsordner und GPU-Cache ungeeignet. Tests leiten alles um.
if (process.env.SOMA_USER_DATA) app.setPath('userData', process.env.SOMA_USER_DATA);
else if (process.platform === 'win32' && process.env.LOCALAPPDATA) app.setPath('userData', path.join(process.env.LOCALAPPDATA, 'soma'));

/**
 * Linux ohne nutzbaren Grafiktreiber (VM, Remote-Desktop, xvfb): Chromium sperrt WebGL auf dem Software-Renderer llvmpipe,
 * ohne WebGL gibt es keinen Viewer. Bekommt der Viewer keinen Kontext, meldet das Fenster es (gpu:webglFailed), die App
 * merkt es sich in den App-Daten und übergeht ab dann bei jedem Start die Sperrliste. Der Merker statt einer Prüfung beim
 * Start: Der Status von Electron ist vor dem ersten Fenster nicht verlässlich (auf einem Rechner mit Grafikkarte meldete er
 * alles als aus). Ein Rechner, der den Merker zu Unrecht hat, verliert nichts: Ohne Sperre rendert die Grafikkarte weiter.
 */
const softwareGlFlag = () => path.join(app.getPath('userData'), 'software-gl');
if (process.platform === 'linux' && fs.existsSync(softwareGlFlag())) app.commandLine.appendSwitch('ignore-gpu-blocklist');

let win: BrowserWindow | null = null;
/** Für Anfragen aus den Terminals (bridge.ts): das Projekt des Fensters. */
let controller: ProjectController | null = null;
/** Im Testmodus landet Kopiertes hier statt in der echten Zwischenablage des Nutzers. */
let testClipboard = '';

function registerIpc(ctl: ProjectController): void {
  const dir = () => ctl.need().dir;

  ipcMain.handle('project:current', () => ctl.info());
  // Nur der feste Name fürs Tutorial (E94), kein freier Text aus dem Renderer
  ipcMain.handle('project:create', (_e, kind?: unknown) => ctl.create(kind === 'tutorial' ? 'Tutorial' : undefined));
  ipcMain.handle('project:list', async () => (await import('./workspace')).listProjects());
  ipcMain.handle('project:open', (_e, id: string) => ctl.open(id));
  ipcMain.handle('project:saveState', () => ctl.saveState());
  ipcMain.handle('project:save', (_e, saveAs?: boolean) => ctl.save(!!saveAs));
  ipcMain.handle('project:openZip', () => ctl.openZip());
  ipcMain.handle('project:exportZip', () => ctl.exportZip());
  ipcMain.handle('project:createFromCadQuery', () => ctl.createFromCadQuery());
  ipcMain.handle('project:exportCadQuery', () => ctl.exportCadQuery());
  ipcMain.handle('project:reveal', () => ctl.reveal());
  ipcMain.handle('project:setThumb', (_e, dataUrl: string) => {
    const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
    if (!m || m[1].length > 2_000_000 || !ctl.session) return;
    fs.mkdirSync(thumbnailsDir(), { recursive: true });
    fs.writeFileSync(path.join(thumbnailsDir(), `${ctl.session.id}.jpg`), Buffer.from(m[1], 'base64'));
  });
  ipcMain.handle('project:remove', (_e, id: string) => ctl.remove(String(id)));
  ipcMain.handle('project:viewFile', (_e, rel: unknown) => ctl.viewFile(rel));
  ipcMain.handle('project:thumb', (_e, id: string) => {
    if (!isProjectId(String(id))) return null;
    try { return `data:image/jpeg;base64,${fs.readFileSync(path.join(thumbnailsDir(), `${id}.jpg`)).toString('base64')}`; } catch { return null; }
  });

  ipcMain.handle('versions:log', () => ctl.gitLog());
  ipcMain.handle('versions:preview', (_e, hash: string) => ctl.preview(hash));
  ipcMain.handle('versions:restore', (_e, hash: string) => ctl.restore(hash));

  ipcMain.handle('build:run', () => ctl.need().builds.start('manual'));
  ipcMain.handle('build:cancel', () => ctl.need().builds.cancel());
  ipcMain.handle('build:setAuto', (_e, on: boolean) => ctl.need().builds.setAuto(!!on));
  ipcMain.handle('build:status', () => ctl.need().builds.status);
  ipcMain.handle('build:export', (_e, format: string, part: string | null) => ctl.exportModel(String(format), part ? String(part) : null));

  ipcMain.handle('fs:list', () => listFiles(dir()));
  ipcMain.handle('fs:import', (_e, paths: string[]) => importInputs(dir(), Array.isArray(paths) ? paths.map(String) : []));
  ipcMain.handle('fs:importPick', async () => {
    const root = dir();
    const files = await chooseInputFiles(win);
    return files.length ? importInputs(root, files) : null;
  });
  ipcMain.handle('fs:create', (_e, parent: string, name: string, isDir: boolean) => createEntry(dir(), String(parent ?? ''), String(name ?? ''), !!isDir));
  ipcMain.handle('fs:rename', (_e, rel: string, name: string) => renameEntry(dir(), String(rel ?? ''), String(name ?? '')));
  ipcMain.handle('fs:trash', async (_e, rel: string): Promise<FileOpResult> => {
    const root = dir();
    const r = entryPath(root, String(rel ?? ''), false);
    if (!r.abs) return { ok: false, error: r.error };
    // Gesperrtes gar nicht erst zur Rückfrage bringen (trashEntry prüft danach noch einmal mit bereinigtem Pfad)
    const block = fileOpBlockReason(String(rel), 'delete');
    if (block) return { ok: false, error: `${rel} cannot be deleted. ${block}` };
    const isDir = fs.statSync(r.abs).isDirectory();
    // Die Rückfrage stellt der Hauptprozess: So beantworten Tests sie wie alle anderen Dialoge (dialogs.ts)
    const c = await choose(win, {
      title: 'Delete',
      message: isDir ? `Move the folder “${path.basename(r.abs)}” and everything in it to the Recycle Bin?` : `Move “${path.basename(r.abs)}” to the Recycle Bin?`,
      detail: 'It can be restored from the Recycle Bin. Saved versions in the history are kept anyway.',
      buttons: ['Move to Recycle Bin', 'Cancel'],
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
    if (!/^(https?:\/\/|mailto:)/i.test(u)) return { ok: false, error: `Only web and mail addresses can be opened: ${u.slice(0, 100)}` };
    if (process.env.SOMA_TEST === '1') return { ok: true, path: u };
    try { await shell.openExternal(u); return { ok: true, path: u }; } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  });
  ipcMain.handle('fs:saveFeedback', (_e, png: unknown) => saveFeedbackImage(dir(), png));
  ipcMain.handle('fs:writeText', (_e, id: string, rel: string, text: string, base: string | null, force?: boolean) => {
    const s = ctl.session;
    // Späte Eingabe aus einem schon gewechselten Modell: nicht ins falsche Projekt schreiben, aber auch nicht verlieren
    if (!s || s.id !== id) {
      if (!isProjectId(String(id))) return { ok: false, error: 'Unknown model.' };
      return { ok: false, error: `The model has been switched in the meantime. The change is kept as a backup in ${backupText(editBackupsDir(id), String(rel), String(text))}` };
    }
    return writeProjectText(s.dir, String(rel), String(text), base == null ? null : String(base), !!force, editBackupsDir(s.id));
  });
  ipcMain.handle('fs:backupText', (_e, id: string, rel: string, text: string) => {
    if (!isProjectId(String(id))) throw new Error('Unknown model.');
    return backupText(editBackupsDir(String(id)), String(rel), String(text));
  });
  ipcMain.handle('fs:readText', (_e, rel: string) => fs.readFileSync(resolveInside(dir(), rel), 'utf8'));
  ipcMain.handle('fs:readBinary', (_e, rel: string) => {
    const b = fs.readFileSync(resolveInside(dir(), rel));
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  });
  ipcMain.handle('dxf:view', (_e, rel: unknown, known: unknown) => viewDxf(dir(), String(rel), known == null ? null : String(known)));

  ipcMain.handle('term:create', (_e, opts?: { command?: string }) => ctl.need().terminals.create(opts));
  ipcMain.on('term:write', (_e, id: number, data: string) => ctl.session?.terminals.write(id, data));
  ipcMain.on('term:resize', (_e, id: number, cols: number, rows: number) => ctl.session?.terminals.resize(id, cols, rows));
  ipcMain.on('term:kill', (_e, id: number) => ctl.session?.terminals.kill(id));

  const agents = () => detectAgents(ctl.session ? terminalEnv(dir()) : process.env);
  ipcMain.handle('agents:detect', () => agents());
  ipcMain.handle('measure:query', (_e, source: unknown, req: unknown) => ctl.measure(source, req));
  ipcMain.handle('measure:start', () => ctl.measureStart());
  ipcMain.handle('measure:prepare', (_e, source: unknown, build: unknown) => ctl.measurePrepare(source, build));
  ipcMain.handle('params:state', () => ctl.paramState());
  ipcMain.handle('params:set', (_e, values: unknown) => ctl.setParams(values));
  ipcMain.handle('params:resetAll', () => ctl.resetAllParams());
  // Anleitung (E83): Text aus dem mitgelieferten Skill, Bilder aus resources/help/
  ipcMain.handle('help:read', () => readHelp(skillsDir()));
  ipcMain.handle('help:image', (_e, name: unknown) => readHelpImage(helpDir(), name));
  ipcMain.handle('skills:list', () => ctl.skills());
  ipcMain.handle('skills:set', (_e, id: unknown, mode: unknown) => ctl.setSkill(id, mode));
  ipcMain.handle('skills:configure', (_e, id: unknown, values: unknown) => ctl.configureSkill(id, values));
  ipcMain.handle('skills:setDefault', (_e, id: unknown, mode: unknown) => ctl.setSkillDefault(id, mode));

  // Bibliothek der Skills in den Einstellungen (E78): unabhängig vom offenen Modell, also auch auf der Startseite
  const lib = () => libraryState(skillDirs(), getSkillDefaults(), getSkillBases());
  const libDo = async (f: () => Omit<LibraryResult, 'ok' | 'library'> | Promise<Omit<LibraryResult, 'ok' | 'library'>>): Promise<LibraryResult> => {
    try { return { ok: true, ...(await f()), library: lib() }; } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e), library: lib() }; }
  };
  ipcMain.handle('library:list', () => lib());
  ipcMain.handle('library:read', (_e, id: unknown) => readLibrarySkill(skillDirs(), String(id)));
  ipcMain.handle('library:check', (_e, text: unknown) => checkLibraryText(text));
  ipcMain.handle('library:save', (_e, id: unknown, text: unknown, base: unknown) => libDo(() => {
    if (typeof text !== 'string') throw new Error('No text.');
    const r = saveLibrarySkill(skillDirs(), String(id), text, typeof base === 'string' ? base : null, libraryBackupsDir());
    if (r.base !== undefined) setSkillBase(String(id), r.base);
    return { id: String(id), backup: r.backup, warnings: r.warnings };
  }));
  ipcMain.handle('library:create', (_e, title: unknown, from: unknown) =>
    libDo(() => ({ id: createLibrarySkill(skillDirs(), String(title ?? ''), typeof from === 'string' ? from : undefined) })));
  ipcMain.handle('library:remove', (_e, id: unknown) => libDo(() => {
    const backup = removeLibrarySkill(skillDirs(), String(id), libraryBackupsDir());
    setSkillBase(String(id), null);
    return { id: String(id), backup };
  }));
  ipcMain.handle('library:import', () => libDo(async () => {
    const files = await chooseSkillFiles(win);
    if (!files.length) return { canceled: true };
    const r = await importLibrarySkills(skillDirs(), files, libraryBackupsDir(), async (c) => {
      const detail = c.source === 'own'
        ? `${c.file} has the same file name as one of your skills. Replace: your current version goes into the backup. Import as a copy: the file gets its own name.`
        : `${c.file} has the same file name as a built-in skill. Replace: the file takes the place of the built-in skill${c.source === 'edited' ? ', your edited version goes into the backup' : ''}, “Reset” brings the original back. Import as a copy: the file gets its own name.`;
      const i = await choose(win, { title: 'Import skills', message: `“${c.title}” (${c.id}.md) already exists.`, detail, buttons: ['Replace', 'Import as a copy', 'Skip'] });
      return i === 0 ? 'replace' : i === 1 ? 'copy' : 'skip';
    });
    for (const [id, h] of Object.entries(r.bases)) setSkillBase(id, h);
    return { id: r.ids[0], imported: r.ids, warnings: r.warnings, backup: r.backups[0] ?? null };
  }));
  ipcMain.handle('library:setDefault', (_e, id: unknown, mode: unknown) => libDo(() => {
    const s = isSkillId(id) ? librarySkill(skillDirs(), id) : undefined;
    if (!s) throw new Error('This skill does not exist (any more).');
    if (!isSkillMode(mode)) throw new Error(`Unknown level “${String(mode)}”.`);
    setSkillDefault(s.id, mode, s.defaultMode);
    return { id: s.id };
  }));
  ipcMain.handle('library:reveal', async (_e, id: unknown) => {
    const file = typeof id === 'string' ? ownFile(skillDirs(), id) : null;
    if (process.env.SOMA_TEST === '1') return;
    if (file) { shell.showItemInFolder(file); return; }
    fs.mkdirSync(userSkillsDir(), { recursive: true });
    await shell.openPath(userSkillsDir());
  });

  // Einstellungen der App (E81)
  ipcMain.handle('settings:get', () => readSettings());
  ipcMain.handle('settings:set', (_e, patch: unknown) => {
    try { return writeSettings(patch); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e), ...readSettings() }; }
  });
  ipcMain.handle('storage:stats', () => storageStats());
  ipcMain.handle('storage:open', async (_e, area: unknown): Promise<FileOpResult> => {
    if (!isStorageArea(area)) return { ok: false, error: 'Unknown folder.' };
    const p = areaDir(area);
    try { fs.mkdirSync(p, { recursive: true }); } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    if (process.env.SOMA_TEST === '1') return { ok: true, path: p };
    const err = await shell.openPath(p);
    return err ? { ok: false, error: err } : { ok: true, path: p };
  });
  ipcMain.handle('storage:clearPreviews', async (): Promise<StorageClear> => {
    const keep = ctl.session?.id ?? null;
    const c = await choose(win, {
      title: 'Clear preview cache',
      message: 'Clear the preview cache?',
      detail: `Previews of older versions are created again when you open them in the history. ${keep ? 'Those of the open model stay. ' : ''}Your models and their history are not affected.`,
      buttons: ['Clear', 'Cancel'],
    });
    if (c !== 0) return { ok: false, canceled: true };
    try {
      const r = await clearPreviews(keep);
      return { ok: !r.failed, freed: r.freed, kept: r.kept, stats: await storageStats(), ...(r.failed ? { error: `${r.failed} folder${r.failed === 1 ? '' : 's'} could not be removed (still in use).` } : {}) };
    } catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  });
  // Antwort true: Die App startet mit Software-Rendering neu. false: Das hilft hier nicht (anderes System, schon versucht).
  ipcMain.handle('gpu:webglFailed', () => {
    if (process.platform !== 'linux' || app.commandLine.hasSwitch('ignore-gpu-blocklist')) return false;
    try { fs.writeFileSync(softwareGlFlag(), 'WebGL was unavailable, SOMA starts with --ignore-gpu-blocklist.\n'); } catch { return false; }
    console.log('[gpu] no WebGL context, restarting with --ignore-gpu-blocklist (software rendering)');
    setTimeout(() => { app.relaunch(); app.exit(0); }, 1500); // Zeit, die Meldung im Fenster zu lesen
    return true;
  });
  ipcMain.handle('about:info', () => aboutInfo(agents));
  // Nur wenn die Einstellung es erlaubt: Ausgeschaltet geht keine Anfrage ins Netz
  ipcMain.handle('updates:check', () => checkUpdate(readSettings().settings.start.updateCheck));
  ipcMain.handle('about:copy', async (): Promise<FileOpResult> => {
    const text = aboutText(await aboutInfo(agents));
    if (process.env.SOMA_TEST === '1') testClipboard = text; else clipboard.writeText(text);
    return { ok: true };
  });

  ipcMain.handle('anim:list', () => ctl.animList());
  ipcMain.handle('anim:build', (_e, file: unknown) => ctl.animBuild(file));
  ipcMain.handle('drawings:list', () => ctl.drawingList());
  ipcMain.handle('drawings:build', (_e, file: unknown) => ctl.drawingBuild(file));
  ipcMain.handle('drawings:export', (_e, what: unknown, sheet: unknown) => ctl.drawingExport(what, sheet));
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
    ipcMain.handle('test:clipboard', () => testClipboard);
    // Fenster schließen wie mit dem Kreuz (mit Rückfrage und Verlassen des Modells). window.close() der Seite umgeht das
    ipcMain.handle('test:close', (e) => { BrowserWindow.fromWebContents(e.sender)?.close(); });
    // Screenshot auch aus unsichtbaren Fenstern (CDP liefert dort kein Bild)
    // `rect` (in CSS-Pixeln): nur dieser Ausschnitt, etwa für die Bilder der Hilfe (test/helpshots.mjs)
    // capturePage(rect) liefert bei Fenstern außerhalb des Bildschirms das ganze Bild, deshalb danach zuschneiden
    ipcMain.handle('test:screenshot', async (e, file: string, rect?: Electron.Rectangle) => {
      let img = await e.sender.capturePage();
      const css = BrowserWindow.fromWebContents(e.sender)?.getContentBounds().width;
      if (rect && css) {
        const f = img.getSize().width / css;
        img = img.crop({ x: Math.round(rect.x * f), y: Math.round(rect.y * f), width: Math.round(rect.width * f), height: Math.round(rect.height * f) });
      }
      fs.writeFileSync(file, img.toPNG());
      return img.getSize();
    });
  }
}

function onRendererGone(wc: WebContents, reason: string, exitCode: number): void {
  console.error(`[soma] Renderer process ended: reason=${reason} code=${exitCode}`);
  if (reason === 'launch-failed' && process.env.SOMA_HIDDEN !== '1') {
    // Häufigste Ursache unter Windows: das Programm liegt auf einem Netzlaufwerk. Die sandboxed Prozesse laufen mit
    // eingeschränktem Token, verlieren dort den Zugriff und starten nicht. Ohne Meldung bliebe nur ein schwarzes Fenster.
    dialog.showErrorBox('SOMA cannot start its user interface',
      `The display process could not be started (code ${exitCode}).\n\nA common cause: the program is on a network drive. ` +
      'Install or start it from a local disk (for example C:).');
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
  controller = ctl;
  registerIpc(ctl);
  // Stürzt der Anzeigeprozess ab, steht der Grund im Protokoll (sonst bliebe nur ein schwarzes Fenster).
  wc.on('render-process-gone', (_e, d) => onRendererGone(wc, d.reason, d.exitCode));
  wc.on('unresponsive', () => console.error('[soma] Renderer is not responding'));
  wc.on('console-message', (_e, level, message, line, source) => { if (level >= 2) console.error(`[renderer] ${message} (${source}:${line})`); });
  wc.once('did-finish-load', () => {
    // Die App beginnt auf der Startseite, dort stehen die zuletzt geöffneten Modelle (E69). Ein Arbeitsstand von vor einem
    // Absturz ist dort zu finden. Nur die Tests öffnen gleich das letzte Modell, sonst ein neues (SOMA_TEST_START=home nicht).
    if (process.env.SOMA_TEST !== '1' || process.env.SOMA_TEST_START === 'home') return;
    void (async () => {
      try { await ctl.open(getLastProject() ?? (await createProject()).id); }
      catch (e) { console.error('[soma] Could not open the project:', e); }
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
      // Erst das Modell verlassen: Ein unverändertes neues verschwindet dabei (E69), danach erst das Fenster schließen
      if (ok) { await ctl.leave().catch(() => {}); allowClose = true; win?.close(); }
    })();
  });
  win.on('closed', () => { ctl.close(); ctl.renders.close(); controller = null; win = null; });
  hostDialogs(wc);
}

/**
 * Rückfragen (dialogs.ts choose) zeigt der Renderer selbst an, sobald er sich bereit meldet. Lädt er neu oder stürzt ab,
 * bekommen offene Fragen `null` und landen im Dialog des Systems: Eine Rückfrage darf nie ohne Antwort hängen bleiben.
 */
function hostDialogs(wc: WebContents): void {
  let next = 0;
  const pending = new Map<number, (i: number | null) => void>();
  const drop = () => { setDialogHost(null); for (const r of pending.values()) r(null); pending.clear(); };
  const onReady = (e: Electron.IpcMainEvent) => {
    if (e.sender !== wc) return;
    setDialogHost((o: ChooseOptions) => new Promise((resolve) => {
      if (wc.isDestroyed()) { resolve(null); return; }
      const id = ++next;
      pending.set(id, resolve);
      wc.send('dialog:show', id, o);
    }));
  };
  const onRes = (e: Electron.IpcMainEvent, id: unknown, i: unknown) => {
    if (e.sender !== wc) return;
    const r = pending.get(Number(id));
    if (!r) return;
    pending.delete(Number(id));
    r(typeof i === 'number' ? i : null);
  };
  ipcMain.on('dialog:ready', onReady);
  ipcMain.on('dialog:res', onRes);
  wc.on('did-start-navigation', (e) => { if (e.isMainFrame && !e.isSameDocument) drop(); });
  wc.on('render-process-gone', drop);
  wc.once('destroyed', () => { drop(); ipcMain.removeListener('dialog:ready', onReady); ipcMain.removeListener('dialog:res', onRes); });
}

// Erst die Verbindung für `soma render` (E58), dann das Fenster: Die Terminals bekommen Adresse und Schlüssel beim Anlegen
app.whenReady().then(async () => {
  // Dunkel wie die Oberfläche: unter Windows sonst eine weiße Titelleiste, ebenso die Dialoge zum Öffnen und Speichern
  nativeTheme.themeSource = 'dark';
  adoptLoginShellPath(); // macOS und Linux: PATH wie im Terminal, sonst fehlen die Agenten
  // Python schon jetzt vorwärmen: Bis das Fenster steht und das letzte Modell offen ist, ist cadquery geladen (build.ts)
  warmUp();
  sweepDiscarded(); // Reste verworfener Modelle (E69) vom letzten Mal
  renameOldSkillFiles(skillDirs()); // eigene Fassungen unter den Kennungen bis 0.5.0 (E87)
  await startBridge(async (route, body) => {
    if (!controller) return { status: 503, body: { ok: false, error: 'The app has no window right now.' } };
    if (route === 'render') return controller.renderForAgent(body);
    return { status: 404, body: { ok: false, error: `Unknown request: ${route}` } };
  });
  createWindow();
});
app.on('window-all-closed', () => { stopBridge(); stopWarm(); app.quit(); });
