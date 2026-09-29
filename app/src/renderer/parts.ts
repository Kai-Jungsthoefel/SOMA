import { icon } from './icons';
import { el } from './ui';

export interface PartRow { id: string; name: string; role: string; color: string }

interface Hooks {
  select(id: string): void;
  setVisible(id: string, on: boolean): void;
  isVisible(id: string): boolean;
  context(id: string, x: number, y: number): void;
}

/**
 * Schwebende Bauteilkarte oben links im Viewer. Nur so hoch wie ihr Inhalt, einklappbar, ab ein paar Teilen mit Suche.
 * Referenzen stehen in einem eigenen Abschnitt (E34).
 */
export class PartsCard {
  private parts: PartRow[] = [];
  private selected: string | null = null;
  private filter = '';
  private placeholder = '';

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
    const match = (p: PartRow) => !this.filter || p.name.toLowerCase().includes(this.filter);
    const own = this.parts.filter((p) => p.role !== 'reference' && match(p));
    const refs = this.parts.filter((p) => p.role === 'reference' && match(p));
    const rows: HTMLElement[] = own.map((p) => this.row(p));
    if (refs.length) rows.push(el('div', { className: 'grp', textContent: 'REFERENZEN' }), ...refs.map((p) => this.row(p)));
    if (!rows.length) rows.push(el('div', { className: 'hint', textContent: 'Kein Bauteil passt zur Suche.' }));
    list.replaceChildren(...rows);
  }

  private row(p: PartRow): HTMLElement {
    const visible = this.hooks.isVisible(p.id);
    const sw = el('span', { className: 'sw' + (p.role === 'reference' ? ' ref' : '') });
    sw.style.background = p.color;
    const name = el('button', { className: 'nm', title: 'Auswählen und Codestelle zeigen' }, sw, el('span', { className: 'pname', textContent: p.name }));
    name.addEventListener('click', () => this.hooks.select(p.id));
    const eye = el('button', { className: 'eye', title: visible ? 'Ausblenden' : 'Einblenden' }, icon(visible ? 'eye' : 'eyeoff', 15));
    eye.setAttribute('aria-label', `${p.name} ${visible ? 'ausblenden' : 'einblenden'}`);
    eye.addEventListener('click', () => { this.hooks.setVisible(p.id, !visible); this.render(); });
    const row = el('div', { className: 'row' + (this.selected === p.id ? ' sel' : '') + (visible ? '' : ' off') }, name, eye);
    row.dataset.id = p.id;
    row.addEventListener('contextmenu', (e) => { e.preventDefault(); this.hooks.context(p.id, e.clientX, e.clientY); });
    return row;
  }
}
