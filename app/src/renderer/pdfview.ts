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

/** Eine Datei einer zusammengesetzten Ansicht (loadSet). `key` steht für die Datei in Zitat und Markierung. */
export interface PdfSource { key: string; data: ArrayBuffer; label?: string }

/** Zusätze je Seite für Ansichten, die auf der PDF-Ansicht aufbauen (etwa die Zeichnungen). */
export interface PdfDecorator {
  /** Element shown above the page (inside the scroll area, scrolls with the page, same width as the page). Called when the page box is created. */
  header?(key: string, pageInSource: number): HTMLElement | null;
  /** Element laid over the page canvas (absolute, inset 0, above the text layer). Called when the page box is created; sizes in % stay valid on zoom. */
  overlay?(key: string, pageInSource: number): HTMLElement | null;
  /** Label under the thumbnail (default: page number). */
  thumbLabel?(key: string, pageInSource: number): string | null;
  /** Current page changed (scrolling, single-page navigation). */
  current?(key: string, pageInSource: number): void;
}

export interface PdfOptions {
  /** Art der Ansicht: Ansicht, Einpassen und Vorschauleiste werden je Art gemerkt. */
  kind?: string;
  decorate?: PdfDecorator;
  defaultFit?: Fit;
  defaultMode?: Mode;
}

type Mode = 'all' | 'single';
type Fit = 'width' | 'page';

/** Längste Zitate: Mehr passt nicht sinnvoll in eine Eingabezeile des Agenten. Längeres wird gekürzt und gemeldet. */
export const MAX_QUOTE = 2000;
const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
/** Auflösung von „Seite markieren“: so scharf, dass Maßzahlen in Zeichnungen lesbar bleiben. */
const MARK_SCALE = 2.5;
/** Breite der Vorschaubilder in CSS-Pixeln. Die Leiste selbst ist etwas breiter (style.css, .pdf-thumbs). */
const THUMB_W = 84;
/** Schmaler als das ist die Ansicht zu eng für die Vorschauleiste: Sie blendet sich aus, bis wieder Platz ist. */
const THUMBS_MIN_VIEW = 420;
/**
 * Bis zu so vielen Seiten werden alle Seitenformate vorab gelesen (Einpassen je Seite, Platzhalter in richtiger Größe).
 * Darüber gilt bis zum Zeichnen das Format der ersten Seite der Datei, sonst dauert das Öffnen dicker Datenblätter.
 */
const SIZE_ALL_MAX = 300;
/** Rand um die Seiten (style.css, .pdf-pages padding). */
const PAD = 16;
/** Format des Platzhalters für eine Datei, die sich nicht lesen lässt: A4 quer, wie ein Zeichnungsblatt. */
const ERR_SIZE: [number, number] = [842, 595];

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

async function parse(data: ArrayBuffer): Promise<PDFDocumentProxy> {
  await ensureWorker();
  return getDocument({
    data: new Uint8Array(data), enableXfa: false, stopAtErrors: false,
    cMapUrl: 'pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: 'pdfjs/standard_fonts/', wasmUrl: 'pdfjs/wasm/',
  }).promise;
}

function parseError(e: unknown): string {
  return e instanceof PasswordException ? 'The PDF is password protected. Right-click it in the file tree: “Open with default app”.'
    : `The PDF cannot be read: ${e instanceof Error ? e.message : String(e)}`;
}

/** Eine geladene Datei. `doc` fehlt, wenn sie sich nicht lesen ließ: Dann steht sie als eine Platzhalterseite mit `error` da. */
interface Src { key: string; label: string; sig: string; doc: PDFDocumentProxy | null; error: string | null; count: number }

interface Page {
  /** Seite in der ganzen Ansicht (1 …), `pin` die Seite in ihrer Datei. */
  n: number; src: Src; pin: number;
  /** Format in PDF-Punkten (vorab gelesen oder vom ersten Zeichnen). */
  size: [number, number];
  /** Hülle aus Kopf (vom Decorator) und Seite. */
  wrap: HTMLElement; box: HTMLElement;
  /** Höhe des Kopfs samt Abstand, zuletzt gemessen: Beim Einpassen der ganzen Seite muss er mit in die Höhe passen. */
  headH: number;
  canvas: HTMLCanvasElement | null; text: HTMLElement | null; scale: number; task: RenderTask | null; textLayer: TextLayer | null;
  thumb: HTMLButtonElement; thumbImg: HTMLElement; thumbDone: boolean;
  /** Seite gehört nicht mehr zur Ansicht (neu geladen): laufendes Zeichnen verwirft sein Ergebnis. */
  dead: boolean;
}

interface Prefs { mode?: Mode; fit?: Fit; thumbs?: boolean }

/** Gemerkte Wahl je Art der Ansicht. localStorage kann fehlen oder werfen, dann gelten die Vorgaben. */
function loadPrefs(kind: string): Prefs {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(`soma.pdf.${kind}`) ?? '{}');
    if (!v || typeof v !== 'object') return {};
    const o = v as Record<string, unknown>;
    return {
      mode: o.mode === 'all' || o.mode === 'single' ? o.mode : undefined,
      fit: o.fit === 'width' || o.fit === 'page' ? o.fit : undefined,
      thumbs: typeof o.thumbs === 'boolean' ? o.thumbs : undefined,
    };
  } catch { return {}; }
}

