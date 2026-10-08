import type { MeasureInfo, MeasureResponse, MeasureResult, MeasureSource, MeasureSpan, PartMap } from '../shared/types';
import { icon } from './icons';
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
  PLANE: 'plane', CYLINDER: 'cylinder', CONE: 'cone', SPHERE: 'sphere', TORUS: 'torus', BSPLINE: 'freeform', BEZIER: 'freeform',
  REVOLUTION: 'revolved', EXTRUSION: 'extruded', OFFSET: 'offset', OTHER: 'other',
  LINE: 'line', CIRCLE: 'circle', ELLIPSE: 'ellipse', HYPERBOLA: 'hyperbola', PARABOLA: 'parabola', VERTEX: 'point',
};
const KIND: Record<string, string> = { face: 'Face', edge: 'Edge', vertex: 'Point' };
/** „Face · plane“, „Edge · circle“, beim Eckpunkt nur „Point“. Im Fließtext (`inline`) „face (plane)“. */
const what = (i: { kind: string; type: string }, inline = false) => (i.kind === 'vertex' ? (inline ? 'point' : 'Point')
  : inline ? `${KIND[i.kind].toLowerCase()} (${typeName(i.type)})` : `${KIND[i.kind]} · ${typeName(i.type)}`);
/** Lage eines Punkts: „X 20.00 · Y −15.00 · Z 5.00“. */
const coords = (p: number[]) => p.map((v, k) => `${'XYZ'[k]} ${minus((Math.abs(v) < 5e-4 ? 0 : v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))}`).join(' · ');
const typeName = (t: string) => TYPE[t] ?? t.toLowerCase();
const mm = (v: number) => `${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} mm`;
const mm2 = (v: number) => `${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} mm²`;
const deg = (v: number) => `${v.toLocaleString('en-US', { maximumFractionDigits: 1 })}°`;
const minus = (s: string) => s.replace(/^-/, '−');
/** Für den Agenten: Punkt als Dezimalzeichen, drei Stellen, kein „-0“. */
const f3 = (v: number) => (Math.abs(v) < 5e-4 ? 0 : v).toFixed(3);
const vec = (d: number[]) => `(${d.map((x) => +(Math.abs(x) < 5e-7 ? 0 : x).toFixed(4)).join(', ')})`;

