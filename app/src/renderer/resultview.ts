import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { ResultMeta } from '../shared/types';
import { resultColor } from './overlay';
import type { Viewer } from './viewer';

// Ergebnis einer Auswertung (E58, .soma/results/<name>.glb von `soma analyze`): je Bauteil ein Netz mit einem Wert je Dreieck
// (Attribut _VALUE) und seinen Kanten. Solange es angezeigt wird, tritt das Modell zurück und die Netze vertreten seine Bauteile
// (Viewer.setStandIns): Ausblenden und Transparent aus der Seitenleiste gelten für sie, der Schnitt füllt sie wie das Modell.
// FEM (E65) bringt dazu je Ecke die Vergleichsspannung (_STRESS) und die Verschiebung (_DISP) mit, und den Lastfall als
// eigene Netze (extras.soma.marker): Die Verformung lässt sich überhöht zeigen, Einspannungen und Lasten sind markiert.

interface ResultMesh { mesh: THREE.Mesh; name: string; values: THREE.BufferAttribute; stress?: THREE.BufferAttribute; disp?: THREE.BufferAttribute }
/** Verformbare Geometrie: Ausgangslage und Verschiebung je Ecke. */
interface Deformable { geo: THREE.BufferGeometry; base: Float32Array; disp: THREE.BufferAttribute }
interface Arrow { obj: THREE.Object3D; base: THREE.Vector3; shift: THREE.Vector3 }

export interface ResultProbe {
  name: string; value: number; point: number[];
  /** FEM: Vergleichsspannung (MPa) und Betrag der Verschiebung (mm) an der Stelle. */
  stress?: number; disp?: number;
}

/** Gezeigte Größe: der Wert der Auswertung (bei FEM die Sicherheit) oder bei FEM die Vergleichsspannung nach von Mises. */
export type ResultField = 'value' | 'stress';

/** Blau des Lastfalls: keine Statusfarbe, nicht Orange (Aktion) und nicht Violett (Vorschau). */
const BC_COLOR = 0x5ea8ff;

export class ResultLayer {
  meta: ResultMeta | null = null;
  private group: THREE.Object3D | null = null;
  private meshes: ResultMesh[] = [];
  private deformables: Deformable[] = [];
  private markers: THREE.Object3D[] = [];
  private arrows: Arrow[] = [];
  /** Überhöhung der Verformung (0: unverformt). */
  scale = 0;
  /** Vorschlag: die größte Verschiebung als 5 % der Modellgröße, auf eine runde Zahl. */
  autoScale = 0;
  private showBcs = true;
  /** Gezeigte Größe und eigene Spanne der Farbskala (null: die der Auswertung). */
  field: ResultField = 'value';
  private range: [number, number] | null = null;
  /** FEM: zulässige Spannung (MPa, Festigkeit durch geforderte Sicherheit), bei mehreren Werkstoffen die kleinste. */
  private stressLimit = 0;
  private stressMixed = false;

  constructor(private readonly viewer: Viewer) {}

  get active(): boolean { return !!this.group; }
  get isFem(): boolean { return !!this.meta?.fem; }
  /** Spannung zeigbar: FEM mit _STRESS an jedem Netz und Werkstoff mit Festigkeit (für die Grenze). */
  get canStress(): boolean { return this.isFem && this.stressLimit > 0 && this.meshes.length > 0 && this.meshes.every((m) => m.stress); }
  /** Grenze der Spannung gilt nur für den schwächsten von mehreren Werkstoffen. */
  get stressLimitMixed(): boolean { return this.stressMixed; }

  /**
   * Was gezeigt wird: Größe, Einheit, Grenze und Spanne der Farbskala. Spannung: kritisch über der zulässigen Spannung, so
   * bleiben die Farben bei beiden Größen gleich gemeint (Rot heißt zu wenig Sicherheit). Gewählte Spanne: Farbverlauf über die
   * Spanne (`ramp`), nicht mehr am Grenzwert ausgerichtet.
   */
  get view(): (ResultMeta & { ramp?: boolean }) | null {
    const m = this.meta;
    if (!m) return null;
    const base: ResultMeta = this.field === 'stress'
      ? { ...m, quantity: 'Vergleichsspannung (von Mises)', unit: 'MPa', bad: 'high', threshold: this.stressLimit, range: this.autoRange('stress') }
      : m;
    return this.range ? { ...base, range: this.range, ramp: true } : base;
  }

