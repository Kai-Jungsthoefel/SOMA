import type { DxfBatch, DxfDrawing, DxfResult } from '../shared/types';
import { icon } from './icons';
import { el, menus } from './ui';

/** Was die DXF-Ansicht vom Rest der App braucht. */
export interface DxfDeps {
  /** Geometrie über `soma dxfview` (E80). `known`: Fingerabdruck des gezeigten Stands. Ist die Datei gleich, kommt nichts. */
  dxf(rel: string, known: string | null): Promise<DxfResult>;
  /** Die Ansicht als Bild auf der Zeichenfläche der Markierung öffnen. `label` nennt Datei und Ausschnitt für den Agenten. */
  markDxf(label: string, canvas: HTMLCanvasElement): void;
}

/** Hintergrund wie BACKGROUND in soma/dxfview.py: Danach richtet ezdxf Farbe 7 aus (hell auf dunkel). */
const BG = '#121417';
/** Rand beim Einpassen in CSS-Pixeln. */
const PAD = 16;
/** Zoom über das Einpassen hinaus. Weiter hilft nicht: Die Koordinaten sind auf rund sieben Stellen gerundet. */
const MAX_ZOOM = 20000, MIN_ZOOM = 0.05;
const STEP = 1.25;
/** Auflösung von „Mark up view“ gegenüber dem Bildschirm, damit Maßzahlen lesbar bleiben. */
const MARK_SCALE = 2;
/**
 * Strichstärke auf dem Bildschirm in CSS-Pixeln, unabhängig vom Zoom, wie die Anzeige der Linienstärken in CAD-Programmen.
 * Auf Papier skaliert (wie in der PDF) würden Linien beim Hineinzoomen breiter als die Details, die man sehen will.
 */
const lineWidth = (mm: number) => Math.min(6, Math.max(1, mm * 3.2));

interface Item { b: DxfBatch; layer: string; path: Path2D | null }

/**
 * DXF-Ansicht im Code-Panel (E80), neben der PDF-Ansicht (E54). Gezeichnet hat soma mit ezdxf, hier kommen nur Pfade an:
 * je Stapel ein Path2D, gezeichnet in Koordinaten der Zeichnung, damit Zoomen und Verschieben nur die Transformation
 * ändern. Die Datei ist nicht vertrauenswürdig, an die Oberfläche gehen Namen nur als Text.
 */
export class DxfView {
  readonly root: HTMLElement;
  private canvas: HTMLCanvasElement;
  private msg: HTMLElement;
  private note: HTMLElement;
  private menu: HTMLElement;
  private bar: { layers: HTMLButtonElement; size: HTMLElement; pos: HTMLElement; zoom: HTMLElement; mark: HTMLButtonElement; fit: HTMLButtonElement };
  private drawing: DxfDrawing | null = null;
  private items: Item[] = [];
  /** Ausgeblendete Layer (klein geschrieben). Bleibt beim Neuladen. Neue Layer, die in der Datei aus sind, kommen dazu. */
  private hiddenLayers = new Set<string>();
  private seenLayers = new Set<string>();
  /** CSS-Pixel je Zeichnungseinheit und Mitte der Ansicht (relativ zu `origin`). */
  private scale = 1;
  private cx = 0;
  private cy = 0;
  /** Eingepasst: Die Ansicht folgt der Größe des Panels und neuen Fassungen der Datei, bis der Nutzer zoomt oder verschiebt. */
  private fitted = true;
  private sig: string | null = null;
  private loadId = 0;
  private inflight: Promise<'ok' | 'gone'> | null = null;
  private again = false;
  private resize: ResizeObserver;
  private raf = 0;
  private drag: { x: number; y: number; cx: number; cy: number; id: number } | null = null;
  private mouse: { x: number; y: number } | null = null;
  error: string | null = null;
  loading = false;

