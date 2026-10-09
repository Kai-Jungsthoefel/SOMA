import { el, fmtWhen, menus, toast } from './ui';

/** Werkzeuge der Markierung (E16). Nichts ist maßhaltig, Maße schreibt man als Text daneben. */
export type MarkTool = 'select' | 'pen' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'text';
type DrawTool = Exclude<MarkTool, 'select'>;
type Pt = [number, number];

/**
 * Eine gezeichnete Form. Die Geometrie liegt unskaliert um den Mittelpunkt (x, y), dazu kommen Drehung und Skalierung.
 * So lassen sich Formen nachträglich verschieben, drehen und skalieren, ohne dass die Strichstärke mitwächst.
 * Text hat keine Punkte, sondern die Größe seines Kastens (`box`).
 */
interface Shape { id: number; tool: DrawTool; color: string; pts: Pt[]; text?: string; box?: Pt; x: number; y: number; rot: number; sx: number; sy: number }

type Handle = { kind: 'move' } | { kind: 'rotate' } | { kind: 'scale'; corner: number };
type Drag =
  | { kind: 'draw'; tool: DrawTool; color: string; raw: Pt[] }
  | { kind: 'move' | 'rotate' | 'scale'; corner: number; id: number; start: Pt; orig: Shape; before: Shape[]; moved: boolean };

interface Ui {
  /** Bekommt die Klasse `marking`: Bauteilkarte, Würfel und Karten treten zurück, damit das Bild sauber bleibt. */
  viewer: HTMLElement;
  layer: HTMLElement;
  canvas: HTMLCanvasElement;
  text: HTMLInputElement;
  hint: HTMLElement;
  /** Werkzeugleiste mit Knöpfen `[data-tool]`. */
  tools: HTMLElement;
  undo: HTMLButtonElement;
  del: HTMLButtonElement;
  blank: HTMLButtonElement;
  /** Raster ein und aus. */
  grid: HTMLButtonElement;
  /** Knopf mit der aktuellen Farbe, darunter das Menü mit Knöpfen `[data-color]` und der eigenen Farbe. */
  colorBtn: HTMLButtonElement;
  colorSwatch: HTMLElement;
  palette: HTMLElement;
  custom: HTMLInputElement;
}

const LINE = 3; // Strichstärke in CSS-Pixeln
const FONT = 19;
/** Rand plus Innenabstand des Textfelds: So steht der Text im Bild dort, wo er beim Tippen stand. */
const TEXT_PAD: Pt = [5, 3];
/** Abstand des Auswahlrahmens zur Form, Abstand des Drehgriffs über dem Rahmen, Fangradius der Griffe und der Linien (CSS-Pixel). */
const SEL_PAD = 6, ROT_GAP = 24, GRAB = 9, TOL = 6;
/** Rasterweite in CSS-Pixeln, jede fünfte Linie kräftiger. */
const GRID = 20, GRID_MAJOR = 5;
/** Größte Vergrößerung über das Einpassen hinaus. */
const ZOOM_MAX = 8;
const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const clone = <T>(v: T): T => structuredClone(v);
const turn = (a: number, u: number, v: number): Pt => [u * Math.cos(a) - v * Math.sin(a), u * Math.sin(a) + v * Math.cos(a)];
const dist = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/**
 * Zeichnen auf einem eingefrorenen Bild des Viewers oder auf leerer Fläche (E16). Das Ergebnis ist ein PNG in voller
 * Auflösung. Gespeichert und an den Agenten gegeben wird es in main.ts, hier entsteht nur das Bild.
 * Jede Form bleibt ein eigenes Objekt: Mit „Auswählen“ lässt sie sich verschieben, drehen, skalieren, umfärben und löschen.
 * Formen liegen in CSS-Pixeln vor und werden bei jeder Änderung komplett neu gezeichnet (wenige Formen, das reicht).
 */
export class Markup {
  private shapes: Shape[] = [];
  /** Stände vor jeder Änderung, für Rückgängig und Wiederholen. */
  private history: Shape[][] = [];
  private future: Shape[][] = [];
  private nextId = 1;
  private selected: number | null = null;
  private drag: Drag | null = null;
  private tool: MarkTool = 'pen';
  private color: string;
  /** Name der Farbe aus der Palette, null bei eigener Farbe. */
  private colorName: string | null = 'orange';
  private bg: HTMLCanvasElement | null = null;
  private blankBg = false;
  /** Raster an: Es steht im Bild (wie Karopapier) und Linien, Pfeile und Formen rasten an den Kreuzungen ein. Bleibt für die nächste Markierung. */
  private grid = false;
  private scale = 1;
  private size: Pt = [0, 0];
  /**
   * Ansicht: Die Zeichenfläche wird in den Viewer eingepasst und lässt sich darüber hinaus vergrößern und verschieben.
   * `k` sind Bildschirmpixel je Pixel der Zeichenfläche, `off` ihre linke obere Ecke im Viewer. Die Formen bleiben in
   * den Pixeln der Zeichenfläche, Ansicht und Bild für den Agenten hängen also nicht voneinander ab.
   */
  private zoom = 1;
  private pan: Pt = [0, 0];
  private k = 1;
  private off: Pt = [0, 0];
  private panning: { id: number; x: number; y: number; pan: Pt } | null = null;
  private takenAt = Date.now();
  private sourceFile: string | null = null;
  /** Offenes Textfeld: neuer Text an `p` (oben links) oder ein vorhandener Text (`id`). */
  private editing: { id: number | null; p: Pt; color: string } | null = null;
  private escUntil = 0;
  private lastPress: { id: number; t: number } | null = null;
  /** Lage des offenen Textfelds in Pixeln der Zeichenfläche, damit es beim Zoomen mitwandert. */
  private input: { p: Pt; transform: string } | null = null;

