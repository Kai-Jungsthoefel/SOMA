import { lexer, type Token, type Tokens } from 'marked';
import { el } from './ui';

/** Was die Ansicht vom Rest der App braucht. */
export interface MarkdownDeps {
  /** Link angeklickt. `href` steht so in der Datei (relativ zur Markdown-Datei oder eine Web-Adresse). */
  link(href: string): void;
  /** Bild aus dem Projekt als blob:-Adresse, null wenn es nicht geht. Pfad relativ zum Projektordner. */
  image(rel: string): Promise<string | null>;
  /** Kästchen einer Aufgabenliste umgeschaltet: Zeichen an `pos` im Quelltext wird zu `ch` (' ' oder 'x'). */
  toggleTask(pos: number, ch: ' ' | 'x'): void;
  /** Doppelklick auf einen Block: im Editor an dieser Zeile weitermachen. */
  edit(line: number): void;
}

/** Benannte Entitäten, die in Notizen vorkommen. Der Lexer lässt sie stehen, der HTML-Renderer überließe sie dem Browser. */
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '­', mdash: '—', ndash: '–', hellip: '…', times: '×', deg: '°', plusmn: '±', micro: 'µ' };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
  const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
});
const TASK = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]/;
const isWeb = (href: string) => /^(https?:|mailto:)/i.test(href);

/**
 * Zeigt Markdown als Dokument (E51). Gebaut wird aus den Tokens von `marked` direkt DOM, ohne `innerHTML`: Der Text
 * stammt aus dem Projekt und damit vielleicht vom Agenten (Grundsatz: Texte aus dem Projekt nie per innerHTML).
 * Rohes HTML in der Datei wird deshalb nicht ausgeführt, sondern als Quelltext gezeigt (Block) oder weggelassen (Tags im Text).
 * Blöcke tragen ihre Zeilennummer (`data-line`): Doppelklick springt an dieselbe Stelle im Editor.
 */
