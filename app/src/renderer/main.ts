import { affectsBuild } from '../shared/editable';
import type { AgentInfo, AnimEntry, BuildStatus, ExportResult, FileNode, ModelMap, PartMap, PreviewResult, ProjectInfo, ResultEntry, SaveState } from '../shared/types';
import { SOMA_VERSION } from '../shared/version';
import { CodePanel, codeRows, isPdf, type Mark } from './code';
import { AnimTool } from './animtool';
import { Busy } from './busy';
import { DRAG_FILE, FileTree, IMAGE_EXT, TEXT_EXT, VIDEO_EXT } from './filetree';
import { hydrateIcons, icon } from './icons';
import { Markup } from './markup';
import { MAX_QUOTE } from './pdfview';
import { MeasureTool } from './measuretool';
import { SectionTool } from './sectiontool';
import { ExplodeTool } from './explodetool';
import { SkillsPanel } from './skills';
import { DRAG_PART, PartsCard } from './parts';
import { ResultTool } from './resulttool';
import { ResultLayer } from './resultview';
import { TerminalTabs } from './terminals';
import { $, el, fmtWhen, menuItem, menus, toast } from './ui';
import { VersionsBar } from './versions';
import { VideoView } from './videoview';
import { PickResult, Viewer, ViewName } from './viewer';

hydrateIcons();
const api = window.soma;

const viewer = new Viewer($('viewer'));
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

const num = (v: number, digits = 1) => v.toLocaleString('de-DE', { maximumFractionDigits: digits });
const SURFACE: Record<string, string> = {
  PLANE: 'eben', CYLINDER: 'Zylinder', CONE: 'Kegel', SPHERE: 'Kugel', TORUS: 'Torus', BSPLINE: 'Freiform', BEZIER: 'Freiform',
  REVOLUTION: 'Drehfläche', EXTRUSION: 'Extrusionsfläche', OFFSET: 'Versatzfläche', OTHER: 'sonstige',
};
const surfaceName = (s: string | null) => (s ? SURFACE[s] ?? s.toLowerCase() : 'Fläche');
const ERROR_KIND: Record<string, string> = { Timeout: 'Zeitlimit überschritten', PythonStart: 'Python ließ sich nicht starten', NoResult: 'Build ohne Ergebnis' };

// ---- Seitenleiste (Bauteile, Dateien, Skills) und Code-Spalte (Entwurf 2) -----------------------------------------

type PanelName = 'parts' | 'files' | 'skills';
let panel: PanelName | null = null;
/** Zuletzt gezeigte Ansicht der Seitenleiste: Der Schalter oben bringt sie wieder. */
let lastPanel: PanelName = 'parts';
let filesDirty = true;
let codeOpen = false;
/** Der Dateibaum entsteht nach dem Code-Panel, das ihm schon beim Aufbau die offene Datei meldet. */
let fileTree: FileTree | null = null;

function showPanel(p: PanelName | null): void {
  panel = p;
  if (p) lastPanel = p;
  $('side').hidden = !p;
  $('split-side').hidden = !p;
  $('panel-parts').hidden = p !== 'parts';
  $('panel-files').hidden = p !== 'files';
  $('panel-skills').hidden = p !== 'skills';
  document.querySelectorAll<HTMLButtonElement>('#rail [data-panel]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.panel === p)));
  if (p === 'files' && filesDirty) void refreshFiles();
  if (p === 'skills') void skills.refresh();
  else skills.closeDetail();
  store.set('soma.side', p ?? '');
  renderLayout();
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
    else if (project) void code.open('model.py');
  }
  renderLayout();
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
    active: (f) => fileTree?.setActive(f),
    saveAndBuild: () => void saveCode(),
    build: () => void api.build.run(),
    link: (href) => openLink(href),
    image: async (rel) => { try { return await imageUrl(rel); } catch { return null; } },
    quote: (file, pages, text) => {
      // Eine Zeile mit Datei und Seite, wie Auswahl und Markierung. Sehr lange Zitate werden gekürzt, das steht in der Meldung.
      const cut = text.length > MAX_QUOTE;
      insertToAgent(`[Zitat: ${file} S. ${pages}: "${cut ? `${text.slice(0, MAX_QUOTE)} …` : text}"] `, cut ? `Zitat auf ${MAX_QUOTE} Zeichen gekürzt.` : undefined);
    },
    markPage: (file, page, canvas) => void markSource(`${file} S. ${page}`, canvas, canvas.width, canvas.height),
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
    void api.openUrl(href).then((r) => { if (!r.ok) toast(r.error ?? `${href} ließ sich nicht öffnen.`, 'error'); });
    return;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) { toast(`Dieser Link wird aus Sicherheitsgründen nicht geöffnet: ${href.slice(0, 100)}`, 'error'); return; }
  if (TEXT_EXT.test(href.split('/').pop() ?? '') || isPdf(href)) void openCode(href);
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
  insert: (text) => insertToAgent(text),
  toast,
  changed: () => { filesDirty = true; textCache.clear(); void refreshSaveState(); void code.refresh(); },
});

const files = new FileTree($('tab-files'), $('menu-ctx'), {
  open: (n) => {
    if (TEXT_EXT.test(n.name) || isPdf(n.name)) void openCode(n.path);
    // Bilder (etwa Markierungen und Skizzen) öffnen auf der Zeichenfläche (E52), das Bildprogramm gibt es per Rechtsklick
    else if (IMAGE_EXT.test(n.name)) void markImage(n.path);
    else if (VIDEO_EXT.test(n.name)) void videoView.open(n.path);
    else if (/\.(step|stp)$/i.test(n.name)) toast('Fremde STEP-Dateien im Viewer ansehen kommt in einem späteren Schritt. Der Agent kann sie schon jetzt im Skript einbinden.', 'info');
    else toast('Für diesen Dateityp gibt es keine Ansicht in der App. Rechtsklick: „Mit Standardprogramm öffnen“.', 'info');
  },
  create: async (parent, name, dir) => {
    const r = await api.fs.create(parent, name, dir);
    if (!r.ok || !r.path) { toast(r.error ?? `${name} ließ sich nicht anlegen.`, 'error'); return false; }
    await refreshFiles();
    if (!dir && TEXT_EXT.test(name)) void openCode(r.path);
    return true;
  },
  rename: async (rel, name) => {
    if (!fileOpAllowed(rel, 'umbenennen')) return true;
    const wasOpen = code.openUnder(rel);
    const r = await api.fs.rename(rel, name);
    if (!r.ok || !r.path) { toast(r.error ?? `${rel} ließ sich nicht umbenennen.`, 'error'); return false; }
    // Reiter wandern mit: der alte zu, die Datei unter neuem Namen wieder auf (ohne das Panel zu wechseln)
    code.forget(rel);
    for (const f of wasOpen) void code.open(r.path + f.slice(rel.length), undefined, false);
    await refreshFiles();
    return true;
  },
  trash: (rel) => void (async () => {
    if (!fileOpAllowed(rel, 'löschen')) return;
    const r = await api.fs.trash(rel);
    if (r.canceled) return;
    if (!r.ok) { toast(r.error ?? `${rel} ließ sich nicht löschen.`, 'error'); return; }
    code.forget(rel);
    await refreshFiles();
    toast(`${rel} liegt im Papierkorb.`);
  })(),
  reveal: (rel) => void api.fs.reveal(rel).then((r) => { if (!r.ok) toast(r.error ?? 'Der Explorer ließ sich nicht öffnen.', 'error'); }),
  openExternal: (rel) => void openExternal(rel),
  mark: (rel) => void markImage(rel),
  toAgent: (rel) => insertToAgent(`[Datei: ${rel}] `),
  copyPath: (rel) => void navigator.clipboard.writeText(rel).then(() => toast(`Pfad kopiert: ${rel}`), (e) => toast(`Der Pfad ließ sich nicht kopieren: ${e instanceof Error ? e.message : String(e)}`, 'error')),
});
fileTree = files;
files.setActive(code.activeFile);

