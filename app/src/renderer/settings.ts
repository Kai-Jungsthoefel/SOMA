import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { syntaxHighlighting } from '@codemirror/language';
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension } from '@codemirror/state';
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers } from '@codemirror/view';
import { skillIdFrom, uniqueSkillId } from '../shared/skillname';
import type { LibraryResult, LibrarySkill, LibraryState, LibraryText, SkillCheck, SkillMode, SkillSource, SomaApi } from '../shared/types';
import { frontMatter, HIGHLIGHT } from './code';
import { icon } from './icons';
import { renderMarkdown } from './markdown';
import { CATEGORY_ICON } from './skills';
import { el, menus } from './ui';

/** Reiter der Einstellungen (E78, E81). */
export type SettingsSection = 'viewer' | 'keys' | 'skills' | 'storage' | 'about';
export const SECTIONS: SettingsSection[] = ['viewer', 'keys', 'skills', 'storage', 'about'];
/** Ein Reiter außer „Skills“: wird beim Zeigen aufgefrischt. */
export interface SettingsPage { show(): void }

interface Deps {
  library: SomaApi['library'];
  choose: SomaApi['dialog']['choose'];
  toast(text: string, kind?: 'ok' | 'info' | 'error'): void;
  /** Link aus der Vorschau eines Skills. */
  link(href: string): void;
  /** Die Bibliothek hat sich geändert: Panel „Skills“ des offenen Modells neu laden. */
  changed(): void;
  /** Stufe eines Skills im offenen Modell, null ohne Modell. */
  modelMode(id: string): Promise<SkillMode | null>;
  /** Die übrigen Reiter (settingspages.ts). */
  pages: Partial<Record<SettingsSection, SettingsPage>>;
}

interface Ui {
  root: HTMLElement;
  /** Leiste mit den Reitern (Knöpfe mit `data-sec`) und je Reiter ein Abschnitt `#st-<name>`. */
  nav: HTMLElement;
  list: HTMLElement;
  editor: HTMLElement;
  /** Popover für den Namen eines neuen Skills. */
  popover: HTMLElement;
  newBtn: HTMLButtonElement;
  importBtn: HTMLButtonElement;
  folderBtn: HTMLButtonElement;
  close: HTMLButtonElement;
  /** Was hinter dem Fenster liegt: gesperrt, solange es offen ist (Tab und Klicks bleiben im Fenster). */
  background: HTMLElement[];
}

type ViewMode = 'edit' | 'preview' | 'builtin';
const MODES: { mode: SkillMode; label: string }[] = [{ mode: 'off', label: 'Off' }, { mode: 'demand', label: 'On demand' }, { mode: 'always', label: 'Always' }];
const SOURCE_TEXT: Record<SkillSource, string> = { builtin: 'built into the app', edited: 'built-in skill, edited by you', own: 'your own skill' };
const SOURCE_BADGE: Record<SkillSource, string> = { builtin: '', edited: 'Edited', own: 'Yours' };
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Einstellungen (E78, E81) mit Reitern: Viewer, Skills, Speicher, Info. Dieser Teil ist das Fenster selbst und der Reiter
 * „Skills“, die übrigen stehen in settingspages.ts. Skills: links die Liste (mitgelieferte, bearbeitete, eigene), rechts der
 * Text im Editor mit Vorschau und Prüfung beim Tippen. Gespeichert wird nur auf Wunsch (Speichern, Strg+S). Die Modelle
 * merken davon erst etwas, wenn ein Skill dort neu kopiert wird: Ihre Kopien bleiben, wie sie sind.
 */
export class SettingsDialog {
  private lib: LibraryState | null = null;
  /** Offener Skill, `base`: der zuletzt geladene oder gespeicherte Text. */
  private doc: (LibraryText & { base: string }) | null = null;
  private mode: ViewMode = 'edit';
  private check: SkillCheck | null = null;
  private checkTimer: ReturnType<typeof setTimeout> | undefined;
  private busy = false;
  private error = '';
  private lastFocus: HTMLElement | null = null;
  /** Gezeigter Reiter. Beim nächsten Öffnen ohne Ziel kommt derselbe wieder. */
  private section: SettingsSection = 'viewer';
  private view: EditorView;
  private builtinView: EditorView | null = null;
  private els: { empty: HTMLElement; ed: HTMLElement; hd: HTMLElement; notes: HTMLElement; bar: HTMLElement; cm: HTMLElement; md: HTMLElement; bi: HTMLElement; check: HTMLElement };

