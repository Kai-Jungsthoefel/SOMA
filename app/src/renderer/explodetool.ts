import type { ExplodePart, Viewer } from './viewer';

interface Ui {
  card: HTMLElement;
  /** Knopf „Explosion“ im Viewer, Schließen in der Karte. */
  button: HTMLButtonElement; close: HTMLButtonElement;
  range: HTMLInputElement; value: HTMLElement; hint: HTMLElement;
  trails: HTMLButtonElement; fit: HTMLButtonElement;
  /** Bekommt die Klasse `exploding`, solange die Karte offen ist (ein offener Schnitt rückt dann darüber). */
  viewerEl: HTMLElement;
}
interface Deps {
  viewer: Viewer;
  /** Vor dem Einschalten: Gemessen wird nur in Einbaulage, die exakte Geometrie kennt keine Explosion. */
  beforeOn: () => void;
  /** Die Bauteile stehen still (Schieber losgelassen, Bewegung zu Ende), etwa für den Bereich des Schnitts. */
  settled: () => void;
}

/**
 * Abstand bei 100 % als Vielfaches des Abstands der Mitten. Gruppen rücken weiter auseinander als die Teile in ihnen, so
 * bleiben sie als Gruppe erkennbar. Geöffnet wird bei OPEN_AMOUNT, der Schieber reicht für weit verschachtelte Teile bis 100 %.
 */
const GROUP_WEIGHT = 3.2;
const PART_WEIGHT = 2;
const OPEN_AMOUNT = 0.5;
const MOVE_MS = 450;
/** Achsen gelten als gleich, wenn sie höchstens etwa 2,5° auseinanderliegen. */
const SAME_AXIS = 0.999;

type Vec = number[];
const add = (a: Vec, b: Vec) => a.map((x, i) => x + b[i]);
const sub = (a: Vec, b: Vec) => a.map((x, i) => x - b[i]);
const scale = (a: Vec, k: number) => a.map((x) => x * k);
const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Knoten im Baum der Gruppen: eine Gruppe oder ein Bauteil. `axis`: gemeinsame Achse aller Bauteile darunter, sonst null. */
interface Node {
  part?: ExplodePart; children: Node[]; byName: Map<string, Node>;
  min: Vec; max: Vec; axis: Vec | null; span: [number, number] | null;
}

const node = (part?: ExplodePart): Node => ({ part, children: [], byName: new Map(), min: [0, 0, 0], max: [0, 0, 0], axis: null, span: null });
const center = (n: Node) => n.min.map((x, i) => (x + n.max[i]) / 2);

function finish(n: Node): void {
  if (n.part) {
    n.min = n.part.min; n.max = n.part.max;
    n.axis = n.part.axis;
    n.span = n.part.axis ? n.part.span : null;
    return;
  }
  n.children.forEach(finish);
  n.min = [0, 1, 2].map((k) => Math.min(...n.children.map((c) => c.min[k])));
  n.max = [0, 1, 2].map((k) => Math.max(...n.children.map((c) => c.max[k])));
  const a = n.children[0]?.axis ?? null;
  n.axis = a && n.children.every((c) => c.axis && dot(c.axis, a) > SAME_AXIS) ? a : null;
  const spans = n.children.map((c) => c.span).filter((s): s is [number, number] => !!s);
  n.span = n.axis && spans.length ? [Math.min(...spans.map((s) => s[0])), Math.max(...spans.map((s) => s[1]))] : null;
}

function walk(n: Node, acc: Vec, out: Map<string, Vec>): void {
  const c = center(n);
  for (const ch of n.children) {
    const v = sub(center(ch), c);
    const w = ch.part ? PART_WEIGHT : GROUP_WEIGHT;
    let s: Vec;
    if (!ch.axis) s = scale(v, w);
    else if (n.axis) s = scale(ch.axis, dot(v, ch.axis) * w); // innerhalb gleicher Achse: nur die Reihenfolge entlang der Achse
    else {
      // Normteil verlässt sein Bauteil: aus dem Material heraus, dazu die eigene Länge (bei OPEN_AMOUNT ist es dann aus der Bohrung)
      const len = ch.span ? ch.span[1] - ch.span[0] : 0;
      s = scale(ch.axis, (Math.max(dot(v, ch.axis), 0) + len) * w);
    }
    const next = add(acc, s);
    if (ch.part) out.set(ch.part.id, next); else walk(ch, next, out);
  }
}

/**
 * Verschiebung jedes Bauteils bei voller Explosion (100 %), ohne KI, allein aus der Lage der Bauteile:
 * - Die Bauteile bilden einen Baum aus ihren Gruppen. Jeder Knoten rückt von der Mitte seines Elternknotens weg, um ein
 *   Vielfaches des Abstands seiner Mitte zu ihr (Mitte des Hüllquaders, Teile PART_WEIGHT, Gruppen GROUP_WEIGHT). Die
 *   Schritte addieren sich entlang des Pfads. Ein Bauteil genau in der Mitte bleibt stehen.
 * - Normteile (und Gruppen, deren Teile alle dieselbe Achse haben) bewegen sich nur entlang ihrer Achse aus dem Material
 *   heraus: um ihren Abstand in Achsrichtung (nicht negativ) plus ihre Länge. Seitlich würden sie durch die Wand fahren.
 * - Referenzen bleiben stehen und zählen für die Mitten nicht mit (sie sind Umgebung, nicht Teil der Konstruktion).
 */