/**
 * PDF-Ansicht im Code-Panel (E54). Seiten werden erst gezeichnet, wenn sie in Sicht kommen, darüber liegt die Textebene
 * von pdf.js: Markierter Text geht mit Datei und Seite als Zitat an den Agenten. Gescannte Seiten ohne Text lassen sich
 * als Bild markieren. Die Datei kommt aus dem Projekt und ist nicht vertrauenswürdig: kein Skript, kein eval, keine Formulare.
 *
 * Alle Seiten untereinander oder eine Seite für sich, links eine Leiste mit Vorschaubildern, Einpassen auf Seitenbreite
 * oder ganze Seite. Mit loadSet zeigt dieselbe Ansicht mehrere Dateien hintereinander als ein Dokument (Zeichnungen),
 * ein PdfDecorator legt dann Kopf und Überlagerung je Seite dazu.
 */
export class PdfView {
  readonly root: HTMLElement;
  private scroller: HTMLElement;
  private pagesEl: HTMLElement;
  private thumbsEl: HTMLElement;
  private bar: {
    page: HTMLElement; zoom: HTMLElement; quote: HTMLButtonElement; mark: HTMLButtonElement; thumbs: HTMLButtonElement;
    prev: HTMLButtonElement; next: HTMLButtonElement; mode: HTMLElement; fit: HTMLElement;
  };
  private srcs: Src[] = [];
  private pages: Page[] = [];
  /** null = eingepasst (`fit`). */
  private zoom: number | null = null;
  private mode: Mode;
  private fit: Fit;
  /** Vorschauleiste gewünscht: null = noch nie umgeschaltet, dann bei mehr als einer Seite. */
  private thumbsPref: boolean | null;
  /** Aktuelle Seite in der Einzelansicht. */
  private cur = 1;
  /** Nach einem Sprung gilt die angesprungene Seite als aktuell, solange nicht weitergescrollt wird (kurze Seiten am Ende). */
  private forced: { n: number; top: number } | null = null;
  /** Sprungziel aus goTo, während noch geladen wird. */
  private pending: { key: string; pin: number } | null = null;
  private loading = 0;
  private lastCur: Page | null = null;
  private empty: HTMLElement | null = null;
  private isEmpty = false;
  private kind: string;
  private deco: PdfDecorator;
  private observer: IntersectionObserver;
  private thumbObserver: IntersectionObserver;
  private resize: ResizeObserver;
  private viewW = 0;
  private viewH = 0;
  /** Breiteste Seite in PDF-Punkten: Beim Einpassen auf Seitenbreite haben alle Seiten denselben Maßstab. */
  private maxW = 595;
  private relayoutTimer: ReturnType<typeof setTimeout> | undefined;
  private loadId = 0;
  /** Fingerabdruck der geladenen Datei(en): Nur wenn er sich ändert, wird neu geladen. */
  private sig = '';
  error: string | null = null;