async function openExternal(rel: string): Promise<void> {
  const r = await api.fs.openExternal(rel);
  if (!r.ok) toast(r.error ?? `${rel} ließ sich nicht öffnen.`, 'error');
}

/** Umbenennen und Löschen nur ohne ungespeicherte Eingaben im Editor, sonst gingen sie unter dem alten Namen verloren. */
function fileOpAllowed(rel: string, what: string): boolean {
  const open = code.unsaved().filter((f) => f === rel || f.startsWith(`${rel}/`));
  if (!open.length) return true;
  toast(`Zum ${what === 'löschen' ? 'Löschen' : 'Umbenennen'} erst speichern oder die Änderungen verwerfen: ${open.join(', ')}`, 'error');
  return false;
}

async function refreshFiles(): Promise<void> {
  if (panel !== 'files') { filesDirty = true; return; }
  filesDirty = false;
  try { files.render(await api.fs.list()); } catch { /* Projekt wechselt gerade */ }
}

$('btn-file-new').addEventListener('click', () => files.startCreate('', false));
$('btn-folder-new').addEventListener('click', () => files.startCreate('', true));

// Dateien und Ordner ziehen: überall im Fenster ablegen landet in inputs/. Ohne das würde Electron die Datei als Seite öffnen.
// Bauteile und Dateien aus der App lassen sich ins Terminal ziehen (ersetzt die Übergabeleiste, Entwurf 2).
let dragDepth = 0;
const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
const isInternal = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].some((t) => t === DRAG_PART || t === DRAG_FILE);
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
    const partId = e.dataTransfer?.getData(DRAG_PART), rel = e.dataTransfer?.getData(DRAG_FILE);
    if (partId) { selectPart(partId, null); insertToAgent(selectionText()); } else if (rel) insertToAgent(`[Datei: ${rel}] `);
    return;
  }
  const list = [...(e.dataTransfer?.files ?? [])];
  if (list.length && project) void importFiles(list);
});

async function importFiles(list: File[]): Promise<void> {
  const r = await api.fs.importFiles(list);
  showPanel('files');
  const lines: string[] = [];
  if (r.files.length) lines.push(`In inputs/ abgelegt: ${r.files.map((f) => f.replace(/^inputs\//, '')).join(', ')}`, 'Der Agent kann sie jetzt im Skript einbinden.');
  // Ein Ordner voller Verknüpfungen soll die Meldung nicht über den Bildschirm ziehen
  const shown = r.errors.slice(0, 8);
  if (r.errors.length > shown.length) shown.push(`… und ${r.errors.length - shown.length} weitere`);
  if (r.errors.length) lines.push(`Nicht übernommen:\n${shown.join('\n')}`);
  if (lines.length) toast(lines.join('\n'), r.errors.length ? 'error' : 'ok');
}

// ---- Bauteile und Auswahl ---------------------------------------------------------------------------------------

const partsCard = new PartsCard({
  list: $('tab-model'), count: $('parts-count'), search: $<HTMLButtonElement>('btn-parts-search'), filter: $<HTMLInputElement>('parts-filter'),
}, {
  select: (id) => selectPart(id, null, true),
  setVisible: (ids, on) => { viewer.setVisible(ids, on); resultTool.forgetProbe(); },
  isVisible: (id) => viewer.isVisible(id),
  setGhost: (ids, on) => { viewer.setGhosted(ids, on); resultTool.forgetProbe(); },
  isGhost: (id) => viewer.isGhosted(id),
  context: (id, x, y) => openPartMenu(id, x, y),
  groupContext: (ids, name, x, y) => openGroupMenu(ids, name, x, y),
});

const refreshPartsCard = () => { partsCard.set(viewer.partList(), viewer.selection); renderViewSwitch(); };
const partEntry = (id: string): PartMap | undefined => map?.parts.find((x) => x.id === id);
const partInfo = (id: string) => viewer.partList().find((x) => x.id === id);
const lineRange = (e: PartMap) => ({ from: e.line!, to: e.end_line && e.end_line >= e.line! ? e.end_line : e.line! });

function selectPart(id: string | null, pick: PickResult | null, focus = false): void {
  selection = id ? { partId: id, pick } : null;
  if (!pick) viewer.select(id); // ein Klick im Viewer hat die Auswahl dort schon gesetzt
  if (id && focus) viewer.focusPart(id);
  partsCard.select(id);
  void renderSelection();
}

viewer.onPick = (r) => selectPart(r?.partId ?? null, r);

async function renderSelection(): Promise<void> {
  const card = $('selcard');
  if (!selection) { card.hidden = true; return; }
  const { partId, pick } = selection;
  const p = partInfo(partId);
  const e = partEntry(partId);
  const name = e?.name ?? p?.name ?? partId;
  // Zukaufteile (Normteile aus soma.fasteners, E48) sehen aus wie eigene Teile, der Zusatz unterscheidet sie
  $('sel-name').textContent = name + (p?.role === 'reference' ? ' (Referenz)' : p?.role === 'hardware' ? ' (Zukaufteil)' : '');
  $('sel-name').title = p?.group ? `Gruppe ${p.group}` : '';
  $('sel-swatch').style.background = p?.color ?? '';
  const bits = pick?.faceId != null
    ? ['Fläche', surfaceName(pick.surface), ...(pick.area != null ? [`${num(pick.area)} mm²`] : [])]
    : pick?.cut ? ['Schnittfläche', 'ganzes Bauteil'] : ['ganzes Bauteil'];
  $('info').textContent = bits.join(' · ');
  const peek = $('code');
  const hasCode = !!(e?.file && e.line);
  $<HTMLButtonElement>('btn-sel-code').disabled = !hasCode;
  card.hidden = false;
  if (!hasCode) { peek.replaceChildren(); return; }
  const { from, to } = lineRange(e!);
  const last = Math.min(to, from + 3);
  const head = el('div', { className: 'ph' }, el('span', { textContent: e!.file! }), el('span', { textContent: `Zeile ${from}${to !== from ? '–' + to : ''}` }));
  try {
    const src = (await readText(e!.file!)).split(/\r?\n/);
    if (selection?.partId !== partId) return; // inzwischen etwas anderes gewählt
    peek.replaceChildren(head, ...codeRows(src.slice(from - 1, last), from, { from, to, kind: 'hl' }));
    if (to > last) peek.append(el('div', { className: 'ph', textContent: `… bis Zeile ${to}` }));
  } catch { peek.replaceChildren(head, el('div', { className: 'ph', textContent: `${e!.file} nicht lesbar` })); }
  if (codeOpen) void code.follow(e!.file!, { from, to, label: name, color: p?.color });
}

