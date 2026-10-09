import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { MeshBVH } from 'three-mesh-bvh';
import { navAction, type NavButton, type NavPreset, type Projection } from '../shared/settings';
import { ViewCube } from './viewcube';

// CAD-Konvention: Z ist oben, Einheit mm. Muss vor dem Anlegen von Kamera und Objekten gesetzt sein.
THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

/** `normal`: ebene Fläche, nach außen. `axis`: Zylinder oder Kegel. Beides fehlt bei älteren Builds. */
interface FaceEntry { id: number; surface: string; area?: number; center?: number[]; normal?: number[]; axis?: number[]; triStart: number; triCount: number }
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
  /** Lage aus einer Animation (E58), bezogen auf die Einbaulage. Fehlt: in Einbaulage. */
  pose?: THREE.Matrix4;
}

/**
 * Netz einer eigenen Ebene (Ergebnis, E58), das an Stelle eines Bauteils zu sehen ist, solange das Modell zurücktritt. `part`:
 * das Bauteil gleichen Namens (fehlt, wenn es das Teil im Modell nicht mehr gibt). Ausblenden, Transparent und der Schnitt mit
 * Deckel und Kontur gelten für dieses Netz wie für das Bauteil.
 */
interface StandIn {
  mesh: THREE.Mesh; lines: THREE.LineSegments[]; name: string; part?: PartEntry;
  cap?: PartEntry['cap'];
  world?: PartEntry['world'];
}

/** Zeichnet Texte über das Bild (E58). `project`: Weltpunkt → Bildpunkt in dieser Fläche, null hinter der Kamera. */
export type OverlayPainter = (g: CanvasRenderingContext2D, w: number, h: number, project: (p: THREE.Vector3) => { x: number; y: number } | null) => void;

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
 * dem Material heraus, `span` ihre Ausdehnung entlang dieser Achse. `dirs`: Richtungen aus der eigenen Form, in denen das Teil
 * herauskommen könnte (Achsen seiner Zylinder und Kegel, Normalen seiner großen ebenen Flächen), ohne Vorzeichen.
 */
export interface ExplodePart {
  id: string; group: string | null; role: string; min: number[]; max: number[]; axis: number[] | null; span: [number, number] | null;
  dirs: number[][];
}

/** Ebene Flächen ab diesem Anteil an der größten ebenen Fläche des Teils geben eine Richtung vor (kleine Fasen nicht). */
const OWN_PLANE_SHARE = 0.2;

/**
 * Treffer des Strahltests: kürzester Abstand bis zum anderen Teil, Zahl der Strahlen, die es berühren (unter `touch`), und Zahl der
 * Strahlen, die schon in ihm beginnen (der erste Treffer tritt aus): Die beiden überschneiden sich dort, etwa eine Schraube mit
 * ihrem Gewinde im Kernloch.
 */
export interface RayHit { dist: number; touch: number; inside: number }
/** Je Richtung: Bauteil → (Bauteil, das ihm in dieser Richtung im Weg steht → Treffer). */
export type BlockMap = Map<string, Map<string, RayHit>>[];

/** So lange rechnet der Strahltest am Stück, bevor er die Oberfläche wieder zeichnen lässt. */
const YIELD_MS = 30;
/** Punkte je Dreieck für den Strahltest (baryzentrisch), wichtigste zuerst: Mitte, nahe den Ecken, nahe den Kanten. */
const SAMPLE_PATTERN = [[1 / 3, 1 / 3, 1 / 3], [0.7, 0.15, 0.15], [0.15, 0.7, 0.15], [0.15, 0.15, 0.7],
  [0.425, 0.425, 0.15], [0.15, 0.425, 0.425], [0.425, 0.15, 0.425]];

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
/** Deckel der Netze einer Ebene: neutrales Grau, die Farben dort gehören den Werten des Ergebnisses. */
const LAYER_CAP = new THREE.Color(0x6c727a);
const NAV_BUTTON: Record<number, NavButton> = { 0: 'left', 1: 'middle', 2: 'right' };
const NAV_KEY: Record<NavButton, 'LEFT' | 'MIDDLE' | 'RIGHT'> = { left: 'LEFT', middle: 'MIDDLE', right: 'RIGHT' };
/** Keine Bewegung für eine Taste (OrbitControls kennt dafür keinen eigenen Wert, alles außer den drei Aktionen gilt als nichts). */
const NAV_NONE = -1 as THREE.MOUSE;

