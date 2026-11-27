import { BUILD_TIME_LIMITS, DECIMALS, KNOWN_AGENTS, MAX_OPEN_TABS, NAV_PRESETS, OPEN_LIMITS, navLegend, type AgentId, type NavPreset, type OpenTab, type Projection, type SettingsPatch, type SettingsResult, type SettingsState, type ViewerPrefs } from '../shared/settings';
import type { AboutInfo, AgentInfo, ComponentInfo, SomaApi, StorageArea, StorageEntry, StorageStats } from '../shared/types';
import { inchDigits, MM_PER_INCH, type DisplayUnits } from '../shared/units';
import { icon } from './icons';
import type { SettingsPage } from './settings';
import { shortcutGroups } from './shortcuts';
import { el } from './ui';

/**
 * Reiter der Einstellungen außer „Skills“ (E81): Viewer, Speicherplatz und Info. Werte des Viewers gelten sofort und stehen
 * in settings.json, das Schreiben und Anwenden übernimmt main.ts. Texte sind englisch wie die ganze Oberfläche (E73).
 */

type Toast = (text: string, kind?: 'ok' | 'info' | 'error') => void;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Zeile eines Formulars: links Titel und Erklärung, rechts das Bedienelement. */
export function field(title: string, desc: string | null, control: HTMLElement, extra?: HTMLElement | null): HTMLElement {
  return el('div', { className: 'st-field' },
    el('div', { className: 'st-fl' }, el('b', { textContent: title }), desc ? el('span', { textContent: desc }) : null, extra ?? null),
    el('div', { className: 'st-fc' }, control));
}

export function group(title: string, ...rows: HTMLElement[]): HTMLElement {
  return el('section', { className: 'st-group' }, el('div', { className: 'st-gh', textContent: title }), ...rows);
}

export function head(title: string, intro: string): HTMLElement[] {
  return [el('h2', { className: 'st-h2', textContent: title }), el('p', { className: 'st-lead', textContent: intro })];
}

function toggle(id: string, on: boolean, label: string, change: (on: boolean) => void): HTMLInputElement {
  const c = el('input', { id, type: 'checkbox', className: 'switch', checked: on });
  c.setAttribute('aria-label', label);
  c.addEventListener('change', () => change(c.checked));
  return c;
}

/** Umschalter mit Feldern nebeneinander (wie Edit/Preview im Editor). */
function segmented<T extends string>(label: string, options: { value: T; label: string }[], cur: T, change: (v: T) => void): HTMLElement {
  const box = el('div', { className: 'cmode st-seg' });
  box.setAttribute('role', 'radiogroup');
  box.setAttribute('aria-label', label);
  for (const o of options) {
    const b = el('button', { textContent: o.label });
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(o.value === cur));
    b.dataset.value = o.value;
    b.addEventListener('click', () => { if (o.value !== cur) change(o.value); });
    box.append(b);
  }
  return box;
}

/** Größe für Menschen: „812 KB“, „1.4 GB“. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toLocaleString('en-US', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[i]}`;
}

// ---- General --------------------------------------------------------------------------------------------------------

interface GeneralDeps {
  current(): SettingsState;
  /** Writes and applies (main.ts). */
  set(patch: SettingsPatch): Promise<SettingsResult>;
  toast: Toast;
  /** The command line agents found on this computer, for "not installed" in the choice of a tab. */
  agents(): Promise<AgentInfo[]>;
  /** The start page shows the update label and the tutorial card after a change at once. */
  startChanged(): void;
}

