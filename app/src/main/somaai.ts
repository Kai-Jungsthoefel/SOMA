import { app, type WebContents } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AiResult, AiStatus } from '../shared/types';
import { userDataDir } from './paths';
import { terminalEnv } from './terminals';

/*
 * SOMA AI: the agent built into SOMA. It is pi (pi.dev, MIT), bundled with the app, so people without a coding agent of
 * their own can start right away. SOMA does not build its own harness: pi runs the agent loop, the tools and the
 * providers. SOMA starts one pi process per open model in RPC mode (JSON lines over stdin and stdout), passes its records
 * to the chat and its questions to the user. The terminals and the agents in them stay as they are.
 *
 * Safety (decision of the user, 2026-11-16): not a sandbox, a permission extension (@gotgenes/pi-permission-system, MIT)
 * with SOMA's rules. Everything inside the model folder is allowed, dangerous commands are stopped, leaving the folder,
 * the internet and installing software ask. A note at the start of the chat names the remaining risks.
 */

const PI_PACKAGE = ['node_modules', '@earendil-works', 'pi-coding-agent'];
const GUARD_PACKAGE = ['node_modules', '@gotgenes', 'pi-permission-system'];
/** Commands the chat may send to pi. Everything else (bash, export_html, switch_session …) stays out of reach. */
const COMMANDS = new Set([
  'prompt', 'steer', 'follow_up', 'abort', 'new_session', 'get_state', 'get_messages', 'get_available_models', 'set_model',
  'set_thinking_level', 'get_session_stats', 'get_last_assistant_text', 'compact', 'get_commands',
]);
/** Images of a prompt travel as base64 in the command. Larger than this is a mistake, not a sketch photo. */
const MAX_COMMAND = 40_000_000;
const REQUEST_TIMEOUT_MS = 60_000;

/** pi's own folder in the app data (PI_CODING_AGENT_DIR): sign-in (auth.json), settings, conversations. Not ~/.pi of the user. */
export const aiDir = () => path.join(userDataDir(), 'somaai');
/** Files of SOMA for pi: its addition to the system prompt and its own extension. */
const aiResources = () => path.join(app.getAppPath(), 'resources', 'somaai');

/** Entry of pi for RPC mode, null when the installation lacks it. */
export function piEntry(): string | null {
  const f = path.join(app.getAppPath(), ...PI_PACKAGE, 'dist', 'bundle', 'rpc-entry.js');
  return fs.existsSync(f) ? f : null;
}

export function piVersion(): string | null {
  try { return (JSON.parse(fs.readFileSync(path.join(app.getAppPath(), ...PI_PACKAGE, 'package.json'), 'utf8')) as { version?: string }).version ?? null; }
  catch { return null; }
}

function guardDir(): string | null {
  const d = path.join(app.getAppPath(), ...GUARD_PACKAGE);
  return fs.existsSync(path.join(d, 'package.json')) ? d : null;
}

/** Root of the Git that SOMA brings (dugite). Under Windows it also holds bash and the usual command line tools. */
function bundledGitDir(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('dugite') as typeof import('dugite')).resolveGitDir();
  } catch { return null; }
}

/**
 * pi's shell tool needs bash. Under Windows that means Git for Windows, which people without a coding background rarely
 * have. SOMA's own Git brings a bash (sh.exe) with ls, cp, mv and the rest in usr/bin.
 */
function windowsShell(): { shell: string; bin: string } | null {
  if (process.platform !== 'win32') return null;
  const git = bundledGitDir();
  if (!git) return null;
  const bin = path.join(git, 'usr', 'bin');
  const shell = path.join(bin, 'sh.exe');
  return fs.existsSync(shell) ? { shell, bin } : null;
}

/**
 * Environment of pi: the one of the terminals (Python, soma, Git, the bridge for soma render), plus pi's own folder and
 * no telemetry, no version check and no model catalog downloads (SOMA only goes online where the user chose it).
 * ELECTRON_RUN_AS_NODE starts the Electron of the app as plain Node, so no Node has to be installed. SOMA's extension
 * removes it again for the commands pi runs (resources/somaai/soma.ts).
 */
function aiEnv(dir: string): NodeJS.ProcessEnv {
  const env = terminalEnv(dir);
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const sh = windowsShell();
  if (sh) env[key] = [sh.bin, env[key] ?? ''].join(path.delimiter);
  return {
    ...env, ELECTRON_RUN_AS_NODE: '1', PI_CODING_AGENT_DIR: aiDir(), PI_TELEMETRY: '0', PI_SKIP_VERSION_CHECK: '1', PI_OFFLINE: '1',
  };
}

