import type { SkillInfo, SkillMode, SkillResult, SkillValue, SkillVar } from '../shared/types';
import { icon } from './icons';
import { el, menus } from './ui';

interface Deps {
  list(): Promise<SkillInfo[]>;
  set(id: string, mode: SkillMode): Promise<SkillResult>;
  configure(id: string, values: Record<string, SkillValue | null>): Promise<SkillResult>;
  /** Stufe für neue Modelle (gilt für die App, E46, E55). */
  setDefault(id: string, mode: SkillMode): Promise<SkillResult>;
  /** Kopie im Projekt im Code zeigen (nur lesen). */
  open(file: string): void;
  /** Skill in den Einstellungen bearbeiten (E78). */
  edit(id: string): void;
  /** Text in die Eingabe des Agenten einfügen (E11). */
  insert(text: string): void;
  toast(text: string, kind?: 'ok' | 'info' | 'error'): void;
  /** Dateien im Projekt haben sich geändert (Speicherstand, Dateibaum). */
  changed(): void;
}

interface Ui {
  list: HTMLElement;
  /** Zeile über der Liste: wie viele Skills auf welcher Stufe stehen. */
  sum: HTMLElement;
  /** Karte neben der Liste mit Beschreibung, Stufe und Einstellungen eines Skills. */
  detail: HTMLElement;
  /** Menü für den Stufen-Schalter einer Zeile. */
  menu: HTMLElement;
}

const unitOf = (v: SkillVar) => (v.unit ? (v.unit === '°' ? '°' : ` ${v.unit}`) : '');
/** Wert für die Oberfläche: Zahl mit Einheit, bei einer Auswahl der angezeigte Name. */
const shown = (v: SkillVar, x: SkillValue = v.value) => (typeof x === 'number'
  ? `${x.toLocaleString('en-US', { maximumFractionDigits: 6, useGrouping: false })}${unitOf(v)}` : v.options?.find((o) => o.value === x)?.label ?? String(x));
/** Für den Agenten: Zahlen mit Punkt. */
const forAgent = (v: SkillVar) => (typeof v.value === 'number' ? `${String(v.value)}${unitOf(v)}` : shown(v));
const changedVars = (s: SkillInfo) => s.vars.filter((v) => v.value !== v.default);

/** Die drei Stufen (E55), benannt nach dem, was der Agent tut. */
const MODES: { mode: SkillMode; label: string; title: string }[] = [
  { mode: 'off', label: 'Off', title: 'The agent does not see this skill.' },
  { mode: 'demand', label: 'On demand', title: 'The agent reads it when the conversation turns to the topic.' },
  { mode: 'always', label: 'Always', title: 'The agent follows it with every change.' },
];
const modeOf = (m: SkillMode) => MODES.find((x) => x.mode === m)!;
/** Symbol vor der Überschrift einer Kategorie: Die Liste ist lang, so findet man die Gruppen schneller. */
export const CATEGORY_ICON: Record<string, string> = {
  'Way of working': 'route', Manufacturing: 'wrench', 'Design knowledge': 'compass', 'Check and present': 'gauge',
  // Kategorien älterer Skill-Köpfe (vor E73)
  Arbeitsweise: 'route', Fertigungsverfahren: 'wrench', Konstruktionswissen: 'compass', 'Prüfen und Zeigen': 'gauge',
};
const labelOf = (m: SkillMode) => modeOf(m).label;
/** Zusatz zur Kategorie in der Karte: eigene und bearbeitete Skills (E78). */
const SOURCE_NOTE: Record<string, string> = { edited: ' · edited by you', own: ' · your own skill' };

/** Text für die Eingabe des Agenten: Pfad und die vom Standard abweichenden Einstellungen. */
export function skillNote(s: SkillInfo): string {
  const set = changedVars(s);
  return `[Skill: ${s.file}${set.length ? `, settings: ${set.map((v) => `${v.label} = ${forAgent(v)}`).join(', ')}` : ''}] `;
}