/** Value of a tab in its select: `ai`, `terminal`, `agent:<id>` or `command`. */
const tabValue = (t: OpenTab) => (t.kind === 'agent' ? `agent:${t.agent}` : t.kind);
const sameTabs = (a: OpenTab[], b: OpenTab[]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Tab "General": what happens when a model opens (the tabs of the agent area, issue #18), the start page and building.
 * The tabs are edited as a draft: a command tab without a command is not saved yet, the saved tabs apply until then.
 */
export class GeneralPage implements SettingsPage {
  private draft: OpenTab[] | null = null;
  private agents: AgentInfo[] = [];

  constructor(private root: HTMLElement, private deps: GeneralDeps) {}

  show(): void {
    this.draft = null;
    this.render();
    void this.deps.agents().then((a) => { this.agents = a; if (!this.root.hidden) this.render(); }).catch(() => {});
  }

  private async patch(patch: SettingsPatch): Promise<boolean> {
    let r: SettingsResult;
    try { r = await this.deps.set(patch); } catch (e) { r = { ok: false, error: errText(e), ...this.deps.current() }; }
    if (!r.ok) this.deps.toast(`The setting was not changed: ${r.error ?? 'unknown error'}`, 'error');
    else if (r.backup) this.deps.toast(`Saved. The previous settings.json is in the backup: ${r.backup}`, 'info');
    return r.ok;
  }

  private get saved(): OpenTab[] { return this.deps.current().settings.open.tabs; }
  private get tabs(): OpenTab[] { return this.draft ?? this.saved; }

  /** Saves the draft when every tab is complete. The first tab is the one in front. */
  private async saveTabs(): Promise<void> {
    const d = this.draft;
    if (!d || d.some((t) => t.kind === 'command' && !t.command.trim())) { this.render(); return; }
    const tabs = d.map((t): OpenTab => (t.kind === 'command' ? { kind: 'command', command: t.command.trim(), title: t.title.trim() } : t));
    if (!sameTabs(tabs, this.saved) || this.deps.current().settings.open.front !== 0) {
      if (await this.patch({ open: { tabs, front: 0 } })) this.draft = null;
    } else this.draft = null;
    this.render();
  }

  private edit(change: (tabs: OpenTab[]) => void): void {
    const next = this.tabs.map((t) => ({ ...t }));
    change(next);
    this.draft = next;
    void this.saveTabs();
  }

  private tabRow(t: OpenTab, i: number, all: OpenTab[]): HTMLElement {
    const sel = el('select', { className: 'sk-select st-select', id: `st-tab-${i + 1}` });
    sel.setAttribute('aria-label', `Tab ${i + 1}`);
    const aiElsewhere = all.some((x, j) => j !== i && x.kind === 'ai');
    const opt = (value: string, label: string, disabled = false) => el('option', { value, textContent: label, disabled });
    sel.append(
      opt('ai', aiElsewhere ? 'SOMA AI (already in another tab)' : 'SOMA AI', aiElsewhere),
      opt('terminal', 'Empty terminal'),
      ...KNOWN_AGENTS.map((a) => {
        const found = this.agents.find((x) => x.id === a.id)?.found;
        return opt(`agent:${a.id}`, found === false ? `${a.label} (not installed)` : a.label);
      }),
      opt('command', 'Your own command …'),
    );
    sel.value = tabValue(t);
    sel.addEventListener('change', () => this.edit((tabs) => {
      const v = sel.value;
      tabs[i] = v === 'ai' || v === 'terminal' ? { kind: v } : v === 'command' ? { kind: 'command', command: '', title: '' } : { kind: 'agent', agent: v.slice(6) as AgentId };
    }));
    const up = el('button', { className: 'ibtn s', title: 'Move up', disabled: i === 0 }, icon('up', 14, 2));
    up.setAttribute('aria-label', `Move tab ${i + 1} up`);
    up.addEventListener('click', () => this.edit((tabs) => { [tabs[i - 1], tabs[i]] = [tabs[i], tabs[i - 1]]; }));
    const rm = el('button', { className: 'ibtn s', title: 'Remove', disabled: all.length <= 1 }, icon('x', 14, 2));
    rm.setAttribute('aria-label', `Remove tab ${i + 1}`);
    rm.addEventListener('click', () => this.edit((tabs) => { tabs.splice(i, 1); }));
    const row = el('div', { className: 'st-tab' },
      el('div', { className: 'st-tab-hd' }, el('span', { className: 'st-tab-n', textContent: i === 0 ? '1 · in front' : String(i + 1) }), sel, up, rm));
    if (t.kind === 'command') {
      const cmd = el('input', { className: 'st-input grow', value: t.command, maxLength: OPEN_LIMITS.command, placeholder: 'Command, for example python my_tool.py', spellcheck: false });
      cmd.setAttribute('aria-label', `Command of tab ${i + 1}`);
      const name = el('input', { className: 'st-input', value: t.title, maxLength: OPEN_LIMITS.title, placeholder: 'Tab name' });
      name.setAttribute('aria-label', `Name of tab ${i + 1}`);
      // Typing changes only the draft, leaving the field (or Enter) saves it
      cmd.addEventListener('input', () => { this.draft = this.tabs.map((x, j) => (j === i ? { ...x, command: cmd.value } as OpenTab : x)); });
      name.addEventListener('input', () => { this.draft = this.tabs.map((x, j) => (j === i ? { ...x, title: name.value } as OpenTab : x)); });
      for (const f of [cmd, name]) {
        f.addEventListener('change', () => void this.saveTabs());
        f.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); f.blur(); } });
      }
      row.append(el('div', { className: 'st-tab-cmd' }, cmd, name));
      if (!t.command.trim()) row.append(el('div', { className: 'st-tab-note', textContent: 'Enter the command. Until then the tabs saved before apply.' }));
    }
    return row;
  }

  state() { return { text: this.root.innerText, draft: this.draft }; }

  render(): void {
    const { settings, problem } = this.deps.current();
    const tabs = this.tabs;
    const add = el('button', { className: 'btn sm', id: 'st-tab-add', disabled: tabs.length >= MAX_OPEN_TABS }, icon('plus', 14, 2), 'Add tab');
    add.addEventListener('click', () => this.edit((t) => { t.push({ kind: 'terminal' }); }));
    const hasCommand = tabs.some((t) => t.kind === 'command');

    // A value set by hand in settings.json that is not among the choices still shows as selected
    const cur = settings.build.timeLimit;
    const limits = BUILD_TIME_LIMITS.includes(cur) ? BUILD_TIME_LIMITS : [...BUILD_TIME_LIMITS.filter((m) => m !== 0), cur].sort((a, b) => a - b).concat(cur ? [0] : []);
    const limit = el('select', { id: 'st-build-limit', className: 'sk-select st-select narrow' },
      ...limits.map((m) => el('option', { value: String(m), textContent: m === 0 ? 'No limit' : m >= 60 && m % 60 === 0 ? `${m / 60} h` : `${m} min` })));
    limit.value = String(cur);
    limit.addEventListener('change', () => void this.patch({ build: { timeLimit: Number(limit.value) } }).then(() => this.render()));
    const start = (key: 'updateCheck' | 'tutorialCard', on: boolean) => void this.patch({ start: { [key]: on } }).then(() => { this.deps.startChanged(); this.render(); });

    this.root.replaceChildren(el('div', { className: 'st-pg' },
      ...head('General', 'What opens with a model, the start page and building. Changes apply right away.'),
      problem ? el('div', { className: 'st-problem' }, icon('alert', 14, 2), el('span', { textContent: problem })) : null,
      group('When a model opens',
        el('div', { className: 'st-field col' },
          el('div', { className: 'st-fl' }, el('b', { textContent: 'Tabs in the agent area' }),
            el('span', { textContent: `Up to ${MAX_OPEN_TABS} tabs open with every model, the first one in front. With your own command you can start other agent harnesses or command line tools automatically. The + above the agent area opens more at any time.` })),
          el('div', { className: 'st-tabs', id: 'st-open-tabs' }, ...tabs.map((t, i) => this.tabRow(t, i, tabs)), el('div', { className: 'st-tab-add' }, add)),
          hasCommand ? el('div', { className: 'st-tab-warn' }, icon('alert', 14, 2), el('span', {
            textContent: 'Each time you open a model, SOMA types your command into a terminal in the model’s folder. This includes models from other people. The command uses the model’s Python, and the terminal stays open after it finishes. Your command is saved only on this computer, never in the model file.',
          })) : null)),
      group('Start page',
        field('Check for new versions', 'The start page asks GitHub once per session whether a newer release exists. SOMA downloads and installs nothing by itself.',
          toggle('st-update', settings.start.updateCheck, 'Check for new versions', (on) => start('updateCheck', on))),
        field('Tutorial card', 'The card “New to SOMA?” with the guided tour. Help (F1) can always start the tour.',
          toggle('st-tour', settings.start.tutorialCard, 'Tutorial card', (on) => start('tutorialCard', on)))),
      group('Building',
        field('Build time limit', 'A build that takes longer is stopped, so a stuck model does not keep the computer busy. Raise it for large models. Applies from the next build, you can always stop a build yourself.', limit)),
    ));
  }
}


