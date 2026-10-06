import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { ViewCube } from './viewcube';

// CAD-Konvention: Z ist oben, Einheit mm. Muss vor dem Anlegen von Kamera und Objekten gesetzt sein.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

interface FaceEntry { id: number; surface: string; area?: number; center?: number[]; triStart: number; triCount: number }
interface EdgeEntry { id: number; curve: string; length?: number; segStart: number; segCount: number }
interface VertexEntry { id: number; p: number[] }
/**
 * `solid`: geschlossener Körper (fehlt bei älteren Builds, gilt dann als geschlossen). Nur dann füllt der Schnitt die Schnittfläche.
 * `axis`: nur bei Normteilen, Richtung aus dem Material heraus. Daran zieht die Explosionsansicht sie heraus.
 */
interface PartMeta { partId: string; name: string; role: string; group?: string | null; solid?: boolean; axis?: number[]; faces: FaceEntry[]; edges?: EdgeEntry[]; vertices?: VertexEntry[] }
interface PartEntry {
  group: THREE.Object3D; meta: PartMeta; meshes: THREE.Mesh[]; lines: THREE.LineSegments[];
  /** Lage des Knotens laut GLB (Einbaulage) und die Verschiebung der Explosionsansicht davon weg. */
  base: THREE.Vector3; offset: THREE.Vector3;
  /** Deckel der Schnittfläche: Zählnetze für den Schablonenpuffer und die Platte in der Ebene (erst beim ersten Schnitt angelegt). */
  cap?: { stencils: THREE.Mesh[]; plate: THREE.Mesh };
  /** Dreiecke in Weltkoordinaten, für die Schnittkontur und den Bereich des Schiebers (erst bei Bedarf berechnet). */
  world?: { pos: Float32Array; idx: ArrayLike<number>; faces: boolean }[];
}

/** Treffer eines Strahls. `cut`: Er trifft die Schnittfläche (dort steckt er in der Schnittebene im Material). */
type Hit = THREE.Intersection & { cut?: boolean };

export interface PickResult {
  partId: string; name: string; role: string;
  faceId: number | null; surface: string | null; area: number | null;
  point: number[];
  /** Angeklickt wurde die Schnittfläche, keine Fläche des Modells. */
  cut?: boolean;
}

/** Schnittebene: sichtbar bleibt, was auf der Seite der Normalen liegt (n·p + c ≥ 0). */
export interface SectionPlane { normal: number[]; constant: number }

/** Angeklickte Fläche, an der sich der Schnitt ausrichten soll. `normal` zeigt aus dem Material heraus. */
export interface PlaneHit { partId: string; name: string; faceId: number; surface: string; normal: number[]; point: number[] }

/**
 * Bauteil in Einbaulage, Grundlage der Explosionsansicht. `min`/`max`: Hüllquader. `axis`: nur Normteile, Einheitsvektor aus
 * dem Material heraus, `span` ihre Ausdehnung entlang dieser Achse.
 */
export interface ExplodePart { id: string; group: string | null; role: string; min: number[]; max: number[]; axis: number[] | null; span: [number, number] | null }

export type ViewName = 'iso' | 'front' | 'back' | 'top' | 'bottom' | 'right' | 'left' | 'fit';

/** Treffer beim Messen: Fläche, Kante oder Eckpunkt eines Bauteils, mit Punkt auf dem Netz (beim Eckpunkt seine Lage). */
export interface ProbeHit {
  partId: string; name: string; kind: 'face' | 'edge' | 'vertex'; id: number;
  /** Flächenart bzw. Kurvenart laut Mesher (PLANE, CYLINDER, LINE, CIRCLE …), bei Eckpunkten VERTEX. */
  type: string;
  /** Flächeninhalt bzw. Länge laut Mesher, zum Abgleich mit der exakten Geometrie. */
  size: number | null;
  point: number[];
}

/** Was die Messung im Viewer zeigt: hervorgehobene Elemente, Punkte, Strecken und eine Beschriftung. */
export interface MeasureMarks {
  entities: { partId: string; kind: 'face' | 'edge' | 'vertex'; id: number }[];
  points: number[][];
  lines: { a: number[]; b: number[]; primary?: boolean }[];
  label?: { at: number[]; text: string };
}

/** Fangradius für Kanten und Eckpunkte in Bildschirmpixeln. Punkte etwas größer, sonst gewönne stets die Kante. */
const EDGE_PX = 7;
const VERTEX_PX = 9;
const ORANGE = 0xf29a38;
/** Zeichenreihenfolge der Deckel: nach allen deckenden Bauteilen (0, Referenzen 1), je Bauteil zwei Schritte. */
const CAP_ORDER = 100;
const CONTOUR_ORDER = 100000;
const CONTOUR_COLOR = 0x0d0f12;

