import type { AnimEntry } from '../shared/types';
import { stepsOf, stepsSource, type AnimTool } from './animtool';
import { icon } from './icons';
import { el } from './ui';

// Reiter Animation (E82): Liste der Animationen mit den Videos darunter und der Ablauf der gezeigten. Die Schritte kommen aus der
// Animation (ausdrücklich oder aus den Untertiteln), ein Klick springt hin. Abgespielt wird in der Leiste unten im Bild (animtool.ts).
// Videos stehen nach Ordnern, ein Ordner lässt sich einklappen (der Agent legt oft viele Einzelclips neben die Hauptvideos).
// Rechtsklick auf ein Video öffnet das Menü der Datei wie im Dateibaum.

interface Ui {
  list: HTMLElement; listCount: HTMLElement; rows: HTMLElement;
  report: HTMLElement; back: HTMLButtonElement; backCount: HTMLElement; code: HTMLButtonElement;
  body: HTMLElement; video: HTMLButtonElement; agent: HTMLButtonElement;
}
interface Deps {
  tool: AnimTool;
  /** Videos in renders/ (Pfade im Projekt). */
  videos(): string[];
  openVideo(rel: string): void;
  openCode(file: string, line: number | null): void;
  insert(text: string): void;
  isNew(key: string): boolean;
  seen(key: string): void;
  /** Menü der Datei (wie im Dateibaum) an dieser Stelle. */
  fileMenu(rel: string, x: number, y: number): void;
  /** Eingeklappte Ordner der Videoliste, pro Modell gemerkt. */
  closedDirs(): string[];
  setClosedDirs(dirs: string[]): void;
}

export const animKey = (a: AnimEntry) => `a:${a.id}`;
export const videoKey = (v: string) => `v:${v}`;
const base = (rel: string) => rel.split('/').pop() ?? rel;
const dirOf = (rel: string) => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

export class AnimPanel {
  private mode: 'list' | 'report' = 'report';
  /** Zuletzt hervorgehobener Schritt: Nur bei einem Wechsel wird neu gezeichnet, nicht in jedem Bild. */
  private curStep = -2;

  constructor(private readonly ui: Ui, private readonly d: Deps) {
    ui.back.addEventListener('click', () => { this.mode = 'list'; this.render(); });
    ui.video.addEventListener('click', () => void d.tool.makeVideo());
    ui.agent.addEventListener('click', () => { const t = d.tool.agentNote(); if (t) d.insert(t); });
    ui.code.addEventListener('click', () => { const e = d.tool.shown?.entry; if (e) d.openCode(e.file, e.line); });
  }

  /** Reiter geöffnet: der Ablauf der Animation im Bild, sonst die Liste. */
  opened(): void { this.mode = 'report'; this.render(); }

  render(): void {
    const s = this.d.tool.shown;
    const report = !!s && this.mode === 'report';
    this.ui.list.hidden = report;
    this.ui.report.hidden = !report;
    const n = this.d.tool.entries.animations.length;
    this.ui.listCount.textContent = n ? String(n) : '';
    this.ui.backCount.textContent = String(n);
    this.curStep = -2;
    if (report) this.renderReport(); else this.renderList();
  }

  /** Zeit geändert: nur den aktuellen Schritt nachziehen. */
  tick(): void {
    const s = this.d.tool.shown;
    if (!s || this.ui.report.hidden) return;
    const t = this.d.tool.time;
    const steps = stepsOf(s.data);
    let cur = -1;
    steps.forEach((x, i) => { if (t >= x.start - 1e-6) cur = i; });
    if (cur === this.curStep) return;
    this.curStep = cur;
    this.ui.body.querySelectorAll('.cx-seq').forEach((r, i) => r.classList.toggle('cur', i === cur));
  }

  /** `showDir`: Ordner unter dem Namen (nur ohne Ordnerköpfe, sonst steht er schon darüber). */
  private videoRow(v: string, showDir: boolean): HTMLButtonElement {
    const isNew = this.d.isNew(videoKey(v));
    const meta = showDir || isNew ? el('div', { className: 'm' }, showDir ? v.slice(0, v.length - base(v).length) || './' : '',
      isNew ? el('span', { className: 'tag acc', textContent: 'new' }) : null) : null;
    const b = el('button', { className: 'al-row ic3' + (showDir ? '' : ' in'), title: `${v}: open in the player. Right-click for file actions.` }, el('span', { className: 'ic' }, icon('f-video', 16)),
      el('div', {}, el('div', { className: 't', textContent: base(v) }), meta),
      el('div', { className: 'v' }));
    b.dataset.video = v;
    b.addEventListener('click', () => { this.d.seen(videoKey(v)); this.d.openVideo(v); this.render(); });
    this.withFileMenu(b, v);
    return b;
  }

