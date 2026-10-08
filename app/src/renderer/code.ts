import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { bracketMatching, HighlightStyle, indentOnInput, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { Annotation, EditorState, RangeSetBuilder, StateEffect, StateField, Transaction, type Extension, type TransactionSpec } from '@codemirror/state';
import {
  Decoration, drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers,
  MatchDecorator, ViewPlugin, type DecorationSet, type ViewUpdate,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import { affectsBuild, readOnlyReason } from '../shared/editable';
import { icon } from './icons';
import { renderMarkdown } from './markdown';
import { PdfView, type PdfDeps } from './pdfview';
import { el } from './ui';

// Einfache Python-Hervorhebung pro Zeile für Codeausschnitte (Auswahl- und Fehlerkarte). Der Editor färbt über CodeMirror,
// mit denselben Klassen k-*, damit beides gleich aussieht.
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

// ---- Editor ---------------------------------------------------------------------------------------------------------

const MAX_EDIT_CHARS = 2_000_000;

export interface Mark { from: number; to: number; label: string; color?: string; kind?: 'hl' | 'er' }

interface Doc {
  file: string;
  state: EditorState;
  /** Inhalt auf der Platte beim letzten Lesen oder Schreiben, mit den Zeilenenden der Datei. Grundlage der Konfliktprüfung. */
  base: string;
  eol: '\n' | '\r\n';
  /** Grund, warum die Datei nur lesbar ist, sonst null. */
  locked: string | null;
  /** Der Text weicht vom gespeicherten Stand ab. */
  dirty: boolean;
  writing: boolean;
  /** Schreibvorgänge je Datei laufen nacheinander. */
  queue: Promise<unknown>;
  /** Die Datei wurde außerhalb geändert (disk) oder gelöscht (null), während hier ungesicherte Eingaben lagen. */
  conflict: { disk: string | null } | null;
  mark: Mark | null;
  scrollTop: number;
  /** Markdown als Dokument zeigen statt im Editor (E51). Nur bei .md-Dateien. */
  preview: boolean;
  previewScroll: number;
  /** PDF-Reiter (E54): Statt des Editors steht die PDF-Ansicht da, der Text bleibt leer und nur lesbar. */
  pdf?: PdfView;
}

const isMarkdown = (file: string) => /\.md$/i.test(file);
export const isPdf = (file: string) => /\.pdf$/i.test(file);

interface Ui {
  tabs: HTMLElement; info: HTMLElement; banner: HTMLElement; view: HTMLElement; link: HTMLButtonElement;
  /** Umschalter „Ansicht / Bearbeiten“ für Markdown, Knöpfe `[data-mode]`. */
  mode: HTMLElement;
}
interface Deps extends PdfDeps {
  /** Liest eine Datei frisch von der Platte (ohne Zwischenspeicher). */
  read(rel: string): Promise<string>;
  readBinary(rel: string): Promise<ArrayBuffer>;
  projectId(): string | null;
  toast(text: string, kind?: 'ok' | 'info' | 'error'): void;
  /** Rückfrage mit Knöpfen, liefert den Index (letzter Knopf: Abbrechen). */
  ask(o: { title: string; message: string; detail?: string; buttons: string[] }): Promise<number>;
  /** Die Menge der ungespeicherten Dateien hat sich geändert (für den Speicherstand oben). */
  changed(): void;
  /** Der aktive Reiter (null: keiner), etwa um die Datei im Dateibaum hervorzuheben. */
  active?(file: string | null): void;
  /** Link in einer Markdown-Ansicht: Web-Adresse oder Pfad im Projekt. */
  link(href: string): void;
  /** Bild aus dem Projekt für die Markdown-Ansicht als blob:-Adresse, null wenn es nicht geht. */
  image(rel: string): Promise<string | null>;
  /** Knopf „Speichern und bauen“ (wie Strg+S im Editor). */
  saveAndBuild(): void;
  /** Nach dem Speichern einer einzelnen Datei, die das Modell betrifft (Konflikt gelöst, Reiter geschlossen): bauen. */
  build(): void;
}

/** Änderungen, die von außen kommen (Agent, Wiederherstellen). Sie machen die Datei nicht „ungesichert“ und landen nicht im Rückgängig. */
const External = Annotation.define<boolean>();

const setMark = StateEffect.define<{ from: number; to: number; kind: 'hl' | 'er' } | null>();
const markField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setMark)) deco = e.value ? lineMarks(tr.state, e.value) : Decoration.none;
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function lineMarks(state: EditorState, m: { from: number; to: number; kind: 'hl' | 'er' }): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  for (let n = Math.max(1, m.from); n <= Math.min(m.to, state.doc.lines); n++) b.add(state.doc.line(n).from, state.doc.line(n).from, Decoration.line({ class: `cm-mark-${m.kind}` }));
  return b.finish();
}

