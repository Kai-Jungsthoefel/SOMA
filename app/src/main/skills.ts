import fs from 'node:fs';
import path from 'node:path';
import type { SkillInfo } from '../shared/types';
import { backupText, resolveInside } from './files';

/**
 * Skills (E17): Regelwerke als Markdown, die der Nutzer pro Modell zuschaltet. Die App liefert sie mit
 * (`resources/skills/`). Ein aktivierter Skill wird nach `.soma/skills/<id>.md` kopiert, steht in `project.json` und wird
 * in einem eigenen Abschnitt der `AGENTS.md` aufgeführt. So wandert er mit ZIP und Git und gilt für jeden Agenten.
 * Die Kopie im Projekt bleibt, wie sie ist, auch wenn eine neuere App eine neuere Fassung mitbringt.
 */

/** Kennung = Dateiname ohne .md. Nur Kleinbuchstaben, Ziffern und Bindestrich: Sie landet in Pfaden und in AGENTS.md. */
const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const isSkillId = (id: unknown): id is string => typeof id === 'string' && ID.test(id);
export const SKILLS_DIR = '.soma/skills';
const BEGIN = '<!-- soma:skills -->';
const END = '<!-- /soma:skills -->';
const MAX_BYTES = 256 * 1024;

interface Parsed { id: string; title: string; name: string; summary: string; order: number; topics: string[]; text: string }

/** Zeilenenden vereinheitlichen: Eine Kopie mit CRLF (etwa nach einem Git-Checkout) gilt nicht als geändert. */
const norm = (t: string) => t.replace(/\r\n?/g, '\n');

/**
 * Liest Kopf und Inhalt. Der Kopf steht zwischen zwei `---`-Zeilen als `schlüssel: wert` (title, summary und topics für
 * die Oberfläche auf Deutsch, name auf Englisch für AGENTS.md). Fehlt er, gilt die erste Überschrift als Titel.
 */
