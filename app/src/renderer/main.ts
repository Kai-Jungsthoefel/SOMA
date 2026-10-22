import { affectsBuild } from '../shared/editable';
import { DEFAULT_SETTINGS, type SettingsPatch, type SettingsResult, type SettingsState } from '../shared/settings';
import type { AgentInfo, AnimEntry, BuildStatus, CadQueryImportResult, DrawingEntry, DrawingList, ExportResult, FileNode, ImportResult, ModelMap, PartMap, PreviewResult, ProjectInfo, ProjectListEntry, ResultEntry, SaveState, UpdateInfo } from '../shared/types';
import { AnalysisPanel } from './analysispanel';
import { AnimPanel, animKey, videoKey } from './animpanel';
import { SOMA_VERSION } from '../shared/version';
import { CodePanel, codeRows, isDxf, isPdf, type Mark } from './code';
import { DRAWINGS_KEY, DrawingsView } from './drawings';
import { DrawingLink } from './drawlink';
import { AnimTool } from './animtool';
import { Busy } from './busy';
import { DRAG_FILE, FileTree, IMAGE_EXT, TEXT_EXT, VIDEO_EXT } from './filetree';
import { FileView } from './fileview';
import { hydrateIcons, icon } from './icons';
import { Markup } from './markup';
import { MAX_QUOTE } from './pdfview';
import { MeasureTool } from './measuretool';
import { SectionTool } from './sectiontool';
import { ExplodeTool } from './explodetool';
import { HelpDialog } from './help';
import { SettingsDialog } from './settings';
import { AboutPage, ShortcutsPage, StoragePage, ViewerPage } from './settingspages';
import { SkillsPanel } from './skills';
import { ParamsPanel } from './params';
import { StructureTree } from './tree';
import { Tour, tourSteps, type TourContext } from './tutorial';
import { ResultTool } from './resulttool';
import { ResultLayer } from './resultview';
import { TerminalTabs } from './terminals';
import { $, ask, el, fmtWhen, menuItem, menus, toast } from './ui';
import { VersionsBar } from './versions';
import { VideoView } from './videoview';
import { PickResult, Viewer, ViewName } from './viewer';

hydrateIcons();
const api = window.soma;

/** Ladebildschirm aus index.html ausblenden. Auch bei einem Fehler im Aufbau, sonst bliebe er für immer stehen. */
function hideBoot(): void {
  const boot = document.getElementById('boot');
  if (!boot || boot.classList.contains('gone')) return;
  boot.classList.add('gone');
  setTimeout(() => boot.remove(), 200);
}
window.addEventListener('error', hideBoot, { once: true });

/**
 * Ohne WebGL gibt es keine 3D-Ansicht, und die ganze Oberfläche hängt am Viewer. Unter Linux startet der Hauptprozess dann
 * mit Software-Rendering neu (main/main.ts), sonst klar sagen, was fehlt, statt mit leerem Fenster stehen zu bleiben.
 */
function createViewer(): Viewer {
  try {
    return new Viewer($('viewer'));
  } catch (e) {
    const title = el('h1', {}, '3D view unavailable');
    const text = el('p', {}, 'SOMA needs WebGL 2 for the 3D view, but this system could not provide it. Install or update the graphics driver, or start SOMA on a machine with graphics acceleration.');
    document.body.replaceChildren(el('div', { className: 'fatal' }, title, text, el('pre', {}, String(e instanceof Error ? e.message : e))));
    void window.soma.gpu.webglFailed().then((restarting) => {
      if (!restarting) return;
      title.textContent = 'Restarting with software rendering';
      text.textContent = 'No graphics acceleration is available, so SOMA restarts and draws the 3D view in software. This is slower for large models. If no window appears, start SOMA again.';
    }).catch(() => { /* Meldung bleibt */ });
    throw e;
  }
}
const viewer = createViewer();
viewer.attachCube($('cube-view'));
const terminals = new TerminalTabs($('term-tabs'), $('term-panes'), $('btn-term-add'), $('strip-tabs'));

let project: ProjectInfo | null = null;
let saveState: SaveState | null = null;
let buildStatus: BuildStatus = { state: 'idle' };
let lastOkAt: number | null = null;
let errorAt = 0;
let map: ModelMap | null = null;
let loadSeq = 0;
let selection: { partId: string; pick: PickResult | null } | null = null;
/** Alle ausgewählten Bauteile (Strg/Shift-Klick, Rahmen, Baum). `selection` ist das zuletzt gewählte darunter. */
let picked: string[] = [];
let agents: AgentInfo[] = [];
const textCache = new Map<string, string>();

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ohne Speicher geht es auch */ } },
};

async function readText(rel: string): Promise<string> {
  let t = textCache.get(rel);
  if (t === undefined) { t = await api.fs.readText(rel); textCache.set(rel, t); }
  return t;
}

const num = (v: number, digits = 1) => v.toLocaleString('en-US', { maximumFractionDigits: digits });
const SURFACE: Record<string, string> = {
  PLANE: 'plane', CYLINDER: 'cylinder', CONE: 'cone', SPHERE: 'sphere', TORUS: 'torus', BSPLINE: 'freeform', BEZIER: 'freeform',
  REVOLUTION: 'surface of revolution', EXTRUSION: 'extruded surface', OFFSET: 'offset surface', OTHER: 'other',
};
const surfaceName = (s: string | null) => (s ? SURFACE[s] ?? s.toLowerCase() : 'face');
const ERROR_KIND: Record<string, string> = { Timeout: 'Time limit exceeded', PythonStart: 'Python could not be started', NoResult: 'Build without result' };

// ---- Seitenleiste (Parameter, Dateien, Analyse, Animation, Skills, E82) und Code-Spalte (Entwurf 2) ------------------

type PanelName = 'params' | 'files' | 'analysis' | 'anim' | 'skills';
const PANELS: PanelName[] = ['params', 'files', 'analysis', 'anim', 'skills'];
let panel: PanelName | null = null;
/** Zuletzt gezeigte Ansicht der Seitenleiste: Der Schalter oben bringt sie wieder. */
let lastPanel: PanelName = 'files';
let filesDirty = true;
let codeOpen = false;
/** Der Dateibaum entsteht nach dem Code-Panel, das ihm schon beim Aufbau die offene Datei meldet. */
let fileTree: FileTree | null = null;

function showPanel(p: PanelName | null): void {
  panel = p;
  if (p) lastPanel = p;
  $('side').hidden = !p;
  $('split-side').hidden = !p;
  $('panel-params').hidden = p !== 'params';
  $('panel-files').hidden = p !== 'files';
  $('panel-analysis').hidden = p !== 'analysis';
  $('panel-anim').hidden = p !== 'anim';
  $('panel-skills').hidden = p !== 'skills';
  // Bericht und Ablauf brauchen mehr Breite als Listen (Entwurf: 352 px). Zieht der Nutzer breiter, gilt seine Breite
  $('side').classList.toggle('wide', p === 'analysis' || p === 'anim');
  document.querySelectorAll<HTMLButtonElement>('#rail [data-panel]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.panel === p)));
  if (p === 'files' && filesDirty) void refreshFiles();
  if (p === 'params') void paramsPanel.refresh();
  if (p === 'skills') void skills.refresh();
  else skills.closeDetail();
  if (p === 'analysis') void openResults();
  if (p === 'anim') void openAnims();
  // Nur die Ansichten zum Arbeiten am Modell bleiben über einen Neustart: Ein Ergebnis zeigt sich erst auf Wunsch
  if (p !== 'analysis' && p !== 'anim') store.set('soma.side', p ?? '');
  renderLayout();
  renderResults();
}

/** Code als eigene Spalte neben der Seitenleiste, damit Dateien und Code gleichzeitig offen sein können. */
function showCode(on: boolean): void {
  codeOpen = on;
  $('editor').hidden = !on;
  $('split-code').hidden = !on;
  // Leer aufgemacht: die Stelle der Auswahl zeigen, sonst model.py
  if (on && !code.activeFile) {
    const e = selection ? partEntry(selection.partId) : undefined;
    if (e?.file && e.line) void code.open(e.file, { ...lineRange(e), label: e.name, color: partInfo(e.id)?.color });
    else if (project) void code.open(project.entry);
  }
  renderLayout();
  renderDrawingsRail();
}

/** Spalten-Schalter oben rechts: zeigen, welche Spalten offen sind. */
function renderLayout(): void {
  $('btn-lay-side').setAttribute('aria-pressed', String(!!panel));
  $('btn-lay-code').setAttribute('aria-pressed', String(codeOpen));
  $('btn-lay-agent').setAttribute('aria-pressed', String(!$('terminals').classList.contains('collapsed')));
}

const code = new CodePanel(
  { tabs: $('code-tabs'), info: $('code-info'), banner: $('code-banner'), view: $('code-view'), link: $<HTMLButtonElement>('btn-codelink'), mode: $('code-mode') },
  {
    read: (rel) => api.fs.readText(rel), readBinary: (rel) => api.fs.readBinary(rel), projectId: () => project?.id ?? null, toast, ask: (o) => api.dialog.choose(o),
    changed: () => { if (saveState) renderSaveState(saveState); },
    // Später: Der erste Aufruf kommt schon aus dem Konstruktor, bevor `code` steht
    active: (f) => { fileTree?.setActive(f); queueMicrotask(renderDrawingsRail); },
    saveAndBuild: () => void saveCode(),
    build: () => void api.build.run(),
    link: (href) => openLink(href),
    image: async (rel) => { try { return await imageUrl(rel); } catch { return null; } },
    quote: (file, pages, text) => {
      // Eine Zeile mit Datei und Seite, wie Auswahl und Markierung. Sehr lange Zitate werden gekürzt, das steht in der Meldung.
      const cut = text.length > MAX_QUOTE;
      insertToAgent(`[Quote: ${file} p. ${pages}: "${cut ? `${text.slice(0, MAX_QUOTE)} …` : text}"] `, cut ? `Quote shortened to ${MAX_QUOTE} characters.` : undefined);
    },
    markPage: (file, page, canvas) => void markSource(`${file} p. ${page}`, canvas, canvas.width, canvas.height),
    dxf: (rel, known) => api.dxf.view(rel, known),
    markDxf: (label, canvas) => void markSource(label, canvas, canvas.width, canvas.height),
  },
);

/** Bilddatei aus dem Projekt als blob:-Adresse (die CSP erlaubt blob:). Freigeben muss der Aufrufer. */
async function imageUrl(rel: string): Promise<string> {
  const data = await api.fs.readBinary(rel);
  return URL.createObjectURL(new Blob([data], { type: /\.svg$/i.test(rel) ? 'image/svg+xml' : '' }));
}

/** Link aus einer Markdown-Ansicht: Web-Adressen im Browser, Dateien im Projekt wie ein Klick im Dateibaum. */
function openLink(href: string): void {
  if (/^(https?:|mailto:)/i.test(href)) {
    void api.openUrl(href).then((r) => { if (!r.ok) toast(r.error ?? `${href} could not be opened.`, 'error'); });
    return;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) { toast(`For security reasons, this link is not opened: ${href.slice(0, 100)}`, 'error'); return; }
  if (TEXT_EXT.test(href.split('/').pop() ?? '') || isPdf(href) || isDxf(href)) void openCode(href);
  else void openExternal(href);
}

async function openCode(file: string, mark?: Mark): Promise<void> {
  if (!codeOpen) { codeOpen = true; $('editor').hidden = false; $('split-code').hidden = false; renderLayout(); }
  await code.open(file, mark);
}

const skills = new SkillsPanel({ list: $('skills-list'), sum: $('skills-sum'), detail: $('skill-detail'), menu: $('menu-ctx') }, {
  list: () => api.skills.list(),
  set: (id, mode) => api.skills.set(id, mode),
  configure: (id, values) => api.skills.configure(id, values),
  setDefault: (id, mode) => api.skills.setDefault(id, mode),
  open: (file) => void openCode(file),
  edit: (id) => void settings.open(id),
  insert: (text) => insertToAgent(text),
  toast,
  changed: () => { filesDirty = true; textCache.clear(); void refreshSaveState(); void code.refresh(); },
});

// ---- Einstellungen (E78, E81) ---------------------------------------------------------------------------------------

/** Einstellungen der App aus settings.json. Bis sie geladen sind, gelten die Vorgaben. */
let appSettings: SettingsState = { settings: DEFAULT_SETTINGS };

/** Viewer und Messen nach den Einstellungen (sofort, auch bei offenem Modell). */
function applySettings(): void {
  const v = appSettings.settings.viewer;
  viewer.setNavigation(v.navigation, v.invertZoom);
  viewer.setProjection(v.projection);
  measureTool.setDecimals(v.decimals);
}

/** Darstellung beim Öffnen eines Modells (Menü „Display“). Danach gilt bis zum nächsten Modell, was der Nutzer dort umstellt. */
function applyDisplayDefaults(): void {
  const v = appSettings.settings.viewer;
  const want: Record<string, boolean> = { edges: v.edges, wire: v.wireframe, ghost: v.transparent, axes: v.axes };
  document.querySelectorAll<HTMLButtonElement>('[data-display]').forEach((b) => b.setAttribute('aria-checked', String(want[b.dataset.display!])));
  viewer.setEdges(v.edges);
  viewer.setWireframe(v.wireframe);
  viewer.setGhost(v.transparent);
  setAxes(v.axes);
}

/** Ursprung und Achsen: eigener Knopf neben dem ViewCube und Eintrag im Menü „Display“, beide zeigen denselben Stand. */
function setAxes(on: boolean): void {
  $('btn-axes').setAttribute('aria-pressed', String(on));
  document.querySelector('[data-display="axes"]')?.setAttribute('aria-checked', String(on));
  viewer.setAxes(on);
}

async function changeSettings(patch: SettingsPatch): Promise<SettingsResult> {
  const r = await api.settings.set(patch);
  appSettings = { settings: r.settings, ...(r.problem ? { problem: r.problem } : {}) };
  if (r.ok) applySettings();
  return r;
}

const viewerPage = new ViewerPage($('st-viewer'), { current: () => appSettings, set: (patch) => changeSettings(patch), toast });
const storagePage = new StoragePage($('st-storage'), { api: api.storage, toast });
const shortcutsPage = new ShortcutsPage($('st-keys'), { current: () => appSettings });
const aboutPage = new AboutPage($('st-about'), {
  api: api.about, toast,
  openUrl: (url) => void api.openUrl(url).then((r) => { if (!r.ok) toast(r.error ?? `${url} could not be opened.`, 'error'); }),
  openFolder: (area) => void api.storage.open(area).then((r) => { if (!r.ok) toast(`The folder could not be opened: ${r.error ?? 'unknown error'}`, 'error'); }),
  updateCheck: () => appSettings.settings.start.updateCheck,
  setUpdateCheck: async (on) => { const r = await changeSettings({ start: { updateCheck: on } }); if (!$('start').hidden) void renderUpdate(); return r; },
});

// Einstellungen (E78, E81): Reiter Viewer, Skills, Speicher und Info, auch von der Startseite aus. Änderungen an den
// Skills zeigt das Panel „Skills“ sofort
const settings = new SettingsDialog({
  root: $('settings'), nav: $('st-nav'), list: $('st-list'), editor: $('st-editor'), popover: $('menu-skill-name'), newBtn: $('btn-st-new'), importBtn: $('btn-st-import'),
  // Gesperrt wird, was dahinter liegt. Nicht #app: Es umschließt auch Menüs, Meldungen und die Einstellungen selbst
  folderBtn: $('btn-st-folder'), close: $('btn-st-close'), background: [$('topbar'), $('body'), $('start')],
}, {
  library: api.library,
  choose: (o) => api.dialog.choose(o),
  toast,
  link: (href) => {
    if (/^(https?:|mailto:)/i.test(href)) void api.openUrl(href).then((r) => { if (!r.ok) toast(r.error ?? `${href} could not be opened.`, 'error'); });
    else toast('Only web links open from the preview of a skill.', 'info');
  },
  changed: () => { if (project && skills.isLoaded) void skills.refresh(); },
  modelMode: async (id) => (project ? (await api.skills.list()).find((s) => s.id === id)?.mode ?? 'off' : null),
  pages: { viewer: viewerPage, keys: shortcutsPage, storage: storagePage, about: aboutPage },
});
// Hilfe (E83): Knopf in der Leiste und auf der Startseite, F1 überall außer in den Einstellungen
const help = new HelpDialog({ root: $('help'), nav: $('help-nav'), body: $('help-body'), close: $('btn-help-close') as HTMLButtonElement, background: [$('topbar'), $('body'), $('start')] }, {
  help: api.help,
  openUrl: (href) => void api.openUrl(href).then((r) => { if (!r.ok) toast(r.error ?? `${href} could not be opened.`, 'error'); }),
});
$('btn-help').addEventListener('click', () => void help.open());
$('btn-start-help').addEventListener('click', () => void help.open());
window.addEventListener('keydown', (e) => {
  if (e.key !== 'F1' || e.ctrlKey || e.altKey || e.metaKey || settings.isOpen) return;
  e.preventDefault();
  if (help.isOpen) help.close(); else void help.open();
});
$('btn-settings').addEventListener('click', () => void settings.open());
$('btn-start-settings').addEventListener('click', () => void settings.open());
$('btn-skills-manage').addEventListener('click', () => void settings.open());

const paramsPanel = new ParamsPanel({ list: $('params-list'), foot: $('params-foot'), count: $('params-count') }, {
  state: () => api.params.state(),
  set: (values) => api.params.set(values),
  resetAll: () => api.params.resetAll(),
  openCode: (file, line, label) => void openCode(file, { from: line, to: line, label }),
  insert: (text) => insertToAgent(text),
  toast,
});

const files = new FileTree($('tab-files'), $('menu-ctx'), {
  open: (n) => {
    if (TEXT_EXT.test(n.name) || isPdf(n.name) || isDxf(n.name)) void openCode(n.path);
    // Bilder (etwa Markierungen und Skizzen) öffnen auf der Zeichenfläche (E52), das Bildprogramm gibt es per Rechtsklick
    else if (IMAGE_EXT.test(n.name)) void markImage(n.path);
    else if (VIDEO_EXT.test(n.name)) void videoView.open(n.path);
    // STEP-Dateien des Projekts im Viewer, schreibgeschützt wie die Vorschau eines alten Stands
    else if (/\.(step|stp)$/i.test(n.name)) void fileView.open(n.path);
    else toast('The app has no view for this file type. Right-click: “Open with default app”.', 'info');
  },
  create: async (parent, name, dir) => {
    const r = await api.fs.create(parent, name, dir);
    if (!r.ok || !r.path) { toast(r.error ?? `${name} could not be created.`, 'error'); return false; }
    await refreshFiles();
    if (!dir && TEXT_EXT.test(name)) void openCode(r.path);
    return true;
  },
  rename: async (rel, name) => {
    if (!fileOpAllowed(rel, 'rename')) return true;
    const wasOpen = code.openUnder(rel);
    const r = await api.fs.rename(rel, name);
    if (!r.ok || !r.path) { toast(r.error ?? `${rel} could not be renamed.`, 'error'); return false; }
    // Reiter wandern mit: der alte zu, die Datei unter neuem Namen wieder auf (ohne das Panel zu wechseln)
    code.forget(rel);
    for (const f of wasOpen) void code.open(r.path + f.slice(rel.length), undefined, false);
    await refreshFiles();
    return true;
  },
  trash: (rel) => void (async () => {
    if (!fileOpAllowed(rel, 'delete')) return;
    const r = await api.fs.trash(rel);
    if (r.canceled) return;
    if (!r.ok) { toast(r.error ?? `${rel} could not be deleted.`, 'error'); return; }
    code.forget(rel);
    await refreshFiles();
    toast(`${rel} is in the Recycle Bin.`);
  })(),
  reveal: (rel) => void api.fs.reveal(rel).then((r) => { if (!r.ok) toast(r.error ?? 'Explorer could not be opened.', 'error'); }),
  openExternal: (rel) => void openExternal(rel),
  mark: (rel) => void markImage(rel),
  toAgent: (rel) => insertToAgent(`[File: ${rel}] `),
  copyPath: (rel) => void navigator.clipboard.writeText(rel).then(() => toast(`Path copied: ${rel}`), (e) => toast(`The path could not be copied: ${e instanceof Error ? e.message : String(e)}`, 'error')),
});
fileTree = files;
files.setActive(code.activeFile);

async function openExternal(rel: string): Promise<void> {
  const r = await api.fs.openExternal(rel);
  if (!r.ok) toast(r.error ?? `${rel} could not be opened.`, 'error');
}

/** Umbenennen und Löschen nur ohne ungespeicherte Eingaben im Editor, sonst gingen sie unter dem alten Namen verloren. */
function fileOpAllowed(rel: string, what: 'rename' | 'delete'): boolean {
  const open = code.unsaved().filter((f) => f === rel || f.startsWith(`${rel}/`));
  if (!open.length) return true;
  toast(`To ${what}, first save or discard the changes: ${open.join(', ')}`, 'error');
  return false;
}

async function refreshFiles(): Promise<void> {
  // Ohne Modell (Startseite) gibt es keine Dateien: Die Anfrage scheiterte nur und stand als Fehler im Protokoll
  if (panel !== 'files' || !project) { filesDirty = true; return; }
  filesDirty = false;
  try { files.render(await api.fs.list()); } catch { /* Projekt wechselt gerade */ }
}

$('btn-file-new').addEventListener('click', () => files.startCreate('', false));
$('btn-folder-new').addEventListener('click', () => files.startCreate('', true));

// Dateien und Ordner ziehen: überall im Fenster ablegen landet in inputs/. Ohne das würde Electron die Datei als Seite öffnen.
// Bauteile und Dateien aus der App lassen sich ins Terminal ziehen (ersetzt die Übergabeleiste, Entwurf 2).
let dragDepth = 0;
const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
const isInternal = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].some((t) => t === DRAG_FILE);
const overTerminal = (e: DragEvent) => !!(e.target as HTMLElement | null)?.closest?.('#term-panes');
document.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  if (dragDepth++ === 0) { document.body.classList.add('dragging'); if (project) showPanel('files'); }
});
document.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  const term = isInternal(e) && overTerminal(e);
  $('term-panes').classList.toggle('dropping', term);
  if (e.dataTransfer) e.dataTransfer.dropEffect = (hasFiles(e) && project) || term ? 'copy' : 'none';
});
document.addEventListener('dragend', () => $('term-panes').classList.remove('dropping'));
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  $('term-panes').classList.remove('dropping');
  if (isInternal(e)) {
    if (!overTerminal(e)) return;
    const rel = e.dataTransfer?.getData(DRAG_FILE);
    if (rel) insertToAgent(`[File: ${rel}] `);
    return;
  }
  const list = [...(e.dataTransfer?.files ?? [])];
  if (list.length && project) void importFiles(list);
});

