import type { Busy } from './busy';
import { icon } from './icons';
import type { BlockMap, ExplodePart, Viewer } from './viewer';

export type ExplodeAxis = 'x' | 'y' | 'z';

interface Ui {
  card: HTMLElement;
  /** Knopf „Explosion“ im Viewer, Schließen in der Karte. */
  button: HTMLButtonElement; close: HTMLButtonElement;
  range: HTMLInputElement; value: HTMLElement; hint: HTMLElement;
  trails: HTMLButtonElement; fit: HTMLButtonElement;
  /**
   * Abspielen Schritt für Schritt: zurück, den Auseinanderbau abspielen oder anhalten, weiter, Anzeige „Schritt X von N“,
   * Reihenfolge an den Agenten.
   */
  back: HTMLButtonElement; play: HTMLButtonElement; next: HTMLButtonElement; step: HTMLElement; send: HTMLButtonElement;
  /**
   * Den Zusammenbau abspielen oder anhalten, Tempo, die Teile des gezeigten Schritts. Fehlen sie hier, sucht die Karte sie in sich
   * selbst (IDs aus index.html).
   */
  assemble?: HTMLButtonElement; speed?: HTMLSelectElement; names?: HTMLElement;
  /** Bekommt die Klasse `exploding`, solange die Karte offen ist (ein offener Schnitt rückt dann darüber). */
  viewerEl: HTMLElement;
}
interface Deps {
  viewer: Viewer;
  /** Ladeanzeige, solange die Analyse rechnet (große Baugruppen: Sekunden). */
  busy: Busy;
  /** Vor dem Einschalten: Gemessen wird nur in Einbaulage, die exakte Geometrie kennt keine Explosion. */
  beforeOn: () => void;
  /** Die Bauteile stehen still (Schieber losgelassen, Bewegung zu Ende), etwa für den Bereich des Schnitts. */
  settled: () => void;
  /** Text in die Eingabe des Agenten einfügen (Abschicken macht der Nutzer). */
  insert: (text: string) => void;
}

/** Lücke zwischen den Teilen bei OPEN_AMOUNT, als Anteil der Diagonale des Modells. */
const GAP = 0.05;
/**
 * Stand des Schiebers beim Öffnen. Bis dahin gleiten die Teile aus der Einbaulage in die Explosion mit Lücke GAP, darüber in
 * die mit FAR-facher Lücke. Zwischen zwei Lagen gleicher Ordnung überholt kein Teil ein anderes.
 */
const OPEN_AMOUNT = 0.5;
const FAR = 3;
const MOVE_MS = 450;
/** Dauer eines Schritts beim Abspielen im Tempo 1×. */
const STEP_MS = 700;
/** Wählbares Tempo (`#explode-speed`), wie in der Animationskarte. */
const SPEEDS = [0.25, 0.5, 1, 2];
/**
 * Strahltest, relativ zur Diagonale mit Untergrenze in mm: Die Punkte liegen EPS unter der Oberfläche (so weit dürfen sich Teile
 * überschneiden, etwa durch die Vernetzung), Treffer bis TOUCH gelten als Berührung, je Bauteil etwa SAMPLES Punkte.
 */
const EPS = 1e-3, EPS_MIN = 0.1;
const TOUCH = 4e-3, TOUCH_MIN = 0.5;
const SAMPLES = 600;
/** Normteile, deren Achse höchstens etwa 25° von einer Hauptachse abweicht, stimmen für sie als Montagerichtung. */
const ALONG = 0.9;

type Vec = number[];
const AXES: Record<ExplodeAxis, Vec> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const INDEX: Record<ExplodeAxis, number> = { x: 0, y: 1, z: 2 };
const add = (a: Vec, b: Vec) => a.map((x, i) => x + b[i]);
const sub = (a: Vec, b: Vec) => a.map((x, i) => x - b[i]);
const scale = (a: Vec, k: number) => a.map((x) => x * k);
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const mid = (p: { min: Vec; max: Vec }) => p.min.map((x, i) => (x + p.max[i]) / 2);
const volume = (p: { min: Vec; max: Vec }) => (p.max[0] - p.min[0]) * (p.max[1] - p.min[1]) * (p.max[2] - p.min[2]);

/** Größe eines Modells (Diagonale über alle Hüllquader), Maßstab für Abstände und Toleranzen. */
function diagonal(parts: ExplodePart[]): number {
  if (!parts.length) return 1;
  const lo = [0, 1, 2].map((i) => Math.min(...parts.map((p) => p.min[i])));
  const hi = [0, 1, 2].map((i) => Math.max(...parts.map((p) => p.max[i])));
  return Math.max(Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]), 1e-6);
}

/** Überdeckung zweier Intervalle (negativ, wenn sie auseinanderliegen). */
const overlap = (a0: number, a1: number, b0: number, b1: number) => Math.min(a1, b1) - Math.max(a0, b0);

/**
 * Bevorzugte Richtung für „Auto“: Normteile zeigen die Montagerichtung, also gilt die Achse, entlang der die meisten sitzen.
 * Ohne Normteile die Achse, entlang der Teile aufeinanderliegen (Hüllquader berühren sich dort, ihre Grundflächen überdecken
 * sich, gewichtet mit der Fläche). Sonst Z, in CAD oben.
 */
export function autoAxis(parts: ExplodePart[]): ExplodeAxis {
  const own = parts.filter((p) => p.role !== 'reference');
  const pick = (score: number[]): ExplodeAxis | null => {
    let best: ExplodeAxis | null = null;
    for (const n of ['z', 'x', 'y'] as ExplodeAxis[]) if (score[INDEX[n]] > 0 && (!best || score[INDEX[n]] > score[INDEX[best]])) best = n;
    return best; // bei Gleichstand gewinnt Z, dann X
  };
  const votes = [0, 0, 0];
  for (const p of own) {
    if (!p.axis) continue;
    const k = [0, 1, 2].reduce((b, i) => (Math.abs(p.axis![i]) > Math.abs(p.axis![b]) ? i : b), 0);
    if (Math.abs(p.axis[k]) > ALONG) votes[k]++;
  }
  const byHardware = pick(votes);
  if (byHardware) return byHardware;
  if (own.length < 2) return 'z';
  const tol = diagonal(own) * 1e-3;
  const touch = [0, 0, 0];
  for (let i = 0; i < own.length; i++) {
    for (let j = i + 1; j < own.length; j++) {
      const p = own[i], q = own[j];
      for (let k = 0; k < 3; k++) {
        const [a, b] = [0, 1, 2].filter((x) => x !== k);
        const oa = overlap(p.min[a], p.max[a], q.min[a], q.max[a]), ob = overlap(p.min[b], p.max[b], q.min[b], q.max[b]);
        if (oa <= tol || ob <= tol) continue;
        if (Math.abs(p.max[k] - q.min[k]) <= tol || Math.abs(q.max[k] - p.min[k]) <= tol) touch[k] += oa * ob;
      }
    }
  }
  return pick(touch) ?? 'z';
}

