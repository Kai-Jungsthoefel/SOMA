import * as THREE from 'three';
import type { AnimEntry, AnimList, RenderResult } from '../shared/types';
import { AnimData, type AnimFrame } from './animdata';
import { icon } from './icons';
import { paintOverlay } from './overlay';
import { el } from './ui';
import type { Viewer } from './viewer';

// Animationen im Viewer (E58, E82): abspielen, an eine Stelle springen. Die Bauteile bewegen sich im echten Modell,
// angehalten gehen Schnitt, Auswahl und Markieren. Untertitel und Beschriftungen stehen wie im Video über dem Bild, lassen sich
// im Viewer aber ausblenden (das Video behält sie). Abgespielt wird in der Leiste unten im Bild (mit dem × zurück zum Modell),
// Liste, Schritte und Videos zeigt der Reiter Animation (animpanel.ts).

interface Ui {
  /** Leiste unten im Bild. */
  bar: HTMLElement; close: HTMLButtonElement;
  play: HTMLButtonElement; range: HTMLInputElement; time: HTMLElement; total: HTMLElement; ticks: HTMLElement;
  loop: HTMLButtonElement; follow: HTMLButtonElement; texts: HTMLButtonElement; speed: HTMLSelectElement;
  /** Bekommt die Klasse `animating`, solange eine Animation gezeigt wird. */
  viewerEl: HTMLElement;
}
interface Deps {
  viewer: Viewer;
  list(): Promise<AnimList>;
  build(file: string): Promise<unknown>;
  readBinary(rel: string): Promise<ArrayBuffer>;
  renderVideo(id: string): Promise<RenderResult>;
  /** Vor dem Einschalten: Messen und Explosion beenden (beide brauchen die Einbaulage). */
  beforeOn(): void;
  insert(text: string): void;
  toast(text: string, kind?: 'ok' | 'info' | 'error'): void;
  /** Ein erzeugtes Video zeigen. */
  showVideo(rel: string): void;
  /** An, aus, eine andere Animation, neu gelesen oder Video fertig: Reiter und Baum ziehen nach. */
  changed(): void;
  /** Zeit oder Abspielen geändert (bei jedem Bild): der aktuelle Schritt im Reiter. */
  tick(): void;
}

export class AnimTool {
  private active = false;
  private list: AnimList = { animations: [], errors: [], building: false };
  private current: { entry: AnimEntry; data: AnimData; glb: string } | null = null;
  private t = 0;
  private playing = false;
  private raf = 0;
  private last = 0;
  private follow = true;
  private loop = false;
  /** Titel, Untertitel und Beschriftungen zeigen. Gilt für alle Animationen der Sitzung: Wer sie ausblendet, will meist nur die Bewegung sehen. */
  private texts = true;
  private rendering = false;
  /** Fortschritt beim Erzeugen eines Videos (0 bis 1). */
  private renderFraction = 0;
  /** Zuletzt gezeigte Animation: Der Reiter Animation bringt sie wieder. */
  private lastId: string | null = null;
  /** Für welche veraltete Animation schon ein Neubau angestoßen ist (nicht in jeder Runde erneut). */
  private rebuilt = '';
  private loading = 0;
  /** Beim nächsten Laden diese Animation zeigen (Wahl im Reiter). */
  private want: string | null = null;

  constructor(private readonly ui: Ui, private readonly d: Deps) {
    ui.close.addEventListener('click', () => this.setActive(false));
    ui.play.addEventListener('click', () => (this.playing ? this.pause() : this.play()));
    ui.range.addEventListener('input', () => { this.pause(); this.seek(Number(ui.range.value)); });
    ui.loop.addEventListener('click', () => { this.loop = !this.loop; ui.loop.setAttribute('aria-pressed', String(this.loop)); });
    ui.follow.addEventListener('click', () => this.setFollow(!this.follow));
    ui.texts.addEventListener('click', () => this.setTexts(!this.texts));
    ui.speed.addEventListener('change', () => { this.last = performance.now(); });
    window.addEventListener('keydown', (e) => {
      if (!this.active || (e.target as HTMLElement | null)?.closest?.('input, textarea, select, .cm-editor, #terminals')) return;
      // Liegt ein Video oder die Zeichenfläche darüber, gehört ihnen die Leertaste
      if (document.querySelector('#videoview:not([hidden]), #markup:not([hidden])')) return;
      if (e.key === ' ' && !e.ctrlKey) { e.preventDefault(); if (this.playing) this.pause(); else this.play(); }
    });
  }