async function importFiles(list: File[]): Promise<void> {
  reportImport(await api.fs.importFiles(list));
}

// Knopf „Import“: derselbe Weg wie Ziehen, nur mit Dateidialog. Zeigt Nutzern, wie Daten ins Modell kommen
$('btn-import').addEventListener('click', async () => {
  if (!project) return;
  const r = await api.fs.importPick();
  if (r) reportImport(r);
});

function reportImport(r: ImportResult): void {
  showPanel('files');
  const lines: string[] = [];
  if (r.files.length) lines.push(`Added to inputs/: ${r.files.map((f) => f.replace(/^inputs\//, '')).join(', ')}`, 'The agent can now use them in the script.');
  // Ein Ordner voller Verknüpfungen soll die Meldung nicht über den Bildschirm ziehen
  const shown = r.errors.slice(0, 8);
  if (r.errors.length > shown.length) shown.push(`… and ${r.errors.length - shown.length} more`);
  if (r.errors.length) lines.push(`Not added:\n${shown.join('\n')}`);
  if (lines.length) toast(lines.join('\n'), r.errors.length ? 'error' : 'ok');
}

// ---- Bauteile und Auswahl ---------------------------------------------------------------------------------------

// Strukturbaum oben links im Viewer (E82). Ausblenden und Transparent liegen im Viewer und gelten für Modell, Analyse und Animation
const tree = new StructureTree($('tree'), {
  select: (s) => {
    if (s.how === 'replace') selectPart(s.id, null, true);
    else if (s.how === 'range') setPicked(s.ids, s.id);
    else setPicked(picked.includes(s.id) ? picked.filter((x) => x !== s.id) : [...picked, s.id], picked.includes(s.id) ? picked.filter((x) => x !== s.id).at(-1) ?? null : s.id);
  },
  setVisible: (ids, on) => { viewer.setVisible(ids, on); resultTool.forgetProbe(); },
  isVisible: (id) => viewer.isVisible(id),
  setGhost: (ids, on) => { viewer.setGhosted(ids, on); resultTool.forgetProbe(); },
  isGhost: (id) => viewer.isGhosted(id),
  showAll: () => { viewer.showAll(); resultTool.forgetProbe(); },
  context: (id, x, y) => openPartMenu(id, x, y),
  groupContext: (ids, name, x, y) => openGroupMenu(ids, name, x, y),
  resized: () => fitDock(),
});

const refreshTree = () => { tree.set(viewer.partList(), picked); resultTool.forgetProbe(); fitDock(); };

/**
 * Werkzeuge oben in der Mitte neben dem Baum: Der Platz links gehört dem Baum, wird es eng, zeigen sie nur Symbole (E82).
 * Gemessen statt per CSS, weil die Breite des Baums vom Namen des Modells und vom Aufklappen abhängt.
 */
function fitDock(): void {
  const dock = $('dock'), vtop = $('vtop');
  $('tree-space').style.width = `${$('tree').offsetWidth}px`;
  dock.classList.remove('compact');
  const room = vtop.clientWidth - $('tree-space').offsetWidth - $('vtop').querySelector<HTMLElement>('.cubespace')!.offsetWidth - 3 * 12;
  dock.classList.toggle('compact', dock.scrollWidth > room);
}
new ResizeObserver(() => fitDock()).observe($('viewer'));
// Höhe des sichtbaren Banners (Vorschau, Dateiansicht): Die Karten unten links rücken darüber, sonst verdeckt es sie
const bannerObserver = new ResizeObserver(() => {
  const h = Math.max($('preview-banner').offsetHeight, $('file-banner').offsetHeight);
  if (h) $('viewer').style.setProperty('--bn-h', `${h}px`);
});
bannerObserver.observe($('preview-banner'));
bannerObserver.observe($('file-banner'));
const partEntry = (id: string): PartMap | undefined => map?.parts.find((x) => x.id === id);
const partInfo = (id: string) => viewer.partList().find((x) => x.id === id);
const lineRange = (e: PartMap) => ({ from: e.line!, to: e.end_line && e.end_line >= e.line! ? e.end_line : e.line! });

function selectPart(id: string | null, pick: PickResult | null, focus = false): void {
  selection = id ? { partId: id, pick } : null;
  picked = id ? [id] : [];
  if (!pick) viewer.select(id); // ein Klick im Viewer hat die Auswahl dort schon gesetzt
  if (id && focus) viewer.focusPart(id);
  tree.select(picked);
  void renderSelection();
}

/** Mehrere Bauteile auswählen, `primary` zeigt die Auswahlkarte (bei mehreren eine Zusammenfassung). */
function setPicked(ids: string[], primary: string | null, pick: PickResult | null = null): void {
  picked = [...new Set(ids)];
  const main = primary && picked.includes(primary) ? primary : picked.at(-1) ?? null;
  selection = main ? { partId: main, pick: main === primary ? pick : null } : null;
  viewer.setSelection(picked, main);
  tree.select(picked);
  void renderSelection();
}

// Klick ins Modell: allein auswählen, mit Shift dazu, mit Strg dazu oder heraus. Daneben geklickt mit Taste: Auswahl bleibt
viewer.onPick = (r, mods) => {
  const add = mods.shift || mods.ctrl;
  if (!add) { selectPart(r?.partId ?? null, r); return; }
  if (!r) { setPicked(picked, selection?.partId ?? null, selection?.pick ?? null); return; }
  if (mods.ctrl && picked.includes(r.partId)) { const rest = picked.filter((x) => x !== r.partId); setPicked(rest, rest.at(-1) ?? null); return; }
  setPicked([...picked, r.partId], r.partId, r);
};
// Alt + links ziehen: Rahmenauswahl, mit Shift oder Strg dazu
viewer.onBox = (ids, add) => setPicked(add ? [...picked, ...ids] : ids, ids.at(-1) ?? (add ? selection?.partId ?? null : null));
viewer.onContext = (id, x, y) => { if (id) openPartMenu(id, x, y); else openViewerMenu(x, y); };

const partName = (id: string) => partEntry(id)?.name ?? partInfo(id)?.name ?? id;

async function renderSelection(): Promise<void> {
  const card = $('selcard');
  if (!selection) { card.hidden = true; return; }
  $<HTMLButtonElement>('btn-sel-export').disabled = picked.length > 1;
  if (picked.length > 1) {
    // Mehrere: Zahl und Namen, kein Code und kein Export eines einzelnen Teils
    $('sel-name').textContent = `${picked.length} parts selected`;
    $('sel-name').title = '';
    $('sel-swatch').style.background = 'var(--acc)';
    const names = picked.map(partName);
    $('info').textContent = names.slice(0, 6).join(', ') + (names.length > 6 ? ` and ${names.length - 6} more` : '');
    $('code').replaceChildren();
    $<HTMLButtonElement>('btn-sel-code').disabled = true;
    card.hidden = false;
    return;
  }
  const { partId, pick } = selection;
  const p = partInfo(partId);
  const e = partEntry(partId);
  const name = e?.name ?? p?.name ?? partId;
  // Zukaufteile (Normteile aus soma.fasteners, E48) sehen aus wie eigene Teile, der Zusatz unterscheidet sie
  $('sel-name').textContent = name + (p?.role === 'reference' ? ' (reference)' : p?.role === 'hardware' ? ' (purchased part)' : '');
  $('sel-name').title = p?.group ? `Group ${p.group}` : '';
  $('sel-swatch').style.background = p?.color ?? '';
  const bits = pick?.faceId != null
    ? ['Face', surfaceName(pick.surface), ...(pick.area != null ? [`${num(pick.area)} mm²`] : [])]
    : pick?.cut ? ['Cut face', 'whole part'] : ['whole part'];
  $('info').textContent = bits.join(' · ');
  const peek = $('code');
  const hasCode = !!(e?.file && e.line);
  $<HTMLButtonElement>('btn-sel-code').disabled = !hasCode;
  card.hidden = false;
  if (!hasCode) { peek.replaceChildren(); return; }
  const { from, to } = lineRange(e!);
  const last = Math.min(to, from + 3);
  const head = el('div', { className: 'ph' }, el('span', { textContent: e!.file! }), el('span', { textContent: `${to !== from ? 'Lines' : 'Line'} ${from}${to !== from ? '–' + to : ''}` }));
  try {
    const src = (await readText(e!.file!)).split(/\r?\n/);
    if (selection?.partId !== partId) return; // inzwischen etwas anderes gewählt
    peek.replaceChildren(head, ...codeRows(src.slice(from - 1, last), from, { from, to, kind: 'hl' }));
    if (to > last) peek.append(el('div', { className: 'ph', textContent: `… to line ${to}` }));
  } catch { peek.replaceChildren(head, el('div', { className: 'ph', textContent: `${e!.file} not readable` })); }
  if (codeOpen) void code.follow(e!.file!, { from, to, label: name, color: p?.color });
}

