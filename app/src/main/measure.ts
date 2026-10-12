import { spawn, type ChildProcess } from 'node:child_process';
import type { MeasurePrepared, MeasureRequest, MeasureResponse } from '../shared/types';
import { pythonExe } from './paths';

const START_TIMEOUT_MS = 60_000; // cadquery zu laden dauert beim ersten Mal einige Sekunden
const REQUEST_TIMEOUT_MS = 30_000;
const PREPARE_TIMEOUT_MS = 600_000; // große Baugruppen: Das BREP zu lesen kann Minuten dauern

interface Pending { resolve: (r: MeasureResponse) => void; timer: NodeJS.Timeout }

/**
 * Langlebiger Python-Dienst pro Projekt für exakte Messungen (E24): `python -m soma serve`, JSON-Zeilen über
 * stdin/stdout. Er startet erst mit dem Messmodus (cadquery zu laden kostet Sekunden) und bleibt dann offen.
 * Stürzt er ab, gilt die laufende Anfrage als fehlgeschlagen, die nächste startet ihn neu. Fehler sind Ergebnisse,
 * keine Ausnahmen: Die Oberfläche zeigt sie an.
 */
export class MeasureService {
  private proc: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<number, Pending>();
  private seq = 0;
  private buf = '';
  private disposed = false;

  constructor(private readonly cwd: string) {}

  request(folder: string, req: MeasureRequest): Promise<MeasureResponse> {
    return this.send({ ...req, folder }, REQUEST_TIMEOUT_MS);
  }

  /** Den Dienst starten, ohne etwas zu messen (der Messmodus startet ihn beim Einschalten). */
  async warm(): Promise<MeasurePrepared> {
    if (this.disposed) return { ok: false, error: 'The model is closed.' };
    try { await this.start(); return { ok: true }; }
    catch (e) { return { ok: false, error: `Could not start the measuring service: ${e instanceof Error ? e.message : String(e)}` }; }
  }

  /** Einen Stand vorab laden. Der Dienst arbeitet der Reihe nach: Messungen danach warten, bis er geladen ist. */
  async prepare(folder: string, build: string): Promise<MeasurePrepared> {
    const r = await this.send({ prepare: true, build, folder }, PREPARE_TIMEOUT_MS);
    return { ok: r.ok, error: r.error, stale: r.stale, rebuilt: r.rebuilt };
  }

  private async send(payload: Record<string, unknown>, timeoutMs: number): Promise<MeasureResponse> {
    const warm = await this.warm();
    if (!warm.ok) return warm;
    const proc = this.proc;
    if (!proc?.stdin) return { ok: false, error: 'The measuring service is not running.' };
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, error: 'The measuring service does not answer (time limit).' }); }, timeoutMs);
      this.pending.set(id, { resolve, timer });
      proc.stdin!.write(JSON.stringify({ ...payload, id }) + '\n');
    });
  }

  stop(): void {
    this.disposed = true;
    this.proc?.kill();
    this.fail('The model is closed.');
  }

  private start(): Promise<void> {
    if (this.proc && this.ready) return this.ready;
    this.buf = '';
    const child = spawn(pythonExe(), ['-m', 'soma', 'serve'], {
      cwd: this.cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    });
    this.proc = child;
    let err = '';
    this.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('Time limit at start')); child.kill(); }, START_TIMEOUT_MS);
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (d: string) => {
        this.buf += d;
        let nl: number;
        while ((nl = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, nl).trim();
          this.buf = this.buf.slice(nl + 1);
          if (!line) continue;
          let msg: { ready?: boolean; id?: number } & MeasureResponse;
          try { msg = JSON.parse(line); } catch { continue; } // fremde Ausgaben (Warnungen von Bibliotheken) überspringen
          if (msg.ready) { clearTimeout(timer); resolve(); continue; }
          const p = msg.id != null ? this.pending.get(msg.id) : undefined;
          if (!p) continue;
          this.pending.delete(msg.id!);
          clearTimeout(p.timer);
          p.resolve({ ok: !!msg.ok, result: msg.result, error: msg.error, stale: msg.stale, rebuilt: msg.rebuilt });
        }
      });
      child.stderr!.on('data', (d: Buffer) => { err = (err + d.toString('utf8')).slice(-2000); });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (this.proc === child) { this.proc = null; this.ready = null; }
        reject(new Error(`ended with code ${code}. ${err.trim().split('\n').pop() ?? ''}`));
        this.fail(`The measuring service ended (code ${code}). The next measurement starts it again.`);
      });
    });
    this.ready.catch(() => { /* wird bei der Anfrage gemeldet */ });
    return this.ready;
  }

  private fail(error: string): void {
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.resolve({ ok: false, error }); this.pending.delete(id); }
  }
}
