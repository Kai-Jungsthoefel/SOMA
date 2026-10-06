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
/** Wert für die Oberfläche: Zahl mit Komma und Einheit, bei einer Auswahl der deutsche Name. */
const shown = (v: SkillVar, x: SkillValue = v.value) => (typeof x === 'number'
  ? `${x.toLocaleString('de-DE', { maximumFractionDigits: 6 })}${unitOf(v)}` : v.options?.find((o) => o.value === x)?.label ?? String(x));
/** Für den Agenten: Zahlen mit Punkt. */
const forAgent = (v: SkillVar) => (typeof v.value === 'number' ? `${String(v.value)}${unitOf(v)}` : shown(v));
const changedVars = (s: SkillInfo) => s.vars.filter((v) => v.value !== v.default);

/** Die drei Stufen (E55), benannt nach dem, was der Agent tut. */
const MODES: { mode: SkillMode; label: string; title: string }[] = [
  { mode: 'off', label: 'Aus', title: 'Der Agent sieht diesen Skill nicht.' },
  { mode: 'demand', label: 'Bei Bedarf', title: 'Der Agent liest ihn, wenn das Gespräch auf das Thema kommt.' },
  { mode: 'always', label: 'Immer', title: 'Der Agent befolgt ihn bei jeder Änderung.' },
];
const modeOf = (m: SkillMode) => MODES.find((x) => x.mode === m)!;
/** Symbol vor der Überschrift einer Kategorie: Die Liste ist lang, so findet man die Gruppen schneller. */
const CATEGORY_ICON: Record<string, string> = { Arbeitsweise: 'route', Fertigungsverfahren: 'wrench', Konstruktionswissen: 'compass', 'Prüfen und Zeigen': 'gauge' };
const labelOf = (m: SkillMode) => modeOf(m).label;

