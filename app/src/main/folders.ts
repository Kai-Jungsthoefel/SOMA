import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SOMA_VERSION } from '../shared/version';
import { resolveInside } from './files';
import { skillBackupsDir, skillDirs, templateDir, workspacesDir } from './paths';
import { BEGIN as SKILLS_BEGIN, END as SKILLS_END, applyDefaultSkills, writeAtomic } from './skills';
import { API_VERSION, folderOf, getSkillDefaults, isProjectId, type ProjectJson } from './workspace';

/**
 * Ordner-Modus („Open folder“): SOMA in einem Ordner des Nutzers, etwa einem Repository. Der Ordner gehört ihm. Die App
 * legt nur ihren Teil an (.soma/ mit eigener .gitignore, bei Bedarf model.py) und ergänzt AGENTS.md um einen Abschnitt
 * zwischen Markierungen, CLAUDE.md um einen Verweis darauf. Vorher sagt ein Hinweis, was angelegt und was geändert wird
 * (Wunsch des Nutzers). Geänderte Dateien kommen vorher in die Sicherungen. Git rührt die App hier nicht an.
 */

export const FOLDER_BEGIN = '<!-- soma:folder -->';
export const FOLDER_END = '<!-- /soma:folder -->';
const CLAUDE_REF = '@AGENTS.md';
/** Kopf der AGENTS.md eines ganzen SOMA-Modells (Vorlage). Ein solcher Ordner (etwa ein geklontes Modell) bleibt, wie er ist. */
const TEMPLATE_HEAD = '# Instructions for the coding agent (managed by the app';
/** Paketliste im Ordner-Modus: Eine requirements.txt im Ordner gehört dem Nutzer (packages.ts, env.py). */
const FOLDER_REQUIREMENTS = '.soma/requirements.txt';

/** Zwischenergebnisse der App in .soma/, relativ zu .soma/ (wie die .gitignore der Vorlage). project.json und Skills bleiben sichtbar. */
const SOMA_GITIGNORE = `# Written by SOMA: intermediate results of the app, regenerated
model.glb
model.map.json
build.json
zip-info.json
feedback/
geometry/
anim/
results/
drawings/
env/
help/
`;

const FOLDER_GIT = `## Version history (git)

SOMA does not manage Git in this folder. If the folder is a repository, the app shows its commits as a timeline under the 3D view, but it does not commit or restore anything here.

- Commit only when the user asks, and follow the conventions of this repository.
- Do not rewrite history unless the user asks for it explicitly.
`;

const read = (file: string): string | null => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const readJson = <T>(file: string): T | null => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; } };

/** Ein ganzes SOMA-Modell (AGENTS.md aus der Vorlage), etwa ein geklontes Repository eines Modells. */
export function isFullModel(dir: string): boolean {
  return (read(path.join(dir, 'AGENTS.md')) ?? '').trimStart().startsWith(TEMPLATE_HEAD);
}

