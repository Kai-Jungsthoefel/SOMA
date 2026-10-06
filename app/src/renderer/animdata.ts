import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Animation aus .soma/anim/<id>.glb (E58, geschrieben von `soma anim build`): je bewegtem Bauteil ein Knoten mit Lage und
// Drehung über die Zeit, dazu Kamera und Zielpunkt. Texte, Hervorhebungen und der Ablauf stehen in extras.soma_animation.
// Viewer und Render-Fenster werten sie gleich aus, damit das Video aussieht wie die Ansicht.

export interface AnimSpan { start: number; end: number }
export interface AnimMeta {
  version: number; id: string; name: string; file: string; line: number; duration: number; fps: number; fov: number;
  /** Die Animation legt keine Kamera fest (dann Standardansicht, im Viewer bleibt die Kamera frei). */
  cameraAuto: boolean;
  parts: string[];
  captions: (AnimSpan & { text: string })[];
  titles: (AnimSpan & { text: string; subtitle?: string })[];
  /** `at`: Punkt in der Lage im Modell, `part`: Bauteil, mit dem die Beschriftung wandert. */
  labels: (AnimSpan & { text: string; part: string | null; at: number[] })[];
  /** Zeitspannen je Bauteilname. */
  states: { highlight: Record<string, number[][]>; hidden: Record<string, number[][]>; ghost: Record<string, number[][]> };
  steps: (AnimSpan & { text: string })[];
}

/** Zustand zu einem Zeitpunkt. Lagen und Zustände nach Bauteilname. */
export interface AnimFrame {
  t: number;
  poses: Map<string, THREE.Matrix4>;
  camera: { position: THREE.Vector3; target: THREE.Vector3 };
  caption: string | null;
  title: { text: string; subtitle?: string } | null;
  labels: { text: string; at: THREE.Vector3 }[];
  hidden: Set<string>; ghost: Set<string>; highlight: Set<string>;
}

type Track = { evaluate(t: number): ArrayLike<number> };

export class AnimData {
  private constructor(
    readonly meta: AnimMeta,
    private readonly tracks: Map<string, { pos: Track; rot: Track }>,
    private readonly cam: { pos: Track; target: Track },
  ) {}

  static async parse(glb: ArrayBuffer): Promise<AnimData> {
    const gltf = await new GLTFLoader().parseAsync(glb, '');
    const meta = (gltf.parser.json as { extras?: { soma_animation?: AnimMeta } }).extras?.soma_animation;
    if (!meta || meta.version !== 1) throw new Error('Keine Animation von soma (extras.soma_animation fehlt)');
    const clip = gltf.animations[0];
    if (!clip) throw new Error('Die Datei enthält keine Bewegung');
    // three.js benennt Knoten um (ohne Punkte, Doppelpunkte, Leerzeichen): Die Spuren heißen wie der Knoten, der echte
    // Bauteilname steht in seinen extras
    const byNode = new Map<string, { part?: string; camera?: boolean; target?: boolean }>();
    gltf.scene.traverse((o) => {
      const s = (o.userData as { soma?: { part?: string; camera?: boolean; cameraTarget?: boolean } }).soma;
      if (s) byNode.set(o.name, { part: s.part, camera: s.camera, target: s.cameraTarget });
    });
    // Drehungen sphärisch, Lagen geradlinig zwischen den Abtastzeiten (wie glTF LINEAR)
    const interp = (tr: THREE.KeyframeTrack): Track => {
      const i = tr instanceof THREE.QuaternionKeyframeTrack
        ? new THREE.QuaternionLinearInterpolant(tr.times, tr.values, tr.getValueSize())
        : new THREE.LinearInterpolant(tr.times, tr.values, tr.getValueSize());
      return { evaluate: (t) => i.evaluate(t) };
    };
    const tracks = new Map<string, { pos: Track; rot: Track }>();
    const cam: Partial<{ pos: Track; target: Track }> = {};
    const pending = new Map<string, Partial<{ pos: Track; rot: Track }>>();
    for (const tr of clip.tracks) {
      const dot = tr.name.lastIndexOf('.');
      const node = tr.name.slice(0, dot), prop = tr.name.slice(dot + 1);
      const info = byNode.get(node);
      if (!info) continue;
      if (info.camera && prop === 'position') cam.pos = interp(tr);
      else if (info.target && prop === 'position') cam.target = interp(tr);
      else if (info.part) {
        const e = pending.get(info.part) ?? {};
        if (prop === 'position') e.pos = interp(tr);
        if (prop === 'quaternion') e.rot = interp(tr);
        pending.set(info.part, e);
      }
    }
    for (const [name, e] of pending) if (e.pos && e.rot) tracks.set(name, { pos: e.pos, rot: e.rot });
    if (!cam.pos || !cam.target) throw new Error('Die Animation hat keine Kamera');
    return new AnimData(meta, tracks, { pos: cam.pos, target: cam.target });
  }

