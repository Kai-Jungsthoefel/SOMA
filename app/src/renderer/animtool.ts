import * as THREE from 'three';
import type { AnimEntry, AnimList, RenderResult } from '../shared/types';
import { AnimData, type AnimFrame } from './animdata';
import { icon } from './icons';
import { paintOverlay } from './overlay';
import { el } from './ui';
import type { Viewer } from './viewer';

// Animationen im Viewer (E58): auswählen, abspielen, an eine Stelle springen. Die Bauteile bewegen sich im echten Modell,
// angehalten gehen Schnitt, Auswahl und Markieren. Untertitel und Beschriftungen stehen wie im Video über dem Bild, lassen sich
// im Viewer aber ausblenden (das Video behält sie).

interface Ui {
  card: HTMLElement; close: HTMLButtonElement;
  select: HTMLSelectElement; play: HTMLButtonElement; range: HTMLInputElement; time: HTMLElement;
  loop: HTMLButtonElement; follow: HTMLButtonElement; speed: HTMLSelectElement; hint: HTMLElement;
  video: HTMLButtonElement; agent: HTMLButtonElement;
  /** Bekommt die Klasse `animating`, solange die Karte offen ist. */
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
  /** An, aus oder eine andere Animation: der Umschalter oben links zeigt, was zu sehen ist. */
  changed(): void;
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
  /** Der Schalter steht in der Karte, gesucht statt übergeben (fehlt er, gibt es eben keinen Schalter). */
  private readonly textsBtn: HTMLButtonElement | null;
  private rendering = false;
  /** Für welche veraltete Animation schon ein Neubau angestoßen ist (nicht in jeder Runde erneut). */
  private rebuilt = '';
  private loading = 0;
  /** Beim nächsten Laden diese Animation zeigen (Wahl im Umschalter). */
  private want: string | null = null;