/** Text für die Eingabe des Agenten. Zahlen mit Punkt, damit sie eindeutig bleiben. */
function selectionText(): string | null {
  if (!selection) return null;
  // In der Dateiansicht gehören die Teile zur STEP-Datei, nicht zum Modell: Das muss der Agent wissen
  const inFile = fileView.rel ? ` in the STEP file ${fileView.rel}` : '';
  if (picked.length > 1) {
    const names = picked.map((id) => `"${partName(id)}"`);
    return `[Selection: ${picked.length} parts${inFile}: ${names.slice(0, 40).join(', ')}${names.length > 40 ? ` and ${names.length - 40} more` : ''}] `;
  }
  const e = partEntry(selection.partId);
  const group = partInfo(selection.partId)?.group;
  const bits = [`part "${e?.name ?? partInfo(selection.partId)?.name ?? selection.partId}"${group ? ` in group "${group}"` : ''}${inFile}`];
  if (e?.file && e.line) { const { from, to } = lineRange(e); bits.push(`${e.file} ${to !== from ? 'lines' : 'line'} ${from}${to !== from ? '-' + to : ''}`); }
  const pk = selection.pick;
  if (pk?.faceId != null) {
    bits.push(`clicked face: ${surfaceName(pk.surface)}${pk.area != null ? `, ${pk.area.toFixed(1)} mm²` : ''}, point (${pk.point.map((v) => v.toFixed(1)).join(', ')}) mm`);
  }
  return `[Selection: ${bits.join(', ')}] `;
}

function errorText(): string | null {
  const e = buildStatus.state === 'error' ? buildStatus.result?.error : undefined;
  if (!e) return null;
  const where = e.file ? `${e.file}${e.line ? ` line ${e.line}` : ''}: ` : '';
  return `[Build error: ${where}${e.message.replace(/\s+/g, ' ').trim().slice(0, 400)}] `;
}

/** Fügt Text in die Eingabezeile des aktiven Terminals ein. Abschicken macht der Nutzer selbst (E11). `done` steht vor der Meldung. */
function insertToAgent(text: string | null, done?: string): void {
  if (!text) return;
  const pre = done ? `${done}\n` : '';
  // Immer auch in die Zwischenablage: Eine Agenten-App außerhalb der App (Claude Desktop, Codex-App) erreicht die Notiz nur so.
  // Ob im Terminal ein Agent läuft, lässt sich nicht für jeden Agenten verlässlich erkennen
  void api.copyText(text);
  if (!terminals.count) { toast(`${pre}Copied to the clipboard. Paste it into your agent, or start one with +.`, 'info'); return; }
  setAgentCollapsed(false);
  const title = terminals.insert(text);
  if (title) toast(`${pre}Added to the input of ${title}. Enter sends it. Also copied to the clipboard.`);
  else toast(`${pre}Copied to the clipboard. All terminals have ended, open a new one with +.`, 'info');
}

// ---- Messen (E9) ------------------------------------------------------------------------------------------------

const measureTool = new MeasureTool({
  card: $('measure-card'), body: $('measure-body'), button: $<HTMLButtonElement>('btn-measure'), close: $<HTMLButtonElement>('btn-measure-close'),
  again: $<HTMLButtonElement>('btn-measure-again'), agent: $<HTMLButtonElement>('btn-measure-agent'), viewerEl: $('viewer'),
}, {
  viewer,
  source: () => fileView.source ?? (versions.previewed ? { preview: versions.previewed.hash } : 'live'),
  build: () => map?.build ?? null,
  reload: () => void (fileView.active ? fileView.filesChanged() : loadModel()),
  part: (id) => partEntry(id),
  insert: (t) => insertToAgent(t),
});

// ---- Schnitt ----------------------------------------------------------------------------------------------------

const sectionTool = new SectionTool({
  card: $('section-card'), button: $<HTMLButtonElement>('btn-section'), close: $<HTMLButtonElement>('btn-section-close'),
  axes: $('section-axes'), label: $('section-label'), range: $<HTMLInputElement>('section-range'), value: $<HTMLInputElement>('section-value'),
  hint: $('section-hint'), flip: $<HTMLButtonElement>('btn-section-flip'), look: $<HTMLButtonElement>('btn-section-look'),
}, { viewer });

// ---- Zeichnungen (E76): Dokument „Drawings“ in der Code-Spalte, Ansichten und Maße in 3D --------------------------

const drawingLink = new DrawingLink({
  viewer, section: sectionTool,
  beforeShow: () => endOthers('drawing'),
  partIds: (names) => {
    const want = new Set(names);
    return viewer.partList().filter((p) => want.has(p.name) || want.has(p.id)).map((p) => p.id);
  },
  allIds: () => viewer.partList().map((p) => p.id),
  ready: () => viewer.partList().length > 0,
});
const drawingKey = (e: DrawingEntry) => `d:${e.id}:${e.built}`;
const drawingsView = () => code.pane(DRAWINGS_KEY) as DrawingsView | undefined;
const drawingsShown = () => codeOpen && code.activeFile === DRAWINGS_KEY;

/** Klick auf „Drawings“ an der Leiste: das Dokument zeigen, ist es schon vorne, die Code-Spalte schließen. */
function toggleDrawings(): void {
  if (drawingsShown()) { showCode(false); return; }
  // Blätter brauchen die Breite: Eine offene Seitenleiste geht zu, wie beim Wechsel zwischen ihren Reitern
  if (panel) showPanel(null);
  if (!codeOpen) { codeOpen = true; $('editor').hidden = false; $('split-code').hidden = false; renderLayout(); }
  code.openPane(DRAWINGS_KEY, 'Drawings', () => new DrawingsView({
    list: () => api.drawings.list(), build: (f) => api.drawings.build(f), readBinary: (rel) => api.fs.readBinary(rel),
    pdf: {
      quote: (file, pages, text) => {
        const cut = text.length > MAX_QUOTE;
        insertToAgent(`[Quote: ${file} p. ${pages}: "${cut ? `${text.slice(0, MAX_QUOTE)} …` : text}"] `, cut ? `Quote shortened to ${MAX_QUOTE} characters.` : undefined);
      },
      markPage: (file, page, canvas) => void markSource(`${file} p. ${page}`, canvas, canvas.width, canvas.height),
    },
    openCode: (file, line, label) => void openCode(file, line ? { from: line, to: line, label } : undefined),
    openFile: (rel) => void openCode(rel),
    insert: (t) => insertToAgent(t), toast, link: drawingLink,
    menu: $('menu-ctx'),
    exportFiles: async (what, sheet) => {
      const r = await api.drawings.export(what, sheet);
      if (r.cancelled) return;
      const name = (f: string) => f.split(/[\\/]/).pop() ?? f;
      const warn = r.warnings?.length ? `\n${r.warnings.join('\n')}` : '';
      if (!r.ok) toast(`Export failed: ${r.error}${warn}`, 'error');
      else if (r.files.length === 1) toast(`Exported:\n${r.target ?? r.files[0]}${warn}`, warn ? 'info' : 'ok');
      else toast(`${r.files.length} files exported to ${r.target ?? ''}:\n${r.files.map(name).join(', ')}${warn}`, warn ? 'info' : 'ok');
    },
    isNew: (e) => !seen.has(drawingKey(e)), seen: (e) => { seen.add(drawingKey(e)); },
    listed: (list) => { viewLists.drawings = list.drawings; renderResults(); },
  }));
  renderResults();
}

/** Knopf an der Leiste: gedrückt, solange das Dokument vorne in der offenen Code-Spalte steht. */
function renderDrawingsRail(): void {
  $('btn-rail-drawings').setAttribute('aria-pressed', String(drawingsShown()));
}
$('btn-rail-drawings').addEventListener('click', () => toggleDrawings());

// ---- Explosionsansicht (E56) ----------------------------------------------------------------------------------------

/** Ladeanzeige über dem Viewer, solange die Explosion rechnet. */
const busy = new Busy();
const explodeTool = new ExplodeTool({
  card: $('explode-card'), button: $<HTMLButtonElement>('btn-explode'), close: $<HTMLButtonElement>('btn-explode-close'),
  range: $<HTMLInputElement>('explode-range'), value: $('explode-value'), hint: $('explode-hint'),
  trails: $<HTMLButtonElement>('btn-explode-trails'), fit: $<HTMLButtonElement>('btn-explode-fit'), viewerEl: $('viewer'),
  back: $<HTMLButtonElement>('btn-explode-back'), play: $<HTMLButtonElement>('btn-explode-play'), next: $<HTMLButtonElement>('btn-explode-next'),
  step: $('explode-step'), send: $<HTMLButtonElement>('btn-explode-agent'),
}, {
  viewer,
  busy,
  insert: (t) => insertToAgent(t),
  beforeOn: () => { if (measureTool.isActive) measureTool.setActive(false); },
  settled: () => sectionTool.refresh(), // der Bereich des Schiebers folgt den verschobenen Bauteilen
});
// Gemessen wird in Einbaulage (die exakte Geometrie kennt keine Explosion): Messen setzt das Modell sofort zusammen.
// Nach dem Knopf-Handler von MeasureTool registriert, isActive ist hier schon umgeschaltet.
$('btn-measure').addEventListener('click', () => { if (measureTool.isActive) explodeTool.setActive(false, false); });

// ---- Markierung (E16) -------------------------------------------------------------------------------------------

const markup = new Markup({
  viewer: $('viewer'), layer: $('markup'), canvas: $<HTMLCanvasElement>('mark-canvas'), text: $<HTMLInputElement>('mark-text'),
  hint: $('mark-hint'), tools: $('mark-tools'), undo: $<HTMLButtonElement>('btn-mark-undo'), del: $<HTMLButtonElement>('btn-mark-delete'),
  blank: $<HTMLButtonElement>('btn-mark-blank'), grid: $<HTMLButtonElement>('btn-mark-grid'), colorBtn: $<HTMLButtonElement>('btn-mark-color'), colorSwatch: $('mark-color-sw'),
  palette: $('menu-mark-color'), custom: $<HTMLInputElement>('mark-color-custom'),
});

/** Friert die Ansicht ein, wie sie gerade ist (auch als Vorschau eines alten Stands, nur ohne Auswahl). Ohne Modell: leere Fläche. */
function startMarkup(): void {
  if (!project || markup.active) return;
  menus.close();
  markup.open(viewer.partList().length ? viewer.snapshot() : null);
}

/** Größte Kantenlänge der Zeichenfläche in Gerätepixeln: Große Fotos bleiben scharf, ohne dass die Fläche ausufert. */
const MARK_MAX_PX = 8192;

/**
 * Öffnet ein Bild aus dem Projekt als Hintergrund der Markierung. Die Zeichenfläche hat das Seitenverhältnis des Viewers,
 * das Bild wird unverzerrt eingepasst und behält seine Auflösung (so lesen Agenten auch feine Details einer Skizze).
 */
async function markImage(rel: string): Promise<void> {
  if (!project || !(await mayReplaceMarkup(rel))) return;
  let img: HTMLImageElement, url: string;
  try { url = await imageUrl(rel); } catch (e) { toast(`${rel} cannot be read: ${e instanceof Error ? e.message : String(e)}`, 'error'); return; }
  try {
    img = new Image();
    img.src = url;
    await img.decode();
  } catch {
    toast(`${rel} could not be loaded as an image. Right-click: “Open with default app”.`, 'error');
    return;
  } finally { URL.revokeObjectURL(url); }
  // SVG ohne Größenangabe meldet 0: dann einfach in Viewergröße
  const view = $('viewer');
  await markSource(rel, img, img.naturalWidth || view.clientWidth, img.naturalHeight || view.clientHeight, false);
}

/** Von Bild zu Bild wechseln geht direkt. Nur eine angefangene Zeichnung wird nicht still verworfen. */
async function mayReplaceMarkup(source: string): Promise<boolean> {
  menus.close();
  if (!markup.active) return true;
  if (markup.source === source) return false;
  if (!markup.drawn) return true;
  const c = await api.dialog.choose({ title: 'Markup', message: 'The open markup has not been sent to the agent yet.', detail: `Discard it and open ${source}?`, buttons: ['Discard and switch', 'Cancel'] });
  return c === 0;
}

/** Bild (Datei oder PDF-Seite) unverzerrt in eine Zeichenfläche im Seitenverhältnis des Viewers einpassen und öffnen. */
async function markSource(label: string, img: CanvasImageSource, iw: number, ih: number, ask = true): Promise<void> {
  if (!project || (ask && !(await mayReplaceMarkup(label)))) return;
  const view = $('viewer'), w = view.clientWidth, h = view.clientHeight;
  if (!w || !h || !iw || !ih) return;
  const scale = Math.min(Math.max(window.devicePixelRatio || 1, iw / w, ih / h), MARK_MAX_PX / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  const g = c.getContext('2d')!;
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--s2').trim() || '#1b1e23';
  g.fillRect(0, 0, c.width, c.height);
  const f = Math.min(c.width / iw, c.height / ih);
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, (c.width - iw * f) / 2, (c.height - ih * f) / 2, iw * f, ih * f);
  markup.close();
  markup.open(c, label);
}

async function sendMarkup(): Promise<void> {
  const btn = $<HTMLButtonElement>('btn-mark-send');
  if (btn.disabled || !markup.active) return;
  btn.disabled = true;
  try {
    const r = await api.fs.saveFeedback(await markup.image());
    // Ging das Speichern schief, bleibt die Zeichnung offen: Nichts geht verloren, der Nutzer kann es noch einmal versuchen
    if (!r.ok || !r.path) { toast(`The markup could not be saved: ${r.error ?? 'unknown error'}`, 'error'); return; }
    const old = versions.previewed, source = markup.source, shownFile = fileView.rel;
    markup.close();
    void refreshFiles(); // die neue Markierung steht gleich im Dateibaum
    // Zeigt das Bild einen alten Stand, einen Schnitt oder eine Explosion, soll der Agent das wissen (sonst vergleicht er es mit dem
    // aktuellen Code, hält die Schnittfläche für eine echte Fläche oder die auseinandergezogenen Teile für ihre Lage)
    // Auf einem Bild aus dem Projekt gezeichnet: Der Agent soll das Original kennen, Stand und Schnitt spielen dann keine Rolle
    const cut = [sectionTool.agentText(), explodeTool.agentText(), animTool.agentText(), resultTool.agentText()].filter(Boolean).join(', ');
    const note = source ? `, drawn on ${source}`
      : (old ? `, shows the older version ${old.short} "${old.subject.slice(0, 80)}"` : '')
        + (shownFile ? `, shows the STEP file ${shownFile}, not the model` : '') + (cut ? `, ${cut}` : '');
    insertToAgent(`[Markup: ${r.path}${note}] `, `Markup saved: ${r.path}`);
  } catch (e) {
    toast(`The markup could not be saved: ${e instanceof Error ? e.message : String(e)}`, 'error');
  } finally { btn.disabled = false; }
}

// ---- Animation, Analyse und Video (E58) -----------------------------------------------------------------------------

