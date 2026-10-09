import * as THREE from 'three';

/** Was der Würfel vom Viewer braucht. */
export interface CubeHost {
  /** Die gerade benutzte Kamera des Viewers (perspektivisch oder orthografisch, E81). */
  camera(): THREE.Camera;
  target(): THREE.Vector3;
  /** Ansicht aus dieser Richtung (vom Drehpunkt zur Kamera), animiert, Abstand und Drehpunkt bleiben. */
  orient(dir: THREE.Vector3): void;
  /** Um den Drehpunkt drehen: Winkel um die Hochachse und zur Hochachse hin (Bogenmaß). */
  orbit(dTheta: number, dPhi: number): void;
}

/** Seiten des Würfels. CAD-Konvention der App: Z oben, vorne ist -Y (so zeigt auch „Vorne“ im Viewer). */
const FACES: { n: [number, number, number]; up: [number, number, number]; text: string; bg: string }[] = [
  { n: [0, 0, 1], up: [0, 1, 0], text: 'TOP', bg: '#2b3139' },
  { n: [0, 0, -1], up: [0, -1, 0], text: 'BOTTOM', bg: '#2b3139' },
  { n: [0, -1, 0], up: [0, 0, 1], text: 'FRONT', bg: '#262b33' },
  { n: [0, 1, 0], up: [0, 0, 1], text: 'BACK', bg: '#262b33' },
  { n: [1, 0, 0], up: [0, 0, 1], text: 'RIGHT', bg: '#20252c' },
  { n: [-1, 0, 0], up: [0, 0, 1], text: 'LEFT', bg: '#20252c' },
];
/** Grenze zwischen Mitte und Rand einer Seite. Der Würfel reicht von -1 bis 1, außen liegen Kanten und Ecken. */
const EDGE = 0.62;
const SIZE = 116; // CSS-Pixel
const DRAG_PX = 3;
const AXES: { dir: [number, number, number]; color: string; label: string }[] = [
  { dir: [1, 0, 0], color: '#e5534b', label: 'X' }, { dir: [0, 1, 0], color: '#57ab5a', label: 'Y' }, { dir: [0, 0, 1], color: '#539bf5', label: 'Z' },
];