/** Text für die Eingabe des Agenten. Zahlen mit Punkt, damit sie eindeutig bleiben. */
function selectionText(): string | null {
  if (!selection) return null;
  const e = partEntry(selection.partId);
  const group = partInfo(selection.partId)?.group;
  const bits = [`Bauteil "${e?.name ?? partInfo(selection.partId)?.name ?? selection.partId}"${group ? ` in Gruppe "${group}"` : ''}`];
  if (e?.file && e.line) { const { from, to } = lineRange(e); bits.push(`${e.file} Zeile ${from}${to !== from ? '-' + to : ''}`); }
  const pk = selection.pick;
  if (pk?.faceId != null) {
    bits.push(`angeklickte Fläche: ${surfaceName(pk.surface)}${pk.area != null ? `, ${pk.area.toFixed(1)} mm²` : ''}, Punkt (${pk.point.map((v) => v.toFixed(1)).join(', ')}) mm`);
  }
  return `[Auswahl: ${bits.join(', ')}] `;
}

function errorText(): string | null {
  const e = buildStatus.state === 'error' ? buildStatus.result?.error : undefined;
  if (!e) return null;
  const where = e.file ? `${e.file}${e.line ? ` Zeile ${e.line}` : ''}: ` : '';
  return `[Build-Fehler: ${where}${e.message.replace(/\s+/g, ' ').trim().slice(0, 400)}] `;
}

/** Fügt Text in die Eingabezeile des aktiven Terminals ein. Abschicken macht der Nutzer selbst (E11). `done` steht vor der Meldung. */
function insertToAgent(text: string | null, done?: string): void {
  if (!text) return;
  const pre = done ? `${done}\n` : '';
  if (!terminals.count) { toast(`${pre}Kein Terminal offen. Starte über + einen Agenten oder ein Terminal.`, 'error'); return; }
  setAgentCollapsed(false);
  const title = terminals.insert(text);
  if (title) toast(`${pre}In die Eingabe von ${title} eingefügt. Enter schickt ab.`);
  else toast(`${pre}Alle Terminals sind beendet. Öffne über + ein neues.`, 'error');
}

// ---- Messen (E9) ------------------------------------------------------------------------------------------------

const measureTool = new MeasureTool({
  card: $('measure-card'), body: $('measure-body'), button: $<HTMLButtonElement>('btn-measure'), close: $<HTMLButtonElement>('btn-measure-close'),
  again: $<HTMLButtonElement>('btn-measure-again'), agent: $<HTMLButtonElement>('btn-measure-agent'), viewerEl: $('viewer'),
}, {
  viewer,
  source: () => (versions.previewed ? { preview: versions.previewed.hash } : 'live'),
  build: () => map?.build ?? null,
  part: (id) => partEntry(id),
  insert: (t) => insertToAgent(t),
});

// ---- Schnitt ----------------------------------------------------------------------------------------------------

const sectionTool = new SectionTool({
  card: $('section-card'), button: $<HTMLButtonElement>('btn-section'), close: $<HTMLButtonElement>('btn-section-close'),
  axes: $('section-axes'), label: $('section-label'), range: $<HTMLInputElement>('section-range'), value: $<HTMLInputElement>('section-value'),
  hint: $('section-hint'), flip: $<HTMLButtonElement>('btn-section-flip'), look: $<HTMLButtonElement>('btn-section-look'),
}, { viewer });

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
  try { url = await imageUrl(rel); } catch (e) { toast(`${rel} lässt sich nicht lesen: ${e instanceof Error ? e.message : String(e)}`, 'error'); return; }
  try {
    img = new Image();
    img.src = url;
    await img.decode();
  } catch {
    toast(`${rel} ließ sich nicht als Bild laden. Rechtsklick: „Mit Standardprogramm öffnen“.`, 'error');
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
  const c = await api.dialog.choose({ title: 'Markierung', message: 'Die offene Markierung ist noch nicht an den Agenten gegeben.', detail: `Verwerfen und ${source} öffnen?`, buttons: ['Verwerfen und wechseln', 'Abbrechen'] });
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
    if (!r.ok || !r.path) { toast(`Die Markierung ließ sich nicht speichern: ${r.error ?? 'unbekannter Fehler'}`, 'error'); return; }
    const old = versions.previewed, source = markup.source;
    markup.close();
    void refreshFiles(); // die neue Markierung steht gleich im Dateibaum
    // Zeigt das Bild einen alten Stand, einen Schnitt oder eine Explosion, soll der Agent das wissen (sonst vergleicht er es mit dem
    // aktuellen Code, hält die Schnittfläche für eine echte Fläche oder die auseinandergezogenen Teile für ihre Lage)
    // Auf einem Bild aus dem Projekt gezeichnet: Der Agent soll das Original kennen, Stand und Schnitt spielen dann keine Rolle
    const cut = [sectionTool.agentText(), explodeTool.agentText(), animTool.agentText(), resultTool.agentText()].filter(Boolean).join(', ');
    const note = source ? `, gezeichnet auf ${source}`
      : (old ? `, zeigt den älteren Stand ${old.short} "${old.subject.slice(0, 80)}"` : '') + (cut ? `, ${cut}` : '');
    insertToAgent(`[Markierung: ${r.path}${note}] `, `Markierung gespeichert: ${r.path}`);
  } catch (e) {
    toast(`Die Markierung ließ sich nicht speichern: ${e instanceof Error ? e.message : String(e)}`, 'error');
  } finally { btn.disabled = false; }
}

// ---- Animation, Analyse und Video (E58) -----------------------------------------------------------------------------

