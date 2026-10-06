import type { SkillInfo, SkillMode, SkillResult, SkillValue, SkillVar } from '../shared/types';
import { icon } from './icons';
import { el } from './ui';

interface Deps {
  list(): Promise<SkillInfo[]>;
  set(id: string, mode: SkillMode): Promise<SkillResult>;
  configure(id: string, values: Record<string, SkillValue | null>): Promise<SkillResult>;
  /** Stufe für neue Modelle (gilt für die App, E46, E55). */
  setDefault(id: string, mode: SkillMode): Promise<SkillResult>;
  /** Kopie im Projekt im Code-Panel zeigen (nur lesen). */
  open(file: string): void;
  /** Text in die Eingabe des Agenten einfügen (E11). */
  insert(text: string): void;
  toast(text: string, kind?: 'ok' | 'info' | 'error'): void;
  /** Dateien im Projekt haben sich geändert (Speicherstand, Dateibaum). */
  changed(): void;
}

const unitOf = (v: SkillVar) => (v.unit ? (v.unit === '°' ? '°' : ` ${v.unit}`) : '');
/** Wert für die Oberfläche: Zahl mit Komma und Einheit, bei einer Auswahl der deutsche Name. */
const shown = (v: SkillVar, x: SkillValue = v.value) => (typeof x === 'number'
  ? `${x.toLocaleString('de-DE', { maximumFractionDigits: 6 })}${unitOf(v)}` : v.options?.find((o) => o.value === x)?.label ?? String(x));
/** Für den Agenten: Zahlen mit Punkt. */
const forAgent = (v: SkillVar) => (typeof v.value === 'number' ? `${String(v.value)}${unitOf(v)}` : shown(v));
const changedVars = (s: SkillInfo) => s.vars.filter((v) => v.value !== v.default);

/** Die drei Stufen (E55), benannt nach dem, was der Agent tut. */
const MODES: { mode: SkillMode; label: string; title: string }[] = [
  { mode: 'off', label: 'Aus', title: 'Der Agent sieht diesen Skill nicht' },
  { mode: 'demand', label: 'Bei Bedarf', title: 'Der Agent liest ihn, wenn das Gespräch auf das Thema kommt' },
  { mode: 'always', label: 'Immer', title: 'Der Agent befolgt ihn bei jeder Änderung' },
];
const labelOf = (m: SkillMode) => MODES.find((x) => x.mode === m)!.label;

/** Text für die Eingabe des Agenten: Pfad und die vom Standard abweichenden Einstellungen. */
export function skillNote(s: SkillInfo): string {
  const set = changedVars(s);
  return `[Skill: ${s.file}${set.length ? `, Einstellungen: ${set.map((v) => `${v.label} = ${forAgent(v)}`).join(', ')}` : ''}] `;
}

/**
 * Seitenpanel „Skills“ (E17): mitgelieferte Regelwerke mit einer Stufe je Modell (E55). Das Umstellen erledigt der
 * Hauptprozess (Kopie in .soma/skills/, project.json, AGENTS.md). Das Panel zeigt nur, was er meldet.
 */
export class SkillsPanel {
  private skills: SkillInfo[] = [];
  private error = '';
  private busy = new Set<string>();
  private expanded = new Set<string>();
  private loaded = false;

  constructor(private list: HTMLElement, private deps: Deps) {}

  async refresh(): Promise<void> {
    try { this.skills = await this.deps.list(); this.error = ''; } catch (e) { this.error = e instanceof Error ? e.message : String(e); }
    this.loaded = true;
    this.render();
  }

  /** Neues Modell: alte Liste weg, beim nächsten Öffnen neu laden. */
  reset(): void { this.skills = []; this.expanded.clear(); this.loaded = false; this.render(); }

  get isLoaded(): boolean { return this.loaded; }