  constructor(readonly file: string, private deps: DxfDeps) {
    const btn = (ico: string, title: string, onClick: () => void, label = '') => {
      const b = el('button', { className: 'btn sm ghost', title }, icon(ico, 14, 1.9), label);
      b.setAttribute('aria-label', title);
      b.addEventListener('click', onClick);
      return b;
    };
    this.bar = {
      layers: btn('layers', 'Show and hide layers', () => this.toggleMenu(), 'Layers'),
      size: el('span', { className: 'dxf-size c3' }),
      pos: el('span', { className: 'dxf-pos c3' }),
      zoom: el('span', { className: 'pdf-zoom c3' }),
      mark: btn('camera', 'Mark up this view as an image for the agent', () => this.markView(), 'Mark up view'),
      fit: btn('fit', 'Fit the drawing (double-click)', () => this.fit()),
    };
    this.bar.layers.setAttribute('aria-haspopup', 'menu');
    const minus = btn('minus', 'Zoom out', () => this.step(-1));
    const plus = btn('plus', 'Zoom in', () => this.step(1));
    this.canvas = el('canvas', { className: 'dxf-canvas', tabIndex: 0 });
    this.canvas.setAttribute('aria-label', `Drawing ${file}`);
    this.msg = el('div', { className: 'dxf-msg' });
    this.note = el('div', { className: 'dxf-note c3' });
    this.note.hidden = true;
    this.menu = el('div', { className: 'menu dxf-layers' });
    this.menu.setAttribute('role', 'menu');
    this.menu.hidden = true;
    this.root = el('div', { className: 'dxfview' },
      el('div', { className: 'pdf-bar' }, this.bar.layers, this.bar.size, el('span', { className: 'grow' }), this.bar.pos,
        minus, this.bar.zoom, plus, this.bar.fit, el('span', { className: 'pdf-sep' }), this.bar.mark),
      this.note, el('div', { className: 'dxf-stage' }, this.canvas, this.msg));
    this.resize = new ResizeObserver(() => this.relayout());
    this.resize.observe(this.canvas);
    this.wire();
    this.showMessage('Reading the DXF…');
    this.updateBar();
  }

  // ---- Laden ------------------------------------------------------------------------------------------------------

