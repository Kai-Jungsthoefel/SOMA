import { icon } from './icons';
import { el } from './ui';

/** Ein Schritt der Tour. Texte sind fest (englisch, E73), nichts aus dem Projekt. */
export interface TourStep {
  title: string;
  /** Text der Karte, als Funktion, wenn er vom Zustand abhängt (etwa gefundene Agenten). */
  text: string | (() => string);
  /** Hervorgehobenes Element (mehrere: gemeinsamer Rahmen). Fehlt es oder ist unsichtbar, steht die Karte in der Mitte. */
  target?: () => (HTMLElement | null)[];
  /** Beim Betreten: nötiges Panel oder Werkzeug öffnen. */
  enter?: () => void | Promise<void>;
  /** Beim Verlassen: aufräumen, was den nächsten Schritt stören würde. */
  leave?: () => void;
  /** Hat der Nutzer getan, wozu der Schritt einlädt? Zeigt nur einen Haken, „Next“ geht immer. */
  done?: () => boolean;
}

interface Deps {
  /** Liegt gerade etwas über dem Modellfenster (Startseite, Hilfe, Einstellungen)? Dann wartet die Tour unsichtbar. */
  covered(): boolean;
  /** Tour zu Ende, `finished`: bis zum letzten Schritt durchlaufen (sonst übersprungen). */
  ended(finished: boolean): void;
}

const GAP = 14;
const MARGIN = 12;

/**
 * Geführte Tour (E94): eine Karte mit „Step n of m“, Titel, Text und Back, Skip, Next, dazu ein oranger Rahmen um das
 * Element des Schritts, der Rest leicht abgedunkelt. Rahmen und Abdunklung lassen Klicks durch (pointer-events: none), der
 * Nutzer probiert also direkt an der echten Oberfläche aus. Die Lage folgt dem Element in jedem Frame: Panels gehen auf,
 * das Fenster ändert seine Größe. Fehlt ein Element, steht die Karte ohne Rahmen in der Mitte, statt zu scheitern.
 */
export class Tour {
  private layer: HTMLElement;
  private spot: HTMLElement;
  /** Abdunklung um das Element: vier Flächen oben, unten, links, rechts (ein riesiger Schatten wird bei großen Elementen nicht gezeichnet). */
  private dims: HTMLElement[];
  private card: HTMLElement;
  private count: HTMLElement;
  private check: HTMLElement;
  private title: HTMLElement;
  private text: HTMLElement;
  private back: HTMLButtonElement;
  private next: HTMLButtonElement;
  private i = -1;
  private raf = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private last = '';
  private steps: TourStep[] = [];

  constructor(private deps: Deps) {
    this.spot = el('div', { className: 'tour-spot' });
    this.dims = [0, 1, 2, 3].map(() => el('div', { className: 'tour-dim' }));
    this.count = el('span', { className: 'tour-n' });
    this.check = el('span', { className: 'tour-ok', title: 'Done' }, icon('check', 14, 2.4), 'Done');
    this.title = el('b', { className: 'tour-t' });
    this.text = el('p', { className: 'tour-x' });
    this.back = el('button', { className: 'btn sm', id: 'btn-tour-back', textContent: 'Back' });
    this.next = el('button', { className: 'btn sm primary', id: 'btn-tour-next', textContent: 'Next' });
    const skip = el('button', { className: 'btn sm ghost', id: 'btn-tour-skip', textContent: 'Skip', title: 'End the tutorial (Escape). Help can start it again.' });
    this.card = el('div', { className: 'tour-card', id: 'tour-card' },
      el('div', { className: 'tour-hd' }, this.count, this.check),
      this.title, this.text,
      el('div', { className: 'tour-acts' }, skip, el('span', { className: 'grow' }), this.back, this.next));
    this.card.setAttribute('role', 'dialog');
    this.card.setAttribute('aria-label', 'Tutorial');
    this.card.setAttribute('aria-live', 'polite');
    this.layer = el('div', { className: 'tour', id: 'tour', hidden: true }, ...this.dims, this.spot, this.card);
    document.body.append(this.layer);
    this.back.addEventListener('click', () => void this.go(this.i - 1));
    this.next.addEventListener('click', () => { if (this.i >= this.steps.length - 1) this.stop(true); else void this.go(this.i + 1); });
    skip.addEventListener('click', () => this.stop(false));
    // Escape beendet die Tour, aber erst nach Menüs und Werkzeugen (die rufen preventDefault) und nie im Terminal oder
    // Editor: Dort gehört Escape dem Agenten (Claude Code unterbricht damit) und dem Editor
    window.addEventListener('keydown', (e) => {
      if (!this.active || e.key !== 'Escape' || e.defaultPrevented || this.deps.covered()) return;
      if ((e.target as HTMLElement | null)?.closest?.('#terminals, #code-view, input, textarea, select')) return;
      e.preventDefault();
      this.stop(false);
    });
  }