  private withFileMenu(b: HTMLElement, rel: string): void {
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); this.d.fileMenu(rel, e.clientX, e.clientY); });
  }

  /** Videos nach Ordnern. Bei nur einem Ordner ohne Köpfe wie bisher. */
  private videoRows(videos: string[]): HTMLElement[] {
    const dirs = new Map<string, string[]>();
    for (const v of videos) { const d = dirOf(v); const list = dirs.get(d); if (list) list.push(v); else dirs.set(d, [v]); }
    if (dirs.size === 1) return videos.map((v) => this.videoRow(v, true));
    const closed = new Set(this.d.closedDirs());
    const rows: HTMLElement[] = [];
    for (const [dir, list] of [...dirs].sort(([a], [b]) => a.localeCompare(b))) {
      const open = !closed.has(dir);
      const anyNew = !open && list.some((v) => this.d.isNew(videoKey(v)));
      const head = el('button', { className: 'al-dir', title: `${dir || 'Project folder'}: ${open ? 'collapse' : 'expand'}` },
        el('span', { className: 'chev' }, icon(open ? 'down' : 'right', 12, 2.2)), icon('folder', 14), el('span', { textContent: `${dir || '.'}/` }),
        anyNew ? el('span', { className: 'tag acc', textContent: 'new' }) : null, el('span', { className: 'cnt', textContent: String(list.length) }));
      head.dataset.dir = dir;
      head.setAttribute('aria-expanded', String(open));
      head.addEventListener('click', () => {
        if (open) closed.add(dir); else closed.delete(dir);
        this.d.setClosedDirs([...closed]);
        this.render();
      });
      rows.push(head);
      if (open) rows.push(...list.map((v) => this.videoRow(v, false)));
    }
    return rows;
  }

  private renderList(): void {
    const { animations, errors } = this.d.tool.entries;
    const cur = this.d.tool.currentId;
    const rows: HTMLElement[] = animations.map((a) => {
      const meta = el('div', { className: 'm' }, `${a.parts} moving part${a.parts === 1 ? '' : 's'}`);
      if (a.stale) meta.append(' · ', el('span', { className: 'w', textContent: 'older than the code' }));
      if (this.d.isNew(animKey(a))) meta.append(' ', el('span', { className: 'tag acc', textContent: 'new' }));
      const b = el('button', { className: 'al-row ic3' + (a.id === cur ? ' cur' : ''), title: `${a.name}\n${a.file}` },
        el('span', { className: 'ic' }, icon('anim', 16)), el('div', {}, el('div', { className: 't', textContent: a.name }), meta),
        el('div', { className: 'v' }, el('span', { textContent: `${a.duration.toFixed(1)} s` })));
      b.dataset.id = a.id;
      b.addEventListener('click', () => { this.mode = 'report'; this.d.seen(animKey(a)); this.d.tool.show(a.id); this.render(); });
      return b;
    });
    for (const e of errors) rows.push(el('div', { className: 'al-err' }, icon('alert', 14, 2), el('span', { textContent: `${e.file}${e.line ? `, line ${e.line}` : ''}: ${e.message}` })));
    if (!animations.length && !errors.length) rows.push(el('div', { className: 'al-empty', textContent: 'No animations yet.' }));
    const videos = this.d.videos();
    if (videos.length) {
      // Mit Ordnerköpfen steht der Ordner schon darunter
      const oneDir = new Set(videos.map(dirOf)).size === 1;
      rows.push(el('div', { className: 'al-sh' }, 'VIDEOS ', el('span', { className: 'cnt', textContent: String(videos.length) }), oneDir ? el('span', { className: 'r', textContent: `${dirOf(videos[0]) || '.'}/` }) : null));
      rows.push(...this.videoRows(videos));
    }
    this.ui.rows.replaceChildren(...rows, el('div', { className: 'al-note' },
      'The agent creates animations in ', el('code', { textContent: 'animations/' }), ' and videos with ', el('code', { textContent: 'soma render' }),
      ' (skill “Animation and video”). A video opens in the player, right-click it to rename, delete or find it in the files.'));
  }

  private renderReport(): void {
    const s = this.d.tool.shown!;
    const { entry, data } = s;
    this.d.seen(animKey(entry));
    const tool = this.d.tool;
    this.ui.video.disabled = tool.isRendering;
    this.ui.code.title = `Open ${entry.file}${entry.line ? `, line ${entry.line}` : ''}`;
    const meta = el('div', { className: 'cx-meta' }, `Animation · ${data.duration.toFixed(1)} s · ${entry.parts} part${entry.parts === 1 ? '' : 's'} move`);
    const kids: HTMLElement[] = [el('div', { className: 'cx-head' }, el('h3', { className: 'cx-title', textContent: entry.name }), meta)];
    const hint = tool.hint();
    if (hint) kids.push(el('div', { className: 'cx-line' + (hint.warn ? '' : ' info') }, icon(hint.warn ? 'alert' : 'info', 14, 2), el('span', { textContent: hint.text })));
    kids.push(el('div', { className: 'cx-gap' }));
    const steps = stepsOf(data);
    const sec = el('section', { className: 'cx-sec' }, el('div', { className: 'cx-sh' }, 'STEPS', el('span', { className: 'r', textContent: stepsSource(data) })));
    if (steps.length) {
      sec.append(...steps.map((x) => {
        const b = el('button', { className: 'cx-seq', title: `Jump to ${x.start.toFixed(1)} s` }, el('span', { className: 't', textContent: `${x.start.toFixed(1)} s` }), el('span', { textContent: x.text }));
        b.addEventListener('click', () => tool.jump(x.start));
        return b;
      }));
    } else sec.append(el('div', { className: 'cx-empty', textContent: 'The animation has no steps or subtitles. Play it in the bar below the image.' }));
    kids.push(sec);
    // Videos dieser Animation: „Make video“ schreibt renders/<id>.mp4, der Agent nennt seine meist ähnlich
    const mine = this.d.videos().filter((v) => base(v).toLowerCase().startsWith(entry.id.toLowerCase()));
    const vids = el('section', { className: 'cx-sec' }, el('div', { className: 'cx-sh' }, 'VIDEOS ', el('span', { className: 'cnt', textContent: String(mine.length) }), el('span', { className: 'r', textContent: 'renders/' })));
    if (mine.length) vids.append(...mine.map((v) => {
      const b = el('button', { className: 'cx-file', title: `${v}: open in the player` }, icon('f-video', 15), el('span', { textContent: base(v) }), el('span', { className: 's' }));
      b.addEventListener('click', () => { this.d.seen(videoKey(v)); this.d.openVideo(v); });
      this.withFileMenu(b, v);
      return b;
    }));
    else vids.append(el('div', { className: 'cx-empty', textContent: 'No video yet. “Make video” writes one to renders/.' }));
    kids.push(vids);
    this.ui.body.replaceChildren(...kids);
    this.tick();
  }

  /** Prüfhilfe. */
  state() {
    return {
      mode: this.ui.report.hidden ? 'list' : 'report',
      list: [...this.ui.rows.querySelectorAll<HTMLElement>('.al-row')].map((x) => ({ id: x.dataset.id ?? null, text: x.textContent, cur: x.classList.contains('cur'), isNew: !!x.querySelector('.tag') })),
      title: this.ui.body.querySelector('.cx-title')?.textContent ?? null, meta: this.ui.body.querySelector('.cx-meta')?.textContent ?? null,
      hint: this.ui.body.querySelector('.cx-line')?.textContent ?? null,
      steps: [...this.ui.body.querySelectorAll<HTMLElement>('.cx-seq')].map((x) => ({ text: x.textContent, cur: x.classList.contains('cur') })),
      videos: [...this.ui.body.querySelectorAll<HTMLElement>('.cx-file')].map((x) => x.textContent),
      dirs: [...this.ui.rows.querySelectorAll<HTMLElement>('.al-dir')].map((x) => ({ dir: x.dataset.dir ?? '', open: x.getAttribute('aria-expanded') === 'true' })),
      listVideos: [...this.ui.rows.querySelectorAll<HTMLElement>('.al-row[data-video]')].map((x) => x.dataset.video ?? ''),
    };
  }
}
