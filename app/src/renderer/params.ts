import type { BuildStatus, ParamInfo, ParamResult, ParamState, ParamValue } from '../shared/types';
import { icon } from './icons';
import { el } from './ui';

interface Deps {
  state(): Promise<ParamState>;
  /** Werte setzen (null: zurück auf den Wert aus dem Code). Der Hauptprozess schreibt parameters.json und baut. */
  set(values: Record<string, ParamValue | null>): Promise<ParamResult>;
  resetAll(): Promise<ParamResult>;
  /** Stelle im Code zeigen, an der der Parameter angelegt ist. */
  openCode(file: string, line: number, label: string): void;
  /** Text in die Eingabe des Agenten einfügen (E11). */
  insert(text: string): void;
  toast(text: string, kind?: 'ok' | 'info' | 'error'): void;
}

interface Ui {
  list: HTMLElement;
  /** Zeile unter der Liste: wie viele Werte vom Code abweichen, „Reset all“. */
  foot: HTMLElement;
  count: HTMLElement;
}

/** Zahl zum Lesen und Wiedereinlesen: Punkt, ohne Tausendertrennung (1500 darf nicht als „1,500“ zurückkommen). */
const numText = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 6, useGrouping: false });
const unitOf = (p: ParamInfo) => (p.unit && (p.kind === 'number' || p.kind === 'int') ? (/^[°%]$/.test(p.unit) ? p.unit : ` ${p.unit}`) : '');
/** Wert für die Oberfläche: Zahl mit Einheit, Schalter als on/off, Auswahl mit ihrem Namen. */
export function shownValue(p: ParamInfo, v: ParamValue): string {
  if (typeof v === 'number') return `${numText(v)}${unitOf(p)}`;
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  if (p.kind === 'choice') return p.options?.find((o) => o.value === v)?.label ?? String(v);
  return `“${v}”`;
}
/** Für den Agenten: Zahlen mit Punkt, Texte in Anführungszeichen, Schalter wie in Python. */
const forAgent = (p: ParamInfo, v: ParamValue) => (typeof v === 'boolean' ? (v ? 'True' : 'False') : typeof v === 'string' ? JSON.stringify(v) : `${numText(v)}${unitOf(p)}`);

/** Passt ein Wert aus parameters.json zum Parameter? Gleiche Regeln wie soma build (python/soma/params.py, _coerce). */
function usable(p: ParamInfo, v: ParamValue): boolean {
  switch (p.kind) {
    case 'number': return typeof v === 'number' && Number.isFinite(v);
    case 'int': return typeof v === 'number' && Number.isInteger(v);
    case 'bool': return typeof v === 'boolean';
    case 'text': return typeof v === 'string';
    default: return !!p.options?.some((o) => o.value === v);
  }
}
const outside = (p: ParamInfo, v: ParamValue) => typeof v === 'number' && ((p.min != null && v < p.min) || (p.max != null && v > p.max));
const rangeText = (p: ParamInfo) => `${p.min != null ? shownValue(p, p.min) : '…'} to ${p.max != null ? shownValue(p, p.max) : '…'}`;
/** Bereich kurz für die Zeile, wie der Agent ihn gesetzt hat: „30–200 mm“, „≥ 2 mm“, „3 options“. Ohne Bereich leer. */
function rangeShort(p: ParamInfo): string {
  if (p.kind === 'choice') return `${p.options?.length ?? 0} options`;
  if (p.kind !== 'number' && p.kind !== 'int') return '';
  if (p.min != null && p.max != null) return `${numText(p.min)}–${numText(p.max)}${unitOf(p)}`;
  if (p.min != null) return `≥ ${numText(p.min)}${unitOf(p)}`;
  if (p.max != null) return `≤ ${numText(p.max)}${unitOf(p)}`;
  return '';
}

/** Text für die Eingabe des Agenten: Name, Wert, ggf. der Wert aus dem Code, Stelle im Code. */
export function paramNote(p: ParamInfo, v: ParamValue, changed: boolean): string {
  return `[Parameter: "${p.label}" (${p.name}) = ${forAgent(p, v)}${changed ? `, set in the app, code default ${forAgent(p, p.default)}` : ''}, ${p.file} line ${p.line}] `;
}

