import type { SomaApi, VoiceStatus } from '../shared/types';
import { isVoiceLanguage, VOICE_LANGUAGES, VOICE_MAX_SECONDS, VOICE_MODEL } from '../shared/voice';
import { icon } from './icons';
import { el } from './ui';

/*
 * Voice input for SOMA AI (main/voice.ts): the microphone button next to the chat input, the setup on the first click
 * (language, download of the speech model) and the recording. The text goes into the input, never sent on its own: the
 * user reads it first. Recognition runs on this computer.
 */

type Toast = (text: string, kind?: 'ok' | 'info' | 'error') => void;
const MB = (n: number) => `${Math.round(n / 1e6)} MB`;

/** Recording from the microphone as mono samples at the rate of the sound card (the engine resamples). */
class Recording {
  private chunks: Float32Array[] = [];
  private length = 0;
  private constructor(private stream: MediaStream, private ctx: AudioContext, private node: ScriptProcessorNode) {}

  static async start(onLevel: (rms: number) => void, onFull: () => void): Promise<Recording> {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(stream);
    // ScriptProcessorNode is deprecated but needs no extra module: an AudioWorklet would have to be loaded as its own file
    const node = ctx.createScriptProcessor(4096, 1, 1);
    const rec = new Recording(stream, ctx, node);
    const max = VOICE_MAX_SECONDS * ctx.sampleRate;
    node.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      rec.chunks.push(new Float32Array(data)); // the buffer is reused for the next block
      rec.length += data.length;
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
      onLevel(Math.sqrt(sum / data.length));
      if (rec.length >= max) onFull();
    };
    source.connect(node);
    node.connect(ctx.destination); // without an output Chromium does not run the node. It writes nothing, so it stays silent
    return rec;
  }

  get seconds(): number { return this.length / this.ctx.sampleRate; }

  stop(): { samples: Float32Array; sampleRate: number } {
    const sampleRate = this.ctx.sampleRate;
    this.close();
    const samples = new Float32Array(this.length);
    let at = 0;
    for (const c of this.chunks) { samples.set(c, at); at += c.length; }
    this.chunks = [];
    return { samples, sampleRate };
  }

  close(): void {
    this.node.onaudioprocess = null;
    this.node.disconnect();
    for (const t of this.stream.getTracks()) t.stop();
    void this.ctx.close().catch(() => {});
  }
}

// ---- Setup ----------------------------------------------------------------------------------------------------------

/** Language to start with: the one of the system, if the model knows it, otherwise English. */
function defaultLanguage(chosen: string): string {
  if (isVoiceLanguage(chosen)) return chosen;
  const sys = (navigator.language || 'en').slice(0, 2).toLowerCase();
  return isVoiceLanguage(sys) ? sys : 'en';
}

let openSetup: SetupDialog | null = null;

/**
 * Setup of voice input: which language, what is downloaded, then the download with progress. "Hide" lets it go on in
 * the background. Resolves true when voice input is ready.
 */
export function voiceSetup(api: SomaApi, toast: Toast, status: VoiceStatus | null): Promise<boolean> {
  if (openSetup) return openSetup.done;
  openSetup = new SetupDialog(api, toast, status);
  void openSetup.done.finally(() => { openSetup = null; });
  return openSetup.done;
}

/** The open setup follows the status of the download (main process). */
export function voiceSetupUpdate(s: VoiceStatus): void { openSetup?.update(s); }

class SetupDialog {
  readonly done: Promise<boolean>;
  private resolve!: (ok: boolean) => void;
  private scrim: HTMLElement;
  private lang: HTMLSelectElement;
  private other: HTMLElement;
  private progress: HTMLElement;
  private bar: HTMLElement;
  private info: HTMLElement;
  private btns: HTMLElement;
  private before = document.activeElement as HTMLElement | null;
  private installing = false;
  /** Which buttons are shown: rebuilt only when that changes, so a click during a progress report is not lost. */
  private shownBtns = '';