const resultLayer = new ResultLayer(viewer);
/** Messen, Explosion, Animation und Analyse schließen sich aus: Jedes braucht das Modell in seiner eigenen Lage. */
const endOthers = (keep: 'measure' | 'explode' | 'anim' | 'result') => {
  if (keep !== 'measure' && measureTool.isActive) measureTool.setActive(false);
  if (keep !== 'explode' && explodeTool.isActive) explodeTool.setActive(false, false);
  if (keep !== 'anim') animTool.setActive(false);
  if (keep !== 'result') resultTool.setActive(false);
};
const animTool = new AnimTool({
  card: $('anim-card'), close: $<HTMLButtonElement>('btn-anim-close'),
  select: $<HTMLSelectElement>('anim-select'), play: $<HTMLButtonElement>('btn-anim-play'), range: $<HTMLInputElement>('anim-range'), time: $('anim-time'),
  loop: $<HTMLButtonElement>('btn-anim-loop'), follow: $<HTMLButtonElement>('btn-anim-follow'), speed: $<HTMLSelectElement>('anim-speed'), hint: $('anim-hint'),
  video: $<HTMLButtonElement>('btn-anim-video'), agent: $<HTMLButtonElement>('btn-anim-agent'), viewerEl: $('viewer'),
}, {
  viewer, list: () => api.anim.list(), build: (f) => api.anim.build(f), readBinary: (rel) => api.fs.readBinary(rel), renderVideo: (id) => api.render.video(id),
  beforeOn: () => endOthers('anim'), insert: (t) => insertToAgent(t), toast, showVideo: (rel) => { void refreshFiles(); void videoView.open(rel); },
  changed: () => renderViewSwitch(),
});
const resultTool = new ResultTool({
  card: $('result-card'), close: $<HTMLButtonElement>('btn-result-close'), select: $<HTMLSelectElement>('result-select'),
  legend: $('result-legend'), summary: $('result-summary'), probe: $('result-probe'), hint: $('result-hint'),
  rerun: $<HTMLButtonElement>('btn-result-rerun'), agent: $<HTMLButtonElement>('btn-result-agent'), viewerEl: $('viewer'),
  femRow: $('result-fem'), deform: $<HTMLSelectElement>('result-deform'), bcs: $<HTMLButtonElement>('btn-result-bcs'),
  field: $<HTMLSelectElement>('result-field'), range: $<HTMLSelectElement>('result-range'), custom: $('result-custom'),
  lo: $<HTMLInputElement>('result-lo'), hi: $<HTMLInputElement>('result-hi'),
}, {
  layer: resultLayer, list: () => api.results.list(), rerun: (id) => api.results.rerun(id), readBinary: (rel) => api.fs.readBinary(rel),
  beforeOn: () => endOthers('result'), insert: (t) => insertToAgent(t), toast,
  changed: () => renderViewSwitch(),
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

function openPartMenu(id: string, x: number, y: number): void {
  const e = partEntry(id);
  const visible = viewer.isVisible(id);
  const ghost = viewer.isGhosted(id);
  const m = $('menu-ctx');
  const items: (HTMLElement | null)[] = [
    el('div', { className: 'mh', textContent: e?.name ?? partInfo(id)?.name ?? id }),
    menuItem('Isolieren', { icon: 'target', onClick: () => { viewer.isolate(id); refreshPartsCard(); } }),
    viewer.hiddenCount ? menuItem('Alle einblenden', { icon: 'eye', onClick: () => { viewer.showAll(); refreshPartsCard(); } }) : null,
    menuItem(visible ? 'Ausblenden' : 'Einblenden', { icon: visible ? 'eyeoff' : 'eye', onClick: () => { viewer.setVisible(id, !visible); refreshPartsCard(); } }),
    menuItem(ghost ? 'Nicht mehr transparent' : 'Transparent', { icon: 'ghost', onClick: () => { viewer.setGhosted(id, !ghost); refreshPartsCard(); } }),
    menuItem('Kamera auf Bauteil', { icon: 'fit', onClick: () => viewer.focusPart(id) }),
    el('div', { className: 'msep' }),
    menuItem('Code zeigen', { icon: 'code', disabled: !e?.file, onClick: () => { selectPart(id, null); if (e?.file && e.line) void openCode(e.file, { ...lineRange(e), label: e.name, color: partInfo(id)?.color }); } }),
    menuItem('An Agent geben', { icon: 'send', onClick: () => { selectPart(id, null); insertToAgent(selectionText()); } }),
    menuItem('Exportieren …', { icon: 'export', onClick: () => { selectPart(id, null); exportScope = 'sel'; openExportMenu(); } }),
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
    el('div', { className: 'mh', textContent: `${name} · ${ids.length} Teil${ids.length === 1 ? '' : 'e'}` }),
    menuItem('Isolieren', { icon: 'target', onClick: () => { viewer.isolate(ids); refreshPartsCard(); } }),
    viewer.hiddenCount ? menuItem('Alle einblenden', { icon: 'eye', onClick: () => { viewer.showAll(); refreshPartsCard(); } }) : null,
    menuItem(anyVisible ? 'Ausblenden' : 'Einblenden', { icon: anyVisible ? 'eyeoff' : 'eye', onClick: () => { viewer.setVisible(ids, !anyVisible); refreshPartsCard(); } }),
    menuItem(allGhost ? 'Nicht mehr transparent' : 'Transparent', { icon: 'ghost', onClick: () => { viewer.setGhosted(ids, !allGhost); refreshPartsCard(); } }),
    menuItem('Kamera auf Gruppe', { icon: 'fit', onClick: () => viewer.setView('fit', ids) }),
  ];
  m.replaceChildren(...items.filter((x): x is HTMLElement => !!x));
  menus.at(m, x, y);
}

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
    main.textContent = 'Installiert Pakete …';
    detail.textContent = s.installing.join(', ');
  } else if (s.state === 'building') {
    dot.className = 'spin';
    dot.append(icon('spin', 14, 2.4));
    main.textContent = 'Baut …';
    detail.textContent = s.queued ? 'weiterer Build vorgemerkt' : '';
  } else if (s.stale) {
    main.textContent = 'Code geändert';
    detail.textContent = 'Auto-Build ist aus';
  } else if (s.state === 'ok') {
    dot.style.background = 'var(--ok)';
    main.textContent = 'Gebaut';
    detail.textContent = `${count} Bauteil${count === 1 ? '' : 'e'} · ${num(secs)} s`;
  } else if (s.state === 'error') {
    const e = s.result?.error;
    dot.style.background = 'var(--err)';
    main.textContent = 'Build fehlgeschlagen';
    detail.textContent = e?.file ? `${e.file}${e.line ? `, Zeile ${e.line}` : ''}` : ERROR_KIND[e?.kind ?? ''] ?? '';
  } else {
    main.textContent = 'Bereit';
    detail.textContent = '';
  }
  void renderErrorCard();
}

async function renderErrorCard(): Promise<void> {
  const s = buildStatus;
  const e = s.state === 'error' && !versions.previewing ? s.result?.error : undefined;
  const hasModel = viewer.partList().length > 0;
  $('viewer').classList.toggle('dim', !!e && hasModel);
  $('lastgood').hidden = !(e && hasModel && lastOkAt);
  if (lastOkAt) $('lastgood').textContent = `Letzter guter Stand · ${fmtWhen(lastOkAt)}`;
  const card = $('errcard');
  if (!e) { card.hidden = true; return; }
  $('err-where').textContent = `${e.file ? `${e.file}${e.line ? `, Zeile ${e.line}` : ''}` : ERROR_KIND[e.kind] ?? e.kind} · ${fmtWhen(errorAt)}`;
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

async function loadModel(): Promise<void> {
  if (versions.previewing) return; // während einer Vorschau bleibt der alte Stand stehen
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
    refreshPartsCard();
    // Flächen-IDs gelten nur für einen Build: nach dem Neuladen bleibt das Bauteil gewählt, die Fläche nicht
    if (selection && !partInfo(selection.partId)) selectPart(null, null);
    else if (selection) { selection.pick = null; viewer.select(selection.partId); void renderSelection(); }
    void renderErrorCard();
    scheduleThumb();
  } catch (e) {
    msg.className = 'error';
    msg.textContent = `Das Modell konnte nicht geladen werden: ${e instanceof Error ? e.message : String(e)}`;
  }
}

let thumbTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleThumb(): void {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => {
    if (versions.previewing) return;
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
    animTool.setActive(false);
    resultTool.setActive(false);
    try {
      map = res.map;
      textCache.clear();
      await viewer.load(res.glb);
      measureTool.reset();
      explodeTool.refresh();
      sectionTool.refresh();
      refreshPartsCard();
      selectPart(null, null);
      void renderErrorCard();
    } catch (e) { toast(`Vorschau nicht darstellbar: ${e instanceof Error ? e.message : String(e)}`, 'error'); }
    renderViewSwitch();
  },
  toast,
  beforeRestore: () => leaveEditor('Stand wiederherstellen'), // Wiederherstellen ersetzt Dateien
});

// ---- Projekt ----------------------------------------------------------------------------------------------------

async function onProject(p: ProjectInfo): Promise<void> {
  project = p;
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
  terminals.closeAll();
  code.reset();
  skills.reset();
  if (panel === 'skills') void skills.refresh();
  if (codeOpen) void code.open('model.py'); // die Code-Spalte bleibt offen, dann nicht leer
  resetViewLists();
  selection = null;
  void renderSelection();
  partsCard.message('Modell wird gebaut …');
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
  b.replaceChildren(icon('alert', 14, 2), `${problems.length} Hinweis${problems.length === 1 ? '' : 'e'}`);
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
  if (!st.zipPath) { dot.style.background = 'var(--warn)'; text = 'Noch nicht gespeichert'; }
  else if (unsaved) { dot.style.background = 'var(--warn)'; text = `Nicht gespeichert${st.savedAt ? ` · zuletzt ${fmtWhen(st.savedAt)}` : ''}`; }
  else { dot.style.background = 'var(--ok)'; text = `Gespeichert${st.savedAt ? ` · ${fmtWhen(st.savedAt)}` : ''}`; }
  const b = $('save-badge');
  b.replaceChildren(dot, text);
  b.title = st.zipPath ? `ZIP: ${st.zipPath}` : 'Noch nicht als ZIP gespeichert. Strg+S speichert.';
  versions.setSaved(st.zipPath ? st.savedHead : null);
  document.title = `SOMA – ${project?.name ?? ''}${unsaved ? ' ●' : ''}`;
}

async function refreshSaveState(): Promise<void> {
  try { renderSaveState(await api.project.saveState()); } catch { /* Projekt wechselt gerade */ }
}

/**
 * Strg+S im Editor und „Speichern und bauen“: geänderte Dateien schreiben. Gebaut wird nur, wenn darunter eine ist,
 * die das Modell betrifft (Python, inputs/). Keine ZIP, kein Snapshot, das macht „Speichern“ oben.
 */
async function saveCode(): Promise<void> {
  const r = await code.saveAll();
  if (!r.ok) { toast('Nicht alles ließ sich speichern (siehe Hinweis im Code). Gebaut wird erst danach.', 'error'); return; }
  if (r.saved.some(affectsBuild)) await api.build.run();
}

/** Vor Modellwechsel und Wiederherstellen: ungespeicherte Eingaben im Editor nicht still verlieren. false = abbrechen. */
async function leaveEditor(title: string): Promise<boolean> {
  const files = code.unsaved();
  if (!files.length) return true;
  const c = await api.dialog.choose({
    title, message: `Im Editor gibt es ungespeicherte Änderungen: ${files.join(', ')}.`,
    detail: 'Verwerfen legt deine Fassung als Sicherung in den App-Daten ab.', buttons: ['Speichern', 'Verwerfen', 'Abbrechen'],
  });
  if (c === 0) {
    const r = await code.saveAll();
    if (!r.ok) toast('Nicht alles ließ sich speichern (siehe Hinweis im Code-Panel).', 'error');
    return r.ok;
  }
  return c === 1 ? code.discardAll() : false;
}

let saving = false;
/**
 * Speichern kann dauern (ein laufender oder veralteter Build wird abgewartet, dann Snapshot und ZIP): Der Knopf zeigt das
 * sofort, weitere Klicks und Strg+S zählen solange nicht.
 */
async function doSave(saveAs = false): Promise<void> {
  if (saving) return;
  saving = true;
  const btn = $<HTMLButtonElement>('btn-save');
  const label = btn.innerHTML;
  btn.disabled = true;
  btn.classList.add('busy');
  btn.replaceChildren(el('span', { className: 'spin' }, icon('spin', 14, 2.4)), 'Speichert …');
  try {
    // Erst die Eingaben im Editor, sonst fehlten sie in Snapshot und ZIP. Das Speichern baut danach, falls nötig.
    const c = await code.saveAll();
    if (!c.ok) { toast('Nicht alles im Editor ließ sich speichern (siehe Hinweis im Code). Das Modell ist deshalb nicht gespeichert.', 'error'); return; }
    const r = await api.project.save(saveAs);
    if (r.cancelled) return;
    if (r.error) { toast(r.error, 'error'); return; }
    const kb = Math.round((r.bytes ?? 0) / 1024);
    const lines = [`Gespeichert: ${r.zipPath}`, `${r.files} Dateien, ${kb} KB${r.snapshot ? ' · Snapshot im Verlauf angelegt' : ''}`];
    if (r.warnings?.length) lines.push(`Hinweis: ${r.warnings.join(' ')}`);
    toast(lines.join('\n'), r.warnings?.length ? 'error' : 'ok');
    project = await api.project.current(); // der Modellname folgt dem Dateinamen
    $('doc-name').textContent = project.name;
    void refreshSaveState();
  } finally {
    saving = false;
    btn.disabled = false;
    btn.classList.remove('busy');
    btn.innerHTML = label; // fester Text aus index.html, kein Text aus dem Projekt
  }
}

async function doOpen(): Promise<boolean> {
  if (!(await leaveEditor('Modell öffnen'))) return false;
  const r = await api.project.openZip();
  if (r.error) toast(r.error, 'error');
  return !!r.opened;
}

const doNew = async () => { if (await leaveEditor('Neues Modell')) await api.project.create(); };
/** „Jetzt bauen“: baut immer. Vorher werden die Eingaben im Editor gespeichert, sonst sähe der Build sie nicht. */
async function doBuild(): Promise<void> {
  const r = await code.saveAll();
  if (!r.ok) { toast('Nicht alles ließ sich speichern (siehe Hinweis im Code-Panel). Gebaut wird erst danach.', 'error'); return; }
  await api.build.run();
}
const openProject = async (id: string) => { if (await leaveEditor('Modell öffnen')) await api.project.open(id); };

