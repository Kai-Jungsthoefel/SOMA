import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { samePath } from './animations';
import { pythonExe, warmDir } from './paths';

/**
 * Projektumgebung (E25, E67): eine kleine venv je Modell unter .soma/env, angelegt von `soma env` (python/soma/env.py).
 * Sie sieht die Basisumgebung, kostet daher nur rund 0,6 MB, und der Agent installiert Zusatzpakete einfach mit pip (die
 * Terminals leiten pip per PIP_PYTHON hierher, terminals.ts). Die Umgebung kommt weder in die ZIP noch in Git. Was das
 * Modell davon importiert, hält `soma build` in requirements.txt fest. Fehlt davon etwas (anderer Rechner, alter Stand
 * wiederhergestellt), installiert die App es vor dem nächsten Build.
 */
const ENV_FORMAT = 1; // gleich FORMAT in python/soma/env.py
const WIN = process.platform === 'win32';
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

export interface EnvPaths { env: string; scripts: string; python: string }

/** Pfade der Projektumgebung. Stehen fest, bevor es sie gibt: Terminals bekommen sie gleich beim Öffnen. */
export function envPaths(dir: string): EnvPaths {
  const env = path.join(dir, '.soma', 'env');
  const scripts = path.join(env, WIN ? 'Scripts' : 'bin');
  return { env, scripts, python: path.join(scripts, WIN ? 'python.exe' : 'python') };
}

/** soma-env.json, von `soma env` geschrieben. */
interface EnvInfo { format?: number; base_python?: string; base_sites?: string[]; base_mtimes?: (number | null)[]; site?: string }

function readInfo(env: string): EnvInfo | null {
  try { return JSON.parse(fs.readFileSync(path.join(env, 'soma-env.json'), 'utf8')) as EnvInfo; } catch { return null; }
}

/**
 * Passt die Umgebung zur Basis (dasselbe Python, Basispakete seither unverändert)? Dann muss beim Öffnen kein Python
 * starten. Ändert sich die Basis (neue App, Paket in der Basis nachinstalliert), bringt `soma env` sie auf den Stand.
 */
export function envIsCurrent(dir: string): boolean {
  const { env, python } = envPaths(dir);
  const info = readInfo(env);
  if (!info || info.format !== ENV_FORMAT || !fs.existsSync(python) || !fs.existsSync(path.join(env, 'pyvenv.cfg'))) return false;
  if (!info.base_python || !samePath(info.base_python, pythonExe())) return false;
  const sites = info.base_sites ?? [];
  return sites.length > 0 && sites.every((s, i) => {
    try { return Math.floor(fs.statSync(s).mtimeMs) === info.base_mtimes?.[i]; } catch { return false; }
  });
}

interface RunResult { code: number | null; out: string; err: string }

