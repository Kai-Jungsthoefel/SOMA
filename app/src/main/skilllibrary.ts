import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { skillIdFrom, uniqueSkillId } from '../shared/skillname';
import type { IgnoredSkillFile, LibraryState, LibraryText, SkillCheck } from '../shared/types';
import { backupText } from './files';
import {
  MAX_BYTES, bundledSkills, checkSkillText, isSkillId, librarySkills, norm, readSkillFile, showText, sortSkills, writeAtomic, type SkillDefaults, type SkillDirs,
} from './skills';

/**
 * Bibliothek der Skills in den Einstellungen (E78): eigene Skills anlegen, mitgelieferte bearbeiten, Dateien übernehmen.
 * Alles liegt im Ordner der eigenen Skills (`dirs.user`), die mitgelieferten bleiben unangetastet. Was ersetzt oder
 * entfernt wird, wandert in die Sicherung. Die Modelle betrifft das erst, wenn ein Skill dort neu kopiert wird: Ihre
 * Kopien in `.soma/skills/` bleiben, wie sie sind (sie wandern mit dem Modell).
 */

/** Fingerabdruck einer mitgelieferten Fassung (Zeilenenden egal), siehe getSkillBases. */
export const textHash = (t: string) => createHash('sha256').update(norm(t)).digest('hex').slice(0, 16);

const fileOf = (dirs: SkillDirs, id: string) => path.join(dirs.user, `${id}.md`);
const readOwn = (dirs: SkillDirs, id: string) => readSkillFile(fileOf(dirs, id));

/** Kennungen, die schon vergeben sind: Skills der Bibliothek und alle Dateien im eigenen Ordner, auch unlesbare. */
function takenIds(dirs: SkillDirs): Set<string> {
  const out = new Set(librarySkills(dirs).keys());
  try { for (const n of fs.readdirSync(dirs.user)) out.add(n.replace(/\.md$/i, '').toLowerCase()); } catch { /* noch kein eigener */ }
  return out;
}

/** Dateien im eigenen Ordner, die die App nicht liest, mit Grund. Gemeldet statt umbenannt (E28). */
function ignoredFiles(dir: string): IgnoredSkillFile[] {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out: IgnoredSkillFile[] = [];
  for (const name of names.sort()) {
    if (!/\.md$/i.test(name)) continue;
    const id = name.replace(/\.md$/i, '');
    if (!isSkillId(id)) { out.push({ name, reason: `File names may only contain lowercase letters, digits and “-”, for example ${skillIdFrom(id)}.md.` }); continue; }
    let size = 0;
    try { const st = fs.statSync(path.join(dir, name)); if (!st.isFile()) continue; size = st.size; } catch { out.push({ name, reason: 'The file cannot be read.' }); continue; }
    if (size > MAX_BYTES) out.push({ name, reason: `Larger than ${MAX_BYTES / 1024} KB.` });
    else if (readSkillFile(path.join(dir, name)) == null) out.push({ name, reason: 'The file cannot be read.' });
  }
  return out;
}

/**
 * Die Bibliothek für die Einstellungen, sortiert wie im Panel. `defaults`: Stufen für neue Modelle laut state.json,
 * `bases`: Fingerabdrücke der mitgelieferten Fassungen, auf denen bearbeitete Skills beruhen.
 */
export function libraryState(dirs: SkillDirs, defaults: SkillDefaults, bases: Record<string, string>): LibraryState {
  const bundled = bundledSkills(dirs.bundled);
  const skills = sortSkills([...librarySkills(dirs).values()]).map((s) => {
    const b = bundled.get(s.id);
    return {
      id: s.id, title: s.title, summary: showText(s.summary, s.vars, {}), category: s.category, order: s.order, source: s.source,
      defaultMode: defaults[s.id] ?? s.defaultMode,
      newerBuiltin: s.source === 'edited' && !!b && s.id in bases && bases[s.id] !== textHash(b.text),
    };
  });
  return { skills, ignored: ignoredFiles(dirs.user), dir: dirs.user };
}

export function readLibrarySkill(dirs: SkillDirs, id: string): LibraryText {
  const s = isSkillId(id) ? librarySkills(dirs).get(id) : undefined;
  if (!s) throw new Error(`The skill “${String(id)}” does not exist (any more).`);
  return { id, source: s.source, text: s.text, builtin: bundledSkills(dirs.bundled).get(id)?.text ?? null };
}

