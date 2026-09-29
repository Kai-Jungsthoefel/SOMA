import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// CAD-Konvention: Z ist oben, Einheit mm. Muss vor dem Anlegen von Kamera und Objekten gesetzt sein.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

interface FaceEntry { id: number; surface: string; area?: number; center?: number[]; triStart: number; triCount: number }
interface PartMeta { partId: string; name: string; role: string; faces: FaceEntry[] }
interface PartEntry { group: THREE.Object3D; meta: PartMeta; meshes: THREE.Mesh[]; lines: THREE.LineSegments[] }

export interface PickResult {
  partId: string; name: string; role: string;
  faceId: number | null; surface: string | null; area: number | null;
  point: number[];
}

export type ViewName = 'iso' | 'front' | 'top' | 'right' | 'fit';

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
  onPick: (r: PickResult | null) => void = () => {};

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x1e2227);
    this.camera.up.set(0, 0, 1);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 2.2);
    sun.position.set(80, -120, 200);
    this.scene.add(sun, this.highlight);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false; // gerendert wird nur bei Änderungen
    this.controls.addEventListener('change', () => this.requestRender());
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
        const mat = m.material as THREE.MeshStandardMaterial;
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
    if (this.selectedId && !this.parts.has(this.selectedId)) this.selectedId = null;
    if (!this.hasFitted && this.parts.size) { this.setView('iso'); this.hasFitted = true; }
    this.requestRender();
  }

  clear(): void {
    this.disposeModel();
    this.parts.clear();
    this.hidden.clear();
    this.hasFitted = false;
    this.highlight.clear();
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
      iso: new THREE.Vector3(0.8, -1.2, 0.9), front: new THREE.Vector3(0, -1, 0),
      top: new THREE.Vector3(0, -0.0001, 1), right: new THREE.Vector3(1, 0, 0),
      fit: this.camera.position.clone().sub(this.controls.target),
    }[name].clone().normalize();
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 1.05;
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.near = Math.max(dist / 1000, 0.05);
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.requestRender();
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
    if (!hit) { this.selectedId = null; this.requestRender(); return null; }
    const part = [...this.parts.values()].find((p) => p.meshes.includes(hit.object as THREE.Mesh))!;
    const face = hit.faceIndex != null ? Viewer.faceOfTriangle(part.meta.faces, hit.faceIndex) : null;
    this.selectedId = part.meta.partId;
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
      color: 0xffa000, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide }));
    o.renderOrder = 2;
    this.highlight.add(o);
  }

  private installPicking(): void {
    const el = this.renderer.domElement;
    let down: [number, number] | null = null;
    el.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
    el.addEventListener('pointerup', (e) => {
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return; // Ziehen ist kein Klick
      const r = el.getBoundingClientRect();
      this.onPick(this.pickAt(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1));
    });
  }

  select(id: string | null): void { this.selectedId = id; this.highlight.clear(); this.requestRender(); }
  get selection(): string | null { return this.selectedId; }

  // ---- Rendern --------------------------------------------------------------------------------------------------

  private resize(): void {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  requestRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => { this.renderQueued = false; this.renderer.render(this.scene, this.camera); });
  }

  // ---- Prüfhilfen (nur für Tests) -------------------------------------------------------------------------------

  facesOf(partId: string): FaceEntry[] { return this.parts.get(partId)?.meta.faces ?? []; }

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
