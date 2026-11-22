import { app, net, session, systemPreferences, utilityProcess, type BrowserWindow, type UtilityProcess } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isVoiceLanguage, VOICE_MAX_SECONDS, VOICE_MODEL } from '../shared/voice';
import type { VoiceResult, VoiceStatus, VoiceText } from '../shared/types';
import { userDataDir } from './paths';
import { writeAtomic } from './skills';

/*
 * Voice input for SOMA AI (decision of the user, 2026-11-17): speech to text on this computer with sherpa-onnx and
 * NVIDIA's Parakeet TDT 0.6B v3. The engine (npm sherpa-onnx-node, about 25-35 MB) comes with the app, the model
 * (487 MB) only when the user sets voice input up. Recognition runs in its own utility process (voiceworker.ts): the
 * model needs about 1 GB of memory while loaded and a crash of native code must not take the app with it. The process
 * ends after a while without use.
 */

/** Release of sherpa-onnx with the converted model. Tests point it elsewhere. */
const MODEL_URL = process.env.SOMA_VOICE_URL
  || 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2';
/** Folder in the archive and the files of it that recognition needs (README.md with the license comes along). */
const ARCHIVE_FOLDER = 'sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8';
export const MODEL_FILES = ['encoder.int8.onnx', 'decoder.int8.onnx', 'joiner.int8.onnx', 'tokens.txt'];
/** Free space needed to start: archive and unpacked model side by side for a moment. */
const SPACE_NEEDED = VOICE_MODEL.downloadBytes + VOICE_MODEL.diskBytes + 100_000_000;
/** The model is let go after this long without use (it holds about 1 GB). */
const IDLE_MS = 5 * 60_000;

export const voiceDir = () => path.join(userDataDir(), 'voice');
/** The model. Tests use one that is already unpacked (SOMA_VOICE_MODEL_DIR) instead of downloading it. */
const modelDir = () => process.env.SOMA_VOICE_MODEL_DIR || path.join(voiceDir(), VOICE_MODEL.id);
const configFile = () => path.join(voiceDir(), 'voice.json');

/** Folder of the engine's native part for this system (npm installs only the one that fits), null when missing. */
export function engineDir(): string | null {
  try {
    const pkg = path.dirname(require.resolve('sherpa-onnx-node/package.json'));
    const platform = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
    const native = path.join(path.dirname(pkg), `sherpa-onnx-${platform}`);
    return fs.existsSync(path.join(native, 'sherpa-onnx.node')) ? native : null;
  } catch { return null; }
}

const MISSING = 'The speech engine is missing from this installation. Reinstalling SOMA brings it back.';

/**
 * Known limits of the engine's prebuilt files (sherpa-onnx 2.0.1, read from their headers): the macOS module is built for
 * macOS 14 and later, the Linux one needs glibc 2.32 (GLIBCXX 3.4.29). Named here in plain words, before anything is
 * downloaded. Anything else shows in the trial run (Voice.probe).
 */
export function systemProblem(): string | null {
  if (process.platform === 'darwin') {
    const darwin = Number(os.release().split('.')[0]); // Darwin 23 is macOS 14
    if (darwin && darwin < 23) return 'Voice input needs macOS 14 (Sonoma) or newer.';
  }
  if (process.platform === 'linux') {
    const glibc = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header?.glibcVersionRuntime;
    const [major, minor] = (glibc ?? '').split('.').map(Number);
    if (glibc && (major < 2 || (major === 2 && minor < 32))) {
      return `Voice input needs a Linux with glibc 2.32 or newer (for example Ubuntu 22.04, Debian 12 or Fedora 35), this one has ${glibc}.`;
    }
  }
  return null;
}

function modelInstalled(): boolean {
  const dir = modelDir();
  return MODEL_FILES.every((f) => fs.existsSync(path.join(dir, f)));
}

function readLanguage(): string {
  try {
    const v = (JSON.parse(fs.readFileSync(configFile(), 'utf8')) as { language?: unknown }).language;
    return isVoiceLanguage(v) ? v : '';
  } catch { return ''; }
}

// ---- Microphone -----------------------------------------------------------------------------------------------------

/**
 * Microphone for the main window only, and only sound. Electron allows every permission when no handler is set: other
 * permissions keep that, what changes is the camera and other windows (the render window, help pages).
 */
export function allowMicrophone(win: BrowserWindow): void {
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (permission !== 'media') { callback(true); return; }
    const types = (details as { mediaTypes?: string[] }).mediaTypes ?? [];
    callback(!win.isDestroyed() && wc === win.webContents && types.length > 0 && types.every((t) => t === 'audio'));
  });
}

