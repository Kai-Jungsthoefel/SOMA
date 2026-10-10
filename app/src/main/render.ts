import { BrowserWindow, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { RenderJob, RenderOutput, RenderResult } from '../shared/types';
import { resolveInside } from './files';

/**
 * Bilder und Videos des Modells (E58): ein unsichtbares Fenster mit demselben Viewer wie auf dem Bildschirm. Es entsteht
 * beim ersten Auftrag und schließt sich nach einer Minute ohne Arbeit wieder (ein Renderer-Prozess kostet Speicher).
 * Aufträge laufen nacheinander. Auftraggeber sind `soma render` im Terminal (über bridge.ts) und Knöpfe der App.
 */
export interface RenderRequest {
  kind: 'still' | 'sheet' | 'video';
  size: [number, number];
  view: string | null;
  /** Freie Blickrichtung statt `view`, Namen von Teilen oder Gruppen (aufgelöst im Render-Fenster), Zoom (1: eingepasst). */
  dir: [number, number, number] | null;
  hide: string[];
  only: string[];
  fit: string[];
  zoom: number;
  at: number;
  grid: [number, number];
  fps: number;
  /** Dateien im Projekt (relativ): Animation (.soma/anim/…glb), Ergebnis (.soma/results/…glb), Ziel. */
  anim: string | null;
  result: string | null;
  out: string;
}

const VIEWS = ['iso', 'front', 'back', 'left', 'right', 'top', 'bottom'];
const MAX_SIDE = 3840;
const IDLE_MS = 60_000;

/** Prüft einen Auftrag von außen (Terminal) und bringt ihn auf die erwartete Form. Fehler als Text. */
export function checkRequest(root: string, raw: unknown): RenderRequest | string {
  const r = (raw ?? {}) as Record<string, unknown>;
  const kind = r.kind;
  if (kind !== 'still' && kind !== 'sheet' && kind !== 'video') return 'Unknown kind (still, sheet or video).';
  const size = Array.isArray(r.size) ? r.size.map(Number) : [];
  if (size.length !== 2 || !size.every((v) => Number.isInteger(v) && v >= 64 && v <= MAX_SIDE)) return `Size between 64 and ${MAX_SIDE} pixels.`;
  const grid = Array.isArray(r.grid) ? r.grid.map(Number) : [3, 3];
  if (grid.length !== 2 || !grid.every((v) => Number.isInteger(v) && v >= 1 && v <= 6)) return 'Contact sheet: 1 to 6 columns and rows.';
  const view = r.view == null ? null : String(r.view);
  if (view && !VIEWS.includes(view)) return `Unknown view ${view}.`;
  const dir = r.dir == null ? null : Array.isArray(r.dir) ? r.dir.map(Number) : [];
  if (dir && (dir.length !== 3 || !dir.every(Number.isFinite) || Math.hypot(...dir) < 1e-9)) return 'The view direction needs three numbers, not all zero.';
  const names = (v: unknown, what: string): string[] | Error => {
    if (v == null) return [];
    if (!Array.isArray(v) || v.length > 500 || !v.every((x) => typeof x === 'string' && x.trim() && x.length <= 300)) return new Error(`${what}: a list of part or group names.`);
    return v as string[];
  };
  const hide = names(r.hide, 'Hide'), only = names(r.only, 'Only'), fit = names(r.fit, 'Fit');
  for (const x of [hide, only, fit]) if (x instanceof Error) return x.message;
  const zoom = r.zoom == null ? 1 : Number(r.zoom);
  if (!Number.isFinite(zoom) || zoom < 0.05 || zoom > 50) return 'Zoom between 0.05 and 50.';
  const at = r.at == null ? 0 : Number(r.at);
  const fps = r.fps == null ? 30 : Number(r.fps);
  if (!Number.isFinite(at) || at < 0) return 'Invalid time.';
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) return 'Frames per second between 1 and 60.';
  const file = (v: unknown, dir: string, what: string): string | null | Error => {
    if (v == null) return null;
    const p = String(v).replace(/\\/g, '/');
    if (!p.startsWith(dir) || !p.endsWith('.glb') || p.includes('..')) return new Error(`${what} must be in ${dir}.`);
    try { if (!fs.statSync(resolveInside(root, p)).isFile()) throw new Error(); } catch { return new Error(`${what} ${p} does not exist.`); }
    return p;
  };
  const anim = file(r.anim, '.soma/anim/', 'The animation');
  const result = file(r.result, '.soma/results/', 'The result');
  if (anim instanceof Error) return anim.message;
  if (result instanceof Error) return result.message;
  if ((kind === 'sheet' || kind === 'video') && !anim) return 'Contact sheet and video need an animation.';
  const out = String(r.out ?? '').replace(/\\/g, '/');
  const ext = kind === 'video' ? '.mp4' : '.png';
  if (!out.toLowerCase().endsWith(ext)) return `The target must end in ${ext}.`;
  if (/^(\.git|\.soma)(\/|$)/i.test(out) || out.split('/').includes('..') || path.isAbsolute(out)) return 'The target must be in the project folder, not in .git/ or .soma/.';
  try { resolveInside(root, out); } catch { return 'The target is not in the project folder.'; }
  return { kind, size: [size[0], size[1]], view, dir: dir as [number, number, number] | null, hide: hide as string[], only: only as string[], fit: fit as string[], zoom, at, grid: [grid[0], grid[1]], fps, anim, result, out };
}