export function explodeSpreads(parts: ExplodePart[]): Map<string, Vec> {
  const out = new Map<string, Vec>();
  const root = node();
  for (const p of parts) {
    if (p.role === 'reference') continue;
    let n = root;
    for (const seg of (p.group ?? '').split('/').map((s) => s.trim()).filter(Boolean)) {
      let g = n.byName.get(seg);
      if (!g) { g = node(); n.byName.set(seg, g); n.children.push(g); }
      n = g;
    }
    n.children.push(node(p));
  }
  if (!root.children.length) return out;
  finish(root);
  walk(root, [0, 0, 0], out);
  return out;
}

/**
 * Explosionsansicht: Die Bauteile rücken auseinander, gesteuert über einen Schieber (0–100 %). Die Richtungen bestimmt
 * explodeSpreads. Ändert nichts am Modell und wird nicht gespeichert. Gemessen wird nur in Einbaulage (Messen setzt zusammen).
 */
export class ExplodeTool {
  private active = false;
  /** Stand des Schiebers (0..1). Bleibt für das nächste Einschalten. */
  private amount = OPEN_AMOUNT;
  /** Gezeigter Anteil, während einer Bewegung zwischen altem und neuem Wert. */
  private shown = 0;
  private spreads = new Map<string, Vec>();
  private moving = 0;
  private refs = 0;
  private trails = true;
  private anim: { stop(): void } | null = null;

  constructor(private ui: Ui, private deps: Deps) {
    ui.button.addEventListener('click', () => this.setActive(!this.active));
    ui.close.addEventListener('click', () => this.setActive(false));
    ui.range.addEventListener('input', () => {
      this.amount = Math.min(1, Math.max(0, Number(ui.range.value) / 100));
      this.stopAnim();
      this.show(this.amount);
      this.render();
    });
    ui.range.addEventListener('change', () => this.deps.settled());
    ui.trails.addEventListener('click', () => { this.trails = !this.trails; this.deps.viewer.setTrails(this.trails); this.render(); });
    ui.fit.addEventListener('click', () => this.deps.viewer.setView('fit'));
    this.deps.viewer.setTrails(this.trails);
    this.render();
  }

  get isActive(): boolean { return this.active; }

  /** Ein- oder ausschalten. Mit `animate` gleiten die Bauteile, ohne springen sie (etwa wenn Messen übernimmt). */
  setActive(on: boolean, animate = true): void {
    if (on !== this.active) {
      this.active = on;
      this.ui.button.setAttribute('aria-pressed', String(on));
      this.ui.card.hidden = !on;
      this.ui.viewerEl.classList.toggle('exploding', on);
      if (on) { this.deps.beforeOn(); this.compute(); }
    }
    const target = on ? this.amount : 0;
    if (animate) this.moveTo(target);
    else if (this.anim || this.shown !== target) { this.stopAnim(); this.show(target); this.deps.settled(); }
    this.render();
  }

  /** Neues Modell (Build oder anderer Stand): Richtungen neu bestimmen, die Explosion bleibt so weit, wie sie war. */
  refresh(): void {
    this.compute();
    if (this.shown > 0) this.show(this.shown);
    this.render();
  }

  /** Beschreibung für den Agenten, etwa beim Markieren. Ohne Explosion null. */
  agentText(): string | null {
    if (!this.active || this.shown <= 0 || !this.moving) return null;
    return `Explosionsansicht (${Math.round(this.shown * 100)} %): Die Bauteile sind nur zur Darstellung auseinandergezogen, ihre Lage im Bild ist nicht die Einbaulage`;
  }

  private compute(): void {
    const parts = this.deps.viewer.explodeParts();
    this.spreads = explodeSpreads(parts);
    this.refs = parts.filter((p) => p.role === 'reference').length;
    this.moving = [...this.spreads.values()].filter((s) => Math.hypot(s[0], s[1], s[2]) > 1e-6).length;
  }

  private show(t: number): void {
    this.shown = t;
    if (t <= 0) { this.deps.viewer.setOffsets(null); return; }
    const m = new Map<string, Vec>();
    for (const [id, s] of this.spreads) m.set(id, scale(s, t));
    this.deps.viewer.setOffsets(m);
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

  private stopAnim(): void { this.anim?.stop(); }

  private render(): void {
    const { ui } = this;
    const pct = Math.round(this.amount * 100);
    ui.range.min = '0'; ui.range.max = '100'; ui.range.step = '1';
    ui.range.value = String(pct);
    ui.value.textContent = `${pct} %`;
    ui.trails.setAttribute('aria-pressed', String(this.trails));
    if (!this.active) return;
    let hint: string;
    if (!this.spreads.size) hint = 'Keine Bauteile zum Auseinanderziehen.';
    else if (!this.moving) hint = 'Nur ein Bauteil, da rückt nichts auseinander.';
    else hint = 'Teile rücken von der Mitte weg, Gruppen gemeinsam, Normteile entlang ihrer Achse.';
    if (this.refs && this.spreads.size) hint += ' Referenzen bleiben stehen.';
    ui.hint.textContent = hint;
    // Ein offener Schnitt steht über dieser Karte (style.css), ihre Höhe hängt am Hinweis
    ui.viewerEl.style.setProperty('--excard-h', `${ui.card.offsetHeight}px`);
  }

  /** Für Tests. */
  state() {
    return {
      active: this.active, amount: this.amount, shown: this.shown, trails: this.trails, moving: this.moving, animating: !!this.anim,
      spreads: Object.fromEntries([...this.spreads].map(([id, s]) => [id, s.map((v) => +v.toFixed(4))])),
      text: this.ui.card.innerText, agent: this.agentText(),
    };
  }
}
