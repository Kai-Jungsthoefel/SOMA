// Test der Dateiansicht: Ein Klick auf eine STEP-Datei im Dateibaum zeigt sie im Viewer (Basismodus, Cache nach Inhalt),
// mit Banner, Messen, Schnitt und Explosion. Ein Build des Modells ersetzt sie nicht, eine Änderung der Datei lädt neu,
// „Back to model“ kehrt zurück. Dazu Zusammenspiel mit der Versionsvorschau und Störfälle (kaputte, leere Datei, außerhalb).
// Aufruf: npm run test:stepview (baut vorher). SMOKE_VISIBLE=offscreen SMOKE_SHOTS=1 legt Bilder in test/shots/ ab.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP, checker, cleanup, sleep, startApp } from './harness.mjs';

const t = checker();
const { check } = t;
let app;
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-sv-'));

// Platte und Block wie im Messtest, dazu später ein Stift: So unterscheidet sich das Modell von den STEP-Dateien
const MODEL = (pin) => `import cadquery as cq
from soma import add_part

plate = (cq.Workplane("XY").box(40, 30, 5, centered=(True, True, False))
         .faces(">Z").workplane().pushPoints([(-10, 0), (10, 0)]).hole(6))
block = cq.Workplane("XY").box(20, 20, 5, centered=(True, True, False)).translate((45, 0, 15))

add_part("Platte", plate)
add_part("Block", block, color=(0.85, 0.55, 0.25))
${pin ? 'add_part("Stift", cq.Workplane("XY").circle(2).extrude(30).translate((-45, 0, 0)))' : ''}
`;

