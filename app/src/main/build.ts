import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { affectsBuild } from '../shared/editable';
import type { BuildResult, BuildStatus } from '../shared/types';
import { pythonExe, warmDir } from './paths';
import { IGNORED_TOP } from './watcher';

const DEBOUNCE_MS = 700;
const TIMEOUT_MS = 5 * 60 * 1000;
/**
 * Fassung von model.glb, model.map.json und geometry/, gleich OUTPUT_FORMAT in python/soma/build.py. Nur ein Build mit
 * dieser Nummer wird beim Öffnen ohne Neubau gezeigt (currentBuild).
 */
export const OUTPUT_FORMAT = 1;

/**
 * Startet `soma build` als eigenen Einmal-Prozess (E24) und haelt den Stand fest.
 *
 * Regeln (E20):
 * - Auto-Build ist abschaltbar. Aenderungen werden entprellt.
 * - Kommt eine Aenderung waehrend eines Builds, laeuft dieser fertig und danach genau ein weiterer Build.
 * - Ein haengender Build wird nach dem Zeitlimit abgebrochen, die App bleibt bedienbar.
 * - Fehler sind Ergebnisse, keine Ausnahmen: der zuletzt gute Stand bleibt auf der Platte und im Viewer.
 *
 * Python zu starten und cadquery zu laden dauert einige Sekunden, das Bauen selbst oft nur Bruchteile davon.
 * Deshalb nimmt jeder Build einen vorgewärmten Prozess aus dem Vorrat der App (startJob, unten).
 */
export class BuildManager extends EventEmitter {
  status: BuildStatus = { state: 'idle' };
  autoBuild = true;
  private proc: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private rerun = false;
  private disposed = false;
  /** Pakete in Arbeit (E67) und ob danach gebaut wird. */
  private installing: string[] | null = null;
  private afterInstall = false;
  private packageError: string | null = null;

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
    if (this.installing) { // ohne die Pakete scheiterte der Build nur am Import
      this.afterInstall = true;
      this.setStatus({ ...this.status, queued: true });
      return;
    }
    if (this.proc) {
      this.rerun = true;
      this.setStatus({ ...this.status, queued: true });
      return;
    }
    const startedAt = Date.now();
    this.setStatus({ state: 'building', startedAt, reason, result: this.status.result });
    const w = startJob(this.dir, ['build', '--project', this.dir, '--json']);
    const { child } = w;
    this.proc = child;
    let done = false;
    let killedByTimeout = false;
    const timeout = setTimeout(() => { killedByTimeout = true; child.kill(); }, TIMEOUT_MS);

    const finish = (result: BuildResult) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      this.proc = null;
      if (this.disposed) return;
      this.setStatus({ state: result.status === 'ok' ? 'ok' : 'error', result, seconds: (Date.now() - startedAt) / 1000, builtAt: Date.now() });
      if (this.rerun) { this.rerun = false; this.start('Änderung während des Builds'); }
    };

    // Das Ergebnis gilt, sobald seine Zeile vollständig da ist; auf das Prozessende muss niemand warten
    w.onLine = (l) => {
      if (!l.startsWith('{')) return;
      try { finish(JSON.parse(l) as BuildResult); } catch { /* keine Ergebniszeile */ }
    };
    for (const l of w.lines) w.onLine(l);
    w.onError = (e) => finish(errorResult('PythonStart', `Python konnte nicht gestartet werden (${pythonExe()}): ${e.message}`));
    w.onClose = (code) => {
      if (killedByTimeout) return finish(errorResult('Timeout', `Der Build wurde nach ${TIMEOUT_MS / 1000} s abgebrochen (Zeitlimit).`));
      finish(errorResult('NoResult', `Der Build lieferte kein Ergebnis (Exit-Code ${code}).\n${(w.err || w.out).slice(-2000)}`));
    };
  }

  /**
   * Den letzten Build übernehmen, ohne neu zu bauen (beim Öffnen, wenn er noch gilt, siehe currentBuild). Der Viewer lädt
   * dann gleich, was auf der Platte liegt. Läuft schon ein Build oder steht einer an, zählt dessen Ergebnis.
   */
  adopt(last: LastBuild): void {
    if (this.disposed || this.busy) return;
    const result: BuildResult = { status: 'ok', parts: last.parts, timings: last.timings, warnings: last.warnings };
    const seconds = typeof last.started === 'number' && typeof last.finished === 'number' ? Math.max(0, last.finished - last.started) : undefined;
    const builtAt = typeof last.finished === 'number' ? last.finished * 1000 : undefined;
    this.setStatus({ state: 'ok', result, reason: 'letzter Build', seconds, builtAt });
  }

  /**
   * Pakete aus requirements.txt installieren (E67), bevor gebaut wird. Wer in der Zwischenzeit bauen will, wartet, danach
   * läuft genau ein Build. `build`: danach auf jeden Fall bauen (es gibt keinen gültigen Build). `install` gibt einen
   * Fehlertext zurück oder null.
   */
  async installFirst(names: string[], install: () => Promise<string | null>, build: boolean): Promise<void> {
    if (this.installing || this.disposed) return;
    this.installing = names;
    this.afterInstall = build;
    this.setStatus(this.status);
    let error: string | null;
    try { error = await install(); } catch (e) { error = e instanceof Error ? e.message : String(e); }
    this.installing = null;
    if (this.disposed) return;
    this.packageError = error;
    const { queued: _q, ...rest } = this.status;
    this.setStatus(rest);
    if (this.afterInstall) { this.afterInstall = false; this.start('Pakete installiert'); }
  }

  /** Die Projektumgebung ließ sich nicht einrichten (E67): Die Oberfläche zeigt es als Hinweis. */
  reportPackageError(error: string): void {
    if (this.disposed) return;
    this.packageError = error;
    this.setStatus(this.status);
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
    // Installation und Paketfehler gehören zum Manager, nicht zum einzelnen Build: bei jedem Stand mitgeben
    const { installing: _i, packageError: _p, ...rest } = s;
    this.status = { ...rest, ...(this.installing ? { installing: this.installing } : {}), ...(this.packageError ? { packageError: this.packageError } : {}) };
    this.emit('status', this.status);
  }
}