  constructor(private readonly ui: Ui, private readonly d: Deps) {
    ui.close.addEventListener('click', () => this.setActive(false));
    ui.select.addEventListener('change', () => void this.choose(ui.select.value));
    ui.play.addEventListener('click', () => (this.playing ? this.pause() : this.play()));
    ui.range.addEventListener('input', () => { this.pause(); this.seek(Number(ui.range.value)); });
    ui.loop.addEventListener('click', () => { this.loop = !this.loop; ui.loop.setAttribute('aria-pressed', String(this.loop)); });
    ui.follow.addEventListener('click', () => this.setFollow(!this.follow));
    this.textsBtn = ui.card.querySelector<HTMLButtonElement>('#btn-anim-texts');
    this.textsBtn?.addEventListener('click', () => this.setTexts(!this.texts));
    ui.speed.addEventListener('change', () => { this.last = performance.now(); });
    ui.video.addEventListener('click', () => void this.makeVideo());
    ui.agent.addEventListener('click', () => { const t = this.agentNote(); if (t) d.insert(t); });
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

  /** Eine bestimmte Animation zeigen (aus dem Umschalter oben links), null: die zuletzt gezeigte oder die erste. */
  show(id: string | null): void {
    this.want = id;
    if (!this.active) this.setActive(true);
    else if (id && id !== this.current?.entry.id) void this.choose(id);
  }

  setActive(on: boolean): void {
    if (on === this.active) return;
    if (on) this.d.beforeOn();
    this.active = on;
    this.ui.card.hidden = !on;
    this.ui.viewerEl.classList.toggle('animating', on);
    this.d.changed();
    if (on) { void this.refresh(); return; }
    this.loading++; // ein noch laufendes Laden darf danach nichts mehr ins Modell setzen
    this.pause();
    this.d.viewer.setPoses(null);
    this.d.viewer.setAnimState(null);
    this.d.viewer.setPainter(null);
  }

  /** Liste neu lesen (Watcher, Build, Einschalten) und die gewählte Animation neu laden. */
  async refresh(): Promise<void> {
    if (!this.active) return;
    const seq = ++this.loading;
    try { this.list = await this.d.list(); } catch { return; }
    if (seq !== this.loading || !this.active) return;
    const anims = this.list.animations;
    this.ui.select.replaceChildren(...anims.map((a) => el('option', { value: a.id, textContent: `${a.name} (${a.duration.toFixed(1).replace('.', ',')} s)` })));
    this.ui.select.disabled = anims.length < 2;
    const want = anims.find((a) => a.id === (this.want ?? this.current?.entry.id)) ?? anims[0];
    this.want = null;
    if (want) {
      this.ui.select.value = want.id;
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
  }

  /** Neues Modell geladen: Liste neu lesen (veraltet?) und die Lagen erneut anwenden, die Bauteile sind neu. */
  modelChanged(): void { if (this.active) void this.refresh(); }

  private async choose(id: string): Promise<void> {
    const e = this.list.animations.find((a) => a.id === id);
    if (!e) return;
    this.pause();
    this.t = 0;
    await this.load(e, ++this.loading);
    this.render();
  }

  private async load(entry: AnimEntry, seq: number): Promise<void> {
    try {
      const buf = await this.d.readBinary(entry.glb);
      const data = await AnimData.parse(buf);
      if (seq !== this.loading || !this.active) return;
      const fresh = this.current?.entry.id !== entry.id;
      this.current = { entry, data, glb: entry.glb };
      if (fresh) this.setFollow(!data.meta.cameraAuto);
      this.ui.range.max = String(data.duration);
      this.ui.range.step = String(Math.min(0.01, data.duration / 1000));
      this.t = Math.min(this.t, data.duration);
      this.apply();
      this.d.changed();
    } catch (e) {
      this.current = null;
      this.d.toast(`Die Animation ließ sich nicht laden: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  }

  private setFollow(on: boolean): void {
    this.follow = on;
    this.ui.follow.setAttribute('aria-pressed', String(on));
    if (on && this.current) this.apply();
  }

  private setTexts(on: boolean): void {
    this.texts = on;
    this.textsBtn?.setAttribute('aria-pressed', String(on));
    // Nur die Texte neu malen: Ein ganzes apply() würde angehalten die frei gedrehte Kamera zurücksetzen
    if (this.current) this.paintTexts(this.current.data.frame(this.t));
  }

  private seek(t: number): void {
    if (!this.current) return;
    this.t = Math.max(0, Math.min(this.current.data.duration, t));
    this.apply();
  }

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
    this.ui.time.textContent = `${this.t.toFixed(2).replace('.', ',')} / ${c.data.duration.toFixed(2).replace('.', ',')} s`;
  }

  /** Titel, Untertitel und Beschriftungen über das Bild, ausgeschaltet gar nichts (auch nicht im Bild für die Markierung). */
  private paintTexts(f: AnimFrame): void {
    if (!this.texts) { this.d.viewer.setPainter(null); return; }
    this.d.viewer.setPainter((g, w, h, project) => paintOverlay(g, w, h, {
      caption: f.caption, title: f.title,
      // Im Viewer stehen unten links die Karten: Untertitel darüber, sonst verdecken sie ihn (im Video steht er unten)
      captionLift: this.ui.card.hidden ? 0 : ((this.ui.card.parentElement ?? this.ui.card).offsetHeight + 24) * (w / Math.max(1, this.ui.viewerEl.clientWidth)),
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
    this.ui.play.replaceChildren(icon(this.playing ? 'pause' : 'play', 16, 2));
    this.ui.play.setAttribute('aria-label', this.playing ? 'Anhalten' : 'Abspielen');
    this.ui.play.title = this.playing ? 'Anhalten (Leertaste)' : 'Abspielen (Leertaste)';
  }

  private render(): void {
    const c = this.current, hint = this.ui.hint;
    const err = this.list.errors[0];
    const has = !!c;
    for (const b of [this.ui.play, this.ui.agent, this.ui.video, this.ui.follow, this.ui.loop, this.textsBtn]) if (b) b.disabled = !has;
    this.ui.range.disabled = !has;
    this.ui.video.disabled = !has || this.rendering;
    hint.classList.toggle('warn', !!err || !!c?.entry.stale);
    if (this.rendering) return;
    if (err) hint.textContent = `${err.file}${err.line ? `, Zeile ${err.line}` : ''}: ${err.message}`;
    else if (this.list.building) hint.textContent = 'Animation wird gebaut …';
    else if (c?.entry.stale) hint.textContent = 'Älter als der Code, wird neu gebaut …';
    else if (c) hint.textContent = `${c.entry.file}, Zeile ${c.entry.line ?? 1} · ${c.entry.parts} bewegte${c.entry.parts === 1 ? 's' : ''} Bauteil${c.entry.parts === 1 ? '' : 'e'}`;
    else hint.textContent = 'Noch keine Animation. Der Agent legt sie in animations/ an (Skill „Animation und Video“).';
    if (!has) this.ui.time.textContent = '';
  }

  /** Fortschritt beim Erzeugen eines Videos (0 bis 1). */
  progress(f: number): void {
    if (!this.rendering) return;
    this.ui.hint.classList.remove('warn');
    this.ui.hint.textContent = `Video wird erzeugt … ${Math.round(f * 100)} %`;
  }

  private async makeVideo(): Promise<void> {
    const c = this.current;
    if (!c || this.rendering) return;
    this.pause();
    this.rendering = true;
    this.ui.video.disabled = true;
    this.progress(0);
    try {
      const r = await this.d.renderVideo(c.entry.id);
      if (!r.ok) { this.d.toast(`Das Video ließ sich nicht erzeugen: ${r.error ?? 'unbekannter Fehler'}`, 'error'); return; }
      const mp4 = r.files.find((f) => f.endsWith('.mp4'));
      this.d.toast(`Video erzeugt: ${mp4}${r.warnings.length ? `\n${r.warnings.join('\n')}` : ''}`, r.warnings.length ? 'info' : 'ok');
      if (mp4) this.d.showVideo(mp4);
    } finally {
      this.rendering = false;
      this.render();
    }
  }

  /** Für die Markierung: Welche Animation zu welcher Zeit zu sehen ist (null: keine). */
  agentText(): string | null {
    if (!this.active || !this.current) return null;
    // Ausgeblendete Texte fehlen auch im Bild: Sonst sucht der Agent einen Untertitel, den er selbst angelegt hat, vergeblich
    return `Animation „${this.current.entry.name}“ bei ${this.t.toFixed(2)} s${this.texts ? '' : ' (ohne Titel, Untertitel und Beschriftungen)'}`;
  }

  private agentNote(): string | null {
    const c = this.current;
    return c ? `[Animation: "${c.entry.name}" (${c.entry.file}) bei ${this.t.toFixed(2)} s] ` : null;
  }

  /** Prüfhilfe: Zustand der Karte. */
  state() {
    return {
      active: this.active, playing: this.playing, t: +this.t.toFixed(3), follow: this.follow, loop: this.loop, texts: this.texts,
      name: this.current?.entry.name ?? null, duration: this.current?.data.duration ?? null,
      options: [...this.ui.select.options].map((o) => o.textContent), hint: this.ui.hint.textContent, time: this.ui.time.textContent,
      note: this.agentNote(), building: this.list.building, errors: this.list.errors.length,
    };
  }

  /** Prüfhilfe: an diese Zeit springen (in unsichtbaren Fenstern läuft requestAnimationFrame nicht). */
  testSeek(t: number): void { this.pause(); this.seek(t); }
}
