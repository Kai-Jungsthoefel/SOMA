import { HELP_DIR, helpSections, type HelpSection } from '../shared/help';
import type { SomaApi } from '../shared/types';
import { renderMarkdown } from './markdown';
import { el, menus } from './ui';

interface Ui {
  root: HTMLElement;
  nav: HTMLElement;
  body: HTMLElement;
  close: HTMLButtonElement;
  /** Was hinter dem Fenster liegt: gesperrt, solange es offen ist. */
  background: HTMLElement[];
}

interface Deps {
  help: SomaApi['help'];
  /** Web-Link aus der Anleitung. */
  openUrl(href: string): void;
}

/** Pfad, unter dem die Anleitung als Skill im Projekt läge: Von dort lösen sich die Bilder (`../help/…`) auf. */
const AS_FILE = '.soma/skills/soma-app.md';

/**
 * Hilfe (E83): Fenster über der App wie die Einstellungen, links die Abschnitte der Anleitung, rechts der gewählte. Der Text
 * ist der mitgelieferte Skill „Using the app“ ohne die Teile nur für den Agenten (shared/help.ts), gezeigt mit derselben
 * Markdown-Ansicht wie Notizen. Bilder kommen aus den Dateien der App, nicht aus dem Projekt.
 */
export class HelpDialog {
  private sections: HelpSection[] = [];
  private current = 0;
  private error = '';
  private loaded = false;
  private lastFocus: HTMLElement | null = null;
  /** blob:-Adressen der Bilder, einmal geladen für die ganze Sitzung. */
  private images = new Map<string, Promise<string | null>>();

  constructor(private ui: Ui, private deps: Deps) {
    ui.close.addEventListener('click', () => this.close());
    ui.root.addEventListener('mousedown', (e) => { if (e.target === ui.root) this.close(); });
    ui.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); this.close(); }
      else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && (e.target as HTMLElement | null)?.closest?.('[data-help]')) {
        e.preventDefault();
        this.show(Math.max(0, Math.min(this.sections.length - 1, this.current + (e.key === 'ArrowDown' ? 1 : -1))), true);
      }
    });
  }

  get isOpen(): boolean { return !this.ui.root.hidden; }

  /** Öffnen, mit `title` gleich bei diesem Abschnitt. Die Anleitung wird beim ersten Öffnen gelesen. */
  async open(title?: string): Promise<void> {
    if (!this.isOpen) {
      this.lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      menus.close();
      this.ui.root.hidden = false;
      for (const b of this.ui.background) b.inert = true;
    }
    if (!this.loaded) await this.load();
    const i = title ? this.sections.findIndex((s) => s.title.toLowerCase() === title.toLowerCase()) : -1;
    this.show(i >= 0 ? i : this.current, true);
  }

  close(): void {
    if (!this.isOpen) return;
    this.ui.root.hidden = true;
    for (const b of this.ui.background) b.inert = false;
    this.lastFocus?.focus();
  }

  private async load(): Promise<void> {
    try {
      const raw = await this.deps.help.read();
      this.sections = raw ? helpSections(raw) : [];
      this.error = raw ? '' : 'The guide is missing from this installation (resources/skills/soma-app.md).';
    } catch (e) { this.error = e instanceof Error ? e.message : String(e); }
    this.loaded = !this.error;
    this.ui.nav.replaceChildren(...this.sections.map((s, i) => {
      const b = el('button', { textContent: s.title });
      b.dataset.help = String(i);
      b.addEventListener('click', () => this.show(i, false));
      return b;
    }));
  }

  private show(i: number, focus: boolean): void {
    if (this.error || !this.sections.length) {
      this.ui.body.replaceChildren(el('p', { className: 'st-empty', textContent: this.error || 'The guide is empty.' }));
      return;
    }
    this.current = i;
    const s = this.sections[i];
    this.ui.nav.querySelectorAll<HTMLButtonElement>('button[data-help]').forEach((b) => {
      if (b.dataset.help === String(i)) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    const doc = renderMarkdown(`## ${s.title}\n\n${s.text}`, AS_FILE, true, {
      link: (href) => { if (/^(https?:|mailto:)/i.test(href)) this.deps.openUrl(href); },
      image: (rel) => this.image(rel),
      toggleTask: () => {},
      edit: () => {},
    });
    doc.classList.add('help-doc');
    // Bilder passen in die Breite, ein Klick zeigt sie in voller Größe (kleine Beschriftungen lesbar)
    doc.querySelectorAll<HTMLImageElement>('img.md-img').forEach((img) => img.addEventListener('click', () => img.classList.toggle('full')));
    this.ui.body.replaceChildren(doc);
    this.ui.body.scrollTop = 0;
    if (focus) this.ui.nav.querySelector<HTMLElement>(`button[data-help="${i}"]`)?.focus();
  }

  /** Bild der Anleitung: nur aus `.soma/help/` (so stehen sie im Text), geladen aus den Dateien der App. */
  private image(rel: string): Promise<string | null> {
    const name = rel.startsWith(`${HELP_DIR}/`) ? rel.slice(HELP_DIR.length + 1) : '';
    if (!name) return Promise.resolve(null);
    let p = this.images.get(name);
    if (!p) {
      p = this.deps.help.image(name).then((bytes) => (bytes ? URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'image/png' })) : null)).catch(() => null);
      this.images.set(name, p);
    }
    return p;
  }

  /** Für die Tests: Abschnitte, gezeigter Abschnitt und wie viele Bilder geladen sind. */
  state(): { open: boolean; sections: string[]; current: string; images: number; loadedImages: number; text: string } {
    const imgs = [...this.ui.body.querySelectorAll<HTMLImageElement>('img')];
    return {
      open: this.isOpen, sections: this.sections.map((s) => s.title), current: this.sections[this.current]?.title ?? '',
      images: imgs.length, loadedImages: imgs.filter((x) => x.complete && x.naturalWidth > 0).length, text: this.ui.body.textContent ?? '',
    };
  }
}
