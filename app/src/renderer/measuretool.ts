import type { MeasureInfo, MeasureResponse, MeasureResult, MeasureSource, MeasureSpan, PartMap } from '../shared/types';
import { el } from './ui';
import type { MeasureMarks, ProbeHit, Viewer } from './viewer';

interface Ui {
  card: HTMLElement; body: HTMLElement;
  /** Knopf „Messen“ im Viewer (schaltet den Modus), Schließen, Neu messen, An Agent geben. */
  button: HTMLButtonElement; close: HTMLButtonElement; again: HTMLButtonElement; agent: HTMLButtonElement;
  /** Bekommt die Klasse `measuring`, solange gemessen wird (die Auswahlkarte tritt dann zurück). */
  viewerEl: HTMLElement;
}
interface Deps {
  viewer: Viewer;
  /** Aktueller Stand oder Vorschau eines alten Stands. */
  source(): MeasureSource;
  /** Kennung des angezeigten Builds (aus model.map.json). */
  build(): string | null;
  part(id: string): PartMap | undefined;
  insert(text: string): void;
}

const TYPE: Record<string, string> = {
  PLANE: 'eben', CYLINDER: 'Zylinder', CONE: 'Kegel', SPHERE: 'Kugel', TORUS: 'Torus', BSPLINE: 'Freiform', BEZIER: 'Freiform',
  REVOLUTION: 'Drehfläche', EXTRUSION: 'Extrusionsfläche', OFFSET: 'Versatzfläche', OTHER: 'sonstige',
  LINE: 'Gerade', CIRCLE: 'Kreis', ELLIPSE: 'Ellipse', HYPERBOLA: 'Hyperbel', PARABOLA: 'Parabel', VERTEX: 'Punkt',
};
const KIND: Record<string, string> = { face: 'Fläche', edge: 'Kante', vertex: 'Punkt' };
/** „Fläche · eben“, „Kante · Kreis“, beim Eckpunkt nur „Punkt“. */
const what = (i: { kind: string; type: string }, sep = ' · ') => (i.kind === 'vertex' ? 'Punkt' : `${KIND[i.kind]}${sep}${typeName(i.type)}`);
/** Lage eines Punkts: „X 20,00 · Y −15,00 · Z 5,00“. */
const coords = (p: number[]) => p.map((v, k) => `${'XYZ'[k]} ${minus((Math.abs(v) < 5e-4 ? 0 : v).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))}`).join(' · ');
const typeName = (t: string) => TYPE[t] ?? t.toLowerCase();
const mm = (v: number) => `${v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} mm`;
const mm2 = (v: number) => `${v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} mm²`;
const deg = (v: number) => `${v.toLocaleString('de-DE', { maximumFractionDigits: 1 })}°`;
const minus = (s: string) => s.replace(/^-/, '−');
/** Für den Agenten: Punkt als Dezimalzeichen, drei Stellen, kein „-0“. */
const f3 = (v: number) => (Math.abs(v) < 5e-4 ? 0 : v).toFixed(3);
const vec = (d: number[]) => `(${d.map((x) => +(Math.abs(x) < 5e-7 ? 0 : x).toFixed(4)).join(', ')})`;

