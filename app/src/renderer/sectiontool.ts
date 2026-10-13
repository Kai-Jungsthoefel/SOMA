import type { PlaneHit, Viewer } from './viewer';

type Axis = 'x' | 'y' | 'z' | 'face';

const AXES: Record<'x' | 'y' | 'z', number[]> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
/**
 * Welche Seite zunächst wegfällt: die, von der die Standardansicht kommt (rechts, vorne, oben). So sieht man nach dem
 * Einschalten gleich in den Schnitt. „Seite wechseln“ dreht das um.
 */
const REMOVE: Record<'x' | 'y' | 'z', number> = { x: 1, y: -1, z: 1 };

interface Ui {
  card: HTMLElement;
  /** Knopf „Schnitt“ im Viewer, Schließen in der Karte. */
  button: HTMLButtonElement; close: HTMLButtonElement;
  /** Knöpfe mit `data-axis` (x, y, z, face). */
  axes: HTMLElement;
  label: HTMLElement; range: HTMLInputElement; value: HTMLInputElement; hint: HTMLElement;
  flip: HTMLButtonElement; look: HTMLButtonElement;
}
interface Deps { viewer: Viewer }

// Ohne Tausendertrennzeichen: Der Wert steht auch im Eingabefeld und muss sich wieder lesen lassen
const num = (v: number, digits = 2) => (Math.abs(v) < 5e-4 ? 0 : v).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: 3, useGrouping: false }).replace(/^-/, '−');
/** Für den Agenten: Punkt als Dezimalzeichen, drei Stellen, kein „-0“. */
const f3 = (v: number) => (Math.abs(v) < 5e-4 ? 0 : v).toFixed(3);
const vec = (d: number[]) => `(${d.map((x) => +(Math.abs(x) < 5e-7 ? 0 : x).toFixed(4)).join(', ')})`;
const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Schrittweite für Schieber und Pfeiltasten: 1, 2 oder 5 mal einer Zehnerpotenz, etwa ein Fünfhundertstel des Bereichs. */
function niceStep(span: number): number {
  const raw = Math.max(span / 500, 1e-4);
  const p = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((k) => k * p).find((s) => s >= raw) ?? p * 10;
}

/**
 * Schnittansicht: Eine Ebene senkrecht zu X, Y oder Z oder parallel zu einer angeklickten ebenen Fläche schneidet das Modell.
 * Der Viewer füllt die Schnittflächen und zieht die Kontur. Klicks und Messungen gehen nur an das, was stehen bleibt.
 * Der Schnitt ändert nichts am Modell und wird nicht gespeichert.
 */
export class SectionTool {
  private active = false;
  private axis: Axis = 'x';
  /** Lage der Ebene entlang der Richtung (`a·p = value`). */
  private value = 0;
  private flipped = false;
  /** Fläche, an der der Schnitt ausgerichtet ist. `normal` zeigt aus dem Material heraus, `base` ist ihre Lage entlang der Normalen. */
  private face: { normal: number[]; point: number[]; name: string; base: number; drawing?: boolean } | null = null;
  private range: [number, number] = [0, 1];
  private picking = false;
  private note = '';

