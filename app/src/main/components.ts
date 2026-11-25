import type { BrowserWindow } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ModelComponent, ComponentResult } from '../shared/types';
import { choose, choosePath } from './dialogs';
import { pythonEnv, pythonExe } from './paths';

/**
 * Components (GitHub discussion #21): other SOMA models inside this one, in components/. The work is done by
 * `soma component` (python/soma/components.py), the same command the agent uses. The app lists the components with
 * their state, asks how to insert a .soma file and updates linked components on request.
 */

/**
 * `soma component` in a process of its own, not the prewarmed one of the builds (build.ts): it needs no cadquery and
 * starts in half a second, and the next build still finds a warm process (the app checks after every build and on focus).
 */
function runCold(args: string[], cwd: string, timeoutMs: number): Promise<{ out: string; err: string }> {
  return new Promise((resolve) => {
    let out = '', err = '';
    let child;
    try { child = spawn(pythonExe(), ['-m', 'soma', ...args], { cwd, windowsHide: true, env: pythonEnv() }); }
    catch (e) { resolve({ out: '', err: e instanceof Error ? e.message : String(e) }); return; }
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout?.on('data', (d: Buffer) => { out += d.toString('utf8'); });
    child.stderr?.on('data', (d: Buffer) => { err += d.toString('utf8'); });
    child.on('error', (e) => { clearTimeout(timer); resolve({ out, err: err || e.message }); });
    child.on('close', () => { clearTimeout(timer); resolve({ out, err }); });
  });
}

async function soma(dir: string, args: string[]): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  const r = await runCold(['component', ...args, '--json', '--project', dir], dir, 60000);
  // The last line that is JSON: the warm process may print other lines before it
  const line = r.out.split(/\r?\n/).reverse().find((l) => l.trim().startsWith('{'));
  if (!line) return { ok: false, error: (r.err || r.out || 'soma component gave no answer').trim().split(/\r?\n/).slice(-3).join('\n') };
  try {
    const data = JSON.parse(line) as Record<string, unknown>;
    if (data.status !== 'ok') return { ok: false, error: String(data.error ?? 'soma component failed') };
    return { ok: true, data };
  } catch {
    return { ok: false, error: 'soma component gave an unreadable answer' };
  }
}

/** Components of the model with their state. Empty without components/ (no Python started). */
export async function listComponents(dir: string): Promise<ModelComponent[]> {
  return (await listOrError(dir)).components;
}

/** Like listComponents, with the reason when `soma component list` failed (the tree says so instead of showing nothing). */
export async function listOrError(dir: string): Promise<{ components: ModelComponent[]; error?: string }> {
  if (!fs.existsSync(path.join(dir, 'components'))) return { components: [] };
  const r = await soma(dir, ['list']);
  if (!r.ok) { console.warn('[components]', r.error); return { components: [], error: r.error }; }
  return { components: Array.isArray(r.data.components) ? r.data.components as ModelComponent[] : [] };
}

/** A folder that is a SOMA model (it has .soma/project.json): Import offers it as a component like a .soma file. */
export function isModelFolder(p: string): boolean {
  try { return fs.statSync(p).isDirectory() && fs.statSync(path.join(p, '.soma', 'project.json')).isFile(); } catch { return false; }
}

/** The model file of the open model must not go into itself. */
const same = (a: string, b: string) => { try { return fs.realpathSync(a).toLowerCase() === fs.realpathSync(b).toLowerCase(); } catch { return false; } };

/**
 * A .soma file was imported: ask whether it becomes a linked component, a copy, or a plain file in inputs/.
 * `inputs`: the user chose the plain file. `null`: canceled.
 */
export async function insertModel(win: BrowserWindow | null, dir: string, file: string, ownZip: string | null): Promise<ComponentResult | 'inputs' | null> {
  const folder = isModelFolder(file);
  const name = folder ? path.basename(file) : path.basename(file, path.extname(file));
  if ((ownZip && same(file, ownZip)) || same(file, dir)) return { ok: false, error: `${path.basename(file)} is this model itself, it cannot be inserted into itself.` };
  const c = await choose(win, {
    title: 'Insert model',
    message: `Insert “${name}” into this model as a component?`,
    detail: `Linked: stays connected to the original ${folder ? 'folder' : 'file'}. When the original is saved with changes, SOMA shows it and you update with one click.\n`
      + 'Copy: independent of the original, you or the agent can change it in this model.',
    buttons: ['Linked', 'Copy', folder ? 'Add folder to inputs/' : 'Add file to inputs/', 'Cancel'],
  });
  if (c === 2) return 'inputs';
  if (c !== 0 && c !== 1) return null;
  const mode = c === 1 ? ['--copy'] : [];
  let r = await soma(dir, ['add', file, ...mode]);
  if (!r.ok && /There is already a component/.test(r.error)) {
    // Inserted before: a second component from the same model needs its own name
    const taken = new Set((await listComponents(dir)).map((x) => x.name.toLowerCase()));
    let i = 2;
    while (taken.has(`${name} ${i}`.toLowerCase())) i++;
    const a = await choose(win, {
      title: 'Insert model',
      message: `This model has a component “${name}” already.`,
      detail: `Insert it a second time as “${name} ${i}”? To bring changes of the original into the existing one, use Update in the structure tree instead. To use it several times, the agent can place more instances of the existing one.`,
      buttons: [`Insert as “${name} ${i}”`, 'Cancel'],
    });
    if (a !== 0) return null;
    r = await soma(dir, ['add', file, ...mode, '--name', `${name} ${i}`]);
  }
  if (!r.ok) return { ok: false, error: r.error };
  const comp = r.data.component as ModelComponent;
  return { ok: true, component: comp, placed: placeInModel(dir, comp) };
}

