import type { ResultEntry } from '../shared/types';
import { resultColor } from './overlay';
import { fmtScale, type ResultField, type ResultLayer, type ResultProbe } from './resultview';
import { el } from './ui';

// Ergebnisse von `soma analyze` im Viewer (E58): auswählen, farbig zeigen, Wert unter dem Zeiger, an den Agenten geben.
// Gerechnet wird in Python, hier wird nur gezeigt. Neu berechnen nutzt die Angaben, mit denen der Agent es erzeugt hat.

interface Ui {
  card: HTMLElement; close: HTMLButtonElement; select: HTMLSelectElement;
  legend: HTMLElement; summary: HTMLElement; probe: HTMLElement; hint: HTMLElement;
  rerun: HTMLButtonElement; agent: HTMLButtonElement;
  /** Nur FEM: Überhöhung der Verformung und Lastfall ein/aus. */
  femRow: HTMLElement; deform: HTMLSelectElement; bcs: HTMLButtonElement;
  /** Farbskala: gezeigte Größe (nur FEM), Spanne (automatisch, Min bis Max, eigene) und die eigenen Grenzen. */
  field: HTMLSelectElement; range: HTMLSelectElement; custom: HTMLElement; lo: HTMLInputElement; hi: HTMLInputElement;
  viewerEl: HTMLElement;
}
interface Deps {
  layer: ResultLayer;
  list(): Promise<ResultEntry[]>;
  rerun(id: string): Promise<{ ok: boolean; error?: string }>;
  readBinary(rel: string): Promise<ArrayBuffer>;
  beforeOn(): void;
  insert(text: string): void;
  toast(text: string, kind?: 'ok' | 'info' | 'error'): void;
  /** An, aus oder ein anderes Ergebnis: der Umschalter oben links zeigt, was zu sehen ist. */
  changed(): void;
}

const num = (v: number, unit: string) => (+v.toFixed(unit === '°' ? 1 : 2) + 0).toLocaleString('en-US'); // + 0: kein „-0“
// Ohne Einheit (Sicherheitsfaktor der FEM) steht die Zahl allein
const withUnit = (v: number, unit: string) => `${num(v, unit)}${unit === '°' ? '°' : unit ? ` ${unit}` : ''}`;
const dot = (v: number, unit: string) => `${v.toFixed(unit === '°' ? 1 : 2)}${unit === '°' ? '°' : unit ? ` ${unit}` : ''}`;
const loc = (v: number, digits: number) => (+v.toFixed(digits) + 0).toLocaleString('en-US');
/** Höchster Sicherheitsfaktor in der Datei (soma.fem VALUE_CAP): Dort ist kaum Spannung, der Wert selbst sagt nichts. */
const SAFETY_CAP = 99;
const safety = (v: number) => (v >= SAFETY_CAP ? `over ${SAFETY_CAP}` : loc(v, 2));
/** FEM an einer Stelle: die gezeigte Größe zuerst, dann die andere und die Verschiebung. */
const femAt = (p: ResultProbe, field: ResultField, label: boolean) => {
  const stress = p.stress != null ? `${loc(p.stress, 1)} MPa` : null;
  const sf = `${label || field === 'stress' ? 'Safety ' : ''}${safety(p.value)}`;
  return [...(field === 'stress' && stress ? [stress, sf] : [sf, stress]), p.disp != null ? `${loc(p.disp, 3)} mm` : null].filter(Boolean).join(' · ');
};
type RangeMode = 'auto' | 'minmax' | 'custom';
/** Abstand des Schilds vom Zeiger (px): neben den Armen des Fadenkreuzes, nicht darauf. */
const TIP_GAP = 14;