/** Richtung in Worten: entlang einer Achse „+Z“, sonst die Komponenten. */
function dirText(d: number[]): string {
  const len = Math.hypot(d[0], d[1], d[2]) || 1;
  for (let i = 0; i < 3; i++) if (Math.abs(Math.abs(d[i]) / len - 1) < 1e-6) return `${d[i] > 0 ? '+' : '−'}${'XYZ'[i]}`;
  return `(${d.map((x) => minus((x / len).toLocaleString('de-DE', { maximumFractionDigits: 3 }))).join(' · ')})`;
}
const mid = (a: number[], b: number[]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
const same = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-3;

/**
 * Messen (E9, E22): Im Messmodus wählt ein Klick einen Eckpunkt, eine Kante oder eine Fläche. Der erste Klick zeigt die
 * exakten Werte (Lage, Durchmesser, Länge, Fläche, Normale), der zweite Abstand und Winkel zum ersten, der dritte beginnt von vorn.
 * Gerechnet wird im Python-Dienst an der exakten Geometrie, der Viewer liefert nur, was angeklickt wurde.
 */
export class MeasureTool {
  private active = false;
  private a: ProbeHit | null = null;
  private b: ProbeHit | null = null;
  private result: MeasureResult | null = null;
  private error = '';
  private busy = false;
  private seq = 0;
  private warm = false;
  /** Einmaliger Hinweis, etwa nach einem Klick auf die Schnittfläche. Verschwindet beim nächsten Klick. */
  private note = '';

  constructor(private ui: Ui, private deps: Deps) {
    ui.button.addEventListener('click', () => this.setActive(!this.active));
    ui.close.addEventListener('click', () => this.setActive(false));
    ui.again.addEventListener('click', () => this.reset());
    ui.agent.addEventListener('click', () => { const t = this.agentText(); if (t) deps.insert(t); });
    deps.viewer.onMeasurePick = (h) => void this.pick(h);
    // Die Schnittfläche hat keine exakte Geometrie. Der Klick verwirft nichts, ein Hinweis sagt, was geht.
    deps.viewer.onMeasureCut = () => { this.note = 'Die Schnittfläche selbst lässt sich nicht messen. Ein Klick nahe ihrem Rand wählt die geschnittene Fläche.'; this.render(); };
    window.addEventListener('keydown', (e) => {
      if (!this.active || e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('#terminals, #code-view, input, textarea, .menu')) return;
      e.preventDefault();
      // Erst die Messung verwerfen, beim zweiten Mal den Modus verlassen
      if (this.a) this.reset(); else this.setActive(false);
    });
    this.render();
  }

  get isActive(): boolean { return this.active; }

  setActive(on: boolean): void {
    this.active = on;
    this.ui.button.setAttribute('aria-pressed', String(on));
    this.ui.viewerEl.classList.toggle('measuring', on);
    this.deps.viewer.setMode(on ? 'measure' : 'select');
    this.clear();
    this.render();
  }

  /** Neuer Build oder anderer Stand: Die IDs der Flächen und Kanten gelten nicht mehr. */
  reset(): void { this.clear(); this.render(); }

  private clear(): void {
    this.a = this.b = null;
    this.result = null;
    this.error = '';
    this.busy = false;
    this.seq++;
    this.deps.viewer.setMeasureMarks(null);
  }

  private async pick(h: ProbeHit | null): Promise<void> {
    this.note = '';
    if (!h) { if (this.a) this.reset(); else this.render(); return; } // daneben geklickt: von vorn
    const sameAsA = this.a && !this.b && this.a.partId === h.partId && this.a.kind === h.kind && this.a.id === h.id;
    if (!this.a || this.b || sameAsA) { this.a = h; this.b = null; } else this.b = h;
    this.result = null;
    this.error = '';
    this.deps.viewer.setMeasureMarks({ entities: this.entities(), points: [], lines: [] });
    await this.query();
  }

  private entities(): MeasureMarks['entities'] {
    return [this.a, this.b].filter((x): x is ProbeHit => !!x).map((x) => ({ partId: x.partId, kind: x.kind, id: x.id }));
  }

  private async query(): Promise<void> {
    const build = this.deps.build();
    if (!build) { this.error = 'Zu diesem Stand gibt es keine Geometrie zum Messen. Einmal neu bauen hilft.'; this.render(); return; }
    const seq = ++this.seq;
    this.busy = true;
    this.render();
    const ent = (x: ProbeHit) => ({ part: x.partId, kind: x.kind, id: x.id, point: x.point, check: x.size ?? undefined });
    let r: MeasureResponse;
    try { r = await window.soma.measure.query(this.deps.source(), { build, a: ent(this.a!), ...(this.b ? { b: ent(this.b) } : {}) }); }
    catch (e) { r = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    if (seq !== this.seq) return; // inzwischen neu geklickt oder abgebrochen
    this.busy = false;
    this.warm = true;
    if (r.ok && r.result) { this.result = r.result; this.drawMarks(); }
    else {
      this.error = r.error ?? 'Die Messung ist fehlgeschlagen.';
      if (r.stale) { this.a = this.b = null; this.deps.viewer.setMeasureMarks(null); }
    }
    this.render();
  }

  /**
   * Die wichtigste Angabe eines Paars: Abstand paralleler Ebenen oder Achsen, mit einem Punkt dessen Abstand zur Ebene,
   * Achse oder Geraden, bei zwei Punkten ihr Abstand, sonst der kürzeste Abstand.
   */
  private primary(r: MeasureResult): { label: string; span: MeasureSpan } | null {
    const p = r.pair;
    if (!p) return null;
    if (p.planes) return { label: 'Abstand der Ebenen', span: p.planes };
    const circles = r.a.type === 'CIRCLE' && r.b?.type === 'CIRCLE';
    if (p.axes) return { label: circles ? 'Abstand der Mittelpunkte' : 'Abstand der Achsen', span: p.axes };
    if (p.toPlane) return { label: 'Abstand zur Ebene', span: p.toPlane };
    if (p.toAxis) return { label: 'Abstand zur Achse', span: p.toAxis };
    if (p.toLine) return { label: 'Abstand zur Geraden', span: p.toLine };
    if (r.a.kind === 'vertex' && r.b?.kind === 'vertex' && p.points) return { label: 'Abstand der Punkte', span: p.points };
    return { label: 'Kürzester Abstand', span: p.min };
  }

  /** Wert, der im Viewer an einem einzelnen Element steht. */
  private headline(i: MeasureInfo): string | null {
    if (i.kind === 'vertex') return i.point ? coords(i.point) : null;
    if (i.radius != null && (i.type === 'CYLINDER' || i.type === 'CIRCLE' || i.type === 'SPHERE')) return `Ø ${mm(2 * i.radius)}`;
    if (i.kind === 'edge' && i.length != null) return mm(i.length);
    if (i.area != null) return mm2(i.area);
    return null;
  }

  private drawMarks(): void {
    const r = this.result!;
    const points = [r.a.point, r.b?.point].filter((p): p is number[] => !!p);
    const lines: MeasureMarks['lines'] = [];
    let label: MeasureMarks['label'];
    const main = this.primary(r);
    if (main) {
      lines.push({ a: main.span.p1, b: main.span.p2, primary: true });
      label = { at: mid(main.span.p1, main.span.p2), text: mm(main.span.value) };
      const pts = r.pair?.points;
      if (pts && !(same(pts.p1, main.span.p1) && same(pts.p2, main.span.p2))) lines.push({ a: pts.p1, b: pts.p2 });
    } else {
      const text = this.headline(r.a);
      const at = r.a.type === 'CIRCLE' && r.a.center ? r.a.center : r.a.point ?? this.a?.point;
      if (text && at) label = { at, text };
    }
    this.deps.viewer.setMeasureMarks({ entities: this.entities(), points, lines, label });
  }

  // ---- Karte ----------------------------------------------------------------------------------------------------

  private render(): void {
    const { card, body, again, agent } = this.ui;
    card.hidden = !this.active;
    if (!this.active) return;
    const rows: HTMLElement[] = [];
    const hint = (t: string) => el('div', { className: 'mc-hint', textContent: t });
    if (!this.a) rows.push(hint('Klick auf einen Punkt, eine Kante oder eine Fläche. Ein zweiter Klick misst Abstand und Winkel zum ersten.'));
    else if (this.busy) rows.push(hint(this.warm ? 'Messe …' : 'Messe … Beim ersten Mal startet der Messdienst, das dauert einige Sekunden.'));
    else if (this.error) rows.push(el('div', { className: 'mc-err', textContent: this.error }));
    else if (this.result && !this.result.b) {
      rows.push(...this.entityRows(this.result.a, true));
      rows.push(hint('Zweites Element anklicken für Abstand und Winkel.'));
    } else if (this.result?.b && this.result.pair) {
      const r = this.result, p = this.result.pair;
      const main = this.primary(r)!;
      rows.push(el('div', { className: 'mc-main' }, el('span', { textContent: main.label }), el('b', { textContent: mm(main.span.value) })));
      if (main.span !== p.min && Math.abs(main.span.value - p.min.value) > 5e-4) rows.push(this.row('Kürzester Abstand', mm(p.min.value)));
      if (p.points) {
        // Bei zwei Punkten ist der Abstand schon die Hauptangabe, die Anteile je Achse gehören trotzdem dazu
        if (main.span !== p.points) rows.push(this.row('Punkt zu Punkt', mm(p.points.value)));
        const d = p.points.delta ?? [0, 0, 0];
        rows.push(el('div', { className: 'mc-sub', textContent: d.map((v, k) => `Δ${'XYZ'[k]} ${minus(v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))}`).join(' · ') }));
      }
      if (p.angle != null) rows.push(this.row('Winkel', p.angle < 1e-6 ? '0° (parallel)' : deg(p.angle)));
      rows.push(el('div', { className: 'mc-sep' }));
      rows.push(this.entityLine('A', r.a), this.entityLine('B', r.b!));
    }
    if (this.note) rows.push(el('div', { className: 'mc-hint warn', textContent: this.note }));
    body.replaceChildren(...rows);
    again.disabled = !this.a;
    agent.disabled = !this.result;
  }

  private row(label: string, value: string): HTMLElement {
    return el('div', { className: 'mc-row' }, el('span', { textContent: label }), el('span', { className: 'v', textContent: value }));
  }

  private entityLine(tag: string, i: MeasureInfo): HTMLElement {
    const value = this.headline(i);
    return el('div', { className: 'mc-ent' }, el('b', { textContent: tag }), el('span', { textContent: `${what(i, ' ')} · ${i.name ?? i.part}${value ? ` · ${value}` : ''}` }));
  }

  private entityRows(i: MeasureInfo, withPart: boolean): HTMLElement[] {
    const rows: HTMLElement[] = [
      el('div', { className: 'mc-title' }, el('b', { textContent: what(i) }), el('span', { className: 'c2', textContent: i.name ?? i.part })),
    ];
    if (i.kind === 'vertex' && i.point) i.point.forEach((v, k) => rows.push(this.row('XYZ'[k], mm(Math.abs(v) < 5e-4 ? 0 : v).replace(/^-/, '−'))));
    if (i.radius != null) { rows.push(this.row('Durchmesser', `Ø ${mm(2 * i.radius)}`), this.row('Radius', mm(i.radius))); }
    if (i.majorRadius != null && i.minorRadius != null) rows.push(this.row('Radien', `${mm(i.majorRadius)} · ${mm(i.minorRadius)}`));
    if (i.semiAngle != null) rows.push(this.row('Halber Öffnungswinkel', deg(Math.abs(i.semiAngle))));
    if (i.axis) rows.push(this.row('Achse', dirText(i.axis.dir)));
    if (i.normal) rows.push(this.row('Normale', dirText(i.normal)));
    if (i.dir) rows.push(this.row('Richtung', dirText(i.dir)));
    if (i.kind === 'edge' && i.length != null) rows.push(this.row(i.type === 'CIRCLE' && i.closed === false ? 'Bogenlänge' : 'Länge', mm(i.length)));
    if (i.area != null) rows.push(this.row('Fläche', mm2(i.area)));
    const bb = withPart ? this.deps.part(i.part)?.bbox : undefined;
    if (bb) {
      const d = [0, 1, 2].map((k) => bb[1][k] - bb[0][k]);
      rows.push(el('div', { className: 'mc-sep' }), this.row('Bauteil (X × Y × Z)', d.map((v) => v.toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })).join(' × ') + ' mm'));
    }
    return rows;
  }

  // ---- Für den Agenten ------------------------------------------------------------------------------------------

  /** Text für die Eingabe des Agenten. Zahlen mit Punkt und drei Stellen, damit sie eindeutig bleiben. */
  agentText(): string | null {
    const r = this.result;
    if (!r) return null;
    const desc = (i: MeasureInfo) => `Bauteil "${i.name ?? i.part}" ${what(i, ' ')}`;
    const facts = (i: MeasureInfo) => {
      const out: string[] = [];
      if (i.kind === 'vertex' && i.point) return [`Lage ${vec(i.point.map((v) => +v.toFixed(3)))}`];
      if (i.radius != null) out.push(`Durchmesser ${f3(2 * i.radius)} mm`);
      if (i.axis) out.push(`Achse ${vec(i.axis.dir)} durch ${vec(i.axis.point)}`);
      if (i.normal) out.push(`Normale ${vec(i.normal)}`);
      if (i.dir) out.push(`Richtung ${vec(i.dir)}`);
      if (i.kind === 'edge' && i.length != null) out.push(`Länge ${f3(i.length)} mm`);
      if (i.area != null) out.push(`Fläche ${f3(i.area)} mm²`);
      if (i.point) out.push(`angeklickt bei ${vec(i.point.map((v) => +v.toFixed(3)))}`);
      return out;
    };
    if (!r.b || !r.pair) return `[Messung: ${desc(r.a)}, ${facts(r.a).join(', ')}] `;
    const p = r.pair, main = this.primary(r)!;
    const out = [`${main.label} ${f3(main.span.value)} mm`];
    if (main.span !== p.min && Math.abs(main.span.value - p.min.value) > 5e-4) out.push(`kürzester Abstand ${f3(p.min.value)} mm`);
    if (p.points && main.span === p.points) out.push(`dX ${f3(p.points.delta?.[0] ?? 0)}, dY ${f3(p.points.delta?.[1] ?? 0)}, dZ ${f3(p.points.delta?.[2] ?? 0)}`);
    else if (p.points) out.push(`Punkt zu Punkt ${f3(p.points.value)} mm (dX ${f3(p.points.delta?.[0] ?? 0)}, dY ${f3(p.points.delta?.[1] ?? 0)}, dZ ${f3(p.points.delta?.[2] ?? 0)})`);
    if (p.angle != null) out.push(`Winkel ${p.angle.toFixed(1)}°`);
    return `[Messung: ${desc(r.a)} und ${desc(r.b)}: ${out.join(', ')}] `;
  }

  // ---- Prüfhilfe (nur Tests) ------------------------------------------------------------------------------------

  state() {
    return { active: this.active, a: this.a, b: this.b, busy: this.busy, error: this.error, result: this.result, text: this.ui.body.textContent, agentText: this.agentText() };
  }
}
