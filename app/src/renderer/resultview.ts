import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { ResultMeta } from '../shared/types';
import { resultColor } from './overlay';
import type { Viewer } from './viewer';

// Ergebnis einer Auswertung (E58, .soma/results/<name>.glb von `soma analyze`): je Bauteil ein Netz mit einem Wert je Dreieck
// (Attribut _VALUE) und seinen Kanten. Solange es angezeigt wird, tritt das Modell zurück. Der Schnitt gilt auch hier.

interface ResultMesh { mesh: THREE.Mesh; name: string; values: THREE.BufferAttribute }

export interface ResultProbe { name: string; value: number; point: number[] }

export class ResultLayer {
  meta: ResultMeta | null = null;
  private group: THREE.Object3D | null = null;
  private meshes: ResultMesh[] = [];

  constructor(private readonly viewer: Viewer) {}

  get active(): boolean { return !!this.group; }

  async show(glb: ArrayBuffer): Promise<ResultMeta> {
    const gltf = await new GLTFLoader().parseAsync(glb, '');
    const meta = (gltf.parser.json as { extras?: { soma_result?: ResultMeta } }).extras?.soma_result;
    if (!meta || !Array.isArray(meta.range)) throw new Error('Kein Ergebnis von soma (extras.soma_result fehlt)');
    this.hide();
    const meshes: ResultMesh[] = [];
    gltf.scene.traverse((o) => {
      const name = (o.userData as { soma?: { name?: string } }).soma?.name;
      if (!name) return;
      o.traverse((c) => {
        const m = c as THREE.Mesh;
        if (m.isMesh) {
          const values = m.geometry.getAttribute('_value') as THREE.BufferAttribute | undefined;
          if (!values) return;
          m.material = new THREE.MeshStandardMaterial({
            vertexColors: true, side: THREE.DoubleSide, roughness: 0.75, metalness: 0,
            polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, clippingPlanes: this.viewer.clipPlanes,
          });
          meshes.push({ mesh: m, name, values });
        } else if ((c as THREE.LineSegments).isLineSegments) {
          const l = c as THREE.LineSegments;
          l.material = new THREE.LineBasicMaterial({ color: 0x1a1d22, clippingPlanes: this.viewer.clipPlanes });
        }
      });
    });
    this.meta = meta;
    this.meshes = meshes;
    this.group = gltf.scene;
    this.recolor();
    this.viewer.setModelHidden(true);
    this.viewer.addLayer(this.group);
    return meta;
  }

  /** Farben neu aus den Werten (etwa nach geänderter Spanne). */
  recolor(): void {
    if (!this.meta) return;
    const c = new THREE.Color();
    for (const m of this.meshes) {
      const n = m.values.count;
      const col = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const rgb = resultColor(m.values.getX(i), this.meta);
        c.setRGB(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255, THREE.SRGBColorSpace);
        col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
      }
      m.mesh.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
    }
    this.viewer.requestRender();
  }

  hide(): void {
    if (!this.group) return;
    this.viewer.removeLayer(this.group);
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose();
      (Array.isArray(m.material) ? m.material : m.material ? [m.material] : []).forEach((x) => x.dispose());
    });
    this.group = null;
    this.meshes = [];
    this.meta = null;
    this.viewer.setModelHidden(false);
  }

  /** Wert unter dem Zeiger: Bauteil, Wert des Dreiecks und der Punkt (mm). */
  probe(clientX: number, clientY: number): ResultProbe | null {
    if (!this.group) return null;
    const hit = this.viewer.pickObjects(clientX, clientY, this.meshes.map((m) => m.mesh));
    if (!hit || hit.face == null) return null;
    const m = this.meshes.find((x) => x.mesh === hit.object);
    if (!m) return null;
    return { name: m.name, value: m.values.getX(hit.face.a), point: hit.point.toArray().map((v) => +v.toFixed(2)) };
  }
}