const resultLayer = new ResultLayer(viewer);
/** Zeigt der Viewer gerade eine Analyse oder Animation, sagen es Reiter, Baum und die Leiste unten im Bild (E82). */
/** Messen, Explosion, Animation und Analyse schließen sich aus: Jedes braucht das Modell in seiner eigenen Lage. */
const endOthers = (keep: 'measure' | 'explode' | 'anim' | 'result' | 'drawing') => {
  if (keep !== 'drawing') drawingLink.release();
  if (keep !== 'measure' && measureTool.isActive) measureTool.setActive(false);
  if (keep !== 'explode' && explodeTool.isActive) explodeTool.setActive(false, false);
  if (keep !== 'anim') animTool.setActive(false);
  if (keep !== 'result') resultTool.setActive(false);
};
const animTool = new AnimTool({
  bar: $('anim-bar'), close: $<HTMLButtonElement>('btn-anim-close'),
  play: $<HTMLButtonElement>('btn-anim-play'), range: $<HTMLInputElement>('anim-range'), time: $('anim-time'), total: $('anim-total'), ticks: $('anim-ticks'),
  loop: $<HTMLButtonElement>('btn-anim-loop'), follow: $<HTMLButtonElement>('btn-anim-follow'), texts: $<HTMLButtonElement>('btn-anim-texts'),
  speed: $<HTMLSelectElement>('anim-speed'), viewerEl: $('viewer'),
}, {
  viewer, list: () => api.anim.list(), build: (f) => api.anim.build(f), readBinary: (rel) => api.fs.readBinary(rel), renderVideo: (id) => api.render.video(id),
  beforeOn: () => endOthers('anim'), insert: (t) => insertToAgent(t), toast,
  showVideo: (rel) => { void refreshFiles(); seen.add(videoKey(rel)); scheduleViewLists(); void videoView.open(rel); },
  changed: () => renderResults(),
  tick: () => animPanel.tick(),
});
const resultTool = new ResultTool({
  legend: $('result-legend'), legendTitle: $('result-q'), legendBody: $('result-lg-body'), scaleBtn: $<HTMLButtonElement>('btn-result-scale'), scaleMode: $('result-scale-mode'),
  scaleMenu: $('menu-scale'), legendFull: $('result-q-full'), legendFoot: $('result-lg-foot'),
  range: $('result-range'), custom: $('result-custom'), lo: $<HTMLInputElement>('result-lo'), hi: $<HTMLInputElement>('result-hi'),
  bar: $('result-bar'), field: $('result-field'), deform: $('result-deform'), deformLabel: $('result-deform-label'), bcs: $<HTMLButtonElement>('btn-result-bcs'),
  name: $('result-name'), close: $<HTMLButtonElement>('btn-result-close'), viewerEl: $('viewer'),
}, {
  layer: resultLayer, viewer, list: () => api.results.list(), rerun: (id) => api.results.rerun(id), readBinary: (rel) => api.fs.readBinary(rel),
  beforeOn: () => endOthers('result'), toast,
  changed: () => renderResults(),
});
const analysisPanel = new AnalysisPanel({
  list: $('an-list'), listCount: $('an-count'), rows: $('an-rows'),
  report: $('an-report'), back: $<HTMLButtonElement>('btn-an-back'), backCount: $('an-back-count'), code: $<HTMLButtonElement>('btn-an-code'),
  more: $<HTMLButtonElement>('btn-an-more'), body: $('an-body'), pick: $('an-pick'), rerun: $<HTMLButtonElement>('btn-result-rerun'),
  agent: $<HTMLButtonElement>('btn-result-agent'), menu: $('menu-ctx'),
}, {
  tool: resultTool, insert: (t) => insertToAgent(t), openCode: (f) => void openCode(f),
  copy: (t) => void navigator.clipboard.writeText(t).then(() => toast(`Copied: ${t}`), (e) => toast(`Could not copy: ${e instanceof Error ? e.message : String(e)}`, 'error')),
  isNew: (r) => !seen.has(resultKey(r)), seen: (r) => { seen.add(resultKey(r)); },
});
const animPanel = new AnimPanel({
  list: $('am-list'), listCount: $('am-count'), rows: $('am-rows'),
  report: $('am-report'), back: $<HTMLButtonElement>('btn-am-back'), backCount: $('am-back-count'), code: $<HTMLButtonElement>('btn-am-code'),
  body: $('am-body'), video: $<HTMLButtonElement>('btn-anim-video'), agent: $<HTMLButtonElement>('btn-anim-agent'),
}, {
  tool: animTool, videos: () => viewLists.videos, openVideo: (rel) => void videoView.open(rel),
  openCode: (file, line) => void openCode(file, line ? { from: line, to: line, label: animTool.currentName ?? 'Animation' } : undefined),
  insert: (t) => insertToAgent(t), isNew: (k) => !seen.has(k), seen: (k) => { seen.add(k); },
});
// Messen und Explosion schalten die beiden aus, bevor sie selbst anfangen (Lauscher in der Erfassungsphase laufen vor denen
// der Werkzeuge): Beide rechnen mit der Einbaulage
for (const [id, isOn] of [['btn-measure', () => measureTool.isActive], ['btn-explode', () => explodeTool.isActive]] as const) {
  $(id).addEventListener('click', () => { if (!isOn()) { animTool.setActive(false); resultTool.setActive(false); } }, true);
}
const videoView = new VideoView({
  root: $('videoview'), video: $<HTMLVideoElement>('video-el'), title: $('video-title'), play: $<HTMLButtonElement>('btn-video-play'),
  back: $<HTMLButtonElement>('btn-video-back'), fwd: $<HTMLButtonElement>('btn-video-fwd'), range: $<HTMLInputElement>('video-range'), time: $('video-time'),
  mark: $<HTMLButtonElement>('btn-video-mark'), agent: $<HTMLButtonElement>('btn-video-agent'), close: $<HTMLButtonElement>('btn-video-close'),
}, {
  readBinary: (rel) => api.fs.readBinary(rel), insert: (t) => insertToAgent(t), toast,
  markFrame: (label, c) => markSource(label, c, c.width, c.height),
});

$('btn-mark').addEventListener('click', startMarkup);
$('btn-mark-cancel').addEventListener('click', () => markup.close());
$('btn-mark-send').addEventListener('click', () => void sendMarkup());

/**
 * Rechtsklick auf ein Teil (Baum oder Bild). Ist es Teil einer Mehrfachauswahl, gilt das Menü für alle. Sonst wird es
 * ausgewählt, wie in CAD üblich. Die Tasten stehen daneben.
 */
function openPartMenu(id: string, x: number, y: number): void {
  if (picked.length > 1 && picked.includes(id)) { openSelectionMenu(x, y); return; }
  if (selection?.partId !== id) selectPart(id, null);
  const e = partEntry(id);
  const visible = viewer.isVisible(id);
  const ghost = viewer.isGhosted(id);
  const m = $('menu-ctx');
  const items: (HTMLElement | null)[] = [
    el('div', { className: 'mh', textContent: e?.name ?? partInfo(id)?.name ?? id }),
    menuItem('Isolate', { icon: 'target', kbd: 'I', onClick: () => { viewer.isolate(id); refreshTree(); } }),
    viewer.hiddenCount ? menuItem('Show all', { icon: 'eye', kbd: 'Shift H', onClick: () => { viewer.showAll(); refreshTree(); } }) : null,
    menuItem(visible ? 'Hide' : 'Show', { icon: visible ? 'eyeoff' : 'eye', kbd: visible ? 'H' : '', onClick: () => { viewer.setVisible(id, !visible); refreshTree(); } }),
    menuItem(ghost ? 'Not transparent' : 'Transparent', { icon: 'ghost', kbd: 'T', onClick: () => { viewer.setGhosted(id, !ghost); refreshTree(); } }),
    menuItem('Zoom to part', { icon: 'fit', onClick: () => viewer.focusPart(id) }),
    el('div', { className: 'msep' }),
    menuItem('Show code', { icon: 'code', disabled: !e?.file, onClick: () => { selectPart(id, null); if (e?.file && e.line) void openCode(e.file, { ...lineRange(e), label: e.name, color: partInfo(id)?.color }); } }),
    menuItem('Send to agent', { icon: 'send', onClick: () => { selectPart(id, null); insertToAgent(selectionText()); } }),
    menuItem('Export …', { icon: 'export', onClick: () => { selectPart(id, null); exportScope = 'sel'; openExportMenu(); } }),
  ];
  m.replaceChildren(...items.filter((x): x is HTMLElement => !!x));
  menus.at(m, x, y);
}

/** Rechtsklick auf eine Gruppe: dasselbe für alle ihre Teile. */
function openGroupMenu(ids: string[], name: string, x: number, y: number): void {
  const anyVisible = ids.some((id) => viewer.isVisible(id));
  const allGhost = ids.every((id) => viewer.isGhosted(id));
  const m = $('menu-ctx');
  const items: (HTMLElement | null)[] = [
    el('div', { className: 'mh', textContent: `${name} · ${ids.length} part${ids.length === 1 ? '' : 's'}` }),
    menuItem('Isolate', { icon: 'target', onClick: () => { viewer.isolate(ids); refreshTree(); } }),
    viewer.hiddenCount ? menuItem('Show all', { icon: 'eye', kbd: 'Shift H', onClick: () => { viewer.showAll(); refreshTree(); } }) : null,
    menuItem(anyVisible ? 'Hide' : 'Show', { icon: anyVisible ? 'eyeoff' : 'eye', onClick: () => { viewer.setVisible(ids, !anyVisible); refreshTree(); } }),
    menuItem(allGhost ? 'Not transparent' : 'Transparent', { icon: 'ghost', onClick: () => { viewer.setGhosted(ids, !allGhost); refreshTree(); } }),
    menuItem('Zoom to group', { icon: 'fit', onClick: () => viewer.setView('fit', ids) }),
  ];
  m.replaceChildren(...items.filter((x): x is HTMLElement => !!x));
  menus.at(m, x, y);
}

/** Rechtsklick auf mehrere ausgewählte Teile: Isolieren, Ausblenden, Transparent für alle. */
function openSelectionMenu(x: number, y: number): void {
  const ids = [...picked];
  const allGhost = ids.every((id) => viewer.isGhosted(id));
  const m = $('menu-ctx');
  const items: (HTMLElement | null)[] = [
    el('div', { className: 'mh', textContent: `${ids.length} parts selected` }),
    menuItem(`Isolate ${ids.length} parts`, { icon: 'target', kbd: 'I', onClick: () => selectionAction('isolate') }),
    menuItem(`Hide ${ids.length} parts`, { icon: 'eyeoff', kbd: 'H', onClick: () => selectionAction('hide') }),
    viewer.hiddenCount ? menuItem('Show all', { icon: 'eye', kbd: 'Shift H', onClick: () => selectionAction('showAll') }) : null,
    menuItem(allGhost ? 'Not transparent' : 'Transparent', { icon: 'ghost', kbd: 'T', onClick: () => selectionAction('ghost') }),
    menuItem('Zoom to selection', { icon: 'fit', onClick: () => viewer.setView('fit', ids) }),
    el('div', { className: 'msep' }),
    menuItem('Send to agent', { icon: 'send', onClick: () => insertToAgent(selectionText()) }),
    menuItem('Clear selection', { icon: 'x', kbd: 'Esc', onClick: () => selectPart(null, null) }),
  ];
  m.replaceChildren(...items.filter((x): x is HTMLElement => !!x));
  menus.at(m, x, y);
}

/** Rechtsklick ins Bild neben das Modell: alles einblenden, Auswahl aufheben. Ohne beides kein Menü. */
function openViewerMenu(x: number, y: number): void {
  const items: HTMLElement[] = [];
  if (viewer.hiddenCount) items.push(menuItem('Show all', { icon: 'eye', kbd: 'Shift H', onClick: () => selectionAction('showAll') }));
  if (picked.length) items.push(menuItem('Clear selection', { icon: 'x', kbd: 'Esc', onClick: () => selectPart(null, null) }));
  if (!items.length) return;
  $('menu-ctx').replaceChildren(...items);
  menus.at($('menu-ctx'), x, y);
}

/**
 * Was die Tasten H, Shift H, I und T tun (auch aus den Menüs). Ausgeblendete Teile verlassen die Auswahl, sonst wirkte die
 * nächste Taste auf Unsichtbares.
 */
function selectionAction(a: 'hide' | 'showAll' | 'isolate' | 'ghost'): void {
  const ids = [...picked];
  if (a === 'showAll') viewer.showAll();
  else if (!ids.length) { toast('Select parts first: click in the model or the tree, Ctrl or Shift for more, Alt + drag for a box.', 'info'); return; }
  else if (a === 'hide') { viewer.setVisible(ids, false); selectPart(null, null); }
  else if (a === 'isolate') viewer.isolate(ids);
  else viewer.setGhosted(ids, !ids.every((id) => viewer.isGhosted(id)));
  refreshTree();
}

// Tasten für die Auswahl (wie in CAD): H ausblenden, Shift H alles einblenden, I isolieren, T transparent, Esc Auswahl aufheben.
// Nicht beim Schreiben (Code, Terminal, Felder) und nicht, solange Markierung, Video, Einstellungen oder die Startseite offen sind
window.addEventListener('keydown', (e) => {
  if (!project || e.ctrlKey || e.altKey || e.metaKey || e.repeat || settings.isOpen || help.isOpen || !$('start').hidden) return;
  if ((e.target as HTMLElement | null)?.closest?.('#terminals, #code-view, input, textarea, select, [contenteditable=true]')) return;
  if (markup.active || !$('videoview').hidden) return;
  const k = e.key.toLowerCase();
  if (k === 'h' && e.shiftKey) selectionAction('showAll');
  else if (e.shiftKey) return;
  else if (k === 'h') selectionAction('hide');
  else if (k === 'i') selectionAction('isolate');
  else if (k === 't') selectionAction('ghost');
  // Escape gehört zuerst Menüs und Werkzeugen (Messen, Schnitt mit Flächenwahl, Ladeanzeige): nur ohne sie die Auswahl aufheben
  else if (e.key === 'Escape' && picked.length && !e.defaultPrevented && !measureTool.isActive && $('viewer-busy').hidden) selectPart(null, null);
  else return;
  e.preventDefault();
});

// ---- Build und Modell -------------------------------------------------------------------------------------------

/** Zuletzt gezeigter Fehler der Projektumgebung (E67): als Hinweis nur einmal. */
let shownPackageError = '';

function renderBuild(s: BuildStatus): void {
  buildStatus = s;
  if (s.state === 'ok') lastOkAt = s.builtAt ?? Date.now();
  if (s.state === 'error') errorAt = Date.now();
  const dot = $('build-dot'), main = $('status'), detail = $('status-detail');
  $('build-pill').classList.toggle('err', s.state === 'error' && !s.stale);
  $('btn-cancel').hidden = s.state !== 'building' || !!s.installing;
  $('btn-buildnow').hidden = !(s.stale && s.state !== 'building');
  const count = s.result?.parts?.length ?? 0;
  const secs = s.seconds ?? 0;
  dot.replaceChildren();
  dot.className = 'dot';
  dot.style.background = '';
  if (s.packageError && s.packageError !== shownPackageError) toast(s.packageError, 'error');
  shownPackageError = s.packageError ?? '';
  if (s.installing) {
    dot.className = 'spin';
    dot.append(icon('spin', 14, 2.4));
    main.textContent = 'Installing packages …';
    detail.textContent = s.installing.join(', ');
  } else if (s.state === 'building') {
    dot.className = 'spin';
    dot.append(icon('spin', 14, 2.4));
    main.textContent = 'Building …';
    detail.textContent = s.queued ? 'another build queued' : '';
  } else if (s.stale) {
    main.textContent = 'Code changed';
    detail.textContent = 'Auto build is off';
  } else if (s.state === 'ok') {
    dot.style.background = 'var(--ok)';
    main.textContent = 'Built';
    detail.textContent = `${count} part${count === 1 ? '' : 's'} · ${num(secs)} s`;
  } else if (s.state === 'error') {
    const e = s.result?.error;
    dot.style.background = 'var(--err)';
    main.textContent = 'Build failed';
    detail.textContent = e?.file ? `${e.file}${e.line ? `, line ${e.line}` : ''}` : ERROR_KIND[e?.kind ?? ''] ?? '';
  } else {
    main.textContent = 'Ready';
    detail.textContent = '';
  }
  void renderErrorCard();
}