/** Höchstens so viele schräge Richtungen aus der Form der Teile (je mit Gegenrichtung), die häufigsten zuerst. */
const MAX_OWN_DIRS = 12;
/** Die ersten sechs Kandidaten sind ±X, ±Y, ±Z. */
const PRINCIPAL = 6;

/**
 * Kandidaten für die Richtung, in der ein Teil herauskommt: ±X, ±Y, ±Z, die Achsen der Normteile und die schrägen Richtungen aus
 * der Form der Teile (Achsen von Zylindern, Normalen großer ebener Flächen). `opp`: Gegenrichtung.
 */
export function directions(parts: ExplodePart[]): { dirs: Vec[]; opp: number[] } {
  const dirs: Vec[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  const known = (d: Vec) => dirs.some((e) => Math.abs(dot(e, d)) > 0.9995);
  const both = (d: Vec) => { dirs.push(d, scale(d, -1)); };
  for (const p of parts) if (p.axis && !known(p.axis)) both(p.axis);
  const extra: { d: Vec; n: number }[] = [];
  for (const p of parts) {
    // Normteile kommen entlang ihrer Achse heraus. Die Flächen ihres Sechskants gäben nur schräge Richtungen ohne Nutzen
    if (p.axis) continue;
    for (const d of p.dirs) {
      if (known(d)) continue;
      const e = extra.find((x) => Math.abs(dot(x.d, d)) > 0.9995);
      if (e) e.n++; else extra.push({ d, n: 1 });
    }
  }
  for (const e of extra.sort((a, b) => b.n - a.n).slice(0, MAX_OWN_DIRS)) both(e.d);
  return { dirs, opp: dirs.map((d) => dirs.findIndex((e) => dot(e, d) < -0.9995)) };
}

/**
 * Ein Schritt des Auseinanderbaus: ein Bauteil oder eine Baugruppe, die nur als Ganzes herauskommt (`members`, in sich wieder
 * zerlegt in `sub`). Richtung als Index in `dirs`, das Teil oder die Gruppe, mit der es wandert (`parent`), die Runde, und ob es
 * trotz Hindernissen herausmusste (`forced`).
 */
export interface Step { id: string; members: string[]; dir: number; parent: string; level: number; forced: boolean; sub?: Plan }
export interface Plan { base: string | null; steps: Map<string, Step>; dirs: Vec[] }

/** Starke Zusammenhangskomponenten (Tarjan): Teile, die einander über Umwege blockieren. */
function components(nodes: string[], next: (id: string) => string[]): string[][] {
  let n = 0;
  const index = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], on = new Set<string>();
  const out: string[][] = [];
  const visit = (v: string) => {
    index.set(v, n); low.set(v, n); n++;
    stack.push(v); on.add(v);
    for (const w of next(v)) {
      if (!index.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, index.get(w)!));
    }
    if (low.get(v) === index.get(v)) {
      const c: string[] = [];
      let w: string;
      do { w = stack.pop()!; on.delete(w); c.push(w); } while (w !== v);
      out.push(c);
    }
  };
  for (const v of nodes) if (!index.has(v)) visit(v);
  return out;
}

interface Ctx { byId: Map<string, ExplodePart>; dirs: Vec[]; opp: number[]; block: BlockMap; prefer: Vec; units: number }

const boxOf = (ps: ExplodePart[]): Box => ({
  min: [0, 1, 2].map((k) => Math.min(...ps.map((p) => p.min[k]))), max: [0, 1, 2].map((k) => Math.max(...ps.map((p) => p.max[k]))),
});
const better = (a: number[], b: number[]) => { for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k] > b[k]; return false; };

/**
 * Demontage-Analyse, per Skript ohne KI. Das größte Teil (kein Normteil) bleibt stehen, der Anker. In jeder Runde kommt alles
 * heraus, was in mindestens einer Richtung frei ist (laut Strahltest steht ihm dort keines der verbliebenen Teile im Weg). Ist
 * es in mehreren Richtungen frei, entscheiden nacheinander: bei Normteilen die eigene Achse aus dem Material heraus, dann die
 * Richtung, in der es von etwas abhebt, worauf es liegt, dann die bevorzugte Achse, dann weg vom Anker.
 * Ist kein einzelnes Teil frei, kommt eine Baugruppe heraus, die nur sich selbst im Weg steht (Kolben mit Pleuel, Welle mit der
 * Mutter in ihrer Tasche): eine Senke im Blockiergraph einer Richtung, die kleinste zuerst. Sie wird danach genauso in sich zerlegt.
 * Erst wenn auch das nicht geht (verklemmt, eingeschlossen, überschneidend), kommt das Teil mit den wenigsten Hindernissen trotzdem
 * heraus und fährt durch sie hindurch (`forced`).
 * Zuletzt bekommt jeder Schritt ein Elternteil, mit dem er wandert: unter den Teilen, die später herauskommen (und dem Anker),
 * das, an dem er aus den meisten Richtungen anliegt, bei Gleichstand das nächste hinter ihm. Teile, die in dieselbe Richtung gehen,
 * kommen dafür immer in Frage, solche quer dazu nur, wenn sie ihn umschließen, entgegenlaufende nie. So wandert eine Mutter mit der
 * Welle, in deren Tasche sie steckt, ein Stößel aber nicht mit dem Nockenrad, auf dem er nur aufsitzt, und ein Schwungrad hinten
 * nicht mit der Kurbelwelle, die nach vorne geht.
 */
export function disassemble(parts: ExplodePart[], dirs: Vec[], opp: number[], block: BlockMap, prefer: Vec): Plan {
  const own = parts.filter((p) => p.role !== 'reference');
  return planOf(own.map((p) => p.id), { byId: new Map(own.map((p) => [p.id, p])), dirs, opp, block, prefer, units: 0 });
}

