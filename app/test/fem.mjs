// Test der FEM-Auswertung (E65): soma analyze fem mit einer Studie in analyses/, Vergleich mit der Balkenformel, verschmolzene
// Teile mit eigenem Werkstoff, Druck, Eigengewicht und near=, Fehlermeldungen (Lagerung, Bauteil, Selektor, kein fix), Anzeige in
// der App (Karte mit Lastfall, Überhöhung, Wert unter dem Zeiger in Ausgangslage, An Agent geben), soma render --result,
// veraltet nach Änderung der Studie, Neu berechnen und das Beispiel aus dem Skill.
// Aufruf: node test/run-all.mjs fem (baut vorher mit npm run build). SMOKE_VISIBLE=offscreen SMOKE_SHOTS=1 legt Bilder ab.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { APP, checker, cleanup, sleep, startApp } from './harness.mjs';

const t = checker();
const { check } = t;
let app;

const PY = process.env.SOMA_PYTHON || path.join(process.env.LOCALAPPDATA ?? '', 'cadide-phase0', 'venv-full', 'Scripts', 'python.exe');

// Kragbalken 100 x 10 x 10 entlang +X (Formel: w = 4 F L³ / (E b h³)), ein Winkel aus zwei Teilen, die sich berühren, und die
// Konsole aus dem Beispiel im Skill
const MODEL = `import cadquery as cq
from soma import add_part

add_part("Balken", cq.Workplane().box(100, 10, 10, centered=(False, True, True)))
fuss = cq.Workplane().box(60, 40, 5, centered=(True, True, False)).translate((0, 100, 0))
wand = cq.Workplane().box(5, 40, 40, centered=(True, True, False)).translate((27.5, 100, 5))
add_part("Fuss", fuss)
add_part("Wand", wand)
bracket = cq.Workplane().box(40, 20, 4, centered=(False, True, False)).union(
    cq.Workplane().box(4, 20, 30, centered=(False, True, False))).translate((0, -100, 0))
add_part("Bracket", bracket)
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
  await waitFor('Testmodell gebaut', () => window.__t.status().state === 'ok' && window.__t.partCount() === 4, 90000);
  const bridge = await ev(() => window.soma.test.bridge());
  const env = { ...process.env, ...bridge, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
  const soma = (args) => spawnSync(PY, ['-m', 'soma', ...args], { cwd: dir, env, encoding: 'utf8', timeout: 10 * 60 * 1000 });
  fs.mkdirSync(path.join(dir, 'analyses'));
  const study = (name, text) => fs.writeFileSync(path.join(dir, 'analyses', `${name}.py`), text);

  // 1) Kragbalken gegen die Formel: w = 4 * 50 * 100³ / (70000 * 10 * 10³) = 0,2857 mm, Spannung an der Einspannung 30 MPa
  study('balken', BALKEN(50));
  let r = soma(['analyze', 'fem', 'analyses/balken.py']);
  const w = Number(/größte Verschiebung (\d+\.\d+) mm/.exec(r.stdout)?.[1]);
  const s = Number(/höchste Vergleichsspannung (\d+\.\d) MPa/.exec(r.stdout)?.[1]);
  check('Kragbalken: Durchbiegung wie die Formel (0,286 mm, ±2 %)', r.status === 0 && near(w, 0.2857, 0.006), r.stdout + r.stderr);
  check('Kragbalken: Spannung an der Einspannung um 30 MPa, Sicherheit über 2, nichts kritisch', near(s, 30, 4) && /kleinste Sicherheit [5-9]\.\d\d, nichts unter 2/.test(r.stdout), r.stdout);
  check('Lastfall in der Ausgabe: fest 100 mm² mit Lagerkraft 50 N, Kraft 100 mm², im Gleichgewicht', /fest: Balken <X \(100\.0 mm²\), Lagerkraft \(0\.0, 0\.0, 50\.0\) N/.test(r.stdout)
    && /Kraft: Balken >X \(100\.0 mm²\), \(0\.0, 0\.0, -50\.0\) N/.test(r.stdout) && r.stdout.includes('(im Gleichgewicht)'), r.stdout);
  check('Netzprüfung: zweite Rechnung mit gröberem Netz genannt, Hinweis zur Spitze an der Einspannung', /mit gröberem Netz \d+\.\d MPa/.test(r.stdout)
    && r.stdout.includes('am Rand einer Einspannung'), r.stdout);
  check('Ergebnisdatei .soma/results/balken.glb', fs.existsSync(path.join(dir, '.soma', 'results', 'balken.glb')));

  // 2) Zwei verschmolzene Teile mit eigenem Werkstoff, Druck über near=, Eigengewicht
  study('winkel', WINKEL);
  r = soma(['analyze', 'fem', 'analyses/winkel.py']);
  check('Winkel: beide Teile mit ihrem Werkstoff, Druck 0,2 MPa auf 1600 mm² (320 N), Eigengewicht, im Gleichgewicht', r.status === 0
    && /Fuss \(Aluminium 6082/.test(r.stdout) && /Wand \(Steel S235/.test(r.stdout) && /Druck: Wand nahe \(30, 100, 30\) \(1600\.0 mm²\), 0\.2 MPa, zusammen \(-320\.0, 0\.0, 0\.0\) N/.test(r.stdout)
    && r.stdout.includes('Eigengewicht') && r.stdout.includes('(im Gleichgewicht)'), r.stdout + r.stderr);
  check('Winkel: Einspannung 2400 mm² trägt Druck und Gewicht', /fest: Fuss <Z \(2400\.0 mm²\), Lagerkraft \(320\.0, 0\.0, \d\.\d\) N/.test(r.stdout), r.stdout);

  // 3) Fehler: verständlich, Exit 1, keine Ergebnisdatei
  study('lose', LOSE);
  r = soma(['analyze', 'fem', 'analyses/lose.py']);
  check('Nur in Z gehalten: meldet, was noch frei ist', r.status === 1 && /Lagerung reicht nicht[^\n]*Fuss, Wand: noch frei beweglich \([^)]*Verschiebung in X/.test(r.stderr + r.stdout), r.stderr + r.stdout);
  study('kaputt', BALKEN(1).replace('fix("Balken"', 'fix("Gibtsnicht"'));
  r = soma(['analyze', 'fem', 'analyses/kaputt.py']);
  check('Unbekanntes Bauteil: nennt die vorhandenen', r.status === 1 && (r.stderr + r.stdout).includes("Bauteil 'Gibtsnicht' gibt es nicht") && (r.stderr + r.stdout).includes("'Balken'"), r.stderr + r.stdout);
  study('kaputt', BALKEN(1).replace('faces="<X"', 'faces="<Q"'));
  r = soma(['analyze', 'fem', 'analyses/kaputt.py']);
  check('Falscher Selektor: Fehler nennt ihn', r.status === 1 && (r.stderr + r.stdout).includes("Selektor '<Q'"), r.stderr + r.stdout);
  study('kaputt', BALKEN(1).replace(/study\.fix[^\n]*\n/, ''));
  r = soma(['analyze', 'fem', 'analyses/kaputt.py']);
  check('Ohne fix: verlangt eine Einspannung', r.status === 1 && (r.stderr + r.stdout).includes('Mindestens ein study.fix'), r.stderr + r.stdout);
  study('kaputt', 'from soma.fem import Study\nx = 1 / 0\n');
  r = soma(['analyze', 'fem', 'analyses/kaputt.py']);
  check('Fehler im Code der Studie: Datei und Zeile 2', r.status === 1 && (r.stderr + r.stdout).includes('analyses/kaputt.py (Zeile 2): ZeroDivisionError'), r.stderr + r.stdout);
  r = soma(['analyze', 'fem']);
  check('Ohne Studie: Hinweis auf die Datei', r.status === 1 && (r.stderr + r.stdout).includes('braucht die Datei mit dem Lastfall'), r.stderr + r.stdout);
  check('Fehler legen keine Ergebnisse an', !fs.existsSync(path.join(dir, '.soma', 'results', 'kaputt.glb')) && !fs.existsSync(path.join(dir, '.soma', 'results', 'lose.glb')));

  // 4) Anzeige in der App: Karte mit Lastfall und Überhöhung, Wert unter dem Zeiger in Ausgangslage
  await ev(() => window.__t.openViewMenu());
  await ev(() => { [...document.querySelectorAll('#menu-view .mi')].find((b) => b.textContent.includes('Balken unter Last')).click(); });
  await waitFor('FEM-Ergebnis geladen', () => window.__t.result().id === 'balken', 20000);
  let rs = await ev(() => window.__t.result());
  // Überhöhung: 5 % von 101 mm / 0,286 mm = 17,7, auf eine runde Zahl abgerundet 10
  check('Karte: Sicherheit, Spannung, Verschiebung je Teil, Lastfall in zwei Zeilen, verformt 10-fach', rs.active && rs.fem
    && rs.rows.some((x) => x.startsWith('Balken') && /Sicherheit \d+,\d+ · 30(,\d)? MPa · 0,28\d mm$/.test(x))
    && rs.fem.bcRows.length === 2 && rs.fem.bcRows[0].startsWith('fest') && rs.fem.bcRows[0].includes('Lagerkraft 50 N') && rs.fem.bcRows[1].startsWith('Kraft')
    && rs.fem.scale === 10 && rs.fem.options.includes('10-fach überhöht') && rs.fem.bcs === true && rs.meta.unit === '', JSON.stringify(rs));
  check('Hinweis in der Karte nennt den Befehl mit der Studie', rs.hint.startsWith('soma analyze fem analyses/balken.py'), rs.hint);
  await ev(() => window.__t.viewer.setView('front'));
  await sleep(300);
  // Vorderseite am Ende: um 10 x 0,28 mm nach unten verschoben gezeichnet, der Wert nennt die Stelle im unverformten Modell
  const at = await ev(() => window.__t.viewer.screenAt([97, -5, -2.8]));
  const pin = await ev((p) => window.__t.resultPin(p.x, p.y), at);
  check('Klick auf das verformte Balkenende: Stelle in Ausgangslage, Verschiebung um 0,28 mm, Spannung klein', pin?.name === 'Balken'
    && near(pin.point[0], 97, 1) && near(pin.point[2], 0, 1.2) && near(pin.disp, 0.28, 0.03) && pin.stress < 5 && pin.value > 20, JSON.stringify(pin));
  rs = await ev(() => window.__t.result());
  check('An Agent geben: Sicherheit, Spannung und Verschiebung', /^\[Ergebnis: "Balken unter Last" \(\.soma\/results\/balken\.glb, Grenzwert 2\.00\), Bauteil "Balken": Sicherheit (über 99|\d+\.\d\d) \(\d+\.\d MPa, Verschiebung 0\.2\d\d mm\) bei \(/.test(rs.note), rs.note);
  await ev(() => window.__t.viewer.setView('iso'));
  await shot('fem-1');
  await ev(() => { const s = document.getElementById('result-deform'); s.value = '0'; s.dispatchEvent(new Event('change')); });
  await domClick('btn-result-bcs');
  rs = await ev(() => window.__t.result());
  check('Unverformt und Lastfall aus', rs.fem.scale === 0 && rs.fem.bcs === false, JSON.stringify(rs.fem));
  await domClick('btn-result-bcs');

  // Farbskala: Spannung statt Sicherheit (Grenze 250 / 2 = 125 MPa, kritisch darüber), Spanne Min bis Max und eigene
  const pick = (id, v) => ev((a) => { const s = document.getElementById(a.id); s.value = a.v; s.dispatchEvent(new Event('change')); }, { id, v });
  check('Skala automatisch: Sicherheit, Spanne der Auswertung', rs.scale.field === 'value' && rs.scale.mode === 'auto' && rs.scale.canStress
    && rs.scale.range[0] === 0 && rs.scale.threshold === 2, JSON.stringify(rs.scale));
  await pick('result-field', 'stress');
  rs = await ev(() => window.__t.result());
  check('Spannung: MPa, Grenze 125 MPa kritisch darüber, Skala 0 bis 250', rs.scale.field === 'stress' && rs.scale.unit === 'MPa'
    && rs.scale.threshold === 125 && rs.scale.range.join() === '0,250' && rs.scale.legend.includes('Vergleichsspannung (von Mises) (MPa)')
    && rs.scale.legend.includes('Grenze 125 MPa, kritisch darüber'), JSON.stringify(rs.scale));
  await ev(() => window.__t.viewer.setView('front'));
  await sleep(300);
  const pin2 = await ev((p) => window.__t.resultPin(p.x, p.y), at);
  await ev(() => window.__t.viewer.setView('iso'));
  rs = await ev(() => window.__t.result());
  check('Stelle bei Spannung: MPa zuerst, Sicherheit danach', pin2?.stress != null && /: Balken, \d+,\d MPa · Sicherheit /.test(rs.probe), rs.probe);
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
  const ends = await ev(() => getComputedStyle(document.querySelector('#result-legend .rs-bar')).backgroundImage.match(/rgb\([^)]*\)/g));
  check('Eigene Skala 10 bis 40 MPa gilt sofort, Farbe über die Spanne bis Rot, Grenze außerhalb ohne Strich', rs.scale.range.join() === '10,40'
    && rs.scale.legend.includes('Farbe über die Spanne') && ends.at(-1) === 'rgb(240, 116, 112)'
    && await ev(() => document.querySelector('#result-legend .rs-mark').hidden), JSON.stringify(rs.scale) + ends?.join(' '));
  await shot('fem-2');
  await typeIn('result-lo', '50');
  rs = await ev(() => window.__t.result());
  check('Von größer als bis: rot umrandet, Skala bleibt', rs.scale.range.join() === '10,40' && await ev(() => document.getElementById('result-lo').classList.contains('bad')), JSON.stringify(rs.scale));
  await typeIn('result-lo', '10');
  await pick('result-field', 'value');
  rs = await ev(() => window.__t.result());
  check('Zurück zur Sicherheit: eigene Skala neu aus deren Spanne', rs.scale.field === 'value' && rs.scale.range[0] === 0 && rs.scale.threshold === 2
    && await ev(() => document.getElementById('result-hi').value) === String(rs.scale.range[1]), JSON.stringify(rs.scale));
  await pick('result-range', 'auto');

  // 5) soma render --result: Bild mit Legende
  r = soma(['render', '--result', 'balken']);
  check('soma render --result balken: Bild 1280 x 800', r.status === 0 && JSON.stringify(pngSize(path.join(dir, 'renders', 'ergebnis-balken.png'))) === '[1280,800]', r.stdout + r.stderr);

  // 6) Studie ändern: Ergebnis veraltet (die Studie zählt mit), Neu berechnen rechnet die neue Last
  await sleep(1100);
  study('balken', BALKEN(100));
  const stale = await ev(() => window.soma.results.list().then((l) => l.find((x) => x.id === 'balken')?.stale));
  check('Geänderte Studie: Ergebnis veraltet', stale === true, String(stale));
  await ev(() => window.__t.resultRefresh?.());
  await domClick('btn-result-rerun');
  await waitFor('neu berechnet', () => window.__t.result().stale === false && window.__t.result().fem?.bcRows?.[0]?.includes('100 N'), 120000).catch(() => {});
  rs = await ev(() => window.__t.result());
  check('Neu berechnen: Lagerkraft jetzt 100 N, Verschiebung doppelt', !rs.stale && rs.fem?.bcRows[0].includes('Lagerkraft 100 N')
    && rs.rows.some((x) => x.startsWith('Balken') && /0,5[67]\d mm/.test(x)), JSON.stringify(rs));
  await domClick('btn-result-close');
  check('Analyse aus: Modell wieder sichtbar', !(await ev(() => window.__t.viewer.animViewState())).modelHidden);

  // 7) Das Beispiel im Skill läuft so, wie es dasteht
  const skill = fs.readFileSync(path.join(APP, 'resources', 'skills', 'fem.md'), 'utf8');
  const block = /```python\r?\n([\s\S]*?)\r?\n```/.exec(skill)?.[1] ?? '';
  study('skill', block);
  r = soma(['analyze', 'fem', 'analyses/skill.py']);
  check('Beispiel aus dem Skill „Festigkeit mit FEM“ rechnet ohne Fehler', r.status === 0 && r.stdout.includes('FEM "Bracket, 5 kg on the arm"')
    && /Bracket \(PETG/.test(r.stdout), r.stdout.slice(0, 600) + r.stderr);
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
