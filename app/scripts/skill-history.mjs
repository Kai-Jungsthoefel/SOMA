// Collects every version of the built-in skills from the Git history into resources/skill-history.br (JSON, Brotli).
//
// Why: opening a model updates its skill copies (.soma/skills/) to the version of the app, but only copies nobody changed
// in the model. Copies written by apps after 1.0.0 carry a fingerprint in project.json for that. Older copies have none: the app
// compares them with these past versions instead (skills.ts, matchesPastVersion). The file only needs the versions up to
// the fingerprints, so it is generated once; running it again after a skill changed does no harm.
//
//   node scripts/skill-history.mjs        (in app/, needs the full Git history, not a shallow clone)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(APP, '..');
const DIR = 'app/resources/skills';
const OUT = path.join(APP, 'resources', 'skill-history.br');

const git = (...args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
if (git('rev-parse', '--is-shallow-repository').trim() === 'true') throw new Error('Shallow clone: the history is incomplete.');

const norm = (t) => t.replace(/\r\n?/g, '\n');
const files = new Set(git('log', '--all', '--format=', '--name-only', '--', `${DIR}/*.md`).split('\n').filter((f) => f.endsWith('.md')));
const out = {};
for (const file of [...files].sort()) {
  const id = path.basename(file, '.md');
  const texts = new Set();
  for (const c of git('log', '--all', '--format=%H', '--', file).split('\n').filter(Boolean)) {
    try { texts.add(norm(git('show', `${c}:${file}`))); } catch { /* deleted in this commit */ }
  }
  const cur = path.join(REPO, file);
  if (fs.existsSync(cur)) texts.add(norm(fs.readFileSync(cur, 'utf8')));
  if (texts.size) out[id] = [...texts];
}
const json = JSON.stringify(out);
fs.writeFileSync(OUT, zlib.brotliCompressSync(Buffer.from(json, 'utf8'), {
  params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: 24, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: json.length },
}));
const n = Object.values(out).reduce((a, v) => a + v.length, 0);
console.log(`${n} versions of ${Object.keys(out).length} skills, ${json.length} bytes, ${fs.statSync(OUT).size} compressed: ${path.relative(REPO, OUT)}`);
