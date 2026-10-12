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

/** Uhrzeit, bei älteren Tagen mit Datum: „14:02“, „yesterday 14:02“, „24 Sept 14:02“. */
export function fmtWhen(t: number | string, withToday = false): string {
  const d = new Date(t);
  const now = new Date();
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) return withToday ? `today ${time}` : time;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `yesterday ${time}`;
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} ${time}`;
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

  /** Unter dem Auslöser öffnen (`beside`: links daneben, oben bündig), ist es schon offen: schließen. */
  toggle(menu: HTMLElement, anchor: HTMLElement, align: 'left' | 'right' | 'beside' = 'left', onClose?: () => void): void {
    if (this.isOpen(menu)) { this.close(); return; }
    const r = anchor.getBoundingClientRect();
    if (align === 'beside') this.show(menu, r.left - 8, r.top, anchor, 'right', onClose);
    else this.show(menu, align === 'left' ? r.left : r.right, r.bottom + 6, anchor, align, onClose);
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

export interface AskOptions { title: string; message: string; detail?: string; buttons: string[] }

/**
 * Rückfrage als Fenster in der App statt als weißer Dialog des Systems. Liefert den Index des Knopfs; der erste ist
 * der Standard (Enter), der letzte gilt als Abbrechen (Escape). Mehrere Rückfragen kommen nacheinander.
 */
let askQueue: Promise<unknown> = Promise.resolve();
export function ask(o: AskOptions): Promise<number> {
  const run = askQueue.then(() => showAsk(o));
  askQueue = run.catch(() => {});
  return run;
}

function showAsk(o: AskOptions): Promise<number> {
  return new Promise((resolve) => {
    const before = document.activeElement as HTMLElement | null;
    const cancel = o.buttons.length - 1;
    const btns = o.buttons.map((label, i) => el('button', { className: i === 0 ? 'btn primary' : 'btn', textContent: label, onclick: () => done(i) }));
    const dlg = el('div', { className: 'ask-dlg' },
      el('div', { className: 'ask-title' }, o.title),
      el('div', { className: 'ask-msg' }, o.message),
      o.detail ? el('div', { className: 'ask-detail' }, o.detail) : null,
      el('div', { className: 'ask-btns' }, ...btns));
    dlg.setAttribute('role', 'alertdialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-label', o.title);
    const scrim = el('div', { className: 'ask-scrim' }, dlg);
    // Tasten gehören solange nur dem Dialog: Escape soll nicht zusätzlich Einstellungen oder Werkzeuge schließen
    const onKey = (e: KeyboardEvent) => {
      e.stopImmediatePropagation();
      if (e.key === 'Escape') { e.preventDefault(); done(cancel); }
      else if (e.key === 'Enter' && !(e.target instanceof HTMLButtonElement && dlg.contains(e.target))) { e.preventDefault(); done(0); }
      else if (e.key === 'Tab') {
        e.preventDefault();
        const at = btns.indexOf(document.activeElement as HTMLButtonElement);
        btns[(at + (e.shiftKey ? -1 : 1) + btns.length) % btns.length].focus();
      }
    };
    function done(i: number): void {
      window.removeEventListener('keydown', onKey, true);
      scrim.remove();
      before?.focus?.();
      resolve(i);
    }
    window.addEventListener('keydown', onKey, true);
    document.body.append(scrim);
    btns[0].focus();
  });
}