export class ResultTool {
  private active = false;
  private list: ResultEntry[] = [];
  private current: ResultEntry | null = null;
  /** Zuletzt angeklickte Stelle (für „An Agent geben“). */
  private pinned: ResultProbe | null = null;
  private loading = 0;
  private busy = false;
  /** Beim nächsten Laden dieses Ergebnis zeigen (Wahl im Umschalter). */
  private want: string | null = null;
  // Farbskala: Die Wahl gilt über Ergebnisse hinweg, eigene Grenzen nur für dasselbe Ergebnis und dieselbe Größe
  // (nach „Neu berechnen“ bleibt die Skala, die Farben bleiben vergleichbar)
  private field: ResultField = 'value';
  private mode: RangeMode = 'auto';
  private custom: { key: string; range: [number, number] } | null = null;
  // Schild am Zeiger: Der Wert steht dort, wo man hinschaut, die Zeile in der Karte bleibt für das Merken per Klick.
  // Ein einziges Element, das nur verschoben und per textContent befüllt wird (Bauteilnamen kommen aus dem Projekt).
  private readonly tipDot = el('span', { className: 'rs-tip-dot' });
  private readonly tipVal = el('b');
  private readonly tipName = el('div', { className: 'rs-tip-n' });
  private readonly tip = el('div', { className: 'rs-tip', hidden: true }, el('div', { className: 'rs-tip-v' }, this.tipDot, this.tipVal), this.tipName);

