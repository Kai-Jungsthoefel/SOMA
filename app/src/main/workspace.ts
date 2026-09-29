import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectListEntry } from '../shared/types';
import { appStateFile, projectStateDir, templateDir, workspacesDir } from './paths';

export const API_VERSION = 1;

export interface ProjectJson {
  id: string;
  name: string;
  api_version: number;
  entry: string;
  main_output: string;
  created: string;
}

const readJson = <T>(file: string): T | null => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; }
};

export function projectDir(id: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error(`Ungueltige Projekt-ID: ${id}`);
  return path.join(workspacesDir(), id);
}

/** Neues Projekt: UUID-Ordner in den App-Daten (E21), Vorlage kopieren, Zustand doppelt ablegen (E27). */
export function createProject(name = 'Neues Modell'): { id: string; dir: string } {
  const id = randomUUID();
  const dir = projectDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(templateDir(), dir, { recursive: true });
  const pj: ProjectJson = { id, name, api_version: API_VERSION, entry: 'model.py', main_output: 'output/model.step', created: new Date().toISOString() };
  fs.mkdirSync(path.join(dir, '.cadide'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.cadide', 'project.json'), JSON.stringify(pj, null, 2));
  fs.mkdirSync(projectStateDir(), { recursive: true });
  fs.writeFileSync(path.join(projectStateDir(), `${id}.json`), JSON.stringify(pj, null, 2));
  setLastProject(id);
  return { id, dir };
}

/** Prueft ein Projekt und MELDET Auffaelligkeiten. Repariert nichts (E28). */
export function inspectProject(id: string): { name: string; problems: string[] } {
  const dir = projectDir(id);
  const problems: string[] = [];
  if (!fs.existsSync(dir)) return { name: id, problems: ['Der Arbeitsordner existiert nicht.'] };
  const pj = readJson<ProjectJson>(path.join(dir, '.cadide', 'project.json'));
  const backup = readJson<ProjectJson>(path.join(projectStateDir(), `${id}.json`));
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
    if (fs.existsSync(path.join(dir, bad, 'pyvenv.cfg'))) problems.push(`Im Projekt liegt eine eigene Python-Umgebung (${bad}/). Sie wird ignoriert.`);
  }
  return { name: pj?.name ?? backup?.name ?? id, problems };
}

export function listProjects(): ProjectListEntry[] {
  const root = workspacesDir();
  if (!fs.existsSync(root)) return [];
  const out: ProjectListEntry[] = [];
  for (const id of fs.readdirSync(root)) {
    if (!/^[0-9a-f-]{36}$/.test(id)) continue;
    const dir = path.join(root, id);
    const pj = readJson<ProjectJson>(path.join(dir, '.cadide', 'project.json'));
    out.push({ id, name: pj?.name ?? id.slice(0, 8), modified: fs.statSync(dir).mtimeMs });
  }
  return out.sort((a, b) => b.modified - a.modified);
}

export function getLastProject(): string | null {
  const s = readJson<{ lastProject?: string }>(appStateFile());
  return s?.lastProject && fs.existsSync(projectDir(s.lastProject)) ? s.lastProject : null;
}

export function setLastProject(id: string): void {
  fs.mkdirSync(path.dirname(appStateFile()), { recursive: true });
  const s = readJson<Record<string, unknown>>(appStateFile()) ?? {};
  fs.writeFileSync(appStateFile(), JSON.stringify({ ...s, lastProject: id }, null, 2));
}