export function renderMarkdown(src: string, file: string, readOnly: boolean, deps: MarkdownDeps): HTMLElement {
  const root = el('article', { className: 'md' });
  const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/') + 1) : '';
  const lineAt = (pos: number) => { let n = 1; for (let i = src.indexOf('\n'); i >= 0 && i < pos; i = src.indexOf('\n', i + 1)) n++; return n; };
  // Front Matter (Kopf der Skills zwischen zwei „---“): Daten für Programme. Als Markdown gelesen würde der ganze Kopf
  // zu einer Überschrift (Text über „---“), deshalb steht er als Quelltext vorn und nur der Rest geht an den Lexer.
  const fm = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(src);
  const bodyAt = fm ? fm[0].length : 0;
  let tokens: Token[];
  try { tokens = lexer(src.slice(bodyAt), { gfm: true }); } catch (e) {
    root.append(el('p', { className: 'md-err', textContent: `The file cannot be read as Markdown: ${e instanceof Error ? e.message : String(e)}` }));
    return root;
  }

  const inline = (list: Token[] | undefined, fallback = ''): (Node | string)[] => (list ? list.flatMap(inl) : [decode(fallback)]);
  const inl = (t: Token): (Node | string)[] => {
    switch (t.type) {
      case 'text': return t.tokens?.length ? inline(t.tokens) : [decode(t.text)];
      case 'escape': return [t.text];
      case 'strong': return [el('strong', {}, ...inline(t.tokens, t.text))];
      case 'em': return [el('em', {}, ...inline(t.tokens, t.text))];
      case 'del': return [el('del', {}, ...inline(t.tokens, t.text))];
      case 'codespan': return [el('code', { textContent: t.text })];
      case 'br': return [el('br')];
      case 'link': return [link(t as Tokens.Link)];
      case 'image': return [image(t as Tokens.Image)];
      // Eingebettete Tags: nur Zeilenumbruch übernehmen, sonst bleibt der Text dazwischen stehen
      case 'html': return /^<br\s*\/?>$/i.test(t.text.trim()) ? [el('br')] : [];
      case 'checkbox': return [];
      default: return 'tokens' in t && t.tokens ? inline(t.tokens) : [decode(t.raw)];
    }
  };

  // Kein href: Ein Klick darf das Fenster nie wegnavigieren, Mittelklick kein neues Fenster öffnen
  const link = (t: Tokens.Link) => {
    const href = t.autolink ? t.href : decode(t.href);
    const a = el('a', { className: 'md-link', title: t.title ? `${t.title}\n${href}` : href, tabIndex: 0 }, ...inline(t.tokens, t.text));
    a.setAttribute('role', 'link');
    a.dataset.href = href;
    return a;
  };

  const image = (t: Tokens.Image) => {
    const href = decode(t.href);
    const alt = decode(t.text);
    const img = el('img', { className: 'md-img', alt, title: t.title ?? alt });
    // Nur Bilder aus dem Projekt. Fremde Adressen lädt die App nicht (offline, und der Agent soll nichts nachladen lassen).
    if (isWeb(href) || /^[a-z][a-z0-9+.-]*:/i.test(href)) {
      return el('span', { className: 'md-imgmiss', textContent: `[Image: ${alt || href}]`, title: `External images are not loaded: ${href}` });
    }
    const rel = resolve(dir, href);
    void deps.image(rel).then((url) => {
      if (url) img.src = url;
      else img.replaceWith(el('span', { className: 'md-imgmiss', textContent: `[Image missing: ${rel}]` }));
    });
    return img;
  };

  /** Blöcke; `pos` ist die Stelle des Blocks im Quelltext (für Zeilennummern und Kästchen), -1 wenn unbekannt. */
  const block = (t: Token, pos: number): HTMLElement | null => {
    let node: HTMLElement | null;
    switch (t.type) {
      case 'space': case 'def': return null;
      case 'heading': node = el(`h${Math.min(6, Math.max(1, t.depth))}` as 'h1', {}, ...inline(t.tokens, t.text)); break;
      case 'paragraph': node = el('p', {}, ...inline(t.tokens, t.text)); break;
      case 'text': node = el('p', {}, ...inline(t.tokens, t.text)); break;
      case 'hr': node = el('hr'); break;
      case 'code': {
        const code = el('code', { textContent: t.text });
        node = el('pre', {}, code);
        if (t.lang) node.dataset.lang = t.lang;
        break;
      }
      case 'blockquote': node = el('blockquote', {}, ...blocks(t.tokens, pos)); break;
      case 'list': node = list(t as Tokens.List, pos); break;
      case 'table': node = table(t as Tokens.Table); break;
      case 'html': node = el('pre', { className: 'md-html', title: 'HTML is not run, only shown', textContent: t.text.replace(/\n$/, '') }); break;
      default: node = el('p', { textContent: t.raw });
    }
    if (pos >= 0) node.dataset.line = String(lineAt(pos));
    return node;
  };

  /** Unterblöcke: Ihre Lage im Quelltext ergibt sich aus der Suche nach ihrem Rohtext ab dem Anfang des Elternblocks. */
  const blocks = (list: Token[] | undefined, start: number): HTMLElement[] => {
    const out: HTMLElement[] = [];
    let cur = start;
    for (const t of list ?? []) {
      const at = cur >= 0 && t.raw ? src.indexOf(t.raw, cur) : -1;
      const n = block(t, at);
      if (n) out.push(n);
      if (at >= 0) cur = at + t.raw.length;
    }
    return out;
  };

  const list = (t: Tokens.List, pos: number) => {
    const node = el(t.ordered ? 'ol' : 'ul');
    if (t.ordered && typeof t.start === 'number' && t.start !== 1) node.setAttribute('start', String(t.start));
    let cur = pos;
    for (const item of t.items) {
      const at = cur >= 0 ? src.indexOf(item.raw, cur) : -1;
      if (at >= 0) cur = at + item.raw.length;
      const body = item.loose ? blocks(item.tokens, at) : item.tokens.flatMap((x) => (x.type === 'text' ? inl(x) : x.type === 'checkbox' ? [] : [block(x, -1) ?? '']));
      const li = el('li', {}, ...body);
      if (at >= 0) li.dataset.line = String(lineAt(at));
      if (item.task) {
        li.classList.add('md-task');
        const box = el('input', { type: 'checkbox', checked: !!item.checked });
        const m = at >= 0 ? TASK.exec(item.raw) : null;
        // Umschalten nur, wenn das Kästchen sicher im Quelltext gefunden ist. Sonst nur anzeigen.
        if (m && !readOnly) {
          const p = at + m[0].length - 2;
          box.title = 'Checking it off changes the file (save with Ctrl+S)';
          box.addEventListener('change', () => deps.toggleTask(p, box.checked ? 'x' : ' '));
        } else box.disabled = true;
        li.prepend(box);
      }
      node.append(li);
    }
    return node;
  };

  const table = (t: Tokens.Table) => {
    const cell = (c: Tokens.TableCell, tag: 'th' | 'td') => {
      const n = el(tag, {}, ...inline(c.tokens, c.text));
      if (c.align) n.style.textAlign = c.align;
      return n;
    };
    return el('div', { className: 'md-table' }, el('table', {},
      el('thead', {}, el('tr', {}, ...t.header.map((c) => cell(c, 'th')))),
      el('tbody', {}, ...t.rows.map((r) => el('tr', {}, ...r.map((c) => cell(c, 'td')))))));
  };

  if (fm) {
    const head = el('pre', { className: 'md-front', title: 'Front matter: data for the app, not part of the text', textContent: fm[1] });
    head.dataset.line = '1';
    root.append(head);
  }
  root.append(...blocks(tokens, bodyAt));
  if (!root.childElementCount) root.append(el('p', { className: 'md-empty', textContent: readOnly ? 'Empty file.' : 'Empty file. “Edit” at the top lets you write in it.' }));

  root.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('.md-link');
    if (!a?.dataset.href) return;
    e.preventDefault();
    const href = a.dataset.href;
    deps.link(isWeb(href) || href.startsWith('#') ? href : resolve(dir, href));
  });
  root.addEventListener('keydown', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('.md-link');
    if (a && e.key === 'Enter') a.click();
  });
  root.addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement).closest('input, .md-link')) return;
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-line]');
    if (b) deps.edit(Number(b.dataset.line));
  });
  return root;
}

/** Pfad relativ zur Markdown-Datei, ohne Anker und Abfrage. `..` über den Projektordner hinaus bleibt stehen und scheitert später an resolveInside. */
function resolve(dir: string, href: string): string {
  let p = href.replace(/[?#].*$/, '');
  try { p = decodeURIComponent(p); } catch { /* bleibt wie geschrieben */ }
  const parts: string[] = [];
  for (const s of (p.startsWith('/') ? p.slice(1) : dir + p).split('/')) {
    if (!s || s === '.') continue;
    if (s === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop();
    else parts.push(s);
  }
  return parts.join('/');
}