  /**
   * Lädt die Datei (neu), wenn sie sich geändert hat. Laufende Ladevorgänge werden nicht verdoppelt: Kommt ein Aufruf
   * dazu, wird danach genau einmal nachgeladen. 'gone': Die Datei gibt es nicht mehr, der Reiter soll zu.
   */
  load(): Promise<'ok' | 'gone'> {
    if (this.inflight) { this.again = true; return this.inflight; }
    this.inflight = (async () => {
      let r: 'ok' | 'gone';
      do { this.again = false; r = await this.loadOnce(); } while (this.again && r === 'ok');
      return r;
    })().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async loadOnce(): Promise<'ok' | 'gone'> {
    const id = this.loadId;
    this.loading = true;
    this.updateBar();
    let r: DxfResult;
    try { r = await this.deps.dxf(this.file, this.sig); } catch (e) { r = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    if (id !== this.loadId) return 'ok'; // inzwischen geschlossen
    this.loading = false;
    if (r.gone) { this.updateBar(); return 'gone'; }
    if (r.unchanged) { this.updateBar(); return 'ok'; }
    this.sig = r.sig ?? null;
    if (!r.ok || !r.drawing) this.setError(r.error ?? 'The DXF cannot be shown.');
    else this.setDrawing(r.drawing);
    return 'ok';
  }

  private setDrawing(d: DxfDrawing): void {
    const prev = this.drawing;
    // Lage der Ansicht in Koordinaten der Datei merken: Die Mitte der neuen Fassung kann woanders liegen
    const keep = prev && !this.fitted ? [this.cx + prev.origin[0], this.cy + prev.origin[1]] : null;
    this.drawing = d;
    this.error = null;
    this.items = d.batches.map((b) => ({ b, layer: d.layers[b.layer]?.name.toLowerCase() ?? '', path: b.kind === 'point' ? null : toPath(b) }));
    for (const l of d.layers) {
      const k = l.name.toLowerCase();
      if (this.seenLayers.has(k)) continue;
      this.seenLayers.add(k);
      if (l.off) this.hiddenLayers.add(k);
    }
    if (keep) { this.cx = keep[0] - d.origin[0]; this.cy = keep[1] - d.origin[1]; }
    else this.fit(false);
    this.msg.hidden = !!d.box;
    if (!d.box) this.msg.textContent = 'The DXF contains nothing to draw.';
    this.renderNote();
    if (menus.isOpen(this.menu)) this.renderMenu();
    this.updateBar();
    this.draw();
  }

  private setError(text: string): void {
    this.error = text;
    this.drawing = null;
    this.items = [];
    this.renderNote();
    if (menus.isOpen(this.menu)) menus.close();
    this.showMessage(text);
    this.updateBar();
    this.draw();
  }

  private showMessage(text: string): void {
    this.msg.textContent = text;
    this.msg.hidden = false;
  }

  private renderNote(): void {
    const d = this.drawing;
    const parts: string[] = [];
    if (d?.layout) parts.push(`Shows the layout “${d.layout}”, the model space is empty.`);
    const skipped = Object.entries(d?.skipped ?? {});
    if (skipped.length) parts.push(`Not shown: ${skipped.map(([t, n]) => `${n} × ${t}`).join(', ')}.`);
    if (d?.truncated) parts.push('Very large drawing: only part of it is shown.');
    if (d?.issues) parts.push(`The file has ${d.issues} problem(s) and is shown as far as possible (the file is not changed).`);
    this.note.textContent = parts.join(' ');
    this.note.hidden = !parts.length;
  }

  dispose(): void {
    this.loadId++;
    this.resize.disconnect();
    cancelAnimationFrame(this.raf);
    if (menus.isOpen(this.menu)) menus.close();
    this.menu.remove();
    this.items = [];
    this.drawing = null;
  }

  /** Beim Wechsel des Reiters: Das Layer-Menü gehört zur sichtbaren Ansicht. */
  hidden(): void { if (menus.isOpen(this.menu)) menus.close(); }

  /** Reiter wieder sichtbar: Beim Laden versteckt (Breite 0) oder das Panel hat sich verändert. Gleich neu zeichnen. */
  shown(): void { this.relayout(); }

  // ---- Ansicht ----------------------------------------------------------------------------------------------------

  private size(): [number, number] { return [this.canvas.clientWidth, this.canvas.clientHeight]; }

  private fitScale(): number {
    const box = this.drawing?.box;
    const [w, h] = this.size();
    if (!box || !w || !h) return 1;
    const bw = box[2] - box[0], bh = box[3] - box[1];
    // Nur ein Punkt oder eine Linie: nicht unendlich vergrößern
    const floor = Math.max(bw, bh) * 0.01 || 1;
    const s = Math.min((w - 2 * PAD) / Math.max(bw, floor), (h - 2 * PAD) / Math.max(bh, floor));
    return Number.isFinite(s) && s > 0 ? s : 1;
  }

  fit(draw = true): void {
    const box = this.drawing?.box;
    this.fitted = true;
    if (box) { this.scale = this.fitScale(); this.cx = (box[0] + box[2]) / 2; this.cy = (box[1] + box[3]) / 2; }
    if (draw) { this.updateBar(); this.draw(); }
  }

  private relayout(): void {
    if (this.fitted) this.fit(false);
    this.updateBar();
    this.draw();
  }

  /** Zoom um den Faktor `f` am Punkt (x, y) in CSS-Pixeln der Zeichenfläche, ohne Angabe in der Mitte. */
  zoomBy(f: number, x?: number, y?: number): void {
    if (!this.drawing?.box) return;
    const [w, h] = this.size();
    const px = x ?? w / 2, py = y ?? h / 2;
    const fs = this.fitScale();
    const next = Math.min(fs * MAX_ZOOM, Math.max(fs * MIN_ZOOM, this.scale * f));
    const [wx, wy] = this.toModel(px, py);
    this.scale = next;
    // Der Punkt unter dem Zeiger bleibt, wo er ist
    this.cx = wx - (px - w / 2) / next;
    this.cy = wy + (py - h / 2) / next;
    this.fitted = false;
  }

  private step(dir: 1 | -1): void {
    this.zoomBy(dir > 0 ? STEP : 1 / STEP);
    this.updateBar();
    this.draw();
  }

  /** CSS-Pixel der Zeichenfläche in Koordinaten relativ zu `origin`. */
  private toModel(x: number, y: number): [number, number] {
    const [w, h] = this.size();
    return [this.cx + (x - w / 2) / this.scale, this.cy - (y - h / 2) / this.scale];
  }

  /** Nächstes Bild bei Maus und Rad. Alles andere zeichnet sofort, in unsichtbaren Fenstern läuft requestAnimationFrame nicht. */
  private schedule(): void {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.updateBar(); this.draw(); });
  }