  constructor(private readonly ui: Ui, private readonly d: Deps) {
    ui.close.addEventListener('click', () => this.setActive(false));
    ui.select.addEventListener('change', () => { const e = this.list.find((r) => r.id === ui.select.value); if (e) void this.load(e); });
    ui.rerun.addEventListener('click', () => void this.rerun());
    ui.agent.addEventListener('click', () => { const t = this.agentNote(); if (t) d.insert(t); });
    ui.deform.addEventListener('change', () => { d.layer.setScale(Number(ui.deform.value) || 0); this.hideTip(); });
    ui.bcs.addEventListener('click', () => { d.layer.setBcsVisible(!d.layer.bcsVisible); ui.bcs.setAttribute('aria-pressed', String(d.layer.bcsVisible)); });
    ui.field.addEventListener('change', () => { this.field = ui.field.value === 'stress' ? 'stress' : 'value'; this.applyScale(); this.render(); });
    ui.range.addEventListener('change', () => { this.mode = ui.range.value as RangeMode; this.applyScale(); this.render(); });
    // Eigene Grenzen gelten sofort beim Tippen, solange sie gültig sind (von kleiner als bis), sonst rot umrandet und unverändert
    const typed = () => {
      const lo = ui.lo.valueAsNumber, hi = ui.hi.valueAsNumber;
      const ok = Number.isFinite(lo) && Number.isFinite(hi) && lo < hi;
      ui.lo.classList.toggle('bad', !ok);
      ui.hi.classList.toggle('bad', !ok);
      if (!ok || !this.custom) return;
      this.custom.range = [lo, hi];
      this.applyScale();
      this.renderLegend();
      this.hideTip();
    };
    ui.lo.addEventListener('input', typed);
    ui.hi.addEventListener('input', typed);
    ui.viewerEl.append(this.tip);
    let queued = false, pos: [number, number] | null = null, away = true;
    // Zeiger nicht mehr über dem Bild: Schild weg, die Karte zeigt wieder die gemerkte Stelle (wichtig vor „An Agent geben“)
    const leave = () => { pos = null; this.hideTip(); if (!away) { away = true; this.showProbe(null, false); } };
    const track = (e: MouseEvent) => {
      if (!this.active) return;
      // Beim Drehen und Verschieben bliebe das Schild mit altem Wert stehen, die Zeile in der Karte bleibt wie bisher
      if (e.buttons) { pos = null; this.hideTip(); return; }
      // Über Karten, Knöpfen, Würfel oder Video kein Wert vom Modell dahinter
      if (!this.overImage(e.target)) { leave(); return; }
      away = false;
      pos = [e.clientX, e.clientY];
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (!pos || !this.active) return;
        const p = this.d.layer.probe(pos[0], pos[1]);
        this.showProbe(p, false);
        this.showTip(p, pos);
      });
    };
    ui.viewerEl.addEventListener('pointermove', track);
    // Beim Zoomen wandert das Modell unter dem stehenden Zeiger weg: Wert an derselben Stelle neu holen
    ui.viewerEl.addEventListener('wheel', track, { passive: true });
    ui.viewerEl.addEventListener('pointerleave', () => { if (this.active) leave(); });
    let down: [number, number] | null = null;
    ui.viewerEl.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    ui.viewerEl.addEventListener('pointerup', (e) => {
      if (!this.active || !down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
      if ((e.target as HTMLElement).closest('.float')) return;
      this.pinned = this.d.layer.probe(e.clientX, e.clientY);
      this.showProbe(this.pinned, true);
    });
  }

  get isActive(): boolean { return this.active; }
  /** Titel des gezeigten Ergebnisses (null: keines geladen). */
  get currentTitle(): string | null { return this.active ? this.current?.title ?? null : null; }
  get currentId(): string | null { return this.active ? this.current?.id ?? null : null; }

  /** Ein bestimmtes Ergebnis zeigen (aus dem Umschalter oben links), null: das zuletzt gezeigte oder das erste. */
  show(id: string | null): void {
    this.want = id;
    if (!this.active) { this.setActive(true); return; }
    const e = id ? this.list.find((r) => r.id === id) : undefined;
    if (e && e.id !== this.current?.id) void this.load(e);
    else void this.refresh();
  }

  setActive(on: boolean): void {
    if (on === this.active) return;
    if (on) this.d.beforeOn();
    this.active = on;
    this.ui.card.hidden = !on;
    this.ui.viewerEl.classList.toggle('analyzing', on);
    this.d.changed();
    if (on) { void this.refresh(); return; }
    this.loading++;
    this.hideTip();
    this.d.layer.hide();
    this.current = null;
    this.pinned = null;
  }

  /** Liste neu lesen (Einschalten, neuer Build, nach einer Auswertung) und das gewählte Ergebnis neu laden. */
  async refresh(): Promise<void> {
    if (!this.active) return;
    const seq = ++this.loading;
    try { this.list = await this.d.list(); } catch { return; }
    if (seq !== this.loading || !this.active) return;
    this.ui.select.replaceChildren(...this.list.map((r) => el('option', { value: r.id, textContent: r.id === r.kind ? r.title : `${r.title} (${r.id})` })));
    this.ui.select.disabled = this.list.length < 2;
    const want = this.list.find((r) => r.id === (this.want ?? this.current?.id)) ?? this.list[0];
    this.want = null;
    if (want) await this.load(want, seq);
    else { this.d.layer.hide(); this.current = null; this.render(); }
  }

  private async load(e: ResultEntry, seq = ++this.loading): Promise<void> {
    try {
      const buf = await this.d.readBinary(e.file);
      if (seq !== this.loading || !this.active) return;
      await this.d.layer.show(buf);
      // Während des Ladens geschlossen oder ein anderes gewählt: nicht stehen lassen
      if (!this.active) { this.d.layer.hide(); return; }
      if (seq !== this.loading) return;
      this.current = e;
      this.applyScale();
      this.ui.select.value = e.id;
      this.pinned = null;
      this.d.changed();
    } catch (err) {
      this.d.toast(`Could not load the result: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
    this.render();
  }

  private render(): void {
    const r = this.current;
    this.ui.rerun.disabled = !r || this.busy;
    this.ui.agent.disabled = !r;
    this.ui.legend.replaceChildren();
    this.ui.summary.replaceChildren();
    this.ui.probe.textContent = '';
    // Anderes Ergebnis oder neu berechnet: Der Wert im Schild gilt nicht mehr, die nächste Bewegung holt den neuen
    this.hideTip();
    this.ui.hint.classList.toggle('warn', !!r?.stale);
    // Ohne Ergebnis keine Skala zum Einstellen
    this.ui.range.parentElement!.hidden = !r;
    if (!r) {
      this.ui.hint.textContent = 'No result yet. The agent creates it with soma analyze (overhang, wall thickness, clearance, strength with FEM).';
      return;
    }
    this.ui.hint.textContent = this.busy ? 'Recalculating …' : r.stale ? 'Older than the code. “Recalculate” evaluates the current model.' : `soma ${r.command.join(' ')}`;
    this.renderLegend();
    for (const p of r.parts) {
      const range = p.min != null && p.max != null ? `${withUnit(p.min, r.unit)} to ${withUnit(p.max, r.unit)}` : 'no values';
      const crit = p.critical > 0 ? `${(p.critical / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })} cm² critical` : 'nothing critical';
      // FEM: kleinste Sicherheit, höchste Spannung und größte Verschiebung sagen mehr als die Spanne
      // („kritisch“ nur, wenn es so ist: die Zeile ist schmal, und sie ist dann ohnehin rot)
      const text = r.fem && p.stress && p.displacement && p.min != null
        ? `Safety ${loc(p.min, 2)} · ${loc(p.stress.value, 1)} MPa · ${loc(p.displacement.value, 3)} mm${p.critical > 0 ? ` · ${crit}` : ''}`
        : `${range} · ${crit}`;
      this.ui.summary.append(el('div', { className: 'rs-row' + (p.critical > 0 ? ' bad' : '') },
        el('b', { textContent: p.name }), el('span', { textContent: text })));
    }
    this.renderFem(r);
    this.showProbe(this.pinned, true);
  }

  /** Legende: Verlauf über die Spanne der gezeigten Größe, Grenzwert als Strich. */
  private renderLegend(): void {
    this.ui.legend.replaceChildren();
    const v = this.d.layer.view;
    if (!v || !this.current) return;
    const [lo, hi] = v.range;
    const stops = Array.from({ length: 24 }, (_, i) => {
      const c = resultColor(lo + ((hi - lo) * i) / 23, v);
      return `rgb(${c.map(Math.round).join(',')}) ${((i / 23) * 100).toFixed(1)}%`;
    });
    const bar = el('div', { className: 'rs-bar' });
    bar.style.background = `linear-gradient(to right, ${stops.join(', ')})`;
    const mark = el('div', { className: 'rs-mark' });
    // Grenzwert außerhalb einer gewählten Spanne: kein Strich am Rand, der dort eine Grenze vortäuschen würde
    mark.hidden = v.threshold < lo || v.threshold > hi;
    mark.style.left = `${Math.max(0, Math.min(100, ((v.threshold - lo) / (hi - lo || 1)) * 100))}%`;
    bar.append(mark);
    const weakest = this.d.layer.field === 'stress' && this.d.layer.stressLimitMixed ? ' (weakest material)' : '';
    // Gewählte Spanne: Rot heißt dort „oberes Ende der Skala“, nicht kritisch. Das steht dabei
    const thr = `Limit ${withUnit(v.threshold, v.unit)}${weakest}, ${v.ramp ? 'color across the range' : `critical ${v.bad === 'high' ? 'above' : 'below'}`}`;
    this.ui.legend.append(
      el('div', { className: 'rs-q', textContent: v.unit ? `${v.quantity} (${v.unit})` : v.quantity }), bar,
      el('div', { className: 'rs-scale' }, el('span', { textContent: withUnit(lo, v.unit) }),
        el('span', { className: 'rs-thr', textContent: thr }),
        el('span', { textContent: withUnit(hi, v.unit) })),
    );
  }

  /** Größe und Spanne an die Ebene geben und die Auswahl in der Karte nachziehen. */
  private applyScale(): void {
    const l = this.d.layer, r = this.current;
    if (!l.meta || !r) return;
    const field: ResultField = this.field === 'stress' && l.canStress ? 'stress' : 'value';
    let range: [number, number] | null = null;
    if (this.mode === 'minmax') range = l.dataRange(field);
    else if (this.mode === 'custom') {
      const key = `${r.id}/${field}`;
      if (this.custom?.key !== key) this.custom = { key, range: l.autoRange(field).map((x) => +x.toPrecision(3)) as [number, number] };
      range = this.custom.range;
    }
    l.setDisplay(field, range);
    this.ui.field.hidden = !l.canStress;
    this.ui.field.value = field;
    this.ui.range.value = this.mode;
    this.ui.custom.hidden = this.mode !== 'custom';
    // Beim Tippen nicht überschreiben (aus „1.“ würde „1“)
    const typing = document.activeElement === this.ui.lo || document.activeElement === this.ui.hi;
    if (this.custom && this.mode === 'custom' && !typing) {
      this.ui.lo.value = String(this.custom.range[0]);
      this.ui.hi.value = String(this.custom.range[1]);
      this.ui.lo.classList.remove('bad');
      this.ui.hi.classList.remove('bad');
    }
  }

  /** FEM: Lastfall und Hinweise in der Karte, Wahl der Überhöhung. */
  private renderFem(r: ResultEntry): void {
    const fem = r.fem;
    this.ui.femRow.hidden = !fem;
    if (!fem) return;
    const n = (v: number[]) => `${loc(Math.hypot(v[0], v[1], v[2]), 1)} N`;
    for (const b of fem.bcs) {
      const what = b.kind === 'fix' ? `Fixed${b.axes && b.axes !== 'xyz' ? ` (${b.axes.toUpperCase().split('').join(', ')} only)` : ''}`
        : b.kind === 'force' ? 'Force' : 'Pressure';
      const val = b.kind === 'fix' ? (b.reaction ? `reaction force ${n(b.reaction)}` : '')
        : b.kind === 'pressure' ? `${loc(b.value ?? 0, 3)} MPa, total ${n(b.total ?? [0, 0, 0])}` : n(b.total ?? [0, 0, 0]);
      this.ui.summary.append(el('div', { className: 'rs-row bc' }, el('b', { textContent: what }), el('span', { textContent: `${b.label} · ${val}` })));
    }
    for (const t of r.notes ?? []) this.ui.summary.append(el('div', { className: 'rs-note', textContent: t }));
    const l = this.d.layer;
    const opts: [number, string][] = [[0, 'Undeformed'], [1, 'True scale']];
    if (l.autoScale > 1) opts.push([l.autoScale, `Exaggerated ${fmtScale(l.autoScale)}×`]);
    this.ui.deform.replaceChildren(...opts.map(([v, t]) => el('option', { value: String(v), textContent: t })));
    this.ui.deform.value = String(l.scale);
    this.ui.bcs.setAttribute('aria-pressed', String(l.bcsVisible));
  }

  private showProbe(p: ResultProbe | null, pinned: boolean): void {
    const r = this.current;
    if (!r) return;
    if (!p) { if (!pinned || !this.pinned) this.ui.probe.textContent = this.pinned ? this.probeText(this.pinned, true) : 'Point at the model to see the value there. Click to keep the spot for the agent.'; return; }
    this.ui.probe.textContent = this.probeText(p, pinned);
  }

  /**
   * Frei über dem Bild? Die Ebenen darüber (Beschriftungen, Malfläche, dieses Schild) lassen den Zeiger durch, das Ziel ist
   * dann die 3D-Fläche selbst. Karten, Knöpfe, Würfel und Video sind eigene Elemente und zählen nicht.
   */
  private overImage(t: EventTarget | null): boolean {
    const v = this.ui.viewerEl;
    return t === v || (t instanceof HTMLCanvasElement && t.parentElement === v);
  }

  /** Schild neben dem Zeiger: Wert groß, Bauteil klein, Punkt in der Farbe des Werts. Kein Bauteil unter dem Zeiger: weg. */
  private showTip(p: ResultProbe | null, at: [number, number]): void {
    const r = this.current;
    if (!p || !r) { this.hideTip(); return; }
    const l = this.d.layer;
    this.tipVal.textContent = r.fem ? femAt(p, l.field, false) : withUnit(p.value, r.unit);
    this.tipName.textContent = p.name;
    this.tipDot.style.background = `rgb(${resultColor(l.shown(p), l.view ?? r).map(Math.round).join(',')})`;
    this.tip.hidden = false;
    // Rechts oberhalb wie die Messbeschriftung, am Rand des Viewers auf die andere Seite, damit nichts abgeschnitten wird
    const v = this.ui.viewerEl.getBoundingClientRect();
    const w = this.tip.offsetWidth, h = this.tip.offsetHeight;
    const x = at[0] - v.left, y = at[1] - v.top;
    const left = x + TIP_GAP + w > v.width - 6 ? Math.max(6, x - TIP_GAP - w) : x + TIP_GAP;
    const top = y - TIP_GAP - h < 6 ? y + TIP_GAP : y - TIP_GAP - h;
    this.tip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  private hideTip(): void { this.tip.hidden = true; }

  /** Teil aus- oder eingeblendet: Der Wert unter dem Zeiger gilt nicht mehr, bis sich die Maus wieder bewegt. */
  forgetProbe(): void { if (this.active) { this.hideTip(); this.showProbe(null, false); } }

  private probeText(p: ResultProbe, pinned: boolean): string {
    const r = this.current!;
    const what = r.fem ? femAt(p, this.d.layer.field, true) : withUnit(p.value, r.unit);
    return `${pinned ? 'Picked' : 'Pointer'}: ${p.name}, ${what} at (${p.point.map((v) => (v + 0).toLocaleString('en-US')).join(', ')})`;
  }

  private async rerun(): Promise<void> {
    const r = this.current;
    if (!r || this.busy) return;
    this.busy = true;
    this.render();
    try {
      const res = await this.d.rerun(r.id);
      if (!res.ok) this.d.toast(`Could not recalculate: ${res.error ?? 'unknown error'}`, 'error');
    } finally {
      this.busy = false;
      await this.refresh();
    }
  }

  private agentNote(): string | null {
    const r = this.current;
    if (!r) return null;
    const head = `[Result: "${r.title}" (${r.file}, limit ${dot(r.threshold, r.unit)})`;
    const p = this.pinned;
    // FEM: Sicherheit mit Spannung und Verschiebung, damit der Agent die Stelle ohne neue Rechnung einordnen kann
    const extra = p && p.stress != null ? ` (${p.stress.toFixed(1)} MPa${p.disp != null ? `, displacement ${p.disp.toFixed(3)} mm` : ''})` : '';
    return p ? `${head}, part "${p.name}": ${r.fem ? 'safety factor ' : ''}${r.fem && p.value >= SAFETY_CAP ? `over ${SAFETY_CAP}` : dot(p.value, r.unit)}${extra} at (${p.point.map((v) => v.toFixed(1)).join(', ')}) mm] ` : `${head}] `;
  }

  /** Für die Markierung: Welches Ergebnis zu sehen ist (null: keines). */
  agentText(): string | null {
    return this.active && this.current ? `shows the result "${this.current.title}" (${this.current.file})` : null;
  }

  /** Prüfhilfe. */
  state() {
    return {
      active: this.active, id: this.current?.id ?? null, stale: this.current?.stale ?? null, options: [...this.ui.select.options].map((o) => o.textContent),
      rows: [...this.ui.summary.querySelectorAll('.rs-row')].map((x) => x.textContent), probe: this.ui.probe.textContent, hint: this.ui.hint.textContent,
      note: this.agentNote(), meta: this.d.layer.meta ? { threshold: this.d.layer.meta.threshold, unit: this.d.layer.meta.unit } : null,
      tip: this.tip.hidden ? null : `${this.tipVal.textContent} · ${this.tipName.textContent}`,
      scale: { field: this.d.layer.field, mode: this.mode, canStress: this.d.layer.canStress, range: this.d.layer.view?.range ?? null,
        threshold: this.d.layer.view?.threshold ?? null, unit: this.d.layer.view?.unit ?? null, legend: this.ui.legend.textContent },
      fem: this.ui.femRow.hidden ? null : {
        deform: this.ui.deform.value, options: [...this.ui.deform.options].map((o) => o.textContent), bcs: this.ui.bcs.getAttribute('aria-pressed') === 'true',
        scale: this.d.layer.scale, notes: [...this.ui.summary.querySelectorAll('.rs-note')].map((x) => x.textContent),
        bcRows: [...this.ui.summary.querySelectorAll('.rs-row.bc')].map((x) => x.textContent),
      },
    };
  }

  /** Prüfhilfe: Stelle anklicken wie mit der Maus. */
  testPin(x: number, y: number): ResultProbe | null { this.pinned = this.d.layer.probe(x, y); this.showProbe(this.pinned, true); return this.pinned; }
}
