import { getDocument, GlobalWorkerOptions, PasswordException, TextLayer, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from 'pdfjs-dist';
import { icon } from './icons';
import { el } from './ui';

/** Was die PDF-Ansicht vom Rest der App braucht. */
export interface PdfDeps {
  /** Zitat an den Agenten. `pages` ist z. B. „3“ oder „3–4“. */
  quote(file: string, pages: string, text: string): void;
  /** Seite als Bild auf der Zeichenfläche der Markierung öffnen. */
  markPage(file: string, page: number, canvas: HTMLCanvasElement): void;
}

/** Längste Zitate: Mehr passt nicht sinnvoll in eine Eingabezeile des Agenten. Längeres wird gekürzt und gemeldet. */
export const MAX_QUOTE = 2000;
const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
/** Auflösung von „Seite markieren“: so scharf, dass Maßzahlen in Zeichnungen lesbar bleiben. */
const MARK_SCALE = 2.5;

let workerReady = false;
/**
 * Der Worker ist eigens als klassisches Skript gebündelt (esbuild.config.mjs): Module aus file:// lädt Chromium nicht.
 * Klappt der Worker trotzdem nicht, läuft pdf.js im Hauptthread weiter, dafür wird dasselbe Skript als <script> geladen.
 */
function ensureWorker(): Promise<void> {
  if (workerReady) return Promise.resolve();
  workerReady = true;
  try {
    GlobalWorkerOptions.workerPort = new Worker('pdf.worker.js');
    return Promise.resolve();
  } catch {
    return new Promise((resolve) => {
      const s = el('script', { src: 'pdf.worker.js' });
      s.onload = s.onerror = () => resolve();
      document.head.append(s);
    });
  }
}

interface Page { n: number; box: HTMLElement; canvas: HTMLCanvasElement | null; text: HTMLElement | null; scale: number; task: RenderTask | null; textLayer: TextLayer | null }

/**
 * PDF-Ansicht im Code-Panel (E54). Seiten werden erst gezeichnet, wenn sie in Sicht kommen, darüber liegt die Textebene
 * von pdf.js: Markierter Text geht mit Datei und Seite als Zitat an den Agenten. Gescannte Seiten ohne Text lassen sich
 * als Bild markieren. Die Datei kommt aus dem Projekt und ist nicht vertrauenswürdig: kein Skript, kein eval, keine Formulare.
 */
export class PdfView {
  readonly root: HTMLElement;
  private scroller: HTMLElement;
  private pagesEl: HTMLElement;
  private bar: { page: HTMLElement; zoom: HTMLElement; quote: HTMLButtonElement; mark: HTMLButtonElement };
  private floatBtn: HTMLButtonElement;
  private doc: PDFDocumentProxy | null = null;
  private pages: Page[] = [];
  /** null = Seitenbreite. */
  private zoom: number | null = null;
  private fitScale = 1;
  private observer: IntersectionObserver;
  private resize: ResizeObserver;
  private lastWidth = 0;
  private relayoutTimer: ReturnType<typeof setTimeout> | undefined;
  private loadId = 0;
  /** Fingerabdruck der geladenen Datei: Nur wenn er sich ändert, wird neu geladen. */
  private sig = '';
  error: string | null = null;

  constructor(readonly file: string, private deps: PdfDeps) {
    const btn = (ico: string, title: string, onClick: () => void, label = '') => {
      const b = el('button', { className: 'btn sm ghost', title }, icon(ico, 14, 1.9), label);
      b.setAttribute('aria-label', title);
      b.addEventListener('click', onClick);
      return b;
    };
    this.bar = {
      page: el('span', { className: 'pdf-page-no c3' }),
      zoom: el('span', { className: 'pdf-zoom c3' }),
      quote: btn('send', 'Markierten Text als Zitat mit Seite an den Agenten geben', () => this.sendQuote(), 'Zitat an Agent'),
      mark: btn('camera', 'Diese Seite als Bild markieren (für Zeichnungen und gescannte Seiten)', () => void this.markPage(), 'Seite markieren'),
    };
    const minus = btn('minus', 'Verkleinern', () => this.step(-1));
    const plus = btn('plus', 'Vergrößern', () => this.step(1));
    const fit = btn('fit', 'Auf Seitenbreite', () => this.setZoom(null));
    this.pagesEl = el('div', { className: 'pdf-pages' });
    this.scroller = el('div', { className: 'pdf-scroll', tabIndex: -1 }, this.pagesEl);
    this.floatBtn = el('button', { className: 'btn sm acc pdf-float', title: 'Markierten Text als Zitat an den Agenten geben' }, icon('send', 13, 2), 'Zitat an Agent');
    this.floatBtn.hidden = true;
    // Mausdruck nicht als Klick ins Dokument werten, sonst ginge die Textauswahl vor dem Klick verloren
    this.floatBtn.addEventListener('mousedown', (e) => e.preventDefault());
    this.floatBtn.addEventListener('click', () => this.sendQuote());
    this.root = el('div', { className: 'pdfview' },
      el('div', { className: 'pdf-bar' }, this.bar.page, el('span', { className: 'grow' }), minus, this.bar.zoom, plus, fit, el('span', { className: 'pdf-sep' }), this.bar.mark, this.bar.quote),
      this.scroller, this.floatBtn);
    this.observer = new IntersectionObserver((list) => {
      for (const e of list) if (e.isIntersecting) void this.renderPage(this.pages[Number((e.target as HTMLElement).dataset.page) - 1]);
    }, { root: this.scroller, rootMargin: '600px 0px' });
    this.resize = new ResizeObserver(() => {
      const w = this.scroller.clientWidth;
      if (w && Math.abs(w - this.lastWidth) > 2 && this.zoom == null) this.relayoutSoon();
    });
    this.resize.observe(this.scroller);
    this.scroller.addEventListener('scroll', () => { this.updatePageNo(); this.updateSelection(); });
    document.addEventListener('selectionchange', this.onSelection);
    this.scroller.addEventListener('keydown', (e) => {
      if (!e.ctrlKey || e.altKey) return;
      if (e.key === '+' || e.key === '=') { e.preventDefault(); this.step(1); }
      else if (e.key === '-') { e.preventDefault(); this.step(-1); }
      else if (e.key === '0') { e.preventDefault(); this.setZoom(null); }
    });
    this.scroller.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.step(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    this.updateBar();
  }

  /** Lädt die Datei (neu). Gleicher Inhalt wie zuletzt: nichts zu tun. Die Scrolllage bleibt, so gut es geht. */
  async load(data: ArrayBuffer): Promise<void> {
    const sig = signature(data);
    if (sig === this.sig) return;
    this.sig = sig;
    const id = ++this.loadId;
    const keepTop = this.scroller.scrollTop;
    await ensureWorker();
    let doc: PDFDocumentProxy;
    try {
      doc = await getDocument({
        data: new Uint8Array(data), enableXfa: false, stopAtErrors: false,
        cMapUrl: 'pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: 'pdfjs/standard_fonts/', wasmUrl: 'pdfjs/wasm/',
      }).promise;
    } catch (e) {
      if (id !== this.loadId) return;
      this.error = e instanceof PasswordException ? 'Die PDF ist mit einem Passwort geschützt. Rechtsklick im Dateibaum: „Mit Standardprogramm öffnen“.'
        : `Die PDF lässt sich nicht lesen: ${e instanceof Error ? e.message : String(e)}`;
      this.showMessage(this.error);
      return;
    }
    if (id !== this.loadId) { void doc.loadingTask.destroy(); return; }
    this.error = null;
    this.clearPages();
    void this.doc?.loadingTask.destroy();
    this.doc = doc;
    const first = await doc.getPage(1);
    const vp = first.getViewport({ scale: 1 });
    this.pageSize = [vp.width, vp.height];
    for (let n = 1; n <= doc.numPages; n++) {
      const box = el('div', { className: 'pdf-page' });
      box.dataset.page = String(n);
      box.append(el('span', { className: 'pdf-pnum', textContent: String(n) }));
      this.pagesEl.append(box);
      this.pages.push({ n, box, canvas: null, text: null, scale: 0, task: null, textLayer: null });
    }
    this.layout();
    this.scroller.scrollTop = keepTop;
    for (const p of this.pages) this.observer.observe(p.box);
    this.updateBar();
  }

  /** Größe der ersten Seite in PDF-Punkten. Alle Seiten bekommen zunächst ihr Format, bis sie gezeichnet sind. */
  private pageSize: [number, number] = [595, 842];

  dispose(): void {
    this.loadId++;
    this.observer.disconnect();
    this.resize.disconnect();
    document.removeEventListener('selectionchange', this.onSelection);
    clearTimeout(this.relayoutTimer);
    this.clearPages();
    void this.doc?.loadingTask.destroy();
    this.doc = null;
  }

  /** Beim Wechsel des Reiters: Die Auswahl und der schwebende Knopf gehören nur zur sichtbaren Ansicht. */
  hidden(): void { this.floatBtn.hidden = true; }

  /**
   * Reiter wieder sichtbar: War die Ansicht beim Laden versteckt (Breite 0) oder hat sich das Panel inzwischen verändert,
   * gleich neu einpassen. Der ResizeObserver allein reicht nicht, er meldet sich erst beim nächsten Zeichnen des Fensters.
   */
  shown(): void {
    if (this.pages.length && Math.abs(this.scroller.clientWidth - this.lastWidth) > 2) { this.layout(); this.updateBar(); }
  }

  // ---- Zitat und Seite --------------------------------------------------------------------------------------------

  /** Markierter Text in dieser Ansicht mit den Seiten, auf denen er steht. */
  selection(): { text: string; pages: string; rect: DOMRect | null } | null {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
    const range = sel.getRangeAt(0);
    if (!this.pagesEl.contains(range.commonAncestorContainer)) return null;
    const text = cleanQuote(sel.toString());
    if (!text) return null;
    const pageOf = (n: Node) => Number((n instanceof Element ? n : n.parentElement)?.closest<HTMLElement>('.pdf-page')?.dataset.page ?? 0);
    const a = pageOf(range.startContainer), b = pageOf(range.endContainer);
    const lo = Math.min(a || b, b || a), hi = Math.max(a, b);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0);
    return { text, pages: !lo ? '?' : lo === hi ? String(lo) : `${lo}–${hi}`, rect: rects.length ? rects[rects.length - 1] : null };
  }

  sendQuote(): void {
    const s = this.selection();
    if (!s) return;
    this.deps.quote(this.file, s.pages, s.text);
  }

  async markPage(n = this.currentPage()): Promise<void> {
    if (!this.doc) return;
    const page = await this.doc.getPage(n);
    const vp = page.getViewport({ scale: MARK_SCALE });
    const c = el('canvas', { width: Math.round(vp.width), height: Math.round(vp.height) });
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff'; // PDF-Seiten sind weiß, auch wenn die Datei keinen Hintergrund malt
    g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvas: c, canvasContext: g, viewport: vp }).promise;
    this.deps.markPage(this.file, n, c);
  }

  currentPage(): number {
    const top = this.scroller.scrollTop + this.scroller.clientHeight / 3;
    let cur = 1;
    for (const p of this.pages) { if (p.box.offsetTop <= top) cur = p.n; else break; }
    return cur;
  }

  private onSelection = () => this.updateSelection();

  private updateSelection(): void {
    const s = this.root.isConnected && !this.root.hidden ? this.selection() : null;
    this.bar.quote.disabled = !s;
    if (!s?.rect) { this.floatBtn.hidden = true; return; }
    const host = this.root.getBoundingClientRect();
    this.floatBtn.hidden = false;
    const w = this.floatBtn.offsetWidth || 120;
    const x = Math.min(Math.max(8, s.rect.right - host.left - w / 2), host.width - w - 8);
    const y = Math.min(s.rect.bottom - host.top + 8, host.height - 36);
    this.floatBtn.style.left = `${x}px`;
    this.floatBtn.style.top = `${Math.max(44, y)}px`;
  }

  // ---- Zoom und Seiten --------------------------------------------------------------------------------------------

  private step(dir: 1 | -1): void {
    const cur = this.scale();
    const next = dir > 0 ? ZOOMS.find((z) => z > cur + 0.001) : [...ZOOMS].reverse().find((z) => z < cur - 0.001);
    if (next) this.setZoom(next);
  }

  private setZoom(z: number | null): void {
    const p = this.currentPage();
    this.zoom = z;
    this.layout();
    this.pages[p - 1]?.box.scrollIntoView({ block: 'start' });
    this.updateBar();
  }

  /** Maßstab: 1 heißt 100 % (72 PDF-Punkte = 96 CSS-Pixel wie im Browser). */
  private scale(): number { return this.zoom ?? this.fitScale; }

  private relayoutSoon(): void {
    clearTimeout(this.relayoutTimer);
    this.relayoutTimer = setTimeout(() => { this.layout(); this.updateBar(); }, 120);
  }

  /** Setzt die Seitengrößen für den aktuellen Maßstab. Gezeichnete Seiten mit altem Maßstab werden beim Sichtbarwerden neu gezeichnet. */
  private layout(): void {
    this.lastWidth = this.scroller.clientWidth;
    const avail = Math.max(120, this.lastWidth - 32);
    this.fitScale = avail / (this.pageSize[0] * CSS_UNITS);
    const s = this.scale();
    for (const p of this.pages) {
      const [w, h] = p.box.dataset.w ? [Number(p.box.dataset.w), Number(p.box.dataset.h)] : this.pageSize;
      p.box.style.width = `${Math.floor(w * CSS_UNITS * s)}px`;
      p.box.style.height = `${Math.floor(h * CSS_UNITS * s)}px`;
      if (p.scale && Math.abs(p.scale - s) > 0.001) this.unrender(p);
    }
    // Sichtbare Seiten gleich neu zeichnen, der Beobachter meldet nur Wechsel der Sichtbarkeit
    const r = this.scroller.getBoundingClientRect();
    for (const p of this.pages) {
      const b = p.box.getBoundingClientRect();
      if (b.bottom > r.top - 600 && b.top < r.bottom + 600) void this.renderPage(p);
    }
  }

  private async renderPage(p: Page | undefined): Promise<void> {
    if (!p || !this.doc) return;
    const s = this.scale();
    if (p.scale && Math.abs(p.scale - s) < 0.001) return;
    this.unrender(p);
    p.scale = s;
    const doc = this.doc;
    let page: PDFPageProxy;
    try { page = await doc.getPage(p.n); } catch { return; }
    if (doc !== this.doc || p.scale !== s) return;
    const base = page.getViewport({ scale: 1 });
    p.box.dataset.w = String(base.width);
    p.box.dataset.h = String(base.height);
    const vp = page.getViewport({ scale: s * CSS_UNITS });
    p.box.style.width = `${Math.floor(vp.width)}px`;
    p.box.style.height = `${Math.floor(vp.height)}px`;
    const dpr = window.devicePixelRatio || 1;
    const canvas = el('canvas', { className: 'pdf-canvas', width: Math.floor(vp.width * dpr), height: Math.floor(vp.height * dpr) });
    const text = el('div', { className: 'textLayer' });
    p.box.style.setProperty('--scale-factor', String(vp.scale));
    p.box.style.setProperty('--total-scale-factor', String(vp.scale));
    p.canvas = canvas;
    p.text = text;
    p.box.append(canvas, text);
    p.task = page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
    try { await p.task.promise; } catch { return; } // abgebrochen (neuer Maßstab) oder kaputte Seite: Rest der PDF bleibt nutzbar
    finally { p.task = null; }
    if (p.text !== text) return;
    p.textLayer = new TextLayer({ textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }), container: text, viewport: vp });
    try { await p.textLayer.render(); } catch { /* ohne Textebene bleibt die Seite sichtbar, nur nicht zitierbar */ }
    if (p.text === text) p.box.classList.toggle('no-text', !text.textContent?.trim());
  }

  private unrender(p: Page): void {
    p.task?.cancel();
    p.textLayer?.cancel();
    p.canvas?.remove();
    p.text?.remove();
    Object.assign(p, { canvas: null, text: null, scale: 0, task: null, textLayer: null });
    p.box.classList.remove('no-text');
  }

  private clearPages(): void {
    for (const p of this.pages) { this.observer.unobserve(p.box); this.unrender(p); }
    this.pages = [];
    this.pagesEl.replaceChildren();
  }

  private showMessage(text: string): void {
    this.clearPages();
    this.pagesEl.append(el('div', { className: 'pdf-msg', textContent: text }));
    this.updateBar();
  }

  private updatePageNo(): void {
    this.bar.page.textContent = this.pages.length ? `Seite ${this.currentPage()} von ${this.pages.length}` : '';
  }

  private updateBar(): void {
    this.updatePageNo();
    this.bar.zoom.textContent = `${Math.round(this.scale() * 100)} %`;
    this.bar.mark.disabled = !this.pages.length;
    this.bar.quote.disabled = !this.selection();
  }

  // ---- Prüfhilfen (nur für Tests) ---------------------------------------------------------------------------------

  state() {
    return {
      pages: this.pages.length, rendered: this.pages.filter((p) => p.canvas && !p.task).map((p) => p.n), current: this.currentPage(),
      zoom: Math.round(this.scale() * 100), error: this.error, float: !this.floatBtn.hidden,
      text: this.pages.map((p) => p.text?.textContent ?? null),
    };
  }

  /** Wählt auf Seite `n` den ersten Treffer von `find` in der Textebene aus, wie mit der Maus. */
  select(n: number, find: string): boolean {
    const t = this.pages[n - 1]?.text;
    if (!t) return false;
    const walker = document.createTreeWalker(t, NodeFilter.SHOW_TEXT);
    let all = '';
    const nodes: [Text, number][] = [];
    for (let x = walker.nextNode(); x; x = walker.nextNode()) { nodes.push([x as Text, all.length]); all += x.textContent ?? ''; }
    const i = all.indexOf(find);
    if (i < 0) return false;
    const at = (pos: number): [Text, number] => { const [node, off] = [...nodes].reverse().find(([, o]) => o <= pos)!; return [node, pos - off]; };
    const r = document.createRange();
    r.setStart(...at(i));
    r.setEnd(...at(i + find.length));
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    this.updateSelection();
    return true;
  }
}

/** PDF-Punkte zu CSS-Pixeln (72 zu 96 dpi), wie im Browser bei 100 %. */
const CSS_UNITS = 96 / 72;

/** Zitat als eine Zeile: Zeilenumbrüche der PDF und Silbentrennung am Zeilenende fallen weg. */
export function cleanQuote(s: string): string {
  return s.replace(/(\p{L})-\s*\n\s*(\p{Ll})/gu, '$1$2').replace(/\s+/g, ' ').trim();
}

/** Billiger Fingerabdruck: Länge plus FNV-1a über bis zu 64 KB vorne, hinten und in der Mitte. */
function signature(data: ArrayBuffer): string {
  const b = new Uint8Array(data);
  let h = 0x811c9dc5;
  const take = (from: number, to: number) => { for (let i = Math.max(0, from); i < Math.min(b.length, to); i++) { h ^= b[i]; h = Math.imul(h, 0x01000193); } };
  take(0, 65536);
  take((b.length >> 1) - 32768, (b.length >> 1) + 32768);
  take(b.length - 65536, b.length);
  return `${b.length}:${(h >>> 0).toString(16)}`;
}