// Kurzbefehle gelten nicht im Terminal: dort gehören Strg+S/Strg+O den Programmen (Claude Code nutzt Strg+O selbst)
window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement | null)?.closest?.('#terminals') || !e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  // Im Editor speichert Strg+S den Code und baut, sonst das ganze Modell als ZIP
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
$('btn-open').addEventListener('click', () => void doOpen());
$('btn-save').addEventListener('click', () => void doSave(false));
$('btn-save-menu').addEventListener('click', () => void doSave(false));
$('btn-saveas').addEventListener('click', () => void doSave(true));
$('btn-reveal').addEventListener('click', () => void api.project.reveal());
$('btn-reveal-menu').addEventListener('click', () => void api.project.reveal());
$('btn-start').addEventListener('click', () => showStart(true));
$('btn-home').addEventListener('click', () => showStart(true));
// Versionsnummer (E68): neben dem Namen auf der Startseite und im Hinweis des Logos
$('start-version').textContent = SOMA_VERSION;
$('btn-home').title = `Startseite · SOMA ${SOMA_VERSION}`;
$('problems').addEventListener('click', () => menus.toggle($('menu-problems'), $('problems')));

// Build
function renderAuto(): void {
  const on = $<HTMLInputElement>('chk-auto').checked;
  $('auto-label').textContent = on ? 'Auto an' : 'Auto aus';
  $('btn-auto').title = on ? 'Baut automatisch, wenn sich der Code ändert. Klick schaltet aus.' : 'Auto-Build ist aus. Klick schaltet ein.';
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
  $('bm-title').textContent = s.state === 'error' ? 'Letzter Build fehlgeschlagen' : s.state === 'building' ? 'Build läuft' : lastOkAt ? `Zuletzt gebaut ${fmtWhen(lastOkAt)}` : 'Noch nicht gebaut';
  $('bm-sub').textContent = s.state === 'ok' ? `${num(secs)} s · ${count} Bauteil${count === 1 ? '' : 'e'} · ${warn.length ? `${warn.length} Warnung${warn.length === 1 ? '' : 'en'}` : 'keine Warnungen'}` : '';
  $('bm-warn').hidden = !warn.length;
  $('bm-warn').textContent = warn.join('\n');
  menus.toggle($('menu-build'), $('btn-buildinfo'));
});

// Darstellung
$('btn-display').addEventListener('click', () => menus.toggle($('menu-display'), $('btn-display'), 'beside'));
document.querySelectorAll<HTMLButtonElement>('[data-display]').forEach((b) => b.addEventListener('click', () => {
  const on = b.getAttribute('aria-checked') !== 'true';
  b.setAttribute('aria-checked', String(on));
  if (b.dataset.display === 'edges') viewer.setEdges(on);
  else if (b.dataset.display === 'wire') viewer.setWireframe(on);
  else viewer.setGhost(on);
}));

// Export
let exportScope: 'all' | 'sel' = 'all';
function renderExportScope(): void {
  const e = selection ? partEntry(selection.partId) : undefined;
  const name = e?.name ?? (selection ? partInfo(selection.partId)?.name : undefined);
  const sel = $<HTMLButtonElement>('exp-sel');
  sel.disabled = !name;
  sel.textContent = name ? `Nur ${name}` : 'Nur Auswahl';
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

/** Exportieren: Der Hauptprozess fragt nach Datei (ein Bauteil) oder Ordner (alle Bauteile) und schreibt erst danach. */
async function doExport(fmt: string, label: string): Promise<ExportResult> {
  menus.close();
  const e = selection ? partEntry(selection.partId) : undefined;
  const part = exportScope === 'sel' ? e?.name ?? partInfo(selection?.partId ?? '')?.name ?? null : null;
  const r = await api.build.export(fmt, part);
  if (r.cancelled) return r;
  const name = (f: string) => f.split(/[\\/]/).pop() ?? f;
  if (r.ok && part) toast(`„${part}“ als ${label} exportiert:\n${r.target ?? r.files[0] ?? ''}`);
  else if (r.ok) toast(`${r.files.length} Datei${r.files.length === 1 ? '' : 'en'} als ${label} exportiert nach ${r.target ?? ''}:\n${r.files.map(name).join(', ') || '(keine Datei)'}`);
  else toast(`Export fehlgeschlagen: ${r.error}`, 'error');
  return r;
}

// ---- Umschalter oben links: was der Viewer zeigt (Entwurf 2) -----------------------------------------------------
// Analysen, Animationen und Videos sind Ergebnisse des Agenten, keine Werkzeuge. Hier wählt man, was der Viewer zeigt.

let viewLists: { results: ResultEntry[]; anims: AnimEntry[]; videos: string[] } = { results: [], anims: [], videos: [] };
/** Schon gesehene Ergebnisse. Was danach dazukommt, bekommt einen Punkt am Umschalter. */
const seen = new Set<string>();
let seenReady = false;
let viewSeq = 0;
let viewTimer: ReturnType<typeof setTimeout> | undefined;

const resultKey = (r: ResultEntry) => `r:${r.id}:${String((r as { created?: unknown }).created ?? '')}`;
const animKey = (a: AnimEntry) => `a:${a.id}`;
const viewKeys = () => [...viewLists.results.map(resultKey), ...viewLists.anims.map(animKey), ...viewLists.videos.map((v) => `v:${v}`)];

function videosIn(nodes: FileNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.dir) { if (!n.name.startsWith('.')) videosIn(n.children ?? [], out); }
    else if (VIDEO_EXT.test(n.name)) out.push(n.path);
  }
  return out;
}

function resetViewLists(): void {
  viewSeq++;
  viewLists = { results: [], anims: [], videos: [] };
  seen.clear();
  seenReady = false;
  renderViewSwitch();
  void refreshViewLists();
}

async function refreshViewLists(): Promise<void> {
  if (!project) return;
  const seq = ++viewSeq;
  const [results, anims, nodes] = await Promise.all([
    api.results.list().catch(() => [] as ResultEntry[]), api.anim.list().then((l) => l.animations).catch(() => [] as AnimEntry[]), api.fs.list().catch(() => [] as FileNode[]),
  ]);
  if (seq !== viewSeq) return;
  viewLists = { results, anims, videos: videosIn(nodes) };
  // Was beim Öffnen des Modells schon da ist, gilt als gesehen
  if (!seenReady) { for (const k of viewKeys()) seen.add(k); seenReady = true; }
  renderViewSwitch();
}
const scheduleViewLists = () => { clearTimeout(viewTimer); viewTimer = setTimeout(() => void refreshViewLists(), 400); };

function renderViewSwitch(): void {
  const prev = versions.previewed;
  let ico = 'cube', name = 'Modell', sub = '', closable = false;
  const n = viewer.partList().length;
  if (prev) { ico = 'history'; name = `Stand ${prev.short}`; sub = 'nur ansehen'; closable = true; }
  // Bei Analyse und Animation sagt das Symbol, was es ist: Der Platz gehört dem Namen
  else if (resultTool.isActive) { ico = 'gauge'; name = resultTool.currentTitle ?? 'Analyse'; closable = true; }
  else if (animTool.isActive) { ico = 'anim'; name = animTool.currentName ?? 'Animation'; closable = true; }
  else sub = n ? `${n} Bauteil${n === 1 ? '' : 'e'}` : '';
  $('view-ico').replaceChildren(icon(ico, 16));
  $('view-name').textContent = name;
  $('view-sub').textContent = sub;
  $('btn-view').title = resultTool.isActive && !prev ? `Analyse: ${name}` : animTool.isActive && !prev ? `Animation: ${name}` : 'Was der Viewer zeigt: das Modell, eine Analyse, eine Animation oder ein Video';
  $('view-switch').classList.toggle('vio', !!prev);
  $('view-switch').classList.toggle('result', !prev && (resultTool.isActive || animTool.isActive));
  $('btn-view-close').hidden = !closable;
  $('view-sep').hidden = !closable;
  const unseen = viewKeys().filter((k) => !seen.has(k)).length;
  const badge = $('view-new');
  badge.hidden = !unseen;
  badge.dataset.n = String(unseen);
  badge.textContent = `${unseen} neu`;
  badge.title = 'Neue Ergebnisse des Agenten. Klick zeigt die Liste.';
}