  get duration(): number { return this.meta.duration; }

  frame(time: number): AnimFrame {
    const t = Math.max(0, Math.min(this.meta.duration, time));
    const poses = new Map<string, THREE.Matrix4>();
    for (const [name, tr] of this.tracks) {
      const p = tr.pos.evaluate(t), q = tr.rot.evaluate(t);
      poses.set(name, new THREE.Matrix4().compose(new THREE.Vector3(p[0], p[1], p[2]), new THREE.Quaternion(q[0], q[1], q[2], q[3]).normalize(), new THREE.Vector3(1, 1, 1)));
    }
    const cp = this.cam.pos.evaluate(t), ct = this.cam.target.evaluate(t);
    const inSpan = (s: AnimSpan) => t >= s.start && (t < s.end || (t === s.end && s.end >= this.meta.duration));
    const caption = this.meta.captions.find(inSpan)?.text ?? null;
    const title = this.meta.titles.find(inSpan) ?? null;
    const labels = this.meta.labels.filter(inSpan).map((l) => {
      const at = new THREE.Vector3(l.at[0], l.at[1], l.at[2]);
      const m = l.part ? poses.get(l.part) : undefined;
      return { text: l.text, at: m ? at.applyMatrix4(m) : at };
    });
    const set = (rec: Record<string, number[][]>) => new Set(Object.entries(rec).filter(([, spans]) => spans.some(([a, b]) => t >= a && (t < b || b >= this.meta.duration))).map(([n]) => n));
    return {
      t, poses, caption, labels,
      title: title ? { text: title.text, subtitle: title.subtitle } : null,
      camera: { position: new THREE.Vector3(cp[0], cp[1], cp[2]), target: new THREE.Vector3(ct[0], ct[1], ct[2]) },
      hidden: set(this.meta.states.hidden), ghost: set(this.meta.states.ghost), highlight: set(this.meta.states.highlight),
    };
  }

  /** Untertitel als WebVTT (für Player außerhalb der App, im Video stehen sie ohnehin im Bild). */
  vtt(): string | null {
    if (!this.meta.captions.length) return null;
    const ts = (s: number) => {
      const ms = Math.round(s * 1000);
      const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, sec = Math.floor(ms / 1000) % 60, r = ms % 1000;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(r).padStart(3, '0')}`;
    };
    const cues = this.meta.captions.map((c, i) => `${i + 1}\n${ts(c.start)} --> ${ts(c.end)}\n${c.text.replace(/-->/g, '->')}`);
    return `WEBVTT\n\n${cues.join('\n\n')}\n`;
  }
}

/** Zeit für Anzeige und Agent: Sekunden mit zwei Stellen und Punkt (eindeutig für den Agenten). */
export const fmtTime = (t: number) => `${t.toFixed(2)} s`;
/** Zeitstempel im Video, wie Player ihn zeigen: mm:ss.cc */
export function videoStamp(t: number): string {
  const cs = Math.round(t * 100);
  return `${String(Math.floor(cs / 6000)).padStart(2, '0')}:${String(Math.floor(cs / 100) % 60).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}
