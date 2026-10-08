import fs from 'node:fs';
import path from 'node:path';
import type { AnimBuildResult, AnimEntry, AnimFileError, AnimList, ResultEntry, ResultMeta } from '../shared/types';
import { newestSourceMtime, runSoma } from './build';
import { resolveInside } from './files';

// Animationen und Ergebnisse im Projekt (E58). Gebaut und ausgewertet wird in Python (`soma anim build`, `soma analyze`),
// die App liest nur deren Dateien: .soma/anim/index.json und die JSON-Teile der GLB-Dateien.

/** JSON-Teil einer GLB-Datei, ohne die Binärdaten zu lesen. */
export function readGlbJson(file: string): Record<string, unknown> | null {
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(20);
    if (fs.readSync(fd, head, 0, 20, 0) < 20 || head.readUInt32LE(0) !== 0x46546c67 || head.readUInt32LE(16) !== 0x4e4f534a) return null;
    const len = head.readUInt32LE(12);
    if (len > 64 * 1024 * 1024) return null;
    const js = Buffer.alloc(len);
    fs.readSync(fd, js, 0, len, 20);
    return JSON.parse(js.toString('utf8')) as Record<string, unknown>;
  } catch { return null; } finally { if (fd !== null) fs.closeSync(fd); }
}

const mtime = (f: string) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };

/** Liste aus .soma/anim/index.json. Veraltet: Modell oder Animationsdatei neuer als die gebaute Datei. */
export function readAnimList(dir: string, building = false): AnimList {
  let idx: { animations?: unknown[]; errors?: unknown[] } = {};
  try { idx = JSON.parse(fs.readFileSync(path.join(dir, '.soma', 'anim', 'index.json'), 'utf8')); } catch { /* noch nichts gebaut */ }
  const model = newestSourceMtime(dir);
  const animations: AnimEntry[] = [];
  for (const raw of Array.isArray(idx.animations) ? idx.animations : []) {
    const a = raw as Partial<AnimEntry>;
    if (typeof a.id !== 'string' || typeof a.name !== 'string' || typeof a.glb !== 'string' || typeof a.file !== 'string') continue;
    let glb: string, src: string;
    try { glb = resolveInside(dir, a.glb); src = resolveInside(dir, a.file); } catch { continue; }
    if (!a.glb.startsWith('.soma/anim/') || !fs.existsSync(glb)) continue;
    const built = mtime(glb);
    animations.push({ id: a.id, name: a.name, file: a.file, line: typeof a.line === 'number' ? a.line : null, duration: Number(a.duration) || 0,
      glb: a.glb, parts: Number(a.parts) || 0, stale: Math.max(model, mtime(src)) > built });
  }
  // Fehler gelöschter Dateien gelten nicht mehr (der Index wird erst beim nächsten Bauen bereinigt)
  const exists = (rel: string) => { try { return fs.existsSync(resolveInside(dir, rel)); } catch { return false; } };
  const errors: AnimFileError[] = (Array.isArray(idx.errors) ? idx.errors : []).map((e) => e as Partial<AnimFileError>)
    .filter((e) => typeof e.file === 'string' && typeof e.message === 'string' && exists(e.file))
    .map((e) => ({ file: e.file!, line: typeof e.line === 'number' ? e.line : null, message: e.message! }));
  return { animations, errors, building };
}

/** Dateien in animations/, die (noch) nicht im Index stehen. */
export function unbuiltAnimFiles(dir: string, list: AnimList): string[] {
  let files: string[] = [];
  try { files = fs.readdirSync(path.join(dir, 'animations')).filter((f) => f.endsWith('.py') && !f.startsWith('_')).map((f) => `animations/${f}`); } catch { return []; }
  const known = new Set([...list.animations.map((a) => a.file), ...list.errors.map((e) => e.file)]);
  return files.filter((f) => !known.has(f));
}

/**
 * Baut Animationen im Hintergrund, eine nach der anderen. Kommt während eines Laufs ein weiterer Wunsch, folgt genau ein
 * weiterer Lauf (für alle gewünschten Dateien), wie beim Modell (E20).
 */
export class AnimBuilder {
  private running: Promise<AnimBuildResult> | null = null;
  private pending: Set<string> | 'all' | null = null;
  private disposed = false;

  constructor(private readonly dir: string, private readonly changed: () => void) {}

  get busy(): boolean { return this.running !== null; }

  /** `file`: animations/x.py, null: alle. Liefert das Ergebnis des Laufs, der diesen Wunsch enthält. */
  request(file: string | null): Promise<AnimBuildResult> {
    if (this.running) {
      if (file === null || this.pending === 'all') this.pending = 'all';
      else { const p = this.pending ?? new Set<string>(); p.add(file); this.pending = p; }
      return this.running.then(() => this.running ?? Promise.resolve(readAnimList(this.dir) as AnimBuildResult));
    }
    this.running = this.run(file === null ? null : [file]);
    return this.running;
  }