// ---- Viewer ---------------------------------------------------------------------------------------------------------

interface ViewerDeps {
  current(): SettingsState;
  /** Schreibt und wendet an (main.ts). */
  set(patch: SettingsPatch): Promise<SettingsResult>;
  toast: Toast;
}

export class ViewerPage implements SettingsPage {
  constructor(private root: HTMLElement, private deps: ViewerDeps) {}

  show(): void { this.render(); }

  private async change(patch: Partial<ViewerPrefs>): Promise<void> { return this.patch({ viewer: patch }); }

  private async patch(patch: SettingsPatch): Promise<void> {
    let r: SettingsResult;
    try { r = await this.deps.set(patch); } catch (e) { r = { ok: false, error: errText(e), ...this.deps.current() }; }
    if (!r.ok) this.deps.toast(`The setting was not changed: ${r.error ?? 'unknown error'}`, 'error');
    else if (r.backup) this.deps.toast(`Saved. The previous settings.json is in the backup: ${r.backup}`, 'info');
    this.render();
  }

  render(): void {
    const { settings, problem } = this.deps.current();
    const v = settings.viewer;
    const nav = el('select', { id: 'st-nav-preset', className: 'sk-select st-select' }, ...NAV_PRESETS.map((p) => el('option', { value: p.id, textContent: p.label })));
    nav.value = v.navigation;
    nav.addEventListener('change', () => void this.change({ navigation: nav.value as NavPreset }));
    const legend = el('div', { className: 'st-legend' }, ...navLegend(v.navigation).map((l) => el('div', { className: 'st-lg-row' },
      el('span', { className: 'st-lg-k', textContent: l.label }), el('span', { className: 'st-lg-v', textContent: l.how }))));
    const digits = el('select', { id: 'st-decimals', className: 'sk-select st-select narrow' },
      ...Array.from({ length: DECIMALS.max - DECIMALS.min + 1 }, (_, i) => el('option', { value: String(DECIMALS.min + i), textContent: String(DECIMALS.min + i) })));
    digits.value = String(v.decimals);
    digits.addEventListener('change', () => void this.change({ decimals: Number(digits.value) }));
    // The sample is the same length in the units chosen: 12.3456 mm, or the inch it rounds to with two more digits
    const inch = v.units === 'in';
    const d = inch ? inchDigits(v.decimals) : v.decimals;
    const sample = `${(inch ? 12.3456 / MM_PER_INCH : 12.3456).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })} ${v.units}`;

    this.root.replaceChildren(el('div', { className: 'st-pg' },
      ...head('Viewer', 'How the 3D view responds to the mouse and what it shows when a model opens. Changes apply right away.'),
      problem ? el('div', { className: 'st-problem' }, icon('alert', 14, 2), el('span', { textContent: problem })) : null,
      group('Navigation',
        field('Mouse buttons', 'Rotate, pan and zoom like in the program you know. A left click always selects, a double click sets the pivot.', nav, legend),
        field('Invert zoom', 'Turning the wheel toward you zooms in instead of out. Also applies to zooming by dragging.',
          toggle('st-invert', v.invertZoom, 'Invert zoom', (on) => void this.change({ invertZoom: on })))),
      group('View',
        field('Projection', 'Orthographic keeps parallel edges parallel and sizes independent of the distance, as in a technical drawing.',
          segmented<Projection>('Projection', [{ value: 'perspective', label: 'Perspective' }, { value: 'orthographic', label: 'Orthographic' }], v.projection,
            (p) => void this.change({ projection: p })))),
      group('When a model opens',
        field('Edges', null, toggle('st-edges', v.edges, 'Edges', (on) => void this.change({ edges: on }))),
        field('Wireframe', null, toggle('st-wire', v.wireframe, 'Wireframe', (on) => void this.change({ wireframe: on }))),
        field('Transparent', null, toggle('st-ghost', v.transparent, 'Transparent', (on) => void this.change({ transparent: on }))),
        field('Origin and axes', 'The display menu in the viewer changes these for the open model, until the next one opens.',
          toggle('st-axes', v.axes, 'Origin and axes', (on) => void this.change({ axes: on })))),
      group('Measurements',
        field('Units', 'Lengths in the measurement card, the selection and the section. The model stays in millimetres, nothing is rebuilt. Text sent to the agent gives millimetres, with inches added.',
          segmented<DisplayUnits>('Units', [{ value: 'mm', label: 'Millimetres' }, { value: 'in', label: 'Inches' }], v.units,
            (u) => void this.change({ units: u }))),
        field('Decimal places', `In the measurement card and at the measuring line, for example ${sample}.${inch ? ' Inches show two more.' : ''} Text sent to the agent always has three decimals.`, digits)),
    ));
  }