  constructor(readonly file: string, private deps: PdfDeps, opts: PdfOptions = {}) {
    this.kind = opts.kind ?? 'pdf';
    this.deco = opts.decorate ?? {};
    const saved = loadPrefs(this.kind);
    this.mode = saved.mode ?? opts.defaultMode ?? 'all';
    this.fit = saved.fit ?? opts.defaultFit ?? 'width';
    this.thumbsPref = saved.thumbs ?? null;
    const btn = (ico: string, title: string, onClick: () => void, label = '') => {
      const b = el('button', { className: label ? 'btn sm ghost' : 'btn sm ghost ico', title }, icon(ico, 14, 1.9), label && el('span', { className: 'lbl', textContent: label }));
      b.setAttribute('aria-label', title);
      b.addEventListener('click', onClick);
      return b;
    };
    // Umschalter wie beim Markdown (.cmode): genau einer gewählt, beim Einpassen keiner, sobald von Hand gezoomt ist
    const seg = (name: string, label: string, items: [string, string, string][], pick: (v: string) => void) => {
      const g = el('div', { className: 'cmode pdf-seg' });
      g.dataset.pdf = name;
      g.setAttribute('role', 'radiogroup');
      g.setAttribute('aria-label', label);
      for (const [v, ico, title] of items) {
        const b = el('button', { title }, icon(ico, 14, 1.9));
        b.dataset.v = v;
        b.setAttribute('role', 'radio');
        b.setAttribute('aria-label', title);
        b.addEventListener('click', () => pick(v));
        g.append(b);
      }
      return g;
    };
    this.bar = {
      page: el('span', { className: 'pdf-page-no c3' }),
      zoom: el('span', { className: 'pdf-zoom c3' }),
      quote: btn('send', 'Send the selected text to the agent as a quote with its page', () => this.sendQuote(), 'Quote to agent'),
      mark: btn('camera', 'Mark up this page as an image (for drawings and scanned pages)', () => void this.markPage(), 'Mark up page'),
      thumbs: btn('thumbs', 'Page thumbnails', () => this.toggleThumbs()),
      prev: btn('left', 'Previous page', () => this.go(this.currentPage() - 1)),
      next: btn('right', 'Next page', () => this.go(this.currentPage() + 1)),
      mode: seg('mode', 'Page display', [['all', 'pages', 'All pages: scroll through the document'], ['single', 'page1', 'Single page: one page at a time (Page Up/Down, arrow keys)']],
        (v) => this.setMode(v as Mode)),
      fit: seg('fit', 'Fit', [['width', 'fitw', 'Fit page width (Ctrl+0)'], ['page', 'fitp', 'Fit whole page']], (v) => this.setFit(v as Fit)),
    };
    this.bar.thumbs.dataset.pdf = 'thumbs';
    this.bar.prev.dataset.pdf = 'prev';
    this.bar.next.dataset.pdf = 'next';
    const minus = btn('minus', 'Zoom out', () => this.step(-1));
    const plus = btn('plus', 'Zoom in', () => this.step(1));
    this.pagesEl = el('div', { className: 'pdf-pages' });
    this.scroller = el('div', { className: 'pdf-scroll', tabIndex: -1 }, this.pagesEl);
    this.thumbsEl = el('div', { className: 'pdf-thumbs' });
    this.thumbsEl.setAttribute('aria-label', 'Page thumbnails');
    this.thumbsEl.hidden = true;
    // Mausdruck auf den Knopf nicht als Klick ins Dokument werten, sonst ginge die Textauswahl vor dem Klick verloren
    this.bar.quote.addEventListener('mousedown', (e) => e.preventDefault());
    this.root = el('div', { className: 'pdfview' },
      el('div', { className: 'pdf-bar' }, this.bar.thumbs, this.bar.mode, el('span', { className: 'pdf-sep' }), this.bar.prev, this.bar.page, this.bar.next,
        el('span', { className: 'grow' }), minus, this.bar.zoom, plus, this.bar.fit, el('span', { className: 'pdf-sep' }), this.bar.mark, this.bar.quote),
      el('div', { className: 'pdf-body' }, this.thumbsEl, this.scroller));
    this.root.dataset.kind = this.kind;
    this.observer = new IntersectionObserver((list) => {
      for (const e of list) if (e.isIntersecting) void this.renderPage(this.pages[Number((e.target as HTMLElement).dataset.page) - 1]);
    }, { root: this.scroller, rootMargin: '600px 0px' });
    this.thumbObserver = new IntersectionObserver((list) => {
      for (const e of list) if (e.isIntersecting) void this.renderThumb(this.pages[Number((e.target as HTMLElement).dataset.page) - 1]);
    }, { root: this.thumbsEl, rootMargin: '300px 0px' });
    this.resize = new ResizeObserver(() => {
      if (!this.root.clientWidth) return; // versteckter Reiter: erst beim Zeigen neu einpassen
      this.updateThumbs();
      const w = this.scroller.clientWidth, h = this.scroller.clientHeight;
      if (w && this.zoom == null && (Math.abs(w - this.viewW) > 2 || (this.fit === 'page' && Math.abs(h - this.viewH) > 2))) this.relayoutSoon();
    });
    this.resize.observe(this.root);
    this.resize.observe(this.scroller);
    this.scroller.addEventListener('scroll', () => { this.updatePageNo(); this.updateSelection(); });
    document.addEventListener('selectionchange', this.onSelection);
    this.root.addEventListener('keydown', (e) => this.onKey(e));
    this.scroller.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.step(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
    this.root.classList.toggle('single', this.mode === 'single');
    this.updateBar();
  }

  /** Lädt die Datei (neu). Gleicher Inhalt wie zuletzt: nichts zu tun. Die Scrolllage bleibt, so gut es geht. */
  async load(data: ArrayBuffer): Promise<void> {
    const sig = signature(data);
    if (sig === this.sig) return;
    this.sig = sig;
    const id = ++this.loadId;
    this.loading++;
    try {
      let doc: PDFDocumentProxy;
      try { doc = await parse(data); } catch (e) {
        if (id !== this.loadId) return;
        this.error = parseError(e);
        this.showMessage(this.error);
        return;
      }
      if (id !== this.loadId) { void doc.loadingTask.destroy(); return; }
      const src: Src = { key: this.file, label: '', sig, doc, error: null, count: doc.numPages };
      const sizes = await readSizes([src]);
      if (id !== this.loadId) { void doc.loadingTask.destroy(); return; }
      this.error = null;
      this.install([src], sizes, []);
    } finally { this.loading--; }
  }

  /**
   * Mehrere Dateien hintereinander als ein Dokument (Zeichnungen). Unveränderte Dateien werden nicht neu gelesen, gleicher
   * Inhalt insgesamt: nichts zu tun. Eine Datei, die sich nicht lesen lässt, steht als Platzhalterseite mit der Meldung da,
   * `errors` (etwa Blätter, die gar nicht gebaut wurden) als Meldungen nach den Seiten.
   */
  async loadSet(sources: PdfSource[], errors: { key: string; label: string; message: string }[] = []): Promise<void> {
    const sigs = sources.map((s) => `${s.key}\u0000${s.label ?? ''}\u0000${signature(s.data)}`);
    const sig = `set\u0001${sigs.join('\u0001')}\u0002${JSON.stringify(errors.map((e) => [e.key, e.label, e.message]))}`;
    if (sig === this.sig) return;
    this.sig = sig;
    const id = ++this.loadId;
    this.loading++;
    try {
      const old = new Map(this.srcs.filter((s) => s.doc).map((s) => [s.sig, s]));
      const srcs = await Promise.all(sources.map(async (s, i): Promise<Src> => {
        const prev = old.get(sigs[i]);
        if (prev) { old.delete(sigs[i]); return { ...prev }; }
        try {
          const doc = await parse(s.data);
          return { key: s.key, label: s.label ?? '', sig: sigs[i], doc, error: null, count: doc.numPages };
        } catch (e) {
          return { key: s.key, label: s.label ?? '', sig: sigs[i], doc: null, error: parseError(e), count: 1 };
        }
      }));
      const discard = () => {
        const keep = new Set(this.srcs.map((s) => s.doc));
        for (const s of srcs) if (s.doc && !keep.has(s.doc)) void s.doc.loadingTask.destroy();
      };
      if (id !== this.loadId) { discard(); return; }
      const sizes = await readSizes(srcs);
      if (id !== this.loadId) { discard(); return; }
      this.error = null;
      this.install(srcs, sizes, errors);
    } finally { this.loading--; }
  }

  /** Was die Ansicht zeigt, wenn loadSet nichts bekommt (weder Dateien noch Meldungen). */
  setEmpty(content: HTMLElement): void {
    this.empty = content;
    if (this.isEmpty) this.pagesEl.replaceChildren(content);
  }

  /** Zur Seite einer Datei springen (Einzelansicht: umschalten). Läuft noch ein Laden, gilt der Sprung danach. */
  goTo(key: string, pageInSource = 1): void {
    const p = this.findPage(key, pageInSource);
    if (!p || this.loading) this.pending = { key, pin: pageInSource };
    if (p) this.go(p.n);
  }

  currentSource(): { key: string; page: number } | null {
    const p = this.pages[this.currentPage() - 1];
    return p ? { key: p.src.key, page: p.pin } : null;
  }

  /** Das .pdf-page-Element einer Seite (für Überlagerungen und Tests). */
  pageBox(key: string, pageInSource: number): HTMLElement | null {
    return this.pages.find((p) => p.src.key === key && p.pin === pageInSource)?.box ?? null;
  }

  dispose(): void {
    this.loadId++;
    this.observer.disconnect();
    this.thumbObserver.disconnect();
    this.resize.disconnect();
    document.removeEventListener('selectionchange', this.onSelection);
    clearTimeout(this.relayoutTimer);
    this.clearPages();
    this.destroyDocs(new Set());
    this.srcs = [];
  }

  /** Beim Wechsel des Reiters: Die Auswahl gehört nur zur sichtbaren Ansicht. */
  hidden(): void { this.updateSelection(); }

  /**
   * Reiter wieder sichtbar: War die Ansicht beim Laden versteckt (Breite 0) oder hat sich das Panel inzwischen verändert,
   * gleich neu einpassen. Der ResizeObserver allein reicht nicht, er meldet sich erst beim nächsten Zeichnen des Fensters.
   */
  shown(): void {
    this.updateThumbs();
    if (this.pages.length && (Math.abs(this.scroller.clientWidth - this.viewW) > 2 || Math.abs(this.scroller.clientHeight - this.viewH) > 2)) {
      // Die zuletzt gemeldete Seite, nicht neu ausgerechnet: Die Lage der Seiten stammt noch aus der alten Breite
      const n = this.lastCur && !this.lastCur.dead ? this.lastCur.n : 1;
      this.layout();
      if (this.mode === 'all' && n > 1) this.scrollToPage(n);
    }
    this.updateBar();
  }

  // ---- Laden ------------------------------------------------------------------------------------------------------

  /** Baut die Seiten neu auf und hält dabei die Stelle, an der man war (gleiche Datei und Seite, sonst gleiche Nummer). */
  private install(srcs: Src[], sizes: [number, number][][], errors: { key: string; label: string; message: string }[]): void {
    const anchor = this.anchor();
    this.destroyDocs(new Set(srcs.map((s) => s.doc)));
    this.clearPages();
    this.srcs = srcs;
    let n = 0;
    srcs.forEach((s, i) => { for (let pin = 1; pin <= s.count; pin++) this.addPage(++n, s, pin, sizes[i][pin - 1] ?? sizes[i][0] ?? ERR_SIZE); });
    for (const e of errors) {
      this.pagesEl.append(el('div', { className: 'pdf-err' }, icon('alert', 15, 2),
        el('div', {}, e.label && el('b', { textContent: e.label }), e.label && ' ', el('span', { textContent: e.message }))));
    }
    this.isEmpty = !this.pages.length && !errors.length;
    if (this.isEmpty && this.empty) this.pagesEl.append(this.empty);
    this.maxW = Math.max(1, ...this.pages.map((p) => p.size[0]));
    this.updateThumbs();

    // Wohin: offener Sprung, sonst dieselbe Seite derselben Datei, sonst dieselbe Datei, sonst dieselbe Nummer
    let target: Page | undefined, off = 0, jump = false;
    if (this.pending) { target = this.findPage(this.pending.key, this.pending.pin); this.pending = null; jump = true; }
    else if (anchor) {
      target = this.findPage(anchor.key, anchor.pin) ?? this.pages[Math.min(anchor.n, this.pages.length) - 1];
      off = anchor.off;
    }
    if (this.mode === 'single') {
      this.showPage(target?.n ?? 1);
      this.scroller.scrollTop = jump ? 0 : off;
    } else {
      this.layout();
      if (target && jump) this.scrollToPage(target.n);
      else this.scroller.scrollTop = target ? Math.max(0, target.wrap.offsetTop + off) : 0;
    }
    for (const p of this.pages) { this.observer.observe(p.box); this.thumbObserver.observe(p.thumb); }
    this.updateBar();
  }

  private addPage(n: number, src: Src, pin: number, size: [number, number]): void {
    const box = el('div', { className: src.doc ? 'pdf-page' : 'pdf-page pdf-errpage' });
    box.dataset.page = String(n);
    box.append(el('span', { className: 'pdf-pnum', textContent: String(n) }));
    const wrap = el('div', { className: 'pdf-sheet' });
    wrap.dataset.page = String(n);
    const head = this.decorate(() => this.deco.header?.(src.key, pin));
    if (head) wrap.append(head);
    wrap.append(box);
    if (!src.doc) {
      const text = head || !src.label ? src.error ?? '' : `${src.label}: ${src.error ?? ''}`;
      box.append(el('div', { className: 'pdf-errpage-msg' }, icon('alert', 18, 2), el('span', { textContent: text })));
    } else {
      // Über Leinwand und Textebene, selbst ohne Mauswirkung: Die Kinder des Decorators entscheiden, wo sie Klicks wollen
      const over = this.decorate(() => this.deco.overlay?.(src.key, pin));
      if (over) box.append(el('div', { className: 'pdf-overlay' }, over));
    }
    this.pagesEl.append(wrap);
    const label = this.decorate(() => this.deco.thumbLabel?.(src.key, pin)) ?? String(n);
    const thumbImg = el('div', { className: src.doc ? 'pdf-thumb-img' : 'pdf-thumb-img err' }, !src.doc && icon('alert', 18, 2));
    thumbImg.style.height = `${Math.round(THUMB_W * size[1] / size[0])}px`;
    const thumb = el('button', { className: 'pdf-thumb', title: label }, thumbImg, el('span', { className: 'pdf-thumb-label', textContent: label }));
    thumb.dataset.page = String(n);
    thumb.setAttribute('aria-label', `Page ${n}: ${label}`);
    thumb.addEventListener('click', () => { this.go(n); this.scroller.focus({ preventScroll: true }); });
    this.thumbsEl.append(thumb);
    this.pages.push({ n, src, pin, size, wrap, box, headH: 0, canvas: null, text: null, scale: 0, task: null, textLayer: null, thumb, thumbImg, thumbDone: false, dead: false });
  }

  /** Aufruf in den Decorator: Ein Fehler dort soll nicht die ganze Ansicht mitnehmen. */
  private decorate<T>(f: () => T | null | undefined): T | null {
    try { return f() ?? null; } catch (e) { console.error('PDF decorator', e); return null; }
  }

  private anchor(): { key: string; pin: number; n: number; off: number } | null {
    if (!this.pages.length) return null;
    const p = this.pages[this.currentPage() - 1];
    return { key: p.src.key, pin: p.pin, n: p.n, off: this.mode === 'single' ? this.scroller.scrollTop : this.scroller.scrollTop - p.wrap.offsetTop };
  }

  private findPage(key: string, pin: number): Page | undefined {
    return this.pages.find((p) => p.src.key === key && p.pin === pin) ?? this.pages.find((p) => p.src.key === key);
  }

  /** Gibt die Dokumente frei, die nicht weiter gebraucht werden. */
  private destroyDocs(keep: Set<PDFDocumentProxy | null>): void {
    for (const s of this.srcs) if (s.doc && !keep.has(s.doc)) void s.doc.loadingTask.destroy();
  }

  // ---- Zitat und Seite --------------------------------------------------------------------------------------------

  /**
   * Markierter Text in dieser Ansicht mit der Datei und den Seiten, auf denen er steht. Reicht die Auswahl über zwei
   * Dateien, zählt die erste.
   */
  selection(): { key: string; text: string; pages: string; rect: DOMRect | null } | null {
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
    const pa = this.pages[lo - 1], pb = this.pages[hi - 1];
    let key = this.file, pages = '?';
    if (pa) {
      key = pa.src.key;
      const end = pb && pb.src === pa.src ? pb.pin : pa.src.count;
      pages = end === pa.pin ? String(pa.pin) : `${pa.pin}–${end}`;
    }
    return { key, text, pages, rect: rects.length ? rects[rects.length - 1] : null };
  }

  sendQuote(): void {
    const s = this.selection();
    if (!s) return;
    this.deps.quote(s.key, s.pages, s.text);
  }

  /** Seite `n` der ganzen Ansicht als Bild auf die Zeichenfläche, unter ihrer Datei und Seite darin. */
  async markPage(n = this.currentPage()): Promise<void> {
    const p = this.pages[n - 1];
    if (!p?.src.doc) return;
    const page = await p.src.doc.getPage(p.pin);
    const vp = page.getViewport({ scale: MARK_SCALE });
    const c = el('canvas', { width: Math.round(vp.width), height: Math.round(vp.height) });
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff'; // PDF-Seiten sind weiß, auch wenn die Datei keinen Hintergrund malt
    g.fillRect(0, 0, c.width, c.height);
    await page.render({ canvas: c, canvasContext: g, viewport: vp }).promise;
    this.deps.markPage(p.src.key, p.pin, c);
  }

  currentPage(): number {
    if (!this.pages.length) return 1;
    if (this.mode === 'single') return Math.min(Math.max(1, this.cur), this.pages.length);
    if (this.forced && Math.abs(this.forced.top - this.scroller.scrollTop) < 2) return this.forced.n;
    // Versteckt (Reiter im Hintergrund) liegen alle Seiten bei 0: dann gilt die zuletzt aktuelle Seite
    if (!this.scroller.clientHeight) return this.lastCur && !this.lastCur.dead ? this.lastCur.n : 1;
    this.forced = null;
    const top =this.scroller.scrollTop + this.scroller.clientHeight / 3;
    let cur = 1;
    for (const p of this.pages) { if (p.wrap.offsetTop <= top) cur = p.n; else break; }
    return cur;
  }

  private onSelection = () => this.updateSelection();

  private updateSelection(): void {
    const s = this.root.isConnected && !this.root.hidden ? this.selection() : null;
    // Kein schwebender Knopf am Text (störte beim Lesen): Der Knopf oben wird orange, sobald etwas markiert ist
    this.bar.quote.disabled = !s;
    this.bar.quote.classList.toggle('acc', !!s);
    this.bar.quote.classList.toggle('ghost', !s);
  }

  // ---- Ansicht, Blättern, Vorschauleiste --------------------------------------------------------------------------

  private setMode(m: Mode): void {
    if (m === this.mode) return;
    const n = this.currentPage();
    this.mode = m;
    this.savePrefs();
    this.root.classList.toggle('single', m === 'single');
    if (m === 'single') this.showPage(n);
    else {
      for (const p of this.pages) p.wrap.hidden = false;
      this.layout();
      this.scrollToPage(n);
    }
    this.updateBar();
  }

  /** Zu Seite `n` der ganzen Ansicht: in der Einzelansicht umschalten, sonst hinscrollen. */
  private go(n: number, atEnd = false): void {
    if (!this.pages.length) return;
    n = Math.min(Math.max(1, n), this.pages.length);
    if (this.mode === 'single') {
      if (n !== this.cur) this.showPage(n);
      this.scroller.scrollTop = atEnd ? this.scroller.scrollHeight : 0;
    } else this.scrollToPage(n);
    this.updateBar();
  }

  /** Einzelansicht: nur Seite `n` sichtbar. Einpassen danach, weil erst jetzt der Kopf dieser Seite messbar ist. */
  private showPage(n: number): void {
    this.cur = Math.min(Math.max(1, n), Math.max(1, this.pages.length));
    for (const p of this.pages) p.wrap.hidden = p.n !== this.cur;
    this.layout();
    this.scroller.scrollTop = 0;
    this.scroller.scrollLeft = 0;
  }

  private scrollToPage(n: number): void {
    const p = this.pages[n - 1];
    if (!p) return;
    this.scroller.scrollTop = Math.max(0, p.wrap.offsetTop - PAD);
    this.forced = { n, top: this.scroller.scrollTop };
    this.updatePageNo();
  }

  /**
   * Tasten der Einzelansicht: Bild auf/ab blättert am Rand der Seite (vorher scrollt es wie gewohnt), Pfeile links/rechts
   * immer, Pfeile hoch/runter nur, wenn die Seite ganz zu sehen ist. Zoom mit Strg in beiden Ansichten.
   */
  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    if (t?.closest('input, textarea, select, [contenteditable=""], [contenteditable=true]')) return;
    if (e.ctrlKey && !e.altKey) {
      if (e.key === '+' || e.key === '=') { e.preventDefault(); this.step(1); }
      else if (e.key === '-') { e.preventDefault(); this.step(-1); }
      else if (e.key === '0') { e.preventDefault(); this.setZoom(null); }
      return;
    }
    if (this.mode !== 'single' || e.altKey || e.metaKey || e.shiftKey || !this.pages.length) return;
    const sc = this.scroller;
    const fits = sc.scrollHeight <= sc.clientHeight + 1;
    const atTop = sc.scrollTop <= 1, atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 1;
    const n = this.cur;
    let to = 0, atEnd = false;
    switch (e.key) {
      case 'ArrowLeft': to = n - 1; break;
      case 'ArrowRight': to = n + 1; break;
      case 'ArrowUp': if (fits) to = n - 1; break;
      case 'ArrowDown': if (fits) to = n + 1; break;
      case 'PageUp': if (atTop) { to = n - 1; atEnd = true; } break;
      case 'PageDown': if (atBottom) to = n + 1; break;
      case 'Home': to = 1; break;
      case 'End': to = this.pages.length; break;
      default: return;
    }
    if (!to) return;
    e.preventDefault();
    if (to >= 1 && to <= this.pages.length && to !== n) this.go(to, atEnd);
  }

