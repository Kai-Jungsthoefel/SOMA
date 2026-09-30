import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import type { BuildResult, BuildStatus } from '../shared/types';
import { pythonExe } from './paths';

const DEBOUNCE_MS = 700;
const TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Startet `cadide build` als eigenen Einmal-Prozess (E24) und haelt den Stand fest.
 *
 * Regeln (E20):
 * - Auto-Build ist abschaltbar. Aenderungen werden entprellt.
 * - Kommt eine Aenderung waehrend eines Builds, laeuft dieser fertig und danach genau ein weiterer Build.
 * - Ein haengender Build wird nach dem Zeitlimit abgebrochen, die App bleibt bedienbar.
 * - Fehler sind Ergebnisse, keine Ausnahmen: der zuletzt gute Stand bleibt auf der Platte und im Viewer.
 */
export class BuildManager extends EventEmitter {
  status: BuildStatus = { state: 'idle' };
  autoBuild = true;
  private proc: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private rerun = false;
  private disposed = false;

  constructor(private readonly dir: string) { super(); }

  /**
   * Dateiaenderung im Projekt gemeldet. Ohne Auto-Build merkt sich der Stand nur, dass er veraltet ist.
   * Stammt die Aenderung von vor dem Start des laufenden Builds (Speichern im Editor, direkt danach gebaut), steckt sie
   * schon darin: kein zweiter Build. Das Ereignis des Watchers kommt oft erst nach dem Start an.
   */
  sourceChanged(file: string | null = null): void {
    if (file && this.proc && this.status.startedAt) {
      try { if (fs.statSync(file).mtimeMs <= this.status.startedAt) return; } catch { /* Datei weg: normal weiter */ }
    }
    if (this.autoBuild) this.schedule('Dateiänderung');
    else if (!this.status.stale) this.setStatus({ ...this.status, stale: true });
  }

  /** Auto-Build umschalten. Wird er eingeschaltet, während der Stand veraltet ist, baut er gleich nach. */
  setAuto(on: boolean): void {
    this.autoBuild = on;
    if (on && this.status.stale) this.schedule('Auto-Build eingeschaltet', 0);
  }

  schedule(reason: string, delay = DEBOUNCE_MS): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.start(reason); }, delay);
  }

  /** Sofort bauen (Knopf oder Agent-Aufruf ueber die App). Laeuft schon ein Build, wird ein weiterer eingereiht. */
  start(reason = 'manuell'): void {
    if (this.disposed) return;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.proc) {
      this.rerun = true;
      this.setStatus({ ...this.status, queued: true });
      return;
    }
    this.setStatus({ state: 'building', startedAt: Date.now(), reason, result: this.status.result });
    const child = spawn(pythonExe(), ['-m', 'cadide', 'build', '--project', this.dir, '--json'], {
      cwd: this.dir, windowsHide: true,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    });
    this.proc = child;
    let out = '';
    let err = '';
    let killedByTimeout = false;
    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString('utf8'); });
    const timeout = setTimeout(() => { killedByTimeout = true; child.kill(); }, TIMEOUT_MS);

    const finish = (result: BuildResult) => {
      clearTimeout(timeout);
      this.proc = null;
      if (this.disposed) return;
      this.setStatus({ state: result.status === 'ok' ? 'ok' : 'error', result });
      if (this.rerun) { this.rerun = false; this.start('Änderung während des Builds'); }
    };

    child.on('error', (e) => finish(errorResult('PythonStart', `Python konnte nicht gestartet werden (${pythonExe()}): ${e.message}`)));
    child.on('close', (code) => {
      if (killedByTimeout) return finish(errorResult('Timeout', `Der Build wurde nach ${TIMEOUT_MS / 1000} s abgebrochen (Zeitlimit).`));
      const line = out.trim().split(/\r?\n/).reverse().find((l) => l.startsWith('{'));
      if (line) {
        try { return finish(JSON.parse(line) as BuildResult); } catch { /* fällt auf Fehlertext zurück */ }
      }
      finish(errorResult('NoResult', `Der Build lieferte kein Ergebnis (Exit-Code ${code}).\n${(err || out).slice(-2000)}`));
    });
  }

  /** Läuft gerade ein Build oder steht einer an? */
  get busy(): boolean { return this.proc !== null || this.timer !== null; }

  /** Wartet, bis kein Build mehr läuft oder ansteht (mit Zeitlimit, damit Speichern nie ewig hängt). */
  whenIdle(timeoutMs = 120000): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => { clearTimeout(t); this.off('status', onStatus); resolve(); };
      const onStatus = () => { if (!this.busy) done(); };
      const t = setTimeout(done, timeoutMs);
      this.on('status', onStatus);
    });
  }

  cancel(): void {
    this.rerun = false;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.proc) this.proc.kill();
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
    this.removeAllListeners();
  }

  private setStatus(s: BuildStatus): void {
    this.status = s;
    this.emit('status', s);
  }
}

function errorResult(kind: string, message: string): BuildResult {
  return { status: 'error', error: { kind, message, file: null, line: null, traceback: '' } };
}

/** Neuester Änderungszeitpunkt von Einstiegspunkt, parts/ und inputs/ (Quelltext des Modells). */
export function newestSourceMtime(dir: string): number {
  let newest = 0;
  const walk = (d: string, depth: number) => {
    if (depth > 4) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else try { newest = Math.max(newest, fs.statSync(p).mtimeMs); } catch { /* verschwunden */ }
    }
  };
  for (const top of ['parts', 'inputs']) walk(path.join(dir, top), 0);
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.py')) try { newest = Math.max(newest, fs.statSync(path.join(dir, f)).mtimeMs); } catch { /* weg */ }
  return newest;
}

/** Ist der Quelltext neuer als das letzte Build-Ergebnis (oder gibt es noch keines)? */
export function buildIsStale(dir: string): boolean {
  try { return newestSourceMtime(dir) > fs.statSync(path.join(dir, '.cadide', 'build.json')).mtimeMs; } catch { return true; }
}

/** Führt `python -m cadide <args>` aus (z. B. glb für Vorschauen). Kein Wurf: das Ergebnis trägt den Fehler. */
export function runCadide(args: string[], cwd: string, timeoutMs = 120000): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(pythonExe(), ['-m', 'cadide', ...args], {
      cwd, windowsHide: true, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
    });
    let out = '', err = '';
    child.stdout.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d: Buffer) => { err += d.toString('utf8'); });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, out, err: e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ ok: code === 0, out, err }); });
  });
}