/**
 * Seitenleiste „Parameters“ (Entwurf 2, Bild 6): die Werte, die der Agent mit `param()` freigegeben hat, gruppiert wie im
 * Code. Ändern schreibt den Wert nach parameters.json und baut, der Wert im Code (der des Agenten) bleibt. Abweichende
 * Werte sind orange und einzeln oder alle zusammen zurückzusetzen. Werte außerhalb des Bereichs werden gemeldet und
 * trotzdem gebaut (E28), abgelehnt wird nur, was nicht zum Typ passt.
 */
export class ParamsPanel {
  private st: ParamState | null = null;
  private loadError = '';
  private openName: string | null = null;
  private collapsed = new Set<string>();
  private busy = false;
  private build: BuildStatus = { state: 'idle' };
  /**
   * Letzte Änderung: Scheitert der Build danach, bietet das Panel den Wert davor an (null: Wert aus dem Code). Den Build
   * startet der Hauptprozess schon beim Schreiben, seine Meldung „building“ kann vor der Antwort hier ankommen.
   */
  private last: { name: string; before: ParamValue | null; after: ParamValue | null } | null = null;
  /** Neu zeichnen erst, wenn kein Feld mehr in Bearbeitung ist: sonst wären Eingabe und Fokus weg. */
  private deferred = false;
  private commitTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private ui: Ui, private deps: Deps) {
    ui.list.addEventListener('focusout', () => setTimeout(() => {
      if (this.deferred && !this.editing()) { this.deferred = false; this.render(); }
    }, 0));
  }

  async refresh(): Promise<void> {
    try { this.st = await this.deps.state(); this.loadError = ''; } catch (e) { this.loadError = e instanceof Error ? e.message : String(e); }
    this.render();
  }

  /** Neues Modell: alte Liste weg. */
  reset(): void { this.st = null; this.openName = null; this.last = null; this.collapsed.clear(); this.render(); }

  /** Stand des Builds: für den Hinweis, wenn ein Build nach einer Änderung scheitert. */
  setBuild(s: BuildStatus): void { this.build = s; }

  private editing(): boolean {
    const a = document.activeElement;
    return !!a && this.ui.list.contains(a) && (a.tagName === 'INPUT' || a.tagName === 'SELECT');
  }

  private userValue(p: ParamInfo): ParamValue | undefined {
    const v = this.st?.values[p.name];
    return v !== undefined && usable(p, v) ? v : undefined;
  }

  private current(p: ParamInfo): ParamValue { return this.userValue(p) ?? p.default; }

  /** Wert übernehmen. Gleich dem Wert im Code: Eintrag entfernen, dann folgt der Parameter wieder dem Code. */
  private async commit(p: ParamInfo, v: ParamValue | null): Promise<void> {
    clearTimeout(this.commitTimer);
    const next = v === null || v === p.default ? null : v;
    const before = this.userValue(p) ?? null;
    if (next === before && this.st?.values[p.name] === (before ?? undefined)) { this.render(); return; }
    this.busy = true;
    let r: ParamResult;
    try { r = await this.deps.set({ [p.name]: next }); } catch (e) { r = { ok: false, message: e instanceof Error ? e.message : String(e), ...(this.st ?? { params: null, values: {} }) }; }
    this.busy = false;
    this.st = r;
    if (!r.ok) { this.deps.toast(r.message ?? `${p.label} could not be changed.`, 'error'); this.render(); return; }
    this.last = { name: p.name, before, after: next };
    this.render();
  }

  /** Zahlen aus Pfeiltasten und Stepper kurz sammeln, damit nicht jeder Druck einen Build anstößt. */
  private commitSoon(p: ParamInfo, v: ParamValue): void {
    clearTimeout(this.commitTimer);
    this.commitTimer = setTimeout(() => void this.commit(p, v), 450);
  }

  private async resetAll(): Promise<void> {
    this.busy = true;
    let r: ParamResult;
    try { r = await this.deps.resetAll(); } catch (e) { r = { ok: false, message: e instanceof Error ? e.message : String(e), ...(this.st ?? { params: null, values: {} }) }; }
    this.busy = false;
    this.st = r;
    this.last = null;
    this.render();
    if (!r.ok) this.deps.toast(r.message ?? 'The values could not be reset.', 'error');
    else this.deps.toast('All parameters are back at the values from the code.');
  }

  render(): void {
    if (this.editing()) { this.deferred = true; return; }
    const { list, foot, count } = this.ui;
    const st = this.st;
    const params = st?.params ?? null;
    count.textContent = params?.length ? String(params.length) : '';
    const out: HTMLElement[] = [];
    if (this.loadError) out.push(el('div', { className: 'pm-warn', textContent: `Parameters not readable: ${this.loadError}` }));
    if (st?.error) out.push(el('div', { className: 'pm-warn' }, icon('alert', 14, 2), el('span', { textContent: st.error })));
    if (!st && !this.loadError) out.push(el('div', { className: 'hint', textContent: 'Loading …' }));
    else if (st && params === null) {
      out.push(el('div', { className: 'hint', textContent: this.build.state === 'building' ? 'The parameters appear after the build …' : 'The parameters appear after the first successful build.' }));
    } else if (params && !params.length) out.push(this.empty());
    if (params?.length) {
      if (st?.stale) out.push(el('div', { className: 'pm-note', textContent: 'The last build failed before it reached the parameters. The list is from an earlier build.' }));
      const failed = this.failedHint(params);
      if (failed) out.push(failed);
      const groups = new Map<string, ParamInfo[]>();
      for (const p of params) {
        const g = p.group ?? '';
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g)!.push(p);
      }
      // Ohne Gruppe zuerst und ohne Überschrift, danach die Gruppen in der Reihenfolge des Codes
      const order = [...groups.keys()].sort((a, b) => Number(a !== '') - Number(b !== ''));
      for (const g of order) {
        const items = groups.get(g)!;
        if (g) {
          const closed = this.collapsed.has(g);
          const changed = items.filter((p) => this.st?.values[p.name] !== undefined).length;
          const h = el('button', { className: 'pg', title: closed ? 'Expand group' : 'Collapse group' }, icon(closed ? 'right' : 'down', 12, 2), el('span', { textContent: g }),
            closed ? el('span', { className: 'src', textContent: `· ${items.length}${changed ? `, ${changed} changed` : ''}` }) : null);
          h.setAttribute('aria-expanded', String(!closed));
          h.addEventListener('click', () => { if (closed) this.collapsed.delete(g); else this.collapsed.add(g); this.render(); });
          out.push(h);
          if (closed) continue;
        }
        for (const p of items) out.push(this.row(p));
      }
    }
    // Werte ohne Parameter, auch wenn das Modell gar keine (mehr) hat. Nicht bei einer Liste von früher: Neue Parameter
    // des gescheiterten Builds kennt sie nicht
    if (params && !st?.stale) {
      const known = new Set(params.map((p) => p.name));
      const orphans = Object.entries(st?.values ?? {}).filter(([k]) => !known.has(k));
      if (orphans.length) out.push(this.orphans(orphans));
    }
    list.replaceChildren(...out);
    // Fußzeile: wie viele Werte vom Code abweichen
    const n = params ? Object.keys(st?.values ?? {}).length : 0;
    foot.hidden = !n;
    if (n) {
      const b = el('button', { className: 'btn sm', disabled: this.busy, title: 'Remove all your values: every parameter takes the value from the code again' }, icon('reset', 14, 1.9), 'Reset all');
      b.addEventListener('click', () => void this.resetAll());
      foot.replaceChildren(el('span', { className: 'dot' }), el('span', { className: 'pf-t', textContent: `${n} changed`, title: `${n} value${n === 1 ? '' : 's'} of yours in parameters.json, in place of the values from the code` }), el('span', { className: 'grow' }), b);
    }
  }

  /** Leerer Zustand (Entwurf 2, Bild 7): was Parameter sind und wie man zu ihnen kommt. */
  private empty(): HTMLElement {
    const ask = el('button', { className: 'btn sm acc', title: 'Add a request to the agent’s input. Enter sends it.' }, icon('send', 14, 1.9), 'Ask the agent');
    ask.addEventListener('click', () => this.deps.insert('Make the main dimensions of the model adjustable with param(), so I can change them in the Parameters panel. '));
    return el('div', { className: 'pm-empty' }, el('span', { className: 'c3' }, icon('sliders', 22, 1.6)), el('b', { textContent: 'This model has no parameters yet' }),
      el('span', { className: 'c2 small', textContent: 'Parameters are values of the model you can change here, such as a size, a count or an angle. The agent decides which ones, for example when you ask: “Make bore and stroke adjustable”.' }),
      ask);
  }

  /** Der Build nach der letzten Änderung ist gescheitert: den Wert davor anbieten (nicht selbst zurücknehmen, E28). */
  private failedHint(params: ParamInfo[]): HTMLElement | null {
    const l = this.last;
    if (!l || this.build.state !== 'error') return null;
    const p = params.find((x) => x.name === l.name);
    if (!p) return null;
    const after = l.after ?? p.default;
    const back = el('button', { className: 'btn sm', disabled: this.busy }, icon('undo', 14, 2), `Back to ${shownValue(p, l.before ?? p.default)}`);
    back.addEventListener('click', () => void this.commit(p, l.before));
    const send = el('button', { className: 'btn sm acc', title: 'Add the parameter to the agent’s input. The error is in the card in the viewer.' }, icon('send', 14, 1.9), 'Send to agent');
    send.addEventListener('click', () => this.deps.insert(`${paramNote(p, after, l.after !== null)}The build fails with this value. `));
    return el('div', { className: 'pm-fail' }, el('div', { className: 'pm-fail-t' }, icon('alert', 15, 2), el('span', { textContent: `The build failed after ${p.label} was set to ${shownValue(p, after)}.` })),
      el('div', { className: 'pm-acts' }, back, send));
  }

  private orphans(entries: [string, ParamValue][]): HTMLElement {
    const box = el('div', { className: 'pm-orph' }, el('div', { className: 'pg static', textContent: 'Not in the model anymore' }),
      el('div', { className: 'pm-note', textContent: 'You set these values, but the code has no parameter with this name (anymore). They are not used.' }));
    for (const [name, v] of entries) {
      const rm = el('button', { className: 'btn sm', disabled: this.busy, title: `Remove ${name} from parameters.json` }, 'Remove');
      rm.addEventListener('click', () => void (async () => {
        const r = await this.deps.set({ [name]: null }).catch((e: unknown) => ({ ok: false, message: e instanceof Error ? e.message : String(e), params: null, values: {} }) as ParamResult);
        if (!r.ok) this.deps.toast(r.message ?? `${name} could not be removed.`, 'error');
        else this.st = r;
        this.render();
      })());
      const row = el('div', { className: 'pm-orow' }, el('span', { className: 'mono', textContent: name }), el('span', { className: 'c3', textContent: typeof v === 'string' ? `“${v}”` : String(v) }), el('span', { className: 'grow' }), rm);
      row.dataset.name = name;
      box.append(row);
    }
    return box;
  }

  private row(p: ParamInfo): HTMLElement {
    const raw = this.st?.values[p.name];
    const user = this.userValue(p);
    const v = user ?? p.default;
    const changed = raw !== undefined;
    const bad = raw !== undefined && user === undefined; // in der Datei, passt aber nicht zum Parameter
    const out = outside(p, v);
    const open = this.openName === p.name;
    const cls = ['prm', changed && 'chg', (out || bad) && 'err', open && 'open'].filter(Boolean).join(' ');
    // Zweite Zeile: Name im Code und der Bereich, den der Agent gesetzt hat (ohne Aufklappen sichtbar)
    const range = rangeShort(p);
    const lb = el('button', { className: 'lb', title: `${p.label} (${p.name})${range ? `, range set by the agent: ${p.kind === 'choice' ? range : rangeText(p)}` : ''}${p.help ? `\n${p.help}` : ''}` },
      el('span', { className: 'lt', textContent: p.label }),
      el('span', { className: 'sub' }, el('span', { className: 'cn', textContent: p.name }), range ? el('span', { className: 'rg', textContent: range }) : null));
    lb.setAttribute('aria-expanded', String(open));
    lb.addEventListener('click', () => { this.openName = open ? null : p.name; this.render(); });
    const rst = el('button', { className: 'rst', disabled: this.busy, title: `Back to the value from the code (${shownValue(p, p.default)})` }, icon('reset', 13, 2));
    rst.setAttribute('aria-label', `Reset ${p.label}`);
    // Unsichtbar statt ausgeblendet: Die Felder aller Zeilen bleiben bündig
    rst.classList.toggle('off', !changed);
    rst.tabIndex = changed ? 0 : -1;
    rst.addEventListener('click', () => void this.commit(p, null));
    const r = el('div', { className: 'r' }, lb, this.control(p, v), rst);
    const row = el('div', { className: cls }, r);
    row.dataset.name = p.name;
    if (out) row.title = `Outside the range ${rangeText(p)} from the code`;
    if (open) row.append(this.details(p, v, changed, out, bad));
    return row;
  }

  /** Aufgeklappt: Schieber, Erklärung, Wert im Code, Hinweise, Sprung in den Code und „Send to agent“. */
  private details(p: ParamInfo, v: ParamValue, changed: boolean, out: boolean, bad: boolean): HTMLElement {
    const x = el('div', { className: 'x' });
    if ((p.kind === 'number' || p.kind === 'int') && p.min != null && p.max != null && p.max > p.min) x.append(this.slider(p, v as number));
    if (p.help) x.append(el('div', { className: 'c2 small', textContent: p.help }));
    const facts = [`Code: ${shownValue(p, p.default)}`];
    if ((p.kind === 'number' || p.kind === 'int') && (p.min != null || p.max != null)) facts.push(`range ${rangeText(p)}`);
    if (p.step != null) facts.push(`step ${numText(p.step)}`);
    x.append(el('div', { className: 'c3 small', textContent: facts.join(' · ') }));
    if (out) x.append(el('div', { className: 'pm-err small', textContent: `${shownValue(p, v)} lies outside the range from the code. It is used anyway, the agent chose the range so the model works within it.` }));
    if (bad) x.append(el('div', { className: 'pm-err small', textContent: `parameters.json holds ${JSON.stringify(this.st?.values[p.name])}, which does not fit this parameter. The value from the code applies.` }));
    const code = el('button', { className: 'lnk', title: 'Show the place in the code' }, icon('code', 13, 2), `${p.file}, line ${p.line}`);
    code.addEventListener('click', () => this.deps.openCode(p.file, p.line, p.label));
    const send = el('button', { className: 'lnk', title: 'Add this parameter to the agent’s input' }, icon('send', 13, 2), 'Send to agent');
    send.addEventListener('click', () => this.deps.insert(paramNote(p, v, changed)));
    x.append(el('div', { className: 'pm-links' }, code, el('span', { className: 'grow' }), send));
    return x;
  }

  private slider(p: ParamInfo, v: number): HTMLElement {
    const min = p.min!, max = p.max!;
    // Ohne step: ein Zweihundertstel des Bereichs, auf eine runde Zahl von Stellen
    const step = p.step ?? (p.kind === 'int' ? 1 : 10 ** Math.floor(Math.log10((max - min) / 200)));
    const digits = Math.max(0, Math.min(6, -Math.floor(Math.log10(step) + 1e-9)));
    const round = (n: number) => (p.kind === 'int' ? Math.round(n) : Number(n.toFixed(digits)));
    const range = el('input', { type: 'range', className: 'pm-range', min: String(min), max: String(max), step: String(step), value: String(Math.min(max, Math.max(min, v))), disabled: this.busy });
    range.setAttribute('aria-label', `${p.label}, slider`);
    // Beim Ziehen nur die Zahl mitführen, gebaut wird beim Loslassen
    range.addEventListener('input', () => {
      const f = range.closest('.prm')?.querySelector<HTMLInputElement>('.pm-num');
      if (f) f.value = numText(round(Number(range.value)));
    });
    range.addEventListener('change', () => { range.blur(); void this.commit(p, round(Number(range.value))); });
    return el('div', { className: 'slider' }, el('span', { className: 'c3', textContent: numText(min) }), range, el('span', { className: 'c3', textContent: numText(max) }));
  }

  private control(p: ParamInfo, v: ParamValue): HTMLElement {
    const id = `pm-${p.name}`;
    if (p.kind === 'bool') {
      const sw = el('button', { id, className: 'pm-switch', disabled: this.busy, title: v ? 'On' : 'Off' }, el('span'));
      sw.setAttribute('role', 'switch');
      sw.setAttribute('aria-checked', String(v === true));
      sw.setAttribute('aria-label', p.label);
      sw.addEventListener('click', () => void this.commit(p, !(v === true)));
      return el('span', { className: 'pm-ctl' }, sw);
    }
    if (p.kind === 'choice') {
      const sel = el('select', { id, className: 'pm-select', disabled: this.busy }, ...(p.options ?? []).map((o, i) => el('option', { value: String(i), textContent: o.label })));
      sel.value = String(Math.max(0, (p.options ?? []).findIndex((o) => o.value === v)));
      sel.setAttribute('aria-label', p.label);
      sel.addEventListener('change', () => { const o = p.options?.[Number(sel.value)]; sel.blur(); if (o) void this.commit(p, o.value); });
      return el('span', { className: 'pm-ctl' }, sel);
    }
    const isNum = p.kind === 'number' || p.kind === 'int';
    const shown = typeof v === 'number' ? numText(v) : String(v);
    const inp = el('input', { id, className: isNum ? 'pm-num' : 'pm-text', type: 'text', value: shown, spellcheck: false, autocomplete: 'off', disabled: this.busy });
    inp.setAttribute('aria-label', p.label);
    if (isNum) inp.inputMode = p.kind === 'int' ? 'numeric' : 'decimal';
    const parse = (): ParamValue | null => {
      if (!isNum) return inp.value;
      const n = Number(inp.value.trim().replace(',', '.'));
      if (!inp.value.trim() || !Number.isFinite(n)) { this.deps.toast(`${p.label} needs a number, for example ${numText(p.default as number)}.`, 'error'); return null; }
      if (p.kind === 'int' && !Number.isInteger(n)) { this.deps.toast(`${p.label} needs a whole number.`, 'error'); return null; }
      return n;
    };
    const apply = () => {
      if (inp.value.trim() === shown) return;
      const n = parse();
      if (n === null) { inp.value = shown; return; }
      void this.commit(p, n);
    };
    const nudge = (dir: 1 | -1) => {
      const cur = parse();
      if (typeof cur !== 'number') return;
      const step = p.step ?? (p.kind === 'int' ? 1 : 10 ** Math.floor(Math.log10(Math.max(Math.abs(cur), 1e-6))) / 10);
      const next = Number((cur + dir * step).toFixed(6));
      inp.value = numText(next);
      this.commitSoon(p, next);
    };
    inp.addEventListener('change', apply);
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); apply(); inp.blur(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); inp.value = shown; inp.blur(); }
      else if (isNum && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); nudge(e.key === 'ArrowUp' ? 1 : -1); }
    });
    const box = el('span', { className: `pm-ctl valbox${isNum ? '' : ' wide'}` });
    if (p.kind === 'int') {
      const minus = el('button', { className: 'stp', disabled: this.busy, title: `Less (${p.label})` }, icon('minus', 12, 2));
      const plus = el('button', { className: 'stp', disabled: this.busy, title: `More (${p.label})` }, icon('plus', 12, 2));
      minus.setAttribute('aria-label', `${p.label} minus`);
      plus.setAttribute('aria-label', `${p.label} plus`);
      minus.addEventListener('click', () => nudge(-1));
      plus.addEventListener('click', () => nudge(1));
      box.classList.add('stepper');
      box.append(minus, inp, plus);
    } else box.append(inp);
    if (isNum && p.unit) box.append(el('span', { className: 'u', textContent: p.unit }));
    return box;
  }

  /** Für Tests. */
  state() {
    const params = this.st?.params ?? null;
    return {
      names: params?.map((p) => p.name) ?? null,
      shown: Object.fromEntries((params ?? []).map((p) => [p.name, shownValue(p, this.current(p))])),
      values: { ...(this.st?.values ?? {}) },
      changed: [...this.ui.list.querySelectorAll<HTMLElement>('.prm.chg')].map((x) => x.dataset.name),
      errors: [...this.ui.list.querySelectorAll<HTMLElement>('.prm.err')].map((x) => x.dataset.name),
      stale: !!this.st?.stale, error: this.st?.error ?? null, busy: this.busy, open: this.openName,
      text: this.ui.list.innerText, foot: this.ui.foot.hidden ? '' : this.ui.foot.innerText,
    };
  }
}