  private toggleThumbs(): void {
    this.thumbsPref = this.thumbsEl.hidden;
    this.savePrefs();
    this.updateThumbs();
  }

  /** Vorschauleiste nach Wunsch, aber nur, wenn die Ansicht breit genug ist. */
  private updateThumbs(): void {
    const width = this.root.clientWidth;
    const want = this.thumbsPref ?? this.pages.length > 1;
    const narrow = width > 0 && width < THUMBS_MIN_VIEW;
    const show = want && !narrow && this.pages.length > 0;
    // Versteckter Reiter (Breite 0): so lassen, wie es ist, bis er wieder zu sehen ist
    if (width > 0 && this.thumbsEl.hidden === show) this.thumbsEl.hidden = !show;
    const b = this.bar.thumbs;
    b.setAttribute('aria-pressed', String(!this.thumbsEl.hidden));
    b.disabled = narrow || !this.pages.length;
    b.title = narrow ? 'Page thumbnails (the view is too narrow)' : 'Page thumbnails';
    if (!this.thumbsEl.hidden) this.markThumb(this.pages[this.currentPage() - 1]);
  }

  private async renderThumb(p: Page | undefined): Promise<void> {
    if (!p || p.thumbDone || !p.src.doc || this.thumbsEl.hidden) return;
    p.thumbDone = true;
    let page: PDFPageProxy;
    try { page = await p.src.doc.getPage(p.pin); } catch { return; }
    if (p.dead) return;
    const base = page.getViewport({ scale: 1 });
    const dpr = window.devicePixelRatio || 1;
    const vp = page.getViewport({ scale: THUMB_W * dpr / base.width });
    const c = el('canvas', { width: Math.max(1, Math.round(vp.width)), height: Math.max(1, Math.round(vp.height)) });
    const g = c.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    try { await page.render({ canvas: c, canvasContext: g, viewport: vp }).promise; } catch { return; }
    if (p.dead) return;
    p.thumbImg.style.height = `${Math.round(THUMB_W * base.height / base.width)}px`;
    p.thumbImg.replaceChildren(c);
  }