  get active(): boolean { return this.i >= 0; }

  start(steps: TourStep[]): void {
    if (this.active) this.stop(false, false);
    this.steps = steps;
    this.layer.hidden = false;
    void this.go(0);
    const tick = () => { this.place(); this.raf = requestAnimationFrame(tick); };
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(tick);
    // Ein verdecktes oder unsichtbares Fenster bekommt keine Frames: dann wenigstens alle 250 ms nachziehen
    clearInterval(this.timer);
    this.timer = setInterval(() => this.place(), 250);
  }

  /** Beenden, `finished`: mit „Done“ im letzten Schritt. `notify`: dem Aufrufer Bescheid geben. */
  stop(finished: boolean, notify = true): void {
    if (!this.active) return;
    try { this.steps[this.i]?.leave?.(); } catch { /* Aufräumen ist verzichtbar */ }
    this.i = -1;
    cancelAnimationFrame(this.raf);
    clearInterval(this.timer);
    this.layer.hidden = true;
    this.last = '';
    if (notify) this.deps.ended(finished);
  }

  private async go(i: number): Promise<void> {
    if (i < 0 || i >= this.steps.length) return;
    if (this.i >= 0 && this.i !== i) { try { this.steps[this.i].leave?.(); } catch { /* weiter */ } }
    this.i = i;
    const s = this.steps[i];
    this.count.textContent = `Step ${i + 1} of ${this.steps.length}`;
    this.title.textContent = s.title;
    this.text.textContent = typeof s.text === 'function' ? s.text() : s.text;
    this.back.disabled = i === 0;
    this.next.textContent = i === this.steps.length - 1 ? 'Done' : 'Next';
    this.last = '';
    try { await s.enter?.(); } catch { /* Ohne Panel geht der Schritt trotzdem, die Karte steht dann in der Mitte */ }
    if (this.i !== i) return;
    // Der Text kann vom Zustand nach dem Betreten abhängen
    this.text.textContent = typeof s.text === 'function' ? s.text() : s.text;
    this.place();
    this.next.focus({ preventScroll: true });
  }

