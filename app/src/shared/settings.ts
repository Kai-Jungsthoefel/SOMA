// Einstellungen der App (E81), gemeinsam für Hauptprozess und Renderer: Werte, Vorgaben und Prüfung.
// Gespeichert in `<App-Daten>/settings.json`. Was dort fehlt oder nicht passt, gilt mit der Vorgabe und wird gemeldet.

/** Mausbelegung des Viewers nach dem Vorbild bekannter CAD-Programme. `soma`: wie bisher (links drehen, rechts verschieben). */
export type NavPreset = 'soma' | 'solidworks' | 'fusion' | 'onshape' | 'creo' | 'rhino';
export type NavAction = 'rotate' | 'pan' | 'zoom';
export type NavButton = 'left' | 'middle' | 'right';
/** Gehaltene Taste beim Ziehen. Strg und auf dem Mac Cmd zählen gleich. */
export type NavMod = '' | 'shift' | 'ctrl';
export interface NavBinding { button: NavButton; mod: NavMod; action: NavAction }
export type Projection = 'perspective' | 'orthographic';

export interface ViewerPrefs {
  navigation: NavPreset;
  /** Mausrad und Zoomen durch Ziehen andersherum. */
  invertZoom: boolean;
  projection: Projection;
  /** Darstellung, wenn ein Modell geöffnet wird (Menü „Display“). */
  edges: boolean;
  wireframe: boolean;
  transparent: boolean;
  /** Nachkommastellen der Messwerte in der Oberfläche. Der Text für den Agenten hat immer drei. */
  decimals: number;
}
export interface AppSettings { viewer: ViewerPrefs }
/** Änderung aus dem Renderer: nur die Werte, die sich ändern sollen. */
export interface SettingsPatch { viewer?: Partial<ViewerPrefs> }
/** `problem`: settings.json war nicht lesbar oder enthielt Unbekanntes, es gelten (teils) die Vorgaben. */
export interface SettingsState { settings: AppSettings; problem?: string }
export interface SettingsResult extends SettingsState { ok: boolean; error?: string; backup?: string | null }

export const DECIMALS = { min: 0, max: 4 };
export const DEFAULT_SETTINGS: AppSettings = {
  viewer: { navigation: 'soma', invertZoom: false, projection: 'perspective', edges: true, wireframe: false, transparent: false, decimals: 2 },
};

const NAV = (spec: string): NavBinding[] => spec.split(',').map((s) => {
  const [mod, button, action] = s.trim().split(' ');
  return { mod: (mod === '-' ? '' : mod) as NavMod, button: button as NavButton, action: action as NavAction };
});

/**
 * Belegungen. Die Vorbilder sind die Standardbelegungen der Programme, so wie sie Umsteiger in der Hand haben. Die linke Taste
 * wählt in den CAD-Belegungen nur aus, Ziehen mit ihr tut dort nichts. Das Mausrad zoomt immer. `soma` entspricht genau dem,
 * was OrbitControls von sich aus tut (mit Umschalt oder Strg tauschen Drehen und Verschieben).
 */
export const NAV_PRESETS: { id: NavPreset; label: string; bindings: NavBinding[] }[] = [
  { id: 'soma', label: 'SOMA', bindings: NAV('- left rotate, shift left pan, ctrl left pan, - right pan, shift right rotate, ctrl right rotate, - middle zoom, shift middle zoom, ctrl middle zoom') },
  { id: 'solidworks', label: 'SolidWorks', bindings: NAV('- middle rotate, ctrl middle pan, shift middle zoom') },
  { id: 'fusion', label: 'Fusion 360, Inventor', bindings: NAV('- middle pan, shift middle rotate') },
  { id: 'onshape', label: 'Onshape', bindings: NAV('- right rotate, ctrl right pan, - middle pan') },
  { id: 'creo', label: 'Creo, NX, Blender', bindings: NAV('- middle rotate, shift middle pan, ctrl middle zoom') },
  { id: 'rhino', label: 'Rhino', bindings: NAV('- right rotate, shift right pan, ctrl right zoom') },
];

export const navPreset = (id: NavPreset) => NAV_PRESETS.find((p) => p.id === id) ?? NAV_PRESETS[0];

/** Was eine Taste mit gehaltener Taste in dieser Belegung tut, null: nichts. */
export function navAction(id: NavPreset, button: NavButton, mod: NavMod): NavAction | null {
  return navPreset(id).bindings.find((b) => b.button === button && b.mod === mod)?.action ?? null;
}