function planOf(ids: string[], ctx: Ctx): Plan {
  const { byId, dirs, opp, block, prefer } = ctx;
  const steps = new Map<string, Step>();
  if (!ids.length) return { base: null, steps, dirs };
  const parts = ids.map((id) => byId.get(id)!);
  const pool = parts.filter((p) => !p.axis);
  const base = (pool.length ? pool : parts).reduce((b, p) => (volume(p) > volume(b) ? p : b)).id;
  const remaining = new Set(ids);
  // Was im Weg steht. Ein Normteil entlang seiner Achse hält nichts auf, worin es eingeschraubt ist: Mit dem Teil überschneidet es
  // sich (Gewinde im Kernloch, auch wo die Spitze dahinter wieder in den Gewindering stößt)
  const overlaps = (a: string, b: string) => block.some((m) => (m.get(a)?.get(b)?.inside ?? 0) > 0);
  const ahead = (id: string, i: number) => {
    const axis = byId.get(id)!.axis, along = !!axis && dot(dirs[i], axis) > 0.999;
    return [...(block[i].get(id)?.keys() ?? [])].filter((q) => remaining.has(q) && !(along && overlaps(id, q)));
  };
  const restsOn = (ms: string[], i: number) => ms.some((m) => [...(block[i].get(m) ?? [])].some(([q, h]) => remaining.has(q) && !ms.includes(q) && h.touch > 0));
  const anchor = mid(byId.get(base)!);
  // Schräge Richtungen nur, wenn sie zur Form gehören (Achse des Stifts, Normale der schrägen Platte, Achse des Normteils). Sonst
  // schickte die Fase eines Nachbarn ein Teil schräg hinaus
  const allowed = (ms: string[], i: number) => i < PRINCIPAL || ms.some((m) => {
    const p = byId.get(m)!;
    return (p.axis ? [p.axis] : p.dirs).some((e) => Math.abs(dot(e, dirs[i])) > 0.9995);
  });
  const rank = (ms: string[], i: number): number[] => {
    const d = dirs[i], one = ms.length === 1 ? byId.get(ms[0])! : null;
    return [
      one?.axis && dot(d, one.axis) > 0.999 ? 1 : 0,
      restsOn(ms, opp[i]) ? 1 : 0,
      Math.abs(dot(d, prefer)) > 0.999 ? 1 : 0,
      dot(d, sub(mid(boxOf(ms.map((m) => byId.get(m)!))), anchor)),
    ];
  };
  let level = 0;
  while (remaining.size > 1) {
    let layer: { members: string[]; dir: number }[] = [];
    for (const id of remaining) {
      if (id === base) continue;
      let best = -1;
      for (let i = 0; i < dirs.length; i++) if (allowed([id], i) && !ahead(id, i).length && (best < 0 || better(rank([id], i), rank([id], best)))) best = i;
      if (best >= 0) layer.push({ members: [id], dir: best });
    }
    if (!layer.length) {
      let best: { members: string[]; dir: number } | null = null, key: number[] = [];
      for (let i = 0; i < dirs.length; i++) {
        for (const c of components([...remaining], (id) => ahead(id, i))) {
          if (c.length < 2 || c.includes(base) || !allowed(c, i)) continue;
          const set = new Set(c);
          if (!c.every((m) => ahead(m, i).every((q) => set.has(q)))) continue;
          const k = [-c.length, ...rank(c, i), -volume(boxOf(c.map((m) => byId.get(m)!)))];
          if (!best || better(k, key)) { best = { members: c, dir: i }; key = k; }
        }
      }
      if (best) layer = [best];
    }
    let forced = false;
    if (!layer.length) {
      // Nichts geht: das Teil mit den wenigsten Hindernissen, bei Gleichstand nach Rang, dann das kleinste
      let best: { members: string[]; dir: number } | null = null, key: number[] = [];
      for (const id of remaining) {
        if (id === base) continue;
        for (let i = 0; i < dirs.length; i++) {
          if (!allowed([id], i)) continue;
          const k = [-ahead(id, i).length, ...rank([id], i), -volume(byId.get(id)!)];
          if (!best || better(k, key)) { best = { members: [id], dir: i }; key = k; }
        }
      }
      layer = [best!];
      forced = true;
    }
    for (const it of layer) {
      const id = it.members.length === 1 ? it.members[0] : `#${++ctx.units}`;
      steps.set(id, { id, members: it.members, dir: it.dir, parent: base, level, forced });
    }
    for (const it of layer) for (const m of it.members) remaining.delete(m);
    level++;
  }
  const itemOf = new Map<string, string>([[base, base]]);
  for (const [id, s] of steps) for (const m of s.members) itemOf.set(m, id);
  for (const s of steps.values()) {
    const d = dirs[s.dir];
    // Woran es hängt: Berührungen in allen Richtungen (Mutter in der Tasche, Stößel in der Führung, Scheibe auf dem Rad),
    // dazu der Abstand zu dem, wovon es abgezogen wird (in Gegenrichtung)
    const cand = new Map<string, { sides: Set<number>; touch: number; dist: number }>();
    for (const m of s.members) {
      for (let i = 0; i < dirs.length; i++) {
        for (const [q, h] of block[i].get(m) ?? []) {
          const item = itemOf.get(q);
          if (!item || item === s.id) continue; // außerhalb dieser Ebene oder in derselben Baugruppe
          const t = steps.get(item);
          if (item !== base && !(t && t.level > s.level && dot(dirs[t.dir], d) > -0.1)) continue;
          const c = cand.get(item) ?? { sides: new Set<number>(), touch: 0, dist: Infinity };
          if (h.touch > 0) { c.sides.add(i); c.touch += h.touch; }
          if (i === opp[s.dir]) c.dist = Math.min(c.dist, h.dist);
          cand.set(item, c);
        }
      }
    }
    // Wer quer zur eigenen Richtung wandert, nimmt es nur mit, wenn es von ihm umschlossen ist (Berührung aus drei Richtungen):
    // eine Mutter in der Tasche ja, ein Stößel, der auf dem Nockenrad nur aufsitzt, nein
    const pick = [...cand].filter(([item, c]) => {
      if (!(c.touch > 0 || c.dist < Infinity)) return false;
      const t = steps.get(item);
      return item === base || (t && dot(dirs[t.dir], d) > 0.99) || c.sides.size >= 3;
    }).sort((a, b) => b[1].sides.size - a[1].sides.size || b[1].touch - a[1].touch || a[1].dist - b[1].dist)[0];
    if (pick) s.parent = pick[0];
  }
  for (const s of steps.values()) if (s.members.length > 1) s.sub = planOf(s.members, ctx);
  return { base, steps, dirs };
}

type Box = { min: Vec; max: Vec };
type Arranged = { off: Map<string, Vec>; legs: Map<string, Vec>; box: Box };
/** Verschiebung je Teil, ihr eigener Anteil (für die Wege) und der Weg je Schritt relativ zu seinem Elternteil (zum Abspielen). */
type Layout = { offsets: Map<string, Vec>; legs: Map<string, Vec>; rel: Map<string, Vec> };