  state() { return { text: this.root.innerText }; }
}

// ---- Speicherplatz --------------------------------------------------------------------------------------------------

interface StorageDeps { api: SomaApi['storage']; toast: Toast }

const AREA: Record<Exclude<StorageEntry['id'], 'appdata'>, { title: string; icon: string; desc: (e: StorageEntry) => string }> = {
  workspaces: { title: 'Models on this computer', icon: 'cube', desc: (e) => `Working folders of ${e.models ?? 0} model${e.models === 1 ? '' : 's'} with their history and Python packages. Saved model files (.soma) are elsewhere and not counted.` },
  backups: { title: 'Backups', icon: 'history', desc: () => 'Replaced working folders and earlier versions of files and skills. SOMA never deletes them: remove what you no longer need in the folder.' },
  previews: { title: 'Preview cache', icon: 'layers', desc: () => 'Older versions from the history, prepared for viewing. Created again when needed.' },
  thumbnails: { title: 'Start page pictures', icon: 'image', desc: () => 'Pictures of your models on the start page.' },
  skills: { title: 'Your skills', icon: 'book', desc: () => 'Skills you created or edited under “Skills”.' },
  somaai: { title: 'SOMA AI', icon: 'sparkle', desc: () => 'Sign-ins, settings and conversations of SOMA AI, the agent built into SOMA.' },
  voice: { title: 'Voice input', icon: 'mic', desc: () => 'The speech model for voice input. Remove it in Settings > SOMA AI.' },
  logs: { title: 'Logs', icon: 'file', desc: () => 'What the app did and what went wrong, for bug reports. A few MB at most, older entries are dropped.' },
  other: { title: 'Other', icon: 'file', desc: () => 'Caches of the display, the settings and the state of the app.' },
};

