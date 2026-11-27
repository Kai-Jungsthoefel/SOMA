import { app, BrowserWindow, clipboard, dialog, ipcMain, nativeTheme, shell, type WebContents } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { aboutInfo, aboutText, osName } from './about';
import { detectAgents } from './agents';
import { bridgeEnv, startBridge, stopBridge } from './bridge';
import { stopWarm, warmUp } from './build';
import { choose, chooseInputFiles, chooseSkillFiles, setDialogHost, setTestAnswers, trashItem, type ChooseOptions } from './dialogs';
import { viewDxf } from './dxf';
import { componentSource, insertModel, isModelFolder, listOrError, relinkComponent, unlinkComponent, updateComponents } from './components';
import { openElsewhere, OPEN_ELSEWHERE } from './openlock';
import { readZipTexts, ZIP_INFO_PATH } from './zip';
import { backupText, createEntry, entryPath, importInputs, listFiles, renameEntry, resolveInside, saveFeedbackImage, trashEntry, writeProjectText } from './files';
import { ProjectController } from './projects';
import { terminalEnv } from './terminals';
import { readHelp, readHelpImage } from './help';
import { initLog, log } from './log';
import { adoptLoginShellPath, appIcon, editBackupsDir, helpDir, libraryBackupsDir, logsDir, pythonExe, skillDirs, skillsDir, thumbnailsDir, userDataDir, userSkillsDir } from './paths';
import { SOMA_VERSION } from '../shared/version';
import { readSettings, writeSettings } from './settings';
import { checkUpdate } from './updates';
import { areaDir, clearPreviews, isStorageArea, storageStats } from './storage';
import { checkLibraryText, createLibrarySkill, importLibrarySkills, libraryState, ownFile, readLibrarySkill, removeLibrarySkill, renameOldSkillFiles, saveLibrarySkill } from './skilllibrary';
import { isSkillId, isSkillMode, librarySkill } from './skills';
import { fileOpBlockReason } from '../shared/editable';
import type { AiResult, AiStatus, FileOpResult, ImportResult, LibraryResult, OpenResult, StorageClear } from '../shared/types';
import { piEntry, setCatalogRefresh } from './somaai';
import { allowMicrophone, fakeMicrophone, micAccess, Voice } from './voice';
import { aiAccounts, cancelSignIn, defaultEffort, defaultModel, listModels, listSessions, saveApiKey, setDefaultEffort, setDefaultModel, signIn, signOut } from './somaaiauth';
import { createProject, getLastProject, getSkillBases, getSkillDefaults, isProjectId, setSkillBase, setSkillDefault, sweepDiscarded } from './workspace';

// App-Daten (Arbeitsordner, Caches) gehören auf die lokale Platte. Das Roaming-Profil (%APPDATA%) kann in Firmennetzen
// umgeleitet oder synchronisiert sein, das ist für Arbeitsordner und GPU-Cache ungeeignet. Tests leiten alles um.
if (process.env.SOMA_USER_DATA) app.setPath('userData', process.env.SOMA_USER_DATA);
else if (process.platform === 'win32' && process.env.LOCALAPPDATA) app.setPath('userData', path.join(process.env.LOCALAPPDATA, 'soma'));

// Protokoll (log.ts) so früh wie möglich: Auch Fehler beim Start sollen drinstehen
initLog(logsDir(), {
  version: SOMA_VERSION, system: `${osName()} ${process.arch}`, electron: process.versions.electron,
  packaged: app.isPackaged ? 'yes' : 'no (development)', python: pythonExe(), appData: userDataDir(),
});

/**
 * Linux ohne nutzbaren Grafiktreiber (VM, Remote-Desktop, xvfb): Chromium sperrt WebGL auf dem Software-Renderer llvmpipe,
 * ohne WebGL gibt es keinen Viewer. Bekommt der Viewer keinen Kontext, meldet das Fenster es (gpu:webglFailed), die App
 * merkt es sich in den App-Daten und übergeht ab dann bei jedem Start die Sperrliste. Der Merker statt einer Prüfung beim
 * Start: Der Status von Electron ist vor dem ersten Fenster nicht verlässlich (auf einem Rechner mit Grafikkarte meldete er
 * alles als aus). Ein Rechner, der den Merker zu Unrecht hat, verliert nichts: Ohne Sperre rendert die Grafikkarte weiter.
 */
const softwareGlFlag = () => path.join(app.getPath('userData'), 'software-gl');
if (process.platform === 'linux' && fs.existsSync(softwareGlFlag())) app.commandLine.appendSwitch('ignore-gpu-blocklist');