  private draw(): void {
    const c = this.canvas;
    const [w, h] = this.size();
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.round(w * dpr), H = Math.round(h * dpr);
    if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    this.paint(c.getContext('2d')!, W, H, dpr);
  }

  /** Zeichnet die aktuelle Ansicht auf `g` (W x H Bildpunkte, `px` Bildpunkte je CSS-Pixel). */
  private paint(g: CanvasRenderingContext2D, W: number, H: number, px: number): void {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = BG;
    g.fillRect(0, 0, W, H);
    if (!this.drawing) return;
    const s = this.scale * px;
    // y nach oben wie in der Zeichnung
    g.setTransform(s, 0, 0, -s, W / 2 - this.cx * s, H / 2 + this.cy * s);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const it of this.items) {
      if (this.hiddenLayers.has(it.layer)) continue;
      const b = it.b;
      if (b.kind === 'line') {
        g.strokeStyle = b.color;
        g.lineWidth = lineWidth(b.lw) * px / s;
        g.stroke(it.path!);
      } else if (b.kind === 'point') {
        g.fillStyle = b.color;
        const r = 1.5 * px / s;
        for (let i = 0; i + 1 < b.xy.length; i += 2) g.fillRect(b.xy[i] - r, b.xy[i + 1] - r, 2 * r, 2 * r);
      } else {
        g.fillStyle = b.color;
        // Text mit der Füllregel der Schrift, sonst wird das Ø zum Fleck. Flächen und Schraffuren: Löcher über gerade/ungerade
        g.fill(it.path!, b.kind === 'text' ? 'nonzero' : 'evenodd');
      }
    }
  }

  // ---- Maus und Tastatur ------------------------------------------------------------------------------------------

  private wire(): void {
    const c = this.canvas;
    const at = (e: MouseEvent) => { const r = c.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = at(e);
      // Mausrad etwa 100 je Raste: Faktor 1.16, Touchpads liefern kleine Schritte und zoomen entsprechend fein
      this.zoomBy(Math.pow(1.0015, -e.deltaY * (e.deltaMode === 1 ? 33 : 1)), p.x, p.y);
      this.schedule();
    }, { passive: false });
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 1) return;
      e.preventDefault();
      c.focus({ preventScroll: true });
      const p = at(e);
      this.drag = { ...p, cx: this.cx, cy: this.cy, id: e.pointerId };
      c.setPointerCapture(e.pointerId);
      c.classList.add('grabbing');
    });
    c.addEventListener('pointermove', (e) => {
      const p = at(e);
      this.mouse = p;
      const d = this.drag;
      if (d && d.id === e.pointerId && (p.x !== d.x || p.y !== d.y)) {
        this.cx = d.cx - (p.x - d.x) / this.scale;
        this.cy = d.cy + (p.y - d.y) / this.scale;
        this.fitted = false;
      }
      this.schedule();
    });
    const end = (e: PointerEvent) => {
      if (this.drag?.id !== e.pointerId) return;
      this.drag = null;
      c.classList.remove('grabbing');
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('pointerleave', () => { this.mouse = null; this.updateBar(); });
    c.addEventListener('dblclick', () => this.fit());
    c.addEventListener('keydown', (e) => {
      if (e.altKey) return;
      if (e.key === '+' || e.key === '=') { e.preventDefault(); this.step(1); }
      else if (e.key === '-') { e.preventDefault(); this.step(-1); }
      else if (e.key === '0' || e.key === 'Home') { e.preventDefault(); this.fit(); }
    });
  }

  // ---- Leiste und Layer -------------------------------------------------------------------------------------------

  private updateBar(): void {
    const d = this.drawing;
    const box = d?.box;
    const unit = d?.units ? ` ${d.units}` : '';
    const step = box ? Math.max(box[2] - box[0], box[3] - box[1]) / 1000 : 1;
    this.bar.size.textContent = this.loading && (d || this.error) ? 'Reading…'
      : box ? `${fmt(box[2] - box[0], step)} × ${fmt(box[3] - box[1], step)}${unit}` : '';
    this.bar.size.title = box ? 'Size of the drawing' : '';
    const fs = this.fitScale();
    this.bar.zoom.textContent = box ? `${Math.round((this.scale / fs) * 100)}%` : '';
    if (d && box && this.mouse) {
      // Auf einen Bildpunkt genau
      const [x, y] = this.toModel(this.mouse.x, this.mouse.y);
      this.bar.pos.textContent = `x ${fmt(x + d.origin[0], 1 / this.scale)}  y ${fmt(y + d.origin[1], 1 / this.scale)}${unit}`;
    } else this.bar.pos.textContent = '';
    const layers = d?.layers ?? [];
    const shown = layers.filter((l) => !this.hiddenLayers.has(l.name.toLowerCase())).length;
    this.bar.layers.lastChild!.textContent = layers.length && shown < layers.length ? `Layers ${shown}/${layers.length}` : 'Layers';
    this.bar.layers.disabled = !layers.length;
    this.bar.mark.disabled = !box;
    this.bar.fit.disabled = !box;
  }

  private toggleMenu(): void {
    if (!this.drawing) return;
    if (!this.menu.isConnected) document.body.append(this.menu);
    this.renderMenu();
    menus.toggle(this.menu, this.bar.layers, 'left');
  }

  private renderMenu(): void {
    const layers = this.drawing?.layers ?? [];
    const all = el('button', { className: 'mi keep' }, el('span', { className: 'noico' }), el('span', { textContent: 'Show all' }));
    all.addEventListener('click', () => this.setLayers(layers.map((l) => l.name), true));
    const items = layers.map((l) => {
      const on = !this.hiddenLayers.has(l.name.toLowerCase());
      const dot = el('span', { className: 'dot' });
      dot.style.background = l.color;
      const b = el('button', { className: 'mi keep', title: l.off ? `${l.name} (off in the file)` : l.name },
        el('span', { className: 'chk' }, icon('check', 15, 2.2)), dot, el('span', { className: 'dxf-lname', textContent: l.name }),
        l.off ? el('span', { className: 'sub', textContent: 'off in file' }) : null);
      b.setAttribute('role', 'menuitemcheckbox');
      b.setAttribute('aria-checked', String(on));
      b.addEventListener('click', () => this.setLayers([l.name], this.hiddenLayers.has(l.name.toLowerCase())));
      return b;
    });
    this.menu.replaceChildren(el('div', { className: 'mh', textContent: 'LAYERS' }), ...items, el('div', { className: 'msep' }), all);
  }

  /** Layer ein- oder ausblenden (Namen ohne Rücksicht auf Groß- und Kleinschreibung, wie in DXF). */
  setLayers(names: string[], on: boolean): void {
    for (const n of names) { if (on) this.hiddenLayers.delete(n.toLowerCase()); else this.hiddenLayers.add(n.toLowerCase()); }
    if (menus.isOpen(this.menu)) this.renderMenu();
    this.updateBar();
    this.draw();
  }

  // ---- Markieren --------------------------------------------------------------------------------------------------

  /** Die Ansicht in doppelter Auflösung auf die Zeichenfläche der Markierung, mit dem Ausschnitt im Namen für den Agenten. */
  markView(): void {
    const d = this.drawing;
    const [w, h] = this.size();
    if (!d?.box || !w || !h) return;
    const k = Math.max(MARK_SCALE, window.devicePixelRatio || 1);
    const c = el('canvas', { width: Math.round(w * k), height: Math.round(h * k) });
    this.paint(c.getContext('2d')!, c.width, c.height, k);
    this.deps.markDxf(this.areaLabel(), c);
  }

  /** „drawings/plate.dxf“, bei einem Ausschnitt mit dem Bereich: „drawings/plate.dxf, area x 10 to 80, y 0 to 50 mm“. */
  private areaLabel(): string {
    const d = this.drawing!, box = d.box!;
    const [w, h] = this.size();
    const [ax, ay] = this.toModel(0, h), [bx, by] = this.toModel(w, 0);
    const x0 = Math.max(ax, box[0]), x1 = Math.min(bx, box[2]), y0 = Math.max(ay, box[1]), y1 = Math.min(by, box[3]);
    if (x0 <= box[0] && x1 >= box[2] && y0 <= box[1] && y1 >= box[3]) return this.file;
    const span = Math.max(x1 - x0, y1 - y0) / 1000;
    const [ox, oy] = d.origin;
    return `${this.file}, area x ${fmt(x0 + ox, span)} to ${fmt(x1 + ox, span)}, y ${fmt(y0 + oy, span)} to ${fmt(y1 + oy, span)}${d.units ? ` ${d.units}` : ''}`;
  }

  // ---- Prüfhilfen (nur für Tests) ---------------------------------------------------------------------------------

  state() {
    const d = this.drawing;
    return {
      loading: this.loading, error: this.error, units: d?.units ?? null, entities: d?.entities ?? 0, batches: this.items.length,
      box: d?.box ? [d.box[0] + d.origin[0], d.box[1] + d.origin[1], d.box[2] + d.origin[0], d.box[3] + d.origin[1]] : null,
      layers: (d?.layers ?? []).map((l) => ({ name: l.name, on: !this.hiddenLayers.has(l.name.toLowerCase()), off: l.off })),
      zoom: Math.round((this.scale / this.fitScale()) * 100), fitted: this.fitted, center: d ? [this.cx + d.origin[0], this.cy + d.origin[1]] : null,
      note: this.note.hidden ? '' : this.note.textContent, message: this.msg.hidden ? '' : this.msg.textContent, label: d?.box ? this.areaLabel() : null,
      bar: [this.bar.layers.textContent, this.bar.size.textContent].join(' | '),
      canvas: [this.canvas.width, this.canvas.height], scale: this.scale,
    };
  }

  /** Zählt Bildpunkte der Zeichenfläche, die nicht Hintergrund sind (prüft, dass wirklich gezeichnet wurde). */
  inked(): number {
    const c = this.canvas;
    if (!c.width || !c.height) return 0;
    const px = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (Math.abs(px[i] - 0x12) + Math.abs(px[i + 1] - 0x14) + Math.abs(px[i + 2] - 0x17) > 60) n++;
    return n;
  }

  /** Zoomen wie mit dem Rad, aber sofort gezeichnet (im Test läuft requestAnimationFrame nicht). */
  testZoom(f: number): void { this.zoomBy(f); this.updateBar(); this.draw(); }
}