export function parseSkill(id: string, raw: string): Parsed {
  const text = norm(raw);
  const meta: Record<string, string> = {};
  let body = text;
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (m) {
    for (const line of m[1].split('\n')) {
      const kv = /^([a-z_]+):\s*(.*)$/.exec(line.trim());
      if (kv) meta[kv[1]] = kv[2].trim();
    }
    body = text.slice(m[0].length);
  }
  const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  // Themen für die Übersicht: aus dem Kopf (deutsch, mit „;“ getrennt), sonst die Zwischenüberschriften
  const topics = (meta.topics ? meta.topics.split(';') : [...body.matchAll(/^##\s+(.+)$/gm)].map((x) => x[1]))
    .map((x) => x.trim()).filter(Boolean).slice(0, 12);
  return {
    id, text: raw,
    title: meta.title || heading || id,
    name: meta.name || heading || meta.title || id,
    summary: meta.summary ?? '',
    order: Number(meta.order) || 100,
    topics,
  };
}

function readSkillFile(file: string): string | null {
  try {
    if (fs.statSync(file).size > MAX_BYTES) return null;
    return fs.readFileSync(file, 'utf8');
  } catch { return null; }
}

/** Mitgelieferte Skills aus dem Ordner der App. Unlesbare oder falsch benannte Dateien fallen weg. */
export function bundledSkills(dir: string): Map<string, Parsed> {
  const out = new Map<string, Parsed>();
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names.sort()) {
    const id = n.replace(/\.md$/i, '');
    if (!/\.md$/i.test(n) || !isSkillId(id)) continue;
    const raw = readSkillFile(path.join(dir, n));
    if (raw != null) out.set(id, parseSkill(id, raw));
  }
  return out;
}

const relOf = (id: string) => `${SKILLS_DIR}/${id}.md`;

/** Kopie im Projekt, sofern lesbar. Der Pfad geht durch resolveInside: Ein Verweis nach außen wird nicht gelesen. */
function projectCopy(root: string, id: string): string | null {
  try { return readSkillFile(resolveInside(root, relOf(id))); } catch { return null; }
}

function agentsText(root: string): string | null {
  try { return fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'); } catch { return null; }
}

/** Die Liste der Skills in AGENTS.md: der Abschnitt zwischen den Markierungen, ohne sie die ganze Datei. */
function agentsList(text: string): string {
  const a = text.indexOf(BEGIN), z = text.indexOf(END);
  return a >= 0 && z > a ? text.slice(a, z) : text;
}

/**
 * Alle Skills für die Oberfläche: die mitgelieferten und solche, die nur im Projekt liegen (etwa aus einer neueren App).
 * `active` stammt aus project.json (null: unlesbar). Auffälligkeiten werden gemeldet, nicht behoben (E28).
 */
export function listSkills(root: string, bundledDir: string, active: string[] | null): SkillInfo[] {
  const bundled = bundledSkills(bundledDir);
  const on = new Set((active ?? []).filter(isSkillId));
  let files: string[] = [];
  try { files = fs.readdirSync(path.join(root, SKILLS_DIR)).filter((n) => /\.md$/i.test(n)).map((n) => n.replace(/\.md$/i, '')).filter(isSkillId); } catch { /* noch keiner aktiv */ }
  const raw = agentsText(root);
  const agents = raw == null ? null : agentsList(raw);
  const ids = [...new Set([...bundled.keys(), ...on, ...files])];
  const out: SkillInfo[] = ids.map((id) => {
    const b = bundled.get(id);
    const copy = projectCopy(root, id);
    const meta = b ?? (copy != null ? parseSkill(id, copy) : null);
    const isOn = on.has(id);
    const info: SkillInfo = {
      id, title: meta?.title ?? id, summary: meta?.summary ?? '', topics: meta?.topics ?? [], order: meta?.order ?? 100,
      bundled: !!b, active: isOn, file: copy != null ? relOf(id) : null,
      changed: !!b && copy != null && norm(copy) !== norm(b.text),
      problems: [],
    };
    if (isOn && copy == null) info.problems.push(`Aktiv, aber ${relOf(id)} fehlt oder ist unlesbar. Der Agent findet die Regeln nicht.`);
    if (!isOn && copy != null) info.problems.push(`Nicht aktiv, aber ${relOf(id)} liegt noch im Projekt.`);
    if (isOn && agents != null && !agents.includes(relOf(id))) info.problems.push('AGENTS.md nennt diesen Skill nicht. Ein Agent erfährt nichts davon.');
    if (!b && isOn) info.problems.push('Diese App bringt den Skill nicht mit. Die Kopie im Projekt gilt weiter.');
    return info;
  });
  return out.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title, 'de'));
}

/** Text atomar schreiben: erst eine Nebendatei, dann umbenennen. */
function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.soma-tmp`;
  try {
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* bleibt liegen, stört nicht */ }
    throw e;
  }
}

/**
 * Skill ins Projekt kopieren. Liegt dort schon eine abweichende Fassung (vom Nutzer, vom Agenten oder aus einer älteren
 * App), wandert sie vorher in die Sicherung. Gibt den Pfad der Sicherung zurück, falls es eine gab.
 */
export function copySkill(root: string, bundledDir: string, id: string, backupDir: string): string | null {
  const b = bundledSkills(bundledDir).get(id);
  const abs = resolveInside(root, relOf(id));
  const old = projectCopy(root, id);
  if (!b) {
    // Nicht mitgeliefert: Nur einschalten, was schon im Projekt liegt
    if (old == null) throw new Error(`Den Skill „${id}“ gibt es in dieser App nicht.`);
    return null;
  }
  if (old != null && norm(old) === norm(b.text)) return null;
  const backup = old != null ? backupText(backupDir, relOf(id), old) : null;
  writeAtomic(abs, b.text);
  return backup;
}

/**
 * Kopie aus dem Projekt entfernen. Eine unveränderte Kopie eines mitgelieferten Skills lässt sich jederzeit neu anlegen und
 * wird einfach gelöscht, alles andere kommt vorher in die Sicherung.
 */
export function removeSkill(root: string, bundledDir: string, id: string, backupDir: string): string | null {
  const abs = resolveInside(root, relOf(id));
  const old = projectCopy(root, id);
  if (old == null) { fs.rmSync(abs, { force: true }); return null; }
  const b = bundledSkills(bundledDir).get(id);
  const backup = b && norm(old) === norm(b.text) ? null : backupText(backupDir, relOf(id), old);
  fs.rmSync(abs, { force: true });
  return backup;
}

/** Abschnitt der AGENTS.md mit den aktiven Skills (auf Englisch wie der Rest der Datei). */
export function skillsBlock(entries: { id: string; name: string }[]): string {
  const lines = [BEGIN, '## Skills', ''];
  if (!entries.length) {
    lines.push('No skills are active for this model. The user can switch on rule sets (for example 3D printing) in the app.');
  } else {
    lines.push('The user switched on these rule sets for this model. **Read each file before you change the model and follow it.**',
      'They take precedence over your general habits, but not over explicit wishes of the user. If a rule cannot be met, say so.', '');
    for (const e of entries) lines.push(`- \`${relOf(e.id)}\`: ${e.name}`);
  }
  lines.push(END);
  return lines.join('\n');
}

/**
 * Trägt die aktiven Skills in AGENTS.md ein: zwischen den Markierungen, ohne Markierungen (ältere Projekte) am Ende.
 * Fehlt AGENTS.md, legt die App sie nicht neu an (E28), sondern meldet das. Rückgabe: Warnung oder null.
 */
export function writeAgentsList(root: string, entries: { id: string; name: string }[]): string | null {
  const file = path.join(root, 'AGENTS.md');
  const cur = agentsText(root);
  if (cur == null) return 'AGENTS.md fehlt. Der Skill liegt im Projekt, ein Agent erfährt aber nichts davon.';
  const eol = cur.includes('\r\n') ? '\r\n' : '\n';
  const block = skillsBlock(entries).replace(/\n/g, eol);
  const a = cur.indexOf(BEGIN), z = cur.indexOf(END);
  const next = a >= 0 && z > a
    ? cur.slice(0, a) + block + cur.slice(z + END.length)
    : cur.replace(/\s*$/, '') + eol + eol + block + eol;
  if (next !== cur) writeAtomic(file, next);
  return null;
}

/** Englischer Name eines Skills für AGENTS.md, aus der mitgelieferten Fassung oder der Kopie im Projekt. */
export function skillName(root: string, bundledDir: string, id: string): string {
  const b = bundledSkills(bundledDir).get(id);
  if (b) return b.name;
  const copy = projectCopy(root, id);
  return copy != null ? parseSkill(id, copy).name : id;
}