async function renderErrorCard(): Promise<void> {
  const s = buildStatus;
  const e = s.state === 'error' && !showsOther() ? s.result?.error : undefined;
  const hasModel = viewer.partList().length > 0;
  $('viewer').classList.toggle('dim', !!e && hasModel);
  $('lastgood').hidden = !(e && hasModel && lastOkAt);
  if (lastOkAt) $('lastgood').textContent = `Last good version · ${fmtWhen(lastOkAt)}`;
  const card = $('errcard');
  if (!e) { card.hidden = true; return; }
  $('err-where').textContent = `${e.file ? `${e.file}${e.line ? `, line ${e.line}` : ''}` : ERROR_KIND[e.kind] ?? e.kind} · ${fmtWhen(errorAt)}`;
  $('err-msg').textContent = e.message;
  $('err-trace').textContent = e.traceback;
  $<HTMLButtonElement>('btn-err-details').disabled = !e.traceback;
  $<HTMLButtonElement>('btn-err-code').disabled = !e.file;
  card.hidden = false;
  const pc = $('err-code');
  pc.hidden = true;
  if (e.file && e.line) {
    try {
      const src = (await readText(e.file)).split(/\r?\n/);
      const a = Math.max(1, e.line - 1), b = Math.min(src.length, e.line + 2);
      pc.replaceChildren(...codeRows(src.slice(a - 1, b), a, { from: e.line, to: e.line, kind: 'er' }));
      pc.hidden = false;
    } catch { /* Datei nicht lesbar: Meldung reicht */ }
  }
}

/** Der Viewer zeigt gerade nicht das Modell, sondern einen alten Stand oder eine STEP-Datei: Builds warten. */
const showsOther = () => versions.previewing || fileView.active;

async function loadModel(): Promise<void> {
  if (showsOther()) return; // während einer Vorschau oder Dateiansicht bleibt deren Bild stehen
  const seq = ++loadSeq;
  const msg = $('viewer-msg');
  try {
    const [mapText, glb] = await Promise.all([api.fs.readText('.soma/model.map.json'), api.fs.readBinary('.soma/model.glb')]);
    if (seq !== loadSeq) return; // neuerer Build ist schon unterwegs
    map = JSON.parse(mapText) as ModelMap;
    textCache.clear();
    await viewer.load(glb);
    measureTool.reset(); // neuer Build: die Nummern der Flächen und Kanten gelten nicht mehr
    explodeTool.refresh(); // vor dem Schnitt: Dessen Bereich hängt von der Lage der Bauteile ab
    animTool.modelChanged(); // neue Bauteile: Lagen erneut anwenden, eine veraltete Animation neu bauen lassen
    if (resultTool.isActive) void resultTool.refresh();
    sectionTool.refresh();
    msg.className = ''; msg.textContent = '';
    refreshTree();
    // Flächen-IDs gelten nur für einen Build: nach dem Neuladen bleibt das Bauteil gewählt, die Fläche nicht
    // Mehrfachauswahl: was es nach dem Build noch gibt
    const still = picked.filter((id) => partInfo(id));
    if (selection && !partInfo(selection.partId)) setPicked(still, still.at(-1) ?? null);
    else if (selection) { selection.pick = null; setPicked(still, selection.partId); }
    void renderErrorCard();
    scheduleThumb();
  } catch (e) {
    msg.className = 'error';
    msg.textContent = `The model could not be loaded: ${e instanceof Error ? e.message : String(e)}`;
  }
}

let thumbTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleThumb(): void {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => {
    if (showsOther()) return;
    const url = viewer.thumbnail();
    if (url) void api.project.setThumb(url).catch(() => { /* Vorschaubild ist verzichtbar */ });
  }, 1500);
}

const versions = new VersionsBar({
  dots: $('vdots'), info: $('vinfo'), problem: $('vproblem'), restore: $<HTMLButtonElement>('btn-restore'), live: $<HTMLButtonElement>('btn-live'),
  banner: $('preview-banner'), bannerTitle: $('bn-title'), bannerSub: $('bn-sub'), viewer: $('viewer'),
}, {
  async show(res: PreviewResult | null, restored = false) {
    // Nach dem Wiederherstellen bleibt das Bild der Vorschau stehen, bis der Build danach fertig ist (er lädt dann wie jeder
    // Build von selbst). Sonst wäre so lange wieder der vorherige Build zu sehen, bei großen Modellen viele Sekunden. Braucht
    // der Stand erst Pakete (E67), kommt der Build nach der Installation.
    if (!res && restored && (buildStatus.state === 'building' || buildStatus.installing)) return;
    if (!res) { await loadModel(); return; }
    // Eine offene STEP-Datei macht der Vorschau Platz, ohne dazwischen das Modell zu laden
    if (fileView.active) { fileView.drop(); tree.setTitle(project?.name ?? ''); }
    await showForeign(res.glb, res.map, 'The preview');
  },
  toast,
  beforeRestore: () => leaveEditor('Restore version'), // Wiederherstellen ersetzt Dateien
});

/**
 * Zeigt einen fremden Stand (Vorschau eines alten Stands oder STEP-Datei) im Viewer. Animation und Analyse gehören zum
 * Modell und gehen aus, Messen, Explosion und Schnitt fangen auf dem neuen Bild von vorn an.
 */
async function showForeign(glb: ArrayBuffer, m: ModelMap, what: string): Promise<void> {
  loadSeq++; // ein noch laufendes Laden des Modells soll das Bild nicht überschreiben
  animTool.setActive(false);
  resultTool.setActive(false);
  try {
    map = m;
    textCache.clear();
    await viewer.load(glb);
    measureTool.reset();
    explodeTool.refresh();
    sectionTool.refresh();
    refreshTree();
    selectPart(null, null);
    void renderErrorCard();
  } catch (e) { toast(`${what} cannot be shown: ${e instanceof Error ? e.message : String(e)}`, 'error'); }
  renderResults();
}

const fileView = new FileView({
  banner: $('file-banner'), title: $('fb-title'), sub: $('fb-sub'), back: $<HTMLButtonElement>('btn-file-back'), viewer: $('viewer'),
}, {
  async show(res) {
    if (!res) { tree.setTitle(project?.name ?? ''); await loadModel(); return; }
    tree.setTitle(fileView.title ?? '');
    await showForeign(res.glb, res.map, 'The file');
  },
  beforeShow: () => versions.endPreview(),
  busy: (title, cancel) => busy.show(title, cancel),
  toast,
});

// ---- Projekt ----------------------------------------------------------------------------------------------------

async function onProject(p: ProjectInfo): Promise<void> {
  project = p;
  // Ein anderes Modell geöffnet (Menü, Startseite): Die Tour gehört zum Tutorial-Modell und endet
  if (tour.active && p.id !== tourProject) tour.stop(false, false);
  loadSeq++; // laufende Ladevorgänge des vorherigen Projekts verwerfen
  map = null;
  lastOkAt = null;
  textCache.clear();
  markup.close();
  if (measureTool.isActive) measureTool.setActive(false);
  sectionTool.setActive(false);
  explodeTool.setActive(false, false);
  animTool.setActive(false);
  resultTool.setActive(false);
  videoView.close();
  viewer.clear();
  versions.reset();
  fileView.drop();
  tree.setTitle(p.name);
  terminals.closeAll();
  code.reset();
  skills.reset();
  if (panel === 'skills') void skills.refresh();
  paramsPanel.reset();
  if (panel === 'params') void paramsPanel.refresh();
  if (codeOpen) void code.open(p.entry); // die Code-Spalte bleibt offen, dann nicht leer
  // Ordner-Modus: Der Ordner ist das Modell (kein Speichern als .soma), den Verlauf gibt es nur zum Ansehen
  versions.setReadOnly(p.folder);
  $('btn-save').hidden = $('btn-saveas').hidden = p.folder;
  resetViewLists();
  applyDisplayDefaults();
  selection = null;
  picked = [];
  void renderSelection();
  tree.message('Building the model …');
  $('doc-name').textContent = p.name;
  document.title = `SOMA – ${p.name}`;
  $<HTMLInputElement>('chk-auto').checked = p.autoBuild;
  renderAuto();
  showProblems(p.problems);
  filesDirty = true;
  if (panel === 'files') void refreshFiles();
  void versions.refresh();
  void refreshSaveState();
  void terminals.add({ title: 'Terminal' });
  void refreshAgents();
  const st = await api.build.status();
  renderBuild(st);
  if (st.state === 'ok') void loadModel();
}

function showProblems(problems: string[]): void {
  const b = $('problems');
  b.hidden = problems.length === 0;
  b.replaceChildren(icon('alert', 14, 2), `${problems.length} issue${problems.length === 1 ? '' : 's'}`);
  b.title = problems.join('\n');
  $('problem-list').replaceChildren(...problems.map((p) => el('div', { className: 'problem' }, el('span', { className: 'pi' }, icon('alert', 16)), el('span', { textContent: p }))));
}

async function refreshAgents(): Promise<void> {
  try { agents = await api.agents.detect(); } catch { agents = []; }
}

// ---- Speichern und Öffnen ---------------------------------------------------------------------------------------

function renderSaveState(st: SaveState): void {
  saveState = st;
  const dot = el('span', { className: 'dot' });
  let text: string;
  // Ungespeichertes im Editor zählt mit, auch wenn die Dateien auf der Platte dem gespeicherten Stand entsprechen
  const unsaved = st.unsaved || code.unsaved().length > 0;
  if (project?.folder) { dot.style.background = unsaved ? 'var(--warn)' : 'var(--ok)'; text = unsaved ? 'Folder · unsaved edits' : 'Folder'; }
  else if (!st.zipPath) { dot.style.background = 'var(--warn)'; text = 'Not saved yet'; }
  else if (unsaved) { dot.style.background = 'var(--warn)'; text = `Not saved${st.savedAt ? ` · last ${fmtWhen(st.savedAt)}` : ''}`; }
  else { dot.style.background = 'var(--ok)'; text = `Saved${st.savedAt ? ` · ${fmtWhen(st.savedAt)}` : ''}`; }
  const b = $('save-badge');
  b.replaceChildren(dot, text);
  b.title = project?.folder ? `Folder: ${project.dir}\nChanges are saved in the folder itself.` : st.zipPath ? `File: ${st.zipPath}` : 'Not saved yet. Ctrl+S saves.';
  versions.setSaved(st.zipPath ? st.savedHead : null);
  document.title = `SOMA – ${project?.name ?? ''}${unsaved ? ' ●' : ''}`;
}

async function refreshSaveState(): Promise<void> {
  try { renderSaveState(await api.project.saveState()); } catch { /* Projekt wechselt gerade */ }
}

/**
 * Strg+S im Editor und „Speichern und bauen“: geänderte Dateien schreiben. Gebaut wird nur, wenn darunter eine ist,
 * die das Modell betrifft (Python, inputs/). Keine Modelldatei, kein Snapshot, das macht „Speichern“ oben.
 */
async function saveCode(): Promise<void> {
  const r = await code.saveAll();
  if (!r.ok) { toast('Not everything could be saved (see the note in the code). The build waits until then.', 'error'); return; }
  if (r.saved.some(affectsBuild)) await api.build.run();
}

/** Vor Modellwechsel und Wiederherstellen: ungespeicherte Eingaben im Editor nicht still verlieren. false = abbrechen. */
async function leaveEditor(title: string): Promise<boolean> {
  const files = code.unsaved();
  if (!files.length) return true;
  const c = await api.dialog.choose({
    title, message: `The editor has unsaved changes: ${files.join(', ')}.`,
    detail: 'Discard keeps your version as a backup in the app data.', buttons: ['Save', 'Discard', 'Cancel'],
  });
  if (c === 0) {
    const r = await code.saveAll();
    if (!r.ok) toast('Not everything could be saved (see the note in the code panel).', 'error');
    return r.ok;
  }
  return c === 1 ? code.discardAll() : false;
}

let saving = false;
/**
 * Speichern kann dauern (ein laufender oder veralteter Build wird abgewartet, dann Snapshot und .soma-Datei): Der Knopf zeigt das
 * sofort, weitere Klicks und Strg+S zählen solange nicht.
 */
async function doSave(saveAs = false): Promise<void> {
  if (saving) return;
  // Ordner-Modus: Strg+S schreibt nur die Eingaben im Editor in den Ordner, eine .soma-Datei gibt es nicht
  if (project?.folder) {
    const c = await code.saveAll();
    if (!c.ok) toast('Not everything in the editor could be saved (see the note in the code).', 'error');
    else if (c.saved.length) { toast(`Saved in the folder: ${c.saved.join(', ')}`, 'ok'); if (c.saved.some(affectsBuild)) await api.build.run(); }
    else toast('Nothing to save. This model is the folder itself. Export › Everything as ZIP makes a copy as a file.', 'info');
    void refreshSaveState();
    return;
  }
  saving = true;
  const btn = $<HTMLButtonElement>('btn-save');
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.classList.add('busy');
  btn.replaceChildren(el('span', { className: 'spin' }, icon('spin', 14, 2.4)), 'Saving …');
  try {
    // Erst die Eingaben im Editor, sonst fehlten sie in Snapshot und Datei. Das Speichern baut danach, falls nötig.
    const c = await code.saveAll();
    if (!c.ok) { toast('Not everything in the editor could be saved (see the note in the code). So the model is not saved.', 'error'); return; }
    const r = await api.project.save(saveAs);
    if (r.cancelled) return;
    if (r.error) { toast(r.error, 'error'); return; }
    const kb = Math.round((r.bytes ?? 0) / 1024);
    const lines = [`Saved: ${r.zipPath}`, `${r.files} file${r.files === 1 ? '' : 's'}, ${kb} KB${r.snapshot ? ' · snapshot added to the history' : ''}`];
    if (r.warnings?.length) lines.push(`Note: ${r.warnings.join(' ')}`);
    toast(lines.join('\n'), r.warnings?.length ? 'error' : 'ok');
    project = await api.project.current(); // der Modellname folgt dem Dateinamen
    $('doc-name').textContent = project.name;
    tree.setTitle(fileView.title ?? project.name);
    void refreshSaveState();
  } finally {
    saving = false;
    btn.disabled = false;
    btn.classList.remove('busy');
    btn.innerHTML = label; // fester Text aus index.html, kein Text aus dem Projekt
  }
}

async function doOpen(): Promise<boolean> {
  if (!(await leaveEditor('Open model'))) return false;
  const r = await api.project.openZip();
  if (r.error) toast(r.error, 'error');
  return !!r.opened;
}

