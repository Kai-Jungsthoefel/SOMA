import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ProjectListEntry, SkillMode } from '../shared/types';
import { SOMA_VERSION, isNewerVersion } from '../shared/version';
import { runSoma } from './build';
import { GitRepo } from './git';
import { appStateFile, backupsDir, editBackupsDir, foldersFile, previewsDir, projectStateDir, skillBackupsDir, skillDirs, templateDir, thumbnailsDir, workspacesDir } from './paths';
import { SKILLS_DIR, applyDefaultSkills, currentSkillId, isSkillId, isSkillMode, type SkillDefaults, type SkillModes } from './skills';
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
  /** Version von SOMA, die das Modell zuletzt gespeichert hat (E68). Fehlt bei Modellen von vor 0.1.0. */
  app_version?: string;
  /** Skills auf „Immer“ (E17, E55), ihre Kopien liegen in .soma/skills/. Vor E55 hießen sie „aktiv“. */
  skills?: string[];
  /** Skills auf „Bei Bedarf“ (E55), ebenfalls mit Kopie. Was in keiner der beiden Listen steht, ist aus. */
  skills_on_demand?: string[];
  /** Einstellungen der Skills je Kennung, nur vom Standard abweichende Werte (auch für ausgeschaltete Skills). */
  skill_settings?: Record<string, Record<string, number | string>>;
  /** Paketliste (E67), wenn nicht requirements.txt: im Ordner-Modus .soma/requirements.txt (packages.ts, env.py). */
  requirements?: string;
}

/** Zweite Kopie des Projektzustands in den App-Daten (E27) plus Angaben, die nur die App braucht. */
/** `exportDir`: Ordner des letzten Exports, dort beginnt der nächste Dateidialog. */
export interface AppState { zipPath?: string; savedHead?: string | null; savedAt?: number; exportDir?: string }
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
  if (!isProjectId(id)) throw new Error(`Invalid project ID: ${id}`);
  return folderOf(id) ?? path.join(workspacesDir(), id);
}

/**
 * Ordner-Modus: Modelle in einem Ordner des Nutzers, den er mit „Open folder“ geöffnet hat. Der Ordner gehört ihm: Die App
 * legt dort kein Git an, verschiebt und löscht ihn nie (E69 und „Remove“ gelten nicht), sie schreibt nur ihren Teil
 * (.soma/, den Abschnitt in AGENTS.md, folders.ts).
 */
function readFolders(): Record<string, string> {
  const all = readJson<Record<string, unknown>>(foldersFile()) ?? {};
  const out: Record<string, string> = {};
  for (const [id, dir] of Object.entries(all)) if (isProjectId(id) && typeof dir === 'string' && path.isAbsolute(dir)) out[id] = dir;
  return out;
}

export const folderOf = (id: string): string | null => readFolders()[id] ?? null;
export const isFolderProject = (id: string): boolean => folderOf(id) !== null;
/** Kennung, unter der ein Ordner schon eingetragen ist (gleicher Ordner, auch über Kurznamen oder andere Schreibweise). */
export function folderId(dir: string): string | null {
  const real = (p: string) => { try { return fs.realpathSync.native(p).toLowerCase(); } catch { return path.resolve(p).toLowerCase(); } };
  const want = real(dir);
  return Object.entries(readFolders()).find(([, d]) => real(d) === want)?.[0] ?? null;
}

export function registerFolder(id: string, dir: string): void {
  writeJson(foldersFile(), { ...readFolders(), [id]: path.resolve(dir) });
}

function unregisterFolder(id: string): void {
  const all = readFolders();
  if (!(id in all)) return;
  delete all[id];
  writeJson(foldersFile(), all);
}

const stateFile = (id: string) => path.join(projectStateDir(), `${id}.json`);
export const readProjectJson = (id: string) => readJson<ProjectJson>(path.join(projectDir(id), '.soma', 'project.json'));

/** Neues Projekt: UUID-Ordner in den App-Daten (E21), Vorlage kopieren, Zustand doppelt ablegen (E27), Git-Verlauf anlegen (E7). */
/**
 * Legt ein neues Modell aus der Vorlage an. `prepare` läuft vor dem ersten Build und dem Startcommit (etwa der Import eines
 * CadQuery-Skripts, E100), so beginnt schon der erste Stand mit dem fremden Skript. Wirft `prepare`, wird der halb
 * angelegte Ordner wieder entfernt und der Fehler weitergereicht.
 */
