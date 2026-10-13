import type { DrawingDim, DrawingEntry, DrawingList, DrawingView, DrawingWarning } from '../shared/types';
import type { Pane } from './code';
import { icon } from './icons';
import { PdfView, type PdfDeps } from './pdfview';
import { el, menuItem, menus } from './ui';

// Dokument „Drawings“ (E76): alle Blätter aus .soma/drawings/index.json als ein PDF in der Code-Spalte, ohne Seitenleiste.
// Über jedem Blatt ein Kopf mit Format, Stand, Warnungen und Knöpfen. Auf dem Blatt sind Ansichten und Maße anklickbar,
// die Lage kommt aus dem Index (Blatt-mm), gezeigt wird in 3D über DrawingLink (drawlink.ts).

export const DRAWINGS_KEY = 'soma:drawings';

interface Link {
  showView(e: DrawingEntry, v: DrawingView): string | null;
  showDim(e: DrawingEntry, d: DrawingDim): string | null;
  clear(): void;
}
interface Deps {
  list(): Promise<DrawingList>;
  build(file?: string): Promise<{ ok: boolean; error?: string }>;
  readBinary(rel: string): Promise<ArrayBuffer>;
  pdf: PdfDeps;
  openCode(file: string, line: number | null, label: string): void;
  openFile(rel: string): void;
  insert(text: string): void;
  toast(text: string, kind?: 'ok' | 'info' | 'error'): void;
  link: Link;
  /** Exportieren mit Dateidialog (Meldung macht der Aufrufer). */
  exportFiles(what: 'set' | 'pdf' | 'dxf' | 'both', sheet?: string): Promise<void>;
  /** Element für Aufklappmenüs. */
  menu: HTMLElement;
  /** Blatt neu (seit dem Öffnen des Modells gebaut und noch nicht angesehen)? */
  isNew(e: DrawingEntry): boolean;
  seen(e: DrawingEntry): void;
  /** Liste neu gelesen (für den Punkt an der Leiste). */
  listed(list: DrawingList): void;
}

type Hit = { kind: 'view'; v: DrawingView; box: number[] } | { kind: 'dim'; d: DrawingDim; box: number[] };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const area = (b: number[]) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const inside = (b: number[], x: number, y: number, pad = 0) => x >= b[0] - pad && x <= b[2] + pad && y >= b[1] - pad && y <= b[3] + pad;
const KIND: Record<string, string> = { view: 'View', section: 'Section', detail: 'Detail' };
const DIM_KIND: Record<string, string> = { linear: 'Length', diameter: 'Diameter', radius: 'Radius', angle: 'Angle' };
const fmt = (v: number) => (Math.abs(v) < 5e-5 ? 0 : v).toFixed(3).replace(/\.?0+$/, '');
const where = (file: string | null, line: number | null) => (file ? `${file}${line ? ` line ${line}` : ''}` : '');

export class DrawingsView implements Pane {
  readonly root: HTMLElement;
  private pdf: PdfView;
  private list: DrawingList = { drawings: [], errors: [], building: false };
  private byKey = new Map<string, DrawingEntry>();
  private heads = new Map<string, HTMLElement>();
  private overlays = new Map<string, HTMLElement>();
  /** Aufgeklappte Warnungen je Blatt. */
  private openWarn = new Set<string>();
  private hover: { key: string; hit: Hit } | null = null;
  private sel: { key: string; hit: Hit; hint: string | null } | null = null;
  private card: HTMLElement;
  private status: HTMLElement;
  private rebuildAll: HTMLButtonElement;
  private exportBtn: HTMLButtonElement;
  /** Hinweis, wenn Blätter von einem älteren soma stammen: Ohne Neubau keine Verknüpfung mit 3D. */
  private note: HTMLElement;
  private loadSeq = 0;
  private down: { x: number; y: number } | null = null;
  private building = new Set<string>();