/** Reines CadQuery-Skript (E100): ohne soma, mit show_object oder result. Dann gilt der Kompatibilitätsmodus beim Bauen. */
function isPlainScript(file: string): boolean {
  const text = read(file) ?? '';
  return !/^\s*(from\s+soma\b|import\s+soma\b)/m.test(text) && /\bshow_object\s*\(|^\s*result\s*=/m.test(text);
}

/**
 * Abschnitt für AGENTS.md, gebaut aus der AGENTS.md der Vorlage: ab „Project layout“, mit eigenem Kopf, ohne die Regeln
 * zum Committen (die App verwaltet Git hier nicht), mit der Einstiegsdatei statt model.py und der Paketliste in .soma/.
 * `skills`: die bisherige Liste der Skills (zwischen ihren Markierungen), sonst die leere aus der Vorlage.
 */
export function folderSection(entry: string, plain: boolean, skills?: string): string {
  const tpl = (read(path.join(templateDir(), 'AGENTS.md')) ?? '').replace(/\r\n/g, '\n');
  const at = tpl.indexOf('## Project layout');
  let body = at >= 0 ? tpl.slice(at) : tpl;
  body = body.replace(/## Version history \(git\)\n[\s\S]*?(?=\n## )/, FOLDER_GIT);
  body = body.replace(/`requirements\.txt`/g, `\`${FOLDER_REQUIREMENTS}\``);
  if (entry !== 'model.py') body = body.replace(/model\.py/g, entry);
  if (skills) {
    const a = body.indexOf(SKILLS_BEGIN), z = body.indexOf(SKILLS_END);
    if (a >= 0 && z > a) body = body.slice(0, a) + skills + body.slice(z + SKILLS_END.length);
  }
  const head = [
    FOLDER_BEGIN,
    '# SOMA (written by the app, do not edit this section)',
    '',
    'The SOMA app writes and replaces everything between the two `soma:folder` markers. The rest of this file belongs to the folder.',
    '',
    `A person designs a 3D model with code in this folder, together with you. The model is written in Python with CadQuery, the entry point is \`${entry}\`. The SOMA app shows the result in a 3D viewer next to the terminal.`,
    '',
  ];
  if (plain) {
    head.push(`\`${entry}\` is a plain CadQuery script (\`show_object\` or \`result\`). SOMA builds it in a compatibility mode. Keep its style and leave rules 1, 2 and 9 aside unless the user asks to switch to \`add_part\`.`, '');
  }
  return `${head.join('\n')}${body.trim()}\n${FOLDER_END}`;
}

/** Bisherige Liste der Skills im Abschnitt, mit Markierungen. */
function currentSkills(section: string): string | undefined {
  const a = section.indexOf(SKILLS_BEGIN), z = section.indexOf(SKILLS_END);
  return a >= 0 && z > a ? section.slice(a, z + SKILLS_END.length) : undefined;
}

/** Text mit dem Abschnitt: ersetzt einen vorhandenen, sonst angehängt (Zeilenenden wie in der Datei). */
function withSection(cur: string | null, section: (old: string | undefined) => string): string {
  if (cur == null) return `${section(undefined)}\n`;
  const eol = cur.includes('\r\n') ? '\r\n' : '\n';
  const norm = cur.replace(/\r\n/g, '\n');
  const a = norm.indexOf(FOLDER_BEGIN), z = norm.indexOf(FOLDER_END);
  const next = a >= 0 && z > a
    ? norm.slice(0, a) + section(currentSkills(norm.slice(a, z))) + norm.slice(z + FOLDER_END.length)
    : `${norm.replace(/\s*$/, '')}\n\n${section(undefined)}\n`;
  return next.replace(/\n/g, eol);
}

const hasSection = (text: string | null) => !!text && text.includes(FOLDER_BEGIN) && text.includes(FOLDER_END);
const hasClaudeRef = (text: string | null) => !!text && text.toLowerCase().includes(CLAUDE_REF.toLowerCase());

/** Python-Dateien direkt im Ordner, für die Frage nach der Einstiegsdatei. */
export function topLevelScripts(dir: string): string[] {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && /\.py$/i.test(e.name)).map((e) => e.name); } catch { return []; }
}

export interface FolderPlan {
  dir: string;
  /** Einstiegsdatei relativ zum Ordner (mit /). */
  entry: string;
  /** model.py aus der Vorlage anlegen. */
  createModel: boolean;
  /** Was angelegt und was geändert wird, als Zeilen für den Hinweis. Beides leer: Der Ordner ist schon eingerichtet. */
  create: string[];
  change: string[];
}

/** Was „Open folder“ in `dir` anlegen und ändern würde. Liest nur. */
export function planFolder(dir: string, entry: string, createModel: boolean): FolderPlan {
  const create: string[] = [];
  const change: string[] = [];
  const pj = readJson<ProjectJson>(path.join(dir, '.soma', 'project.json'));
  if (!fs.existsSync(path.join(dir, '.soma'))) create.push('.soma/  app data, cache and skills (intermediate results are ignored by Git)');
  else if (!pj) create.push('.soma/project.json  ID and settings of the model');
  else if (pj.entry !== entry) change.push(`.soma/project.json  entry point ${entry}`);
  if (createModel) create.push('model.py  a model from the template with an example part');
  if (!isFullModel(dir)) {
    const agents = read(path.join(dir, 'AGENTS.md'));
    if (agents == null) create.push('AGENTS.md  instructions for the agent');
    else if (!hasSection(agents)) change.push('AGENTS.md  adds a section for SOMA at the end');
    const claude = read(path.join(dir, 'CLAUDE.md'));
    if (claude == null) create.push('CLAUDE.md  points Claude Code to AGENTS.md');
    else if (!hasClaudeRef(claude)) change.push('CLAUDE.md  adds a line that points to AGENTS.md');
  }
  if ((create.length || change.length) && !fs.existsSync(path.join(dir, 'output'))) create.push('output/  the result of each build (model.step)');
  return { dir, entry, createModel, create, change };
}

/** Kopie einer Datei des Nutzers in die Sicherungen, bevor die App sie ändert. */
function backupFile(file: string, backupDir: string): void {
  fs.mkdirSync(backupDir, { recursive: true });
  fs.copyFileSync(file, path.join(backupDir, path.basename(file)));
}

/**
 * Richtet den Ordner nach `plan` ein und gibt die Kennung des Modells zurück. Eine Kennung aus .soma/project.json bleibt,
 * außer ein anderer Ordner oder ein Arbeitsordner der App hat schon dieselbe (kopierter Ordner): dann eine neue.
 * `backupRoot`: dort landen die Fassungen geänderter Dateien.
 */