  private async run(files: string[] | null): Promise<AnimBuildResult> {
    this.changed();
    let res: AnimBuildResult;
    try {
      const errors: string[] = [];
      for (const f of files ?? [null]) {
        const r = await runSoma(['anim', 'build', ...(f ? [f] : []), '--project', this.dir, '--json'], this.dir, 5 * 60 * 1000);
        if (!r.out.trim().startsWith('{')) errors.push((r.err || r.out).trim().split(/\r?\n/).slice(-3).join('\n') || 'soma anim build returned no result');
      }
      res = { ...readAnimList(this.dir), ok: errors.length === 0, ...(errors.length ? { error: errors.join('\n') } : {}) };
    } catch (e) {
      res = { ...readAnimList(this.dir), ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const next = this.pending;
    this.pending = null;
    this.running = next && !this.disposed ? this.run(next === 'all' ? null : [...next]) : null;
    if (!this.running) this.changed();
    return res;
  }

  dispose(): void { this.disposed = true; this.pending = null; }
}

const KINDS = new Set(['overhang', 'thickness', 'clearance', 'fem']);
/** Lastfall einer FEM-Studie: eine Python-Datei im Projekt (kommt aus der Ergebnisdatei, also prüfen). */
const STUDY = /^[\p{L}\p{N}_./ -]{1,200}\.py$/u;

/** Ergebnisse in .soma/results/. Veraltet: Der Code ist neuer als die Auswertung. */
export function listResults(dir: string): ResultEntry[] {
  const out: ResultEntry[] = [];
  let files: string[] = [];
  try { files = fs.readdirSync(path.join(dir, '.soma', 'results')).filter((f) => f.endsWith('.glb')).sort(); } catch { return out; }
  const model = newestSourceMtime(dir);
  for (const f of files) {
    const meta = (readGlbJson(path.join(dir, '.soma', 'results', f))?.extras as { soma_result?: ResultMeta } | undefined)?.soma_result;
    if (!meta || typeof meta.id !== 'string' || !Array.isArray(meta.range)) continue;
    // FEM: auch die Datei mit dem Lastfall zählt (analyses/ gehört nicht zu den Quellen des Modells)
    let newest = model;
    const study = meta.fem?.study;
    if (typeof study === 'string' && STUDY.test(study)) try { newest = Math.max(newest, mtime(resolveInside(dir, study))); } catch { /* außerhalb: zählt nicht */ }
    out.push({ ...meta, file: `.soma/results/${f}`, stale: newest > (Number(meta.created) || 0) * 1000 });
  }
  return out;
}

/**
 * Dieselbe Auswertung noch einmal. Die Angaben stammen aus der Datei im Projekt, also nicht vertrauenswürdig: nur die
 * bekannten Auswertungen und Schalter, Werte ohne Leerzeichen-Tricks (es gibt ohnehin keine Shell dazwischen).
 */
export async function rerunResult(dir: string, id: string): Promise<{ ok: boolean; error?: string }> {
  const r = listResults(dir).find((x) => x.id === id);
  if (!r) return { ok: false, error: `No result “${id}”.` };
  const cmd = Array.isArray(r.command) ? r.command.map(String) : [];
  if (cmd[0] !== 'analyze' || !KINDS.has(cmd[1])) return { ok: false, error: 'Unknown analysis in the file.' };
  const args = ['analyze', cmd[1]];
  let rest = cmd.slice(2);
  if (cmd[1] === 'fem') {
    // Die Datei mit dem Lastfall: relativ, im Projekt, eine .py-Datei
    const study = rest[0] ?? '';
    if (!STUDY.test(study) || study.startsWith('-') || study.includes('..')) return { ok: false, error: `Unexpected study in the file: ${study.slice(0, 60)}` };
    try { resolveInside(dir, study); } catch { return { ok: false, error: 'The study is outside the project.' }; }
    args.push(study);
    rest = rest.slice(1);
  }
  for (const a of rest) {
    // Immer als --schalter=wert: Werte wie -z oder -0.5 sind dann keine Schalter für argparse
    const m = /^(--parts|--threshold|--up|--name)=(.{1,400})$/s.exec(a);
    if (!m) return { ok: false, error: `Unexpected argument in the file: ${a.slice(0, 60)}` };
    args.push(a);
  }
  const res = await runSoma([...args, '--project', dir, '--json'], dir, 5 * 60 * 1000);
  if (res.ok) return { ok: true };
  return { ok: false, error: (res.err || res.out).trim().split(/\r?\n/).slice(-3).join('\n') || 'Analysis failed' };
}

/** Gleicher Ordner? Unter Windows ohne Groß- und Kleinschreibung, Kurznamen (NAME~1) aufgelöst. */
export function samePath(a: string, b: string): boolean {
  try {
    const ra = fs.realpathSync.native(a), rb = fs.realpathSync.native(b);
    return process.platform === 'win32' ? ra.toLowerCase() === rb.toLowerCase() : ra === rb;
  } catch { return false; }
}