/** Reiter „Shortcuts“: alle Tasten und Mausgesten zum Nachschlagen, die Navigation nach der gewählten Mausbelegung. Nur lesen. */
export class ShortcutsPage implements SettingsPage {
  constructor(private root: HTMLElement, private deps: { current(): SettingsState }) {}

  show(): void {
    const nav = this.deps.current().settings.viewer.navigation;
    const groups = shortcutGroups(nav).map((g) => group(g.title, ...g.items.map((it) => el('div', { className: 'st-key' },
      el('span', { className: 'st-kk' }, ...it.keys.flatMap((k, i) => [i ? el('span', { className: 'plus', textContent: '+' }) : null, el('kbd', { textContent: k })])),
      el('span', { className: 'st-kw', textContent: it.what })))));
    this.root.replaceChildren(...head('Shortcuts', `Keys and mouse gestures of SOMA. Not active while you type in the code, the terminal or a field. Navigation as set under Viewer (${NAV_PRESETS.find((p) => p.id === nav)?.label ?? nav}).`), ...groups);
  }
}

export class StoragePage implements SettingsPage {
  private stats: StorageStats | null = null;
  private loading = false;
  private error = '';
  private busy = false;
  private seq = 0;

  constructor(private root: HTMLElement, private deps: StorageDeps) {}