/**
 * Lage der Explosion: Jeder Schritt rückt von seinem Elternteil weg, in seiner Richtung, bis er mit Lücke `gap` frei vor allem
 * liegt, was seine Grundfläche (quer zur Richtung) überdeckt: das Elternteil selbst und die Geschwister, die vor ihm in dieselbe
 * Richtung gegangen sind. Geschwister in anderen Richtungen nur, wo sich die Hüllquader wirklich überschneiden (ein schräg
 * gezogener Stift und der Deckel darüber). Innen zuerst: Was später herauskommt, liegt näher. Ein Schritt zieht seine Kinder mit (als Hüllquader
 * des ganzen Teilbaums), eine Baugruppe ist dabei ein Block, der in sich schon auseinandergezogen ist. Ergebnis: Verschiebung je
 * Teil und ihr eigener Anteil (ohne den des Elternteils), Grundlage der gestrichelten Wege.
 */
export function layout(parts: ExplodePart[], plan: Plan, gap: number): Layout {
  const byId = new Map(parts.map((p) => [p.id, p]));
  const tol = diagonal(parts) * 1e-3;
  const corners = (b: Box) => [0, 1, 2, 3, 4, 5, 6, 7].map((k) => [k & 1 ? b.max[0] : b.min[0], k & 2 ? b.max[1] : b.min[1], k & 4 ? b.max[2] : b.min[2]]);
  const along = (b: Box, d: Vec) => { const v = corners(b).map((c) => dot(c, d)); return [Math.min(...v), Math.max(...v)]; };
  const basis = (d: Vec): [Vec, Vec] => {
    const u0 = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = sub(u0, scale(d, dot(u0, d)));
    const un = scale(u, 1 / Math.hypot(u[0], u[1], u[2]));
    return [un, [d[1] * un[2] - d[2] * un[1], d[2] * un[0] - d[0] * un[2], d[0] * un[1] - d[1] * un[0]]];
  };
  const covers = (a: Box, b: Box, d: Vec) => basis(d).every((e) => {
    const [a0, a1] = along(a, e), [b0, b1] = along(b, e);
    return overlap(a0, a1, b0, b1) > tol;
  });
  const shift = (b: Box, v: Vec): Box => ({ min: add(b.min, v), max: add(b.max, v) });
  const union = (a: Box, b: Box): Box => ({ min: a.min.map((x, i) => Math.min(x, b.min[i])), max: a.max.map((x, i) => Math.max(x, b.max[i])) });
  const intersects = (a: Box, b: Box) => [0, 1, 2].every((i) => overlap(a.min[i], a.max[i], b.min[i], b.max[i]) > tol);
  const single = (id: string): Arranged => {
    const p = byId.get(id)!;
    return { off: new Map([[id, [0, 0, 0]]]), legs: new Map(), box: { min: p.min, max: p.max } };
  };
  const relAll = new Map<string, Vec>();
  const arrange = (pl: Plan): Arranged => {
    const off = new Map<string, Vec>(), legs = new Map<string, Vec>();
    if (!pl.base) return { off, legs, box: { min: [0, 0, 0], max: [0, 0, 0] } };
    // Jeder Schritt als Block: ein Teil oder eine in sich schon auseinandergezogene Baugruppe
    const blocks = new Map<string, Arranged>([[pl.base, single(pl.base)]]);
    for (const [id, s] of pl.steps) blocks.set(id, s.sub ? arrange(s.sub) : single(id));
    const kids = new Map<string, Step[]>();
    for (const s of pl.steps.values()) kids.set(s.parent, [...(kids.get(s.parent) ?? []), s]);
    const rel = new Map<string, Vec>();
    // Teilbaum als Hüllquader, in der Lage des Blocks (seine eigene Verschiebung kommt beim Elternteil dazu)
    const place = (id: string): Box => {
      const own = blocks.get(id)!.box;
      let box = own;
      // Innen zuerst: Was später herauskommt, liegt näher. Das Elternteil selbst gilt für jede Richtung
      const placed: { box: Box; dir: number }[] = [{ box: own, dir: -1 }];
      for (const k of [...(kids.get(id) ?? [])].sort((a, b) => b.level - a.level)) {
        const d = pl.dirs[k.dir];
        const sb = place(k.id);
        const lo = along(sb, d)[0];
        // Liegt es vor etwas, das in dieselbe Richtung ging (die Grundflächen überdecken sich), rückt es so weit, dass genau eine Lücke
        // bleibt, sonst eine Lücke weit. Mindestens eine halbe: Ein Teil, das stehen bleibt, sähe aus wie vergessen
        let t = -Infinity;
        for (const o of placed) if ((o.dir < 0 || o.dir === k.dir) && covers(sb, o.box, d)) t = Math.max(t, along(o.box, d)[1] - lo + gap);
        t = t === -Infinity ? gap : Math.max(t, gap / 2);
        // Was in eine andere Richtung ging, ist nur im Weg, wenn sich die beiden dort wirklich überschneiden: dann weiter, bis es frei ist
        for (let round = 0; round < placed.length; round++) {
          const hit = placed.find((o) => o.dir >= 0 && o.dir !== k.dir && intersects(shift(sb, scale(d, t)), o.box) && covers(sb, o.box, d));
          if (!hit) break;
          t = Math.max(t, along(hit.box, d)[1] - lo + gap);
        }
        rel.set(k.id, scale(d, t));
        const moved = shift(sb, scale(d, t));
        placed.push({ box: moved, dir: k.dir });
        box = union(box, moved);
      }
      return box;
    };
    const box = place(pl.base);
    for (const [id, v] of rel) relAll.set(id, v);
    const walk = (id: string, at: Vec) => {
      const blk = blocks.get(id)!;
      for (const [m, o] of blk.off) off.set(m, add(at, o));
      for (const [m, l] of blk.legs) legs.set(m, l);
      // Der eigene Weg des Blocks gehört zu seinem Ankerteil (bei einer Baugruppe deren Anker)
      const leg = rel.get(id), s = pl.steps.get(id);
      if (leg && s) legs.set(s.sub?.base ?? id, leg);
      for (const k of kids.get(id) ?? []) walk(k.id, add(at, rel.get(k.id)!));
    };
    walk(pl.base, [0, 0, 0]);
    return { off, legs, box };
  };
  const r = arrange(plan);
  return { offsets: r.off, legs: r.legs, rel: relAll };
}

