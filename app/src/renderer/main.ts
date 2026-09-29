import type { AgentInfo, BuildStatus, FileNode, ModelMap, PreviewResult, ProjectInfo, SaveState } from '../shared/types';
import { TerminalTabs } from './terminals';
import { VersionsBar } from './versions';
import { PickResult, Viewer, ViewName } from './viewer';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const api = window.cadide;

const viewer = new Viewer($('viewer'));
const terminals = new TerminalTabs($('term-tabs'), $('term-panes'), $('btn-term-add'));

let project: ProjectInfo | null = null;
let saveState: SaveState | null = null;
let map: ModelMap | null = null;
let loadSeq = 0;
const textCache = new Map<string, string>();

/** Erzeugt ein Element. Text geht immer über textContent, nie über innerHTML (Namen kommen aus dem Projekt). */
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...kids: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string, kind: 'info' | 'error' = 'info'): void {
  const t = $('toast');
  t.textContent = text;
  t.className = kind === 'error' ? 'error' : '';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, kind === 'error' ? 12000 : 6000);
}

const versions = new VersionsBar({
  slider: $<HTMLInputElement>('vslider'), dots: $('vdots'), info: $('vinfo'), problem: $('vproblem'),
  restore: $<HTMLButtonElement>('btn-restore'), live: $<HTMLButtonElement>('btn-live'), banner: $('preview-banner'),
}, {
  async show(res: PreviewResult | null) {
    if (!res) { await loadModel(); return; }
    try {
      map = res.map;
      textCache.clear();
      await viewer.load(res.glb);
      buildModelTree();
      $('info').textContent = 'Vorschau eines alten Standes: Ein Klick zeigt Bauteil und Fläche, aber keinen Code.';
      $('code').replaceChildren();
    } catch (e) { toast(`Vorschau nicht darstellbar: ${e instanceof Error ? e.message : String(e)}`, 'error'); }
  },
  toast,
});

// ---- Projekt ----------------------------------------------------------------------------------------------------

async function onProject(p: ProjectInfo): Promise<void> {
  project = p;
  loadSeq++; // laufende Ladevorgänge des vorherigen Projekts verwerfen
  map = null;
  textCache.clear();
  viewer.clear();
  versions.reset();
  terminals.closeAll();
  $('tab-model').replaceChildren(el('div', { className: 'hint' }, 'Modell wird gebaut …'));
  $('info').textContent = 'Klick auf ein Bauteil zeigt die zugehörige Codestelle.';
  $('code').replaceChildren();
  $<HTMLInputElement>('chk-auto').checked = p.autoBuild;
  document.title = `CAD-IDE – ${p.name}`;
  showProblems(p.problems);
  await refreshProjects();
  void refreshFiles();
  void versions.refresh();
  void refreshSaveState();
  void terminals.add({ title: 'Terminal' });
  void refreshAgents();
  setStatusFromBuild(await api.build.status());
  if ((await api.build.status()).state === 'ok') void loadModel();
}

function showProblems(problems: string[]): void {
  const el_ = $('problems');
  el_.hidden = problems.length === 0;
  el_.textContent = `⚠ ${problems.length} Hinweis${problems.length === 1 ? '' : 'e'}`;
  el_.title = problems.join('\n');
}

async function refreshProjects(): Promise<void> {
  const sel = $<HTMLSelectElement>('sel-projects');
  const list = await api.project.list();
  sel.replaceChildren(...list.map((e) => el('option', { value: e.id, textContent: e.name + ' · ' + e.id.slice(0, 8), selected: e.id === project?.id })));
}

// ---- Build und Modell -------------------------------------------------------------------------------------------

function setStatusFromBuild(s: BuildStatus): void {
  const status = $('status'), detail = $('status-detail');
  status.dataset.state = s.state;
  $<HTMLButtonElement>('btn-cancel').disabled = s.state !== 'building';
  const msg = $('viewer-msg');
  msg.className = '';
  msg.textContent = '';
  if (s.state === 'building') {
    status.textContent = s.queued ? 'Baue … (weiterer Build vorgemerkt)' : 'Baue …';
    detail.textContent = s.reason ?? '';
  } else if (s.state === 'ok') {
    const t = Object.values(s.result?.timings ?? {}).reduce((a, b) => a + b, 0);
    status.textContent = `Build ok · ${s.result?.parts?.length ?? 0} Bauteile`;
    detail.textContent = `${t.toFixed(2)} s`;
  } else if (s.state === 'error') {
    const e = s.result?.error;
    const where = e?.file ? ` (${e.file}${e.line ? ':' + e.line : ''})` : '';
    status.textContent = 'Build-Fehler';
    detail.textContent = (e?.message ?? '') + where;
    // Der zuletzt gute Stand bleibt sichtbar, der Fehler steht darüber. Der Nutzer kann den Agenten bitten, ihn zu beheben.
    msg.className = 'error';
    msg.textContent = `Build-Fehler${where}\n${e?.message ?? ''}` + (viewer.partList().length ? '\n(Angezeigt wird der letzte erfolgreiche Stand.)' : '');
  } else {
    status.textContent = 'Bereit';
    detail.textContent = '';
  }
}