  show(): void { void this.refresh(); }

  async refresh(): Promise<void> {
    const seq = ++this.seq;
    this.loading = true;
    this.render();
    try { const s = await this.deps.api.stats(); if (seq !== this.seq) return; this.stats = s; this.error = ''; } catch (e) { if (seq !== this.seq) return; this.error = errText(e); }
    this.loading = false;
    this.render();
  }

  private async open(area: StorageArea): Promise<void> {
    const r = await this.deps.api.open(area).catch((e) => ({ ok: false, error: errText(e) }));
    if (!r.ok) this.deps.toast(`The folder could not be opened: ${r.error ?? 'unknown error'}`, 'error');
  }

  private async clear(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.render();
    const r = await this.deps.api.clearPreviews().catch((e) => ({ ok: false, error: errText(e) } as Awaited<ReturnType<SomaApi['storage']['clearPreviews']>>));
    this.busy = false;
    if (r.stats) this.stats = r.stats;
    this.render();
    if (r.canceled) return;
    const kept = r.kept ? ' The previews of the open model stay.' : '';
    if (!r.ok) this.deps.toast(`${r.freed ? `${fmtBytes(r.freed)} freed. ` : ''}${r.error ?? 'The preview cache could not be cleared.'}`, 'error');
    else this.deps.toast(`Preview cache cleared, ${fmtBytes(r.freed ?? 0)} freed.${kept}`);
  }

  private row(e: StorageEntry): HTMLElement {
    const a = AREA[e.id === 'appdata' ? 'other' : e.id];
    const actions: HTMLElement[] = [];
    if (e.id === 'previews') {
      const clear = el('button', { className: 'btn sm', disabled: this.busy || this.loading || !e.bytes, title: 'Remove the prepared previews. They are created again when needed.' }, icon('trash', 14, 1.9), 'Clear …');
      clear.dataset.act = 'clear';
      clear.addEventListener('click', () => void this.clear());
      actions.push(clear);
    }
    if (e.id !== 'other') {
      const open = el('button', { className: 'ibtn s', title: 'Open the folder' }, icon('folder', 15, 1.8));
      open.setAttribute('aria-label', `Open the folder: ${a.title}`);
      open.addEventListener('click', () => void this.open(e.id as StorageArea));
      actions.push(open);
    }
    const r = el('div', { className: 'st-store' },
      el('span', { className: 'st-store-ico' }, icon(a.icon, 16, 1.8)),
      el('div', { className: 'st-fl' }, el('b', { textContent: a.title }), el('span', { textContent: a.desc(e) })),
      el('span', { className: 'st-size', textContent: fmtBytes(e.bytes) }),
      el('div', { className: 'st-store-act' }, ...actions));
    r.dataset.area = e.id;
    return r;
  }

