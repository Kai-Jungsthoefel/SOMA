import type { FileViewResult } from '../shared/types';
import type { BusyHandle } from './busy';

interface Ui {
  banner: HTMLElement;
  title: HTMLElement;
  sub: HTMLElement;
  back: HTMLButtonElement;
  /** Bekommt die Klasse `fileview` (violetter Rahmen wie bei der Vorschau), solange eine Datei zu sehen ist. */
  viewer: HTMLElement;
}

interface Hooks {
  /** `res`: die Datei zeigen. `null`: zurück zum Modell. */
  show(res: FileViewResult | null): Promise<void>;
  /** Vor dem Zeigen einer Datei: eine laufende Versionsvorschau beenden, ohne das Modell neu zu laden. */
  beforeShow(): void;
  busy(title: string, cancel: () => void): BusyHandle;
  toast(text: string, kind: 'ok' | 'info' | 'error'): void;
}

const base = (rel: string) => rel.split('/').pop() ?? rel;

/**
 * Eine STEP-Datei aus dem Projekt im Viewer (Klick im Dateibaum), schreibgeschützt wie die Vorschau eines alten Stands:
 * Messen, Schnitt, Explosion und Baum gehen, Klick zum Code, Animation und Analyse nicht. Solange sie offen ist, ersetzt
 * ein Build des Modells sie nicht. Ändert sich die Datei auf der Platte, wird sie neu geladen (der Hauptprozess wandelt
 * nur um, wenn sich der Inhalt geändert hat).
 */
export class FileView {
  private cur: { rel: string; key: string; parts: number } | null = null;
  private seq = 0;
  private loading = false;
  /** Während des Ladens kam eine Änderung im Projekt: danach noch einmal nachsehen. */
  private recheck = false;
  /** Letzter Fehler beim Neuladen, damit dieselbe Meldung nicht bei jeder Änderung im Projekt wiederkommt. */
  private reloadError = '';

  constructor(private ui: Ui, private hooks: Hooks) {
    ui.back.addEventListener('click', () => void this.close());
  }

  get active(): boolean { return this.cur !== null; }
  /** Pfad der gezeigten Datei, relativ zum Projekt. */
  get rel(): string | null { return this.cur?.rel ?? null; }
  /** Quelle für das Messen. */
  get source(): { file: string; key: string } | null { return this.cur ? { file: this.cur.rel, key: this.cur.key } : null; }
  get title(): string | null { return this.cur ? base(this.cur.rel) : null; }

  /** Datei zeigen. `reload`: Die angezeigte Datei hat sich vielleicht geändert, nur bei neuem Inhalt neu laden. */
  async open(rel: string, reload = false): Promise<void> {
    const seq = ++this.seq;
    this.loading = true;
    // Abbrechen lässt die Umwandlung im Hauptprozess zu Ende laufen (ihr Ergebnis landet im Cache), es wird nur nicht gezeigt
    const busy = this.hooks.busy(`Loading ${base(rel)}`, () => { if (seq === this.seq) { this.seq++; this.loading = false; } });
    busy.detail('Reading the STEP file. Large assemblies can take a while.');
    let res: FileViewResult;
    try { res = await window.soma.project.viewFile(rel); }
    catch (e) { res = { rel, key: '', glb: new ArrayBuffer(0), map: { version: 0, parts: [] }, error: e instanceof Error ? e.message : String(e) }; }
    busy.close();
    if (seq !== this.seq) return;
    this.loading = false;
    if (res.error) {
      if (!reload) this.hooks.toast(`${base(rel)} cannot be shown: ${res.error}`, 'error');
      else if (res.error !== this.reloadError) this.hooks.toast(`${base(rel)} changed on disk but cannot be loaded again: ${res.error} The viewer still shows the last loaded state.`, 'error');
      if (reload) this.reloadError = res.error;
    } else if (!(this.cur?.rel === rel && this.cur.key === res.key)) { // derselbe Inhalt wird schon gezeigt: nichts zu tun
      this.reloadError = '';
      this.hooks.beforeShow();
      this.cur = { rel, key: res.key, parts: res.map.parts.length };
      this.render();
      await this.hooks.show(res);
      if (reload) this.hooks.toast(`${base(rel)} changed on disk and was loaded again.`, 'info');
    }
    if (this.recheck && this.cur) { this.recheck = false; void this.filesChanged(); }
  }

  /** Dateien im Projekt haben sich geändert: Gilt das auch für die gezeigte, neu laden. */
  async filesChanged(): Promise<void> {
    if (!this.cur) return;
    if (this.loading) { this.recheck = true; return; }
    await this.open(this.cur.rel, true);
  }

  /** Zurück zum Modell. */
  async close(): Promise<void> {
    if (!this.cur && !this.loading) return;
    const was = this.cur;
    this.drop();
    if (was) await this.hooks.show(null);
  }

  /** Ohne Neuladen beenden: Projektwechsel oder eine Versionsvorschau übernimmt den Viewer. */
  drop(): void {
    this.seq++;
    this.loading = false;
    this.recheck = false;
    this.reloadError = '';
    this.cur = null;
    this.render();
  }

  private render(): void {
    const c = this.cur;
    this.ui.banner.hidden = !c;
    this.ui.viewer.classList.toggle('fileview', !!c);
    if (!c) return;
    this.ui.title.textContent = `Viewing ${c.rel}`;
    this.ui.title.title = c.rel;
    this.ui.sub.textContent = `STEP file · ${c.parts} part${c.parts === 1 ? '' : 's'} · shown in basic mode, without links to code`;
  }

  /** Prüfhilfe (nur Tests). */
  state() { return { rel: this.cur?.rel ?? null, key: this.cur?.key ?? null, parts: this.cur?.parts ?? 0, loading: this.loading }; }
}