  /** Gemeinsamer Rahmen der sichtbaren Zielelemente, null ohne. */
  private targetRect(): DOMRect | null {
    const s = this.steps[this.i];
    let els: (HTMLElement | null)[] = [];
    try { els = s?.target?.() ?? []; } catch { els = []; }
    const rs = els.filter((e): e is HTMLElement => !!e && e.isConnected && e.getClientRects().length > 0)
      .map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0 && r.height > 0);
    if (!rs.length) return null;
    const x = Math.min(...rs.map((r) => r.left)), y = Math.min(...rs.map((r) => r.top));
    const r = new DOMRect(x, y, Math.max(...rs.map((r) => r.right)) - x, Math.max(...rs.map((r) => r.bottom)) - y);
    // Nur was im Fenster liegt
    const l = Math.max(0, r.left), t = Math.max(0, r.top), rr = Math.min(innerWidth, r.right), b = Math.min(innerHeight, r.bottom);
    return rr - l > 0 && b - t > 0 ? new DOMRect(l, t, rr - l, b - t) : null;
  }

  /** Rahmen und Karte an das Element legen. Läuft in jedem Frame, schreibt nur bei einer Änderung. */
  private place(): void {
    if (!this.active) return;
    const covered = this.deps.covered();
    this.layer.classList.toggle('covered', covered);
    if (covered) return;
    const s = this.steps[this.i];
    let done = false;
    try { done = !!s.done?.(); } catch { done = false; }
    this.check.hidden = !done;
    if (typeof s.text === 'function') { const t = s.text(); if (this.text.textContent !== t) this.text.textContent = t; }
    const r = this.targetRect();
    const cw = this.card.offsetWidth, ch = this.card.offsetHeight;
    const key = `${r ? [r.left, r.top, r.width, r.height].map(Math.round).join(',') : '-'}|${innerWidth}x${innerHeight}|${cw}x${ch}`;
    if (key === this.last) return;
    this.last = key;
    this.spot.hidden = !r;
    for (const d of this.dims) d.hidden = !r;
    this.layer.classList.toggle('free', !r);
    if (!r) {
      this.card.style.left = `${Math.max(MARGIN, (innerWidth - cw) / 2)}px`;
      this.card.style.top = `${Math.max(MARGIN, (innerHeight - ch) / 2)}px`;
      return;
    }
    const pad = 4;
    const L = r.left - pad, T = r.top - pad, R = r.right + pad, B = r.bottom + pad;
    Object.assign(this.spot.style, { left: `${L}px`, top: `${T}px`, width: `${R - L}px`, height: `${B - T}px` });
    const box = (d: HTMLElement, x: number, y: number, w: number, h: number) => Object.assign(d.style, { left: `${x}px`, top: `${y}px`, width: `${Math.max(0, w)}px`, height: `${Math.max(0, h)}px` });
    box(this.dims[0], 0, 0, innerWidth, T);
    box(this.dims[1], 0, B, innerWidth, innerHeight - B);
    box(this.dims[2], 0, T, L, B - T);
    box(this.dims[3], R, T, innerWidth - R, B - T);
    // Neben das Element, wo Platz ist: rechts, links, darunter, darüber. Sonst innen unten rechts (große Bereiche wie der Viewer)
    const fits = (x: number, y: number) => x >= MARGIN && y >= MARGIN && x + cw <= innerWidth - MARGIN && y + ch <= innerHeight - MARGIN;
    const clampY = (y: number) => Math.max(MARGIN, Math.min(innerHeight - ch - MARGIN, y));
    const clampX = (x: number) => Math.max(MARGIN, Math.min(innerWidth - cw - MARGIN, x));
    const cy = clampY(r.top + r.height / 2 - ch / 2), cx = clampX(r.left + r.width / 2 - cw / 2);
    const tries: [number, number][] = [
      [r.right + GAP, cy], [r.left - GAP - cw, cy], [cx, r.bottom + GAP], [cx, r.top - GAP - ch],
    ];
    const at = tries.find(([x, y]) => fits(x, y)) ?? [clampX(r.right - cw - 24), clampY(r.bottom - ch - 24)];
    this.card.style.left = `${Math.round(at[0])}px`;
    this.card.style.top = `${Math.round(at[1])}px`;
  }

  /** Für die Tests: Schritt, Titel, ob das Ziel gefunden und hervorgehoben ist, Lage der Karte. */
  state() {
    const r = this.active ? this.targetRect() : null;
    const c = this.card.getBoundingClientRect();
    return {
      active: this.active, step: this.i + 1, count: this.steps.length, title: this.active ? this.title.textContent : '',
      text: this.active ? this.text.textContent : '', target: !!r, spot: this.active && !this.spot.hidden, done: this.active && !this.check.hidden,
      next: this.next.textContent, backDisabled: this.back.disabled,
      card: { x: c.left, y: c.top, w: c.width, h: c.height }, view: { w: innerWidth, h: innerHeight },
      titles: this.steps.map((s) => s.title),
    };
  }

  /** Für die Tests: direkt zu einem Schritt (1-basiert). */
  goTo(n: number): Promise<void> { return this.go(n - 1); }
}

/** Was die Schritte von der Oberfläche brauchen (main.ts). */
export interface TourContext {
  showPanel(p: 'params' | 'files' | null): void;
  showCode(on: boolean): void;
  openCode(file: string): void;
  expandAgent(): void;
  /** SOMA AI's tab to the front, its pane (null without it). `chatSetUp`: signed in, the chat is ready. */
  showChat(): void;
  chatPane(): HTMLElement | null;
  chatSetUp(): boolean;
  /** The + menu of the agent area: open it (the step about an own agent shows it), close it, is it open. */
  openAgentMenu(): void;
  closeAgentMenu(): void;
  agentMenu(): HTMLElement | null;
  /** Gefundene Agenten (Namen), null solange die Suche läuft. */
  agentsFound(): string[] | null;
  selected(): boolean;
  measuring(): boolean;
  stopMeasure(): void;
  marking(): boolean;
  /** Markierung schließen, wenn noch nichts gezeichnet ist (eine Zeichnung wird nicht still verworfen). */
  closeEmptyMarkup(): void;
  paramsChanged(): boolean;
}

const byId = (id: string) => document.getElementById(id);

/**
 * Die Schritte der Tour am Beispielmodell (Kiste mit Deckel aus der Vorlage, Parameter Length, Width, Height, Wall). Texte
 * kurz und schlicht wie in der Anleitung (resources/skills/soma-app.md), Knöpfe mit dem Namen, den sie in der App tragen.
 */