function run(exe: string, args: string[], cwd: string, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let out = '', err = '';
    let child: ChildProcess;
    try {
      child = spawn(exe, args, { cwd, windowsHide: true, env: { ...process.env, PIP_PYTHON: undefined, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
    } catch (e) { resolve({ code: null, out, err: e instanceof Error ? e.message : String(e) }); return; }
    const timer = setTimeout(() => { err += '\nTime limit exceeded.'; child.kill(); }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, out, err: err + e.message }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

/**
 * `soma env` mit dem Python der Basis: Projektumgebung anlegen oder auf den Stand bringen (rund 0,5 s). Gibt einen
 * Fehlertext zurück oder null. Gestartet wird in einem leeren Ordner, damit keine Datei des Projekts Module überdeckt.
 */
export async function ensureEnv(dir: string): Promise<string | null> {
  const cwd = warmDir();
  try { fs.mkdirSync(cwd, { recursive: true }); } catch { /* dann scheitert der Start und meldet es */ }
  const r = await run(pythonExe(), ['-m', 'soma', 'env', '--project', dir, '--json'], cwd, 60000);
  const line = r.out.trim().split(/\r?\n/).pop() ?? '';
  try {
    const res = JSON.parse(line) as { ok?: boolean; error?: string; note?: string };
    if (res.note) console.log(`[soma] ${res.note}`);
    if (res.ok) return null;
    if (res.error) return res.error;
  } catch { /* kein Ergebnis: unten mit der Fehlerausgabe melden */ }
  return `Could not create the project environment (${pythonExe()}): ${(r.err || r.out).trim().split('\n').slice(-3).join(' ')}`;
}

const norm = (name: string) => name.replace(/[-_.]+/g, '-').toLowerCase();

/** Eine Zeile aus requirements.txt: Paketname (normiert) und gepinnte Version, falls angegeben. Optionen (`-…`) ohne Namen. */
interface Requirement { name: string | null; version: string | null; line: string }

function parseRequirements(text: string): Requirement[] {
  const out: Requirement[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.split(' #')[0].trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:==\s*([^\s;,]+))?/.exec(line);
    out.push({ name: m && !line.startsWith('-') ? norm(m[1]) : null, version: m?.[2] ?? null, line });
  }
  return out;
}

/** Installierte Pakete der Projektumgebung (Name normiert, Version) laut METADATA in site-packages. */
function installedInEnv(env: string): Map<string, string> {
  const have = new Map<string, string>();
  const site = path.join(env, readInfo(env)?.site ?? (WIN ? path.join('Lib', 'site-packages') : ''));
  let entries: string[];
  try { entries = fs.readdirSync(site); } catch { return have; }
  for (const e of entries) {
    if (!e.endsWith('.dist-info')) continue;
    try {
      const head = fs.readFileSync(path.join(site, e, 'METADATA'), 'utf8').split(/\r?\n\r?\n/)[0];
      const name = /^Name:\s*(.+)$/m.exec(head)?.[1]?.trim();
      const version = /^Version:\s*(.+)$/m.exec(head)?.[1]?.trim();
      if (name && version) have.set(norm(name), version);
    } catch { /* unvollständig: gilt als nicht installiert */ }
  }
  return have;
}

/** Paketnamen der Basis (aus den Constraints, die `soma env` schreibt). Sie gelten immer als vorhanden: Die Basis gewinnt. */
function basePackages(env: string): Set<string> {
  try {
    return new Set(parseRequirements(fs.readFileSync(path.join(env, 'base-constraints.txt'), 'utf8')).flatMap((r) => (r.name ? [r.name] : [])));
  } catch { return new Set(); }
}

/** Zeilen aus requirements.txt, die in der Projektumgebung fehlen oder dort eine andere Version haben. */
function missingLines(dir: string): Requirement[] {
  let text: string;
  try { text = fs.readFileSync(path.join(dir, 'requirements.txt'), 'utf8'); } catch { return []; }
  const { env } = envPaths(dir);
  const have = installedInEnv(env);
  const base = basePackages(env);
  return parseRequirements(text).filter((r) => {
    if (!r.name || base.has(r.name)) return false;
    const v = have.get(r.name);
    return v === undefined || (r.version !== null && v !== r.version);
  });
}

/** Fehlende Pakete aus requirements.txt, für die Anzeige (z. B. „tabulate==0.10.0“). Leer: nichts zu tun. */
export function missingPackages(dir: string): string[] {
  return missingLines(dir).map((r) => r.line);
}

/**
 * Installiert, was laut requirements.txt fehlt, mit pip der Projektumgebung (die Constraints der Basis stehen in ihrer
 * pip.ini). Optionen aus der Datei (z. B. `--index-url`) gehen mit. Gibt einen Fehlertext zurück oder null.
 */
export async function installMissing(dir: string): Promise<string | null> {
  const missing = missingLines(dir);
  if (!missing.length) return null;
  const { env, python } = envPaths(dir);
  let options: string[] = [];
  try { options = parseRequirements(fs.readFileSync(path.join(dir, 'requirements.txt'), 'utf8')).filter((r) => !r.name).map((r) => r.line); } catch { /* nur die Pakete */ }
  const list = path.join(env, 'restore-requirements.txt');
  try { fs.writeFileSync(list, [...options, ...missing.map((r) => r.line)].join('\n') + '\n'); } catch (e) {
    return `Could not write the package list: ${e instanceof Error ? e.message : String(e)}`;
  }
  const r = await run(python, ['-m', 'pip', 'install', '-r', list], dir, INSTALL_TIMEOUT_MS);
  if (r.code === 0) return null;
  const tail = (r.err || r.out).trim().split(/\r?\n/).filter((l) => l.trim()).slice(-4).join('\n');
  return `Could not install packages from requirements.txt (${missing.map((m) => m.line).join(', ')}).\n${tail}`;
}