/**
 * Adds the component to the end of the entry file, so it shows up right away. Only for models that register parts with
 * add_part (plain CadQuery scripts would lose their show_object parts). Returns the file, or null when it was left alone.
 */
function placeInModel(dir: string, comp: ModelComponent): string | null {
  let entry = 'model.py';
  try { const pj = JSON.parse(fs.readFileSync(path.join(dir, '.soma', 'project.json'), 'utf8')) as { entry?: unknown }; if (typeof pj.entry === 'string' && pj.entry) entry = pj.entry; } catch { /* default */ }
  const file = path.join(dir, entry);
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  if (!/\badd_part\s*\(/.test(text)) return null;
  const q = JSON.stringify(comp.name);
  const lines = [
    '',
    `# Component ${q} (${comp.folder}/), inserted in the app. Place it with .loc = cq.Location((x, y, z))`,
    ...(/\bimport\b[^\n]*\bcomponent\b/.test(text) ? [] : ['from soma import component  # noqa: E402']),
    `add_part(${q}, component(${q}))`,
    '',
  ];
  fs.writeFileSync(file, text.replace(/\s*$/, '\n') + lines.join('\n'), 'utf8');
  return entry;
}

/**
 * Updates linked components from their original (`name` null: all out of date). A component that was changed in this
 * model is only updated after asking (the changed copy goes into .soma/component-backups/).
 */
export async function updateComponents(win: BrowserWindow | null, dir: string, name: string | null): Promise<ComponentResult> {
  const all = await listComponents(dir);
  const todo = name ? all.filter((c) => c.name === name) : all.filter((c) => c.state === 'outdated');
  if (!todo.length) return { ok: true, updated: [] };
  const changed = todo.filter((c) => c.changed);
  let force = false;
  if (changed.length) {
    const names = changed.map((c) => `“${c.name}”`).join(', ');
    const a = await choose(win, {
      title: 'Update component',
      message: `${names} ${changed.length === 1 ? 'was' : 'were'} changed in this model. Update anyway?`,
      detail: 'The update replaces those changes with the original. The changed copy is kept in .soma/component-backups/.',
      buttons: ['Update', 'Cancel'],
    });
    if (a !== 0) return { ok: false, canceled: true };
    force = true;
  }
  const updated: string[] = [];
  for (const c of todo) {
    const r = await soma(dir, ['update', c.name, ...(force ? ['--force'] : [])]);
    if (!r.ok) return { ok: false, error: r.error, updated };
    updated.push(c.name);
  }
  return { ok: true, updated };
}

/**
 * Where the original of a component is, to open it in the window ("Open the original"): a .soma file or a model folder.
 */
export async function componentSource(dir: string, name: string): Promise<{ path: string; folder: boolean } | { error: string }> {
  const c = (await listComponents(dir)).find((x) => x.name === name);
  if (!c) return { error: `There is no component “${name}” in this model.` };
  if (!c.source) return { error: `“${name}” does not know its original (it was copied in by hand).` };
  try {
    const st = fs.statSync(c.source);
    return { path: c.source, folder: st.isDirectory() };
  } catch {
    return { error: `The original of “${name}” is not found: ${c.source}` };
  }
}

/**
 * The original of a component was not found (moved, another computer): the user picks it, the component is linked to
 * it again. Its files stay, the state then shows whether an update is due.
 */
export async function relinkComponent(win: BrowserWindow | null, dir: string, name: string): Promise<ComponentResult> {
  const file = await choosePath(win, 'open', '');
  if (!file) return { ok: false, canceled: true };
  const r = await soma(dir, ['relink', name, file]);
  return r.ok ? { ok: true, component: r.data.component as ModelComponent } : { ok: false, error: r.error };
}

/** Turns a linked component into an independent copy, after asking. */
export async function unlinkComponent(win: BrowserWindow | null, dir: string, name: string): Promise<ComponentResult> {
  const a = await choose(win, {
    title: 'Unlink component',
    message: `Make “${name}” an independent copy?`,
    detail: 'It stays as it is, but no longer follows the original. You or the agent can then change it in this model.',
    buttons: ['Unlink', 'Cancel'],
  });
  if (a !== 0) return { ok: false, canceled: true };
  const r = await soma(dir, ['unlink', name]);
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}
