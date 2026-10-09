import { DECIMALS, NAV_PRESETS, navLegend, type NavPreset, type Projection, type SettingsPatch, type SettingsResult, type SettingsState, type ViewerPrefs } from '../shared/settings';
import type { AboutInfo, ComponentInfo, SomaApi, StorageArea, StorageEntry, StorageStats } from '../shared/types';
import { icon } from './icons';
import type { SettingsPage } from './settings';
import { el } from './ui';

/**
 * Reiter der Einstellungen außer „Skills“ (E81): Viewer, Speicherplatz und Info. Werte des Viewers gelten sofort und stehen
 * in settings.json, das Schreiben und Anwenden übernimmt main.ts. Texte sind englisch wie die ganze Oberfläche (E73).
 */

type Toast = (text: string, kind?: 'ok' | 'info' | 'error') => void;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Zeile eines Formulars: links Titel und Erklärung, rechts das Bedienelement. */
function field(title: string, desc: string | null, control: HTMLElement, extra?: HTMLElement | null): HTMLElement {
  return el('div', { className: 'st-field' },
    el('div', { className: 'st-fl' }, el('b', { textContent: title }), desc ? el('span', { textContent: desc }) : null, extra ?? null),
    el('div', { className: 'st-fc' }, control));
}

function group(title: string, ...rows: HTMLElement[]): HTMLElement {
  return el('section', { className: 'st-group' }, el('div', { className: 'st-gh', textContent: title }), ...rows);
}

function head(title: string, intro: string): HTMLElement[] {
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

  private async change(patch: Partial<ViewerPrefs>): Promise<void> {
    let r: SettingsResult;
    try { r = await this.deps.set({ viewer: patch }); } catch (e) { r = { ok: false, error: errText(e), ...this.deps.current() }; }
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
    const sample = (12.3456).toLocaleString('en-US', { minimumFractionDigits: v.decimals, maximumFractionDigits: v.decimals });

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
        field('Transparent', 'The display menu in the viewer changes these for the open model, until the next one opens.',
          toggle('st-ghost', v.transparent, 'Transparent', (on) => void this.change({ transparent: on })))),
      group('Measurements',
        field('Decimal places', `In the measurement card and at the measuring line, for example ${sample} mm. Text sent to the agent always has three decimals.`, digits)),
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
  other: { title: 'Other', icon: 'file', desc: () => 'Caches of the display, the settings and the state of the app.' },
};

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

interface AboutDeps { api: SomaApi['about']; openUrl(url: string): void; openFolder(area: StorageArea): void; toast: Toast }

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
        el('div', {}, el('h2', { className: 'st-h2', textContent: `SOMA ${a?.version ?? ''}`.trim() }), el('p', { className: 'st-lead', textContent: 'Solid Object Modeling with Agents' }))),
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
      const area: StorageArea | null = p.label === 'App data' ? 'appdata' : p.label === 'Your skills' ? 'skills' : null;
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