/** The system's side of the microphone: macOS asks the user once, Windows has a switch in its privacy settings. */
export async function micAccess(): Promise<VoiceResult> {
  // Tests record from Chromium's fake microphone. A CI runner has no microphone: macOS would ask and wait forever,
  // Windows reports access as denied
  if (process.env.SOMA_TEST === '1') return { ok: true };
  if (process.platform === 'darwin') {
    if (await systemPreferences.askForMediaAccess('microphone')) return { ok: true };
    return { ok: false, error: 'SOMA may not use the microphone. Allow it in System Settings > Privacy & Security > Microphone, then try again.' };
  }
  if (process.platform === 'win32' && systemPreferences.getMediaAccessStatus('microphone') === 'denied') {
    return { ok: false, error: 'Windows does not let apps use the microphone. Turn it on in Settings > Privacy & security > Microphone ("Let desktop apps access your microphone"), then try again.' };
  }
  return { ok: true };
}

// ---- Download -------------------------------------------------------------------------------------------------------

type Listener = (s: VoiceStatus) => void;

export class Voice {
  private download: VoiceStatus['download'] = null;
  private abort: AbortController | null = null;
  private lastError = '';
  private lastSent = 0;
  private worker: UtilityProcess | null = null;
  private ready: Promise<void> | null = null;
  private pending = new Map<number, (r: VoiceText) => void>();
  private seq = 0;
  private idle: NodeJS.Timeout | null = null;
  /** Trial run of the engine, once per app run: null when it loads, otherwise why not. */
  private engineCheck: Promise<string | null> | null = null;
  private engineError: string | null = null;

  constructor(private readonly notify: Listener) {}

  status(): VoiceStatus {
    const unavailable = !engineDir() ? MISSING : systemProblem() ?? this.engineError;
    return {
      available: !unavailable, installed: modelInstalled(), download: this.download, language: readLanguage(),
      ...(unavailable ? { unavailable } : {}), ...(this.lastError ? { error: this.lastError } : {}),
    };
  }

  /**
   * Loads the engine once in a short-lived utility process, without a model: whether it runs on this computer is known
   * before 487 MB are downloaded (missing system libraries, a system too old for the prebuilt files, a blocked library).
   */
  probe(): Promise<string | null> {
    this.engineCheck ??= new Promise<string | null>((resolve) => {
      if (!engineDir()) { resolve(MISSING); return; }
      const known = systemProblem();
      if (known) { resolve(known); return; }
      const proc = utilityProcess.fork(path.join(__dirname, 'voiceworker.js'), ['--probe'], { serviceName: 'SOMA speech check', stdio: 'pipe' });
      let err = '';
      proc.stderr?.on('data', (d) => { err += String(d); });
      const timer = setTimeout(() => { proc.kill(); resolve('The speech engine did not start in time.'); }, 20_000);
      proc.on('message', (m: { type?: string; ok?: boolean; error?: string }) => {
        if (m.type !== 'probe') return;
        clearTimeout(timer);
        resolve(m.ok ? null : `The speech engine cannot run on this computer: ${m.error ?? 'unknown reason'}`);
        proc.kill();
      });
      // Ended without an answer (a crash while loading native code). After an answer the first one wins, this is ignored
      proc.on('exit', (code) => {
        clearTimeout(timer);
        resolve(`The speech engine cannot run on this computer (it ended with code ${code}). ${err.trim().slice(0, 300)}`.trim());
      });
    }).then((r) => {
      this.engineError = r;
      if (r) console.error('[voice]', r);
      return r;
    });
    return this.engineCheck;
  }

  /** Status after the trial run of the engine (first click on the microphone, before the setup). */
  async check(): Promise<VoiceStatus> {
    await this.probe();
    return this.status();
  }

