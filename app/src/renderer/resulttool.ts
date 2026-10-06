import type { ResultEntry } from '../shared/types';
import { resultColor } from './overlay';
import type { ResultLayer, ResultProbe } from './resultview';
import { el } from './ui';

// Ergebnisse von `soma analyze` im Viewer (E58): auswählen, farbig zeigen, Wert unter dem Zeiger, an den Agenten geben.
// Gerechnet wird in Python, hier wird nur gezeigt. Neu berechnen nutzt die Angaben, mit denen der Agent es erzeugt hat.

interface Ui {
  card: HTMLElement; button: HTMLButtonElement; close: HTMLButtonElement; select: HTMLSelectElement;
  legend: HTMLElement; summary: HTMLElement; probe: HTMLElement; hint: HTMLElement;
  rerun: HTMLButtonElement; agent: HTMLButtonElement;
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
}

const num = (v: number, unit: string) => (+v.toFixed(unit === '°' ? 1 : 2) + 0).toLocaleString('de-DE'); // + 0: kein „-0“
const withUnit = (v: number, unit: string) => `${num(v, unit)}${unit === '°' ? '°' : ` ${unit}`}`;
const dot = (v: number, unit: string) => `${v.toFixed(unit === '°' ? 1 : 2)}${unit === '°' ? '°' : ` ${unit}`}`;

export class ResultTool {
  private active = false;
  private list: ResultEntry[] = [];
  private current: ResultEntry | null = null;
  /** Zuletzt angeklickte Stelle (für „An Agent geben“). */
  private pinned: ResultProbe | null = null;
  private loading = 0;
  private busy = false;