  /** Aktuelle Seite in der Leiste orange und in Sicht halten (nur die Leiste scrollt, nie das Fenster). */
  private markThumb(p: Page | undefined): void {
    for (const x of this.thumbsEl.querySelectorAll('.pdf-thumb.on')) if (x !== p?.thumb) { x.classList.remove('on'); x.removeAttribute('aria-current'); }
    if (!p) return;
    p.thumb.classList.add('on');
    p.thumb.setAttribute('aria-current', 'page');
    const s = this.thumbsEl, t = p.thumb;
    if (s.hidden || !s.clientHeight) return;
    if (t.offsetTop < s.scrollTop) s.scrollTop = t.offsetTop - 8;
    else if (t.offsetTop + t.offsetHeight > s.scrollTop + s.clientHeight) s.scrollTop = t.offsetTop + t.offsetHeight - s.clientHeight + 8;
  }

  private savePrefs(): void {
    const v: Prefs = { mode: this.mode, fit: this.fit };
    if (this.thumbsPref != null) v.thumbs = this.thumbsPref;
    try { localStorage.setItem(`soma.pdf.${this.kind}`, JSON.stringify(v)); } catch { /* ohne Speicher geht es auch */ }
  }

  // ---- Zoom und Seiten --------------------------------------------------------------------------------------------

