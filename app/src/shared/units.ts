/**
 * Lengths for people who work in inches (discussion #22, E111). The model stays in millimetres everywhere: geometry,
 * CadQuery, parameter values, STEP. The setting "Units" only changes what the viewer shows (measurements, selection,
 * section). Parameters keep the unit the agent gave them (an inch pipe in a metric model stays in inches).
 *
 * Number fields (parameters, section) take small calculations and units: "20 - 2.5", "1.5 in" in a mm field,
 * "1/4 in", "3 mm" in an inch field, mixed numbers in inches ("1-1/2"). Parsed by hand, never with eval: the text comes from the user, the units from the
 * project.
 */

export type DisplayUnits = 'mm' | 'in';
export const DISPLAY_UNITS: DisplayUnits[] = ['mm', 'in'];
export const DISPLAY_UNITS_LABEL: Record<DisplayUnits, string> = { mm: 'Millimetres (mm)', in: 'Inches (in)' };
export const isDisplayUnits = (v: unknown): v is DisplayUnits => v === 'mm' || v === 'in';

export const MM_PER_INCH = 25.4;

/** Length units a field or an input may name, in millimetres. */
const LENGTH: Record<string, number> = {
  mm: 1, cm: 10, m: 1000, µm: 0.001, um: 0.001,
  in: MM_PER_INCH, inch: MM_PER_INCH, inches: MM_PER_INCH, '"': MM_PER_INCH, '″': MM_PER_INCH,
  ft: 304.8, foot: 304.8, feet: 304.8, "'": 304.8, '′': 304.8,
};
/** Millimetres per unit, null when `unit` is not a length (deg, %, none). */
export const lengthScale = (unit: string | null | undefined): number | null => (unit ? LENGTH[unit.trim().toLowerCase()] ?? null : null);

/** Digits shown for inches: two more than for millimetres, an inch is 25 times larger. */
export const inchDigits = (mmDigits: number) => Math.min(6, mmDigits + 2);

export type EvalResult = { ok: true; value: number; units: boolean } | { ok: false; error: string };

/**
 * The value of a number field. `unit` is the field's unit: numbers without a unit are in it, a length named in the text
 * ("1.5 in") is converted to it. A unit applies to the number or the product before it: "1/4 in" is a quarter inch,
 * "2 x 3 mm" is 6 mm. `units` in the result: the text named one. Decimal comma is accepted where it cannot be a
 * separator between thousands.
 */
