import fs from 'node:fs';
import path from 'node:path';
import type { DrawingBuildResult, DrawingDim, DrawingEntry, DrawingFileError, DrawingList, DrawingView, DrawingWarning } from '../shared/types';
import { newestSourceMtime, runSoma } from './build';
import { resolveInside } from './files';

// Technische Zeichnungen (E76) für das Dokument „Drawings“. Gebaut wird in Python (`soma drawing build`), die App liest nur
// .soma/drawings/index.json. Der Index kommt aus dem Projekt, also wird jedes Feld geprüft, bevor es zum Renderer geht.

const mtime = (f: string) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown, max = 400): string | null => (typeof v === 'string' ? v.slice(0, max) : null);
/** Zahlenliste fester Länge (Punkte, Richtungen, Rechtecke), sonst undefined. */
const vec = (v: unknown, n: number): number[] | undefined =>
  Array.isArray(v) && v.length === n && v.every((x) => num(x) !== null) ? (v as number[]).map(Number) : undefined;
const line = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null);

function view(raw: unknown): DrawingView | null {
  const v = raw as Record<string, unknown>;
  const name = str(v?.name, 200), bbox = vec(v?.bbox, 4), direction = vec(v?.direction, 3);
  if (!name || !bbox || !direction) return null;
  const out: DrawingView = { name, kind: str(v.kind, 40) ?? 'view', scale: str(v.scale, 40) ?? '', line: line(v.line), file: str(v.file), direction, bbox };
  if (Array.isArray(v.parts)) out.parts = v.parts.filter((p): p is string => typeof p === 'string').slice(0, 500);
  out.right = vec(v.right, 3);
  out.up = vec(v.up, 3);
  out.center = vec(v.center, 3);
  out.size = num(v.size) ?? undefined;
  const s = v.section as Record<string, unknown> | undefined;
  if (s && typeof s === 'object') out.section = { kind: str(s.kind, 40) ?? '', point: vec(s.point, 3), normal: vec(s.normal, 3) };
  const d = v.detail as Record<string, unknown> | undefined;
  const dc = vec(d?.center, 3), dr = num(d?.radius);
  if (dc && dr) out.detail = { center: dc, radius: dr, parent: str(d!.parent, 200) ?? '' };
  return out;
}

function dim(raw: unknown): DrawingDim | null {
  const d = raw as Record<string, unknown>;
  const value = num(d?.value), viewName = str(d?.view, 200);
  if (value === null || !viewName) return null;
  const points = Array.isArray(d.points) ? d.points.map((p) => vec(p, 3)).filter((p): p is number[] => !!p) : undefined;
  return {
    // soma setzt die Beschriftung für den Agenten in Anführungszeichen ("4x Ø8"), auf dem Blatt stehen keine
    kind: str(d.kind, 40) ?? 'linear', value, label: (str(d.label, 200) ?? str(d.text, 200) ?? String(value)).replace(/^"(.*)"$/s, '$1'), view: viewName,
    line: line(d.line), file: str(d.file), points: points?.length ? points : undefined, radius: num(d.radius),
    box: vec(d.box, 4), textBox: vec(d.text_box, 4),
  };
}

function warning(raw: unknown): DrawingWarning | null {
  const w = raw as Record<string, unknown>;
  const message = str(w?.message, 2000);
  return message ? { message, file: str(w.file), line: line(w.line), box: vec(w.box, 4) } : null;
}