/** Richtung in Worten, für den Hinweis beim Überfahren: „Oben vorne rechts“. */
function dirName(s: number[]): string {
  const parts = [s[2] > 0 ? 'top' : s[2] < 0 ? 'bottom' : '', s[1] < 0 ? 'front' : s[1] > 0 ? 'back' : '', s[0] > 0 ? 'right' : s[0] < 0 ? 'left' : ''].filter(Boolean);
  const t = parts.join(' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/**
 * Ansichtswürfel wie in CAD-Programmen: eine eigene kleine 3D-Szene, die sich mit der Kamera dreht. Ein Klick auf eine
 * Seite, Kante oder Ecke (3 × 3 Felder je Seite, 26 Richtungen) dreht die Ansicht dorthin, Ziehen dreht frei.
 * Drehpunkt und Abstand bleiben dabei, damit man nah an einer Stelle bleiben kann. Einpassen macht der Knopf darunter.
 */
export class ViewCube {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-2.05, 2.05, 2.05, -2.05, 0.1, 20);
  private faces: THREE.Mesh[] = [];
  private textures: { tex: THREE.CanvasTexture; draw: () => void }[] = [];
  private hl = new THREE.Group();
  private hoverKey = '';
  private raycaster = new THREE.Raycaster();

  constructor(private el: HTMLElement, private host: CubeHost) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(SIZE, SIZE);
    this.renderer.setClearColor(0x000000, 0);
    el.appendChild(this.renderer.domElement);
    this.build();
    this.installPointer();
    // Beschriftung erst mit der eigenen Schrift sauber: nachzeichnen, sobald sie geladen ist
    void document.fonts?.ready.then(() => { for (const t of this.textures) { t.draw(); t.tex.needsUpdate = true; } this.render(); });
  }

  private build(): void {
    for (const f of FACES) {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      const draw = () => {
        const g = c.getContext('2d')!;
        g.fillStyle = f.bg;
        g.fillRect(0, 0, 256, 256);
        g.fillStyle = '#c9ced4';
        g.font = `600 44px "IBM Plex Sans", "Segoe UI", sans-serif`;
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.fillText(f.text, 128, 132);
      };
      draw();
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      this.textures.push({ tex, draw });
      // Ebene 2 × 2 ausrichten: rechts = oben × Normale, damit die Schrift aus der Ansicht dieser Seite lesbar steht
      const n = new THREE.Vector3(...f.n), up = new THREE.Vector3(...f.up), right = up.clone().cross(n);
      const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: tex }));
      m.applyMatrix4(new THREE.Matrix4().makeBasis(right, up, n).setPosition(n));
      m.userData.normal = n;
      this.faces.push(m);
      this.scene.add(m);
    }
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(2.01, 2.01, 2.01)), new THREE.LineBasicMaterial({ color: 0x56606c }));
    this.scene.add(edges, this.hl);
    // Achsen an der Ecke links vorne unten, wie gewohnt X rot, Y grün, Z blau
    const o = new THREE.Vector3(-1.02, -1.02, -1.02);
    for (const a of AXES) {
      const d = new THREE.Vector3(...a.dir);
      const g = new THREE.BufferGeometry().setFromPoints([o, o.clone().addScaledVector(d, 2.4)]);
      this.scene.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: a.color })));
      const lc = document.createElement('canvas');
      lc.width = lc.height = 64;
      const lg = lc.getContext('2d')!;
      lg.fillStyle = a.color;
      lg.font = '700 44px "IBM Plex Sans", "Segoe UI", sans-serif';
      lg.textAlign = 'center';
      lg.textBaseline = 'middle';
      lg.fillText(a.label, 32, 34);
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(lc), depthTest: false }));
      sp.position.copy(o).addScaledVector(d, 2.66);
      sp.scale.setScalar(0.38);
      this.scene.add(sp);
    }
  }

  /** Nach jedem Bild des Viewers: dieselbe Blickrichtung wie die Hauptkamera. */
  render(): void {
    const cam = this.host.camera();
    const dir = cam.position.clone().sub(this.host.target());
    if (dir.lengthSq() < 1e-18) return;
    this.cam.position.copy(dir.normalize().multiplyScalar(6));
    this.cam.up.copy(cam.up);
    this.cam.lookAt(0, 0, 0);
    this.renderer.render(this.scene, this.cam);
  }

  // ---- Eingabe --------------------------------------------------------------------------------------------------

  /** Feld unter dem Zeiger als Richtung mit Komponenten -1, 0, 1 (Mitte einer Seite, Kante oder Ecke). */
  private regionAt(clientX: number, clientY: number): number[] | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.raycaster.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.cam);
    const hit = this.raycaster.intersectObjects(this.faces, false)[0];
    if (!hit) return null;
    const p = hit.point, n = hit.object.userData.normal as THREE.Vector3;
    return [p.x, p.y, p.z].map((v, k) => (n.getComponent(k) !== 0 ? n.getComponent(k) : v > EDGE ? 1 : v < -EDGE ? -1 : 0));
  }

  private installPointer(): void {
    const c = this.renderer.domElement;
    let down: { x: number; y: number; lx: number; ly: number; dragged: boolean } | null = null;
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      down = { x: e.clientX, y: e.clientY, lx: e.clientX, ly: e.clientY, dragged: false };
      try { c.setPointerCapture(e.pointerId); } catch { /* synthetische Ereignisse (Tests) */ }
    });
    c.addEventListener('pointermove', (e) => {
      if (down) {
        if (!down.dragged && Math.hypot(e.clientX - down.x, e.clientY - down.y) > DRAG_PX) { down.dragged = true; this.setHover(null); }
        if (down.dragged) {
          // Wie Ziehen im Viewer: nach rechts ziehen dreht das Modell nach rechts
          const k = (2 * Math.PI) / (SIZE * 3);
          this.host.orbit(-(e.clientX - down.lx) * k, -(e.clientY - down.ly) * k);
          down.lx = e.clientX; down.ly = e.clientY;
        }
        return;
      }
      this.setHover(this.regionAt(e.clientX, e.clientY));
    });
    c.addEventListener('pointerup', (e) => {
      const d = down;
      down = null;
      if (!d || d.dragged) return;
      const s = this.regionAt(e.clientX, e.clientY);
      if (s) this.host.orient(new THREE.Vector3(s[0], s[1], s[2]));
    });
    c.addEventListener('pointerleave', () => { if (!down) this.setHover(null); });
  }

  /** Feld hervorheben: auf jeder Seite, die zur Richtung gehört, das passende der 3 × 3 Felder. */
  private setHover(s: number[] | null): void {
    const key = s ? s.join(',') : '';
    if (key === this.hoverKey) return;
    this.hoverKey = key;
    for (const o of [...this.hl.children]) { this.hl.remove(o); (o as THREE.Mesh).geometry.dispose(); ((o as THREE.Mesh).material as THREE.Material).dispose(); }
    this.el.title = s ? `${dirName(s)}: view from there (click). Drag to rotate.` : 'Click a face, edge or corner to view from there. Drag to rotate the view.';
    if (s) {
      const range = (v: number): [number, number] => (v < 0 ? [-1, -EDGE] : v > 0 ? [EDGE, 1] : [-EDGE, EDGE]);
      for (let a = 0; a < 3; a++) {
        if (!s[a]) continue;
        const [b, c] = [0, 1, 2].filter((k) => k !== a);
        const [b0, b1] = range(s[b]), [c0, c1] = range(s[c]);
        const corner = (vb: number, vc: number) => { const v = [0, 0, 0]; v[a] = s[a] * 1.004; v[b] = vb; v[c] = vc; return v; };
        const pos = [...corner(b0, c0), ...corner(b1, c0), ...corner(b1, c1), ...corner(b0, c0), ...corner(b1, c1), ...corner(b0, c1)];
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        this.hl.add(new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: 0xf29a38, transparent: true, opacity: 0.6, side: THREE.DoubleSide })));
      }
    }
    this.renderer.domElement.style.cursor = s ? 'pointer' : 'grab';
    this.render();
  }

  // ---- Prüfhilfe (nur Tests) ------------------------------------------------------------------------------------

  /** Bildschirmposition (Fenster-Pixel) eines Punkts auf dem Würfel, etwa (0, -1, 0) für die Mitte von „Vorne“. */
  screenOf(p: number[]): { x: number; y: number } {
    this.render();
    const v = new THREE.Vector3(p[0], p[1], p[2]).project(this.cam);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }
}