// ---- .soma files from the system: double-click, "Open with", the Dock icon (macOS) ---------------------------------
// The installation registers .soma for SOMA (electron-builder.config.cjs, fileAssociations). The file comes as an
// argument (Windows, Linux) or as the event open-file (macOS). Every file opens in a SOMA window of its own (wish of the
// user): the work of the user and the agent in an open window is never interrupted.

/** The .soma file among the arguments of a start, or null. */
function fileFromArgv(argv: string[], cwd = process.cwd()): string | null {
  for (const a of argv.slice(1)) {
    if (a.startsWith('-') || !/\.soma$/i.test(a)) continue;
    const f = path.resolve(cwd, a);
    if (fs.existsSync(f)) return f;
  }
  return null;
}
/**
 * A window of its own for a model ("Open the original" of a component, a file from the Dock on macOS): SOMA starts
 * itself again with --soma-window and the model (.soma file or folder).
 */
const WINDOW_FLAG = '--soma-window';
const OPEN_FLAG = '--soma-open=';
const ownWindow = process.argv.includes(WINDOW_FLAG);
const argOpen = process.argv.find((a) => a.startsWith(OPEN_FLAG))?.slice(OPEN_FLAG.length) || null;
/** A file (or for --soma-window a folder) that came before the window could take it: opened once the window has loaded. */
let pendingFile: string | null = argOpen ?? fileFromArgv(process.argv);
// The lock only tells whether another SOMA runs with the same app data. Then Chromium's own storage (local storage,
// caches) stays with the first one, this window gets its own, removed when it ends. Models and settings are shared, a
// model is open in one window only (openlock.ts)
const firstInstance = app.requestSingleInstanceLock();
const sessionDir = !firstInstance ? path.join(app.getPath('userData'), 'window-sessions', String(process.pid)) : null;
if (sessionDir) app.setPath('sessionData', sessionDir);

/** Starts another SOMA window for a model (.soma file or folder). */
function openInNewWindow(target: string): void {
  const args = [...(app.isPackaged ? [] : [app.getAppPath()]), WINDOW_FLAG, `${OPEN_FLAG}${target}`];
  console.log(`[soma] new window for ${target}`);
  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', env: { ...process.env, SOMA_TEST_START: undefined } });
  // Without a listener a failed start would end this process as an uncaught error
  child.on('error', (e) => console.error(`[soma] Could not start a new window for ${target}:`, e));
  child.unref();
}

/** Window sessions of SOMA windows that are gone (crash, or the folder was still busy when they ended). */
function sweepWindowSessions(): void {
  const base = path.join(app.getPath('userData'), 'window-sessions');
  let names: string[] = [];
  try { names = fs.readdirSync(base); } catch { return; }
  for (const n of names) {
    const pid = Number(n);
    let running = false;
    try { process.kill(pid, 0); running = true; } catch (e) { running = (e as NodeJS.ErrnoException).code === 'EPERM'; }
    if (!running) void fs.promises.rm(path.join(base, n), { recursive: true, force: true }).catch(() => {});
  }
}
// macOS hands files to the running app: before its window is there it opens the file itself, later a new window does
app.on('open-file', (e, f) => { e.preventDefault(); if (rendererReady) openInNewWindow(f); else deliverFile(f); });

/** Shows the window and lets the renderer open the file (it asks about unsaved text in the editor first). */
function deliverFile(f: string): void {
  console.log(`[soma] open file from the system: ${f}`);
  if (!win || win.isDestroyed() || !rendererReady) { pendingFile = f; return; }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents.send('app:openFile', f);
}

/** The window has loaded (did-finish-load): it can take files. isLoading() can still be true then (frames). */
let rendererReady = false;

/** Opens a model file the system named (or, in a window of its own, a model folder). Only existing .soma or .zip files. */
async function openModelFile(ctl: ProjectController, file: string): Promise<OpenResult> {
  if (ownWindow && file === argOpen && fs.existsSync(file) && fs.statSync(file).isDirectory()) return ctl.openFolder(file);
  if (!file || !path.isAbsolute(file) || !/\.(soma|zip)$/i.test(file)) return { cancelled: false, error: `Not a SOMA model file: ${file}` };
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return { cancelled: false, error: `The file was not found: ${file}` };
  return ctl.openZipFile(file);
}

