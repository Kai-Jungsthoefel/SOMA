// Test der FEM-Auswertung (E65): soma analyze fem mit einer Studie in analyses/, Vergleich mit der Balkenformel, verschmolzene
// Teile mit eigenem Werkstoff, Druck, Eigengewicht und near=, Fehlermeldungen (Lagerung, Bauteil, Selektor, kein fix), Anzeige in
// der App (Reiter Analysis mit Bericht, Leiste und Legende im Bild, Beschriftungen, Überhöhung, Wert unter dem Zeiger in
// Ausgangslage, An Agent geben, E82), soma render --result,
// veraltet nach Änderung der Studie, Neu berechnen und das Beispiel aus dem Skill.
// Aufruf: node test/run-all.mjs fem (baut vorher mit npm run build). SMOKE_VISIBLE=offscreen SMOKE_SHOTS=1 legt Bilder ab.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { APP, checker, cleanup, sleep, startApp } from './harness.mjs';

const t = checker();
const { check } = t;
let app;

const PY = process.env.SOMA_PYTHON || path.join(process.env.LOCALAPPDATA ?? '', 'soma-dev', 'venv', 'Scripts', 'python.exe');

// Kragbalken 100 x 10 x 10 entlang +X (Formel: w = 4 F L³ / (E b h³)), ein Winkel aus zwei Teilen, die sich berühren, und die
// Konsole aus dem Beispiel im Skill
const MODEL = `import cadquery as cq
from soma import add_part
from soma.fasteners import Screw

add_part("Balken", cq.Workplane().box(100, 10, 10, centered=(False, True, True)))
fuss = cq.Workplane().box(60, 40, 5, centered=(True, True, False)).translate((0, 100, 0))
wand = cq.Workplane().box(5, 40, 40, centered=(True, True, False)).translate((27.5, 100, 5))
add_part("Fuss", fuss)
add_part("Wand", wand)
bracket = cq.Workplane().box(40, 20, 4, centered=(False, True, False)).union(
    cq.Workplane().box(4, 20, 30, centered=(False, True, False))).translate((0, -100, 0))
add_part("Bracket", bracket)
# Platte mit Arm auf einer Bodenplatte (Bericht eines Testagenten: brach als "moves without limit" ab)
add_part("Grund", cq.Workplane().box(100, 100, 10, centered=(True, True, False)).translate((0, 250, -10)))
add_part("Halter", cq.Workplane().box(60, 60, 8, centered=(True, True, False)).union(
    cq.Workplane().box(20, 12, 80, centered=(True, True, False)).translate((0, 0, 8))).translate((0, 250, 0)))
# Lasche mit einer Schraube M5 auf einem Sockel mit Gewinde (bolt())
screw = Screw("ISO 4762", "M5x16", at=(0, -250, 6))
add_part("Sockel", cq.Workplane().box(30, 30, 12, centered=(True, True, False)).translate((0, -250, -12)).cut(screw.tap_hole()))
add_part("Lasche", cq.Workplane().box(30, 30, 6, centered=(True, True, False)).translate((0, -250, 0)).cut(screw.clearance_hole()))
add_part("Schraube", screw)
`;
const BALKEN = (n) => `from soma.fem import Study
study = Study("Balken unter Last", material="Aluminium 6082", safety=2)
study.fix("Balken", faces="<X")
study.force("Balken", faces=">X", N=(0, 0, ${-n}))
`;
const WINKEL = `from soma.fem import Study
study = Study("Winkel", material="Aluminium 6082", safety=1.5)
study.set_material("Wand", "Steel S235")
study.fix("Fuss", faces="<Z")
study.pressure("Wand", near=(30, 100, 30), MPa=0.2)
study.gravity()
`;
const LOSE = `from soma.fem import Study
study = Study("lose", material="PLA")
study.fix("Fuss", faces="<Z", axes="z")
study.force("Wand", faces=">Z", N=(-10, 0, 0))
`;
// Kontakt (E84): Die Wand steht auf dem Fuß, oben gedrückt und leicht seitlich (20 N < 0,3 x 400 N: haftet)
const KONTAKT = (friction) => `from soma.fem import Study
study = Study("Wand steht auf", material="Aluminium 6082", check_mesh=False)
study.fix("Fuss", faces="<Z")
study.force("Wand", faces=">Z", N=(-20, 0, -400))
study.contact("Fuss", "Wand"${friction ? `, friction=${friction}` : ''})
`;

const near = (a, b, eps) => Math.abs(a - b) <= eps;
const pngSize = (f) => { const b = fs.readFileSync(f); return b.toString('ascii', 1, 4) === 'PNG' ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null; };

