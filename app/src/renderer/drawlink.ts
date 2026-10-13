import * as THREE from 'three';
import type { DrawingDim, DrawingEntry, DrawingView } from '../shared/types';
import type { SectionTool } from './sectiontool';
import type { MeasureMarks, Viewer } from './viewer';

// Zeichnung und 3D (E76): Ein Klick auf eine Ansicht des Blatts dreht die Kamera in ihre Blickrichtung, ein Schnitt setzt das
// Schnittwerkzeug auf seine Ebene, eine Einzelheit rückt heran. Ein Klick auf ein Maß zeigt seine Punkte und die gemessene
// Strecke im Bild, wie das Messwerkzeug. Alles kommt aus dem Index von `soma drawing build`, der Agent tut dafür nichts.

interface Deps {
  viewer: Viewer;
  section: SectionTool;
  /** Messen, Explosion, Animation und Analyse beenden: Die Punkte gelten für das Modell in seiner Lage. */
  beforeShow(): void;
  /** Bauteil-IDs im Viewer zu den Namen aus der Zeichnung (leer: keine passenden). */
  partIds(names: string[]): string[];
  /** Alle Bauteil-IDs im Viewer. */
  allIds(): string[];
  /** Ist ein Modell geladen? */
  ready(): boolean;
}

type V3 = number[];
const sub = (a: V3, b: V3) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3, k = 1) => [a[0] + b[0] * k, a[1] + b[1] * k, a[2] + b[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3) => { const l = len(a); return l > 1e-12 ? a.map((x) => x / l) : null; };
const cross = (a: V3, b: V3) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const v3 = (a: V3) => new THREE.Vector3(a[0], a[1], a[2]);

/** Rechts und oben auf dem Blatt; ältere Indizes ohne die Angaben: aus der Blickrichtung mit Z (oder Y) oben. */
export function axesOf(v: DrawingView): { right: V3; up: V3; n: V3 } {
  const n = unit(v.direction) ?? [0, -1, 0];
  if (v.right && v.up) return { right: v.right, up: v.up, n };
  const up0 = Math.abs(n[2]) > 0.99 ? [0, Math.sign(n[2]) || 1, 0] : [0, 0, 1];
  const right = unit(cross(up0, n)) ?? [1, 0, 0];
  return { right, up: cross(n, right), n };
}

/** Kreis um `c` mit Radius `r` in der Ebene von `a` und `b`, als Strecken. */
function circle(c: V3, r: number, a: V3, b: V3, segs = 48): { a: V3; b: V3; primary: boolean }[] {
  const out: { a: V3; b: V3; primary: boolean }[] = [];
  const at = (i: number) => { const t = (i / segs) * Math.PI * 2; return add(add(c, a, r * Math.cos(t)), b, r * Math.sin(t)); };
  for (let i = 0; i < segs; i++) out.push({ a: at(i), b: at(i + 1), primary: true });
  return out;
}

/** Was ein Maß im Bild zeigt: Punkte, Strecken (die gemessene in Orange) und die Maßzahl. */
export function dimMarks(d: DrawingDim, v: DrawingView | undefined): MeasureMarks | null {
  const pts = d.points ?? [];
  if (!pts.length) return null;
  const ax = v ? axesOf(v) : { right: [1, 0, 0], up: [0, 0, 1], n: [0, -1, 0] };
  const lines: MeasureMarks['lines'] = [];
  let at = pts[0];
  if ((d.kind === 'diameter' || d.kind === 'radius') && d.radius) {
    const c = pts[0], r = d.radius;
    lines.push(...circle(c, r, ax.right, ax.up));
    // Durchmesser oder Radius schräg wie üblich auf Zeichnungen
    const diag = unit(add(ax.right, ax.up))!;
    lines.push({ a: d.kind === 'diameter' ? add(c, diag, -r) : c, b: add(c, diag, r), primary: true });
    at = add(c, diag, r);
  } else if (d.kind === 'angle' && pts.length >= 3) {
    lines.push({ a: pts[0], b: pts[1], primary: true }, { a: pts[0], b: pts[2], primary: true });
    at = pts[0];
  } else if (pts.length >= 2) {
    // Lineares Maß: waagerecht, senkrecht oder schräg auf dem Blatt. Welche Richtung, verrät der gemessene Wert.
    const [p1, p2] = pts;
    const delta = sub(p2, p1);
    const inPlane = sub(delta, ax.n.map((x) => x * dot(delta, ax.n)));
    const cands: { dir: V3; val: number }[] = [
      { dir: ax.right, val: Math.abs(dot(delta, ax.right)) }, { dir: ax.up, val: Math.abs(dot(delta, ax.up)) },
      { dir: unit(inPlane) ?? ax.right, val: len(inPlane) },
    ];
    const best = cands.reduce((a, b) => (Math.abs(b.val - d.value) < Math.abs(a.val - d.value) ? b : a));
    const end = add(p1, best.dir, dot(delta, best.dir));
    lines.push({ a: p1, b: end, primary: true });
    if (len(sub(end, p2)) > 1e-6) lines.push({ a: end, b: p2 });
    at = add(p1, sub(end, p1), 0.5);
  }
  return { entities: [], points: pts.slice(0, d.kind === 'angle' ? 3 : 2), lines, label: { at, text: d.label } };
}

export class DrawingLink {
  /** Den Schnitt hat die Zeichnung gesetzt: Beim Verlassen nimmt sie ihn wieder weg. */
  private ownSection = false;
  private ownMarks = false;
  /** Die übrigen Teile sind durchsichtig (Zustand der Animation im Viewer, die Animation ist dabei aus). */
  private ownGhost = false;

  constructor(private readonly d: Deps) {}

  /** Ansicht im Bild zeigen. Liefert einen Hinweis für die Karte oder null. */
  showView(e: DrawingEntry, v: DrawingView): string | null {
    if (!this.d.ready()) return 'The model is not loaded, so there is nothing to show in 3D.';
    this.d.beforeShow();
    this.clearMarks();
    const ids = this.d.partIds(v.parts ?? []);
    this.focus(ids);
    const { n, right, up } = axesOf(v);
    let hint: string | null = null;
    if (v.section?.kind === 'plane' && v.section.point && v.section.normal) {
      this.d.section.showPlane(v.section.point, v.section.normal, `section ${v.name} of “${e.name}”`);
      this.ownSection = true;
      hint = 'The section tool shows the same cut. Its slider moves the plane.';
    } else {
      this.dropSection();
      if (v.kind === 'section') hint = 'A stepped section or break-out cannot be shown as one plane in 3D.';
    }
    if (v.detail) {
      // Kreis der Einzelheit im Bild, die Kamera rückt auf ihn
      const c = v.detail.center, r = v.detail.radius;
      this.d.viewer.setMeasureMarks({ entities: [], points: [], lines: circle(c, r, right, up).map((l) => ({ ...l, primary: false })),
        label: { at: add(c, unit(add(right, up))!, r), text: v.name } });
      this.ownMarks = true;
      this.d.viewer.frame(v3(n), v3(c), r * 1.5);
    } else this.d.viewer.viewFrom(v3(n), ids.length ? ids : undefined);
    if (v.parts?.length && !ids.length && !hint) hint = 'The parts of this view are not in the model any more.';
    return hint;
  }

  /** Maß im Bild zeigen: Kamera wie in seiner Ansicht, dazu Punkte und Strecke. */
  showDim(e: DrawingEntry, d: DrawingDim): string | null {
    if (!this.d.ready()) return 'The model is not loaded, so there is nothing to show in 3D.';
    const v = e.views.find((x) => x.name === d.view);
    const marks = dimMarks(d, v);
    if (!marks) return 'This sheet was built by an older soma without the points of its dimensions. Rebuild it.';
    this.d.beforeShow();
    this.dropSection();
    this.d.viewer.setMeasureMarks(marks);
    this.ownMarks = true;
    if (v) {
      const ids = this.d.partIds(v.parts ?? []);
      this.focus(ids);
      if (v.detail) this.d.viewer.frame(v3(axesOf(v).n), v3(v.detail.center), v.detail.radius * 1.5);
      else this.d.viewer.viewFrom(v3(axesOf(v).n), ids.length ? ids : undefined);
    }
    return null;
  }

  /** Auswahl in der Zeichnung aufgehoben: Marken und den eigenen Schnitt wegnehmen, die Kamera bleibt. */
  clear(): void {
    this.clearMarks();
    this.dropSection();
    this.focus([]);
  }

  /**
   * Ein anderes Werkzeug übernimmt das Bild (Messen, Animation, Analyse, Explosion): Marken und Zustände gehören jetzt ihm,
   * ein späteres clear() darf sie nicht wegnehmen.
   */
  release(): void { this.ownMarks = false; this.ownGhost = false; }

  /** Zeigt die Ansicht nur einen Teil des Modells, werden die übrigen Teile durchsichtig. Leer: alle wieder normal. */
  private focus(ids: string[]): void {
    const all = this.d.allIds();
    const keep = new Set(ids);
    const others = all.filter((id) => !keep.has(id));
    if (ids.length && others.length) {
      this.d.viewer.setAnimState({ hidden: new Set(), ghost: new Set(others), highlight: new Set() });
      this.ownGhost = true;
    } else if (this.ownGhost) {
      this.d.viewer.setAnimState(null);
      this.ownGhost = false;
    }
  }

  private clearMarks(): void {
    if (this.ownMarks) this.d.viewer.setMeasureMarks(null);
    this.ownMarks = false;
  }

  private dropSection(): void {
    // Nur wenn der Schnitt noch der aus der Zeichnung ist: Hat der Nutzer ihn inzwischen umgestellt, gehört er ihm
    if (this.ownSection && this.d.section.fromDrawing) this.d.section.setActive(false);
    this.ownSection = false;
  }
}