export function evalNumber(text: string, unit?: string | null): EvalResult {
  const field = lengthScale(unit);
  let s = text.trim().replace(/[−–]/g, '-').replace(/[×x](?=\s*[\d.(])/gi, '*').replace(/÷/g, '/');
  // "1,5" is 1.5, "1,000.5" is a thousands separator
  s = s.includes('.') ? s.replace(/(\d),(?=\d{3}\b)/g, '$1') : s.replace(/(\d),(\d)/g, '$1.$2');
  if (!s) return { ok: false, error: 'Enter a number.' };
  // Mixed numbers as written in the US: "1-1/2" and "1 1/2" are 1½, not 1 − ½ (fasteners.py reads them the same way).
  // Only for inches: in an inch field, or followed by an inch unit ("1-1/2 in" in a mm field). Elsewhere "20-1/2" stays
  // 19.5, as anyone who works in mm means it. With spaces, "20 - 1/2" is always a subtraction
  const mixed = field === MM_PER_INCH ? '' : '(?=\\s*(?:inch(?:es)?\\b|in\\b|["″]))';
  s = s.replace(new RegExp(`(?<![\\d.,/])(\\d+)(?:-|\\s+)(\\d+)\\/(\\d+)(?![\\d.])${mixed}`, 'g'), '($1+$2/$3)');
  const tokens: string[] = [];
  const re = /\s*(\d+(?:\.\d*)?(?:e[+-]?\d+)?|\.\d+(?:e[+-]?\d+)?|[+\-*/()]|[a-zµ]+|["″'′])/giy;
  let m: RegExpExecArray | null;
  let at = 0;
  while (at < s.length && (m = re.exec(s))) { tokens.push(m[1]); at = re.lastIndex; }
  if (s.slice(at).trim()) return { ok: false, error: `Cannot read “${s.slice(at).trim()}”.` };
  let i = 0;
  let named = false;
  const peek = () => tokens[i];
  const isUnit = (t: string | undefined) => t !== undefined && /^([a-zµ]+|["″'′])$/i.test(t);
  const fail = (error: string): never => { throw new Error(error); };

  // expr := term (('+'|'-') term)*   term := factor (('*'|'/') factor | unit)*   factor := ('-'|'+') factor | number | '(' expr ')'
  const factor = (): number => {
    const t = tokens[i++];
    if (t === undefined) return fail('The calculation ends too early.');
    if (t === '-') return -factor();
    if (t === '+') return factor();
    if (t === '(') {
      const v = expr();
      if (tokens[i++] !== ')') fail('A bracket is not closed.');
      return v;
    }
    const n = Number(t);
    if (!Number.isFinite(n)) fail(`Cannot read “${t}”.`);
    return n;
  };
  const term = (): number => {
    let v = factor();
    for (;;) {
      const t = peek();
      if (t === '*' || t === '/') {
        i++;
        const r = factor();
        if (t === '/' && r === 0) fail('Division by zero.');
        v = t === '*' ? v * r : v / r;
      } else if (isUnit(t)) {
        i++;
        const k = lengthScale(t);
        if (k === null) fail(`“${t}” is not a unit SOMA knows. Lengths: mm, cm, m, in, ft.`);
        if (field === null) fail(unit ? `This field is in ${unit}, not a length.` : 'This field has no unit, leave out the unit.');
        v = (v * k!) / field!;
        named = true;
      } else return v;
    }
  };
  const expr = (): number => {
    let v = term();
    while (peek() === '+' || peek() === '-') v = tokens[i++] === '+' ? v + term() : v - term();
    return v;
  };
  try {
    const v = expr();
    if (i < tokens.length) return { ok: false, error: tokens[i] === ')' ? 'A bracket is closed that was not opened.' : `Cannot read “${tokens.slice(i).join(' ')}”.` };
    if (!Number.isFinite(v)) return { ok: false, error: 'The result is not a number.' };
    return { ok: true, value: v, units: named };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Values of analyses and FEM in the user's units (E111): SOMA computes in mm, mm², MPa and N, people who work in inches
 * read in, in², psi and lbf. Only the display changes, results and limits on disk stay as they are. Angles and factors
 * without a unit stay.
 */
const IMPERIAL: Record<string, { unit: string; k: number; digits: number }> = {
  mm: { unit: 'in', k: 1 / MM_PER_INCH, digits: 1 },
  'mm²': { unit: 'in²', k: 1 / MM_PER_INCH ** 2, digits: 2 },
  'mm³': { unit: 'in³', k: 1 / MM_PER_INCH ** 3, digits: 2 },
  MPa: { unit: 'psi', k: 145.0377377, digits: -2 },
  N: { unit: 'lbf', k: 0.2248089431, digits: 0 },
};

/** The value and unit to show. `digits` are those for the SOMA unit, the result has as many as fit the shown one. */
export function shownQty(v: number, unit: string, units: DisplayUnits, digits = 2): { v: number; unit: string; digits: number } {
  const c = units === 'in' ? IMPERIAL[unit] : undefined;
  return c ? { v: v * c.k, unit: c.unit, digits: Math.max(0, Math.min(6, digits + c.digits)) } : { v, unit, digits };
}
/** A value typed in the shown unit back into SOMA's unit. */
export const fromShownQty = (v: number, unit: string, units: DisplayUnits) => {
  const c = units === 'in' ? IMPERIAL[unit] : undefined;
  return c ? v / c.k : v;
};