  constructor(private ui: Ui, private deps: Deps) {
    const cm = el('div', { className: 'st-cm', id: 'st-cm' });
    const md = el('div', { className: 'mdview st-md', tabIndex: -1 });
    const bi = el('div', { className: 'st-cm st-bi' });
    this.els = {
      empty: el('div', { className: 'st-empty', textContent: 'Select a skill on the left, or create your own with “New skill”.' }),
      ed: el('div', { className: 'st-ed' }), hd: el('div', { className: 'st-ed-hd' }), notes: el('div', { className: 'st-notes' }),
      bar: el('div', { className: 'st-ed-bar' }), cm, md, bi, check: el('div', { className: 'st-check', role: 'status' }),
    };
    this.els.ed.append(this.els.hd, this.els.notes, this.els.bar, el('div', { className: 'st-view' }, cm, md, bi), this.els.check);
    ui.editor.replaceChildren(this.els.empty, this.els.ed);
    this.view = new EditorView({ parent: cm, state: this.editorState('') });

    ui.close.addEventListener('click', () => void this.close());
    ui.newBtn.addEventListener('click', () => this.askName(ui.newBtn));
    ui.importBtn.addEventListener('click', () => void this.importFiles());
    ui.folderBtn.addEventListener('click', () => void deps.library.reveal());
    ui.nav.querySelectorAll<HTMLButtonElement>('button[data-sec]').forEach((b) => b.addEventListener('click', () => void this.show(b.dataset.sec as SettingsSection)));
    // Escape schließt, außer CodeMirror braucht ihn (Suche) oder ein Popover ist offen (das fängt Menus vorher ab)
    ui.root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); void this.close(); }
      else if (this.section === 'skills' && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); void this.save(); }
    });
  }

  get isOpen(): boolean { return !this.ui.root.hidden; }

  /** Öffnen: mit `id` gleich bei diesem Skill (Reiter „Skills“), sonst im Reiter `section` oder dem zuletzt gezeigten. */
  async open(id?: string, section?: SettingsSection): Promise<void> {
    if (!this.isOpen) {
      this.lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      menus.close();
      this.ui.root.hidden = false;
      for (const b of this.ui.background) b.inert = true;
    }
    const sec = id ? 'skills' : section ?? this.section;
    if (sec !== 'skills') { await this.show(sec); return; }
    this.showSection('skills');
    await this.reload();
    if (id && id !== this.doc?.id) await this.select(id);
    else if (this.doc && !this.lib?.skills.some((s) => s.id === this.doc!.id)) { this.doc = null; this.render(); } // außerhalb gelöscht
    else this.render();
    (this.ui.list.querySelector<HTMLElement>('.st-row.sel') ?? this.ui.newBtn).focus();
  }

  /** Reiter wechseln. „Skills“ mit ungespeichertem Text zu verlassen ist unbedenklich: Der Text bleibt im Editor. */
  async show(sec: SettingsSection): Promise<void> {
    if (sec === 'skills') { await this.open(undefined, 'skills'); return; }
    this.showSection(sec);
    this.deps.pages[sec]?.show();
    this.ui.nav.querySelector<HTMLElement>(`button[data-sec="${sec}"]`)?.focus();
  }

  private showSection(sec: SettingsSection): void {
    this.section = sec;
    for (const s of SECTIONS) {
      const page = document.getElementById(`st-${s}`);
      if (page) page.hidden = s !== sec;
    }
    this.ui.nav.querySelectorAll<HTMLButtonElement>('button[data-sec]').forEach((b) => {
      if (b.dataset.sec === sec) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
  }

  /** Schließen, bei ungespeicherten Änderungen erst fragen. Rückgabe: geschlossen. */
  async close(): Promise<boolean> {
    if (!this.isOpen) return true;
    if (!(await this.confirmLeave('Close settings'))) return false;
    menus.close();
    this.ui.root.hidden = true;
    for (const b of this.ui.background) b.inert = false;
    this.lastFocus?.focus();
    return true;
  }

  private async reload(): Promise<void> {
    try { this.lib = await this.deps.library.list(); this.error = ''; } catch (e) { this.error = errText(e); }
    this.renderList();
  }

  private text(): string { return this.view.state.doc.toString(); }
  private get dirty(): boolean { return !!this.doc && this.text() !== this.doc.base; }
  private entry(id: string | undefined = this.doc?.id): LibrarySkill | undefined { return this.lib?.skills.find((s) => s.id === id); }
  private titleOf(id: string): string { return this.entry(id)?.title ?? id; }

  private setText(text: string): void {
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } });
  }

  /** Ungespeichertes erst sichern oder verwerfen lassen. Rückgabe: weitermachen. */
  private async confirmLeave(what: string): Promise<boolean> {
    if (!this.dirty) return true;
    const i = await this.deps.choose({ title: what, message: `Save the changes to “${this.titleOf(this.doc!.id)}”?`, detail: 'Otherwise they are lost.', buttons: ['Save', 'Discard', 'Cancel'] });
    if (i === 0) return this.save();
    if (i === 1) { this.setText(this.doc!.base); return true; }
    return false;
  }

  /** Skill zum Bearbeiten öffnen (null: keinen). */
  async select(id: string | null): Promise<void> {
    if (id === (this.doc?.id ?? null)) return;
    if (!(await this.confirmLeave('Switch skill'))) return;
    if (id == null) { this.doc = null; this.render(); return; }
    let t: LibraryText;
    try { t = await this.deps.library.read(id); } catch (e) {
      this.deps.toast(`The skill cannot be opened: ${errText(e)}`, 'error');
      await this.reload();
      return;
    }
    this.doc = { ...t, base: t.text };
    this.mode = 'edit';
    this.check = null;
    this.view.setState(this.editorState(t.text));
    this.render();
    this.scheduleCheck(0);
  }

  private editorState(text: string, readOnly = false): EditorState {
    return EditorState.create({ doc: text, extensions: this.extensions(readOnly) });
  }

  private extensions(readOnly: boolean): Extension[] {
    return [
      lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), history(), drawSelection(), syntaxHighlighting(HIGHLIGHT),
      highlightActiveLine(), highlightSelectionMatches(), search({ top: false }), markdown({ extensions: [frontMatter] }), EditorView.lineWrapping,
      EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly), keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
      readOnly ? [] : EditorView.updateListener.of((u) => { if (u.docChanged) { this.renderChrome(); this.scheduleCheck(); } }),
    ];
  }

  /** Prüfung im Hauptprozess, kurz nach dem letzten Tastendruck. Ein veraltetes Ergebnis wird verworfen. */
  private scheduleCheck(delay = 350): void {
    clearTimeout(this.checkTimer);
    this.checkTimer = setTimeout(() => {
      const id = this.doc?.id, text = this.text();
      if (!id) return;
      void this.deps.library.check(text).then((c) => {
        if (this.doc?.id !== id || this.text() !== text) return;
        this.check = c;
        this.renderCheck();
      }).catch(() => { /* bleibt ohne Prüfung */ });
    }, delay);
  }

  /** Speichern. Rückgabe: gespeichert (oder nichts zu speichern). */
  async save(): Promise<boolean> {
    const d = this.doc;
    if (!d || this.busy) return false;
    if (!this.dirty) return true;
    const text = this.text();
    const title = this.titleOf(d.id);
    this.busy = true;
    this.renderChrome();
    let r: LibraryResult;
    try { r = await this.deps.library.save(d.id, text, d.base); } catch (e) { r = { ok: false, error: errText(e), library: this.lib ?? { skills: [], ignored: [], dir: '' } }; }
    this.busy = false;
    this.lib = r.library;
    if (!r.ok) { this.render(); this.deps.toast(`“${title}” was not saved: ${r.error ?? 'unknown error'}`, 'error'); return false; }
    // Die Herkunft kann wechseln: Speichern macht aus einem mitgelieferten einen bearbeiteten, der Text der mitgelieferten
    // Fassung macht ihn wieder zum mitgelieferten
    const source = this.entry(d.id)?.source ?? d.source;
    this.doc = { ...d, base: text, source };
    this.check = { errors: [], warnings: r.warnings ?? [] };
    this.render();
    this.deps.changed();
    const inModel = await this.deps.modelMode(d.id).catch(() => null);
    const what = source === 'builtin' ? 'is the built-in version again' : 'saved';
    const model = inModel && inModel !== 'off' ? ' The open model keeps its copy: switch the skill off and on there to take over this version.' : '';
    const kept = r.backup ? ` The file had been changed outside the app, that version is in the backup: ${r.backup}` : '';
    this.deps.toast(`“${this.titleOf(d.id)}” ${what}. New models get this version.${model}${kept}`, r.backup ? 'info' : 'ok');
    return true;
  }

  /** Name für einen neuen Skill (`from`: als Kopie davon) in einem Popover am Knopf. */
  private askName(anchor: HTMLElement, from?: LibrarySkill): void {
    const pop = this.ui.popover;
    if (menus.isOpen(pop)) { menus.close(); return; }
    const input = el('input', { className: 'st-name-in', type: 'text', value: from ? `${from.title} (copy)` : '', placeholder: 'Name, for example Welded frames', spellcheck: false, autocomplete: 'off' });
    input.maxLength = 80;
    input.setAttribute('aria-label', 'Name of the skill');
    const file = el('div', { className: 'mnote st-name-file' });
    const taken = new Set([...(this.lib?.skills ?? []).map((s) => s.id), ...(this.lib?.ignored ?? []).map((f) => f.name.replace(/\.md$/i, '').toLowerCase())]);
    const ok = el('button', { className: 'btn sm acc', textContent: from ? 'Duplicate' : 'Create' });
    const cancel = el('button', { className: 'btn sm', textContent: 'Cancel' });
    const update = () => {
      const name = input.value.trim();
      file.textContent = name ? `File: ${uniqueSkillId(skillIdFrom(name), taken)}.md` : 'Shown in the app and in AGENTS.md. The file name follows from it.';
      ok.disabled = !name;
    };
    const go = () => { const name = input.value.trim(); if (!name) return; menus.close(); void this.create(name, from?.id); };
    input.addEventListener('input', update);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    ok.addEventListener('click', go);
    cancel.addEventListener('click', () => menus.close());
    update();
    pop.replaceChildren(el('div', { className: 'mh', textContent: from ? 'DUPLICATE SKILL' : 'NEW SKILL' }), el('div', { className: 'st-name' }, input), file,
      el('div', { className: 'st-name-actions' }, cancel, ok));
    menus.toggle(pop, anchor, 'left');
    input.focus();
    input.select();
  }

  private async create(title: string, from?: string): Promise<void> {
    if (!(await this.confirmLeave('New skill'))) return;
    let r: LibraryResult;
    try { r = await this.deps.library.create(title, from); } catch (e) { r = { ok: false, error: errText(e), library: this.lib ?? { skills: [], ignored: [], dir: '' } }; }
    this.lib = r.library;
    if (!r.ok || !r.id) { this.renderList(); this.deps.toast(`The skill was not created: ${r.error ?? 'unknown error'}`, 'error'); return; }
    this.deps.changed();
    await this.select(r.id);
    this.view.focus();
    this.deps.toast(`“${title}” created as ${r.id}.md${from ? ` from “${this.titleOf(from)}”` : ''}. Write the rules and save. In a model, switch it on under “Skills”.`);
  }

  /** Eigenen Skill löschen oder bearbeiteten zurücksetzen, nach Rückfrage. Die Datei kommt in die Sicherung. */
  private async remove(): Promise<void> {
    const d = this.doc;
    if (!d || d.source === 'builtin' || this.busy) return;
    const title = this.titleOf(d.id);
    const own = d.source === 'own';
    const lost = this.dirty ? ' Unsaved changes are lost.' : '';
    const i = await this.deps.choose(own
      ? { title: 'Delete skill', message: `Delete “${title}”?`, detail: `The file goes into the backup. Models that use the skill keep their copy.${lost}`, buttons: ['Delete', 'Cancel'] }
      : { title: 'Reset skill', message: `Reset “${title}” to the built-in version?`, detail: `Your version goes into the backup. Models that use the skill keep their copy.${lost}`, buttons: ['Reset', 'Cancel'] });
    if (i !== 0) return;
    let r: LibraryResult;
    try { r = await this.deps.library.remove(d.id); } catch (e) { r = { ok: false, error: errText(e), library: this.lib ?? { skills: [], ignored: [], dir: '' } }; }
    this.lib = r.library;
    if (!r.ok) { this.render(); this.deps.toast(`“${title}” was not ${own ? 'deleted' : 'reset'}: ${r.error ?? 'unknown error'}`, 'error'); return; }
    this.deps.changed();
    const kept = r.backup ? ` The file is in the backup: ${r.backup}` : '';
    // Die Rückfrage hat das Ungespeicherte schon abgedeckt: ohne zweite Frage weiter
    this.doc = null;
    if (own) { this.render(); this.deps.toast(`“${title}” deleted.${kept}`); return; }
    await this.select(d.id);
    this.deps.toast(`“${title}” is the built-in version again.${kept}`);
  }

  private async importFiles(): Promise<void> {
    if (this.busy) return;
    let r: LibraryResult;
    try { r = await this.deps.library.import(); } catch (e) { r = { ok: false, error: errText(e), library: this.lib ?? { skills: [], ignored: [], dir: '' } }; }
    this.lib = r.library;
    this.renderList();
    if (!r.ok) { this.deps.toast(`Import failed: ${r.error ?? 'unknown error'}`, 'error'); return; }
    if (r.canceled) return;
    const ids = r.imported ?? [];
    const notes = r.warnings?.length ? ` ${r.warnings.join(' ')}` : '';
    const kept = r.backup ? ` The replaced version is in the backup: ${r.backup}` : '';
    if (ids.length) this.deps.changed();
    this.deps.toast(ids.length
      ? `${ids.length === 1 ? `“${this.titleOf(ids[0])}”` : `${ids.length} skills`} imported. In a model, switch ${ids.length === 1 ? 'it' : 'them'} on under “Skills”.${notes}${kept}`
      : `Nothing imported.${notes}`, notes ? 'info' : 'ok');
    if (ids.length) await this.select(ids[0]);
  }

  private async setDefault(mode: SkillMode): Promise<void> {
    const d = this.doc;
    if (!d) return;
    let r: LibraryResult;
    try { r = await this.deps.library.setDefault(d.id, mode); } catch (e) { r = { ok: false, error: errText(e), library: this.lib ?? { skills: [], ignored: [], dir: '' } }; }
    this.lib = r.library;
    this.render();
    if (!r.ok) { this.deps.toast(r.error ?? 'The default for new models could not be changed.', 'error'); return; }
    this.deps.changed();
    this.deps.toast(`“${this.titleOf(d.id)}” is set to “${MODES.find((m) => m.mode === mode)!.label}” for new models. Existing models stay as they are.`);
  }

  private setMode(mode: ViewMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    this.renderChrome();
    this.renderView();
  }

  // ---- Darstellung ---------------------------------------------------------------------------------------------

  private render(): void {
    this.renderList();
    this.renderChrome();
    this.renderView();
    this.renderCheck();
  }

  private renderList(): void {
    const list = this.ui.list;
    if (this.error) { list.replaceChildren(el('div', { className: 'hint', textContent: `Skills not readable: ${this.error}` })); return; }
    const out: HTMLElement[] = [];
    let cat: string | null = null;
    for (const s of this.lib?.skills ?? []) {
      const c = s.category || 'Other';
      if (c !== cat) {
        const h = el('div', { className: 'sk-cat' }, icon(CATEGORY_ICON[c] ?? 'book', 14, 1.9), el('span', { textContent: c }));
        h.setAttribute('role', 'heading');
        h.setAttribute('aria-level', '3');
        out.push(h);
        cat = c;
      }
      const sel = s.id === this.doc?.id;
      const row = el('button', { className: `st-row ${s.source}${sel ? ' sel' : ''}${sel && this.dirty ? ' dirty' : ''}` },
        el('span', { className: 'st-rt' }, el('b', { textContent: s.title }), el('span', { className: 'st-dirty', textContent: '●', title: 'Unsaved changes' }),
          s.newerBuiltin ? el('span', { className: 'dot st-newer', title: 'The app includes a newer version of the built-in skill' }) : null,
          SOURCE_BADGE[s.source] ? el('span', { className: 'st-badge', textContent: SOURCE_BADGE[s.source] }) : null),
        el('span', { className: 'st-rs', textContent: s.summary }));
      row.dataset.id = s.id;
      row.setAttribute('role', 'listitem');
      if (sel) row.setAttribute('aria-current', 'true');
      row.addEventListener('click', () => void this.select(s.id));
      out.push(row);
    }
    if (this.lib && !this.lib.skills.length) out.push(el('div', { className: 'hint', textContent: 'No skills yet.' }));
    for (const f of this.lib?.ignored ?? []) {
      out.push(el('div', { className: 'st-ignored' }, icon('alert', 14, 2), el('span', {}, el('b', { textContent: f.name }), ` is not read: ${f.reason}`)));
    }
    list.replaceChildren(...out);
  }

  /** Kopf, Hinweise und Leiste des offenen Skills (ändern sich beim Tippen nur im Zustand „ungespeichert“). */
  private renderChrome(): void {
    const d = this.doc;
    const { empty, ed, hd, notes, bar } = this.els;
    empty.hidden = !!d;
    ed.hidden = !d;
    const sel = this.ui.list.querySelector('.st-row.sel');
    sel?.classList.toggle('dirty', this.dirty);
    if (!d) return;
    const s = this.entry(d.id);
    const dirty = this.dirty;

    const defId = 'st-default';
    const def = el('select', { id: defId, className: 'sk-select', disabled: this.busy || !s }, ...MODES.map((m) => el('option', { value: m.mode, textContent: m.label })));
    def.value = s?.defaultMode ?? 'demand';
    def.addEventListener('change', () => void this.setDefault(def.value as SkillMode));
    hd.replaceChildren(
      el('span', { className: 'mc-ico sk-ico' }, icon('book', 15)),
      el('div', { className: 'sk-title' }, el('b', { textContent: s?.title ?? d.id }), el('span', { className: 'c3', textContent: `${d.id}.md · ${SOURCE_TEXT[d.source]}${dirty ? ' · unsaved' : ''}` })),
      el('span', { className: 'grow' }),
      el('label', { className: 'st-def', htmlFor: defId, title: 'Level of the skill in models created from now on. Existing models stay as they are.' }, 'For new models', def));

    const n: HTMLElement[] = [];
    if (d.source === 'builtin') n.push(el('div', { className: 'st-note', textContent: 'Built-in skill. When you save, your version is kept with your own skills and takes its place, here and in new models. “Reset” brings the original back.' }));
    if (d.source === 'edited' && s?.newerBuiltin) n.push(el('div', { className: 'st-note warn', textContent: 'This app includes a newer version of the built-in skill. Your version still applies. Compare under “Built-in”, take the new one over with “Reset” (your version goes into the backup). Saving again hides this note.' }));
    else if (d.source === 'edited') n.push(el('div', { className: 'st-note', textContent: 'Your edited version applies in place of the built-in skill. “Built-in” shows the original, “Reset” brings it back.' }));
    notes.replaceChildren(...n);
    notes.hidden = !n.length;

    const seg = el('div', { className: 'cmode st-mode' });
    seg.setAttribute('role', 'radiogroup');
    seg.setAttribute('aria-label', 'Show');
    const modes: [ViewMode, string, string][] = [['edit', 'Edit', 'Edit the Markdown text'], ['preview', 'Preview', 'Show as a document'], ...(d.builtin != null && d.source === 'edited' ? [['builtin', 'Built-in', 'The built-in version, read only'] as [ViewMode, string, string]] : [])];
    for (const [m, label, title] of modes) {
      const b = el('button', { textContent: label, title });
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(this.mode === m));
      b.dataset.mode = m;
      b.addEventListener('click', () => this.setMode(m));
      seg.append(b);
    }
    const dup = el('button', { className: 'btn sm', title: 'Create a new skill of your own from this one' }, icon('copy', 14, 1.8), 'Duplicate');
    dup.addEventListener('click', () => { if (s) this.askName(dup, s); });
    const kids: (HTMLElement | null)[] = [seg, el('span', { className: 'grow' }), dup];
    if (d.source !== 'builtin') {
      const own = d.source === 'own';
      const rm = el('button', { className: 'btn sm', title: own ? 'Delete this skill (the file goes into the backup)' : 'Back to the built-in version (yours goes into the backup)' }, icon(own ? 'trash' : 'undo', 14, 1.9), own ? 'Delete' : 'Reset');
      rm.dataset.act = 'remove';
      rm.disabled = this.busy;
      rm.addEventListener('click', () => void this.remove());
      const show = el('button', { className: 'ibtn s', title: 'Show the file in the Explorer' }, icon('folder', 15, 1.8));
      show.setAttribute('aria-label', 'Show file');
      show.addEventListener('click', () => void this.deps.library.reveal(d.id));
      kids.push(rm, show);
    }
    const discard = el('button', { className: 'btn sm', textContent: 'Discard', title: 'Back to the saved text', disabled: this.busy });
    discard.dataset.act = 'discard';
    discard.hidden = !dirty;
    discard.addEventListener('click', () => this.setText(d.base));
    const save = el('button', { className: 'btn sm primary', title: 'Save (Ctrl+S)', disabled: !dirty || this.busy }, 'Save');
    save.dataset.act = 'save';
    save.addEventListener('click', () => void this.save());
    kids.push(el('span', { className: 'st-sep' }), discard, save);
    bar.replaceChildren(...kids.filter((x): x is HTMLElement => !!x));
  }

  private renderView(): void {
    const d = this.doc;
    const { cm, md, bi } = this.els;
    cm.hidden = !d || this.mode !== 'edit';
    md.hidden = !d || this.mode !== 'preview';
    bi.hidden = !d || this.mode !== 'builtin';
    if (!d) return;
    if (this.mode === 'preview') {
      md.replaceChildren(renderMarkdown(this.text(), `${d.id}.md`, true, {
        link: (href) => this.deps.link(href),
        image: async () => null,
        toggleTask: () => { /* nur lesen */ },
        edit: (line) => {
          this.setMode('edit');
          const at = this.view.state.doc.line(Math.max(1, Math.min(line, this.view.state.doc.lines))).from;
          this.view.dispatch({ selection: { anchor: at }, scrollIntoView: true });
          this.view.focus();
        },
      }));
    } else if (this.mode === 'builtin') {
      const text = d.builtin ?? '';
      if (!this.builtinView) this.builtinView = new EditorView({ parent: bi, state: this.editorState(text, true) });
      else if (this.builtinView.state.doc.toString() !== text) this.builtinView.setState(this.editorState(text, true));
    }
  }

  private renderCheck(): void {
    const box = this.els.check;
    const c = this.check;
    if (!this.doc || !c) { box.replaceChildren(); box.hidden = true; return; }
    box.hidden = false;
    const rows = [
      ...c.errors.map((t) => el('div', { className: 'st-err' }, icon('alert', 14, 2), el('span', { textContent: t }))),
      ...c.warnings.map((t) => el('div', { className: 'st-warn' }, icon('alert', 14, 2), el('span', { textContent: t }))),
    ];
    box.replaceChildren(...(rows.length ? rows : [el('div', { className: 'st-ok' }, icon('check', 14, 2.2), el('span', { textContent: 'No issues found.' }))]));
  }

  /** Für Tests. */
  state() {
    return {
      open: this.isOpen, section: this.section, busy: this.busy, selected: this.doc?.id ?? null, source: this.doc?.source ?? null, dirty: this.dirty, mode: this.mode,
      text: this.doc ? this.text() : null, check: this.check,
      skills: (this.lib?.skills ?? []).map((s) => ({ id: s.id, title: s.title, source: s.source, defaultMode: s.defaultMode, newerBuiltin: s.newerBuiltin, category: s.category })),
      ignored: this.lib?.ignored ?? [], dir: this.lib?.dir ?? '',
      list: this.ui.list.innerText, editor: this.els.ed.hidden ? null : `${this.els.hd.innerText}\n${this.els.notes.innerText}`,
    };
  }

  /** Für Tests: Text im Editor ersetzen, wie getippt. */
  type(text: string): void { this.setText(text); }
}