  constructor(private readonly ui: Ui, private readonly d: Deps) {
    ui.button.addEventListener('click', () => this.setActive(!this.active));
    ui.close.addEventListener('click', () => this.setActive(false));
    ui.select.addEventListener('change', () => { const e = this.list.find((r) => r.id === ui.select.value); if (e) void this.show(e); });
    ui.rerun.addEventListener('click', () => void this.rerun());
    ui.agent.addEventListener('click', () => { const t = this.agentNote(); if (t) d.insert(t); });
    let queued = false, pos: [number, number] = [0, 0];
    ui.viewerEl.addEventListener('pointermove', (e) => {
      if (!this.active || e.buttons) return;
      pos = [e.clientX, e.clientY];
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; this.showProbe(this.d.layer.probe(pos[0], pos[1]), false); });
    });
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

  setActive(on: boolean): void {
    if (on === this.active) return;
    if (on) this.d.beforeOn();
    this.active = on;
    this.ui.card.hidden = !on;
    this.ui.button.setAttribute('aria-pressed', String(on));
    this.ui.viewerEl.classList.toggle('analyzing', on);
    if (on) { void this.refresh(); return; }
    this.loading++;
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
    const want = this.list.find((r) => r.id === this.current?.id) ?? this.list[0];
    if (want) await this.show(want, seq);
    else { this.d.layer.hide(); this.current = null; this.render(); }
  }

  private async show(e: ResultEntry, seq = ++this.loading): Promise<void> {
    try {
      const buf = await this.d.readBinary(e.file);
      if (seq !== this.loading || !this.active) return;
      await this.d.layer.show(buf);
      // Während des Ladens geschlossen oder ein anderes gewählt: nicht stehen lassen
      if (!this.active) { this.d.layer.hide(); return; }
      if (seq !== this.loading) return;
      this.current = e;
      this.ui.select.value = e.id;
      this.pinned = null;
    } catch (err) {
      this.d.toast(`Das Ergebnis ließ sich nicht laden: ${err instanceof Error ? err.message : String(err)}`, 'error');
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
    this.ui.hint.classList.toggle('warn', !!r?.stale);
    if (!r) {
      this.ui.hint.textContent = 'Noch kein Ergebnis. Der Agent erzeugt es mit soma analyze (Überhang, Wandstärke, Abstand).';
      return;
    }
    this.ui.hint.textContent = this.busy ? 'Wird neu berechnet …' : r.stale ? 'Älter als der Code. „Neu berechnen“ wertet das aktuelle Modell aus.' : `soma ${r.command.join(' ')}`;
    // Legende: Verlauf über die Spanne, Grenzwert als Strich
    const [lo, hi] = r.range;
    const stops = Array.from({ length: 24 }, (_, i) => {
      const c = resultColor(lo + ((hi - lo) * i) / 23, r);
      return `rgb(${c.map(Math.round).join(',')}) ${((i / 23) * 100).toFixed(1)}%`;
    });
    const bar = el('div', { className: 'rs-bar' });
    bar.style.background = `linear-gradient(to right, ${stops.join(', ')})`;
    const mark = el('div', { className: 'rs-mark' });
    mark.style.left = `${Math.max(0, Math.min(100, ((r.threshold - lo) / (hi - lo || 1)) * 100))}%`;
    bar.append(mark);
    this.ui.legend.append(
      el('div', { className: 'rs-q', textContent: `${r.quantity} (${r.unit})` }), bar,
      el('div', { className: 'rs-scale' }, el('span', { textContent: withUnit(lo, r.unit) }),
        el('span', { className: 'rs-thr', textContent: `Grenze ${withUnit(r.threshold, r.unit)}, kritisch ${r.bad === 'high' ? 'darüber' : 'darunter'}` }),
        el('span', { textContent: withUnit(hi, r.unit) })),
    );
    for (const p of r.parts) {
      const range = p.min != null && p.max != null ? `${withUnit(p.min, r.unit)} bis ${withUnit(p.max, r.unit)}` : 'keine Werte';
      const crit = p.critical > 0 ? `${(p.critical / 100).toLocaleString('de-DE', { maximumFractionDigits: 2 })} cm² kritisch` : 'nichts kritisch';
      this.ui.summary.append(el('div', { className: 'rs-row' + (p.critical > 0 ? ' bad' : '') },
        el('b', { textContent: p.name }), el('span', { textContent: `${range} · ${crit}` })));
    }
    this.showProbe(this.pinned, true);
  }

  private showProbe(p: ResultProbe | null, pinned: boolean): void {
    const r = this.current;
    if (!r) return;
    if (!p) { if (!pinned || !this.pinned) this.ui.probe.textContent = this.pinned ? this.probeText(this.pinned, true) : 'Zeiger aufs Modell: Wert an der Stelle. Klick merkt sie für den Agenten.'; return; }
    this.ui.probe.textContent = this.probeText(p, pinned);
  }

  private probeText(p: ResultProbe, pinned: boolean): string {
    const r = this.current!;
    return `${pinned ? 'Gewählt' : 'Zeiger'}: ${p.name}, ${withUnit(p.value, r.unit)} bei (${p.point.map((v) => (v + 0).toLocaleString('de-DE')).join('; ')})`;
  }

  private async rerun(): Promise<void> {
    const r = this.current;
    if (!r || this.busy) return;
    this.busy = true;
    this.render();
    try {
      const res = await this.d.rerun(r.id);
      if (!res.ok) this.d.toast(`Neu berechnen ging nicht: ${res.error ?? 'unbekannter Fehler'}`, 'error');
    } finally {
      this.busy = false;
      await this.refresh();
    }
  }

  private agentNote(): string | null {
    const r = this.current;
    if (!r) return null;
    const head = `[Ergebnis: "${r.title}" (${r.file}, Grenzwert ${dot(r.threshold, r.unit)})`;
    const p = this.pinned;
    return p ? `${head}, Bauteil "${p.name}": ${dot(p.value, r.unit)} bei (${p.point.map((v) => v.toFixed(1)).join(', ')}) mm] ` : `${head}] `;
  }

  /** Für die Markierung: Welches Ergebnis zu sehen ist (null: keines). */
  agentText(): string | null {
    return this.active && this.current ? `zeigt das Ergebnis „${this.current.title}“ (${this.current.file})` : null;
  }

  /** Prüfhilfe. */
  state() {
    return {
      active: this.active, id: this.current?.id ?? null, stale: this.current?.stale ?? null, options: [...this.ui.select.options].map((o) => o.textContent),
      rows: [...this.ui.summary.querySelectorAll('.rs-row')].map((x) => x.textContent), probe: this.ui.probe.textContent, hint: this.ui.hint.textContent,
      note: this.agentNote(), meta: this.d.layer.meta ? { threshold: this.d.layer.meta.threshold, unit: this.d.layer.meta.unit } : null,
    };
  }

  /** Prüfhilfe: Stelle anklicken wie mit der Maus. */
  testPin(x: number, y: number): ResultProbe | null { this.pinned = this.d.layer.probe(x, y); this.showProbe(this.pinned, true); return this.pinned; }
}
