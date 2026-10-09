import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSoma } from './build';
import { resolveInside } from './files';
import type { DxfBatch, DxfDrawing, DxfResult } from '../shared/types';

/** Größere Dateien liest ezdxf nur sehr langsam und die Geometrie sprengt den Speicher der Ansicht. */
const MAX_BYTES = 200 * 1024 * 1024;
let counter = 0;

/**
 * DXF für die Ansicht im Code-Panel (E80): `soma dxfview` zeichnet mit dem Zeichenmodul von ezdxf und schreibt Pfade
 * als JSON, hier werden daraus typisierte Felder (gehen günstig über IPC). `known` ist der Fingerabdruck des Stands, den
 * die Ansicht schon zeigt. Hat sich die Datei nicht geändert, wird nichts gezeichnet (Aufruf nach jeder Dateiänderung).
 */
export async function viewDxf(dir: string, rel: string, known?: string | null): Promise<DxfResult> {
  let file: string;
  try { file = resolveInside(dir, rel); } catch (e) { return { ok: false, error: errText(e) }; }
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return { ok: false, gone: true, error: `${rel} does not exist.` }; }
  if (!st.isFile()) return { ok: false, gone: true, error: `${rel} is not a file.` };
  // Vor dem Zeichnen genommen: Ändert sich die Datei währenddessen, zeichnet der nächste Abgleich neu
  const sig = `${st.size}:${st.mtimeMs}`;
  if (known === sig) return { ok: true, unchanged: true, sig };
  if (st.size > MAX_BYTES) {
    return { ok: false, sig, error: `${rel} is too large for the view (${(st.size / 1048576).toFixed(0)} MB, at most ${MAX_BYTES / 1048576} MB). Right-click it in the file tree: “Open with default app”.` };
  }
  const out = path.join(os.tmpdir(), `soma-dxf-${process.pid}-${++counter}.json`);
  try {
    const r = await runSoma(['dxfview', file, '--out', out], dir, 3 * 60 * 1000);
    let raw: RawResult;
    try { raw = JSON.parse(fs.readFileSync(out, 'utf8')) as RawResult; } catch {
      const why = r.err.trim().split(/\r?\n/).filter(Boolean).pop();
      return { ok: false, sig, error: `The DXF could not be read${why ? `: ${why}` : '. Python stopped without a message.'}` };
    }
    if (!raw.ok) return { ok: false, sig, error: String(raw.error ?? 'The DXF could not be read.') };
    return { ok: true, sig, drawing: toDrawing(raw) };
  } finally {
    fs.rmSync(out, { force: true });
  }
}

interface RawResult extends Omit<DxfDrawing, 'batches'> {
  ok: boolean;
  error?: string;
  batches: (Omit<DxfBatch, 'ops' | 'xy'> & { ops?: number[]; xy: number[] })[];
}

/** JSON-Zahlenlisten in typisierte Felder. Koordinaten sind relativ zur Mitte und gerundet, 32 Bit reichen. */
function toDrawing(r: RawResult): DxfDrawing {
  return {
    units: r.units ?? null, layout: r.layout ?? null, origin: r.origin, box: r.box ?? null, layers: r.layers ?? [],
    skipped: r.skipped ?? {}, issues: r.issues ?? 0, truncated: !!r.truncated, entities: r.entities ?? 0,
    batches: (r.batches ?? []).map((b) => ({
      kind: b.kind, layer: b.layer, color: b.color, lw: b.lw, ops: Uint8Array.from(b.ops ?? []), xy: Float32Array.from(b.xy ?? []),
    })),
  };
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