  constructor(private readonly d: Deps) {
    this.pdf = new PdfView(DRAWINGS_KEY, d.pdf, {
      kind: 'drawings', defaultFit: 'page', defaultMode: 'all',
      decorate: {
        header: (key, page) => (page === 1 ? this.headOf(key) : null),
        overlay: (key, page) => (page === 1 ? this.overlayOf(key) : null),
        thumbLabel: (key) => this.byKey.get(key)?.name ?? null,
      },
    });
    this.card = el('div', { className: 'dw-card', role: 'status' });
    this.card.hidden = true;
    this.status = el('span', { className: 'dw-status c3' });
    this.rebuildAll = el('button', { className: 'btn sm ghost', title: 'Build all drawings again (soma drawing build)' }, icon('refresh', 14, 1.9), 'Rebuild all');
    this.rebuildAll.addEventListener('click', () => void this.rebuild(null));
    this.exportBtn = el('button', { className: 'btn sm ghost', title: 'Export the drawings as PDF or DXF' }, icon('export', 14, 1.9), 'Export', icon('down', 12, 2));
    this.exportBtn.setAttribute('aria-haspopup', 'menu');
    this.exportBtn.addEventListener('click', () => this.openExport());
    const bar = el('div', { className: 'dw-bar' }, icon('drawing', 15, 1.8), el('b', { textContent: 'Drawings' }), this.status, el('span', { className: 'grow' }), this.exportBtn, this.rebuildAll);
    const again = el('button', { className: 'btn sm acc', title: 'Build all drawings again (soma drawing build)' }, icon('refresh', 14, 1.9), 'Rebuild');
    again.addEventListener('click', () => void this.rebuild(null));
    this.note = el('div', { className: 'dw-note' }, icon('alert', 14, 2),
      el('span', { textContent: 'Built with an older soma. Rebuild the drawings to click dimensions and to see views and sections on the model.' }), again);
    this.note.hidden = true;
    this.root = el('div', { className: 'dwview' }, bar, this.note, el('div', { className: 'dw-pdf' }, this.pdf.root), this.card);
    this.pdf.setEmpty(this.emptyNote());
    // Zeiger über dem Blatt: Treffer über den Index, die Ereignisse kommen von der Textebene der Seite
    this.root.addEventListener('pointermove', (e) => this.onMove(e));
    this.root.addEventListener('pointerleave', () => this.setHover(null));
    this.root.addEventListener('pointerdown', (e) => { this.down = { x: e.clientX, y: e.clientY }; });
    this.root.addEventListener('click', (e) => this.onClick(e));
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.sel) { e.preventDefault(); e.stopPropagation(); this.select(null); }
    });
    this.refresh();
  }

  // ---- Pane -----------------------------------------------------------------------------------------------------

  dispose(): void { this.select(null); this.pdf.dispose(); }
  hidden(): void { this.pdf.hidden(); this.setHover(null); }
  shown(): void { this.pdf.shown(); for (const e of this.list.drawings) this.d.seen(e); this.renderHeads(); }

  /** Liste neu lesen und die PDFs neu laden (PdfView lädt nur, was sich geändert hat). */
  refresh(): void { void this.load(); }

  private async load(): Promise<void> {
    const seq = ++this.loadSeq;
    let list: DrawingList;
    try { list = await this.d.list(); } catch { return; }
    if (seq !== this.loadSeq) return;
    const sources: { key: string; data: ArrayBuffer; label: string }[] = [];
    const errors: { key: string; label: string; message: string }[] = [];
    for (const e of list.drawings) {
      try { sources.push({ key: e.pdf, data: await this.d.readBinary(e.pdf), label: e.name }); } catch (err) {
        errors.push({ key: e.pdf, label: e.name, message: `${e.pdf} cannot be read: ${err instanceof Error ? err.message : String(err)}` });
      }
      if (seq !== this.loadSeq) return;
    }
    for (const x of list.errors) errors.push({ key: `err:${x.file}`, label: x.file, message: `${where(x.file, x.line)}: ${x.message}` });
    this.list = list;
    this.byKey = new Map(list.drawings.map((e) => [e.pdf, e]));
    // Auswahl auf ein Blatt, das es nicht mehr gibt: aufheben. Sonst mit den neuen Angaben weiter
    if (this.sel && !this.byKey.has(this.sel.key)) this.select(null);
    this.d.listed(list);
    if (!this.root.hidden && this.root.isConnected) for (const e of list.drawings) this.d.seen(e);
    this.renderHeads();
    this.renderBar();
    await this.pdf.loadSet(sources, errors);
    if (seq !== this.loadSeq) return;
    for (const k of this.overlays.keys()) this.renderOverlay(k);
  }

  private emptyNote(): HTMLElement {
    return el('div', { className: 'dw-empty' },
      el('span', { className: 'ic' }, icon('drawing', 30, 1.4)),
      el('b', { textContent: 'No drawings yet' }),
      el('p', { textContent: 'Ask the agent for a technical drawing, for example “Make a drawing of the bracket with all dimensions for manufacturing.” It writes drawings/*.py and builds the sheets with soma drawing build. They appear here.' }));
  }

  private renderBar(): void {
    const n = this.list.drawings.length;
    const busy = this.list.building || this.building.size > 0;
    const stale = this.list.drawings.filter((e) => e.stale).length;
    this.status.textContent = busy ? 'Building …' : [n ? plural(n, 'sheet') : '', stale ? `${stale} older than the code` : '', this.list.errors.length ? plural(this.list.errors.length, 'error') : ''].filter(Boolean).join(' · ');
    this.status.classList.toggle('warn', !busy && (stale > 0 || this.list.errors.length > 0));
    this.rebuildAll.disabled = busy;
    this.rebuildAll.hidden = !n && !this.list.errors.length;
    this.exportBtn.hidden = !n;
    this.exportBtn.disabled = busy;
    this.note.hidden = busy || !this.list.drawings.some((e) => !e.linked);
  }

  private async rebuild(file: string | null): Promise<void> {
    this.building.add(file ?? '*');
    this.renderBar();
    this.renderHeads();
    let r: { ok: boolean; error?: string };
    try { r = await this.d.build(file ?? undefined); } catch (e) { r = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    this.building.delete(file ?? '*');
    if (!r.ok && r.error) this.d.toast(`The drawings could not be built: ${r.error}`, 'error');
    await this.load();
  }

  // ---- Kopf über jedem Blatt --------------------------------------------------------------------------------------

  private headOf(key: string): HTMLElement {
    let h = this.heads.get(key);
    if (!h) {
      h = el('div', { className: 'dw-head' });
      h.dataset.key = key;
      this.heads.set(key, h);
    }
    this.renderHead(key);
    return h;
  }

  private renderHeads(): void { for (const k of this.heads.keys()) this.renderHead(k); }

  private renderHead(key: string): void {
    const h = this.heads.get(key);
    const e = this.byKey.get(key);
    if (!h) return;
    if (!e) { h.replaceChildren(); return; }
    const btn = (ico: string, title: string, on: () => void, disabled = false) => {
      const b = el('button', { className: 'ibtn s', title, disabled }, icon(ico, 15, 1.9));
      b.setAttribute('aria-label', title);
      b.addEventListener('click', (ev) => { ev.stopPropagation(); on(); });
      return b;
    };
    const busy = this.building.has('*') || (!!e.file && this.building.has(e.file)) || this.list.building;
    const meta = el('span', { className: 'm' }, [e.size, e.scale, plural(e.views.length, 'view'), plural(e.dims.length, 'dimension')].filter(Boolean).join(' · '));
    const tags: HTMLElement[] = [];
    if (this.d.isNew(e)) tags.push(el('span', { className: 'tag acc', textContent: 'new' }));
    if (e.stale) tags.push(el('span', { className: 'tag w', textContent: 'older than the code', title: 'The model or the drawing file changed since this sheet was built. Rebuild it.' }));
    if (e.warnings.length) {
      const w = el('button', { className: 'tag w btn-tag', textContent: plural(e.warnings.length, 'warning'), title: 'Show the warnings of the check' });
      w.setAttribute('aria-expanded', String(this.openWarn.has(key)));
      w.addEventListener('click', (ev) => { ev.stopPropagation(); if (!this.openWarn.delete(key)) this.openWarn.add(key); this.renderHead(key); });
      tags.push(w);
    }
    const ex: HTMLButtonElement = btn('export', `Export “${e.name}” as PDF or DXF`, () => this.openSheetExport(e, ex), busy);
    const row = el('div', { className: 'dw-hrow' },
      el('span', { className: 'dw-name', textContent: e.name, title: where(e.file, e.line) }), meta, ...tags, el('span', { className: 'grow' }),
      e.file ? btn('code', `Open ${where(e.file, e.line)}`, () => this.d.openCode(e.file!, e.line, e.name)) : null,
      e.dxf ? btn('f-draw', `Open ${e.dxf}`, () => this.d.openFile(e.dxf!)) : null,
      ex,
      e.file ? btn('refresh', busy ? 'Building …' : `Build this sheet again (${e.file})`, () => void this.rebuild(e.file), busy) : null,
      btn('send', 'Add this sheet and its warnings to the agent\'s input', () => this.d.insert(this.sheetNote(e))));
    const kids: HTMLElement[] = [row];
    if (this.openWarn.has(key) && e.warnings.length) {
      kids.push(el('div', { className: 'dw-warns' }, ...e.warnings.map((w) => this.warnRow(e, w))));
    }
    h.replaceChildren(...kids);
  }

  private warnRow(e: DrawingEntry, w: DrawingWarning): HTMLElement {
    const r = el('button', { className: 'dw-warn', title: w.file ? `Open ${where(w.file, w.line)}` : '' }, icon('alert', 13, 2), el('span', { textContent: w.message }),
      w.line ? el('span', { className: 'c3', textContent: `line ${w.line}` }) : null);
    r.addEventListener('click', (ev) => { ev.stopPropagation(); if (w.file) this.d.openCode(w.file, w.line, `Warning in “${e.name}”`); });
    r.addEventListener('pointerenter', () => this.flashBox(e.pdf, w.box));
    r.addEventListener('pointerleave', () => this.flashBox(e.pdf, undefined));
    return r;
  }

  // ---- Export ------------------------------------------------------------------------------------------------------

  private openExport(): void {
    const n = this.list.drawings.length;
    const go = (what: 'set' | 'pdf' | 'dxf' | 'both') => () => { menus.close(); void this.d.exportFiles(what); };
    this.d.menu.replaceChildren(
      el('div', { className: 'mh', textContent: `Export ${plural(n, 'sheet')}` }),
      menuItem('All sheets as one PDF …', { icon: 'f-pdf', sub: 'one file', onClick: go('set'), disabled: this.list.errors.length > 0 }),
      menuItem('Each sheet as PDF …', { icon: 'f-pdf', sub: 'into a folder', onClick: go('pdf') }),
      menuItem('Each sheet as DXF …', { icon: 'f-draw', sub: 'into a folder', onClick: go('dxf') }),
      menuItem('PDF and DXF of each sheet …', { icon: 'folder', sub: 'into a folder', onClick: go('both') }));
    menus.toggle(this.d.menu, this.exportBtn, 'right');
  }

  private openSheetExport(e: DrawingEntry, anchor: HTMLElement): void {
    const go = (what: 'pdf' | 'dxf') => () => { menus.close(); void this.d.exportFiles(what, e.id); };
    this.d.menu.replaceChildren(
      el('div', { className: 'mh', textContent: `Export “${e.name}”` }),
      menuItem('PDF …', { icon: 'f-pdf', onClick: go('pdf') }),
      menuItem('DXF …', { icon: 'f-draw', onClick: go('dxf'), disabled: !e.dxf }));
    menus.toggle(this.d.menu, anchor, 'right');
  }

  // ---- Ebene über dem Blatt ---------------------------------------------------------------------------------------

  private overlayOf(key: string): HTMLElement {
    let o = this.overlays.get(key);
    if (!o) {
      o = el('div', { className: 'dw-ov' });
      o.dataset.key = key;
      this.overlays.set(key, o);
    }
    this.renderOverlay(key);
    return o;
  }

  /** Rechteck in Blatt-mm als Lage in Prozent der Seite. */
  private place(node: HTMLElement, e: DrawingEntry, b: number[]): void {
    const [x0, y0, x1, y1] = e.pageBox;
    const w = x1 - x0, h = y1 - y0;
    node.style.left = `${((b[0] - x0) / w) * 100}%`;
    node.style.top = `${((y1 - b[3]) / h) * 100}%`;
    node.style.width = `${((b[2] - b[0]) / w) * 100}%`;
    node.style.height = `${((b[3] - b[1]) / h) * 100}%`;
  }

  private renderOverlay(key: string): void {
    const o = this.overlays.get(key);
    const e = this.byKey.get(key);
    if (!o) return;
    if (!e) { o.replaceChildren(); return; }
    const kids: HTMLElement[] = [];
    // Warnungen mit Ort: kleine gelbe Marken, der Text steht im Kopf
    for (const w of e.warnings) {
      if (!w.box) continue;
      const m = el('div', { className: 'dw-wmark', title: w.message });
      this.place(m, e, w.box);
      kids.push(m);
    }
    const mark = (cls: string, hit: Hit, label: string) => {
      const pad = 1.2; // mm Luft um Maß und Ansicht
      const b = [hit.box[0] - pad, hit.box[1] - pad, hit.box[2] + pad, hit.box[3] + pad];
      const m = el('div', { className: `dw-hit ${cls}` }, el('span', { className: 'dw-tag', textContent: label }));
      if (hit.box[3] > e.pageBox[3] - 12) m.classList.add('below'); // oben am Rand: Schild nach unten
      this.place(m, e, b);
      kids.push(m);
    };
    if (this.sel?.key === key) mark('sel', this.sel.hit, this.hitLabel(this.sel.hit));
    if (this.hover?.key === key && !(this.sel?.key === key && this.sameHit(this.sel.hit, this.hover.hit))) mark('hov', this.hover.hit, this.hitLabel(this.hover.hit));
    if (this.flash?.key === key) { const m = el('div', { className: 'dw-hit flash' }); this.place(m, e, this.flash.box); kids.push(m); }
    o.replaceChildren(...kids);
  }

  private flash: { key: string; box: number[] } | null = null;
  private flashBox(key: string, box: number[] | undefined): void {
    const prev = this.flash?.key;
    this.flash = box ? { key, box } : null;
    if (prev && prev !== key) this.renderOverlay(prev);
    this.renderOverlay(key);
  }

  private hitLabel(h: Hit): string {
    if (h.kind === 'dim') return h.d.label;
    const v = h.v;
    return `${v.kind === 'view' ? v.name : `${KIND[v.kind] ?? v.kind} ${v.name}`} · ${v.scale}`;
  }

  private sameHit(a: Hit, b: Hit): boolean {
    return a.kind === b.kind && (a.kind === 'dim' ? a.d === (b as typeof a).d : a.v === (b as Extract<Hit, { kind: 'view' }>).v);
  }

  /** Was liegt an diesem Punkt des Blatts (mm)? Maße vor Ansichten, kleinere vor größeren. */
  private hitAt(e: DrawingEntry, x: number, y: number): Hit | null {
    let best: Hit | null = null;
    for (const d of e.dims) {
      // Nur die Maßzahl: Maß- und Hilfslinien liegen oft über anderen Maßen und über der Ansicht
      const b = d.textBox ?? d.box;
      if (!b || !inside(b, x, y, 0.5)) continue;
      if (!best || area(b) < area(best.box)) best = { kind: 'dim', d, box: b };
    }
    if (best) return best;
    for (const v of e.views) {
      if (!inside(v.bbox, x, y, 2)) continue;
      if (!best || area(v.bbox) < area(best.box)) best = { kind: 'view', v, box: v.bbox };
    }
    return best;
  }

  /** Blatt und Punkt in mm unter dem Zeiger. */
  private sheetAt(ev: MouseEvent): { key: string; e: DrawingEntry; x: number; y: number } | null {
    const page = (ev.target as HTMLElement | null)?.closest?.('.pdf-page');
    const o = page?.querySelector<HTMLElement>('.dw-ov');
    const key = o?.dataset.key;
    const e = key ? this.byKey.get(key) : undefined;
    if (!o || !key || !e) return null;
    const r = o.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return null;
    const [x0, y0, x1, y1] = e.pageBox;
    const fx = (ev.clientX - r.left) / r.width, fy = (ev.clientY - r.top) / r.height;
    if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return null;
    return { key, e, x: x0 + fx * (x1 - x0), y: y1 - fy * (y1 - y0) };
  }

  private onMove(ev: PointerEvent): void {
    if (ev.buttons) return; // beim Markieren von Text nichts hervorheben
    const s = this.sheetAt(ev);
    const hit = s ? this.hitAt(s.e, s.x, s.y) : null;
    this.setHover(s && hit ? { key: s.key, hit } : null);
  }

  private setHover(h: { key: string; hit: Hit } | null): void {
    const prev = this.hover;
    if (prev && h && prev.key === h.key && this.sameHit(prev.hit, h.hit)) return;
    this.hover = h;
    if (prev) this.renderOverlay(prev.key);
    if (h && h.key !== prev?.key) this.renderOverlay(h.key);
    this.root.classList.toggle('dw-pointer', !!h);
  }

  private onClick(ev: MouseEvent): void {
    // Nur echte Klicks: Wer Text markiert oder zieht, will nichts auswählen
    const moved = this.down ? Math.hypot(ev.clientX - this.down.x, ev.clientY - this.down.y) > 4 : false;
    if (moved || !document.getSelection()?.isCollapsed) return;
    const s = this.sheetAt(ev);
    if (!s) return;
    const hit = this.hitAt(s.e, s.x, s.y);
    this.select(hit ? { key: s.key, hit } : null);
  }

  /** Ansicht oder Maß auswählen: im Blatt orange, in 3D gezeigt, dazu die Karte unten. */
  select(x: { key: string; hit: Hit } | null): void {
    const prev = this.sel?.key;
    if (!x) {
      if (this.sel) this.d.link.clear();
      this.sel = null;
    } else {
      const e = this.byKey.get(x.key)!;
      const hint = x.hit.kind === 'view' ? this.d.link.showView(e, x.hit.v) : this.d.link.showDim(e, x.hit.d);
      this.sel = { ...x, hint };
    }
    if (prev) this.renderOverlay(prev);
    if (this.sel && this.sel.key !== prev) this.renderOverlay(this.sel.key);
    this.renderCard();
  }

  // ---- Karte zur Auswahl ------------------------------------------------------------------------------------------

  private renderCard(): void {
    const s = this.sel;
    const e = s ? this.byKey.get(s.key) : undefined;
    this.card.hidden = !s || !e;
    if (!s || !e) { this.card.replaceChildren(); return; }
    const h = s.hit;
    let title: string, meta: string, file: string | null, line: number | null;
    if (h.kind === 'view') {
      const v = h.v;
      title = v.kind === 'view' ? `View ${v.name}` : `${KIND[v.kind] ?? v.kind} ${v.name}`;
      meta = [v.scale, v.parts?.length ? v.parts.slice(0, 4).join(', ') + (v.parts.length > 4 ? ' …' : '') : ''].filter(Boolean).join(' · ');
      file = v.file ?? e.file; line = v.line;
    } else {
      const d = h.d;
      title = d.label;
      meta = `${DIM_KIND[d.kind] ?? d.kind} in ${d.view} · measured ${fmt(d.value)}${d.kind === 'angle' ? '°' : ' mm'}`;
      file = d.file ?? e.file; line = d.line;
    }
    const lines: HTMLElement[] = [];
    if (!e.linked) lines.push(el('div', { className: 'dw-cline warn' }, icon('alert', 13, 2), el('span', { textContent: 'Built with an older soma: only the direction is known. Rebuild the drawing to zoom to its parts, cut sections and click dimensions.' })));
    if (e.stale) lines.push(el('div', { className: 'dw-cline warn' }, icon('alert', 13, 2), el('span', { textContent: 'The sheet is older than the code: in 3D it may not match the model.' })));
    if (s.hint) lines.push(el('div', { className: 'dw-cline' }, icon('info', 13, 2), el('span', { textContent: s.hint })));
    const code = el('button', { className: 'btn sm', title: file ? `Open ${where(file, line)}` : '', disabled: !file }, icon('code', 14, 1.9), 'Code');
    code.addEventListener('click', () => { if (file) this.d.openCode(file, line, title); });
    const agent = el('button', { className: 'btn sm acc', title: 'Add this to the agent\'s input' }, icon('send', 14, 1.9), 'Send to agent');
    agent.addEventListener('click', () => this.d.insert(this.hitNote(e, h)));
    const close = el('button', { className: 'ibtn s', title: 'Clear the selection (Escape)' }, icon('x', 14, 2));
    close.setAttribute('aria-label', 'Clear the selection');
    close.addEventListener('click', () => this.select(null));
    this.card.replaceChildren(
      el('div', { className: 'dw-chead' }, el('div', {}, el('div', { className: 't', textContent: title }), el('div', { className: 'm', textContent: `${e.name} · ${meta}` })), close),
      ...lines,
      el('div', { className: 'dw-cacts' }, code, el('span', { className: 'grow' }), agent));
  }

  // ---- Text für den Agenten ---------------------------------------------------------------------------------------

  private sheetNote(e: DrawingEntry): string {
    const warn = e.warnings.length ? `, ${plural(e.warnings.length, 'warning')}: ${e.warnings.map((w) => `${w.message}${w.line ? ` (line ${w.line})` : ''}`).join('; ')}` : '';
    return `[Drawing: "${e.name}" (${where(e.file, e.line) || e.pdf}), ${e.pdf}${e.stale ? ', older than the code' : ''}${warn}] `;
  }

  private hitNote(e: DrawingEntry, h: Hit): string {
    if (h.kind === 'view') {
      const v = h.v;
      return `[Drawing "${e.name}", ${v.kind === 'view' ? 'view' : v.kind} "${v.name}" (${where(v.file ?? e.file, v.line)}), scale ${v.scale}] `;
    }
    const d = h.d;
    return `[Drawing "${e.name}", dimension ${d.label} in view "${d.view}" (${where(d.file ?? e.file, d.line)}), measured ${fmt(d.value)}${d.kind === 'angle' ? '°' : ' mm'}] `;
  }

  // ---- Prüfhilfen -------------------------------------------------------------------------------------------------

  state() {
    return {
      sheets: this.list.drawings.map((e) => ({ name: e.name, stale: e.stale, views: e.views.length, dims: e.dims.length, warnings: e.warnings.length })),
      errors: this.list.errors.length, building: this.list.building,
      heads: [...this.root.querySelectorAll<HTMLElement>('.dw-head')].map((h) => h.textContent),
      hover: this.hover ? this.hitLabel(this.hover.hit) : null,
      selected: this.sel ? { label: this.hitLabel(this.sel.hit), hint: this.sel.hint } : null,
      card: this.card.hidden ? null : this.card.textContent,
      pdf: this.pdf.state(),
    };
  }

  /** Prüfhilfe: Punkt eines Blatts (mm) auf dem Bildschirm, um dorthin zu zeigen oder zu klicken. */
  screenOf(name: string, x: number, y: number): { x: number; y: number } | null {
    const e = this.list.drawings.find((d) => d.name === name);
    const o = e ? this.overlays.get(e.pdf) : undefined;
    if (!e || !o?.isConnected) return null;
    const r = o.getBoundingClientRect();
    const [x0, y0, x1, y1] = e.pageBox;
    return { x: r.left + ((x - x0) / (x1 - x0)) * r.width, y: r.top + ((y1 - y) / (y1 - y0)) * r.height };
  }

  /** Prüfhilfe: zum Blatt springen. */
  goTo(name: string): void {
    const e = this.list.drawings.find((d) => d.name === name);
    if (e) this.pdf.goTo(e.pdf, 1);
  }
}