export interface Saved { backup: string | null; warnings: string[]; base: string | null | undefined }

/**
 * Text speichern. `base` ist der Text, den der Editor geladen hat: Hat sich die Datei seitdem geändert (etwa im Explorer
 * bearbeitet), kommt diese Fassung vorher in die Sicherung. Gleicht der Text der mitgelieferten Fassung, gibt es keine
 * eigene Datei (mehr): Der Skill ist wieder der mitgelieferte. `base` im Ergebnis: neuer Fingerabdruck für state.json
 * (string setzen, null entfernen, undefined nicht ändern).
 */
export function saveLibrarySkill(dirs: SkillDirs, id: string, text: string, base: string | null, backupDir: string): Saved {
  if (!isSkillId(id)) throw new Error('File names of skills may only contain lowercase letters, digits and “-”.');
  const check = checkSkillText(text);
  if (check.errors.length) throw new Error(check.errors.join(' '));
  const cur = readOwn(dirs, id);
  const builtin = bundledSkills(dirs.bundled).get(id)?.text ?? null;
  const outside = cur != null && base != null && norm(cur) !== norm(base);
  if (builtin != null && norm(text) === norm(builtin)) {
    // Zurück auf die mitgelieferte Fassung getippt: Die eigene Datei kommt weg, aber nicht ungesichert
    const backup = cur != null && norm(cur) !== norm(builtin) ? backupText(backupDir, `${id}.md`, cur) : null;
    if (cur != null) fs.rmSync(fileOf(dirs, id), { force: true });
    return { backup, warnings: check.warnings, base: null };
  }
  const backup = outside ? backupText(backupDir, `${id}.md`, cur) : null;
  writeAtomic(fileOf(dirs, id), text);
  return { backup, warnings: check.warnings, base: builtin != null ? textHash(builtin) : undefined };
}

/** Vorlage für einen neuen Skill (englisch wie alle Skills, E73). Die Kommentare im Kopf erklären die Schlüssel. */
function template(title: string): string {
  return `---
title: ${title}
name: ${title}
summary: One sentence for the list in the app.
order: 100
category: My skills
default: on-demand
when: the conversation turns to this topic
topics: First topic; Second topic
# title and summary are shown in the app, name and when in AGENTS.md (“Read when …”).
# default is the level for new models: always, on-demand or off.
# A setting the user can change in the app (number with range, or choices), used in the text as {{name}}:
# var wall: 2 | mm | Minimum wall | 0.5..10
# var material: PLA | | Material | PLA, PETG, ABS
---

# Skill: ${title}

Rules for the agent. Short and concrete: agents follow short rules better than long explanations.

## First topic

- …

## Second topic

- …
`;
}

