// Narrow windows (phones, a narrow browser tab of the web version): one view at a time instead of the columns side by
// side, chosen with a tab bar at the bottom. The columns keep their own state (which panel, which file, agent collapsed
// or not): this only decides which one fills the window, so widening the window brings the desktop layout back as it was.

/** What fills the window: the viewer, the agent area, the code column or the sidebar with its rail above it. */
export type CompactView = 'model' | 'agent' | 'code' | 'side';
/** The tabs at the bottom. Parameters and More both show the sidebar, the code is reached from More. */
export type CompactTab = 'model' | 'agent' | 'params' | 'more';

/** Narrow: a phone upright, or on its side (wide but low). Only here: the CSS follows the class `compact` on the body. */
const QUERY = '(max-width: 760px), (max-height: 500px) and (max-width: 1000px)';

export interface CompactHooks {
  /** A tab was pressed: open what it needs (a sidebar panel) and say which view to show. */
  open(tab: CompactTab): CompactView;
  /** Which tab is lit for a view (the sidebar can be Parameters or More). */
  tab(view: CompactView): CompactTab;
  /** The mode changed (window resized, phone turned). */
  changed(on: boolean): void;
  /** The view changed: the terminal needs to fit its new size, and so on. */
  shown(view: CompactView): void;
}

export class CompactLayout {
  on = false;
  view: CompactView = 'model';
  private readonly mq = matchMedia(QUERY);

  constructor(private readonly body: HTMLElement, private readonly bar: HTMLElement, private readonly hooks: CompactHooks) {
    bar.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.addEventListener('click', () => {
      this.show(this.hooks.open(b.dataset.tab as CompactTab));
    }));
    this.mq.addEventListener('change', () => this.apply());
    this.apply();
  }

  /** Shows a view. Outside the narrow mode only remembered, for when the window gets narrow. */
  show(view: CompactView): void {
    this.view = view;
    this.body.dataset.view = view;
    this.renderTabs();
    if (this.on) this.hooks.shown(view);
  }

  /** Something closed the view that is shown (a panel, the code): back to the model. */
  closed(view: CompactView): void {
    if (this.view === view) this.show('model');
  }

  /** Lights the tab of the view again, when what the view shows changed (another sidebar panel). */
  renderTabs(): void {
    const tab = this.hooks.tab(this.view);
    this.bar.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tab === tab)));
  }

  /** A dot on a tab: news there that is not seen yet (the agent asks, works). Empty string removes it. */
  mark(tab: CompactTab, state: string): void {
    const b = this.bar.querySelector<HTMLElement>(`[data-tab="${tab}"]`);
    if (b) b.dataset.mark = state;
  }

  private apply(): void {
    const on = this.mq.matches;
    if (on === this.on) return;
    this.on = on;
    document.body.classList.toggle('compact', on);
    this.bar.hidden = !on;
    this.hooks.changed(on);
    this.show(this.view);
  }
}
