// Test of the parallel meshing in `soma build` (python/soma/parmesh.py, issue #16): with worker processes the build writes
// the same viewer files as without, large parts get a coarser tolerance of their own, a script that calls run_build()
// without a __main__ guard runs once, and the workers end with the build process. Python only.
// Run: node test/parmesh.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checker, cleanup, sleep } from './harness.mjs';

const t = checker();
const { check } = t;

const PY = process.env.SOMA_PYTHON || path.join(process.env.LOCALAPPDATA ?? '', 'soma-dev', 'venv', 'Scripts', 'python.exe');
const ENV = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };

// Enough parts for several packets, with curved and freeform faces (fillets, a loft) and one long part
const MODEL = `import cadquery as cq
from soma import add_part

for i in range(24):
    add_part(f"Block {i}", cq.Workplane().box(20, 12, 8).edges("|Z").fillet(2).translate((i * 25, 0, 0)), group="Blocks")
loft = (cq.Workplane("XY").ellipse(30, 18).workplane(offset=40).circle(10).loft())
add_part("Loft", loft.translate((0, 60, 0)))
add_part("Rod", cq.Workplane("YZ").circle(40).extrude(3000).translate((0, 0, 100)))
`;

/** Runs PY with args, resolves with exit code and output. */
function run(args, { env = {}, cwd } = {}) {
  const child = spawn(PY, args, { env: { ...ENV, ...env }, cwd, windowsHide: true });
  let out = '', err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, out, err })));
  return { child, done, get out() { return out; } };
}
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const dirs = [];
const tmp = (name) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), `soma-parmesh-${name}-`)); dirs.push(d); return d; };

try {
  // 1) Same files with and without workers
  const seq = tmp('seq'), par = tmp('par');
  for (const d of [seq, par]) fs.writeFileSync(path.join(d, 'model.py'), MODEL);
  const [rs, rp] = await Promise.all([
    run(['-m', 'soma', 'build', '--project', seq], { env: { SOMA_BUILD_WORKERS: '0' } }).done,
    run(['-m', 'soma', 'build', '--project', par], { env: { SOMA_BUILD_WORKERS: '3' } }).done,
  ]);
  check('Both builds ok', rs.code === 0 && rp.code === 0, (rs.err + rp.err).slice(-400));
  const bs = read(path.join(seq, '.soma', 'build.json')), bp = read(path.join(par, '.soma', 'build.json'));
  check('build.json names the workers (0 and 3)', bs.mesh_workers === 0 && bp.mesh_workers === 3, `${bs.mesh_workers} / ${bp.mesh_workers}`);
  check('No warnings from the workers', bp.warnings.length === 0, bp.warnings.join(' | '));
  const strip = (m) => JSON.stringify(m.parts);
  const ms = read(path.join(seq, '.soma', 'model.map.json')), mp = read(path.join(par, '.soma', 'model.map.json'));
  check('model.map.json: same parts, boxes and volumes', strip(ms) === strip(mp));
  const gs = fs.readFileSync(path.join(seq, '.soma', 'model.glb')), gp = fs.readFileSync(path.join(par, '.soma', 'model.glb'));
  check('model.glb: same size with and without workers', gs.length === gp.length, `${gs.length} / ${gp.length}`);
  // The JSON chunk of the GLB holds the face tables (area, center) and the accessor counts (triangles)
  const json = (b) => JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8'));
  const js = json(gs), jp = json(gp);
  const faces = (j) => j.nodes.slice(1).map((n) => n.extras.soma.faces.map((f) => [f.surface, f.triCount, f.area]));
  check('Same faces, triangles and areas per part', JSON.stringify(faces(js)) === JSON.stringify(faces(jp)));

  // 2) Tolerances: the long rod gets its own, the small parts keep the model value
  const tol = run(['-c', `
import cadquery as cq
from soma import build
small = cq.Workplane().box(10, 10, 10).val()
rod = cq.Workplane("YZ").circle(40).extrude(3000).val()
print(build.mesh_tolerances([small])[0], build.auto_tolerance([small]))
print(*build.mesh_tolerances([small, rod])[1])
`]);
  const tr = await tol.done;
  const [line1, line2] = tr.out.trim().split(/\r?\n/);
  const [m1, a1] = line1.split(' ').map(Number);
  const [ts, tr2] = line2.split(' ').map(Number);
  check('Small model: tolerance as auto_tolerance', Math.abs(m1 - a1) < 1e-9, line1);
  check('Small part beside a 3 m rod: 0.2 mm, the rod relative to its length (about 1.2 mm)', ts === 0.2 && tr2 > 1.1 && tr2 < 1.3, line2);
  check('The rod is meshed with fewer triangles than at 0.2 mm', (() => {
    const rod = js.nodes.slice(1).find((n) => n.extras.soma.name === 'Rod');
    return rod && rod.extras.soma.faces.reduce((s, f) => s + f.triCount, 0) < 2000;
  })());

  // 3) A script without a __main__ guard that calls run_build: the workers must not run it again
  const guard = tmp('guard');
  fs.writeFileSync(path.join(guard, 'model.py'), MODEL);
  fs.writeFileSync(path.join(guard, 'runner.py'), `import os, sys
from pathlib import Path
Path(sys.argv[1], f"ran-{os.getpid()}.txt").write_text("1")
from soma import build
r = build.run_build(sys.argv[1])
print(r["status"], r.get("mesh_workers"))
`);
  const rg = await run([path.join(guard, 'runner.py'), guard], { env: { SOMA_BUILD_WORKERS: '2' } }).done;
  const ran = fs.readdirSync(guard).filter((f) => f.startsWith('ran-')).length;
  check('Unguarded script: build ok with 2 workers, script ran once', rg.out.trim() === 'ok 2' && ran === 1, `${rg.out.trim()} ${rg.err.slice(-300)}, ran ${ran}x`);

  // 4) Workers end with the build process: the script prints its own and the workers' pids, then waits
  const kill = tmp('kill');
  fs.writeFileSync(path.join(kill, 'hold.py'), `import os, sys, time
import cadquery as cq
from soma import parmesh
shapes = [cq.Workplane().box(5, 5, 5).translate((i * 10, 0, 0)).val() for i in range(16)]
job = parmesh.MeshJob(shapes, [0.01] * 16, workers=3).start()
print(os.getpid(), *[p.pid for p in job.procs], flush=True)
time.sleep(600)
`);
  const h = run([path.join(kill, 'hold.py')]);
  const t0 = Date.now();
  while (!h.out.trim() && Date.now() - t0 < 60000) await sleep(100);
  const [mainPid, ...workers] = h.out.trim().split(/\s+/).map(Number);
  check('Three workers started', workers.length === 3 && workers.every(alive), h.out.trim());
  process.kill(mainPid); // the interpreter itself, not a launcher in between
  await h.done;
  const t1 = Date.now();
  while (workers.some(alive) && Date.now() - t1 < 10000) await sleep(200);
  check('Workers end with the build process', !workers.some(alive), workers.filter(alive).join(', '));
  for (const w of workers.filter(alive)) process.kill(w);
} catch (err) {
  console.log('ABORT:', err.message);
  t.fail();
}
await sleep(300);
for (const d of dirs) cleanup(d);
console.log(t.fails ? `\n${t.fails} check(s) failed` : '\nALL CHECKS PASSED');
process.exit(t.fails ? 1 : 0);