// ---- Vorgewärmte Python-Prozesse ------------------------------------------------------------------------------------

/**
 * Python starten und cadquery laden dauert rund 3 s. Deshalb liegt für die ganze App ein vorgewärmter Prozess bereit
 * (`soma warm`), unabhängig vom Projekt. Wer ihn nimmt (Build, Vorschau alter Stände, Export, Animationen, Auswertungen),
 * schickt ihm eine Zeile mit Ordner und Befehl, und gleich danach wärmt der nächste vor. So wartet auch der erste Build
 * nach dem Öffnen oder Anlegen eines Modells nicht auf Python. Jeder Auftrag bleibt ein eigener, frischer Prozess (E24).
 */
let spare: WarmProcess | null = null;
let warming = true;

/** Vorrat anlegen, falls keiner bereitliegt (beim Start der App und nach jeder Entnahme). */
export function warmUp(): void {
  if (warming && (!spare || spare.ended)) spare = spawnWarm();
}

/** Beim Beenden der App: Vorrat verwerfen und keinen neuen mehr anlegen. */
export function stopWarm(): void {
  warming = false;
  spare?.child.kill();
  spare = null;
}

/**
 * Auftrag an einen vorgewärmten Prozess. Ein schon beendeter Vorrat (abgestürzt, Python fehlt) wird nicht genommen:
 * frisch starten, damit der Fehler beim Auftrag sichtbar wird.
 */
function startJob(cwd: string, argv: string[]): WarmProcess {
  const w = spare && !spare.ended ? spare : spawnWarm();
  spare = null;
  warmUp();
  try { w.child.stdin?.end(JSON.stringify({ cwd, argv }) + '\n'); } catch { /* Prozess schon weg: onClose meldet es */ }
  return w;
}

/** Vorgewärmter `soma warm`. Ausgaben werden schon gesammelt, bevor ein Auftrag ihn übernimmt. */
interface WarmProcess {
  child: ChildProcess;
  out: string;
  err: string;
  /** Vollständige Zeilen von stdout, solange niemand `onLine` gesetzt hat. */
  lines: string[];
  ended: boolean;
  error: Error | null;
  onLine: ((l: string) => void) | null;
  onError: ((e: Error) => void) | null;
  onClose: ((code: number | null) => void) | null;
}

function spawnWarm(): WarmProcess {
  const cwd = warmDir();
  try { fs.mkdirSync(cwd, { recursive: true }); } catch { /* dann scheitert der Start und meldet es */ }
  const child = spawn(pythonExe(), ['-m', 'soma', 'warm'], {
    cwd, windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
  });
  const w: WarmProcess = { child, out: '', err: '', lines: [], ended: false, error: null, onLine: null, onError: null, onClose: null };
  let partial = '';
  child.stdout?.on('data', (d: Buffer) => {
    const s = d.toString('utf8');
    w.out += s;
    const parts = (partial + s).split(/\r?\n/);
    partial = parts.pop() ?? '';
    for (const l of parts) emitLine(w, l);
  });
  child.stderr?.on('data', (d: Buffer) => { w.err += d.toString('utf8'); });
  // Ohne Listener würde ein Schreibfehler auf die Auftragszeile (Prozess schon weg) die App abstürzen lassen
  child.stdin?.on('error', () => { /* onClose meldet den Grund */ });
  child.on('error', (e) => { w.ended = true; w.error = e; w.onError?.(e); });
  child.on('close', (code) => {
    w.ended = true;
    if (partial) { emitLine(w, partial); partial = ''; }
    w.onClose?.(code);
  });
  return w;
}