let win: BrowserWindow | null = null;
/** Für Anfragen aus den Terminals (bridge.ts): das Projekt des Fensters. */
let controller: ProjectController | null = null;
/** Voice input for SOMA AI (voice.ts), for the whole app: the model does not belong to an open model. */
const voice = new Voice((s) => { if (win && !win.isDestroyed()) win.webContents.send('voice:status', s); });
fakeMicrophone();
/** Im Testmodus landet Kopiertes hier statt in der echten Zwischenablage des Nutzers. */
let testClipboard = '';

/**
 * Anfragen des Renderers mit der Antwort `{ ok: false, error }` ins Protokoll (log.ts), abgebrochene Rückfragen nicht.
 * Sonst sähe nur der Nutzer die Meldung, im Protokoll fehlte sie. Ein Wrapper um ipcMain.handle statt an jedem der vielen
 * Handler. Ausnahmen protokolliert Electron selbst über console.error („Error occurred in handler for …“, mit Stack), die
 * landen so schon im Protokoll.
 */
function logIpcFailures(): void {
  const handle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (channel, fn) => handle(channel, async (e, ...args) => {
    const r: unknown = await fn(e, ...args);
    const o = r as { ok?: unknown; error?: unknown; canceled?: unknown } | null;
    if (o && typeof o === 'object' && o.ok === false && o.error && !o.canceled) log('WARN', `[${channel}] ${String(o.error)}`);
    return r;
  });
}

