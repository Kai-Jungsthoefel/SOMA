// part_library for SOMA AI (loaded by soma.ts): search open CAD libraries by file name and download a part.
// The libraries are Git repositories on GitHub. One request of GitHub's API gives the complete file list (tested
// 2026-11-25: FreeCAD library 11 154 files, Adafruit 1 825, nothing truncated), files load from
// raw.githubusercontent.com without Git LFS. The lists are kept for a day in pi's folder of the app data.
// Only Node's own modules, so test/unit.mjs can bundle it.
import fs from 'node:fs';
import path from 'node:path';

export interface Library {
  id: string; name: string; repo: string; branch: string; license: string; licenseUrl: string;
  /** What it has, for the tool description and the result. */
  about: string;
}

export const LIBRARIES: Library[] = [
  {
    id: 'freecad', name: 'FreeCAD parts library', repo: 'FreeCAD/FreeCAD-library', branch: 'master',
    license: 'CC-BY 3.0', licenseUrl: 'https://creativecommons.org/licenses/by/3.0/',
    about: 'about 2 900 STEP files: mechanical parts (bearings, fasteners, profiles, gears), electrical and electronic parts, motors, sensors, robots, pipes, architecture',
  },
  {
    id: 'adafruit', name: 'Adafruit CAD parts', repo: 'adafruit/Adafruit_CAD_Parts', branch: 'main',
    license: 'MIT', licenseUrl: 'https://github.com/adafruit/Adafruit_CAD_Parts/blob/main/LICENSE',
    about: 'about 490 STEP files of Adafruit boards and modules, folders start with the Adafruit product number',
  },
];

/** Files worth finding: CAD models. Pictures, docs and code of the repositories stay out of the results. */
const CAD = /\.(step|stp|fcstd|stl|3mf|obj|iges|igs|dxf|f3d|f3z)$/i;
const FORMAT_RANK: Record<string, number> = { step: 0, stp: 0, fcstd: 1, iges: 2, igs: 2, f3d: 3, f3z: 3, stl: 4, '3mf': 4, obj: 5, dxf: 6 };
export const INDEX_TTL_MS = 24 * 3600_000;

export const libraryById = (id: string) => LIBRARIES.find((l) => l.id === id.trim().toLowerCase());
export const treeUrl = (lib: Library) => `https://api.github.com/repos/${lib.repo}/git/trees/${lib.branch}?recursive=1`;
export const rawUrl = (lib: Library, file: string) => `https://raw.githubusercontent.com/${lib.repo}/${lib.branch}/${file.split('/').map(encodeURIComponent).join('/')}`;
export const pageUrl = (lib: Library, file: string) => `https://github.com/${lib.repo}/blob/${lib.branch}/${file.split('/').map(encodeURIComponent).join('/')}`;

/** The CAD files of a tree answer of GitHub's API. Null when the answer is no tree; `truncated` says it is not all. */
export function filesOfTree(json: unknown): string[] | null {
  const t = json as { tree?: { path?: unknown; type?: unknown }[]; truncated?: unknown };
  if (!t || !Array.isArray(t.tree)) return null;
  return t.tree.filter((e) => e.type === 'blob' && typeof e.path === 'string' && CAD.test(e.path)).map((e) => e.path as string);
}

export interface CachedIndex { fetched: number; files: string[] }

export function readCache(dir: string, lib: Library): CachedIndex | null {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(dir, `${lib.id}.json`), 'utf8')) as CachedIndex;
    return Array.isArray(c.files) && typeof c.fetched === 'number' ? c : null;
  } catch { return null; }
}

export function writeCache(dir: string, lib: Library, files: string[], now = Date.now()): void {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${lib.id}.json`);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ fetched: now, files }));
  fs.renameSync(`${file}.tmp`, file);
}

const norm = (s: string) => s.toLowerCase().replace(/[_\-./\\()[\],+]+/g, ' ').replace(/\s+/g, ' ');
const extOf = (f: string) => /\.([a-z0-9]+)$/i.exec(f)?.[1]?.toLowerCase() ?? '';

/**
 * How well a word of the query matches a file name: a whole word 4, the start of a word 3 ("608" in "608zz"), but not
 * when a number goes on with more digits ("608" in "6080" is another size), anywhere else 2.
 */
function nameScore(name: string, w: string): number {
  if (` ${name} `.includes(` ${w} `)) return 4;
  const esc = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(^| )${esc}${/\d$/.test(w) ? '(?!\\d)' : ''}`).test(name)) return 3;
  return 2;
}

export interface Hit { item: string; files: string[]; formats: string[]; score: number; partial?: boolean }

/**
 * Searches file names and folders. Every word of the query must appear (as part of a word, so "608" finds "608ZZ");
 * words in the file name count more than in folders. Files of one part in several formats (same folder and name)
 * are one hit, the best format first.
 */
export function searchFiles(files: string[], query: string, limit = 25): Hit[] {
  const words = norm(query).split(' ').filter((w) => w.length > 0);
  if (!words.length) return [];
  const all = collect(files, words, words.length);
  // Nothing has every word ("gate hinge", the library only says "hinge"): parts with one word less, marked as such
  return (all.length || words.length < 2 ? all : collect(files, words, words.length - 1).map((h) => ({ ...h, partial: true }))).slice(0, limit);
}

function collect(files: string[], words: string[], need: number): Hit[] {
  const groups = new Map<string, Hit>();
  for (const f of files) {
    const slash = f.lastIndexOf('/');
    const name = norm(f.slice(slash + 1).replace(/\.[^.]+$/, ''));
    const dirs = norm(f.slice(0, slash + 1));
    let score = 0;
    let found = 0;
    for (const w of words) {
      if (name.includes(w)) { score += nameScore(name, w); found++; }
      else if (dirs.includes(w)) { score += 1; found++; }
    }
    if (found < need) continue;
    const item = f.replace(/\.[^.]+$/, '');
    const key = item.toLowerCase();
    const g = groups.get(key) ?? { item, files: [], formats: [], score };
    g.files.push(f);
    g.score = Math.max(g.score, score);
    groups.set(key, g);
  }
  const rank = (f: string) => FORMAT_RANK[extOf(f)] ?? 9;
  const hits = [...groups.values()].map((g) => {
    g.files.sort((a, b) => rank(a) - rank(b));
    g.formats = [...new Set(g.files.map((f) => extOf(f).toUpperCase().replace('STP', 'STEP')))];
    // A STEP file makes a part more useful: it goes straight into the model
    if (g.formats.includes('STEP')) g.score += 2;
    return g;
  });
  hits.sort((a, b) => b.score - a.score || a.item.length - b.item.length || a.item.localeCompare(b.item));
  return hits;
}

/** The line for NOTES.md: where a part came from and under which license (CC-BY asks for it). */
export const attribution = (lib: Library, file: string) => `${file.split('/').pop()}: from the ${lib.name} (${pageUrl(lib, file)}), license ${lib.license} (${lib.licenseUrl})`;
