import fs from 'node:fs';
import path from 'node:path';
import type { SkillInfo, SkillMode, SkillValue, SkillVar } from '../shared/types';
import { backupText, resolveInside } from './files';

/**
 * Skills (E17): Regelwerke als Markdown, die die App mitliefert (`resources/skills/`). Je Modell hat ein Skill eine Stufe
 * (E55): Aus, Bei Bedarf oder Immer. Eingeschaltet (Bei Bedarf oder Immer) liegt er als `.soma/skills/<id>.md` im Projekt,
 * steht in `project.json` und in einem eigenen Abschnitt der `AGENTS.md`. So wandert er mit ZIP und Git und gilt für jeden
 * Agenten. „Immer“ befolgt der Agent bei jeder Änderung, „Bei Bedarf“ nennt `AGENTS.md` mit Anlass, und der Agent liest
 * ihn, wenn das Gespräch auf das Thema kommt (etwa „jetzt für den 3D-Druck“), ohne dass der Nutzer erst umstellen muss.
 *
 * Einstellungen: Ein Skill kann im Kopf Variablen erklären (`var overhang: 45 | ° | Max. Überhang | 20..80`) und im Text
 * Platzhalter verwenden (`{{overhang}}`). Der Nutzer stellt die Werte im Panel ein, sie stehen in `project.json`
 * (`skill_settings`). Die Kopie im Projekt enthält die eingesetzten Werte: Der Agent liest konkrete Zahlen.
 * Die Kopie bleibt, wie sie ist, auch wenn eine neuere App eine neuere Fassung mitbringt.
 *
 * Kategorien und Standard (E46): `category` ordnet den Skill im Panel unter eine Überschrift, `default:` gibt die Stufe bei
 * neuen Modellen vor (`always`, `on-demand` oder `off`, ohne Angabe Bei Bedarf). Der Nutzer kann das je Skill für die ganze
 * App umstellen (`skill_defaults` in state.json).
 */

/** Kennung = Dateiname ohne .md. Nur Kleinbuchstaben, Ziffern und Bindestrich: Sie landet in Pfaden und in AGENTS.md. */
const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const isSkillId = (id: unknown): id is string => typeof id === 'string' && ID.test(id);
export const isSkillMode = (m: unknown): m is SkillMode => m === 'off' || m === 'demand' || m === 'always';
export const SKILLS_DIR = '.soma/skills';
const BEGIN = '<!-- soma:skills -->';
const END = '<!-- /soma:skills -->';
/** Überschrift der Liste „Bei Bedarf“ in AGENTS.md, trennt sie von „Immer“. */
const DEMAND_HEAD = '### Read when relevant';
const MAX_BYTES = 256 * 1024;
const VAR_LINE = /^var\s+([a-z][a-z0-9_]{0,30}):\s*(.*)$/;
const PLACEHOLDER = /\{\{\s*([a-z][a-z0-9_]{0,30})\s*\}\}/g;

/** Stufen, in denen ein Skill im Projekt liegt. */
export type OnMode = Exclude<SkillMode, 'off'>;
const ON_MODES: OnMode[] = ['always', 'demand'];
const MODE_LABEL: Record<SkillMode, string> = { off: 'Aus', demand: 'Bei Bedarf', always: 'Immer' };

/**
 * Stufen eines Modells laut project.json: `skills` (Immer, so hieß die Liste schon vor E55) und `skills_on_demand`
 * (Bei Bedarf). Was in keiner Liste steht, ist aus. Explizit statt „alles Übrige Bei Bedarf“: project.json beschreibt so
 * genau, was im Projekt liegt, und ein Skill einer neueren App ändert ein Modell nicht still.
 */
export interface SkillModes { always: string[]; demand: string[] }
export const modeOf = (modes: SkillModes, id: string): SkillMode =>
  (modes.always.includes(id) ? 'always' : modes.demand.includes(id) ? 'demand' : 'off');

