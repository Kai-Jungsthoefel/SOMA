import type { ResultMeta } from '../shared/types';

// Texte über dem 3D-Bild (E58): Untertitel, Titelkarten und Beschriftungen von Animationen, die Legende eines Ergebnisses
// und der Zeitstempel einer Übersicht. Gezeichnet auf einer 2D-Fläche, im Viewer wie im Video gleich: Was der Nutzer sieht,
// steht so auch im Bild für den Agenten.

export interface OverlayContent {
  caption?: string | null;
  title?: { text: string; subtitle?: string } | null;
  /** Beschriftungen mit Bildpunkt (null: hinter der Kamera oder außerhalb). */
  labels?: { text: string; x: number; y: number }[];
  stamp?: string | null;
  legend?: ResultMeta | null;
  /** Zusatzzeile unter der Legende, etwa die Überhöhung der Verformung (FEM). */
  legendNote?: string | null;
  /** Untertitel so weit über dem unteren Rand (Pixel), im Viewer über der Karte der Animation. */
  captionLift?: number;
}

const FONT = '"IBM Plex Sans", "Segoe UI", system-ui, sans-serif';

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Zeilen umbrechen, damit lange Untertitel nicht aus dem Bild laufen. */
function wrap(g: CanvasRenderingContext2D, text: string, max: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (g.measureText(next).width > max && cur) { lines.push(cur); cur = w; } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 4);
}

