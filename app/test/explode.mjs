// Test der Explosionsansicht (E56, E57, E59): Demontage-Analyse mit Strahltest, Richtungen je Teil (Deckel nach oben, Seitenblech
// zur Seite, Schrauben entlang ihrer Achse, auch durch ihr Kernloch, ein Stift schräg entlang der Achse seiner Bohrung), Baugruppe
// aus Klotz und eingeschlossener Mutter, Elternteile, Stapeln mit gleicher Lücke, Reihenfolge bei 100 %, Vorzugsachse aus den Normteilen,
// Abspielen Schritt für Schritt in beide Richtungen (Auseinanderbau und Zusammenbau, Anhalten, Umkehren, Tempo, Anzeige „Schritt X
// von N“), Reihenfolge an den Agenten, Wege, Auswahl in Einbaulage, Hervorhebung wandert mit, Messen setzt zusammen, Schnitt darüber,
// Ausblenden, neuer Build, Text für den Agenten.
// Aufruf: npm run test:explode (baut vorher). SMOKE_VISIBLE=offscreen SMOKE_SHOTS=1 legt Bilder ab.
import fs from 'node:fs';
import path from 'node:path';
import { APP, checker, cleanup, sleep, startApp } from './harness.mjs';

const t = checker();
const { check } = t;
let app;

// Gehäuse aus Unterteil (z 0..20, oben offen, Wand 3) und Deckel (z 20..H) mit vier Schrauben M3 von oben (Kernloch im Unterteil).
// An der rechten Außenwand ein Seitenblech (x 30..32) mit zwei Schrauben von der Seite. Innen eine Platine (z 8..9,6) und darunter
// ein Klotz (z 3..7) mit einer Mutter in einer geschlossenen Tasche, deren Schlitz zur Wand zeigt: Die Mutter kommt erst heraus,
// wenn der Klotz aus dem Gehäuse ist. An der hinteren Wand ein Sockel mit einer um 30° geneigten Bohrung und einem Stift darin: Er
// kommt nur entlang der Achse seiner Bohrung heraus. Darunter ein Tisch als Referenz.
const MODEL = (h) => `import math
import cadquery as cq
from soma import add_part
from soma.fasteners import Nut, Screw

base = cq.Workplane("XY").box(60, 40, 20, centered=(True, True, False)).faces(">Z").shell(-3)
lid = cq.Workplane("XY").box(60, 40, ${h - 20}, centered=(True, True, False)).translate((0, 0, 20))
screws = [Screw("ISO 4762", "M3x10", at=(x, y, ${h})) for x in (-28.5, 28.5) for y in (-18.5, 18.5)]
for s in screws:
    lid = lid.cut(s.clearance_hole())
    base = base.cut(s.tap_hole())
panel = cq.Workplane("XY").box(2, 20, 10, centered=False).translate((30, -10, 5))
side = [Screw("ISO 4762", "M3x8", at=(32, y, 10), direction="-X") for y in (-6, 6)]
for s in side:
    panel = panel.cut(s.clearance_hole())
    base = base.cut(s.tap_hole())
pcb = cq.Workplane("XY").box(40, 25, 1.6, centered=(True, True, False)).translate((0, 0, 8))
nut = Nut("ISO 4032", "M3", at=(-12, 10, 4), direction="-Z")
block = cq.Workplane("XY").box(16, 10, 4, centered=False).translate((-20, 5, 3)).cut(nut.trap(slot="+Y", slot_length=6))
table = cq.Workplane("XY").box(100, 80, 5, centered=(True, True, False)).translate((0, 0, -5))
axis = (0, -math.sin(math.radians(30)), math.cos(math.radians(30)))
top = (5, 15, 9)
rod = lambda d, length, back: cq.Solid.makeCylinder(d / 2, length, cq.Vector(*(top[i] - axis[i] * back for i in range(3))), cq.Vector(*axis))
base = base.union(cq.Workplane("XY").box(10, 4, 6, centered=False).translate((0, 13, 3))).cut(rod(3.4, 7, 6))
pin = rod(3, 12, 5)

add_part("Unterteil", base, group="Gehäuse")
add_part("Deckel", lid, group="Gehäuse", color=(0.3, 0.5, 0.85))
for i, s in enumerate(screws):
    add_part(f"Schraube {i + 1}", s, group="Gehäuse/Schrauben")
add_part("Seitenblech", panel, color=(0.75, 0.75, 0.3))
for i, s in enumerate(side):
    add_part(f"Seitenschraube {i + 1}", s)
add_part("Platine", pcb, group="Elektronik", color=(0.2, 0.6, 0.3))
add_part("Klotz", block, color=(0.8, 0.45, 0.3))
add_part("Mutter", nut)
add_part("Stift", pin, color=(0.9, 0.9, 0.95))
add_part("Tisch", table, role="reference")
`;

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const only = (o, k, eps = 1e-6) => !!o && o.every((v, i) => i === k || near(v, 0, eps));
const sign = (d) => { const k = d.findIndex((v) => Math.abs(v) > 0.999); return k < 0 ? '?' : `${d[k] > 0 ? '+' : '-'}${'XYZ'[k]}`; };