/** Eintrag im Menü des Umschalters. `dot`: Statusfarbe (Fundstellen), `isNew`: noch nicht gesehen. */
function viewItem(ico: string, label: string, opts: { sub?: string; on?: boolean; dot?: string; isNew?: boolean; title?: string; onClick: () => void }): HTMLButtonElement {
  const d = opts.dot ? el('span', { className: 'dot' }) : null;
  if (d) d.style.background = opts.dot!;
  const b = el('button', { className: 'mi' + (opts.on ? ' cur' : ''), title: opts.title ?? '' },
    icon(ico, 15), el('span', { className: 'vl', textContent: label }), opts.isNew ? el('span', { className: 'tag acc', textContent: 'neu' }) : null,
    el('span', { className: 'k' }, d, opts.sub ?? '', el('span', { className: 'chk' }, icon('check', 14, 2.2))));
  b.setAttribute('role', 'menuitemradio');
  b.setAttribute('aria-checked', String(!!opts.on));
  b.addEventListener('click', opts.onClick);
  return b;
}

async function openViewMenu(): Promise<void> {
  const m = $('menu-view');
  if (menus.isOpen(m)) { menus.close(); return; }
  await refreshViewLists();
  const n = viewer.partList().length;
  const items: HTMLElement[] = [viewItem('cube', 'Modell', { sub: `${n} Bauteil${n === 1 ? '' : 'e'}`, on: !resultTool.isActive && !animTool.isActive, onClick: () => showModelView() })];
  const { results, anims, videos } = viewLists;
  const head = (t: string, src: string) => el('div', { className: 'mh' }, t, el('span', { className: 'src', textContent: src }));
  if (results.length) {
    items.push(el('div', { className: 'msep' }), head('ANALYSEN', '.soma/results/'));
    for (const r of results) {
      const bad = r.parts.filter((x) => x.critical > 0).length;
      items.push(viewItem('gauge', r.id === r.kind ? r.title : `${r.title} (${r.id})`, {
        sub: r.stale ? 'veraltet' : bad ? `${bad} Bauteil${bad === 1 ? '' : 'e'} kritisch` : 'in Ordnung', dot: r.stale ? 'var(--tx3)' : bad ? 'var(--err)' : 'var(--ok)',
        on: resultTool.isActive && resultTool.currentId === r.id, isNew: !seen.has(resultKey(r)), onClick: () => resultTool.show(r.id),
      }));
    }
  }
  if (anims.length) {
    items.push(el('div', { className: 'msep' }), head('ANIMATIONEN', 'animations/'));
    for (const a of anims) {
      items.push(viewItem('anim', a.name, { sub: `${a.duration.toFixed(1).replace('.', ',')} s`, on: animTool.isActive && animTool.currentId === a.id, isNew: !seen.has(animKey(a)), title: a.file, onClick: () => animTool.show(a.id) }));
    }
  }
  if (videos.length) {
    items.push(el('div', { className: 'msep' }), head('VIDEOS', 'renders/'));
    for (const v of videos) items.push(viewItem('f-video', v.split('/').pop() ?? v, { isNew: !seen.has(`v:${v}`), title: v, onClick: () => void videoView.open(v) }));
  }
  if (!results.length && !anims.length && !videos.length) {
    items.push(el('div', { className: 'msep' }), el('div', {
      className: 'mnote', textContent: 'Noch keine Ergebnisse. Der Agent legt sie an: Analysen mit soma analyze, Animationen in animations/, Videos mit soma render (Skills „Analyse“ und „Animation und Video“).',
    }));
  }
  m.replaceChildren(...items);
  for (const k of viewKeys()) seen.add(k);
  renderViewSwitch();
  menus.toggle(m, $('btn-view'));
}

/** Zurück zum Modell: Analyse und Animation beenden, eine Vorschau verlassen. */
function showModelView(): void {
  if (versions.previewing) { $('btn-live').click(); return; }
  animTool.setActive(false);
  resultTool.setActive(false);
}
$('btn-view').addEventListener('click', () => void openViewMenu());
$('btn-view-close').addEventListener('click', () => showModelView());

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
  if (e?.file) void openCode(e.file, e.line ? { from: e.line, to: e.line, label: 'Build-Fehler', kind: 'er' } : undefined);
});
$('btn-err-details').addEventListener('click', () => {
  const t = $('err-trace');
  t.hidden = !t.hidden;
  $('btn-err-details').setAttribute('aria-expanded', String(!t.hidden));
});
$('btn-err-fold').addEventListener('click', () => {
  const folded = $('errcard').classList.toggle('folded');
  $('btn-err-fold').setAttribute('aria-expanded', String(!folded));
  $('btn-err-fold').setAttribute('aria-label', folded ? 'Meldung ausklappen' : 'Meldung einklappen');
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
    const b = el('button', { className: 'mi', disabled: !a.found, title: a.found ? `${a.command} in einem neuen Tab starten` : `${a.command} wurde im PATH nicht gefunden. Installiere den Agenten selbst, dann erscheint er hier.` },
      el('span', { className: 'noico' }, d), el('span', { textContent: a.label }), a.found ? null : el('span', { className: 'k', textContent: 'nicht installiert' }));
    b.setAttribute('role', 'menuitem');
    b.addEventListener('click', () => { setAgentCollapsed(false); void terminals.add({ command: a.command, title: a.label }); });
    return b;
  }));
  if (!agents.length) $('agent-list').append(el('div', { className: 'mnote', textContent: 'Suche nach Agenten …' }));
}
$('btn-term-add').addEventListener('click', () => { renderAgentMenu(); menus.toggle($('menu-agents'), $('btn-term-add')); });
$('btn-term-plain').addEventListener('click', () => void terminals.add({ title: 'Terminal' }));

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
  $('btn-start-close').hidden = !project;
  $('start-note').hidden = store.get('soma.noteSeen') === '1';
  let list: { id: string; name: string; modified: number }[] = [];
  try { list = await api.project.list(); } catch { /* ohne Liste */ }
  list.sort((a, b) => b.modified - a.modified);
  $('start-recent').replaceChildren(...list.slice(0, 12).map((p) => {
    const th = el('div', { className: 'th' }, icon('cube', 36, 1.2));
    void api.project.thumb(p.id).then((url) => { if (url) th.replaceChildren(el('img', { src: url, alt: '' })); });
    const cur = p.id === project?.id;
    const card = el('button', { className: 'recent' + (cur ? ' cur' : ''), title: cur ? 'Gerade geöffnet' : `${p.name} öffnen` },
      th, el('div', { className: 'meta' }, el('b', { textContent: p.name }), el('span', { textContent: cur ? 'geöffnet' : `geändert ${fmtWhen(p.modified, true)}` })));
    card.addEventListener('click', () => { if (!cur) void openProject(p.id); showStart(false); });
    return card;
  }));
  if (!list.length) $('start-recent').append(el('div', { className: 'c3', textContent: 'Noch keine Modelle auf diesem Rechner.' }));
  if (!agents.length && project) await refreshAgents();
  $('start-agents').replaceChildren(...agents.map((a) => el('div', { className: 'agrow' },
    el('span', { className: a.found ? 'ok' : 'no' }, icon(a.found ? 'check' : 'x', 16, 2.2)),
    el('div', {}, el('b', { textContent: a.label }), el('span', { textContent: a.found ? `gefunden (${a.command})` : 'nicht installiert' })))));
}
$('btn-start-close').addEventListener('click', () => showStart(false));
$('start-new').addEventListener('click', () => { void doNew(); showStart(false); });
$('start-open').addEventListener('click', () => { void doOpen().then((ok) => { if (ok) showStart(false); }); });
$('btn-note-ok').addEventListener('click', () => { store.set('soma.noteSeen', '1'); $('start-note').hidden = true; });

