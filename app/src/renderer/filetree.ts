import type { FileNode } from '../shared/types';
import { icon } from './icons';
import { el } from './ui';

/** Dateien, die die App verwaltet. Sie stehen eingeklappt unter „Vom Programm verwaltet“, damit der Baum ruhig bleibt. */
const MANAGED = new Set(['AGENTS.md', 'CLAUDE.md', '.gitignore']);
const TAGS: Record<string, string> = { 'model.py': 'Modell', 'output/model.step': 'Ergebnis', 'NOTES.md': 'Notizen', 'requirements.txt': 'Pakete' };
export const TEXT_EXT = /\.(py|md|txt|json|toml|cfg|ini|yml|yaml|gitignore|csv)$|^[^.]*$/i;

/** Dateien-Panel: kompakter Baum, Ordner einklappbar. Ein Klick auf eine Textdatei öffnet sie im Code-Panel. */
export class FileTree {
  private collapsed = new Set<string>(['#managed']);
  private nodes: FileNode[] = [];

  constructor(private root: HTMLElement, private onOpen: (node: FileNode) => void) {}

  render(nodes: FileNode[] = this.nodes): void {
    this.nodes = nodes;
    const managed = nodes.filter((n) => !n.dir && MANAGED.has(n.name));
    const rest = nodes.filter((n) => !managed.includes(n));
    const rows: HTMLElement[] = [];
    const walk = (list: FileNode[], depth: number) => {
      for (const n of list) {
        rows.push(this.row(n, depth));
        if (n.dir && n.children && !this.collapsed.has(n.path)) walk(n.children, depth + 1);
      }
    };
    walk(rest, 0);
    if (!rest.length) rows.push(el('div', { className: 'hint', textContent: 'Noch keine Dateien.' }));
    if (managed.length) {
      rows.push(el('div', { className: 'gap' }));
      const open = !this.collapsed.has('#managed');
      const head = this.button(0, open ? 'down' : 'right', 'lock', 'Vom Programm verwaltet', String(managed.length), 'dim');
      head.title = 'Diese Dateien legt die App an und erneuert sie bei Updates. Ändern ist nicht nötig.';
      head.setAttribute('aria-expanded', String(open));
      head.addEventListener('click', () => this.toggle('#managed'));
      rows.push(head);
      if (open) for (const n of managed) rows.push(this.row(n, 1));
    }
    this.root.replaceChildren(...rows);
  }

  private toggle(key: string): void {
    if (this.collapsed.has(key)) this.collapsed.delete(key); else this.collapsed.add(key);
    this.render();
  }

  private row(n: FileNode, depth: number): HTMLElement {
    if (n.dir) {
      const open = !this.collapsed.has(n.path);
      const b = this.button(depth, open ? 'down' : 'right', 'folder', n.name, '', 'dir');
      b.setAttribute('aria-expanded', String(open));
      b.title = n.path;
      b.addEventListener('click', () => this.toggle(n.path));
      return b;
    }
    const b = this.button(depth, null, 'file', n.name, TAGS[n.path] ?? '', '');
    b.title = TEXT_EXT.test(n.name) ? `${n.path} im Code-Panel öffnen` : n.path;
    b.addEventListener('click', () => this.onOpen(n));
    return b;
  }

  private button(depth: number, chev: string | null, ico: string, name: string, tag: string, cls: string): HTMLButtonElement {
    const b = el('button', { className: 'frow' + (cls ? ' ' + cls : '') },
      el('span', { className: 'chev' }, chev ? icon(chev, 12, 2.2) : ''),
      el('span', { className: 'fi' }, icon(ico, 15)),
      el('span', { className: 'fn', textContent: name }),
      tag ? el('span', { className: 'tag', textContent: tag }) : null);
    b.style.paddingLeft = `${8 + depth * 18}px`;
    return b;
  }
}