export class RenderService {
  private win: BrowserWindow | null = null;
  private ready: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private idle: NodeJS.Timeout | undefined;
  private nextId = 1;
  private waiting = new Map<number, { resolve: (o: RenderOutput) => void; progress?: (f: number) => void }>();

  constructor() {
    ipcMain.on('render:done', (e, id: number, out: RenderOutput) => {
      if (e.sender !== this.win?.webContents) return;
      this.waiting.get(id)?.resolve(out);
      this.waiting.delete(id);
    });
    ipcMain.on('render:progress', (e, id: number, f: number) => {
      if (e.sender === this.win?.webContents && Number.isFinite(f)) this.waiting.get(id)?.progress?.(f);
    });
  }

  /** Auftrag ausführen, nach den laufenden. Schreibt die Dateien ins Projekt und gibt ihre Pfade zurück. */
  run(dir: string, req: RenderRequest, progress?: (f: number) => void): Promise<RenderResult> {
    const p = this.queue.then(() => this.execute(dir, req, progress));
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async execute(dir: string, req: RenderRequest, progress?: (f: number) => void): Promise<RenderResult> {
    clearTimeout(this.idle);
    try {
      const read = (rel: string) => { const b = fs.readFileSync(resolveInside(dir, rel)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer; };
      let model: ArrayBuffer;
      try { model = read('.soma/model.glb'); } catch { return { ok: false, files: [], warnings: [], error: 'No built model yet (soma build).' }; }
      const id = this.nextId++;
      const [w, h] = req.kind === 'video' ? [req.size[0] & ~1, req.size[1] & ~1] : req.size; // H.264 braucht gerade Maße
      const job: RenderJob = {
        id, kind: req.kind, width: w, height: h, view: req.view, at: req.at, grid: req.grid, fps: req.fps,
        dir: req.dir, hide: req.hide, only: req.only, fit: req.fit, zoom: req.zoom,
        model, anim: req.anim ? read(req.anim) : null, result: req.result ? read(req.result) : null,
      };
      const win = await this.window();
      const timeoutMs = req.kind === 'video' ? 20 * 60_000 : 2 * 60_000;
      const out = await new Promise<RenderOutput>((resolve) => {
        const timer = setTimeout(() => { this.waiting.delete(id); resolve({ ok: false, error: 'Time limit exceeded while rendering.' }); }, timeoutMs);
        this.waiting.set(id, { resolve: (o) => { clearTimeout(timer); resolve(o); }, progress });
        win.webContents.send('render:job', job);
      });
      if (!out.ok) return { ok: false, files: [], warnings: out.warnings ?? [], error: out.error ?? 'Rendering failed.' };
      const files: string[] = [];
      const write = (rel: string, data: ArrayBuffer | string) => {
        const abs = resolveInside(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        // Erst vollständig schreiben, dann ersetzen: Ein Player, der die alte Datei offen hat, sieht nie eine halbe
        const tmp = `${abs}.part`;
        fs.writeFileSync(tmp, typeof data === 'string' ? data : Buffer.from(data));
        fs.renameSync(tmp, abs);
        files.push(rel);
      };
      if (req.kind === 'video') {
        if (!out.mp4) return { ok: false, files: [], warnings: [], error: 'The video is empty.' };
        write(req.out, out.mp4);
        const stem = req.out.replace(/\.mp4$/i, '');
        if (out.vtt) write(`${stem}.vtt`, out.vtt);
        if (out.sheet) write(`${stem}-sheet.png`, out.sheet);
      } else {
        if (!out.png) return { ok: false, files: [], warnings: [], error: 'The image is empty.' };
        write(req.out, out.png);
      }
      return { ok: true, files, warnings: out.warnings ?? [] };
    } catch (e) {
      return { ok: false, files: [], warnings: [], error: e instanceof Error ? e.message : String(e) };
    } finally {
      clearTimeout(this.idle);
      this.idle = setTimeout(() => this.close(), IDLE_MS);
    }
  }

  private window(): Promise<BrowserWindow> {
    if (this.win && !this.win.isDestroyed() && this.ready) return this.ready.then(() => this.win!);
    const win = new BrowserWindow({
      show: false, width: 1280, height: 800, title: 'SOMA Render',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'render-preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false,
      },
    });
    this.win = win;
    win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) console.error(`[render] ${message}`); });
    win.webContents.on('render-process-gone', (_e, d) => {
      console.error(`[soma] Render window ended: ${d.reason}`);
      for (const [, w] of this.waiting) w.resolve({ ok: false, error: `The render window crashed (${d.reason}).` });
      this.waiting.clear();
      this.close();
    });
    this.ready = new Promise<void>((resolve, reject) => {
      const onReady = (e: Electron.IpcMainEvent) => { if (e.sender === win.webContents) { ipcMain.removeListener('render:ready', onReady); resolve(); } };
      ipcMain.on('render:ready', onReady);
      win.webContents.once('did-fail-load', (_e, code, desc) => { ipcMain.removeListener('render:ready', onReady); reject(new Error(`Render window does not load: ${desc} (${code})`)); });
    });
    // Lädt es nicht, beim nächsten Auftrag ein neues versuchen statt ewig am alten zu scheitern
    this.ready.catch(() => { if (this.win === win) this.close(); });
    void win.loadFile(path.join(__dirname, '..', 'renderer', 'render.html'));
    return this.ready.then(() => win);
  }

  close(): void {
    clearTimeout(this.idle);
    const w = this.win;
    this.win = null;
    this.ready = null;
    if (w && !w.isDestroyed()) w.destroy();
  }
}
