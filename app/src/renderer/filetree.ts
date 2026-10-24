import { fileOpBlockReason } from '../shared/editable';
import type { FileNode } from '../shared/types';
import { icon } from './icons';
import { el, menuItem, menus } from './ui';

/** Dateien, die die App verwaltet. Sie stehen eingeklappt unter „Vom Programm verwaltet“, damit der Baum ruhig bleibt. */
const MANAGED = new Set(['AGENTS.md', 'CLAUDE.md', '.gitignore']);
const TAGS: Record<string, string> = { 'model.py': 'model', 'output/model.step': 'result', 'NOTES.md': 'notes', 'requirements.txt': 'packages' };
/** Ordner der Markierungen und der Kopien der Skills. Der Hauptprozess liefert nur diese beiden Teile von .soma/ mit. */
const FEEDBACK = '.soma/feedback';
const SKILLS = '.soma/skills';
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
  /** Dateibaum zeigen und die Datei darin finden, mit `rename` gleich das Namensfeld öffnen (Menü aus anderen Panels). */
  showInTree(rel: string, rename: boolean): void;
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
  [/\.(zip|soma|7z|rar|tar|gz)$/i, 'f-zip'],
  [/^\.gitignore$/i, 'f-lock'],
];
export const fileIcon = (name: string) => FILE_ICONS.find(([re]) => re.test(name))?.[1] ?? 'file';

const parentOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

/**
 * Dateien-Panel: kompakter Baum, Ordner anfangs eingeklappt, darüber ein Suchfeld. Ein Klick auf eine Textdatei öffnet sie im Code-Panel.
 * Rechtsklick (oder Umschalt+F10) öffnet das Menü mit Anlegen, Umbenennen (F2), Löschen (Entf), Öffnen und Pfad.
 * Was gesperrt ist, regelt `fileOpBlockReason`, dieselbe Regel prüft der Hauptprozess noch einmal.
 */
