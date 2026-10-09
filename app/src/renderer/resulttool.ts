import * as THREE from 'three';
import type { ResultEntry } from '../shared/types';
import { icon } from './icons';
import { resultColor } from './overlay';
import { fmtScale, type ResultField, type ResultLayer, type ResultProbe } from './resultview';
import { el, menus } from './ui';
import type { Viewer } from './viewer';

// Ergebnisse von `soma analyze` im Viewer (E58, E82): farbig zeigen, Wert unter dem Zeiger, eine Stelle für den Agenten merken.
// Gerechnet wird in Python, hier wird nur gezeigt. Im Bild stehen die Legende senkrecht am rechten Rand, die Darstellung in einer
// Leiste unten (mit dem × zurück zum Modell) und bei FEM die Kraft und der kleinste Wert als Beschriftung. Den Bericht mit
// Annahmen und Zahlen zeigt der Reiter Analysis (analysispanel.ts), er liest den Zustand hier.

interface Ui {
  /** Schmale Legende: Größe kurz, Knopf zur Skala (zeigt die Spanne), Verlauf mit Grenzwert. */
  legend: HTMLElement; legendTitle: HTMLElement; legendBody: HTMLElement; scaleBtn: HTMLButtonElement; scaleMode: HTMLElement;
  /** Menü der Skala: Größe ausgeschrieben, Spanne, eigene Grenzen, was die Farben heißen. */
  scaleMenu: HTMLElement; legendFull: HTMLElement; legendFoot: HTMLElement;
  range: HTMLElement; custom: HTMLElement; lo: HTMLInputElement; hi: HTMLInputElement;
  /** Leiste unten im Bild: gezeigte Größe (nur FEM), Überhöhung der Verformung (nur FEM), Lastfall, Name, ×. */
  bar: HTMLElement; field: HTMLElement; deform: HTMLElement; deformLabel: HTMLElement; bcs: HTMLButtonElement; name: HTMLElement; close: HTMLButtonElement;
  viewerEl: HTMLElement;
}
interface Deps {
  layer: ResultLayer;
  viewer: Viewer;
  list(): Promise<ResultEntry[]>;
  rerun(id: string): Promise<{ ok: boolean; error?: string }>;
  readBinary(rel: string): Promise<ArrayBuffer>;
  beforeOn(): void;
  toast(text: string, kind?: 'ok' | 'info' | 'error'): void;
  /** An, aus, ein anderes Ergebnis, neu berechnet oder eine Stelle gemerkt: Reiter, Baum und Leiste ziehen nach. */
  changed(): void;
}

const num = (v: number, unit: string) => (+v.toFixed(unit === '°' ? 1 : 2) + 0).toLocaleString('en-US'); // + 0: kein „-0“
// Ohne Einheit (Sicherheitsfaktor der FEM) steht die Zahl allein
export const withUnit = (v: number, unit: string) => `${num(v, unit)}${unit === '°' ? '°' : unit ? ` ${unit}` : ''}`;
const dot = (v: number, unit: string) => `${v.toFixed(unit === '°' ? 1 : 2)}${unit === '°' ? '°' : unit ? ` ${unit}` : ''}`;
export const loc = (v: number, digits: number) => (+v.toFixed(digits) + 0).toLocaleString('en-US');
/** Höchster Sicherheitsfaktor in der Datei (soma.fem VALUE_CAP): Dort ist kaum Spannung, der Wert selbst sagt nichts. */
export const SAFETY_CAP = 99;
export const safety = (v: number) => (v >= SAFETY_CAP ? `over ${SAFETY_CAP}` : loc(v, 2));
/** FEM an einer Stelle: die gezeigte Größe zuerst, dann die anderen. */
const femAt = (p: ResultProbe, field: ResultField, label: boolean) => {
  const stress = p.stress != null ? `${loc(p.stress, 1)} MPa` : null;
  const disp = p.disp != null ? `${loc(p.disp, 3)} mm` : null;
  const sf = `${label || field !== 'value' ? 'Safety ' : ''}${safety(p.value)}`;
  const parts = field === 'stress' ? [stress, sf, disp] : field === 'disp' ? [disp, sf, stress] : [sf, stress, disp];
  return parts.filter(Boolean).join(' · ');
};
type RangeMode = 'auto' | 'minmax' | 'custom';
/** Abstand des Schilds vom Zeiger (px): neben den Armen des Fadenkreuzes, nicht darauf. */
const TIP_GAP = 14;
/** Höhe des Verlaufs in der Legende (px). */
const LEGEND_H = 160;
const RANGE_LABEL: Record<RangeMode, string> = { auto: 'Auto', minmax: 'Min–max', custom: 'Custom' };
const FIELD_LABEL: Record<ResultField, string> = { value: 'Safety factor', stress: 'Stress', disp: 'Displacement' };

