import { icon } from './icons';
import { el } from './ui';

/** `group`: Pfad der Gruppe mit „/“, z. B. „Gehäuse/Schrauben“, oder null. */
export interface PartRow { id: string; name: string; role: string; color: string; group: string | null }

interface Hooks {
  select(id: string): void;
  setVisible(ids: string[], on: boolean): void;
  isVisible(id: string): boolean;
  setGhost(ids: string[], on: boolean): void;
  isGhost(id: string): boolean;
  context(id: string, x: number, y: number): void;
  groupContext(ids: string[], name: string, x: number, y: number): void;
}

/** Gruppe im Baum. `items` in der Reihenfolge, in der sie im Modell zuerst vorkommen (Gruppen und Teile gemischt). */
interface GroupNode { key: string; name: string; items: ({ group: GroupNode } | { part: PartRow })[] }

/**
 * Schwebende Bauteilkarte oben links im Viewer. Nur so hoch wie ihr Inhalt, einklappbar, ab ein paar Teilen mit Suche.
 * Gruppen (aus add_part(group=…) oder aus der Struktur importierter STEP-Dateien) stehen als aufklappbarer Baum.
 * Jedes Teil und jede Gruppe lässt sich aus- und einblenden sowie transparent schalten. Referenzen stehen für sich (E34).
 */
export class PartsCard {
  private parts: PartRow[] = [];
  private selected: string | null = null;
  private filter = '';
  private placeholder = '';
  private collapsed = new Set<string>();

  constructor(private ui: { card: HTMLElement; list: HTMLElement; count: HTMLElement; toggle: HTMLButtonElement; search: HTMLButtonElement; filter: HTMLInputElement }, private hooks: Hooks) {
    ui.toggle.addEventListener('click', () => this.setCollapsed(!ui.card.classList.contains('collapsed')));
    ui.search.addEventListener('click', () => {
      ui.filter.hidden = !ui.filter.hidden;
      if (ui.filter.hidden) { ui.filter.value = ''; this.filter = ''; this.render(); } else ui.filter.focus();
    });
    ui.filter.addEventListener('input', () => { this.filter = ui.filter.value.trim().toLowerCase(); this.render(); });
  }

  setCollapsed(on: boolean): void {
    this.ui.card.classList.toggle('collapsed', on);
    this.ui.toggle.setAttribute('aria-expanded', String(!on));
  }

  /** Hinweis statt Liste, z. B. während des ersten Builds. */
  message(text: string): void { this.placeholder = text; this.parts = []; this.render(); }

  set(parts: PartRow[], selected: string | null): void { this.parts = parts; this.selected = selected; this.placeholder = ''; this.render(); }

  select(id: string | null): void { this.selected = id; this.render(); }

  render(): void {
    const { list, count } = this.ui;
    count.textContent = this.parts.length ? String(this.parts.length) : '';
    if (!this.parts.length) { list.replaceChildren(el('div', { className: 'hint', textContent: this.placeholder || 'Noch keine Bauteile.' })); return; }
    const match = (p: PartRow) => !this.filter || p.name.toLowerCase().includes(this.filter) || (p.group ?? '').toLowerCase().includes(this.filter);
    const own = this.tree('own', this.parts.filter((p) => p.role !== 'reference' && match(p)));
    const refs = this.tree('ref', this.parts.filter((p) => p.role === 'reference' && match(p)));
    const rows: HTMLElement[] = this.rows(own, 0);
    if (refs.items.length) rows.push(el('div', { className: 'grp', textContent: 'REFERENZEN' }), ...this.rows(refs, 0));
    if (!rows.length) rows.push(el('div', { className: 'hint', textContent: 'Kein Bauteil passt zur Suche.' }));
    list.replaceChildren(...rows);
  }

