import { BufferTarget, canEncodeVideo, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH } from 'mediabunny';
import * as THREE from 'three';
import type { RenderJob, RenderOutput, ResultMeta } from '../shared/types';
import { AnimData, fmtTime } from './animdata';
import { paintOverlay } from './overlay';
import { ResultLayer } from './resultview';
import { Viewer, type ViewName } from './viewer';

// Unsichtbares Render-Fenster (E58): Bilder, Übersichten und Videos für `soma render` und die Knöpfe der App. Derselbe Viewer
// wie auf dem Bildschirm, mit festen Maßen und einem Bildpunkt je Pixel. Gerendert wird Bild für Bild, nicht in Echtzeit.

const api = window.somaRender;
const viewer = new Viewer(document.getElementById('stage')!, { pixelRatio: 1 });
const results = new ResultLayer(viewer);

/** Kamera des Auftrags: Richtung, eingepasste Teile und Zoom. `forced`: gilt auch statt der Kamera einer Animation. */
interface Look { dir: THREE.Vector3 | null; view: ViewName; fit: string[] | undefined; zoom: number; forced: boolean }
interface Scene { anim: AnimData | null; legend: ResultMeta | null; ids: Map<string, string>; look: Look }

/**
 * Namen aus `--hide`, `--only` und `--fit` in Bauteil-IDs: Teilname, Gruppe ("Gehäuse", "Gehäuse/Schrauben", mit allem
 * darunter) oder Teil mit Gruppe ("Gehäuse/Deckel"), wie in den Animationen. Unbekanntes ist ein Fehler mit den Namen.
 */
function resolveNames(specs: string[], what: string): string[] {
  const parts = viewer.partList();
  const out = new Set<string>();
  for (const raw of specs) {
    const spec = raw.trim().replace(/^\/+|\/+$/g, '');
    let hit = parts.filter((p) => p.name === raw.trim());
    if (!hit.length) hit = parts.filter((p) => p.group && (p.group === spec || p.group.startsWith(`${spec}/`)));
    if (!hit.length) {
      const i = spec.lastIndexOf('/');
      if (i > 0) hit = parts.filter((p) => p.name === spec.slice(i + 1) && p.group === spec.slice(0, i));
    }
    if (!hit.length) {
      const names = parts.slice(0, 30).map((p) => `'${p.name}'`).join(', ') + (parts.length > 30 ? ' ...' : '');
      const groups = [...new Set(parts.flatMap((p) => (p.group ?? '').split('/').map((_, k, a) => a.slice(0, k + 1).join('/')).filter(Boolean)))].sort();
      throw new Error(`${what} '${raw}' does not exist in the model. Parts: ${names}.${groups.length ? ` Groups: ${groups.map((g) => `'${g}'`).join(', ')}.` : ''}`);
    }
    for (const p of hit) out.add(p.id);
  }
  return [...out];
}

async function prepare(job: RenderJob): Promise<Scene> {
  results.hide();
  viewer.setPoses(null);
  viewer.setAnimState(null);
  viewer.setPainter(null);
  viewer.clear();
  viewer.resizeTo(job.width, job.height);
  await viewer.load(job.model);
  // Schrift erst laden lassen, sonst stehen im ersten Bild Ersatzschriften
  await Promise.all(['500 20px "IBM Plex Sans"', '600 20px "IBM Plex Sans"'].map((f) => document.fonts.load(f).catch(() => [])));
  const legend = job.result ? await results.show(job.result) : null;
  const anim = job.anim ? await AnimData.parse(job.anim) : null;
  const ids = new Map(viewer.partList().map((p) => [p.name, p.id]));
  // Ausblenden gilt zusätzlich zu dem, was eine Animation ausblendet. Eingepasst wird auf das Sichtbare
  if (job.only.length) viewer.isolate(resolveNames(job.only, '--only'));
  if (job.hide.length) viewer.setVisible(resolveNames(job.hide, '--hide'), false);
  const fit = job.fit.length ? resolveNames(job.fit, '--fit') : undefined;
  const look: Look = {
    dir: job.dir ? new THREE.Vector3(...job.dir) : null, view: (job.view as ViewName | null) ?? 'iso', fit, zoom: job.zoom,
    forced: !!job.view || !!job.dir || !!fit || job.zoom !== 1,
  };
  return { anim, legend, ids, look };
}

/** Stand zur Zeit t (ohne Animation: die gewählte Ansicht) und ein Bild davon. */
function frame(s: Scene, t: number, stamp: string | null, forceView: boolean): HTMLCanvasElement {
  // FEM: Das Bild zeigt die Verformung überhöht (wie der Viewer beim Öffnen), die Legende sagt, wie stark
  let content: Parameters<typeof paintOverlay>[3] = { legend: s.legend, legendNote: s.legend ? results.deformNote() : null, stamp };
  let labels: { text: string; at: THREE.Vector3 }[] = [];
  if (s.anim) {
    const f = s.anim.frame(t);
    const byId = (names: Iterable<string>) => new Set([...names].map((n) => s.ids.get(n)).filter((x): x is string => !!x));
    const poses = new Map<string, THREE.Matrix4>();
    for (const [n, m] of f.poses) { const id = s.ids.get(n); if (id) poses.set(id, m); }
    viewer.setPoses(poses);
    viewer.setAnimState({ hidden: byId(f.hidden), ghost: byId(f.ghost), highlight: byId(f.highlight) });
    if (forceView) place(s.look);
    else viewer.setCamera(f.camera.position, f.camera.target);
    content = { ...content, caption: f.caption, title: f.title };
    labels = f.labels;
  } else place(s.look);
  viewer.setPainter((g, w, h, project) => paintOverlay(g, w, h, {
    ...content, labels: labels.map((l) => ({ text: l.text, p: project(l.at) })).filter((l) => l.p).map((l) => ({ text: l.text, x: l.p!.x, y: l.p!.y })),
  }));
  return viewer.snapshot();
}

