// Test für CadQuery rein und raus (E100). Ohne App: Kompatibilitätsmodus von `soma build` (show_object aus CQ-editor,
// ocp_vscode, result), „Export as CadQuery“ als eine Datei und als Ordner, das exportierte Skript läuft ohne soma (mit
// show_object wie in CQ-editor), der Import dreht den Export Zeichen für Zeichen zurück, ein veränderter Block bleibt
// stehen, nicht exportierbare Imports werden mit Zeile gemeldet. Dann in der echten App: „New from CadQuery script“ und
// „As CadQuery script“ im Export-Menü. Aufruf: npm run test:cadquery (baut vorher). SMOKE_VISIBLE=offscreen SMOKE_SHOTS=1
// legt ein Bild der Ladeanzeige in test/shots/ ab.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP, checker, cleanup, sleep, startApp } from './harness.mjs';

const t = checker();
const { check } = t;
let app;

const PY = process.env.SOMA_PYTHON || path.join(process.env.LOCALAPPDATA ?? '', 'soma-dev', 'venv', 'Scripts', 'python.exe');
const ENV = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
const soma = (args, cwd) => spawnSync(PY, ['-m', 'soma', ...args], { cwd, encoding: 'utf8', env: ENV, windowsHide: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-cq-'));
const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true }); fs.writeFileSync(path.join(work, rel), text); };
const read = (rel) => fs.readFileSync(path.join(work, rel), 'utf8');
const mapOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.soma', 'model.map.json'), 'utf8'));
const buildOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, '.soma', 'build.json'), 'utf8'));

// Läuft ein exportiertes Skript wie CQ-editor: show_object vorgegeben, soma gesperrt. Gibt die gezeigten Teile als JSON aus
const RUNNER = String.raw`
import json, runpy, sys
sys.modules["soma"] = None
shown = []
def show_object(o, name=None, options=None):
    bb = o.BoundingBox()
    shown.append(dict(name=name, x=round(bb.xlen, 3), color=[round(c, 3) for c in options["color"]], alpha=options["alpha"]))
ns = runpy.run_path(sys.argv[1], init_globals={"show_object": show_object})
print(json.dumps(dict(shown=shown, result=type(ns.get("result")).__name__)))
`;
const runExported = (file) => {
  const r = spawnSync(PY, ['-c', RUNNER, file], { cwd: path.dirname(file), encoding: 'utf8', env: ENV, windowsHide: true });
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { error: (r.stderr || r.stdout).slice(-400) }; }
};

const SOMA_MODEL = `"""Platte mit Schraube."""
import cadquery as cq
from soma import add_part, param  # API
from soma.fasteners import (
    Screw,
    Nut as N,
)

L = param(60.0, "Length", min=30, max=200, unit="mm")
plate = cq.Workplane().box(L, 20, 4)
s = Screw("ISO 4762", "M3x10", at=(0, 0, 2))
add_part("Plate", plate.cut(s.clearance_hole()), color=(0.2, 0.4, 0.8), group="Base")
add_part("Screw", s, group="Base/Hardware")
add_part("Nut", N("ISO 4032", "M3", at=(10, 0, -2)))
`;