  render(): void {
    const s = this.stats;
    const refresh = el('button', { className: 'btn sm', disabled: this.loading }, icon('refresh', 14, 1.9), 'Refresh');
    refresh.addEventListener('click', () => void this.refresh());
    const openAll = el('button', { className: 'btn sm' }, icon('folder', 14, 1.8), 'Open folder');
    openAll.addEventListener('click', () => void this.open('appdata'));
    const summary = el('div', { className: 'st-total' },
      el('div', { className: 'st-fl' }, el('b', { textContent: s ? `${fmtBytes(s.total)} in total` : 'Calculating …' }), el('span', { className: 'st-path', textContent: s?.dir ?? '' })),
      openAll, refresh);
    this.root.replaceChildren(el('div', { className: 'st-pg' },
      ...head('Storage', 'Everything SOMA keeps on this computer besides your saved model files.'),
      this.error ? el('div', { className: 'st-problem' }, icon('alert', 14, 2), el('span', { textContent: `The sizes could not be determined: ${this.error}` })) : null,
      summary,
      s ? el('div', { className: `st-stores${this.loading ? ' loading' : ''}` }, ...s.areas.map((e) => this.row(e))) : el('div', { className: 'st-wait', textContent: 'Adding up the folders …' }),
    ));
  }

  state() { return { loading: this.loading, busy: this.busy, stats: this.stats, error: this.error, text: this.root.innerText }; }
}

// ---- Info -----------------------------------------------------------------------------------------------------------

interface AboutDeps {
  api: SomaApi['about']; openUrl(url: string): void; openFolder(area: StorageArea): void; toast: Toast;
}

const REPO = 'https://github.com/Kai-Jungsthoefel/SOMA';

export class AboutPage implements SettingsPage {
  private info: AboutInfo | null = null;
  private error = '';
  private loading = false;

  constructor(private root: HTMLElement, private deps: AboutDeps) {}

  show(): void { void this.refresh(); }

  async refresh(): Promise<void> {
    this.loading = true;
    this.render();
    try { this.info = await this.deps.api.info(); this.error = ''; } catch (e) { this.error = errText(e); }
    this.loading = false;
    this.render();
  }

  private async copy(): Promise<void> {
    const r = await this.deps.api.copy().catch((e) => ({ ok: false, error: errText(e) }));
    this.deps.toast(r.ok ? 'System info copied. Paste it into a bug report or a message.' : `Could not copy: ${r.error ?? 'unknown error'}`, r.ok ? 'ok' : 'error');
  }

  private link(label: string, url: string, title: string): HTMLElement {
    const b = el('button', { className: 'btn sm', title }, el('span', { textContent: label }), icon('openext', 13, 1.9));
    b.addEventListener('click', () => this.deps.openUrl(url));
    return b;
  }

  private table(rows: [string, string | null][]): HTMLElement {
    return el('div', { className: 'st-kv' }, ...rows.flatMap(([k, v]) => [el('span', { className: 'k', textContent: k }), el('span', { className: 'v', textContent: v ?? '–' })]));
  }

  private components(title: string, list: ComponentInfo[]): HTMLElement {
    return el('div', { className: 'st-comps' }, el('div', { className: 'st-comps-h', textContent: title }),
      el('div', { className: 'st-comp-grid' }, ...list.flatMap((c) => [
        el('span', { className: 'n', textContent: c.name }), el('span', { className: 'ver', textContent: c.version }), el('span', { className: 'lic', textContent: c.license || 'not stated' }),
      ])));
  }

