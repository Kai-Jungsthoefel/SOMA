import { icon } from './icons';
import { el } from './ui';

/** `group`: Pfad der Gruppe mit „/“, z. B. „Gehäuse/Schrauben“, oder null. */
export interface PartRow { id: string; name: string; role: string; color: string; group: string | null }

/** Klick auf einen Namen: allein auswählen, mit Strg dazu oder heraus, mit Shift den Bereich bis hierher (`ids`). */
export type TreeSelect = { how: 'replace' | 'toggle'; id: string } | { how: 'range'; id: string; ids: string[] };

interface Hooks {
  select(s: TreeSelect): void;
  setVisible(ids: string[], on: boolean): void;
  isVisible(id: string): boolean;
  setGhost(ids: string[], on: boolean): void;
  isGhost(id: string): boolean;
  showAll(): void;
  context(id: string, x: number, y: number): void;
  groupContext(ids: string[], name: string, x: number, y: number): void;
  /** Auf- oder zugeklappt: Die Werkzeuge oben in der Mitte rücken zur Seite oder zeigen nur Symbole. */
  resized(): void;
}

/** Gruppe im Baum. `items` in der Reihenfolge, in der sie im Modell zuerst vorkommen (Gruppen und Teile gemischt). */
interface GroupNode { key: string; name: string; items: ({ group: GroupNode } | { part: PartRow })[] }

/** Schlüssel der Gruppe der Referenzen (E34). Sie steht am Ende. */
const REFS = 'ref';

/**
 * Strukturbaum ganz oben links im Viewer (E82, wie in CATIA): ohne Hintergrund, nur Schrift, Striche und Symbole mit dunklem
 * Rand. Eingeklappt steht nur der Name des Modells da, aufgeklappt die Gruppen und Teile mit Baumstrichen und direkt vor jedem
 * Namen Auge (ausblenden) und Halbkreis (transparent). Derselbe Baum gilt in Modell, Analyse und Animation, der Zustand
 * (aus- und eingeblendet, transparent) liegt im Viewer und bleibt beim Wechsel. Mehrfachauswahl mit Strg und Shift wie im
 * Viewer. Mit gedrückter Maus über die Augen (oder Halbkreise) fahren schaltet alle überfahrenen Zeilen gleich (wie die Ebenen
 * in Photoshop), so blendet man mehrere Teile aus, ohne die ganze Gruppe.
 */
export class StructureTree {
  private parts: PartRow[] = [];
  /** Nur diese Teile zeigen (Analyse: die gerechneten Körper), null: alle. */
  private only: Set<string> | null = null;
  private selected = new Set<string>();
  /** Zuletzt ohne Shift angeklicktes Teil: Anfang eines Bereichs mit Shift-Klick. */
  private anchor: string | null = null;
  /** Ziehen über Augen oder Halbkreise: welche Spalte, welcher Zustand, welche Zeilen schon geschaltet sind. */
  private painting: { kind: 'eye' | 'gh'; on: boolean; done: Set<string> } | null = null;
  private open = false;
  private searching = false;
  private filter = '';
  private placeholder = '';
  private title = '';
  /**
   * Aufgeklappte Gruppen. Alle beginnen zugeklappt: Aufklappen zeigt eine Ebene, die nächste öffnet der Nutzer bei Bedarf
   * (bei großen Baugruppen sähe man sonst alles auf einmal).
   */
  private expanded = new Set<string>();
  private readonly head = el('div', { className: 'tr-hd' });
  private readonly search = el('div', { className: 'tr-search', hidden: true });
  private readonly input = el('input', { type: 'search', placeholder: 'Search part', ariaLabel: 'Search part', spellcheck: false });
  private readonly hits = el('span', { className: 'tr-hits' });
  private readonly rowsEl = el('div', { className: 'tr-rows', role: 'tree' });
  private readonly foot = el('div', { className: 'tr-ft', hidden: true });