  private async setMode(s: SkillInfo, mode: SkillMode): Promise<void> {
    if (this.busy.has(s.id) || mode === s.mode) return;
    const was = s.mode;
    this.busy.add(s.id);
    this.render();
    let r: SkillResult;
    try { r = await this.deps.set(s.id, mode); } catch (e) { r = { ok: false, error: e instanceof Error ? e.message : String(e), skills: this.skills }; }
    this.busy.delete(s.id);
    this.skills = r.skills;
    this.render();
    this.deps.changed();
    if (!r.ok) { this.deps.toast(`„${s.title}“ ließ sich nicht auf „${labelOf(mode)}“ stellen: ${r.error ?? 'unbekannter Fehler'}`, 'error'); return; }
    const kept = r.backup ? ' Die vorige Fassung im Projekt liegt in der Sicherung.' : '';
    if (r.warning) { this.deps.toast(`„${s.title}“ steht auf „${labelOf(mode)}“. ${r.warning}${kept}`, 'error'); return; }
    // Ein laufender Agent liest AGENTS.md nicht von selbst neu
    this.deps.toast(mode === 'always'
      ? `„${s.title}“ gilt jetzt immer und steht in AGENTS.md. Einem laufenden Agenten sagt „An Agent geben“ Bescheid.${kept}`
      : mode === 'demand'
        ? (was === 'always'
          ? `„${s.title}“ gilt nur noch bei Bedarf. Ein laufender Agent folgt ihm vielleicht weiter: Sag ihm Bescheid.${kept}`
          : `„${s.title}“ steht dem Agenten bei Bedarf zur Verfügung (AGENTS.md). Ein laufender Agent erfährt davon erst nach einem Neustart.${kept}`)
        : `„${s.title}“ ist aus. Ein laufender Agent kennt die Regeln vielleicht noch: Sag ihm Bescheid oder starte ihn neu.${kept}`);
  }

  private render(): void {
    if (this.error) { this.list.replaceChildren(el('div', { className: 'hint', textContent: `Skills nicht lesbar: ${this.error}` })); return; }
    if (!this.skills.length) { this.list.replaceChildren(el('div', { className: 'hint', textContent: this.loaded ? 'Diese App bringt keine Skills mit.' : 'Lädt …' })); return; }
    // Der Hauptprozess liefert die Skills nach Kategorien sortiert: Überschrift, wo eine neue beginnt
    const out: HTMLElement[] = [];
    let cat: string | null = null;
    for (const s of this.skills) {
      const c = s.category || 'Weitere';
      if (c !== cat) {
        const h = el('div', { className: 'sk-cat', textContent: c });
        h.setAttribute('role', 'heading');
        h.setAttribute('aria-level', '3');
        out.push(h);
        cat = c;
      }
      out.push(this.row(s));
    }
    this.list.replaceChildren(...out);
  }

  /** Stufe für neue Modelle festlegen. Am offenen Modell ändert sich nichts. */
  private async setDefault(s: SkillInfo, mode: SkillMode): Promise<void> {
    if (this.busy.has(s.id)) return;
    this.busy.add(s.id);
    this.render();
    let r: SkillResult;
    try { r = await this.deps.setDefault(s.id, mode); } catch (e) { r = { ok: false, error: e instanceof Error ? e.message : String(e), skills: this.skills }; }
    this.busy.delete(s.id);
    this.skills = r.skills;
    this.render();
    if (!r.ok) { this.deps.toast(r.error ?? 'Die Vorgabe für neue Modelle ließ sich nicht ändern.', 'error'); return; }
    this.deps.toast(`„${s.title}“ steht bei neuen Modellen auf „${labelOf(mode)}“. Dieses Modell bleibt, wie es ist.`);
  }