export class FileTree {
  /** Aufgeklappte Ordner und Gruppen. Anfangs ist alles zu, sonst wird der Baum mit vielen Unterordnern unübersichtlich. */
  private expanded = new Set<string>();
  /** Suchtext: nur passende Dateien mit ihren Ordnern, dabei alles aufgeklappt. */
  private query = '';
  private search: HTMLInputElement | null = null;
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
    const shown = this.filter(nodes);
    const managed = shown.filter((n) => !n.dir && MANAGED.has(n.name));
    const feedback = shown.find((n) => n.path === FEEDBACK);
    const skills = shown.find((n) => n.path === SKILLS);
    const rest = shown.filter((n) => !managed.includes(n) && n !== feedback && n !== skills);
    const rows: HTMLElement[] = [];
    const ed = this.edit;
    const walk = (list: FileNode[], depth: number, parent: string) => {
      if (ed && ed.mode !== 'rename' && ed.parent === parent) rows.push(this.inputRow(depth, ed.mode === 'dir' ? 'folder' : 'file', ''));
      for (const n of list) {
        rows.push(ed?.mode === 'rename' && ed.node.path === n.path ? this.inputRow(depth, n.dir ? 'folder' : fileIcon(n.name), n.name) : this.row(n, depth));
        if (n.dir && n.children && this.isOpen(n.path)) walk(n.children, depth + 1, n.path);
      }
    };
    /** Kopf einer Gruppe unter den Projektdateien, liefert, ob sie aufgeklappt ist. `rel` macht den Kopf zum Ordner fürs Menü. */
    const group = (key: string, ico: string, label: string, count: number, title: string, rel?: string): boolean => {
      rows.push(el('div', { className: 'gap' }));
      const open = this.isOpen(key);
      const head = this.button(0, open ? 'down' : 'right', ico, label, String(count), 'dim');
      head.title = title;
      head.setAttribute('aria-expanded', String(open));
      if (rel) head.dataset.path = rel;
      head.addEventListener('click', () => this.toggle(key));
      rows.push(head);
      return open;
    };
    walk(rest, 0, '');
    if (this.query && !shown.length) rows.push(el('div', { className: 'hint', textContent: `No file name contains “${this.query}”.` }));
    else if (!rest.length && !ed) rows.push(el('div', { className: 'hint', textContent: 'No files yet.' }));
    // Markierungen (E16) aus .soma/feedback/: eigene Gruppe, neueste zuerst. Zum Wiederfinden und erneut an den Agenten geben.
    if (feedback?.children?.length && group(FEEDBACK, 'image', 'Markups', feedback.children.length,
      'Images from “Mark up”, stored in .soma/feedback/. Click to open for markup, right-click to send the path to the agent or open in an image viewer.', FEEDBACK)) {
      walk(feedback.children, 1, FEEDBACK);
    }
    // Kopien der Skills (E17) aus .soma/skills/: zum Nachlesen, eingeklappt, weil es meist über ein Dutzend sind
    if (skills?.children?.length && group(SKILLS, 'book', 'Skills', skills.children.length,
      'Copies of the skills this model uses, stored in .soma/skills/. Click to read, switch them on and off on the left under “Skills”.', SKILLS)) {
      walk(skills.children, 1, SKILLS);
    }
    if (managed.length && group('#managed', 'lock', 'Managed by the app', managed.length,
      'The app creates these files and renews them with updates. There is no need to change them.')) {
      for (const n of managed) rows.push(this.row(n, 1));
    }
    const hadFocus = !!this.input && document.activeElement === this.input;
    this.root.replaceChildren(...rows);
    // Neu gezeichnet, während getippt wird (Dateiänderung von außen): Fokus und Eingabe bleiben
    if (hadFocus || this.input?.dataset.fresh) this.focusInput();
  }

  // ---- Suchen und Finden ----------------------------------------------------------------------------------------

  /** Suchfeld über dem Baum. Escape leert es, Pfeil nach unten springt in die Treffer. */
  attachSearch(input: HTMLInputElement): void {
    this.search = input;
    input.addEventListener('input', () => { this.query = input.value.trim(); this.render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && input.value) { e.preventDefault(); e.stopPropagation(); this.clearQuery(); this.render(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); this.root.querySelector<HTMLElement>('.frow')?.focus(); }
    });
  }

  private clearQuery(): void {
    this.query = '';
    if (this.search) this.search.value = '';
  }

  private isOpen(key: string): boolean { return !!this.query || this.expanded.has(key); }

  /** Trifft der Suchtext den Namen (mit „/“ im Suchtext: den Pfad)? Groß- und Kleinschreibung zählt nicht. */
  private hit(n: FileNode): boolean {
    const q = this.query.toLowerCase();
    return (q.includes('/') ? n.path : n.name).toLowerCase().includes(q);
  }

  /** Nur Treffer und die Ordner darüber. Ein passender Ordner bleibt auch ohne passende Datei darin stehen. */
  private filter(list: FileNode[]): FileNode[] {
    if (!this.query) return list;
    return list.flatMap((n) => {
      if (!n.dir) return this.hit(n) ? [n] : [];
      const kids = this.filter(n.children ?? []);
      return kids.length || this.hit(n) ? [{ ...n, children: kids }] : [];
    });
  }

  /** Ordner über einer Datei aufklappen. Liefert, ob sich etwas geändert hat. */
  private openAncestors(rel: string): boolean {
    const before = this.expanded.size;
    const parts = rel.split('/');
    for (let i = 1; i < parts.length; i++) this.expanded.add(parts.slice(0, i).join('/'));
    if (parts.length === 1 && MANAGED.has(rel)) this.expanded.add('#managed');
    return this.expanded.size !== before;
  }

  /**
   * Datei im Baum zeigen: Suche leeren, Ordner darüber aufklappen, hinscrollen. Steht sie noch nicht in der Liste (die kommt
   * gleich nach), bleiben die Ordner trotzdem offen.
   */
  reveal(rel: string, focus = true): void {
    this.clearQuery();
    this.openAncestors(rel);
    this.render();
    const row = this.root.querySelector<HTMLElement>(`.frow[data-path="${CSS.escape(rel)}"]`);
    row?.scrollIntoView({ block: 'nearest' });
    if (focus) row?.focus();
  }

  /** Menü einer Datei aus einem anderen Panel (Videos im Reiter Animation): wie im Baum, dazu „Show in file tree“. */
  menuFor(rel: string, x: number, y: number): void {
    this.openMenu(this.find(rel) ?? { name: rel.split('/').pop() ?? rel, path: rel, dir: false }, x, y, true);
  }

  // ---- Anlegen und Umbenennen -----------------------------------------------------------------------------------

  /** Namensfeld für eine neue Datei oder einen neuen Ordner in `parent` ('' = Projektordner). */
  startCreate(parent: string, dir: boolean): void {
    if (fileOpBlockReason(parent, 'create') || this.submitting) return;
    this.edit = { mode: dir ? 'dir' : 'file', parent };
    this.input = null;
    // Ordner aufklappen und die Suche leeren, damit das Feld zu sehen ist
    this.clearQuery();
    if (parent) { this.openAncestors(parent); this.expanded.add(parent); }
    this.render();
  }

  startRename(n: FileNode): void {
    if (fileOpBlockReason(n.path, 'rename') || this.submitting) return;
    this.edit = { mode: 'rename', node: n };
    this.input = null;
    if (this.query && !this.hit(n)) this.clearQuery();
    this.openAncestors(n.path);
    this.render();
  }

  /** Umbenennen einer Datei, die gerade im Baum steht (aus dem Menü eines anderen Panels). */
  startRenameAt(rel: string): void {
    const n = this.find(rel);
    if (n) this.startRename(n);
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

  /** `outside`: aus einem anderen Panel geöffnet. Dann ohne Anlegen, Umbenennen geht im Baum weiter. */
  private openMenu(n: FileNode | null, x: number, y: number, outside = false): void {
    const d = this.deps;
    const folder = n ? (n.dir ? n.path : parentOf(n.path)) : '';
    const blockCreate = fileOpBlockReason(folder, 'create');
    const blocked = (item: HTMLButtonElement, reason: string | null) => { if (reason) { item.disabled = true; item.title = reason; } return item; };
    const items: HTMLElement[] = [el('div', { className: 'mh', textContent: n ? n.name : 'Project folder' })];
    if (n && !n.dir) {
      if (TEXT_EXT.test(n.name) || /\.(pdf|dxf)$/i.test(n.name)) items.push(menuItem('Open', { icon: 'code', onClick: () => d.open(n) }));
      if (IMAGE_EXT.test(n.name)) items.push(menuItem('Mark up', { icon: 'camera', onClick: () => d.mark(n.path) }));
      if (VIDEO_EXT.test(n.name)) items.push(menuItem('Play', { icon: 'play', onClick: () => d.open(n) }));
      if (outside) items.push(menuItem('Show in file tree', { icon: 'file', onClick: () => d.showInTree(n.path, false) }));
      items.push(menuItem('Open with default app', { icon: 'openext', onClick: () => d.openExternal(n.path) }));
    }
    items.push(menuItem('Show in Explorer', { icon: 'folder', onClick: () => d.reveal(n?.path ?? '') }));
    if (n) {
      items.push(el('div', { className: 'msep' }),
        menuItem('Send path to agent', { icon: 'send', onClick: () => d.toAgent(n.path) }),
        menuItem('Copy path', { icon: 'copy', onClick: () => d.copyPath(n.path) }));
    }
    items.push(el('div', { className: 'msep' }));
    if (!outside) {
      items.push(blocked(menuItem(n?.dir ? 'New file here' : 'New file', { icon: 'fileplus', onClick: () => this.startCreate(folder, false) }), blockCreate),
        blocked(menuItem(n?.dir ? 'New folder here' : 'New folder', { icon: 'folderplus', onClick: () => this.startCreate(folder, true) }), blockCreate));
    }
    if (n) {
      items.push(blocked(menuItem('Rename', { icon: 'pen', kbd: outside ? undefined : 'F2', onClick: () => (outside ? d.showInTree(n.path, true) : this.startRename(n)) }), fileOpBlockReason(n.path, 'rename')),
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
    if (this.expanded.has(key)) this.expanded.delete(key); else this.expanded.add(key);
    this.render();
  }

  private row(n: FileNode, depth: number): HTMLElement {
    if (n.dir) {
      const open = this.isOpen(n.path);
      const b = this.button(depth, open ? 'down' : 'right', 'folder', n.name, '', 'dir');
      b.setAttribute('aria-expanded', String(open));
      b.title = n.path;
      b.dataset.path = n.path;
      b.addEventListener('click', () => this.toggle(n.path));
      FileTree.draggable(b, n.path);
      return b;
    }
    const b = this.button(depth, null, fileIcon(n.name), n.name, TAGS[n.path] ?? '', '');
    b.title = TEXT_EXT.test(n.name) || /\.(pdf|dxf)$/i.test(n.name) ? `Open ${n.path} in the code` : IMAGE_EXT.test(n.name) ? `Open ${n.path} for markup`
      : VIDEO_EXT.test(n.name) ? `Play ${n.path}` : n.path;
    b.dataset.path = n.path;
    b.addEventListener('click', () => this.deps.open(n));
    if (n.path === this.active) b.classList.add('sel');
    FileTree.draggable(b, n.path);
    return b;
  }

  /** Datei, die gerade im Code offen ist: im Baum hervorheben, damit man sieht, wo man ist. */
  setActive(rel: string | null): void {
    const changed = rel !== this.active;
    this.active = rel;
    // Neu geöffnete Datei: Ordner darüber aufklappen, damit man sieht, wo sie liegt
    if (rel && changed && this.openAncestors(rel)) { this.render(); return; }
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
      this.nameEl(name),
      tag ? el('span', { className: 'tag', textContent: tag }) : null);
    b.style.paddingLeft = `${8 + depth * 18}px`;
    return b;
  }

  /** Name, beim Suchen mit hervorgehobenem Treffer. Nur Textknoten, Namen kommen aus dem Projekt. */
  private nameEl(name: string): HTMLElement {
    const q = this.query.toLowerCase();
    const at = q && !q.includes('/') ? name.toLowerCase().indexOf(q) : -1;
    if (at < 0) return el('span', { className: 'fn', textContent: name });
    return el('span', { className: 'fn' }, name.slice(0, at), el('span', { className: 'hit', textContent: name.slice(at, at + q.length) }), name.slice(at + q.length));
  }
}