export class Viewer {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  /**
   * Zwei Kameras (E81): perspektivisch wie bisher und orthografisch. `camera` ist die gerade benutzte. Die orthografische
   * zeigt bei gleichem „Abstand“ dieselbe Höhe in der Ebene des Drehpunkts wie die perspektivische (siehe placeAt), so
   * springt das Bild beim Umschalten nicht. Ihr Abstand zum Drehpunkt bestimmt nur, dass das Modell vor ihr liegt (fitClip).
   */
  private persp = new THREE.PerspectiveCamera(35, 1, 0.5, 20000);
  private ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 20000);
  private camera: THREE.PerspectiveCamera | THREE.OrthographicCamera = this.persp;
  private controls: OrbitControls;
  /** Mausbelegung (E81), umgesetzt beim Drücken einer Taste (routeButton). */
  private nav: NavPreset = 'soma';
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
  /** Mehrfachauswahl (Strg/Shift-Klick, Rahmen, Baum): alle leuchten orange, `selectedId` ist das zuletzt gewählte. */
  private selectedIds = new Set<string>();
  /** Rahmenauswahl mit Alt + links ziehen: Startpunkt und das Rechteck im Bild. */
  private box: { x: number; y: number; el: HTMLElement; id: number } | null = null;
  private mode: 'select' | 'measure' = 'select';
  /** Hervorhebung unter dem Zeiger (Messen) und Markierungen der Messung. */
  private hover = new THREE.Group();
  private marks = new THREE.Group();
  private hoverKey = '';
  private lineMats = new Set<LineMaterial>();
  /** HTML-Ebene über dem Bild: Messpunkte und Beschriftung, bei jedem Zeichnen neu positioniert. */
  private overlay: HTMLElement;
  private overlayItems: { el: HTMLElement; at: THREE.Vector3 }[] = [];
  /** Beschriftungen eines Werkzeugs an Punkten im Raum (E82: Kraft und kleinster Wert einer Analyse), neben der Messung. */
  private tagItems: { el: HTMLElement; at: THREE.Vector3 }[] = [];
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
  /** Zu jedem Segment der Schnittkontur Bauteil und Fläche: Beim Messen lässt sich so die Kontur anklicken. null: Netz einer Ebene. */
  private contourOf: { part: PartEntry | null; face: number }[] = [];
  private contourDirty = false;
  /** Explosionsansicht: Wege der verschobenen Bauteile, gestrichelt. */
  private trails = new THREE.Group();
  private showTrails = true;
  /** Eigener Weg je Bauteil (ohne den seines Elternteils): Dort beginnt sein gestrichelter Weg. Ohne Angabe: die Einbaulage. */
  private legs: Map<string, number[]> | null = null;
  /** Wartet auf einen Klick auf eine Fläche (Schnitt an Fläche ausrichten). */
  private planePick: ((h: PlaneHit | null) => void) | null = null;
  /** Animation (E58): ausgeblendete, durchsichtige und hervorgehobene Bauteile zu diesem Zeitpunkt (getrennt von den Einstellungen des Nutzers). */
  private animHidden = new Set<string>();
  private animGhost = new Set<string>();
  private animHighlight = new Set<string>();
  /** Ergebnisansicht (E58): Das Modell tritt zurück, eine eigene Ebene zeigt die gefärbten Netze. */
  private modelHidden = false;
  /** Netze dieser Ebene, die je ein Bauteil vertreten (setStandIns). */
  private standIns: StandIn[] = [];
  /** 2D-Fläche über dem Bild für Untertitel, Beschriftungen und Legende (E58). */
  private paint: HTMLCanvasElement;
  private painter: OverlayPainter | null = null;
  onPick: (r: PickResult | null, mods: { shift: boolean; ctrl: boolean }) => void = () => {};
  /** Rechtsklick ins Bild ohne Ziehen: Bauteil darunter (null: daneben) und die Stelle für das Menü. */
  onContext: (partId: string | null, x: number, y: number) => void = () => {};
  /** Rahmenauswahl fertig: Bauteile im Rahmen, `add` mit Shift oder Strg (zur Auswahl dazu). */
  onBox: (ids: string[], add: boolean) => void = () => {};
  /** Klick im Messmodus. null: daneben geklickt. */
  onMeasurePick: (h: ProbeHit | null) => void = () => {};
  /** Klick im Messmodus auf die Schnittfläche selbst (die hat keine exakte Geometrie). */
  onMeasureCut: () => void = () => {};

  /** `pixelRatio`: fest statt der des Bildschirms (Render-Fenster: ein Bildpunkt je Pixel des Videos). */
  constructor(private container: HTMLElement, private readonly opts: { pixelRatio?: number } = {}) {
    // Durchsichtiger Hintergrund: den Verlauf dahinter zeichnet CSS, so passt er zur übrigen Oberfläche
    // Schablonenpuffer (stencil) für die gefüllten Schnittflächen, seit three.js r163 nicht mehr von selbst da
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: true, stencil: true });
    this.renderer.localClippingEnabled = true;
    this.renderer.setPixelRatio(opts.pixelRatio ?? window.devicePixelRatio);
    this.renderer.setClearColor(0x000000, 0);
    container.appendChild(this.renderer.domElement);
    this.paint = document.createElement('canvas');
    this.paint.className = 'v-paint';
    // Liegt über dem Bild (#viewer > canvas zieht sie auf volle Größe), Klicks gehen durch auf die 3D-Ansicht
    this.paint.style.pointerEvents = 'none';
    container.appendChild(this.paint);
    this.persp.up.set(0, 0, 1);
    this.ortho.up.set(0, 0, 1);
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
    // Vor OrbitControls (Einfangphase am Container): Welche Bewegung eine Taste startet, legt die Belegung fest
    container.addEventListener('pointerdown', (e) => this.routeButton(e), true);
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
    this.linkStandIns();
    this.scene.add(gltf.scene);
    for (const id of [...this.hidden]) if (!this.parts.has(id)) this.hidden.delete(id);
    for (const id of [...this.ghosted]) if (!this.parts.has(id)) this.ghosted.delete(id);
    this.applyVisibility();
    this.applyDisplay();
    this.highlight.clear();
    this.clearGroup(this.hover);
    this.hoverKey = '';
    if (this.selectedId && !this.parts.has(this.selectedId)) this.selectedId = null;
    for (const id of [...this.selectedIds]) if (!this.parts.has(id)) this.selectedIds.delete(id);
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
    this.linkStandIns();
    this.hidden.clear();
    this.ghosted.clear();
    this.hasFitted = false;
    this.highlight.clear();
    this.clearGroup(this.hover);
    this.clearGroup(this.trails);
    this.setMeasureMarks(null);
    this.applyStandIns();
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
    for (const [id, p] of this.parts) p.group.visible = !this.hidden.has(id) && !this.animHidden.has(id) && !this.modelHidden;
    this.applyStandIns();
    this.syncTrails();
    this.syncSection();
  }

  /** Ein Bauteil ist einzeln transparent, vom Nutzer oder von einer Animation. */
  private ownGhost(id: string): boolean { return this.ghosted.has(id) || this.animGhost.has(id); }

  /**
   * Netze einer Ebene folgen ihrem Bauteil: ausgeblendet, transparent, Kanten, Drahtgitter. So gilt die Seitenleiste auch, solange
   * das Modell zurücktritt, und ein Ergebnis, das erst danach lädt, übernimmt den Stand. Ohne Bauteil (älteres Ergebnis) bleibt
   * das Netz sichtbar und deckend.
   */
  private applyStandIns(): void {
    for (const s of this.standIns) {
      const id = s.part?.meta.partId;
      const shown = !id || (!this.hidden.has(id) && !this.animHidden.has(id));
      const own = !!id && this.ownGhost(id);
      s.mesh.visible = shown;
      const mat = s.mesh.material as THREE.MeshStandardMaterial;
      mat.wireframe = this.wire;
      mat.opacity = own ? 0.18 : this.ghost ? 0.35 : 1;
      mat.transparent = own || this.ghost;
      mat.depthWrite = !own;
      s.mesh.renderOrder = own ? 2 : 0;
      mat.needsUpdate = true;
      for (const l of s.lines) {
        l.visible = shown && this.edges;
        const lm = l.material as THREE.LineBasicMaterial;
        lm.transparent = own;
        lm.opacity = own ? 0.3 : 1;
      }
    }
  }

  setEdges(on: boolean): void { this.edges = on; this.applyDisplay(); this.requestRender(); }
  setWireframe(on: boolean): void { this.wire = on; this.applyDisplay(); this.requestRender(); }
  setGhost(on: boolean): void { this.ghost = on; this.applyDisplay(); this.requestRender(); }

  private applyDisplay(): void {
    for (const [id, p] of this.parts) {
      const own = this.ghosted.has(id) || this.animGhost.has(id);
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
    this.applyStandIns();
    this.syncSection();
  }

  /**
   * Sichtbare Bauteile, getrennt nach deckend und einzeln transparent. Treffer gehen zuerst an die deckenden. Tritt das Modell
   * hinter einer Ebene zurück, zählen die Bauteile, deren Netz dort zu sehen ist: Die Ebene hat dieselbe Form (nur feiner
   * unterteilt), ihre Flächen kennt aber nur das Modell (Schnitt an Fläche ausrichten, Drehpunkt per Doppelklick).
   */
  private pickSets(): [PartEntry[], PartEntry[]] {
    const vis = this.modelHidden
      ? this.standIns.flatMap((s) => (s.part && s.mesh.visible ? [s.part] : []))
      : [...this.parts.values()].filter((p) => p.group.visible);
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
    if (d < first.distance && back && this.capShown(first.object)) {
      return { ...first, point: at, distance: d, face: null, faceIndex: undefined, cut: true };
    }
    return first;
  }

  /**
   * Hat der Körper dieses Netzes gerade einen Deckel? Netz eines Bauteils: sein eigener oder, solange eine Ebene es vertritt,
   * der des Netzes dort (dessen Deckel ist dann zu sehen). Netz einer Ebene: sein eigener.
   */
  private capShown(o: THREE.Object3D): boolean {
    const p = this.partOf(o);
    if (p) return !!p.cap?.plate.visible || this.standIns.some((s) => s.part === p && !!s.cap?.plate.visible);
    return this.standIns.some((s) => s.mesh === o && !!s.cap?.plate.visible);
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
    // Ohne Auswahl zählt, was zu sehen ist: auch die Netze einer Ebene an Stelle des Modells (sonst passte „Einpassen“ auf nichts)
    if (!ids) for (const s of this.standIns) if (s.mesh.visible) box.expandByObject(s.mesh);
    return box;
  }

  /**
   * Mitte und Radius aller Bauteile in ihrer aktuellen Lage (die Explosionsansicht vergrößert das Modell). Mit den Netzen einer
   * Ebene: Ein Ergebnis von einem älteren Stand kann über das Modell hinausragen, die Deckel im Schnitt müssen es abdecken.
   */
  private updateExtent(): void {
    const box = this.bounds([...this.parts.keys()]);
    for (const s of this.standIns) box.expandByObject(s.mesh);
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
    const dist = radius / Math.sin(THREE.MathUtils.degToRad(this.persp.fov / 2)) * 1.05;
    this.anim?.stop();
    this.placeAt(center, dir, dist);
    this.controls.update();
    this.fitClip();
    this.requestRender();
  }

  // ---- Kamera, Projektion und Maus (E81) -------------------------------------------------------------------------

  /** tan des halben Bildwinkels: Höhe in der Ebene des Drehpunkts je Abstand. */
  private get halfTan(): number { return Math.tan(THREE.MathUtils.degToRad(this.persp.fov / 2)); }

  /**
   * Kamera auf `target` aus Richtung `dir` (Einheitsvektor, vom Ziel zur Kamera) mit dem Abstand `dist`. Orthografisch wird
   * daraus der Maßstab: dieselbe Bildhöhe in der Ebene des Ziels wie perspektivisch aus diesem Abstand.
   */
  private placeAt(target: THREE.Vector3, dir: THREE.Vector3, dist: number): void {
    this.controls.target.copy(target);
    this.camera.position.copy(target).addScaledVector(dir, dist);
    if (this.camera === this.ortho) {
      this.ortho.zoom = this.ortho.top / Math.max(dist * this.halfTan, 1e-6);
      this.ortho.updateProjectionMatrix();
    }
  }

  /** Abstand, der dem Bild entspricht: perspektivisch der echte, orthografisch der aus dem Maßstab (siehe placeAt). */
  private viewDist(): number {
    if (this.camera === this.ortho) return this.ortho.top / this.ortho.zoom / this.halfTan;
    return this.camera.position.distanceTo(this.controls.target);
  }

  get projection(): Projection { return this.camera === this.ortho ? 'orthographic' : 'perspective'; }

  /** Projektion umschalten. Drehpunkt, Blickrichtung und Bildgröße in der Ebene des Drehpunkts bleiben. */
  setProjection(p: Projection): void {
    if (p === this.projection) return;
    this.anim?.stop();
    const target = this.controls.target.clone();
    const off = this.camera.position.clone().sub(target);
    // Vor dem ersten Modell stehen Kamera und Drehpunkt noch am selben Ort: dann aus der Richtung der Standardansicht
    const dir = off.lengthSq() > 1e-18 ? off.normalize() : new THREE.Vector3(0.8, -1.2, 0.9).normalize();
    const dist = this.viewDist() || 100;
    this.camera = p === 'orthographic' ? this.ortho : this.persp;
    this.controls.object = this.camera;
    this.placeAt(target, dir, dist);
    this.controls.update();
    this.resize();
    this.fitClip();
    this.requestRender();
  }

  /** Mausbelegung und Zoomrichtung (E81). Negativ gerechnet zoomt OrbitControls beim Rad und beim Ziehen andersherum. */
  setNavigation(preset: NavPreset, invertZoom: boolean): void {
    this.nav = preset;
    this.controls.zoomSpeed = invertZoom ? -1 : 1;
  }

  /**
   * Beim Drücken einer Maustaste die Bewegung dieser Taste setzen. OrbitControls tauscht von sich aus Drehen und Verschieben,
   * solange Umschalt oder Strg gehalten wird. Deshalb bekommt es mit gehaltener Taste das Gegenstück dessen, was die
   * Belegung will, dann kommt genau das heraus.
   */
  private routeButton(e: PointerEvent): void {
    if (e.pointerType === 'touch' || e.target !== this.renderer.domElement) return;
    // Alt + links ziehen: Rahmenauswahl, in jeder Mausbelegung frei. Die Kamera bleibt dabei stehen
    if (e.altKey && e.button === 0 && !this.modelHidden && this.mode === 'select' && !this.planePick) {
      this.controls.mouseButtons = { LEFT: NAV_NONE, MIDDLE: NAV_NONE, RIGHT: NAV_NONE };
      this.startBox(e);
      return;
    }
    const button = NAV_BUTTON[e.button];
    if (!button) return;
    const held = e.ctrlKey || e.metaKey || e.shiftKey;
    const action = navAction(this.nav, button, e.ctrlKey || e.metaKey ? 'ctrl' : e.shiftKey ? 'shift' : '');
    const mouse = action === 'zoom' ? THREE.MOUSE.DOLLY
      : action === 'rotate' ? (held ? THREE.MOUSE.PAN : THREE.MOUSE.ROTATE)
        : action === 'pan' ? (held ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN) : NAV_NONE;
    this.controls.mouseButtons = { LEFT: NAV_NONE, MIDDLE: NAV_NONE, RIGHT: NAV_NONE, [NAV_KEY[button]]: mouse };
    // Mittlere Taste: kein automatisches Blättern von Chromium
    if (e.button === 1) e.preventDefault();
  }

  // ---- Ansichtswürfel und Drehpunkt -----------------------------------------------------------------------------

  /** Den Ansichtswürfel in diesem Element anzeigen. Er dreht sich mit der Kamera und dreht sie auf Klick oder Ziehen. */
  attachCube(el: HTMLElement): void {
    this.cube = new ViewCube(el, {
      camera: () => this.camera,
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
    if (this.camera === this.ortho) { this.fitOrtho(); return; }
    const dist = Math.max(this.camera.position.distanceTo(this.controls.target), 1e-3);
    const near = Math.max(dist / 200, 1e-3);
    const far = Math.max(this.camera.position.distanceTo(this.center) + this.radius * 2, near * 100);
    if (Math.abs(near - this.camera.near) > near * 0.02 || Math.abs(far - this.camera.far) > far * 0.02) {
      this.camera.near = near;
      this.camera.far = far;
      this.camera.updateProjectionMatrix();
    }
  }

  /**
   * Orthografisch: Das ganze Modell muss vor der Kamera liegen, sonst schneidet die vordere Ebene es an und Strahlen zum
   * Auswählen beginnen mitten darin. Die Kamera rückt dafür auf der Blickrichtung zurück, das Bild ändert sich nicht.
   */
  private fitOrtho(): void {
    const target = this.controls.target;
    const need = target.distanceTo(this.center) + this.radius * 2 + 1;
    const off = this.ortho.position.clone().sub(target);
    if (off.lengthSq() < 1e-18) off.set(0.8, -1.2, 0.9);
    if (off.length() < need) this.ortho.position.copy(target).addScaledVector(off.normalize(), need);
    const far = this.ortho.position.distanceTo(this.center) + this.radius * 2;
    if (this.ortho.near !== 0 || Math.abs(far - this.ortho.far) > far * 0.02) {
      this.ortho.near = 0;
      this.ortho.far = far;
      this.ortho.updateProjectionMatrix();
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
    // Vertritt eine Ebene das Modell, wählt ein Klick kein Bauteil: Er gehört dort der Ebene (Wert eines Ergebnisses merken)
    const hit = this.modelHidden ? undefined : this.firstHit();
    this.highlight.clear();
    if (!hit) { this.selectedId = null; this.selectedIds.clear(); this.applySelection(); this.requestRender(); return null; }
    const part = this.partOf(hit.object)!;
    const face = hit.faceIndex != null ? Viewer.faceOfTriangle(part.meta.faces, hit.faceIndex) : null;
    this.selectedId = part.meta.partId;
    this.selectedIds = new Set([part.meta.partId]);
    this.applySelection();
    if (face && face.triCount) this.highlightFace(part, face);
    this.requestRender();
    return {
      partId: part.meta.partId, name: part.meta.name, role: part.meta.role,
      faceId: face?.id ?? null, surface: face?.surface ?? null, area: face?.area ?? null,
      // In Einbaulage: Die Explosionsansicht verschiebt nur die Darstellung, der Agent kennt nur das Modell
      point: this.restPoint(part, hit.point).toArray().map((v) => +v.toFixed(3)),
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
    // Ausgewählt wird nur mit der linken Taste: Mitte und rechts drehen oder verschieben je nach Belegung (E81)
    let downR: [number, number] | null = null;
    el.addEventListener('pointerdown', (e) => {
      down = e.button === 0 && !e.altKey ? [e.clientX, e.clientY] : null;
      downR = e.button === 2 ? [e.clientX, e.clientY] : null;
    });
    // Rechtsklick ohne Ziehen öffnet das Menü (rechts ziehen verschiebt oder dreht je nach Belegung)
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerup', (e) => {
      if (e.button !== 2 || !downR || Math.hypot(e.clientX - downR[0], e.clientY - downR[1]) > 4) return;
      downR = null;
      if (this.mode !== 'select' || this.planePick) return;
      this.onContext(this.partAt(e.clientX, e.clientY), e.clientX, e.clientY);
    });
    el.addEventListener('pointerup', (e) => {
      if (!down || e.button !== 0 || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return; // Ziehen ist kein Klick
      if (this.planePick) { const cb = this.planePick; this.pickPlane(null); cb(this.planeAt(e.clientX, e.clientY)); return; }
      if (this.mode === 'measure') {
        const h = this.probeAt(e.clientX, e.clientY);
        if (h === 'cut') this.onMeasureCut(); else this.onMeasurePick(h);
        return;
      }
      const r = el.getBoundingClientRect();
      this.onPick(this.pickAt(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
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
    let eye = this.camera.position;
    let dist = eye.distanceTo(p);
    if (this.camera === this.ortho) {
      // Orthografisch laufen die Sehstrahlen parallel: vom Punkt in der Bildebene der Kamera, der vor `p` liegt
      const fwd = this.ortho.getWorldDirection(new THREE.Vector3());
      dist = fwd.dot(p.clone().sub(eye));
      eye = p.clone().addScaledVector(fwd, -dist);
    }
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
      const of = this.contourOf[k].part;
      if (!of || !allowed.has(of)) continue;
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
      const face = part?.meta.faces.find((f) => f.id === fid);
      if (!part || !face) continue;
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

  /** Beschriftungen an Punkten (mm) ins Bild setzen, null: keine. Die Elemente baut der Aufrufer, hier werden sie nur verschoben. */
  setTags(items: { el: HTMLElement; at: number[] }[] | null): void {
    for (const t of this.tagItems) t.el.remove();
    this.tagItems = (items ?? []).map((t) => ({ el: t.el, at: new THREE.Vector3(...(t.at as [number, number, number])) }));
    for (const t of this.tagItems) this.overlay.appendChild(t.el);
    this.requestRender();
  }

  private placeOverlay(): void {
    if (!this.overlayItems.length && !this.tagItems.length) return;
    const w = this.container.clientWidth, h = this.container.clientHeight;
    const v = new THREE.Vector3();
    for (const it of [...this.overlayItems, ...this.tagItems]) {
      v.copy(it.at).project(this.camera);
      const off = v.z > 1 || v.x < -1.2 || v.x > 1.2 || v.y < -1.2 || v.y > 1.2;
      it.el.hidden = off;
      if (!off) it.el.style.transform = `translate(${((v.x + 1) / 2) * w}px, ${((1 - v.y) / 2) * h}px)`;
    }
  }

  select(id: string | null): void { this.setSelection(id ? [id] : [], id); }

  /** Mehrere Bauteile auswählen. `primary`: das zuletzt gewählte (Auswahlkarte, Code). Die Fläche bleibt nur bei ihm markiert. */
  setSelection(ids: string[], primary: string | null): void {
    if (primary !== this.selectedId || ids.length !== 1) this.highlight.clear();
    this.selectedIds = new Set(ids.filter((id) => this.parts.has(id)));
    this.selectedId = primary && this.selectedIds.has(primary) ? primary : null;
    this.applySelection();
    this.requestRender();
  }

  get selectionIds(): string[] { return [...this.selectedIds]; }

  /** Bauteil unter dem Zeiger (Rechtsklick), auch wenn eine Ergebnisebene das Modell vertritt. Ändert die Auswahl nicht. */
  partAt(clientX: number, clientY: number): string | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    if (this.modelHidden) {
      const hit = this.pickLayer(clientX, clientY);
      return hit ? this.standIns.find((s) => s.mesh === hit.object)?.part?.meta.partId ?? null : null;
    }
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.camera);
    const hit = this.firstHit();
    return hit ? this.partOf(hit.object)?.meta.partId ?? null : null;
  }

  // ---- Rahmenauswahl (Alt + links ziehen) -------------------------------------------------------------------------

  private startBox(e: PointerEvent): void {
    const r = this.container.getBoundingClientRect();
    const box = document.createElement('div');
    box.className = 'v-box';
    this.container.appendChild(box);
    this.box = { x: e.clientX - r.left, y: e.clientY - r.top, el: box, id: e.pointerId };
    const canvas = this.renderer.domElement;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* Zeiger ohne Fang (synthetisch): der Rahmen geht trotzdem */ }
    const move = (ev: PointerEvent) => this.drawBox(ev.clientX - r.left, ev.clientY - r.top);
    const up = (ev: PointerEvent) => {
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', up);
      canvas.removeEventListener('pointercancel', up);
      const b = this.box;
      this.box = null;
      box.remove();
      if (!b || ev.type === 'pointercancel') return;
      const x1 = ev.clientX - r.left, y1 = ev.clientY - r.top;
      if (Math.hypot(x1 - b.x, y1 - b.y) < 4) return;
      // Von links nach rechts: nur Teile ganz im Rahmen. Von rechts nach links: auch angeschnittene (wie in CAD üblich)
      this.onBox(this.partsInRect(Math.min(b.x, x1), Math.min(b.y, y1), Math.max(b.x, x1), Math.max(b.y, y1), x1 < b.x), ev.shiftKey || ev.ctrlKey || ev.metaKey);
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    this.drawBox(this.box.x, this.box.y);
  }

  private drawBox(x: number, y: number): void {
    const b = this.box;
    if (!b) return;
    b.el.style.left = `${Math.min(b.x, x)}px`;
    b.el.style.top = `${Math.min(b.y, y)}px`;
    b.el.style.width = `${Math.abs(x - b.x)}px`;
    b.el.style.height = `${Math.abs(y - b.y)}px`;
    b.el.classList.toggle('cross', x < b.x);
  }

  /**
   * Sichtbare Bauteile im Rechteck (Pixel im Viewer). Geprüft werden die Ecken der Netze (bei großen Netzen eine Auswahl):
   * `crossing` reicht eine Ecke im Rahmen, sonst müssen alle darin liegen. Angeschnitten zählt zusätzlich, was Strahlen auf
   * einem Raster im Rahmen treffen (eine große Fläche ohne Ecke im Rahmen).
   */
  partsInRect(x0: number, y0: number, x1: number, y1: number, crossing: boolean): string[] {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.camera.updateMatrixWorld();
    const v = new THREE.Vector3();
    const out = new Set<string>();
    for (const [id, p] of this.parts) {
      if (!p.group.visible) continue;
      let any = false, all = true, n = 0;
      for (const m of p.meshes) {
        const pos = m.geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
        if (!pos) continue;
        m.updateMatrixWorld();
        const step = Math.max(1, Math.floor(pos.count / 3000));
        for (let i = 0; i < pos.count; i += step) {
          v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld).project(this.camera);
          const sx = ((v.x + 1) / 2) * w, sy = ((1 - v.y) / 2) * h;
          const inside = v.z <= 1 && sx >= x0 && sx <= x1 && sy >= y0 && sy <= y1;
          n++;
          if (inside) any = true; else all = false;
          if (crossing && any) break;
          if (!crossing && !all) break;
        }
        if ((crossing && any) || (!crossing && !all)) break;
      }
      if (n && (crossing ? any : all)) out.add(id);
    }
    if (crossing) {
      const steps = 12;
      for (let i = 0; i <= steps; i++) for (let j = 0; j <= steps; j++) {
        const sx = x0 + ((x1 - x0) * i) / steps, sy = y0 + ((y1 - y0) * j) / steps;
        this.raycaster.setFromCamera(new THREE.Vector2((sx / w) * 2 - 1, -(sy / h) * 2 + 1), this.camera);
        const hit = this.firstHit();
        const id = hit ? this.partOf(hit.object)?.meta.partId : undefined;
        if (id) out.add(id);
      }
    }
    return [...this.parts.keys()].filter((id) => out.has(id));
  }

  /** Das ausgewählte Bauteil leuchtet leicht orange (Farbe der Auswahl in der ganzen Oberfläche). */
  private applySelection(): void {
    for (const [id, p] of this.parts) {
      for (const m of p.meshes) {
        const mat = m.material as THREE.MeshStandardMaterial;
        mat.emissive?.setHex(this.selectedIds.has(id) ? 0x5a2e00 : 0x000000);
        // Hervorhebung einer Animation (E58): Flächenfarbe deutlich nach Orange ziehen. Nur Leuchten färbte ein blaues Teil violett
        // (Violett heißt in der Oberfläche Vorschau)
        // (Material.clone() macht aus einer Farbe in userData ein einfaches Objekt: dann neu merken)
        const stored = mat.userData.baseColor as unknown;
        const base = stored instanceof THREE.Color ? stored : (mat.userData.baseColor = mat.color.clone());
        if (this.animHighlight.has(id)) mat.color.copy(base).lerp(Viewer.highlightColor, 0.65); else mat.color.copy(base);
      }
    }
  }
  get selection(): string | null { return this.selectedId; }

  // ---- Rendern --------------------------------------------------------------------------------------------------

  private resize(): void {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    const dpr = this.renderer.getPixelRatio();
    this.paint.width = Math.round(w * dpr);
    this.paint.height = Math.round(h * dpr);
    for (const m of this.lineMats) m.resolution.set(w, h);
    this.persp.aspect = w / h;
    this.persp.updateProjectionMatrix();
    this.ortho.left = -w / h;
    this.ortho.right = w / h;
    this.ortho.updateProjectionMatrix();
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
      this.paintLive();
      this.cube?.render();
    });
  }

  /**
   * Bild der aktuellen Ansicht in voller Auflösung, Grundlage der Markierung (E16). Die Zeichenfläche ist durchsichtig,
   * den Verlauf dahinter malt sonst CSS. Er wird hier nachgebildet (`radial-gradient(ellipse at 52% 44%, …)` in style.css),
   * damit das Bild aussieht wie der Viewer. Die Auswahl fehlt im Bild: Sie ist Orange wie der Stift und würde die Markierung verschlucken.
   */
  snapshot(): HTMLCanvasElement {
    const sel = this.selectedId, sels = this.selectedIds;
    this.selectedId = null;
    this.selectedIds = new Set();
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
      this.selectedIds = sels;
      this.applySelection();
      this.highlight.visible = !this.modelHidden;
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
    if (this.painter) this.painter(g, w, h, (p) => this.project(p, w, h));
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
    const take = (world: NonNullable<PartEntry['world']>) => {
      for (const w of world) {
        const pos = w.pos;
        for (let i = 0; i < pos.length; i += 3) {
          const v = d.x * pos[i] + d.y * pos[i + 1] + d.z * pos[i + 2];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
    };
    for (const [id, p] of this.parts) {
      if (ids ? !ids.includes(id) : !p.group.visible) continue;
      take(this.worldOf(p));
    }
    // Tritt das Modell zurück, sind seine Teile unsichtbar: Der Schieber reicht dann über die Netze der Ebene
    if (!ids) for (const s of this.standIns) if (s.mesh.visible) take(this.standInWorld(s));
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
    p.world = Viewer.worldTriangles(p.meshes, p.meshes.find((m) => m.geometry.index));
    return p.world;
  }

  /** Dasselbe für ein Netz einer Ebene (einmal berechnet, bis die überhöhte Verformung es bewegt, siehe standInsMoved). */
  private standInWorld(s: StandIn): NonNullable<StandIn['world']> {
    if (s.world) return s.world;
    s.mesh.updateWorldMatrix(true, false);
    s.world = Viewer.worldTriangles([s.mesh]);
    return s.world;
  }

  /** Dreiecke der Netze in Weltkoordinaten. `faceMesh`: das Netz, dessen Dreiecke den Flächen des Bauteils folgen. */
  private static worldTriangles(meshes: THREE.Mesh[], faceMesh?: THREE.Mesh): NonNullable<PartEntry['world']> {
    const v = new THREE.Vector3();
    return meshes.map((m) => {
      const src = m.geometry.getAttribute('position');
      const pos = new Float32Array(src.count * 3);
      for (let i = 0; i < src.count; i++) { v.fromBufferAttribute(src, i).applyMatrix4(m.matrixWorld); pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z; }
      const idx = m.geometry.index ? m.geometry.index.array : Array.from({ length: src.count }, (_, i) => i);
      return { pos, idx, faces: m === faceMesh };
    });
  }

  /**
   * Deckel und Kontur an den aktuellen Stand anpassen: Deckel nur für sichtbare, deckende, geschlossene Körper. Transparente
   * Teile und Referenzen bekommen keinen (ihr Inneres ist ohnehin zu sehen), im Drahtgitter gibt es nur die Kontur.
   */
  private syncSection(): void {
    const on = this.clip.length > 0;
    let k = 0;
    const order = (cap: NonNullable<PartEntry['cap']>, want: boolean) => {
      for (const s of cap.stencils) { s.visible = want; s.renderOrder = CAP_ORDER + 2 * k; }
      cap.plate.visible = want;
      cap.plate.renderOrder = CAP_ORDER + 2 * k + 1;
      if (want) k++;
    };
    for (const [id, p] of this.parts) {
      const mat = p.meshes[0]?.material as THREE.MeshStandardMaterial | undefined;
      const want = on && !this.wire && p.group.visible && p.meta.solid !== false && !this.ghosted.has(id) && !!mat && !mat.userData.baseTransparent;
      if (want && !p.cap) p.cap = this.makeCap(p.meshes, mat!.color);
      if (p.cap) order(p.cap, want);
    }
    // Netze einer Ebene (das Modell ist dann versteckt, seine Deckel aus): sonst sähe man in die hohlen, gefärbten Netze hinein
    for (const s of this.standIns) {
      const want = on && !this.wire && s.mesh.visible && s.part?.meta.solid !== false && !(s.part && this.ownGhost(s.part.meta.partId));
      if (want && !s.cap) s.cap = this.makeCap([s.mesh], LAYER_CAP);
      if (s.cap) order(s.cap, want);
    }
    if (on) this.placeCaps();
    this.contourDirty = true;
  }

  /**
   * Gefüllte Schnittfläche nach dem Verfahren mit dem Schablonenpuffer: Die Rückseiten des geschnittenen Körpers zählen hoch,
   * die Vorderseiten herunter. Wo etwas übrig bleibt, liegt die Schnittebene im Material, dort zeichnet die Platte in der Ebene.
   * Sie setzt den Puffer dabei zurück, damit das nächste Bauteil von vorn zählt.
   */
  private makeCap(meshes: THREE.Mesh[], base: THREE.Color): NonNullable<PartEntry['cap']> {
    const stencils: THREE.Mesh[] = [];
    for (const m of meshes) {
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

  /** Alle Deckel weg, auch die der Netze einer Ebene. syncSection legt sie bei Bedarf neu an. */
  private clearCaps(): void {
    for (const o of [...this.parts.values(), ...this.standIns]) {
      if (!o.cap) continue;
      Viewer.dropCap(o.cap);
      o.cap = undefined;
    }
    this.caps.clear();
    this.setContour(null);
  }

  private static dropCap(cap: NonNullable<PartEntry['cap']>): void {
    for (const s of cap.stencils) { s.removeFromParent(); (s.material as THREE.Material).dispose(); }
    cap.plate.removeFromParent();
    (cap.plate.material as THREE.Material).dispose();
  }

  /** Vor dem Zeichnen: Kontur neu berechnen, wenn sich Ebene oder Sichtbarkeit geändert haben. */
  private prepareSection(): void {
    if (!this.contourDirty) return;
    this.contourDirty = false;
    this.setContour(this.clip.length ? this.computeContour() : null);
  }

  /** Schnittlinien der Dreiecke mit der Ebene, je Segment mit Bauteil und Fläche. Transparente Teile bleiben ohne Kontur. */
  private computeContour(): { flat: number[]; of: { part: PartEntry | null; face: number }[] } {
    const n = this.plane.normal, c = this.plane.constant;
    const flat: number[] = [], of: { part: PartEntry | null; face: number }[] = [];
    const cross = (pos: Float32Array, i: number, j: number, di: number, dj: number) => {
      const t = di / (di - dj);
      flat.push(pos[i] + (pos[j] - pos[i]) * t, pos[i + 1] + (pos[j + 1] - pos[i + 1]) * t, pos[i + 2] + (pos[j + 2] - pos[i + 2]) * t);
    };
    // `p`: Bauteil mit Flächen, null bei Netzen einer Ebene (ihre Kontur lässt sich nicht als Fläche anklicken)
    const add = (world: NonNullable<PartEntry['world']>, p: PartEntry | null) => {
      for (const w of world) {
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
          if (p && w.faces && !(face && tri >= face.triStart && tri < face.triStart + face.triCount)) face = Viewer.faceOfTriangle(p.meta.faces, tri);
          of.push({ part: p, face: p && w.faces && face ? face.id : -1 });
        }
      }
    };
    for (const [id, p] of this.parts) {
      if (!p.group.visible || this.ghosted.has(id)) continue;
      add(this.worldOf(p), p);
    }
    for (const s of this.standIns) {
      if (!s.mesh.visible || (s.part && this.ownGhost(s.part.meta.partId))) continue;
      add(this.standInWorld(s), null);
    }
    return { flat, of };
  }

  private setContour(c: { flat: number[]; of: { part: PartEntry | null; face: number }[] } | null): void {
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
      const dirs: number[][] = [];
      const take = (d?: number[]) => {
        if (!Array.isArray(d) || d.length !== 3 || !d.every(Number.isFinite)) return;
        const l = Math.hypot(d[0], d[1], d[2]);
        if (l < 1e-9) return;
        const u = d.map((x) => x / l);
        if (!dirs.some((e) => Math.abs(e[0] * u[0] + e[1] * u[1] + e[2] * u[2]) > 0.9995)) dirs.push(u);
      };
      const planes = p.meta.faces.filter((f) => f.surface === 'PLANE' && f.normal && f.area);
      const big = Math.max(0, ...planes.map((f) => f.area!));
      for (const f of p.meta.faces) if (f.surface === 'CYLINDER' || f.surface === 'CONE') take(f.axis);
      for (const f of planes) if (f.area! >= OWN_PLANE_SHARE * big) take(f.normal);
      return { id: p.meta.partId, group: p.meta.group ?? null, role: p.meta.role, min: box.min.toArray(), max: box.max.toArray(),
        axis: axis ? axis.toArray() : null, span, dirs };
    });
  }

  /**
   * Was stünde jedem Bauteil in jeder Richtung im Weg (in Einbaulage)? Grundlage der Demontage-Analyse. Von Punkten knapp unter
   * der Oberfläche jedes Bauteils (`eps` nach innen: Berührflächen stören sich nicht, kleine Überschneidungen der Vernetzung
   * zählen nicht) gehen Strahlen in jede Richtung, gegen alle Bauteile zugleich (BVH). Trifft ein Strahl von P aus Q im Abstand t,
   * stößt P in dieser Richtung nach t gegen Q, und Q stieße in der Gegenrichtung gegen P. Treffer unter `touch` zählen als
   * Berührung: Dort liegt P an. `opp[i]` ist die Gegenrichtung von `dirs[i]`. Höchstens etwa `samples` Punkte je Bauteil.
   * Bei großen Baugruppen dauert das Sekunden: Die Rechnung gibt regelmäßig die Oberfläche frei, meldet den Fortschritt (0 bis 1)
   * und hört auf, sobald `signal` abbricht (Ergebnis dann null).
   */
  async explodeRays(ids: string[], dirs: number[][], opp: number[], opts: { eps: number; touch: number; samples: number },
    ctl: { signal?: AbortSignal; progress?: (f: number) => void } = {}): Promise<BlockMap | null> {
    let last = performance.now();
    // Freigeben, damit die Ladeanzeige zeichnet und „Abbrechen“ ankommt. false: abgebrochen. Nur aufrufen, wenn `due()`:
    // Ein await je Strahlpunkt kostete merklich Zeit
    const due = () => performance.now() - last >= YIELD_MS;
    const breathe = async (f: number): Promise<boolean> => {
      ctl.progress?.(f);
      await new Promise((r) => setTimeout(r, 0));
      last = performance.now();
      return !ctl.signal?.aborted;
    };
    const chunks = ids.flatMap((id) => { const p = this.parts.get(id); return p ? [{ id, p, w: this.worldOf(p) }] : []; });
    // Dreiecke aller Teile in Einbaulage hintereinander. Die BVH ordnet nur den Index um, die Ecken bleiben: Über ihren
    // Bereich findet ein Treffer sein Bauteil.
    let nv = 0, ni = 0;
    for (const c of chunks) for (const w of c.w) { nv += w.pos.length / 3; ni += w.idx.length; }
    const pos = new Float32Array(nv * 3), index = new Uint32Array(ni);
    const vStart: number[] = [], range: { id: string; i0: number; i1: number }[] = [];
    let v = 0, i = 0;
    for (const c of chunks) {
      vStart.push(v);
      const i0 = i, o = c.p.offset;
      for (const w of c.w) {
        for (let k = 0; k < w.pos.length; k += 3) {
          pos[v * 3 + k] = w.pos[k] - o.x; pos[v * 3 + k + 1] = w.pos[k + 1] - o.y; pos[v * 3 + k + 2] = w.pos[k + 2] - o.z;
        }
        for (let k = 0; k < w.idx.length; k++) index[i + k] = w.idx[k] + v;
        v += w.pos.length / 3;
        i += w.idx.length;
      }
      range.push({ id: c.id, i0, i1: i });
    }
    const ownerOf = (vertex: number) => {
      let lo = 0, hi = vStart.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (vStart[mid] <= vertex) lo = mid; else hi = mid - 1; }
      return chunks[lo].id;
    };
    const out: BlockMap = dirs.map(() => new Map());
    if (!ni) return out;
    // Vor dem Aufbau der BVH einmal zeichnen lassen, der dauert bei großen Netzen selbst spürbar
    if (!await breathe(0)) return null;
    // Die BVH sortiert den Index beim Aufbau um: Die Punkte je Bauteil kommen aus einer Kopie
    const tri = index.slice();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(index, 1));
    const bvh = new MeshBVH(g);
    // Für den Fortschritt: Zahl der Dreiecke, von denen Strahlen ausgehen
    const total = range.reduce((n, r) => { const t = (r.i1 - r.i0) / 3; return n + (t ? Math.ceil(t / Math.max(1, Math.ceil(t / opts.samples))) : 0); }, 0) || 1;
    let done = 0;
    const note = (m: Map<string, Map<string, RayHit>>, a: string, b: string, dist: number, touch: number, inside: number) => {
      let row = m.get(a);
      if (!row) { row = new Map(); m.set(a, row); }
      const h = row.get(b);
      if (!h) row.set(b, { dist, touch, inside });
      else { h.dist = Math.min(h.dist, dist); h.touch += touch; h.inside += inside; }
    };
    const seen = new Set<string>();
    const dv = dirs.map((d) => new THREE.Vector3(d[0], d[1], d[2]).normalize());
    const ray = new THREE.Ray();
    const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), n = new THREE.Vector3(), e = new THREE.Vector3(), at = new THREE.Vector3();
    for (const r of range) {
      const tris = (r.i1 - r.i0) / 3;
      if (!tris) continue;
      // Wenige Dreiecke (ebene Flächen): mehrere Punkte je Dreieck. Viele: jedes n-te Dreieck, je ein Punkt
      const per = Math.max(1, Math.min(SAMPLE_PATTERN.length, Math.floor(opts.samples / tris)));
      const stride = Math.max(1, Math.ceil(tris / opts.samples));
      for (let t = 0; t < tris; t += stride) {
        if (due() && !await breathe(done / total)) { g.dispose(); return null; }
        done++;
        const k = r.i0 + t * 3;
        A.fromArray(pos, tri[k] * 3); B.fromArray(pos, tri[k + 1] * 3); C.fromArray(pos, tri[k + 2] * 3);
        // Der Mesher legt die Dreiecke so, dass die Normale nach außen zeigt (gespiegelte Flächen umgedreht)
        n.subVectors(B, A).cross(e.subVectors(C, A));
        const len = n.length();
        if (len < 1e-12) continue;
        n.divideScalar(len);
        for (let q = 0; q < per; q++) {
          const [a, b, c] = SAMPLE_PATTERN[q];
          at.set(0, 0, 0).addScaledVector(A, a).addScaledVector(B, b).addScaledVector(C, c).addScaledVector(n, -opts.eps);
          for (let di = 0; di < dv.length; di++) {
            ray.origin.copy(at);
            ray.direction.copy(dv[di]);
            seen.clear();
            for (const h of bvh.raycast(ray, THREE.DoubleSide).sort((x, y) => x.distance - y.distance)) {
              if (!h.face) continue;
              const other = ownerOf(h.face.a);
              if (other === r.id) continue;
              // Die Normale des Dreiecks zeigt nach außen. Tritt schon der erste Treffer auf einem Teil aus, begann der Strahl in ihm
              const inside = !seen.has(other) && h.face.normal.dot(dv[di]) > 0 ? 1 : 0;
              seen.add(other);
              note(out[di], r.id, other, h.distance, h.distance < opts.touch ? 1 : 0, inside);
              note(out[opp[di]], other, r.id, h.distance, 0, inside);
            }
          }
        }
      }
    }
    g.dispose();
    return out;
  }

  /**
   * Bauteile aus der Einbaulage verschieben (nur verschieben, nicht drehen). Fehlende Bauteile und null: Einbaulage. `legs`: der
   * eigene Teil jedes Wegs (ohne den des Elternteils), dort beginnt der gestrichelte Weg. Klicks, Schnitt und Hervorhebungen
   * arbeiten danach mit der neuen Lage.
   */
  setOffsets(offsets: Map<string, number[]> | null, legs: Map<string, number[]> | null = null): void {
    for (const [id, p] of this.parts) {
      const o = offsets?.get(id);
      const next = new THREE.Vector3(o?.[0] ?? 0, o?.[1] ?? 0, o?.[2] ?? 0);
      if (next.equals(p.offset)) continue;
      p.offset.copy(next);
      p.group.position.copy(p.base).add(p.offset);
      p.group.updateMatrixWorld(true);
      p.world = undefined;
    }
    this.legs = offsets ? legs : null;
    this.follow();
    this.updateExtent();
    this.syncTrails();
    this.syncSection();
    this.fitClip();
    this.requestRender();
  }

  /** Wege der Explosionsansicht zeigen oder nicht. */
  setTrails(on: boolean): void { this.showTrails = on; this.syncTrails(); this.requestRender(); }

  /** Gestrichelte Linie je verschobenem, sichtbarem Bauteil: sein eigener Weg bis zur aktuellen Mitte. */
  private syncTrails(): void {
    this.clearGroup(this.trails);
    if (!this.showTrails) return;
    const flat: number[] = [];
    const c = new THREE.Vector3();
    for (const [id, p] of this.parts) {
      const l = this.legs?.get(id);
      const leg = l ? new THREE.Vector3(l[0], l[1], l[2]) : p.offset;
      if (!p.group.visible || leg.length() < this.radius * 1e-3) continue;
      new THREE.Box3().setFromObject(p.group).getCenter(c);
      flat.push(c.x - leg.x, c.y - leg.y, c.z - leg.z, c.x, c.y, c.z);
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

  // ---- Animation und Ergebnisse (E58) ---------------------------------------------------------------------------

  private static highlightColor = new THREE.Color(ORANGE);

  /**
   * Lage je Bauteil aus einer Animation (Matrix bezogen auf die Einbaulage, Schlüssel: partId). null oder fehlend: Einbaulage.
   * Wie bei der Explosion arbeiten Klicks, Schnitt und Hervorhebungen danach mit der neuen Lage.
   */
  setPoses(poses: Map<string, THREE.Matrix4> | null): void {
    const t = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    let changed = false;
    for (const p of this.parts.values()) {
      const m = poses?.get(p.meta.partId) ?? null;
      if (!m && !p.pose) continue;
      if (m && p.pose && m.equals(p.pose)) continue;
      p.pose = m ? m.clone() : undefined;
      if (m) m.decompose(t, q, sc); else { t.set(0, 0, 0); q.identity(); }
      p.group.position.copy(p.base).add(t).add(p.offset);
      p.group.quaternion.copy(q);
      p.group.updateMatrixWorld(true);
      p.world = undefined;
      changed = true;
    }
    if (!changed) return;
    this.follow();
    this.syncTrails();
    this.syncSection();
    this.fitClip();
    this.requestRender();
  }

  /** Zustände einer Animation (Schlüssel: partId). null: keine. */
  setAnimState(s: { hidden: Set<string>; ghost: Set<string>; highlight: Set<string> } | null): void {
    const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));
    const next = s ?? { hidden: new Set<string>(), ghost: new Set<string>(), highlight: new Set<string>() };
    if (same(next.hidden, this.animHidden) && same(next.ghost, this.animGhost) && same(next.highlight, this.animHighlight)) return;
    this.animHidden = new Set(next.hidden);
    this.animGhost = new Set(next.ghost);
    this.animHighlight = new Set(next.highlight);
    this.applyVisibility();
    this.applyDisplay();
    this.applySelection();
    this.requestRender();
  }

  /** Kamera an diese Stelle, Blick auf `target` (Drehpunkt), Z bleibt oben. */
  setCamera(position: THREE.Vector3, target: THREE.Vector3): void {
    this.anim?.stop();
    const off = position.clone().sub(target);
    const dist = off.length();
    this.placeAt(target, dist > 1e-9 ? off.divideScalar(dist) : new THREE.Vector3(0, -1, 0), dist);
    this.controls.update();
    this.fitClip();
    this.requestRender();
  }

  /** Malt Texte über das Bild (null: nichts). Wird bei jedem Zeichnen und im Schnappschuss aufgerufen. */
  setPainter(p: OverlayPainter | null): void {
    this.painter = p;
    this.requestRender();
  }

  private project(p: THREE.Vector3, w: number, h: number): { x: number; y: number } | null {
    const v = p.clone().project(this.camera);
    if (v.z > 1) return null;
    return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h };
  }

  private paintLive(): void {
    const g = this.paint.getContext('2d');
    if (!g) return;
    g.clearRect(0, 0, this.paint.width, this.paint.height);
    if (this.painter) this.painter(g, this.paint.width, this.paint.height, (p) => this.project(p, this.paint.width, this.paint.height));
  }

  /** Punkt in Einbaulage: ohne Explosion und Bewegung der Animation (der Agent kennt nur das Modell). */
  private restPoint(part: PartEntry, p: THREE.Vector3): THREE.Vector3 {
    const q = p.clone().sub(part.offset);
    return part.pose ? q.applyMatrix4(part.pose.clone().invert()) : q;
  }

  /** Das Modell ausblenden, solange eine eigene Ebene (Ergebnis) es zeigt. */
  setModelHidden(on: boolean): void {
    if (this.modelHidden === on) return;
    this.modelHidden = on;
    // Die angeklickte Fläche gehört zum versteckten Modell und läge sonst orange über den Farben der Ebene
    this.highlight.visible = !on;
    this.applyVisibility();
    this.requestRender();
  }

  /** Eigene Objekte in der Szene (Ergebnisse). Sie werden geschnitten, wenn ihre Materialien `clipPlanes` nutzen. */
  addLayer(o: THREE.Object3D): void { this.scene.add(o); this.requestRender(); }
  removeLayer(o: THREE.Object3D): void { this.scene.remove(o); this.requestRender(); }
  /** Die Liste der Schnittebenen (leer ohne Schnitt). Dieselbe Liste für alle Materialien, sie ändert sich an Ort und Stelle. */
  get clipPlanes(): THREE.Plane[] { return this.clip; }

  /**
   * Netze einer Ebene (addLayer), die je ein Bauteil vertreten, zugeordnet über den Namen. Der Viewer blendet sie mit ihrem
   * Bauteil aus, schaltet sie transparent und gibt ihnen im Schnitt Deckel und Kontur. Ihre Materialien gehören ihm dafür,
   * solange sie hier stehen. null: keine (vor dem Freigeben der Netze aufrufen, die Deckel hängen an ihnen).
   */
  setStandIns(items: { mesh: THREE.Mesh; name: string; lines?: THREE.LineSegments[] }[] | null): void {
    for (const s of this.standIns) if (s.cap) Viewer.dropCap(s.cap);
    this.standIns = (items ?? []).map((x) => ({ mesh: x.mesh, name: x.name, lines: x.lines ?? [] }));
    this.linkStandIns();
    this.updateExtent();
    this.applyVisibility(); // mit applyStandIns: Stand der Seitenleiste und der Darstellung, dazu Deckel im Schnitt
    this.fitClip();
    this.requestRender();
  }

  /** Die Netze der Ebene haben sich bewegt (andere Überhöhung der Verformung): Kontur und Bereich des Schnitts neu bestimmen. */
  standInsMoved(): void {
    for (const s of this.standIns) s.world = undefined;
    this.contourDirty = true;
    this.requestRender();
  }

  /** Netze der Ebene ihren Bauteilen zuordnen. Gleichnamige der Reihe nach (beide Seiten folgen der Reihenfolge des Modells). */
  private linkStandIns(): void {
    const byName = new Map<string, PartEntry[]>();
    for (const p of this.parts.values()) {
      const l = byName.get(p.meta.name);
      if (l) l.push(p); else byName.set(p.meta.name, [p]);
    }
    for (const s of this.standIns) s.part = byName.get(s.name)?.shift();
  }

  /**
   * Netz einer Ebene unter dem Zeiger, wie ein Klick ins Modell: Ausgeblendete Teile zählen nicht, transparent geschaltete nur,
   * wenn dahinter nichts Deckendes liegt, was der Schnitt wegnimmt, auch nicht. `cut`: Der Zeiger steht auf einer Schnittfläche.
   */
  pickLayer(clientX: number, clientY: number): (THREE.Intersection & { cut?: boolean }) | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.camera);
    const shown = this.standIns.filter((s) => s.mesh.visible);
    const own = (s: StandIn) => !!s.part && this.ownGhost(s.part.meta.partId);
    return this.visibleHit(shown.filter((s) => !own(s)).map((s) => s.mesh)) ?? this.visibleHit(shown.filter(own).map((s) => s.mesh)) ?? null;
  }

  /** Erster sichtbarer Treffer unter dem Zeiger auf diesen Objekten (was der Schnitt wegnimmt, zählt nicht). */
  pickObjects(clientX: number, clientY: number, objects: THREE.Object3D[]): THREE.Intersection | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.camera);
    return this.raycaster.intersectObjects(objects, true).find((h) => !this.clipped(h.point)) ?? null;
  }

  /** Feste Größe in CSS-Pixeln (Render-Fenster). */
  resizeTo(w: number, h: number): void {
    this.container.style.width = `${w}px`;
    this.container.style.height = `${h}px`;
    this.resize();
  }

  /** Lage eines Bauteils, für Tests: Mittelpunkt des Hüllquaders und Drehung (Quaternion). */
  partPose(id: string): { center: number[]; quaternion: number[] } | null {
    const p = this.parts.get(id);
    if (!p) return null;
    const c = new THREE.Box3().setFromObject(p.group).getCenter(new THREE.Vector3());
    return { center: c.toArray().map((v) => +v.toFixed(3)), quaternion: p.group.quaternion.toArray().map((v) => +v.toFixed(4)) };
  }

  /** Zustand der Animation im Viewer, für Tests. */
  animViewState() {
    return { hidden: [...this.animHidden], ghost: [...this.animGhost], highlight: [...this.animHighlight], modelHidden: this.modelHidden, painter: !!this.painter };
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
    const b = this.controls.mouseButtons;
    return { target: this.controls.target.toArray(), dir: d.clone().normalize().toArray(), dist: this.viewDist(), near: this.camera.near, far: this.camera.far,
      zoomToCursor: this.controls.zoomToCursor, animating: !!this.anim, projection: this.projection, navigation: this.nav, zoomSpeed: this.controls.zoomSpeed,
      buttons: [b.LEFT, b.MIDDLE, b.RIGHT] };
  }

  /** Stand des Schnitts, für Tests: Ebene, Bauteile mit Deckel, Segmente und Ausdehnung der Kontur, geschnittene Materialien. */
  sectionState() {
    this.prepareSection();
    const capped = [...this.parts.values()].filter((p) => p.cap?.plate.visible).map((p) => p.meta.partId);
    const clipped = [...this.parts.values()].every((p) => p.meshes.every((m) => (m.material as THREE.Material).clippingPlanes === this.clip));
    const box = this.contour?.geometry.boundingBox;
    return { plane: this.section, capped, contour: this.contourOf.length, contourBox: box ? [box.min.toArray(), box.max.toArray()] : null, clipped, picking: !!this.planePick };
  }

  /** Netze einer Ebene, für Tests: Name, zugeordnetes Bauteil, sichtbar, Deckkraft, Deckel im Schnitt. */
  layerState() {
    this.prepareSection();
    return this.standIns.map((s) => ({
      name: s.name, partId: s.part?.meta.partId ?? null, visible: s.mesh.visible, opacity: (s.mesh.material as THREE.Material).opacity,
      capped: !!s.cap?.plate.visible, edges: s.lines.some((l) => l.visible),
    }));
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