  constructor(private api: SomaApi, private toast: Toast, private status: VoiceStatus | null) {
    this.done = new Promise((r) => { this.resolve = r; });
    this.lang = el('select', { className: 'ai-field vc-lang' });
    for (const l of [...VOICE_LANGUAGES].sort((a, b) => a.label.localeCompare(b.label))) this.lang.append(el('option', { value: l.id, textContent: l.label }));
    this.lang.append(el('option', { value: '', textContent: 'Another language' }));
    this.lang.value = defaultLanguage(status?.language ?? '');
    this.lang.addEventListener('change', () => this.render());
    this.lang.setAttribute('aria-label', 'Language you speak');
    this.other = el('div', { className: 'vc-note', textContent: 'Only the languages in this list work for now. More may follow with other speech models.' });
    this.bar = el('span');
    this.progress = el('div', { className: 'vc-bar' }, this.bar);
    this.info = el('div', { className: 'vc-info' });
    this.btns = el('div', { className: 'ask-btns' });
    const dlg = el('div', { className: 'ask-dlg vc-dlg' },
      el('div', { className: 'ask-title' }, 'Voice input'),
      el('div', { className: 'ask-msg' }, 'Speak to SOMA AI instead of typing'),
      el('div', { className: 'ask-detail' },
        'SOMA turns what you say into text on this computer, nothing you say leaves it. The text lands in the chat input, you read it before sending.'),
      el('label', { className: 'vc-row' }, el('span', { textContent: 'Language you speak' }), this.lang),
      this.other,
      el('div', { className: 'vc-model' }, icon('download', 14, 2),
        el('span', {}, 'Downloads the speech model once: ', el('b', { textContent: `${VOICE_MODEL.name}` }), ` by ${VOICE_MODEL.by} (license ${VOICE_MODEL.license}), `,
          `${MB(VOICE_MODEL.downloadBytes)} download, ${MB(VOICE_MODEL.diskBytes)} on disk, ${VOICE_MODEL.memory} of memory while in use.`)),
      this.progress, this.info, this.btns);
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-label', 'Voice input');
    this.scrim = el('div', { className: 'ask-scrim vc-scrim' }, dlg);
    window.addEventListener('keydown', this.onKey, true);
    document.body.append(this.scrim);
    this.render();
    this.btns.querySelector('button')?.focus();
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.close(false);
  };

  update(s: VoiceStatus): void {
    this.status = s;
    this.render();
  }

  private render(): void {
    const s = this.status;
    const dl = s?.download ?? null;
    const busy = this.installing || !!dl;
    this.lang.disabled = busy;
    this.other.hidden = !!this.lang.value || busy;
    this.progress.hidden = !dl;
    if (dl) this.bar.style.width = dl.phase === 'unpack' || !dl.total ? '100%' : `${Math.min(100, (dl.received / dl.total) * 100).toFixed(1)}%`;
    this.progress.classList.toggle('unpack', dl?.phase === 'unpack');
    this.info.className = s?.error && !busy ? 'vc-info ai-err' : 'vc-info';
    this.info.textContent = dl
      ? dl.phase === 'unpack' ? 'Unpacking the speech model …' : `Downloading ${MB(dl.received)} of ${MB(dl.total)} …`
      : s?.error && !busy ? `The download did not work: ${s.error}` : '';
    const mk = (label: string, cls: string, act: string, fn: () => void) => {
      const b = el('button', { className: cls, textContent: label });
      b.dataset.act = act;
      b.addEventListener('click', fn);
      return b;
    };
    const which = busy ? 'busy' : `idle:${s?.error ? 'error' : ''}`;
    if (which === this.shownBtns) {
      const go = this.btns.querySelector<HTMLButtonElement>('[data-act=download]');
      if (go) go.disabled = !this.lang.value;
      return;
    }
    const focused = this.btns.contains(document.activeElement);
    this.shownBtns = which;
    if (busy) {
      this.btns.replaceChildren(
        mk('Hide', 'btn primary', 'hide', () => this.close(false)),
        mk('Cancel download', 'btn', 'cancel', () => void this.api.voice.cancel()));
    } else {
      const go = mk(s?.error ? 'Try again' : `Download ${MB(VOICE_MODEL.downloadBytes)}`, 'btn primary', 'download', () => void this.install());
      go.disabled = !this.lang.value;
      this.btns.replaceChildren(go, mk('Cancel', 'btn', 'close', () => this.close(false)));
    }
    if (focused) this.btns.querySelector('button')?.focus();
  }