function registerIpc(ctl: ProjectController): void {
  const dir = () => ctl.need().dir;

  ipcMain.handle('project:current', () => ctl.info());
  // Nur der feste Name fürs Tutorial (E94), kein freier Text aus dem Renderer
  ipcMain.handle('project:create', (_e, kind?: unknown) => ctl.create(kind === 'tutorial' ? 'Tutorial' : undefined));
  ipcMain.handle('project:list', async () => (await import('./workspace')).listProjects());
  ipcMain.handle('project:open', async (_e, id: string) => {
    // Recent: compares with the model file first, it may have been saved on another computer (openKnown)
    const r = await ctl.openKnown(id);
    if (r.error) throw new Error(r.error);
    return r.opened ? ctl.info() : null;
  });
  ipcMain.handle('project:openFile', (_e, file: unknown) => openModelFile(ctl, String(file ?? '')));
  ipcMain.handle('project:saveState', () => ctl.saveState());
  ipcMain.handle('project:save', (_e, saveAs?: boolean) => ctl.save(!!saveAs));
  ipcMain.handle('project:openZip', () => ctl.openZip());
  ipcMain.handle('project:openFolder', () => ctl.openFolder());
  ipcMain.handle('project:exportZip', () => ctl.exportZip());
  ipcMain.handle('project:createFromCadQuery', () => ctl.createFromCadQuery());
  ipcMain.handle('project:exportCadQuery', () => ctl.exportCadQuery());
  ipcMain.handle('project:reveal', () => ctl.reveal());
  // Agenten-Apps (Claude Desktop, Codex-App) öffnen den Arbeitsordner selbst. `soma` finden sie über .soma/env (AGENTS.md)
  ipcMain.handle('project:copyPath', (): FileOpResult => {
    const dir = ctl.session?.dir;
    if (!dir) return { ok: false, error: 'No model is open.' };
    if (process.env.SOMA_TEST === '1') testClipboard = dir; else clipboard.writeText(dir);
    return { ok: true, path: dir };
  });
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
  ipcMain.handle('versions:cancelPreview', () => ctl.cancelPreview());
  ipcMain.handle('versions:restore', (_e, hash: string) => ctl.restore(hash));

  ipcMain.handle('build:run', () => ctl.need().builds.start('manual'));
  ipcMain.handle('build:cancel', () => ctl.need().builds.cancel());
  ipcMain.handle('build:setAuto', (_e, on: boolean) => ctl.need().builds.setAuto(!!on));
  ipcMain.handle('build:status', () => ctl.need().builds.status);
  ipcMain.handle('build:export', (_e, format: string, part: string | null, mesh: unknown) => ctl.exportModel(String(format), part ? String(part) : null, mesh));
  ipcMain.handle('build:exportAssembly', () => ctl.exportModel('step', null, undefined, true));

  ipcMain.handle('fs:list', () => listFiles(dir()));
  /**
   * Import: .soma files can become components (other models inside this one), the app asks for each. Everything else
   * goes to inputs/ as before.
   */
  const importWithModels = async (root: string, paths: string[]): Promise<ImportResult> => {
    const models = paths.filter((p) => (/\.soma$/i.test(p) && fs.statSync(p, { throwIfNoEntry: false })?.isFile()) || isModelFolder(p));
    const files = paths.filter((p) => !models.includes(p));
    const inserted: NonNullable<ImportResult['inserted']> = [];
    const errors: string[] = [];
    const ownZip = (await ctl.saveState().catch(() => null))?.zipPath ?? null;
    for (const m of models) {
      const r = await insertModel(win, root, m, ownZip);
      if (r === 'inputs') files.push(m);
      else if (r && !r.ok) errors.push(`${path.basename(m)}: ${r.error}`);
      else if (r?.component) inserted.push({ name: r.component.name, mode: r.component.mode, placed: r.placed ?? null });
    }
    const res: ImportResult = files.length ? await importInputs(root, files) : { files: [], errors: [] };
    return { ...res, errors: [...res.errors, ...errors], inserted };
  };
  ipcMain.handle('fs:import', (_e, paths: string[]) => importWithModels(dir(), Array.isArray(paths) ? paths.map(String) : []));
  ipcMain.handle('fs:importPick', async () => {
    const root = dir();
    const files = await chooseInputFiles(win);
    return files.length ? importWithModels(root, files) : null;
  });
  ipcMain.handle('components:list', () => listOrError(dir()));
  ipcMain.handle('components:relink', (_e, name: unknown) => relinkComponent(win, dir(), String(name ?? '')));
  ipcMain.handle('components:update', (_e, name: unknown) => updateComponents(win, dir(), typeof name === 'string' ? name : null));
  ipcMain.handle('components:unlink', (_e, name: unknown) => unlinkComponent(win, dir(), String(name ?? '')));
  // In a SOMA window of its own: the work here goes on, and the Update note shows when the original was saved there
  ipcMain.handle('components:openOriginal', async (_e, name: unknown): Promise<OpenResult> => {
    const src = await componentSource(dir(), String(name ?? ''));
    if ('error' in src) return { cancelled: false, error: src.error };
    // Already open in a window: say so here instead of starting a window that only shows the same message
    if (!src.folder) {
      try {
        const t = (await readZipTexts(src.path, [ZIP_INFO_PATH]))[ZIP_INFO_PATH];
        const id = t ? (JSON.parse(t) as { id?: unknown }).id : null;
        if (typeof id === 'string' && openElsewhere(id)) return { cancelled: false, error: OPEN_ELSEWHERE };
      } catch { /* the new window reads the file and says what is wrong */ }
    }
    openInNewWindow(src.path);
    return { cancelled: false, opened: true };
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
  // „Send to agent“ legt den Text auch in die Zwischenablage, für Agenten-Apps außerhalb der App (Claude Desktop, Codex-App)
  ipcMain.handle('app:copyText', (_e, text: unknown): FileOpResult => {
    if (typeof text !== 'string' || text.length > 1_000_000) return { ok: false, error: 'Nothing to copy.' };
    if (process.env.SOMA_TEST === '1') testClipboard = text; else clipboard.writeText(text);
    return { ok: true };
  });
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
  // SOMA AI (somaai.ts): one pi process per open model, only reachable through the commands SomaAI allows
  const noModel: AiResult = { ok: false, error: 'No model is open.' };
  ipcMain.handle('ai:status', (): AiStatus => ctl.session?.ai.status() ?? { available: !!piEntry(), running: false });
  ipcMain.handle('ai:start', () => ctl.session?.ai.start() ?? noModel);
  ipcMain.handle('ai:command', (_e, cmd: unknown) => ctl.session?.ai.command(cmd) ?? noModel);
  ipcMain.handle('ai:runTimes', () => ctl.session?.ai.runTimes() ?? noModel);
  ipcMain.on('ai:respond', (_e, res: unknown) => ctl.session?.ai.respond(res));
  ipcMain.handle('ai:stop', () => ctl.session?.ai.stopAndWait());
  // Sign-in (somaaiauth.ts) holds for the whole app. A running pi of the open model ends, the next message starts it
  // again with the new sign-in and model (the conversation continues)
  const restartAi = <T extends { ok: boolean }>(r: T): T => { if (r.ok) ctl.session?.ai.restart(); return r; };
  ipcMain.handle('ai:accounts', () => aiAccounts());
  ipcMain.handle('ai:saveKey', (_e, provider: unknown, key: unknown) => restartAi(saveApiKey(provider, key)));
  ipcMain.handle('ai:signIn', async (e, provider: unknown) => restartAi(await signIn(provider, (page) => {
    if (!e.sender.isDestroyed()) e.sender.send('ai:signInPage', page);
    if (process.env.SOMA_TEST !== '1') void shell.openExternal(page.url);
  })));
  ipcMain.handle('ai:cancelSignIn', () => cancelSignIn());
  ipcMain.handle('ai:signOut', (_e, provider: unknown) => restartAi(signOut(provider)));
  // Earlier conversations of the open model: the window gets ids, never files. Switching looks the file up again
  ipcMain.handle('ai:sessions', async () => {
    const s = ctl.session;
    if (!s) return noModel;
    const r = await listSessions(s.dir);
    return r.ok ? { ok: true, sessions: (r.sessions ?? []).map(({ id, title, modified, messages }) => ({ id, title, modified, messages })) } : r;
  });
  ipcMain.handle('ai:switchSession', async (_e, id: unknown) => {
    const s = ctl.session;
    if (!s) return noModel;
    if (typeof id !== 'string') return { ok: false, error: 'Unknown conversation.' };
    const r = await listSessions(s.dir);
    if (ctl.session !== s) return { ok: false, error: 'Another model was opened meanwhile.' };
    const hit = r.sessions?.find((x) => x.id === id);
    if (!hit) return { ok: false, error: r.error ?? 'This conversation is no longer there.' };
    return s.ai.switchSession(hit.path);
  });
  ipcMain.handle('ai:models', () => listModels());
  setCatalogRefresh(listModels);
  ipcMain.handle('ai:defaultModel', () => defaultModel());
  ipcMain.handle('ai:setDefaultModel', (_e, provider: unknown, id: unknown) => setDefaultModel(provider, id));
  ipcMain.handle('ai:defaultEffort', () => defaultEffort());
  ipcMain.handle('ai:setDefaultEffort', (_e, level: unknown) => setDefaultEffort(level));
  ipcMain.handle('voice:status', () => voice.status());
  ipcMain.handle('voice:check', () => voice.check());
  ipcMain.handle('voice:install', (_e, language: unknown) => voice.install(language));
  ipcMain.handle('voice:cancel', () => voice.cancel());
  ipcMain.handle('voice:remove', () => voice.remove());
  ipcMain.handle('voice:micAccess', () => micAccess());
  ipcMain.on('voice:warm', () => { voice.warm().catch(() => { /* reported with the recording */ }); });
  ipcMain.handle('voice:transcribe', (_e, samples: unknown, rate: unknown) => voice.transcribe(samples, rate));
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
  ipcMain.handle('skills:takeOver', (_e, id: unknown) => ctl.takeOverSkill(id));
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
    return { id: String(id), backup: r.backup, warnings: r.warnings, modelUpdated: ctl.refreshOpenSkills() };
  }));
  ipcMain.handle('library:create', (_e, title: unknown, from: unknown) =>
    libDo(() => ({ id: createLibrarySkill(skillDirs(), String(title ?? ''), typeof from === 'string' ? from : undefined) })));
  ipcMain.handle('library:remove', (_e, id: unknown) => libDo(() => {
    const backup = removeLibrarySkill(skillDirs(), String(id), libraryBackupsDir());
    setSkillBase(String(id), null);
    return { id: String(id), backup, modelUpdated: ctl.refreshOpenSkills() };
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
    return { id: r.ids[0], imported: r.ids, warnings: r.warnings, backup: r.backups[0] ?? null, modelUpdated: ctl.refreshOpenSkills() };
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
    // Size of the page, for the layout of narrow windows (phones, test/compact.mjs)
    ipcMain.handle('test:size', (e, w: number, h: number) => { BrowserWindow.fromWebContents(e.sender)?.setContentSize(Math.round(w), Math.round(h)); });
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
  allowMicrophone(win);
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
    rendererReady = true;
    // Started by a double-click on a .soma file: open it right away
    if (pendingFile) { const f = pendingFile; pendingFile = null; deliverFile(f); return; }
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
  win.on('closed', () => { ctl.close(); ctl.renders.close(); controller = null; win = null; rendererReady = false; });
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
  sweepWindowSessions();
  logIpcFailures();
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
app.on('window-all-closed', () => { console.log('[soma] quit'); stopBridge(); stopWarm(); voice.shutdown(); app.quit(); });
// Chromium still holds files of its storage until the very end: try once, else the next start sweeps it
app.on('will-quit', () => { if (sessionDir) try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch { /* next start */ } });
