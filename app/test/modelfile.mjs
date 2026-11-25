// Test for the model file shared between computers (a .soma file on a network folder) and for opening .soma files from
// the system. Saving over a file that was saved elsewhere asks first (Replace keeps the other version as a backup, Save
// as, Cancel). Opening from Recent compares with the model file when it was saved elsewhere, and does not ask again
// after "Keep current work". A second start of SOMA with a .soma file (double-click) opens it in a window of its own.
// Call: npm run test:modelfile (builds first).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { electronExe } from '../scripts/electron-local.mjs';
import { APP, checker, cleanup, sleep, startApp } from './harness.mjs';

const PY = process.env.SOMA_PYTHON || path.join(process.env.LOCALAPPDATA ?? '', 'soma-dev', 'venv', 'Scripts', 'python.exe');

const t = checker();
const { check } = t;
let app;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-modelfile-'));
const zipPath = path.join(tmp, 'Shared.soma');
const older = path.join(tmp, 'older.soma');

try {
  app = await startApp({ name: 'modelfile' });
  const { ev, waitFor } = app;
  await waitFor('model and build', () => !!window.__t && !!window.__t.project() && window.__t.status().state === 'ok');
  const proj = await ev(() => window.__t.project());
  const save = () => ev(() => window.soma.project.save(false));
  const tryEv = async (fn, arg) => { try { return { ok: true, v: await ev(fn, arg) }; } catch (e) { return { ok: false, error: String(e?.message ?? e) }; } };

  // 1) Saved twice on this computer; the first file is "the other computer's" version later
  await app.answers([zipPath]);
  let r = await save();
  check('First save writes the model file', !r.error && fs.existsSync(zipPath), JSON.stringify(r));
  fs.copyFileSync(zipPath, older);
  fs.appendFileSync(path.join(proj.dir, 'NOTES.md'), '\nChanged on this computer\n');
  await waitFor('change seen', () => window.__t.saveState()?.dirtyFiles === 1, 20000);
  r = await save();
  check('Second save: no question, the file is ours', !r.error && !r.cancelled, JSON.stringify(r));

  // 2) Another computer saves the file: our save asks. Cancel keeps it, Replace backs it up first
  fs.copyFileSync(older, zipPath);
  fs.appendFileSync(path.join(proj.dir, 'NOTES.md'), '\nMore here\n');
  await waitFor('change seen', () => window.__t.saveState()?.dirtyFiles === 1, 20000);
  await app.answers([2]);
  r = await save();
  check('Saved elsewhere since: Save asks, Cancel leaves the other version as it is',
    r.cancelled === true && fs.readFileSync(zipPath).equals(fs.readFileSync(older)), JSON.stringify(r));
  await app.answers([0]);
  r = await save();
  const backups = path.join(app.ud, 'workspace-backups');
  const kept = fs.existsSync(backups) ? fs.readdirSync(backups).filter((n) => n.startsWith(`${proj.id}-file-`)) : [];
  check('Replace: our version in the file, the other one kept as a backup',
    !r.error && !r.cancelled && !fs.readFileSync(zipPath).equals(fs.readFileSync(older)) && kept.length === 1
    && fs.readFileSync(path.join(backups, kept[0], 'Shared.soma')).equals(fs.readFileSync(older)), JSON.stringify(r) + kept.join(','));

  // 3) Recent: the file was saved elsewhere since. Opening compares (the question comes), "Keep current work" is remembered
  fs.copyFileSync(older, zipPath);
  await ev(() => window.soma.project.create());
  await waitFor('other model', (id) => window.__t.project()?.id !== id, 30000, proj.id);
  let o = await tryEv((id) => window.soma.project.open(id), proj.id); // no answer prepared: the question shows as an error
  check('Recent after a save elsewhere: the app compares and asks (working folder and file differ)',
    !o.ok && o.error.includes('Working folder and file differ'), o.error ?? JSON.stringify(o.v));
  await app.answers([0]);
  o = await tryEv((id) => window.soma.project.open(id), proj.id);
  check('"Keep current work": the model opens as it is here', o.ok && o.v?.id === proj.id && (await ev(() => window.__t.project().id)) === proj.id, o.error);
  await ev(() => window.soma.project.create());
  await waitFor('other model again', (id) => window.__t.project()?.id !== id, 30000, proj.id);
  o = await tryEv((id) => window.soma.project.open(id), proj.id);
  check('Same version of the file again: Recent opens without asking', o.ok && o.v?.id === proj.id, o.error);

  // 4) Double-click while SOMA runs: the second start opens the file in a window of its own, this one keeps its model
  const other = path.join(tmp, 'Other.soma');
  const otherId = '0b7e3c1a-2d4f-4a6b-9c8d-7e6f5a4b3c2d';
  const z = spawnSync(PY, ['-c', `
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], "w") as z:
    z.writestr("model.py", "import cadquery as cq\\nfrom soma import add_part\\nadd_part('Block', cq.Workplane().box(10, 10, 10))\\n")
    z.writestr(".soma/project.json", '{"id": "${otherId}", "name": "Other", "entry": "model.py", "api": 1}')
`, other], { encoding: 'utf8' });
  if (z.status !== 0) throw new Error(z.stderr);
  const before = await ev(() => window.__t.project()?.id);
  const second = spawn(electronExe(APP), ['.', other], {
    cwd: APP, env: { ...process.env, SOMA_USER_DATA: app.ud, SOMA_TEST: '1', SOMA_HIDDEN: '1' }, stdio: 'ignore',
  });
  const lock = path.join(app.ud, 'open-models', `${otherId}.pid`);
  let pid = 0;
  for (const t0 = Date.now(); !pid && Date.now() - t0 < 60000; await sleep(500)) {
    try { pid = Number(fs.readFileSync(lock, 'utf8')); } catch { /* not yet */ }
  }
  check('Second start with a .soma file: a window of its own opens the model, this window keeps its own',
    pid === second.pid && (await ev(() => window.__t.project()?.id)) === before, `pid ${pid}, second ${second.pid}`);
  try { spawnSync('taskkill', ['/PID', String(second.pid), '/T', '/F'], { windowsHide: true }); } catch { /* gone */ }
} catch (e) {
  console.log('ABORTED:', e.message);
  t.fail();
} finally {
  await app?.stop();
  cleanup(tmp);
  if (app) cleanup(app.ud);
}
console.log(t.fails ? `\n${t.fails} failed` : '\nAll OK');
process.exit(t.fails ? 1 : 0);