export async function createProject(name = 'New model', prepare?: (dir: string, id: string) => Promise<void>): Promise<{ id: string; dir: string }> {
  const id = randomUUID();
  const dir = projectDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(templateDir(), dir, { recursive: true });
  if (prepare) {
    try { await prepare(dir, id); } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
  }
  // Skills für neue Modelle (E46) vor dem ersten Build und dem Startcommit: Der erste Stand enthält sie schon
  const skills = applyDefaultSkills(dir, skillDirs(), skillBackupsDir(id), getSkillDefaults());
  const pj: ProjectJson = { id, name, api_version: API_VERSION, app_version: SOMA_VERSION, entry: 'model.py', main_output: 'output/model.step', created: new Date().toISOString(),
    ...(skills.always.length ? { skills: skills.always } : {}), ...(skills.demand.length ? { skills_on_demand: skills.demand } : {}) };
  writeJson(path.join(dir, '.soma', 'project.json'), pj);
  writeJson(stateFile(id), { ...pj, app: {} } satisfies ProjectState);
  // Einmal bauen, bevor der Startcommit entsteht: So enthält auch der erste Stand eine output/model.step
  // und lässt sich im Verlauf als Vorschau öffnen. Scheitert der Build, geht das Anlegen trotzdem weiter.
  await runSoma(['build', '--project', dir], dir, 90000);
  try {
    await new GitRepo(dir).init('New model created');
  } catch (e) {
    // Ohne Git bleibt das Projekt benutzbar. Der Verlauf meldet den Grund (Projekt-Check), statt das Anlegen scheitern zu lassen.
    console.error('[soma] Could not create the Git history:', e);
  }
  setLastProject(id);
  return { id, dir };
}

/** Angaben, die nur die App braucht (Pfad der Modelldatei, zuletzt gespeicherter Stand). */
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
  const file = path.join(projectDir(id), '.soma', 'project.json');
  const pj = readJson<ProjectJson>(file);
  if (!pj || pj.name === name) return;
  writeJson(file, { ...pj, name });
  const cur = readJson<ProjectState>(stateFile(id));
  if (cur) writeJson(stateFile(id), { ...cur, name });
}

/**
 * Beim Speichern: Version dieser App in project.json und die App-Kopie (E68), falls sie dort anders steht. Die Änderung
 * landet im Snapshot. Eine unlesbare project.json bleibt, wie sie ist (der Projekt-Check meldet sie).
 */
export function stampAppVersion(id: string): void {
  const file = path.join(projectDir(id), '.soma', 'project.json');
  const pj = readJson<ProjectJson>(file);
  if (!pj || pj.app_version === SOMA_VERSION) return;
  writeJson(file, { ...pj, app_version: SOMA_VERSION });
  const cur = readJson<ProjectState>(stateFile(id));
  if (cur) writeJson(stateFile(id), { ...cur, app_version: SOMA_VERSION });
}

/** Stufen der Skills laut project.json (E55), null wenn sie unlesbar ist. Fehlt eine Liste, ist sie leer. */
export function readSkillModes(id: string): SkillModes | null {
  const pj = readProjectJson(id);
  if (!pj) return null;
  const list = (x: unknown) => (Array.isArray(x) ? x.filter(isSkillId) : []);
  const always = list(pj.skills);
  return { always, demand: list(pj.skills_on_demand).filter((s) => !always.includes(s)) };
}

