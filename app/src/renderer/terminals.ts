import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
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
  /** Reihenfolge des Aktivierens (zuletzt aktiviert hinten), damit Einfügen das zuletzt benutzte Terminal findet. */
  private used: number[] = [];
  /** Klick auf einen Tab der eingeklappten Leiste: der Bereich soll aufgehen. */
  onStripClick: () => void = () => {};

  constructor(private tabBar: HTMLElement, private panes: HTMLElement, private anchor: HTMLElement, private strip: HTMLElement) {
    window.soma.term.onData((id, data) => this.tabs.get(id)?.term.write(data));
    window.soma.term.onExit((id, code) => {
      const t = this.tabs.get(id);
      if (!t) return;
      t.exited = true;
      t.tab.classList.add('exited');
      t.term.write(`\r\n\x1b[90m[Process ended, code ${code}]\x1b[0m\r\n`);
      this.renderStrip();
    });
    new ResizeObserver(() => this.fitActive()).observe(panes);
  }

  async add(opts: { command?: string; title?: string } = {}): Promise<number> {
    const id = await window.soma.term.create({ command: opts.command });
    const term = new Terminal({
      fontFamily: '"IBM Plex Mono", "Cascadia Mono", Consolas, monospace', fontSize: 13, lineHeight: 1, cursorBlink: true, scrollback: 5000,
      theme: { background: '#0f1114', foreground: '#c9ced4', cursor: '#e6e8eb', selectionBackground: 'rgba(242,154,56,0.30)', black: '#1b1e23', brightBlack: '#7f8994' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const pane = el('div', { className: 'term-pane' });
    pane.hidden = true;
    this.panes.appendChild(pane);
    term.open(pane);
    // WebGL zeichnet Block- und Rahmenzeichen selbst über die volle Zellhöhe. Der DOM-Renderer nimmt die Schriftglyphen,
    // die die Zelle nicht immer ganz füllen (OpenCode-Seitenleisten erscheinen sonst gestrichelt). Ohne WebGL oder nach
    // Kontextverlust (zu viele Kontexte neben dem 3D-Viewer) bleibt der DOM-Renderer als Rückfallweg.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch { /* DOM-Renderer */ }
    term.onData((d) => window.soma.term.write(id, d));
    // Strg+V selbst einfügen: xterm schickt sonst nur das Steuerzeichen ^V. PowerShell liest daraufhin die Zwischenablage
    // selbst, Agenten wie OpenCode erwarten aber ein echtes Einfügen (bracketed paste). Ohne Text in der Zwischenablage
    // (etwa ein Bild) geht ^V weiter, damit der Agent sie selbst lesen kann.
    term.attachCustomKeyEventHandler((e) => {
      if (!e.ctrlKey || e.altKey || e.metaKey || e.key.toLowerCase() !== 'v') return true;
      e.preventDefault();
      if (e.type === 'keydown') {
        void navigator.clipboard.readText().catch(() => '').then((text) => {
          if (text) term.paste(text); else window.soma.term.write(id, '\x16');
        });
      }
      return false;
    });
    term.onResize(({ cols, rows }) => window.soma.term.resize(id, cols, rows));

    const agent = !!opts.command;
    const title = opts.title ?? (this.tabs.size ? `Terminal ${this.tabs.size + 1}` : 'Terminal');
    const label = el('button', { className: 't', title: agent ? `${title} runs in a shell in the model folder` : 'Shell in the model folder' },
      agent ? el('span', { className: 'dot' }) : icon('term', 14, 2), el('span', { textContent: title }));
    const x = el('button', { className: 'x', title: `Close ${title}` }, icon('x', 12, 2.2));
    x.setAttribute('aria-label', `Close ${title}`);
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
    this.used = [...this.used.filter((x) => x !== id), id];
    this.renderStrip();
    requestAnimationFrame(() => { this.fitActive(); this.tabs.get(id)?.term.focus(); });
  }

  close(id: number): void {
    const t = this.tabs.get(id);
    if (!t) return;
    window.soma.term.kill(id);
    t.term.dispose(); t.pane.remove(); t.tab.remove();
    this.tabs.delete(id);
    this.used = this.used.filter((x) => x !== id);
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

  /** Laufende Terminals, zuletzt benutztes zuerst: das aktive, dann die übrigen in umgekehrter Reihenfolge des Aktivierens. */
  private live(): Tab[] {
    return [...this.used].reverse().map((id) => this.tabs.get(id)).filter((t): t is Tab => !!t && !t.exited);
  }

  /**
   * Text in die Eingabezeile einfügen, ohne abzuschicken (E11). Läuft als Einfügen (bracketed paste), damit Agenten den
   * Text nicht als Tastenkürzel deuten. Ziel ist das aktive Terminal. Ist es beendet, das zuletzt benutzte, das noch läuft:
   * Es kommt nach vorn, damit man sieht, wo der Text gelandet ist. Liefert den Tab-Titel oder null, wenn keines mehr läuft.
   */
  insert(text: string): string | null {
    const t = this.live()[0];
    if (!t) return null;
    if (t.id !== this.active) this.activate(t.id);
    t.term.paste(text);
    t.term.focus();
    return t.title;
  }

  /** Nach dem Ausklappen: Größe neu berechnen. */
  refit(): void { requestAnimationFrame(() => this.fitActive()); }

  private renderStrip(): void {
    this.strip.replaceChildren(...[...this.tabs.values()].map((t) => {
      const b = el('button', { className: (t.id === this.active ? 'on' : '') + (t.exited ? ' exited' : ''), title: `${t.title} (expand the agent area)` },
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