try {
  // 1) Kompatibilitätsmodus: drei Arten fremder Skripte
  write('cqe/model.py', `import cadquery as cq
box = cq.Workplane().box(10, 10, 10)
cyl = cq.Workplane().cylinder(20, 3)
show_object(box, name="Box", options={"color": (255, 0, 0), "alpha": 0.5})
show_object(cyl, options={"color": "steelblue"})
debug(cyl)
`);
  write('ocp/model.py', `import cadquery as cq
from ocp_vscode import show, set_port, Camera
set_port(3939)
plate = cq.Workplane().box(30, 20, 2)
show(plate, cq.Workplane().sphere(4), names=["Plate"], colors=["#00ff00"], reset_camera=Camera.RESET)
`);
  write('res/model.py', 'import cadquery as cq\nresult = cq.Workplane().box(5, 5, 5)\n');
  write('none/model.py', 'import cadquery as cq\nx = 1\n');
  write('mixed/model.py', 'import cadquery as cq\nfrom soma import add_part\nadd_part("A", cq.Workplane().box(1, 1, 1))\nshow_object(cq.Workplane().box(2, 2, 2), name="B")\n');
  // Wie viele Skripte für CQ-editor: fragen globals() ab und exportieren sonst selbst, die Teile stecken in einer Baugruppe
  write('glob/model.py', `from pathlib import Path
import cadquery as cq
blade = cq.Workplane().box(50, 10, 1)
handle = cq.Workplane().box(10, 10, 20).translate((-30, 0, 0))
saw = (cq.Assembly(name="saw").add(blade, name="blade", color=cq.Color(0.75, 0.77, 0.80))
       .add(handle, name="handle", color=cq.Color(0.55, 0.33, 0.15)))
result = blade.union(handle)
if "show_object" in globals():
    show_object(saw, name="saw")
elif __name__ == "__main__":
    saw.export(str(Path(__file__).with_name("saw.step")))
`);
  for (const d of ['cqe', 'ocp', 'res', 'none', 'mixed', 'glob']) soma(['build', '--project', path.join(work, d)], path.join(work, d));
  const m1 = mapOf(path.join(work, 'cqe')), b1 = buildOf(path.join(work, 'cqe'));
  check('CQ-editor: show_object mit Name, sonst Variablenname, Zeile des Aufrufs, debug() fällt weg',
    b1.status === 'ok' && JSON.stringify(m1.parts.map((p) => [p.name, p.line])) === '[["Box",4],["cyl",5]]', JSON.stringify(m1.parts.map((p) => [p.name, p.line])));
  check('Warnung „Compatibility mode“ mit Verweis auf den Skill', b1.warnings.some((w) => w.startsWith('Compatibility mode') && w.includes('cadquery-scripts.md')), b1.warnings.join(' | '));
  const m2 = mapOf(path.join(work, 'ocp'));
  check('ocp_vscode: show() mit names, ohne Namen „Part 2“, set_port und Camera ohne Wirkung',
    buildOf(path.join(work, 'ocp')).status === 'ok' && JSON.stringify(m2.parts.map((p) => p.name)) === '["Plate","Part 2"]', JSON.stringify(m2.parts.map((p) => p.name)));
  check('Nur result: ein Teil „result“', buildOf(path.join(work, 'res')).status === 'ok' && mapOf(path.join(work, 'res')).parts.map((p) => p.name).join() === 'result');
  const m6 = mapOf(path.join(work, 'glob'));
  check('`if "show_object" in globals()`: Baugruppe als Teile mit Gruppe, kein eigener Export des Skripts, nicht result',
    JSON.stringify(m6.parts.map((p) => [p.name, p.group])) === '[["blade","saw"],["handle","saw"]]' && !fs.existsSync(path.join(work, 'glob', 'saw.step')),
    JSON.stringify(m6.parts.map((p) => [p.name, p.group])));
  const b4 = buildOf(path.join(work, 'none'));
  check('Ohne alles: Fehler NoParts mit Hinweis auf show_object und result', b4.status === 'error' && b4.error.kind === 'NoParts' && b4.error.message.includes('show_object'), b4.error?.message);
  const b5 = buildOf(path.join(work, 'mixed'));
  check('add_part und show_object gemischt: nur add_part zählt, keine Warnung', b5.status === 'ok' && mapOf(path.join(work, 'mixed')).parts.map((p) => p.name).join() === 'A'
    && !b5.warnings.some((w) => w.startsWith('Compatibility')), JSON.stringify(b5.warnings));

  // 2) Export als eine Datei, Lauf ohne soma, Rückweg
  write('src/model.py', SOMA_MODEL);
  write('src/parameters.json', JSON.stringify({ note: 'x', values: { L: 80 } }, null, 2));
  write('src/inputs/board.step', 'ISO-10303-21;\n');
  const ex = soma(['cadquery', 'export', '--out', path.join(work, 'out', 'plate.py'), '--project', path.join(work, 'src'), '--json'], work);
  const exr = JSON.parse(ex.stdout.trim().split('\n').pop() || '{}');
  const txt = fs.existsSync(path.join(work, 'out', 'plate.py')) ? read('out/plate.py') : '';
  check('Export: eine Datei, Originalimporte als # soma-import, Block mit Prüfsumme, Fußblock, Werte des Panels',
    exr.status === 'ok' && exr.mode === 'single' && txt.includes('# soma-import: from soma import add_part, param  # API') && txt.includes('# soma-import:     Nut as N,')
    && /# soma-checksum: [0-9a-f]{16}/.test(txt) && txt.includes("_SOMA_VALUES = {'L': 80}") && txt.includes('# >>> soma-compat footer') && txt.includes('SPDX-License-Identifier: Apache-2.0'),
    ex.stderr.slice(-300));
  check('Der Modellcode dazwischen bleibt Zeichen für Zeichen gleich', txt.includes(SOMA_MODEL.split('\n').slice(8).join('\n').trimEnd()));
  check('inputs/ wird nur kopiert, wenn das Skript es nutzt (hier nicht)', !fs.existsSync(path.join(work, 'out', 'inputs')));
  const run = runExported(path.join(work, 'out', 'plate.py'));
  check('Exportiertes Skript läuft ohne soma: show_object je Teil mit Farbe, param() liefert den Wert aus dem Panel (80)',
    run.shown?.length === 3 && run.shown[0].name === 'Plate' && run.shown[0].x === 80 && JSON.stringify(run.shown[0].color) === '[0.2,0.4,0.8]'
    && run.shown[1].name === 'Screw' && run.shown[2].name === 'Nut' && run.result === 'Assembly', JSON.stringify(run).slice(0, 300));
  write('asis/model.py', txt);
  const b6 = soma(['build', '--project', path.join(work, 'asis')], path.join(work, 'asis'));
  check('Unverändert in SOMA gebaut: Kompatibilitätsmodus über den Fußblock, drei Teile', b6.status === 0 && b6.stdout.includes('3 part(s)'), (b6.stdout + b6.stderr).slice(-300));

  fs.mkdirSync(path.join(work, 'back'));
  const im = soma(['cadquery', 'import', path.join(work, 'out', 'plate.py'), '--project', path.join(work, 'back'), '--json'], work);
  const imr = JSON.parse(im.stdout.trim().split('\n').pop() || '{}');
  check('Import dreht den Export zurück: model.py gleich dem Original, Werte in parameters.json, Original in inputs/',
    imr.mode === 'soma' && read('back/model.py') === SOMA_MODEL && JSON.parse(read('back/parameters.json')).values.L === 80 && fs.existsSync(path.join(work, 'back', 'inputs', 'plate.py')),
    JSON.stringify(imr));
  write('back/model.py', SOMA_MODEL + '# geaendert\n');
  const im2 = soma(['cadquery', 'import', path.join(work, 'out', 'plate.py'), '--project', path.join(work, 'back')], work);
  check('Ein zweiter Import ersetzt nichts ohne --backup', im2.status === 1 && im2.stderr.includes('already exists'), im2.stderr);

  // 3) Veränderter Block bleibt stehen, nur _SOMA_VALUES darf sich ändern
  write('tamper/a.py', txt.replace("_SOMA_VALUES = {'L': 80}", "_SOMA_VALUES = {'L': 90}"));
  write('tamper/b.py', txt.replace('def _soma_path(path):', 'def _soma_path(path):  # geaendert'));
  fs.mkdirSync(path.join(work, 'ta')); fs.mkdirSync(path.join(work, 'tb'));
  const ta = JSON.parse(soma(['cadquery', 'import', path.join(work, 'tamper', 'a.py'), '--project', path.join(work, 'ta'), '--json'], work).stdout.trim().split('\n').pop());
  const tb = JSON.parse(soma(['cadquery', 'import', path.join(work, 'tamper', 'b.py'), '--project', path.join(work, 'tb'), '--json'], work).stdout.trim().split('\n').pop());
  check('Geänderter Wert in _SOMA_VALUES: Import gelingt, neuer Wert in parameters.json', ta.mode === 'soma' && JSON.parse(read('ta/parameters.json')).values.L === 90);
  check('Geänderter Block: Skript bleibt, wie es ist, mit Hinweis', tb.mode === 'cadquery' && read('tb/model.py') === read('tamper/b.py')
    && tb.warnings.some((w) => w.includes('was changed')), JSON.stringify(tb.warnings));

  // 4) Modell mit parts/: Ordner mit soma_compat.py, Rückweg
  write('multi/model.py', 'import cadquery as cq\nfrom soma import add_part\nfrom parts.lid import make_lid\nadd_part("Lid", make_lid())\nadd_part("Box", cq.Workplane().box(10, 10, 10))\n');
  write('multi/parts/lid.py', 'import cadquery as cq\nfrom soma import param\nW = param(12.0, "Width")\n\n\ndef make_lid():\n    return cq.Workplane().box(W, W, 1).translate((0, 0, 6))\n');
  write('multi/parameters.json', JSON.stringify({ values: { W: 14 } }));
  const fx = JSON.parse(soma(['cadquery', 'export', '--out', path.join(work, 'mout', 'multi.py'), '--project', path.join(work, 'multi'), '--json'], work).stdout.trim().split('\n').pop());
  const mdir = path.join(work, 'mout', 'multi');
  check('Mit parts/: Ordner mit model.py, parts/lid.py und soma_compat.py', fx.mode === 'folder' && ['model.py', 'parts/lid.py', 'soma_compat.py'].every((f) => fs.existsSync(path.join(mdir, f)))
    && fs.readFileSync(path.join(mdir, 'parts', 'lid.py'), 'utf8').includes('from soma_compat import param  # soma-compat'), JSON.stringify(fx));
  const mrun = runExported(path.join(mdir, 'model.py'));
  check('Ordner läuft ohne soma, Wert W = 14 aus dem Panel', mrun.shown?.length === 2 && mrun.shown[0].name === 'Lid' && mrun.shown[0].x === 14, JSON.stringify(mrun).slice(0, 300));
  fs.mkdirSync(path.join(work, 'mback'));
  const mi = JSON.parse(soma(['cadquery', 'import', path.join(mdir, 'model.py'), '--project', path.join(work, 'mback'), '--json'], work).stdout.trim().split('\n').pop());
  check('Ordner zurück: model.py und parts/lid.py wie im Original, kein soma_compat.py, W in parameters.json',
    mi.mode === 'soma' && read('mback/model.py') === read('multi/model.py') && read('mback/parts/lid.py') === read('multi/parts/lid.py')
    && !fs.existsSync(path.join(work, 'mback', 'soma_compat.py')) && JSON.parse(read('mback/parameters.json')).values.W === 14, JSON.stringify(mi));

  // 4b) Namen, die cq.Assembly ablehnt: Teil wie seine Gruppe, Teil wie eine Gruppe daneben, Teil wie die Wurzel
  write('names/model.py', `import cadquery as cq
from soma import add_part
add_part("X beam", cq.Workplane().box(100, 10, 10), group="X beam")
add_part("Y beam", cq.Workplane().box(10, 100, 10), group="Frame")
add_part("Frame", cq.Workplane().box(5, 5, 5))
add_part("Model", cq.Workplane().box(3, 3, 3))
`);
  soma(['cadquery', 'export', '--out', path.join(work, 'names-out', 'names.py'), '--project', path.join(work, 'names')], work);
  const nrun = runExported(path.join(work, 'names-out', 'names.py'));
  check('Gleiche Namen von Teil und Gruppe: Export läuft, show_object behält die Namen aus add_part',
    JSON.stringify(nrun.shown?.map((x) => x.name)) === '["X beam","Y beam","Frame","Model"]' && nrun.result === 'Assembly', JSON.stringify(nrun).slice(0, 300));

  // 5) Was sich nicht exportieren lässt, wird mit Zeile gemeldet
  write('bad1/model.py', 'import cadquery as cq\nimport soma\nsoma.add_part("A", cq.Workplane().box(1, 1, 1))\n');
  write('bad2/model.py', 'import cadquery as cq\nfrom soma import add_part\nfrom soma.anim import Animation\n');
  const e1 = soma(['cadquery', 'export', '--out', path.join(work, 'x1.py'), '--project', path.join(work, 'bad1')], work);
  const e2 = soma(['cadquery', 'export', '--out', path.join(work, 'x2.py'), '--project', path.join(work, 'bad2')], work);
  check('`import soma` und soma.anim: Fehler mit Zeile, keine Datei', e1.status === 1 && e1.stderr.includes('line 2') && e2.status === 1 && e2.stderr.includes('soma.anim')
    && !fs.existsSync(path.join(work, 'x1.py')) && !fs.existsSync(path.join(work, 'x2.py')), e1.stderr + e2.stderr);

  // 6) In der App: neues Modell aus einem CadQuery-Skript, Export über das Menü
  app = await startApp({ name: 'cadquery' });
  const { ev, waitFor, ud } = app;
  await waitFor('Projekt und Build', () => !!window.__t && !!window.__t.project() && window.__t.status().state === 'ok');
  const first = await ev(() => window.__t.project());
  await app.answers([path.join(work, 'cqe', 'model.py')]);
  const nr = await ev(() => window.__t.newFromCadQuery());
  await waitFor('neues Modell gebaut', (old) => window.__t.project().id !== old && window.__t.status().state === 'ok', 120000, first.id).catch(() => {});
  const p2 = await ev(() => window.__t.project());
  const w2 = buildOf(p2.dir).warnings ?? [];
  check('New from CadQuery script: neues Modell mit dem Namen der Datei, Teile aus show_object, Warnung im Build',
    !nr?.error && p2.id !== first.id && p2.name === 'model' && JSON.stringify(await ev(() => window.__t.treeNames())) === '["Box","cyl"]'
    && w2.some((w) => w.startsWith('Compatibility mode')), `${p2.name} ${JSON.stringify(w2)}`);
  check('Skript unverändert als model.py, Original in inputs/, Vorlage in workspace-backups/, Skill im Modell',
    fs.readFileSync(path.join(p2.dir, 'model.py'), 'utf8') === read('cqe/model.py') && fs.existsSync(path.join(p2.dir, 'inputs', 'model.py'))
    && fs.existsSync(path.join(ud, 'workspace-backups', `${p2.id}-import`, 'model.py')) && fs.existsSync(path.join(p2.dir, '.soma', 'skills', 'cadquery-scripts.md')));
  check('Erster Stand im Verlauf enthält das Skript', (await ev(() => window.soma.versions.log())).commits?.length >= 1);

  await app.answers([path.join(work, 'appout.py')]);
  const er = await ev(() => window.__t.exportCadQuery());
  check('As CadQuery script: Datei am gewählten Ort, ohne soma-Imports unverändert (fremdes Skript)', er.ok && fs.existsSync(path.join(work, 'appout.py'))
    && read('appout.py') === read('cqe/model.py'), JSON.stringify(er));
  await app.answers([null]);
  check('Abbrechen im Dateidialog: nichts passiert', (await ev(() => window.__t.newFromCadQuery()))?.cancelled === true && (await ev(() => window.__t.project())).id === p2.id);
  const count = (await ev(() => window.soma.project.list())).length;
  await app.answers([path.join(work, 'missing.py')]);
  const br = await ev(() => window.__t.newFromCadQuery());
  check('Datei fehlt: Meldung, kein neues Modell, kein halber Ordner', !!br?.error && br.error.includes('not a Python file') && (await ev(() => window.__t.project())).id === p2.id
    && (await ev(() => window.soma.project.list())).length === count, JSON.stringify(br));
  // Ein Skript mit Syntaxfehler kommt trotzdem herein: Der Build meldet den Fehler mit Zeile, der Agent kann ihn beheben
  write('broken/broken.py', 'import cadquery as cq\ndef (:\n');
  await app.answers([path.join(work, 'broken', 'broken.py')]);
  const bk = await ev(() => window.__t.newFromCadQuery());
  await waitFor('Build mit Fehler', (old) => window.__t.project().id !== old && window.__t.status().state === 'error', 120000, p2.id).catch(() => {});
  const p3 = await ev(() => window.__t.project());
  const e3 = p3.id !== p2.id ? buildOf(p3.dir).error : null;
  check('Syntaxfehler: Modell entsteht, der Build meldet Datei und Zeile', !bk?.error && e3?.file === 'model.py' && e3?.line === 2, JSON.stringify(e3 ?? bk));

  // Eintrag im Pfeil-Menü von „New model“ auf der Startseite
  await ev(() => window.__t.showStart(true));
  await app.answers([path.join(work, 'res', 'model.py')]);
  await app.domClick('start-new-cq');
  await waitFor('Ladeanzeige', () => !window.__t.cqBusy().hidden, 30000).catch(() => {});
  const busy = await ev(() => window.__t.cqBusy());
  if (process.env.SMOKE_SHOTS && !busy.hidden) {
    fs.mkdirSync(path.join(APP, 'test', 'shots'), { recursive: true });
    await sleep(300);
    await app.screenshot(path.join(APP, 'test', 'shots', 'cadquery-busy.png')).catch((e) => console.log('Screenshot:', e.message));
  }
  check('Ladeanzeige über der Startseite: Titel, Schritt und Dateiname', !busy.hidden && busy.text.includes('Loading CadQuery script')
    && busy.text.includes('model.py') && /Reading the script|Building the model|Opening the model/.test(busy.text), JSON.stringify(busy));
  await waitFor('Modell von der Startseite', (old) => window.__t.project().id !== old && window.__t.status().state === 'ok'
    && document.getElementById('start').hidden, 120000, p3.id).catch(() => {});
  check('Startseite: „New from CadQuery script“ legt das Modell an und schließt die Startseite',
    (await ev(() => window.__t.project())).id !== p3.id && JSON.stringify(await ev(() => window.__t.treeNames())) === '["result"]'
    && await ev(() => document.getElementById('start').hidden) && (await ev(() => window.__t.cqBusy())).hidden, JSON.stringify(await ev(() => window.__t.treeNames())));
} catch (e) {
  check('Unerwarteter Fehler', false, e instanceof Error ? e.stack : String(e));
} finally {
  if (app) { await app.stop(); cleanup(app.ud); }
  cleanup(work);
}
process.exit(t.fails ? 1 : 0);