/** Reihenfolge zum Abspielen: je Schritt die Teile oder Baugruppen, die zusammen herauskommen. Eine Baugruppe zerfällt gleich danach. */
export function sequence(plan: Plan): string[][] {
  const out: string[][] = [];
  const walk = (pl: Plan) => {
    const levels = new Map<number, Step[]>();
    for (const st of pl.steps.values()) levels.set(st.level, [...(levels.get(st.level) ?? []), st]);
    for (const lv of [...levels.keys()].sort((a, b) => a - b)) {
      const ss = levels.get(lv)!;
      out.push(ss.map((st) => st.id));
      for (const st of ss) if (st.sub) walk(st.sub);
    }
  };
  walk(plan);
  return out;
}

/** Je Teil die Schritte, deren Weg es mitgeht: der eigene, dann die seiner Eltern bis zum Anker, bei Baugruppen dazu die der Gruppe. */
export function chains(plan: Plan): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const walk = (pl: Plan, outer: string[]) => {
    if (!pl.base) return;
    const up = (id: string): string[] => { const st = pl.steps.get(id); return st ? [id, ...up(st.parent)] : []; };
    out.set(pl.base, outer);
    for (const [id, st] of pl.steps) {
      const c = [...up(id), ...outer];
      if (st.sub) walk(st.sub, c); else out.set(id, c);
    }
  };
  walk(plan, []);
  return out;
}

/**
 * Explosionsansicht: Die Bauteile kommen so auseinander, wie man sie auseinanderbauen würde (Demontage-Analyse). Gesteuert über
 * einen Schieber (0–100 %). Ändert nichts am Modell und wird nicht gespeichert. Gemessen wird nur in Einbaulage.
 */
export class ExplodeTool {
  private active = false;
  /** Stand des Schiebers (0..1). Bleibt für das nächste Einschalten. */
  private amount = OPEN_AMOUNT;
  /** Gezeigter Anteil, während einer Bewegung zwischen altem und neuem Wert. */
  private shown = 0;
  /** Bevorzugte Achse, wenn ein Teil in mehrere Richtungen frei ist (autoAxis). */
  private axis: ExplodeAxis = 'z';
  /** Strahltest des aktuellen Modells (hängt nicht von der bevorzugten Richtung ab). */
  private analysis: { dirs: Vec[]; opp: number[]; block: BlockMap; ms: number } | null = null;
  private plan: Plan | null = null;
  /** Lage bei OPEN_AMOUNT und bei 100 %. */
  private near: Layout = { offsets: new Map(), legs: new Map(), rel: new Map() };
  private far: Layout = { offsets: new Map(), legs: new Map(), rel: new Map() };
  /**
   * Abspielen: Reihenfolge der Schritte, ihre Nummer, die Ketten je Teil und der Stand (null: alle Schritte zugleich, wie mit dem
   * Schieber eingestellt).
   */
  private order: string[][] = [];
  private index = new Map<string, number>();
  private chain = new Map<string, string[]>();
  private stepPos: number | null = null;
  private playing = false;
  /** Richtung beim Abspielen: 1 auseinander, -1 zusammen. Gilt, solange `playing`. */
  private playDir: 1 | -1 = 1;
  /** Tempo beim Abspielen (Faktor, SPEEDS). Bleibt für das nächste Einschalten. */
  private speed = 1;
  private moving = 0;
  private forced = 0;
  private refs = 0;
  private trails = true;
  /** Laufende Bewegung. Beim Abspielen mit Ziel, damit ein neues Tempo von der aktuellen Lage aus weiterläuft. */
  private anim: { stop(): void; goal?: { target: number; play: boolean } } | null = null;
  /** Laufende Analyse (Strahltest), abbrechbar. */
  private loading: AbortController | null = null;
  private ui: Required<Ui>;

  constructor(ui: Ui, private deps: Deps) {
    const own = <T extends HTMLElement>(id: string): T => {
      const e = ui.card.querySelector<T>(`#${id}`);
      if (!e) throw new Error(`Explosionskarte: #${id} fehlt in index.html`);
      return e;
    };
    this.ui = {
      ...ui, assemble: ui.assemble ?? own<HTMLButtonElement>('btn-explode-assemble'), speed: ui.speed ?? own<HTMLSelectElement>('explode-speed'),
      names: ui.names ?? own<HTMLElement>('explode-names'),
    };
    ui.button.addEventListener('click', () => this.setActive(!this.active));
    ui.close.addEventListener('click', () => this.setActive(false));
    ui.range.addEventListener('input', () => {
      this.amount = Math.min(1, Math.max(0, Number(ui.range.value) / 100));
      this.stopAnim();
      this.stepPos = null; // der Schieber zeigt wieder alle Schritte zugleich
      this.show(this.amount);
      this.render();
    });
    ui.range.addEventListener('change', () => this.deps.settled());
    ui.trails.addEventListener('click', () => { this.trails = !this.trails; this.deps.viewer.setTrails(this.trails); this.render(); });
    ui.fit.addEventListener('click', () => this.deps.viewer.setView('fit'));
    ui.next.addEventListener('click', () => this.stepBy(1));
    ui.back.addEventListener('click', () => this.stepBy(-1));
    ui.play.addEventListener('click', () => this.togglePlay(1));
    this.ui.assemble.addEventListener('click', () => this.togglePlay(-1));
    this.ui.speed.addEventListener('change', () => this.setSpeed(Number(this.ui.speed.value)));
    ui.send.addEventListener('click', () => { const t = this.orderText(); if (t) this.deps.insert(t); });
    this.deps.viewer.setTrails(this.trails);
    this.render();
  }

  get isActive(): boolean { return this.active; }

  /** Ein- oder ausschalten. Mit `animate` gleiten die Bauteile, ohne springen sie (etwa wenn Messen übernimmt). */
  setActive(on: boolean, animate = true): void {
    if (on !== this.active) {
      this.active = on;
      this.ui.button.setAttribute('aria-pressed', String(on));
      this.ui.viewerEl.classList.toggle('exploding', on);
      this.stepPos = null;
      if (on) {
        this.deps.beforeOn();
        if (!this.analysis) {
          // Die Karte erscheint erst mit dem Ergebnis, bis dahin zeigt die Ladeanzeige den Fortschritt
          this.ui.card.hidden = true;
          void this.prepare(() => { this.compute(); this.ui.card.hidden = false; this.goTo(true, animate); });
          return;
        }
        this.compute();
      } else this.cancelLoad();
      this.ui.card.hidden = !on;
    }
    if (this.loading) return; // noch keine Analyse, prepare() fährt danach auseinander
    this.goTo(on, animate);
  }