  render(): void {
    const a = this.info;
    const pkg = (n: string) => a?.python.packages.find((p) => p.name.toLowerCase() === n)?.version ?? null;
    const copy = el('button', { className: 'btn sm acc', disabled: !a }, icon('copy', 14, 1.8), 'Copy system info');
    copy.dataset.act = 'copy';
    copy.addEventListener('click', () => void this.copy());
    const kids: (HTMLElement | null)[] = [
      el('div', { className: 'st-about-hd' }, el('span', { className: 'st-logo' }, icon('logo', 34, 1.5)),
        el('div', {}, el('h2', { className: 'st-h2', textContent: `SOMA ${a?.version ?? ''}`.trim() }), el('p', { className: 'st-lead', textContent: 'Solid Object Modeling with Agents' }), el('p', { className: 'st-lead', textContent: 'Author: Kai Jungsthöfel' }))),
      el('div', { className: 'st-actions' }, copy, this.link('Project page', REPO, 'Source code, issues and releases on GitHub'), this.link('Changelog', `${REPO}/blob/main/CHANGELOG.md`, 'What changed in each version')),
      el('p', { className: 'st-license' },
        'SOMA is free software under the GNU GPL, version 3 or later. The SOMA Model Exception makes sure that what you design belongs to you: your models, their files and everything SOMA creates from them.'),
      el('div', { className: 'st-actions' }, this.link('License', `${REPO}/blob/main/LICENSE`, 'GNU General Public License, version 3'), this.link('Model Exception', `${REPO}/blob/main/MODEL-EXCEPTION.md`, 'Additional permission for your models')),
    ];
    if (this.error) kids.push(el('div', { className: 'st-problem' }, icon('alert', 14, 2), el('span', { textContent: `The information could not be collected: ${this.error}` })));
    if (!a) {
      kids.push(el('div', { className: 'st-wait', textContent: this.loading ? 'Collecting versions …' : '' }));
      this.root.replaceChildren(el('div', { className: 'st-pg' }, ...kids));
      return;
    }
    kids.push(group('Versions', this.table([
      ['SOMA app', a.version], ['soma (Python library)', pkg('soma')], ['Python', a.python.version ?? null], ['CadQuery', pkg('cadquery')], ['OCP (OpenCascade)', pkg('cadquery-ocp')],
      ['Electron', a.electron], ['Chromium', a.chrome], ['Node.js', a.node], ['Git', a.git], ['System', a.os],
    ])));
    if (a.python.error) kids.push(el('div', { className: 'st-problem' }, icon('alert', 14, 2), el('span', { textContent: `Python did not answer: ${a.python.error}` })));
    kids.push(group('Agents', el('div', { className: 'st-agents' }, ...(a.agents.length ? a.agents.map((x) => el('div', { className: `st-agent ${x.found ? 'ok' : 'no'}` },
      el('span', { className: 'st-agent-ico' }, icon(x.found ? 'check' : 'x', 14, 2.2)), el('b', { textContent: x.label }),
      el('span', { className: 'c3', textContent: x.found ? `found (${x.command})` : `not installed (${x.command})` })))
      : [el('span', { className: 'c3', textContent: 'No agents were checked.' })]))));
    kids.push(group('Folders', el('div', { className: 'st-kv paths' }, ...a.paths.flatMap((p) => {
      const area: StorageArea | null = p.label === 'App data' ? 'appdata' : p.label === 'Your skills' ? 'skills' : p.label === 'Logs' ? 'logs' : null;
      const open = area ? el('button', { className: 'ibtn s', title: 'Open the folder' }, icon('folder', 14, 1.8)) : null;
      open?.setAttribute('aria-label', `Open the folder: ${p.label}`);
      open?.addEventListener('click', () => this.deps.openFolder(area!));
      return [el('span', { className: 'k', textContent: p.label }), el('span', { className: 'v path' }, el('span', { textContent: p.path }), open)];
    }))));
    kids.push(group('Components',
      el('p', { className: 'st-lead', textContent: 'Open source parts SOMA is built on, with the license their authors state.' }),
      this.components('App', a.components),
      this.components('Python', a.python.packages.filter((p) => p.name.toLowerCase() !== 'soma'))));
    this.root.replaceChildren(el('div', { className: 'st-pg' }, ...kids));
  }

  state() { return { loading: this.loading, info: this.info, error: this.error, text: this.root.innerText }; }
}
