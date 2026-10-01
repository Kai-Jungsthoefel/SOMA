import { spawn, type ChildProcess } from 'node:child_process';
import type { MeasureRequest, MeasureResponse } from '../shared/types';
import { pythonExe } from './paths';

const START_TIMEOUT_MS = 60_000; // cadquery zu laden dauert beim ersten Mal einige Sekunden
const REQUEST_TIMEOUT_MS = 30_000;

interface Pending { resolve: (r: MeasureResponse) => void; timer: NodeJS.Timeout }

/**
 * Langlebiger Python-Dienst pro Projekt für exakte Messungen (E24): `python -m soma serve`, JSON-Zeilen über
 * stdin/stdout. Er startet erst bei der ersten Messung (cadquery zu laden kostet Sekunden) und bleibt dann offen.
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

  async request(folder: string, req: MeasureRequest): Promise<MeasureResponse> {
    if (this.disposed) return { ok: false, error: 'Das Modell ist geschlossen.' };
    try { await this.start(); } catch (e) { return { ok: false, error: `Der Messdienst ließ sich nicht starten: ${e instanceof Error ? e.message : String(e)}` }; }
    const proc = this.proc;
    if (!proc?.stdin) return { ok: false, error: 'Der Messdienst läuft nicht.' };
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, error: 'Der Messdienst antwortet nicht (Zeitlimit).' }); }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      proc.stdin!.write(JSON.stringify({ ...req, id, folder }) + '\n');
    });
  }

  stop(): void {
    this.disposed = true;
    this.proc?.kill();
    this.fail('Das Modell ist geschlossen.');
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
      const timer = setTimeout(() => { reject(new Error('Zeitlimit beim Start')); child.kill(); }, START_TIMEOUT_MS);
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
          p.resolve({ ok: !!msg.ok, result: msg.result, error: msg.error, stale: msg.stale });
        }
      });
      child.stderr!.on('data', (d: Buffer) => { err = (err + d.toString('utf8')).slice(-2000); });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('exit', (code) => {
        clearTimeout(timer);
        if (this.proc === child) { this.proc = null; this.ready = null; }
        reject(new Error(`beendet mit Code ${code}. ${err.trim().split('\n').pop() ?? ''}`));
        this.fail(`Der Messdienst wurde beendet (Code ${code}). Die nächste Messung startet ihn neu.`);
      });
    });
    this.ready.catch(() => { /* wird bei der Anfrage gemeldet */ });
    return this.ready;
  }

  private fail(error: string): void {
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.resolve({ ok: false, error }); this.pending.delete(id); }
  }
}