  private goTo(on: boolean, animate: boolean): void {
    const target = on ? this.amount : 0;
    if (animate) this.moveTo(target);
    else if (this.anim || this.shown !== target) { this.stopAnim(); this.show(target); this.deps.settled(); }
    this.render();
  }

  /** Neues Modell (Build oder anderer Stand): neu analysieren, die Explosion bleibt so weit, wie sie war. */
  refresh(): void {
    this.analysis = null;
    this.cancelLoad();
    if (!this.active) { // erst beim Einschalten rechnen. Läuft noch das Zusammenfahren: gleich in Einbaulage
      if (this.shown > 0) { this.stopAnim(); this.show(0); }
      this.plan = null;
      return;
    }
    if (this.anim?.goal) this.stopAnim(); // ein laufender Schritt gehört zum alten Plan
    void this.prepare(() => {
      this.compute();
      if (this.shown > 0) this.show(this.shown);
      this.render();
      this.deps.settled();
    });
  }

  /**
   * Strahltest im Hintergrund mit Ladeanzeige, danach `then`. Abbrechen (Knopf, Escape) beendet die Explosion. Ein neuer Aufruf
   * oder cancelLoad() verwirft den laufenden, dessen `then` kommt dann nicht mehr.
   */
  private async prepare(then: () => void): Promise<void> {
    this.cancelLoad();
    const ctl = new AbortController();
    this.loading = ctl;
    const { viewer } = this.deps;
    const view = this.deps.busy.show('Explosion wird vorbereitet', () => this.setActive(false, false));
    try {
      // Strahltest und Hüllquader in Einbaulage
      if (this.shown > 0) viewer.setOffsets(null);
      const own = viewer.explodeParts().filter((p) => p.role !== 'reference');
      const size = diagonal(own);
      const t0 = performance.now();
      const { dirs, opp } = directions(own);
      view.detail(`${own.length} Bauteile: Was steht wem im Weg?`);
      const block = await viewer.explodeRays(own.map((p) => p.id), dirs, opp,
        { eps: Math.max(EPS_MIN, EPS * size), touch: Math.max(TOUCH_MIN, TOUCH * size), samples: SAMPLES },
        { signal: ctl.signal, progress: (f) => view.progress(f) });
      if (!block || this.loading !== ctl) return;
      this.analysis = { dirs, opp, block, ms: performance.now() - t0 };
      this.loading = null;
      then();
    } finally {
      if (this.loading === ctl) this.loading = null;
      view.close();
    }
  }

  private cancelLoad(): void {
    this.loading?.abort();
    this.loading = null;
  }

  /** Beschreibung für den Agenten, etwa beim Markieren. Ohne Explosion null. */
  agentText(): string | null {
    if (!this.active || this.shown <= 0 || !this.moving) return null;
    const step = this.stepPos === null ? '' : `, Schritt ${this.shownStep()} von ${this.order.length} des Auseinanderbaus`;
    return `Explosionsansicht (${Math.round(this.shown * 100)} %${step}): Die Bauteile sind nur zur Darstellung auseinandergezogen, ihre Lage im Bild ist nicht die Einbaulage`;
  }

  /** Plan und Lagen aus der Analyse (prepare() hat sie gerechnet). */
  private compute(): void {
    const { viewer } = this.deps;
    if (!this.analysis) return;
    // Ein laufender Schritt gehört zum alten Plan (seine Nummern stimmen nicht mehr)
    if (this.anim?.goal) this.stopAnim();
    // Hüllquader in Einbaulage. Wer danach etwas zeigen will, ruft show() wieder auf.
    if (this.shown > 0) viewer.setOffsets(null);
    const parts = viewer.explodeParts();
    const own = parts.filter((p) => p.role !== 'reference');
    const size = diagonal(own);
    this.axis = autoAxis(parts);
    const { dirs, opp, block } = this.analysis;
    this.plan = disassemble(own, dirs, opp, block, AXES[this.axis]);
    this.near = layout(own, this.plan, GAP * size);
    this.far = layout(own, this.plan, GAP * FAR * size);
    this.order = sequence(this.plan);
    this.index = new Map(this.order.flatMap((ids, k) => ids.map((id) => [id, k] as [string, number])));
    this.chain = chains(this.plan);
    this.stepPos = null; // neuer Plan: Die Schritte von eben gelten nicht mehr
    this.refs = parts.length - own.length;
    const count = (pl: Plan): number => [...pl.steps.values()].reduce((n, st) => n + (st.forced ? st.members.length : 0) + (st.sub ? count(st.sub) : 0), 0);
    this.forced = count(this.plan);
    this.moving = [...this.near.offsets.values()].filter((s) => Math.hypot(s[0], s[1], s[2]) > 1e-6).length;
  }

  private show(t: number): void {
    this.shown = t;
    if (t <= 0) { this.deps.viewer.setOffsets(null); return; }
    const k = (t - OPEN_AMOUNT) / (1 - OPEN_AMOUNT);
    const blend = (a: Map<string, Vec>, b: Map<string, Vec>) => {
      const m = new Map<string, Vec>();
      for (const [id, s] of a) {
        const f = b.get(id) ?? s;
        m.set(id, t <= OPEN_AMOUNT ? scale(s, t / OPEN_AMOUNT) : s.map((x, i) => x + (f[i] - x) * k));
      }
      return m;
    };
    if (this.stepPos === null) {
      this.deps.viewer.setOffsets(blend(this.near.offsets, this.far.offsets), blend(this.near.legs, this.far.legs));
      return;
    }
    // Schritt für Schritt: Jedes Teil geht die Wege seiner Kette, jeden erst, wenn dessen Schritt dran ist (sanft innerhalb des Schritts)
    const rel = blend(this.near.rel, this.far.rel), p = this.stepPos;
    const part = (id: string) => {
      const f = Math.min(1, Math.max(0, p - (this.index.get(id) ?? 0)));
      return f < 0.5 ? 2 * f * f : 1 - (-2 * f + 2) ** 2 / 2;
    };
    const offsets = new Map<string, Vec>(), legs = new Map<string, Vec>();
    for (const [id, c] of this.chain) {
      let at: Vec = [0, 0, 0];
      for (const st of c) at = add(at, scale(rel.get(st) ?? [0, 0, 0], part(st)));
      offsets.set(id, at);
      if (c.length) legs.set(id, scale(rel.get(c[0]) ?? [0, 0, 0], part(c[0])));
    }
    this.deps.viewer.setOffsets(offsets, legs);
  }

  // ---- Abspielen Schritt für Schritt ------------------------------------------------------------------------------

