import { shownQty, type DisplayUnits } from '../shared/units';

/*
 * The units the user chose (Settings > Viewer > Units, E111) for everything that shows values of analyses, FEM and
 * drawings. main.ts sets them from the settings, the panels ask here instead of each keeping a copy.
 */
let current: DisplayUnits = 'mm';
export const prefUnits = (): DisplayUnits => current;
export function setPrefUnits(u: DisplayUnits): void { current = u; }

const fmt = (v: number, d: number) => (+v.toFixed(d) + 0).toLocaleString('en-US', { maximumFractionDigits: d }); // + 0: no "-0"

/** A value in SOMA's unit (mm, mm², MPa, N) as text in the user's units, with the unit: "0.0472 in", "2,900 psi". */
export function qty(v: number, unit: string, digits = 2): string {
  const s = shownQty(v, unit, current, digits);
  return `${fmt(s.v, s.digits)}${s.unit === '°' ? '°' : s.unit ? ` ${s.unit}` : ''}`;
}
/** The number alone, in the user's units. */
export function qtyNum(v: number, unit: string, digits = 2): string {
  const s = shownQty(v, unit, current, digits);
  return fmt(s.v, s.digits);
}
/** The unit label in the user's units ("mm" -> "in", "MPa" -> "psi"). */
export const qtyUnit = (unit: string) => shownQty(0, unit, current).unit;
/** The value as a number in the user's units (legend ticks, custom range). */
export const qtyValue = (v: number, unit: string) => shownQty(v, unit, current).v;

/**
 * For the agent: SOMA's value with its unit, and the user's in brackets when they differ. The agent works in mm and
 * MPa, the brackets let it answer in the user's units. Dots as decimal separators, no grouping.
 */
export function agentQty(v: number, unit: string, digits = 2): string {
  const own = `${(Math.abs(v) < 10 ** -digits / 2 ? 0 : v).toFixed(digits)}${unit === '°' ? '°' : unit ? ` ${unit}` : ''}`;
  const s = shownQty(v, unit, current, digits);
  return s.unit === unit ? own : `${own} (${s.v.toFixed(s.digits)} ${s.unit})`;
}
