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
  if (kind !== 'still' && kind !== 'sheet' && kind !== 'video') return 'Unbekannte Art (still, sheet oder video).';
  const size = Array.isArray(r.size) ? r.size.map(Number) : [];
  if (size.length !== 2 || !size.every((v) => Number.isInteger(v) && v >= 64 && v <= MAX_SIDE)) return `Größe zwischen 64 und ${MAX_SIDE} Pixeln.`;
  const grid = Array.isArray(r.grid) ? r.grid.map(Number) : [3, 3];
  if (grid.length !== 2 || !grid.every((v) => Number.isInteger(v) && v >= 1 && v <= 6)) return 'Übersicht: 1 bis 6 Spalten und Zeilen.';
  const view = r.view == null ? null : String(r.view);
  if (view && !VIEWS.includes(view)) return `Unbekannte Ansicht ${view}.`;
  const at = r.at == null ? 0 : Number(r.at);
  const fps = r.fps == null ? 30 : Number(r.fps);
  if (!Number.isFinite(at) || at < 0) return 'Ungültiger Zeitpunkt.';
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) return 'Bilder je Sekunde zwischen 1 und 60.';
  const file = (v: unknown, dir: string, what: string): string | null | Error => {
    if (v == null) return null;
    const p = String(v).replace(/\\/g, '/');
    if (!p.startsWith(dir) || !p.endsWith('.glb') || p.includes('..')) return new Error(`${what} muss in ${dir} liegen.`);
    try { if (!fs.statSync(resolveInside(root, p)).isFile()) throw new Error(); } catch { return new Error(`${what} ${p} gibt es nicht.`); }
    return p;
  };
  const anim = file(r.anim, '.soma/anim/', 'Die Animation');
  const result = file(r.result, '.soma/results/', 'Das Ergebnis');
  if (anim instanceof Error) return anim.message;
  if (result instanceof Error) return result.message;
  if ((kind === 'sheet' || kind === 'video') && !anim) return 'Übersicht und Video brauchen eine Animation.';
  const out = String(r.out ?? '').replace(/\\/g, '/');
  const ext = kind === 'video' ? '.mp4' : '.png';
  if (!out.toLowerCase().endsWith(ext)) return `Das Ziel muss auf ${ext} enden.`;
  if (/^(\.git|\.soma)(\/|$)/i.test(out) || out.split('/').includes('..') || path.isAbsolute(out)) return 'Das Ziel muss im Projektordner liegen, nicht in .git/ oder .soma/.';
  try { resolveInside(root, out); } catch { return 'Das Ziel liegt nicht im Projektordner.'; }
  return { kind, size: [size[0], size[1]], view, at, grid: [grid[0], grid[1]], fps, anim, result, out };
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
      try { model = read('.soma/model.glb'); } catch { return { ok: false, files: [], warnings: [], error: 'Noch kein gebautes Modell (soma build).' }; }
      const id = this.nextId++;
      const [w, h] = req.kind === 'video' ? [req.size[0] & ~1, req.size[1] & ~1] : req.size; // H.264 braucht gerade Maße
      const job: RenderJob = {
        id, kind: req.kind, width: w, height: h, view: req.view, at: req.at, grid: req.grid, fps: req.fps,
        model, anim: req.anim ? read(req.anim) : null, result: req.result ? read(req.result) : null,
      };
      const win = await this.window();
      const timeoutMs = req.kind === 'video' ? 20 * 60_000 : 2 * 60_000;
      const out = await new Promise<RenderOutput>((resolve) => {
        const timer = setTimeout(() => { this.waiting.delete(id); resolve({ ok: false, error: 'Zeitlimit beim Rendern überschritten.' }); }, timeoutMs);
        this.waiting.set(id, { resolve: (o) => { clearTimeout(timer); resolve(o); }, progress });
        win.webContents.send('render:job', job);
      });
      if (!out.ok) return { ok: false, files: [], warnings: out.warnings ?? [], error: out.error ?? 'Rendern fehlgeschlagen.' };
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
        if (!out.mp4) return { ok: false, files: [], warnings: [], error: 'Das Video ist leer.' };
        write(req.out, out.mp4);
        const stem = req.out.replace(/\.mp4$/i, '');
        if (out.vtt) write(`${stem}.vtt`, out.vtt);
        if (out.sheet) write(`${stem}-uebersicht.png`, out.sheet);
      } else {
        if (!out.png) return { ok: false, files: [], warnings: [], error: 'Das Bild ist leer.' };
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
      console.error(`[soma] Render-Fenster beendet: ${d.reason}`);
      for (const [, w] of this.waiting) w.resolve({ ok: false, error: `Das Render-Fenster ist abgestürzt (${d.reason}).` });
      this.waiting.clear();
      this.close();
    });
    this.ready = new Promise<void>((resolve, reject) => {
      const onReady = (e: Electron.IpcMainEvent) => { if (e.sender === win.webContents) { ipcMain.removeListener('render:ready', onReady); resolve(); } };
      ipcMain.on('render:ready', onReady);
      win.webContents.once('did-fail-load', (_e, code, desc) => { ipcMain.removeListener('render:ready', onReady); reject(new Error(`Render-Fenster lädt nicht: ${desc} (${code})`)); });
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