  private async install(): Promise<void> {
    const language = this.lang.value;
    if (!language) return;
    this.installing = true;
    this.render();
    const r = await this.api.voice.install(language).catch((e) => ({ ok: false, error: String(e), cancelled: false }));
    this.installing = false;
    if (r.ok) {
      this.toast('Voice input is ready. Click the microphone, speak, and click it again.');
      this.close(true);
      return;
    }
    if (r.cancelled) this.toast('The download was cancelled.', 'info');
    else if (!openSetup) this.toast(`Voice input could not be set up: ${r.error ?? 'unknown reason'}`, 'error');
    this.status = await this.api.voice.status().catch(() => this.status);
    this.render();
  }

  private close(ok: boolean): void {
    if (!this.scrim.isConnected) return;
    window.removeEventListener('keydown', this.onKey, true);
    this.scrim.remove();
    this.before?.focus?.();
    if (this.installing && !ok) this.toast('The speech model keeps downloading. The microphone button shows how far it is.', 'info');
    this.resolve(ok);
  }
}

// ---- The button -----------------------------------------------------------------------------------------------------

export interface VoiceDeps {
  api: SomaApi;
  toast: Toast;
  /** Recognized text into the chat input. */
  insert(text: string): void;
}

type Phase = 'idle' | 'starting' | 'recording' | 'working';

/** Microphone button of the chat. First click: setup. Then: click to speak, click again for the text. Escape drops it. */
export class VoiceButton {
  readonly el: HTMLButtonElement;
  private status: VoiceStatus | null = null;
  private phase: Phase = 'idle';
  private rec: Recording | null = null;
  private locked = false;
  private lastText = '';
  /** Icon shown now: replaced only when it changes, a new spinner would start its turn over at every progress report. */
  private shown = '';

  constructor(private deps: VoiceDeps) {
    this.el = el('button', { className: 'ibtn s ai-mic' });
    this.el.addEventListener('click', () => void this.click());
    deps.api.voice.onStatus((s) => { this.status = s; voiceSetupUpdate(s); this.render(); });
    void deps.api.voice.status().then((s) => { this.status = s; this.render(); }).catch(() => {});
    this.render();
  }

  get recording(): boolean { return this.phase === 'recording' || this.phase === 'starting'; }

  /** The input is locked (note, question of SOMA AI): no recording either. */
  setLocked(locked: boolean): void {
    this.locked = locked;
    if (locked && this.recording) this.cancel();
    this.render();
  }

  private render(): void {
    const s = this.status;
    const dl = s?.download;
    let title: string;
    if (s && !s.available) title = s.unavailable ?? 'Voice input does not work here';
    else if (dl) title = dl.phase === 'unpack' ? 'Setting up voice input: unpacking …' : `Setting up voice input: ${dl.total ? Math.round((dl.received / dl.total) * 100) : 0} % downloaded`;
    else if (this.phase === 'recording') title = 'Listening … Click to stop and get the text (Esc drops it)';
    else if (this.phase === 'working') title = 'Turning your speech into text …';
    else if (s && !s.installed) title = 'Voice input: speak instead of typing (sets it up on the first click)';
    else title = 'Speak instead of typing';
    this.el.title = title;
    this.el.setAttribute('aria-label', title);
    this.el.setAttribute('aria-pressed', String(this.phase === 'recording'));
    this.el.classList.toggle('rec', this.phase === 'recording');
    this.el.disabled = this.locked || this.phase === 'working' || this.phase === 'starting';
    this.el.dataset.state = dl ? 'download' : this.phase;
    const kind = dl || this.phase === 'working' ? 'spin' : 'mic';
    if (kind !== this.shown) {
      this.shown = kind;
      this.el.replaceChildren(kind === 'spin' ? el('span', { className: 'spin' }, icon('spin', 15, 2.4)) : icon('mic', 17));
    }
  }