// Parameter als Konstanten in Großbuchstaben (LENGTH, WALL) hervorheben: Die Vorlage und AGENTS.md setzen darauf
const CONSTANT = new MatchDecorator({ regexp: /\b[A-Z][A-Z0-9_]{2,}\b/g, decoration: Decoration.mark({ class: 'k-num' }) });
const constants = ViewPlugin.fromClass(class {
  decorations: DecorationSet;
  constructor(v: EditorView) { this.decorations = CONSTANT.createDeco(v); }
  update(u: ViewUpdate) { this.decorations = CONSTANT.updateDeco(u, this.decorations); }
}, { decorations: (p) => p.decorations });

const HIGHLIGHT = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.definitionKeyword, t.moduleKeyword, t.operatorKeyword, t.bool, t.null, t.self], class: 'k-kw' },
  { tag: [t.string, t.special(t.string), t.docString], class: 'k-str' },
  { tag: t.number, class: 'k-num' },
  { tag: [t.comment, t.lineComment], class: 'k-cm' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName)), t.definition(t.className)], class: 'k-fn' },
  // Markdown: Überschriften und Betonung wie im Dokument, Zeichen wie # und * gedämpft
  { tag: t.heading, class: 'k-mh' },
  { tag: t.strong, class: 'k-b' },
  { tag: t.emphasis, class: 'k-i' },
  { tag: t.strikethrough, class: 'k-s' },
  { tag: [t.link, t.url], class: 'k-fn' },
  { tag: t.monospace, class: 'k-str' },
  { tag: [t.quote, t.processingInstruction, t.contentSeparator, t.meta], class: 'k-cm' },
]);

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Code-Spalte mit Editor (CodeMirror 6, Entwurf 2: eigene Spalte neben der Seitenleiste). Offene Dateien als Reiter, die Auswahl im Viewer springt zur Codestelle, solange
 * „Mit Auswahl verknüpft“ an ist. Gespeichert wird nur auf Wunsch des Nutzers (Strg+S im Editor, „Speichern und bauen“,
 * „Speichern“ oben), danach wird gebaut. Beim Tippen passiert nichts auf der Platte.
 *
 * Der Agent schreibt an denselben Dateien. Deshalb kennt jede Datei den Stand, den der Editor zuletzt von der Platte
 * hatte (`base`). Ändert sie sich außen und hier liegt nichts Ungesichertes, übernimmt der Editor die neue Fassung.
 * Liegt hier etwas Ungesichertes, wird nichts überschrieben: Der Nutzer entscheidet, welche Fassung gilt, die andere
 * wandert in eine Sicherung (Grundsatz: nichts still überschreiben).
 */
export class CodePanel {
  private docs = new Map<string, Doc>();
  private loading = new Map<string, Promise<Doc | null>>();
  private active: string | null = null;
  private view: EditorView;
  private empty: HTMLElement;
  private saveBtn: HTMLButtonElement;
  private md: HTMLElement;
  /** Was die Markdown-Ansicht gerade zeigt, damit nicht bei jeder Kleinigkeit neu gebaut wird. */
  private mdShown: { file: string; text: string; locked: boolean } | null = null;
  /** blob:-Adressen der Bilder in der Markdown-Ansicht, freigegeben beim Neuaufbau. */
  private mdUrls: string[] = [];
  linked = true;

  constructor(private ui: Ui, private deps: Deps) {
    ui.link.addEventListener('click', () => {
      this.linked = !this.linked;
      ui.link.setAttribute('aria-pressed', String(this.linked));
    });
    this.view = new EditorView({ parent: ui.view, state: EditorState.create({ doc: '' }) });
    this.empty = el('div', { className: 'hint', textContent: 'No file open. Click a part, or a file under “Files” on the left.' });
    this.md = el('div', { className: 'mdview', tabIndex: -1 });
    this.md.hidden = true;
    ui.view.append(this.empty, this.md);
    ui.mode.addEventListener('click', (e) => {
      const m = (e.target as HTMLElement).closest<HTMLElement>('[data-mode]')?.dataset.mode;
      if (m) this.setPreview(m === 'view');
    });
    this.saveBtn = el('button', { id: 'btn-code-save', className: 'btn sm acc', textContent: 'Save and build', title: 'Save the changed files and build the model (Ctrl+S in the editor). “Save” at the top writes the ZIP file.' });
    this.saveBtn.addEventListener('click', () => deps.saveAndBuild());
    this.renderChrome();
  }