/** Skills und ihre Einstellungen ins Projekt schreiben, in project.json und die App-Kopie (E27). Wirft, wenn project.json unlesbar ist. */
export function updateProjectSkills(id: string, patch: { modes?: SkillModes; skill_settings?: ProjectJson['skill_settings'] }): void {
  const file = path.join(projectDir(id), '.soma', 'project.json');
  const pj = readJson<ProjectJson>(file);
  if (!pj) throw new Error('.soma/project.json is missing or unreadable. Without it no skill can be recorded.');
  // Leere Einstellungen fallen weg, damit project.json ohne Änderung auch gleich bleibt
  const settings = Object.fromEntries(Object.entries(patch.skill_settings ?? pj.skill_settings ?? {}).filter(([, v]) => v && Object.keys(v).length));
  // `skills` bleibt auch leer stehen (wie bisher), `skills_on_demand` nur, wenn es welche gibt
  const next: ProjectJson = { ...pj, ...(patch.modes ? { skills: patch.modes.always, skills_on_demand: patch.modes.demand } : {}) };
  if (!next.skills_on_demand?.length) delete next.skills_on_demand;
  if (Object.keys(settings).length) next.skill_settings = settings; else delete next.skill_settings;
  writeJson(file, next);
  const cur = readJson<ProjectState>(stateFile(id));
  if (cur) {
    const copy: ProjectState = { ...cur, skills: next.skills };
    if (next.skills_on_demand) copy.skills_on_demand = next.skills_on_demand; else delete copy.skills_on_demand;
    if (next.skill_settings) copy.skill_settings = next.skill_settings; else delete copy.skill_settings;
    writeJson(stateFile(id), copy);
  }
}

/** Prüft ein Projekt und MELDET Auffälligkeiten. Repariert nichts (E28). */
export function inspectProject(id: string): { name: string; problems: string[] } {
  const dir = projectDir(id);
  const problems: string[] = [];
  if (!fs.existsSync(dir)) return { name: id, problems: ['The working folder does not exist.'] };
  const pj = readJson<ProjectJson>(path.join(dir, '.soma', 'project.json'));
  const backup = readJson<ProjectState>(stateFile(id));
  if (!pj) {
    problems.push(backup
      ? '.soma/project.json is missing or unreadable. A copy is in the app data (not restored automatically).'
      : '.soma/project.json is missing or unreadable, and there is no copy.');
  } else if (pj.id !== id) {
    problems.push('The ID in .soma/project.json does not match the working folder.');
  } else if (pj.api_version > API_VERSION) {
    problems.push(`The project uses api_version ${pj.api_version}, this app only knows ${API_VERSION}.`);
  } else if (isNewerVersion(pj.app_version)) {
    problems.push(`The model was last saved with SOMA ${pj.app_version}, this app is ${SOMA_VERSION}. Newer features may be missing here.`);
  }
  const entry = pj?.entry ?? 'model.py';
  if (!fs.existsSync(path.join(dir, entry))) problems.push(`Entry point ${entry} is missing.`);
  for (const s of [pj?.skills, pj?.skills_on_demand].flatMap((x) => (Array.isArray(x) ? x : [])).filter(isSkillId)) {
    if (!fs.existsSync(path.join(dir, SKILLS_DIR, `${s}.md`))) problems.push(`The skill “${s}” is switched on, but ${SKILLS_DIR}/${s}.md is missing.`);
  }
  // Ein geöffneter Ordner darf eigene Umgebungen haben, sie gehören dem Nutzer
  for (const bad of isFolderProject(id) ? [] : ['.venv', 'venv', 'env']) {
    if (fs.existsSync(path.join(dir, bad, 'pyvenv.cfg'))) problems.push(`The project contains its own Python environment (${bad}/). It is ignored and not packed into the saved file.`);
  }
  return { name: pj?.name ?? backup?.name ?? id, problems };
}

