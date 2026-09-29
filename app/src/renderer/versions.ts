import type { CommitInfo, GitLog, PreviewResult } from '../shared/types';

interface Ui {
  slider: HTMLInputElement;
  dots: HTMLElement;
  info: HTMLElement;
  problem: HTMLElement;
  restore: HTMLButtonElement;
  live: HTMLButtonElement;
  banner: HTMLElement;
}

interface Hooks {
  /** `res` = Vorschau eines alten Standes, `null` = zurück zum Arbeitsstand. */
  show(res: PreviewResult | null): Promise<void>;
  toast(text: string, kind: 'info' | 'error'): void;
}

const fmt = (iso: string) => new Date(iso).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });

/**
 * Verlaufsleiste unter dem Viewer (E7, E35): jeder Commit ein Punkt, ganz rechts der Arbeitsstand.
 * Alte Stände sind eine schreibgeschützte Vorschau, der Arbeitsordner bleibt unberührt.
 * „Stand wiederherstellen" legt einen neuen Commit an, es gibt kein Zurückspulen.
 */
export class VersionsBar {
  private log: GitLog = { commits: [], problems: [], head: null, dirtyFiles: 0 };
  private previewHash: string | null = null;
  private seq = 0;

  constructor(private ui: Ui, private hooks: Hooks) {
    ui.slider.addEventListener('change', () => void this.select(Number(ui.slider.value)));
    ui.live.addEventListener('click', () => void this.select(this.log.commits.length));
    ui.restore.addEventListener('click', () => void this.restore());
  }

  get previewing(): boolean { return this.previewHash !== null; }

  /** Beim Projektwechsel: alles zurücksetzen. */
  reset(): void {
    this.seq++;
    this.previewHash = null;
    this.log = { commits: [], problems: [], head: null, dirtyFiles: 0 };
    this.ui.banner.hidden = true;
    this.render();
  }

  async refresh(): Promise<void> {
    try { this.log = await window.cadide.versions.log(); } catch { return; }
    // Existiert der angezeigte Stand nicht mehr (Verlauf umgebaut), zurück zum Arbeitsstand
    if (this.previewHash && !this.log.commits.some((c) => c.hash === this.previewHash)) await this.select(this.log.commits.length);
    else this.render();
  }

  private index(): number {
    if (!this.previewHash) return this.log.commits.length;
    return this.log.commits.findIndex((c) => c.hash === this.previewHash);
  }

  private async select(i: number): Promise<void> {
    const seq = ++this.seq;
    const n = this.log.commits.length;
    if (i >= n || i < 0) { // Arbeitsstand
      this.previewHash = null;
      this.ui.banner.hidden = true;
      this.render();
      await this.hooks.show(null);
      return;
    }
    const commit = this.log.commits[i];
    this.ui.info.textContent = 'Lade Vorschau …';
    const res = await window.cadide.versions.preview(commit.hash);
    if (seq !== this.seq) return; // inzwischen etwas anderes gewählt
    if (res.error) {
      this.hooks.toast(res.error, 'error');
      this.render();
      return;
    }
    this.previewHash = commit.hash;
    this.ui.banner.textContent = `Vorschau: ${commit.subject} · ${fmt(commit.date)} · ${commit.short} (schreibgeschützt, der Arbeitsordner bleibt unverändert)`;
    this.ui.banner.hidden = false;
    this.render();
    await this.hooks.show(res);
  }

  private async restore(): Promise<void> {
    if (!this.previewHash) return;
    const r = await window.cadide.versions.restore(this.previewHash);
    if (r.cancelled) return;
    if (r.error) { this.hooks.toast(r.error, 'error'); return; }
    this.hooks.toast(r.commit ? 'Stand wiederhergestellt und als neuer Stand im Verlauf abgelegt.' : 'Dieser Stand war schon der aktuelle.', 'info');
    this.previewHash = null;
    this.ui.banner.hidden = true;
    await this.refresh();
    await this.hooks.show(null);
  }

  private render(): void {
    const { commits, problems, dirtyFiles } = this.log;
    const n = commits.length;
    const idx = this.index();
    const ui = this.ui;
    ui.slider.max = String(n);
    ui.slider.value = String(Math.max(idx, 0));
    ui.slider.disabled = n === 0;
    ui.dots.replaceChildren(...[...commits, null].map((c: CommitInfo | null, i) => {
      const dot = document.createElement('button');
      dot.className = 'vdot' + (c ? '' : ' live') + (i === idx ? ' cur' : '') + (!c && dirtyFiles ? ' dirty' : '');
      dot.style.left = n === 0 ? '0%' : `${(i / n) * 100}%`;
      dot.title = c ? `${c.subject}\n${c.author} · ${fmt(c.date)}` : `Arbeitsstand${dirtyFiles ? ` (${dirtyFiles} ungesicherte Änderungen)` : ''}`;
      dot.addEventListener('click', () => void this.select(i));
      return dot;
    }));
    const previewCommit = this.previewHash ? commits.find((c) => c.hash === this.previewHash) : null;
    ui.info.textContent = previewCommit
      ? `${previewCommit.subject} · ${fmt(previewCommit.date)}`
      : n === 0 ? 'Kein Verlauf' : `${n} ${n === 1 ? 'Stand' : 'Stände'}${dirtyFiles ? ` · ${dirtyFiles} ungesicherte Änderung${dirtyFiles === 1 ? '' : 'en'}` : ''}`;
    ui.restore.hidden = !previewCommit;
    ui.live.hidden = !previewCommit;
    ui.problem.hidden = problems.length === 0;
    ui.problem.textContent = problems.join(' ');
  }

  /** Prüfhilfe (nur Tests). */
  state() {
    return { count: this.log.commits.length, index: this.index(), previewing: this.previewHash, subjects: this.log.commits.map((c) => c.subject), problems: this.log.problems, dirtyFiles: this.log.dirtyFiles };
  }
}