const doNew = async () => { if (await leaveEditor('New model')) await api.project.create(); };
// Ladeanzeige für den Import: erscheint mit dem ersten Schritt nach dem Dateidialog, zählt die Sekunden mit
let cqBusyTick: ReturnType<typeof setInterval> | undefined;
api.project.onCadQueryStep(({ step, file }) => {
  const root = $('app-busy');
  if (root.hidden) {
    const t0 = performance.now();
    $('app-busy-time').textContent = '';
    clearInterval(cqBusyTick);
    cqBusyTick = setInterval(() => { $('app-busy-time').textContent = `${Math.round((performance.now() - t0) / 1000)} s`; }, 1000);
    root.hidden = false;
  }
  $('app-busy-step').textContent = `${step} …`;
  $('app-busy-file').textContent = file;
});
function closeCadQueryBusy(): void {
  clearInterval(cqBusyTick);
  $('app-busy').hidden = true;
}

/** Neues Modell aus einem CadQuery-Skript (E100). Die Hinweise des Imports (Kompatibilitätsmodus, Werte) zeigt ein Toast. */
/** „Open folder“ (Ordner-Modus): Fragen und Hinweis stellt der Hauptprozess. */
async function doOpenFolder(): Promise<boolean> {
  if (!(await leaveEditor('Open folder'))) return false;
  const r = await api.project.openFolder().catch((e: unknown) => ({ cancelled: false, opened: false, error: e instanceof Error ? e.message : String(e) }));
  if (r.error) toast(r.error, 'error');
  return !!r.opened;
}

async function doNewFromCadQuery(): Promise<CadQueryImportResult | null> {
  if (!(await leaveEditor('New model'))) return null;
  let r: CadQueryImportResult;
  try { r = await api.project.createFromCadQuery(); } finally { closeCadQueryBusy(); }
  if (r.cancelled) return r;
  if (r.error) { toast(r.error, 'error'); return r; }
  showStart(false);
  toast(['Model created from the CadQuery script. The original is kept in inputs/.', ...r.warnings].join('\n'), 'info');
  return r;
}
/** „Jetzt bauen“: baut immer. Vorher werden die Eingaben im Editor gespeichert, sonst sähe der Build sie nicht. */
async function doBuild(): Promise<void> {
  const r = await code.saveAll();
  if (!r.ok) { toast('Not everything could be saved (see the note in the code panel). The build waits until then.', 'error'); return; }
  await api.build.run();
}
const openProject = async (id: string) => {
  if (!(await leaveEditor('Open model'))) return;
  // Ein geöffneter Ordner kann fehlen (verschoben, Laufwerk ab): Der Hauptprozess sagt es
  await api.project.open(id).catch((e: unknown) => toast(String(e instanceof Error ? e.message : e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error'));
};

// F3 klappt den Strukturbaum auf und zu wie in CATIA (E82, Vorschlag aus dem Entwurf). Nicht beim Schreiben in Code, Terminal oder Feldern
window.addEventListener('keydown', (e) => {
  if (e.key !== 'F3' || e.ctrlKey || e.altKey || e.shiftKey || !project || settings.isOpen || help.isOpen || !$('start').hidden) return;
  if ((e.target as HTMLElement | null)?.closest?.('#terminals, #code-view, input, textarea, select, [contenteditable=true]')) return;
  e.preventDefault();
  tree.setOpen(!tree.isOpen);
});

// Kurzbefehle gelten nicht im Terminal: dort gehören Strg+S/Strg+O den Programmen (Claude Code nutzt Strg+O selbst)
window.addEventListener('keydown', (e) => {
  // Die Einstellungen liegen über allem und haben eigene Kurzbefehle (Strg+S speichert den Skill), die Hilfe ebenso
  if (settings.isOpen || help.isOpen || (e.target as HTMLElement | null)?.closest?.('#terminals') || !e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  // Ohne offenes Modell (Startseite beim Start, E69) gibt es nur Neu und Öffnen
  if (!project && k !== 'n' && k !== 'o') return;
  // Im Editor speichert Strg+S den Code und baut, sonst das ganze Modell als .soma-Datei
  if (k === 's') { e.preventDefault(); if (!e.shiftKey && (e.target as HTMLElement | null)?.closest?.('#code-view')) void saveCode(); else void doSave(e.shiftKey); }
  else if (k === 'o' && !e.shiftKey) { e.preventDefault(); void doOpen().then((ok) => { if (ok) showStart(false); }); }
  else if (k === 'n' && !e.shiftKey) { e.preventDefault(); void doNew().then(() => showStart(false)); }
  else if (k === 'b' && !e.shiftKey) { e.preventDefault(); void doBuild(); }
  else if (k === '1' && !e.shiftKey) { e.preventDefault(); toggleSide(); }
  else if (k === '2' && !e.shiftKey) { e.preventDefault(); showCode(!codeOpen); }
  else if (k === '3' && !e.shiftKey) { e.preventDefault(); setAgentCollapsed(!$('terminals').classList.contains('collapsed')); }
}, true);

// ---- Menüs der Kopfzeile ----------------------------------------------------------------------------------------

async function renderRecent(): Promise<void> {
  let list: { id: string; name: string; modified: number }[] = [];
  try { list = await api.project.list(); } catch { /* ohne Liste */ }
  list.sort((a, b) => b.modified - a.modified);
  const others = list.filter((p) => p.id !== project?.id).slice(0, 6);
  $('recent-wrap').hidden = others.length === 0;
  $('recent-list').replaceChildren(...others.map((p) => menuItem(p.name, { icon: 'cube', sub: fmtWhen(p.modified, true), onClick: () => void openProject(p.id) })));
}

$('btn-doc').addEventListener('click', () => { void renderRecent().then(() => menus.toggle($('menu-doc'), $('btn-doc'))); });
$('btn-new').addEventListener('click', () => void doNew());
$('btn-new-cq').addEventListener('click', () => { menus.close(); void doNewFromCadQuery(); });
$('btn-open').addEventListener('click', () => void doOpen());
$('btn-open-folder').addEventListener('click', () => { menus.close(); void doOpenFolder().then((ok) => { if (ok) showStart(false); }); });
$('btn-save').addEventListener('click', () => void doSave(false));
$('btn-save-menu').addEventListener('click', () => void doSave(false));
$('btn-saveas').addEventListener('click', () => void doSave(true));
$('btn-reveal').addEventListener('click', () => void api.project.reveal());
$('btn-reveal-menu').addEventListener('click', () => void api.project.reveal());
$('btn-start').addEventListener('click', () => showStart(true));
$('btn-home').addEventListener('click', () => showStart(true));
// Versionsnummer (E68): neben dem Namen auf der Startseite und im Hinweis des Logos
$('start-version').textContent = SOMA_VERSION;
$('btn-home').title = `Start page · SOMA ${SOMA_VERSION}`;
$('problems').addEventListener('click', () => menus.toggle($('menu-problems'), $('problems')));

// Build
function renderAuto(): void {
  const on = $<HTMLInputElement>('chk-auto').checked;
  $('auto-label').textContent = on ? 'Auto on' : 'Auto off';
  $('btn-auto').title = on ? 'Builds automatically when the code changes. Click to turn off.' : 'Auto build is off. Click to turn on.';
}
$<HTMLInputElement>('chk-auto').addEventListener('change', (e) => { renderAuto(); void api.build.setAuto((e.target as HTMLInputElement).checked); });
$('btn-auto').addEventListener('click', () => { const c = $<HTMLInputElement>('chk-auto'); c.checked = !c.checked; c.dispatchEvent(new Event('change')); });
$('btn-build').addEventListener('click', () => void doBuild());
$('btn-buildnow').addEventListener('click', () => void doBuild());
$('btn-cancel').addEventListener('click', () => void api.build.cancel());
$('btn-buildinfo').addEventListener('click', () => {
  const s = buildStatus;
  const count = s.result?.parts?.length ?? 0;
  const secs = s.seconds ?? 0;
  const warn = s.result?.warnings ?? [];
  $('bm-title').textContent = s.state === 'error' ? 'Last build failed' : s.state === 'building' ? 'Build running' : lastOkAt ? `Last built ${fmtWhen(lastOkAt)}` : 'Not built yet';
  $('bm-sub').textContent = s.state === 'ok' ? `${num(secs)} s · ${count} part${count === 1 ? '' : 's'} · ${warn.length ? `${warn.length} warning${warn.length === 1 ? '' : 's'}` : 'no warnings'}` : '';
  $('bm-warn').hidden = !warn.length;
  $('bm-warn').textContent = warn.join('\n');
  menus.toggle($('menu-build'), $('btn-buildinfo'));
});

// Darstellung
$('btn-display').addEventListener('click', () => menus.toggle($('menu-display'), $('btn-display'), 'beside'));
$('btn-axes').addEventListener('click', () => setAxes($('btn-axes').getAttribute('aria-pressed') !== 'true'));
document.querySelectorAll<HTMLButtonElement>('[data-display]').forEach((b) => b.addEventListener('click', () => {
  const on = b.getAttribute('aria-checked') !== 'true';
  b.setAttribute('aria-checked', String(on));
  if (b.dataset.display === 'edges') viewer.setEdges(on);
  else if (b.dataset.display === 'wire') viewer.setWireframe(on);
  else if (b.dataset.display === 'axes') setAxes(on);
  else viewer.setGhost(on);
}));

// Export
let exportScope: 'all' | 'sel' = 'all';
function renderExportScope(): void {
  const e = selection ? partEntry(selection.partId) : undefined;
  const name = e?.name ?? (selection ? partInfo(selection.partId)?.name : undefined);
  const sel = $<HTMLButtonElement>('exp-sel');
  sel.disabled = !name;
  sel.textContent = name ? `Only ${name}` : 'Selection only';
  if (!name) exportScope = 'all';
  $('exp-all').classList.toggle('on', exportScope === 'all');
  sel.classList.toggle('on', exportScope === 'sel');
  $('exp-all').setAttribute('aria-pressed', String(exportScope === 'all'));
  sel.setAttribute('aria-pressed', String(exportScope === 'sel'));
}
function openExportMenu(anchor: HTMLElement = $('btn-export')): void {
  renderExportScope();
  const m = $('menu-export');
  if (!menus.isOpen(m)) menus.toggle(m, anchor, anchor.id === 'btn-export' ? 'right' : 'left');
}
$('btn-export').addEventListener('click', () => {
  if (menus.isOpen($('menu-export'))) { menus.close(); return; }
  exportScope = selection ? exportScope : 'all';
  openExportMenu();
});
$('btn-sel-export').addEventListener('click', () => {
  if (menus.isOpen($('menu-export'))) { menus.close(); return; }
  exportScope = 'sel';
  openExportMenu($('btn-sel-export'));
});
$('exp-all').addEventListener('click', () => { exportScope = 'all'; renderExportScope(); });
$('exp-sel').addEventListener('click', () => { exportScope = 'sel'; renderExportScope(); });
document.querySelectorAll<HTMLButtonElement>('#menu-export [data-fmt]').forEach((b) => b.addEventListener('click', () => void doExport(b.dataset.fmt!, b.textContent!)));
$('exp-zip').addEventListener('click', () => { menus.close(); void doExportZip(); });
$('exp-cq').addEventListener('click', () => { menus.close(); void doExportCadQuery(); });

/** Das Modell als reines CadQuery (E100). Wie beim ZIP fehlen Eingaben, die im Editor noch nicht gespeichert sind. */
async function doExportCadQuery(): Promise<ExportResult> {
  const r = await api.project.exportCadQuery();
  if (r.cancelled) return r;
  const open = code.unsaved();
  if (r.ok) {
    const notes = [...(r.warnings ?? []), ...(open.length ? [`Not included (not saved in the editor): ${open.join(', ')}`] : [])];
    toast([`Model exported as CadQuery:\n${r.target ?? ''}`, ...notes].join('\n'), open.length ? 'error' : 'ok');
  } else toast(r.error ?? 'Export failed', 'error');
  return r;
}

/**
 * Das ganze Modell als ZIP (E79). Eingaben im Editor, die noch nicht gespeichert sind, fehlen darin wie in jedem Export:
 * Die Meldung nennt sie, statt sie ungefragt zu speichern.
 */
async function doExportZip(): Promise<ExportResult> {
  const r = await api.project.exportZip();
  if (r.cancelled) return r;
  const open = code.unsaved();
  if (r.ok) {
    const notes = [...(r.warnings ?? []), ...(open.length ? [`Not included (not saved in the editor): ${open.join(', ')}`] : [])];
    toast([`Model exported as ZIP:\n${r.target ?? ''}`, ...notes].join('\n'), notes.length ? 'error' : 'ok');
  } else toast(r.error ?? 'Export failed', 'error');
  return r;
}

/** Exportieren: Der Hauptprozess fragt nach Datei (ein Bauteil) oder Ordner (alle Bauteile) und schreibt erst danach. */
async function doExport(fmt: string, label: string): Promise<ExportResult> {
  menus.close();
  const e = selection ? partEntry(selection.partId) : undefined;
  const part = exportScope === 'sel' ? e?.name ?? partInfo(selection?.partId ?? '')?.name ?? null : null;
  const r = await api.build.export(fmt, part);
  if (r.cancelled) return r;
  const name = (f: string) => f.split(/[\\/]/).pop() ?? f;
  if (r.ok && part) toast(`“${part}” exported as ${label}:\n${r.target ?? r.files[0] ?? ''}`);
  else if (r.ok) toast(`${r.files.length} file${r.files.length === 1 ? '' : 's'} exported as ${label} to ${r.target ?? ''}:\n${r.files.map(name).join(', ') || '(no file)'}`);
  else toast(`Export failed: ${r.error}`, 'error');
  return r;
}

// ---- Ergebnisse des Agenten in den Reitern Analysis und Animation (E82) ----------------------------------------------
// Analysen, Animationen und Videos sind Ergebnisse des Agenten, keine Werkzeuge. Ein Klick auf den Reiter zeigt die Liste (oder
// den Bericht, wenn schon ein Ergebnis im Bild ist), erst ein Klick in der Liste bringt eins in den Viewer. Das × in der Leiste unten im Bild führt zurück zum Modell.

let viewLists: { results: ResultEntry[]; anims: AnimEntry[]; videos: string[]; drawings: DrawingEntry[] } = { results: [], anims: [], videos: [], drawings: [] };
/** Angesehene Ergebnisse (Schlüssel). Was danach dazukommt, steht in der Liste als „new“, bis man es öffnet. */
const seen = new Set<string>();
/** Ergebnisse, die schon in einem geöffneten Reiter standen. Was nicht darin ist, gibt dem Reiter einen Punkt. */
const tabSeen = new Set<string>();
let seenReady = false;
let viewSeq = 0;
let viewTimer: ReturnType<typeof setTimeout> | undefined;

const resultKey = (r: ResultEntry) => `r:${r.id}:${String(r.created ?? '')}`;
const analysisKeys = () => viewLists.results.map(resultKey);
const animKeys = () => [...viewLists.anims.map(animKey), ...viewLists.videos.map(videoKey)];
const drawingKeys = () => viewLists.drawings.map(drawingKey);

function videosIn(nodes: FileNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.dir) { if (!n.name.startsWith('.')) videosIn(n.children ?? [], out); }
    else if (VIDEO_EXT.test(n.name)) out.push(n.path);
  }
  return out;
}

function resetViewLists(): void {
  viewSeq++;
  viewLists = { results: [], anims: [], videos: [], drawings: [] };
  seen.clear();
  tabSeen.clear();
  seenReady = false;
  renderResults();
  void refreshViewLists();
}

async function refreshViewLists(): Promise<void> {
  if (!project) return;
  const seq = ++viewSeq;
  const [results, anims, nodes, drawings] = await Promise.all([
    api.results.list().catch(() => null), api.anim.list().catch(() => null), api.fs.list().catch(() => [] as FileNode[]),
    api.drawings.list().catch(() => null as DrawingList | null),
  ]);
  if (seq !== viewSeq) return;
  viewLists = { results: results ?? viewLists.results, anims: anims?.animations ?? viewLists.anims, videos: videosIn(nodes), drawings: drawings?.drawings ?? viewLists.drawings };
  if (results) resultTool.setList(results);
  if (anims) animTool.setList(anims);
  // Was beim Öffnen des Modells schon da ist, gilt als gesehen
  if (!seenReady) { for (const k of [...analysisKeys(), ...animKeys(), ...drawingKeys()]) { seen.add(k); tabSeen.add(k); } seenReady = true; }
  renderResults();
}
const scheduleViewLists = () => { clearTimeout(viewTimer); viewTimer = setTimeout(() => void refreshViewLists(), 400); };

/** Reiter, Punkte an der Leiste und Baum nachziehen: Was zeigt der Viewer, was ist neu? */
function renderResults(): void {
  // Ein offener Reiter zeigt das Neue selbst (in der Liste), dort braucht es keinen Punkt
  if (panel === 'analysis') for (const k of analysisKeys()) tabSeen.add(k);
  if (panel === 'anim') for (const k of animKeys()) tabSeen.add(k);
  $('nd-analysis').hidden = !analysisKeys().some((k) => !tabSeen.has(k));
  $('nd-anim').hidden = !animKeys().some((k) => !tabSeen.has(k));
  if (drawingsShown()) for (const k of drawingKeys()) tabSeen.add(k);
  $('nd-drawings').hidden = !drawingKeys().some((k) => !tabSeen.has(k));
  renderDrawingsRail();
  if (panel === 'analysis') analysisPanel.render();
  if (panel === 'anim') animPanel.render();
  // In der Analyse stehen im Baum nur die gerechneten Körper, gegliedert wie im Modell
  const r = resultTool.shown;
  tree.limit(r ? r.parts.map((x) => x.name) : null);
  fitDock();
}

/** Reiter Analysis oder Animation geöffnet: Liste frisch laden. Von selbst kommt nichts ins Bild, das wählt der Nutzer in der Liste. */
async function openResults(): Promise<void> {
  analysisPanel.opened();
  await refreshViewLists();
}

async function openAnims(): Promise<void> {
  animPanel.opened();
  await refreshViewLists();
}

// ---- Viewer-Bedienung -------------------------------------------------------------------------------------------

// Einpassen, Standardansicht und die Ansichten im Menü „Darstellung“ (der Würfel selbst steuert über viewcube.ts)
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) => b.addEventListener('click', () => viewer.setView(b.dataset.view as ViewName)));
$('btn-sel-close').addEventListener('click', () => selectPart(null, null));
$('btn-sel-code').addEventListener('click', () => {
  const e = selection ? partEntry(selection.partId) : undefined;
  if (e?.file && e.line) void openCode(e.file, { ...lineRange(e), label: e.name, color: partInfo(e.id)?.color });
});
$('btn-sel-agent').addEventListener('click', () => insertToAgent(selectionText()));
$('btn-err-agent').addEventListener('click', () => insertToAgent(errorText()));
$('btn-err-code').addEventListener('click', () => {
  const e = buildStatus.result?.error;
  if (e?.file) void openCode(e.file, e.line ? { from: e.line, to: e.line, label: 'Build error', kind: 'er' } : undefined);
});
$('btn-err-details').addEventListener('click', () => {
  const t = $('err-trace');
  t.hidden = !t.hidden;
  $('btn-err-details').setAttribute('aria-expanded', String(!t.hidden));
});
$('btn-err-fold').addEventListener('click', () => {
  const folded = $('errcard').classList.toggle('folded');
  $('btn-err-fold').setAttribute('aria-expanded', String(!folded));
  $('btn-err-fold').setAttribute('aria-label', folded ? 'Expand message' : 'Collapse message');
});