try {
  app = await startApp({ name: 'explode' });
  const { ev, waitFor, domClick, page } = app;
  const shot = async (name) => {
    if (!process.env.SMOKE_SHOTS) return;
    fs.mkdirSync(path.join(APP, 'test', 'shots'), { recursive: true });
    await sleep(900);
    await app.screenshot(path.join(APP, 'test', 'shots', `${name}.png`)).catch((e) => console.log('Screenshot:', e.message));
  };
  await waitFor('Projekt und Build', () => !!window.__t && !!window.__t.project() && window.__t.status().state === 'ok' && window.__t.partCount() > 0);
  const proj = await ev(() => window.__t.project());
  fs.writeFileSync(path.join(proj.dir, 'model.py'), MODEL(24));
  await waitFor('Testmodell gebaut', () => window.__t.status().state === 'ok' && window.__t.partCount() === 14, 60000);
  await ev(() => window.__t.viewer.setView('iso'));
  await sleep(300);
  const ids = await ev(() => Object.fromEntries(window.__t.parts().map((p) => [p.name, p.id])));
  const screws = [1, 2, 3, 4].map((i) => ids[`Schraube ${i}`]);
  const side = [1, 2].map((i) => ids[`Seitenschraube ${i}`]);
  const ex = () => ev(() => window.__t.explode());
  const vs = () => ev(() => window.__t.viewer.explodeState());
  const settle = () => waitFor('Bewegung zu Ende', () => !window.__t.explode().animating, 10000).then(() => sleep(100));

  // 0) Achsen aus dem Build: Schrauben zeigen aus dem Material heraus, eigene Teile ohne Achse
  const input = await ev(() => window.__t.viewer.explodeParts());
  const byId = Object.fromEntries(input.map((p) => [p.id, p]));
  check('Build liefert die Achse der Normteile: oben (0, 0, 1), seitlich (1, 0, 0), Mutter (0, 0, 1), Deckel ohne',
    screws.every((id) => JSON.stringify(byId[id].axis) === '[0,0,1]') && side.every((id) => JSON.stringify(byId[id].axis) === '[1,0,0]')
    && JSON.stringify(byId[ids.Mutter].axis) === '[0,0,1]' && byId[ids.Deckel].axis === null, JSON.stringify(byId[ids.Mutter].axis));

  // 0b) Abbrechen während der Analyse (große Baugruppen rechnen Sekunden): Explosion aus, nichts verschoben, Karte zu
  const cancelled = await ev(() => {
    document.getElementById('btn-explode').click();
    const during = { loading: window.__t.explode().loading, busy: window.__t.busy() };
    document.getElementById('btn-busy-cancel').click();
    return { during, after: window.__t.explode(), busy: window.__t.busy(), card: document.getElementById('explode-card').hidden };
  });
  await sleep(300);
  check('Abbrechen während der Analyse: Explosion aus, Karte zu, Ladeanzeige weg, nichts verschoben',
    cancelled.during.loading && cancelled.during.busy?.title === 'Preparing the exploded view' && !cancelled.after.active && !cancelled.after.loading
    && cancelled.card && cancelled.busy === null && !(await ev(() => window.__t.explode())).active && !Object.keys((await vs()).offsets).length
    && await ev(() => document.getElementById('viewer-busy').hidden && document.getElementById('btn-explode').getAttribute('aria-pressed') === 'false'),
    JSON.stringify(cancelled).slice(0, 160));

  // 1) Einschalten: Demontage-Analyse, zunächst auf 50 %
  await domClick('btn-explode');
  await settle();
  let s = await ex();
  let v = await vs();
  const st = s.steps;
  const dir = (id) => (st[id] ? sign(st[id].dir) : '-');
  check('„Explode": Karte offen ohne Richtungsknöpfe, Knopf gedrückt, Schieber 50 %, Vorzugsachse Z (aus den Schrauben), Anker Unterteil, nichts steckt fest',
    s.active && s.amount === 0.5 && s.shown === 0.5 && s.axis === 'z' && s.base === ids.Unterteil && s.forced === 0
    && s.text.includes('50 %') && await ev(() => !document.querySelector('#explode-card [data-axis]')
      && document.getElementById('btn-explode').getAttribute('aria-pressed') === 'true'), `${s.base} ${s.forced} ${s.analysisMs} ms`);
  check('Reihenfolge: zuerst die Schrauben (oben +Z, seitlich +X, trotz Gewinde im Kernloch), dann Deckel (+Z) und Seitenblech (+X)',
    screws.every((id) => dir(id) === '+Z' && st[id].level === 0) && side.every((id) => dir(id) === '+X' && st[id].level === 0)
    && dir(ids.Deckel) === '+Z' && st[ids.Deckel].level === 1 && dir(ids.Seitenblech) === '+X' && st[ids.Seitenblech].level === 1,
    JSON.stringify(Object.fromEntries(Object.entries(st).map(([k, x]) => [k, `${sign(x.dir)}@${x.level}`]))).slice(0, 200));
  check('Platine erst nach Deckel und Stift (seine Spitze ragt über sie), nach oben aus dem offenen Unterteil (nicht durch den Boden)',
    dir(ids.Platine) === '+Z' && st[ids.Platine].level === 3,
    JSON.stringify(st[ids.Platine]));
  const unit = Object.entries(st).find(([, x]) => x.members.length > 1);
  check('Klotz und Mutter kommen als Baugruppe nach oben (die Wand versperrt den Schlitz), darin geht die Mutter zur Seite (+Y)',
    !!unit && JSON.stringify([...unit[1].members].sort()) === JSON.stringify([ids.Klotz, ids.Mutter].sort()) && sign(unit[1].dir) === '+Z'
    && unit[1].base === ids.Klotz && dir(ids.Mutter) === '+Y' && st[ids.Mutter].unit === unit[0], JSON.stringify(unit));
  const tilt = [0, -0.5, Math.sqrt(3) / 2];
  check('Stift (kein Normteil) kommt nach dem Deckel schräg entlang der Achse seiner Bohrung heraus, aus den Zylinderflächen des Meshers',
    !!st[ids.Stift] && st[ids.Stift].dir.every((v, k) => near(v, tilt[k], 1e-3)) && st[ids.Stift].level === 2 && !st[ids.Stift].forced
    && byId[ids.Stift].dirs.some((d) => Math.abs(d[0] * tilt[0] + d[1] * tilt[1] + d[2] * tilt[2]) > 0.9999), JSON.stringify(st[ids.Stift]));
  check('Die Referenz bleibt stehen und zählt nicht mit', !st[ids.Tisch] && !v.offsets[ids.Tisch] && s.text.includes('Reference parts stay in place'));
  check('Im Normalfall kein allgemeiner Hinweis, nur der zu den Referenzen', s.hint === 'Reference parts stay in place.' && !s.text.includes('Each part'), String(s.hint));

  // Abstände: gleiche Lücke g zwischen allem, was übereinander gestapelt ist
  const off = v.offsets;
  const z = (id) => off[id]?.[2] ?? 0;
  const g = off[ids.Seitenblech]?.[0];
  const own = input.filter((p) => p.role !== 'reference');
  const diag = Math.hypot(...[0, 1, 2].map((i) => Math.max(...own.map((p) => p.max[i])) - Math.min(...own.map((p) => p.min[i]))));
  check('Seitenblech rückt um eine Lücke (5 % der Modelldiagonale) zur Seite, nur in X', only(off[ids.Seitenblech], 0) && near(g, 0.05 * diag, 1e-3), `${g} ${diag}`);
  check('Seitenschrauben eine Lücke außerhalb des abgerückten Seitenblechs, nur in X', side.every((id) => only(off[id], 0) && near(24 + off[id][0], 32 + g + g, 1e-3)),
    JSON.stringify(off[side[0]]));
  // Der schräg gezogene Stift stünde im Deckel: Der Deckel rückt über das höhere von Platine und Stift
  const pinTop = (o) => byId[ids.Stift].max[2] + (o[ids.Stift]?.[2] ?? 0);
  check('Stapel nach oben mit gleicher Lücke: Klotz über dem Unterteil, Platine über der Baugruppe, Deckel über Platine und Stift, Schrauben darüber',
    near(3 + z(ids.Klotz), 20 + g, 1e-3) && near(8 + z(ids.Platine), 7 + z(ids.Klotz) + g, 1e-3)
    && near(20 + z(ids.Deckel), Math.max(9.6 + z(ids.Platine), pinTop(off)) + g, 1e-3) && screws.every((id) => near(14 + z(id), 24 + z(ids.Deckel) + g, 1e-3)),
    JSON.stringify([z(ids.Klotz), z(ids.Platine), z(ids.Deckel), z(screws[0])]));
  check('Die Mutter wandert mit dem Klotz und rückt aus ihrem Schlitz (+Y) eine Lücke vor den Klotz', near(off[ids.Mutter][2], z(ids.Klotz), 1e-6)
    && near(off[ids.Mutter][1] - (off[ids.Klotz]?.[1] ?? 0), 15 - byId[ids.Mutter].min[1] + g, 1e-3), JSON.stringify([off[ids.Mutter], off[ids.Klotz]]));
  const so = off[ids.Stift];
  check('Der Stift rückt nur entlang seiner Achse', !!so && near(so[0], 0, 1e-6) && near(so[1] / so[2], tilt[1] / tilt[2], 1e-3) && so[2] > 0, JSON.stringify(so));
  check('Alle Teile außer Anker und Referenz verschoben, gestrichelte Wege für jedes', s.moving === 12 && v.trails === 12, `${s.moving} ${v.trails}`);
  check('Text für den Agenten: Explosionsansicht, nicht die Einbaulage', s.agent?.startsWith('exploded view (50 %)') && s.agent.includes('not the assembled position'), s.agent);
  await domClick('btn-explode-fit');
  await waitFor('Kamera steht', () => !window.__t.viewer.viewState().animating, 5000);
  await shot('explosion-1');

  // 2) Schieber auf 100 %: dreifache Lücke, dieselbe Reihenfolge (nichts holt etwas ein)
  const slide = (pct) => ev((x) => { const r = document.getElementById('explode-range'); r.value = x; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); }, String(pct));
  await slide(100);
  s = await ex();
  let vo = (await vs()).offsets;
  const zz = (id) => vo[id]?.[2] ?? 0;
  check('Schieber 100 %: Stapel mit dreifacher Lücke, Reihenfolge bleibt (nichts holt etwas ein), Anzeige „100 %"', s.amount === 1 && s.shown === 1 && s.text.includes('100 %')
    && near(3 + zz(ids.Klotz), 20 + 3 * g, 1e-3) && near(8 + zz(ids.Platine), 7 + zz(ids.Klotz) + 3 * g, 1e-3)
    && near(20 + zz(ids.Deckel), Math.max(9.6 + zz(ids.Platine), pinTop(vo)) + 3 * g, 1e-3) && near(vo[ids.Seitenblech][0], 3 * g, 1e-3),
    JSON.stringify([zz(ids.Klotz), zz(ids.Platine), zz(ids.Deckel)]));
  await domClick('btn-explode-fit');
  await waitFor('Kamera steht', () => !window.__t.viewer.viewState().animating, 5000);
  await shot('explosion-2-voll');

  // 2c) Abspielen Schritt für Schritt in beide Richtungen: Schrauben, Deckel und Seitenblech, Stift, Platine, die Baugruppe, die Mutter
  const stepDone = () => waitFor('Schritt fertig', () => !window.__t.explode().animating, 15000);
  const movedIds = async () => Object.keys((await vs()).offsets).sort();
  const sorted = (xs) => [...xs].sort();
  const btn = (id) => ev((i) => { const b = document.getElementById(i); return { label: b.getAttribute('aria-label'), disabled: b.disabled, on: b.classList.contains('on') }; }, id);
  const setSpeed = (x) => ev((val) => { const e = document.getElementById('explode-speed'); e.value = val; e.dispatchEvent(new Event('change')); }, String(x));
  check('Sechs Schritte, alle zugleich: Anzeige „Step 6 of 6", „Step forward" gesperrt, „Step back" nicht',
    s.order.length === 6 && s.stepPos === null && s.shownStep === 6 && s.text.includes('Step 6 of 6') && s.text.includes('All steps at once')
    && (await btn('btn-explode-next')).disabled && !(await btn('btn-explode-back')).disabled, s.text.replace(/\n/g, ' | '));
  // Zusammenbauen abspielen, erst im Viertel-Tempo: Das neue Tempo wirkt sofort (sonst dauerte es 6 × 2,8 s)
  await setSpeed(0.25);
  await domClick('btn-explode-assemble');
  s = await ex();
  let asm = await btn('btn-explode-assemble'), apart = await btn('btn-explode-play');
  check('„Play assembly": läuft rückwärts, der Knopf heißt „Pause" und leuchtet, „Play disassembly" bleibt',
    s.playing && s.direction === 'together' && s.speed === 0.25 && asm.label === 'Pause' && asm.on && apart.label === 'Play disassembly' && !apart.on,
    JSON.stringify([s.direction, asm, apart]));
  const t0 = Date.now();
  await setSpeed(2);
  const together = await waitFor('Assembled', () => !window.__t.explode().animating, 8000).then(() => true, () => false);
  const took = Date.now() - t0;
  s = await ex();
  check('Tempo 2× während des Abspielens: nach gut 2 s zusammengebaut (nicht 17 s), „Step 0 of 6", „Step back" gesperrt',
    together && took < 6000 && s.speed === 2 && s.stepPos === 0 && !s.playing && s.direction === null && !Object.keys((await vs()).offsets).length
    && s.shownStep === 0 && s.text.includes('Step 0 of 6') && s.text.includes('Assembled') && (await btn('btn-explode-back')).disabled
    && (await btn('btn-explode-assemble')).label === 'Play assembly', `${took} ms, ${s.text.replace(/\n/g, ' | ')}`);
  await domClick('btn-explode-next');
  await stepDone();
  s = await ex();
  check('„Step forward": Schritt 1, nur die sechs Schrauben sind heraus, die Anzeige nennt sie', s.stepPos === 1 && s.shownStep === 1
    && JSON.stringify(await movedIds()) === JSON.stringify(sorted([...screws, ...side])) && s.text.includes('Step 1 of 6') && s.text.includes('Schraube 1'), s.text);
  await domClick('btn-explode-next');
  await stepDone();
  await domClick('btn-explode-next');
  await stepDone();
  s = await ex();
  // Deckel und Seitenblech kamen in Schritt 2, die Anzeige nennt nur, was in diesem Schritt herauskommt
  check('Schritt 3: dazu Deckel, Seitenblech und Stift, Platine, Klotz und Mutter noch drin, die Anzeige nennt den Stift',
    JSON.stringify(await movedIds()) === JSON.stringify(sorted([...screws, ...side, ids.Deckel, ids.Seitenblech, ids.Stift]))
    && s.text.includes('Step 3 of 6') && s.text.includes('Stift') && !s.text.includes('Deckel'), `${s.text.replace(/\s+/g, ' ').slice(0, 200)} | ${JSON.stringify(await movedIds())}`);
  await domClick('btn-explode-play');
  s = await ex();
  apart = await btn('btn-explode-play');
  check('„Play disassembly": läuft weiter, der Knopf heißt jetzt „Pause" und leuchtet', s.playing && s.direction === 'apart'
    && apart.label === 'Pause' && apart.on && (await btn('btn-explode-assemble')).label === 'Play assembly', JSON.stringify(apart));
  await stepDone();
  s = await ex();
  const full = (await vs()).offsets;
  check('Am Ende (Schritt 6) stehen alle Teile wie in der ganzen Explosion bei 100 %, „Step forward" gesperrt', s.stepPos === 6 && !s.playing
    && s.text.includes('Step 6 of 6') && (await btn('btn-explode-next')).disabled
    && Object.keys(s.far).every((id) => (s.far[id].every((x) => near(x, 0, 1e-6)) && !full[id]) || (full[id] && s.far[id].every((x, k) => near(full[id][k], x, 1e-3)))),
    JSON.stringify(full[ids.Mutter]));
  await domClick('btn-explode-back');
  await stepDone();
  const back = (await vs()).offsets;
  check('„Step back": Schritt 5, die Mutter steckt wieder im Klotz (geht mit der Baugruppe)', (await ex()).stepPos === 5
    && back[ids.Mutter].every((x, k) => near(x, back[ids.Klotz][k], 1e-6)), JSON.stringify([back[ids.Mutter], back[ids.Klotz]]));
  s = await ex();
  check('Text für den Agenten nennt den Schritt', s.agent?.includes('step 5 of 6 of the disassembly'), s.agent);
  // Umkehren und Anhalten in beide Richtungen, im halben Tempo (1,4 s je Schritt, genug Luft für die Klicks)
  await setSpeed(0.5);
  await domClick('btn-explode-assemble');
  await sleep(400);
  await domClick('btn-explode-play');
  s = await ex();
  check('Beim Zusammenbauen „Play disassembly": kehrt um, ohne Sprung', s.playing && s.direction === 'apart' && s.stepPos > 4 && s.stepPos < 5
    && (await btn('btn-explode-play')).on && !(await btn('btn-explode-assemble')).on, String(s.stepPos));
  await sleep(300);
  await domClick('btn-explode-play');
  s = await ex();
  let paused = s.stepPos;
  check('Anhalten beim Auseinanderbauen: hält gleich an, Knopf wieder „Play disassembly"', !s.playing && s.direction === null
    && (await btn('btn-explode-play')).label === 'Play disassembly', String(paused));
  await stepDone();
  s = await ex();
  check('… und der laufende Schritt wird noch fertig (vorwärts auf den nächsten ganzen Schritt)', s.stepPos === Math.ceil(paused - 1e-6) && s.stepPos <= 6,
    `${paused} → ${s.stepPos}`);
  const from = s.stepPos;
  await domClick('btn-explode-assemble');
  await sleep(400);
  await domClick('btn-explode-assemble');
  s = await ex();
  paused = s.stepPos;
  check('Anhalten beim Zusammenbauen: hält gleich an, Knopf wieder „Play assembly"', !s.playing && s.direction === null && paused < from
    && (await btn('btn-explode-assemble')).label === 'Play assembly', `${from} → ${paused}`);
  await stepDone();
  s = await ex();
  check('… und der laufende Schritt wird noch fertig (rückwärts auf den ganzen Schritt davor), die Anzeige stimmt', s.stepPos === Math.floor(paused + 1e-6)
    && s.stepPos < from && s.text.includes(`Step ${s.stepPos} of 6`), `${paused} → ${s.stepPos}`);
  await setSpeed(1);
  check('Reihenfolge für den Agenten: sechs Zeilen, Deckel nach +Z, Stift schräg, Baugruppe aus Klotz und Mutter, Anker Unterteil',
    s.orderText.includes('Stays in place: "Unterteil"') && s.orderText.includes('2. ') && s.orderText.includes('"Deckel" towards +Z')
    && s.orderText.includes('assembly of') && s.orderText.includes('3. "Stift" towards (0, -0.5, 0.866)') && s.orderText.includes('6. "Mutter" towards +Y'),
    s.orderText);
  await domClick('btn-explode-agent');
  await sleep(200);
  const toast = await ev(() => window.__t.toast());
  check('„Send the order to the agent" fügt sie in die Eingabe ein', toast.text.includes('Added to the input of'), toast.text);
  // Der Schieber verlässt das Abspielen, die Anzeige folgt ihm: 0 % ist der Anfang, alles darüber das Ende
  await slide(0);
  s = await ex();
  check('Schieber auf 0 % verlässt das Abspielen: „Step 0 of 6", zusammengebaut, „Step back" gesperrt', s.stepPos === null && s.shownStep === 0
    && s.text.includes('Step 0 of 6') && s.text.includes('Assembled') && (await btn('btn-explode-back')).disabled, s.text.replace(/\n/g, ' | '));
  await domClick('btn-explode-next');
  s = await ex();
  check('„Step forward" bei 0 %: Der Abstand geht auf 50 %, sonst sähe man den Schritt nicht', s.amount === 0.5 && s.text.includes('50 %'), String(s.amount));
  await stepDone();
  check('… und Schritt 1 ist heraus', (await ex()).stepPos === 1 && JSON.stringify(await movedIds()) === JSON.stringify(sorted([...screws, ...side])));
  await slide(100);
  s = await ex();
  check('Schieber auf 100 %: wieder alle zugleich, „Step 6 of 6"', s.stepPos === null && s.shownStep === 6 && s.text.includes('Step 6 of 6')
    && s.text.includes('All steps at once'), s.text.replace(/\n/g, ' | '));

  // 3) Auswahl in der Explosion: Klick auf die Deckeloberseite wählt den Deckel, der Punkt steht in Einbaulage (z = 24)
  const lidUp = zz(ids.Deckel);
  await ev(() => window.__t.viewer.setView('top'));
  await waitFor('Kamera steht', () => !window.__t.viewer.viewState().animating, 5000);
  await sleep(200);
  const top = await ev((id) => window.__t.viewer.facesOf(id).filter((f) => f.surface === 'PLANE' && f.center && Math.abs(f.center[2] - 24) < 1e-3)
    .sort((a, b) => b.area - a.area)[0], ids.Deckel);
  // Am hinteren Rand, zwischen den Schraubenlöchern
  const at = await ev((p) => window.__t.viewer.screenAt(p), [0, 18, 24 + lidUp]);
  await page.click(at.x, at.y);
  await waitFor('Deckel gewählt', () => window.__t.info().startsWith('Deckel'), 5000);
  const pk = await ev(() => window.__t.pick());
  check('Klick auf den verschobenen Deckel: gewählt, Punkt in Einbaulage (z = 24, nicht 24 + Verschiebung)', pk?.faceId === top.id && near(pk.point[2], 24, 0.01)
    && near(pk.point[1], 18, 0.05), JSON.stringify(pk));
  // Schräg von oben, dort verschiebt sich die Fläche im Bild. Der Deckel ist blau, die Hervorhebung orange.
  await ev(() => window.__t.viewer.setView('iso'));
  await waitFor('Kamera steht', () => !window.__t.viewer.viewState().animating, 5000);
  await sleep(500); // der Drehpunkt leuchtet nach dem Klick noch kurz in der Bildmitte auf
  const orange = (px) => px.rgb[0] > px.rgb[2] + 60;
  const blue = (px) => px.rgb[2] > px.rgb[0] + 40;
  // Nahe der hinteren Kante der Deckeloberseite: Senkt sich der Deckel auf 0 %, liegt die alte Stelle über ihm im Leeren
  const rim = (dz) => ev((p) => window.__t.viewer.screenAt(p), [0, 18, 24 + dz]);
  const was = await rim(lidUp);
  const before = await ev((p) => window.__t.viewer.pixels(p.x, p.y, 2), was);
  await shot('explosion-3-auswahl');
  await slide(0);
  const moved = await rim(0);
  const after = await ev((p) => window.__t.viewer.pixels(p.x, p.y, 2), moved);
  const left = await ev((p) => window.__t.viewer.pixels(p.x, p.y, 2), was);
  check('Hervorgehobene Fläche (Orange) wandert mit dem Deckel, die alte Stelle ist nicht mehr orange',
    moved.y - was.y > 12 && orange(before) && orange(after) && !orange(left), JSON.stringify([was, moved, before.rgb, after.rgb, left.rgb]));
  await slide(75);
  const mid = await ev(([id, f]) => window.__t.viewer.screenOf(id, f), [ids.Deckel, top.id]);
  await ev(() => window.__t.viewer.select(null));
  const plain = await ev((p) => window.__t.viewer.pixels(p.x, p.y, 3), mid);
  check('Gegenprobe: ohne Auswahl ist die Stelle blau (Deckel)', blue(plain), JSON.stringify(plain.rgb));

  // 4) Ausblenden: Der Weg des ausgeblendeten Teils verschwindet, die Explosion bleibt gleich
  await ev((id) => window.__t.viewer.setVisible(id, false), ids.Platine);
  v = await vs();
  check('Platine ausgeblendet: elf Wege, Verschiebungen unverändert (75 %: Seitenblech 2g)', v.trails === 11 && near(v.offsets[ids.Seitenblech][0], 2 * g, 1e-3),
    String(v.trails));
  await ev((id) => window.__t.viewer.setVisible(id, true), ids.Platine);
  await domClick('btn-explode-trails');
  v = await vs();
  check('„Paths" aus: keine Linien, Knopf nicht gedrückt', v.trails === 0 && await ev(() => document.getElementById('btn-explode-trails').getAttribute('aria-pressed') === 'false'), String(v.trails));
  await domClick('btn-explode-trails');

  // 5) Schnitt dazu: Die Karten überdecken sich nicht, der Bereich des Schnitts reicht über das auseinandergezogene Modell
  await domClick('btn-section');
  await sleep(100);
  const rects = await ev(() => ['section-card', 'explode-card'].map((i) => document.getElementById(i).getBoundingClientRect().toJSON()));
  check('Schnitt und Explosion zugleich: Schnittkarte steht über der Explosionskarte', rects[0].bottom <= rects[1].top + 0.5, JSON.stringify(rects.map((r) => [r.top, r.bottom])));
  await ev(() => document.querySelector('#section-axes [data-axis="z"]').click());
  const sec = await ev(() => window.__t.section());
  vo = (await vs()).offsets;
  check('Bereich des Schnitts in Z reicht bis zu den verschobenen Schrauben', sec.range[1] > 27 + vo[screws[0]][2] - 1e-3, JSON.stringify(sec.range));
  await domClick('btn-section');

  // 6) Messen setzt sofort zusammen, Explosion schaltet umgekehrt das Messen ab
  await domClick('btn-measure');
  s = await ex();
  v = await vs();
  check('„Measure": Explosion aus, alle Teile in Einbaulage, Karte zu', !s.active && s.shown === 0 && !Object.keys(v.offsets).length && v.trails === 0
    && await ev(() => document.getElementById('explode-card').hidden && window.__t.measure().active), JSON.stringify(v.offsets).slice(0, 80));
  await domClick('btn-explode');
  await settle();
  check('„Explode" beendet das Messen und zieht wieder auseinander (75 %, wie zuletzt eingestellt)',
    !(await ev(() => window.__t.measure().active)) && (await ex()).shown === 0.75 && Object.keys((await vs()).offsets).length === 12);

  // 7) Neuer Build: Die Explosion bleibt, die Analyse läuft neu (Deckel 6 mm dick)
  fs.writeFileSync(path.join(proj.dir, 'model.py'), MODEL(26));
  await waitFor('Neuer Build', () => window.__t.status().state === 'ok' && window.__t.partSize('Deckel')?.[2] === 6, 60000);
  await settle(); // die Analyse des neuen Stands läuft im Hintergrund
  s = await ex();
  vo = (await vs()).offsets;
  check('Nach dem Build: Explosion aktiv, zwölf Teile verschoben, Schrauben über dem neuen Deckel', s.active && Object.keys(vo).length === 12 && s.forced === 0
    && screws.every((id) => 16 + vo[id][2] > 26 + vo[ids.Deckel][2]), JSON.stringify([vo[screws[0]], vo[ids.Deckel]]));

  // 8) Schließen: Die Teile gleiten zurück in die Einbaulage
  await domClick('btn-explode-close');
  await settle();
  s = await ex();
  v = await vs();
  check('Schließen: Einbaulage, keine Wege, Knopf nicht gedrückt, kein Text für den Agenten', !s.active && s.shown === 0 && !Object.keys(v.offsets).length && v.trails === 0
    && s.agent === null && await ev(() => document.getElementById('btn-explode').getAttribute('aria-pressed') === 'false'));

  const relevant = page.errors.filter((e) => !/favicon/i.test(e));
  check('Keine Konsolenfehler im Renderer', relevant.length === 0, relevant.slice(0, 2).join(' | ').slice(0, 100));
} catch (e) {
  console.log('ABBRUCH:', e.message);
  t.fail();
}
if (app) { await app.stop(); cleanup(app.ud); }
console.log(t.fails ? `\n${t.fails} Prüfung(en) fehlgeschlagen` : '\nALLE PRÜFUNGEN BESTANDEN');
process.exit(t.fails ? 1 : 0);