  /** Umschalter mit drei Stufen. Ein Skill, den die App nicht mitbringt und der nicht im Projekt liegt, lässt sich nur ausschalten. */
  private modeSwitch(s: SkillInfo): HTMLElement {
    const box = el('div', { className: 'sk-mode' });
    box.setAttribute('role', 'radiogroup');
    box.setAttribute('aria-label', `${s.title}: Stufe`);
    for (const m of MODES) {
      const b = el('button', { textContent: m.label, title: m.title });
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(s.mode === m.mode));
      b.dataset.mode = m.mode;
      b.disabled = this.busy.has(s.id) || (m.mode !== 'off' && !s.bundled && !s.file);
      b.addEventListener('click', () => void this.setMode(s, m.mode));
      box.append(b);
    }
    return box;
  }

  private row(s: SkillInfo): HTMLElement {
    const open = this.expanded.has(s.id);
    const more = el('button', { className: 'sk-more' + (open ? ' open' : ''), title: open ? 'Weniger zeigen' : 'Inhalt und Aktionen' }, icon('down', 15, 2));
    more.setAttribute('aria-expanded', String(open));
    more.setAttribute('aria-label', `${s.title}: ${open ? 'weniger zeigen' : 'Inhalt zeigen'}`);
    more.addEventListener('click', () => { if (open) this.expanded.delete(s.id); else this.expanded.add(s.id); this.render(); });
    // Die Vorgabe für neue Modelle nur nennen, wenn sie vom Üblichen (Bei Bedarf) abweicht
    const text = el('div', { className: 'sk-text' }, el('b', { textContent: s.title }), el('span', { textContent: s.summary }),
      s.bundled && s.defaultMode !== 'demand' ? el('span', { className: 'sk-defnote', textContent: `Bei neuen Modellen: ${labelOf(s.defaultMode)}` }) : null);
    const row = el('div', { className: `sk-row ${s.mode}` }, el('div', { className: 'sk-head' }, text, more), this.modeSwitch(s));
    row.setAttribute('role', 'listitem');
    row.dataset.id = s.id;
    const set = changedVars(s);
    if (set.length) row.append(el('div', { className: 'sk-setline', textContent: `Eingestellt: ${set.map((v) => `${v.label} ${shown(v)}`).join(' · ')}` }));
    if (s.changed) row.append(el('div', { className: 'sk-note', textContent: 'Die Kopie im Projekt weicht von der Fassung dieser App ab. Aus- und wieder Einschalten übernimmt die Fassung der App, die bisherige kommt in die Sicherung.' }));
    for (const p of s.problems) row.append(el('div', { className: 'sk-warn', textContent: p }));
    if (open) {
      const body = el('div', { className: 'sk-body' });
      if (s.vars.length) {
        body.append(el('div', { className: 'sk-h', textContent: 'Einstellungen' }), el('div', { className: 'sk-vars' }, ...s.vars.map((v) => this.field(s, v))));
      }
      if (s.topics.length) body.append(el('div', { className: 'sk-h', textContent: 'Darauf achtet der Agent' }), el('ul', {}, ...s.topics.map((t) => el('li', { textContent: t }))));
      if (s.bundled) {
        const id = `sk-${s.id}-default`;
        const sel = el('select', { id, className: 'sk-select', disabled: this.busy.has(s.id) }, ...MODES.map((m) => el('option', { value: m.mode, textContent: m.label })));
        sel.value = s.defaultMode;
        sel.addEventListener('change', () => void this.setDefault(s, sel.value as SkillMode));
        body.append(el('div', { className: 'sk-h', textContent: 'Neue Modelle' }),
          el('div', { className: 'sk-var', title: 'Gilt für alle Modelle, die ab jetzt angelegt werden. Dieses Modell bleibt, wie es ist.' },
            el('label', { textContent: 'Stufe bei neuen Modellen', htmlFor: id }), el('span', { className: 'sk-in' }, sel)));
      }
      const actions = el('div', { className: 'sk-actions' });
      if (s.file) {
        const view = el('button', { className: 'btn sm', title: 'Die Kopie im Projekt im Code-Panel zeigen' }, icon('file', 14, 1.9), 'Ansehen');
        view.addEventListener('click', () => this.deps.open(s.file!));
        actions.append(view);
      }
      if (s.mode !== 'off' && s.file) {
        const send = el('button', { className: 'btn sm acc', title: 'Den Pfad in die Eingabe des Agenten einfügen' }, icon('send', 14, 1.9), 'An Agent geben');
        send.addEventListener('click', () => this.deps.insert(skillNote(s)));
        actions.append(send);
      }
      if (!s.file) body.append(el('div', { className: 'c3', textContent: 'Auf „Bei Bedarf“ oder „Immer“ liegt der Skill als Markdown im Projekt und lässt sich ansehen.' }));
      if (actions.childElementCount) body.append(actions);
      row.append(body);
    }
    return row;
  }

  /** Einstellung ändern (null: Standard). Der Hauptprozess prüft den Wert und schreibt die Kopie neu, wenn der Skill nicht aus ist. */
  private async configure(s: SkillInfo, v: SkillVar, value: SkillValue | null): Promise<void> {
    if (this.busy.has(s.id)) return;
    this.busy.add(s.id);
    let r: SkillResult;
    try { r = await this.deps.configure(s.id, { [v.name]: value }); } catch (e) { r = { ok: false, error: e instanceof Error ? e.message : String(e), skills: this.skills }; }
    this.busy.delete(s.id);
    this.skills = r.skills;
    this.render();
    if (!r.ok) { this.deps.toast(r.error ?? 'Die Einstellung ließ sich nicht ändern.', 'error'); return; }
    this.deps.changed();
    const now = r.skills.find((x) => x.id === s.id)?.vars.find((x) => x.name === v.name) ?? v;
    const kept = r.backup ? ' Die vorige Fassung im Projekt liegt in der Sicherung.' : '';
    this.deps.toast(`„${s.title}“: ${v.label} ${shown(now)}${value === null ? ' (Standard)' : ''}. `
      + (s.mode !== 'off' ? `Steht in ${s.file}. Einem laufenden Agenten sagt „An Agent geben“ Bescheid.${kept}` : 'Gilt, sobald der Skill nicht mehr aus ist.'));
  }

  /** Eingabe einer Einstellung: Zahlenfeld (Komma oder Punkt, Enter übernimmt, Escape verwirft) oder Auswahl. */
  private field(s: SkillInfo, v: SkillVar): HTMLElement {
    const id = `sk-${s.id}-${v.name}`;
    let input: HTMLInputElement | HTMLSelectElement;
    if (v.kind === 'choice') {
      const sel = el('select', { id, className: 'sk-select' }, ...(v.options ?? []).map((o) => el('option', { value: o.value, textContent: o.label })));
      sel.value = String(v.value);
      sel.addEventListener('change', () => void this.configure(s, v, sel.value));
      input = sel;
    } else {
      const shownNum = typeof v.value === 'number' ? v.value.toLocaleString('de-DE', { maximumFractionDigits: 6 }) : String(v.value);
      const inp = el('input', { id, className: 'sk-num', type: 'text', value: shownNum, spellcheck: false, autocomplete: 'off' });
      inp.inputMode = 'decimal';
      inp.title = v.min != null && v.max != null ? `Erlaubt ${shown(v, v.min)} bis ${shown(v, v.max)}` : '';
      inp.addEventListener('change', () => { if (inp.value.trim() !== shownNum) void this.configure(s, v, inp.value); });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); if (inp.value.trim() !== shownNum) void this.configure(s, v, inp.value); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); inp.value = shownNum; inp.blur(); }
      });
      input = inp;
    }
    input.disabled = this.busy.has(s.id);
    const label = el('label', { textContent: v.label, htmlFor: id });
    const isDefault = v.value === v.default;
    const reset = el('button', { className: 'sk-reset', title: `Zurück auf den Standard (${shown(v, v.default)})` }, icon('undo', 13, 2));
    reset.setAttribute('aria-label', `${v.label} zurück auf den Standard`);
    reset.hidden = isDefault;
    reset.addEventListener('click', () => void this.configure(s, v, null));
    const row = el('div', { className: 'sk-var' + (isDefault ? '' : ' set') }, label, el('span', { className: 'sk-in' }, input, el('span', { className: 'c3', textContent: v.unit })), reset);
    row.dataset.var = v.name;
    return row;
  }

  /** Für Tests. */
  state() {
    return {
      skills: this.skills.map((s) => ({ id: s.id, title: s.title, summary: s.summary, category: s.category, defaultMode: s.defaultMode, mode: s.mode, file: s.file, changed: s.changed, problems: s.problems,
        vars: Object.fromEntries(s.vars.map((v) => [v.name, v.value])) })),
      busy: [...this.busy], text: this.list.innerText,
    };
  }
}
