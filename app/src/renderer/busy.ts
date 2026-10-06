import { $ } from './ui';

/** Erst nach dieser Zeit erscheint die Anzeige: Was schneller fertig ist, soll nicht aufblitzen. */
const SHOW_AFTER_MS = 200;

export interface BusyHandle {
  /** Anteil 0 bis 1, null: unbestimmt (der Balken läuft durch). */
  progress(f: number | null): void;
  /** Zweite Zeile, etwa der laufende Schritt. */
  detail(text: string): void;
  /** Schließen. Gehört die Anzeige inzwischen einem anderen, bleibt sie stehen. */
  close(): void;
}

/**
 * Ladeanzeige über dem Viewer, solange ein Werkzeug sich vorbereitet (Explosion: Strahltest bei großen Baugruppen). Sie deckt
 * den Viewer ab, Klicks ins Modell kämen sonst vor dem Ergebnis an. „Abbrechen“ und Escape beenden das Werkzeug. Es gibt immer
 * nur eine: Wer neu anfängt, übernimmt sie. Messen zeigt seine Vorbereitung in der eigenen Karte, dort darf man schon klicken.
 */
export class Busy {
  private owner = 0;
  private cancel: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private t0 = 0;
  private tick: ReturnType<typeof setInterval> | undefined;
  private root = $('viewer-busy');
  private title = $('viewer-busy-title');
  private sub = $('viewer-busy-detail');
  private time = $('viewer-busy-time');
  private bar = $('viewer-busy-bar');
  private fill = $('viewer-busy-fill');

  constructor() {
    $('btn-busy-cancel').addEventListener('click', () => this.abort());
    window.addEventListener('keydown', (e) => {
      if (this.root.hidden || e.key !== 'Escape' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('#terminals, #code-view, input, textarea, .menu')) return;
      e.preventDefault();
      this.abort();
    }, true); // vor den Werkzeugen: Escape bricht das Laden ab, nicht mehr
  }

  /** `cancel`: was „Abbrechen“ tut (das Werkzeug beenden). */
  show(title: string, cancel: () => void): BusyHandle {
    const id = ++this.owner;
    this.cancel = cancel;
    this.title.textContent = title;
    this.sub.textContent = '';
    this.time.textContent = '';
    this.setProgress(null);
    clearTimeout(this.timer);
    clearInterval(this.tick);
    this.root.hidden = true;
    this.t0 = performance.now();
    this.timer = setTimeout(() => {
      if (id !== this.owner) return;
      this.root.hidden = false;
      // Sekunden mitzählen: Auch ohne Fortschritt sieht man, dass noch etwas geschieht
      this.tick = setInterval(() => { this.time.textContent = `${Math.round((performance.now() - this.t0) / 1000)} s`; }, 1000);
    }, SHOW_AFTER_MS);
    const mine = () => id === this.owner;
    return {
      progress: (f) => { if (mine()) this.setProgress(f); },
      detail: (text) => { if (mine()) this.sub.textContent = text; },
      close: () => { if (mine()) this.hide(); },
    };
  }

  get visible(): boolean { return !this.root.hidden; }
  /** Für Tests: Titel und Zeile darunter, null wenn nichts lädt. */
  state(): { title: string; detail: string; progress: number | null } | null {
    if (!this.cancel) return null;
    const w = this.fill.style.width;
    return { title: this.title.textContent ?? '', detail: this.sub.textContent ?? '', progress: this.bar.classList.contains('indet') ? null : parseFloat(w) / 100 };
  }

  private setProgress(f: number | null): void {
    this.bar.classList.toggle('indet', f === null);
    this.fill.style.width = f === null ? '' : `${Math.round(Math.min(1, Math.max(0, f)) * 100)}%`;
  }

  private abort(): void {
    const c = this.cancel;
    this.hide();
    c?.();
  }

  private hide(): void {
    this.owner++;
    this.cancel = null;
    clearTimeout(this.timer);
    clearInterval(this.tick);
    this.root.hidden = true;
  }
}