  /**
   * Gezeigter Schritt (0 bis N): der, dessen Teile gerade wandern oder zuletzt angekommen sind, in beiden Richtungen gleich. „Alle
   * zugleich“ zeigt dieselbe Lage wie der letzte Schritt, bei 0 % wie das zusammengebaute Modell.
   */
  private shownStep(): number {
    const n = this.order.length;
    if (this.stepPos === null) return this.amount > 0 ? n : 0;
    return Math.min(n, Math.max(0, Math.ceil(this.stepPos - 1e-6)));
  }

  /**
   * In den Schrittmodus, an der Stelle, die „alle zugleich“ gerade zeigt (siehe shownStep). Bei 0 % geht der Abstand auf den beim
   * Öffnen, sonst bliebe jeder Schritt unsichtbar.
   */
  private enterSteps(): void {
    if (this.stepPos === null) this.stepPos = this.amount > 0 ? this.order.length : 0;
    if (this.amount <= 0) this.amount = OPEN_AMOUNT;
    this.show(this.amount);
  }

  /** Einen Schritt weiter (auseinander) oder zurück (zusammen). */
  private stepBy(dir: 1 | -1): void {
    if (!this.active || !this.order.length) return;
    this.stopAnim();
    this.enterSteps();
    const n = this.order.length, p = this.stepPos!;
    this.stepTo(dir > 0 ? Math.min(n, Math.floor(p + 1e-6) + 1) : Math.max(0, Math.ceil(p - 1e-6) - 1));
  }

  /**
   * Abspielen in Richtung `dir` (1 auseinander, -1 zusammen) bis ans Ende, vom anderen Ende, falls es schon dort steht. Läuft es
   * schon in diese Richtung: anhalten, der laufende Schritt wird noch fertig. Läuft es in die andere: umkehren, ohne Sprung.
   */
  private togglePlay(dir: 1 | -1): void {
    if (!this.active || !this.order.length) return;
    const n = this.order.length;
    if (this.playing && this.playDir === dir) {
      this.stopAnim();
      const p = this.stepPos ?? 0;
      this.stepTo(dir > 0 ? Math.ceil(p - 1e-6) : Math.floor(p + 1e-6));
      return;
    }
    this.stopAnim();
    this.enterSteps();
    const end = dir > 0 ? n : 0;
    if (Math.abs(this.stepPos! - end) < 1e-6) { this.stepPos = n - end; this.show(this.amount); }
    this.playDir = dir;
    this.stepTo(end, true);
  }

  /** Neues Tempo. Läuft gerade ein Schritt, geht es von der aktuellen Lage aus im neuen Tempo weiter. */
  private setSpeed(v: number): void {
    this.speed = SPEEDS.includes(v) ? v : 1;
    const goal = this.anim?.goal;
    if (goal) this.stepTo(goal.target, goal.play);
    else this.render();
  }

  /**
   * Gleichmäßig zum Schritt `target`, im eingestellten Tempo. Die Lage hängt nur an der Zeit: Ohne Bildwiederholung (unsichtbares
   * Fenster) steht es nach Ablauf trotzdem dort, und Anhalten, Umkehren oder ein neues Tempo setzen an der richtigen Stelle an.
   */
  private stepTo(target: number, play = false): void {
    this.stopAnim();
    const from = this.stepPos ?? 0;
    const ms = (Math.abs(target - from) * STEP_MS) / this.speed;
    if (ms < 1) { this.stepPos = target; this.show(this.amount); this.render(); return; }
    const t0 = performance.now();
    const at = () => from + (target - from) * Math.min(1, (performance.now() - t0) / ms);
    let raf = 0, done = false;
    const stop = () => {
      if (done) return;
      done = true; cancelAnimationFrame(raf); clearTimeout(timer);
      // Unterbrochen: Hier geht es weiter. Wer den Schrittmodus verlassen hat (stepPos null), bleibt draußen
      if (this.stepPos !== null) this.stepPos = at();
      if (this.anim === handle) this.anim = null;
      this.playing = false;
    };
    const finish = () => { if (done) return; stop(); this.stepPos = target; this.show(this.amount); this.render(); this.deps.settled(); };
    const tick = () => {
      if (done) return;
      if (performance.now() - t0 >= ms) { finish(); return; }
      this.stepPos = at();
      this.show(this.amount);
      this.render();
      raf = requestAnimationFrame(tick);
    };
    const timer = setTimeout(finish, ms + 60);
    const handle = { stop, goal: { target, play } };
    this.anim = handle;
    this.playing = play;
    this.render();
    raf = requestAnimationFrame(tick);
  }

  /** Name eines Schritts: das Teil, bei einer Baugruppe ihre Teile. */
  private label(id: string, names: Map<string, string>): string {
    const find = (pl: Plan | undefined): Step | undefined => {
      for (const st of pl?.steps.values() ?? []) { if (st.id === id) return st; const r = find(st.sub); if (r) return r; }
      return undefined;
    };
    const st = find(this.plan ?? undefined);
    return st && st.members.length > 1 ? st.members.map((m) => names.get(m) ?? m).join(' + ') : (names.get(id) ?? id);
  }

  /** Reihenfolge des Auseinanderbaus als Text für den Agenten, eine Zeile je Schritt. */
  private orderText(): string | null {
    const plan = this.plan;
    if (!plan?.base || !this.order.length) return null;
    const names = new Map(this.deps.viewer.partList().map((x) => [x.id, x.name]));
    const name = (id: string) => `"${names.get(id) ?? id}"`;
    const steps = new Map<string, { st: Step; pl: Plan }>();
    const collect = (pl: Plan) => { for (const st of pl.steps.values()) { steps.set(st.id, { st, pl }); if (st.sub) collect(st.sub); } };
    collect(plan);
    const dirName = (d: Vec) => {
      const k = d.findIndex((v) => Math.abs(v) > 0.999);
      return k >= 0 ? `${d[k] > 0 ? '+' : '-'}${'XYZ'[k]}` : `(${d.map((v) => +v.toFixed(3)).join(', ')})`;
    };
    const lines = this.order.map((ids, k) => `${k + 1}. ${ids.map((id) => {
      const { st, pl } = steps.get(id)!;
      const what = st.members.length > 1 ? `Baugruppe aus ${st.members.map(name).join(', ')}` : name(id);
      return `${what} nach ${dirName(pl.dirs[st.dir])}${st.forced ? ' (steckt fest)' : ''}`;
    }).join('; ')}`);
    return `Reihenfolge des Auseinanderbaus laut Explosionsansicht (Strahltest auf dem Netz, ohne Gewähr; zum Zusammenbau rückwärts lesen). `
      + `Es bleibt stehen: ${name(plan.base)}.\n${lines.join('\n')}\n`;
  }

