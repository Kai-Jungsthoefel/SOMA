// Test von Animation, Analyse, soma render und Video (E58): Animationsdateien bauen (auch über den Watcher), Ablauf als Text,
// Kollisionsprüfung, Fehler mit Datei und Zeile, Abspielen im Viewer (Lage, Hervorhebung, Kamera), Ausschluss mit Explosion
// und Messen, soma render über die App (Bild, Übersicht, Video mit Untertiteln), Fehler der Verbindung, Video abspielen und
// Standbild markieren, Auswertungen (Überhang, Wandstärke, Abstand) mit Anzeige, Wert unter dem Zeiger und Neu berechnen.
// Aufruf: npm run test:animation (baut vorher). SMOKE_VISIBLE=offscreen SMOKE_SHOTS=1 legt Bilder ab.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP, checker, cleanup, sleep, startApp } from './harness.mjs';

const t = checker();
const { check } = t;
let app;

const PY = process.env.SOMA_PYTHON || path.join(process.env.LOCALAPPDATA ?? '', 'cadide-phase0', 'venv-full', 'Scripts', 'python.exe');

// Kasten mit Deckel (Scharnier hinten oben), dazu Teile für die Auswertungen: Halter mit Bohrung 6,4 und Stift 6 darin (Spalt 0,2),
// Konsole mit waagerechter Unterseite in 10 mm Höhe (Überhang), Lasche 1 mm dünn, Störer 2 mm im Halter (Überschneidung)
const MODEL = (tab = 1.0) => `import cadquery as cq
from soma import add_part

W, D, H, WALL = 60.0, 40.0, 25.0, 2.0
body = cq.Workplane("XY").box(W, D, H, centered=(True, True, False)).faces(">Z").shell(-WALL)
lid = cq.Workplane("XY").box(W, D, WALL, centered=(True, True, False)).translate((0, 0, H))
holder = cq.Workplane("XY").box(20, 20, 10, centered=(True, True, False)).translate((50, 0, 0)).cut(
    cq.Workplane("XY").circle(3.2).extrude(20).translate((50, 0, -5)))
pin = cq.Workplane("XY").circle(3).extrude(14).translate((50, 0, -2))
console = cq.Workplane("XY").box(6, 6, 10, centered=(True, True, False)).translate((-50, 0, 0)).union(
    cq.Workplane("XY").box(20, 20, 4, centered=(True, True, False)).translate((-50, 0, 10)))
tab = cq.Workplane("XY").box(20, ${tab}, 12, centered=(True, True, False)).translate((0, -40, 0))
clash = cq.Workplane("XY").box(6, 6, 6, centered=(True, True, False)).translate((61, 0, 0))
add_part("Body", body, color=(0.25, 0.45, 0.75))
add_part("Lid", lid, color=(0.85, 0.85, 0.88))
add_part("Halter", holder)
add_part("Stift", pin, color=(0.6, 0.6, 0.62))
add_part("Konsole", console)
add_part("Lasche", tab, color=(0.8, 0.5, 0.3))
add_part("Störer", clash, color=(0.7, 0.3, 0.3))
`;

const DECKEL = (extra = '') => `from soma.anim import Animation
from model import D, H

a = Animation("Deckel öffnen")
lid = a.hinge("Lid", (0, D / 2, H), (1, D / 2, H))
a.camera.set(view="iso")
a.title("Kasten mit Deckel", subtitle="Scharnier hinten", duration=1)
a.caption("Der Deckel öffnet bis 110°")
a.play(lid.to(-110), run_time=2)
a.label("Scharnier", part="Lid", at=(0, D / 2, H))
a.wait(0.5)
a.play(a.camera.orbit(90), run_time=2)
a.caption(None)
a.play(lid.to(0), a.camera.move(view="front", zoom=1.3), run_time=1.5, ease="linear")
a.highlight("Body", duration=1)
a.wait(1)
${extra}`;

// Drehachse durch die Mitte des Deckels: Er dreht in den Kasten hinein
const FALSCH = `from soma.anim import Animation

a = Animation("Deckel falsch")
lid = a.hinge("Lid", (0, 0, 26), (1, 0, 26))
a.play(lid.to(60), run_time=1)
`;
const KAPUTT = `from soma.anim import Animation
a = Animation("Kaputt")
a.hinge("Gibtsnicht", (0, 0, 0), (1, 0, 0))
`;