  constructor(private ui: Ui, private deps: Deps) {
    ui.button.addEventListener('click', () => this.setActive(!this.active));
    ui.close.addEventListener('click', () => this.setActive(false));
    ui.axes.querySelectorAll<HTMLButtonElement>('[data-axis]').forEach((b) => b.addEventListener('click', () => {
      const a = b.dataset.axis as Axis;
      if (a === 'face') this.startPick(); else this.setAxis(a);
    }));
    ui.range.addEventListener('input', () => this.setShown(Number(ui.range.value)));
    ui.value.addEventListener('change', () => this.takeInput());
    ui.value.addEventListener('blur', () => this.showValue());
    // Während getippt wird, bleibt der Text stehen (render lässt das fokussierte Feld in Ruhe). Enter, Escape und die Pfeiltasten
    // schreiben den übernommenen Wert danach ausdrücklich hinein.
    ui.value.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.takeInput(); this.showValue(); ui.value.select(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.showValue(); ui.value.blur(); }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        // Pfeiltasten: 1 mm, mit Umschalt 10 mm, mit Alt 0,1 mm
        e.preventDefault();
        const step = (e.shiftKey ? 10 : e.altKey ? 0.1 : 1) * (e.key === 'ArrowUp' ? 1 : -1);
        this.setShown(this.shown() + step);
        this.showValue();
        ui.value.select();
      }
    });
    ui.flip.addEventListener('click', () => { this.flipped = !this.flipped; this.apply(); });
    ui.look.addEventListener('click', () => this.deps.viewer.lookFrom(this.removedDir()));
    // Escape bricht das Anklicken einer Fläche ab. Vor allen anderen (Messen verlässt sonst seinen Modus).
    window.addEventListener('keydown', (e) => {
      if (!this.picking || e.key !== 'Escape') return;
      const t = e.target as HTMLElement | null;
      if (t?.closest?.('#terminals, #code-view, .menu')) return;
      e.preventDefault();
      e.stopPropagation();
      this.cancelPick();
    }, true);
    this.render();
  }

  get isActive(): boolean { return this.active; }

  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    this.ui.button.setAttribute('aria-pressed', String(on));
    this.ui.card.hidden = !on;
    this.stopPick();
    this.note = '';
    if (on) { this.updateRange(); this.value = this.mid(); this.apply(); } else this.deps.viewer.setSection(null);
    this.render();
  }

  /**
   * Schnitt wie in einer Zeichnung (E76): Ebene durch `point`, weggenommen wird die Seite, in die `removed` zeigt. `name`
   * nennt die Herkunft („section A-A of Bracket“). Danach ist es ein gewöhnlicher Schnitt an einer Fläche: Tiefe und Seite
   * lassen sich verstellen.
   */
  showPlane(point: number[], removed: number[], name: string): void {
    const len = Math.hypot(removed[0], removed[1], removed[2]);
    if (!(len > 1e-9)) return;
    this.stopPick();
    const n = removed.map((x) => x / len);
    this.axis = 'face';
    this.flipped = false;
    this.note = '';
    this.face = { normal: n, point: [...point], name, base: dot(n, point), drawing: true };
    if (!this.active) {
      this.active = true;
      this.ui.button.setAttribute('aria-pressed', 'true');
      this.ui.card.hidden = false;
    }
    this.updateRange();
    this.value = this.face.base;
    this.apply();
  }

  /** Stammt der Schnitt aus einer Zeichnung? */
  get fromDrawing(): boolean { return this.active && this.axis === 'face' && !!this.face?.drawing; }

  /** Neues Modell (Build oder anderer Stand): Bereich neu bestimmen, die Ebene bleibt, wo sie war. */
  refresh(): void {
    if (!this.active) return;
    this.updateRange();
    this.apply();
  }

  /** Beschreibung für den Agenten, etwa beim Markieren: welche Ebene, welche Seite fehlt. Ohne Schnitt null. */
  agentText(): string | null {
    if (!this.active) return null;
    if (this.axis !== 'face') {
      const name = this.axis.toUpperCase();
      const gone = this.removedSign() > 0 ? '>' : '<';
      return `section view at ${name} = ${f3(this.value)} mm, ${name} ${gone} ${f3(this.value)} is cut away`;
    }
    const r = this.removedDir();
    const p = this.planePoint();
    if (this.face!.drawing) return `section view as ${this.face!.name}, plane through (${p.map(f3).join(', ')}) mm, the side towards ${vec(r)} is cut away`;
    return `section view, plane through (${p.map(f3).join(', ')}) mm parallel to a face of "${this.face!.name}", `
      + `the side towards ${vec(r)} is cut away`;
  }

  // ---- Zustand ------------------------------------------------------------------------------------------------

  /** Richtung, entlang der `value` gemessen wird. */
  private dir(): number[] { return this.axis === 'face' ? this.face!.normal : AXES[this.axis]; }

  private removedSign(): number {
    const s = this.axis === 'face' ? 1 : REMOVE[this.axis];
    return this.flipped ? -s : s;
  }

  /** Richtung zur weggeschnittenen Seite. Von dort blickt man auf den Schnitt. */
  private removedDir(): number[] { return this.dir().map((x) => x * this.removedSign()); }

  private planePoint(): number[] {
    const a = this.dir();
    if (this.axis !== 'face') return a.map((x) => x * this.value);
    // Punkt der Fläche, entlang der Normalen in die Ebene geschoben
    const off = this.value - this.face!.base;
    return this.face!.point.map((x, i) => x + a[i] * off);
  }

  /** Was Schieber und Eingabe zeigen: die Koordinate, bei einer Fläche die Tiefe ab der Fläche (positiv ins Material). */
  private shown(): number { return this.axis === 'face' ? this.face!.base - this.value : this.value; }

  private setShown(u: number): void {
    if (!Number.isFinite(u)) return;
    this.value = this.axis === 'face' ? this.face!.base - u : u;
    this.apply();
  }

  private showValue(): void { if (this.active) this.ui.value.value = num(this.shown()); }

  private takeInput(): void {
    // Komma als Dezimaltrenner weiter annehmen, neben einem Punkt ist es ein Tausendertrennzeichen
    const s = this.ui.value.value.trim().replace(/\s/g, '').replace('−', '-');
    const t = s.includes('.') ? s.replace(/,/g, '') : s.replace(',', '.');
    const u = Number(t);
    if (t === '' || !Number.isFinite(u)) { this.render(); return; }
    this.setShown(u);
  }

  private updateRange(): void {
    this.range = this.deps.viewer.extent(this.dir()) ?? [-1, 1];
  }

  private mid(): number { return (this.range[0] + this.range[1]) / 2; }

  private setAxis(a: 'x' | 'y' | 'z'): void {
    this.stopPick();
    this.note = '';
    if (this.axis === a) { this.render(); return; }
    this.axis = a;
    this.flipped = false;
    this.updateRange();
    this.value = this.mid();
    this.apply();
  }

  // ---- Fläche anklicken ---------------------------------------------------------------------------------------

  private startPick(): void {
    this.picking = true;
    this.note = '';
    this.deps.viewer.pickPlane((h) => this.picked(h));
    this.render();
  }

  private picked(h: PlaneHit | null): void {
    if (!this.picking) return;
    if (!h || h.surface !== 'PLANE') {
      // Weiter warten: Ein Fehlklick soll nicht gleich alles abbrechen
      this.note = h ? 'That is not a planar face. Please click a planar face.' : 'There is no face there. Please click a planar face.';
      this.deps.viewer.pickPlane((x) => this.picked(x));
      this.render();
      return;
    }
    this.picking = false;
    this.note = '';
    this.axis = 'face';
    this.flipped = false;
    this.face = { normal: h.normal, point: h.point, name: h.name, base: dot(h.normal, h.point) };
    this.updateRange();
    // Anfangs mitten durch das Bauteil der Fläche, nicht genau in die Fläche (dort fiele die Schnittfläche mit ihr zusammen)
    const own = this.deps.viewer.extent(h.normal, [h.partId]);
    this.value = own ? (own[0] + own[1]) / 2 : this.mid();
    this.apply();
  }

  private cancelPick(): void { this.stopPick(); this.note = ''; this.render(); }

  private stopPick(): void {
    if (!this.picking) return;
    this.picking = false;
    this.deps.viewer.pickPlane(null);
  }

  // ---- Anzeige ------------------------------------------------------------------------------------------------

  private apply(): void {
    if (!this.active) return;
    // Ebene: a·p = value. Behalten wird die Gegenseite der weggeschnittenen: n = −s·a, c = s·value
    const s = this.removedSign();
    const n = this.dir().map((x) => -s * x);
    this.deps.viewer.setSection({ normal: n, constant: s * this.value });
    this.render();
  }

  private render(): void {
    const { ui } = this;
    ui.axes.querySelectorAll<HTMLButtonElement>('[data-axis]').forEach((b) => {
      const a = b.dataset.axis as Axis;
      const on = this.picking ? a === 'face' : a === this.axis;
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('waiting', this.picking && a === 'face');
    });
    if (!this.active) return;
    const faceMode = this.axis === 'face' && !!this.face;
    // Schieber in der angezeigten Größe: bei einer Fläche die Tiefe, sonst die Koordinate
    const [lo, hi] = faceMode ? [this.face!.base - this.range[1], this.face!.base - this.range[0]] : this.range;
    const u = this.shown();
    const step = niceStep(hi - lo);
    ui.range.min = String(Math.min(lo, u));
    ui.range.max = String(Math.max(hi, u));
    ui.range.step = String(step);
    ui.range.value = String(u);
    if (document.activeElement !== ui.value) this.showValue();
    ui.label.textContent = faceMode ? 'Depth' : `${this.axis.toUpperCase()} =`;
    ui.flip.disabled = ui.look.disabled = this.picking;
    ui.range.disabled = ui.value.disabled = this.picking;
    let hint: string;
    if (this.picking) hint = this.note || 'Click a planar face in the model. Escape cancels.';
    else if (faceMode && this.face!.drawing) hint = `As ${this.face!.name}, depth from its cutting plane.`;
    else if (faceMode) hint = `Parallel to a face of “${this.face!.name}”, depth from the face.`;
    else hint = `Cut away: ${this.axis.toUpperCase()} ${this.removedSign() > 0 ? '>' : '<'} ${num(this.value)} mm`;
    ui.hint.textContent = hint;
    ui.hint.classList.toggle('warn', !!this.note);
  }

  /** Für Tests. */
  state() {
    return {
      active: this.active, axis: this.axis, value: this.value, shown: this.active ? this.shown() : null, flipped: this.flipped, picking: this.picking,
      range: this.range, face: this.face, text: this.ui.card.innerText, agent: this.agentText(),
    };
  }
}