/** Text für die Eingabe des Agenten: Pfad und die vom Standard abweichenden Einstellungen. */
export function skillNote(s: SkillInfo): string {
  const set = changedVars(s);
  return `[Skill: ${s.file}${set.length ? `, Einstellungen: ${set.map((v) => `${v.label} = ${forAgent(v)}`).join(', ')}` : ''}] `;
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
    const { list, sum } = this.ui;
    if (this.error) { list.replaceChildren(el('div', { className: 'hint', textContent: `Skills nicht lesbar: ${this.error}` })); sum.textContent = ''; this.renderDetail(); return; }
    if (!this.skills.length) {
      list.replaceChildren(el('div', { className: 'hint', textContent: this.loaded ? 'Diese App bringt keine Skills mit.' : 'Lädt …' }));
      sum.textContent = '';
      this.renderDetail();
      return;
    }
    const count = (m: SkillMode) => this.skills.filter((s) => s.mode === m).length;
    sum.textContent = `Regeln für den Agenten, je Modell · ${count('always')} immer, ${count('demand')} bei Bedarf, ${count('off')} aus`;
    // Der Hauptprozess liefert die Skills nach Kategorien sortiert: Überschrift, wo eine neue beginnt
    const out: HTMLElement[] = [];
    let cat: string | null = null;
    for (const s of this.skills) {
      const c = s.category || 'Weitere';
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
      ? el('span', { className: 'warn', textContent: s.problems[0] ?? 'Kopie weicht von der Fassung der App ab' })
      : set.length ? el('span', { className: 'cust', textContent: `${set.map((v) => shown(v)).join(' · ')} · angepasst` })
        : el('span', { textContent: s.summary });
    const open = el('button', { className: 'sk-open', title: `${s.title}: Beschreibung, Stufe und Einstellungen` }, el('b', { textContent: s.title }), note);
    open.addEventListener('click', () => this.openDetail(this.openId === s.id ? null : s.id));
    const row = el('div', { className: `sk-row ${s.mode}${this.openId === s.id ? ' sel' : ''}` }, open, this.levelChip(s));
    row.setAttribute('role', 'listitem');
    row.dataset.id = s.id;
    return row;
  }

  /** Kleiner Schalter mit der Stufe. Klick öffnet ein Menü mit den drei Stufen und was sie bedeuten. */
  private levelChip(s: SkillInfo): HTMLButtonElement {
    const b = el('button', { className: `sk-lvl ${s.mode}`, disabled: this.busy.has(s.id), title: `Stufe: ${labelOf(s.mode)}. ${modeOf(s.mode).title}` },
      el('span', { className: 'ld' }), el('span', { textContent: labelOf(s.mode) }), icon('down', 12, 2));
    b.setAttribute('aria-haspopup', 'menu');
    b.setAttribute('aria-label', `${s.title}: Stufe ${labelOf(s.mode)}`);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const m = this.ui.menu;
      m.replaceChildren(el('div', { className: 'mh', textContent: s.title.toUpperCase() }), ...MODES.map((x) => {
        const item = el('button', { className: 'mi two', disabled: x.mode !== 'off' && !s.bundled && !s.file },
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

  /** Karte neben der Liste. Bleibt offen, bis sie geschlossen wird (Kreuz, Escape, Zeile noch einmal), auch beim Umstellen. */
  private renderDetail(): void {
    const box = this.ui.detail;
    const s = this.openId ? this.skills.find((x) => x.id === this.openId) : undefined;
    box.hidden = !s;
    if (!s) { box.replaceChildren(); return; }
    box.dataset.id = s.id;
    const close = el('button', { className: 'ibtn s', title: 'Schließen (Escape)' }, icon('x', 14, 2));
    close.setAttribute('aria-label', 'Karte schließen');
    close.addEventListener('click', () => this.closeDetail());
    const kids: (HTMLElement | null)[] = [
      el('div', { className: 'mc-hd' }, el('span', { className: 'mc-ico sk-ico' }, icon('book', 15)),
        el('div', { className: 'sk-title' }, el('b', { textContent: s.title }), el('span', { className: 'c3', textContent: s.category || 'Weitere' })), el('span', { className: 'grow' }), close),
      el('div', { className: 'sk-desc', textContent: s.summary }),
    ];
    if (s.changed) kids.push(el('div', { className: 'sk-note', textContent: 'Die Kopie im Projekt weicht von der Fassung dieser App ab. Aus- und wieder Einschalten übernimmt die Fassung der App, die bisherige kommt in die Sicherung.' }));
    for (const p of s.problems) kids.push(el('div', { className: 'sk-warn', textContent: p }));
    kids.push(el('div', { className: 'sk-sec' }, el('div', { className: 'sk-h', textContent: 'Für dieses Modell' }), this.modeSwitch(s),
      el('div', { className: 'c3 small', textContent: modeOf(s.mode).title })));
    if (s.vars.length) {
      const set = changedVars(s);
      const reset = set.length ? el('button', { className: 'sk-resetall', textContent: 'Zurücksetzen', title: 'Alle Einstellungen dieses Skills zurück auf den Standard' }) : null;
      reset?.addEventListener('click', () => void this.resetAll(s));
      kids.push(el('div', { className: 'sk-sec' },
        el('div', { className: 'sk-h' }, el('span', { textContent: 'Einstellungen' }), el('span', { className: 'grow' }), set.length ? el('span', { className: 'sk-hn', textContent: `${set.length} angepasst · ` }) : null, reset),
        el('div', { className: 'sk-vars' }, ...s.vars.map((v) => this.field(s, v)))));
    }
    if (s.topics.length) kids.push(el('div', { className: 'sk-sec' }, el('div', { className: 'sk-h', textContent: 'Darauf achtet der Agent' }), el('ul', { className: 'sk-topics' }, ...s.topics.map((t) => el('li', { textContent: t })))));
    if (s.bundled) {
      const id = `sk-${s.id}-default`;
      const sel = el('select', { id, className: 'sk-select', disabled: this.busy.has(s.id) }, ...MODES.map((m) => el('option', { value: m.mode, textContent: m.label })));
      sel.value = s.defaultMode;
      sel.addEventListener('change', () => void this.setDefault(s, sel.value as SkillMode));
      kids.push(el('div', { className: 'sk-sec sk-def', title: 'Gilt für alle Modelle, die ab jetzt angelegt werden. Dieses Modell bleibt, wie es ist.' },
        el('label', { textContent: 'Bei neuen Modellen', htmlFor: id }), sel));
    }
    const actions = el('div', { className: 'sc-actions sk-actions' });
    if (s.file) {
      const view = el('button', { className: 'btn sm', title: 'Die Kopie im Projekt im Code zeigen (nur lesen)' }, icon('file', 14, 1.9), 'Datei ansehen');
      view.addEventListener('click', () => this.deps.open(s.file!));
      actions.append(view);
    }
    if (s.mode !== 'off' && s.file) {
      const send = el('button', { className: 'btn sm acc', title: 'Pfad und angepasste Einstellungen in die Eingabe des Agenten einfügen, damit ein laufender Agent davon erfährt' }, icon('send', 14, 1.9), 'An Agent geben');
      send.addEventListener('click', () => this.deps.insert(skillNote(s)));
      actions.append(send);
    }
    if (!s.file) kids.push(el('div', { className: 'sk-note', textContent: 'Auf „Bei Bedarf“ oder „Immer“ liegt der Skill als Markdown im Projekt und lässt sich ansehen.' }));
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
    if (!r.ok) { this.deps.toast(r.error ?? 'Die Vorgabe für neue Modelle ließ sich nicht ändern.', 'error'); return; }
    this.deps.toast(`„${s.title}“ steht bei neuen Modellen auf „${labelOf(mode)}“. Dieses Modell bleibt, wie es ist.`);
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
    if (!r.ok) { this.deps.toast(r.error ?? 'Die Einstellung ließ sich nicht ändern.', 'error'); return; }
    this.deps.changed();
    const now = r.skills.find((x) => x.id === s.id) ?? s;
    const kept = r.backup ? ' Die vorige Fassung im Projekt liegt in der Sicherung.' : '';
    this.deps.toast(`„${s.title}“: ${what(now)}. `
      + (s.mode !== 'off' ? `Steht in ${s.file}. Einem laufenden Agenten sagt „An Agent geben“ Bescheid.${kept}` : 'Gilt, sobald der Skill nicht mehr aus ist.'));
  }

  private setVar(s: SkillInfo, v: SkillVar, value: SkillValue | null): Promise<void> {
    return this.configure(s, { [v.name]: value }, (now) => {
      const x = now.vars.find((y) => y.name === v.name) ?? v;
      return `${v.label} ${shown(x)}${value === null ? ' (Standard)' : ''}`;
    });
  }

  private resetAll(s: SkillInfo): Promise<void> {
    const set = changedVars(s);
    return this.configure(s, Object.fromEntries(set.map((v) => [v.name, null])), () => `${set.map((v) => v.label).join(', ')} zurück auf den Standard`);
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
      const shownNum = typeof v.value === 'number' ? v.value.toLocaleString('de-DE', { maximumFractionDigits: 6 }) : String(v.value);
      const inp = el('input', { id, className: 'sk-num', type: 'text', value: shownNum, spellcheck: false, autocomplete: 'off' });
      inp.inputMode = 'decimal';
      inp.title = v.min != null && v.max != null ? `Erlaubt ${shown(v, v.min)} bis ${shown(v, v.max)}` : '';
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
    const reset = el('button', { className: 'sk-reset', title: `Zurück auf den Standard (${shown(v, v.default)})` }, icon('undo', 13, 2));
    reset.setAttribute('aria-label', `${v.label} zurück auf den Standard`);
    reset.hidden = isDefault;
    reset.addEventListener('click', () => void this.setVar(s, v, null));
    const row = el('div', { className: 'sk-var' + (isDefault ? '' : ' set') }, label, el('span', { className: 'sk-in' }, input, el('span', { className: 'c3', textContent: v.unit })), reset);
    row.dataset.var = v.name;
    return row;
  }

  /** Für Tests. */
  state() {
    return {
      skills: this.skills.map((s) => ({ id: s.id, title: s.title, summary: s.summary, category: s.category, defaultMode: s.defaultMode, mode: s.mode, file: s.file, changed: s.changed, problems: s.problems,
        vars: Object.fromEntries(s.vars.map((v) => [v.name, v.value])) })),
      busy: [...this.busy], text: this.ui.list.innerText, detail: this.ui.detail.hidden ? null : this.ui.detail.innerText, open: this.openId,
    };
  }
}