/** Stufe setzen: aus beiden Listen nehmen und an die passende anhängen. */
export function withMode(modes: SkillModes, id: string, mode: SkillMode): SkillModes {
  const always = modes.always.filter((x) => x !== id);
  const demand = modes.demand.filter((x) => x !== id);
  if (mode === 'always') always.push(id); else if (mode === 'demand') demand.push(id);
  return { always, demand };
}

/** Stufe aus dem Kopf (`default:`). Ohne Angabe Bei Bedarf: Verfügbar ist jeder Skill, den niemand ausschaltet (E55). */
export function parseMode(s: string | undefined): SkillMode {
  const v = (s ?? '').trim().toLowerCase();
  if (/^(always|immer|on|an|yes|ja|true)$/.test(v)) return 'always';
  if (/^(off|aus|no|nein|false)$/.test(v)) return 'off';
  return 'demand';
}

/** Eingestellte Werte eines Skills, nur die vom Standard abweichenden. */
export type SkillValues = Record<string, SkillValue>;
/** Kopf einer Variablen ohne aktuellen Wert. */
type VarDef = Omit<SkillVar, 'value'>;
interface Parsed {
  id: string; title: string; name: string; summary: string; order: number; topics: string[]; vars: VarDef[]; text: string;
  /** Anlass für AGENTS.md (englisch, ein Nebensatz nach „Read when“), leer: nur der Name. */
  when: string;
  /** Überschrift im Panel (deutsch), leer: „Weitere“. */
  category: string;
  /** Stufe bei neuen Modellen, solange der Nutzer in der App nichts anderes festlegt (E46, E55). */
  defaultMode: SkillMode;
}

/** Zeilenenden vereinheitlichen: Eine Kopie mit CRLF (etwa nach einem Git-Checkout) gilt nicht als geändert. */
const norm = (t: string) => t.replace(/\r\n?/g, '\n');
const FRONT = /^---\n([\s\S]*?)\n---\n?/;

/**
 * Variable aus dem Kopf: `Standard | Einheit | Bezeichnung | Bereich oder Auswahl`. Ein Bereich `20..80` macht eine Zahl,
 * eine Liste `PLA, PETG` eine Auswahl, Einträge mit `wert=Anzeige` zeigen in der Oberfläche einen deutschen Namen.
 */
function parseVar(name: string, spec: string): VarDef | null {
  const [def = '', unit = '', label = '', rule = ''] = spec.split('|').map((x) => x.trim());
  if (!def) return null;
  const range = /^(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)$/.exec(rule);
  if (rule.includes(',') || (!range && !Number.isFinite(Number(def)))) {
    const options = (rule ? rule.split(',') : [def]).map((o) => o.trim()).filter(Boolean).map((o) => {
      const [value, shown] = o.split('=').map((x) => x.trim());
      return { value, label: shown || value };
    });
    if (!options.some((o) => o.value === def)) options.unshift({ value: def, label: def });
    return { name, label: label || name, unit, kind: 'choice', default: def, options };
  }
  const d = Number(def);
  if (!Number.isFinite(d)) return null;
  return { name, label: label || name, unit, kind: 'number', default: d, ...(range ? { min: Number(range[1]), max: Number(range[2]) } : {}) };
}

/**
 * Liest Kopf und Inhalt. Der Kopf steht zwischen zwei `---`-Zeilen als `schlüssel: wert` (title, summary und topics für
 * die Oberfläche auf Deutsch, name und when auf Englisch für AGENTS.md, var für Einstellungen). Fehlt er, gilt die erste
 * Überschrift als Titel.
 */