const VIEW_DIRS: Record<string, [number, number, number]> = {
  iso: [0.8, -1.2, 0.9], front: [0, -1, 0], back: [0, 1, 0], top: [0, 0, 1], bottom: [0, 0, -1], right: [1, 0, 0], left: [-1, 0, 0],
};
function place(l: Look): void {
  viewer.viewFrom(l.dir ?? new THREE.Vector3(...(VIEW_DIRS[l.view] ?? VIEW_DIRS.iso)), l.fit, l.zoom);
}

function png(c: HTMLCanvasElement): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? b.arrayBuffer().then(resolve, reject) : reject(new Error('Could not create the PNG'))), 'image/png'));
}

/** Übersicht: Standbilder gleichmäßig über die Dauer, je mit Zeit, oben Name und Dauer der Animation. */
async function sheet(s: Scene, job: RenderJob, cols: number, rows: number): Promise<ArrayBuffer> {
  const anim = s.anim!;
  const n = cols * rows, cw = job.width, ch = job.height, gap = 6, head = Math.round(Math.max(28, ch * 0.12));
  const c = document.createElement('canvas');
  c.width = cols * cw + (cols + 1) * gap;
  c.height = head + rows * ch + (rows + 1) * gap;
  const g = c.getContext('2d')!;
  g.fillStyle = '#121417';
  g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#e6e8eb';
  g.font = `600 ${Math.round(head * 0.45)}px "IBM Plex Sans", "Segoe UI", sans-serif`;
  g.textBaseline = 'middle';
  g.fillText(`${anim.meta.name} · ${fmtTime(anim.duration)} · ${n} stills`, gap * 2, head / 2 + gap / 2);
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : (anim.duration * i) / (n - 1);
    const img = frame(s, t, fmtTime(t), s.look.forced);
    g.drawImage(img, gap + (i % cols) * (cw + gap), head + gap + Math.floor(i / cols) * (ch + gap), cw, ch);
  }
  return png(c);
}

async function video(s: Scene, job: RenderJob, progress: (f: number) => void): Promise<{ mp4: ArrayBuffer; warnings: string[] }> {
  const anim = s.anim!;
  const warnings: string[] = [];
  const c = document.createElement('canvas');
  c.width = job.width;
  c.height = job.height;
  const g = c.getContext('2d')!;
  let codec: 'avc' | 'vp9' = 'avc';
  if (!(await canEncodeVideo('avc', { width: c.width, height: c.height }))) {
    codec = 'vp9';
    warnings.push('This computer cannot encode H.264, the video is VP9 (plays in the app and in browsers, not in every player).');
  }
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const source = new CanvasSource(c, { codec, bitrate: QUALITY_HIGH, keyFrameInterval: 1 });
  output.addVideoTrack(source, { frameRate: job.fps });
  await output.start();
  const n = Math.max(1, Math.round(anim.duration * job.fps)) + 1;
  for (let i = 0; i < n; i++) {
    const t = Math.min(anim.duration, i / job.fps);
    g.drawImage(frame(s, t, null, s.look.forced), 0, 0);
    await source.add(i / job.fps, 1 / job.fps);
    if (i % 10 === 0) progress(i / n);
  }
  await output.finalize();
  const buf = output.target.buffer;
  if (!buf) throw new Error('The video is empty.');
  return { mp4: buf, warnings };
}

async function run(job: RenderJob): Promise<RenderOutput> {
  const s = await prepare(job);
  const warnings: string[] = [];
  if (job.kind === 'still') {
    const t = s.anim ? Math.min(job.at, s.anim.duration) : 0;
    return { ok: true, png: await png(frame(s, t, null, s.look.forced)), warnings };
  }
  if (!s.anim) return { ok: false, error: 'A contact sheet or video needs an animation.' };
  if (job.kind === 'sheet') return { ok: true, png: await sheet(s, job, job.grid[0], job.grid[1]), warnings };
  const v = await video(s, job, (f) => api.progress(job.id, f * 0.9));
  // Übersicht zum Video, damit der Agent sieht, was darin steht (Videos kann er nicht ansehen)
  const cw = 480, ch = Math.round(480 * job.height / job.width);
  const sh = await sheet(s, { ...job, width: cw, height: ch }, 3, 3);
  api.progress(job.id, 1);
  return { ok: true, mp4: v.mp4, vtt: s.anim.vtt(), sheet: sh, warnings: [...warnings, ...v.warnings] };
}

let busy: Promise<void> = Promise.resolve();
api.onJob((job) => {
  busy = busy.then(async () => {
    let out: RenderOutput;
    try { out = await run(job); } catch (e) { out = { ok: false, error: e instanceof Error ? e.message : String(e) }; }
    api.done(job.id, out);
  });
});
api.ready();