  get activeFile(): string | null { return this.active; }

  async open(file: string, mark?: Mark, scroll = true): Promise<void> {
    const d = this.docs.get(file) ?? (await this.load(file));
    if (!d) return;
    this.activate(d);
    if (mark) this.setMarkOn(d, mark, scroll);
    else if (d.mark && scroll) this.scrollTo(d, d.mark.from);
    this.renderChrome();
  }

  /** Auswahl im Viewer: nur folgen, wenn verknüpft. Während im Editor getippt wird, springt nichts, nur die Hervorhebung wandert mit. */
  async follow(file: string, mark: Mark): Promise<void> {
    if (!this.linked) return;
    const d = this.docs.get(file);
    if (this.view.hasFocus) { if (d) { this.setMarkOn(d, mark, false); this.renderChrome(); } return; }
    const same = d?.mark && d.mark.from === mark.from && d.mark.to === mark.to && this.active === file;
    await this.open(file, mark, !same);
  }

  /** Nach Dateiänderungen: offene Dateien mit der Platte abgleichen. */
  async refresh(): Promise<void> {
    for (const d of [...this.docs.values()]) {
      if (d.pdf) { await this.refreshPdf(d); continue; }
      if (d.writing) continue;
      let disk: string | null;
      try { disk = await this.deps.read(d.file); } catch { disk = null; }
      if (this.docs.get(d.file) !== d || d.writing) continue;
      // Wieder so wie zuletzt gelesen (etwa gelöscht und neu angelegt): Der Konflikt hat sich erledigt
      if (disk === d.base) { d.conflict = null; continue; }
      // Nur lesbare Dateien haben nie Eingaben: Ist die Datei weg, geht der Reiter zu, sonst wird neu geladen
      if (d.locked) { if (disk === null) await this.close(d.file); else this.takeExternal(d, disk); continue; }
      // Hier liegt Ungespeichertes oder die Datei ist weg: nicht still ersetzen, sondern fragen
      if (d.dirty || disk === null) d.conflict = { disk };
      else this.takeExternal(d, disk);
    }
    this.renderChrome();
    this.deps.changed();
  }

  /** Dateien mit ungespeicherten Eingaben (auch solche mit Konflikt). */
  unsaved(): string[] { return [...this.docs.values()].filter((d) => d.dirty || d.conflict).map((d) => d.file); }

  /** Offene Dateien, die `rel` ist oder die in diesem Ordner liegen. */
  openUnder(rel: string): string[] { return [...this.docs.keys()].filter((f) => f === rel || f.startsWith(`${rel}/`)); }

  /**
   * Schließt Reiter ohne Rückfrage, nachdem ihre Datei umbenannt oder gelöscht wurde. Nur für Reiter ohne ungespeicherte
   * Eingaben: Der Dateibaum lehnt Umbenennen und Löschen vorher ab, solange hier etwas ungespeichert ist.
   */
  forget(rel: string): void {
    const gone = this.openUnder(rel);
    if (!gone.length) return;
    for (const f of gone) { const p = this.docs.get(f)?.pdf; p?.dispose(); p?.root.remove(); this.docs.delete(f); }
    if (this.active && gone.includes(this.active)) {
      this.active = null;
      const next = [...this.docs.values()].pop();
      if (next) this.activate(next); else this.view.setState(EditorState.create({ doc: '' }));
    }
    this.renderChrome();
    this.deps.changed();
  }

  /**
   * Ungespeicherte Dateien schreiben (Strg+S, Knöpfe, vor dem Bauen). `ok` ist false, wenn etwas nicht geschrieben
   * werden konnte, etwa wegen eines Konflikts: Dann soll auch nicht gebaut oder als ZIP gespeichert werden.
   */
  async saveAll(): Promise<{ ok: boolean; saved: string[] }> {
    const saved: string[] = [];
    let ok = true;
    for (const d of [...this.docs.values()]) {
      if (d.conflict) { ok = false; continue; }
      if (!d.dirty) continue;
      if (await this.write(d)) saved.push(d.file); else ok = false;
    }
    return { ok, saved };
  }

