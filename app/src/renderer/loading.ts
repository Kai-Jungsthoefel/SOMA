import { $ } from './ui';

/**
 * Loading screen over the whole window while a model is created: "New model", the tutorial, a model from a CadQuery
 * script. Copying the template, the first build and the first commit take a few seconds, then the viewer, the files and
 * the agent panel load. Without it the old model stayed on screen with no sign that anything happened. There is one
 * screen: whoever starts it owns it (the number from start), an older owner cannot close it.
 */
export class Loading {
  private owner = 0;
  private shown = 0;
  private t0 = 0;
  private tick: ReturnType<typeof setInterval> | undefined;
  private waiters: (() => void)[] = [];
  private root = $('app-busy');
  private title = $('app-busy-title');
  private stepEl = $('app-busy-step');
  private file = $('app-busy-file');
  private time = $('app-busy-time');
  private note = $('app-busy-note');

  /** Show the screen now. `note`: a line at the bottom, e.g. that large scripts take a while. Returns the owner number. */
  start(title: string, note = ''): number {
    const id = ++this.owner;
    this.shown = id;
    this.title.textContent = title;
    this.stepEl.textContent = '';
    this.file.textContent = '';
    this.file.hidden = true;
    this.note.textContent = note;
    this.note.hidden = !note;
    this.time.textContent = '';
    this.t0 = performance.now();
    clearInterval(this.tick);
    // Count the seconds: without a progress bar this shows that something is still happening
    this.tick = setInterval(() => { this.time.textContent = `${Math.round((performance.now() - this.t0) / 1000)} s`; }, 1000);
    this.root.hidden = false;
    return id;
  }

  /** Owner number of the shown screen, 0 when none is shown. */
  get active(): number { return this.shown; }

  /** The step that runs now. `file`: the file it is about (the CadQuery script). */
  step(text: string, file?: string): void {
    if (!this.shown) return;
    this.stepEl.textContent = `${text} …`;
    if (file !== undefined) { this.file.textContent = file; this.file.hidden = !file; }
  }

  /** Close the screen, if `id` still owns it (a newer start keeps it open). */
  end(id: number): void {
    if (!this.shown || id !== this.shown) return;
    this.shown = 0;
    clearInterval(this.tick);
    this.root.hidden = true;
    for (const w of this.waiters.splice(0)) w();
  }

  /** Resolves when no screen is shown (any more), e.g. to start the tutorial's tour on a loaded window. */
  closed(): Promise<void> {
    return this.shown ? new Promise((r) => this.waiters.push(r)) : Promise.resolve();
  }

  /** For tests: shown, title, step and file. */
  state(): { shown: boolean; title: string; step: string; file: string; note: string } {
    return { shown: !this.root.hidden, title: this.title.textContent ?? '', step: this.stepEl.textContent ?? '', file: this.file.textContent ?? '', note: this.note.hidden ? '' : this.note.textContent ?? '' };
  }
}