/** Zeichnet alles in eine Fläche der Größe w x h (Pixel). Die Schriftgröße folgt der Bildhöhe. */
export function paintOverlay(g: CanvasRenderingContext2D, w: number, h: number, c: OverlayContent): void {
  const unit = Math.max(10, Math.min(w, h * 1.6) / 60);
  g.save();
  g.textBaseline = 'middle';

  for (const l of c.labels ?? []) {
    g.font = `500 ${Math.round(unit * 0.95)}px ${FONT}`;
    const pad = unit * 0.45, tw = g.measureText(l.text).width;
    const bx = l.x + unit * 1.2, by = l.y - unit * 2.4, bw = tw + pad * 2, bh = unit * 1.7;
    g.strokeStyle = 'rgba(230,232,235,.85)';
    g.lineWidth = Math.max(1, unit * 0.09);
    g.beginPath(); g.moveTo(l.x, l.y); g.lineTo(bx, by + bh / 2); g.stroke();
    g.fillStyle = '#e6e8eb';
    g.beginPath(); g.arc(l.x, l.y, unit * 0.28, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(18,20,23,.86)';
    roundRect(g, bx, by, bw, bh, unit * 0.35); g.fill();
    g.fillStyle = '#e6e8eb';
    g.fillText(l.text, bx + pad, by + bh / 2);
  }

  if (c.caption) {
    g.font = `500 ${Math.round(unit * 1.25)}px ${FONT}`;
    const lines = wrap(g, c.caption, w * 0.8);
    const lh = unit * 1.7, pad = unit * 0.8;
    const bw = Math.max(...lines.map((s) => g.measureText(s).width)) + pad * 2, bh = lines.length * lh + pad;
    const bx = (w - bw) / 2, by = h - bh - Math.max(unit * 1.6, c.captionLift ?? 0);
    g.fillStyle = 'rgba(12,13,16,.78)';
    roundRect(g, bx, by, bw, bh, unit * 0.4); g.fill();
    g.fillStyle = '#f4f5f6';
    g.textAlign = 'center';
    lines.forEach((s, i) => g.fillText(s, w / 2, by + pad / 2 + lh * (i + 0.5)));
    g.textAlign = 'left';
  }

  if (c.title) {
    g.fillStyle = 'rgba(12,13,16,.62)';
    g.fillRect(0, 0, w, h);
    g.textAlign = 'center';
    g.fillStyle = '#f4f5f6';
    g.font = `600 ${Math.round(unit * 2.6)}px ${FONT}`;
    const lines = wrap(g, c.title.text, w * 0.85);
    const lh = unit * 3.3;
    const top = h / 2 - (lines.length * lh) / 2 - (c.title.subtitle ? unit : 0);
    lines.forEach((s, i) => g.fillText(s, w / 2, top + lh * (i + 0.5)));
    if (c.title.subtitle) {
      g.fillStyle = '#a3acb6';
      g.font = `500 ${Math.round(unit * 1.3)}px ${FONT}`;
      g.fillText(c.title.subtitle, w / 2, top + lh * lines.length + unit * 1.1);
    }
    g.textAlign = 'left';
  }

  if (c.stamp) {
    g.font = `600 ${Math.round(unit * 1.15)}px ${FONT}`;
    const pad = unit * 0.5, tw = g.measureText(c.stamp).width;
    g.fillStyle = 'rgba(12,13,16,.8)';
    roundRect(g, unit * 0.6, unit * 0.6, tw + pad * 2, unit * 1.8, unit * 0.3); g.fill();
    g.fillStyle = '#f4f5f6';
    g.fillText(c.stamp, unit * 0.6 + pad, unit * 1.5);
  }

  if (c.legend) paintLegend(g, w, h, unit, c.legend, c.legendNote ?? null);
  g.restore();
}

// Farben mit fester Bedeutung (wie --ok, --warn, --err in style.css): Grün unkritisch, Gelb nahe am Grenzwert, Rot kritisch.
// Weit im unkritischen Bereich verblasst das Grün zu Grau, Berührung (Abstand 0) ist Blaugrau.
const OK = [0x5c, 0xc9, 0x8b], WARN = [0xe8, 0xc5, 0x47], ERR = [0xf0, 0x74, 0x70], DEEP = [0xa8, 0x2c, 0x2c], FAR = [0x9a, 0xa4, 0xae], NEUTRAL = [0x6f, 0x8f, 0xb8];
const mix = (a: number[], b: number[], t: number) => a.map((v, i) => v + (b[i] - v) * Math.max(0, Math.min(1, t)));

/**
 * Farbe eines Werts (RGB 0..255): kritisch rot (tiefer, je weiter), im Übergang gelb, sonst grün bis grau. Mit `ramp` (selbst
 * gewählte Spanne) läuft die Farbe gleichmäßig über die Spanne von Grau (gute Seite) bis Rot (schlechte Seite), unabhängig vom
 * Grenzwert: So zeigt auch ein sicheres Teil, wo es belastet ist.
 */
export function resultColor(v: number, m: Pick<ResultMeta, 'bad' | 'threshold' | 'range' | 'neutral'> & { ramp?: boolean }): number[] {
  if (m.neutral && v >= m.neutral[0] && v <= m.neutral[1]) return NEUTRAL;
  const [lo, hi] = m.range;
  if (m.ramp) {
    const t = (v - lo) / (hi - lo || 1);
    const b = m.bad === 'low' ? 1 - t : t; // 0 gut, 1 schlecht
    return b < 1 / 3 ? mix(FAR, OK, b * 3) : b < 2 / 3 ? mix(OK, WARN, b * 3 - 1) : mix(WARN, ERR, b * 3 - 2);
  }
  // Abstand vom Grenzwert in Richtung „gut“ (positiv) bzw. „schlecht“ (negativ), auf die Spanne bezogen
  const good = m.bad === 'low' ? v - m.threshold : m.threshold - v;
  const spanGood = Math.max(1e-9, m.bad === 'low' ? hi - m.threshold : m.threshold - lo);
  const spanBad = Math.max(1e-9, m.bad === 'low' ? m.threshold - lo : hi - m.threshold);
  if (good < 0) return mix(ERR, DEEP, -good / spanBad);
  const f = good / spanGood;
  if (f < 0.15) return mix(WARN, OK, f / 0.15);
  return mix(OK, FAR, (f - 0.15) / 0.85);
}

const fmt = (v: number, unit: string) => `${(+v.toFixed(unit === '°' ? 1 : 2)).toLocaleString('en-US')}${unit === '°' ? '°' : unit ? ` ${unit}` : ''}`;

/** Legende unten rechts: Farbverlauf über die Spanne, Grenzwert markiert. */
function paintLegend(g: CanvasRenderingContext2D, w: number, h: number, unit: number, m: ResultMeta, note: string | null): void {
  const bw = Math.min(w * 0.36, unit * 22), bh = unit * 0.9, pad = unit * 0.8;
  const boxW = bw + pad * 2, boxH = unit * (note ? 7.5 : 6.3);
  const x0 = w - boxW - unit, y0 = h - boxH - unit;
  g.fillStyle = 'rgba(18,20,23,.88)';
  roundRect(g, x0, y0, boxW, boxH, unit * 0.4); g.fill();
  g.fillStyle = '#e6e8eb';
  g.font = `600 ${Math.round(unit * 1.0)}px ${FONT}`;
  g.fillText(m.unit ? `${m.title} (${m.unit})` : `${m.title}: ${m.quantity}`, x0 + pad, y0 + unit * 1.3);
  const bx = x0 + pad, by = y0 + unit * 2.3;
  const [lo, hi] = m.range;
  for (let i = 0; i < bw; i++) {
    const c = resultColor(lo + (hi - lo) * (i / Math.max(1, bw - 1)), m);
    g.fillStyle = `rgb(${c.map(Math.round).join(',')})`;
    g.fillRect(bx + i, by, 1.5, bh);
  }
  const tx = bx + ((m.threshold - lo) / (hi - lo || 1)) * bw;
  g.fillStyle = '#f4f5f6';
  g.fillRect(tx - 1, by - unit * 0.3, 2, bh + unit * 0.6);
  g.font = `500 ${Math.round(unit * 0.85)}px ${FONT}`;
  g.fillStyle = '#a3acb6';
  g.fillText(fmt(lo, m.unit), bx, by + bh + unit * 1.0);
  g.textAlign = 'right';
  g.fillText(fmt(hi, m.unit), bx + bw, by + bh + unit * 1.0);
  g.textAlign = 'center';
  g.fillStyle = '#e6e8eb';
  g.fillText(`Limit ${fmt(m.threshold, m.unit)}`, Math.min(Math.max(tx, bx + unit * 3), bx + bw - unit * 3), by + bh + unit * 2.1);
  g.textAlign = 'left';
  if (note) {
    g.fillStyle = '#a3acb6';
    g.fillText(note, bx, by + bh + unit * 3.3);
  }
}
