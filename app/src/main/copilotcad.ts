import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { backupText, resolveInside } from './files';

const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_EDIT_LENGTH = 4000;
const MAX_FILES = 150;
const MAX_DEPTH = 6;

export function copilotCad(root: string, entry: string, backups: string, rebuild: () => void) {
  const activeEntry = entry.replace(/\\/g, '/');
  const segmentsOf = (rel: string) => {
    const segments = rel.split('/');
    if (rel.length > 512 || segments.length > MAX_DEPTH + 1 ||
        segments.some((segment) => !/^[\w-][\w .-]*$/.test(segment) || /[. ]$/.test(segment))) {
      throw new Error('Use a project-relative path with forward slashes and no traversal.');
    }
    return segments;
  };
  const checkedPath = (rel: string) => {
    const segments = segmentsOf(rel);
    const file = resolveInside(root, rel);
    const expected = path.join(fs.realpathSync(root), ...segments);
    if (fs.realpathSync(file) !== expected) throw new Error('Linked paths are not accessible to Copilot.');
    return file;
  };
  const source = (requested: unknown, editing = false) => {
    const rel = requested === undefined ? activeEntry : requested;
    if (typeof rel !== 'string') throw new Error('Provide a project-relative source path.');
    const segments = segmentsOf(rel);
    const python = /\.py$/i.test(rel) && (segments.length === 1 || segments[0] === 'parts'
      || (rel === activeEntry && !['inputs', 'output', 'renders', 'exports'].includes(segments[0].toLowerCase())));
    if (!python && (editing || rel !== 'AGENTS.md')) {
      throw new Error('Copilot can access the entry script, root Python files, and Python files under parts/. AGENTS.md is read-only.');
    }
    const file = checkedPath(rel);
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_SOURCE_BYTES) {
      throw new Error('The source must be a regular, unlinked project file of at most 256 KB.');
    }
    const text = fs.readFileSync(file, 'utf8');
    if (Buffer.byteLength(text) > MAX_SOURCE_BYTES || text.includes('\u0000') || text.includes('\uFFFD')) {
      throw new Error('The source must be UTF-8 text and at most 256 KB.');
    }
    return { rel, file, text };
  };
  const list = (directory: string, accept: (rel: string) => boolean, recurse: boolean): string[] => {
    const files: string[] = [];
    let visited = 0;
    const walk = (dir: string, depth: number) => {
      if (depth > MAX_DEPTH || visited >= 1000 || files.length >= MAX_FILES) return;
      const absolute = dir ? checkedPath(dir) : root;
      for (const item of fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        if (++visited > 1000 || files.length >= MAX_FILES) break;
        if (!/^[\w-][\w .-]*$/.test(item.name) || /[. ]$/.test(item.name)) continue;
        const rel = dir ? `${dir}/${item.name}` : item.name;
        if (item.isDirectory() && recurse && item.name !== '__pycache__') walk(rel, depth + 1);
        if (item.isFile() && accept(rel)) files.push(rel);
      }
    };
    if (!directory || fs.lstatSync(path.join(root, directory), { throwIfNoEntry: false })?.isDirectory()) walk(directory, 1);
    return files;
  };
  return {
    list() {
      const python = (rel: string) => /\.py$/i.test(rel);
      const sources = [source(undefined).rel, ...list('', python, false), ...list('parts', python, true)];
      return { entry: activeEntry, sources: [...new Set(sources)],
        instructions: list('', (rel) => rel === 'AGENTS.md', false),
        assets: list('inputs', (rel) => /\.(step|stp)$/i.test(rel), true) };
    },
    read(requested?: unknown) {
      const { rel, text } = source(requested);
      return { path: rel, source: text };
    },
    async replace(before: unknown, after: unknown, approve: (detail: string) => Promise<boolean>, active: () => boolean, requested?: unknown) {
      if (typeof before !== 'string' || !before.trim() || typeof after !== 'string'
          || before === after || before.length > MAX_EDIT_LENGTH || after.length > MAX_EDIT_LENGTH) {
        throw new Error('Provide two different snippets, at most 4,000 characters each, with a nonempty original.');
      }
      const initial = source(requested, true);
      const index = initial.text.indexOf(before);
      if (index < 0 || initial.text.indexOf(before, index + 1) >= 0) throw new Error('The original snippet must match exactly once. Read the script and try again.');
      const next = initial.text.slice(0, index) + after + initial.text.slice(index + before.length);
      if (Buffer.byteLength(next) > MAX_SOURCE_BYTES) throw new Error('The edited script would exceed 256 KB.');
      if (!active() || !await approve(`File: ${initial.rel}\n\nReplace:\n${before}\n\nWith:\n${after}`) || !active()) {
        return { ok: false, message: 'The edit was not approved. Nothing changed.' };
      }
      const current = source(initial.rel, true);
      if (current.file !== initial.file || current.text !== initial.text) throw new Error('The script changed during review. Nothing was overwritten.');
      backupText(backups, initial.rel, current.text);
      const temporary = resolveInside(root, `${initial.rel}.${randomUUID()}.soma-tmp`);
      fs.writeFileSync(temporary, next, { encoding: 'utf8', flag: 'wx' });
      try { fs.renameSync(temporary, current.file); }
      catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
      rebuild();
      return { ok: true, message: 'The approved script was saved and a SOMA rebuild was requested. Check the viewer build status for its result.' };
    },
  };
}