/** Kleinster Wert (kritisch darunter) oder größter (kritisch darüber) über alle Teile, mit dem Teil. */
export function worstOf(r: ResultEntry): { part: string; value: number; at: number[] | null } | null {
  let best: { part: string; value: number; at: number[] | null } | null = null;
  for (const p of r.parts) {
    const v = r.bad === 'low' ? p.min : p.max;
    if (v == null) continue;
    if (!best || (r.bad === 'low' ? v < best.value : v > best.value)) best = { part: p.name, value: v, at: p.worst?.at ?? null };
  }
  return best;
}

export class ResultTool {
  private active = false;
  private entries: ResultEntry[] = [];
  private current: ResultEntry | null = null;
  /** Zuletzt angeklickte Stelle (für „An Agent geben“). */
  private pinned: ResultProbe | null = null;
  /** Stelle, die der Bericht zeigen soll („Show the spot“): Teil, an dem die Beschriftung steht. */
  private spot: string | null = null;
  private loading = 0;
  private rerunning = false;
  /** Beim nächsten Laden dieses Ergebnis zeigen. */
  private want: string | null = null;
  /** Zuletzt gezeigtes Ergebnis: Der Reiter Analysis bringt es wieder. */
  private lastId: string | null = null;
  // Farbskala: Die Wahl gilt über Ergebnisse hinweg, eigene Grenzen nur für dasselbe Ergebnis und dieselbe Größe
  // (nach „Neu berechnen“ bleibt die Skala, die Farben bleiben vergleichbar)
  private field: ResultField = 'value';
  private mode: RangeMode = 'auto';
  private custom: { key: string; range: [number, number] } | null = null;
  // Schild am Zeiger: Der Wert steht dort, wo man hinschaut. Ein einziges Element, das nur verschoben und per textContent
  // befüllt wird (Bauteilnamen kommen aus dem Projekt).
  private readonly tipDot = el('span', { className: 'rs-tip-dot' });
  private readonly tipVal = el('b');
  private readonly tipName = el('div', { className: 'rs-tip-n' });
  private readonly tip = el('div', { className: 'rs-tip', hidden: true }, el('div', { className: 'rs-tip-v' }, this.tipDot, this.tipVal), this.tipName);

