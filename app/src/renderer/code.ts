import { icon } from './icons';
import { el } from './ui';

// Einfache Python-Hervorhebung pro Zeile. Mehrzeilige Strings färbt sie nur zeilenweise, das reicht zum Lesen.
const TOKEN = /(#.*$)|("""[^]*?"""|'''[^]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|\b(def|class|return|import|from|as|for|in|if|elif|else|while|with|try|except|finally|lambda|and|or|not|is|None|True|False|pass|break|continue|yield|raise|global|nonlocal|assert|del)\b|\b([A-Z][A-Z0-9_]{2,})\b|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_]\w*)(?=\()/g;

/** Eine Codezeile als DOM-Knoten (nur textContent, der Code kommt aus dem Projekt). */
export function highlightLine(line: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of line.matchAll(TOKEN)) {
    const i = m.index ?? 0;
    if (i > last) frag.append(line.slice(last, i));
    const cls = m[1] ? 'k-cm' : m[2] ? 'k-str' : m[3] ? 'k-kw' : (m[4] || m[5]) ? 'k-num' : 'k-fn';
    frag.append(el('span', { className: cls, textContent: m[0] }));
    last = i + m[0].length;
  }
  if (last < line.length) frag.append(line.slice(last));
  return frag;
}

/** Zeilen mit Nummern. `mark` hebt einen Bereich hervor (`hl` Auswahl, `er` Fehler). */
export function codeRows(lines: string[], firstNo: number, mark?: { from: number; to: number; kind: 'hl' | 'er' }): HTMLElement[] {
  return lines.map((l, i) => {
    const no = firstNo + i;
    const hit = mark && no >= mark.from && no <= mark.to;
    const row = el('div', { className: 'cl' + (hit ? ' ' + mark!.kind : '') }, el('span', { className: 'ln', textContent: String(no) }), el('span', {}, highlightLine(l)));
    row.dataset.line = String(no);
    return row;
  });
}

const MAX_LINES = 5000;

interface Mark { from: number; to: number; label: string; color?: string }

/**
 * Code-Panel (nur lesen). Offene Dateien als Reiter, die Auswahl im Viewer springt zur Codestelle, solange
 * „Mit Auswahl verknüpft“ an ist. Bearbeiten übernimmt der Agent. Ein Editor kommt in einem späteren Schritt.
 */
export class CodePanel {
  private files: string[] = [];
  private active: string | null = null;
  private mark: (Mark & { file: string }) | null = null;
  linked = true;

  constructor(private ui: { tabs: HTMLElement; info: HTMLElement; view: HTMLElement; link: HTMLButtonElement }, private read: (rel: string) => Promise<string>) {
    ui.link.addEventListener('click', () => {
      this.linked = !this.linked;
      ui.link.setAttribute('aria-pressed', String(this.linked));
    });
  }

  get activeFile(): string | null { return this.active; }

  async open(file: string, mark?: Mark): Promise<void> {
    if (!this.files.includes(file)) this.files.push(file);
    this.active = file;
    this.mark = mark ? { ...mark, file } : (this.mark?.file === file ? this.mark : null);
    await this.render(true);
  }

  /** Auswahl im Viewer: nur folgen, wenn verknüpft. */
  async follow(file: string, mark: Mark): Promise<void> {
    if (this.linked) await this.open(file, mark);
  }

  clearMark(): void { this.mark = null; void this.render(false); }

  /** Nach Dateiänderungen neu lesen, Scrollposition bleibt. */
  async refresh(): Promise<void> { if (this.active) await this.render(false); }

  reset(): void { this.files = []; this.active = null; this.mark = null; void this.render(false); }

  private close(file: string): void {
    this.files = this.files.filter((f) => f !== file);
    if (this.active === file) this.active = this.files[this.files.length - 1] ?? null;
    if (this.mark?.file === file) this.mark = null;
    void this.render(false);
  }

  private async render(scroll: boolean): Promise<void> {
    const { tabs, info, view } = this.ui;
    tabs.replaceChildren(...this.files.map((f) => {
      const x = el('button', { className: 'x', title: `${f} schließen` }, icon('x', 11, 2.2));
      x.setAttribute('aria-label', `${f} schließen`);
      x.addEventListener('click', (e) => { e.stopPropagation(); this.close(f); });
      const t = el('div', { className: 'ctab' + (f === this.active ? ' on' : ''), title: f }, el('span', { textContent: f.split('/').pop()! }), x);
      t.addEventListener('click', () => { this.active = f; void this.render(true); });
      return t;
    }));
    const m = this.mark && this.mark.file === this.active ? this.mark : null;
    if (m) {
      const sw = el('span', { className: 'sw' });
      if (m.color) sw.style.background = m.color;
      info.replaceChildren(sw, `${m.label} · Zeile ${m.from}${m.to !== m.from ? '–' + m.to : ''}`);
    } else info.replaceChildren();
    if (!this.active) { view.replaceChildren(el('div', { className: 'ftree' }, el('div', { className: 'hint', textContent: 'Keine Datei geöffnet. Klick auf ein Bauteil oder im Dateien-Panel auf eine Datei.' }))); return; }
    const top = view.scrollTop;
    let text: string;
    try { text = await this.read(this.active); } catch (e) {
      view.replaceChildren(el('div', { className: 'hint', textContent: `${this.active} lässt sich nicht lesen: ${e instanceof Error ? e.message : String(e)}` }));
      return;
    }
    const lines = text.split(/\r?\n/);
    const shown = lines.slice(0, MAX_LINES);
    view.replaceChildren(...codeRows(shown, 1, m ? { from: m.from, to: m.to, kind: 'hl' } : undefined));
    if (lines.length > MAX_LINES) view.append(el('div', { className: 'hint', textContent: `Nur die ersten ${MAX_LINES} von ${lines.length} Zeilen.` }));
    if (scroll && m) view.querySelector<HTMLElement>(`.cl[data-line="${m.from}"]`)?.scrollIntoView({ block: 'center' });
    else view.scrollTop = top;
  }
}
