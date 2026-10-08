import fs from 'node:fs';
import path from 'node:path';
import type { ParamInfo, ParamValue } from '../shared/types';

/**
 * Werte des Nutzers aus dem Parameter-Panel. Die Werte des Agenten stehen im Code (`param(38.0, …)`), die des Nutzers in
 * dieser Datei im Projektordner. So bleibt der Wert des Agenten erhalten, und „Zurücksetzen“ entfernt nur den Eintrag.
 * Die Datei liegt in Git und in der ZIP, `soma build` liest sie (python/soma/params.py, gleicher Aufbau).
 */
export const PARAMS_FILE = 'parameters.json';
const NOTE = 'Values the user set in the Parameters panel of SOMA. They take the place of the defaults of param() in the code.';
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_TEXT = 1000;

export interface UserParams {
  /** Inhalt der Datei ohne `values` (etwa die Notiz). Bleibt beim Schreiben erhalten. */
  rest: Record<string, unknown>;
  values: Record<string, ParamValue>;
  /** Die Datei ist da, aber nicht lesbar: dann wird nichts geschrieben (nichts still überschreiben). */
  error?: string;
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Ein Wert, wie er in der Datei stehen darf. Was nicht passt, lässt die App weg, `soma build` meldet es. */
export function isParamValue(v: unknown): v is ParamValue {
  return typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.length <= MAX_TEXT);
}

export function readUserParams(dir: string): UserParams {
  let text: string;
  try { text = fs.readFileSync(path.join(dir, PARAMS_FILE), 'utf8'); } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { rest: {}, values: {} };
    return { rest: {}, values: {}, error: `${PARAMS_FILE} cannot be read: ${msg(e)}` };
  }
  let data: unknown;
  try { data = JSON.parse(text.replace(/^﻿/, '')); } catch (e) {
    return { rest: {}, values: {}, error: `${PARAMS_FILE} is not valid JSON (${msg(e)}). The defaults from the code apply. Ask the agent to fix the file.` };
  }
  if (!isObject(data) || !isObject(data.values)) return { rest: {}, values: {}, error: `${PARAMS_FILE} has no “values” object. The defaults from the code apply. Ask the agent to fix the file.` };
  const { values, ...rest } = data;
  const out: Record<string, ParamValue> = {};
  for (const [k, v] of Object.entries(values)) if (isParamValue(v)) out[k] = v;
  return { rest, values: out };
}

/**
 * Passt der Wert zum Parameter? Bereichsgrenzen zählen nicht: Ein Wert außerhalb wird eingetragen und gebaut, die
 * Oberfläche und `soma build` melden ihn (melden statt reparieren, E28). Ohne Definition (noch kein Build) nur der Typ.
 */
export function checkParamValue(p: ParamInfo | undefined, v: ParamValue): string | null {
  if (!p) return isParamValue(v) ? null : 'This value cannot be stored.';
  switch (p.kind) {
    case 'number': return typeof v === 'number' && Number.isFinite(v) ? null : `${p.label} needs a number.`;
    case 'int': return typeof v === 'number' && Number.isInteger(v) ? null : `${p.label} needs a whole number.`;
    case 'bool': return typeof v === 'boolean' ? null : `${p.label} is on or off.`;
    case 'text': return typeof v === 'string' && v.length <= MAX_TEXT ? null : `${p.label} needs a text of at most ${MAX_TEXT} characters.`;
    case 'choice': return p.options?.some((o) => o.value === v) ? null : `${p.label}: this is not one of the options.`;
    default: return null;
  }
}

/**
 * Werte setzen (null: Eintrag entfernen, dann gilt der Wert aus dem Code). Ohne Einträge und ohne weiteren Inhalt
 * verschwindet die Datei, so bleibt ein Modell ohne eigene Werte wie die Vorlage. Gibt einen Fehlertext zurück oder null.
 */
export function writeUserParams(dir: string, changes: Record<string, ParamValue | null>): string | null {
  const cur = readUserParams(dir);
  if (cur.error) return `${cur.error} Nothing was changed.`;
  const values = { ...cur.values };
  for (const [k, v] of Object.entries(changes)) {
    if (!NAME.test(k)) return `“${k}” is not a parameter name.`;
    if (v === null) delete values[k];
    else values[k] = v;
  }
  const file = path.join(dir, PARAMS_FILE);
  const rest = Object.fromEntries(Object.entries(cur.rest).filter(([k]) => k !== 'note'));
  try {
    if (!Object.keys(values).length && !Object.keys(rest).length) {
      fs.rmSync(file, { force: true });
      return null;
    }
    // Erst vollständig schreiben, dann ersetzen: Ein halber Inhalt würde den nächsten Build alle Werte verlieren lassen
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ note: NOTE, ...rest, values }, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return null;
  } catch (e) {
    return `${PARAMS_FILE} could not be written: ${msg(e)}`;
  }
}