/** Liste aus .soma/drawings/index.json. Veraltet: Modell oder Zeichnungsdatei neuer als die PDF. */
export function readDrawingList(dir: string, building = false): DrawingList {
  let idx: { version?: unknown; drawings?: unknown[]; errors?: unknown[] } = {};
  try { idx = JSON.parse(fs.readFileSync(path.join(dir, '.soma', 'drawings', 'index.json'), 'utf8')); } catch { /* noch nichts gebaut */ }
  const model = newestSourceMtime(dir);
  const drawings: DrawingEntry[] = [];
  for (const raw of Array.isArray(idx.drawings) ? idx.drawings : []) {
    const e = raw as Record<string, unknown>;
    const id = str(e.id, 200), name = str(e.name, 200), pdf = str(e.pdf), width = num(e.width), height = num(e.height);
    if (!id || !name || !pdf || !width || !height || width <= 0 || height <= 0) continue;
    // Nur PDFs, die soma selbst ablegt: output/drawings/<id>.pdf
    if (!/^output\/drawings\/[^/]+\.pdf$/i.test(pdf)) continue;
    let pdfAbs: string, src: string | null = null;
    try { pdfAbs = resolveInside(dir, pdf); } catch { continue; }
    const file = str(e.file);
    if (file) try { src = resolveInside(dir, file); } catch { src = null; }
    const built = mtime(pdfAbs);
    if (!built) continue;
    const dxf = str(e.dxf);
    drawings.push({
      id, name, file: file && src ? file : null, line: line(e.line), size: str(e.size, 40) ?? '', width, height, scale: str(e.scale, 40) ?? '',
      pdf, dxf: dxf && /^output\/drawings\/[^/]+\.dxf$/i.test(dxf) ? dxf : null,
      pageBox: vec(e.page_box, 4) ?? [0, 0, width, height],
      views: (Array.isArray(e.views) ? e.views : []).map(view).filter((x): x is DrawingView => !!x),
      dims: (Array.isArray(e.dims) ? e.dims : []).map(dim).filter((x): x is DrawingDim => !!x),
      warnings: (Array.isArray(e.warnings) ? e.warnings : []).map(warning).filter((x): x is DrawingWarning => !!x),
      built, stale: Math.max(model, src ? mtime(src) : 0) > built, linked: Number(idx.version) >= 2,
    });
  }
  // Fehler gelöschter Dateien gelten nicht mehr (der Index wird erst beim nächsten Bauen bereinigt)
  const exists = (rel: string) => { try { return fs.existsSync(resolveInside(dir, rel)); } catch { return false; } };
  const errors: DrawingFileError[] = (Array.isArray(idx.errors) ? idx.errors : []).map((x) => x as Record<string, unknown>)
    .filter((x) => typeof x.file === 'string' && typeof x.message === 'string' && exists(x.file))
    .map((x) => ({ file: x.file as string, line: line(x.line), message: (x.message as string).slice(0, 4000) }));
  return { drawings, errors, building };
}

/** Eine Zeichnungsdatei (drawings/x.py)? Nur solche baut die App einzeln. */
export const isDrawingFile = (rel: string) => /^drawings\/[^/]+\.py$/i.test(rel.replace(/\\/g, '/'));

/**
 * Baut Zeichnungen auf Wunsch im Hintergrund, einen Lauf nach dem anderen. Kommt während eines Laufs ein weiterer Wunsch,
 * folgt genau ein weiterer (für alle, wenn einer alle wollte), wie bei den Animationen.
 */
export class DrawingBuilder {
  private running: Promise<DrawingBuildResult> | null = null;
  private pending: Set<string> | 'all' | null = null;
  private disposed = false;

  constructor(private readonly dir: string, private readonly changed: () => void) {}

  get busy(): boolean { return this.running !== null; }

  request(file: string | null): Promise<DrawingBuildResult> {
    if (this.running) {
      if (file === null || this.pending === 'all') this.pending = 'all';
      else { const p = this.pending ?? new Set<string>(); p.add(file); this.pending = p; }
      return this.running.then(() => this.running ?? Promise.resolve({ ...readDrawingList(this.dir), ok: true }));
    }
    this.running = this.run(file === null ? null : [file]);
    return this.running;
  }

  private async run(files: string[] | null): Promise<DrawingBuildResult> {
    this.changed();
    let res: DrawingBuildResult;
    try {
      const errors: string[] = [];
      for (const f of files ?? [null]) {
        // Fehler einzelner Zeichnungen stehen im Index. Ohne JSON-Antwort ging gar nichts (etwa: das Modell baut nicht).
        const r = await runSoma(['drawing', 'build', ...(f ? [f] : []), '--project', this.dir, '--json'], this.dir, 10 * 60 * 1000);
        if (!r.out.trim().startsWith('{')) errors.push((r.err || r.out).trim().split(/\r?\n/).slice(-3).join('\n') || 'soma drawing build returned no result');
      }
      res = { ...readDrawingList(this.dir), ok: errors.length === 0, ...(errors.length ? { error: errors.join('\n') } : {}) };
    } catch (e) {
      res = { ...readDrawingList(this.dir), ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const next = this.pending;
    this.pending = null;
    this.running = next && !this.disposed ? this.run(next === 'all' ? null : [...next]) : null;
    if (!this.running) this.changed();
    return res;
  }

  dispose(): void { this.disposed = true; this.pending = null; }
}