  /** Gleitend zum Ziel. Ohne Bildwiederholung (unsichtbares Fenster) steht sie nach Ablauf trotzdem dort. */
  private moveTo(target: number): void {
    this.stopAnim();
    const from = this.shown;
    if (Math.abs(target - from) < 1e-9) { this.show(target); return; }
    const t0 = performance.now();
    let raf = 0, done = false;
    const stop = () => { done = true; cancelAnimationFrame(raf); clearTimeout(timer); if (this.anim === handle) this.anim = null; };
    const finish = () => { if (done) return; stop(); this.show(target); this.deps.settled(); };
    const tick = () => {
      if (done) return;
      const k = Math.min(1, (performance.now() - t0) / MOVE_MS);
      if (k >= 1) { finish(); return; }
      this.show(from + (target - from) * (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2));
      raf = requestAnimationFrame(tick);
    };
    const timer = setTimeout(finish, MOVE_MS + 60);
    const handle = { stop };
    this.anim = handle;
    raf = requestAnimationFrame(tick);
  }

  private stopAnim(): void { this.anim?.stop(); this.playing = false; }

  private render(): void {
    const { ui } = this;
    const pct = Math.round(this.amount * 100);
    ui.range.min = '0'; ui.range.max = '100'; ui.range.step = '1';
    ui.range.value = String(pct);
    ui.value.textContent = `${pct} %`;
    ui.trails.setAttribute('aria-pressed', String(this.trails));
    const n = this.order.length;
    // Zwei Abspielknöpfe, je Richtung einer. Der laufende zeigt „Anhalten“ und leuchtet, der andere kehrt um
    const playButton = (b: HTMLButtonElement, on: boolean, name: string, title: string) => {
      b.replaceChildren(icon(on ? 'pause' : 'play', 15));
      b.classList.toggle('on', on);
      b.setAttribute('aria-label', on ? 'Anhalten' : name);
      b.title = on ? 'Anhalten (der laufende Schritt wird noch fertig)' : title;
    };
    playButton(ui.play, this.playing && this.playDir > 0, 'Auseinanderbauen abspielen', 'Den Auseinanderbau Schritt für Schritt abspielen');
    playButton(ui.assemble, this.playing && this.playDir < 0, 'Zusammenbauen abspielen', 'Den Zusammenbau Schritt für Schritt abspielen');
    const pos = this.stepPos ?? this.shownStep();
    ui.back.disabled = !n || pos <= 1e-6;
    ui.next.disabled = !n || pos >= n - 1e-6;
    ui.play.disabled = ui.assemble.disabled = ui.speed.disabled = ui.send.disabled = !n;
    // Nur bei Abweichung: render() läuft beim Abspielen in jedem Bild, eine offene Auswahlliste soll dabei stehen bleiben
    if (ui.speed.value !== String(this.speed)) ui.speed.value = String(this.speed);
    const k = this.shownStep();
    ui.step.textContent = n ? `Schritt ${k} von ${n}` : '';
    // Darunter, was in diesem Schritt herauskommt (Namen können lang sein, die Zeile hat die volle Breite)
    let what = '';
    if (n) {
      if (k === 0) what = 'Zusammengebaut';
      else if (this.stepPos === null) what = 'Alle Schritte zugleich';
      else {
        const names = new Map(this.deps.viewer.partList().map((x) => [x.id, x.name]));
        what = this.order[k - 1].map((id) => this.label(id, names)).join(', ');
      }
    }
    ui.names.textContent = what;
    ui.names.title = what;
    ui.names.hidden = !what;
    ui.step.title = what ? `${ui.step.textContent}: ${what}` : ui.step.textContent;
    if (!this.active) return;
    // Im Normalfall kein Hinweis: Die Zeile verschwindet dann ganz, statt leer Platz zu nehmen
    const notes: string[] = [];
    if (!this.plan?.base) notes.push('Keine Bauteile zum Auseinanderziehen.');
    else if (!this.moving) notes.push('Nur ein Bauteil, da rückt nichts auseinander.');
    if (this.forced) notes.push(`${this.forced === 1 ? 'Ein Teil steckt' : `${this.forced} Teile stecken`} fest (verklemmt oder eingeschlossen) und ${this.forced === 1 ? 'fährt' : 'fahren'} durch andere hindurch.`);
    if (this.refs && this.plan?.base) notes.push('Referenzen bleiben stehen.');
    ui.hint.textContent = notes.join(' ');
    ui.hint.hidden = !notes.length;
    ui.hint.classList.toggle('warn', this.forced > 0);
    // Ein offener Schnitt steht über dieser Karte (style.css), ihre Höhe hängt am Hinweis
    ui.viewerEl.style.setProperty('--excard-h', `${ui.card.offsetHeight}px`);
  }

  /** Für Tests. */
  state() {
    const flatSteps = (pl: Plan, unit: string | null = null, out: Record<string, unknown> = {}) => {
      for (const [id, st] of pl.steps) {
        out[id] = { members: st.members, dir: pl.dirs[st.dir].map((v) => +v.toFixed(4)), parent: st.parent, level: st.level, forced: st.forced,
          unit, base: st.sub?.base ?? null };
        if (st.sub) flatSteps(st.sub, id, out);
      }
      return out;
    };
    const vec = (m: Map<string, Vec>) => Object.fromEntries([...m].map(([id, s]) => [id, s.map((v) => +v.toFixed(4))]));
    const plan = this.plan;
    return {
      active: this.active, amount: this.amount, shown: this.shown, trails: this.trails, axis: this.axis,
      // animating auch während der Analyse: Tests warten so auf die fertige Lage
      moving: this.moving, forced: this.forced, animating: !!this.anim || !!this.loading, loading: !!this.loading, analysisMs: this.analysis ? Math.round(this.analysis.ms) : null,
      base: plan?.base ?? null,
      steps: plan ? flatSteps(plan) : {},
      spreads: vec(this.near.offsets), far: vec(this.far.offsets),
      order: this.order, stepPos: this.stepPos, playing: this.playing, chains: Object.fromEntries(this.chain), orderText: this.orderText(),
      direction: this.playing ? (this.playDir > 0 ? 'apart' : 'together') : null, speed: this.speed,
      shownStep: this.order.length ? this.shownStep() : null, hint: this.ui.hint.hidden ? null : this.ui.hint.textContent,
      text: this.ui.card.innerText, agent: this.agentText(),
    };
  }
}
