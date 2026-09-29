import { icon } from './icons';

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

type Kid = Node | string | null | false | undefined;

/** Erzeugt ein Element. Text geht immer über textContent, nie über innerHTML (Namen kommen aus dem Projekt). */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...kids: Kid[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  for (const k of kids) if (k) e.append(k);
  return e;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
/** Kurze Meldung unten rechts. Fehler bleiben länger stehen. */
export function toast(text: string, kind: 'ok' | 'info' | 'error' = 'ok'): void {
  const t = $('toast');
  t.replaceChildren(el('span', { className: 'ti' }, icon(kind === 'error' ? 'alert' : kind === 'info' ? 'info' : 'check', 16, 2.1)), el('span', {}, text));
  t.className = kind;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'error' ? 12000 : 6000);
}

/** Uhrzeit, bei älteren Tagen mit Datum: „14:02“, „gestern 14:02“, „24.09. 14:02“. */
export function fmtWhen(t: number | string, withToday = false): string {
  const d = new Date(t);
  const now = new Date();
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return withToday ? `heute ${time}` : time;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `gestern ${time}`;
  return `${d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })} ${time}`;
}

interface OpenMenu { menu: HTMLElement; anchor: HTMLElement | null; onClose?: () => void }

/**
 * Aufklappmenüs und Popover. Immer nur eines ist offen, es schließt bei Klick daneben, Escape und Größenänderung.
 * Einträge mit der Klasse `mi` schließen das Menü nach dem Klick, außer sie tragen `keep` (Schalter, Häkchen).
 */
class Menus {
  private cur: OpenMenu | null = null;

  constructor() {
    document.addEventListener('pointerdown', (e) => {
      const c = this.cur;
      if (c && !c.menu.contains(e.target as Node) && !c.anchor?.contains(e.target as Node)) this.close();
    }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.cur) { e.stopPropagation(); this.close(); } }, true);
    document.addEventListener('click', (e) => {
      const item = (e.target as HTMLElement).closest?.('.menu .mi');
      if (item && !item.classList.contains('keep') && this.cur?.menu.contains(item)) this.close();
    });
    window.addEventListener('resize', () => this.close());
    window.addEventListener('blur', () => this.close());
  }

  isOpen(menu: HTMLElement): boolean { return this.cur?.menu === menu; }

  /** Unter dem Auslöser öffnen, ist es schon offen: schließen. */
  toggle(menu: HTMLElement, anchor: HTMLElement, align: 'left' | 'right' = 'left', onClose?: () => void): void {
    if (this.isOpen(menu)) { this.close(); return; }
    const r = anchor.getBoundingClientRect();
    this.show(menu, align === 'left' ? r.left : r.right, r.bottom + 6, anchor, align, onClose);
  }

  /** An einer Stelle öffnen (Kontextmenü). */
  at(menu: HTMLElement, x: number, y: number, onClose?: () => void): void { this.show(menu, x, y, null, 'left', onClose); }

  close(): void {
    const c = this.cur;
    if (!c) return;
    this.cur = null;
    c.menu.hidden = true;
    c.anchor?.setAttribute('aria-expanded', 'false');
    c.onClose?.();
  }

  private show(menu: HTMLElement, x: number, y: number, anchor: HTMLElement | null, align: 'left' | 'right', onClose?: () => void): void {
    this.close();
    menu.hidden = false;
    menu.style.left = '0px'; menu.style.top = '0px';
    const w = menu.offsetWidth, h = menu.offsetHeight;
    let left = align === 'left' ? x : x - w;
    left = Math.max(8, Math.min(left, innerWidth - w - 8));
    let top = y;
    if (top + h > innerHeight - 8) top = Math.max(8, (anchor ? anchor.getBoundingClientRect().top - 6 : y) - h);
    menu.style.left = `${left}px`; menu.style.top = `${top}px`;
    anchor?.setAttribute('aria-expanded', 'true');
    this.cur = { menu, anchor, onClose };
  }
}

export const menus = new Menus();

/** Menüeintrag für dynamische Menüs. */
export function menuItem(label: string, opts: { icon?: string; kbd?: string; sub?: string; disabled?: boolean; onClick?: () => void; cls?: string } = {}): HTMLButtonElement {
  const b = el('button', { className: 'mi' + (opts.cls ? ' ' + opts.cls : ''), disabled: !!opts.disabled },
    opts.icon ? icon(opts.icon, 15) : el('span', { className: 'noico' }), el('span', { textContent: label }),
    opts.sub ? el('span', { className: 'sub', textContent: opts.sub }) : null,
    opts.kbd ? el('span', { className: 'k', textContent: opts.kbd }) : null);
  b.setAttribute('role', 'menuitem');
  if (opts.onClick) b.addEventListener('click', opts.onClick);
  return b;
}