  constructor(private readonly ui: Ui, private readonly d: Deps) {
    ui.close.addEventListener('click', () => this.setActive(false));
    ui.bcs.addEventListener('click', () => { d.layer.setBcsVisible(!d.layer.bcsVisible); this.renderBar(); this.renderTags(); });
    // Links neben der Legende, damit der Verlauf beim Einstellen zu sehen bleibt
    ui.scaleBtn.addEventListener('click', () => {
      menus.toggle(ui.scaleMenu, ui.legend, 'beside', () => ui.scaleBtn.setAttribute('aria-expanded', 'false'));
      ui.scaleBtn.setAttribute('aria-expanded', String(menus.isOpen(ui.scaleMenu)));
    });
    for (const b of ui.range.querySelectorAll<HTMLButtonElement>('[data-range]')) {
      b.addEventListener('click', () => { this.mode = b.dataset.range as RangeMode; this.applyScale(); this.renderLegend(); });
    }
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
    let queued = false, pos: [number, number] | null = null;
    const leave = () => { pos = null; this.hideTip(); };
    const track = (e: MouseEvent) => {
      if (!this.active) return;
      // Beim Drehen und Verschieben bliebe das Schild mit altem Wert stehen
      if (e.buttons) { pos = null; this.hideTip(); return; }
      // Über Baum, Leisten, Würfel oder Video kein Wert vom Modell dahinter
      if (!this.overImage(e.target)) { leave(); return; }
      pos = [e.clientX, e.clientY];
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        if (!pos || !this.active) return;
        this.showTip(this.d.layer.probe(pos[0], pos[1]), pos);
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
      if (!this.overImage(e.target)) return;
      this.pinned = this.d.layer.probe(e.clientX, e.clientY);
      this.d.changed();
    });
  }

  get isActive(): boolean { return this.active; }
  /** Gezeigtes Ergebnis (null: keines geladen). */
  get shown(): ResultEntry | null { return this.active ? this.current : null; }
  get currentTitle(): string | null { return this.shown?.title ?? null; }
  get currentId(): string | null { return this.shown?.id ?? null; }
  /** Alle Ergebnisse, wie zuletzt gelesen. */
  get list(): ResultEntry[] { return this.entries; }
  get busy(): boolean { return this.rerunning; }
  get picked(): ResultProbe | null { return this.pinned; }

  /** Ein bestimmtes Ergebnis zeigen, null: das zuletzt gezeigte, beim ersten Mal das neueste. */
  show(id: string | null): void {
    this.want = id ?? this.lastId;
    if (!this.active) { this.setActive(true); return; }
    const e = this.want ? this.entries.find((r) => r.id === this.want) : undefined;
    this.want = null;
    if (e && e.id !== this.current?.id) void this.load(e);
  }

  setActive(on: boolean): void {
    if (on === this.active) return;
    if (on) this.d.beforeOn();
    this.active = on;
    this.ui.viewerEl.classList.toggle('analyzing', on);
    if (on) { this.renderAll(); this.d.changed(); void this.refresh(); return; }
    this.loading++;
    this.hideTip();
    this.d.layer.hide();
    this.current = null;
    this.pinned = null;
    this.spot = null;
    this.renderAll();
    this.d.changed();
  }

  /** Liste neu lesen (Einschalten, neuer Build, nach einer Auswertung) und das gewählte Ergebnis neu laden. */
  async refresh(): Promise<void> {
    const seq = ++this.loading;
    let list: ResultEntry[];
    try { list = await this.d.list(); } catch { return; }
    if (seq !== this.loading) return;
    this.entries = list;
    if (!this.active) { this.d.changed(); return; }
    const newest = [...list].sort((a, b) => b.created - a.created)[0];
    const want = list.find((r) => r.id === (this.want ?? this.current?.id)) ?? newest;
    this.want = null;
    if (want) await this.load(want, seq);
    else { this.d.layer.hide(); this.current = null; this.renderAll(); this.d.changed(); }
  }

  /** Liste von außen (Reiter Analysis liest sie ohnehin), ohne das gezeigte Ergebnis neu zu laden. */
  setList(list: ResultEntry[]): void {
    this.entries = list;
    // Die Zahlen im Bericht folgen der Datei (veraltet, neu gerechnet): Das gezeigte Ergebnis lädt nur neu, wenn es sich geändert hat
    const now = this.current ? list.find((r) => r.id === this.current!.id) : undefined;
    if (this.active && now && now.created !== this.current!.created) void this.load(now);
    else if (this.active && now) this.current = now;
  }

  private async load(e: ResultEntry, seq = ++this.loading): Promise<void> {
    try {
      const buf = await this.d.readBinary(e.file);
      if (seq !== this.loading || !this.active) return;
      await this.d.layer.show(buf);
      // Während des Ladens geschlossen oder ein anderes gewählt: nicht stehen lassen
      if (!this.active) { this.d.layer.hide(); return; }
      if (seq !== this.loading) return;
      if (this.current?.id !== e.id) { this.pinned = null; this.spot = null; }
      this.current = e;
      this.lastId = e.id;
      this.applyScale();
    } catch (err) {
      this.d.toast(`Could not load the result: ${err instanceof Error ? err.message : String(err)}`, 'error');
    }
    this.renderAll();
    this.d.changed();
  }

  private renderAll(): void {
    // Anderes Ergebnis oder neu berechnet: Der Wert im Schild gilt nicht mehr, die nächste Bewegung holt den neuen
    this.hideTip();
    const has = this.active && !!this.current;
    this.ui.legend.hidden = !has;
    this.ui.bar.hidden = !this.active;
    this.renderLegend();
    this.renderBar();
    this.renderTags();
  }

  /** Legende senkrecht am Rand: oben das größte, unten das kleinste, der Grenzwert als Strich mit Zahl. */
  private renderLegend(): void {
    const v = this.d.layer.view, r = this.current;
    this.ui.legendBody.replaceChildren();
    if (!v || !r || !this.active) return;
    const [lo, hi] = v.range;
    const y = (x: number) => ((hi - x) / (hi - lo || 1)) * LEGEND_H;
    const stops = Array.from({ length: 31 }, (_, i) => {
      const c = resultColor(hi - ((hi - lo) * i) / 30, v);
      return `rgb(${c.map(Math.round).join(',')}) ${((i / 30) * 100).toFixed(1)}%`;
    });
    const bar = el('div', { className: 'lg-bar' });
    bar.style.background = `linear-gradient(to bottom, ${stops.join(', ')})`;
    const ticks = [hi, lo + (hi - lo) * 0.5, lo].map((x) => {
      const t = el('span', { className: 'lg-t', textContent: withUnit(+x.toPrecision(3), '') });
      t.style.top = `${y(x).toFixed(1)}px`;
      return t;
    });
    this.ui.legendBody.append(bar, ...ticks);
    // Grenzwert außerhalb einer gewählten Spanne oder ohne Grenzwert (Verschiebung): kein Strich, der eine Grenze vortäuschen würde
    if (Number.isFinite(v.threshold) && v.threshold >= lo && v.threshold <= hi) {
      // Schmal: nur die Zahl, das Wort steht im Hinweis und im Menü der Skala
      const word = r.fem ? (this.d.layer.field === 'stress' ? 'allowable' : 'required') : 'limit';
      const thr = el('div', { className: 'lg-thr', title: `${withUnit(v.threshold, v.unit)} ${word}` }, el('i'), el('span', { textContent: withUnit(v.threshold, '') }));
      thr.style.top = `${y(v.threshold).toFixed(1)}px`;
      // Zahlen der Teilung, die unter dem Strich lägen, weichen
      for (const t of ticks) if (Math.abs(parseFloat(t.style.top) - y(v.threshold)) < 14) t.hidden = true;
      this.ui.legendBody.append(thr);
    }
    // Kopf kurz (Einheit, bei der Sicherheit „Safety“), ausgeschrieben im Hinweis und im Menü
    const full = v.unit ? `${v.quantity} (${v.unit})` : v.quantity;
    this.ui.legendTitle.textContent = v.unit || (r.fem ? 'Safety' : v.quantity);
    this.ui.legendTitle.title = full;
    this.ui.legendFull.textContent = full;
    this.ui.scaleMode.textContent = RANGE_LABEL[this.mode];
    const weakest = this.d.layer.field === 'stress' && this.d.layer.stressLimitMixed ? ' (weakest material)' : '';
    const foot = [
      !Number.isFinite(v.threshold) ? 'No limit, color across the range'
        : v.ramp ? `Color across the range, limit ${withUnit(v.threshold, v.unit)}${weakest}`
          : `Red: ${v.bad === 'high' ? 'above' : 'below'} ${r.fem ? (this.d.layer.field === 'stress' ? 'allowable' : 'required') : 'the limit'}${weakest}`,
      this.d.layer.deformNote(),
    ].filter((x): x is string => !!x);
    this.ui.legendFoot.replaceChildren(...foot.flatMap((t, i) => (i ? [el('br'), t] : [t])));
    this.ui.legend.title = foot.join('\n');
  }

  /** Leiste unten im Bild. Ohne FEM gibt es nur den Namen und das ×. */
  private renderBar(): void {
    const l = this.d.layer, r = this.current;
    const fem = !!r?.fem && this.active;
    this.ui.name.hidden = fem || !r;
    this.ui.name.textContent = r?.title ?? '';
    this.ui.field.hidden = !fem;
    this.ui.deform.hidden = this.ui.deformLabel.hidden = !fem || l.autoScale <= 0;
    this.ui.bcs.hidden = !fem;
    for (const sep of this.ui.bar.querySelectorAll<HTMLElement>('.vsep[data-fem]')) sep.hidden = !fem;
    if (!fem) return;
    const fields: ResultField[] = ['value', ...(l.canStress ? ['stress' as const] : []), ...(l.canDisp ? ['disp' as const] : [])];
    this.ui.field.replaceChildren(...fields.map((f) => {
      const b = el('button', { textContent: FIELD_LABEL[f], className: l.field === f ? 'on' : '' });
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(l.field === f));
      b.dataset.field = f;
      b.addEventListener('click', () => { this.field = f; this.applyScale(); this.renderLegend(); this.renderBar(); this.renderTags(); this.d.changed(); });
      return b;
    }));
    const scales: [number, string][] = [[0, 'Off'], [1, '1×']];
    if (l.autoScale > 1) scales.push([l.autoScale, `${fmtScale(l.autoScale)}×`]);
    this.ui.deform.replaceChildren(...scales.map(([s, t]) => {
      const b = el('button', { textContent: t, className: l.scale === s ? 'on' : '', title: s === 0 ? 'Undeformed' : s === 1 ? 'Deformation at true scale' : `Deformation exaggerated ${fmtScale(s)} times so you can see it` });
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(l.scale === s));
      b.dataset.scale = String(s);
      b.addEventListener('click', () => { l.setScale(s); this.hideTip(); this.renderBar(); this.renderLegend(); this.renderTags(); });
      return b;
    }));
    this.ui.bcs.setAttribute('aria-pressed', String(l.bcsVisible));
  }

  /**
   * Beschriftungen im Bild: Kraft am Ende jedes Pfeils (nur mit Lastfall), der kleinste Wert und die Stelle, die der Bericht
   * zeigen soll. Ein ausgeblendetes Teil hat keine Beschriftung.
   */
  renderTags(): void {
    const r = this.current, l = this.d.layer;
    if (!this.active || !r || !l.meta) { this.d.viewer.setTags(null); return; }
    const visible = (name: string) => {
      const p = this.d.viewer.partList().find((x) => x.name === name);
      return !p || this.d.viewer.isVisible(p.id);
    };
    const tags: { el: HTMLElement; at: number[] }[] = [];
    if (r.fem && l.bcsVisible) {
      for (const t of l.arrowTails()) {
        const b = r.fem.bcs[t.bc];
        const total = b?.total;
        if (!b || !total) continue;
        tags.push({ el: el('div', { className: 'c3d' }, icon('force', 13, 2.2), el('b', { textContent: `${loc(Math.hypot(total[0], total[1], total[2]), 1)} N` })), at: t.at });
      }
    }
    const spotTag = (part: string, label: string, value: string) => {
      const p = r.parts.find((x) => x.name === part);
      const at = p?.worst?.at;
      if (!p || !at || !visible(part)) return;
      const d = el('span', { className: 'dot' });
      d.style.background = p.critical > 0 ? 'var(--err)' : 'var(--ok)';
      tags.push({ el: el('div', { className: 'c3d pt' }, d, label, el('b', { textContent: value })), at: l.shownAt(part, at) });
    };
    const w = worstOf(r);
    const val = (v: number) => (r.fem ? safety(v) : withUnit(v, r.unit));
    // Der Extremwert der gezeigten Größe: kleinste Sicherheit, höchste Spannung oder größte Verschiebung
    const peak = (key: 'stress' | 'displacement', unit: string, digits: number) => {
      let best: { name: string; value: number; at: number[] } | null = null;
      for (const p of r.parts) { const x = p[key]; if (x && (!best || x.value > best.value)) best = { name: p.name, value: x.value, at: x.at }; }
      if (!best || !visible(best.name)) return;
      const d = el('span', { className: 'dot' });
      d.style.background = 'var(--tx2)';
      tags.push({ el: el('div', { className: 'c3d pt' }, d, 'Max ', el('b', { textContent: `${loc(best.value, digits)} ${unit}` })), at: l.shownAt(best.name, best.at) });
    };
    if (l.field === 'stress') peak('stress', 'MPa', 1);
    else if (l.field === 'disp') peak('displacement', 'mm', 3);
    else if (w) spotTag(w.part, 'Min ', val(w.value));
    if (this.spot && this.spot !== w?.part) {
      const p = r.parts.find((x) => x.name === this.spot);
      const v = p ? (r.bad === 'low' ? p.min : p.max) : undefined;
      if (p && v != null) spotTag(p.name, `${p.name} `, val(v));
    }
    this.d.viewer.setTags(tags);
  }

  /** Bericht „Show the spot“: Blick auf die ungünstigste Stelle des Teils, mit Beschriftung. */
  showSpot(part: string): void {
    const r = this.current, p = r?.parts.find((x) => x.name === part);
    const at = p?.worst?.at;
    if (!r || !p || !at) return;
    this.spot = part;
    // Ausgeblendet bleibt ausgeblendet (der Baum gehört dem Nutzer), die Meldung sagt, warum nichts zu sehen ist
    const ids = this.d.viewer.partList().filter((x) => x.name === part).map((x) => x.id);
    if (ids.length && ids.every((id) => !this.d.viewer.isVisible(id))) this.d.toast(`${part} is hidden. Show it in the structure tree to see the spot.`, 'info');
    const q = this.d.layer.shownAt(part, at);
    this.d.viewer.setPivot(new THREE.Vector3(q[0], q[1], q[2]));
    this.renderTags();
    this.d.changed();
  }

  /** Größe und Spanne an die Ebene geben und die Auswahl in der Legende nachziehen. */
  private applyScale(): void {
    const l = this.d.layer, r = this.current;
    if (!l.meta || !r) return;
    const field: ResultField = this.field === 'stress' && l.canStress ? 'stress' : this.field === 'disp' && l.canDisp ? 'disp' : 'value';
    let range: [number, number] | null = null;
    if (this.mode === 'minmax') range = l.dataRange(field);
    else if (this.mode === 'custom') {
      const key = `${r.id}/${field}`;
      if (this.custom?.key !== key) this.custom = { key, range: l.autoRange(field).map((x) => +x.toPrecision(3)) as [number, number] };
      range = this.custom.range;
    }
    l.setDisplay(field, range);
    for (const b of this.ui.range.querySelectorAll<HTMLButtonElement>('[data-range]')) b.setAttribute('aria-checked', String(b.dataset.range === this.mode));
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

  /**
   * Frei über dem Bild? Die Ebenen darüber (Beschriftungen, Malfläche, dieses Schild) lassen den Zeiger durch, das Ziel ist
   * dann die 3D-Fläche selbst. Baum, Leisten, Würfel und Video sind eigene Elemente und zählen nicht.
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

  /** Teil aus- oder eingeblendet: Der Wert unter dem Zeiger gilt nicht mehr, die Beschriftungen folgen. */
  forgetProbe(): void { if (this.active) { this.hideTip(); this.renderTags(); } }

  /** Gemerkte Stelle als Zeile für den Bericht (null: keine). */
  pickText(): string | null {
    const p = this.pinned, r = this.current;
    if (!p || !r) return null;
    const what = r.fem ? femAt(p, this.d.layer.field, true) : withUnit(p.value, r.unit);
    return `Picked: ${p.name}, ${what} at (${p.point.map((v) => (v + 0).toLocaleString('en-US')).join(', ')})`;
  }

  async rerun(): Promise<void> {
    const r = this.current;
    if (!r || this.rerunning) return;
    this.rerunning = true;
    this.d.changed();
    try {
      const res = await this.d.rerun(r.id);
      if (!res.ok) this.d.toast(`Could not recalculate: ${res.error ?? 'unknown error'}`, 'error');
    } finally {
      this.rerunning = false;
      await this.refresh();
    }
  }

  agentNote(): string | null {
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
    const l = this.d.layer;
    return {
      active: this.active, id: this.current?.id ?? null, stale: this.current?.stale ?? null, busy: this.rerunning,
      options: this.entries.map((r) => r.title), probe: this.pickText(), note: this.agentNote(),
      meta: l.meta ? { threshold: l.meta.threshold, unit: l.meta.unit } : null,
      tip: this.tip.hidden ? null : `${this.tipVal.textContent} · ${this.tipName.textContent}`,
      tags: [...this.ui.viewerEl.querySelectorAll('.v-overlay .c3d')].map((x) => x.textContent),
      // Nur was zu sehen ist (ohne FEM fehlen Größe, Verformung und Lastfall)
      bar: this.ui.bar.hidden ? null : [...this.ui.bar.children].filter((c) => !(c as HTMLElement).hidden).map((c) => c.textContent?.trim()).filter(Boolean).join(' · '),
      scale: { field: l.field, mode: this.mode, canStress: l.canStress, canDisp: l.canDisp, range: l.view?.range ?? null,
        threshold: l.view?.threshold ?? null, unit: l.view?.unit ?? null, legend: this.ui.legend.hidden ? '' : `${this.ui.legend.textContent ?? ''} ${this.ui.scaleMenu.textContent ?? ''}`.replace(/\s+/g, ' ').trim() },
      fem: this.current?.fem && this.active ? {
        deform: String(l.scale), options: [...this.ui.deform.querySelectorAll('button')].map((o) => o.textContent),
        fields: [...this.ui.field.querySelectorAll('button')].map((o) => o.textContent), bcs: l.bcsVisible, scale: l.scale,
      } : null,
    };
  }

  /** Prüfhilfe: Stelle anklicken wie mit der Maus. */
  testPin(x: number, y: number): ResultProbe | null { this.pinned = this.d.layer.probe(x, y); this.d.changed(); return this.pinned; }
  /** Prüfhilfe: Größe wählen wie in der Leiste. */
  testField(f: ResultField): void { this.ui.field.querySelector<HTMLButtonElement>(`[data-field="${f}"]`)?.click(); }
  /** Prüfhilfe: Überhöhung wählen wie in der Leiste (0, 1 oder die vorgeschlagene). */
  testDeform(s: number): void { this.ui.deform.querySelector<HTMLButtonElement>(`[data-scale="${s}"]`)?.click(); }
}