  constructor(private ui: Ui) {
    this.color = css('--mk-orange') || '#f29a38';
    ui.tools.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.addEventListener('click', () => this.setTool(b.dataset.tool as MarkTool)));
    ui.colorBtn.addEventListener('click', () => menus.toggle(ui.palette, ui.colorBtn));
    ui.palette.querySelectorAll<HTMLButtonElement>('[data-color]').forEach((b) => b.addEventListener('click', () => {
      this.setColor(css(`--mk-${b.dataset.color}`) || this.color, b.dataset.color!);
      menus.close();
    }));
    // „change“ statt „input“: Der Farbdialog meldet sich so nur einmal, sonst entstünde pro Zwischenwert ein Rückgängig-Schritt
    ui.custom.addEventListener('change', () => this.setColor(ui.custom.value, null));
    ui.undo.addEventListener('click', () => this.undo());
    ui.del.addEventListener('click', () => this.removeSelected());
    ui.blank.addEventListener('click', () => { this.blankBg = !this.blankBg || !this.bg; this.renderUi(); this.draw(); });
    ui.grid.addEventListener('click', () => { this.grid = !this.grid; this.renderUi(); this.draw(); });
    this.installPointer();
    ui.text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.commitText(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.cancelText(); }
    });
    // Übernommen wird mit Enter, beim nächsten Klick auf die Zeichenfläche und beim Abschicken, bewusst nicht beim
    // Verlassen des Felds: Ein Blur-Ereignis käme je nach Klickreihenfolge einem gerade neu geöffneten Feld in die Quere.
    window.addEventListener('keydown', (e) => {
      // Im Terminal gehört Escape dem Agenten (Claude Code unterbricht damit), im Textfeld dem Textfeld
      if (!this.active || e.target === ui.text || (e.target as HTMLElement | null)?.closest?.('#terminals')) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (k === 'Escape') { e.preventDefault(); this.escape(); }
      else if (e.ctrlKey && !e.altKey && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); this.redo(); }
      else if (e.ctrlKey && !e.altKey && k === 'z') { e.preventDefault(); this.undo(); }
      else if ((k === 'Delete' || k === 'Backspace') && this.selected != null) { e.preventDefault(); this.removeSelected(); }
      else if (k.startsWith('Arrow') && this.selected != null && !e.ctrlKey && !e.altKey) { e.preventDefault(); this.nudge(k, e.shiftKey ? 10 : 1); }
      else if (e.ctrlKey && !e.altKey && k === '0') { e.preventDefault(); this.fit(); }
    });
    // Wird der Viewer größer (z. B. weil die PDF daneben geschlossen wird), wächst die Zeichenfläche mit
    new ResizeObserver(() => { if (this.active) this.layout(); }).observe(ui.layer);
  }

  get active(): boolean { return !this.ui.layer.hidden; }
  /** Es ist etwas gezeichnet oder ein Text angefangen, das beim Schließen verloren ginge. */
  get drawn(): boolean { return this.shapes.length > 0 || (!!this.editing && !!this.ui.text.value.trim()); }
  /** Bilddatei unter der Zeichnung, null beim Viewer-Bild und auf leerer Fläche. */
  get source(): string | null { return this.blankBg ? null : this.sourceFile; }

  /**
   * Öffnet die Zeichenfläche über dem Viewer. `snapshot` ist das Hintergrundbild in Gerätepixeln, im Seitenverhältnis des
   * Viewers, ohne Bild bleibt nur die leere Fläche. `source` ist die Bilddatei im Projekt, wenn nicht der Viewer abgebildet ist.
   */
  open(snapshot: HTMLCanvasElement | null, source: string | null = null): void {
    const w = this.ui.viewer.clientWidth, h = this.ui.viewer.clientHeight;
    this.bg = snapshot && snapshot.width && snapshot.height ? snapshot : null;
    this.scale = this.bg ? this.bg.width / w : window.devicePixelRatio || 1;
    this.size = [w, h];
    this.reset();
    this.blankBg = !this.bg;
    this.takenAt = Date.now();
    this.sourceFile = this.bg ? source : null;
    const c = this.ui.canvas;
    // Feste Größe für die ganze Sitzung: Ändert sich das Fenster, bleibt das Bild, wie es aufgenommen wurde
    c.width = this.bg ? this.bg.width : Math.round(w * this.scale);
    c.height = this.bg ? this.bg.height : Math.round(h * this.scale);
    this.zoom = 1;
    this.pan = [0, 0];
    this.ui.layer.hidden = false;
    this.layout();
    this.ui.viewer.classList.add('marking');
    this.ui.blank.disabled = !this.bg;
    this.renderUi();
    this.draw();
  }

  /** Schließt die Zeichenfläche und verwirft die Zeichnung. */
  close(): void {
    if (menus.isOpen(this.ui.palette)) menus.close();
    this.reset();
    this.bg = null;
    this.ui.layer.hidden = true;
    this.ui.viewer.classList.remove('marking');
    this.ui.canvas.width = 0; // Speicher des Bildes freigeben
    this.ui.canvas.height = 0;
  }

  private reset(): void {
    this.shapes = [];
    this.history = [];
    this.future = [];
    this.selected = null;
    this.drag = null;
    this.editing = null;
    this.lastPress = null;
    this.escUntil = 0;
    this.panning = null;
    this.input = null;
    this.ui.text.hidden = true;
  }

  // ---- Ansicht --------------------------------------------------------------------------------------------------

  /** Zeichenfläche einpassen und Zoom und Verschiebung anwenden. Ist sie kleiner als der Viewer, steht sie mittig. */
  private layout(): void {
    const W = this.ui.layer.clientWidth, H = this.ui.layer.clientHeight, [w, h] = this.size;
    if (!W || !H || !w || !h) return;
    this.k = Math.min(W / w, H / h) * this.zoom;
    const dw = w * this.k, dh = h * this.k;
    const place = (free: number, pan: number) => free >= 0 ? free / 2 : Math.max(free, Math.min(0, free / 2 + pan));
    this.off = [place(W - dw, this.pan[0]), place(H - dh, this.pan[1])];
    // Verschiebung auf das tatsächlich Mögliche zurückführen, sonst müsste man erst „zurückschieben“, bevor sich etwas tut
    this.pan = [W - dw >= 0 ? 0 : this.off[0] - (W - dw) / 2, H - dh >= 0 ? 0 : this.off[1] - (H - dh) / 2];
    Object.assign(this.ui.canvas.style, { left: `${this.off[0]}px`, top: `${this.off[1]}px`, width: `${dw}px`, height: `${dh}px` });
    this.placeInput();
  }

  /** Zoom um einen Punkt im Viewer (CSS-Pixel relativ zur Ebene): Der Punkt unter dem Mauszeiger bleibt stehen. */
  private zoomAt(factor: number, mx: number, my: number): void {
    const z = Math.max(1, Math.min(ZOOM_MAX, this.zoom * factor));
    if (z === this.zoom) return;
    const q: Pt = [(mx - this.off[0]) / this.k, (my - this.off[1]) / this.k];
    const W = this.ui.layer.clientWidth, H = this.ui.layer.clientHeight, [w, h] = this.size;
    const k = Math.min(W / w, H / h) * z;
    this.zoom = z;
    this.pan = [mx - q[0] * k - (W - w * k) / 2, my - q[1] * k - (H - h * k) / 2];
    this.layout();
  }

  /** Zurück auf eingepasst. */
  private fit(): void {
    this.zoom = 1;
    this.pan = [0, 0];
    this.layout();
  }

  undo(): void {
    if (this.editing) { this.cancelText(); return; }
    const prev = this.history.pop();
    if (!prev) return;
    this.future.push(clone(this.shapes));
    this.shapes = prev;
    this.changed();
  }

  redo(): void {
    const next = this.future.pop();
    if (!next) return;
    this.history.push(clone(this.shapes));
    this.shapes = next;
    this.changed();
  }

  /** PNG mit Hintergrund in voller Auflösung, ohne Auswahlrahmen. Ein offenes Textfeld wird vorher übernommen. */
  async image(): Promise<Uint8Array> {
    this.commitText();
    this.drag = null;
    this.draw(false);
    const blob = await new Promise<Blob | null>((r) => this.ui.canvas.toBlob(r, 'image/png'));
    this.draw();
    if (!blob) throw new Error('Could not create the image.');
    return new Uint8Array(await blob.arrayBuffer());
  }

  // ---- Bearbeiten -----------------------------------------------------------------------------------------------

  private sel(): Shape | undefined { return this.selected == null ? undefined : this.shapes.find((s) => s.id === this.selected); }

  /** Vor jeder Änderung aufrufen: legt den bisherigen Stand für Rückgängig ab. */
  private remember(before: Shape[] = clone(this.shapes)): void {
    this.history.push(before);
    this.future = [];
  }

  private changed(): void {
    if (!this.sel()) this.selected = null;
    this.renderUi();
    this.draw();
  }

  private setTool(t: MarkTool): void {
    this.tool = t;
    if (t !== 'select') this.selected = null;
    this.renderUi();
    this.draw();
  }

  /** Neue Farbe für alles Folgende. Eine ausgewählte Form und ein offenes Textfeld bekommen sie gleich mit. */
  private setColor(hex: string, name: string | null): void {
    this.color = hex;
    this.colorName = name;
    const s = this.sel();
    if (s && s.color !== hex) { this.remember(); s.color = hex; }
    if (this.editing) { this.editing.color = hex; this.ui.text.style.color = hex; }
    this.renderUi();
    this.draw();
  }

  private removeSelected(): void {
    const s = this.sel();
    if (!s) return;
    this.remember();
    this.shapes = this.shapes.filter((x) => x !== s);
    this.changed();
  }

  private nudge(key: string, d: number): void {
    const s = this.sel();
    if (!s) return;
    this.remember();
    if (key === 'ArrowLeft') s.x -= d; else if (key === 'ArrowRight') s.x += d;
    else if (key === 'ArrowUp') s.y -= d; else if (key === 'ArrowDown') s.y += d;
    this.changed();
  }

  /** Escape hebt zuerst die Auswahl auf. Ohne Zeichnung schließt es sofort, mit Zeichnung erst beim zweiten Mal. */
  private escape(): void {
    if (this.selected != null) { this.selected = null; this.changed(); return; }
    if (!this.shapes.length || Date.now() < this.escUntil) { this.close(); return; }
    this.escUntil = Date.now() + 3000;
    toast('Press Escape again to discard the drawing.', 'info');
  }

  // ---- Geometrie ------------------------------------------------------------------------------------------------

  private makeShape(tool: DrawTool, color: string, raw: Pt[], id = 0): Shape {
    const xs = raw.map((p) => p[0]), ys = raw.map((p) => p[1]);
    const x = (Math.min(...xs) + Math.max(...xs)) / 2, y = (Math.min(...ys) + Math.max(...ys)) / 2;
    return { id, tool, color, pts: raw.map((p): Pt => [p[0] - x, p[1] - y]), x, y, rot: 0, sx: 1, sy: 1 };
  }

  /** Kasten der Form im eigenen, unskalierten System: [x0, y0, x1, y1]. */
  private bounds(s: Shape): [number, number, number, number] {
    if (s.box) return [-s.box[0] / 2, -s.box[1] / 2, s.box[0] / 2, s.box[1] / 2];
    const xs = s.pts.map((p) => p[0]), ys = s.pts.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
  }

  private world(s: Shape, p: Pt): Pt {
    const [u, v] = turn(s.rot, p[0] * s.sx, p[1] * s.sy);
    return [s.x + u, s.y + v];
  }

  /** Punkte auf der Zeichenfläche: die Linie (Stift, Linie, Pfeil) bzw. der geschlossene Umriss (Rechteck, Ellipse). */
  private outline(s: Shape): Pt[] {
    if (s.tool === 'pen' || s.tool === 'line' || s.tool === 'arrow') return s.pts.map((p) => this.world(s, p));
    const [x0, y0, x1, y1] = this.bounds(s);
    if (s.tool === 'rect') return ([[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]] as Pt[]).map((p) => this.world(s, p));
    // Die Ellipse als Vieleck: So bleibt die Strichstärke beim Skalieren gleich
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = (x1 - x0) / 2, ry = (y1 - y0) / 2;
    return Array.from({ length: 73 }, (_, i) => this.world(s, [cx + rx * Math.cos((i / 72) * 2 * Math.PI), cy + ry * Math.sin((i / 72) * 2 * Math.PI)]));
  }

  /** Auswahlrahmen: Ecken (oben links im Uhrzeigersinn), Drehgriff und der Rahmen im gedrehten System der Form. */
  private frame(s: Shape) {
    const [x0, y0, x1, y1] = this.bounds(s);
    const a = x0 * s.sx - SEL_PAD, b = x1 * s.sx + SEL_PAD, c = y0 * s.sy - SEL_PAD, d = y1 * s.sy + SEL_PAD;
    const at = (u: number, v: number): Pt => { const [x, y] = turn(s.rot, u, v); return [s.x + x, s.y + y]; };
    return { corners: [at(a, c), at(b, c), at(b, d), at(a, d)], top: at((a + b) / 2, c), rotate: at((a + b) / 2, c - ROT_GAP), rect: [a, c, b, d] as const };
  }

  private hits(s: Shape, p: Pt): boolean {
    if (s.tool === 'text') {
      const [x0, y0, x1, y1] = this.bounds(s);
      const [u, v] = turn(-s.rot, p[0] - s.x, p[1] - s.y);
      return u / s.sx >= x0 && u / s.sx <= x1 && v / s.sy >= y0 && v / s.sy <= y1;
    }
    // Rechteck und Ellipse sind hohl: Getroffen wird die Linie, damit Formen darunter erreichbar bleiben
    const o = this.outline(s), tol = TOL / this.k;
    if (o.length === 1) return dist(p, o[0]) <= tol;
    for (let i = 1; i < o.length; i++) if (segDist(p, o[i - 1], o[i]) <= tol) return true;
    return false;
  }

  /** Oberste Form an dieser Stelle. */
  private hit(p: Pt): Shape | undefined {
    for (let i = this.shapes.length - 1; i >= 0; i--) if (this.hits(this.shapes[i], p)) return this.shapes[i];
    return undefined;
  }

  private handleAt(s: Shape, p: Pt): Handle | null {
    const f = this.frame(s);
    // Fangradien gelten auf dem Bildschirm, beim Zoomen bleiben die Griffe so gleich gut zu treffen
    const grab = GRAB / this.k;
    if (dist(p, f.rotate) <= grab) return { kind: 'rotate' };
    const i = f.corners.findIndex((q) => dist(p, q) <= grab);
    if (i >= 0) return { kind: 'scale', corner: i };
    const [u, v] = turn(-s.rot, p[0] - s.x, p[1] - s.y);
    const [a, c, b, d] = f.rect;
    return u >= a && u <= b && v >= c && v <= d ? { kind: 'move' } : null;
  }

  /** Skalieren an einer Ecke: Die gegenüberliegende Ecke bleibt stehen. Text und Umschalt behalten das Seitenverhältnis. */
  private scaleTo(s: Shape, o: Shape, corner: number, p: Pt, keep: boolean): void {
    const [x0, y0, x1, y1] = this.bounds(o);
    const w = x1 - x0, h = y1 - y0;
    const anchor = this.frame(o).corners[(corner + 2) % 4];
    const dx = corner === 1 || corner === 2 ? 1 : -1, dy = corner >= 2 ? 1 : -1;
    const [u, v] = turn(-o.rot, p[0] - anchor[0], p[1] - anchor[1]);
    // Ohne Ausdehnung in einer Richtung (etwa eine waagerechte Linie) wird in dieser Richtung nicht skaliert
    let sx = w > 1 ? Math.max(0.05, (dx * u - 2 * SEL_PAD) / w) : o.sx;
    let sy = h > 1 ? Math.max(0.05, (dy * v - 2 * SEL_PAD) / h) : o.sy;
    if (keep || o.tool === 'text') {
      const f = Math.max(w > 1 ? sx / o.sx : 0, h > 1 ? sy / o.sy : 0) || 1;
      sx = o.sx * f;
      sy = o.sy * f;
    }
    const [ax, ay] = turn(o.rot, dx > 0 ? x0 * sx - SEL_PAD : x1 * sx + SEL_PAD, dy > 0 ? y0 * sy - SEL_PAD : y1 * sy + SEL_PAD);
    s.sx = sx; s.sy = sy;
    s.x = anchor[0] - ax; s.y = anchor[1] - ay;
  }

  // ---- Eingabe --------------------------------------------------------------------------------------------------

  private at(e: PointerEvent): Pt {
    const r = this.ui.canvas.getBoundingClientRect();
    const x = ((e.clientX - r.left) / (r.width || 1)) * this.size[0], y = ((e.clientY - r.top) / (r.height || 1)) * this.size[1];
    return [Math.max(0, Math.min(this.size[0], x)), Math.max(0, Math.min(this.size[1], y))];
  }

  private installPointer(): void {
    const c = this.ui.canvas, layer = this.ui.layer;
    const onUi = (e: Event) => !!(e.target as HTMLElement).closest('.float, .mk-actions, .mk-text');
    // Mausrad zoomt, mittlere oder rechte Taste verschiebt. Auf der Ebene, damit es auch neben der Zeichenfläche geht.
    layer.addEventListener('wheel', (e) => {
      if (onUi(e)) return;
      e.preventDefault();
      const r = layer.getBoundingClientRect();
      this.zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    layer.addEventListener('pointerdown', (e) => {
      if ((e.button !== 1 && e.button !== 2) || onUi(e)) return;
      e.preventDefault();
      this.panning = { id: e.pointerId, x: e.clientX, y: e.clientY, pan: [...this.pan] };
      try { layer.setPointerCapture(e.pointerId); } catch { /* synthetische Ereignisse (Tests) haben keinen aktiven Zeiger */ }
      layer.style.cursor = 'grabbing';
    });
    layer.addEventListener('pointermove', (e) => {
      const p = this.panning;
      if (!p || p.id !== e.pointerId) return;
      this.pan = [p.pan[0] + e.clientX - p.x, p.pan[1] + e.clientY - p.y];
      this.layout();
    });
    const endPan = (e: PointerEvent) => { if (this.panning?.id === e.pointerId) { this.panning = null; layer.style.cursor = ''; } };
    layer.addEventListener('pointerup', endPan);
    layer.addEventListener('pointercancel', endPan);
    layer.addEventListener('contextmenu', (e) => { if (!onUi(e)) e.preventDefault(); });
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.panning) return;
      e.preventDefault(); // kein Fokuswechsel, sonst schlösse sich ein gerade geöffnetes Textfeld sofort wieder
      this.commitText();
      const p = this.at(e);
      if (this.tool === 'select') this.pressSelect(p);
      else if (this.tool === 'text') {
        const t = this.hit(p);
        if (t?.tool === 'text') this.editText(t); else this.openText(p);
        return;
      } else this.drag = { kind: 'draw', tool: this.tool, color: this.color, raw: [this.tool === 'pen' ? p : this.snap(p, e.altKey)] };
      if (this.drag) try { c.setPointerCapture(e.pointerId); } catch { /* synthetische Ereignisse (Tests) haben keinen aktiven Zeiger */ }
      this.draw();
    });
    c.addEventListener('pointermove', (e) => {
      if (this.panning) return;
      const p = this.at(e);
      if (!this.drag) { if (this.tool === 'select') c.style.cursor = this.cursorAt(p); return; }
      this.dragTo(p, e.shiftKey, e.altKey);
      this.draw();
    });
    c.addEventListener('pointerup', (e) => {
      const d = this.drag;
      if (!d) return;
      this.dragTo(this.at(e), e.shiftKey, e.altKey);
      this.drag = null;
      if (d.kind === 'draw') {
        const [a, b = a] = d.raw;
        // Ein bloßer Klick ergibt mit dem Stift einen Punkt, bei den Formen nichts
        if (d.tool === 'pen' || dist(a, b) >= 4) { this.remember(); this.shapes.push(this.makeShape(d.tool, d.color, d.raw, this.nextId++)); }
      } else if (d.moved) this.remember(d.before);
      this.renderUi();
      this.draw();
    });
    c.addEventListener('pointercancel', () => {
      const d = this.drag;
      this.drag = null;
      if (d && d.kind !== 'draw' && d.moved) this.shapes = d.before; // abgebrochen: zurück zum Stand davor
      this.changed();
    });
  }

  /** Klick mit „Auswählen“: Griff der gewählten Form, sonst die oberste Form an der Stelle, sonst Auswahl aufheben. */
  private pressSelect(p: Pt): void {
    const cur = this.sel();
    let target = cur;
    let h = cur ? this.handleAt(cur, p) : null;
    if (!h) { target = this.hit(p); h = target ? { kind: 'move' } : null; }
    if (!target || !h) { this.selected = null; this.lastPress = null; this.renderUi(); return; }
    const now = Date.now();
    if (h.kind === 'move' && target.tool === 'text' && this.lastPress?.id === target.id && now - this.lastPress.t < 450) {
      this.lastPress = null; // Doppelklick auf einen Text: bearbeiten
      this.editText(target);
      return;
    }
    this.lastPress = { id: target.id, t: now };
    this.selected = target.id;
    this.drag = { kind: h.kind, corner: h.kind === 'scale' ? h.corner : 0, id: target.id, start: p, orig: clone(target), before: clone(this.shapes), moved: false };
    this.renderUi();
  }

  /**
   * Ziehen. Linie und Pfeil mit Umschalt: Winkel in 15-Grad-Schritten (waagerecht, senkrecht, 45° …). Rechteck und
   * Ellipse mit Umschalt: Quadrat bzw. Kreis. Bei eingeschaltetem Raster rasten die Endpunkte ein, Alt hebt das auf.
   */
  private dragTo(p: Pt, shift: boolean, alt = false): void {
    const d = this.drag!;
    if (d.kind === 'draw') {
      if (d.tool === 'pen') { if (dist(p, d.raw[d.raw.length - 1]) >= 1.5) d.raw.push(p); }
      else if (shift && (d.tool === 'line' || d.tool === 'arrow')) d.raw[1] = angled(d.raw[0], p);
      else if (shift) d.raw[1] = square(d.raw[0], this.snap(p, alt));
      else d.raw[1] = this.snap(p, alt);
      return;
    }
    const s = this.shapes.find((x) => x.id === d.id);
    if (!s || (!d.moved && dist(p, d.start) < 1)) return;
    d.moved = true;
    const o = d.orig;
    if (d.kind === 'move') { s.x = o.x + p[0] - d.start[0]; s.y = o.y + p[1] - d.start[1]; }
    else if (d.kind === 'rotate') {
      let r = o.rot + Math.atan2(p[1] - o.y, p[0] - o.x) - Math.atan2(d.start[1] - o.y, d.start[0] - o.x);
      if (shift) r = Math.round(r / (Math.PI / 12)) * (Math.PI / 12); // Umschalt: in 15-Grad-Schritten
      s.rot = r;
    } else this.scaleTo(s, o, d.corner, p, shift);
  }

  /** Nächste Rasterkreuzung, solange das Raster an ist und Alt nicht gedrückt. Bleibt auf der Zeichenfläche. */
  private snap(p: Pt, alt: boolean): Pt {
    if (!this.grid || alt) return p;
    const r = (v: number, max: number) => Math.max(0, Math.min(max, Math.round(v / GRID) * GRID));
    return [r(p[0], this.size[0]), r(p[1], this.size[1])];
  }

  private cursorAt(p: Pt): string {
    const s = this.sel();
    const h = s ? this.handleAt(s, p) : null;
    if (h?.kind === 'rotate') return 'grab';
    if (h?.kind === 'scale') {
      const q = this.frame(s!).corners[h.corner];
      const deg = ((Math.atan2(q[1] - s!.y, q[0] - s!.x) * 180) / Math.PI + 180) % 180;
      return ['ew-resize', 'nwse-resize', 'ns-resize', 'nesw-resize'][Math.round(deg / 45) % 4];
    }
    return h || this.hit(p) ? 'move' : 'default';
  }

  // ---- Text -----------------------------------------------------------------------------------------------------

  private font(): string { return `600 ${FONT}px ${css('--sans') || 'sans-serif'}`; }

  private textBox(text: string): Pt {
    const g = this.ui.canvas.getContext('2d');
    if (!g) return [text.length * FONT * 0.6 + 2 * TEXT_PAD[0], FONT + 2 * TEXT_PAD[1]];
    g.save();
    g.font = this.font();
    const w = g.measureText(text).width;
    g.restore();
    return [w + 2 * TEXT_PAD[0], FONT + 2 * TEXT_PAD[1]];
  }

  private openText(p: Pt): void {
    this.editing = { id: null, p, color: this.color };
    this.showInput('', p, '', FONT);
  }

  /** Vorhandenen Text bearbeiten. Das Feld steht ungedreht über dem Mittelpunkt, die Form tritt solange zurück. */
  private editText(s: Shape): void {
    this.editing = { id: s.id, p: [s.x, s.y], color: s.color };
    this.showInput(s.text ?? '', [s.x, s.y], 'translate(-50%, -50%)', FONT * s.sx);
    this.draw();
  }

  private showInput(value: string, p: Pt, transform: string, size: number): void {
    const t = this.ui.text;
    t.value = value;
    Object.assign(t.style, { fontSize: `${size}px`, color: this.editing!.color });
    this.input = { p, transform };
    this.placeInput();
    t.hidden = false;
    // Erst nach dem Mausklick fokussieren, der sonst den Fokus wieder mitnimmt. Schreibmarke ans Ende.
    setTimeout(() => { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }, 0);
  }

  /** Textfeld über die Stelle der Zeichenfläche legen, in derselben Vergrößerung wie die Fläche. */
  private placeInput(): void {
    const i = this.input;
    if (!i) return;
    Object.assign(this.ui.text.style, {
      left: `${this.off[0] + i.p[0] * this.k}px`, top: `${this.off[1] + i.p[1] * this.k}px`, transformOrigin: '0 0', transform: `scale(${this.k}) ${i.transform}`,
    });
  }

  private commitText(): void {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;
    this.input = null;
    const text = this.ui.text.value.trim();
    this.ui.text.hidden = true;
    if (ed.id != null) {
      const s = this.shapes.find((x) => x.id === ed.id);
      if (s && (text !== s.text || ed.color !== s.color)) {
        this.remember();
        // Leer übernommen heißt gelöscht
        if (!text) this.shapes = this.shapes.filter((x) => x !== s);
        else { s.text = text; s.color = ed.color; s.box = this.textBox(text); }
      }
    } else if (text) {
      this.remember();
      const box = this.textBox(text);
      this.shapes.push({ id: this.nextId++, tool: 'text', color: ed.color, pts: [], text, box, x: ed.p[0] + box[0] / 2, y: ed.p[1] + box[1] / 2, rot: 0, sx: 1, sy: 1 });
    }
    this.changed();
  }

  private cancelText(): void {
    this.editing = null;
    this.input = null;
    this.ui.text.hidden = true;
    this.draw();
  }

  // ---- Zeichnen -------------------------------------------------------------------------------------------------

  private draw(withSelection = true): void {
    const c = this.ui.canvas;
    const g = c.getContext('2d');
    if (!g || !c.width) return;
    g.setTransform(1, 0, 0, 1, 0, 0);
    if (this.bg && !this.blankBg) g.drawImage(this.bg, 0, 0);
    else { g.fillStyle = css('--s2') || '#1b1e23'; g.fillRect(0, 0, c.width, c.height); }
    g.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    if (this.grid) this.paintGrid(g);
    for (const s of this.shapes) if (s.id !== this.editing?.id) this.paint(g, s);
    const d = this.drag;
    if (d?.kind === 'draw') this.paint(g, this.makeShape(d.tool, d.color, d.raw));
    const s = withSelection && this.tool === 'select' ? this.sel() : undefined;
    if (s && s.id !== this.editing?.id) this.paintSelection(g, s);
  }

  private paint(g: CanvasRenderingContext2D, s: Shape): void {
    g.save();
    g.strokeStyle = g.fillStyle = s.color;
    g.lineWidth = LINE;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    // Dunkler Schatten, damit Striche und Text auch auf hellen Bauteilen lesbar bleiben. Er skaliert nicht mit, daher mal scale.
    g.shadowColor = 'rgba(0,0,0,.55)';
    g.shadowBlur = 3 * this.scale;
    if (s.tool === 'text' && s.text && s.box) {
      g.translate(s.x, s.y);
      g.rotate(s.rot);
      g.scale(s.sx, s.sy);
      g.font = this.font();
      // Grundlinie wie im Textfeld (line-height 1): Die Schriftbox steht mittig in der Zeile, darin liegt die Grundlinie
      const m = g.measureText(s.text);
      const asc = m.fontBoundingBoxAscent, desc = m.fontBoundingBoxDescent;
      g.fillText(s.text, -s.box[0] / 2 + TEXT_PAD[0], -s.box[1] / 2 + TEXT_PAD[1] + (FONT - asc - desc) / 2 + asc);
      g.restore();
      return;
    }
    const p = this.outline(s);
    const [a, b = a] = p;
    g.beginPath();
    g.moveTo(a[0], a[1]);
    if (s.tool === 'pen') {
      if (p.length === 1) g.lineTo(a[0] + 0.01, a[1]);
      // Durch die Mittelpunkte geglättet, sonst wirkt Freihand eckig
      for (let i = 1; i < p.length - 1; i++) g.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
      if (p.length > 1) g.lineTo(p[p.length - 1][0], p[p.length - 1][1]);
    } else if (s.tool === 'line') {
      g.lineTo(b[0], b[1]);
    } else if (s.tool === 'arrow') {
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
      const head = Math.min(16, dist(a, b) * 0.4);
      g.lineTo(b[0], b[1]);
      for (const k of [-0.5, 0.5]) { g.moveTo(b[0], b[1]); g.lineTo(b[0] - head * Math.cos(ang + k), b[1] - head * Math.sin(ang + k)); }
    } else {
      for (const q of p.slice(1)) g.lineTo(q[0], q[1]);
      g.closePath();
    }
    g.stroke();
    g.restore();
  }

  /**
   * Raster wie Karopapier. Es kommt mit ins Bild: Der Agent sieht dann dieselben Kästchen wie der Nutzer und kann
   * Größenverhältnisse daran abzählen. Halbtransparent, damit es auf dunklem und hellem Grund zu sehen ist, ohne das Modell zu verdecken.
   */
  private paintGrid(g: CanvasRenderingContext2D): void {
    const [w, h] = this.size;
    g.save();
    // Auf halbe Gerätepixel gelegt, damit dünne Linien scharf bleiben
    const crisp = (v: number) => (Math.round(v * this.scale) + 0.5) / this.scale;
    for (const major of [false, true]) {
      g.beginPath();
      for (let i = 0; i * GRID <= w; i++) if ((i % GRID_MAJOR === 0) === major) { const x = crisp(i * GRID); g.moveTo(x, 0); g.lineTo(x, h); }
      for (let i = 0; i * GRID <= h; i++) if ((i % GRID_MAJOR === 0) === major) { const y = crisp(i * GRID); g.moveTo(0, y); g.lineTo(w, y); }
      g.strokeStyle = major ? 'rgba(150,158,170,.42)' : 'rgba(150,158,170,.2)';
      g.lineWidth = 1 / this.scale;
      g.stroke();
    }
    g.restore();
  }

  /** Rahmen, Eckgriffe (skalieren) und Drehgriff. Kommt nie ins Bild für den Agenten. */
  private paintSelection(g: CanvasRenderingContext2D, s: Shape): void {
    const f = this.frame(s);
    g.save();
    g.strokeStyle = css('--acc') || '#f29a38';
    g.fillStyle = css('--tx') || '#e6e8eb';
    g.lineWidth = 1;
    g.setLineDash([4, 3]);
    g.beginPath();
    f.corners.forEach((q, i) => (i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1])));
    g.closePath();
    g.moveTo(f.top[0], f.top[1]);
    g.lineTo(f.rotate[0], f.rotate[1]);
    g.stroke();
    g.setLineDash([]);
    g.lineWidth = 1.5;
    for (const q of f.corners) { g.fillRect(q[0] - 4, q[1] - 4, 8, 8); g.strokeRect(q[0] - 4, q[1] - 4, 8, 8); }
    g.beginPath();
    g.arc(f.rotate[0], f.rotate[1], 5, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.restore();
  }

  private renderUi(): void {
    const u = this.ui;
    u.tools.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === this.tool)));
    u.palette.querySelectorAll<HTMLButtonElement>('[data-color]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.color === this.colorName)));
    u.colorSwatch.style.setProperty('--c', this.color);
    if (/^#[0-9a-f]{6}$/i.test(this.color)) u.custom.value = this.color;
    u.undo.disabled = !this.history.length && !this.editing;
    u.del.disabled = this.selected == null;
    u.blank.setAttribute('aria-pressed', String(this.blankBg));
    u.grid.setAttribute('aria-pressed', String(this.grid));
    u.canvas.style.cursor = this.tool === 'select' ? 'default' : this.tool === 'text' ? 'text' : 'crosshair';
    const what = this.blankBg ? 'Blank canvas. The image is saved in '
      : this.sourceFile ? `Image ${this.sourceFile}. The markup is saved as a new file in ` : `Viewer image from ${fmtWhen(this.takenAt)}. It is saved in `;
    u.hint.replaceChildren(what,
      el('code', { textContent: '.soma/feedback/' }), ', and its path goes into the agent’s input. Scroll to zoom, drag with the right mouse button to pan, Ctrl 0 fits.');
  }

  // ---- Prüfhilfen (nur für Tests) -------------------------------------------------------------------------------

  state() {
    const r = (v: number, n = 2) => +v.toFixed(n);
    return {
      active: this.active, source: this.source, zoom: +this.zoom.toFixed(3), view: [+this.k.toFixed(3), +this.off[0].toFixed(1), +this.off[1].toFixed(1)], tool: this.tool, color: this.color, blank: this.blankBg, grid: this.grid, size: this.size, pixels: [this.ui.canvas.width, this.ui.canvas.height],
      shapes: this.shapes.map((s) => s.tool),
      items: this.shapes.map((s) => ({ tool: s.tool, color: s.color, text: s.text ?? null, x: r(s.x), y: r(s.y), rot: r(s.rot, 4), sx: r(s.sx, 3), sy: r(s.sy, 3) })),
      selected: this.shapes.findIndex((s) => s.id === this.selected), editing: !!this.editing, undo: this.history.length, redo: this.future.length,
    };
  }

  /** Neu einpassen wie nach einer Größenänderung. Unsichtbare Testfenster zeichnen nicht, dort meldet sich der ResizeObserver nicht. */
  relayout(): void { if (this.active) this.layout(); }

  /** Griffe der ausgewählten Form in CSS-Pixeln der Zeichenfläche. */
  handles() {
    const s = this.sel();
    if (!s) return null;
    const f = this.frame(s);
    return { corners: f.corners, rotate: f.rotate, center: [s.x, s.y] };
  }

  /** RGBA eines Bildpunkts, Koordinaten in CSS-Pixeln der Zeichenfläche. */
  pixel(x: number, y: number): number[] {
    const g = this.ui.canvas.getContext('2d');
    return g ? [...g.getImageData(Math.round(x * this.scale), Math.round(y * this.scale), 1, 1).data] : [];
  }
}

/** Mit Umschalt: Quadrat bzw. Kreis. */
function square(a: Pt, p: Pt): Pt {
  const d = Math.max(Math.abs(p[0] - a[0]), Math.abs(p[1] - a[1]));
  return [a[0] + Math.sign(p[0] - a[0] || 1) * d, a[1] + Math.sign(p[1] - a[1] || 1) * d];
}

/** Mit Umschalt bei Linie und Pfeil: Richtung auf 15-Grad-Schritte gerundet, Länge bleibt. */
function angled(a: Pt, p: Pt): Pt {
  const step = Math.PI / 12;
  const ang = Math.round(Math.atan2(p[1] - a[1], p[0] - a[0]) / step) * step, len = dist(a, p);
  return [a[0] + len * Math.cos(ang), a[1] + len * Math.sin(ang)];
}

/** Abstand eines Punkts von einer Strecke. */
function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}
