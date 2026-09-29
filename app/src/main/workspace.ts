import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectListEntry } from '../shared/types';
import { runCadide } from './build';
import { GitRepo } from './git';
import { appStateFile, backupsDir, projectStateDir, templateDir, workspacesDir } from './paths';
import { extractZip } from './zip';

export const API_VERSION = 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ProjectJson {
  id: string;
  name: string;
  api_version: number;
  entry: string;
  main_output: string;
  created: string;
}

/** Zweite Kopie des Projektzustands in den App-Daten (E27) plus Angaben, die nur die App braucht. */
export interface AppState { zipPath?: string; savedHead?: string | null; savedAt?: number }
interface ProjectState extends ProjectJson { app?: AppState }

const readJson = <T>(file: string): T | null => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; }
};
const writeJson = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
};

export const isProjectId = (id: string) => UUID.test(id);

export function projectDir(id: string): string {
  if (!isProjectId(id)) throw new Error(`Ungültige Projekt-ID: ${id}`);
  return path.join(workspacesDir(), id);
}

const stateFile = (id: string) => path.join(projectStateDir(), `${id}.json`);
export const readProjectJson = (id: string) => readJson<ProjectJson>(path.join(projectDir(id), '.cadide', 'project.json'));

/** Neues Projekt: UUID-Ordner in den App-Daten (E21), Vorlage kopieren, Zustand doppelt ablegen (E27), Git-Verlauf anlegen (E7). */
export async function createProject(name = 'Neues Modell'): Promise<{ id: string; dir: string }> {
  const id = randomUUID();
  const dir = projectDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(templateDir(), dir, { recursive: true });
  const pj: ProjectJson = { id, name, api_version: API_VERSION, entry: 'model.py', main_output: 'output/model.step', created: new Date().toISOString() };
  writeJson(path.join(dir, '.cadide', 'project.json'), pj);
  writeJson(stateFile(id), { ...pj, app: {} } satisfies ProjectState);
  // Einmal bauen, bevor der Startcommit entsteht: So enthält auch der erste Stand eine output/model.step
  // und lässt sich im Verlauf als Vorschau öffnen. Scheitert der Build, geht das Anlegen trotzdem weiter.
  await runCadide(['build', '--project', dir], dir, 90000);
  try {
    await new GitRepo(dir).init('Neues Modell angelegt');
  } catch (e) {
    // Ohne Git bleibt das Projekt benutzbar. Der Verlauf meldet den Grund (Projekt-Check), statt das Anlegen scheitern zu lassen.
    console.error('[cadide] Git-Verlauf konnte nicht angelegt werden:', e);
  }
  setLastProject(id);
  return { id, dir };
}

/** Angaben, die nur die App braucht (Pfad der ZIP, zuletzt gespeicherter Stand). */
export function getAppState(id: string): AppState {
  return readJson<ProjectState>(stateFile(id))?.app ?? {};
}

export function patchAppState(id: string, patch: AppState): void {
  const cur = readJson<ProjectState>(stateFile(id)) ?? (readProjectJson(id) as ProjectJson | null);
  if (!cur) return;
  writeJson(stateFile(id), { ...cur, app: { ...(cur as ProjectState).app, ...patch } });
}

/** Benennt das Projekt um (project.json und App-Kopie). Die Änderung landet beim nächsten Snapshot im Verlauf. */
export function renameProject(id: string, name: string): void {
  const file = path.join(projectDir(id), '.cadide', 'project.json');
  const pj = readJson<ProjectJson>(file);
  if (!pj || pj.name === name) return;
  writeJson(file, { ...pj, name });
  const cur = readJson<ProjectState>(stateFile(id));
  if (cur) writeJson(stateFile(id), { ...cur, name });
}