export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.5, 20000);
  private controls: OrbitControls;
  private model: THREE.Object3D | null = null;
  private parts = new Map<string, PartEntry>();
  private highlight = new THREE.Group();
  private hidden = new Set<string>();
  /** Einzeln transparent geschaltete Bauteile (anders als „Transparent“ im Menü, das für alle gilt). */
  private ghosted = new Set<string>();
  private raycaster = new THREE.Raycaster();
  private renderQueued = false;
  private hasFitted = false;
  private edges = true;
  private wire = false;
  private ghost = false;
  private selectedId: string | null = null;
  private mode: 'select' | 'measure' = 'select';
  /** Hervorhebung unter dem Zeiger (Messen) und Markierungen der Messung. */
  private hover = new THREE.Group();
  private marks = new THREE.Group();
  private hoverKey = '';
  private lineMats = new Set<LineMaterial>();
  /** HTML-Ebene über dem Bild: Messpunkte und Beschriftung, bei jedem Zeichnen neu positioniert. */
  private overlay: HTMLElement;
  private overlayItems: { el: HTMLElement; at: THREE.Vector3 }[] = [];
  /** Mitte und Radius aller Bauteile, für die Schnittebenen der Kamera. */
  private center = new THREE.Vector3();
  private radius = 1;
  private cube: ViewCube | null = null;
  private anim: { stop(): void } | null = null;
  /** Punkt am Drehpunkt, sichtbar während der Bewegung und kurz nach dem Setzen. */
  private pivot: THREE.Points;
  private pivotTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * Schnittansicht: Diese eine Liste hängt an allen geschnittenen Materialien (Bauteile, Kanten, Hervorhebungen). Ohne Schnitt
   * ist sie leer, mit Schnitt enthält sie `plane`. three.js merkt die geänderte Anzahl und baut die Shader neu.
   */
  private clip: THREE.Plane[] = [];
  private plane = new THREE.Plane(new THREE.Vector3(1, 0, 0), 0);
  /** Platten der Schnittflächen, je Bauteil eine. */
  private caps = new THREE.Group();
  private contour: LineSegments2 | null = null;
  /** Zu jedem Segment der Schnittkontur Bauteil und Fläche: Beim Messen lässt sich so die Kontur anklicken. */
  private contourOf: { part: PartEntry; face: number }[] = [];
  private contourDirty = false;
  /** Explosionsansicht: Wege der verschobenen Bauteile, gestrichelt von der Einbaulage zur aktuellen Lage. */
  private trails = new THREE.Group();
  private showTrails = true;
  /** Wartet auf einen Klick auf eine Fläche (Schnitt an Fläche ausrichten). */
  private planePick: ((h: PlaneHit | null) => void) | null = null;
  onPick: (r: PickResult | null) => void = () => {};
  /** Klick im Messmodus. null: daneben geklickt. */
  onMeasurePick: (h: ProbeHit | null) => void = () => {};
  /** Klick im Messmodus auf die Schnittfläche selbst (die hat keine exakte Geometrie). */
  onMeasureCut: () => void = () => {};

  constructor(private container: HTMLElement) {
    // Durchsichtiger Hintergrund: den Verlauf dahinter zeichnet CSS, so passt er zur übrigen Oberfläche
    // Schablonenpuffer (stencil) für die gefüllten Schnittflächen, seit three.js r163 nicht mehr von selbst da
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true, stencil: true });
    this.renderer.localClippingEnabled = true;
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);
    this.camera.up.set(0, 0, 1);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(80, -120, 200);
    this.scene.add(sun, this.highlight, this.hover, this.marks, this.caps, this.trails);
    this.overlay = document.createElement('div');
    this.overlay.className = 'v-overlay';
    container.appendChild(this.overlay);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false; // gerendert wird nur bei Änderungen
    // Zoomen zur Mausposition statt zur Mitte: So kommt man an Ecken und Kanten heran, ohne erst zu verschieben
    this.controls.zoomToCursor = true;
    this.controls.minDistance = 0.05;
    this.controls.addEventListener('change', () => { this.fitClip(); this.requestRender(); });
    this.controls.addEventListener('start', () => { this.anim?.stop(); this.showPivot(true); });
    this.controls.addEventListener('end', () => this.showPivot(false, 350));
    const pg = new THREE.BufferGeometry();
    pg.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
    this.pivot = new THREE.Points(pg, new THREE.PointsMaterial({ color: 0xe6e8eb, size: 11, sizeAttenuation: false, map: Viewer.dot(), transparent: true, alphaTest: 0.2, depthTest: false }));
    this.pivot.renderOrder = 12;
    this.pivot.visible = false;
    this.scene.add(this.pivot);
    new ResizeObserver(() => this.resize()).observe(container);
    this.resize();
    this.installPicking();
  }

  // ---- Laden ----------------------------------------------------------------------------------------------------

  /** Ersetzt das Modell. Kamera, Sichtbarkeit und Auswahl bleiben erhalten, damit ein Rebuild nicht stört. */
  async load(glb: ArrayBuffer): Promise<void> {
    const gltf = await new GLTFLoader().parseAsync(glb, '');
    const fresh = new Map<string, PartEntry>();
    gltf.scene.traverse((o) => {
      const meta = (o.userData as { soma?: PartMeta }).soma;
      if (!meta) return;
      const meshes: THREE.Mesh[] = [];
      const lines: THREE.LineSegments[] = [];
      o.traverse((c) => {
        if ((c as THREE.Mesh).isMesh) meshes.push(c as THREE.Mesh);
        if ((c as THREE.LineSegments).isLineSegments) lines.push(c as THREE.LineSegments);
      });
      // Auch die Kanten brauchen ihr eigenes Material, sonst würden sie mit einem transparenten Teil überall blass
      for (const l of lines) {
        l.material = (l.material as THREE.LineBasicMaterial).clone();
        l.material.clippingPlanes = this.clip;
      }
      for (const m of meshes) {
        // Eigenes Material je Netz: die Auswahl färbt ein Bauteil ein, gleichfarbige Teile dürfen nicht mitleuchten
        const mat = (m.material as THREE.MeshStandardMaterial).clone();
        mat.clippingPlanes = this.clip;
        m.material = mat;
        // Flächen minimal nach hinten, damit Kantenlinien nicht mit ihnen um die Tiefe kämpfen
        mat.polygonOffset = true; mat.polygonOffsetFactor = 1; mat.polygonOffsetUnits = 1;
        mat.userData.baseOpacity = mat.opacity;
        mat.userData.baseTransparent = mat.transparent;
        if (meta.role === 'reference') { mat.depthWrite = false; m.renderOrder = 1; }
      }
      fresh.set(meta.partId, { group: o, meta, meshes, lines, base: o.position.clone(), offset: new THREE.Vector3() });
    });
    this.clearCaps();
    this.disposeModel();
    this.model = gltf.scene;
    this.parts = fresh;
    this.scene.add(gltf.scene);
    for (const id of [...this.hidden]) if (!this.parts.has(id)) this.hidden.delete(id);
    for (const id of [...this.ghosted]) if (!this.parts.has(id)) this.ghosted.delete(id);
    this.applyVisibility();
    this.applyDisplay();
    this.highlight.clear();
    this.clearGroup(this.hover);
    this.hoverKey = '';
    if (this.selectedId && !this.parts.has(this.selectedId)) this.selectedId = null;
    this.applySelection();
    this.updateExtent();
    if (!this.hasFitted && this.parts.size) { this.setView('iso'); this.hasFitted = true; }
    this.fitClip();
    this.syncSection();
    this.requestRender();
  }

  clear(): void {
    this.clearCaps();
    this.disposeModel();
    this.parts.clear();
    this.hidden.clear();
    this.ghosted.clear();
    this.hasFitted = false;
    this.highlight.clear();
    this.clearGroup(this.hover);
    this.clearGroup(this.trails);
    this.setMeasureMarks(null);
    this.syncSection();
    this.requestRender();
  }

  private disposeModel(): void {
    if (!this.model) return;
    this.scene.remove(this.model);
    this.model.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
      mats.forEach((x) => x.dispose());
    });
    this.model = null;
  }

  // ---- Sichtbarkeit und Darstellung -----------------------------------------------------------------------------

  partList(): { id: string; name: string; role: string; color: string; group: string | null }[] {
    return [...this.parts.values()].map((p) => ({
      id: p.meta.partId, name: p.meta.name, role: p.meta.role, group: p.meta.group ?? null,
      color: p.meshes[0] ? '#' + (p.meshes[0].material as THREE.MeshStandardMaterial).color.getHexString() : '#888',
    }));
  }

  isVisible(id: string): boolean { return !this.hidden.has(id); }

  setVisible(ids: string | string[], on: boolean): void {
    for (const id of typeof ids === 'string' ? [ids] : ids) { if (on) this.hidden.delete(id); else this.hidden.add(id); }
    this.applyVisibility();
    this.requestRender();
  }

  /** Nur dieses Bauteil (oder diese Gruppe) zeigen. */
  isolate(ids: string | string[]): void {
    const keep = new Set(typeof ids === 'string' ? [ids] : ids);
    for (const k of this.parts.keys()) if (!keep.has(k)) this.hidden.add(k); else this.hidden.delete(k);
    this.applyVisibility();
    this.requestRender();
  }

  isGhosted(id: string): boolean { return this.ghosted.has(id); }

  /** Einzelne Bauteile transparent schalten. Sie lassen dann Klicks durch zu dem, was dahinter liegt. */
  setGhosted(ids: string | string[], on: boolean): void {
    for (const id of typeof ids === 'string' ? [ids] : ids) { if (on) this.ghosted.add(id); else this.ghosted.delete(id); }
    this.applyDisplay();
    this.requestRender();
  }

  showAll(): void { this.hidden.clear(); this.applyVisibility(); this.requestRender(); }

  get hiddenCount(): number { return this.hidden.size; }

  private applyVisibility(): void {
    for (const [id, p] of this.parts) p.group.visible = !this.hidden.has(id);
    this.syncTrails();
    this.syncSection();
  }

  setEdges(on: boolean): void { this.edges = on; this.applyDisplay(); this.requestRender(); }
  setWireframe(on: boolean): void { this.wire = on; this.applyDisplay(); this.requestRender(); }
  setGhost(on: boolean): void { this.ghost = on; this.applyDisplay(); this.requestRender(); }

  private applyDisplay(): void {
    for (const [id, p] of this.parts) {
      const own = this.ghosted.has(id);
      for (const l of p.lines) {
        l.visible = this.edges;
        const lm = l.material as THREE.LineBasicMaterial;
        lm.transparent = own;
        lm.opacity = own ? 0.3 : 1;
      }
      for (const m of p.meshes) {
        const mat = m.material as THREE.MeshStandardMaterial;
        mat.wireframe = this.wire;
        const base = (mat.userData.baseOpacity as number) ?? 1;
        // Einzeln transparent: deutlich durchsichtiger und ohne Tiefe, damit man sieht, was dahinter liegt
        mat.opacity = own ? Math.min(base, 0.18) : this.ghost ? Math.min(base, 0.35) : base;
        mat.transparent = own || this.ghost || (mat.userData.baseTransparent as boolean);
        mat.depthWrite = !own && p.meta.role !== 'reference';
        m.renderOrder = own ? 2 : p.meta.role === 'reference' ? 1 : 0;
        mat.needsUpdate = true;
      }
    }
    this.syncSection();
  }

  /** Sichtbare Bauteile, getrennt nach deckend und einzeln transparent. Treffer gehen zuerst an die deckenden. */
  private pickSets(): [PartEntry[], PartEntry[]] {
    const vis = [...this.parts.values()].filter((p) => p.group.visible);
    return [vis.filter((p) => !this.ghosted.has(p.meta.partId)), vis.filter((p) => this.ghosted.has(p.meta.partId))];
  }

  /** Erste Fläche unter dem Strahl, transparente Teile nur, wenn dahinter nichts Deckendes liegt. */
  private firstHit(): Hit | undefined {
    const [solid, ghost] = this.pickSets();
    return this.visibleHit(solid.flatMap((p) => p.meshes)) ?? this.visibleHit(ghost.flatMap((p) => p.meshes));
  }

  private partOf(o: THREE.Object3D): PartEntry | undefined {
    return [...this.parts.values()].find((p) => p.meshes.includes(o as THREE.Mesh));
  }

  /**
   * Erster sichtbarer Treffer des Strahls: Was der Schnitt wegnimmt, zählt nicht. Ist der erste verbleibende Treffer die
   * Rückseite eines Bauteils mit Deckel, steckt der Strahl in der Schnittebene im Material. Er trifft dann die Schnittfläche.
   */
  private visibleHit(meshes: THREE.Mesh[]): Hit | undefined {
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (!this.clip.length) return hits[0];
    const first = hits.find((h) => !this.clipped(h.point));
    if (!first?.face) return first;
    const ray = this.raycaster.ray;
    const at = ray.intersectPlane(this.plane, new THREE.Vector3());
    if (!at) return first;
    const d = at.distanceTo(ray.origin);
    const back = first.face.normal.clone().transformDirection(first.object.matrixWorld).dot(ray.direction) > 0;
    if (d < first.distance && back && this.partOf(first.object)?.cap?.plate.visible) {
      return { ...first, point: at, distance: d, face: null, faceIndex: undefined, cut: true };
    }
    return first;
  }

  /** Liegt der Punkt auf der weggeschnittenen Seite? Etwas Toleranz, sonst flackerten Punkte genau in der Ebene. */
  private clipped(p: THREE.Vector3): boolean {
    return this.clip.length > 0 && this.plane.distanceToPoint(p) < -Math.max(1e-6, this.radius * 1e-7);
  }

  // ---- Kamera ---------------------------------------------------------------------------------------------------

  private bounds(ids?: string[]): THREE.Box3 {
    const box = new THREE.Box3();
    for (const [id, p] of this.parts) {
      if (ids && !ids.includes(id)) continue;
      if (!ids && !p.group.visible) continue;
      box.expandByObject(p.group);
    }
    return box;
  }

  /** Mitte und Radius aller Bauteile in ihrer aktuellen Lage (die Explosionsansicht vergrößert das Modell). */
  private updateExtent(): void {
    const box = this.bounds([...this.parts.keys()]);
    if (!box.isEmpty()) { box.getCenter(this.center); this.radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1); }
  }

  setView(name: ViewName, ids?: string[]): void {
    const box = this.bounds(ids);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1);
    const dir = {
      iso: new THREE.Vector3(0.8, -1.2, 0.9), front: new THREE.Vector3(0, -1, 0), back: new THREE.Vector3(0, 1, 0),
      top: new THREE.Vector3(0, -0.0001, 1), bottom: new THREE.Vector3(0, -0.0001, -1),
      right: new THREE.Vector3(1, 0, 0), left: new THREE.Vector3(-1, 0, 0),
      fit: this.camera.position.clone().sub(this.controls.target),
    }[name].clone().normalize();
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.05;
    this.anim?.stop();
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.controls.update();
    this.fitClip();
    this.requestRender();
  }

  // ---- Ansichtswürfel und Drehpunkt -----------------------------------------------------------------------------

  /** Den Ansichtswürfel in diesem Element anzeigen. Er dreht sich mit der Kamera und dreht sie auf Klick oder Ziehen. */
  attachCube(el: HTMLElement): void {
    this.cube = new ViewCube(el, {
      camera: this.camera,
      target: () => this.controls.target,
      orient: (d) => this.orient(d),
      orbit: (t, p) => this.orbit(t, p),
    });
    this.cube.render();
  }

  /** Ansicht aus einer Richtung (vom Drehpunkt zur Kamera), animiert. Drehpunkt und Abstand bleiben, anders als bei setView. */
  orient(dir: THREE.Vector3): void {
    const target = this.controls.target.clone();
    const dist = this.camera.position.distanceTo(target);
    const from = this.camera.position.clone().sub(target).normalize();
    const to = dir.clone().normalize();
    // Genau senkrecht kann die Kamera nicht stehen (Hochachse Z): ein Hauch nach vorne, dann liegt „Vorne“ unten im Bild
    if (Math.abs(to.z) > 0.999999) to.set(0, -1e-4, Math.sign(to.z)).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(from, to), id = new THREE.Quaternion();
    this.animate(280, (t) => {
      this.camera.position.copy(target).addScaledVector(from.clone().applyQuaternion(id.clone().slerp(q, t)), dist);
      this.controls.update();
    });
  }

  /** Wie orient, mit der Richtung als Zahlen (vom Drehpunkt zur Kamera). */
  lookFrom(dir: number[]): void { this.orient(new THREE.Vector3(dir[0], dir[1], dir[2])); }

  /** Um den Drehpunkt drehen, wie OrbitControls es tut (Kugelkoordinaten zur Hochachse). */
  orbit(dTheta: number, dPhi: number): void {
    this.anim?.stop();
    const target = this.controls.target;
    const toY = new THREE.Quaternion().setFromUnitVectors(this.camera.up, new THREE.Vector3(0, 1, 0));
    const off = this.camera.position.clone().sub(target).applyQuaternion(toY);
    const sph = new THREE.Spherical().setFromVector3(off);
    sph.theta += dTheta;
    sph.phi = Math.min(Math.PI - 1e-4, Math.max(1e-4, sph.phi + dPhi));
    off.setFromSpherical(sph).applyQuaternion(toY.invert());
    this.camera.position.copy(target).add(off);
    this.controls.update();
  }

  /**
   * Neuer Drehpunkt: Die Ansicht verschiebt sich (ohne zu drehen), bis der Punkt in der Mitte liegt. Danach dreht und
   * zoomt sie um ihn. So lassen sich Ecken und kleine Stellen genau ansehen. „Einpassen“ oder „Standardansicht“ setzen zurück.
   */
  setPivot(p: THREE.Vector3): void {
    const t0 = this.controls.target.clone(), c0 = this.camera.position.clone();
    const delta = p.clone().sub(t0);
    this.animate(250, (t) => {
      this.controls.target.copy(t0).addScaledVector(delta, t);
      this.camera.position.copy(c0).addScaledVector(delta, t);
      this.controls.update();
    });
    this.showPivot(true);
    this.showPivot(false, 900);
  }

  /** Zeitgesteuerte Bewegung. Ohne Bildwiederholung (unsichtbares Fenster) steht sie nach Ablauf trotzdem am Ziel. */
  private animate(ms: number, step: (t: number) => void): void {
    this.anim?.stop();
    const t0 = performance.now();
    let raf = 0, done = false;
    const stop = () => { done = true; cancelAnimationFrame(raf); clearTimeout(timer); if (this.anim === handle) this.anim = null; };
    const finish = () => { if (done) return; stop(); step(1); };
    const tick = () => {
      if (done) return;
      const t = Math.min(1, (performance.now() - t0) / ms);
      if (t >= 1) { finish(); return; }
      step(t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
      raf = requestAnimationFrame(tick);
    };
    const timer = setTimeout(finish, ms + 60);
    const handle = { stop };
    this.anim = handle;
    raf = requestAnimationFrame(tick);
  }

  private showPivot(on: boolean, afterMs = 0): void {
    clearTimeout(this.pivotTimer);
    const apply = () => { this.pivot.visible = on && this.parts.size > 0; this.requestRender(); };
    if (afterMs) this.pivotTimer = setTimeout(apply, afterMs); else apply();
  }

  /**
   * Schnittebenen der Kamera nach Abstand: Nah am Drehpunkt muss die vordere Ebene nah heran, sonst schneidet sie die
   * Ecke weg, die man ansehen will. Die hintere reicht über das ganze Modell.
   */
  private fitClip(): void {
    const dist = Math.max(this.camera.position.distanceTo(this.controls.target), 1e-3);
    const near = Math.max(dist / 200, 1e-3);
    const far = Math.max(this.camera.position.distanceTo(this.center) + this.radius * 2, near * 100);
    if (Math.abs(near - this.camera.near) > near * 0.02 || Math.abs(far - this.camera.far) > far * 0.02) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
  }

  focusPart(id: string): void { if (this.parts.has(id)) this.setView('fit', [id]); }

  // ---- Auswahl --------------------------------------------------------------------------------------------------

  private static faceOfTriangle(faces: FaceEntry[], tri: number): FaceEntry | null {
    let lo = 0, hi = faces.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (faces[mid].triStart <= tri) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    while (ans >= 0 && !(tri < faces[ans].triStart + faces[ans].triCount)) ans--; // Flächen ohne Dreiecke überspringen
    return ans >= 0 ? faces[ans] : null;
  }

  pickAt(ndcX: number, ndcY: number): PickResult | null {
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const hit = this.firstHit();
    this.highlight.clear();
    if (!hit) { this.selectedId = null; this.applySelection(); this.requestRender(); return null; }
    const part = this.partOf(hit.object)!;
    const face = hit.faceIndex != null ? Viewer.faceOfTriangle(part.meta.faces, hit.faceIndex) : null;
    this.selectedId = part.meta.partId;
    this.applySelection();
    if (face && face.triCount) this.highlightFace(part, face);
    this.requestRender();
    return {
      partId: part.meta.partId, name: part.meta.name, role: part.meta.role,
      faceId: face?.id ?? null, surface: face?.surface ?? null, area: face?.area ?? null,
      // In Einbaulage: Die Explosionsansicht verschiebt nur die Darstellung, der Agent kennt nur das Modell
      point: hit.point.clone().sub(part.offset).toArray().map((v) => +v.toFixed(3)),
      ...(hit.cut ? { cut: true } : {}),
    };
  }

  private highlightFace(part: PartEntry, face: FaceEntry): void {
    const src = part.meshes.find((m) => m.geometry.index);
    if (!src) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', src.geometry.getAttribute('position'));
    g.setIndex(Array.from(src.geometry.index!.array.slice(face.triStart * 3, (face.triStart + face.triCount) * 3)));
    const o = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color: 0xf29a38, transparent: true, opacity: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide,
      clippingPlanes: this.clip }));
    o.renderOrder = 2;
    this.attach(o, src);
    this.highlight.add(o);
  }

  /** Hervorhebung in den Koordinaten von `src` (Netz oder Knoten eines Bauteils): Sie wandert mit, wenn die Explosionsansicht es verschiebt. */
  private attach(o: THREE.Object3D, src: THREE.Object3D): void {
    o.matrixAutoUpdate = false;
    o.userData.follow = src;
    src.updateMatrixWorld();
    o.matrix.copy(src.matrixWorld);
  }

  /** Angehängte Hervorhebungen an die aktuelle Lage ihrer Bauteile setzen. */
  private follow(): void {
    for (const g of [this.highlight, this.hover, this.marks]) {
      for (const o of g.children) {
        const src = o.userData.follow as THREE.Object3D | undefined;
        if (src) { o.matrix.copy(src.matrixWorld); o.matrixWorldNeedsUpdate = true; }
      }
    }
  }

  private installPicking(): void {
    const el = this.renderer.domElement;
    let down: [number, number] | null = null;
    el.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return; // Ziehen ist kein Klick
      if (this.planePick) { const cb = this.planePick; this.pickPlane(null); cb(this.planeAt(e.clientX, e.clientY)); return; }
      if (this.mode === 'measure') {
        const h = this.probeAt(e.clientX, e.clientY);
        if (h === 'cut') this.onMeasureCut(); else this.onMeasurePick(h);
        return;
      }
      const r = el.getBoundingClientRect();
      this.onPick(this.pickAt(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1));
    });
    // Messen: Element unter dem Zeiger hervorheben (höchstens einmal pro Bild berechnet)
    let queued: [number, number] | null = null;
    el.addEventListener('pointermove', (e) => {
      if ((this.mode !== 'measure' && !this.planePick) || e.buttons) return;
      if (!queued) requestAnimationFrame(() => {
        const q = queued;
        queued = null;
        if (!q) return;
        if (this.planePick) { const f = this.planeAt(q[0], q[1]); this.showHover(f ? { partId: f.partId, name: f.name, kind: 'face', id: f.faceId, type: f.surface, size: null, point: f.point } : null); }
        else if (this.mode === 'measure') this.showHover(this.probe(q[0], q[1]));
      });
      queued = [e.clientX, e.clientY];
    });
    el.addEventListener('pointerleave', () => this.showHover(null));
    // Doppelklick ins Modell: Drehpunkt dorthin (auch beim Messen)
    el.addEventListener('dblclick', (e) => {
      const r = el.getBoundingClientRect();
      this.raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
      const hit = this.firstHit();
      if (hit) this.setPivot(hit.point.clone());
    });
  }

  // ---- Messen ---------------------------------------------------------------------------------------------------

  /** Umschalten zwischen Auswählen (Klick wählt ein Bauteil) und Messen (Klick wählt Fläche oder Kante). */
  setMode(m: 'select' | 'measure'): void {
    this.mode = m;
    this.updateCursor();
    if (m !== 'measure') this.showHover(null);
  }

  private updateCursor(): void {
    this.renderer.domElement.style.cursor = this.mode === 'measure' || this.planePick ? 'crosshair' : '';
  }

  /**
   * Eckpunkt, Kante oder Fläche unter einem Bildschirmpunkt, in dieser Reihenfolge: Punkte gewinnen im Umkreis von VERTEX_PX,
   * Kanten im Umkreis von EDGE_PX, sonst gilt die Fläche (sonst ließen sich Punkte und Kanten kaum treffen). Verdeckte Punkte
   * und Kanten zählen nicht, ebenso wenig ausgeblendete Bauteile. Ohne sichtbare Kanten gibt es auch keine Punkte.
   */
  probe(clientX: number, clientY: number): ProbeHit | null {
    const h = this.probeAt(clientX, clientY);
    return h === 'cut' ? null : h;
  }

  /** Wie probe, nur mit 'cut', wenn der Klick die Schnittfläche selbst trifft. */
  private probeAt(clientX: number, clientY: number): ProbeHit | 'cut' | null {
    const el = this.renderer.domElement;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const px = clientX - r.left, py = clientY - r.top;
    this.camera.updateMatrixWorld();
    // Erst die deckenden Teile, transparent geschaltete nur, wenn dort nichts anderes liegt: So misst man durch sie hindurch
    const [solid, ghost] = this.pickSets();
    return this.probeIn(px, py, r.width, r.height, solid) ?? this.probeIn(px, py, r.width, r.height, ghost);
  }

  private probeIn(px: number, py: number, w: number, h: number, parts: PartEntry[]): ProbeHit | 'cut' | null {
    if (!parts.length) return null;
    const targets = parts.flatMap((p) => p.meshes);
    this.raycaster.setFromCamera(new THREE.Vector2((px / w) * 2 - 1, -(py / h) * 2 + 1), this.camera);
    const hit = this.visibleHit(targets);
    const vertex = this.nearestVertex(px, py, w, h, parts, targets);
    if (vertex) return vertex;
    const edge = this.nearestEdge(px, py, w, h, parts, targets);
    if (edge) return edge;
    // Am Schnitt: Ein Klick nahe der Kontur wählt die Fläche, aus der sie stammt (so misst man Wandstärken im Schnitt)
    const rim = this.nearestContour(px, py, w, h, parts, targets);
    if (rim) return rim;
    if (!hit) return null;
    if (hit.cut) return 'cut';
    const part = this.partOf(hit.object)!;
    const face = hit.faceIndex != null ? Viewer.faceOfTriangle(part.meta.faces, hit.faceIndex) : null;
    if (!face) return null;
    return { partId: part.meta.partId, name: part.meta.name, kind: 'face', id: face.id, type: face.surface, size: face.area ?? null, point: hit.point.toArray() };
  }

  /** Liegt der Weltpunkt hinter einer Fläche oder einer Schnittfläche? Toleranz für die Vernetzung, sonst verdeckte die eigene Fläche ihre Kanten. */
  private occluded(p: THREE.Vector3, occluders: THREE.Mesh[]): boolean {
    const eye = this.camera.position;
    const dist = eye.distanceTo(p);
    this.raycaster.set(eye, p.clone().sub(eye).normalize());
    const first = this.visibleHit(occluders);
    return !!first && first.distance < dist - Math.max(0.5, dist * 0.002);
  }

  private nearestVertex(px: number, py: number, w: number, h: number, parts: PartEntry[], occluders: THREE.Mesh[]): ProbeHit | null {
    const v = new THREE.Vector3(), s = new THREE.Vector3();
    const cands: { part: PartEntry; vx: VertexEntry; d: number; point: THREE.Vector3 }[] = [];
    for (const p of parts) {
      if (!p.meta.vertices?.length || !p.lines.some((l) => l.visible)) continue;
      p.group.updateMatrixWorld();
      for (const vx of p.meta.vertices) {
        v.set(vx.p[0], vx.p[1], vx.p[2]).applyMatrix4(p.group.matrixWorld);
        if (this.clipped(v)) continue;
        s.copy(v).project(this.camera);
        if (s.z > 1) continue;
        const d = Math.hypot((s.x + 1) / 2 * w - px, (1 - s.y) / 2 * h - py);
        if (d <= VERTEX_PX) cands.push({ part: p, vx, d, point: v.clone() });
      }
    }
    cands.sort((a, b) => a.d - b.d);
    for (const c of cands.slice(0, 8)) {
      if (this.occluded(c.point, occluders)) continue;
      return { partId: c.part.meta.partId, name: c.part.meta.name, kind: 'vertex', id: c.vx.id, type: 'VERTEX', size: null, point: c.point.toArray() };
    }
    return null;
  }

  private nearestEdge(px: number, py: number, w: number, h: number, parts: PartEntry[], occluders: THREE.Mesh[]): ProbeHit | null {
    const a = new THREE.Vector3(), b = new THREE.Vector3(), sa = new THREE.Vector3(), sb = new THREE.Vector3();
    const cands: { part: PartEntry; seg: number; d: number; point: THREE.Vector3 }[] = [];
    for (const p of parts) {
      if (!p.meta.edges?.length) continue;
      for (const l of p.lines) {
        if (!l.visible) continue;
        const pos = l.geometry.getAttribute('position');
        l.updateMatrixWorld();
        for (let i = 0; i + 1 < pos.count; i += 2) {
          a.fromBufferAttribute(pos, i).applyMatrix4(l.matrixWorld);
          b.fromBufferAttribute(pos, i + 1).applyMatrix4(l.matrixWorld);
          sa.copy(a).project(this.camera);
          sb.copy(b).project(this.camera);
          if (sa.z > 1 || sb.z > 1) continue; // hinter der Kamera
          const ax = (sa.x + 1) / 2 * w, ay = (1 - sa.y) / 2 * h, bx = (sb.x + 1) / 2 * w, by = (1 - sb.y) / 2 * h;
          const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
          const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
          const d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
          if (d <= EDGE_PX) cands.push({ part: p, seg: i / 2, d, point: a.clone().lerp(b, t) });
        }
      }
    }
    cands.sort((x, y) => x.d - y.d);
    for (const c of cands.slice(0, 8)) {
      if (this.clipped(c.point) || this.occluded(c.point, occluders)) continue;
      const edge = Viewer.edgeOfSegment(c.part.meta.edges!, c.seg);
      if (!edge) continue;
      return { partId: c.part.meta.partId, name: c.part.meta.name, kind: 'edge', id: edge.id, type: edge.curve, size: edge.length ?? null, point: c.point.toArray() };
    }
    return null;
  }

  /** Nächstes Segment der Schnittkontur in der Nähe: liefert die Fläche, die dort geschnitten wird. */
  private nearestContour(px: number, py: number, w: number, h: number, parts: PartEntry[], occluders: THREE.Mesh[]): ProbeHit | null {
    if (!this.clip.length) return null;
    this.prepareSection();
    if (!this.contour) return null;
    const pos = (this.contour.geometry as LineSegmentsGeometry).getAttribute('instanceStart') as THREE.InterleavedBufferAttribute;
    const end = (this.contour.geometry as LineSegmentsGeometry).getAttribute('instanceEnd') as THREE.InterleavedBufferAttribute;
    const allowed = new Set(parts);
    const a = new THREE.Vector3(), b = new THREE.Vector3(), sa = new THREE.Vector3(), sb = new THREE.Vector3();
    const cands: { k: number; d: number; point: THREE.Vector3 }[] = [];
    for (let k = 0; k < this.contourOf.length; k++) {
      if (!allowed.has(this.contourOf[k].part)) continue;
      a.fromBufferAttribute(pos, k); b.fromBufferAttribute(end, k);
      sa.copy(a).project(this.camera); sb.copy(b).project(this.camera);
      if (sa.z > 1 || sb.z > 1) continue;
      const ax = (sa.x + 1) / 2 * w, ay = (1 - sa.y) / 2 * h, bx = (sb.x + 1) / 2 * w, by = (1 - sb.y) / 2 * h;
      const dx = bx - ax, dy = by - ay, len = dx * dx + dy * dy;
      const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
      const d = Math.hypot(px - ax - t * dx, py - ay - t * dy);
      if (d <= EDGE_PX) cands.push({ k, d, point: a.clone().lerp(b, t) });
    }
    cands.sort((x, y) => x.d - y.d);
    for (const c of cands.slice(0, 8)) {
      if (this.occluded(c.point, occluders)) continue;
      const { part, face: fid } = this.contourOf[c.k];
      const face = part.meta.faces.find((f) => f.id === fid);
      if (!face) continue;
      return { partId: part.meta.partId, name: part.meta.name, kind: 'face', id: face.id, type: face.surface, size: face.area ?? null, point: c.point.toArray() };
    }
    return null;
  }

  private static edgeOfSegment(edges: EdgeEntry[], seg: number): EdgeEntry | null {
    let lo = 0, hi = edges.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (edges[mid].segStart <= seg) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans >= 0 && seg < edges[ans].segStart + edges[ans].segCount ? edges[ans] : null;
  }

  private showHover(h: ProbeHit | null): void {
    const key = h ? `${h.partId}|${h.kind}|${h.id}` : '';
    if (key === this.hoverKey) return;
    this.hoverKey = key;
    this.clearGroup(this.hover);
    if (h) this.addEntity(this.hover, h.partId, h.kind, h.id, 0xffffff, 0.22, 2);
    this.requestRender();
  }

  /** Messung zeichnen (oder mit null entfernen). Die Elemente stehen in Orange (Auswahl), die Strecken darüber. */
  setMeasureMarks(m: MeasureMarks | null): void {
    this.clearGroup(this.marks);
    for (const it of this.overlayItems) it.el.remove();
    this.overlayItems = [];
    if (m) {
      for (const e of m.entities) this.addEntity(this.marks, e.partId, e.kind, e.id, ORANGE, 0.5, 3);
      for (const l of m.lines) {
        this.marks.add(this.fatLines([...l.a, ...l.b], l.primary ? ORANGE : 0xe6e8eb, l.primary ? 2.5 : 1.5, !l.primary));
      }
      for (const p of m.points) this.addOverlay('v-pt', '', p);
      if (m.label) this.addOverlay('v-label', m.label.text, m.label.at);
    }
    this.requestRender();
  }

  private addOverlay(cls: string, text: string, at: number[]): void {
    const el = document.createElement('div');
    el.className = cls;
    el.textContent = text; // Werte, kein Text aus dem Projekt, trotzdem nie innerHTML
    this.overlay.appendChild(el);
    this.overlayItems.push({ el, at: new THREE.Vector3(...(at as [number, number, number])) });
  }

  private addEntity(group: THREE.Group, partId: string, kind: 'face' | 'edge' | 'vertex', id: number, color: number, opacity: number, width: number): void {
    const p = this.parts.get(partId);
    if (!p) return;
    if (kind === 'vertex') {
      const vx = p.meta.vertices?.find((x) => x.id === id);
      if (!vx) return;
      // Ein runder Punkt fester Bildgröße, immer sichtbar (Hervorhebung: größer, Auswahl in Orange)
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(vx.p.slice(0, 3), 3));
      const m = new THREE.PointsMaterial({ color, size: 6 + width * 3, sizeAttenuation: false, map: Viewer.dot(), transparent: true, alphaTest: 0.2, depthTest: false });
      const o = new THREE.Points(g, m);
      o.renderOrder = 11;
      this.attach(o, p.group);
      group.add(o);
      return;
    }
    if (kind === 'face') {
      const face = p.meta.faces.find((f) => f.id === id);
      const src = p.meshes.find((m) => m.geometry.index);
      if (!face || !face.triCount || !src) return;
      // Eigene, kompakte Dreiecke: So lässt sich die Hervorhebung freigeben, ohne die Daten des Bauteils anzufassen
      const pos = src.geometry.getAttribute('position'), idx = src.geometry.index!;
      const tri = new Float32Array(face.triCount * 9);
      for (let k = 0; k < face.triCount * 3; k++) {
        const vi = idx.getX(face.triStart * 3 + k);
        tri[k * 3] = pos.getX(vi); tri[k * 3 + 1] = pos.getY(vi); tri[k * 3 + 2] = pos.getZ(vi);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(tri, 3));
      const o = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide,
        clippingPlanes: this.clip }));
      o.renderOrder = 3;
      this.attach(o, src);
      group.add(o);
      return;
    }
    const edge = p.meta.edges?.find((e) => e.id === id);
    const l = p.lines[0];
    if (!edge || !l) return;
    const pos = l.geometry.getAttribute('position');
    const flat: number[] = [];
    for (let s = edge.segStart; s < edge.segStart + edge.segCount; s++) {
      for (const k of [s * 2, s * 2 + 1]) flat.push(pos.getX(k), pos.getY(k), pos.getZ(k));
    }
    const o = this.fatLines(flat, color, width, false, true);
    this.attach(o, l);
    group.add(o);
  }

  private static dotTexture: THREE.Texture | null = null;
  /** Runde Punktform mit dunklem Rand, einmal gezeichnet und für alle Punkte geteilt. */
  private static dot(): THREE.Texture {
    if (!Viewer.dotTexture) {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d')!;
      g.beginPath();
      g.arc(32, 32, 26, 0, Math.PI * 2);
      g.fillStyle = '#ffffff';
      g.fill();
      g.lineWidth = 8;
      g.strokeStyle = 'rgba(0,0,0,0.65)';
      g.stroke();
      Viewer.dotTexture = new THREE.CanvasTexture(c);
    }
    return Viewer.dotTexture;
  }

  /**
   * Linien mit fester Breite in Pixeln (WebGL-Linien sind sonst immer 1 px). Immer sichtbar, auch hinter Flächen.
   * `clipped`: Der Schnitt nimmt sie mit weg (Kanten des Modells, nicht aber Messstrecken).
   */
  private fatLines(flat: number[], color: number, width: number, dashed: boolean, clipped = false): LineSegments2 {
    const g = new LineSegmentsGeometry();
    g.setPositions(flat);
    const m = new LineMaterial({ color, linewidth: width, depthTest: false, transparent: true, dashed, dashSize: 1.2, gapSize: 0.9 });
    if (clipped) m.clippingPlanes = this.clip;
    m.resolution.set(this.container.clientWidth || 1, this.container.clientHeight || 1);
    this.lineMats.add(m);
    const l = new LineSegments2(g, m);
    if (dashed) l.computeLineDistances();
    l.renderOrder = 10;
    return l;
  }

  private clearGroup(g: THREE.Group): void {
    for (const o of [...g.children]) {
      g.remove(o);
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      const mat = m.material as THREE.Material | undefined;
      if (mat) { if (mat instanceof LineMaterial) this.lineMats.delete(mat); mat.dispose(); }
    }
  }

  private placeOverlay(): void {
    if (!this.overlayItems.length) return;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const v = new THREE.Vector3();
    for (const it of this.overlayItems) {
      v.copy(it.at).project(this.camera);
      const off = v.z > 1 || v.x < -1.2 || v.x > 1.2 || v.y < -1.2 || v.y > 1.2;
      it.el.hidden = off;
      if (!off) it.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px)`;
    }
  }

  select(id: string | null): void { this.selectedId = id; this.highlight.clear(); this.applySelection(); this.requestRender(); }

  /** Das ausgewählte Bauteil leuchtet leicht orange (Farbe der Auswahl in der ganzen Oberfläche). */
  private applySelection(): void {
    for (const [id, p] of this.parts) {
      for (const m of p.meshes) (m.material as THREE.MeshStandardMaterial).emissive?.setHex(id === this.selectedId ? 0x5a2e00 : 0x000000);
    }
  }
  get selection(): string | null { return this.selectedId; }

  // ---- Rendern --------------------------------------------------------------------------------------------------

  private resize(): void {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    for (const m of this.lineMats) m.resolution.set(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  requestRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.pivot.position.copy(this.controls.target);
      this.prepareSection();
      this.renderer.render(this.scene, this.camera);
      this.placeOverlay();
      this.cube?.render();
    });
  }

  /**
   * Bild der aktuellen Ansicht in voller Auflösung, Grundlage der Markierung (E16). Die Zeichenfläche ist durchsichtig,
   * den Verlauf dahinter malt sonst CSS. Er wird hier nachgebildet (`radial-gradient(ellipse at 52% 44%, …)` in style.css),
   * damit das Bild aussieht wie der Viewer. Die Auswahl fehlt im Bild: Sie ist Orange wie der Stift und würde die Markierung verschlucken.
   */
  snapshot(): HTMLCanvasElement {
    const sel = this.selectedId;
    this.selectedId = null;
    this.applySelection();
    this.highlight.visible = false;
    this.hover.visible = false; // Messlinien ohne ihre Beschriftung wären im Bild nur verwirrend
    this.marks.visible = false;
    const pivotShown = this.pivot.visible;
    this.pivot.visible = false;
    this.prepareSection();
    this.renderer.render(this.scene, this.camera);
    const c = document.createElement('canvas');
    try { this.paintSnapshot(c); } finally {
      this.selectedId = sel;
      this.applySelection();
      this.highlight.visible = true;
      this.hover.visible = true;
      this.marks.visible = true;
      this.pivot.visible = pivotShown;
      this.requestRender();
    }
    return c;
  }

  private paintSnapshot(c: HTMLCanvasElement): void {
    const src = this.renderer.domElement;
    c.width = src.width; c.height = src.height;
    const g = c.getContext('2d');
    if (!g || !c.width || !c.height) return;
    const w = c.width, h = c.height, cx = w * 0.52, cy = h * 0.44;
    // CSS: Ellipse mit dem Seitenverhältnis von closest-side, die durch die fernste Ecke geht (farthest-corner)
    const k = Math.min(cx, w - cx) / Math.min(cy, h - cy);
    const ry = Math.hypot(Math.max(cx, w - cx) / k, Math.max(cy, h - cy)), rx = ry * k;
    g.save();
    g.translate(cx, cy);
    g.scale(1, ry / rx);
    const grad = g.createRadialGradient(0, 0, 0, 0, 0, rx);
    grad.addColorStop(0, '#272c34'); grad.addColorStop(0.6, '#1b1e23'); grad.addColorStop(1, '#16181c');
    g.fillStyle = grad;
    g.fillRect(-cx, -cy * rx / ry, w, h * rx / ry);
    g.restore();
    g.drawImage(src, 0, 0);
  }

  /**
   * Vorschaubild für die Startseite: aktuelle Ansicht, mittig auf das Seitenverhältnis zugeschnitten, als JPEG.
   * Der Hintergrund ist sonst durchsichtig, deshalb bekommt das Bild den Grundton der Oberfläche.
   */
  thumbnail(w = 360, h = 240): string | null {
    const src = this.renderer.domElement;
    if (!this.parts.size || !src.width || !src.height) return null;
    // Ohne Schnitt: Auf der Startseite soll das Modell ganz zu sehen sein
    const cut = this.clip.length > 0;
    if (cut) { this.clip.length = 0; this.caps.visible = false; if (this.contour) this.contour.visible = false; }
    this.renderer.render(this.scene, this.camera);
    if (cut) { this.clip.push(this.plane); this.caps.visible = true; if (this.contour) this.contour.visible = true; this.requestRender(); }
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    if (!g) return null;
    const grad = g.createRadialGradient(w / 2, h * 0.45, 0, w / 2, h * 0.45, w * 0.7);
    grad.addColorStop(0, '#272c34'); grad.addColorStop(1, '#1b1e23');
    g.fillStyle = grad; g.fillRect(0, 0, w, h);
    // Ganz hineinpassen lassen (das Modell füllt den Viewer fast aus, Beschneiden kappt sonst Kanten)
    const scale = Math.min(w / src.width, h / src.height);
    const dw = src.width * scale, dh = src.height * scale;
    g.drawImage(src, 0, 0, src.width, src.height, (w - dw) / 2, (h - dh) / 2, dw, dh);
    return c.toDataURL('image/jpeg', 0.82);
  }

  // ---- Schnitt --------------------------------------------------------------------------------------------------

  /** Schnittebene setzen oder mit null aufheben. Sichtbar bleibt, was auf der Seite der Normalen liegt. */
  setSection(s: SectionPlane | null): void {
    if (s) {
      this.plane.normal.set(s.normal[0], s.normal[1], s.normal[2]).normalize();
      this.plane.constant = s.constant;
      if (!this.clip.length) this.clip.push(this.plane);
    } else this.clip.length = 0;
    this.syncSection();
    this.requestRender();
  }

  get section(): SectionPlane | null {
    return this.clip.length ? { normal: this.plane.normal.toArray(), constant: this.plane.constant } : null;
  }

  /** Von wo bis wo reichen die sichtbaren Bauteile entlang einer Richtung? Für den Bereich des Schiebers. */
  extent(dir: number[], ids?: string[]): [number, number] | null {
    const d = new THREE.Vector3(dir[0], dir[1], dir[2]).normalize();
    let lo = Infinity, hi = -Infinity;
    for (const [id, p] of this.parts) {
      if (ids ? !ids.includes(id) : !p.group.visible) continue;
      for (const w of this.worldOf(p)) {
        const pos = w.pos;
        for (let i = 0; i < pos.length; i += 3) {
          const v = d.x * pos[i] + d.y * pos[i + 1] + d.z * pos[i + 2];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
    }
    return lo <= hi ? [lo, hi] : null;
  }

  /** Der nächste Klick ins Modell wählt eine Fläche (Rückruf mit null: daneben). pickPlane(null) bricht ab. */
  pickPlane(cb: ((h: PlaneHit | null) => void) | null): void {
    this.planePick = cb;
    this.updateCursor();
    if (!cb) this.showHover(null);
  }

  get pickingPlane(): boolean { return !!this.planePick; }

  /** Fläche unter dem Zeiger mit ihrer Normalen (nach außen) und einem Punkt darauf. */
  private planeAt(clientX: number, clientY: number): PlaneHit | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.camera);
    const hit = this.firstHit();
    if (!hit || hit.cut || !hit.face || hit.faceIndex == null) return null;
    const part = this.partOf(hit.object)!;
    const face = Viewer.faceOfTriangle(part.meta.faces, hit.faceIndex);
    if (!face) return null;
    const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    // Achsparallel bleibt exakt achsparallel (die Normale des Dreiecks hat Rundungsfehler im Netz)
    const snapped = n.toArray().map((x) => (Math.abs(x) < 1e-6 ? 0 : Math.abs(Math.abs(x) - 1) < 1e-6 ? Math.sign(x) : x));
    n.fromArray(snapped).normalize();
    const point = face.center && face.surface === 'PLANE'
      ? new THREE.Vector3(...(face.center as [number, number, number])).applyMatrix4(part.group.matrixWorld) : hit.point;
    return { partId: part.meta.partId, name: part.meta.name, faceId: face.id, surface: face.surface, normal: n.toArray(), point: point.toArray() };
  }

  /** Dreiecke eines Bauteils in Weltkoordinaten (einmal berechnet, bis die Explosionsansicht das Bauteil verschiebt). */
  private worldOf(p: PartEntry): NonNullable<PartEntry['world']> {
    if (p.world) return p.world;
    p.group.updateMatrixWorld(true);
    const v = new THREE.Vector3();
    const faceMesh = p.meshes.find((m) => m.geometry.index);
    p.world = p.meshes.map((m) => {
      const src = m.geometry.getAttribute('position');
      const pos = new Float32Array(src.count * 3);
      for (let i = 0; i < src.count; i++) { v.fromBufferAttribute(src, i).applyMatrix4(m.matrixWorld); pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z; }
      const idx = m.geometry.index ? m.geometry.index.array : Array.from({ length: src.count }, (_, i) => i);
      return { pos, idx, faces: m === faceMesh };
    });
    return p.world;
  }

  /**
   * Deckel und Kontur an den aktuellen Stand anpassen: Deckel nur für sichtbare, deckende, geschlossene Körper. Transparente
   * Teile und Referenzen bekommen keinen (ihr Inneres ist ohnehin zu sehen), im Drahtgitter gibt es nur die Kontur.
   */
  private syncSection(): void {
    const on = this.clip.length > 0;
    let k = 0;
    for (const [id, p] of this.parts) {
      const mat = p.meshes[0]?.material as THREE.MeshStandardMaterial | undefined;
      const want = on && !this.wire && p.group.visible && p.meta.solid !== false && !this.ghosted.has(id) && !!mat && !mat.userData.baseTransparent;
      if (want && !p.cap) p.cap = this.makeCap(p);
      if (p.cap) {
        for (const s of p.cap.stencils) { s.visible = want; s.renderOrder = CAP_ORDER + 2 * k; }
        p.cap.plate.visible = want;
        p.cap.plate.renderOrder = CAP_ORDER + 2 * k + 1;
      }
      if (want) k++;
    }
    if (on) this.placeCaps();
    this.contourDirty = true;
  }

  /**
   * Gefüllte Schnittfläche nach dem Verfahren mit dem Schablonenpuffer: Die Rückseiten des geschnittenen Körpers zählen hoch,
   * die Vorderseiten herunter. Wo etwas übrig bleibt, liegt die Schnittebene im Material, dort zeichnet die Platte in der Ebene.
   * Sie setzt den Puffer dabei zurück, damit das nächste Bauteil von vorn zählt.
   */
  private makeCap(p: PartEntry): NonNullable<PartEntry['cap']> {
    const stencils: THREE.Mesh[] = [];
    for (const m of p.meshes) {
      for (const back of [true, false]) {
        const op = back ? THREE.IncrementWrapStencilOp : THREE.DecrementWrapStencilOp;
        const mat = new THREE.MeshBasicMaterial({
          side: back ? THREE.BackSide : THREE.FrontSide, depthWrite: false, depthTest: false, colorWrite: false,
          stencilWrite: true, stencilFunc: THREE.AlwaysStencilFunc, stencilFail: op, stencilZFail: op, stencilZPass: op,
        });
        mat.clippingPlanes = this.clip;
        const s = new THREE.Mesh(m.geometry, mat);
        s.raycast = () => {};
        m.add(s); // gleiche Lage wie das Netz, wird mit ihm freigegeben
        stencils.push(s);
      }
    }
    const base = (p.meshes[0].material as THREE.MeshStandardMaterial).color;
    const mat = new THREE.MeshBasicMaterial({
      color: base.clone().multiplyScalar(0.72), side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      stencilWrite: true, stencilRef: 0, stencilFunc: THREE.NotEqualStencilFunc,
      stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp, stencilZPass: THREE.ReplaceStencilOp,
    });
    // Schraffur im Bildraum wie in Schnittzeichnungen, je Bauteil abwechselnd gekippt (gleiche Shader, eigene Werte)
    const dpr = window.devicePixelRatio || 1;
    const hatch = new THREE.Vector3(this.caps.children.length % 2 ? -1 : 1, 7 * dpr, 0.6 * dpr);
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uHatch = { value: hatch };
      sh.fragmentShader = 'uniform vec3 uHatch;\n' + sh.fragmentShader.replace('#include <dithering_fragment>', `#include <dithering_fragment>
        float hu = (gl_FragCoord.x * uHatch.x + gl_FragCoord.y) * 0.70710678;
        float hd = abs(mod(hu, uHatch.y) - 0.5 * uHatch.y);
        gl_FragColor.rgb *= 1.0 - 0.45 * smoothstep(0.5 * uHatch.y - uHatch.z - 0.6, 0.5 * uHatch.y - uHatch.z + 0.6, hd);`);
    };
    const plate = new THREE.Mesh(Viewer.plateGeometry, mat);
    plate.raycast = () => {};
    plate.onAfterRender = (r) => r.clearStencil();
    this.caps.add(plate);
    return { stencils, plate };
  }

  private static plateGeometry = new THREE.PlaneGeometry(1, 1);

  /** Platten in die Ebene legen, groß genug für das ganze Modell. */
  private placeCaps(): void {
    const at = this.plane.projectPoint(this.center, new THREE.Vector3());
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.plane.normal);
    const s = this.radius * 4;
    for (const o of this.caps.children) { o.position.copy(at); o.quaternion.copy(q); o.scale.set(s, s, 1); }
  }

  private clearCaps(): void {
    for (const p of this.parts.values()) {
      if (!p.cap) continue;
      for (const s of p.cap.stencils) { s.removeFromParent(); (s.material as THREE.Material).dispose(); }
      (p.cap.plate.material as THREE.Material).dispose();
      p.cap = undefined;
    }
    this.caps.clear();
    this.setContour(null);
  }

  /** Vor dem Zeichnen: Kontur neu berechnen, wenn sich Ebene oder Sichtbarkeit geändert haben. */
  private prepareSection(): void {
    if (!this.contourDirty) return;
    this.contourDirty = false;
    this.setContour(this.clip.length ? this.computeContour() : null);
  }

  /** Schnittlinien der Dreiecke mit der Ebene, je Segment mit Bauteil und Fläche. Transparente Teile bleiben ohne Kontur. */
  private computeContour(): { flat: number[]; of: { part: PartEntry; face: number }[] } {
    const n = this.plane.normal, c = this.plane.constant;
    const flat: number[] = [], of: { part: PartEntry; face: number }[] = [];
    const cross = (pos: Float32Array, i: number, j: number, di: number, dj: number) => {
      const t = di / (di - dj);
      flat.push(pos[i] + (pos[j] - pos[i]) * t, pos[i + 1] + (pos[j + 1] - pos[i + 1]) * t, pos[i + 2] + (pos[j + 2] - pos[i + 2]) * t);
    };
    for (const [id, p] of this.parts) {
      if (!p.group.visible || this.ghosted.has(id)) continue;
      for (const w of this.worldOf(p)) {
        const { pos, idx } = w;
        let face: FaceEntry | null = null;
        for (let t = 0; t + 2 < idx.length; t += 3) {
          const a = idx[t] * 3, b = idx[t + 1] * 3, cc = idx[t + 2] * 3;
          const da = n.x * pos[a] + n.y * pos[a + 1] + n.z * pos[a + 2] + c;
          const db = n.x * pos[b] + n.y * pos[b + 1] + n.z * pos[b + 2] + c;
          const dc = n.x * pos[cc] + n.y * pos[cc + 1] + n.z * pos[cc + 2] + c;
          const sa = da >= 0, sb = db >= 0, sc = dc >= 0;
          if (sa === sb && sb === sc) continue;
          // Genau zwei Kanten des Dreiecks kreuzen die Ebene
          if (sa !== sb) cross(pos, a, b, da, db);
          if (sb !== sc) cross(pos, b, cc, db, dc);
          if (sc !== sa) cross(pos, cc, a, dc, da);
          const tri = t / 3;
          if (w.faces && !(face && tri >= face.triStart && tri < face.triStart + face.triCount)) face = Viewer.faceOfTriangle(p.meta.faces, tri);
          of.push({ part: p, face: w.faces && face ? face.id : -1 });
        }
      }
    }
    return { flat, of };
  }

  private setContour(c: { flat: number[]; of: { part: PartEntry; face: number }[] } | null): void {
    if (this.contour) {
      this.scene.remove(this.contour);
      this.contour.geometry.dispose();
      this.lineMats.delete(this.contour.material);
      this.contour.material.dispose();
      this.contour = null;
    }
    this.contourOf = c?.of ?? [];
    if (!c || !c.flat.length) return;
    const g = new LineSegmentsGeometry();
    g.setPositions(c.flat);
    const m = new LineMaterial({ color: CONTOUR_COLOR, linewidth: 1.6 });
    m.resolution.set(this.container.clientWidth || 1, this.container.clientHeight || 1);
    this.lineMats.add(m);
    this.contour = new LineSegments2(g, m);
    this.contour.renderOrder = CONTOUR_ORDER;
    this.contour.raycast = () => {};
    this.scene.add(this.contour);
  }

  // ---- Explosionsansicht ----------------------------------------------------------------------------------------

  /** Alle Bauteile in Einbaulage, auch ausgeblendete: Die Explosion soll nicht springen, wenn man etwas aus- oder einblendet. */
  explodeParts(): ExplodePart[] {
    return [...this.parts.values()].map((p) => {
      const box = new THREE.Box3().setFromObject(p.group).translate(p.offset.clone().negate());
      const a = p.meta.axis;
      const axis = Array.isArray(a) && a.length === 3 && a.every(Number.isFinite) && Math.hypot(a[0], a[1], a[2]) > 1e-9
        ? new THREE.Vector3(a[0], a[1], a[2]).normalize() : null;
      let span: [number, number] | null = null;
      if (axis) {
        // Genau aus den Dreiecken, der Hüllquader wäre bei schräger Achse zu lang
        let lo = Infinity, hi = -Infinity;
        const shift = axis.dot(p.offset);
        for (const w of this.worldOf(p)) {
          for (let i = 0; i < w.pos.length; i += 3) {
            const v = axis.x * w.pos[i] + axis.y * w.pos[i + 1] + axis.z * w.pos[i + 2] - shift;
            if (v < lo) lo = v;
            if (v > hi) hi = v;
          }
        }
        if (lo <= hi) span = [lo, hi];
      }
      return { id: p.meta.partId, group: p.meta.group ?? null, role: p.meta.role, min: box.min.toArray(), max: box.max.toArray(),
        axis: axis ? axis.toArray() : null, span };
    });
  }

  /**
   * Bauteile aus der Einbaulage verschieben (nur verschieben, nicht drehen). Fehlende Bauteile und null: Einbaulage.
   * Klicks, Schnitt und Hervorhebungen arbeiten danach mit der neuen Lage.
   */
  setOffsets(offsets: Map<string, number[]> | null): void {
    for (const [id, p] of this.parts) {
      const o = offsets?.get(id);
      const next = new THREE.Vector3(o?.[0] ?? 0, o?.[1] ?? 0, o?.[2] ?? 0);
      if (next.equals(p.offset)) continue;
      p.offset.copy(next);
      p.group.position.copy(p.base).add(p.offset);
      p.group.updateMatrixWorld(true);
      p.world = undefined;
    }
    this.follow();
    this.updateExtent();
    this.syncTrails();
    this.syncSection();
    this.fitClip();
    this.requestRender();
  }

  /** Wege der Explosionsansicht zeigen oder nicht. */
  setTrails(on: boolean): void { this.showTrails = on; this.syncTrails(); this.requestRender(); }

  /** Gestrichelte Linie je verschobenem, sichtbarem Bauteil von seiner Mitte in Einbaulage zur aktuellen Mitte. */
  private syncTrails(): void {
    this.clearGroup(this.trails);
    if (!this.showTrails) return;
    const flat: number[] = [];
    const c = new THREE.Vector3();
    for (const p of this.parts.values()) {
      if (!p.group.visible || p.offset.length() < this.radius * 1e-3) continue;
      new THREE.Box3().setFromObject(p.group).getCenter(c);
      flat.push(c.x - p.offset.x, c.y - p.offset.y, c.z - p.offset.z, c.x, c.y, c.z);
    }
    if (!flat.length) return;
    const g = new LineSegmentsGeometry();
    g.setPositions(flat);
    // Mit Tiefe, anders als Messstrecken: Die Wege sollen hinter Bauteilen verschwinden, sonst überdecken sie das Bild
    const m = new LineMaterial({ color: 0x8d97a3, linewidth: 1.2, transparent: true, opacity: 0.85, dashed: true,
      dashSize: this.radius / 50, gapSize: this.radius / 70 });
    m.clippingPlanes = this.clip;
    m.resolution.set(this.container.clientWidth || 1, this.container.clientHeight || 1);
    this.lineMats.add(m);
    const l = new LineSegments2(g, m);
    l.computeLineDistances();
    l.raycast = () => {};
    this.trails.add(l);
  }

  // ---- Prüfhilfen (nur für Tests) -------------------------------------------------------------------------------

  /** Verschiebung je Bauteil (nur verschobene) und Zahl der Wege, für Tests. */
  explodeState() {
    const offsets: Record<string, number[]> = {};
    for (const [id, p] of this.parts) if (p.offset.lengthSq() > 0) offsets[id] = p.offset.toArray().map((v) => +v.toFixed(4));
    const t = this.trails.children[0] as LineSegments2 | undefined;
    return { offsets, trails: t ? (t.geometry as LineSegmentsGeometry).getAttribute('instanceStart').count : 0, radius: this.radius };
  }

  facesOf(partId: string): FaceEntry[] { return this.parts.get(partId)?.meta.faces ?? []; }

  /** Kanten eines Bauteils mit Mittelpunkt (Mitte des mittleren Segments) und dessen Bildschirmposition. */
  edgesOf(partId: string): { id: number; curve: string; length?: number; mid: number[]; screen: { x: number; y: number } }[] {
    const p = this.parts.get(partId);
    const l = p?.lines[0];
    if (!p || !l) return [];
    const pos = l.geometry.getAttribute('position');
    const r = this.renderer.domElement.getBoundingClientRect();
    this.camera.updateMatrixWorld();
    l.updateMatrixWorld();
    return (p.meta.edges ?? []).map((e) => {
      const s = e.segStart + Math.floor(e.segCount / 2);
      const a = new THREE.Vector3().fromBufferAttribute(pos, s * 2).applyMatrix4(l.matrixWorld);
      const b = new THREE.Vector3().fromBufferAttribute(pos, s * 2 + 1).applyMatrix4(l.matrixWorld);
      const m = a.clone().lerp(b, 0.5);
      const v = m.clone().project(this.camera);
      return { id: e.id, curve: e.curve, length: e.length, mid: m.toArray(), screen: { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height } };
    });
  }

  /** Eckpunkte eines Bauteils mit Bildschirmposition. */
  verticesOf(partId: string): { id: number; p: number[]; screen: { x: number; y: number } }[] {
    return (this.parts.get(partId)?.meta.vertices ?? []).map((v) => ({ id: v.id, p: v.p, screen: this.screenAt(v.p) }));
  }

  /** Deckkraft und Tiefenschreiben eines Bauteils, für Tests. */
  partLook(id: string): { opacity: number; depthWrite: boolean } | null {
    const m = this.parts.get(id)?.meshes[0]?.material as THREE.MeshStandardMaterial | undefined;
    return m ? { opacity: m.opacity, depthWrite: m.depthWrite } : null;
  }

  /** Kamera, Drehpunkt und Schnittebenen, für Tests. */
  viewState() {
    const d = this.camera.position.clone().sub(this.controls.target);
    return { target: this.controls.target.toArray(), dir: d.clone().normalize().toArray(), dist: d.length(), near: this.camera.near, far: this.camera.far,
      zoomToCursor: this.controls.zoomToCursor, animating: !!this.anim };
  }

  /** Stand des Schnitts, für Tests: Ebene, Bauteile mit Deckel, Segmente der Kontur, geschnittene Materialien. */
  sectionState() {
    this.prepareSection();
    const capped = [...this.parts.values()].filter((p) => p.cap?.plate.visible).map((p) => p.meta.partId);
    const clipped = [...this.parts.values()].every((p) => p.meshes.every((m) => (m.material as THREE.Material).clippingPlanes === this.clip));
    return { plane: this.section, capped, contour: this.contourOf.length, clipped, picking: !!this.planePick };
  }

  /**
   * Bildpunkte um eine Fensterposition, frisch gezeichnet, für Tests: mittlere Helligkeit und Spanne (Schraffur ergibt
   * eine große Spanne) sowie die mittlere Farbe.
   */
  pixels(x: number, y: number, half = 6): { mean: number; span: number; rgb: number[] } {
    this.prepareSection();
    this.renderer.render(this.scene, this.camera);
    const src = this.renderer.domElement, r = src.getBoundingClientRect();
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    const g = c.getContext('2d')!;
    g.drawImage(src, 0, 0);
    const k = src.width / r.width;
    const px = Math.round((x - r.left) * k), py = Math.round((y - r.top) * k), h = Math.round(half * k);
    const d = g.getImageData(px - h, py - h, 2 * h + 1, 2 * h + 1).data;
    let lo = 255, hi = 0, sum = 0;
    const rgb = [0, 0, 0];
    const n = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      lo = Math.min(lo, l); hi = Math.max(hi, l); sum += l;
      rgb[0] += d[i] / n; rgb[1] += d[i + 1] / n; rgb[2] += d[i + 2] / n;
    }
    this.requestRender();
    return { mean: sum / n, span: hi - lo, rgb: rgb.map(Math.round) };
  }

  /** Bildschirmposition eines Punkts auf dem Ansichtswürfel, für Tests. */
  cubeScreen(p: number[]): { x: number; y: number } | null { return this.cube ? this.cube.screenOf(p) : null; }

  /** Bildschirmposition (Pixel im Fenster) eines Weltpunkts. */
  screenAt(p: number[]): { x: number; y: number } {
    this.camera.updateMatrixWorld();
    const v = new THREE.Vector3(...(p as [number, number, number])).project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }

  /** Ausdehnung (x, y, z in mm) eines Bauteils. */
  partSize(partId: string): number[] | null {
    const p = this.parts.get(partId);
    if (!p) return null;
    const s = new THREE.Box3().setFromObject(p.group).getSize(new THREE.Vector3());
    return [+s.x.toFixed(3), +s.y.toFixed(3), +s.z.toFixed(3)];
  }

  /** Bildschirmposition (Pixel im Fenster) des Flächenmittelpunkts. */
  screenOf(partId: string, faceId: number): { x: number; y: number } {
    const f = this.facesOf(partId).find((x) => x.id === faceId)!;
    this.camera.updateMatrixWorld();
    const v = new THREE.Vector3(...(f.center as [number, number, number])).applyMatrix4(this.parts.get(partId)!.group.matrixWorld).project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }
}