// ---- Ereignisse vom Hauptprozess --------------------------------------------------------------------------------

api.project.onChanged((p) => void onProject(p));
let buildStarts = 0; // Prüfhilfe: Wie oft hat ein Build begonnen?
api.build.onStatus((s) => {
  if (s.state === 'building' && buildStatus.state !== 'building') buildStarts++;
  renderBuild(s);
  if (s.state === 'ok' && !s.stale) { void loadModel(); void refreshFiles(); void refreshViewLists(); }
});
// Auch bei geschlossenem Code abgleichen: Offene Dateien können ungesicherte Eingaben enthalten
api.fs.onChanged(() => { textCache.clear(); void refreshFiles(); void code.refresh(); scheduleViewLists(); });
// Beim Beenden fragt der Hauptprozess, was im Editor ungespeichert ist, und lässt speichern oder verwerfen
api.fs.onEditorRequest(async (action) => {
  if (action === 'status') return { dirty: code.unsaved() };
  if (action === 'save') return { ok: (await code.saveAll()).ok };
  return { ok: await code.discardAll() };
});
api.versions.onChanged(() => void versions.refresh());
api.anim.onChanged(() => { void animTool.refresh(); scheduleViewLists(); });
api.render.onProgress((f) => animTool.progress(f));
// Bilder und Videos, die der Agent erzeugt hat: kurz Bescheid geben, ein Klick im Dateibaum öffnet sie
api.render.onNotice((n) => {
  if (!n.byAgent) return;
  if (n.ok) toast(`Der Agent hat ${n.files.join(', ')} erzeugt.`, 'info');
  void refreshFiles();
  scheduleViewLists();
});
// Ergebnisse von soma analyze melden sich nicht von selbst (.soma/results/ beobachtet niemand): ab und zu nachsehen
setInterval(() => { if (project && !document.hidden) void refreshViewLists(); }, 10000);
window.addEventListener('focus', () => scheduleViewLists());
api.project.onSaveState((st) => renderSaveState(st));
// Das Projekt kommt ausschließlich über das Ereignis (der Hauptprozess öffnet es beim Start). Ein zweiter Weg würde alles doppelt aufbauen.

if (store.get('soma.agentCollapsed') === '1') setAgentCollapsed(true);
// Seitenleiste wie beim letzten Mal, beim ersten Start mit den Bauteilen
{
  const side = store.get('soma.side');
  showPanel(side === null ? 'parts' : side === 'parts' || side === 'files' || side === 'skills' ? side : null);
}
// Beim allerersten Start die Startseite zeigen (mit dem Hinweis auf die Rechte des Agenten). Tests überspringen das.
if (!api.testMode && store.get('soma.startSeen') !== '1') { store.set('soma.startSeen', '1'); void showStart(true); }

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
    treeNames: () => [...document.querySelectorAll('#tab-model .pname')].map((x) => x.textContent),
    termText: (id: number) => terminals.text(id),
    versions: () => versions.state(),
    saveState: () => saveState,
    toast: () => ({ text: $('toast').textContent, hidden: $('toast').hidden, error: $('toast').classList.contains('error') }),
    banner: () => ({ hidden: $('preview-banner').hidden, text: $('preview-banner').textContent }),
    partSize: (name: string) => { const p = viewer.partList().find((x) => x.name === name); return p ? viewer.partSize(p.id) : null; },
    versionsUi: () => ({ restoreHidden: $('btn-restore').hidden, problem: $('vproblem').hidden ? '' : $('vproblem').textContent }),
    selectionText, errorText,
    markup: () => markup.state(),
    measure: () => measureTool.state(),
    section: () => sectionTool.state(),
    explode: () => explodeTool.state(),
    busy: () => busy.state(),
    anim: () => animTool.state(),
    animSeek: (t: number) => animTool.testSeek(t),
    animRefresh: () => animTool.refresh(),
    result: () => resultTool.state(),
    resultRefresh: () => resultTool.refresh(),
    resultPin: (x: number, y: number) => resultTool.testPin(x, y),
    video: () => videoView.state(),
    videoOpen: (rel: string) => videoView.open(rel),
    videoSeek: (t: number) => videoView.testSeek(t),
    skills: () => skills.state(),
    pick: () => selection?.pick ?? null,
    markPixel: (x: number, y: number) => markup.pixel(x, y),
    markHandles: () => markup.handles(),
    markImage: (rel: string) => markImage(rel),
    insert: (text: string) => insertToAgent(text),
    showPanel: (p: PanelName | 'code' | null) => (p === 'code' ? showCode(true) : showPanel(p)),
    showCode,
    layout: () => ({ side: panel, code: codeOpen, agent: !$('terminals').classList.contains('collapsed') }),
    viewSwitch: () => ({ name: $('view-name').textContent, sub: $('view-sub').textContent, unseen: $('view-new').hidden ? 0 : Number($('view-new').dataset.n ?? 0), closable: !$('btn-view-close').hidden }),
    openViewMenu: () => openViewMenu(),
    viewMenu: () => [...$('menu-view').querySelectorAll('.mi')].map((x) => x.textContent),
    refreshViewLists: () => refreshViewLists(),
    openSkill: (id: string | null) => skills.openDetail(id),
    /** Export wie über das Menü (`sel`: das ausgewählte Bauteil), liefert das Ergebnis. */
    exportAs: (fmt: string, scope: 'all' | 'sel') => { exportScope = scope; return doExport(fmt, fmt.toUpperCase()); },
    showStart: (on: boolean) => showStart(on),
    setAgentCollapsed,
    fileRows: () => [...document.querySelectorAll('#tab-files .frow .fn')].map((x) => x.textContent),
    codeText: () => code.text(),
    openCode: (file: string) => openCode(file),
    buildStarts: () => buildStarts,
    editor: code.testApi(),
  };
}