  /** Ungespeicherte Eingaben verwerfen. Vorher kommt jede in eine Sicherung. Ohne Sicherung wird nichts verworfen. */
  async discardAll(): Promise<boolean> {
    for (const d of [...this.docs.values()]) {
      if (!d.dirty && !d.conflict) continue;
      if (!(await this.backup(d))) return false;
      if (d.conflict?.disk === null) { this.docs.delete(d.file); if (this.active === d.file) this.active = null; continue; }
      this.takeExternal(d, d.conflict ? d.conflict.disk! : d.base);
    }
    if (!this.active) { const next = [...this.docs.values()].pop(); if (next) this.activate(next); else this.view.setState(EditorState.create({ doc: '' })); }
    this.renderChrome();
    this.deps.changed();
    return true;
  }

  reset(): void {
    for (const d of this.docs.values()) d.pdf?.dispose();
    this.docs.clear();
    this.loading.clear();
    this.active = null;
    this.view.setState(EditorState.create({ doc: '' }));
    this.renderChrome();
  }

  /** Markdown: zwischen Ansicht und Editor wechseln. Im Editor landet der Cursor am Anfang von `line`, wenn angegeben. */
  setPreview(on: boolean, line?: number): void {
    const d = this.active ? this.docs.get(this.active) : undefined;
    if (!d || !isMarkdown(d.file) || (d.preview === on && line == null)) return;
    if (d.preview && !on) d.previewScroll = this.md.scrollTop;
    d.preview = on;
    this.renderChrome();
    if (on) { this.md.focus({ preventScroll: true }); return; }
    if (line != null) {
      const pos = d.state.doc.line(Math.max(1, Math.min(line, d.state.doc.lines))).from;
      this.view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 40 }) });
    }
    this.view.focus();
  }

  /** Text der aktiven Datei (für Tests und Anzeigen). */
  text(): string { return this.active ? this.docs.get(this.active)?.state.doc.toString() ?? '' : ''; }

  // ---- Laden und Anzeigen ---------------------------------------------------------------------------------------

  private load(file: string): Promise<Doc | null> {
    let p = this.loading.get(file);
    if (!p) {
      p = (async () => {
        if (isPdf(file)) return this.loadPdf(file);
        let text: string;
        try { text = await this.deps.read(file); } catch (e) { this.deps.toast(`${file} cannot be read: ${errText(e)}`, 'error'); return null; }
        const locked = readOnlyReason(file)
          ?? (text.length > MAX_EDIT_CHARS ? 'Too large to edit (over 2 MB).' : null)
          ?? (text.includes('\uFFFD') ? 'Not readable as UTF-8. Editing would damage the file.' : null);
        const d: Doc = { file, base: text, eol: text.includes('\r\n') ? '\r\n' : '\n', locked, dirty: false, writing: false, queue: Promise.resolve(), conflict: null, mark: null, scrollTop: 0,
          preview: isMarkdown(file), previewScroll: 0, state: null! };
        d.state = EditorState.create({ doc: text, extensions: this.extensions(d) });
        this.docs.set(file, d);
        return d;
      })().finally(() => this.loading.delete(file));
      this.loading.set(file, p);
    }
    return p;
  }

  private async loadPdf(file: string): Promise<Doc | null> {
    let data: ArrayBuffer;
    try { data = await this.deps.readBinary(file); } catch (e) { this.deps.toast(`${file} cannot be read: ${errText(e)}`, 'error'); return null; }
    const pdf = new PdfView(file, this.deps);
    pdf.root.hidden = true;
    this.ui.view.append(pdf.root);
    const d: Doc = { file, base: '', eol: '\n', locked: 'PDF', dirty: false, writing: false, queue: Promise.resolve(), conflict: null, mark: null, scrollTop: 0,
      preview: false, previewScroll: 0, pdf, state: EditorState.create({ doc: '', extensions: [EditorState.readOnly.of(true)] }) };
    this.docs.set(file, d);
    await pdf.load(data);
    return d;
  }

  /** Geänderte PDF neu laden (etwa vom Agenten neu erzeugt), gelöschte schließen. */
  private async refreshPdf(d: Doc): Promise<void> {
    let data: ArrayBuffer;
    try { data = await this.deps.readBinary(d.file); } catch { await this.close(d.file); return; }
    if (this.docs.get(d.file) === d) await d.pdf!.load(data);
  }

  private extensions(d: Doc): Extension[] {
    const py = /\.py$/i.test(d.file);
    return [
      lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), drawSelection(), indentOnInput(),
      syntaxHighlighting(HIGHLIGHT), bracketMatching(), closeBrackets(), highlightActiveLine(), highlightSelectionMatches(), search({ top: false }),
      py ? [python(), constants] : isMarkdown(d.file) ? [markdown(), EditorView.lineWrapping] : [],
      indentUnit.of('    '), EditorState.tabSize.of(4), EditorState.readOnly.of(!!d.locked),
      keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
      markField,
      EditorView.updateListener.of((u) => this.onUpdate(d, u)),
    ];
  }

  private onUpdate(d: Doc, u: ViewUpdate): void {
    d.state = u.state;
    if (!u.transactions.some((tr) => tr.docChanged && !tr.annotation(External))) return;
    const was = d.dirty;
    d.dirty = this.textOf(d) !== d.base; // zurück auf den gespeicherten Stand getippt: wieder gespeichert
    this.renderChrome();
    if (was !== d.dirty) this.deps.changed();
  }

  private activate(d: Doc): void {
    const prev = this.active ? this.docs.get(this.active) : undefined;
    if (prev === d && this.view.state === d.state) return;
    if (prev) { prev.scrollTop = this.view.scrollDOM.scrollTop; if (prev.preview && this.mdShown) prev.previewScroll = this.md.scrollTop; }
    this.active = d.file;
    this.view.setState(d.state);
    this.view.scrollDOM.scrollTop = d.scrollTop;
  }

  /** Änderung auf Doc anwenden, egal ob es gerade im Editor steht. */
  private apply(d: Doc, spec: TransactionSpec): void {
    if (this.active === d.file && this.view.state === d.state) this.view.dispatch(spec);
    else d.state = d.state.update(spec).state;
  }

  private setMarkOn(d: Doc, mark: Mark, scroll: boolean): void {
    d.mark = mark;
    this.apply(d, { effects: setMark.of({ from: mark.from, to: mark.to, kind: mark.kind ?? 'hl' }) });
    if (scroll) this.scrollTo(d, mark.from);
  }

  private scrollTo(d: Doc, line: number): void {
    if (this.active !== d.file) return;
    const pos = d.state.doc.line(Math.max(1, Math.min(line, d.state.doc.lines))).from;
    this.view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
  }

  private async close(file: string): Promise<void> {
    const d = this.docs.get(file);
    if (!d) return;
    if (d.dirty || d.conflict) {
      const c = await this.deps.ask({
        title: 'Close file', message: `${file} has unsaved changes.`,
        detail: d.conflict ? 'The file was also changed outside the editor. Discard keeps your version as a backup.' : 'Discard keeps your version as a backup.',
        buttons: d.conflict ? ['Discard', 'Cancel'] : ['Save', 'Discard', 'Cancel'],
      });
      const choice = d.conflict ? (c === 0 ? 'discard' : 'cancel') : c === 0 ? 'save' : c === 1 ? 'discard' : 'cancel';
      if (choice === 'cancel') return;
      if (choice === 'save') { if (!(await this.write(d))) return; if (affectsBuild(d.file)) this.deps.build(); }
      else if (!(await this.backup(d))) return;
    }
    d.pdf?.dispose();
    d.pdf?.root.remove();
    this.docs.delete(file);
    if (this.active === file) {
      this.active = null;
      const next = [...this.docs.values()].pop();
      if (next) this.activate(next); else this.view.setState(EditorState.create({ doc: '' }));
    }
    this.renderChrome();
    this.deps.changed();
  }

  // ---- Schreiben und Konflikte ----------------------------------------------------------------------------------

  private textOf(d: Doc): string {
    const s = d.state.doc.toString();
    return d.eol === '\r\n' ? s.replace(/\n/g, '\r\n') : s; // Zeilenenden der Datei beibehalten, sonst änderte sich jede Zeile
  }

  /** Schreibt die Datei. Liefert true, wenn sie danach auf der Platte steht. */
  private write(d: Doc, force = false): Promise<boolean> {
    const p = d.queue.then(() => this.doWrite(d, force));
    d.queue = p.catch(() => undefined);
    return p;
  }

  private async doWrite(d: Doc, force: boolean): Promise<boolean> {
    const id = this.deps.projectId();
    if (!d.dirty) return true;
    if (d.locked || (d.conflict && !force) || !id || this.docs.get(d.file) !== d) return false;
    const text = this.textOf(d);
    d.writing = true;
    let r;
    try { r = await window.soma.fs.writeText(id, d.file, text, d.base, force); } catch (e) { r = { ok: false, error: errText(e) }; }
    d.writing = false;
    if (this.docs.get(d.file) !== d) return false;
    if (r.ok) {
      d.base = text;
      d.conflict = null;
      d.dirty = this.textOf(d) !== text; // während des Schreibens weitergetippt: bleibt ungespeichert
      if (r.backup) this.deps.toast(`${d.file} saved. The outside version is kept as a backup at ${r.backup}`, 'info');
    } else if (r.conflict) {
      d.conflict = { disk: r.disk ?? null };
    } else this.deps.toast(`${d.file} could not be saved: ${r.error}`, 'error');
    this.renderChrome();
    this.deps.changed();
    // Eine Änderung von außen kann während des Schreibens gekommen sein, ihr Ereignis wurde dann übersprungen
    void this.refresh();
    return !!r.ok;
  }

  /** Eigene Fassung als Sicherung ablegen (vor dem Verwerfen). Meldet den Pfad. */
  private async backup(d: Doc): Promise<boolean> {
    const id = this.deps.projectId();
    if (!id) return false;
    try {
      const b = await window.soma.fs.backupText(id, d.file, this.textOf(d));
      this.deps.toast(`Your version of ${d.file} is kept as a backup at ${b}`, 'info');
      return true;
    } catch (e) {
      this.deps.toast(`${d.file} could not be backed up, nothing is discarded: ${errText(e)}`, 'error');
      return false;
    }
  }

  /** Neue Fassung von der Platte übernehmen. Nur der geänderte Teil wird ersetzt, damit Schreibmarke und Ansicht bleiben. */
  private takeExternal(d: Doc, disk: string): void {
    const next = disk.replace(/\r\n?/g, '\n');
    const cur = d.state.doc.toString();
    let a = 0;
    while (a < cur.length && a < next.length && cur[a] === next[a]) a++;
    let b = 0;
    while (b < cur.length - a && b < next.length - a && cur[cur.length - 1 - b] === next[next.length - 1 - b]) b++;
    if (a !== cur.length || a !== next.length) {
      this.apply(d, { changes: { from: a, to: cur.length - b, insert: next.slice(a, next.length - b) }, annotations: [External.of(true), Transaction.addToHistory.of(false)] });
    }
    d.base = disk;
    d.eol = disk.includes('\r\n') ? '\r\n' : '\n';
    d.dirty = false;
    d.conflict = null;
  }

  /** Konflikt: die Fassung aus dem Editor gilt. Die Fassung auf der Platte sichert der Hauptprozess vorher. */
  async keepMine(file = this.active): Promise<void> {
    const d = file ? this.docs.get(file) : undefined;
    if (!d?.conflict) return;
    d.conflict = null;
    d.dirty = true;
    if ((await this.write(d, true)) && affectsBuild(d.file)) this.deps.build();
  }

  /** Konflikt: die Fassung von außen gilt. Die eigene wird vorher gesichert, ohne Sicherung wird nichts verworfen. */
  async takeTheirs(file = this.active): Promise<void> {
    const d = file ? this.docs.get(file) : undefined;
    if (!d?.conflict || !(await this.backup(d))) return;
    const disk = d.conflict.disk;
    if (disk === null) { d.conflict = null; d.dirty = false; await this.close(d.file); return; }
    this.takeExternal(d, disk);
    this.renderChrome();
    this.deps.changed();
  }

  // ---- Oberfläche -----------------------------------------------------------------------------------------------

  private renderChrome(): void {
    const { tabs, info, banner } = this.ui;
    this.deps.active?.(this.active);
    tabs.replaceChildren(...[...this.docs.values()].map((d) => {
      const x = el('button', { className: 'x', title: `Close ${d.file}` }, icon('x', 11, 2.2));
      x.setAttribute('aria-label', `Close ${d.file}`);
      x.addEventListener('click', (e) => { e.stopPropagation(); void this.close(d.file); });
      const state = d.conflict ? el('span', { className: 'dirty warn', textContent: '●', title: 'Conflict with a change from outside' })
        : d.dirty ? el('span', { className: 'dirty', textContent: '●', title: 'Not saved' }) : null;
      const tab = el('div', { className: 'ctab' + (d.file === this.active ? ' on' : ''), title: d.file }, el('span', { textContent: d.file.split('/').pop()! }), state, x);
      tab.addEventListener('click', () => { this.activate(d); this.renderChrome(); });
      return tab;
    }));

    const d = this.active ? this.docs.get(this.active) : undefined;
    const md = !!d && isMarkdown(d.file);
    this.ui.mode.hidden = !md;
    this.ui.mode.querySelectorAll<HTMLElement>('[data-mode]').forEach((b) => b.setAttribute('aria-checked', String((b.dataset.mode === 'view') === !!d?.preview)));
    this.view.dom.hidden = !d || (md && d.preview) || !!d.pdf;
    this.empty.hidden = !!d;
    for (const x of this.docs.values()) if (x.pdf && x.pdf.root.hidden !== (x !== d)) { x.pdf.root.hidden = x !== d; if (x !== d) x.pdf.hidden(); else x.pdf.shown(); }
    this.renderPreview(md && d.preview ? d : null);
    if (!d) { info.replaceChildren(); banner.hidden = true; return; }

    const m = d.pdf ? null : d.mark;
    const left: (Node | string)[] = [];
    if (d.pdf) { /* PDF: eigene Leiste in der Ansicht */ }
    else if (d.locked) left.push(icon('lock', 13, 2), `Read only. ${d.locked}`);
    else if (m) {
      const sw = m.kind === 'er' ? el('span', { className: 'ci-err' }, icon('alert', 13, 2)) : el('span', { className: 'sw' });
      if (m.color) sw.style.background = m.color;
      left.push(sw, `${m.label} · ${m.to !== m.from ? 'lines' : 'line'} ${m.from}${m.to !== m.from ? '–' + m.to : ''}`);
    }
    // Ungespeichert (in irgendeiner Datei, ohne Konflikt): Hinweis und Knopf, gespeichert und gebaut wird erst auf Wunsch
    const waiting = [...this.docs.values()].filter((x) => x.dirty && !x.conflict);
    const pending = waiting.length > 0;
    // Gebaut wird nur, wenn eine gespeicherte Datei das Modell betrifft. Sonst heißt der Knopf nur „Speichern“.
    this.saveBtn.textContent = waiting.some((x) => affectsBuild(x.file)) ? 'Save and build' : 'Save';
    const hint = !d.locked && d.dirty && !d.conflict ? el('span', { className: 'c3 ci-hint', textContent: 'Not saved · Ctrl+S' }) : '';
    if (left.length || pending) info.replaceChildren(el('span', { className: 'ci-main' }, ...left), el('span', { className: 'grow' }), hint, pending ? this.saveBtn : '');
    else info.replaceChildren();
    info.classList.toggle('locked', !!d.locked && !d.pdf);

    banner.hidden = !d.conflict;
    if (d.conflict) {
      const gone = d.conflict.disk === null;
      const keep = el('button', { className: 'btn sm acc', textContent: gone ? 'Recreate with my version' : 'Keep my version' });
      const take = el('button', { className: 'btn sm', textContent: gone ? 'Close' : 'Load the outside version' });
      keep.addEventListener('click', () => void this.keepMine(d.file));
      take.addEventListener('click', () => void this.takeTheirs(d.file));
      banner.replaceChildren(
        el('span', { className: 'cb-ico' }, icon('alert', 16)),
        el('div', { className: 'cb-text' },
          el('b', { textContent: gone ? `${d.file} was deleted outside the editor` : `${d.file} was changed outside the editor, probably by the agent` }),
          el('span', { textContent: 'Your edits here are not saved yet. The version you do not choose goes into a backup.' }),
          el('div', { className: 'cb-actions' }, keep, take)));
    }
  }

  /** Baut die Markdown-Ansicht neu, wenn sich Datei, Text oder Schreibschutz geändert haben. Die Scrolllage bleibt. */
  private renderPreview(d: Doc | null): void {
    this.md.hidden = !d;
    if (!d) { this.mdShown = null; return; }
    const text = d.state.doc.toString(), locked = !!d.locked;
    const s = this.mdShown;
    if (s && s.file === d.file && s.text === text && s.locked === locked) return;
    const top = s?.file === d.file ? this.md.scrollTop : d.previewScroll;
    for (const u of this.mdUrls.splice(0)) URL.revokeObjectURL(u);
    this.md.replaceChildren(renderMarkdown(text, d.file, locked, {
      link: (href) => {
        if (!href.startsWith('#')) { this.deps.link(href); return; }
        // Anker: zur Überschrift mit passendem Text springen (Schreibweise wie bei GitHub: klein, Leerzeichen als Bindestrich)
        const slug = (x: string) => x.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
        let want = href.slice(1).toLowerCase();
        try { want = decodeURIComponent(want); } catch { /* bleibt wie geschrieben */ }
        [...this.md.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')].find((h) => slug(h.textContent ?? '') === want)?.scrollIntoView({ block: 'start' });
      },
      image: async (rel) => {
        const url = await this.deps.image(rel);
        if (url) this.mdUrls.push(url);
        return url;
      },
      toggleTask: (pos, ch) => {
        if (d.locked || this.docs.get(d.file) !== d || d.state.doc.sliceString(pos, pos + 1).toLowerCase() === ch) return;
        this.apply(d, { changes: { from: pos, to: pos + 1, insert: ch }, userEvent: 'input' });
      },
      edit: (line) => this.setPreview(false, line),
    }));
    this.md.scrollTop = top;
    this.mdShown = { file: d.file, text, locked };
  }

  // ---- Prüfhilfen (nur für Tests) -------------------------------------------------------------------------------

  testApi() {
    return {
      state: () => {
        const d = this.active ? this.docs.get(this.active) : undefined;
        return {
          file: this.active, files: [...this.docs.keys()], dirty: !!d?.dirty, conflict: d?.conflict ? (d.conflict.disk === null ? 'gone' : 'changed') : null,
          locked: d?.locked ?? null, readOnly: this.view.state.readOnly, preview: !this.md.hidden, pdf: d?.pdf?.state() ?? null, line: this.view.state.doc.lineAt(this.view.state.selection.main.head).number,
          rendered: this.md.hidden ? null : [...this.md.querySelectorAll<HTMLElement>('.md > *, .md li')].map((x) => `${x.tagName.toLowerCase()}:${(x.textContent ?? '').trim().slice(0, 60)}`), text: this.text(), focused: this.view.hasFocus, unsaved: this.unsaved(),
          marked: [...this.ui.view.querySelectorAll('.cm-line.cm-mark-hl, .cm-line.cm-mark-er')].map((x) => (x.classList.contains('cm-mark-er') ? 'er:' : 'hl:') + x.textContent),
        };
      },
      /** Wie Tippen: ersetzt den ersten Treffer im aktiven Dokument als Eingabe des Nutzers. */
      replace: (find: string, repl: string) => {
        const i = this.view.state.doc.toString().indexOf(find);
        if (i < 0 || this.view.state.readOnly) return false;
        this.view.dispatch({ changes: { from: i, to: i + find.length, insert: repl }, userEvent: 'input.type' });
        return true;
      },
      focus: () => this.view.focus(),
      pdfSelect: (page: number, find: string) => (this.active ? this.docs.get(this.active)?.pdf?.select(page, find) ?? false : false),
      pdfQuote: () => (this.active ? this.docs.get(this.active)?.pdf?.sendQuote() : undefined),
      pdfMarkPage: (n?: number) => (this.active ? this.docs.get(this.active)?.pdf?.markPage(n) : undefined),
      /** Lage des Editors im Panel: füllt er die Höhe, und lässt er sich scrollen? */
      layout: () => {
        const e = this.view.dom.getBoundingClientRect(), v = this.ui.view.getBoundingClientRect(), s = this.view.scrollDOM;
        return { editorTop: e.top, editorBottom: e.bottom, viewTop: v.top, viewBottom: v.bottom, scrollHeight: s.scrollHeight, clientHeight: s.clientHeight };
      },
      scrollToEnd: () => { this.view.scrollDOM.scrollTop = 1e7; return this.view.scrollDOM.scrollTop; },
      blur: () => this.view.contentDOM.blur(),
      keepMine: () => this.keepMine(),
      takeTheirs: () => this.takeTheirs(),
    };
  }
}