  private send(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastSent < 200) return;
    this.lastSent = now;
    this.notify(this.status());
  }

  /** Downloads and unpacks the model. A second call while one runs waits for the same. */
  async install(language: unknown): Promise<VoiceResult> {
    if (!isVoiceLanguage(language)) return { ok: false, error: 'This language is not supported yet.' };
    const problem = await this.probe();
    if (problem) { this.send(true); return { ok: false, error: problem }; }
    fs.mkdirSync(voiceDir(), { recursive: true });
    writeAtomic(configFile(), `${JSON.stringify({ language }, null, 2)}\n`);
    if (modelInstalled()) { this.send(true); return { ok: true }; }
    if (this.download) return { ok: false, error: 'The speech model is already being downloaded.' };
    this.lastError = '';
    this.abort = new AbortController();
    this.download = { phase: 'download', received: 0, total: VOICE_MODEL.downloadBytes };
    this.send(true);
    const archive = path.join(voiceDir(), `${VOICE_MODEL.id}.tar.bz2.part`);
    const unpack = path.join(voiceDir(), `.unpack-${VOICE_MODEL.id}`);
    try {
      await checkSpace(voiceDir());
      await this.fetchTo(archive, this.abort.signal);
      this.download = { phase: 'unpack', received: 0, total: 0 };
      this.send(true);
      fs.rmSync(unpack, { recursive: true, force: true });
      fs.mkdirSync(unpack, { recursive: true });
      await untar(archive, unpack, this.abort.signal);
      const from = path.join(unpack, ARCHIVE_FOLDER);
      const missing = MODEL_FILES.filter((f) => !fs.existsSync(path.join(from, f)));
      if (missing.length) throw new Error(`The download does not contain the expected model (${missing.join(', ')} missing). It may have changed on the server.`);
      // Our own download, never the user's data: a half-finished earlier one can go
      const dest = path.join(voiceDir(), VOICE_MODEL.id);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(dest, { recursive: true });
      for (const f of [...MODEL_FILES, 'README.md']) if (fs.existsSync(path.join(from, f))) fs.renameSync(path.join(from, f), path.join(dest, f));
      return { ok: true };
    } catch (e) {
      const cancelled = this.abort?.signal.aborted ?? false;
      if (!cancelled) {
        this.lastError = (e as Error).message;
        console.error('[voice] Download failed:', e);
      }
      return cancelled ? { ok: false, cancelled: true } : { ok: false, error: this.lastError };
    } finally {
      fs.rmSync(unpack, { recursive: true, force: true });
      fs.rmSync(archive, { force: true });
      this.download = null;
      this.abort = null;
      this.send(true);
    }
  }

  cancel(): void { this.abort?.abort(); }

  private async fetchTo(file: string, signal: AbortSignal): Promise<void> {
    // net.fetch: the system's proxy applies, as for the update check (updates.ts)
    const res = await net.fetch(MODEL_URL, { signal, cache: 'no-store' });
    if (!res.ok || !res.body) throw new Error(`The download server answered ${res.status} ${res.statusText}.`);
    const total = Number(res.headers.get('content-length')) || VOICE_MODEL.downloadBytes;
    const out = fs.createWriteStream(file);
    const done = new Promise<void>((resolve, reject) => { out.on('finish', resolve); out.on('error', reject); });
    const reader = res.body.getReader();
    let received = 0;
    try {
      for (;;) {
        const { done: end, value } = await reader.read();
        if (end) break;
        received += value.byteLength;
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
        this.download = { phase: 'download', received, total };
        this.send();
      }
    } finally {
      out.end();
      await done;
    }
    if (received < total) throw new Error(`The download stopped early (${Math.round(received / 1e6)} of ${Math.round(total / 1e6)} MB).`);
  }

  /** Deletes the model (asked for by the user). Nothing else lives in it. */
  async remove(): Promise<VoiceResult> {
    if (this.download) return { ok: false, error: 'The speech model is being downloaded. Cancel that first.' };
    if (process.env.SOMA_VOICE_MODEL_DIR) return { ok: false, error: 'The speech model is set by SOMA_VOICE_MODEL_DIR and is not removed.' };
    await this.stop();
    try {
      fs.rmSync(path.join(voiceDir(), VOICE_MODEL.id), { recursive: true, force: true });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: `The speech model could not be removed: ${(e as Error).message}` };
    } finally { this.send(true); }
  }

  // ---- Recognition --------------------------------------------------------------------------------------------------

  /** Starts the worker and loads the model, if not done yet. */
  warm(): Promise<void> {
    this.touch();
    if (this.ready) return this.ready;
    if (!engineDir()) return Promise.reject(new Error(MISSING));
    if (!modelInstalled()) return Promise.reject(new Error('The speech model is not installed.'));
    // No library path needed: the native module and its libraries find each other next to it (@loader_path on macOS,
    // $ORIGIN on Linux, the module's folder on Windows), read from the files of sherpa-onnx 2.0.1
    const proc = utilityProcess.fork(path.join(__dirname, 'voiceworker.js'), [modelDir()], { serviceName: 'SOMA speech', stdio: 'pipe' });
    this.worker = proc;
    // The engine writes notes (resampling) and errors to stderr: into the log
    proc.stdout?.on('data', (d) => console.log(`[voice] ${String(d).trim()}`));
    proc.stderr?.on('data', (d) => console.log(`[voice] ${String(d).trim()}`));
    this.ready = new Promise<void>((resolve, reject) => {
      proc.on('message', (m: { type?: string; id?: number; text?: string; error?: string }) => {
        if (m.type === 'ready') resolve();
        else if (m.type === 'failed') reject(new Error(m.error ?? 'The speech model could not be loaded.'));
        else if (typeof m.id === 'number') {
          const cb = this.pending.get(m.id);
          this.pending.delete(m.id);
          cb?.(m.type === 'result' ? { ok: true, text: m.text ?? '' } : { ok: false, error: m.error ?? 'Recognition failed.' });
        }
      });
      proc.on('exit', (code) => {
        if (this.worker !== proc) return;
        this.worker = null;
        this.ready = null;
        const error = `The speech engine stopped unexpectedly (code ${code}).`;
        reject(new Error(error));
        for (const cb of this.pending.values()) cb({ ok: false, error });
        this.pending.clear();
      });
    });
    this.ready.catch((e) => console.error('[voice]', (e as Error).message));
    return this.ready;
  }

  async transcribe(samples: unknown, sampleRate: unknown): Promise<VoiceText> {
    if (!(samples instanceof Float32Array) || typeof sampleRate !== 'number' || !(sampleRate >= 8000 && sampleRate <= 192000)) {
      return { ok: false, error: 'No usable recording.' };
    }
    if (samples.length > (VOICE_MAX_SECONDS + 5) * sampleRate) return { ok: false, error: 'The recording is too long.' };
    try { await this.warm(); } catch (e) { return { ok: false, error: (e as Error).message }; }
    const proc = this.worker;
    if (!proc) return { ok: false, error: 'The speech engine is not running.' };
    const id = ++this.seq;
    const r = await new Promise<VoiceText>((resolve) => {
      // Recognition takes about a tenth of the speaking time. The limit only catches a hanging engine
      const timer = setTimeout(() => { this.pending.delete(id); resolve({ ok: false, error: 'Recognition took too long.' }); }, 30_000 + samples.length / sampleRate * 1000);
      this.pending.set(id, (res) => { clearTimeout(timer); resolve(res); });
      proc.postMessage({ type: 'decode', id, samples, sampleRate });
    });
    this.touch();
    return r;
  }

  /** Lets go of the model after a while without use. */
  private touch(): void {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => void this.stop(), IDLE_MS);
    this.idle.unref?.();
  }

  async stop(): Promise<void> {
    if (this.idle) { clearTimeout(this.idle); this.idle = null; }
    const proc = this.worker;
    this.worker = null;
    this.ready = null;
    for (const cb of this.pending.values()) cb({ ok: false, error: 'The speech engine was stopped.' });
    this.pending.clear();
    if (proc) {
      const gone = new Promise<void>((r) => proc.once('exit', () => r()));
      proc.kill();
      await Promise.race([gone, new Promise((r) => setTimeout(r, 3000))]);
    }
  }

  /** On quit: stop a download and the engine. A half-finished download is cleared up on the next one. */
  shutdown(): void {
    this.abort?.abort();
    this.worker?.kill();
    this.worker = null;
  }
}