/** Writes a JSON file of SOMA in pi's folder. One that is not valid JSON goes into a backup next to it first. */
function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = `${JSON.stringify(data, null, 2)}\n`;
  if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === text) return;
  fs.writeFileSync(file, text, { encoding: 'utf8', mode: 0o600 });
}

function readJson(file: string): Record<string, unknown> {
  if (!fs.existsSync(file)) return {};
  const text = fs.readFileSync(file, 'utf8');
  try {
    const v = JSON.parse(text) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch { /* below */ }
  const backup = `${file}.broken-${Date.now()}`;
  fs.copyFileSync(file, backup);
  console.error(`[somaai] ${path.basename(file)} was not valid JSON, kept as ${path.basename(backup)}`);
  return {};
}

const FORWARD_ONLY = 'SOMA keeps the history of a model forward only (new commits, nothing undone). Make a new commit instead.';

/**
 * Rules of the permission extension. Inside the model folder everything is allowed, the agent moves, renames and analyzes
 * files freely. Leaving the folder, the internet and installing software ask. Dangerous commands and secrets are denied,
 * the agent learns why. Patterns use forward slashes, the extension folds Windows separators.
 */
export function guardPolicy(agentDir: string): Record<string, unknown> {
  const own = `${agentDir.replace(/\\/g, '/')}/*`;
  const deny = (reason: string) => ({ action: 'deny', reason });
  return {
    permission: {
      '*': 'allow',
      external_directory: { '*': 'ask' },
      path: {
        '*': 'allow',
        '*.env': 'deny',
        '~/.ssh/*': 'deny',
        '~/.aws/*': 'deny',
        '~/.gnupg/*': 'deny',
        '~/.pi/*': 'deny',
        [own]: deny('This is where SOMA keeps the sign-in of SOMA AI.'),
      },
      bash: {
        '*': 'allow',
        'curl *': 'ask',
        'wget *': 'ask',
        'pip *': 'ask',
        'pip3 *': 'ask',
        'python -m pip *': 'ask',
        'npm *': 'ask',
        'npx *': 'ask',
        'sudo *': 'deny',
        'rm -rf /*': 'deny',
        'rm -rf ~*': 'deny',
        'shutdown *': 'deny',
        'format *': 'deny',
        'git push *': deny('Publishing is up to the user.'),
        'git reset *': deny(FORWARD_ONLY),
        'git checkout *': deny(FORWARD_ONLY),
        'git restore *': deny(FORWARD_ONLY),
        'git rebase *': deny(FORWARD_ONLY),
        'git branch *': deny(FORWARD_ONLY),
        'git clean *': deny(FORWARD_ONLY),
        'git stash *': deny(FORWARD_ONLY),
      },
    },
  };
}

/** Puts SOMA's part of pi's configuration in place before each start. Keys SOMA does not set (the user's model) stay. */
function prepareAiDir(): void {
  const dir = aiDir();
  const settingsFile = path.join(dir, 'settings.json');
  const settings = readJson(settingsFile);
  // A model folder can come from anywhere (Open folder, a .soma from someone else): never load extensions from it
  settings.defaultProjectTrust = 'never';
  settings.quietStartup = true;
  const sh = windowsShell();
  if (sh) settings.shellPath = sh.shell;
  writeJson(settingsFile, settings);
  writeJson(path.join(dir, 'extensions', 'pi-permission-system', 'config.json'), guardPolicy(dir));
}

/** Process numbers across all models: late records of a process from before a model switch never reach the new chat. */
let nextGen = 1;

/**
 * SOMA AI for one open model. pi starts on the first request from the chat and runs until the model is left. Each
 * conversation continues the last one of the model (pi keeps them per folder in aiDir()/sessions).
 */
export class SomaAI {
  private child: ChildProcess | null = null;
  private gen = 0;
  private starting: Promise<AiResult> | null = null;
  private pending = new Map<string, { resolve: (r: AiResult) => void; timer: NodeJS.Timeout }>();
  private nextId = 1;
  private stderr = '';
  private lastError: string | null = null;
  private exited: Promise<void> = Promise.resolve();
  private endWait: () => void = () => {};
  /** SOMA ends pi itself (model left, chat stopped): its exit code is no error then. */
  private stopping = false;

  constructor(private readonly wc: WebContents, private readonly dir: string) {}

  status(): AiStatus {
    return { available: !!piEntry() && !!guardDir(), running: !!this.child, version: piVersion() ?? undefined, error: this.lastError ?? undefined };
  }

  /** Starts pi if it is not running and waits until it answers. */
  start(): Promise<AiResult> {
    if (this.child) return Promise.resolve({ ok: true });
    this.starting ??= this.launch().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async launch(): Promise<AiResult> {
    const entry = piEntry();
    const guard = guardDir();
    // Never without the permission extension: then SOMA AI does not start at all
    if (!entry || !guard) return this.failed('SOMA AI is missing from this installation. Please reinstall SOMA.');
    try { prepareAiDir(); } catch (e) { return this.failed(`SOMA AI could not write its settings: ${e instanceof Error ? e.message : String(e)}`); }
    const args = [entry, '--continue', '--no-approve', '--offline', '--no-mcp', '-ne', '-ns', '-np', '--no-themes', '-e', guard];
    const own = path.join(aiResources(), 'soma.ts');
    if (fs.existsSync(own)) args.push('-e', own);
    const prompt = path.join(aiResources(), 'system.md');
    if (fs.existsSync(prompt)) args.push('--append-system-prompt', prompt);

    let child: ChildProcess;
    try {
      child = spawn(process.execPath, args, { cwd: this.dir, env: aiEnv(this.dir), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) { return this.failed(`SOMA AI could not start: ${e instanceof Error ? e.message : String(e)}`); }
    const gen = nextGen++;
    this.child = child;
    this.gen = gen;
    this.stderr = '';
    this.lastError = null;
    this.stopping = false;
    // 'exit', not 'close': a command pi started may still hold its output pipes (Windows), close would then wait for it.
    // release() can also end the wait (a process Windows does not let go of)
    this.exited = new Promise((resolve) => { this.endWait = resolve; child.once('exit', () => resolve()); });
    console.log(`[somaai] pi ${piVersion() ?? '?'} started (process ${child.pid})`);

    // Strict JSON lines: split only at \n. readline would also split at U+2028/U+2029, which are valid inside JSON strings
    let buf = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buf += chunk;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line) this.record(gen, line);
      }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (d: string) => {
      this.stderr = (this.stderr + d).slice(-8000);
      // Diagnostics of pi, never the conversation (that only travels on stdout)
      for (const l of d.split(/\r?\n/).filter((x) => x.trim())) console.log(`[somaai] ${l.slice(0, 300)}`);
    });
    child.on('error', (e) => { this.lastError = `SOMA AI could not start: ${e.message}`; });
    child.once('exit', (code) => this.closed(gen, code, child));

    const ready = await this.request({ type: 'get_state' });
    if (!ready.ok) { this.stop(); return this.failed(ready.error ?? 'SOMA AI did not answer.'); }
    return { ok: true, data: ready.data };
  }

  private failed(error: string): AiResult {
    this.lastError = error;
    console.error(`[somaai] ${error}`);
    return { ok: false, error };
  }

  private record(gen: number, line: string): void {
    let rec: Record<string, unknown>;
    try { rec = JSON.parse(line) as Record<string, unknown>; } catch { console.log(`[somaai] not JSON: ${line.slice(0, 200)}`); return; }
    if (rec.type === 'response' && typeof rec.id === 'string' && this.pending.has(rec.id)) {
      const p = this.pending.get(rec.id)!;
      this.pending.delete(rec.id);
      clearTimeout(p.timer);
      p.resolve(rec.success ? { ok: true, data: rec.data } : { ok: false, error: String(rec.error ?? 'SOMA AI refused the request.') });
      return;
    }
    if (!this.wc.isDestroyed()) this.wc.send('ai:event', { gen, record: rec });
  }

  private closed(gen: number, code: number | null, child: ChildProcess): void {
    // The last records may still be on their way. After that, let go of the pipes, even if a leftover process holds them
    setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); }, 2000).unref();
    // Already let go of (release) or replaced by a newer pi: only note its end
    if (gen !== this.gen || this.child !== child) { console.log(`[somaai] earlier pi (process ${child.pid}) ended (code ${code})`); return; }
    this.child = null;
    const tail = this.stderr.trim().split(/\r?\n/).slice(-3).join(' ').slice(0, 600);
    const error = code && !this.stopping ? `SOMA AI stopped unexpectedly (code ${code}).${tail ? ` ${tail}` : ''}` : undefined;
    if (error) this.lastError = error;
    console.log(`[somaai] pi ended (code ${code})`);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve({ ok: false, error: error ?? 'SOMA AI has stopped.' }); }
    this.pending.clear();
    if (!this.wc.isDestroyed()) this.wc.send('ai:exit', { gen, code, error });
  }

  private request(cmd: Record<string, unknown>): Promise<AiResult> {
    const child = this.child;
    if (!child?.stdin?.writable) return Promise.resolve({ ok: false, error: 'SOMA AI is not running.' });
    const id = `soma-${this.nextId++}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: 'SOMA AI did not answer in time.' });
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, timer });
      child.stdin!.write(`${JSON.stringify({ ...cmd, id })}\n`);
    });
  }

  /** A command from the chat. Only the commands in COMMANDS, with an id from SOMA. */
  async command(cmd: unknown): Promise<AiResult> {
    if (!cmd || typeof cmd !== 'object' || Array.isArray(cmd)) return { ok: false, error: 'Invalid request.' };
    const c = { ...(cmd as Record<string, unknown>) };
    if (typeof c.type !== 'string' || !COMMANDS.has(c.type)) return { ok: false, error: `Unknown request: ${String(c.type).slice(0, 40)}` };
    delete c.id;
    if (JSON.stringify(c).length > MAX_COMMAND) return { ok: false, error: 'The message is too large (images included).' };
    const started = await this.start();
    if (!started.ok) return started;
    return this.request(c);
  }

  /** Answer to a question of an extension (confirm, select, input). Only the fields pi knows. */
  respond(res: unknown): void {
    const r = (res && typeof res === 'object' ? res : {}) as Record<string, unknown>;
    if (typeof r.id !== 'string' || r.id.length > 200 || !this.child?.stdin?.writable) return;
    const out: Record<string, unknown> = { type: 'extension_ui_response', id: r.id };
    if (r.cancelled === true) out.cancelled = true;
    else if (typeof r.confirmed === 'boolean') out.confirmed = r.confirmed;
    else if (typeof r.value === 'string') out.value = r.value.slice(0, 100_000);
    else out.cancelled = true;
    this.child.stdin.write(`${JSON.stringify(out)}\n`);
  }

  /**
   * Ends pi with everything it started. Under Windows the whole process tree, because a running command (a build, a
   * shell) would otherwise keep the model folder in use. Elsewhere pi ends its tools itself on SIGTERM.
   */
  stop(): void {
    const child = this.child;
    if (!child) return;
    const gen = this.gen;
    this.stopping = true;
    console.log(`[somaai] stopping pi (process ${child.pid})`);
    try { child.stdin?.end(); } catch { /* already closed */ }
    const alive = () => child.exitCode === null && child.signalCode === null;
    if (process.platform === 'win32' && child.pid) {
      // taskkill /T leaves the whole tree standing when one process in it cannot be ended (see test/harness.mjs). Then
      // at least pi itself goes: its end releases the model folder as working directory
      const tk = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
      let said = '';
      tk.stdout?.on('data', (d) => { said += d; });
      tk.stderr?.on('data', (d) => { said += d; });
      tk.on('error', (e) => console.log(`[somaai] taskkill failed: ${e.message}`));
      tk.on('exit', (c) => { if (c && alive()) console.log(`[somaai] taskkill (${c}): ${said.trim().slice(0, 300)}`); });
      setTimeout(() => { if (alive()) console.log(`[somaai] pi still running after 2 s, ending it: ${child.kill()}`); }, 2000).unref();
    } else {
      child.kill('SIGTERM');
      setTimeout(() => { if (alive()) child.kill('SIGKILL'); }, 3000).unref();
    }
    // A process that Windows is still taking down cannot be ended and reports its end late, seen under load with the
    // app on a network drive (pending I/O). SOMA does not wait for it: the chat can start a new pi, the old one ends on its own
    setTimeout(() => { if (this.child === child && alive()) this.release(gen, child); }, 5000).unref();
  }

  /** Lets go of a pi that does not end: for SOMA it has ended, its real end only goes into the log (closed()). */
  private release(gen: number, child: ChildProcess): void {
    console.log(`[somaai] pi (process ${child.pid}) has not ended 5 s after stopping, SOMA goes on without it`);
    this.child = null;
    this.endWait();
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.resolve({ ok: false, error: 'SOMA AI has stopped.' }); }
    this.pending.clear();
    if (!this.wc.isDestroyed()) this.wc.send('ai:exit', { gen, code: null });
  }

  /** Like stop(), and waits until pi has really ended (at most `ms`), so the model folder is free. */
  stopAndWait(ms = 10000): Promise<void> {
    if (!this.child) return Promise.resolve();
    const done = this.exited;
    this.stop();
    return Promise.race([done, new Promise<void>((r) => setTimeout(r, ms))]);
  }
}