// ---- Seitenleiste -----------------------------------------------------------------------------------------------

document.querySelectorAll<HTMLButtonElement>('#rail [data-panel]').forEach((b) => b.addEventListener('click', () => {
  const p = b.dataset.panel as PanelName;
  showPanel(panel === p ? null : p);
}));
document.querySelectorAll<HTMLButtonElement>('.side-close').forEach((b) => b.addEventListener('click', () => showPanel(null)));
const toggleSide = () => showPanel(panel ? null : lastPanel);
$('btn-lay-side').addEventListener('click', toggleSide);
$('btn-lay-code').addEventListener('click', () => showCode(!codeOpen));
$('btn-lay-agent').addEventListener('click', () => setAgentCollapsed(!$('terminals').classList.contains('collapsed')));
$('btn-code-close').addEventListener('click', () => showCode(false));

// ---- Agent-Bereich ----------------------------------------------------------------------------------------------

function setAgentCollapsed(on: boolean): void {
  $('terminals').classList.toggle('collapsed', on);
  $('agent-strip').hidden = !on;
  $('split-right').hidden = on;
  if (!on) terminals.refit();
  store.set('soma.agentCollapsed', on ? '1' : '0');
  renderLayout();
}
$('btn-agent-expand').addEventListener('click', () => setAgentCollapsed(false));
terminals.onStripClick = () => setAgentCollapsed(false);

function renderAgentMenu(): void {
  $('agent-list').replaceChildren(...(agents.length ? agents : []).map((a) => {
    const d = el('span', { className: 'dot' });
    d.style.background = a.found ? 'var(--ok)' : 'transparent';
    if (!a.found) d.style.boxShadow = 'inset 0 0 0 1.5px var(--tx3)';
    const b = el('button', { className: 'mi', disabled: !a.found, title: a.found ? `Start ${a.command} in a new tab` : `${a.command} was not found in the PATH. Install the agent yourself, then it appears here.` },
      el('span', { className: 'noico' }, d), el('span', { textContent: a.label }), a.found ? null : el('span', { className: 'k', textContent: 'not installed' }));
    b.setAttribute('role', 'menuitem');
    b.addEventListener('click', () => { setAgentCollapsed(false); void terminals.add({ command: a.command, title: a.label }); });
    return b;
  }));
  if (!agents.length) $('agent-list').append(el('div', { className: 'mnote', textContent: 'Looking for agents …' }));
}
$('btn-term-add').addEventListener('click', () => { renderAgentMenu(); menus.toggle($('menu-agents'), $('btn-term-add')); });
$('btn-term-plain').addEventListener('click', () => void terminals.add({ title: 'Terminal' }));
$('btn-copy-path').addEventListener('click', () => void api.project.copyPath().then((r) => {
  toast(r.ok ? 'Path copied. Open it as the project folder in your agent app.' : r.error ?? 'The path could not be copied.', r.ok ? 'ok' : 'error');
}));

// ---- Trennleisten -----------------------------------------------------------------------------------------------

function splitter(id: string, target: () => HTMLElement, prop: () => string, sign: 1 | -1, min: number, max: () => number): void {
  const bar = $(id);
  bar.addEventListener('pointerdown', (down) => {
    const t = target();
    const start = down.clientX, startW = t.getBoundingClientRect().width;
    bar.classList.add('drag');
    bar.setPointerCapture(down.pointerId);
    const move = (e: PointerEvent) => t.style.setProperty(prop(), `${Math.max(min, Math.min(max(), startW + sign * (e.clientX - start)))}px`);
    const up = () => { bar.classList.remove('drag'); bar.removeEventListener('pointermove', move); bar.removeEventListener('pointerup', up); };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
  });
}
splitter('split-side', () => $('side'), () => '--side', 1, 200, () => innerWidth * 0.4);
splitter('split-code', () => $('editor'), () => '--editor', 1, 280, () => innerWidth * 0.6);
splitter('split-right', () => $('terminals'), () => '--right', -1, 300, () => innerWidth - 560);

// ---- Startseite -------------------------------------------------------------------------------------------------

async function showStart(on: boolean): Promise<void> {
  $('start').hidden = !on;
  if (!on) return;
  menus.close();
  $('btn-start-close').hidden = $('start-close-sep').hidden = !project;
  $('start-close-name').textContent = project?.name ?? '';
  renderStartNote();
  renderTourCard();
  void renderUpdate();
  let list: ProjectListEntry[] = [];
  try { list = await api.project.list(); } catch { /* ohne Liste */ }
  list.sort((a, b) => b.modified - a.modified);
  // Ohne Modelle zeigen zwei große Karten den Weg, mit Modellen ist Zuletzt geöffnet der Hauptinhalt
  $('start-recent-wrap').hidden = !list.length;
  $('start-empty').hidden = $('start-tip').hidden = !!list.length;
  $('start-recent-count').textContent = String(list.length);
  ($('start-filter') as HTMLInputElement).value = '';
  $('start-recent').replaceChildren(...list.map((p) => {
    const th = el('div', { className: 'th' }, icon('cube', 36, 1.2));
    void api.project.thumb(p.id).then((url) => { if (url) th.replaceChildren(el('img', { src: url, alt: '' })); });
    const cur = p.id === project?.id;
    // Viele heißen „New model“: Ob es je gespeichert wurde, hilft beim Wiederfinden und beim Aufräumen
    const when = p.folder ? (p.missing ? '' : `changed ${fmtWhen(p.modified, true)}`) : p.saved ? `changed ${fmtWhen(p.modified, true)}` : fmtWhen(p.modified, true);
    // Ordner-Modus: Der Ordner steht im Tooltip, fehlt er, sagt die Karte es
    const title = cur ? 'Currently open' : p.folder ? `Open ${p.name}\nFolder: ${p.folder}` : `Open ${p.name}`;
    const card = el('button', { className: 'recent' + (cur ? ' cur' : ''), title },
      th, cur && el('span', { className: 'tag', textContent: 'Open' }),
      el('div', { className: 'meta' }, el('b', { textContent: p.name }),
        el('span', { className: 'sub' }, p.folder && el('span', { className: 'c3', textContent: 'Folder' }), when && el('span', { textContent: when }),
          !p.saved && el('span', { className: 'unsaved', textContent: 'never saved' }), p.missing && el('span', { className: 'unsaved', textContent: 'folder missing' }))));
    card.addEventListener('click', () => { if (!cur) void openProject(p.id); showStart(false); });
    const item = el('div', { className: 'recent-item' }, card);
    item.dataset.name = p.name.toLowerCase();
    if (cur) return item;
    // Entfernen (E69): Arbeitsordner in den Papierkorb, die Rückfrage im Hauptprozess sagt, was dabei verloren geht
    const rm = el('button', { className: 'recent-rm', title: p.folder ? `Remove “${p.name}” from the list. The folder stays.` : `Remove “${p.name}” from this computer`, ariaLabel: `Remove ${p.name}` }, icon('trash', 14));
    rm.addEventListener('click', () => void (async () => {
      const r = await api.project.remove(p.id).catch((e: unknown) => ({ removed: false, error: e instanceof Error ? e.message : String(e) }));
      if (r.error) toast(r.error, 'error');
      if (r.removed) { toast(p.folder ? `“${p.name}” removed from the list. The folder stays as it is.` : `“${p.name}” removed. The working folder is in the Recycle Bin.`, 'ok'); void showStart(true); }
    })());
    item.append(rm);
    return item;
  }), el('div', { id: 'start-nomatch', className: 'c3', textContent: 'No model matches the filter.', hidden: true }));
  if (!agents.length) await refreshAgents();
  renderStartAgents();
}

/** Agenten kompakt: gefundene zuerst, je eine Zeile mit Punkt wie im Agent-Menü. Jeder andere CLI-Agent geht auch (Zeile darunter). */
function renderStartAgents(): void {
  const list = [...agents.filter((a) => a.found), ...agents.filter((a) => !a.found)];
  $('start-agents-count').textContent = agents.length ? `${agents.filter((a) => a.found).length} of ${agents.length} found` : '';
  $('start-agents').replaceChildren(...list.map((a) => el('div', {
    className: 'agrow' + (a.found ? '' : ' off'),
    title: a.found ? `Found in the PATH as ${a.command}` : `${a.command} was not found in the PATH. Install the agent yourself, then it appears here.`,
  }, el('span', { className: 'dot' }), el('span', { className: 'nm', textContent: a.label }),
  a.found ? el('code', { textContent: a.command }) : el('span', { className: 'st', textContent: 'not installed' }))));
}

/** Sicherheitshinweis bei den Agenten: bis „Got it“ ausführlich, danach eine Zeile. */
function renderStartNote(): void {
  const seen = store.get('soma.noteSeen') === '1';
  $('start-note').hidden = seen;
  $('start-note-line').hidden = !seen;
}

/** Filter über die Namen der Karten. Escape im Feld leert es zuerst, erst das nächste Escape verlässt die Startseite. */
function filterStart(): void {
  const q = ($('start-filter') as HTMLInputElement).value.trim().toLowerCase();
  let shown = 0;
  for (const item of $('start-recent').querySelectorAll<HTMLElement>('.recent-item')) {
    item.hidden = !!q && !(item.dataset.name ?? '').includes(q);
    if (!item.hidden) shown++;
  }
  $('start-nomatch').hidden = shown > 0;
}
$('start-filter').addEventListener('input', filterStart);
$('start-filter').addEventListener('keydown', (e) => {
  const f = e.currentTarget as HTMLInputElement;
  if (e.key === 'Escape' && f.value) { e.preventDefault(); e.stopPropagation(); f.value = ''; filterStart(); }
});
// Escape führt zurück zum offenen Modell. Menüs, Rückfragen, Hilfe und Einstellungen nehmen Escape vorher für sich
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented || $('start').hidden || !project || help.isOpen || settings.isOpen) return;
  e.preventDefault();
  void showStart(false);
});
$('btn-start-close').addEventListener('click', () => showStart(false));
const startNew = () => { void doNew(); showStart(false); };
const startOpen = () => { void doOpen().then((ok) => { if (ok) showStart(false); }); };
$('start-new').addEventListener('click', startNew);
$('start-new-tpl').addEventListener('click', startNew);
$('start-empty-new').addEventListener('click', startNew);
$('start-open').addEventListener('click', startOpen);
$('start-empty-open').addEventListener('click', startOpen);
$('start-new-more').addEventListener('click', () => menus.toggle($('menu-start-new'), $('start-new-more'), 'right'));
$('start-new-cq').addEventListener('click', () => void doNewFromCadQuery());
$('start-empty-cq').addEventListener('click', () => void doNewFromCadQuery());
$('start-open-folder').addEventListener('click', () => { menus.close(); void doOpenFolder().then((ok) => { if (ok) showStart(false); }); });
$('btn-start-tip-help').addEventListener('click', () => void help.open());
/**
 * Pille „neue Version“ neben der Versionsnummer: neueste Version unter GitHub Releases (updates.ts, einmal je Sitzung). Ein
 * Klick öffnet die Seite im Browser, laden und installieren tut der Nutzer selbst. Bei aktuellem Stand keine Pille, klappt die
 * Prüfung nicht, eine leise. Ausgeschaltet (Settings › About) oder im Test ohne Adresse: keine.
 */
