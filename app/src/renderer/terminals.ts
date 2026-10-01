import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { icon } from './icons';
import { el } from './ui';

interface Tab { id: number; term: Terminal; fit: FitAddon; pane: HTMLElement; tab: HTMLElement; title: string; agent: boolean; exited: boolean }

/**
 * Terminal-Tabs (xterm.js). Jedes Terminal ist eine normale Shell im Projektordner (E19), Agenten laufen darin.
 * Eingeklappt zeigt der Bereich nur eine schmale Leiste mit den Tabs, die Terminals laufen weiter.
 */
export class TerminalTabs {
  private tabs = new Map<number, Tab>();
  private active: number | null = null;
  /** Klick auf einen Tab der eingeklappten Leiste: der Bereich soll aufgehen. */
  onStripClick: () => void = () => {};

  constructor(private tabBar: HTMLElement, private panes: HTMLElement, private anchor: HTMLElement, private strip: HTMLElement) {
    window.soma.term.onData((id, data) => this.tabs.get(id)?.term.write(data));
    window.soma.term.onExit((id, code) => {
      const t = this.tabs.get(id);
      if (!t) return;
      t.exited = true;
      t.tab.classList.add('exited');
      t.term.write(`\r\n\x1b[90m[Prozess beendet, Code ${code}]\x1b[0m\r\n`);
      this.renderStrip();
    });
    new ResizeObserver(() => this.fitActive()).observe(panes);
  }

  async add(opts: { command?: string; title?: string } = {}): Promise<number> {
    const id = await window.soma.term.create({ command: opts.command });
    const term = new Terminal({
      fontFamily: '"IBM Plex Mono", "Cascadia Mono", Consolas, monospace', fontSize: 13, lineHeight: 1.2, cursorBlink: true, scrollback: 5000,
      theme: { background: '#0f1114', foreground: '#c9ced4', cursor: '#e6e8eb', selectionBackground: 'rgba(242,154,56,0.30)', black: '#1b1e23', brightBlack: '#7f8994' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const pane = el('div', { className: 'term-pane' });
    pane.hidden = true;
    this.panes.appendChild(pane);
    term.open(pane);
    term.onData((d) => window.soma.term.write(id, d));
    term.onResize(({ cols, rows }) => window.soma.term.resize(id, cols, rows));

    const agent = !!opts.command;
    const title = opts.title ?? (this.tabs.size ? `Terminal ${this.tabs.size + 1}` : 'Terminal');
    const label = el('button', { className: 't', title: agent ? `${title} läuft in einer Shell im Modellordner` : 'Shell im Modellordner' },
      agent ? el('span', { className: 'dot' }) : icon('term', 14, 2), el('span', { textContent: title }));
    const x = el('button', { className: 'x', title: `${title} schließen` }, icon('x', 12, 2.2));
    x.setAttribute('aria-label', `${title} schließen`);
    x.addEventListener('click', (e) => { e.stopPropagation(); this.close(id); });
    label.addEventListener('click', () => this.activate(id));
    const tab = el('div', { className: 'tab' }, label, x);
    this.tabBar.insertBefore(tab, this.anchor);

    this.tabs.set(id, { id, term, fit, pane, tab, title, agent, exited: false });
    this.activate(id);
    return id;
  }

  activate(id: number): void {
    for (const t of this.tabs.values()) {
      const on = t.id === id;
      t.pane.hidden = !on;
      t.tab.classList.toggle('on', on);
    }
    this.active = id;
    this.renderStrip();
    requestAnimationFrame(() => { this.fitActive(); this.tabs.get(id)?.term.focus(); });
  }

  close(id: number): void {
    const t = this.tabs.get(id);
    if (!t) return;
    window.soma.term.kill(id);
    t.term.dispose(); t.pane.remove(); t.tab.remove();
    this.tabs.delete(id);
    if (this.active === id) {
      const next = [...this.tabs.keys()].pop();
      this.active = null;
      if (next !== undefined) this.activate(next);
    }
    this.renderStrip();
  }

  closeAll(): void { for (const id of [...this.tabs.keys()]) this.close(id); }
  get count(): number { return this.tabs.size; }
  get activeId(): number | null { return this.active; }
  get activeTitle(): string | null { return this.active != null ? this.tabs.get(this.active)?.title ?? null : null; }

  /**
   * Text in die Eingabezeile des aktiven Terminals einfügen, ohne abzuschicken (E11). Läuft als Einfügen (bracketed paste),
   * damit Agenten den Text nicht als Tastenkürzel deuten. Liefert den Tab-Titel oder null, wenn kein Terminal offen ist.
   */
  insert(text: string): string | null {
    const t = this.active != null ? this.tabs.get(this.active) : undefined;
    if (!t || t.exited) return null;
    t.term.paste(text);
    t.term.focus();
    return t.title;
  }

  /** Nach dem Ausklappen: Größe neu berechnen. */
  refit(): void { requestAnimationFrame(() => this.fitActive()); }

  private renderStrip(): void {
    this.strip.replaceChildren(...[...this.tabs.values()].map((t) => {
      const b = el('button', { className: (t.id === this.active ? 'on' : '') + (t.exited ? ' exited' : ''), title: `${t.title} (Agent-Bereich ausklappen)` },
        t.agent ? el('span', { className: 'dot' }) : icon('term', 14, 2), el('span', { className: 'v', textContent: t.title }));
      b.addEventListener('click', () => { this.activate(t.id); this.onStripClick(); });
      return b;
    }));
  }

  private fitActive(): void {
    const t = this.active != null ? this.tabs.get(this.active) : undefined;
    if (!t || t.pane.hidden || !t.pane.clientWidth) return;
    try { t.fit.fit(); } catch { /* Bereich noch ohne Größe */ }
  }

  /** Sichtbarer Text des Terminals (für Tests). */
  text(id: number): string {
    const t = this.tabs.get(id);
    if (!t) return '';
    const buf = t.term.buffer.active;
    let text = '';
    for (let i = 0; i < buf.length; i++) {
      const line = buf.getLine(i);
      // Umgebrochene Zeilen gehören zusammen, sonst zerfällt langer Text beim Suchen
      text += (i && !line?.isWrapped ? '\n' : '') + (line?.translateToString(!buf.getLine(i + 1)?.isWrapped) ?? '');
    }
    return text;
  }
}