const near = (a, b, eps = 1e-3) => Math.abs(a - b) <= eps;
const pngSize = (f) => { const b = fs.readFileSync(f); return b.toString('ascii', 1, 4) === 'PNG' ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null; };

try {
  app = await startApp({ name: 'animation' });
  const { ev, waitFor, domClick } = app;
  const shot = async (name) => {
    if (!process.env.SMOKE_SHOTS) return;
    fs.mkdirSync(path.join(APP, 'test', 'shots'), { recursive: true });
    await sleep(900);
    await app.screenshot(path.join(APP, 'test', 'shots', `${name}.png`)).catch((e) => console.log('Screenshot:', e.message));
  };
  await waitFor('Projekt und Build', () => !!window.__t && !!window.__t.project() && window.__t.status().state === 'ok' && window.__t.partCount() > 0);
  const proj = await ev(() => window.__t.project());
  const dir = proj.dir;
  fs.writeFileSync(path.join(dir, 'model.py'), MODEL());
  await waitFor('Testmodell gebaut', () => window.__t.status().state === 'ok' && window.__t.partCount() === 7, 90000);
  const ids = await ev(() => Object.fromEntries(window.__t.parts().map((p) => [p.name, p.id])));
  const bridge = await ev(() => window.soma.test.bridge());
  const env = { ...process.env, ...bridge, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
  const soma = (args, opts = {}) => spawnSync(PY, ['-m', 'soma', ...args], { cwd: dir, env, encoding: 'utf8', timeout: 10 * 60 * 1000, ...opts });
  const tid = await ev(() => window.__t.terminals.activeId);
  const term = () => ev((id) => window.__t.termText(id), tid);
  check('Verbindung für soma render: Adresse auf 127.0.0.1 und Schlüssel', /^127\.0\.0\.1:\d+$/.test(bridge.SOMA_APP ?? '') && (bridge.SOMA_APP_TOKEN ?? '').length >= 32, bridge.SOMA_APP);

  // 1) Animationsdatei anlegen: Der Watcher baut sie, die Liste kennt sie
  fs.mkdirSync(path.join(dir, 'animations'));
  fs.writeFileSync(path.join(dir, 'animations', 'deckel.py'), DECKEL());
  const list = () => ev(() => window.soma.anim.list());
  await waitFor('Animation gebaut (Watcher)', () => window.soma.anim.list().then((l) => l.animations.some((a) => a.name === 'Deckel öffnen') && !l.building), 90000);
  let l = await list();
  let e = l.animations.find((a) => a.name === 'Deckel öffnen');
  check('Watcher baut neue Animationsdatei: Name, Datei, Zeile 4, 8 s, ein bewegtes Teil, aktuell', e.id === 'deckel-oeffnen' && e.file === 'animations/deckel.py'
    && e.line === 4 && near(e.duration, 8) && e.parts === 1 && !e.stale && fs.existsSync(path.join(dir, '.soma', 'anim', 'deckel-oeffnen.glb')), JSON.stringify(e));
  check('Animationsdatei baut das Modell nicht neu (eigener Weg)', await ev(() => window.__t.buildStarts()) <= 2, String(await ev(() => window.__t.buildStarts())));

  let r = soma(['anim', 'info', 'Deckel öffnen']);
  check('soma anim info: Ablauf mit Zeiten, Gelenk, Kamera, Untertitel, Beschriftung', r.status === 0 && r.stdout.includes('Dauer 8.00 s')
    && r.stdout.includes('1.00-3.00 s      Lid: 0 -> -110 Grad') && r.stdout.includes('Kamera: Umlauf 90 Grad') && r.stdout.includes('"Der Deckel öffnet bis 110°"')
    && r.stdout.includes('"Scharnier" an Lid') && r.stdout.includes('nicht geprueft'), r.stdout.slice(0, 300) + r.stderr);

  // 2) Kollisionen: falsche Drehachse dreht den Deckel in den Kasten
  fs.writeFileSync(path.join(dir, 'animations', 'falsch.py'), FALSCH);
  await waitFor('zweite Animation', () => window.soma.anim.list().then((x) => x.animations.length === 2 && !x.building), 90000);
  r = soma(['anim', 'check', 'Deckel falsch', '--step', '0.25']);
  check('soma anim check meldet die Kollision Lid / Body mit Zeit und Tiefe (Exit 1)', r.status === 1 && /Lid \/ Body: Kollision, bis \d+\.\d\d mm tief/.test(r.stdout), r.stdout + r.stderr);
  r = soma(['anim', 'check', 'Deckel öffnen', '--step', '0.5']);
  check('Richtige Drehachse: keine Kollision (Exit 0), der aufliegende Deckel gilt als gewollte Berührung', r.status === 0 && !r.stdout.includes('Kollision,')
    && /Beruehren sich schon im Modell[^\n]*Lid \/ Body/.test(r.stdout), r.stdout);
  r = soma(['anim', 'info', 'Deckel falsch']);
  check('Ergebnis der Prüfung steht danach in soma anim info', r.stdout.includes('Lid / Body: Kollision'), r.stdout.slice(-300));

  // 3) Fehler in einer Animationsdatei: Datei, Zeile, Liste der Bauteile. Die anderen bleiben
  fs.writeFileSync(path.join(dir, 'animations', 'kaputt.py'), KAPUTT);
  await waitFor('Fehler gemeldet', () => window.soma.anim.list().then((x) => x.errors.length === 1 && !x.building), 90000);
  l = await list();
  check('Fehler mit Datei und Zeile 3, nennt das Bauteil und die vorhandenen, die anderen Animationen bleiben', l.errors[0].file === 'animations/kaputt.py'
    && l.errors[0].line === 3 && l.errors[0].message.includes("'Gibtsnicht' gibt es im Modell nicht") && l.errors[0].message.includes("'Lid'") && l.animations.length === 2,
    JSON.stringify(l.errors[0]));
  r = soma(['anim', 'build', 'animations/kaputt.py']);
  check('soma anim build: FEHLER mit Ort im Fehlerkanal, Exit 1', r.status === 1 && r.stderr.includes('Animation FEHLER (animations/kaputt.py:3)'), r.stderr.slice(0, 200));
  fs.rmSync(path.join(dir, 'animations', 'kaputt.py'));
  await waitFor('Fehler weg', () => window.soma.anim.list().then((x) => x.errors.length === 0), 20000).catch(() => {});
  check('Gelöschte Datei: Ihr Fehler verschwindet aus der Liste', (await list()).errors.length === 0);

  // 4) Abspielen im Viewer. Animationen und Analysen wählt man im Umschalter oben links (Entwurf 2), `pickView` klickt den
  // Eintrag, dessen Text `label` enthält (eine Zahl: der n-te Eintrag, 0 ist „Modell“)
  const pickView = async (label) => {
    await ev(() => window.__t.openViewMenu());
    await ev((l) => { const items = [...document.querySelectorAll('#menu-view .mi')]; (typeof l === 'number' ? items[l] : items.find((b) => b.textContent.includes(l))).click(); }, label);
  };
  await pickView('Deckel öffnen');
  await waitFor('Animation geladen', () => window.__t.anim().name !== null, 20000);
  await ev(() => { const s = document.getElementById('anim-select'); s.value = 'deckel-oeffnen'; s.dispatchEvent(new Event('change')); });
  await waitFor('Deckel öffnen gewählt', () => window.__t.anim().name === 'Deckel öffnen', 10000);
  let s = await ev(() => window.__t.anim());
  check('Karte „Animation“: zwei zur Auswahl, Dauer 8 s, Kamera folgt (eigene Kamera), Hinweis mit Datei', s.active && s.options.length === 2 && near(s.duration, 8)
    && s.follow && s.hint.startsWith('animations/deckel.py, Zeile 4') && s.time === '0,00 / 8,00 s'
    && JSON.stringify(await ev(() => window.__t.viewSwitch())) === '{"name":"Deckel öffnen","sub":"","unseen":0,"closable":true}', JSON.stringify(s));
  await ev(() => window.__t.animSeek(3));
  let pose = await ev((id) => window.__t.viewer.partPose(id), ids.Lid);
  const q = [-Math.sin(55 * Math.PI / 180), 0, 0, Math.cos(55 * Math.PI / 180)];
  check('Bei 3 s: Deckel um 110° um die hintere Kante gedreht (Mitte und Drehung)', near(pose.center[1], 27.78, 0.05) && near(pose.center[2], 43.45, 0.05)
    && pose.quaternion.every((v, i) => near(Math.abs(v), Math.abs(q[i]), 2e-3)), JSON.stringify(pose));
  const body0 = await ev((id) => window.__t.viewer.partPose(id), ids.Body);
  check('Andere Teile bleiben in Einbaulage', near(body0.center[2], 12.5, 1e-3) && body0.quaternion[3] === 1, JSON.stringify(body0));
  await shot('anim-1-offen');
  await ev(() => window.__t.animSeek(7.5));
  let vs = await ev(() => window.__t.viewer.animViewState());
  const view = await ev(() => window.__t.viewer.viewState());
  check('Bei 7,5 s: Kasten hervorgehoben, Kamera von vorn, Texte werden gemalt', vs.highlight.includes(ids.Body) && vs.painter
    && near(view.dir[0], 0, 0.02) && near(view.dir[1], -1, 0.02), JSON.stringify([vs, view.dir]));
  s = await ev(() => window.__t.anim());
  check('„An Agent geben“: Name, Datei und Zeit', s.note === '[Animation: "Deckel öffnen" (animations/deckel.py) bei 7.50 s] ', s.note);
  // Schalter „Texte“: Titel, Untertitel und Beschriftungen aus, Bewegung und Hervorhebung bleiben
  await domClick('btn-anim-texts');
  const noText = { s: await ev(() => window.__t.anim()), vs: await ev(() => window.__t.viewer.animViewState()) };
  await domClick('btn-anim-texts');
  const withText = { s: await ev(() => window.__t.anim()), vs: await ev(() => window.__t.viewer.animViewState()) };
  check('„Texte“ aus: nichts gemalt, Hervorhebung bleibt, wieder an: Texte zurück', !noText.s.texts && !noText.vs.painter && noText.vs.highlight.includes(ids.Body)
    && withText.s.texts && withText.vs.painter, JSON.stringify([noText.s.texts, noText.vs.painter, withText.vs.painter]));
  await ev(() => window.__t.animSeek(2));
  await shot('anim-2-halb');

  // 5) Ausschluss: Explosion und Messen beenden die Animation, das Modell steht wieder in Einbaulage
  await domClick('btn-explode');
  await sleep(300);
  s = await ev(() => window.__t.anim());
  pose = await ev((id) => window.__t.viewer.partPose(id), ids.Lid);
  check('Explosion beendet die Animation (Deckel ohne Drehung, Hervorhebung weg)', !s.active && pose.quaternion[3] === 1
    && (await ev(() => window.__t.viewer.animViewState())).highlight.length === 0, JSON.stringify(pose));
  await pickView('Deckel öffnen');
  await waitFor('Animation wieder an', () => window.__t.anim().active && window.__t.anim().name === 'Deckel öffnen', 10000);
  check('Animation beendet die Explosion', !(await ev(() => window.__t.explode())).active);
  await domClick('btn-measure');
  await sleep(200);
  check('Messen beendet die Animation', !(await ev(() => window.__t.anim())).active && (await ev(() => window.__t.measure())).active);
  await domClick('btn-measure');

  // 6) soma render: Fehler der Verbindung
  r = soma(['render'], { env: { ...process.env, PYTHONUTF8: '1', SOMA_APP: '', SOMA_APP_TOKEN: '' } });
  check('Ohne die Umgebung der App: verständliche Meldung', r.status === 1 && r.stderr.includes('braucht die laufende App'), r.stderr);
  r = soma(['render'], { env: { ...env, SOMA_APP_TOKEN: 'x'.repeat(48) } });
  check('Falscher Schlüssel: abgelehnt', r.status === 1 && r.stderr.includes('Falscher Schlüssel'), r.stderr);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-anderes-'));
  r = soma(['render', '--project', other]);
  check('Anderer Ordner als das offene Modell: abgelehnt', r.status === 1 && r.stderr.includes('nicht das Modell'), r.stderr);
  cleanup(other);
  r = soma(['render', '--anim', 'Deckel öffnen', '--at', '99']);
  check('Zeit außerhalb der Animation: Meldung mit der Dauer', r.status === 1 && r.stderr.includes('dauert 8 s'), r.stderr);

  // 7) soma render: Bild, Animation zu einer Zeit, Übersicht, Video
  r = soma(['render']);
  const iso = path.join(dir, 'renders', 'ansicht-iso.png');
  check('soma render: renders/ansicht-iso.png in 1280 x 800', r.status === 0 && r.stdout.includes('geschrieben: renders/ansicht-iso.png')
    && JSON.stringify(pngSize(iso)) === '[1280,800]', r.stdout + r.stderr);
  r = soma(['render', '--view', 'top', '--size', '640x400', '--out', 'renders/oben.png']);
  check('--view, --size und --out', r.status === 0 && JSON.stringify(pngSize(path.join(dir, 'renders', 'oben.png'))) === '[640,400]', r.stdout + r.stderr);
  r = soma(['render', '--anim', 'Deckel öffnen', '--at', '2']);
  check('Animation zu einer Zeit: renders/deckel-oeffnen-2s.png', r.status === 0 && fs.existsSync(path.join(dir, 'renders', 'deckel-oeffnen-2s.png')), r.stdout + r.stderr);
  r = soma(['render', '--anim', 'Deckel öffnen', '--sheet', '3x2', '--size', '320x200']);
  const sheet = pngSize(path.join(dir, 'renders', 'deckel-oeffnen-uebersicht.png'));
  check('Übersicht 3 x 2 Standbilder mit Kopfzeile', r.status === 0 && sheet && sheet[0] === 3 * 320 + 4 * 6 && sheet[1] > 2 * 200, JSON.stringify(sheet) + r.stderr);
  const t0 = Date.now();
  r = soma(['render', '--anim', 'Deckel öffnen', '--video']);
  const mp4 = path.join(dir, 'renders', 'deckel-oeffnen.mp4');
  const head = fs.existsSync(mp4) ? fs.readFileSync(mp4).subarray(4, 8).toString('ascii') : '';
  const vtt = fs.existsSync(mp4.replace('.mp4', '.vtt')) ? fs.readFileSync(mp4.replace('.mp4', '.vtt'), 'utf8') : '';
  check('Video: MP4, Untertitel als WebVTT, Übersicht für den Agenten', r.status === 0 && head === 'ftyp' && vtt.startsWith('WEBVTT')
    && vtt.includes('00:00:01.000 --> 00:00:05.500') && vtt.includes('Der Deckel öffnet bis 110°') && r.stdout.includes('Uebersicht (PNG)'),
    `${head} ${Date.now() - t0} ms ${r.stderr}`);
  await waitFor('Hinweis im Fenster', () => window.__t.toast().text.includes('Der Agent hat renders/deckel-oeffnen.mp4'), 5000).catch(() => {});
  check('Das Fenster meldet, was der Agent erzeugt hat', (await ev(() => window.__t.toast())).text.includes('Der Agent hat renders/deckel-oeffnen.mp4'));

  // 8) Video abspielen, Zeit und Standbild an den Agenten
  await ev(() => window.__t.showPanel('files'));
  await waitFor('Video im Dateibaum', () => window.__t.fileRows().includes('deckel-oeffnen.mp4'), 10000).catch(() => {});
  await ev(() => document.querySelector('#tab-files .frow[data-path="renders/deckel-oeffnen.mp4"]')?.click());
  await waitFor('Video geladen', () => window.__t.video().ready >= 2 && window.__t.video().width > 0, 20000).catch(() => {});
  let v = await ev(() => window.__t.video());
  check('Klick im Dateibaum spielt das Video in der App: 1280 x 720, gut 8 s', v.open && v.file === 'renders/deckel-oeffnen.mp4' && v.width === 1280 && v.height === 720
    && near(v.duration, 8.03, 0.1), JSON.stringify(v));
  await ev(() => window.__t.videoSeek(2));
  v = await ev(() => window.__t.video());
  check('Springen auf 2 s: Zeitanzeige', v.time.startsWith('00:02.00 / 00:08'), v.time);
  await shot('video-1');
  await domClick('btn-video-agent');
  await waitFor('Zeit im Terminal', (id) => window.__t.termText(id).includes('[Video: renders/deckel-oeffnen.mp4 bei 00:02.00]'), 8000, tid).catch(() => {});
  check('„Zeit an Agent“: Datei und Zeitstempel in der Eingabe', (await term()).includes('[Video: renders/deckel-oeffnen.mp4 bei 00:02.00]'), (await term()).slice(-200));
  await domClick('btn-video-mark');
  await waitFor('Zeichenfläche', () => window.__t.markup().active, 8000);
  const mk = await ev(() => window.__t.markup());
  check('„Markieren“: Standbild auf der Zeichenfläche, Quelle mit Zeitstempel', mk.source === 'renders/deckel-oeffnen.mp4 bei 00:02.00', JSON.stringify(mk.source));
  await shot('video-2-markieren');
  await domClick('btn-mark-send');
  await waitFor('Markierung im Terminal', (id) => window.__t.termText(id).includes('gezeichnet auf renders/deckel-oeffnen.mp4 bei 00:02.00]'), 10000, tid).catch(() => {});
  check('Markierung des Standbilds: Pfad des Bilds, Video und Zeit in der Eingabe', /\[Markierung: \.soma\/feedback\/markierung-[\d-]+\.png, gezeichnet auf renders\/deckel-oeffnen\.mp4 bei 00:02\.00\]/.test(await term()),
    (await term()).slice(-200));
  await domClick('btn-video-close');
  check('Schließen: Player weg', !(await ev(() => window.__t.video())).open);

  // 9) Knopf „Video erzeugen“ in der Animation
  await pickView('Deckel öffnen');
  await waitFor('Animation an', () => window.__t.anim().active && !!window.__t.anim().name, 10000);
  fs.rmSync(mp4);
  await domClick('btn-anim-video');
  await waitFor('Video erzeugt und geöffnet', () => window.__t.video().open && window.__t.video().file === 'renders/deckel-oeffnen.mp4', 120000).catch(() => {});
  check('„Video erzeugen“: MP4 entsteht und spielt in der App', fs.existsSync(mp4) && (await ev(() => window.__t.video())).open, JSON.stringify(await ev(() => window.__t.toast())));
  await domClick('btn-video-close');
  await domClick('btn-anim-close');

  // 10) Auswertungen
  r = soma(['analyze', 'overhang']);
  check('Überhang: Konsole hat 3,64 cm² Überhang (Unterseite in 10 mm Höhe), Kasten keinen', r.status === 0
    && /Konsole: 0\.0° bis 90\.0°, 3\.6\d cm² über 45\.0°/.test(r.stdout) && /Body: [^\n]*nichts über 45\.0°/.test(r.stdout), r.stdout + r.stderr);
  r = soma(['analyze', 'thickness']);
  check('Wandstärke: Lasche 1 mm unter dem Grenzwert 1,2, Kasten nicht', r.status === 0 && /Lasche: 1\.00 mm bis [^\n]*cm² unter 1\.20 mm/.test(r.stdout)
    && /Body: 2\.00 mm bis [^\n]*nichts unter 1\.20 mm/.test(r.stdout), r.stdout + r.stderr);
  r = soma(['analyze', 'clearance']);
  check('Abstand: Stift mit 0,2 mm Spalt kritisch, Störer überschneidet sich, Deckel liegt nur auf', r.status === 0
    && /Stift: [^\n]*unter 0\.50 mm/.test(r.stdout) && /Störer: -[^\n]*Ueberschneidung/.test(r.stdout) && /Lid: [^\n]*nichts unter 0\.50 mm[^\n]*Beruehrung/.test(r.stdout),
    r.stdout + r.stderr);
  await pickView(1); // erste Analyse über den Umschalter oben links
  await waitFor('Ergebnis geladen', () => window.__t.result().id !== null, 20000);
  await ev(() => { const s = document.getElementById('result-select'); s.value = 'thickness'; s.dispatchEvent(new Event('change')); });
  await waitFor('Wandstärke gewählt', () => window.__t.result().id === 'thickness', 10000);
  let rs = await ev(() => window.__t.result());
  vs = await ev(() => window.__t.viewer.animViewState());
  check('Karte „Analyse“: drei Ergebnisse, Wandstärke je Bauteil, Lasche kritisch, Modell tritt zurück', rs.active && rs.options.length === 3
    && rs.rows.some((x) => x.startsWith('Lasche') && x.includes('kritisch') && !x.includes('nichts')) && rs.rows.some((x) => x.startsWith('Body') && x.includes('nichts kritisch'))
    && vs.modelHidden && !rs.stale, JSON.stringify(rs.rows));
  await ev(() => window.__t.viewer.setView('front'));
  await sleep(300);
  const at = await ev(() => window.__t.viewer.screenAt([0, -40.5, 6]));
  const pin = await ev((p) => window.__t.resultPin(p.x, p.y), at);
  rs = await ev(() => window.__t.result());
  check('Klick auf die Lasche: Wert 1 mm an der Stelle, „An Agent geben“ nennt ihn', pin?.name === 'Lasche' && near(pin.value, 1, 0.02)
    && rs.note.startsWith('[Ergebnis: "Wandstärke" (.soma/results/thickness.glb, Grenzwert 1.20 mm), Bauteil "Lasche": 1.00 mm bei ('), JSON.stringify([pin, rs.note]));
  await ev(() => window.__t.viewer.setView('iso'));
  await shot('analyse-1');
  r = soma(['render', '--result', 'thickness']);
  check('soma render --result: Bild mit Farben und Legende', r.status === 0 && JSON.stringify(pngSize(path.join(dir, 'renders', 'ergebnis-thickness.png'))) === '[1280,800]', r.stderr);
  // Code ändern: Ergebnis veraltet, „Neu berechnen“ wertet das neue Modell aus
  fs.writeFileSync(path.join(dir, 'model.py'), MODEL(2.0));
  await waitFor('neuer Build', () => window.__t.status().state === 'ok' && window.__t.result().stale === true, 60000).catch(() => {});
  rs = await ev(() => window.__t.result());
  check('Nach Codeänderung: Ergebnis als veraltet gekennzeichnet', rs.stale && rs.hint.startsWith('Älter als der Code'), rs.hint);
  await domClick('btn-result-rerun');
  await waitFor('neu berechnet', () => window.__t.result().stale === false, 90000).catch(() => {});
  rs = await ev(() => window.__t.result());
  check('„Neu berechnen“: Lasche jetzt 2 mm, nichts kritisch', !rs.stale && rs.rows.some((x) => x.startsWith('Lasche') && x.includes('nichts kritisch')), JSON.stringify(rs.rows));
  await domClick('btn-result-close');
  check('Analyse aus: Modell wieder sichtbar', !(await ev(() => window.__t.viewer.animViewState())).modelHidden);

  // 11) Animationsdatei ändern: Der Watcher baut neu, die Dauer ändert sich
  fs.writeFileSync(path.join(dir, 'animations', 'deckel.py'), DECKEL('a.wait(1)\n'));
  await waitFor('Animation neu gebaut', () => window.soma.anim.list().then((x) => x.animations.some((a) => a.id === 'deckel-oeffnen' && Math.abs(a.duration - 9) < 1e-6)), 90000).catch(() => {});
  e = (await list()).animations.find((a) => a.id === 'deckel-oeffnen');
  check('Geänderte Animationsdatei: neu gebaut, jetzt 9 s', near(e.duration, 9) && !e.stale, JSON.stringify(e));

  // 12) Das Beispiel im Skill läuft so, wie es dasteht (Modell mit HINGE_Y, HINGE_Z und einer Schublade)
  const skill = fs.readFileSync(path.join(APP, 'resources', 'skills', 'animation.md'), 'utf8');
  const block = /```python\r?\n([\s\S]*?)\r?\n```/.exec(skill)?.[1] ?? '';
  fs.writeFileSync(path.join(dir, 'model.py'), `${MODEL()}HINGE_Y, HINGE_Z = D / 2, H
drawer = cq.Workplane("XY").box(20, 30, 8, centered=(True, True, False)).translate((-35, 0, 2))
add_part("Drawer", drawer)
`);
  await waitFor('Modell mit Schublade', () => window.__t.status().state === 'ok' && window.__t.partCount() === 8, 60000).catch(() => {});
  fs.writeFileSync(path.join(dir, 'animations', 'skill.py'), block);
  // Der Watcher baut die Datei, danach liest soma anim info sie (ein zweiter Bau gleichzeitig würde um die Dateien konkurrieren)
  await waitFor('Beispiel gebaut', () => window.soma.anim.list().then((x) => !x.building && (x.animations.some((a) => a.name === 'Open the lid') || x.errors.length > 0)), 90000).catch(() => {});
  l = await list();
  r = soma(['anim', 'info', 'Open the lid']);
  check('Beispiel aus dem Skill „Animation und Video“ baut ohne Fehler, Ablauf mit Titel, Gelenk und Schublade', !l.errors.length
    && r.status === 0 && r.stdout.includes('Lid: 0 -> -110 Grad') && r.stdout.includes('Drawer: 0 -> 60 mm') && r.stdout.includes('Titel: Storage box'),
    JSON.stringify(l.errors) + r.stdout.slice(0, 200) + r.stderr);

  // 13) Ohne App, eigener Ordner (E64): Grenzwert mit Netzgenauigkeit, Teil vor Gruppe, Problemstellen, bessere Druckrichtung,
  // Schleife kurzer Schritte im Ablauf, Modell läuft für eine Animation nur einmal
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-anim-plain-'));
  fs.writeFileSync(path.join(plain, 'model.py'), `import cadquery as cq
from soma import add_part
from soma.fasteners import Screw

with open("laeufe.txt", "a") as f:
    f.write("x")
PILZ_X = 60.0
# Teil und Gruppe heissen gleich, die Fase unten hat genau 45 Grad
box = cq.Workplane("XY").box(20, 20, 20, centered=(True, True, False)).edges("<Z and <X").chamfer(5)
add_part("Gehäuse", box, group="Gehäuse")
add_part("Schraube", Screw("ISO 4762", "M3x10", at=(30, 0, 5), direction="-X"), group="Gehäuse/Normteile")
# Pilz: Der Hut steht nach +Z ueber, kopfueber gedruckt gar nicht
pilz = cq.Workplane("XY").box(8, 8, 15, centered=(True, True, False)).union(
    cq.Workplane("XY").box(24, 24, 4, centered=(True, True, False)).translate((0, 0, 15))).translate((PILZ_X, 0, 0))
add_part("Pilz", pilz)
`);
  fs.mkdirSync(path.join(plain, 'animations'));
  fs.writeFileSync(path.join(plain, 'animations', 'schleife.py'), `from soma.anim import Animation
from model import PILZ_X

a = Animation("Schleife")
pilz = a.slider("Pilz", (0, 0, 1))
for i in range(12):
    a.play(pilz.to(i + 1), run_time=0.1, ease="linear")
a.wait(0.5)
`);
  const plainSoma = (args) => soma(args, { cwd: plain });
  r = plainSoma(['analyze', 'overhang']);
  check('Fase mit genau 45°: nicht kritisch, als „genau am Grenzwert“ genannt', r.status === 0 && /Gehäuse: [^\n]*nichts über 45\.0°, 1\.41 cm² genau am Grenzwert/.test(r.stdout), r.stdout + r.stderr);
  check('Pilz: Problemstelle mit Fläche und Größe, Hinweis auf --up -z', /Pilz: [^\n]*5\.12 cm² über 45\.0°, mit --up -z nur 0\.00 cm²/.test(r.stdout)
    && /\n {4}512\.0 mm² in 24\.0 x 24\.0 mm, bis 90\.0° bei/.test(r.stdout), r.stdout);
  r = plainSoma(['analyze', 'overhang', '--parts', 'Gehäuse', '--name', 'teil']);
  const r2 = plainSoma(['analyze', 'overhang', '--parts', 'Gehäuse/', '--name', 'gruppe']);
  check('--parts: Bauteil vor gleichnamiger Gruppe mit Hinweis, „Gehäuse/“ meint die Gruppe', r.status === 0 && !r.stdout.includes('Schraube:')
    && r.stdout.includes("Hinweis: 'Gehäuse' ist Bauteil und Gruppe") && r2.status === 0 && r2.stdout.includes('Schraube:') && !r2.stdout.includes('Hinweis'), r.stdout + r2.stdout);
  r = plainSoma(['anim', 'build']);
  check('Animation importiert aus model.py, das Modell läuft trotzdem nur einmal', r.status === 0 && fs.readFileSync(path.join(plain, 'laeufe.txt'), 'utf8') === 'xxxx',
    fs.readFileSync(path.join(plain, 'laeufe.txt'), 'utf8') + r.stderr);
  r = plainSoma(['anim', 'info', 'Schleife']);
  check('soma anim info: zwölf kurze Schritte als eine Zeile', r.status === 0 && r.stdout.includes('Pilz: 0 -> 12 mm (12 Schritte)') && !r.stdout.includes('Pilz: 1 -> 2'), r.stdout);
  r = plainSoma(['anim', 'check', 'Schleife']);
  check('soma anim check: frei, Exit 0', r.status === 0 && r.stdout.includes('Zeitpunkte') && r.stdout.includes('keine'), r.stdout + r.stderr);
  cleanup(plain);
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