  private tree(section: string, parts: PartRow[]): GroupNode {
    const root: GroupNode = { key: section, name: '', items: [] };
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

  private static ids(node: GroupNode): string[] {
    return node.items.flatMap((x) => ('part' in x ? [x.part.id] : PartsCard.ids(x.group)));
  }

  private rows(node: GroupNode, depth: number): HTMLElement[] {
    const out: HTMLElement[] = [];
    for (const it of node.items) {
      if ('part' in it) { out.push(this.row(it.part, depth)); continue; }
      const g = it.group;
      // Beim Suchen immer aufgeklappt, sonst sähe man die Treffer nicht
      const open = !!this.filter || !this.collapsed.has(g.key);
      out.push(this.groupRow(g, depth, open));
      if (open) out.push(...this.rows(g, depth + 1));
    }
    return out;
  }

  private groupRow(g: GroupNode, depth: number, open: boolean): HTMLElement {
    const ids = PartsCard.ids(g);
    const anyVisible = ids.some((id) => this.hooks.isVisible(id));
    const ghosts = ids.filter((id) => this.hooks.isGhost(id)).length;
    const toggle = () => { if (open) this.collapsed.add(g.key); else this.collapsed.delete(g.key); this.render(); };
    const name = el('button', { className: 'nm', title: open ? 'Gruppe zuklappen' : 'Gruppe aufklappen' },
      el('span', { className: 'chev' + (open ? '' : ' shut') }, icon('down', 13, 2)), el('span', { className: 'gname', textContent: g.name }), el('span', { className: 'gcount', textContent: String(ids.length) }));
    name.setAttribute('aria-expanded', String(open));
    name.addEventListener('click', toggle);
    const row = el('div', { className: 'row gr' + (anyVisible ? '' : ' off') }, name,
      this.ghostButton(`Gruppe ${g.name}`, ghosts === ids.length, ghosts > 0 && ghosts < ids.length, () => this.hooks.setGhost(ids, ghosts !== ids.length)),
      this.eyeButton(`Gruppe ${g.name}`, anyVisible, () => this.hooks.setVisible(ids, !anyVisible)));
    row.style.paddingLeft = `${4 + depth * 14}px`;
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); this.hooks.groupContext(ids, g.name, e.clientX, e.clientY); });
    return row;
  }

  private row(p: PartRow, depth: number): HTMLElement {
    const visible = this.hooks.isVisible(p.id);
    const ghost = this.hooks.isGhost(p.id);
    const sw = el('span', { className: 'sw' + (p.role === 'reference' ? ' ref' : '') });
    sw.style.background = p.color;
    const name = el('button', { className: 'nm', title: 'Auswählen und Codestelle zeigen' }, sw, el('span', { className: 'pname', textContent: p.name }));
    name.addEventListener('click', () => this.hooks.select(p.id));
    const row = el('div', { className: 'row' + (this.selected === p.id ? ' sel' : '') + (visible ? '' : ' off') }, name,
      this.ghostButton(p.name, ghost, false, () => this.hooks.setGhost([p.id], !ghost)),
      this.eyeButton(p.name, visible, () => this.hooks.setVisible([p.id], !visible)));
    row.style.paddingLeft = `${4 + depth * 14}px`;
    row.dataset.id = p.id;
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); this.hooks.context(p.id, e.clientX, e.clientY); });
    return row;
  }

  private eyeButton(what: string, visible: boolean, act: () => void): HTMLButtonElement {
    const b = el('button', { className: 'eye', title: visible ? 'Ausblenden' : 'Einblenden' }, icon(visible ? 'eye' : 'eyeoff', 15));
    b.setAttribute('aria-label', `${what} ${visible ? 'ausblenden' : 'einblenden'}`);
    b.addEventListener('click', () => { act(); this.render(); });
    return b;
  }

  /** Transparent schalten. `partly`: nur ein Teil der Gruppe ist transparent. */
  private ghostButton(what: string, on: boolean, partly: boolean, act: () => void): HTMLButtonElement {
    const b = el('button', { className: 'eye gh' + (on ? ' on' : partly ? ' partly' : ''), title: on ? 'Nicht mehr transparent' : 'Transparent schalten' }, icon('ghost', 15));
    b.setAttribute('aria-label', `${what} ${on ? 'nicht mehr transparent' : 'transparent schalten'}`);
    b.setAttribute('aria-pressed', String(on));
    b.addEventListener('click', () => { act(); this.render(); });
    return b;
  }
}