  constructor(private readonly root: HTMLElement, private readonly hooks: Hooks) {
    const clear = el('button', { className: 'hb', title: 'Close the search (Escape)', ariaLabel: 'Close the search' }, icon('x', 13, 2));
    clear.addEventListener('click', () => this.setSearching(false));
    this.search.append(icon('search', 14, 1.9), this.input, this.hits, clear);
    this.input.addEventListener('input', () => { this.filter = this.input.value.trim().toLowerCase(); this.render(); });
    this.input.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); this.setSearching(false); } });
    root.replaceChildren(this.head, this.search, this.rowsEl, this.foot);
    window.addEventListener('pointerup', () => { this.painting = null; });
    window.addEventListener('pointercancel', () => { this.painting = null; });
    this.render();
  }

  /** Name des Modells in der obersten Zeile. */
  setTitle(name: string): void { this.title = name; this.render(); }

  /** Hinweis statt Liste, z. B. während des ersten Builds. */
  message(text: string): void { this.placeholder = text; this.parts = []; this.render(); }

  set(parts: PartRow[], selected: string[]): void { this.parts = parts; this.selected = new Set(selected); this.placeholder = ''; this.render(); }

  /** Auswahl im Modell: Zeilen markieren, bei zugeklappter Gruppe die Gruppe, und die erste in den sichtbaren Bereich holen. */
  select(ids: string[]): void {
    this.selected = new Set(ids);
    if (ids.length === 1) this.anchor = ids[0];
    this.render();
    this.rowsEl.querySelector<HTMLElement>('.tr-row.sel')?.scrollIntoView({ block: 'nearest' });
  }

  /** Nur die Teile mit diesen Namen zeigen (null: alle). */
  limit(names: string[] | null): void { this.only = names ? new Set(names) : null; this.render(); }

  get isOpen(): boolean { return this.open; }

  setOpen(on: boolean): void {
    if (on === this.open) return;
    this.open = on;
    if (!on) this.setSearching(false, false);
    this.render();
    this.hooks.resized();
  }

  /** Namen aller gezeigten Teile in der Reihenfolge des Baums, auch zugeklappt (Prüfhilfe und Tests). */
  names(): string[] { return this.shown().map((p) => p.name); }

  private shown(): PartRow[] {
    const own = this.parts.filter((p) => p.role !== 'reference' && (!this.only || this.only.has(p.name)));
    const refs = this.parts.filter((p) => p.role === 'reference' && (!this.only || this.only.has(p.name)));
    return [...StructureTree.flat(StructureTree.build('own', own)), ...StructureTree.flat(StructureTree.build(REFS, refs))];
  }

  private setSearching(on: boolean, render = true): void {
    this.searching = on;
    this.search.hidden = !on;
    this.head.hidden = on;
    if (!on) { this.input.value = ''; this.filter = ''; }
    if (render) this.render();
    if (on) this.input.focus();
  }

  render(): void {
    const shown = this.parts.filter((p) => !this.only || this.only.has(p.name));
    const hidden = shown.filter((p) => !this.hooks.isVisible(p.id)).length;
    this.root.classList.toggle('open', this.open);
    this.renderHead(shown.length, hidden);
    this.rowsEl.hidden = !this.open;
    this.foot.hidden = !this.open || !hidden;
    if (!this.open) return;
    const showAll = el('button', { textContent: 'Show all', title: 'Show all hidden parts again' });
    showAll.addEventListener('click', () => { this.hooks.showAll(); this.render(); });
    this.foot.replaceChildren(icon('eyeoff', 13, 1.8), el('span', { textContent: `${hidden} hidden` }), showAll);
    if (!shown.length) {
      this.rowsEl.replaceChildren(el('div', { className: 'tr-hint', textContent: this.placeholder || 'No parts yet.' }));
      this.hits.textContent = '';
      return;
    }
    const match = (p: PartRow) => !this.filter || p.name.toLowerCase().includes(this.filter) || (p.group ?? '').toLowerCase().includes(this.filter);
    const own = StructureTree.build('own', shown.filter((p) => p.role !== 'reference' && match(p)));
    const refs = StructureTree.build(REFS, shown.filter((p) => p.role === 'reference' && match(p)));
    // Die Referenzen hängen als eigene Gruppe am Ende des Baums, statt unter einer eigenen Überschrift
    if (refs.items.length) own.items.push({ group: { ...refs, name: 'References' } });
    const rows = this.rows(own, []);
    this.hits.textContent = this.filter ? `${StructureTree.ids(own).length} of ${shown.length}` : '';
    if (!rows.length) rows.push(el('div', { className: 'tr-hint', textContent: 'No part matches the search.' }));
    this.rowsEl.replaceChildren(...rows);
  }

  private renderHead(count: number, hidden: number): void {
    const toggle = el('button', { className: 'tr-toggle', title: this.open ? 'Collapse the structure tree (F3)' : 'Show the parts of the model (F3)' },
      el('span', { className: 'chev' }, icon(this.open ? 'down' : 'right', 13, 2)), el('span', { className: 'ico' }, icon('tree', 15, 1.8)),
      el('b', { textContent: this.title || 'Model' }),
      // Eingeklappt sagt die Zeile, ob etwas ausgeblendet ist. Aufgeklappt steht es im Fuß
      !this.open && hidden ? el('span', { className: 'n', textContent: `· ${hidden} hidden` }) : null);
    toggle.setAttribute('aria-expanded', String(this.open));
    toggle.addEventListener('click', () => this.setOpen(!this.open));
    const kids: HTMLElement[] = [toggle];
    if (this.open && count) {
      const find = el('button', { className: 'hb', title: 'Search parts', ariaLabel: 'Search parts' }, icon('search', 14, 1.9));
      find.addEventListener('click', () => this.setSearching(true));
      kids.push(el('span', { className: 'sp' }), find);
    }
    this.head.replaceChildren(...kids);
  }

  private static build(key: string, parts: PartRow[]): GroupNode {
    const root: GroupNode = { key, name: '', items: [] };
    for (const p of parts) {
      let node = root;
      for (const seg of (p.group ?? '').split('/').filter(Boolean)) {
        let next = node.items.find((x): x is { group: GroupNode } => 'group' in x && x.group.name === seg)?.group;
        if (!next) { next = { key: `${node.key}/${seg}`, name: seg, items: [] }; node.items.push({ group: next }); }
        node = next;
      }
      node.items.push({ part: p });
    }
    return root;
  }

  private static flat(node: GroupNode): PartRow[] {
    return node.items.flatMap((x) => ('part' in x ? [x.part] : StructureTree.flat(x.group)));
  }

  private static ids(node: GroupNode): string[] { return StructureTree.flat(node).map((p) => p.id); }

  /** `anc`: je Ebene darüber, ob dort noch etwas folgt (dann läuft der senkrechte Strich weiter). */
  private rows(node: GroupNode, anc: boolean[]): HTMLElement[] {
    const out: HTMLElement[] = [];
    node.items.forEach((it, i) => {
      const last = i === node.items.length - 1;
      if ('part' in it) { out.push(this.row(it.part, anc, last)); return; }
      const g = it.group;
      // Beim Suchen immer aufgeklappt, sonst sähe man die Treffer nicht
      const open = !!this.filter || this.expanded.has(g.key);
      out.push(this.groupRow(g, anc, last, open));
      if (open) out.push(...this.rows(g, [...anc, !last]));
    });
    return out;
  }

  /** Baumstriche: weiterlaufende Striche der Ebenen darüber, dann der Abzweig, bei Teilen bis an die Knöpfe heran. */
  private static branches(anc: boolean[], last: boolean, part: boolean): HTMLElement {
    const br = el('span', { className: 'br' });
    for (const more of anc) br.append(el('i', { className: more ? 'v' : '' }));
    br.append(el('i', { className: last ? 'l' : 't' }));
    if (part) br.append(el('i', { className: 'h' }));
    return br;
  }

  private groupRow(g: GroupNode, anc: boolean[], last: boolean, open: boolean): HTMLElement {
    const ids = StructureTree.ids(g);
    const anyVisible = ids.some((id) => this.hooks.isVisible(id));
    const ghosts = ids.filter((id) => this.hooks.isGhost(id)).length;
    const toggle = () => { if (open) this.expanded.delete(g.key); else this.expanded.add(g.key); this.render(); };
    // Ausgewähltes Teil in der zugeklappten Gruppe: Die Gruppe trägt die Markierung
    const holdsSel = !open && ids.some((id) => this.selected.has(id));
    const chev = el('button', { className: 'chev', title: open ? 'Collapse group' : 'Expand group', ariaLabel: `${open ? 'Collapse' : 'Expand'} group ${g.name}` }, icon(open ? 'down' : 'right', 12, 2));
    chev.setAttribute('aria-expanded', String(open));
    chev.addEventListener('click', toggle);
    const name = el('button', { className: 'nm', textContent: g.name, title: open ? 'Collapse group' : 'Expand group' });
    name.addEventListener('click', toggle);
    const row = el('div', { className: 'tr-row gr' + (anyVisible ? '' : ' off') + (holdsSel ? ' sel' : '') }, StructureTree.branches(anc, last, false), chev,
      this.eyeButton(`group ${g.name}`, g.key, anyVisible, (hide) => this.hooks.setVisible(ids, !hide)),
      this.ghostButton(`group ${g.name}`, g.key, ghosts === ids.length, ghosts > 0 && ghosts < ids.length, (on) => this.hooks.setGhost(ids, on)),
      name, el('span', { className: 'cnt', textContent: String(ids.length) }));
    row.setAttribute('role', 'treeitem');
    row.dataset.group = g.key;
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); this.hooks.groupContext(ids, g.name, e.clientX, e.clientY); });
    return row;
  }

  private row(p: PartRow, anc: boolean[], last: boolean): HTMLElement {
    const visible = this.hooks.isVisible(p.id);
    const ghost = this.hooks.isGhost(p.id);
    const name = el('button', { className: 'nm', textContent: p.name, title: `${p.name}: select and show the code location. Ctrl adds or removes, Shift selects a range. Right-click for more.` });
    name.addEventListener('click', (e) => this.clickName(p.id, e));
    const row = el('div', { className: 'tr-row' + (this.selected.has(p.id) ? ' sel' : '') + (visible ? '' : ' off') }, StructureTree.branches(anc, last, true),
      this.eyeButton(p.name, p.id, visible, (hide) => this.hooks.setVisible([p.id], !hide)),
      this.ghostButton(p.name, p.id, ghost, false, (on) => this.hooks.setGhost([p.id], on)), name);
    row.setAttribute('role', 'treeitem');
    row.dataset.id = p.id;
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); this.hooks.context(p.id, e.clientX, e.clientY); });
    return row;
  }

  /** Klick auf einen Namen: Strg schaltet das Teil in der Auswahl um, Shift wählt die sichtbaren Teile vom letzten Klick bis hier. */
  private clickName(id: string, e: MouseEvent): void {
    if (e.shiftKey && this.anchor) {
      const order = [...this.rowsEl.querySelectorAll<HTMLElement>('.tr-row[data-id]')].map((r) => r.dataset.id!);
      const a = order.indexOf(this.anchor), b = order.indexOf(id);
      if (a >= 0 && b >= 0) { this.hooks.select({ how: 'range', id, ids: order.slice(Math.min(a, b), Math.max(a, b) + 1) }); return; }
    }
    this.anchor = id;
    this.hooks.select({ how: e.ctrlKey || e.metaKey ? 'toggle' : 'replace', id });
  }

  /**
   * Schalter für Auge und Halbkreis. Drücken schaltet die Zeile um, Weiterziehen mit gedrückter Maus schaltet jede überfahrene
   * Zeile derselben Spalte in denselben Zustand. `key`: Teil oder Gruppe (jede Zeile nur einmal je Zug). Tastatur: Klick.
   */
  private paintable(b: HTMLButtonElement, kind: 'eye' | 'gh', key: string, state: boolean, act: (on: boolean) => void): HTMLButtonElement {
    b.dataset.paint = kind;
    b.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); // kein Markieren von Text beim Ziehen
      this.painting = { kind, on: !state, done: new Set([key]) };
      act(!state);
      this.render();
    });
    b.addEventListener('pointerover', (e) => {
      const p = this.painting;
      if (!p || p.kind !== kind || p.done.has(key) || !(e.buttons & 1)) return;
      p.done.add(key);
      if (state !== p.on) { act(p.on); this.render(); }
    });
    b.addEventListener('click', (e) => { if (e.detail === 0) { act(!state); this.render(); } });
    return b;
  }

  /** Auge: hell, wenn es wirkt (ausgeblendet, durchgestrichen), sonst gedämpft. `act(true)`: ausblenden. */
  private eyeButton(what: string, key: string, visible: boolean, act: (hide: boolean) => void): HTMLButtonElement {
    const b = el('button', { className: 'tg eye' + (visible ? '' : ' on'), title: visible ? 'Hide (drag across eyes: several)' : 'Show (drag across eyes: several)' }, icon(visible ? 'eye' : 'eyeoff', 14, 1.8));
    b.setAttribute('aria-label', `${visible ? 'Hide' : 'Show'} ${what}`);
    return this.paintable(b, 'eye', key, !visible, act);
  }

  /** Transparent schalten, an: orange. `partly`: nur ein Teil der Gruppe ist transparent. */
  private ghostButton(what: string, key: string, on: boolean, partly: boolean, act: (on: boolean) => void): HTMLButtonElement {
    const b = el('button', { className: 'tg gh' + (on ? ' on' : partly ? ' partly' : ''), title: on ? 'Not transparent' : 'Make transparent' }, icon('ghost', 14, 1.8));
    b.setAttribute('aria-label', `${on ? 'Make opaque' : 'Make transparent'}: ${what}`);
    b.setAttribute('aria-pressed', String(on));
    return this.paintable(b, 'gh', key, on, act);
  }

  /** Prüfhilfe: alle Gruppen aufklappen. */
  expandAll(): void {
    const walk = (n: GroupNode) => n.items.forEach((x) => { if ('group' in x) { this.expanded.add(x.group.key); walk(x.group); } });
    walk(StructureTree.build('own', this.parts.filter((p) => p.role !== 'reference')));
    walk(StructureTree.build(REFS, this.parts.filter((p) => p.role === 'reference')));
    this.expanded.add(REFS);
    this.render();
  }

  /** Prüfhilfe: Zustand des Baums mit den Zeilen, wie sie zu sehen sind. */
  state() {
    return {
      open: this.open, searching: this.searching, title: this.title, names: this.names(),
      head: this.head.textContent, hits: this.hits.textContent, foot: this.foot.hidden ? '' : this.foot.textContent,
      rows: [...this.rowsEl.querySelectorAll<HTMLElement>('.tr-row')].map((r) => ({
        name: r.querySelector('.nm')?.textContent ?? '', group: r.classList.contains('gr'), depth: r.querySelectorAll('.br i').length - (r.classList.contains('gr') ? 1 : 2),
        hidden: r.classList.contains('off'), ghost: !!r.querySelector('.gh.on'), partly: !!r.querySelector('.gh.partly'), sel: r.classList.contains('sel'),
        count: r.querySelector('.cnt')?.textContent ?? null,
      })),
    };
  }
}