  /**
   * Spanne der Farbskala, wie die Auswertung sie vorschlägt. Spannung: von 0 bis zum Doppelten der zulässigen, bei höheren
   * Spitzen bis zur größten Spannung, aber höchstens bis zum Vierfachen: Eine einzelne Spitze soll die Skala nicht stauchen.
   */
  autoRange(field: ResultField): [number, number] {
    if (field === 'value' || !this.meta) return this.meta ? [...this.meta.range] as [number, number] : [0, 1];
    const [, hi] = this.dataRange('stress');
    return [0, +Math.max(2 * this.stressLimit, Math.min(hi, 4 * this.stressLimit)).toPrecision(3)];
  }

  /** Kleinster und größter Wert der Größe über alle Bauteile. */
  dataRange(field: ResultField): [number, number] {
    let lo = Infinity, hi = -Infinity;
    for (const m of this.meshes) {
      const a = field === 'stress' && m.stress ? m.stress : m.values;
      for (let i = 0; i < a.count; i++) { const v = a.getX(i); if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    return Number.isFinite(lo) ? [lo, hi] : [0, 1];
  }

  /** Größe und Spanne wählen (null: Spanne der Auswertung) und neu einfärben. */
  setDisplay(field: ResultField, range: [number, number] | null): void {
    this.field = field === 'stress' && this.canStress ? 'stress' : 'value';
    this.range = range;
    this.recolor();
  }

  /** Gezeigter Wert an einer Stelle (Spannung oder der Wert der Auswertung). */
  shown(p: ResultProbe): number { return this.field === 'stress' && p.stress != null ? p.stress : p.value; }

  async show(glb: ArrayBuffer): Promise<ResultMeta> {
    const gltf = await new GLTFLoader().parseAsync(glb, '');
    const meta = (gltf.parser.json as { extras?: { soma_result?: ResultMeta } }).extras?.soma_result;
    if (!meta || !Array.isArray(meta.range)) throw new Error('Kein Ergebnis von soma (extras.soma_result fehlt)');
    this.hide();
    const meshes: ResultMesh[] = [];
    const deformables: Deformable[] = [];
    const markers: THREE.Object3D[] = [];
    const standIns: { mesh: THREE.Mesh; name: string; lines: THREE.LineSegments[] }[] = [];
    const deformable = (geo: THREE.BufferGeometry) => {
      const disp = geo.getAttribute('_disp') as THREE.BufferAttribute | undefined;
      if (disp) deformables.push({ geo, base: Float32Array.from((geo.getAttribute('position') as THREE.BufferAttribute).array as Float32Array), disp });
    };
    gltf.scene.traverse((o) => {
      const soma = (o.userData as { soma?: { name?: string; marker?: string } }).soma;
      if (soma?.marker) {
        // Lastfall: eingespannte Flächen kräftig, Lastflächen schwächer, beide vor dem Ergebnis gezeichnet
        o.traverse((c) => {
          const m = c as THREE.Mesh;
          if (!m.isMesh) return;
          m.material = new THREE.MeshBasicMaterial({
            color: BC_COLOR, transparent: true, opacity: soma.marker === 'fix' ? 0.55 : 0.28, side: THREE.DoubleSide, depthWrite: false,
            polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, clippingPlanes: this.viewer.clipPlanes,
          });
          m.raycast = () => {}; // der Zeiger trifft das Ergebnis darunter
          m.renderOrder = 3;
          deformable(m.geometry);
        });
        markers.push(o);
        return;
      }
      const name = soma?.name;
      if (!name) return;
      const own: ResultMesh[] = [], lines: THREE.LineSegments[] = [];
      o.traverse((c) => {
        const m = c as THREE.Mesh;
        if (m.isMesh) {
          const values = m.geometry.getAttribute('_value') as THREE.BufferAttribute | undefined;
          if (!values) return;
          m.material = new THREE.MeshStandardMaterial({
            vertexColors: true, side: THREE.DoubleSide, roughness: 0.75, metalness: 0,
            polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, clippingPlanes: this.viewer.clipPlanes,
          });
          own.push({ mesh: m, name, values, stress: m.geometry.getAttribute('_stress') as THREE.BufferAttribute | undefined,
            disp: m.geometry.getAttribute('_disp') as THREE.BufferAttribute | undefined });
          deformable(m.geometry);
        } else if ((c as THREE.LineSegments).isLineSegments) {
          const l = c as THREE.LineSegments;
          l.material = new THREE.LineBasicMaterial({ color: 0x1a1d22, clippingPlanes: this.viewer.clipPlanes });
          lines.push(l);
          deformable(l.geometry);
        }
      });
      // Die Kanten stehen neben dem Netz im selben Knoten: Sie verschwinden mit ihm, wenn das Bauteil ausgeblendet wird
      meshes.push(...own);
      standIns.push(...own.map((m) => ({ mesh: m.mesh, name, lines })));
    });
    this.meta = meta;
    this.meshes = meshes;
    this.deformables = deformables;
    this.markers = markers;
    this.group = gltf.scene;
    this.arrows = this.makeArrows(meta, markers);
    const maxDisp = meta.fem?.maxDisp ?? 0, diag = meta.fem?.diag ?? 0;
    this.autoScale = maxDisp > 0 && diag > 0 ? niceScale((0.05 * diag) / maxDisp) : 0;
    this.scale = 0;
    // Zulässige Spannung je Werkstoff: Festigkeit durch die geforderte Sicherheit (der Grenzwert der Auswertung)
    const limits = meta.fem && meta.threshold > 0
      ? meta.parts.map((p) => p.material?.strength ?? 0).filter((s) => s > 0).map((s) => s / meta.threshold) : [];
    this.stressLimit = limits.length ? Math.min(...limits) : 0;
    this.stressMixed = new Set(limits).size > 1;
    this.range = null;
    if (!this.canStress) this.field = 'value';
    this.recolor();
    this.viewer.setModelHidden(true);
    this.viewer.addLayer(this.group);
    this.viewer.setStandIns(standIns);
    // Verformt zeigen, sobald es eine gibt: So sieht man sofort, ob Lager und Last so wirken wie gedacht
    if (this.autoScale > 0) this.setScale(this.autoScale);
    this.setBcsVisible(this.showBcs);
    return meta;
  }

  /** Pfeile für Kräfte und Druck: an der Mitte der Lastfläche, die Spitze auf der Fläche. Länge 15 % der Modellgröße. */
  private makeArrows(meta: ResultMeta, markers: THREE.Object3D[]): Arrow[] {
    const fem = meta.fem;
    if (!fem) return [];
    const len = Math.max(1, fem.diag * 0.15);
    const out: Arrow[] = [];
    fem.bcs.forEach((b, i) => {
      if (b.kind === 'fix' || !b.total) return;
      const dir = new THREE.Vector3(...(b.total as [number, number, number]));
      if (dir.lengthSq() < 1e-18) return;
      dir.normalize();
      const at = new THREE.Vector3(...(b.at as [number, number, number]));
      const base = at.clone().addScaledVector(dir, -len);
      // Körperhafter Pfeil, vor dem Modell gezeichnet: Eine Linie wäre 1 Pixel dünn, und eine Kraft quer zur Fläche (Kragarm)
      // läge mit der Spitze im Material
      const mat = new THREE.MeshBasicMaterial({ color: BC_COLOR, depthTest: false, transparent: true, opacity: 0.95 });
      const head = len * 0.26, shaft = new THREE.CylinderGeometry(len * 0.022, len * 0.022, len - head, 12);
      shaft.translate(0, (len - head) / 2, 0);
      const cone = new THREE.ConeGeometry(len * 0.075, head, 20);
      cone.translate(0, len - head / 2, 0);
      const a = new THREE.Group();
      for (const g of [shaft, cone]) {
        const m = new THREE.Mesh(g, mat);
        m.raycast = () => {};
        m.renderOrder = 5;
        a.add(m);
      }
      a.position.copy(base);
      a.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      // Mittlere Verschiebung der Lastfläche: Der Pfeil wandert mit der verformten Fläche
      const shift = new THREE.Vector3();
      const marker = markers.find((m) => (m.userData as { soma?: { bc?: number } }).soma?.bc === i);
      marker?.traverse((c) => {
        const d = (c as THREE.Mesh).geometry?.getAttribute('_disp') as THREE.BufferAttribute | undefined;
        if (!d || !d.count) return;
        for (let k = 0; k < d.count; k++) shift.add(new THREE.Vector3(d.getX(k), d.getY(k), d.getZ(k)));
        shift.divideScalar(d.count);
      });
      this.group!.add(a);
      out.push({ obj: a, base, shift });
    });
    return out;
  }

  /** Verformung überhöht zeigen (0: unverformt, 1: echte Größe). */
  setScale(s: number): void {
    if (!this.group) return;
    this.scale = s;
    for (const d of this.deformables) {
      const pos = d.geo.getAttribute('position') as THREE.BufferAttribute;
      const arr = pos.array as Float32Array;
      for (let i = 0; i < d.disp.count; i++) {
        arr[i * 3] = d.base[i * 3] + s * d.disp.getX(i);
        arr[i * 3 + 1] = d.base[i * 3 + 1] + s * d.disp.getY(i);
        arr[i * 3 + 2] = d.base[i * 3 + 2] + s * d.disp.getZ(i);
      }
      pos.needsUpdate = true;
      d.geo.computeBoundingBox();
      d.geo.computeBoundingSphere();
    }
    for (const a of this.arrows) a.obj.position.copy(a.base).addScaledVector(a.shift, s);
    this.viewer.standInsMoved();
  }

  /** Lastfall (Einspannungen, Lastflächen, Pfeile) ein- oder ausblenden. */
  setBcsVisible(on: boolean): void {
    this.showBcs = on;
    for (const m of this.markers) m.visible = on;
    for (const a of this.arrows) a.obj.visible = on;
    this.viewer.requestRender();
  }
  get bcsVisible(): boolean { return this.showBcs; }

  /** Zeile für die Legende im Bild: wie stark die Verformung überhöht ist. */
  deformNote(): string | null {
    if (!this.isFem || this.scale <= 0) return null;
    return this.scale === 1 ? 'Verformung in echter Größe' : `Verformung ${fmtScale(this.scale)}-fach überhöht`;
  }

  /** Farben neu aus den Werten (etwa nach geänderter Spanne). */
  recolor(): void {
    const view = this.view;
    if (!view) return;
    const c = new THREE.Color();
    for (const m of this.meshes) {
      const a = this.field === 'stress' && m.stress ? m.stress : m.values;
      const n = a.count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const rgb = resultColor(a.getX(i), view);
        c.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
      m.mesh.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    this.viewer.requestRender();
  }

  hide(): void {
    if (!this.group) return;
    // Zuerst abmelden: Die Deckel des Schnitts hängen an den Netzen und werden dabei mit freigegeben
    this.viewer.setStandIns(null);
    this.viewer.removeLayer(this.group);
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (Array.isArray(m.material) ? m.material : m.material ? [m.material] : []).forEach((x) => x.dispose());
    });
    this.group = null;
    this.meshes = [];
    this.deformables = [];
    this.markers = [];
    this.arrows = [];
    this.meta = null;
    this.scale = 0;
    this.autoScale = 0;
    this.range = null;
    this.stressLimit = 0;
    this.stressMixed = false;
    this.viewer.setModelHidden(false);
  }

  /**
   * Wert unter dem Zeiger: Bauteil, Wert des Dreiecks und der Punkt (mm). Ausgeblendete Teile zählen nicht, durch transparente
   * geht der Zeiger hindurch. Auf der Schnittfläche gibt es keinen Wert (die Werte gelten an der Oberfläche). Bei verformter
   * Anzeige gilt der Punkt in der Ausgangslage, so wie ihn der Agent im Modell findet.
   */
  probe(clientX: number, clientY: number): ResultProbe | null {
    if (!this.group) return null;
    const hit = this.viewer.pickLayer(clientX, clientY);
    if (!hit || hit.cut || hit.face == null) return null;
    const m = this.meshes.find((x) => x.mesh === hit.object);
    if (!m) return null;
    const i = hit.face.a;
    const p = hit.point.clone();
    let disp: number | undefined;
    if (m.disp) {
      const d = new THREE.Vector3(m.disp.getX(i), m.disp.getY(i), m.disp.getZ(i));
      p.addScaledVector(d, -this.scale);
      disp = d.length();
    }
    return {
      name: m.name, value: m.values.getX(i), point: p.toArray().map((v) => +v.toFixed(2)),
      ...(m.stress ? { stress: m.stress.getX(i) } : {}), ...(disp != null ? { disp } : {}),
    };
  }
}

/** Runde Überhöhung: 1, 2, 5, 10, 20, 50 … (nie kleiner als 1). */
export function niceScale(x: number): number {
  if (!(x > 1)) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / e;
  return (f < 2 ? 1 : f < 5 ? 2 : 5) * e;
}

export const fmtScale = (s: number) => s.toLocaleString('de-DE', { maximumFractionDigits: 0 });