  get isActive(): boolean { return this.active; }
  /** Name der gezeigten Animation (null: keine geladen). */
  get currentName(): string | null { return this.active ? this.current?.entry.name ?? null : null; }
  get currentId(): string | null { return this.active ? this.current?.entry.id ?? null : null; }
  /** Gezeigte Animation mit ihren Daten (Schritte, Untertitel), null: keine. */
  get shown(): { entry: AnimEntry; data: AnimData } | null { return this.active ? this.current : null; }
  /** Alle Animationen und Fehler der Dateien, wie zuletzt gelesen. */
  get entries(): AnimList { return this.list; }
  get time(): number { return this.t; }
  get isPlaying(): boolean { return this.playing; }
  get isRendering(): boolean { return this.rendering; }

  /** Eine bestimmte Animation zeigen, null: die zuletzt gezeigte, beim ersten Mal die erste. */
  show(id: string | null): void {
    this.want = id ?? this.lastId;
    if (!this.active) this.setActive(true);
    else if (this.want && this.want !== this.current?.entry.id) { const w = this.want; this.want = null; void this.choose(w); }
  }

  setActive(on: boolean): void {
    if (on === this.active) return;
    if (on) this.d.beforeOn();
    this.active = on;
    this.ui.bar.hidden = !on;
    this.ui.viewerEl.classList.toggle('animating', on);
    this.d.changed();
    if (on) { void this.refresh(); return; }
    this.loading++; // ein noch laufendes Laden darf danach nichts mehr ins Modell setzen
    this.pause();
    this.d.viewer.setPoses(null);
    this.d.viewer.setAnimState(null);
    this.d.viewer.setPainter(null);
  }

  /** Liste neu lesen (Watcher, Build, Einschalten) und die gewählte Animation neu laden. Ohne gezeigte Animation nur die Liste. */
  async refresh(): Promise<void> {
    const seq = ++this.loading;
    let list: AnimList;
    try { list = await this.d.list(); } catch { return; }
    if (seq !== this.loading) return;
    this.list = list;
    if (!this.active) { this.d.changed(); return; }
    const anims = this.list.animations;
    const want = anims.find((a) => a.id === (this.want ?? this.current?.entry.id)) ?? anims[0];
    this.want = null;
    if (want) {
      // Veraltet (Code oder Animationsdatei geändert): einmal neu bauen lassen, die Liste kommt danach wieder
      if (!want.stale) this.rebuilt = '';
      else if (!this.list.building && this.rebuilt !== want.id) {
        this.rebuilt = want.id;
        void this.d.build(want.file);
      }
      await this.load(want, seq);
    } else {
      this.current = null;
      this.d.viewer.setPoses(null);
      this.d.viewer.setAnimState(null);
      this.d.viewer.setPainter(null);
    }
    this.render();
    this.d.changed();
  }

  /** Liste von außen (der Reiter liest sie ohnehin), ohne die gezeigte Animation neu zu laden. */
  setList(list: AnimList): void { this.list = list; }

  /** Neues Modell geladen: Liste neu lesen (veraltet?) und die Lagen erneut anwenden, die Bauteile sind neu. */
  modelChanged(): void { if (this.active) void this.refresh(); }

  private async choose(id: string): Promise<void> {
    const e = this.list.animations.find((a) => a.id === id);
    if (!e) return;
    this.pause();
    this.t = 0;
    await this.load(e, ++this.loading);
    this.render();
    this.d.changed();
  }