/** Richtung in Worten: entlang einer Achse „+Z“, sonst die Komponenten. */
function dirText(d: number[]): string {
  const len = Math.hypot(d[0], d[1], d[2]) || 1;
  for (let i = 0; i < 3; i++) if (Math.abs(Math.abs(d[i]) / len - 1) < 1e-6) return `${d[i] > 0 ? '+' : '−'}${'XYZ'[i]}`;
  return `(${d.map((x) => minus((x / len).toLocaleString('en-US', { maximumFractionDigits: 3 }))).join(' · ')})`;
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
  /**
   * Vorbereitung beim Einschalten: Messdienst starten, den Stand laden (große Baugruppen: Sekunden). Klicks sind schon
   * möglich, ihre Messung wartet darauf. `phase`: was gerade geschieht, leer wenn bereit.
   */
  private prep: Promise<void> | null = null;
  private prepSeq = 0;
  private phase = '';
  private prepT0 = 0;
  private prepTick: ReturnType<typeof setInterval> | undefined;

  constructor(private ui: Ui, private deps: Deps) {
    ui.button.addEventListener('click', () => this.setActive(!this.active));
    ui.close.addEventListener('click', () => this.setActive(false));
    ui.again.addEventListener('click', () => this.reset());
    ui.agent.addEventListener('click', () => { const t = this.agentText(); if (t) deps.insert(t); });
    deps.viewer.onMeasurePick = (h) => void this.pick(h);
    // Die Schnittfläche hat keine exakte Geometrie. Der Klick verwirft nichts, ein Hinweis sagt, was geht.
    deps.viewer.onMeasureCut = () => { this.note = 'The section face itself cannot be measured. Click near its edge to pick the face that was cut.'; this.render(); };
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
    if (on) this.prepare(); else this.endPrepare();
    this.render();
  }

  /** Neuer Build oder anderer Stand: Die IDs der Flächen und Kanten gelten nicht mehr, den neuen Stand vorab laden. */
  reset(): void {
    this.clear();
    if (this.active) this.prepare();
    this.render();
  }

  private prepare(): void {
    const build = this.deps.build();
    this.endPrepare();
    if (!build) return; // ohne Geometrie meldet der erste Klick, was fehlt
    const seq = this.prepSeq;
    const source = this.deps.source();
    const n = this.deps.viewer.partList().length;
    this.prepT0 = performance.now();
    // Sekunden mitzählen, nur die Zahl: Neu zeichnen ließe den laufenden Balken jedes Mal von vorn beginnen
    this.prepTick = setInterval(() => { const t = this.ui.body.querySelector('.mc-load-time'); if (t) t.textContent = this.prepSeconds(); }, 1000);
    this.phase = 'Starting the measuring service …';
    this.prep = (async () => {
      // Läuft der Dienst schon, ist start() gleich fertig
      let r = await window.soma.measure.start().catch((e: unknown) => ({ ok: false, error: String(e), stale: false }));
      if (seq !== this.prepSeq) return;
      if (r.ok) {
        this.phase = `Loading geometry (${n} ${n === 1 ? 'part' : 'parts'}) …`;
        this.render();
        r = await window.soma.measure.prepare(source, build).catch((e: unknown) => ({ ok: false, error: String(e), stale: false }));
        if (seq !== this.prepSeq) return;
      }
      // Ein veralteter Stand ist kein Fehler: Der neue Build ruft reset() und lädt selbst
      if (r.ok) this.warm = true;
      else if (!r.stale && !this.a) this.error = r.error ?? 'The measuring service could not be prepared.';
      this.endPrepare();
      this.render();
    })();
  }

  /** Vorbereitung beenden oder verwerfen (der Dienst lädt im Hintergrund zu Ende, das schadet nicht). */
  private endPrepare(): void {
    this.prepSeq++;
    this.prep = null;
    this.phase = '';
    clearInterval(this.prepTick);
  }

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
    if (!build) { this.error = 'This version has no geometry to measure. Building it again helps.'; this.render(); return; }
    const seq = ++this.seq;
    this.busy = true;
    this.render();
    if (this.prep) { await this.prep; if (seq !== this.seq) return; } // erst den Stand fertig laden, sonst läuft das Zeitlimit
    const ent = (x: ProbeHit) => ({ part: x.partId, kind: x.kind, id: x.id, point: x.point, check: x.size ?? undefined });
    let r: MeasureResponse;
    try { r = await window.soma.measure.query(this.deps.source(), { build, a: ent(this.a!), ...(this.b ? { b: ent(this.b) } : {}) }); }
    catch (e) { r = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    if (seq !== this.seq) return; // inzwischen neu geklickt oder abgebrochen
    this.busy = false;
    this.warm = true;
    if (r.ok && r.result) { this.result = r.result; this.drawMarks(); }
    else {
      this.error = r.error ?? 'The measurement failed.';
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
    if (p.planes) return { label: 'Distance between planes', span: p.planes };
    const circles = r.a.type === 'CIRCLE' && r.b?.type === 'CIRCLE';
    if (p.axes) return { label: circles ? 'Distance between centers' : 'Distance between axes', span: p.axes };
    if (p.toPlane) return { label: 'Distance to plane', span: p.toPlane };
    if (p.toAxis) return { label: 'Distance to axis', span: p.toAxis };
    if (p.toLine) return { label: 'Distance to line', span: p.toLine };
    if (r.a.kind === 'vertex' && r.b?.kind === 'vertex' && p.points) return { label: 'Distance between points', span: p.points };
    return { label: 'Shortest distance', span: p.min };
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
    if (this.phase) rows.push(this.loadingRow());
    if (this.error && !this.busy) rows.push(el('div', { className: 'mc-err', textContent: this.error }));
    else if (!this.a) rows.push(hint('Click a point, an edge or a face. A second click measures distance and angle to the first.'));
    else if (this.busy) rows.push(hint(this.phase ? 'Measuring as soon as the geometry is loaded.' : this.warm ? 'Measuring …' : 'Measuring … The first time, the measuring service starts, which takes a few seconds.'));
    else if (this.result && !this.result.b) {
      rows.push(...this.entityRows(this.result.a, true));
      rows.push(hint('Click a second element for distance and angle.'));
    } else if (this.result?.b && this.result.pair) {
      const r = this.result, p = this.result.pair;
      const main = this.primary(r)!;
      rows.push(el('div', { className: 'mc-main' }, el('span', { textContent: main.label }), el('b', { textContent: mm(main.span.value) })));
      if (main.span !== p.min && Math.abs(main.span.value - p.min.value) > 5e-4) rows.push(this.row('Shortest distance', mm(p.min.value)));
      if (p.points) {
        // Bei zwei Punkten ist der Abstand schon die Hauptangabe, die Anteile je Achse gehören trotzdem dazu
        if (main.span !== p.points) rows.push(this.row('Point to point', mm(p.points.value)));
        const d = p.points.delta ?? [0, 0, 0];
        rows.push(el('div', { className: 'mc-sub', textContent: d.map((v, k) => `Δ${'XYZ'[k]} ${minus(v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))}`).join(' · ') }));
      }
      if (p.angle != null) rows.push(this.row('Angle', p.angle < 1e-6 ? '0° (parallel)' : deg(p.angle)));
      rows.push(el('div', { className: 'mc-sep' }));
      rows.push(this.entityLine('A', r.a), this.entityLine('B', r.b!));
    }
    if (this.note) rows.push(el('div', { className: 'mc-hint warn', textContent: this.note }));
    body.replaceChildren(...rows);
    again.disabled = !this.a;
    agent.disabled = !this.result;
  }

  /** Was die Vorbereitung gerade tut, mit Sekunden und laufendem Balken. */
  private loadingRow(): HTMLElement {
    return el('div', { className: 'mc-load' },
      el('div', { className: 'mc-load-hd' }, el('span', { className: 'spin' }, icon('spin', 14, 2.4)), el('span', { className: 'grow', textContent: this.phase }),
        el('span', { className: 'c3 mc-load-time', textContent: this.prepSeconds() })),
      el('div', { className: 'vb-bar indet' }, el('div')));
  }

  private prepSeconds(): string {
    const s = Math.round((performance.now() - this.prepT0) / 1000);
    return s ? `${s} s` : '';
  }

  private row(label: string, value: string): HTMLElement {
    return el('div', { className: 'mc-row' }, el('span', { textContent: label }), el('span', { className: 'v', textContent: value }));
  }

  private entityLine(tag: string, i: MeasureInfo): HTMLElement {
    const value = this.headline(i);
    return el('div', { className: 'mc-ent' }, el('b', { textContent: tag }), el('span', { textContent: `${what(i, true)} · ${i.name ?? i.part}${value ? ` · ${value}` : ''}` }));
  }

  private entityRows(i: MeasureInfo, withPart: boolean): HTMLElement[] {
    const rows: HTMLElement[] = [
      el('div', { className: 'mc-title' }, el('b', { textContent: what(i) }), el('span', { className: 'c2', textContent: i.name ?? i.part })),
    ];
    if (i.kind === 'vertex' && i.point) i.point.forEach((v, k) => rows.push(this.row('XYZ'[k], mm(Math.abs(v) < 5e-4 ? 0 : v).replace(/^-/, '−'))));
    if (i.radius != null) { rows.push(this.row('Diameter', `Ø ${mm(2 * i.radius)}`), this.row('Radius', mm(i.radius))); }
    if (i.majorRadius != null && i.minorRadius != null) rows.push(this.row('Radii', `${mm(i.majorRadius)} · ${mm(i.minorRadius)}`));
    if (i.semiAngle != null) rows.push(this.row('Half angle', deg(Math.abs(i.semiAngle))));
    if (i.axis) rows.push(this.row('Axis', dirText(i.axis.dir)));
    if (i.normal) rows.push(this.row('Normal', dirText(i.normal)));
    if (i.dir) rows.push(this.row('Direction', dirText(i.dir)));
    if (i.kind === 'edge' && i.length != null) rows.push(this.row(i.type === 'CIRCLE' && i.closed === false ? 'Arc length' : 'Length', mm(i.length)));
    if (i.area != null) rows.push(this.row('Area', mm2(i.area)));
    const bb = withPart ? this.deps.part(i.part)?.bbox : undefined;
    if (bb) {
      const d = [0, 1, 2].map((k) => bb[1][k] - bb[0][k]);
      rows.push(el('div', { className: 'mc-sep' }), this.row('Part (X × Y × Z)', d.map((v) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })).join(' × ') + ' mm'));
    }
    return rows;
  }

  // ---- Für den Agenten ------------------------------------------------------------------------------------------

  /** Text für die Eingabe des Agenten. Zahlen mit Punkt und drei Stellen, damit sie eindeutig bleiben. */
  agentText(): string | null {
    const r = this.result;
    if (!r) return null;
    const desc = (i: MeasureInfo) => `part "${i.name ?? i.part}" ${what(i, true)}`;
    const facts = (i: MeasureInfo) => {
      const out: string[] = [];
      if (i.kind === 'vertex' && i.point) return [`position ${vec(i.point.map((v) => +v.toFixed(3)))}`];
      if (i.radius != null) out.push(`diameter ${f3(2 * i.radius)} mm`);
      if (i.axis) out.push(`axis ${vec(i.axis.dir)} through ${vec(i.axis.point)}`);
      if (i.normal) out.push(`normal ${vec(i.normal)}`);
      if (i.dir) out.push(`direction ${vec(i.dir)}`);
      if (i.kind === 'edge' && i.length != null) out.push(`length ${f3(i.length)} mm`);
      if (i.area != null) out.push(`area ${f3(i.area)} mm²`);
      if (i.point) out.push(`clicked at ${vec(i.point.map((v) => +v.toFixed(3)))}`);
      return out;
    };
    if (!r.b || !r.pair) return `[Measurement: ${desc(r.a)}, ${facts(r.a).join(', ')}] `;
    const p = r.pair, main = this.primary(r)!;
    const out = [`${main.label} ${f3(main.span.value)} mm`];
    if (main.span !== p.min && Math.abs(main.span.value - p.min.value) > 5e-4) out.push(`shortest distance ${f3(p.min.value)} mm`);
    if (p.points && main.span === p.points) out.push(`dX ${f3(p.points.delta?.[0] ?? 0)}, dY ${f3(p.points.delta?.[1] ?? 0)}, dZ ${f3(p.points.delta?.[2] ?? 0)}`);
    else if (p.points) out.push(`point to point ${f3(p.points.value)} mm (dX ${f3(p.points.delta?.[0] ?? 0)}, dY ${f3(p.points.delta?.[1] ?? 0)}, dZ ${f3(p.points.delta?.[2] ?? 0)})`);
    if (p.angle != null) out.push(`angle ${p.angle.toFixed(1)}°`);
    return `[Measurement: ${desc(r.a)} and ${desc(r.b)}: ${out.join(', ')}] `;
  }

  // ---- Prüfhilfe (nur Tests) ------------------------------------------------------------------------------------

  state() {
    return { active: this.active, a: this.a, b: this.b, busy: this.busy, preparing: !!this.prep, phase: this.phase, error: this.error, result: this.result, text: this.ui.body.textContent, agentText: this.agentText() };
  }
}
