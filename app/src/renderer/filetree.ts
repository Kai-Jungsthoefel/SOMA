import { fileOpBlockReason } from '../shared/editable';
import type { FileNode } from '../shared/types';
import { icon } from './icons';
import { el, menuItem, menus } from './ui';

/** Dateien, die die App verwaltet. Sie stehen eingeklappt unter „Vom Programm verwaltet“, damit der Baum ruhig bleibt. */
const MANAGED = new Set(['AGENTS.md', 'CLAUDE.md', '.gitignore']);
const TAGS: Record<string, string> = { 'model.py': 'model', 'output/model.step': 'result', 'NOTES.md': 'notes', 'requirements.txt': 'packages' };
/** Ordner der Markierungen. Der Hauptprozess liefert ihn als einzigen Teil von .soma/ mit. */
const FEEDBACK = '.soma/feedback';
export const TEXT_EXT = /\.(py|md|txt|json|toml|cfg|ini|yml|yaml|gitignore|csv)$|^[^.]*$/i;
/** Bilder, die die Zeichenfläche als Hintergrund laden kann (alles, was Chromium als <img> anzeigt). */
export const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
/** Videos, die die App abspielt (E58). MOV meist nur, wenn H.264 darin steckt. */
export const VIDEO_EXT = /\.(mp4|webm|m4v|mov)$/i;
/** Datentyp beim Ziehen einer Datei ins Terminal (Wert: Pfad relativ zum Projekt). */
export const DRAG_FILE = 'application/x-soma-file';

/** Was der Baum vom Rest der App braucht. Die Aktionen liefern true, wenn das Namensfeld zugehen darf. */
export interface FileTreeDeps {
  open(node: FileNode): void;
  create(parent: string, name: string, dir: boolean): Promise<boolean>;
  rename(rel: string, name: string): Promise<boolean>;
  trash(rel: string): void;
  reveal(rel: string): void;
  openExternal(rel: string): void;
  /** Bild als Hintergrund der Markierung öffnen (E16). */
  mark(rel: string): void;
  toAgent(rel: string): void;
  copyPath(rel: string): void;
}

/** Offenes Namensfeld: neue Datei oder neuer Ordner in `parent`, oder Umbenennen von `node`. */
type Edit = { mode: 'file' | 'dir'; parent: string } | { mode: 'rename'; node: FileNode };

/**
 * Symbol nach Dateityp, damit man Skripte, Tabellen, CAD-Dateien und Bilder auf einen Blick unterscheidet. Nur die Form
 * unterscheidet sich, nicht die Farbe: Farben haben in der Oberfläche feste Bedeutungen (Aktion, Vorschau, Status).
 */
const FILE_ICONS: [RegExp, string][] = [
  [/\.(py|pyw)$/i, 'f-py'],
  [/\.(md|txt|rst|log)$|^[^.]*$/i, 'f-text'],
  [/\.(csv|tsv|xlsx?|ods)$/i, 'f-table'],
  [/\.(json|toml|ya?ml|ini|cfg|xml)$/i, 'f-data'],
  [/\.(step|stp|iges|igs|brep|x_t|sat)$/i, 'f-cad'],
  [/\.(stl|3mf|obj|glb|gltf|ply|amf)$/i, 'f-mesh'],
  [/\.(dxf|dwg|svg)$/i, 'f-draw'],
  [/\.(png|jpe?g|gif|webp|bmp|tiff?)$/i, 'f-image'],
  [/\.(mp4|webm|m4v|mov)$/i, 'f-video'],
  [/\.pdf$/i, 'f-pdf'],
  [/\.(zip|7z|rar|tar|gz)$/i, 'f-zip'],
  [/^\.gitignore$/i, 'f-lock'],
];
export const fileIcon = (name: string) => FILE_ICONS.find(([re]) => re.test(name))?.[1] ?? 'file';

const parentOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

/**
 * Dateien-Panel: kompakter Baum, Ordner einklappbar. Ein Klick auf eine Textdatei öffnet sie im Code-Panel.
 * Rechtsklick (oder Umschalt+F10) öffnet das Menü mit Anlegen, Umbenennen (F2), Löschen (Entf), Öffnen und Pfad.
 * Was gesperrt ist, regelt `fileOpBlockReason`, dieselbe Regel prüft der Hauptprozess noch einmal.
 */
