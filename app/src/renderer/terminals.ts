import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';

interface Tab { id: number; term: Terminal; fit: FitAddon; pane: HTMLElement; button: HTMLElement; exited: boolean }

/** Terminal-Tabs (xterm.js). Jedes Terminal ist eine normale Shell im Projektordner (E19), Agenten laufen darin. */
export class TerminalTabs {
  private tabs = new Map<number, Tab>();
  private active: number | null = null;

  constructor(private tabBar: HTMLElement, private panes: HTMLElement, private addButton: HTMLElement) {
    window.cadide.term.onData((id, data) => this.tabs.get(id)?.term.write(data));
    window.cadide.term.onExit((id, code) => {
      const t = this.tabs.get(id);
      if (!t) return;
      t.exited = true;
      t.term.write(`\r\n\x1b[90m[Prozess beendet, Code ${code}]\x1b[0m\r\n`);
    });
    new ResizeObserver(() => this.fitActive()).observe(panes);
    addButton.addEventListener('click', () => void this.add());
  }

  async add(opts: { command?: string; title?: string } = {}): Promise<number> {
    const id = await window.cadide.term.create({ command: opts.command });
    const term = new Terminal({
      fontFamily: '"Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace', fontSize: 13, cursorBlink: true,
      scrollback: 5000, theme: { background: '#1a1d21', foreground: '#dde2ea' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const pane = document.createElement('div');
    pane.className = 'term-pane';
    pane.hidden = true;
    this.panes.appendChild(pane);
    term.open(pane);
    term.onData((d) => window.cadide.term.write(id, d));
    term.onResize(({ cols, rows }) => window.cadide.term.resize(id, cols, rows));

    const button = document.createElement('button');
    button.className = 'tab term-tab';
    button.textContent = opts.title ?? `Terminal ${this.tabs.size + 1}`;
    const x = document.createElement('span');
    x.className = 'x'; x.textContent = '×'; x.title = 'Terminal schließen';
    x.addEventListener('click', (e) => { e.stopPropagation(); this.close(id); });
    button.appendChild(x);
    button.addEventListener('click', () => this.activate(id));
    this.tabBar.insertBefore(button, this.addButton);

    this.tabs.set(id, { id, term, fit, pane, button, exited: false });
    this.activate(id);
    return id;
  }

  activate(id: number): void {
    for (const t of this.tabs.values()) {
      const on = t.id === id;
      t.pane.hidden = !on;
      t.button.classList.toggle('active', on);
    }
    this.active = id;
    requestAnimationFrame(() => { this.fitActive(); this.tabs.get(id)?.term.focus(); });
  }

  close(id: number): void {
    const t = this.tabs.get(id);
    if (!t) return;
    window.cadide.term.kill(id);
    t.term.dispose(); t.pane.remove(); t.button.remove();
    this.tabs.delete(id);
    if (this.active === id) {
      const next = [...this.tabs.keys()].pop();
      this.active = null;
      if (next !== undefined) this.activate(next);
    }
  }

  closeAll(): void { for (const id of [...this.tabs.keys()]) this.close(id); }
  get count(): number { return this.tabs.size; }
  get activeId(): number | null { return this.active; }

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
    const lines: string[] = [];
    for (let i = 0; i < buf.length; i++) lines.push(buf.getLine(i)?.translateToString(true) ?? '');
    return lines.join('\n');
  }
}
