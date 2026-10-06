// Test der Explosionsansicht (E56): Richtungen aus Gruppen und Normteil-Achsen, Schieber, Wege, Auswahl in Einbaulage,
// Hervorhebung wandert mit, Messen setzt zusammen, Schnitt darüber, Ausblenden, neuer Build, Text für den Agenten.
// Aufruf: npm run test:explode (baut vorher). SMOKE_VISIBLE=offscreen SMOKE_SHOTS=1 legt Bilder ab.
import fs from 'node:fs';
import path from 'node:path';
import { APP, checker, cleanup, sleep, startApp } from './harness.mjs';

const t = checker();
const { check } = t;
let app;

// Gehäuse aus Unterteil (z 0..20, oben offen), Deckel (z 20..H) und vier Schrauben M3 in den Ecken der Wand, die auf dem
// Deckel aufliegen (Achse +Z). Darin eine Platine (Gruppe „Elektronik“), darunter ein Tisch als Referenz.
const MODEL = (h) => `import cadquery as cq
from soma import add_part
from soma.fasteners import Screw

base = cq.Workplane("XY").box(60, 40, 20, centered=(True, True, False)).faces(">Z").shell(-3)
lid = cq.Workplane("XY").box(60, 40, ${h - 20}, centered=(True, True, False)).translate((0, 0, 20))
screws = [Screw("ISO 4762", "M3x10", at=(x, y, ${h})) for x in (-28.5, 28.5) for y in (-18.5, 18.5)]
for s in screws:
    lid = lid.cut(s.clearance_hole())
pcb = cq.Workplane("XY").box(40, 25, 1.6, centered=(True, True, False)).translate((0, 0, 8))
table = cq.Workplane("XY").box(100, 80, 5, centered=(True, True, False)).translate((0, 0, -5))

add_part("Unterteil", base, group="Gehäuse")
add_part("Deckel", lid, group="Gehäuse", color=(0.3, 0.5, 0.85))
for i, s in enumerate(screws):
    add_part(f"Schraube {i + 1}", s, group="Gehäuse/Schrauben")
add_part("Platine", pcb, group="Elektronik", color=(0.2, 0.6, 0.3))
add_part("Tisch", table, role="reference")
`;

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const flat = (o, eps = 1e-6) => !!o && near(o[0], 0, eps) && near(o[1], 0, eps);

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
  await waitFor('Testmodell gebaut', () => window.__t.status().state === 'ok' && window.__t.partCount() === 8, 60000);
  await ev(() => window.__t.viewer.setView('iso'));
  await sleep(300);
  const ids = await ev(() => Object.fromEntries(window.__t.parts().map((p) => [p.name, p.id])));
  const screws = [1, 2, 3, 4].map((i) => ids[`Schraube ${i}`]);
  const ex = () => ev(() => window.__t.explode());
  const vs = () => ev(() => window.__t.viewer.explodeState());
  const settle = () => waitFor('Bewegung zu Ende', () => !window.__t.explode().animating, 5000).then(() => sleep(100));

  // 0) Achsen aus dem Build: Schrauben zeigen aus dem Material heraus (+Z), eigene Teile ohne Achse
  const input = await ev(() => window.__t.viewer.explodeParts());
  const byId = Object.fromEntries(input.map((p) => [p.id, p]));
  check('Build liefert die Achse der Normteile: Schrauben (0, 0, 1) mit Länge 13 (Kopf 3 + Schaft 10), Deckel ohne Achse',
    screws.every((id) => JSON.stringify(byId[id].axis) === '[0,0,1]' && near(byId[id].span[1] - byId[id].span[0], 13, 1e-3)) && byId[ids.Deckel].axis === null,
    JSON.stringify(byId[screws[0]]));

  // 1) Einschalten: Teile gleiten auseinander, zunächst auf 50 %
  await domClick('btn-explode');
  await settle();
  let s = await ex();
  let v = await vs();
  const off = v.offsets;
  check('„Explosion": Karte offen, Knopf gedrückt, Schieber 50 %', s.active && s.amount === 0.5 && s.shown === 0.5 && s.text.includes('50 %')
    && await ev(() => document.getElementById('btn-explode').getAttribute('aria-pressed') === 'true' && !document.getElementById('explode-card').hidden), s.text);
  check('Deckel nach oben, Unterteil nach unten, beide nur in Z (Mitten über der Mitte des Gehäuses)',
    flat(off[ids.Deckel]) && off[ids.Deckel][2] > 5 && flat(off[ids.Unterteil]) && off[ids.Unterteil][2] < -1, JSON.stringify([off[ids.Deckel], off[ids.Unterteil]]));
  const lidTop = 24 + off[ids.Deckel][2];
  check('Schrauben nur entlang ihrer Achse (+Z), gemeinsam und ganz über dem verschobenen Deckel',
    screws.every((id) => flat(off[id]) && near(off[id][2], off[screws[0]][2], 1e-6) && 14 + off[id][2] > lidTop), JSON.stringify([off[screws[0]], lidTop]));
  check('Platine (eigene Gruppe) rückt nach unten, die Referenz bleibt stehen', flat(off[ids.Platine]) && off[ids.Platine][2] < 0 && !off[ids.Tisch],
    JSON.stringify([off[ids.Platine], off[ids.Tisch]]));
  check('Gestrichelte Wege für die sieben verschobenen Teile, Hinweis nennt die Referenz', v.trails === 7 && s.moving === 7 && s.text.includes('Referenzen bleiben stehen'),
    `${v.trails} ${s.moving}`);
  check('Text für den Agenten: Explosionsansicht, nicht die Einbaulage', s.agent?.startsWith('Explosionsansicht (50 %)') && s.agent.includes('nicht die Einbaulage'), s.agent);
  await domClick('btn-explode-fit');
  await waitFor('Kamera steht', () => !window.__t.viewer.viewState().animating, 5000);
  await shot('explosion-1');

  // 2) Schieber auf 100 %: alle Verschiebungen doppelt so groß, ohne Bewegung
  const slide = (pct) => ev((x) => { const r = document.getElementById('explode-range'); r.value = x; r.dispatchEvent(new Event('input')); r.dispatchEvent(new Event('change')); }, String(pct));
  await slide(100);
  s = await ex();
  v = await vs();
  check('Schieber 100 %: Verschiebungen genau doppelt, Anzeige „100 %"', s.amount === 1 && s.shown === 1 && s.text.includes('100 %')
    && Object.keys(off).every((id) => off[id].every((x, k) => near(v.offsets[id][k], x * 2, 1e-3))), JSON.stringify(v.offsets[ids.Deckel]));
  await shot('explosion-2-voll');

  // 3) Auswahl in der Explosion: Klick auf die Deckeloberseite wählt den Deckel, der Punkt steht in Einbaulage (z = 24)
  await ev(() => window.__t.viewer.setView('top'));
  await waitFor('Kamera steht', () => !window.__t.viewer.viewState().animating, 5000);
  await sleep(200);
  const top = await ev((id) => window.__t.viewer.facesOf(id).filter((f) => f.surface === 'PLANE' && f.center && Math.abs(f.center[2] - 24) < 1e-3)
    .sort((a, b) => b.area - a.area)[0], ids.Deckel);
  // Zwischen den Schraubenlöchern, nahe der Mitte (die Mitte selbst liegt über keinem anderen Teil, trifft aber sicher den Deckel)
  const at = await ev(([id, f]) => window.__t.viewer.screenOf(id, f), [ids.Deckel, top.id]);
  await page.click(at.x, at.y);
  await waitFor('Deckel gewählt', () => window.__t.info().startsWith('Deckel'), 5000);
  const pk = await ev(() => window.__t.pick());
  check('Klick auf den verschobenen Deckel: gewählt, Punkt in Einbaulage (z = 24, nicht 24 + Verschiebung)', pk?.faceId === top.id && near(pk.point[2], 24, 0.01), JSON.stringify(pk));
  // Schräg von oben, dort verschiebt sich die Fläche im Bild. Der Deckel ist blau, die Hervorhebung orange.
  await ev(() => window.__t.viewer.setView('iso'));
  await waitFor('Kamera steht', () => !window.__t.viewer.viewState().animating, 5000);
  await sleep(500); // der Drehpunkt leuchtet nach dem Klick noch kurz in der Bildmitte auf
  const orange = (px) => px.rgb[0] > px.rgb[2] + 60;
  const blue = (px) => px.rgb[2] > px.rgb[0] + 40;
  // Nahe der hinteren Kante der Deckeloberseite: Senkt sich der Deckel auf 0 %, liegt die alte Stelle über ihm im Leeren
  const rim = (dz) => ev((p) => window.__t.viewer.screenAt(p), [0, 18, 24 + dz]);
  const was = await rim(off[ids.Deckel][2] * 2);
  const before = await ev((p) => window.__t.viewer.pixels(p.x, p.y, 2), was);
  await shot('explosion-3-auswahl');
  await slide(0);
  const moved = await rim(0);
  const after = await ev((p) => window.__t.viewer.pixels(p.x, p.y, 2), moved);
  const left = await ev((p) => window.__t.viewer.pixels(p.x, p.y, 2), was);
  check('Hervorgehobene Fläche (Orange) wandert mit dem Deckel, die alte Stelle ist nicht mehr orange',
    moved.y - was.y > 30 && orange(before) && orange(after) && !orange(left), JSON.stringify([was, moved, before.rgb, after.rgb, left.rgb]));
  await slide(75);
  const mid = await ev(([id, f]) => window.__t.viewer.screenOf(id, f), [ids.Deckel, top.id]);
  await ev(() => window.__t.viewer.select(null));
  const plain = await ev((p) => window.__t.viewer.pixels(p.x, p.y, 3), mid);
  check('Gegenprobe: ohne Auswahl ist die Stelle blau (Deckel)', blue(plain), JSON.stringify(plain.rgb));

  // 4) Ausblenden: Der Weg des ausgeblendeten Teils verschwindet, die Explosion bleibt gleich
  await ev((id) => window.__t.viewer.setVisible(id, false), ids.Platine);
  v = await vs();
  check('Platine ausgeblendet: sechs Wege, Verschiebungen unverändert', v.trails === 6 && near(v.offsets[ids.Deckel][2], off[ids.Deckel][2] * 1.5, 1e-3), String(v.trails));
  await ev((id) => window.__t.viewer.setVisible(id, true), ids.Platine);
  await domClick('btn-explode-trails');
  v = await vs();
  check('„Wege" aus: keine Linien, Knopf nicht gedrückt', v.trails === 0 && await ev(() => document.getElementById('btn-explode-trails').getAttribute('aria-pressed') === 'false'), String(v.trails));
  await domClick('btn-explode-trails');

  // 5) Schnitt dazu: Die Karten überdecken sich nicht, der Bereich des Schnitts reicht über das auseinandergezogene Modell
  await ev(() => window.__t.viewer.setView('iso'));
  await domClick('btn-section');
  await sleep(100);
  const rects = await ev(() => ['section-card', 'explode-card'].map((i) => document.getElementById(i).getBoundingClientRect().toJSON()));
  check('Schnitt und Explosion zugleich: Schnittkarte steht über der Explosionskarte', rects[0].bottom <= rects[1].top + 0.5, JSON.stringify(rects.map((r) => [r.top, r.bottom])));
  await ev(() => document.querySelector('#section-axes [data-axis="z"]').click());
  const sec = await ev(() => window.__t.section());
  check('Bereich des Schnitts in Z reicht bis zu den verschobenen Schrauben', sec.range[1] > 27 + off[screws[0]][2] - 1e-3, JSON.stringify(sec.range));
  await domClick('btn-section');

  // 6) Messen setzt sofort zusammen, Explosion schaltet umgekehrt das Messen ab
  await domClick('btn-measure');
  s = await ex();
  v = await vs();
  check('„Messen": Explosion aus, alle Teile in Einbaulage, Karte zu', !s.active && s.shown === 0 && !Object.keys(v.offsets).length && v.trails === 0
    && await ev(() => document.getElementById('explode-card').hidden && window.__t.measure().active), JSON.stringify(v.offsets).slice(0, 80));
  await domClick('btn-explode');
  await settle();
  check('„Explosion" beendet das Messen und zieht wieder auseinander (75 %, wie zuletzt eingestellt)',
    !(await ev(() => window.__t.measure().active)) && (await ex()).shown === 0.75 && Object.keys((await vs()).offsets).length === 7);

  // 7) Neuer Build: Die Explosion bleibt, die Richtungen passen zum neuen Modell (Deckel 6 mm dick)
  fs.writeFileSync(path.join(proj.dir, 'model.py'), MODEL(26));
  await waitFor('Neuer Build', () => window.__t.status().state === 'ok' && window.__t.partSize('Deckel')?.[2] === 6, 60000);
  await sleep(200);
  s = await ex();
  v = await vs();
  check('Nach dem Build: Explosion aktiv, sieben Teile verschoben, Schrauben über dem neuen Deckel', s.active && Object.keys(v.offsets).length === 7
    && screws.every((id) => v.offsets[id] && 16 + v.offsets[id][2] > 26 + v.offsets[ids.Deckel][2]), JSON.stringify([v.offsets[screws[0]], v.offsets[ids.Deckel]]));

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