export function parseSkill(id: string, raw: string): Parsed {
  const text = norm(raw);
  const meta: Record<string, string> = {};
  const vars: VarDef[] = [];
  let body = text;
  const m = FRONT.exec(text);
  if (m) {
    for (const line of m[1].split('\n')) {
      const v = VAR_LINE.exec(line.trim());
      if (v) { const d = parseVar(v[1], v[2]); if (d && !vars.some((x) => x.name === d.name)) vars.push(d); continue; }
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
    id, text: raw, vars,
    title: meta.title || heading || id,
    name: meta.name || heading || meta.title || id,
    summary: meta.summary ?? '',
    order: Number(meta.order) || 100,
    topics,
    when: (meta.when ?? '').replace(/[.\s]+$/, ''),
    category: meta.category ?? '',
    defaultMode: parseMode(meta.default),
  };
}

/**
 * Reihenfolge im Panel: nach Kategorien (eine Kategorie steht dort, wo ihr erster Skill laut `order` steht, ohne Kategorie
 * am Ende), darin nach `order` und Titel. So bleibt eine Kategorie beisammen, auch wenn die Nummern sich überschneiden.
 */
function sortSkills<T extends { category: string; order: number; title: string }>(list: T[]): T[] {
  const first = new Map<string, number>();
  for (const s of list) if (s.category) first.set(s.category, Math.min(first.get(s.category) ?? Infinity, s.order));
  const rank = (s: T) => (s.category ? first.get(s.category)! : Infinity);
  return [...list].sort((a, b) => rank(a) - rank(b) || a.category.localeCompare(b.category, 'de') || a.order - b.order || a.title.localeCompare(b.title, 'de'));
}

/** Zahl für den Agenten: Punkt als Dezimalzeichen, ohne Rundungsreste. */
const agentNum = (v: number) => String(+v.toFixed(6));
const showNum = (v: number) => v.toLocaleString('de-DE', { maximumFractionDigits: 6 });

/**
 * Prüft einen Wert gegen seine Variable. Zahlen dürfen als Text mit Komma kommen. Rückgabe: der saubere Wert oder ein
 * Fehlertext für die Oberfläche.
 */
export function checkValue(v: VarDef, input: unknown): { value: SkillValue } | { error: string } {
  if (v.kind === 'choice') {
    const s = typeof input === 'string' ? input.trim() : '';
    return v.options!.some((o) => o.value === s) ? { value: s } : { error: `${v.label}: „${String(input)}“ steht nicht zur Auswahl.` };
  }
  const n = typeof input === 'number' ? input : typeof input === 'string' ? Number(input.trim().replace('−', '-').replace(',', '.')) : NaN;
  if (typeof input === 'string' && !input.trim()) return { error: `${v.label}: Bitte eine Zahl eingeben.` };
  if (!Number.isFinite(n)) return { error: `${v.label}: „${String(input)}“ ist keine Zahl.` };
  const unit = v.unit ? (v.unit === '°' ? '°' : ` ${v.unit}`) : '';
  if ((v.min != null && n < v.min) || (v.max != null && n > v.max)) {
    return { error: `${v.label}: erlaubt sind ${showNum(v.min ?? -Infinity)} bis ${showNum(v.max ?? Infinity)}${unit}.` };
  }
  return { value: +n.toFixed(6) };
}

/** Gespeicherte Werte (aus project.json, nicht vertrauenswürdig) auf gültige, vom Standard abweichende beschränken. */
export function cleanValues(vars: VarDef[], stored: unknown): SkillValues {
  const out: SkillValues = {};
  if (!stored || typeof stored !== 'object') return out;
  for (const v of vars) {
    const raw = (stored as Record<string, unknown>)[v.name];
    if (raw === undefined) continue;
    const r = checkValue(v, raw);
    if ('value' in r && r.value !== v.default) out[v.name] = r.value;
  }
  return out;
}

const effective = (vars: VarDef[], values: SkillValues): Record<string, SkillValue> =>
  Object.fromEntries(vars.map((v) => [v.name, values[v.name] ?? v.default]));

/**
 * Hinweis in der Kopie eines Skills „Bei Bedarf“ (E55). Er steht in der Datei selbst, weil der Agent sie genau dann liest,
 * wenn er sich für den Skill entscheidet. Die Werte darin hat der Nutzer meist nicht gewählt (Standardwerte der App, etwa
 * Bauraum und Material): Der Agent soll sie nennen oder nachfragen, statt sie still als Vorgabe zu nehmen. Und er soll
 * festhalten, dass er dem Skill folgt, sonst weiß eine spätere Sitzung nichts davon.
 */
function demandNote(vars: VarDef[], values: SkillValues): string {
  const set = vars.filter((v) => v.name in values && values[v.name] !== v.default).map((v) => `\`${v.name}\``);
  const lines = [
    '> **On demand:** the user has not switched this rule set on for every change. Follow it while the conversation is',
    '> about its topic, and add one line to `NOTES.md` under `## Requirements` that names this file, so that a later',
    '> session follows it too.',
  ];
  if (vars.length) {
    lines.push(set.length
      ? `> The user set ${set.join(', ')} in the app. The other values in this file are defaults of the app, the user has not`
      : '> The values in this file are defaults of the app, the user has not',
    '> chosen them: say which ones you rely on, or ask when one matters.');
  }
  lines.push('> In the app, the user can switch this skill to "Immer" (always) and change its settings.');
  return lines.join('\n');
}

/** Hinweis unter die erste Überschrift setzen, mit genau einer Leerzeile davor und danach (sonst liefe der Text ins Zitat). */
function afterHeading(body: string, note: string): string {
  const h = /^#\s+.*$/m.exec(body);
  if (!h) return `${note}\n\n${body.replace(/^\n+/, '')}`;
  const at = h.index + h[0].length;
  return `${body.slice(0, at)}\n\n${note}${body.slice(at).replace(/^\n*/, '\n\n')}`;
}

/**
 * Skill mit eingesetzten Werten, so wie er ins Projekt kommt: Platzhalter im Text ersetzt, im Kopf stehen die Werte statt
 * der Standardwerte (die Kopie ist in sich stimmig, auch für einen Agenten, der den Kopf liest). Bei Bedarf mit Hinweis.
 */
export function renderSkill(raw: string, values: SkillValues, mode: OnMode = 'always'): string {
  const text = norm(raw);
  const p = parseSkill('', text);
  const map = effective(p.vars, values);
  const put = (s: string) => s.replace(PLACEHOLDER, (all, name: string) => (name in map ? (typeof map[name] === 'number' ? agentNum(map[name] as number) : String(map[name])) : all));
  const m = FRONT.exec(text);
  const head = m ? m[0].replace(/^(var\s+([a-z][a-z0-9_]*):\s*)([^|\n]*)/gm, (all, pre: string, name: string, cur: string) => {
    if (!(name in map)) return all;
    const v = map[name];
    return pre + cur.replace(cur.trim(), typeof v === 'number' ? agentNum(v) : v);
  }) : '';
  const body = put(m ? text.slice(m[0].length) : text);
  return put(head) + (mode === 'demand' ? afterHeading(body, demandNote(p.vars, values)) : body);
}

/** Text der Oberfläche (Kurzbeschreibung, Themen) mit eingesetzten Werten, Zahlen mit Komma. */
function showText(s: string, vars: VarDef[], values: SkillValues): string {
  const map = effective(vars, values);
  return s.replace(PLACEHOLDER, (all, name: string) => {
    const v = vars.find((x) => x.name === name);
    if (!v) return all;
    const val = map[name];
    return typeof val === 'number' ? showNum(val) : v.options?.find((o) => o.value === val)?.label ?? String(val);
  });
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

export const bundledSkill = (dir: string, id: string): Parsed | undefined => bundledSkills(dir).get(id);

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

/** Die beiden Listen in AGENTS.md: „Immer“ vor der Überschrift „Read when relevant“, „Bei Bedarf“ danach. */
function agentsSections(text: string): Record<OnMode, string> {
  const list = agentsList(text);
  const i = list.indexOf(DEMAND_HEAD);
  return i >= 0 ? { always: list.slice(0, i), demand: list.slice(i) } : { always: list, demand: '' };
}

/**
 * Alle Skills für die Oberfläche: die mitgelieferten und solche, die nur im Projekt liegen (etwa aus einer neueren App).
 * `modes` und `settings` stammen aus project.json (modes null: unlesbar). Auffälligkeiten werden gemeldet, nicht behoben (E28).
 */
export function listSkills(root: string, bundledDir: string, modes: SkillModes | null, settings: unknown, defaults: SkillDefaults = {}): SkillInfo[] {
  const bundled = bundledSkills(bundledDir);
  const known: SkillModes = { always: (modes?.always ?? []).filter(isSkillId), demand: (modes?.demand ?? []).filter(isSkillId) };
  let files: string[] = [];
  try { files = fs.readdirSync(path.join(root, SKILLS_DIR)).filter((n) => /\.md$/i.test(n)).map((n) => n.replace(/\.md$/i, '')).filter(isSkillId); } catch { /* noch keiner eingeschaltet */ }
  const raw = agentsText(root);
  const agents = raw == null ? null : agentsSections(raw);
  const ids = [...new Set([...bundled.keys(), ...known.always, ...known.demand, ...files])];
  const out: SkillInfo[] = ids.map((id) => {
    const b = bundled.get(id);
    const copy = projectCopy(root, id);
    const meta = b ?? (copy != null ? parseSkill(id, copy) : null);
    const mode = modeOf(known, id);
    // Einstellen lassen sich nur mitgelieferte Skills: Nur dort gibt es den Text mit Platzhaltern
    const vars = b?.vars ?? [];
    const values = cleanValues(vars, (settings as Record<string, unknown> | null)?.[id]);
    // Abweichung gegenüber der Fassung der eingestellten Stufe. Bei „Aus“ zählt jede Fassung der App als unverändert.
    const rendered = (m: OnMode) => (b && copy != null ? norm(copy) === renderSkill(b.text, values, m) : false);
    const info: SkillInfo = {
      id, title: meta?.title ?? id, summary: showText(meta?.summary ?? '', vars, values), topics: (meta?.topics ?? []).map((x) => showText(x, vars, values)),
      order: meta?.order ?? 100, category: meta?.category ?? '', bundled: !!b, mode, file: copy != null ? relOf(id) : null,
      // Für neue Modelle gibt es nur, was die App mitbringt
      defaultMode: b ? (defaults[id] ?? b.defaultMode) : 'off',
      changed: !!b && copy != null && !(mode === 'off' ? ON_MODES.some(rendered) : rendered(mode)),
      vars: vars.map((v) => ({ ...v, value: values[v.name] ?? v.default })),
      problems: [],
    };
    const rel = relOf(id);
    if (mode !== 'off' && copy == null) info.problems.push(`Steht auf „${MODE_LABEL[mode]}“, aber ${rel} fehlt oder ist unlesbar. Der Agent findet die Regeln nicht.`);
    if (mode === 'off' && copy != null) info.problems.push(`Aus, aber ${rel} liegt noch im Projekt.`);
    if (mode !== 'off' && agents != null && !agents[mode].includes(rel)) {
      const other: OnMode = mode === 'always' ? 'demand' : 'always';
      info.problems.push(agents[other].includes(rel)
        ? `AGENTS.md führt diesen Skill unter „${MODE_LABEL[other]}“, eingestellt ist „${MODE_LABEL[mode]}“.`
        : 'AGENTS.md nennt diesen Skill nicht. Ein Agent erfährt nichts davon.');
    }
    if (!b && mode !== 'off') info.problems.push('Diese App bringt den Skill nicht mit. Die Kopie im Projekt gilt weiter.');
    return info;
  });
  return sortSkills(out);
}

/** Vom Nutzer festgelegte Stufen für neue Modelle (nur Abweichungen vom Kopf der Skills). */
export type SkillDefaults = Record<string, SkillMode>;

/** Stufen für ein neues Modell: die mitgelieferten Skills nach Vorgabe des Nutzers oder Kopf (`default:`), in Panel-Reihenfolge. */
export function defaultModes(bundledDir: string, defaults: SkillDefaults): SkillModes {
  const out: SkillModes = { always: [], demand: [] };
  for (const s of sortSkills([...bundledSkills(bundledDir).values()])) {
    const m = defaults[s.id] ?? s.defaultMode;
    if (m !== 'off') out[m].push(s.id);
  }
  return out;
}

/**
 * Richtet in einem neuen Projekt die Skills nach den Vorgaben ein: Kopie mit den Standardwerten, Abschnitt in AGENTS.md.
 * Ein Skill, der sich nicht kopieren lässt, bleibt aus (der Rest geht weiter). Rückgabe: die eingerichteten Stufen,
 * project.json trägt der Aufrufer ein.
 */
export function applyDefaultSkills(root: string, bundledDir: string, backupDir: string, defaults: SkillDefaults): SkillModes {
  const want = defaultModes(bundledDir, defaults);
  const done: SkillModes = { always: [], demand: [] };
  for (const mode of ON_MODES) {
    for (const id of want[mode]) {
      try { copySkill(root, bundledDir, id, backupDir, {}, mode); done[mode].push(id); } catch (e) { console.error(`[soma] Skill „${id}“ ließ sich nicht einschalten:`, e); }
    }
  }
  if (done.always.length || done.demand.length) {
    // Scheitert das, meldet die Karte des Skills später „AGENTS.md nennt diesen Skill nicht“. Das Anlegen geht weiter.
    try {
      const warning = writeAgentsList(root, agentsEntries(root, bundledDir, done));
      if (warning) console.error('[soma]', warning);
    } catch (e) { console.error('[soma] AGENTS.md ließ sich nicht schreiben:', e); }
  }
  return done;
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
 * Skill mit den Werten `values` in der Stufe `mode` ins Projekt schreiben. Liegt dort schon eine abweichende Fassung (vom
 * Nutzer, vom Agenten oder aus einer älteren App), wandert sie vorher in die Sicherung. Ausgenommen ist die unveränderte
 * Kopie mit den bisherigen Werten `prev` in einer der beiden Stufen (beim Umstellen einer Einstellung oder der Stufe).
 * Gibt den Pfad der Sicherung zurück, falls es eine gab.
 */
export function copySkill(root: string, bundledDir: string, id: string, backupDir: string, values: SkillValues, mode: OnMode, prev?: SkillValues): string | null {
  const b = bundledSkill(bundledDir, id);
  const abs = resolveInside(root, relOf(id));
  const old = projectCopy(root, id);
  if (!b) {
    // Nicht mitgeliefert: Nur einschalten, was schon im Projekt liegt
    if (old == null) throw new Error(`Den Skill „${id}“ gibt es in dieser App nicht.`);
    return null;
  }
  const next = renderSkill(b.text, values, mode);
  if (old != null && norm(old) === next) return null;
  const pristine = old != null && prev != null && ON_MODES.some((m) => norm(old) === renderSkill(b.text, prev, m));
  const backup = old != null && !pristine ? backupText(backupDir, relOf(id), old) : null;
  writeAtomic(abs, next);
  return backup;
}

/**
 * Kopie aus dem Projekt entfernen. Eine unveränderte Kopie eines mitgelieferten Skills (gleich in welcher Stufe) lässt sich
 * jederzeit neu anlegen und wird einfach gelöscht, alles andere kommt vorher in die Sicherung.
 */
export function removeSkill(root: string, bundledDir: string, id: string, backupDir: string, values: SkillValues): string | null {
  const abs = resolveInside(root, relOf(id));
  const old = projectCopy(root, id);
  if (old == null) { fs.rmSync(abs, { force: true }); return null; }
  const b = bundledSkill(bundledDir, id);
  const backup = b && ON_MODES.some((m) => norm(old) === renderSkill(b.text, values, m)) ? null : backupText(backupDir, relOf(id), old);
  fs.rmSync(abs, { force: true });
  return backup;
}

/** Eintrag in AGENTS.md: Pfad aus der Kennung, englischer Name, bei „Bei Bedarf“ der Anlass. */
export interface AgentsEntry { id: string; name: string; when: string; mode: OnMode }

/**
 * Abschnitt der AGENTS.md mit den eingeschalteten Skills (auf Englisch wie der Rest der Datei): „Immer“ mit der Pflicht,
 * sie vor jeder Änderung zu lesen, „Bei Bedarf“ als Liste mit Anlass. Der Agent muss wissen, dass es sie gibt und wann sie
 * passen, sonst sieht er nie in `.soma/skills/` nach (E55).
 */
export function skillsBlock(entries: AgentsEntry[]): string {
  const always = entries.filter((e) => e.mode === 'always');
  const demand = entries.filter((e) => e.mode === 'demand');
  const lines = [BEGIN, '## Skills', ''];
  if (!entries.length) lines.push('No skills are switched on for this model. The user can switch on rule sets (for example 3D printing) in the app.');
  if (always.length) {
    lines.push('### Always follow', '',
      'The user switched these rule sets on for this model. **Read each file before you change the model and follow it.**',
      'They take precedence over your general habits, but not over explicit wishes of the user. If a rule cannot be met, say so.', '');
    for (const e of always) lines.push(`- \`${relOf(e.id)}\`: ${e.name}`);
    if (demand.length) lines.push('');
  }
  if (demand.length) {
    lines.push(DEMAND_HEAD, '',
      'These rule sets are available, but not switched on for every change. **Read one as soon as the conversation turns to',
      'its topic** (for example the user wants the part 3D printed), not all of them up front. Follow it while the topic applies.', '');
    for (const e of demand) lines.push(`- \`${relOf(e.id)}\`: ${e.name}${e.when ? `. Read when ${e.when}.` : ''}`);
  }
  lines.push(END);
  return lines.join('\n');
}

/** Einträge für AGENTS.md: „Immer“ in der Reihenfolge des Einschaltens, „Bei Bedarf“ wie im Panel. */
export function agentsEntries(root: string, bundledDir: string, modes: SkillModes): AgentsEntry[] {
  const bundled = bundledSkills(bundledDir);
  const meta = (id: string) => {
    const b = bundled.get(id);
    if (b) return b;
    const copy = projectCopy(root, id);
    return copy != null ? parseSkill(id, copy) : null;
  };
  const entry = (id: string, mode: OnMode) => {
    const m = meta(id);
    return { id, name: m?.name ?? id, when: m?.when ?? '', mode, category: m?.category ?? '', order: m?.order ?? 100, title: m?.title ?? id };
  };
  const always = modes.always.map((id) => entry(id, 'always'));
  const demand = sortSkills(modes.demand.filter((id) => !modes.always.includes(id)).map((id) => entry(id, 'demand')));
  return [...always, ...demand].map(({ id, name, when, mode }) => ({ id, name, when, mode }));
}

/**
 * Trägt die eingeschalteten Skills in AGENTS.md ein: zwischen den Markierungen, ohne Markierungen (ältere Projekte) am Ende.
 * Fehlt AGENTS.md, legt die App sie nicht neu an (E28), sondern meldet das. Rückgabe: Warnung oder null.
 */
export function writeAgentsList(root: string, entries: AgentsEntry[]): string | null {
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
