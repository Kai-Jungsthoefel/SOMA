import type { CommitInfo, GitLog, PreviewResult } from '../shared/types';
import { el, fmtWhen } from './ui';

interface Ui {
  dots: HTMLElement;
  info: HTMLElement;
  problem: HTMLElement;
  restore: HTMLButtonElement;
  live: HTMLButtonElement;
  banner: HTMLElement;
  bannerTitle: HTMLElement;
  bannerSub: HTMLElement;
  /** Bekommt die Klasse `preview` (violetter Rahmen), solange ein alter Stand zu sehen ist. */
  viewer: HTMLElement;
}

interface Hooks {
  /**
   * `res` = Vorschau eines alten Standes, `null` = zurück zum Arbeitsstand. `restored`: Der Stand in der Vorschau wurde eben
   * wiederhergestellt, sie zeigt also schon den neuen Arbeitsstand.
   */
  show(res: PreviewResult | null, restored?: boolean): Promise<void>;
  toast(text: string, kind: 'ok' | 'info' | 'error'): void;
  /** Vor dem Wiederherstellen: ungespeicherte Eingaben im Editor klären. false = abbrechen. */
  beforeRestore(): Promise<boolean>;
}

const who = (c: CommitInfo) => (c.byApp ? 'SOMA' : c.author);

/**
 * Verlaufsleiste unter dem Viewer (E7, E35): jeder Commit ein Punkt, ganz rechts „Jetzt“ (der Arbeitsstand).
 * Punkte: gefüllt = Stand vom Agenten, Ring = Stand der App, grün = zuletzt gespeichert, violett = gerade in der Vorschau.
 * Alte Stände sind eine schreibgeschützte Vorschau, der Arbeitsordner bleibt unberührt.
 * „Wiederherstellen“ legt einen neuen Commit an, es gibt kein Zurückspulen.
 */
export class VersionsBar {
  private log: GitLog = { commits: [], problems: [], head: null, dirtyFiles: 0 };
  private previewHash: string | null = null;
  private savedHead: string | null = null;
  private seq = 0;
  private logSeq = 0;

  constructor(private ui: Ui, private hooks: Hooks) {
    ui.live.addEventListener('click', () => void this.select(this.log.commits.length));
    ui.restore.addEventListener('click', () => void this.restore());
  }

  get previewing(): boolean { return this.previewHash !== null; }
  /** Der alte Stand, der gerade als Vorschau zu sehen ist. */
  get previewed(): CommitInfo | null { return this.previewHash ? this.log.commits.find((c) => c.hash === this.previewHash) ?? null : null; }

  /** Stand der letzten Speicherung, für den grünen Punkt. */
  setSaved(head: string | null): void {
    if (head === this.savedHead) return;
    this.savedHead = head;
    this.render();
  }

  /** Beim Projektwechsel: alles zurücksetzen. */
  reset(): void {
    this.seq++;
    this.previewHash = null;
    this.savedHead = null;
    this.log = { commits: [], problems: [], head: null, dirtyFiles: 0 };
    this.render();
  }

  async refresh(): Promise<void> {
    // Abfragen können sich überholen (etwa wenn .git gerade verschwindet). Nur die neueste zählt, sonst bliebe ein
    // veralteter Stand stehen, und weil sich danach nichts mehr ändert, käme auch keine neue Abfrage.
    const seq = ++this.logSeq;
    let log: GitLog;
    try { log = await window.soma.versions.log(); } catch { return; }
    if (seq !== this.logSeq) return;
    this.log = log;
    // Existiert der angezeigte Stand nicht mehr (Verlauf umgebaut), zurück zum Arbeitsstand
    if (this.previewHash && !this.log.commits.some((c) => c.hash === this.previewHash)) await this.select(this.log.commits.length);
    else this.render();
  }

  /** Vorschau beenden, ohne den Arbeitsstand zu laden: Etwas anderes (eine STEP-Datei) übernimmt den Viewer. */
  endPreview(): void {
    this.seq++;
    if (!this.previewHash) return;
    this.previewHash = null;
    this.render();
  }

  /** Zurück zum Arbeitsstand, falls gerade eine Vorschau läuft. */
  async leavePreview(): Promise<void> { if (this.previewHash) await this.select(this.log.commits.length); }