  private step(dir: 1 | -1): void {
    const cur = this.scale();
    const next = dir > 0 ? ZOOMS.find((z) => z > cur + 0.001) : [...ZOOMS].reverse().find((z) => z < cur - 0.001);
    if (next) this.setZoom(next);
  }

  private setFit(f: Fit): void {
    this.fit = f;
    this.savePrefs();
    this.setZoom(null);
  }

  private setZoom(z: number | null): void {
    const n = this.currentPage();
    this.zoom = z;
    this.layout();
    if (this.mode === 'all') this.scrollToPage(n);
    this.updateBar();
  }

  /** Maßstab der aktuellen Seite: 1 heißt 100 % (72 PDF-Punkte = 96 CSS-Pixel wie im Browser). */
  private scale(): number {
    const p = this.pages[this.currentPage() - 1];
    return p ? this.scaleOf(p) : this.zoom ?? 1;
  }

  /**
   * Seitenbreite: alle Seiten im selben Maßstab, die breiteste passt (ein A4 neben einem A3 bleibt kleiner, wie auf dem
   * Tisch). Ganze Seite: jede Seite für sich, samt Kopf, damit gemischte Formate je Blatt ganz zu sehen sind.
   */
  private scaleOf(p: Page): number {
    if (this.zoom != null) return this.zoom;
    const aw = Math.max(120, this.viewW - 2 * PAD) / CSS_UNITS;
    if (this.fit === 'page') {
      const ah = Math.max(80, this.viewH - 2 * PAD - p.headH) / CSS_UNITS;
      return Math.min(aw / p.size[0], ah / p.size[1]);
    }
    return aw / this.maxW;
  }