  private async click(): Promise<void> {
    if (this.phase === 'recording') { await this.finish(); return; }
    if (this.phase !== 'idle') return;
    let s = this.status ?? (this.status = await this.deps.api.voice.status().catch(() => null));
    if (!s) return;
    // Before the setup: does the engine run on this computer at all? Otherwise 487 MB would be downloaded for nothing
    if (s.available && !s.installed && !s.download) {
      const before = s;
      s = this.status = await this.deps.api.voice.check().catch(() => before);
      this.render();
    }
    if (!s.available) { this.deps.toast(s.unavailable ?? 'Voice input does not work on this computer.', 'error'); return; }
    if (!s.installed || s.download) {
      const ok = await voiceSetup(this.deps.api, this.deps.toast, s);
      this.status = await this.deps.api.voice.status().catch(() => this.status);
      this.render();
      if (!ok) return;
    }
    await this.begin();
  }

  private async begin(): Promise<void> {
    this.phase = 'starting';
    this.render();
    const access = await this.deps.api.voice.micAccess().catch((e) => ({ ok: false, error: String(e) }));
    if (!access.ok) { this.phase = 'idle'; this.render(); this.deps.toast(access.error ?? 'The microphone cannot be used.', 'error'); return; }
    // Load the model while the user speaks: the first time takes a few seconds
    this.deps.api.voice.warm();
    try {
      this.rec = await Recording.start(
        (rms) => this.el.style.setProperty('--lvl', Math.min(1, rms * 8).toFixed(2)),
        () => { if (this.phase === 'recording') { this.deps.toast(`Recordings stop after ${VOICE_MAX_SECONDS / 60} minutes.`, 'info'); void this.finish(); } });
    } catch (e) {
      this.phase = 'idle';
      this.render();
      const name = (e as DOMException).name;
      this.deps.toast(name === 'NotAllowedError' ? 'SOMA may not use the microphone. Check the privacy settings of your system.'
        : name === 'NotFoundError' ? 'No microphone found. Connect one and try again.'
          : `The microphone could not be started: ${(e as Error).message}`, 'error');
      return;
    }
    this.phase = 'recording';
    this.render();
  }

  private async finish(): Promise<void> {
    const rec = this.rec;
    this.rec = null;
    if (!rec) return;
    const seconds = rec.seconds;
    const { samples, sampleRate } = rec.stop();
    this.el.style.removeProperty('--lvl');
    if (seconds < 0.4) { this.phase = 'idle'; this.render(); this.deps.toast('That was too short. Click the microphone, speak, then click it again.', 'info'); return; }
    this.phase = 'working';
    this.render();
    const r = await this.deps.api.voice.transcribe(samples, sampleRate).catch((e) => ({ ok: false, error: String(e), text: undefined }));
    this.phase = 'idle';
    this.render();
    if (!r.ok) { this.deps.toast(`Your speech could not be turned into text: ${r.error ?? 'unknown reason'}`, 'error'); return; }
    const text = (r.text ?? '').trim();
    this.lastText = text;
    if (!text) { this.deps.toast('No speech was recognized. Speak a little closer to the microphone.', 'info'); return; }
    this.deps.insert(text);
  }

  /** Escape while recording: the recording is dropped. */
  cancel(): void {
    if (!this.rec) return;
    this.rec.close();
    this.rec = null;
    this.phase = 'idle';
    this.el.style.removeProperty('--lvl');
    this.render();
  }

  /** For tests. */
  state(): Record<string, unknown> {
    return { phase: this.phase, status: this.status, title: this.el.title, disabled: this.el.disabled, lastText: this.lastText, setup: !!openSetup };
  }
}