/** Zahl mit den Stellen, die bei der Schrittweite `step` sinnvoll sind, ohne Nullen am Ende: 115.38, 200. */
function fmt(v: number, step: number): string {
  const dec = Math.max(0, Math.min(6, -Math.floor(Math.log10(Math.abs(step) || 1))));
  const s = v.toFixed(dec);
  if (Number(s) === 0) return '0';
  return dec ? s.replace(/\.?0+$/, '') : s;
}

/** Befehle aus soma/dxfview.py: 0 M, 1 L, 2 Q, 3 C, 4 Z. Was fehlt oder kaputt ist, lässt Path2D still weg. */
function toPath(b: DxfBatch): Path2D {
  const p = new Path2D(), o = b.ops, v = b.xy;
  let j = 0;
  for (let i = 0; i < o.length; i++) {
    switch (o[i]) {
      case 0: p.moveTo(v[j], v[j + 1]); j += 2; break;
      case 1: p.lineTo(v[j], v[j + 1]); j += 2; break;
      case 2: p.quadraticCurveTo(v[j], v[j + 1], v[j + 2], v[j + 3]); j += 4; break;
      case 3: p.bezierCurveTo(v[j], v[j + 1], v[j + 2], v[j + 3], v[j + 4], v[j + 5]); j += 6; break;
      case 4: p.closePath(); break;
    }
  }
  return p;
}