  private relayoutSoon(): void {
    clearTimeout(this.relayoutTimer);
    this.relayoutTimer = setTimeout(() => {
      const n = this.currentPage();
      this.layout();
      if (this.mode === 'all' && this.fit === 'page' && this.zoom == null) this.scrollToPage(n);
      this.updateBar();
    }, 120);
  }

  /** Setzt die Seitengrößen für den aktuellen Maßstab. Gezeichnete Seiten mit altem Maßstab werden beim Sichtbarwerden neu gezeichnet. */
  private layout(): void {
    this.viewW = this.scroller.clientWidth;
    this.viewH = this.scroller.clientHeight;
    for (const p of this.pages) {
      // Kopf messen, solange er zu sehen ist (in der Einzelansicht nur bei der gezeigten Seite)
      if (!p.wrap.hidden && p.wrap.firstElementChild !== p.box && p.wrap.offsetHeight) p.headH = p.wrap.offsetHeight - p.box.offsetHeight;
      const s = this.scaleOf(p);
      const w = Math.floor(p.size[0] * CSS_UNITS * s);
      p.box.style.width = `${w}px`;
      p.box.style.height = `${Math.floor(p.size[1] * CSS_UNITS * s)}px`;
      p.wrap.style.width = `${w}px`;
      if (p.scale && Math.abs(p.scale - s) > 0.001) this.unrender(p);
    }
    // Sichtbare Seiten gleich neu zeichnen, der Beobachter meldet nur Wechsel der Sichtbarkeit
    const r = this.scroller.getBoundingClientRect();
    for (const p of this.pages) {
      if (p.wrap.hidden) continue;
      const b = p.box.getBoundingClientRect();
      if (b.bottom > r.top - 600 && b.top < r.bottom + 600) void this.renderPage(p);
    }
  }