try {
  app = await startApp({ name: 'fem' });
  const { ev, waitFor, domClick } = app;
  const shot = async (name) => {
    if (!process.env.SMOKE_SHOTS) return;
    fs.mkdirSync(path.join(APP, 'test', 'shots'), { recursive: true });
    await sleep(900);
    await app.screenshot(path.join(APP, 'test', 'shots', `${name}.png`)).catch((e) => console.log('Screenshot:', e.message));
  };
  await waitFor('Projekt und Build', () => !!window.__t && !!window.__t.project() && window.__t.status().state === 'ok' && window.__t.partCount() > 0);
  const dir = (await ev(() => window.__t.project())).dir;
  fs.writeFileSync(path.join(dir, 'model.py'), MODEL);
  await waitFor('Testmodell gebaut', () => window.__t.status().state === 'ok' && window.__t.partCount() === 9, 90000);
  const bridge = await ev(() => window.soma.test.bridge());
  const env = { ...process.env, ...bridge, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
  const soma = (args) => spawnSync(PY, ['-m', 'soma', ...args], { cwd: dir, env, encoding: 'utf8', timeout: 10 * 60 * 1000 });
  fs.mkdirSync(path.join(dir, 'analyses'));
  const study = (name, text) => fs.writeFileSync(path.join(dir, 'analyses', `${name}.py`), text);

  // 1) Kragbalken gegen die Formel: w = 4 * 50 * 100³ / (70000 * 10 * 10³) = 0,2857 mm, Spannung an der Einspannung 30 MPa
  study('balken', BALKEN(50));
  let r = soma(['analyze', 'fem', 'analyses/balken.py']);
  const w = Number(/largest displacement (\d+\.\d+) mm/.exec(r.stdout)?.[1]);
  const s = Number(/highest von Mises stress (\d+\.\d) MPa/.exec(r.stdout)?.[1]);
  check('Kragbalken: Durchbiegung wie die Formel (0,286 mm, ±2 %)', r.status === 0 && near(w, 0.2857, 0.006), r.stdout + r.stderr);
  check('Kragbalken: Spannung an der Einspannung um 30 MPa, Sicherheit über 2, nichts kritisch', near(s, 30, 4) && /lowest safety factor [5-9]\.\d\d, nothing below 2/.test(r.stdout), r.stdout);
  check('Lastfall in der Ausgabe: fest 100 mm² mit Lagerkraft 50 N, Kraft 100 mm², im Gleichgewicht', /fixed: Balken <X \(100\.0 mm²\), reaction force \(0\.0, 0\.0, 50\.0\) N/.test(r.stdout)
    && /force: Balken >X \(100\.0 mm²\), \(0\.0, 0\.0, -50\.0\) N/.test(r.stdout) && r.stdout.includes('(in equilibrium)'), r.stdout);
  check('Netzprüfung: zweite Rechnung mit gröberem Netz genannt, Hinweis zur Spitze an der Einspannung', /with a coarser mesh \d+\.\d MPa/.test(r.stdout)
    && r.stdout.includes('at the edge of a fixed support'), r.stdout);
  check('Ergebnisdatei .soma/results/balken.glb', fs.existsSync(path.join(dir, '.soma', 'results', 'balken.glb')));
  check('Gerechnet mit CalculiX (E84)', /unknowns, CalculiX \d/.test(r.stdout), r.stdout);
  // Rückfallweg ohne CalculiX: der eingebaute Solver, dieselbe Durchbiegung
  const r0 = spawnSync(PY, ['-m', 'soma', 'analyze', 'fem', 'analyses/balken.py', '--name=balken-eigen'], { cwd: dir, env: { ...env, SOMA_FEM_SOLVER: 'builtin' }, encoding: 'utf8', timeout: 10 * 60 * 1000 });
  check('Eingebauter Solver (SOMA_FEM_SOLVER=builtin): gleiche Durchbiegung, direkt gelöst', r0.status === 0 && /unknowns, direct/.test(r0.stdout)
    && near(Number(/largest displacement (\d+\.\d+) mm/.exec(r0.stdout)?.[1]), w, 0.002), r0.stdout + r0.stderr);
  fs.rmSync(path.join(dir, '.soma', 'results', 'balken-eigen.glb'), { force: true });

  // 2) Zwei verschmolzene Teile mit eigenem Werkstoff, Druck über near=, Eigengewicht
  study('winkel', WINKEL);
  r = soma(['analyze', 'fem', 'analyses/winkel.py']);
  check('Winkel: beide Teile mit ihrem Werkstoff, Druck 0,2 MPa auf 1600 mm² (320 N), Eigengewicht, im Gleichgewicht', r.status === 0
    && /Fuss \(Aluminium 6082/.test(r.stdout) && /Wand \(Steel S235/.test(r.stdout) && /pressure: Wand near \(30, 100, 30\) \(1600\.0 mm²\), 0\.2 MPa, in total \(-320\.0, 0\.0, 0\.0\) N/.test(r.stdout)
    && r.stdout.includes('self-weight') && r.stdout.includes('(in equilibrium)'), r.stdout + r.stderr);
  check('Winkel: Einspannung 2400 mm² trägt Druck und Gewicht', /fixed: Fuss <Z \(2400\.0 mm²\), reaction force \(320\.0, 0\.0, \d\.\d\) N/.test(r.stdout), r.stdout);
  check('Winkel: berührende Teile genannt, verklebt, mit Hinweis auf contact()', r.stdout.includes('touching: Fuss – Wand (200.0 mm²), bonded')
    && r.stdout.includes('add study.contact("A", "B")'), r.stdout);

  // 3) Fehler: verständlich, Exit 1, keine Ergebnisdatei
  study('lose', LOSE);
  r = soma(['analyze', 'fem', 'analyses/lose.py']);
  check('Nur in Z gehalten: meldet, was noch frei ist', r.status === 1 && /supports are not enough[^\n]*Fuss, Wand: still free \([^)]*moving in X/.test(r.stderr + r.stdout), r.stderr + r.stdout);
  study('kaputt', BALKEN(1).replace('fix("Balken"', 'fix("Gibtsnicht"'));
  r = soma(['analyze', 'fem', 'analyses/kaputt.py']);
  check('Unbekanntes Bauteil: nennt die vorhandenen', r.status === 1 && (r.stderr + r.stdout).includes("There is no part 'Gibtsnicht'") && (r.stderr + r.stdout).includes("'Balken'"), r.stderr + r.stdout);
  study('kaputt', BALKEN(1).replace('faces="<X"', 'faces="<Q"'));
  r = soma(['analyze', 'fem', 'analyses/kaputt.py']);
  check('Falscher Selektor: Fehler nennt ihn', r.status === 1 && (r.stderr + r.stdout).includes("Selector '<Q'"), r.stderr + r.stdout);
  study('kaputt', BALKEN(1).replace(/study\.fix[^\n]*\n/, ''));
  r = soma(['analyze', 'fem', 'analyses/kaputt.py']);
  check('Ohne fix: verlangt eine Einspannung', r.status === 1 && (r.stderr + r.stdout).includes('At least one study.fix'), r.stderr + r.stdout);
  study('kaputt', 'from soma.fem import Study\nx = 1 / 0\n');
  r = soma(['analyze', 'fem', 'analyses/kaputt.py']);
  check('Fehler im Code der Studie: Datei und Zeile 2', r.status === 1 && (r.stderr + r.stdout).includes('analyses/kaputt.py (line 2): ZeroDivisionError'), r.stderr + r.stdout);
  r = soma(['analyze', 'fem']);
  check('Ohne Studie: Hinweis auf die Datei', r.status === 1 && (r.stderr + r.stdout).includes('needs the file with the load case'), r.stderr + r.stdout);
  check('Fehler legen keine Ergebnisse an', !fs.existsSync(path.join(dir, '.soma', 'results', 'kaputt.glb')) && !fs.existsSync(path.join(dir, '.soma', 'results', 'lose.glb')));

  // 4) Anzeige in der App (E82): Punkt am Reiter, Reiter Analysis zeigt die Liste, Bericht, Leiste und Legende im Bild
  await ev(() => window.__t.refreshViewLists());
  check('Neue Analysen vom Agenten: Punkt am Reiter Analysis, keiner an Animation', (await ev(() => window.__t.rail())).analysis
    && !(await ev(() => window.__t.rail())).anim, JSON.stringify(await ev(() => window.__t.rail())));
  await ev(() => window.__t.showPanel('analysis'));
  await waitFor('Liste geladen', () => window.__t.analysis().mode === 'list' && window.__t.analysis().list.length === 2, 20000);
  let an = await ev(() => window.__t.analysis());
  check('Reiter Analysis: zeigt die Liste, kein Ergebnis von selbst im Bild, Punkt am Reiter weg', !(await ev(() => window.__t.result())).id
    && !an.list.some((x) => x.cur) && !(await ev(() => window.__t.rail())).analysis, JSON.stringify(an));
  await ev(() => document.querySelector('#an-rows .al-row[data-id="winkel"]').click());
  await waitFor('Winkel gezeigt', () => window.__t.result().id === 'winkel' && window.__t.analysis().mode === 'report', 20000);
  an = await ev(() => window.__t.analysis());
  check('Klick in der Liste: Bericht zu Winkel', an.title === 'Winkel' && an.meta.startsWith('FEM · '), JSON.stringify(an));
  check('Bericht Winkel: Druck, Schwerkraft und zwei Werkstoffe als Annahmen', an.inputs.some((x) => x.startsWith('Pressure0.2 MPa'))
    && an.inputs.some((x) => x.startsWith('Gravity9.81 m/s²')) && an.inputs.some((x) => x.startsWith('MaterialAluminium 6082 · Steel S235')), JSON.stringify(an.inputs));
  await domClick('btn-an-back');
  an = await ev(() => window.__t.analysis());
  check('Liste: alle Analysen, die gezeigte markiert, die andere „new“', an.mode === 'list' && an.list.length === 2
    && an.list.find((x) => x.id === 'winkel')?.cur && !an.list.find((x) => x.id === 'winkel')?.isNew && an.list.find((x) => x.id === 'balken')?.isNew, JSON.stringify(an.list));
  await ev(() => document.querySelector('#an-rows .al-row[data-id="balken"]').click());
  await waitFor('FEM-Ergebnis geladen', () => window.__t.result().id === 'balken' && window.__t.analysis().title === 'Balken unter Last', 20000);
  let rs = await ev(() => window.__t.result());
  an = await ev(() => window.__t.analysis());
  // Überhöhung: 5 % von 101 mm / 0,286 mm = 17,7, auf eine runde Zahl abgerundet 10
  check('Bericht: eine Zahl groß (Sicherheit über 2), hält, Lager und Kraft, Werkstoff, Netz, Tabelle mit 30 MPa und 0,28 mm', /^\d+(\.\d+)?$/.test(an.number)
    && Number(an.number) > 2 && an.status === 'Holds the required safety' && an.critical.length === 0
    && an.inputs.some((x) => x.startsWith('SupportFixed · Balken')) && an.inputs.some((x) => x.startsWith('Force50 N downward · Balken'))
    && an.inputs.some((x) => x.startsWith('MaterialAluminium 6082')) && an.inputs.some((x) => /^Mesh[\d.]+ mm · [\d,]+ elements/.test(x))
    && an.table.some((row) => row[0] === 'Balken' && near(Number(row[2]), 30, 4) && /^0\.28\d$/.test(row[3])), JSON.stringify(an));
  await ev(() => { window.__t.analysisToggle('bc0'); window.__t.analysisToggle('mat'); window.__t.analysisToggle('mesh'); window.__t.analysisToggle('calc'); });
  an = await ev(() => window.__t.analysis());
  check('Aufgeklappt: Lagerkraft 50 N nach oben im Gleichgewicht, E-Modul, Querdehnzahl, Dichte, Netz aus der Modellgröße, Löser', an.details.some((x) => x.includes('Reaction50 N upward') && x.includes('in equilibrium'))
    && an.details.some((x) => x.includes('E modulus70 GPa') && x.includes('Poisson ν0.33') && x.includes('Density2.7 g/cm³') && x.includes('allowable 125 MPa'))
    && an.details.some((x) => x.includes('automatic from the model size') && x.includes('coarser mesh'))
    && an.details.some((x) => x.includes('Studyanalyses/balken.py') && x.includes('Commandsoma analyze fem analyses/balken.py')), JSON.stringify(an.details));
  check('Im Bild: Sicherheit, Spannung, Verschiebung wählbar, verformt 10-fach, Lastfall an, Kraft und kleinster Wert beschriftet', rs.active && rs.fem
    && rs.fem.fields.join() === 'Safety factor,Stress,Displacement' && rs.fem.scale === 10 && rs.fem.options.join() === 'Off,1×,10×' && rs.fem.bcs === true
    && rs.meta.unit === '' && rs.tags.some((x) => x === '50 N') && rs.tags.some((x) => x.startsWith('Min ')) && rs.scale.legend.startsWith('Safety Auto') && rs.scale.legend.includes('Safety factor'), JSON.stringify(rs));
  check('Legende schmal (höchstens 90 px), die Skala stellt das Menü hinter dem Knopf „Auto“ ein', await ev(() => document.getElementById('result-legend').offsetWidth <= 90)
    && await ev(() => { document.getElementById('btn-result-scale').click(); return !document.getElementById('menu-scale').hidden; }), String(await ev(() => document.getElementById('result-legend').offsetWidth)));
  await shot('fem-1b-skala');
  await ev(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  const tr = await ev(() => window.__t.tree());
  check('Baum in der Analyse: nur die gerechneten Körper', JSON.stringify(tr.names) === '["Balken"]', JSON.stringify(tr.names));
  await ev(() => window.__t.viewer.setView('front'));
  await sleep(300);
  // Vorderseite am Ende: um 10 x 0,28 mm nach unten verschoben gezeichnet, der Wert nennt die Stelle im unverformten Modell
  const at = await ev(() => window.__t.viewer.screenAt([97, -5, -2.8]));
  const pin = await ev((p) => window.__t.resultPin(p.x, p.y), at);
  check('Klick auf das verformte Balkenende: Stelle in Ausgangslage, Verschiebung um 0,28 mm, Spannung klein', pin?.name === 'Balken'
    && near(pin.point[0], 97, 1) && near(pin.point[2], 0, 1.2) && near(pin.disp, 0.28, 0.03) && pin.stress < 5 && pin.value > 20, JSON.stringify(pin));
  rs = await ev(() => window.__t.result());
  check('Gemerkte Stelle steht im Bericht', (await ev(() => window.__t.analysis())).pick?.startsWith('Picked: Balken, Safety '), (await ev(() => window.__t.analysis())).pick);
  check('An Agent geben: Sicherheit, Spannung und Verschiebung', /^\[Result: "Balken unter Last" \(\.soma\/results\/balken\.glb, limit 2\.00\), part "Balken": safety factor (over 99|\d+\.\d\d) \(\d+\.\d MPa, displacement 0\.2\d\d mm\) at \(/.test(rs.note), rs.note);
  await ev(() => window.__t.viewer.setView('iso'));
  await shot('fem-1');
  await ev(() => window.__t.resultDeform(0));
  await domClick('btn-result-bcs');
  rs = await ev(() => window.__t.result());
  check('Unverformt und Lastfall aus, ohne Beschriftung der Kraft', rs.fem.scale === 0 && rs.fem.bcs === false && !rs.tags.includes('50 N'), JSON.stringify(rs));
  await domClick('btn-result-bcs');

  // Farbskala: Spannung statt Sicherheit (Grenze 250 / 2 = 125 MPa, kritisch darüber), Spanne Min bis Max und eigene
  const pick = (id, v) => ev((a) => document.querySelector(`#${a.id} [data-range="${a.v}"]`).click(), { id, v });
  check('Skala automatisch: Sicherheit, Spanne der Auswertung', rs.scale.field === 'value' && rs.scale.mode === 'auto' && rs.scale.canStress
    && rs.scale.range[0] === 0 && rs.scale.threshold === 2, JSON.stringify(rs.scale));
  await ev(() => window.__t.resultField('stress'));
  rs = await ev(() => window.__t.result());
  check('Spannung: MPa, Grenze 125 MPa kritisch darüber, Skala 0 bis 250', rs.scale.field === 'stress' && rs.scale.unit === 'MPa'
    && rs.scale.threshold === 125 && rs.scale.range.join() === '0,250' && rs.scale.legend.includes('von Mises stress (MPa)')
    && rs.scale.legend.includes('Red: above allowable'), JSON.stringify(rs.scale));
  await ev(() => window.__t.viewer.setView('front'));
  await sleep(300);
  const pin2 = await ev((p) => window.__t.resultPin(p.x, p.y), at);
  await ev(() => window.__t.viewer.setView('iso'));
  rs = await ev(() => window.__t.result());
  check('Stelle bei Spannung: MPa zuerst, Sicherheit danach', pin2?.stress != null && /: Balken, \d+\.\d MPa · Safety /.test(rs.probe), rs.probe);
  await pick('result-range', 'minmax');
  rs = await ev(() => window.__t.result());
  check('Min bis Max: Spanne der Spannungen im Modell (bis rund 30 MPa)', rs.scale.mode === 'minmax' && rs.scale.range[0] >= 0 && rs.scale.range[0] < 5
    && near(rs.scale.range[1], 30, 6), JSON.stringify(rs.scale));
  await pick('result-range', 'custom');
  rs = await ev(() => window.__t.result());
  const shownInputs = await ev(() => [document.getElementById('result-custom').hidden, document.getElementById('result-lo').value, document.getElementById('result-hi').value]);
  check('Eigene Skala: Felder sichtbar, vorbelegt mit der automatischen Spanne', shownInputs[0] === false && shownInputs[1] === '0' && shownInputs[2] === '250'
    && rs.scale.range.join() === '0,250', JSON.stringify(shownInputs));
  const typeIn = (id, v) => ev((a) => { const s = document.getElementById(a.id); s.value = a.v; s.dispatchEvent(new Event('input')); }, { id, v });
  await typeIn('result-hi', '40');
  await typeIn('result-lo', '10');
  rs = await ev(() => window.__t.result());
  // Farben über die Spanne: Das untere Ende ist grau, das obere rot, obwohl der Grenzwert weit darüber liegt
  // Die Legende steht senkrecht: oben das obere Ende der Spanne
  const ends = await ev(() => getComputedStyle(document.querySelector('#result-legend .lg-bar')).backgroundImage.match(/rgb\([^)]*\)/g));
  check('Eigene Skala 10 bis 40 MPa gilt sofort, Farbe über die Spanne bis Rot, Grenze außerhalb ohne Strich', rs.scale.range.join() === '10,40'
    && rs.scale.legend.includes('Color across the range') && ends[0] === 'rgb(240, 116, 112)'
    && await ev(() => !document.querySelector('#result-legend .lg-thr')), JSON.stringify(rs.scale) + ends?.join(' '));
  await shot('fem-2');
  await typeIn('result-lo', '50');
  rs = await ev(() => window.__t.result());
  check('Von größer als bis: rot umrandet, Skala bleibt', rs.scale.range.join() === '10,40' && await ev(() => document.getElementById('result-lo').classList.contains('bad')), JSON.stringify(rs.scale));
  await typeIn('result-lo', '10');
  await ev(() => window.__t.resultField('value'));
  rs = await ev(() => window.__t.result());
  check('Zurück zur Sicherheit: eigene Skala neu aus deren Spanne', rs.scale.field === 'value' && rs.scale.range[0] === 0 && rs.scale.threshold === 2
    && await ev(() => document.getElementById('result-hi').value) === String(rs.scale.range[1]), JSON.stringify(rs.scale));
  await pick('result-range', 'auto');
  await ev(() => window.__t.resultField('disp'));
  rs = await ev(() => window.__t.result());
  check('Verschiebung: mm, ohne Grenzwert, Skala 0 bis zur größten (0,286 mm)', rs.scale.field === 'disp' && rs.scale.unit === 'mm' && rs.scale.threshold === null
    && rs.scale.range[0] === 0 && near(rs.scale.range[1], 0.286, 0.01) && rs.scale.legend.includes('No limit'), JSON.stringify(rs.scale));
  await shot('fem-2b-verschiebung');
  await ev(() => window.__t.resultField('value'));

  // 5) soma render --result: Bild mit Legende
  r = soma(['render', '--result', 'balken']);
  check('soma render --result balken: Bild 1280 x 800', r.status === 0 && JSON.stringify(pngSize(path.join(dir, 'renders', 'result-balken.png'))) === '[1280,800]', r.stdout + r.stderr);

  // 6) Studie ändern: Ergebnis veraltet (die Studie zählt mit), Neu berechnen rechnet die neue Last
  await sleep(1100);
  study('balken', BALKEN(100));
  const stale = await ev(() => window.soma.results.list().then((l) => l.find((x) => x.id === 'balken')?.stale));
  check('Geänderte Studie: Ergebnis veraltet', stale === true, String(stale));
  await ev(() => window.__t.refreshViewLists());
  an = await ev(() => window.__t.analysis());
  check('Bericht: „older than the code“ und Zeile mit Neu berechnen', an.meta.includes('older than the code') && an.stale?.startsWith('Values belong to the model as it was at'), JSON.stringify(an));
  await shot('fem-4-veraltet');
  await domClick('btn-result-rerun');
  await waitFor('neu berechnet', () => window.__t.result().stale === false && window.__t.analysis().details.some((x) => x.includes('Reaction100 N')), 120000).catch(() => {});
  an = await ev(() => window.__t.analysis());
  check('Neu berechnen: Lagerkraft jetzt 100 N, Verschiebung doppelt', !an.stale && an.details.some((x) => x.includes('Reaction100 N upward'))
    && an.table.some((row) => row[0] === 'Balken' && /^0\.5[67]\d$/.test(row[3])), JSON.stringify(an));
  await domClick('btn-result-close');
  check('× in der Leiste: Analyse aus, Modell wieder sichtbar, Baum mit allen Teilen, Bericht wird zur Liste', !(await ev(() => window.__t.viewer.animViewState())).modelHidden
    && (await ev(() => window.__t.tree())).names.length === 9 && (await ev(() => window.__t.analysis())).mode === 'list');

  // Schnitt durch verschmolzene Teile: Jedes Netz ist für sich geschlossen, auch an der Fläche, an der die Wand auf dem Fuß
  // steht. Sonst füllt der Deckel des Schnitts auch Stellen, an denen der Blick durch diese Fläche geht
  await ev(() => window.__t.resultShow('winkel'));
  await waitFor('Ergebnis Winkel geladen', () => window.__t.result().id === 'winkel', 20000);
  const scaleW = (await ev(() => window.__t.result())).fem.scale;
  // Waagerecht durch die Wand bei z = 40, behalten wird darunter: Die Kontur folgt der Überhöhung (die Wand kippt nach −X)
  await ev(() => window.__t.viewer.setSection({ normal: [0, 0, -1], constant: 40 }));
  const boxBent = (await ev(() => window.__t.viewer.sectionState())).contourBox;
  await ev(() => window.__t.resultDeform(0));
  const boxFlat = (await ev(() => window.__t.viewer.sectionState())).contourBox;
  check('Schnitt im Ergebnis: Kontur folgt der Überhöhung (verformt nach −X, unverformt bis x = 30)', scaleW > 0 && near(boxFlat?.[1][0], 30, 0.05)
    && boxBent?.[1][0] < 29.5, JSON.stringify({ scaleW, boxBent, boxFlat }));
  // Senkrecht bei y = 100, behalten wird dahinter. Der Blick auf die Außenseite der Wand knapp über dem Fuß geht durch die
  // Berührfläche: keine Schraffur. Auf der Schnittfläche der Wand: Schraffur
  await ev(() => window.__t.viewer.setSection({ normal: [0, 1, 0], constant: -100 }));
  const wIds = await ev(() => window.__t.viewer.partList().filter((p) => p.name === 'Fuss' || p.name === 'Wand').map((p) => p.id));
  await ev((ids) => window.__t.viewer.setView('iso', ids), wIds);
  await sleep(400);
  const pxAt = async (p) => ev((q) => window.__t.viewer.pixels(q.x, q.y), await ev((q) => window.__t.viewer.screenAt(q), p));
  const outside = await pxAt([30, 110, 8]);
  const cutFace = await pxAt([27.5, 100, 25]);
  const layers = await ev(() => window.__t.viewer.layerState());
  check('Schnitt im Ergebnis: Fuß und Wand mit Deckel, Schraffur nur auf der Schnittfläche, nicht hinter der Berührfläche', outside.span < 12
    && cutFace.span > 25 && ['Fuss', 'Wand'].every((n) => layers.find((l) => l.name === n)?.capped), JSON.stringify({ outside, cutFace, layers }));
  await shot('fem-3-schnitt');
  await ev(() => window.__t.viewer.setSection(null));
  await domClick('btn-result-close');

  // 7) Kontakt (E84): ohne Reibung hält nichts die Wand seitlich, mit Reibung steht sie
  study('kontakt', KONTAKT(0));
  r = soma(['analyze', 'fem', 'analyses/kontakt.py']);
  check('Kontakt ohne Reibung, seitlich frei: vor der Rechnung gemeldet', r.status === 1
    && /Wand: still free \([^)]*moving in X[^)]*\) \(held only by a contact without friction/.test(r.stderr + r.stdout), r.stderr + r.stdout);
  study('kontakt', KONTAKT(0.3));
  r = soma(['analyze', 'fem', 'analyses/kontakt.py']);
  const cf = Number(/contact: Fuss – Wand \(200\.0 mm², friction 0\.3\), carries (\d+\.\d) N/.exec(r.stdout)?.[1]);
  check('Kontakt mit Reibung: trägt die 400 N, im Gleichgewicht, mit Kontakt gerechnet', r.status === 0 && near(cf, 400, 8)
    && r.stdout.includes('linear elastic, with contact') && r.stdout.includes('(in equilibrium)') && /CalculiX [\d.]+, \d+ threads, \d+ load steps?/.test(r.stdout), r.stdout + r.stderr);
  await ev(() => window.__t.refreshViewLists());
  await ev(() => window.__t.resultShow('kontakt'));
  await waitFor('Ergebnis Kontakt geladen', () => window.__t.result().id === 'kontakt', 20000);
  await ev(() => window.__t.resultField('press'));
  rs = await ev(() => window.__t.result());
  check('Im Bild: Kontaktpressung wählbar, MPa ohne Grenzwert, Spanne bis zur größten', rs.fem.fields.join() === 'Safety factor,Stress,Displacement,Contact'
    && rs.scale.field === 'press' && rs.scale.unit === 'MPa' && rs.scale.threshold === null && rs.scale.range[1] > 0 && rs.scale.legend.includes('Contact pressure'), JSON.stringify(rs));
  // Die Kontaktfläche liegt zwischen den Teilen: Wand ausblenden, dann sieht man die Pressung auf dem Fuß
  const wandIds = await ev(() => window.__t.viewer.partList().filter((p) => p.name === 'Wand').map((p) => p.id));
  await ev((ids) => window.__t.viewer.setVisible(ids, false), wandIds);
  await ev(() => window.__t.viewer.setView('top'));
  await shot('fem-5-kontakt');
  await ev((ids) => window.__t.viewer.setVisible(ids, true), wandIds);
  await ev(() => window.__t.viewer.setView('iso'));
  await ev(() => window.__t.resultField('value'));
  await ev(() => window.__t.showPanel('analysis'));
  await waitFor('Bericht Kontakt', () => window.__t.analysis().title === 'Wand steht auf', 20000);
  await ev(() => window.__t.analysisToggle('contact0'));
  an = await ev(() => window.__t.analysis());
  check('Bericht: Zeile Kontakt mit Reibung, aufgeklappt Kraft und Pressung', an.inputs.some((x) => x.startsWith('ContactFriction 0.3 · Fuss – Wand'))
    && an.details.some((x) => x.includes('Carries') && x.includes('Highest pressure')), JSON.stringify(an));
  await domClick('btn-result-close');
  // Der Kontakt hält die Platte, die Armspitze ist nur seitlich geführt. Die Berührfläche findet CalculiX erst nach 11
  // Iterationen; früher galt das ab 12 als Pendeln, und das weiche Gesetz drückte die Teile auseinander
  study('arm', `from soma.fem import Study
study = Study("Arm", material="Steel S235", check_mesh=False)
study.fix("Grund", faces="<Z")
study.fix("Halter", faces=">Z", axes="xy")
study.force("Halter", faces=">Z", N=(0, 0, -200))
study.contact("Grund", "Halter", friction=0.2)
`);
  r = soma(['analyze', 'fem', 'analyses/arm.py']);
  check('Platte mit Arm auf Kontakt: rechnet mit dem steifen Gesetz, trägt 200 N, im Gleichgewicht', r.status === 0
    && /contact: Grund – Halter \(3600\.0 mm², friction 0\.2\), carries 200\.0 N/.test(r.stdout) && r.stdout.includes('(in equilibrium)')
    && !r.stdout.includes('softer one'), r.stdout + r.stderr);

  // Verschraubung: erst 3000 N Vorspannung, dann 1000 N Zug an der Lasche. Die Fuge trägt die Vorspannung minus den Zug
  const LASCHE = (extra) => `from soma.fem import Study
study = Study("Lasche verschraubt", material="Aluminium 6082", mesh=4, check_mesh=False)
study.fix("Sockel", faces="<Z")
study.force("Lasche", faces=">Z", N=(0, 0, 1000))
${extra}
`;
  study('lasche', LASCHE('study.contact("Sockel", "Lasche", friction=0.2)\nstudy.bolt("Schraube", preload=3000)'));
  r = soma(['analyze', 'fem', 'analyses/lasche.py']);
  const bf = Number(/bolt: Schraube \(ISO 4762 M5x16, 8\.8, thread in Sockel\), preload 3000 N \(given\), in the end (\d+) N pull/.exec(r.stdout)?.[1]);
  const jf = Number(/contact: Sockel – Lasche \([\d.]+ mm², friction 0\.2\), carries (\d+\.\d) N/.exec(r.stdout)?.[1]);
  check('bolt(): Vorspannung 3000 N, Schraube am Ende etwas mehr, Fuge trägt Schraubenkraft minus Zug, im Gleichgewicht', r.status === 0
    && bf >= 3000 && bf < 3300 && near(jf, bf - 1000, 15) && r.stdout.includes('linear elastic, with contact and bolts')
    && r.stdout.includes('touching: Lasche – Schraube') && r.stdout.includes('bonded (bolt: head and thread)')
    && r.stdout.includes('(in equilibrium)') && /2 load steps/.test(r.stdout), r.stdout + r.stderr);
  await ev(() => window.__t.refreshViewLists());
  await ev(() => window.__t.resultShow('lasche'));
  await waitFor('Ergebnis Lasche geladen', () => window.__t.result().id === 'lasche', 20000);
  await ev(() => window.__t.showPanel('analysis'));
  await waitFor('Bericht Lasche', () => window.__t.analysis().title === 'Lasche verschraubt', 20000);
  await ev(() => window.__t.analysisToggle('bolt0'));
  an = await ev(() => window.__t.analysis());
  check('Bericht: Zeile Bolt mit Kraft und Schraube, aufgeklappt Vorspannung und Auslastung', an.inputs.some((x) => x.startsWith('Bolt') && x.includes('· Schraube'))
    && an.details.some((x) => x.includes('Preload3,000 N') && x.includes('of the yield strength')), JSON.stringify(an));
  const boltIds = await ev(() => window.__t.viewer.partList().filter((p) => ['Sockel', 'Lasche', 'Schraube'].includes(p.name)).map((p) => p.id));
  await ev(() => window.__t.viewer.setSection({ normal: [0, 1, 0], constant: 250 }));
  await ev((ids) => window.__t.viewer.setView('front', ids), boltIds);
  await shot('fem-6-schraube');
  await ev(() => window.__t.viewer.setSection(null));
  await domClick('btn-result-close');
  // Ohne Kontakt und ohne Angabe: Vorspannung 70 % der Streckgrenze im Spannungsquerschnitt (0.7 x 640 x 14.18 mm²)
  study('lasche', LASCHE('study.bolt("Schraube")'));
  r = soma(['analyze', 'fem', 'analyses/lasche.py']);
  check('bolt() ohne preload: 6354 N automatisch, Schraube aus Stahl 8.8', r.status === 0 && r.stdout.includes('preload 6354 N (automatic)')
    && r.stdout.includes('Schraube (steel 8.8, E 210000 MPa, strength 640 MPa)'), r.stdout + r.stderr);
  study('lasche', LASCHE('study.bolt("Lasche")'));
  r = soma(['analyze', 'fem', 'analyses/lasche.py']);
  check('bolt() auf einem Teil, das keine Schraube ist: Meldung', r.status !== 0 && (r.stdout + r.stderr).includes("bolt('Lasche'): not a screw from soma.fasteners"), r.stdout + r.stderr);

  // 8) Das Beispiel im Skill läuft so, wie es dasteht
  const skill = fs.readFileSync(path.join(APP, 'resources', 'skills', 'fem.md'), 'utf8');
  const block = /```python\r?\n([\s\S]*?)\r?\n```/.exec(skill)?.[1] ?? '';
  study('skill', block);
  r = soma(['analyze', 'fem', 'analyses/skill.py']);
  // Gleichgewicht: Die Knotenkräfte aus der frd von CalculiX lagen hier 5 % daneben, die Lagerkräfte rechnet soma selbst
  check('Beispiel aus dem Skill „Strength with FEM“ rechnet ohne Fehler, im Gleichgewicht', r.status === 0 && r.stdout.includes('FEM "Bracket, 5 kg on the arm"')
    && /Bracket \(PETG/.test(r.stdout) && r.stdout.includes('(in equilibrium)'), r.stdout.slice(0, 900) + r.stderr);
} catch (e) {
  t.fail();
  console.log('ABBRUCH:', e);
  console.log(app?.log().slice(-3000));
} finally {
  await app?.stop();
  if (app) cleanup(app.ud);
}
console.log(t.fails ? `\n${t.fails} PRÜFUNG(EN) FEHLGESCHLAGEN` : '\nALLE PRÜFUNGEN BESTANDEN');
process.exit(t.fails ? 1 : 0);