export function tourSteps(c: TourContext): TourStep[] {
  return [
    {
      title: 'Welcome to SOMA',
      text: 'This is an example model: a box with a lid. In the middle is the 3D view, on the right the agent, on the left the sidebar. Rotate the view with the left mouse button, zoom with the wheel.',
      target: () => [byId('center')],
      enter: () => { c.showCode(false); c.showPanel(null); },
    },
    // SOMA AI, the agent built into SOMA (wish of the user: explain its window, and show at + that an own agent works too)
    {
      title: 'SOMA AI, your agent',
      text: () => 'SOMA AI is the AI agent built into SOMA. Tell it in your own words what you want, for example “Make the lid 5 mm thicker”, or add a photo of a sketch with the clip. It writes the model and you see it in the middle right away.'
        + (c.chatSetUp() ? '' : ' The first time it needs a sign-in: your ChatGPT plan or an API key. You can follow this tutorial without one.'),
      target: () => [c.chatPane()],
      enter: () => { c.expandAgent(); c.showChat(); },
    },
    {
      title: 'While SOMA AI works',
      text: 'Every step shows up in plain words, Details tells exactly what happened. When it needs a decision, it asks with answers to click, or you type your own. Above the input you see that it is working and for how long, Esc stops it. The button next to Send picks the AI model, the clock at the top brings back earlier conversations.',
      target: () => [c.chatPane()],
      enter: () => { c.expandAgent(); c.showChat(); },
    },
    {
      title: 'Or your own agent',
      text: () => {
        const found = c.agentsFound();
        const intro = 'Already working with Claude Code, Codex or another coding agent? Start it from the + menu in a terminal instead of SOMA AI. It works on the same model, with its own sign-in and settings.';
        // Nicht jeder Agent ist in der Liste: über „Empty terminal“ startet man jeden selbst mit seinem Befehl
        const own = 'Not listed? Choose Empty terminal and start it there with its command.';
        if (found === null || !found.length) return `${intro} ${own}`;
        return `${intro} Found on this computer: ${found.join(', ')}. ${own}`;
      },
      target: () => [byId('btn-term-add'), c.agentMenu()],
      enter: () => { c.expandAgent(); c.openAgentMenu(); },
      leave: () => c.closeAgentMenu(),
    },
    {
      title: 'The model is code',
      text: 'The agent writes the model as CadQuery code in model.py. You don’t have to read or edit it: telling the agent what you want is enough. If you like, you can read and change it here too. Files shows everything in the model folder.',
      target: () => [byId('side'), byId('editor')],
      enter: () => { c.showPanel('files'); c.openCode('model.py'); },
    },
    {
      title: 'Click a part',
      text: 'Click the box or the lid. The card shows the part and its line in the code. Send to agent tells the agent exactly which part you mean.',
      target: () => [byId('viewer')],
      enter: () => { c.showCode(false); c.showPanel(null); },
      done: () => c.selected(),
    },
    {
      title: 'Measure',
      text: 'Click Measure, then a face or an edge for its size. A second click gives distance and angle. The values are exact.',
      target: () => [c.measuring() ? byId('measure-card') : byId('btn-measure')],
      leave: () => c.stopMeasure(),
      done: () => c.measuring(),
    },
    {
      title: 'Mark up and send',
      text: 'Mark up freezes the view so you can draw on it: an arrow, a circle, a dimension. Send to agent saves the picture in the model and passes it to the agent.',
      target: () => [c.marking() ? byId('btn-mark-send') : byId('btn-mark')],
      leave: () => c.closeEmptyMarkup(),
      done: () => c.marking(),
    },
    {
      title: 'Change a value',
      text: 'The agent decides which values you can change here. Change Height and watch the model rebuild. The arrow next to a changed value brings back the agent’s value.',
      target: () => [byId('panel-params')],
      enter: () => c.showPanel('params'),
      done: () => c.paramsChanged(),
    },
    {
      title: 'History',
      text: 'Every change the agent commits adds a dot here, Save adds one too. Click a dot to look at an earlier version. Restore brings it back as a new version, nothing is lost.',
      target: () => [byId('versions')],
      enter: () => c.showPanel(null),
    },
    {
      title: 'Save and export',
      text: 'A model is a single .soma file with code, results and history, like a CAD file. Save (Ctrl S) asks for a place the first time. Export writes parts as STL, 3MF, STEP and more.',
      target: () => [byId('btn-export'), byId('btn-save')],
    },
    {
      title: 'Help is always here',
      text: 'Help (F1) explains every part of the window. The agent knows this guide too, so you can just ask it. You can start this tutorial again from Help.',
      target: () => [byId('btn-help')],
    },
  ];
}