let updateInfo: UpdateInfo | null = null;
async function renderUpdate(): Promise<void> {
  const pill = $('start-update');
  if (!appSettings.settings.start.updateCheck) { pill.hidden = true; return; }
  if (!updateInfo) { pill.hidden = true; pill.className = 'uppill checking'; }
  try { updateInfo = await api.updates.check(); } catch (e) {
    updateInfo = { state: 'error', current: SOMA_VERSION, url: RELEASES_URL, error: e instanceof Error ? e.message : String(e) };
  }
  const u = updateInfo;
  if (!appSettings.settings.start.updateCheck || u.state === 'skipped') { pill.hidden = true; return; }
  const when = u.published ? ` on ${new Date(u.published).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}` : '';
  const [ico, label, title] = u.state === 'newer'
    ? ['arrowup', `${u.latest} available`, `SOMA ${u.latest} was released${when}. You have ${u.current}. Opens the release page: download and install it there, your models stay.`]
    : u.state === 'current'
      ? ['okcirc', 'Up to date', `SOMA is up to date. ${u.current} is the latest release on GitHub.`]
      : ['alert', 'Update check failed', `Could not check for a new version. ${u.error ?? ''}`.trim()];
  pill.className = `uppill ${u.state}`;
  pill.title = title;
  pill.dataset.url = u.url;
  pill.replaceChildren(icon(ico, 12, 2.2), el('span', { textContent: label }));
  pill.hidden = u.state === 'current';
}
$('start-update').addEventListener('click', () => {
  const url = $('start-update').dataset.url ?? RELEASES_URL;
  void api.openUrl(url).then((r) => { if (!r.ok) toast(r.error ?? `${url} could not be opened.`, 'error'); });
});
const RELEASES_URL = 'https://github.com/Kai-Jungsthoefel/SOMA/releases';
$('btn-note-ok').addEventListener('click', () => { store.set('soma.noteSeen', '1'); renderStartNote(); });

// ---- Ereignisse vom Hauptprozess --------------------------------------------------------------------------------

api.project.onChanged((p) => void onProject(p));
let buildStarts = 0; // Prüfhilfe: Wie oft hat ein Build begonnen?
api.build.onStatus((s) => {
  if (s.state === 'building' && buildStatus.state !== 'building') buildStarts++;
  renderBuild(s);
  paramsPanel.setBuild(s);
  if (s.state === 'ok' && !s.stale) { void loadModel(); void refreshFiles(); void refreshViewLists(); }
  // Nach jedem Build (auch einem gescheiterten): Liste und Werte neu, der Build kennt die Parameter des Codes
  if (panel === 'params' && s.state !== 'building') void paramsPanel.refresh();
});
// Auch bei geschlossenem Code abgleichen: Offene Dateien können ungesicherte Eingaben enthalten
api.fs.onChanged(() => { textCache.clear(); void fileView.filesChanged(); void refreshFiles(); void code.refresh(); scheduleViewLists(); if (panel === 'params') void paramsPanel.refresh(); });
// Beim Beenden fragt der Hauptprozess, was im Editor ungespeichert ist, und lässt speichern oder verwerfen
api.fs.onEditorRequest(async (action) => {
  if (action === 'status') return { dirty: code.unsaved() };
  if (action === 'save') return { ok: (await code.saveAll()).ok };
  return { ok: await code.discardAll() };
});
// Rückfragen des Hauptprozesses (etwa „Save the model?“ beim Schließen) im Stil der App statt als weißer Dialog des Systems
api.dialog.onShow((o) => ask(o));
api.versions.onChanged(() => void versions.refresh());
api.anim.onChanged(() => { void animTool.refresh(); scheduleViewLists(); });
api.drawings.onChanged(() => { drawingsView()?.refresh(); scheduleViewLists(); });
api.render.onProgress((f) => animTool.progress(f));
// Bilder und Videos, die der Agent erzeugt hat: kurz Bescheid geben, ein Klick im Dateibaum öffnet sie
api.render.onNotice((n) => {
  if (!n.byAgent) return;
  if (n.ok) toast(`The agent created ${n.files.join(', ')}.`, 'info');
  void refreshFiles();
  scheduleViewLists();
});
// Ergebnisse von soma analyze melden sich nicht von selbst (.soma/results/ beobachtet niemand): ab und zu nachsehen
setInterval(() => { if (project && !document.hidden) void refreshViewLists(); }, 10000);
window.addEventListener('focus', () => scheduleViewLists());
api.project.onSaveState((st) => renderSaveState(st));
// Das Projekt kommt ausschließlich über das Ereignis (Startseite, Menü, im Testmodus öffnet es der Hauptprozess beim Start). Ein zweiter Weg würde alles doppelt aufbauen.

// Einstellungen der App (E81): Ein Modell, das schon offen ist, bekommt auch die Darstellung beim Öffnen
void api.settings.get().then((st) => { appSettings = st; applySettings(); applyDisplayDefaults(); renderTourCard(); }).catch(() => { /* es gelten die Vorgaben */ });

// ---- Tutorial (E94) ---------------------------------------------------------------------------------------------
// Erst hier angelegt: Seine Escape-Taste kommt nach Menüs, Messen und Markierung, die Escape zuerst für sich nutzen

const tourCtx: TourContext = {
  showPanel: (p) => showPanel(p),
  showCode: (on) => showCode(on),
  openCode: (f) => void openCode(f),
  expandAgent: () => setAgentCollapsed(false),
  // Die Liste nennt alle bekannten Agenten mit „found“. Leer heißt: Suche läuft noch
  agentsFound: () => (agents.length ? agents.filter((a) => a.found).map((a) => a.label) : null),
  selected: () => !!selection,
  measuring: () => measureTool.isActive,
  stopMeasure: () => { if (measureTool.isActive) measureTool.setActive(false); },
  marking: () => markup.active,
  closeEmptyMarkup: () => { if (markup.active && !markup.drawn) markup.close(); },
  // Läuft in jedem Frame: nur nachsehen, ob eine Zeile als geändert markiert ist (state() misst den ganzen Text)
  paramsChanged: () => !!document.querySelector('#params-list .prm.chg'),
};
/** Modell, zu dem die laufende Tour gehört. */
let tourProject: string | null = null;
const tour = new Tour({
  covered: () => !$('start').hidden || help.isOpen || settings.isOpen,
  // Durchlaufen blendet die Karte der Startseite aus (wie „Got it“), Überspringen nicht: Wer abbricht, findet sie dort wieder
  ended: (finished) => {
    if (finished) void hideTourCard();
    toast(finished ? 'That’s the basics. Help (F1) has the whole guide and can start the tutorial again.' : 'Tutorial ended. Help (F1) can start it again.', 'info');
  },
});

function renderTourCard(): void {
  $('start-tour').hidden = !appSettings.settings.start.tutorialCard;
}

/** Karte „New to SOMA?“ dauerhaft ausblenden (settings.json). Klappt das Schreiben nicht, bleibt sie für diese Sitzung weg. */
async function hideTourCard(): Promise<void> {
  $('start-tour').hidden = true;
  if (!appSettings.settings.start.tutorialCard) return;
  try {
    const r = await changeSettings({ start: { tutorialCard: false } });
    if (!r.ok) toast(r.error ?? 'The setting could not be saved.', 'error');
  } catch (e) { toast(`The setting could not be saved: ${e instanceof Error ? e.message : String(e)}`, 'error'); }
  $('start-tour').hidden = true;
}

/**
 * Tutorial starten: Es legt wie „New model“ ein neues Modell aus der Vorlage an, nur mit dem Namen „Tutorial“, und führt
 * daran durch die Oberfläche. Ein offenes Modell bleibt, wie es ist (unter Recent), nach einer Rückfrage, weil seine
 * Terminals dabei schließen. Bleibt das Tutorial-Modell unverändert, verschwindet es beim Wechsel wie jedes neue (E69).
 */
async function startTutorial(): Promise<void> {
  if (project) {
    const c = await api.dialog.choose({
      title: 'Tutorial', message: 'Start the tutorial with a new example model?',
      detail: `Your model “${project.name}” stays on the start page under Recent. Its terminals close.`, buttons: ['Start tutorial', 'Cancel'],
    });
    if (c !== 0) return;
  }
  if (!(await leaveEditor('Start tutorial'))) return;
  help.close();
  tour.stop(false, false);
  void showStart(false);
  let info: ProjectInfo;
  try { info = await api.project.create('tutorial'); } catch (e) {
    toast(`The example model could not be created: ${e instanceof Error ? e.message : String(e)}`, 'error');
    return;
  }
  tourProject = info.id;
  tour.start(tourSteps(tourCtx));
}
$('btn-tour-start').addEventListener('click', () => void startTutorial());
$('btn-tour-dismiss').addEventListener('click', () => void hideTourCard());
$('btn-help-tour').addEventListener('click', () => void startTutorial());

if (store.get('soma.agentCollapsed') === '1') setAgentCollapsed(true);
// Seitenleiste wie beim letzten Mal, beim ersten Start zu: Die Bauteile stehen im Baum im Viewer (E82)
{
  const side = store.get('soma.side');
  showPanel(side && PANELS.includes(side as PanelName) ? side as PanelName : null);
}
// Die App beginnt auf der Startseite (E69), der Hauptprozess öffnet kein Modell. Nur im Testmodus öffnet er gleich eins.
if (api.startsHome) void showStart(true);
// Erst jetzt steht, was der Nutzer sehen soll, die Startseite liegt schon über der Oberfläche
requestAnimationFrame(() => hideBoot());

// Prüfschnittstelle, nur im Testmodus
if (api.testMode) {
  (window as unknown as Record<string, unknown>).__t = {
    viewer, terminals,
    project: () => project,
    parts: () => viewer.partList(),
    partCount: () => viewer.partList().length,
    status: () => ({ state: buildStatus.state, text: $('status').textContent, detail: $('status-detail').textContent, viewerMsg: $('errcard').hidden ? $('viewer-msg').textContent : $('errcard').textContent }),
    info: () => ($('selcard').hidden ? '' : `${$('sel-name').textContent} · ${$('info').textContent} · ${$('code').querySelector('.ph')?.textContent ?? ''}`),
    codeHighlight: () => [...document.querySelectorAll('#code .cl.hl')].map((x) => x.textContent),
    treeNames: () => tree.names(),
    tree: () => tree.state(),
    treeOpen: (on: boolean) => tree.setOpen(on),
    picked: () => picked.map(partName),
    treeExpandAll: () => tree.expandAll(),
    termText: (id: number) => terminals.text(id),
    versions: () => versions.state(),
    saveState: () => saveState,
    toast: () => ({ text: $('toast').textContent, hidden: $('toast').hidden, error: $('toast').classList.contains('error') }),
    banner: () => ({ hidden: $('preview-banner').hidden, text: $('preview-banner').textContent }),
    fileView: () => ({ ...fileView.state(), banner: $('file-banner').hidden ? null : $('file-banner').textContent, frame: $('viewer').classList.contains('fileview') }),
    openFile: (rel: string) => fileView.open(rel),
    partSize: (name: string) => { const p = viewer.partList().find((x) => x.name === name); return p ? viewer.partSize(p.id) : null; },
    versionsUi: () => ({ restoreHidden: $('btn-restore').hidden, problem: $('vproblem').hidden ? '' : $('vproblem').textContent }),
    selectionText, errorText,
    markup: () => markup.state(),
    measure: () => measureTool.state(),
    mapBuild: () => map?.build ?? null,
    section: () => sectionTool.state(),
    explode: () => explodeTool.state(),
    busy: () => busy.state(),
    anim: () => animTool.state(),
    animSeek: (t: number) => animTool.testSeek(t),
    animRefresh: () => animTool.refresh(),
    result: () => resultTool.state(),
    resultRefresh: () => resultTool.refresh(),
    resultPin: (x: number, y: number) => resultTool.testPin(x, y),
    resultShow: (id: string) => resultTool.show(id),
    resultField: (f: 'value' | 'stress' | 'disp' | 'press') => resultTool.testField(f),
    resultDeform: (sc: number) => resultTool.testDeform(sc),
    analysis: () => analysisPanel.state(),
    analysisToggle: (key: string) => analysisPanel.testToggle(key),
    animShow: (id: string) => animTool.show(id),
    animPanel: () => animPanel.state(),
    drawings: () => drawingsView()?.state() ?? null,
    drawingsOpen: () => toggleDrawings(),
    drawingsScreen: (name: string, x: number, y: number) => drawingsView()?.screenOf(name, x, y) ?? null,
    drawingsGoTo: (name: string) => drawingsView()?.goTo(name),
    drawingsSelectNone: () => drawingsView()?.select(null),
    rail: () => ({ analysis: !$('nd-analysis').hidden, anim: !$('nd-anim').hidden, drawings: !$('nd-drawings').hidden, pressed: [...document.querySelectorAll<HTMLElement>('#rail [aria-pressed=true]')].map((b) => b.dataset.panel) }),
    dockCompact: () => $('dock').classList.contains('compact'),
    video: () => videoView.state(),
    videoOpen: (rel: string) => videoView.open(rel),
    videoSeek: (t: number) => videoView.testSeek(t),
    skills: () => skills.state(),
    params: () => paramsPanel.state(),
    paramsRefresh: () => paramsPanel.refresh(),
    pick: () => selection?.pick ?? null,
    markPixel: (x: number, y: number) => markup.pixel(x, y),
    markHandles: () => markup.handles(),
    markRelayout: () => markup.relayout(),
    markImage: (rel: string) => markImage(rel),
    insert: (text: string) => insertToAgent(text),
    showPanel: (p: PanelName | 'code' | null) => (p === 'code' ? showCode(true) : showPanel(p)),
    showCode,
    layout: () => ({ side: panel, code: codeOpen, agent: !$('terminals').classList.contains('collapsed') }),
    refreshViewLists: () => refreshViewLists(),
    openSkill: (id: string | null) => skills.openDetail(id),
    help: () => help.state(),
    openHelp: (title?: string) => help.open(title),
    closeHelp: () => help.close(),
    settings: () => settings.state(),
    openSettings: (id?: string) => settings.open(id),
    closeSettings: () => settings.close(),
    settingsSelect: (id: string | null) => settings.select(id),
    settingsType: (text: string) => settings.type(text),
    settingsSave: () => settings.save(),
    settingsShow: (sec: 'viewer' | 'keys' | 'skills' | 'storage' | 'about') => settings.open(undefined, sec),
    settingsPages: () => ({ viewer: viewerPage.state(), storage: storagePage.state(), about: aboutPage.state() }),
    appSettings: () => appSettings,
    storageRefresh: () => storagePage.refresh(),
    axes: () => viewer.axesState(),
    display: () => Object.fromEntries([...document.querySelectorAll<HTMLElement>('[data-display]')].map((b) => [b.dataset.display, b.getAttribute('aria-checked') === 'true'])),
    /** Export wie über das Menü (`sel`: das ausgewählte Bauteil), liefert das Ergebnis. */
    exportAs: (fmt: string, scope: 'all' | 'sel') => { exportScope = scope; return doExport(fmt, fmt.toUpperCase()); },
    /** „Everything as ZIP“ im Export-Menü (E79). */
    exportZip: () => doExportZip(),
    /** „As CadQuery script“ im Export-Menü und „New from CadQuery script“ (E100). */
    exportCadQuery: () => doExportCadQuery(),
    newFromCadQuery: () => doNewFromCadQuery(),
    cqBusy: () => ({ hidden: $('app-busy').hidden, text: $('app-busy').textContent }),
    showStart: (on: boolean) => showStart(on),
    tour: () => tour.state(),
    tourGo: (n: number) => tour.goTo(n),
    setAgentCollapsed,
    fileRows: () => [...document.querySelectorAll('#tab-files .frow .fn')].map((x) => x.textContent),
    codeText: () => code.text(),
    openCode: (file: string) => openCode(file),
    buildStarts: () => buildStarts,
    editor: code.testApi(),
  };
}
