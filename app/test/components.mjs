// Test for components (GitHub discussion #21): another SOMA model inside this one. Import of a .soma file asks linked or
// copy, the app adds it to model.py, the tree marks the instance, a changed original shows "Update" in the tree, the update
// copies it in, a component changed in this model asks first, unlink makes it a copy. Two instances with their own
// parameters, placing by anchors, the agent's command `soma component list`, "Export as CadQuery" with components, a model
// folder as a component (part named like the model), finding a moved original, opening the original. Then soma alone:
// packages of the project environment load once, components do not see the model around them, anchors keep upright.
// Call: npm run test:components (builds first).
// SMOKE_VISIBLE=offscreen SMOKE_SHOTS=1 saves pictures.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP, checker, cleanup, sleep, startApp } from './harness.mjs';

const t = checker();
const { check } = t;
let app;

const PY = process.env.SOMA_PYTHON || path.join(process.env.LOCALAPPDATA ?? '', 'soma-dev', 'venv', 'Scripts', 'python.exe');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-components-'));
const src = path.join(tmp, 'drawer');
const zipFile = path.join(tmp, 'Drawer.soma');

const DRAWER = `import cadquery as cq
from soma import add_part, anchor, param
from parts.params import DEPTH

WIDTH = param(300.0, "Width", min=100, max=800, unit="mm")
add_part("Box", cq.Workplane().box(WIDTH, DEPTH, 100).faces(">Z").shell(-8), group="Body", color=(0.6, 0.4, 0.2))
add_part("Handle", cq.Workplane().box(80, 12, 12).translate((0, -DEPTH / 2 - 6, 20)))
add_part("Rail", cq.Workplane().box(8, DEPTH, 8).translate((WIDTH / 2 + 4, 0, 0)), role="reference")
anchor("front", (0, -DEPTH / 2, -50))
`;
/** The original as a model file (.soma is a ZIP of the model folder, zip.ts). */
function writeOriginal(depth) {
  fs.mkdirSync(path.join(src, 'parts'), { recursive: true });
  fs.writeFileSync(path.join(src, 'model.py'), DRAWER);
  fs.writeFileSync(path.join(src, 'parts', 'params.py'), `DEPTH = ${depth}\n`);
  const r = spawnSync(PY, ['-c', `
import zipfile, os, sys
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out + ".part", "w") as z:
    for d, _, fs in os.walk(src):
        for f in fs:
            p = os.path.join(d, f)
            z.write(p, os.path.relpath(p, src).replace(os.sep, "/"))
    z.writestr(".soma/project.json", '{"id": "6f1d2c3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f", "name": "Drawer", "entry": "model.py", "api": 1}')
    z.writestr(".git/HEAD", "ref: refs/heads/main\\n")
os.replace(out + ".part", out)
`, src, zipFile], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
}

/** soma alone, without the app: modules and sys.path while components run, anchors, export, management. */
function pythonChecks() {
  const py = (args, cwd) => spawnSync(PY, args, { encoding: 'utf8', cwd, env: { ...process.env, PYTHONUTF8: '1' } });
  const pr = path.join(tmp, 'py-root');
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(pr, rel)), { recursive: true }); fs.writeFileSync(path.join(pr, rel), text); };
  // A package of the project environment that breaks when it is imported twice, like numpy (a C extension)
  const site = py(['-c', 'import sys, sysconfig; print(sysconfig.get_path("purelib", "venv", vars={"base": sys.argv[1], "platbase": sys.argv[1]}))',
    path.join(pr, '.soma', 'env')]).stdout.trim();
  const ONCE = 'import builtins\nbuiltins._once = getattr(builtins, "_once", 0) + 1\nif builtins._once > 1:\n    raise ImportError("cannot load module more than once per process")\n';
  put(path.relative(pr, path.join(site, 'once', '__init__.py')), ONCE);
  put('helpers.py', 'WHO = "root"\n');
  put('rootonly.py', 'X = 1\n');
  put('model.py', `import cadquery as cq
from soma import add_part, component, place
import once, helpers
cab = component("Cabinet")
d1 = place(component("Drawer"), "back", cab, "slot")
d2 = place(component("Drawer"), "bottom", (1000, 0, 0))
assert helpers.WHO == "root", helpers.WHO
add_part("Cabinet", cab)
add_part("Drawer 1", d1)
add_part("Drawer 2", d2)
`);
  const drawer = `import cadquery as cq
from soma import add_part, anchor, param
import once, helpers
assert helpers.WHO == "drawer", helpers.WHO
try:
    import rootonly
    raise SystemExit("the drawer imported rootonly.py of the model around it")
except ImportError:
    pass
W = param(200.0, "Width")
add_part("Front", cq.Workplane().box(W, 10, 100).translate((0, 0, 50)))
add_part("Knob", cq.Workplane().box(20, 20, 20).translate((0, -15, 90)))
anchor("back", (0, 5, 0), normal=(0, 1, 0))
anchor("bottom", (0, 0, 0))
`;
  for (const dir of ['components/drawer', 'components/cabinet/components/drawer']) {
    put(`${dir}/model.py`, drawer);
    put(`${dir}/helpers.py`, 'WHO = "drawer"\n');
    put(`${dir}/component.json`, '{"name": "Drawer", "mode": "copy"}\n');
  }
  put('components/cabinet/model.py', `import cadquery as cq
from soma import add_part, anchor, component, place
import once, helpers
assert helpers.WHO == "cabinet", helpers.WHO
add_part("Shell", cq.Workplane().box(300, 300, 500).translate((0, 0, 250)))
anchor("slot", (0, 150, 100), normal=(0, -1, 0))
add_part("Inner", place(component("Drawer"), "back", "slot", flip=True))
assert helpers.WHO == "cabinet", helpers.WHO
`);
  put('components/cabinet/helpers.py', 'WHO = "cabinet"\n');
  put('components/cabinet/component.json', '{"name": "Cabinet", "mode": "copy"}\n');
  const b = py(['-m', 'soma', 'build', '--project', pr]);
  check('soma build: a package of .soma/env imported by the model and its (nested) components loads once, a component does not import the model\'s own modules',
    b.status === 0, (b.stdout + b.stderr).slice(-400));
  let parts = [];
  try { parts = JSON.parse(fs.readFileSync(path.join(pr, '.soma', 'model.map.json'), 'utf8')).parts; } catch { /* no build */ }
  const bb = (name) => parts.find((p) => p.name === name)?.bbox.map((c) => c.map(Math.round).join(',')).join(' ');
  check('place(): sideways anchors facing each other keep the drawer upright (turned about Z), a point target only moves it',
    bb('Knob') === '-10,120,180 10,140,200' && bb('Knob (Drawer 1)') === '-10,160,180 10,180,200' && bb('Knob (Drawer 2)') === '990,-25,80 1010,-5,100',
    `${bb('Knob')} | ${bb('Knob (Drawer 1)')} | ${bb('Knob (Drawer 2)')}`);

  // The export: plain CadQuery with soma blocked, the package in a .venv inside the folder
  const out = path.join(tmp, 'py-export');
  const ex = py(['-m', 'soma', 'cadquery', 'export', '--out', path.join(out, 'model.py'), '--project', pr]);
  const dir = path.join(out, 'model');
  fs.mkdirSync(path.join(dir, '.venv', 'Lib', 'site-packages', 'once'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.venv', 'pyvenv.cfg'), '');
  fs.writeFileSync(path.join(dir, '.venv', 'Lib', 'site-packages', 'once', '__init__.py'), ONCE);
  fs.writeFileSync(path.join(dir, 'bad.py'), fs.readFileSync(path.join(dir, 'model.py'), 'utf8').replace('component("Drawer"), "back"', 'component("Drawer", W="wide"), "back"'));
  const runExport = (file) => py(['-c', `import runpy, sys
sys.modules["soma"] = None
sys.path.insert(0, ".")
sys.path.append(".venv/Lib/site-packages")
runpy.run_path("${file}", run_name="export")
import soma_compat
d1 = next(p for p in soma_compat._SOMA_PARTS if p["name"] == "Drawer 1")
print("drawer 1", [round(v) for v in d1["shape"].loc.toTuple()[1]])
`], dir);
  const good = runExport('model.py'), bad = runExport('bad.py');
  check('Export as CadQuery with components: runs without soma, the package in .venv loads once, the drawer turned about Z',
    ex.status === 0 && good.stdout.includes('drawer 1 [0, 0, 180]'), ex.stderr + good.stdout + good.stderr.slice(-400));
  check('Export: a value of the wrong type for component() stops it as in SOMA', bad.status !== 0
    && bad.stderr.includes("component(..., W='wide'): the value is not a number"), bad.stderr.slice(-300));

  // Management: names without Latin letters, a model file in inputs/, the folder around the model, update of all
  const mg = path.join(tmp, 'py-manage'), m = path.join(mg, 'M');
  for (const d of ['src1', 'src2']) {
    fs.mkdirSync(path.join(mg, d), { recursive: true });
    fs.writeFileSync(path.join(mg, d, 'model.py'), 'import cadquery as cq\nfrom soma import add_part\nadd_part("A", cq.Workplane().box(1, 1, 1))\n');
  }
  fs.mkdirSync(path.join(m, 'inputs'), { recursive: true });
  fs.writeFileSync(path.join(m, 'model.py'), 'x = 1\n');
  fs.writeFileSync(path.join(mg, 'model.py'), 'x = 1\n');
  py(['-c', 'import sys, zipfile\nwith zipfile.ZipFile(sys.argv[1], "w") as z:\n    z.write(sys.argv[2], "model.py")', path.join(m, 'inputs', 'Cab.soma'), path.join(mg, 'src1', 'model.py')]);
  const comp = (...args) => py(['-m', 'soma', 'component', ...args, '--project', m], m);
  const a1 = comp('add', path.join(mg, 'src1'), '--name', '抽屉'), a2 = comp('add', path.join(mg, 'src2'), '--name', '柜子');
  const again = comp('add', path.join(mg, 'src2'), '--name', '柜子');
  const fromInputs = comp('add', 'inputs/Cab.soma', '--copy'), around = comp('add', mg);
  check('soma component add: names without Latin letters get folders component and component-2, the same name again is refused',
    a1.status === 0 && a2.status === 0 && a2.stdout.includes('components/component-2') && again.status === 1
    && again.stderr.includes("already a component '柜子' (components/component-2)"), a2.stdout + a2.stderr + again.stderr);
  check('soma component add: a model file in inputs/ is fine, the folder around the model is refused',
    fromInputs.status === 0 && around.status === 1 && around.stderr.includes('cannot contain itself'), fromInputs.stderr + around.stdout + around.stderr);
  fs.appendFileSync(path.join(mg, 'src1', 'model.py'), '# changed\n');
  fs.appendFileSync(path.join(mg, 'src2', 'model.py'), '# changed\n');
  fs.appendFileSync(path.join(m, 'components', 'component', 'model.py'), '# changed here\n');
  const up = comp('update');
  check('soma component update without a name: updates the others, names the one it cannot update, exit code 1',
    up.status === 1 && up.stdout.includes("Updated '柜子'") && up.stderr.includes("Not updated '抽屉'"), up.stdout + up.stderr);
}

try {
  writeOriginal(250);
  app = await startApp({ name: 'components' });
  const { ev, waitFor } = app;
  const shot = async (name) => {
    if (!process.env.SMOKE_SHOTS) return;
    fs.mkdirSync(path.join(APP, 'test', 'shots'), { recursive: true });
    await sleep(900);
    await app.screenshot(path.join(APP, 'test', 'shots', `${name}.png`)).catch((e) => console.log('Screenshot:', e.message));
  };
  await waitFor('model and build', () => !!window.__t && !!window.__t.project() && window.__t.status().state === 'ok' && window.__t.partCount() === 2);
  const proj = await ev(() => window.__t.project());
  const read = (rel) => { try { return fs.readFileSync(path.join(proj.dir, rel), 'utf8'); } catch { return null; } };
  const meta = () => JSON.parse(read('components/drawer/component.json') ?? '{}');

  // 1) Import of a .soma file: the app asks, "Linked" inserts it and adds it to model.py
  await app.answers([[zipFile], 0]);
  await app.domClick('btn-import');
  await waitFor('component inserted', () => document.getElementById('toast')?.textContent?.includes('Inserted “Drawer”'), 30000).catch(() => {});
  const toastText = await ev(() => document.getElementById('toast')?.textContent ?? '');
  check('Import of a .soma file, answer "Linked": the message names the linked component and model.py',
    toastText.includes('Inserted “Drawer” as a linked component') && toastText.includes('end of model.py'), toastText.slice(0, 140));
  check('components/drawer/ with model.py, parts/ and component.json (mode link), without .git and .soma',
    !!read('components/drawer/model.py') && !!read('components/drawer/parts/params.py') && meta().mode === 'link' && meta().name === 'Drawer'
    && !fs.existsSync(path.join(proj.dir, 'components', 'drawer', '.git')) && !fs.existsSync(path.join(proj.dir, 'components', 'drawer', '.soma')), JSON.stringify(meta()));
  check('model.py gets the import and add_part("Drawer", component("Drawer")) at its end',
    (read('model.py') ?? '').includes('from soma import component') && (read('model.py') ?? '').includes('add_part("Drawer", component("Drawer"))'));
  check('The file did not go to inputs/', !fs.existsSync(path.join(proj.dir, 'inputs', 'Drawer.soma')));
  await waitFor('model with component built', () => window.__t.status().state === 'ok' && window.__t.partCount() === 5, 90000).catch(() => {});
  check('Build: 2 own parts + 3 of the component', (await ev(() => window.__t.partCount())) === 5, JSON.stringify(await ev(() => window.__t.status())));

  // 2) Tree: the group of the instance carries the chain, the reference of the component stays a reference
  await ev(() => { window.__t.treeOpen(true); window.__t.treeExpandAll(); });
  await waitFor('state of the component in the tree', () => window.__t.tree().rows.some((r) => r.component === 'drawer' && r.compState === 'current'), 20000).catch(() => {});
  let tr = await ev(() => window.__t.tree());
  const inst = tr.rows.find((r) => r.name === 'Drawer' && r.group && r.component === 'drawer');
  check('Tree: group "Drawer" is marked as a linked component (up to date), no note at the top', !!inst && inst.compState === 'current' && !tr.note, JSON.stringify(inst) + tr.note);
  check('Tree: parts of the component with their groups, the rail under References',
    tr.names.includes('Box') && tr.names.includes('Handle') && tr.rows.some((r) => r.name === 'Body' && r.group) && tr.names.at(-1) === 'Rail', tr.names.join(','));
  await shot('components-1-tree');

  // 3) Two instances with their own width, placed side by side (the agent's way). The parameters of the component stay out of the panel
  const model = (read('model.py') ?? '').replace('add_part("Drawer", component("Drawer"))', `for i, w in enumerate((300.0, 450.0)):
    d = component("Drawer", WIDTH=w)
    d.loc = cq.Location((0, 400 * i, 120))
    add_part(f"Drawer {i + 1}", d, group="Drawers")
from soma import place  # noqa: E402
add_part("Drawer 3", place(component("Drawer"), "front", (1000, 0, 0)))`);
  fs.writeFileSync(path.join(proj.dir, 'model.py'), model);
  await waitFor('three instances built', () => window.__t.status().state === 'ok' && window.__t.partCount() === 11, 90000).catch(() => {});
  const map = JSON.parse(read('.soma/model.map.json') ?? '{"parts":[]}');
  const box1 = map.parts.find((p) => p.name === 'Box'), box2 = map.parts.find((p) => p.name === 'Box (Drawer 2)');
  const width = (p) => p ? Math.round(p.bbox[1][0] - p.bbox[0][0]) : null;
  check('Two instances: Box 300 mm and "Box (Drawer 2)" 450 mm wide, groups Drawers/Drawer 1 and 2',
    width(box1) === 300 && width(box2) === 450 && box1?.component_group === 'Drawers/Drawer 1' && box2?.component_group === 'Drawers/Drawer 2', `${width(box1)} ${width(box2)}`);
  const box3 = map.parts.find((p) => p.name === 'Box (Drawer 3)');
  check('place(): the anchor "front" of the third drawer sits on (1000, 0, 0)',
    !!box3 && box3.bbox[0].map(Math.round).join(',') === '850,0,0', JSON.stringify(box3?.bbox));
  const build = JSON.parse(read('.soma/build.json') ?? '{}');
  check('Parameters of the component are not in the panel of the model', !(build.params ?? []).some((p) => p.name === 'WIDTH' && p.file.startsWith('components')), (build.params ?? []).map((p) => p.name).join(','));

  // 4) The original changes: the tree says so, "Update" copies it in
  writeOriginal(320);
  await sleep(3200); // the check on focus waits 3 s between two checks
  await ev(() => window.dispatchEvent(new Event('focus')));
  await waitFor('note: original changed', () => window.__t.tree().note.includes('the original has changed'), 20000).catch(() => {});
  tr = await ev(() => window.__t.tree());
  check('Original changed: note at the top of the tree with Update, the instances yellow', tr.note.includes('Drawer: the original has changed') && tr.note.includes('Update')
    && tr.rows.filter((r) => r.component === 'drawer').every((r) => r.compState === 'outdated'), tr.note);
  await shot('components-2-outdated');
  await ev(() => document.querySelector('#tree .tr-upd').click());
  await waitFor('updated', () => !window.__t.tree().note, 30000).catch(() => {});
  check('Update takes over the original (DEPTH = 320), backup of the old state, note gone',
    (read('components/drawer/parts/params.py') ?? '').includes('DEPTH = 320') && fs.readdirSync(path.join(proj.dir, '.soma', 'component-backups')).filter((n) => !n.startsWith('.')).length === 1
    && (read('.soma/component-backups/.gitignore') ?? '').includes('*')
    && !(await ev(() => window.__t.tree().note)), read('components/drawer/parts/params.py'));
  await sleep(1500);
  await waitFor('build after the update', () => window.__t.status().state === 'ok', 60000);

  // 5) Changed in this model: the update asks first. Cancel keeps it, "Unlink" makes it a copy
  fs.appendFileSync(path.join(proj.dir, 'components', 'drawer', 'model.py'), '# changed here\n');
  writeOriginal(330);
  await sleep(3200);
  await ev(() => window.dispatchEvent(new Event('focus')));
  await waitFor('out of date again', () => window.__t.tree().note.includes('the original has changed'), 20000).catch(() => {});
  await app.answers([1]);
  await ev(() => document.querySelector('#tree .tr-upd').click());
  await sleep(1500);
  check('Changed here + Update, question answered Cancel: nothing replaced, still out of date',
    (read('components/drawer/model.py') ?? '').includes('# changed here') && (await ev(() => window.__t.tree().note)).includes('the original has changed'));
  const r = spawnSync(PY, ['-m', 'soma', 'component', 'list', '--project', proj.dir], { encoding: 'utf8' });
  check('Agent: soma component list names the state, the change here and the parameters',
    r.stdout.includes('OUT OF DATE') && r.stdout.includes('changed in this model') && r.stdout.includes('WIDTH = 300.0 mm')
    && r.stdout.includes('anchors: front'), r.stdout + r.stderr);
  await app.answers([0]);
  await ev(() => window.__t.unlinkComponent('Drawer'));
  await waitFor('copy', () => !window.__t.tree().note, 20000).catch(() => {});
  tr = await ev(() => window.__t.tree());
  check('Unlink: independent copy, note gone, the change stays', meta().mode === 'copy' && !tr.note && tr.rows.filter((x) => x.component === 'drawer').every((x) => x.compState === 'copy')
    && (read('components/drawer/model.py') ?? '').includes('# changed here'), JSON.stringify(meta()));

  // 6) Plain file instead of a component
  await app.answers([[zipFile], 2]);
  await app.domClick('btn-import');
  await waitFor('file in inputs', () => document.getElementById('toast')?.textContent?.includes('Added to inputs/'), 20000).catch(() => {});
  check('Answer "Add file to inputs/": the .soma file goes to inputs/ as a file', fs.existsSync(path.join(proj.dir, 'inputs', 'Drawer.soma')));

  // 7) Export as CadQuery: a folder with components/, runs with CadQuery alone, the placed drawer where it was in SOMA
  const exp = path.join(tmp, 'export', 'model.py');
  const ex = spawnSync(PY, ['-m', 'soma', 'cadquery', 'export', '--out', exp, '--project', proj.dir], { encoding: 'utf8' });
  const expDir = path.join(tmp, 'export', 'model'); // a model with components becomes a folder named like the file
  const run = spawnSync(PY, ['-c', `
import runpy, sys
sys.path.insert(0, ".")
runpy.run_path("model.py", run_name="export")
import soma_compat
parts = soma_compat._SOMA_PARTS
third = next(p for p in parts if p["name"] == "Drawer 3")
print(len(parts), [round(v) for v in third["shape"].loc.toTuple()[0]], "soma" in sys.modules)
`], { encoding: 'utf8', cwd: expDir });
  check('Export as CadQuery: components/drawer goes along, the export runs without soma (5 parts, Drawer 3 at x 1000, z 50)',
    ex.status === 0 && fs.existsSync(path.join(expDir, 'components', 'drawer', 'model.py'))
    && /^5 \[1000, \d+, 50\] False/m.test(run.stdout), ex.stdout + ex.stderr + run.stdout + run.stderr.slice(-400));

  // 8) A model folder as a component: its only part is named like the model (cq.Assembly would refuse it), anchors from a loop
  const knob = path.join(tmp, 'Knob');
  fs.mkdirSync(path.join(knob, '.soma'), { recursive: true });
  fs.writeFileSync(path.join(knob, '.soma', 'project.json'), '{"name": "Knob", "entry": "model.py"}');
  fs.writeFileSync(path.join(knob, 'model.py'), 'import cadquery as cq\nfrom soma import add_part, anchor\nadd_part("Knob", cq.Workplane().circle(15).extrude(20), group="Knob")\n'
    + 'for i in range(2):\n    anchor(f"pin {i + 1}", (0, 0, 20 * i))\n');
  await app.answers([[knob], 0]);
  await app.domClick('btn-import');
  await waitFor('folder inserted', () => document.getElementById('toast')?.textContent?.includes('Inserted “Knob”'), 30000).catch(() => {});
  await waitFor('built with the knob', () => window.__t.status().state === 'ok' && window.__t.partCount() === 12, 90000).catch(() => {});
  const map2 = JSON.parse(read('.soma/model.map.json') ?? '{"parts":[]}');
  const k = map2.parts.find((p) => p.name === 'Knob');
  const kl = spawnSync(PY, ['-m', 'soma', 'component', 'list', '--project', proj.dir], { encoding: 'utf8' });
  check('Model folder as a component: part "Knob" in the group Knob/Knob builds, anchors from a loop listed as "pin {i + 1}"',
    !!k && k.group === 'Knob/Knob' && kl.stdout.includes('anchors: pin {i + 1}'), JSON.stringify(k) + (await ev(() => JSON.stringify(window.__t.status()))));

  // 9) The original moves: "original not found", Find the original links it again
  const moved = path.join(tmp, 'moved');
  fs.mkdirSync(moved);
  fs.renameSync(knob, path.join(moved, 'Knob'));
  await sleep(3200);
  await ev(() => window.dispatchEvent(new Event('focus')));
  await waitFor('original missing', () => window.__t.tree().rows.some((r) => r.component === 'knob' && r.compState === 'missing'), 20000).catch(() => {});
  const missing = await ev(() => window.__t.tree().rows.some((r) => r.component === 'knob' && r.compState === 'missing'));
  await app.answers([path.join(moved, 'Knob')]);
  await ev(() => window.__t.relinkComponent('Knob'));
  await waitFor('linked again', () => window.__t.tree().rows.some((r) => r.component === 'knob' && r.compState === 'current'), 20000).catch(() => {});
  check('Moved original: marked missing, "Find the original" links it again (up to date)',
    missing && (await ev(() => window.__t.tree().rows.some((r) => r.component === 'knob' && r.compState === 'current'))), read('components/knob/component.json'));

  // 10) Right-click on a part of a component in the viewer: the menu has the component's entries too
  const partId = await ev(() => window.__t.parts().find((p) => p.component === 'drawer')?.id);
  await ev((id) => window.__t.partMenu(id), partId);
  const items = await ev(() => [...document.querySelectorAll('#menu-ctx .mi, #menu-ctx .mh')].map((b) => b.textContent));
  check('Viewer: right-click on a part of a component shows the component with Open the original and its files',
    items.some((x) => x.startsWith('Component “Drawer”')) && items.includes('Open the original') && items.includes('Show its files'), items.join(' | '));
  await ev(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

  // 11) Open the original: a SOMA window of its own opens the model file, this window keeps the assembly
  const lock = path.join(app.ud, 'open-models', '6f1d2c3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f.pid');
  await ev(() => window.__t.openOriginal('Drawer'));
  let other = 0;
  for (const t0 = Date.now(); !other && Date.now() - t0 < 60000; await sleep(500)) {
    try { other = Number(fs.readFileSync(lock, 'utf8')); } catch { /* not yet */ }
  }
  check('Open the original: another SOMA process opens "Drawer", this window keeps its model',
    other > 0 && (await ev(() => window.__t.project()?.id)) === proj.id, `pid ${other}`);
  // The same model in this window too: refused, the other window has it
  const twice = await ev(() => window.soma.project.open('6f1d2c3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f').then(() => 'opened', (e) => String(e.message)));
  check('The model open in the other window cannot be opened here as well', twice.includes('open in another SOMA window'), twice);
  if (other) {
    try { execFileSync(process.platform === 'win32' ? 'taskkill' : 'kill', process.platform === 'win32' ? ['/PID', String(other), '/T', '/F'] : ['-9', String(other)], { stdio: 'ignore' }); } catch { /* gone */ }
  }

  // 12) soma alone: modules and sys.path of components, upright anchors, the export, managing components
  pythonChecks();
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
