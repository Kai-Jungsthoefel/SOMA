import { videoStamp } from './animdata';
import { icon } from './icons';

// Videos aus dem Projekt abspielen (E58), etwa die von `soma render --video`. Anhalten, Bild für Bild, und ein Standbild mit
// Zeitstempel markieren oder nur die Zeit an den Agenten geben. Der Player liegt über dem Viewer, das Modell bleibt dahinter.
// Lautstärke und Stumm gelten für alle Videos und bleiben über den Neustart erhalten. „…“ öffnet das Menü der Datei.

interface Ui {
  root: HTMLElement; video: HTMLVideoElement; title: HTMLElement;
  play: HTMLButtonElement; back: HTMLButtonElement; fwd: HTMLButtonElement;
  range: HTMLInputElement; time: HTMLElement; mark: HTMLButtonElement; agent: HTMLButtonElement; close: HTMLButtonElement;
  mute: HTMLButtonElement; volume: HTMLInputElement; more: HTMLButtonElement;
}
interface Deps {
  readBinary(rel: string): Promise<ArrayBuffer>;
  /** Standbild auf der Zeichenfläche öffnen. `label` steht später in der Notiz an den Agenten. */
  markFrame(label: string, frame: HTMLCanvasElement): Promise<void>;
  insert(text: string): void;
  toast(text: string, kind?: 'ok' | 'info' | 'error'): void;
  /** Menü der Datei (wie im Dateibaum) an dieser Stelle. */
  fileMenu(rel: string, x: number, y: number): void;
  /** Gemerkte Einstellungen des Benutzers (localStorage, darf fehlen). */
  load(key: string): string | null;
  save(key: string, value: string): void;
}

/** Schritt für „Bild vor/zurück“: Videos von soma haben 30 Bilder je Sekunde. */
const FRAME = 1 / 30;

export class VideoView {
  private file: string | null = null;
  private url: string | null = null;

  constructor(private readonly ui: Ui, private readonly d: Deps) {
    const v = ui.video;
    ui.play.addEventListener('click', () => (v.paused ? void v.play().catch(() => {}) : v.pause()));
    ui.back.addEventListener('click', () => this.step(-1));
    ui.fwd.addEventListener('click', () => this.step(1));
    ui.range.addEventListener('input', () => { v.pause(); v.currentTime = Number(ui.range.value); });
    ui.close.addEventListener('click', () => this.close());
    ui.mark.addEventListener('click', () => void this.mark());
    ui.agent.addEventListener('click', () => { if (this.file) d.insert(`[Video: ${this.file} at ${videoStamp(v.currentTime)}] `); });
    const raw = d.load('soma.video.volume');
    const vol = raw === null ? 1 : Number(raw);
    v.volume = Number.isFinite(vol) && vol >= 0 && vol <= 1 ? vol : 1;
    v.muted = d.load('soma.video.muted') === '1';
    ui.mute.addEventListener('click', () => this.toggleMute());
    ui.volume.addEventListener('input', () => {
      v.volume = Number(ui.volume.value);
      // Regler ganz links heißt stumm, wieder hochziehen hebt es auf
      v.muted = v.volume === 0;
    });
    v.addEventListener('volumechange', () => {
      d.save('soma.video.volume', String(v.volume));
      d.save('soma.video.muted', v.muted ? '1' : '0');
      this.renderVolume();
    });
    ui.more.addEventListener('click', () => {
      if (!this.file) return;
      const r = ui.more.getBoundingClientRect();
      d.fileMenu(this.file, r.left, r.top);
    });
    for (const ev of ['timeupdate', 'seeked', 'loadedmetadata', 'play', 'pause', 'ended']) v.addEventListener(ev, () => this.render());
    v.addEventListener('click', () => (v.paused ? void v.play().catch(() => {}) : v.pause()));
    v.addEventListener('error', () => { if (this.file) d.toast(`${this.file} can't be played (format?). Right-click it in the file tree: “Open with default app”.`, 'error'); });
    window.addEventListener('keydown', (e) => {
      if (ui.root.hidden || (e.target as HTMLElement | null)?.closest?.('input, textarea, select, .cm-editor, #terminals, #markup')) return;
      if (e.key === ' ') { e.preventDefault(); if (v.paused) void v.play().catch(() => {}); else v.pause(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); this.step(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); this.step(1); }
      else if ((e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); this.toggleMute(); }
      else if (e.key === 'Escape' && !document.querySelector('.menu:not([hidden])')) this.close();
    });
  }