async function checkSpace(dir: string): Promise<void> {
  try {
    const s = await fs.promises.statfs(dir);
    const free = s.bavail * s.bsize;
    if (free < SPACE_NEEDED) {
      throw new Error(`Not enough free disk space: the speech model needs about ${(SPACE_NEEDED / 1e9).toFixed(1)} GB while it is set up, ${(free / 1e9).toFixed(1)} GB are free.`);
    }
  } catch (e) {
    if ((e as Error).message.startsWith('Not enough')) throw e;
    // statfs not available here: the download reports a full disk itself
  }
}

/**
 * Unpacks the .tar.bz2 with the system's tar: Windows 10 and later bring bsdtar with bzip2 (System32, not the tar of Git,
 * which takes "C:" for a remote host), macOS too, Linux GNU tar calls bzip2.
 */
function untar(archive: string, dest: string, signal: AbortSignal): Promise<void> {
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  return new Promise((resolve, reject) => {
    const child = spawn(tar, ['-xjf', archive, '-C', dest], { windowsHide: true, signal });
    let err = '';
    child.stderr.on('data', (d) => { err += String(d); });
    child.on('error', (e) => reject(signal.aborted ? e : new Error(`The model could not be unpacked, tar is missing (${e.message}).`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`The model could not be unpacked (tar ended with code ${code}): ${err.trim().slice(0, 300)}`))));
  });
}

/** Test switch: Chromium's fake microphone plays a WAV file (Settings and chat can then be tried without speaking).
 *  `SOMA_TEST_MIC=tone` gives it Chromium's test tone instead, for machines without a microphone such as CI runners. */
export function fakeMicrophone(): void {
  const wav = process.env.SOMA_TEST_MIC;
  if (!wav) return;
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  if (wav !== 'tone') app.commandLine.appendSwitch('use-file-for-fake-audio-capture', wav);
}