  private async renderPage(p: Page | undefined): Promise<void> {
    if (!p || p.dead || !p.src.doc || p.wrap.hidden) return;
    let s = this.scaleOf(p);
    if (p.scale && Math.abs(p.scale - s) < 0.001) return;
    this.unrender(p);
    p.scale = s;
    let page: PDFPageProxy;
    try { page = await p.src.doc.getPage(p.pin); } catch { return; }
    if (p.dead || p.scale !== s) return;
    const base = page.getViewport({ scale: 1 });
    if (Math.abs(base.width - p.size[0]) > 0.5 || Math.abs(base.height - p.size[1]) > 0.5) {
      // Format war nur angenommen (sehr dicke Datei): jetzt das echte, die breiteste Seite kann sich dadurch ändern
      p.size = [base.width, base.height];
      if (base.width > this.maxW) { this.maxW = base.width; this.relayoutSoon(); }
      s = p.scale = this.scaleOf(p);
    }
    const vp = page.getViewport({ scale: s * CSS_UNITS });
    p.box.style.width = `${Math.floor(vp.width)}px`;
    p.box.style.height = `${Math.floor(vp.height)}px`;
    p.wrap.style.width = `${Math.floor(vp.width)}px`;
    const dpr = window.devicePixelRatio || 1;
    const canvas = el('canvas', { className: 'pdf-canvas', width: Math.floor(vp.width * dpr), height: Math.floor(vp.height * dpr) });
    const text = el('div', { className: 'textLayer' });
    p.box.style.setProperty('--scale-factor', String(vp.scale));
    p.box.style.setProperty('--total-scale-factor', String(vp.scale));
    p.canvas = canvas;
    p.text = text;
    // Vor eine Überlagerung des Decorators, damit sie obenauf bleibt (z-index regelt es auch, die Reihenfolge hilft beim Lesen)
    const over = p.box.querySelector(':scope > .pdf-overlay');
    if (over) over.before(canvas, text); else p.box.append(canvas, text);
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
    for (const p of this.pages) { p.dead = true; this.observer.unobserve(p.box); this.thumbObserver.unobserve(p.thumb); this.unrender(p); }
    this.pages = [];
    this.lastCur = null;
    this.forced = null;
    this.pagesEl.replaceChildren();
    this.thumbsEl.replaceChildren();
  }

  private showMessage(text: string): void {
    this.clearPages();
    this.destroyDocs(new Set());
    this.srcs = [];
    this.isEmpty = false;
    this.pagesEl.append(el('div', { className: 'pdf-msg', textContent: text }));
    this.updateThumbs();
    this.updateBar();
  }

  private updatePageNo(): void {
    const n = this.currentPage(), count = this.pages.length;
    this.bar.page.textContent = count ? `Page ${n} of ${count}` : '';
    this.bar.prev.disabled = n <= 1;
    this.bar.next.disabled = n >= count;
    const p = this.pages[n - 1] ?? null;
    if (p === this.lastCur) return;
    this.lastCur = p;
    this.markThumb(p ?? undefined);
    this.bar.mark.disabled = !p?.src.doc;
    if (p) this.decorate(() => this.deco.current?.(p.src.key, p.pin));
  }

  private updateBar(): void {
    this.updatePageNo();
    const single = this.mode === 'single';
    this.bar.prev.hidden = this.bar.next.hidden = !single;
    for (const b of this.bar.mode.querySelectorAll<HTMLElement>('[data-v]')) b.setAttribute('aria-checked', String(b.dataset.v === this.mode));
    for (const b of this.bar.fit.querySelectorAll<HTMLElement>('[data-v]')) b.setAttribute('aria-checked', String(this.zoom == null && b.dataset.v === this.fit));
    this.bar.zoom.textContent = `${Math.round(this.scale() * 100)}%`;
    this.bar.mark.disabled = !this.pages[this.currentPage() - 1]?.src.doc;
    this.bar.quote.disabled = !this.selection();
  }

  // ---- Prüfhilfen (nur für Tests) ---------------------------------------------------------------------------------

  state() {
    const cur = this.currentPage();
    return {
      pages: this.pages.length, rendered: this.pages.filter((p) => p.canvas && !p.task).map((p) => p.n), current: cur,
      zoom: Math.round(this.scale() * 100), error: this.error, quote: !this.bar.quote.disabled,
      text: this.pages.map((p) => p.text?.textContent ?? null),
      mode: this.mode, fit: this.zoom == null ? this.fit : null,
      visible: this.pages.filter((p) => !p.wrap.hidden).map((p) => p.n),
      thumbs: {
        visible: !this.thumbsEl.hidden, count: this.thumbsEl.childElementCount,
        rendered: this.pages.filter((p) => p.thumbImg.querySelector('canvas')).length,
        current: Number(this.thumbsEl.querySelector<HTMLElement>('.pdf-thumb.on')?.dataset.page ?? 0),
      },
      src: this.pages.map((p) => ({ key: p.src.key, page: p.pin, error: p.src.error })),
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

/**
 * Formate aller Seiten je Datei in PDF-Punkten. Bei sehr vielen Seiten nur das der ersten Seite je Datei (siehe
 * SIZE_ALL_MAX), die übrigen kommen beim Zeichnen. Unlesbare Datei: ein Platzhalter im Querformat.
 */
async function readSizes(srcs: Src[]): Promise<[number, number][][]> {
  const total = srcs.reduce((a, s) => a + s.count, 0);
  const sizeOf = async (doc: PDFDocumentProxy, n: number): Promise<[number, number]> => {
    try { const vp = (await doc.getPage(n)).getViewport({ scale: 1 }); return [vp.width, vp.height]; } catch { return [595, 842]; }
  };
  return Promise.all(srcs.map(async (s) => {
    if (!s.doc) return [ERR_SIZE];
    const doc = s.doc;
    if (total > SIZE_ALL_MAX) { const first = await sizeOf(doc, 1); return Array.from({ length: s.count }, () => first); }
    return Promise.all(Array.from({ length: s.count }, (_, i) => sizeOf(doc, i + 1)));
  }));
}

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
