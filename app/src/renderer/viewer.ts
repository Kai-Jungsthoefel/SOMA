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
interface PartMeta { partId: string; name: string; role: string; faces: FaceEntry[]; edges?: EdgeEntry[]; vertices?: VertexEntry[] }
interface PartEntry { group: THREE.Object3D; meta: PartMeta; meshes: THREE.Mesh[]; lines: THREE.LineSegments[] }

export interface PickResult {
  partId: string; name: string; role: string;
  faceId: number | null; surface: string | null; area: number | null;
  point: number[];
}

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

export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.5, 20000);
  private controls: OrbitControls;
  private model: THREE.Object3D | null = null;
  private parts = new Map<string, PartEntry>();
  private highlight = new THREE.Group();
  private hidden = new Set<string>();
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
  onPick: (r: PickResult | null) => void = () => {};
  /** Klick im Messmodus. null: daneben geklickt. */
  onMeasurePick: (h: ProbeHit | null) => void = () => {};

  constructor(private container: HTMLElement) {
    // Durchsichtiger Hintergrund: den Verlauf dahinter zeichnet CSS, so passt er zur übrigen Oberfläche
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);
    this.camera.up.set(0, 0, 1);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(80, -120, 200);
    this.scene.add(sun, this.highlight, this.hover, this.marks);
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
      const meta = (o.userData as { cadide?: PartMeta }).cadide;
      if (!meta) return;
      const meshes: THREE.Mesh[] = [];
      const lines: THREE.LineSegments[] = [];
      o.traverse((c) => {
        if ((c as THREE.Mesh).isMesh) meshes.push(c as THREE.Mesh);
        if ((c as THREE.LineSegments).isLineSegments) lines.push(c as THREE.LineSegments);
      });
      for (const m of meshes) {
        // Eigenes Material je Netz: die Auswahl färbt ein Bauteil ein, gleichfarbige Teile dürfen nicht mitleuchten
        const mat = (m.material as THREE.MeshStandardMaterial).clone();
        m.material = mat;
        // Flächen minimal nach hinten, damit Kantenlinien nicht mit ihnen um die Tiefe kämpfen
        mat.polygonOffset = true; mat.polygonOffsetFactor = 1; mat.polygonOffsetUnits = 1;
        mat.userData.baseOpacity = mat.opacity;
        mat.userData.baseTransparent = mat.transparent;
        if (meta.role === 'reference') { mat.depthWrite = false; m.renderOrder = 1; }
      }
      fresh.set(meta.partId, { group: o, meta, meshes, lines });
    });
    this.disposeModel();
    this.model = gltf.scene;
    this.parts = fresh;
    this.scene.add(gltf.scene);
    for (const id of [...this.hidden]) if (!this.parts.has(id)) this.hidden.delete(id);
    this.applyVisibility();
    this.applyDisplay();
    this.highlight.clear();
    this.clearGroup(this.hover);
    this.hoverKey = '';
    if (this.selectedId && !this.parts.has(this.selectedId)) this.selectedId = null;
    this.applySelection();
    const box = this.bounds([...this.parts.keys()]);
    if (!box.isEmpty()) { box.getCenter(this.center); this.radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1); }
    if (!this.hasFitted && this.parts.size) { this.setView('iso'); this.hasFitted = true; }
    this.fitClip();
    this.requestRender();
  }

  clear(): void {
    this.disposeModel();
    this.parts.clear();
    this.hidden.clear();
    this.hasFitted = false;
    this.highlight.clear();
    this.clearGroup(this.hover);
    this.setMeasureMarks(null);
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

  partList(): { id: string; name: string; role: string; color: string }[] {
    return [...this.parts.values()].map((p) => ({
      id: p.meta.partId, name: p.meta.name, role: p.meta.role,
      color: p.meshes[0] ? '#' + (p.meshes[0].material as THREE.MeshStandardMaterial).color.getHexString() : '#888',
    }));
  }

  isVisible(id: string): boolean { return !this.hidden.has(id); }

  setVisible(id: string, on: boolean): void {
    if (on) this.hidden.delete(id); else this.hidden.add(id);
    this.applyVisibility();
    this.requestRender();
  }

  /** Nur dieses Bauteil zeigen. */
  isolate(id: string): void {
    for (const k of this.parts.keys()) if (k !== id) this.hidden.add(k); else this.hidden.delete(k);
    this.applyVisibility();
    this.requestRender();
  }

  showAll(): void { this.hidden.clear(); this.applyVisibility(); this.requestRender(); }

  get hiddenCount(): number { return this.hidden.size; }

  private applyVisibility(): void {
    for (const [id, p] of this.parts) p.group.visible = !this.hidden.has(id);
  }

  setEdges(on: boolean): void { this.edges = on; this.applyDisplay(); this.requestRender(); }
  setWireframe(on: boolean): void { this.wire = on; this.applyDisplay(); this.requestRender(); }
  setGhost(on: boolean): void { this.ghost = on; this.applyDisplay(); this.requestRender(); }

  private applyDisplay(): void {
    for (const p of this.parts.values()) {
      for (const l of p.lines) l.visible = this.edges;
      for (const m of p.meshes) {
        const mat = m.material as THREE.MeshStandardMaterial;
        mat.wireframe = this.wire;
        const base = (mat.userData.baseOpacity as number) ?? 1;
        mat.opacity = this.ghost ? Math.min(base, 0.35) : base;
        mat.transparent = this.ghost || (mat.userData.baseTransparent as boolean);
        mat.needsUpdate = true;
      }
    }
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
    const targets: THREE.Mesh[] = [];
    for (const p of this.parts.values()) if (p.group.visible) targets.push(...p.meshes);
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    this.highlight.clear();
    if (!hit) { this.selectedId = null; this.applySelection(); this.requestRender(); return null; }
    const part = [...this.parts.values()].find((p) => p.meshes.includes(hit.object as THREE.Mesh))!;
    const face = hit.faceIndex != null ? Viewer.faceOfTriangle(part.meta.faces, hit.faceIndex) : null;
    this.selectedId = part.meta.partId;
    this.applySelection();
    if (face && face.triCount) this.highlightFace(part, face);
    this.requestRender();
    return {
      partId: part.meta.partId, name: part.meta.name, role: part.meta.role,
      faceId: face?.id ?? null, surface: face?.surface ?? null, area: face?.area ?? null,
      point: hit.point.toArray().map((v) => +v.toFixed(3)),
    };
  }

  private highlightFace(part: PartEntry, face: FaceEntry): void {
    const src = part.meshes.find((m) => m.geometry.index);
    if (!src) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', src.geometry.getAttribute('position'));
    g.setIndex(Array.from(src.geometry.index!.array.slice(face.triStart * 3, (face.triStart + face.triCount) * 3)));
    const o = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color: 0xf29a38, transparent: true, opacity: 0.85, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide }));
    o.renderOrder = 2;
    this.highlight.add(o);
  }

  private installPicking(): void {
    const el = this.renderer.domElement;
    let down: [number, number] | null = null;
    el.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return; // Ziehen ist kein Klick
      if (this.mode === 'measure') { this.onMeasurePick(this.probe(e.clientX, e.clientY)); return; }
      const r = el.getBoundingClientRect();
      this.onPick(this.pickAt(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1));
    });
    // Messen: Element unter dem Zeiger hervorheben (höchstens einmal pro Bild berechnet)
    let queued: [number, number] | null = null;
    el.addEventListener('pointermove', (e) => {
      if (this.mode !== 'measure' || e.buttons) return;
      if (!queued) requestAnimationFrame(() => { const q = queued; queued = null; if (q && this.mode === 'measure') this.showHover(this.probe(q[0], q[1])); });
      queued = [e.clientX, e.clientY];
    });
    el.addEventListener('pointerleave', () => this.showHover(null));
    // Doppelklick ins Modell: Drehpunkt dorthin (auch beim Messen)
    el.addEventListener('dblclick', (e) => {
      const r = el.getBoundingClientRect();
      this.raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
      const targets: THREE.Mesh[] = [];
      for (const p of this.parts.values()) if (p.group.visible) targets.push(...p.meshes);
      const hit = this.raycaster.intersectObjects(targets, false)[0];
      if (hit) this.setPivot(hit.point.clone());
    });
  }

  // ---- Messen ---------------------------------------------------------------------------------------------------

  /** Umschalten zwischen Auswählen (Klick wählt ein Bauteil) und Messen (Klick wählt Fläche oder Kante). */
  setMode(m: 'select' | 'measure'): void {
    this.mode = m;
    this.renderer.domElement.style.cursor = m === 'measure' ? 'crosshair' : '';
    if (m !== 'measure') this.showHover(null);
  }

  /**
   * Eckpunkt, Kante oder Fläche unter einem Bildschirmpunkt, in dieser Reihenfolge: Punkte gewinnen im Umkreis von VERTEX_PX,
   * Kanten im Umkreis von EDGE_PX, sonst gilt die Fläche (sonst ließen sich Punkte und Kanten kaum treffen). Verdeckte Punkte
   * und Kanten zählen nicht, ebenso wenig ausgeblendete Bauteile. Ohne sichtbare Kanten gibt es auch keine Punkte.
   */
  probe(clientX: number, clientY: number): ProbeHit | null {
    const el = this.renderer.domElement;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const px = clientX - r.left, py = clientY - r.top;
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(new THREE.Vector2((px / r.width) * 2 - 1, -(py / r.height) * 2 + 1), this.camera);
    const targets: THREE.Mesh[] = [];
    for (const p of this.parts.values()) if (p.group.visible) targets.push(...p.meshes);
    const hit = this.raycaster.intersectObjects(targets, false)[0];
    const vertex = this.nearestVertex(px, py, r.width, r.height, targets);
    if (vertex) return vertex;
    const edge = this.nearestEdge(px, py, r.width, r.height, targets);
    if (edge) return edge;
    if (!hit) return null;
    const part = [...this.parts.values()].find((p) => p.meshes.includes(hit.object as THREE.Mesh))!;
    const face = hit.faceIndex != null ? Viewer.faceOfTriangle(part.meta.faces, hit.faceIndex) : null;
    if (!face) return null;
    return { partId: part.meta.partId, name: part.meta.name, kind: 'face', id: face.id, type: face.surface, size: face.area ?? null, point: hit.point.toArray() };
  }

  /** Liegt der Weltpunkt hinter einer Fläche? Toleranz für die Vernetzung, sonst verdeckte die eigene Fläche ihre Kanten. */
  private occluded(p: THREE.Vector3, occluders: THREE.Mesh[]): boolean {
    const eye = this.camera.position;
    const dist = eye.distanceTo(p);
    this.raycaster.set(eye, p.clone().sub(eye).normalize());
    const first = this.raycaster.intersectObjects(occluders, false)[0];
    return !!first && first.distance < dist - Math.max(0.5, dist * 0.002);
  }

  private nearestVertex(px: number, py: number, w: number, h: number, occluders: THREE.Mesh[]): ProbeHit | null {
    const v = new THREE.Vector3(), s = new THREE.Vector3();
    const cands: { part: PartEntry; vx: VertexEntry; d: number; point: THREE.Vector3 }[] = [];
    for (const p of this.parts.values()) {
      if (!p.group.visible || !p.meta.vertices?.length || !p.lines.some((l) => l.visible)) continue;
      p.group.updateMatrixWorld();
      for (const vx of p.meta.vertices) {
        v.set(vx.p[0], vx.p[1], vx.p[2]).applyMatrix4(p.group.matrixWorld);
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

  private nearestEdge(px: number, py: number, w: number, h: number, occluders: THREE.Mesh[]): ProbeHit | null {
    const a = new THREE.Vector3(), b = new THREE.Vector3(), sa = new THREE.Vector3(), sb = new THREE.Vector3();
    const cands: { part: PartEntry; seg: number; d: number; point: THREE.Vector3 }[] = [];
    for (const p of this.parts.values()) {
      if (!p.group.visible || !p.meta.edges?.length) continue;
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
      if (this.occluded(c.point, occluders)) continue;
      const edge = Viewer.edgeOfSegment(c.part.meta.edges!, c.seg);
      if (!edge) continue;
      return { partId: c.part.meta.partId, name: c.part.meta.name, kind: 'edge', id: edge.id, type: edge.curve, size: edge.length ?? null, point: c.point.toArray() };
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
      g.setAttribute('position', new THREE.Float32BufferAttribute(new THREE.Vector3(...(vx.p as [number, number, number])).applyMatrix4(p.group.matrixWorld).toArray(), 3));
      const m = new THREE.PointsMaterial({ color, size: 6 + width * 3, sizeAttenuation: false, map: Viewer.dot(), transparent: true, alphaTest: 0.2, depthTest: false });
      const o = new THREE.Points(g, m);
      o.renderOrder = 11;
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
      const o = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide }));
      o.renderOrder = 3;
      group.add(o);
      return;
    }
    const edge = p.meta.edges?.find((e) => e.id === id);
    const l = p.lines[0];
    if (!edge || !l) return;
    const pos = l.geometry.getAttribute('position');
    const v = new THREE.Vector3();
    const flat: number[] = [];
    for (let s = edge.segStart; s < edge.segStart + edge.segCount; s++) {
      for (const k of [s * 2, s * 2 + 1]) { v.fromBufferAttribute(pos, k).applyMatrix4(l.matrixWorld); flat.push(v.x, v.y, v.z); }
    }
    group.add(this.fatLines(flat, color, width, false));
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

  /** Linien mit fester Breite in Pixeln (WebGL-Linien sind sonst immer 1 px). Immer sichtbar, auch hinter Flächen. */
  private fatLines(flat: number[], color: number, width: number, dashed: boolean): LineSegments2 {
    const g = new LineSegmentsGeometry();
    g.setPositions(flat);
    const m = new LineMaterial({ color, linewidth: width, depthTest: false, transparent: true, dashed, dashSize: 1.2, gapSize: 0.9 });
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
    this.renderer.render(this.scene, this.camera);
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

  // ---- Prüfhilfen (nur für Tests) -------------------------------------------------------------------------------

  facesOf(partId: string): FaceEntry[] { return this.parts.get(partId)?.meta.faces ?? []; }

  /** Kanten eines Bauteils mit Mittelpunkt (Mitte des mittleren Segments) und dessen Bildschirmposition. */
  edgesOf(partId: string): { id: number; curve: string; length?: number; mid: number[]; screen: { x: number; y: number } }[] {
    const p = this.parts.get(partId);
    const l = p?.lines[0];
    if (!p || !l) return [];
    const pos = l.geometry.getAttribute('position');
    const r = this.renderer.domElement.getBoundingClientRect();
    this.camera.updateMatrixWorld();
    return (p.meta.edges ?? []).map((e) => {
      const s = e.segStart + Math.floor(e.segCount / 2);
      const a = new THREE.Vector3().fromBufferAttribute(pos, s * 2), b = new THREE.Vector3().fromBufferAttribute(pos, s * 2 + 1);
      const m = a.clone().lerp(b, 0.5);
      const v = m.clone().project(this.camera);
      return { id: e.id, curve: e.curve, length: e.length, mid: m.toArray(), screen: { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height } };
    });
  }

  /** Eckpunkte eines Bauteils mit Bildschirmposition. */
  verticesOf(partId: string): { id: number; p: number[]; screen: { x: number; y: number } }[] {
    return (this.parts.get(partId)?.meta.vertices ?? []).map((v) => ({ id: v.id, p: v.p, screen: this.screenAt(v.p) }));
  }

  /** Kamera, Drehpunkt und Schnittebenen, für Tests. */
  viewState() {
    const d = this.camera.position.clone().sub(this.controls.target);
    return { target: this.controls.target.toArray(), dir: d.clone().normalize().toArray(), dist: d.length(), near: this.camera.near, far: this.camera.far,
      zoomToCursor: this.controls.zoomToCursor, animating: !!this.anim };
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
    const v = new THREE.Vector3(...(f.center as [number, number, number])).project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }
}