export class FileTree {
  private collapsed = new Set<string>(['#managed']);
  private nodes: FileNode[] = [];
  private edit: Edit | null = null;
  private input: HTMLInputElement | null = null;
  /** Ein Name wird gerade angelegt oder umbenannt: kein zweites Absenden, auch nicht aus einem neu gezeichneten Feld. */
  private submitting = false;
  /** Im Code offene Datei, hervorgehoben. */
  private active: string | null = null;

  constructor(private root: HTMLElement, private menu: HTMLElement, private deps: FileTreeDeps) {
    root.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const row = (e.target as HTMLElement).closest<HTMLElement>('.frow[data-path]');
      this.openMenu(row ? this.find(row.dataset.path!) : null, e.clientX, e.clientY);
    });
    root.addEventListener('keydown', (e) => {
      if (e.target === this.input) return;
      const row = (e.target as HTMLElement).closest<HTMLElement>('.frow[data-path]');
      const n = row ? this.find(row.dataset.path!) : null;
      if (!n) return;
      if (e.key === 'F2') { e.preventDefault(); this.startRename(n); }
      else if (e.key === 'Delete') { e.preventDefault(); if (!fileOpBlockReason(n.path, 'delete')) deps.trash(n.path); }
      else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
        e.preventDefault();
        const r = row!.getBoundingClientRect();
        this.openMenu(n, r.left + 24, r.bottom);
      }
    });
  }

  render(nodes: FileNode[] = this.nodes): void {
    this.nodes = nodes;
    // Verschwindet die Datei, deren Name gerade bearbeitet wird (etwa durch den Agenten), geht das Feld zu
    if (this.edit?.mode === 'rename' && !this.find(this.edit.node.path) && !this.submitting) { this.edit = null; this.input = null; }
    const managed = nodes.filter((n) => !n.dir && MANAGED.has(n.name));
    const feedback = nodes.find((n) => n.path === FEEDBACK);
    const rest = nodes.filter((n) => !managed.includes(n) && n !== feedback);
    const rows: HTMLElement[] = [];
    const ed = this.edit;
    const walk = (list: FileNode[], depth: number, parent: string) => {
      if (ed && ed.mode !== 'rename' && ed.parent === parent) rows.push(this.inputRow(depth, ed.mode === 'dir' ? 'folder' : 'file', ''));
      for (const n of list) {
        rows.push(ed?.mode === 'rename' && ed.node.path === n.path ? this.inputRow(depth, n.dir ? 'folder' : fileIcon(n.name), n.name) : this.row(n, depth));
        if (n.dir && n.children && !this.collapsed.has(n.path)) walk(n.children, depth + 1, n.path);
      }
    };
    walk(rest, 0, '');
    if (!rest.length && !ed) rows.push(el('div', { className: 'hint', textContent: 'No files yet.' }));
    // Markierungen (E16) aus .soma/feedback/: eigene Gruppe, neueste zuerst. Zum Wiederfinden und erneut an den Agenten geben.
    if (feedback?.children?.length) {
      rows.push(el('div', { className: 'gap' }));
      const open = !this.collapsed.has(FEEDBACK);
      const head = this.button(0, open ? 'down' : 'right', 'image', 'Markups', String(feedback.children.length), 'dim');
      head.title = 'Images from “Mark up”, stored in .soma/feedback/. Click to open for markup, right-click to send the path to the agent or open in an image viewer.';
      head.setAttribute('aria-expanded', String(open));
      head.dataset.path = FEEDBACK;
      head.addEventListener('click', () => this.toggle(FEEDBACK));
      rows.push(head);
      if (open) walk(feedback.children, 1, FEEDBACK);
    }
    if (managed.length) {
      rows.push(el('div', { className: 'gap' }));
      const open = !this.collapsed.has('#managed');
      const head = this.button(0, open ? 'down' : 'right', 'lock', 'Managed by the app', String(managed.length), 'dim');
      head.title = 'The app creates these files and renews them with updates. There is no need to change them.';
      head.setAttribute('aria-expanded', String(open));
      head.addEventListener('click', () => this.toggle('#managed'));
      rows.push(head);
      if (open) for (const n of managed) rows.push(this.row(n, 1));
    }
    const hadFocus = !!this.input && document.activeElement === this.input;
    this.root.replaceChildren(...rows);
    // Neu gezeichnet, während getippt wird (Dateiänderung von außen): Fokus und Eingabe bleiben
    if (hadFocus || this.input?.dataset.fresh) this.focusInput();
  }

  // ---- Anlegen und Umbenennen -----------------------------------------------------------------------------------

  /** Namensfeld für eine neue Datei oder einen neuen Ordner in `parent` ('' = Projektordner). */
  startCreate(parent: string, dir: boolean): void {
    if (fileOpBlockReason(parent, 'create') || this.submitting) return;
    this.edit = { mode: dir ? 'dir' : 'file', parent };
    this.input = null;
    if (parent) this.collapsed.delete(parent); // Ordner aufklappen, damit das Feld zu sehen ist
    this.render();
  }

  startRename(n: FileNode): void {
    if (fileOpBlockReason(n.path, 'rename') || this.submitting) return;
    this.edit = { mode: 'rename', node: n };
    this.input = null;
    this.render();
  }

  private inputRow(depth: number, ico: string, value: string): HTMLElement {
    const prev = this.input;
    // Neu gezeichnet, während das Feld offen ist: das Getippte übernehmen
    const input = el('input', { className: 'fedit', type: 'text', spellcheck: false, autocomplete: 'off', value: prev ? prev.value : value });
    input.setAttribute('aria-label', this.edit?.mode === 'rename' ? 'New name' : this.edit?.mode === 'dir' ? 'Name of the new folder' : 'Name of the new file');
    if (!prev) input.dataset.fresh = '1';
    const finish = async (fromBlur: boolean) => {
      if (this.submitting || this.input !== input) return;
      const ed = this.edit;
      const name = input.value;
      // Unverändert oder leer: einfach zu
      if (!ed || !name.trim() || (ed.mode === 'rename' && name === ed.node.name)) { this.cancelEdit(); return; }
      this.submitting = true;
      let ok = false;
      try { ok = ed.mode === 'rename' ? await this.deps.rename(ed.node.path, name) : await this.deps.create(ed.parent, name, ed.mode === 'dir'); }
      finally { this.submitting = false; }
      if (this.edit !== ed) return;
      // Abgelehnt nach Enter: Feld bleibt offen, damit der Name korrigiert werden kann. Nach dem Verlassen geht es zu.
      if (ok || fromBlur) this.cancelEdit();
      else this.input?.focus();
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // Entf, F2 und Escape gehören hier dem Feld
      if (e.key === 'Enter') { e.preventDefault(); void finish(false); }
      else if (e.key === 'Escape') { e.preventDefault(); this.cancelEdit(); }
    });
    input.addEventListener('blur', () => { if (input.isConnected) void finish(true); });
    this.input = input;
    const row = el('div', { className: 'frow editing' }, el('span', { className: 'chev' }), el('span', { className: 'fi' }, icon(ico, 15)), input);
    row.style.paddingLeft = `${8 + depth * 18}px`;
    return row;
  }

  private focusInput(): void {
    const t = this.input;
    if (!t) return;
    const fresh = !!t.dataset.fresh;
    delete t.dataset.fresh;
    t.focus();
    // Beim Umbenennen den Namen ohne Endung markieren, wie im Explorer
    if (fresh) { const dot = t.value.lastIndexOf('.'); t.setSelectionRange(0, dot > 0 && this.edit?.mode === 'rename' ? dot : t.value.length); }
  }

  private cancelEdit(): void {
    const had = !!this.edit;
    this.edit = null;
    this.input = null;
    if (had) this.render();
  }

  // ---- Menü -----------------------------------------------------------------------------------------------------

  private openMenu(n: FileNode | null, x: number, y: number): void {
    const d = this.deps;
    const folder = n ? (n.dir ? n.path : parentOf(n.path)) : '';
    const blockCreate = fileOpBlockReason(folder, 'create');
    const blocked = (item: HTMLButtonElement, reason: string | null) => { if (reason) { item.disabled = true; item.title = reason; } return item; };
    const items: HTMLElement[] = [el('div', { className: 'mh', textContent: n ? n.name : 'Project folder' })];
    if (n && !n.dir) {
      if (TEXT_EXT.test(n.name) || /\.pdf$/i.test(n.name)) items.push(menuItem('Open', { icon: 'code', onClick: () => d.open(n) }));
      if (IMAGE_EXT.test(n.name)) items.push(menuItem('Mark up', { icon: 'camera', onClick: () => d.mark(n.path) }));
      if (VIDEO_EXT.test(n.name)) items.push(menuItem('Play', { icon: 'play', onClick: () => d.open(n) }));
      items.push(menuItem('Open with default app', { icon: 'openext', onClick: () => d.openExternal(n.path) }));
    }
    items.push(menuItem('Show in Explorer', { icon: 'folder', onClick: () => d.reveal(n?.path ?? '') }));
    if (n) {
      items.push(el('div', { className: 'msep' }),
        menuItem('Send path to agent', { icon: 'send', onClick: () => d.toAgent(n.path) }),
        menuItem('Copy path', { icon: 'copy', onClick: () => d.copyPath(n.path) }));
    }
    items.push(el('div', { className: 'msep' }),
      blocked(menuItem(n?.dir ? 'New file here' : 'New file', { icon: 'fileplus', onClick: () => this.startCreate(folder, false) }), blockCreate),
      blocked(menuItem(n?.dir ? 'New folder here' : 'New folder', { icon: 'folderplus', onClick: () => this.startCreate(folder, true) }), blockCreate));
    if (n) {
      items.push(blocked(menuItem('Rename', { icon: 'pen', kbd: 'F2', onClick: () => this.startRename(n) }), fileOpBlockReason(n.path, 'rename')),
        blocked(menuItem('Delete', { icon: 'trash', kbd: 'Del', onClick: () => d.trash(n.path) }), fileOpBlockReason(n.path, 'delete')));
    }
    this.menu.replaceChildren(...items);
    menus.at(this.menu, x, y);
  }

  // ---- Zeilen ---------------------------------------------------------------------------------------------------

  private find(rel: string, list: FileNode[] = this.nodes): FileNode | null {
    for (const n of list) {
      if (n.path === rel) return n;
      if (n.children) { const c = this.find(rel, n.children); if (c) return c; }
    }
    return null;
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
      b.dataset.path = n.path;
      b.addEventListener('click', () => this.toggle(n.path));
      FileTree.draggable(b, n.path);
      return b;
    }
    const b = this.button(depth, null, fileIcon(n.name), n.name, TAGS[n.path] ?? '', '');
    b.title = TEXT_EXT.test(n.name) || /\.pdf$/i.test(n.name) ? `Open ${n.path} in the code` : IMAGE_EXT.test(n.name) ? `Open ${n.path} for markup`
      : VIDEO_EXT.test(n.name) ? `Play ${n.path}` : n.path;
    b.dataset.path = n.path;
    b.addEventListener('click', () => this.deps.open(n));
    if (n.path === this.active) b.classList.add('sel');
    FileTree.draggable(b, n.path);
    return b;
  }

  /** Datei, die gerade im Code offen ist: im Baum hervorheben, damit man sieht, wo man ist. */
  setActive(rel: string | null): void {
    this.active = rel;
    this.root.querySelectorAll<HTMLElement>('.frow[data-path]').forEach((r) => r.classList.toggle('sel', r.dataset.path === rel));
  }

  /** Ziehen ins Terminal fügt den Pfad ein wie „An Agent geben“ im Kontextmenü. */
  private static draggable(b: HTMLElement, rel: string): void {
    b.draggable = true;
    b.addEventListener('dragstart', (e) => { e.dataTransfer?.setData(DRAG_FILE, rel); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy'; });
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
