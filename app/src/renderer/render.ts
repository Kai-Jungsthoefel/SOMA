import { BufferTarget, canEncodeVideo, CanvasSource, Mp4OutputFormat, Output, QUALITY_HIGH } from 'mediabunny';
import type * as THREE from 'three';
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

interface Scene { anim: AnimData | null; legend: ResultMeta | null; ids: Map<string, string>; view: ViewName }

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
  return { anim, legend, ids, view: (job.view as ViewName | null) ?? 'iso' };
}

/** Stand zur Zeit t (ohne Animation: die gewählte Ansicht) und ein Bild davon. */
function frame(s: Scene, t: number, stamp: string | null, forceView: boolean): HTMLCanvasElement {
  let content: Parameters<typeof paintOverlay>[3] = { legend: s.legend, stamp };
  let labels: { text: string; at: THREE.Vector3 }[] = [];
  if (s.anim) {
    const f = s.anim.frame(t);
    const byId = (names: Iterable<string>) => new Set([...names].map((n) => s.ids.get(n)).filter((x): x is string => !!x));
    const poses = new Map<string, THREE.Matrix4>();
    for (const [n, m] of f.poses) { const id = s.ids.get(n); if (id) poses.set(id, m); }
    viewer.setPoses(poses);
    viewer.setAnimState({ hidden: byId(f.hidden), ghost: byId(f.ghost), highlight: byId(f.highlight) });
    if (forceView) viewer.setView(s.view);
    else viewer.setCamera(f.camera.position, f.camera.target);
    content = { ...content, caption: f.caption, title: f.title };
    labels = f.labels;
  } else viewer.setView(s.view);
  viewer.setPainter((g, w, h, project) => paintOverlay(g, w, h, {
    ...content, labels: labels.map((l) => ({ text: l.text, p: project(l.at) })).filter((l) => l.p).map((l) => ({ text: l.text, x: l.p!.x, y: l.p!.y })),
  }));
  return viewer.snapshot();
}

function png(c: HTMLCanvasElement): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => c.toBlob((b) => (b ? b.arrayBuffer().then(resolve, reject) : reject(new Error('PNG ließ sich nicht erzeugen'))), 'image/png'));
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
  g.fillText(`${anim.meta.name} · ${fmtTime(anim.duration)} · ${n} Standbilder`, gap * 2, head / 2 + gap / 2);
  for (let i = 0; i < n; i++) {
    const t = n === 1 ? 0 : (anim.duration * i) / (n - 1);
    const img = frame(s, t, fmtTime(t), !!job.view);
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
    warnings.push('H.264 lässt sich auf diesem Rechner nicht kodieren, das Video ist VP9 (spielt in der App und in Browsern, nicht in jedem Player).');
  }
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const source = new CanvasSource(c, { codec, bitrate: QUALITY_HIGH, keyFrameInterval: 1 });
  output.addVideoTrack(source, { frameRate: job.fps });
  await output.start();
  const n = Math.max(1, Math.round(anim.duration * job.fps)) + 1;
  for (let i = 0; i < n; i++) {
    const t = Math.min(anim.duration, i / job.fps);
    g.drawImage(frame(s, t, null, !!job.view), 0, 0);
    await source.add(i / job.fps, 1 / job.fps);
    if (i % 10 === 0) progress(i / n);
  }
  await output.finalize();
  const buf = output.target.buffer;
  if (!buf) throw new Error('Das Video ist leer.');
  return { mp4: buf, warnings };
}

async function run(job: RenderJob): Promise<RenderOutput> {
  const s = await prepare(job);
  const warnings: string[] = [];
  if (job.kind === 'still') {
    const t = s.anim ? Math.min(job.at, s.anim.duration) : 0;
    return { ok: true, png: await png(frame(s, t, null, !!job.view)), warnings };
  }
  if (!s.anim) return { ok: false, error: 'Übersicht und Video brauchen eine Animation.' };
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