export function listProjects(): ProjectListEntry[] {
  const root = workspacesDir();
  const out: ProjectListEntry[] = [];
  const folders = readFolders();
  for (const id of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    if (!isProjectId(id) || folders[id]) continue;
    const dir = path.join(root, id);
    const pj = readJson<ProjectJson>(path.join(dir, '.soma', 'project.json'));
    out.push({ id, name: pj?.name ?? id.slice(0, 8), modified: fs.statSync(dir).mtimeMs, saved: !!getAppState(id).zipPath });
  }
  // Geöffnete Ordner: Fehlt einer (verschoben, umbenannt, Laufwerk ab), bleibt er mit Hinweis in der Liste (E28: melden)
  for (const [id, dir] of Object.entries(folders)) {
    const pj = readJson<ProjectJson>(path.join(dir, '.soma', 'project.json'));
    let modified = 0;
    try { modified = fs.statSync(path.join(dir, '.soma')).mtimeMs; } catch { /* fehlt */ }
    out.push({ id, name: pj?.name ?? path.basename(dir), modified, saved: true, folder: dir, ...(fs.existsSync(dir) ? {} : { missing: true }) });
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
 * Stufen für neue Modelle, soweit der Nutzer sie abweichend vom Kopf der Skills festgelegt hat (E46, E55). Einträge von
 * vor E55 waren an/aus: an gilt als „Immer“, aus als „Bei Bedarf“ (nicht an hieß damals nur: nicht bei jeder Änderung).
 */
export function getSkillDefaults(): SkillDefaults {
  const raw = readJson<{ skill_defaults?: unknown }>(appStateFile())?.skill_defaults;
  if (!raw || typeof raw !== 'object') return {};
  const out: SkillDefaults = {};
  for (const [id, v] of Object.entries(raw)) {
    if (!isSkillId(id)) continue;
    if (isSkillMode(v)) out[id] = v; else if (typeof v === 'boolean') out[id] = v ? 'always' : 'demand';
  }
  return withCurrentIds(out);
}

/** Legt die Stufe für neue Modelle fest. Entspricht sie dem Kopf des Skills (`factory`), fällt der Eintrag weg. */
export function setSkillDefault(id: string, mode: SkillMode, factory: SkillMode): void {
  const s = readJson<Record<string, unknown>>(appStateFile()) ?? {};
  const next = { ...getSkillDefaults() };
  if (mode === factory) delete next[id]; else next[id] = mode;
  const out: Record<string, unknown> = { ...s, skill_defaults: next };
  if (!Object.keys(next).length) delete out.skill_defaults;
  writeJson(appStateFile(), out);
}

/**
 * Fingerabdrücke der mitgelieferten Fassungen, auf denen bearbeitete Skills beruhen (E78), je Kennung. Bringt eine neuere
 * App eine andere Fassung mit, sagen die Einstellungen das, statt die Bearbeitung still zu behalten oder zu ersetzen.
 */
export function getSkillBases(): Record<string, string> {
  const raw = readJson<{ skill_bases?: unknown }>(appStateFile())?.skill_bases;
  if (!raw || typeof raw !== 'object') return {};
  return withCurrentIds(Object.fromEntries(Object.entries(raw).filter(([id, v]) => isSkillId(id) && typeof v === 'string')) as Record<string, string>);
}

/**
 * Einträge unter alten Kennungen (bis 0.5.0, E87) gelten für den Nachfolger, sofern es für ihn keinen eigenen gibt. Beim
 * nächsten Schreiben stehen sie unter der neuen Kennung in state.json.
 */
function withCurrentIds<T>(entries: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [id, v] of Object.entries(entries)) if (currentSkillId(id) === id) out[id] = v;
  for (const [id, v] of Object.entries(entries)) if (currentSkillId(id) !== id && !(currentSkillId(id) in out)) out[currentSkillId(id)] = v;
  return out;
}

/** Fingerabdruck setzen (null: entfernen, etwa nach dem Zurücksetzen). */
export function setSkillBase(id: string, hash: string | null): void {
  const s = readJson<Record<string, unknown>>(appStateFile()) ?? {};
  const next = { ...getSkillBases() };
  if (hash == null) delete next[id]; else next[id] = hash;
  const out: Record<string, unknown> = { ...s, skill_bases: next };
  if (!Object.keys(next).length) delete out.skill_bases;
  writeJson(appStateFile(), out);
}

/**
 * Verschiebt einen Arbeitsordner in die Sicherungen, statt ihn zu löschen (Regel 5: nichts geht still verloren).
 * Unter Windows hält ein eben beendetes Terminal den Ordner noch kurz als aktuelles Verzeichnis fest, daher mehrere Versuche.
 */
export async function backupWorkspace(id: string): Promise<string> {
  if (isFolderProject(id)) throw new Error('This model is a folder of yours. SOMA does not move it.');
  const src = projectDir(id);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dst = path.join(backupsDir(), `${id}-${stamp}`);
  fs.mkdirSync(backupsDir(), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(src, dst); return dst; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(code) || attempt >= 20) {
        throw new Error('The working folder is still in use (a terminal or program is open in it). Close it and try again.');
      }
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}

/**
 * Ordner, die Git nicht sieht (in der .gitignore), in denen aber Eigenes des Nutzers liegen kann: Markierungen, Bilder und
 * Videos von `soma render`, Ergebnisse, gebaute Animationen.
 */
const UNTRACKED_CONTENT = ['.soma/feedback', 'renders', '.soma/results', '.soma/anim', '.soma/drawings'];

const hasFiles = (dir: string): boolean => {
  try { return fs.readdirSync(dir).length > 0; } catch { return false; }
};

/**
 * Ein neues Modell, das noch genau der Vorlage entspricht (E69): nie gespeichert, im Verlauf nur der Startcommit,
 * nichts geändert oder hinzugekommen, auch nicht dort, wo Git nicht hinsieht, und keine Sicherungen. Verschwindet es,
 * geht nichts verloren. Im Zweifel (Git unlesbar, Fehler) gilt es als verändert und bleibt.
 */
export async function isUntouched(id: string): Promise<boolean> {
  try {
    if (isFolderProject(id)) return false; // ein Ordner des Nutzers verschwindet nie von selbst
    const dir = projectDir(id);
    if (!fs.existsSync(dir) || getAppState(id).zipPath) return false;
    if (UNTRACKED_CONTENT.some((rel) => hasFiles(path.join(dir, rel)))) return false;
    if (hasFiles(editBackupsDir(id)) || hasFiles(skillBackupsDir(id))) return false;
    const git = new GitRepo(dir);
    if (!(await git.isRepo())) return false;
    const count = await git.run(['rev-list', '--count', 'HEAD']);
    if (!count.ok || count.out.trim() !== '1') return false;
    return !(await git.status()).dirty;
  } catch { return false; }
}

/**
 * Löscht die Daten der App zu einem Modell, das es nicht mehr gibt: die zweite Kopie des Projektzustands, Vorschauen alter
 * Stände und das Vorschaubild der Startseite. Sicherungen in workspace-backups/ bleiben (nichts geht still verloren).
 */
export function forgetProject(id: string): void {
  if (!isProjectId(id)) return;
  unregisterFolder(id);
  for (const p of [stateFile(id), path.join(previewsDir(), id), path.join(thumbnailsDir(), `${id}.jpg`)]) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* Cache, nächstes Mal */ }
  }
}