/** Prüft ein Projekt und MELDET Auffälligkeiten. Repariert nichts (E28). */
export function inspectProject(id: string): { name: string; problems: string[] } {
  const dir = projectDir(id);
  const problems: string[] = [];
  if (!fs.existsSync(dir)) return { name: id, problems: ['Der Arbeitsordner existiert nicht.'] };
  const pj = readJson<ProjectJson>(path.join(dir, '.cadide', 'project.json'));
  const backup = readJson<ProjectState>(stateFile(id));
  if (!pj) {
    problems.push(backup
      ? '.cadide/project.json fehlt oder ist unlesbar. Eine Kopie liegt in den App-Daten (nicht automatisch wiederhergestellt).'
      : '.cadide/project.json fehlt oder ist unlesbar, und es gibt keine Kopie.');
  } else if (pj.id !== id) {
    problems.push('Die ID in .cadide/project.json passt nicht zum Arbeitsordner.');
  } else if (pj.api_version > API_VERSION) {
    problems.push(`Das Projekt nutzt api_version ${pj.api_version}, diese App kennt nur ${API_VERSION}.`);
  }
  const entry = pj?.entry ?? 'model.py';
  if (!fs.existsSync(path.join(dir, entry))) problems.push(`Einstiegspunkt ${entry} fehlt.`);
  for (const bad of ['.venv', 'venv', 'env']) {
    if (fs.existsSync(path.join(dir, bad, 'pyvenv.cfg'))) problems.push(`Im Projekt liegt eine eigene Python-Umgebung (${bad}/). Sie wird ignoriert und nicht in die ZIP gepackt.`);
  }
  return { name: pj?.name ?? backup?.name ?? id, problems };
}

export function listProjects(): ProjectListEntry[] {
  const root = workspacesDir();
  if (!fs.existsSync(root)) return [];
  const out: ProjectListEntry[] = [];
  for (const id of fs.readdirSync(root)) {
    if (!isProjectId(id)) continue;
    const dir = path.join(root, id);
    const pj = readJson<ProjectJson>(path.join(dir, '.cadide', 'project.json'));
    out.push({ id, name: pj?.name ?? id.slice(0, 8), modified: fs.statSync(dir).mtimeMs });
  }
  return out.sort((a, b) => b.modified - a.modified);
}

export function getLastProject(): string | null {
  const s = readJson<{ lastProject?: string }>(appStateFile());
  return s?.lastProject && isProjectId(s.lastProject) && fs.existsSync(projectDir(s.lastProject)) ? s.lastProject : null;
}

export function setLastProject(id: string): void {
  const s = readJson<Record<string, unknown>>(appStateFile()) ?? {};
  writeJson(appStateFile(), { ...s, lastProject: id });
}

/**
 * Verschiebt einen Arbeitsordner in die Sicherungen, statt ihn zu löschen (Regel 5: nichts geht still verloren).
 * Unter Windows hält ein eben beendetes Terminal den Ordner noch kurz als aktuelles Verzeichnis fest, daher mehrere Versuche.
 */
export async function backupWorkspace(id: string): Promise<string> {
  const src = projectDir(id);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dst = path.join(backupsDir(), `${id}-${stamp}`);
  fs.mkdirSync(backupsDir(), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(src, dst); return dst; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(code) || attempt >= 20) {
        throw new Error('Der Arbeitsordner ist noch in Benutzung (ein Terminal oder Programm liegt darin). Schließe es und versuche es erneut.');
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

/** Entpackt eine ZIP als Arbeitsordner `id`. Erst in einen Temp-Ordner, dann umbenennen: nie ein halb entpacktes Projekt. */
export async function extractProject(zipPath: string, id: string): Promise<string> {
  const dst = projectDir(id);
  if (fs.existsSync(dst)) throw new Error('Der Arbeitsordner existiert schon (erst sichern).');
  const tmp = path.join(workspacesDir(), `.tmp-${randomUUID()}`);
  try {
    await extractZip(zipPath, tmp);
    // Der Marker ist nur fürs Öffnen da. Bliebe er liegen, wäre er für Git eine unversionierte Datei ("ungespeichert").
    fs.rmSync(path.join(tmp, '.cadide', 'zip-info.json'), { force: true });
    fs.renameSync(tmp, dst);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return dst;
}