function emitLine(w: WarmProcess, line: string): void {
  const l = line.trim();
  if (w.onLine) w.onLine(l);
  else w.lines.push(l);
}

function errorResult(kind: string, message: string): BuildResult {
  return { status: 'error', error: { kind, message, file: null, line: null, traceback: '' } };
}

/** Führt `python -m soma <args>` aus (z. B. glb für Vorschauen). Kein Wurf: das Ergebnis trägt den Fehler. */
export function runSoma(args: string[], cwd: string, timeoutMs = 120000): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    const w = startJob(cwd, args);
    const timer = setTimeout(() => w.child.kill(), timeoutMs);
    w.onError = (e) => { clearTimeout(timer); resolve({ ok: false, out: w.out, err: e.message }); };
    w.onClose = (code) => { clearTimeout(timer); resolve({ ok: code === 0, out: w.out, err: w.err }); };
  });
}

// ---- Stand des letzten Builds ---------------------------------------------------------------------------------------

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

/**
 * Neuester Änderungszeitpunkt aller Dateien, deren Änderung bei offener App einen Build auslöst (dieselbe Regel wie der
 * Watcher). Weiter gefasst als newestSourceMtime: Was sich bei geschlossener App geändert hat, soll beim Öffnen auffallen.
 * Zu viele Dateien: Infinity, dann gilt der Build als veraltet (lieber einmal zu viel bauen).
 */
export function newestBuildInput(dir: string): number {
  let newest = 0, seen = 0;
  const walk = (d: string, rel: string, depth: number): boolean => {
    if (depth > 8) return true;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return true; }
    for (const e of entries) {
      if (++seen > 20000) return false;
      if (e.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if ((!rel && IGNORED_TOP.has(e.name)) || e.name === '__pycache__') continue;
        if (!walk(path.join(d, e.name), r, depth + 1)) return false;
      } else if (affectsBuild(r)) {
        try { newest = Math.max(newest, fs.statSync(path.join(d, e.name)).mtimeMs); } catch { /* verschwunden */ }
      }
    }
    return true;
  };
  return walk(dir, '', 0) ? newest : Infinity;
}

/** Inhalt von .soma/build.json (soma build schreibt sie bei jedem Lauf, auch bei Fehlern). */
export interface LastBuild extends BuildResult { format?: number; started?: number; finished?: number }

export function readLastBuild(dir: string): LastBuild | null {
  try {
    const b = JSON.parse(fs.readFileSync(path.join(dir, '.soma', 'build.json'), 'utf8')) as LastBuild;
    return b && typeof b === 'object' && (b.status === 'ok' || b.status === 'error') ? b : null;
  } catch { return null; }
}

/**
 * Ist der Quelltext neuer als das letzte Build-Ergebnis (oder gibt es noch keines)? Maßgeblich ist der Start des Builds:
 * Eine Änderung, während er lief, steckt womöglich nicht darin.
 */
export function buildIsStale(dir: string): boolean {
  const last = readLastBuild(dir);
  if (!last) return true;
  let at = typeof last.started === 'number' ? last.started * 1000 : NaN;
  if (!Number.isFinite(at)) try { at = fs.statSync(path.join(dir, '.soma', 'build.json')).mtimeMs; } catch { return true; }
  return newestBuildInput(dir) > at;
}

/**
 * Der letzte Build, wenn er noch gilt: erfolgreich, in der Fassung dieser App (OUTPUT_FORMAT), mit allem, was Viewer und
 * Messen brauchen, und kein Quelltext neuer als sein Start. Sonst null, dann wird gebaut wie bisher.
 * Die Geometrie zum Messen hat die Kennung aus model.map.json im Namen. Fehlt sie, ist ein Build mittendrin abgebrochen.
 */
export function currentBuild(dir: string): LastBuild | null {
  const last = readLastBuild(dir);
  if (!last || last.status !== 'ok' || last.format !== OUTPUT_FORMAT) return null;
  const soma = path.join(dir, '.soma');
  try {
    const map = JSON.parse(fs.readFileSync(path.join(soma, 'model.map.json'), 'utf8')) as { build?: unknown };
    if (typeof map.build !== 'string' || !/^[0-9a-f]{32}$/.test(map.build)) return null;
    if (!fs.statSync(path.join(soma, 'model.glb')).isFile() || !fs.statSync(path.join(soma, 'geometry', `${map.build}.brep`)).isFile()) return null;
  } catch { return null; }
  return buildIsStale(dir) ? null : last;
}