/** Kopie eines Skills unter neuem Namen: Titel und Name im Kopf und die erste Überschrift tragen den neuen Namen. */
function retitle(text: string, oldTitle: string, title: string): string {
  const src = norm(text);
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  let head = m ? m[1] : '';
  for (const key of ['title', 'name']) {
    const re = new RegExp(`^${key}:.*$`, 'm');
    head = re.test(head) ? head.replace(re, `${key}: ${title}`) : `${key}: ${title}${head ? `\n${head}` : ''}`;
  }
  // Nur im Inhalt: Im Kopf stehen auch Kommentarzeilen mit „#“
  const body = (m ? src.slice(m[0].length) : `\n${src}`).replace(/^#\s+.*$/m, (h) => (h.includes(oldTitle) ? h.replace(oldTitle, title) : h));
  return `---\n${head}\n---\n${body}`;
}

/** Neuer eigener Skill: aus der Vorlage oder als Kopie von `from`. Rückgabe: die Kennung. */
export function createLibrarySkill(dirs: SkillDirs, title: string, from?: string): string {
  const name = title.replace(/\s+/g, ' ').trim();
  if (!name) throw new Error('Please enter a name for the skill.');
  if (name.length > 80) throw new Error('The name is too long (at most 80 characters).');
  const src = from == null ? null : librarySkills(dirs).get(from);
  if (from != null && !src) throw new Error(`The skill “${from}” does not exist (any more).`);
  const id = uniqueSkillId(skillIdFrom(name), takenIds(dirs));
  const file = fileOf(dirs, id);
  if (fs.existsSync(file)) throw new Error(`${id}.md already exists.`);
  writeAtomic(file, src ? retitle(src.text, src.title, name) : template(name));
  return id;
}

/**
 * Eigenen Skill löschen oder bearbeiteten auf die mitgelieferte Fassung zurücksetzen. Die Datei kommt in die Sicherung.
 * Mitgelieferte lassen sich nicht löschen, nur für neue Modelle ausschalten.
 */
export function removeLibrarySkill(dirs: SkillDirs, id: string, backupDir: string): string | null {
  const s = isSkillId(id) ? librarySkills(dirs).get(id) : undefined;
  if (!s) throw new Error(`The skill “${String(id)}” does not exist (any more).`);
  if (s.source === 'builtin') throw new Error('Built-in skills cannot be deleted. Set them to “Off” for new models instead.');
  const cur = readOwn(dirs, id);
  const backup = cur != null ? backupText(backupDir, `${id}.md`, cur) : null;
  fs.rmSync(fileOf(dirs, id), { force: true });
  return backup;
}

/** Was mit einer Datei geschehen soll, deren Kennung es schon gibt. */
export type ImportChoice = 'replace' | 'copy' | 'skip';
export interface Imported { ids: string[]; warnings: string[]; backups: string[]; bases: Record<string, string> }

/**
 * Markdown-Dateien als eigene Skills übernehmen. Die Kennung kommt aus dem Dateinamen. Gibt es sie schon, entscheidet
 * `ask` (ersetzen: die eigene Fassung kommt in die Sicherung, als Kopie: neue Kennung, überspringen). Unlesbares wird
 * übersprungen und gemeldet.
 */
export async function importLibrarySkills(dirs: SkillDirs, files: string[], backupDir: string,
  ask: (o: { file: string; id: string; title: string; source: string }) => Promise<ImportChoice>): Promise<Imported> {
  const out: Imported = { ids: [], warnings: [], backups: [], bases: {} };
  const bundled = bundledSkills(dirs.bundled);
  for (const file of files) {
    const name = path.basename(file);
    let text: string;
    try {
      if (fs.statSync(file).size > MAX_BYTES) { out.warnings.push(`${name}: larger than ${MAX_BYTES / 1024} KB, not imported.`); continue; }
      text = fs.readFileSync(file, 'utf8');
    } catch (e) { out.warnings.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); continue; }
    const check = checkSkillText(text);
    if (check.errors.length) { out.warnings.push(`${name}: ${check.errors.join(' ')} Not imported.`); continue; }
    let id = skillIdFrom(name.replace(/\.md$/i, ''));
    const existing = librarySkills(dirs).get(id);
    if (!existing) {
      // Eine Datei, die die App nicht lesen konnte (zu groß), wird nicht still ersetzt
      const cur = fs.existsSync(fileOf(dirs, id)) ? fs.readFileSync(fileOf(dirs, id), 'utf8') : null;
      if (cur != null) out.backups.push(backupText(backupDir, `${id}.md`, cur));
    } else {
      if (norm(existing.text) === norm(text)) { out.warnings.push(`${name}: “${existing.title}” is already there with the same text.`); continue; }
      const choice = await ask({ file: name, id, title: existing.title, source: existing.source });
      if (choice === 'skip') continue;
      if (choice === 'copy') id = uniqueSkillId(id, takenIds(dirs));
      else {
        const cur = readOwn(dirs, id);
        if (cur != null) out.backups.push(backupText(backupDir, `${id}.md`, cur));
      }
    }
    writeAtomic(fileOf(dirs, id), text);
    const b = bundled.get(id);
    if (b) out.bases[id] = textHash(b.text);
    out.ids.push(id);
  }
  return out;
}

/** Text prüfen (für die Hinweise beim Tippen). */
export const checkLibraryText = (text: unknown): SkillCheck => (typeof text === 'string' ? checkSkillText(text) : { errors: ['No text.'], warnings: [] });

/** Absoluter Pfad der eigenen Datei, null wenn es keine gibt (mitgeliefert). */
export function ownFile(dirs: SkillDirs, id: string): string | null {
  if (!isSkillId(id)) return null;
  const f = fileOf(dirs, id);
  return fs.existsSync(f) ? f : null;
}
