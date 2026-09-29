import { spawn, type ChildProcess } from 'node:child_process';
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

  /** Dateiaenderung im Projekt gemeldet (nur relevant bei eingeschaltetem Auto-Build). */
  sourceChanged(): void {
    if (this.autoBuild) this.schedule('Dateiänderung');
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