  private async load(entry: AnimEntry, seq: number): Promise<void> {
    try {
      const buf = await this.d.readBinary(entry.glb);
      const data = await AnimData.parse(buf);
      if (seq !== this.loading || !this.active) return;
      const fresh = this.current?.entry.id !== entry.id;
      this.current = { entry, data, glb: entry.glb };
      this.lastId = entry.id;
      if (fresh) this.setFollow(!data.meta.cameraAuto);
      this.ui.range.max = String(data.duration);
      this.ui.range.step = String(Math.min(0.01, data.duration / 1000));
      this.t = Math.min(this.t, data.duration);
      // Marken der Schritte auf der Zeitleiste
      this.ui.ticks.replaceChildren(...stepsOf(data).map((s) => {
        const m = el('span', { className: 'cm', title: s.text });
        m.style.left = `${((s.start / Math.max(data.duration, 1e-6)) * 100).toFixed(2)}%`;
        return m;
      }));
      this.ui.total.textContent = `${data.duration.toFixed(1)} s`;
      this.apply();
    } catch (e) {
      this.current = null;
      this.d.toast(`Could not load the animation: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }

  private setFollow(on: boolean): void {
    this.follow = on;
    this.ui.follow.setAttribute('aria-pressed', String(on));
    if (on && this.current) this.apply();
  }

  private setTexts(on: boolean): void {
    this.texts = on;
    this.ui.texts.setAttribute('aria-pressed', String(on));
    // Nur die Texte neu malen: Ein ganzes apply() würde angehalten die frei gedrehte Kamera zurücksetzen
    if (this.current) this.paintTexts(this.current.data.frame(this.t));
  }

  private seek(t: number): void {
    if (!this.current) return;
    this.t = Math.max(0, Math.min(this.current.data.duration, t));
    this.apply();
  }

  /** An eine Zeit springen (Schritt im Reiter angeklickt). Läuft die Animation, läuft sie dort weiter. */
  jump(t: number): void { this.last = performance.now(); this.seek(t); }

  /** Stand zur aktuellen Zeit in den Viewer: Lagen, Zustände, Kamera (wenn sie folgt) und Texte. */
  private apply(): void {
    const c = this.current;
    if (!c) return;
    const f = c.data.frame(this.t);
    const ids = new Map(this.d.viewer.partList().map((p) => [p.name, p.id]));
    const byId = (names: Iterable<string>) => new Set([...names].map((n) => ids.get(n)).filter((x): x is string => !!x));
    const poses = new Map<string, THREE.Matrix4>();
    for (const [n, m] of f.poses) { const id = ids.get(n); if (id) poses.set(id, m); }
    this.d.viewer.setPoses(poses);
    this.d.viewer.setAnimState({ hidden: byId(f.hidden), ghost: byId(f.ghost), highlight: byId(f.highlight) });
    if (this.follow) this.d.viewer.setCamera(f.camera.position, f.camera.target);
    this.paintTexts(f);
    this.ui.range.value = String(this.t);
    this.ui.range.style.setProperty('--done', `${((this.t / Math.max(c.data.duration, 1e-6)) * 100).toFixed(2)}%`);
    this.ui.time.textContent = `${this.t.toFixed(1)} s`;
    this.d.tick();
  }

  /** Titel, Untertitel und Beschriftungen über das Bild, ausgeschaltet gar nichts (auch nicht im Bild für die Markierung). */
  private paintTexts(f: AnimFrame): void {
    if (!this.texts) { this.d.viewer.setPainter(null); return; }
    this.d.viewer.setPainter((g, w, h, project) => paintOverlay(g, w, h, {
      caption: f.caption, title: f.title,
      // Im Viewer steht unten die Abspielleiste: Untertitel darüber, sonst verdeckt sie ihn (im Video steht er unten)
      captionLift: this.ui.bar.hidden ? 0 : (this.ui.bar.offsetHeight + 34) * (w / Math.max(1, this.ui.viewerEl.clientWidth)),
      labels: f.labels.map((l) => ({ text: l.text, p: project(l.at) })).filter((l) => l.p).map((l) => ({ text: l.text, x: l.p!.x, y: l.p!.y })),
    }));
  }

  play(): void {
    if (!this.current || this.playing) return;
    if (this.t >= this.current.data.duration - 1e-6) this.t = 0;
    this.playing = true;
    this.last = performance.now();
    this.renderPlay();
    const tick = () => {
      if (!this.playing || !this.current) return;
      const now = performance.now();
      this.t += ((now - this.last) / 1000) * Number(this.ui.speed.value || 1);
      this.last = now;
      const dur = this.current.data.duration;
      if (this.t >= dur) {
        if (this.loop) this.t = this.t % Math.max(dur, 1e-3);
        else { this.t = dur; this.apply(); this.pause(); return; }
      }
      this.apply();
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  pause(): void {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.renderPlay();
  }

  private renderPlay(): void {
    this.ui.play.replaceChildren(icon(this.playing ? 'pause' : 'play', 16, 2.2));
    this.ui.play.setAttribute('aria-label', this.playing ? 'Pause' : 'Play');
    this.ui.play.title = this.playing ? 'Pause (Space)' : 'Play (Space)';
    this.d.tick();
  }

  private render(): void {
    const has = !!this.current;
    for (const b of [this.ui.play, this.ui.follow, this.ui.loop, this.ui.texts]) b.disabled = !has;
    this.ui.range.disabled = !has;
    if (!has) { this.ui.time.textContent = ''; this.ui.total.textContent = ''; this.ui.ticks.replaceChildren(); }
  }

  /** Zeile unter dem Kopf im Reiter: Fehler, Bauen, veraltet, Video in Arbeit. `warn`: gelb. */
  hint(): { text: string; warn: boolean } | null {
    const c = this.current, err = this.list.errors[0];
    if (this.rendering) return { text: `Making the video … ${Math.round(this.renderFraction * 100)} %`, warn: false };
    if (err) return { text: `${err.file}${err.line ? `, line ${err.line}` : ''}: ${err.message}`, warn: true };
    if (this.list.building) return { text: 'Building the animation …', warn: false };
    if (c?.entry.stale) return { text: 'Older than the code, rebuilding …', warn: true };
    return null;
  }

  /** Fortschritt beim Erzeugen eines Videos (0 bis 1). */
  progress(f: number): void {
    if (!this.rendering) return;
    this.renderFraction = f;
    this.d.changed();
  }

  async makeVideo(): Promise<void> {
    const c = this.current;
    if (!c || this.rendering) return;
    this.pause();
    this.rendering = true;
    this.renderFraction = 0;
    this.d.changed();
    try {
      const r = await this.d.renderVideo(c.entry.id);
      if (!r.ok) { this.d.toast(`Could not make the video: ${r.error ?? 'unknown error'}`, 'error'); return; }
      const mp4 = r.files.find((f) => f.endsWith('.mp4'));
      this.d.toast(`Video created: ${mp4}${r.warnings.length ? `\n${r.warnings.join('\n')}` : ''}`, r.warnings.length ? 'info' : 'ok');
      if (mp4) this.d.showVideo(mp4);
    } finally {
      this.rendering = false;
      this.d.changed();
    }
  }

  /** Für die Markierung: Welche Animation zu welcher Zeit zu sehen ist (null: keine). */
  agentText(): string | null {
    if (!this.active || !this.current) return null;
    // Ausgeblendete Texte fehlen auch im Bild: Sonst sucht der Agent einen Untertitel, den er selbst angelegt hat, vergeblich
    return `animation "${this.current.entry.name}" at ${this.t.toFixed(2)} s${this.texts ? '' : ' (without titles, captions and labels)'}`;
  }

  agentNote(): string | null {
    const c = this.current;
    return c ? `[Animation: "${c.entry.name}" (${c.entry.file}) at ${this.t.toFixed(2)} s] ` : null;
  }

  /** Prüfhilfe: Zustand der Karte. */
  state() {
    return {
      active: this.active, playing: this.playing, t: +this.t.toFixed(3), follow: this.follow, loop: this.loop, texts: this.texts,
      name: this.current?.entry.name ?? null, duration: this.current?.data.duration ?? null,
      options: this.list.animations.map((a) => a.name), hint: this.hint()?.text ?? '', time: this.ui.time.textContent,
      note: this.agentNote(), building: this.list.building, errors: this.list.errors.length,
    };
  }

  /** Prüfhilfe: an diese Zeit springen (in unsichtbaren Fenstern läuft requestAnimationFrame nicht). */
  testSeek(t: number): void { this.pause(); this.seek(t); }
}

/**
 * Schritte einer Animation für den Reiter (E82): die Untertitel, die der Agent für Menschen geschrieben hat. Ohne Untertitel
 * der Ablauf aus der Datei (Bewegungen und Kamera, wie `soma anim info`), ohne Pausen und Texte.
 */
export function stepsOf(data: AnimData): { start: number; end: number; text: string }[] {
  const caps = (data.meta.captions ?? []).filter((c) => c.text);
  if (caps.length) return caps;
  return (data.meta.steps ?? []).filter((x) => !/^(Pause|Title|Caption|Label)/.test(x.text));
}

/** Woher die Schritte kommen. */
export const stepsSource = (data: AnimData) => ((data.meta.captions ?? []).some((c) => c.text) ? 'from the subtitles' : 'from the animation');