/**
 * Seitenleiste „Skills“ (E17, Entwurf 2): eine Zeile je Skill mit der Stufe als kleinem Schalter (E55). Ein Klick auf die
 * Zeile öffnet daneben eine Karte mit Beschreibung, Stufe, Einstellungen und Aktionen. Orange steht nur für „Immer“.
 * Das Umstellen erledigt der Hauptprozess (Kopie in .soma/skills/, project.json, AGENTS.md), hier wird nur gezeigt, was er meldet.
 */
export class SkillsPanel {
  private skills: SkillInfo[] = [];
  private error = '';
  private busy = new Set<string>();
  private loaded = false;
  /** Skill, dessen Karte offen ist. */
  private openId: string | null = null;

  constructor(private ui: Ui, private deps: Deps) {
    ui.detail.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !(e.target as HTMLElement).closest('input, select')) { e.stopPropagation(); this.closeDetail(); }
    });
  }

  async refresh(): Promise<void> {
    try { this.skills = await this.deps.list(); this.error = ''; } catch (e) { this.error = e instanceof Error ? e.message : String(e); }
    this.loaded = true;
    this.render();
  }

  /** Neues Modell: alte Liste weg, beim nächsten Öffnen neu laden. */
  reset(): void { this.skills = []; this.openId = null; this.loaded = false; this.render(); }

  get isLoaded(): boolean { return this.loaded; }

  /** Karte eines Skills öffnen (null: schließen). */
  openDetail(id: string | null): void { this.openId = id; this.render(); }
  closeDetail(): void { if (this.openId) this.openDetail(null); }

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
    if (!r.ok) { this.deps.toast(`“${s.title}” could not be set to “${labelOf(mode)}”: ${r.error ?? 'unknown error'}`, 'error'); return; }
    const kept = r.backup ? ' The previous version in the project is in the backup.' : '';
    if (r.warning) { this.deps.toast(`“${s.title}” is set to “${labelOf(mode)}”. ${r.warning}${kept}`, 'error'); return; }
    // Ein laufender Agent liest AGENTS.md nicht von selbst neu
    this.deps.toast(mode === 'always'
      ? `“${s.title}” now always applies and is listed in AGENTS.md. “Send to agent” tells a running agent.${kept}`
      : mode === 'demand'
        ? (was === 'always'
          ? `“${s.title}” now only applies on demand. A running agent may keep following it: tell it.${kept}`
          : `“${s.title}” is available to the agent on demand (AGENTS.md). A running agent only learns about it after a restart.${kept}`)
        : `“${s.title}” is off. A running agent may still know the rules: tell it or restart it.${kept}`);
  }

  private render(): void {
    const { list, sum } = this.ui;
    if (this.error) { list.replaceChildren(el('div', { className: 'hint', textContent: `Skills not readable: ${this.error}` })); sum.textContent = ''; this.renderDetail(); return; }
    if (!this.skills.length) {
      list.replaceChildren(el('div', { className: 'hint', textContent: this.loaded ? 'This app comes without skills.' : 'Loading …' }));
      sum.textContent = '';
      this.renderDetail();
      return;
    }
    const count = (m: SkillMode) => this.skills.filter((s) => s.mode === m).length;
    sum.textContent = `Rules for the agent, per model · ${count('always')} always, ${count('demand')} on demand, ${count('off')} off`;
    // Der Hauptprozess liefert die Skills nach Kategorien sortiert: Überschrift, wo eine neue beginnt
    const out: HTMLElement[] = [];
    let cat: string | null = null;
    for (const s of this.skills) {
      const c = s.category || 'Other';
      if (c !== cat) {
        const h = el('div', { className: 'sk-cat' }, icon(CATEGORY_ICON[c] ?? 'book', 14, 1.9), el('span', { textContent: c }));
        h.setAttribute('role', 'heading');
        h.setAttribute('aria-level', '3');
        out.push(h);
        cat = c;
      }
      out.push(this.row(s));
    }
    list.replaceChildren(...out);
    this.renderDetail();
  }

  /** Eine Zeile: Name, darunter die Kurzbeschreibung oder die angepassten Einstellungen, rechts die Stufe. */
  private row(s: SkillInfo): HTMLElement {
    const set = changedVars(s);
    const note = s.problems.length || s.changed
      ? el('span', { className: 'warn', textContent: s.problems[0] ?? 'The copy differs from the current version' })
      : set.length ? el('span', { className: 'cust', textContent: `${set.map((v) => shown(v)).join(' · ')} · customized` })
        : el('span', { textContent: s.summary });
    const open = el('button', { className: 'sk-open', title: `${s.title}: description, level and settings` }, el('b', { textContent: s.title }), note);
    open.addEventListener('click', () => this.openDetail(this.openId === s.id ? null : s.id));
    const row = el('div', { className: `sk-row ${s.mode}${this.openId === s.id ? ' sel' : ''}` }, open, this.levelChip(s));
    row.setAttribute('role', 'listitem');
    row.dataset.id = s.id;
    return row;
  }

  /** Kleiner Schalter mit der Stufe. Klick öffnet ein Menü mit den drei Stufen und was sie bedeuten. */
  private levelChip(s: SkillInfo): HTMLButtonElement {
    const b = el('button', { className: `sk-lvl ${s.mode}`, disabled: this.busy.has(s.id), title: `Level: ${labelOf(s.mode)}. ${modeOf(s.mode).title}` },
      el('span', { className: 'ld' }), el('span', { textContent: labelOf(s.mode) }), icon('down', 12, 2));
    b.setAttribute('aria-haspopup', 'menu');
    b.setAttribute('aria-label', `${s.title}: level ${labelOf(s.mode)}`);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const m = this.ui.menu;
      m.replaceChildren(el('div', { className: 'mh', textContent: s.title.toUpperCase() }), ...MODES.map((x) => {
        const item = el('button', { className: 'mi two', disabled: x.mode !== 'off' && !s.source && !s.file },
          el('span', { className: 'chk' }, icon('check', 15, 2.2)), el('span', { className: 't' }, el('span', { textContent: x.label }), el('span', { className: 'sub', textContent: x.title })));
        item.setAttribute('role', 'menuitemradio');
        item.setAttribute('aria-checked', String(x.mode === s.mode));
        item.dataset.mode = x.mode;
        item.addEventListener('click', () => void this.setMode(s, x.mode));
        return item;
      }));
      menus.toggle(m, b, 'right');
    });
    return b;
  }

  /** Umschalter mit drei Stufen. Ein Skill, den die App nicht mitbringt und der nicht im Projekt liegt, lässt sich nur ausschalten. */
  private modeSwitch(s: SkillInfo): HTMLElement {
    const box = el('div', { className: 'sk-mode' });
    box.setAttribute('role', 'radiogroup');
    box.setAttribute('aria-label', `${s.title}: level`);
    for (const m of MODES) {
      const b = el('button', { textContent: m.label, title: m.title });
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(s.mode === m.mode));
      b.dataset.mode = m.mode;
      b.disabled = this.busy.has(s.id) || (m.mode !== 'off' && !s.source && !s.file);
      b.addEventListener('click', () => void this.setMode(s, m.mode));
      box.append(b);
    }
    return box;
  }

  /** Karte neben der Liste. Bleibt offen, bis sie geschlossen wird (Kreuz, Escape, Zeile noch einmal), auch beim Umstellen. */
  private renderDetail(): void {
    const box = this.ui.detail;
    const s = this.openId ? this.skills.find((x) => x.id === this.openId) : undefined;
    box.hidden = !s;
    if (!s) { box.replaceChildren(); return; }
    box.dataset.id = s.id;
    const close = el('button', { className: 'ibtn s', title: 'Close (Escape)' }, icon('x', 14, 2));
    close.setAttribute('aria-label', 'Close card');
    close.addEventListener('click', () => this.closeDetail());
    const kids: (HTMLElement | null)[] = [
      el('div', { className: 'mc-hd' }, el('span', { className: 'mc-ico sk-ico' }, icon('book', 15)),
        el('div', { className: 'sk-title' }, el('b', { textContent: s.title }), el('span', { className: 'c3', textContent: `${s.category || 'Other'}${SOURCE_NOTE[s.source ?? ''] ?? ''}` })), el('span', { className: 'grow' }), close),
      el('div', { className: 'sk-desc', textContent: s.summary }),
    ];
    if (s.changed) kids.push(el('div', { className: 'sk-note', textContent: 'The copy in the project differs from the current version of the skill (Settings). Switching it off and on again takes over the current version, the previous one goes into the backup.' }));
    for (const p of s.problems) kids.push(el('div', { className: 'sk-warn', textContent: p }));
    kids.push(el('div', { className: 'sk-sec' }, el('div', { className: 'sk-h', textContent: 'For this model' }), this.modeSwitch(s),
      el('div', { className: 'c3 small', textContent: modeOf(s.mode).title })));
    if (s.vars.length) {
      const set = changedVars(s);
      const reset = set.length ? el('button', { className: 'sk-resetall', textContent: 'Reset', title: 'Reset all settings of this skill to the default' }) : null;
      reset?.addEventListener('click', () => void this.resetAll(s));
      kids.push(el('div', { className: 'sk-sec' },
        el('div', { className: 'sk-h' }, el('span', { textContent: 'Settings' }), el('span', { className: 'grow' }), set.length ? el('span', { className: 'sk-hn', textContent: `${set.length} customized · ` }) : null, reset),
        el('div', { className: 'sk-vars' }, ...s.vars.map((v) => this.field(s, v)))));
    }
    if (s.topics.length) kids.push(el('div', { className: 'sk-sec' }, el('div', { className: 'sk-h', textContent: 'What the agent watches for' }), el('ul', { className: 'sk-topics' }, ...s.topics.map((t) => el('li', { textContent: t })))));
    if (s.source) {
      const id = `sk-${s.id}-default`;
      const sel = el('select', { id, className: 'sk-select', disabled: this.busy.has(s.id) }, ...MODES.map((m) => el('option', { value: m.mode, textContent: m.label })));
      sel.value = s.defaultMode;
      sel.addEventListener('change', () => void this.setDefault(s, sel.value as SkillMode));
      kids.push(el('div', { className: 'sk-sec sk-def', title: 'Applies to all models created from now on. This model stays as it is.' },
        el('label', { textContent: 'For new models', htmlFor: id }), sel));
    }
    const actions = el('div', { className: 'sc-actions sk-actions' });
    if (s.file) {
      const view = el('button', { className: 'btn sm', title: 'Show the copy in the project in the code (read only)' }, icon('file', 14, 1.9), 'View file');
      view.addEventListener('click', () => this.deps.open(s.file!));
      actions.append(view);
    }
    if (s.source) {
      const edit = el('button', { className: 'btn sm', title: 'Edit the skill in the settings. Applies to new models, and here once the copy is taken over.' }, icon('pen', 14, 1.9), 'Edit');
      edit.dataset.act = 'edit';
      edit.addEventListener('click', () => this.deps.edit(s.id));
      actions.append(edit);
    }
    if (s.mode !== 'off' && s.file) {
      const send = el('button', { className: 'btn sm acc', title: 'Add the path and customized settings to the agent’s input, so a running agent learns about them' }, icon('send', 14, 1.9), 'Send to agent');
      send.addEventListener('click', () => this.deps.insert(skillNote(s)));
      actions.append(send);
    }
    if (!s.file) kids.push(el('div', { className: 'sk-note', textContent: 'On “On demand” or “Always”, the skill is a Markdown file in the project and can be viewed.' }));
    if (actions.childElementCount) kids.push(actions);
    box.replaceChildren(...kids.filter((x): x is HTMLElement => !!x));
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
    if (!r.ok) { this.deps.toast(r.error ?? 'The default for new models could not be changed.', 'error'); return; }
    this.deps.toast(`“${s.title}” is set to “${labelOf(mode)}” for new models. This model stays as it is.`);
  }

  /** Einstellungen ändern (null: Standard). Der Hauptprozess prüft die Werte und schreibt die Kopie neu, wenn der Skill nicht aus ist. */
  private async configure(s: SkillInfo, values: Record<string, SkillValue | null>, what: (now: SkillInfo) => string): Promise<void> {
    if (this.busy.has(s.id)) return;
    this.busy.add(s.id);
    let r: SkillResult;
    try { r = await this.deps.configure(s.id, values); } catch (e) { r = { ok: false, error: e instanceof Error ? e.message : String(e), skills: this.skills }; }
    this.busy.delete(s.id);
    this.skills = r.skills;
    this.render();
    if (!r.ok) { this.deps.toast(r.error ?? 'The setting could not be changed.', 'error'); return; }
    this.deps.changed();
    const now = r.skills.find((x) => x.id === s.id) ?? s;
    const kept = r.backup ? ' The previous version in the project is in the backup.' : '';
    this.deps.toast(`“${s.title}”: ${what(now)}. `
      + (s.mode !== 'off' ? `Written to ${s.file}. “Send to agent” tells a running agent.${kept}` : 'Applies as soon as the skill is no longer off.'));
  }

  private setVar(s: SkillInfo, v: SkillVar, value: SkillValue | null): Promise<void> {
    return this.configure(s, { [v.name]: value }, (now) => {
      const x = now.vars.find((y) => y.name === v.name) ?? v;
      return `${v.label} ${shown(x)}${value === null ? ' (default)' : ''}`;
    });
  }

  private resetAll(s: SkillInfo): Promise<void> {
    const set = changedVars(s);
    return this.configure(s, Object.fromEntries(set.map((v) => [v.name, null])), () => `${set.map((v) => v.label).join(', ')} reset to the default`);
  }

  /** Eingabe einer Einstellung: Zahlenfeld (Komma oder Punkt, Enter übernimmt, Escape verwirft) oder Auswahl. */
  private field(s: SkillInfo, v: SkillVar): HTMLElement {
    const id = `sk-${s.id}-${v.name}`;
    let input: HTMLInputElement | HTMLSelectElement;
    if (v.kind === 'choice') {
      const sel = el('select', { id, className: 'sk-select' }, ...(v.options ?? []).map((o) => el('option', { value: o.value, textContent: o.label })));
      sel.value = String(v.value);
      sel.addEventListener('change', () => void this.setVar(s, v, sel.value));
      input = sel;
    } else {
      const shownNum = typeof v.value === 'number' ? v.value.toLocaleString('en-US', { maximumFractionDigits: 6, useGrouping: false }) : String(v.value);
      const inp = el('input', { id, className: 'sk-num', type: 'text', value: shownNum, spellcheck: false, autocomplete: 'off' });
      inp.inputMode = 'decimal';
      inp.title = v.min != null && v.max != null ? `Allowed ${shown(v, v.min)} to ${shown(v, v.max)}` : '';
      inp.addEventListener('change', () => { if (inp.value.trim() !== shownNum) void this.setVar(s, v, inp.value); });
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); inp.blur(); if (inp.value.trim() !== shownNum) void this.setVar(s, v, inp.value); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); inp.value = shownNum; inp.blur(); }
      });
      input = inp;
    }
    input.disabled = this.busy.has(s.id);
    const label = el('label', { textContent: v.label, htmlFor: id });
    const isDefault = v.value === v.default;
    const reset = el('button', { className: 'sk-reset', title: `Reset to the default (${shown(v, v.default)})` }, icon('undo', 13, 2));
    reset.setAttribute('aria-label', `Reset ${v.label} to the default`);
    reset.hidden = isDefault;
    reset.addEventListener('click', () => void this.setVar(s, v, null));
    const row = el('div', { className: 'sk-var' + (isDefault ? '' : ' set') }, label, el('span', { className: 'sk-in' }, input, el('span', { className: 'c3', textContent: v.unit })), reset);
    row.dataset.var = v.name;
    return row;
  }

  /** Für Tests. */
  state() {
    return {
      skills: this.skills.map((s) => ({ id: s.id, title: s.title, summary: s.summary, category: s.category, source: s.source, defaultMode: s.defaultMode, mode: s.mode, file: s.file, changed: s.changed, problems: s.problems,
        vars: Object.fromEntries(s.vars.map((v) => [v.name, v.value])) })),
      busy: [...this.busy], text: this.ui.list.innerText, detail: this.ui.detail.hidden ? null : this.ui.detail.innerText, open: this.openId,
    };
  }
}