async function loadModel(): Promise<void> {
  if (versions.previewing) return; // während einer Vorschau bleibt der alte Stand stehen
  const seq = ++loadSeq;
  try {
    const [mapText, glb] = await Promise.all([api.fs.readText('.cadide/model.map.json'), api.fs.readBinary('.cadide/model.glb')]);
    if (seq !== loadSeq) return; // neuerer Build ist schon unterwegs
    map = JSON.parse(mapText) as ModelMap;
    textCache.clear();
    await viewer.load(glb);
    buildModelTree();
  } catch (e) {
    $('viewer-msg').className = 'error';
    $('viewer-msg').textContent = `Das Modell konnte nicht geladen werden: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function buildModelTree(): void {
  const pane = $('tab-model');
  const parts = viewer.partList();
  if (!parts.length) { pane.replaceChildren(el('div', { className: 'hint' }, 'Noch keine Bauteile.')); return; }
  pane.replaceChildren(...parts.map((p) => {
    const cb = el('input', { type: 'checkbox', checked: viewer.isVisible(p.id), title: 'Ein-/Ausblenden' });
    cb.addEventListener('change', () => viewer.setVisible(p.id, cb.checked));
    const sw = el('span', { className: 'swatch' });
    sw.style.background = p.color;
    const name = el('span', { className: 'name', textContent: p.name + (p.role === 'reference' ? ' (Referenz)' : ''), title: 'Anzeigen und Codestelle zeigen' });
    const row = el('div', { className: 'part' + (p.role === 'reference' ? ' ref' : '') + (viewer.selection === p.id ? ' sel' : '') }, cb, sw, name);
    row.dataset.id = p.id;
    name.addEventListener('click', () => { viewer.select(p.id); viewer.focusPart(p.id); markSelected(p.id); void showPart(p.id, null); });
    return row;
  }));
}

function markSelected(id: string | null): void {
  document.querySelectorAll('#tab-model .part').forEach((r) => r.classList.toggle('sel', (r as HTMLElement).dataset.id === id));
}

// ---- Auswahl und Code -------------------------------------------------------------------------------------------

async function showPart(partId: string, pick: PickResult | null): Promise<void> {
  const entry = map?.parts.find((x) => x.id === partId);
  const info = $('info');
  const lines: string[] = [];
  const name = entry?.name ?? partId;
  lines.push(name + (entry?.role === 'reference' ? ' (Referenz)' : ''));
  if (pick && pick.faceId != null) lines.push(`Fläche f${pick.faceId} · ${pick.surface}${pick.area != null ? ' · ' + pick.area + ' mm²' : ''}`);
  if (entry?.file) lines.push(`Code: ${entry.file}:${entry.line}${entry.end_line && entry.end_line !== entry.line ? '–' + entry.end_line : ''}`);
  info.replaceChildren(el('b', {}, lines[0]), ...lines.slice(1).flatMap((l) => [el('br'), l]));
  if (entry?.file && entry.line) await showCode(entry.file, entry.line, entry.end_line ?? entry.line);
  else $('code').replaceChildren();
}

async function showCode(file: string, from: number, to: number): Promise<void> {
  let text = textCache.get(file);
  if (text === undefined) {
    try { text = await api.fs.readText(file); textCache.set(file, text); } catch { $('code').replaceChildren(el('span', { className: 'ln' }, `${file} nicht lesbar`)); return; }
  }
  const src = text.split(/\r?\n/);
  const a = Math.max(1, from - 6), b = Math.min(src.length, to + 6);
  const rows: HTMLElement[] = [];
  for (let i = a; i <= b; i++) rows.push(el('span', { className: 'ln' + (i >= from && i <= to ? ' hl' : ''), textContent: String(i).padStart(3) + '  ' + src[i - 1] }));
  $('code').replaceChildren(...rows);
}

viewer.onPick = (r) => {
  if (!r) { markSelected(null); $('info').textContent = 'Nichts getroffen.'; $('code').replaceChildren(); return; }
  markSelected(r.partId);
  void showPart(r.partId, r);
};

// ---- Dateien ----------------------------------------------------------------------------------------------------

async function refreshFiles(): Promise<void> {
  const nodes = await api.fs.list();
  const render = (list: FileNode[]): HTMLElement => el('ul', {}, ...list.map((n) => {
    const li = el('li', {}, el('span', { className: n.dir ? 'dir' : '', textContent: (n.dir ? '▸ ' : '') + n.name, title: n.path }));
    if (n.dir && n.children) li.appendChild(render(n.children));
    else if (!n.dir) li.querySelector('span')!.addEventListener('click', () => void previewFile(n.path));
    return li;
  }));
  $('tab-files').replaceChildren(el('div', { className: 'ftree' }, render(nodes)));
}

const TEXT_EXT = /\.(py|md|txt|json|toml|cfg|ini|yml|yaml|gitignore|csv)$|^[^.]*$/i;

async function previewFile(rel: string): Promise<void> {
  $('info').textContent = rel;
  if (!TEXT_EXT.test(rel)) { $('code').replaceChildren(el('span', { className: 'ln' }, 'Keine Textvorschau für diesen Dateityp.')); return; }
  try {
    const t = (await api.fs.readText(rel)).split(/\r?\n/).slice(0, 200);
    $('code').replaceChildren(...t.map((l, i) => el('span', { className: 'ln', textContent: String(i + 1).padStart(3) + '  ' + l })));
  } catch (e) { $('code').replaceChildren(el('span', { className: 'ln' }, String(e))); }
}

// ---- Agenten ----------------------------------------------------------------------------------------------------

async function refreshAgents(): Promise<void> {
  const list: AgentInfo[] = await api.agents.detect();
  $('agent-buttons').replaceChildren(...list.map((a) => {
    const b = el('button', { textContent: a.label, disabled: !a.found, title: a.found ? `${a.command} im Terminal starten` : `${a.command} wurde im PATH nicht gefunden. Installiere den Agenten selbst, dann erscheint er hier.` });
    b.addEventListener('click', () => void terminals.add({ command: a.command, title: a.label }));
    return b;
  }));
}

// ---- Speichern und Öffnen ---------------------------------------------------------------------------------------

function renderSaveState(st: SaveState): void {
  saveState = st;
  const b = $('save-badge');
  b.textContent = st.unsaved ? '● ungespeichert' : '✓ gespeichert';
  b.className = 'badge' + (st.unsaved ? ' unsaved' : '');
  b.title = st.zipPath ? `ZIP: ${st.zipPath}` : 'Noch nicht als ZIP gespeichert';
  document.title = `CAD-IDE – ${project?.name ?? ''}${st.unsaved ? ' ●' : ''}`;
}

async function refreshSaveState(): Promise<void> {
  try { renderSaveState(await api.project.saveState()); } catch { /* Projekt wechselt gerade */ }
}

async function doSave(saveAs = false): Promise<void> {
  const r = await api.project.save(saveAs);
  if (r.cancelled) return;
  if (r.error) { toast(r.error, 'error'); return; }
  const kb = Math.round((r.bytes ?? 0) / 1024);
  const lines = [`Gespeichert: ${r.zipPath}`, `${r.files} Dateien, ${kb} KB${r.snapshot ? ' · Snapshot im Verlauf angelegt' : ''}`];
  if (r.warnings?.length) lines.push(`Hinweis: ${r.warnings.join(' ')}`);
  toast(lines.join('\n'), r.warnings?.length ? 'error' : 'info');
  project = await api.project.current(); // der Modellname folgt dem Dateinamen
  void refreshProjects();
  void refreshSaveState();
}

async function doOpen(): Promise<void> {
  const r = await api.project.openZip();
  if (r.error) toast(r.error, 'error');
}

// Kurzbefehle gelten nicht im Terminal: dort gehören Strg+S/Strg+O den Programmen (Claude Code nutzt Strg+O selbst)
window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement | null)?.closest?.('#terminals') || !e.ctrlKey) return;
  const k = e.key.toLowerCase();
  if (k === 's') { e.preventDefault(); void doSave(e.shiftKey); }
  else if (k === 'o' && !e.shiftKey) { e.preventDefault(); void doOpen(); }
}, true);

// ---- Bedienelemente ---------------------------------------------------------------------------------------------

document.querySelectorAll<HTMLButtonElement>('.tab[data-tab]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tab[data-tab]').forEach((x) => x.classList.toggle('active', x === b));
  $('tab-model').hidden = b.dataset.tab !== 'model';
  $('tab-files').hidden = b.dataset.tab !== 'files';
}));
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => b.addEventListener('click', () => viewer.setView(b.dataset.view as ViewName)));
$<HTMLInputElement>('chk-edges').addEventListener('change', (e) => viewer.setEdges((e.target as HTMLInputElement).checked));
$<HTMLInputElement>('chk-wire').addEventListener('change', (e) => viewer.setWireframe((e.target as HTMLInputElement).checked));
$<HTMLInputElement>('chk-ghost').addEventListener('change', (e) => viewer.setGhost((e.target as HTMLInputElement).checked));
$('btn-new').addEventListener('click', () => void api.project.create());
$('btn-open').addEventListener('click', () => void doOpen());
$('btn-save').addEventListener('click', () => void doSave(false));
$('btn-saveas').addEventListener('click', () => void doSave(true));
$('btn-build').addEventListener('click', () => void api.build.run());
$('btn-cancel').addEventListener('click', () => void api.build.cancel());
$<HTMLInputElement>('chk-auto').addEventListener('change', (e) => void api.build.setAuto((e.target as HTMLInputElement).checked));
$<HTMLSelectElement>('sel-projects').addEventListener('change', (e) => { const id = (e.target as HTMLSelectElement).value; if (id && id !== project?.id) void api.project.open(id); });

// Trennleisten: ziehen ändert die Spaltenbreiten (Terminal und Viewer passen sich per ResizeObserver an)
function splitter(id: string, prop: '--left' | '--right'): void {
  $(id).addEventListener('pointerdown', (down) => {
    const main = $('main');
    const start = down.clientX;
    const startVal = parseFloat(getComputedStyle(main).getPropertyValue(prop)) || (prop === '--left' ? 250 : main.clientWidth * 0.46);
    const move = (e: PointerEvent) => {
      const dx = e.clientX - start;
      const v = prop === '--left' ? startVal + dx : startVal - dx;
      main.style.setProperty(prop, Math.max(150, Math.min(main.clientWidth - 400, v)) + 'px');
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  });
}
splitter('split-left', '--left');
splitter('split-right', '--right');

// ---- Ereignisse vom Hauptprozess --------------------------------------------------------------------------------

api.project.onChanged((p) => void onProject(p));
api.build.onStatus((s) => {
  setStatusFromBuild(s);
  if (s.state === 'ok') { void loadModel(); void refreshFiles(); }
});
api.fs.onChanged(() => void refreshFiles());
api.versions.onChanged(() => void versions.refresh());
api.project.onSaveState((st) => renderSaveState(st));
// Das Projekt kommt ausschließlich über das Ereignis (der Hauptprozess öffnet es beim Start). Ein zweiter Weg würde alles doppelt aufbauen.

// Prüfschnittstelle, nur im Testmodus
if (api.testMode) {
  (window as unknown as Record<string, unknown>).__t = {
    viewer, terminals,
    project: () => project,
    parts: () => viewer.partList(),
    partCount: () => viewer.partList().length,
    status: () => ({ state: $('status').dataset.state, text: $('status').textContent, detail: $('status-detail').textContent, viewerMsg: $('viewer-msg').textContent }),
    info: () => $('info').textContent,
    codeHighlight: () => [...document.querySelectorAll('#code .hl')].map((x) => x.textContent),
    treeNames: () => [...document.querySelectorAll('#tab-model .part .name')].map((x) => x.textContent),
    termText: (id: number) => terminals.text(id),
    versions: () => versions.state(),
    saveState: () => saveState,
    toast: () => ({ text: $('toast').textContent, hidden: $('toast').hidden, error: $('toast').className === 'error' }),
    banner: () => ({ hidden: $('preview-banner').hidden, text: $('preview-banner').textContent }),
    partSize: (name: string) => { const p = viewer.partList().find((x) => x.name === name); return p ? viewer.partSize(p.id) : null; },
    versionsUi: () => ({ restoreHidden: $('btn-restore').hidden, problem: $('vproblem').hidden ? '' : $('vproblem').textContent }),
  };
}