const MOD_LABEL: Record<NavMod, string> = { '': '', shift: 'Shift', ctrl: 'Ctrl' };
/**
 * Belegung in Worten, je Aktion: „Pan: right drag, Shift or Ctrl + left drag“. Erst Ziehen ohne Taste, dann mit gehaltener
 * Taste, gleiche Maustaste mit Umschalt und Strg zusammengefasst. Zum Zoomen steht das Mausrad vorn.
 */
export function navLegend(id: NavPreset): { action: NavAction; label: string; how: string }[] {
  const out: { action: NavAction; label: string; how: string }[] = [];
  const buttons: NavButton[] = ['left', 'middle', 'right'];
  for (const [action, label] of [['rotate', 'Rotate'], ['pan', 'Pan'], ['zoom', 'Zoom']] as [NavAction, string][]) {
    const bs = navPreset(id).bindings.filter((b) => b.action === action);
    const ways: string[] = action === 'zoom' ? ['wheel'] : [];
    for (const button of buttons) if (bs.some((b) => b.button === button && !b.mod)) ways.push(`${button} drag`);
    for (const button of buttons) {
      const held = bs.filter((b) => b.button === button && b.mod).map((b) => MOD_LABEL[b.mod]);
      if (held.length) ways.push(`${held.join(' or ')} + ${button} drag`);
    }
    out.push({ action, label, how: ways.length ? ways.join(', ') : '–' });
  }
  return out;
}

const isNav = (v: unknown): v is NavPreset => NAV_PRESETS.some((p) => p.id === v);
const isProjection = (v: unknown): v is Projection => v === 'perspective' || v === 'orthographic';
const isDecimals = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= DECIMALS.min && v <= DECIMALS.max;
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const VIEWER_CHECKS: { [K in keyof ViewerPrefs]: (v: unknown) => boolean } = {
  navigation: isNav, invertZoom: isBool, projection: isProjection, edges: isBool, wireframe: isBool, transparent: isBool, decimals: isDecimals,
};

/**
 * Gelesene Einstellungen (nicht vertrauenswürdig) auf gültige Werte bringen: Fehlendes bekommt die Vorgabe, Ungültiges
 * ebenfalls, wird aber in `ignored` genannt (melden statt still reparieren). Unbekannte Schlüssel fallen weg.
 */
export function cleanSettings(raw: unknown): { settings: AppSettings; ignored: string[] } {
  const ignored: string[] = [];
  const v = (raw && typeof raw === 'object' ? (raw as Record<string, unknown>).viewer : undefined) as Record<string, unknown> | undefined;
  const viewer = { ...DEFAULT_SETTINGS.viewer } as Record<string, unknown>;
  if (v !== undefined && (!v || typeof v !== 'object' || Array.isArray(v))) ignored.push('viewer');
  else if (v) {
    for (const [k, check] of Object.entries(VIEWER_CHECKS)) {
      if (!(k in v)) continue;
      if (check(v[k])) viewer[k] = v[k]; else ignored.push(`viewer.${k}`);
    }
  }
  return { settings: { viewer: viewer as unknown as ViewerPrefs }, ignored };
}

/** Änderung prüfen und anwenden. Ein ungültiger Wert verhindert die ganze Änderung (Rückgabe: Fehlertext). */
export function applyPatch(cur: AppSettings, patch: unknown): { settings: AppSettings } | { error: string } {
  if (!patch || typeof patch !== 'object') return { error: 'No settings to change.' };
  const p = patch as Record<string, unknown>;
  const unknown = Object.keys(p).filter((k) => k !== 'viewer');
  if (unknown.length) return { error: `Unknown setting “${unknown[0]}”.` };
  const v = p.viewer;
  if (v === undefined) return { settings: cur };
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { error: 'Invalid viewer settings.' };
  const viewer = { ...cur.viewer } as Record<string, unknown>;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const check = (VIEWER_CHECKS as Record<string, (x: unknown) => boolean>)[k];
    if (!check) return { error: `Unknown setting “viewer.${k}”.` };
    if (!check(val)) return { error: `Invalid value for “viewer.${k}”: ${JSON.stringify(val)}.` };
    viewer[k] = val;
  }
  return { settings: { ...cur, viewer: viewer as unknown as ViewerPrefs } };
}
