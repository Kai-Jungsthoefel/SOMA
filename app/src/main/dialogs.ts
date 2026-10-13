import { app, dialog, shell, type BrowserWindow } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Alle Dialoge laufen hier durch. Im Testmodus (SOMA_TEST=1) beantwortet eine vorbereitete Warteschlange sie,
 * damit Tests nicht an nativen Fenstern hängen. Ist die Schlange leer, schlägt der Aufruf laut fehl.
 */
const testMode = () => process.env.SOMA_TEST === '1';
const answers: unknown[] = [];
export const setTestAnswers = (a: unknown[]) => { answers.length = 0; answers.push(...a); };
export const pendingTestAnswers = () => answers.length;

function nextAnswer<T>(what: string): T {
  if (!answers.length) throw new Error(`Test mode: no answer is prepared for the dialog “${what}”.`);
  return answers.shift() as T;
}

/**
 * Modelldatei wählen. Gespeichert wird als .soma (E79), geöffnet wird auch eine ZIP (ältere Modelle, „Export als ZIP“).
 * `defaultName`: Dateiname in Dokumente oder ein absoluter Pfad.
 */
export async function choosePath(win: BrowserWindow | null, kind: 'save' | 'open', defaultName: string): Promise<string | null> {
  if (testMode()) return nextAnswer<string | null>(`${kind} path`);
  const defaultPath = path.isAbsolute(defaultName) ? defaultName : path.join(app.getPath('documents'), defaultName);
  if (kind === 'save') {
    const filters = [{ name: 'SOMA model', extensions: ['soma'] }];
    const r = win ? await dialog.showSaveDialog(win, { title: 'Save model', defaultPath, filters }) : await dialog.showSaveDialog({ title: 'Save model', defaultPath, filters });
    return r.canceled || !r.filePath ? null : r.filePath;
  }
  const filters = [{ name: 'SOMA model (.soma, .zip)', extensions: ['soma', 'zip'] }];
  const opts = { title: 'Open model', filters, properties: ['openFile' as const] };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
}

/**
 * Ziel eines Exports: eine Datei (ein Bauteil) oder ein Ordner (alle Bauteile, je eine Datei). Das Betriebssystem fragt
 * beim Speichern selbst nach, wenn die Datei schon da ist. `defaultPath` ist absolut (Ordner oder Ordner plus Dateiname).
 */
export async function chooseExportTarget(win: BrowserWindow | null, o: { kind: 'file' | 'dir'; title: string; defaultPath: string; ext?: string; label?: string }): Promise<string | null> {
  if (testMode()) return nextAnswer<string | null>(o.title);
  if (o.kind === 'file') {
    const opts = { title: o.title, defaultPath: o.defaultPath, filters: o.ext ? [{ name: o.label ?? o.ext.toUpperCase(), extensions: [o.ext] }, { name: 'All files', extensions: ['*'] }] : undefined };
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    return r.canceled || !r.filePath ? null : r.filePath;
  }
  const opts = { title: o.title, defaultPath: o.defaultPath, buttonLabel: 'Export here', properties: ['openDirectory' as const, 'createDirectory' as const] };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
}

export const documentsDir = () => app.getPath('documents');

/** Markdown-Dateien, die als eigene Skills übernommen werden (E78). Leere Liste: abgebrochen. */
export async function chooseSkillFiles(win: BrowserWindow | null): Promise<string[]> {
  if (testMode()) return nextAnswer<string[] | null>('Import skills') ?? [];
  const opts = { title: 'Import skills', defaultPath: documentsDir(), filters: [{ name: 'Skill (Markdown)', extensions: ['md'] }], properties: ['openFile' as const, 'multiSelections' as const] };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return r.canceled ? [] : r.filePaths;
}

/**
 * Dateien für inputs/ wählen (Knopf „Import“, gleicher Weg wie Reinziehen). Ordner nur per Ziehen: Der Dialog von
 * Windows kann nicht Dateien und Ordner zugleich wählen. Leere Liste: abgebrochen.
 */
export async function chooseInputFiles(win: BrowserWindow | null): Promise<string[]> {
  if (testMode()) return nextAnswer<string[] | null>('Import files') ?? [];
  const opts = { title: 'Import files into the model', defaultPath: documentsDir(), buttonLabel: 'Import', properties: ['openFile' as const, 'multiSelections' as const] };
  const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
  return r.canceled ? [] : r.filePaths;
}

export type ChooseOptions = { title: string; message: string; detail?: string; buttons: string[] };
/** Zeigt Rückfragen im Fenster der App. `null`: geht gerade nicht (Fenster lädt, abgestürzt), dann der Dialog des Systems. */
type DialogHost = (o: ChooseOptions) => Promise<number | null>;
let host: DialogHost | null = null;
export const setDialogHost = (h: DialogHost | null) => { host = h; };

/** Liefert den Index des gewählten Knopfs. Der letzte Knopf gilt als Abbrechen (Esc, Fenster schließen). */
export async function choose(win: BrowserWindow | null, o: ChooseOptions): Promise<number> {
  // Tests: Die Antwort 'ui' zeigt die Rückfrage wirklich in der App, der Test klickt dort selbst
  if (testMode()) { const a = nextAnswer<number | 'ui'>(o.title); if (a !== 'ui') return a; if (!host) throw new Error('Test mode: the window shows no questions.'); }
  // Die Dialoge des Systems sind unter Windows weiß und passen nicht zur dunklen App
  if (host) {
    const i = await host(o).catch(() => null);
    if (typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < o.buttons.length) return i;
  }
  const opts = { type: 'question' as const, title: o.title, message: o.message, detail: o.detail, buttons: o.buttons, defaultId: 0, cancelId: o.buttons.length - 1, noLink: true };
  const r = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
  return r.response;
}

/**
 * Papierkorb. Im Testmodus ein eigener Ordner in den App-Daten: Tests sollen den Papierkorb des Nutzers nicht füllen
 * und prüfen können, was dort gelandet ist.
 */
export async function trashItem(abs: string): Promise<void> {
  if (!testMode()) { await shell.trashItem(abs); return; }
  const bin = path.join(app.getPath('userData'), 'test-papierkorb');
  fs.mkdirSync(bin, { recursive: true });
  fs.renameSync(abs, path.join(bin, `${Date.now()}-${path.basename(abs)}`));
}

export function notify(win: BrowserWindow | null, title: string, message: string): void {
  if (testMode()) return;
  if (win) void dialog.showMessageBox(win, { type: 'info', title, message });
  else void dialog.showMessageBox({ type: 'info', title, message });
}