  get isOpen(): boolean { return !this.ui.root.hidden; }
  get current(): string | null { return this.file; }

  async open(rel: string): Promise<void> {
    let data: ArrayBuffer;
    try { data = await this.d.readBinary(rel); } catch (e) { this.d.toast(`Can't read ${rel}: ${e instanceof Error ? e.message : String(e)}`, 'error'); return; }
    this.release();
    this.file = rel;
    this.url = URL.createObjectURL(new Blob([data], { type: /\.webm$/i.test(rel) ? 'video/webm' : 'video/mp4' }));
    this.ui.video.src = this.url;
    this.ui.title.textContent = rel;
    this.ui.title.title = rel;
    this.ui.root.hidden = false;
    this.render();
  }

  close(): void {
    this.ui.video.pause();
    this.ui.root.hidden = true;
    this.release();
    this.file = null;
  }

  private release(): void {
    this.ui.video.removeAttribute('src');
    this.ui.video.load();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }

  private toggleMute(): void {
    const v = this.ui.video;
    // Stumm aufheben, nachdem der Regler auf null gezogen wurde: mit halber Lautstärke statt lautlos weiter
    if (v.muted && v.volume === 0) v.volume = 0.5;
    v.muted = !v.muted;
  }

  private renderVolume(): void {
    const v = this.ui.video;
    const off = v.muted || v.volume === 0;
    this.ui.volume.value = String(off ? 0 : v.volume);
    this.ui.mute.replaceChildren(icon(off ? 'mute' : v.volume < 0.5 ? 'volumelow' : 'volume', 16, 1.9));
    this.ui.mute.setAttribute('aria-label', off ? 'Unmute' : 'Mute');
  }

  private step(dir: number): void {
    const v = this.ui.video;
    v.pause();
    v.currentTime = Math.max(0, Math.min(v.duration || 0, v.currentTime + dir * FRAME));
  }

  private render(): void {
    const v = this.ui.video;
    const dur = Number.isFinite(v.duration) ? v.duration : 0;
    this.ui.range.max = String(dur);
    this.ui.range.step = String(FRAME / 2);
    this.ui.range.value = String(v.currentTime);
    this.ui.time.textContent = `${videoStamp(v.currentTime)} / ${videoStamp(dur)}`;
    this.ui.play.replaceChildren(icon(v.paused ? 'play' : 'pause', 16, 2));
    this.ui.play.setAttribute('aria-label', v.paused ? 'Play' : 'Pause');
    this.renderVolume();
  }

  /** Das gerade gezeigte Bild in voller Auflösung. */
  frame(): HTMLCanvasElement | null {
    const v = this.ui.video;
    if (!v.videoWidth || !v.videoHeight) return null;
    const c = document.createElement('canvas');
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext('2d')!.drawImage(v, 0, 0);
    return c;
  }

  private async mark(): Promise<void> {
    const v = this.ui.video;
    v.pause();
    const c = this.frame();
    if (!c || !this.file) { this.d.toast('The video shows no frame yet.', 'error'); return; }
    await this.d.markFrame(`${this.file} at ${videoStamp(v.currentTime)}`, c);
  }

  /** Prüfhilfen. */
  state() {
    const v = this.ui.video;
    return { open: this.isOpen, file: this.file, time: this.ui.time.textContent, width: v.videoWidth, height: v.videoHeight, duration: v.duration, ready: v.readyState, error: v.error?.code ?? null,
      volume: v.volume, muted: v.muted, slider: Number(this.ui.volume.value), muteLabel: this.ui.mute.getAttribute('aria-label') };
  }
  async testSeek(t: number): Promise<void> {
    const v = this.ui.video;
    v.pause();
    await new Promise<void>((resolve) => { const done = () => { v.removeEventListener('seeked', done); resolve(); }; v.addEventListener('seeked', done); v.currentTime = t; setTimeout(done, 3000); });
    this.render();
  }
}