  private index(): number {
    if (!this.previewHash) return this.log.commits.length;
    return this.log.commits.findIndex((c) => c.hash === this.previewHash);
  }

  private async select(i: number): Promise<void> {
    const seq = ++this.seq;
    const n = this.log.commits.length;
    if (i >= n || i < 0) { // Arbeitsstand
      this.previewHash = null;
      this.render();
      await this.hooks.show(null);
      return;
    }
    const commit = this.log.commits[i];
    this.ui.info.textContent = 'Loading preview …';
    const res = await window.soma.versions.preview(commit.hash);
    if (seq !== this.seq) return; // inzwischen etwas anderes gewählt
    if (res.error) {
      this.hooks.toast(res.error, 'error');
      this.render();
      return;
    }
    this.previewHash = commit.hash;
    this.render();
    await this.hooks.show(res);
  }

  private async restore(): Promise<void> {
    if (!this.previewHash) return;
    if (!(await this.hooks.beforeRestore())) return;
    const r = await window.soma.versions.restore(this.previewHash);
    if (r.cancelled) return;
    if (r.error) { this.hooks.toast(r.error, 'error'); return; }
    this.hooks.toast(r.commit ? 'Version restored and added to the history as a new version.' : 'This version already was the current one.', 'ok');
    this.previewHash = null;
    await this.refresh();
    await this.hooks.show(null, true);
  }

  private render(): void {
    const { commits, problems, dirtyFiles } = this.log;
    const n = commits.length;
    const idx = this.index();
    const ui = this.ui;
    const pos = (i: number) => (n === 0 ? '8px' : `calc(8px + (100% - 60px) * ${i / n})`);
    ui.dots.replaceChildren(...commits.map((c, i) => {
      const dot = el('button', { className: 'vdot' + (c.byApp ? ' app' : '') + (c.hash === this.savedHead ? ' saved' : '') + (i === idx ? ' cur' : '') }, el('i'));
      dot.style.left = pos(i);
      const saved = c.hash === this.savedHead ? '\nLast saved' : '';
      dot.title = `${c.subject}\n${who(c)} · ${fmtWhen(c.date, true)}${saved}\n${i === idx ? 'Shown right now' : 'Click to preview this version'}`;
      dot.setAttribute('aria-label', `${c.subject}, ${fmtWhen(c.date, true)}`);
      dot.addEventListener('click', () => void this.select(i));
      return dot;
    }), (() => {
      const live = el('button', { className: 'vdot live' + (idx === n ? ' cur' : '') + (dirtyFiles ? ' dirty' : '') }, el('i'), el('span', { textContent: 'Now' }));
      live.style.left = pos(n);
      live.title = `Now: your current work${dirtyFiles ? `, ${dirtyFiles} change${dirtyFiles === 1 ? '' : 's'} not in any version yet` : ''}`;
      live.addEventListener('click', () => void this.select(n));
      return live;
    })());

    const previewCommit = this.previewHash ? commits.find((c) => c.hash === this.previewHash) : null;
    ui.info.textContent = n === 0 ? '' : `${n + 1} versions`;
    ui.banner.hidden = !previewCommit;
    ui.viewer.classList.toggle('preview', !!previewCommit);
    if (previewCommit) {
      ui.bannerTitle.textContent = `Preview · version ${idx + 1} of ${n + 1}`;
      ui.bannerSub.textContent = `${previewCommit.subject} · ${who(previewCommit)} · ${fmtWhen(previewCommit.date, true)}`;
      ui.bannerSub.title = ui.bannerSub.textContent;
    }
    ui.restore.hidden = !previewCommit;
    ui.live.hidden = !previewCommit;
    ui.problem.hidden = problems.length === 0;
    ui.problem.textContent = problems.join(' ');
    ui.problem.title = problems.join('\n');
  }

  /** Prüfhilfe (nur Tests). */
  state() {
    return { count: this.log.commits.length, index: this.index(), previewing: this.previewHash, subjects: this.log.commits.map((c) => c.subject), byApp: this.log.commits.map((c) => c.byApp), problems: this.log.problems, dirtyFiles: this.log.dirtyFiles };
  }
}