export function applyFolder(plan: FolderPlan, backupRoot: string): { id: string; newId: boolean } {
  const { dir, entry } = plan;
  const pjFile = path.join(dir, '.soma', 'project.json');
  const old = readJson<ProjectJson>(pjFile);
  const taken = (id: string) => {
    const other = folderOf(id);
    if (other && fs.existsSync(other) && !sameDir(other, dir)) return true;
    return !other && fs.existsSync(path.join(workspacesDir(), id));
  };
  const keep = old && isProjectId(old.id) && !taken(old.id);
  const id = keep ? old.id : randomUUID();
  const backupDir = path.join(backupRoot, `${id}-folder-${new Date().toISOString().replace(/[:.]/g, '-')}`);
  const full = isFullModel(dir);

  fs.mkdirSync(path.join(dir, '.soma'), { recursive: true });
  const ignore = path.join(dir, '.soma', '.gitignore');
  if (!full && !fs.existsSync(ignore)) fs.writeFileSync(ignore, SOMA_GITIGNORE);
  if (plan.createModel) fs.copyFileSync(path.join(templateDir(), 'model.py'), resolveInside(dir, 'model.py'));

  const pj: ProjectJson = old
    ? { ...old, id, entry }
    : { id, name: path.basename(dir), api_version: API_VERSION, app_version: SOMA_VERSION, entry, main_output: 'output/model.step', created: new Date().toISOString(), requirements: FOLDER_REQUIREMENTS };
  if (!old || old.id !== id || old.entry !== entry) writeAtomic(pjFile, JSON.stringify(pj, null, 2));

  if (!full) {
    writeFolderFiles(dir, entry, backupDir);
    // Skills nach den Vorgaben (E46), nur beim ersten Einrichten. Ihre Liste kommt in den Abschnitt von AGENTS.md
    if (!old) {
      const skills = applyDefaultSkills(dir, skillDirs(), skillBackupsDir(id), getSkillDefaults());
      writeAtomic(pjFile, JSON.stringify({ ...pj, ...(skills.always.length ? { skills: skills.always } : {}), ...(skills.demand.length ? { skills_on_demand: skills.demand } : {}) }, null, 2));
    }
  }
  return { id, newId: !!old && !keep };
}

/** AGENTS.md mit dem Abschnitt und CLAUDE.md mit dem Verweis schreiben, soweit nötig. Geänderte Dateien vorher sichern. */
function writeFolderFiles(dir: string, entry: string, backupDir: string): void {
  const agentsFile = path.join(dir, 'AGENTS.md');
  const plain = isPlainScript(path.join(dir, entry));
  const cur = read(agentsFile);
  const next = withSection(cur, (skills) => folderSection(entry, plain, skills));
  if (next !== cur) {
    if (cur != null) backupFile(agentsFile, backupDir);
    writeAtomic(agentsFile, next);
  }
  const claudeFile = path.join(dir, 'CLAUDE.md');
  const claude = read(claudeFile);
  if (claude == null) writeAtomic(claudeFile, `${CLAUDE_REF}\n`);
  else if (!hasClaudeRef(claude)) {
    backupFile(claudeFile, backupDir);
    const eol = claude.includes('\r\n') ? '\r\n' : '\n';
    writeAtomic(claudeFile, `${claude.replace(/\s*$/, '')}${eol}${eol}<!-- SOMA: instructions for the 3D model are in AGENTS.md -->${eol}${CLAUDE_REF}${eol}`);
  }
}

/**
 * Beim Öffnen: Den Abschnitt in AGENTS.md auf den Stand dieser App bringen (neue Vorlage, andere Einstiegsdatei). Nur
 * wenn er schon da ist, die Liste der Skills bleibt. Die alte Fassung kommt in die Sicherungen. Fehlt der Abschnitt
 * (vom Nutzer entfernt), bleibt das so: „Open folder“ fragt beim nächsten Mal wieder.
 */
export function refreshFolderSection(dir: string, entry: string, backupRoot: string, id: string): void {
  const agentsFile = path.join(dir, 'AGENTS.md');
  const cur = read(agentsFile);
  if (!hasSection(cur)) return;
  const next = withSection(cur, (skills) => folderSection(entry, isPlainScript(path.join(dir, entry)), skills));
  if (next === cur) return;
  backupFile(agentsFile, path.join(backupRoot, `${id}-folder-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  writeAtomic(agentsFile, next);
}

function sameDir(a: string, b: string): boolean {
  const real = (p: string) => { try { return fs.realpathSync.native(p).toLowerCase(); } catch { return path.resolve(p).toLowerCase(); } };
  return real(a) === real(b);
}