try {
  app = await startApp({ name: 'stepview' });
  const { ev, waitFor, domClick, page, ud } = app;
  const shot = async (name) => {
    if (!process.env.SMOKE_SHOTS) return;
    fs.mkdirSync(path.join(APP, 'test', 'shots'), { recursive: true });
    await sleep(900);
    await app.screenshot(path.join(APP, 'test', 'shots', `${name}.png`)).catch((e) => console.log('Screenshot:', e.message));
  };
  await waitFor('Projekt und Build', () => !!window.__t && !!window.__t.project() && window.__t.status().state === 'ok' && window.__t.partCount() === 2);
  const proj = await ev(() => window.__t.project());
  const dir = proj.dir;
  const inputs = path.join(dir, 'inputs');
  fs.mkdirSync(inputs, { recursive: true });
  // Die STEP-Datei des Vorlagenmodells (Body, Lid) wird zur fremden Datei im Projekt
  fs.copyFileSync(path.join(dir, 'output', 'model.step'), path.join(inputs, 'box.step'));
  fs.writeFileSync(path.join(inputs, 'broken.step'), 'ISO-10303-21;\nHEADER;\nthis is not a STEP file\n');
  fs.writeFileSync(path.join(inputs, 'empty.stp'), '');
  fs.writeFileSync(path.join(dir, 'model.py'), MODEL(false));
  await waitFor('Testmodell gebaut', () => window.__t.status().state === 'ok' && JSON.stringify(window.__t.treeNames()) === '["Platte","Block"]', 60000);
  const plateStep = path.join(workDir, 'platte.step');
  fs.copyFileSync(path.join(dir, 'output', 'model.step'), plateStep);

  const fv = () => ev(() => window.__t.fileView());
  const names = () => ev(() => JSON.stringify(window.__t.treeNames()));
  const clickRow = (rel) => ev((r) => { const row = document.querySelector(`#tab-files .frow[data-path="${CSS.escape(r)}"]`); row?.click(); return !!row; }, rel);
  const cacheRoot = path.join(ud, 'previews', proj.id, 'files');

  // 1) Klick im Dateibaum öffnet die Datei im Viewer
  await ev(() => window.__t.showPanel('files'));
  await ev(() => window.__t.revealFile('inputs/box.step'));
  await waitFor('Datei im Dateibaum', () => window.__t.fileRows().includes('box.step'), 20000).catch(() => {});
  check('STEP-Datei steht im Dateibaum', await clickRow('inputs/box.step'));
  await waitFor('Datei im Viewer', () => window.__t.fileView().rel === 'inputs/box.step' && JSON.stringify(window.__t.treeNames()) === '["Body","Lid"]', 90000).catch(() => {});
  let f = await fv();
  check('Klick auf box.step: Viewer zeigt die Teile der Datei (Body, Lid)', f.rel === 'inputs/box.step' && await names() === '["Body","Lid"]', `${JSON.stringify(f)} ${await names()}`);
  check('Banner „Viewing inputs/box.step“ mit Teilezahl und „Back to model“, violetter Rahmen', !!f.banner && f.banner.includes('Viewing inputs/box.step')
    && f.banner.includes('2 parts') && f.banner.includes('Back to model') && f.frame, f.banner ?? '');
  check('Kein Banner der Versionsvorschau', (await ev(() => window.__t.banner())).hidden && !(await ev(() => window.__t.versions())).previewing);
  check('Ladeanzeige ist wieder weg', await ev(() => document.getElementById('viewer-busy').hidden));
  check('Baum trägt den Dateinamen als Titel', await ev(() => document.getElementById('tree').textContent.includes('box.step')));
  const key1 = f.key;
  check('Cache nach Inhalt: previews/<Projekt>/files/<SHA-1> mit GLB, Zuordnung und Geometrie, kein Arbeitsordner übrig',
    /^[0-9a-f]{40}$/.test(key1 ?? '') && fs.existsSync(path.join(cacheRoot, key1, 'model.glb')) && fs.existsSync(path.join(cacheRoot, key1, 'geometry'))
    && !fs.readdirSync(cacheRoot).some((n) => n.startsWith('.tmp-')), fs.existsSync(cacheRoot) ? fs.readdirSync(cacheRoot).join(',') : 'kein Cache');
  const parts = await ev(() => window.__t.parts());
  check('Teile im Basismodus (Rolle „basic“), ohne Code zum Bauteil', parts.length === 2 && parts.every((p) => p.role === 'basic'), JSON.stringify(parts).slice(0, 160));
  await ev(() => window.__t.viewer.setView('iso'));
  await shot('stepview-1');

  // 2) Ein Build des Modells ersetzt die Ansicht nicht
  const mapFile = path.join(dir, '.soma', 'model.map.json');
  const buildId = () => { try { return JSON.parse(fs.readFileSync(mapFile, 'utf8')).build; } catch { return null; } };
  const before = buildId();
  fs.writeFileSync(path.join(dir, 'model.py'), MODEL(true));
  const t0 = Date.now();
  while (buildId() === before && Date.now() - t0 < 60000) await sleep(300);
  await waitFor('Build fertig', () => window.__t.status().state === 'ok', 60000).catch(() => {});
  await sleep(800);
  check('Neuer Build des Modells (mit Stift) während der Ansicht: Viewer bleibt bei der Datei', buildId() !== before && await names() === '["Body","Lid"]'
    && (await fv()).rel === 'inputs/box.step', await names());

  // 3) Messen in der Datei: Oberseite des Deckels (60 × 40, Radius 4 in den Ecken)
  await ev(() => window.__t.viewer.setView('iso'));
  await sleep(300);
  await domClick('btn-measure');
  const lidTop = await ev((pid) => {
    const fc = window.__t.viewer.facesOf(pid).filter((x) => x.surface === 'PLANE').sort((a, b) => b.center[2] - a.center[2])[0];
    return { id: fc.id, screen: window.__t.viewer.screenOf(pid, fc.id) };
  }, await ev(() => window.__t.parts().find((p) => p.name === 'Lid').id));
  await page.click(lidTop.screen.x, lidTop.screen.y);
  await waitFor('Messergebnis', () => !!window.__t.measure().result || !!window.__t.measure().error, 90000).catch(() => {});
  let m = await ev(() => window.__t.measure());
  check('Messen in der Datei: Oberseite des Deckels, exakte Fläche', m.result?.a.type === 'PLANE' && Math.abs(m.result.a.area - (60 * 40 - (4 - Math.PI) * 16)) < 1e-6,
    m.error || `${m.result?.a.area}`);
  await shot('stepview-2-messen');
  await domClick('btn-measure');

  // 4) Schnitt und Explosion
  await domClick('btn-section');
  await sleep(300);
  const sec = await ev(() => ({ s: window.__t.section(), v: window.__t.viewer.sectionState() }));
  check('Schnitt in der Datei: beide Teile geschnitten und gedeckelt', sec.s.active && sec.v.clipped && sec.v.capped.length === 2, JSON.stringify(sec.v).slice(0, 160));
  await shot('stepview-3-schnitt');
  await domClick('btn-section');
  await domClick('btn-explode');
  await waitFor('Explosion steht', () => window.__t.explode().active && !window.__t.explode().animating, 30000).catch(() => {});
  const ex = await ev(() => window.__t.explode());
  check('Explosion in der Datei: aktiv, Teile auseinander', ex.active && Object.keys(ex.spreads).length > 0, JSON.stringify(ex.spreads).slice(0, 120));
  await domClick('btn-explode');

  // 5) Auswahl für den Agenten nennt die Datei
  const lidId = await ev(() => window.__t.parts().find((p) => p.name === 'Lid').id);
  await page.click(lidTop.screen.x, lidTop.screen.y);
  await waitFor('Auswahl', () => window.__t.info().startsWith('Lid'), 5000).catch(() => {});
  const selText = await ev(() => window.__t.selectionText());
  check('Text für den Agenten nennt die STEP-Datei', (selText ?? '').includes('in the STEP file inputs/box.step'), `${selText} (${lidId})`);

  // 6) Datei ändert sich auf der Platte: neu laden, Ansicht bleibt offen
  fs.copyFileSync(plateStep, path.join(inputs, 'box.step'));
  await waitFor('Datei neu geladen', () => JSON.stringify(window.__t.treeNames()) === '["Platte","Block"]' && window.__t.fileView().rel === 'inputs/box.step', 90000).catch(() => {});
  f = await fv();
  check('Geänderte Datei wird neu geladen (jetzt Platte und Block), neuer Schlüssel, Hinweis', f.key !== key1 && await names() === '["Platte","Block"]'
    && (await ev(() => window.__t.toast().text)).includes('changed on disk'), `${await names()} ${(await ev(() => window.__t.toast().text))}`);

  // 7) Zurück zum Modell: jetzt mit dem Stift aus dem Build während der Ansicht
  await domClick('btn-file-back');
  await waitFor('Modell wieder da', () => JSON.stringify(window.__t.treeNames()) === '["Platte","Block","Stift"]', 30000).catch(() => {});
  f = await fv();
  check('„Back to model“: Banner und Rahmen weg, Viewer zeigt das aktuelle Modell (mit Stift)', !f.rel && !f.banner && !f.frame && await names() === '["Platte","Block","Stift"]', await names());
  check('Baum trägt wieder den Modellnamen', await ev(() => !document.getElementById('tree').textContent.includes('box.step')));

  // 8) Zusammenspiel mit der Versionsvorschau: eins schließt das andere
  await clickRow('inputs/box.step');
  await waitFor('Datei im Viewer', () => window.__t.fileView().rel === 'inputs/box.step' && !window.__t.fileView().loading, 60000).catch(() => {});
  await ev(() => document.querySelectorAll('#vdots .vdot')[0].click());
  await waitFor('Vorschau', () => !!window.__t.versions().previewing, 60000).catch(() => {});
  f = await fv();
  check('Version gewählt während der Dateiansicht: Vorschau läuft, Dateiansicht beendet', !!(await ev(() => window.__t.versions())).previewing && !f.rel && !f.banner
    && !(await ev(() => window.__t.banner())).hidden, JSON.stringify(f));
  await clickRow('inputs/box.step');
  await waitFor('Datei im Viewer', () => window.__t.fileView().rel === 'inputs/box.step' && !window.__t.fileView().loading, 60000).catch(() => {});
  check('Datei geöffnet während der Vorschau: Vorschau beendet, nur noch das Banner der Datei', !(await ev(() => window.__t.versions())).previewing
    && (await ev(() => window.__t.banner())).hidden && !!(await fv()).banner && await ev(() => !document.getElementById('viewer').classList.contains('preview')));
  await domClick('btn-file-back');
  await waitFor('Modell wieder da', () => JSON.stringify(window.__t.treeNames()) === '["Platte","Block","Stift"]', 30000).catch(() => {});

  // 9) Störfälle: kaputte und leere Datei, Pfade außerhalb, andere Dateitypen
  await clickRow('inputs/broken.step');
  await waitFor('Fehlermeldung', () => /broken\.step cannot be shown/.test(window.__t.toast().text) && !window.__t.fileView().loading, 60000).catch(() => {});
  let toastText = await ev(() => window.__t.toast());
  check('Kaputte STEP-Datei: verständliche Meldung, Viewer bleibt beim Modell', toastText.error && toastText.text.includes('not a valid STEP file') && !(await fv()).rel
    && await names() === '["Platte","Block","Stift"]', toastText.text);
  await clickRow('inputs/empty.stp');
  await waitFor('Fehlermeldung', () => /empty\.stp cannot be shown/.test(window.__t.toast().text), 20000).catch(() => {});
  toastText = await ev(() => window.__t.toast());
  check('Leere Datei: „The file is empty.“', toastText.text.includes('The file is empty.'), toastText.text);
  check('Kein halber Cache-Ordner nach den Fehlern', !fs.readdirSync(cacheRoot).some((n) => n.startsWith('.tmp-')), fs.readdirSync(cacheRoot).join(','));
  const outside = await ev(() => window.soma.project.viewFile('../outside.step'));
  check('Pfad außerhalb des Projekts wird abgelehnt', /outside the project/.test(outside.error ?? ''), outside.error);
  const notStep = await ev(() => window.soma.project.viewFile('model.py'));
  check('Andere Dateitypen werden abgelehnt', /Only STEP files/.test(notStep.error ?? ''), notStep.error);
  const badMeasure = await ev(() => window.soma.measure.prepare({ file: '../x.step', key: '0'.repeat(40) }, '0'.repeat(32)));
  check('Messquelle außerhalb oder unbekannt wird abgelehnt', !badMeasure.ok, badMeasure.error);

  // 10) Netzdateien (STL, 3MF, AMF, OBJ): im Viewer wie STEP, Einheiten umgerechnet, aber ohne Messen (keine CAD-Geometrie)
  const PY = process.env.SOMA_PYTHON || path.join(process.env.LOCALAPPDATA ?? '', 'soma-dev', 'venv', 'Scripts', 'python.exe');
  const exp = (args) => spawnSync(PY, ['-m', 'soma', 'export', ...args, '--project', dir], { encoding: 'utf8', windowsHide: true, timeout: 5 * 60 * 1000 });
  const e1 = exp(['Platte', '--format', '3mf', '--units', 'in', '--out', 'inputs/mesh']);
  const e2 = exp(['Block', '--format', 'stl', '--out', 'inputs/mesh']);
  fs.writeFileSync(path.join(inputs, 'tri.obj'), 'o Dreieck\nv 0 0 0\nv 10 0 0\nv 0 10 0\nf 1 2 3\n');
  fs.writeFileSync(path.join(inputs, 'bad.3mf'), 'this is not a zip');
  check('Netzdateien für den Test exportiert', e1.status === 0 && e2.status === 0, (e1.stderr + e2.stderr).slice(-200));
  await ev(() => window.__t.revealFile('inputs/mesh/Platte.3mf'));
  await waitFor('3MF im Dateibaum', () => window.__t.fileRows().includes('Platte.3mf'), 20000).catch(() => {});
  await clickRow('inputs/mesh/Platte.3mf');
  await waitFor('3MF geladen', () => window.__t.fileView().rel === 'inputs/mesh/Platte.3mf' && !window.__t.fileView().loading, 60000).catch(() => {});
  f = await fv();
  let plateBox = null;
  try { plateBox = JSON.parse(fs.readFileSync(path.join(cacheRoot, f.key, 'model.map.json'), 'utf8')).parts[0].bbox; } catch { /* Prüfung schlägt fehl */ }
  check('Klick auf eine 3MF-Datei: Viewer zeigt das Teil, Banner „3MF file … cannot be measured“', await names() === '["Platte"]' && (f.banner ?? '').includes('3MF file')
    && (f.banner ?? '').includes('cannot be measured') && f.frame, `${await names()} ${f.banner}`);
  check('3MF in Zoll: Größe im Viewer wieder in mm (40 x 30 x 5)', !!plateBox && Math.abs(plateBox[1][0] - plateBox[0][0] - 40) < 0.01 && Math.abs(plateBox[1][2] - plateBox[0][2] - 5) < 0.01, JSON.stringify(plateBox));
  await shot('stepview-mesh');
  await domClick('btn-measure');
  await waitFor('Hinweis beim Messen', () => /no CAD geometry/.test(window.__t.measure().error ?? ''), 10000).catch(() => {});
  check('Messen in einer Netzdatei: Hinweis statt Messung', /have no CAD geometry/.test((await ev(() => window.__t.measure())).error ?? ''), JSON.stringify(await ev(() => window.__t.measure())).slice(0, 160));
  await domClick('btn-measure');
  await ev(() => window.__t.openFile('inputs/mesh/Block.stl'));
  check('STL-Datei: Teil „Block“ im Viewer', await names() === '["Block"]' && ((await fv()).banner ?? '').includes('STL file'), await names());
  await ev(() => window.__t.openFile('inputs/tri.obj'));
  check('OBJ-Datei mit offenem Netz: Teil „Dreieck“', await names() === '["Dreieck"]', await names());
  await clickRow('inputs/bad.3mf');
  await waitFor('Fehlermeldung', () => /bad\.3mf cannot be shown/.test(window.__t.toast().text) && !window.__t.fileView().loading, 60000).catch(() => {});
  toastText = await ev(() => window.__t.toast());
  check('Kaputte 3MF-Datei: verständliche Meldung', toastText.error && toastText.text.includes('not a valid ZIP package'), toastText.text);
  await domClick('btn-file-back');
  await waitFor('Modell wieder da', () => JSON.stringify(window.__t.treeNames()) === '["Platte","Block","Stift"]', 30000).catch(() => {});
  check('Nach der Netzdatei zurück: Modell wieder messbar (Build vorhanden)', !!(await ev(() => window.__t.mapBuild())), await names());

  // 11) STEP-Dateien ohne Baugruppe (ein Körper oder mehrere freie Formen, wie viele CAD-Programme ein Logo schreiben):
  // CadQuerys Assembly.importStep lehnt sie ab („does not contain an assembly“), SOMA liest die freien Formen selbst.
  // Auch import_assembly() und import_step() der API und im exportierten CadQuery-Block (cqruntime).
  const plain = spawnSync(PY, ['-c', String.raw`
import sys
import cadquery as cq
from OCP.STEPControl import STEPControl_Writer, STEPControl_AsIs
from soma import registry, cqruntime
def write(shapes, f):
    w = STEPControl_Writer()
    for s in shapes:
        w.Transfer(s.wrapped, STEPControl_AsIs)
    w.Write(f)
a = cq.Workplane().box(10, 10, 2).val()
b = cq.Workplane().center(30, 0).cylinder(5, 4).val()
write([a], sys.argv[1] + "/Logo_KJ.step")
write([a, b], sys.argv[1] + "/two.step")
f = sys.argv[1] + "/two.step"
print([c.name for c in registry.import_assembly(f).children], round(registry.import_step(f).Volume(), 1),
      [c.name for c in cqruntime.import_assembly(f).children], round(cqruntime.import_step(f).Volume(), 1))
`, inputs], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  const vol = Math.round((200 + Math.PI * 16 * 5) * 10) / 10; // Platte 10 x 10 x 2 und Zylinder Höhe 5, Radius 4
  check('API ohne Baugruppe: import_assembly ein Teil je Körper, import_step mit beiden Körpern (soma und cqruntime)',
    plain.status === 0 && plain.stdout.trim() === `['two 1', 'two 2'] ${vol} ['two 1', 'two 2'] ${vol}`, (plain.stdout + plain.stderr).slice(-300));
  await ev(() => window.__t.openFile('inputs/Logo_KJ.step'));
  check('STEP-Datei ohne Baugruppe im Viewer: ein Teil, benannt nach der Datei', await names() === '["Logo_KJ"]', `${await names()} ${(await ev(() => window.__t.toast())).text}`);
  await ev(() => window.__t.openFile('inputs/two.step'));
  check('Zwei freie Formen: zwei Teile', await names() === '["two 1","two 2"]', await names());
  await domClick('btn-file-back');
  await waitFor('Modell wieder da', () => JSON.stringify(window.__t.treeNames()) === '["Platte","Block","Stift"]', 30000).catch(() => {});

  const relevant = page.errors.filter((e) => !/favicon/i.test(e));
  check('Keine Konsolenfehler im Renderer', relevant.length === 0, relevant.slice(0, 2).join(' | ').slice(0, 100));
} catch (e) {
  console.log('ABBRUCH:', e.message);
  t.fail();
}
if (app) { await app.stop(); cleanup(app.ud); }
fs.rmSync(workDir, { recursive: true, force: true });
console.log(t.fails ? `\n${t.fails} Prüfung(en) fehlgeschlagen` : '\nALLE PRÜFUNGEN BESTANDEN');
process.exit(t.fails ? 1 : 0);