/**
 * Verwirft den Arbeitsordner eines unveränderten Modells (isUntouched, vorher prüfen). Erst umbenennen, dann löschen: Hält
 * ein eben beendetes Terminal den Ordner noch fest, schlägt das Umbenennen als Ganzes fehl (mehrere Versuche), statt einen
 * halb gelöschten Ordner zu hinterlassen. Klappt es nicht, bleibt das Modell stehen. Liefert true, wenn es weg ist.
 */
export async function discardWorkspace(id: string): Promise<boolean> {
  if (isFolderProject(id)) return false;
  const src = projectDir(id);
  const tmp = path.join(workspacesDir(), `.tmp-verworfen-${randomUUID()}`);
  for (let attempt = 0; ; attempt++) {
    try { fs.renameSync(src, tmp); break; } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? '';
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(code) || attempt >= 20) return false;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  forgetProject(id);
  // Einzelne Dateien können noch kurz gesperrt sein (eben beendete Prozesse): mehrere Versuche, ein Rest räumt sweepDiscarded weg
  await fs.promises.rm(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }).catch(() => {});
  return true;
}

/** Reste verworfener Modelle (discardWorkspace), deren Löschen beim letzten Mal nicht ganz klappte. Beim Start der App. */
export function sweepDiscarded(): void {
  let names: string[] = [];
  try { names = fs.readdirSync(workspacesDir()).filter((n) => n.startsWith('.tmp-verworfen-')); } catch { return; }
  for (const n of names) void fs.promises.rm(path.join(workspacesDir(), n), { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
}

/** Entpackt eine Modelldatei (.soma oder .zip) als Arbeitsordner `id`. Erst in einen Temp-Ordner, dann umbenennen: nie ein halb entpacktes Projekt. */
export async function extractProject(zipPath: string, id: string): Promise<string> {
  const dst = projectDir(id);
  if (fs.existsSync(dst)) throw new Error('The working folder already exists (back it up first).');
  const tmp = path.join(workspacesDir(), `.tmp-${randomUUID()}`);
  try {
    await extractZip(zipPath, tmp);
    // Der Marker ist nur fürs Öffnen da. Bliebe er liegen, wäre er für Git eine unversionierte Datei ("ungespeichert").
    fs.rmSync(path.join(tmp, '.soma', 'zip-info.json'), { force: true });
    fs.renameSync(tmp, dst);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return dst;
}
