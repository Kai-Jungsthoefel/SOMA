// Test der Schnittansicht: Ebene senkrecht zu X/Y/Z oder parallel zu einer Fläche, Eingabe der Lage, Seite wechseln,
// Blick auf den Schnitt, gefüllte und schraffierte Schnittfläche, Klicks durch den Schnitt, Messen an der Schnittkontur,
// Text für den Agenten, neuer Build. Aufruf: npm run test:section (baut vorher). SMOKE_VISIBLE=offscreen SMOKE_SHOTS=1 legt Bilder ab.
import fs from 'node:fs';
import path from 'node:path';
import { APP, checker, cleanup, sleep, startApp } from './harness.mjs';

const t = checker();
const { check } = t;
let app;

// Offener Kasten 40 × 30 × 20 mit 4 mm Wand (innen x −16..16, y −11..11, Boden bis z = 4) und ein Block 16 × 16 × H
// bei x = 32..48 mit einer Bohrung Ø 6 von oben
const MODEL = (h) => `import cadquery as cq
from soma import add_part

box = cq.Workplane("XY").box(40, 30, 20, centered=(True, True, False)).faces(">Z").shell(-4)
block = (cq.Workplane("XY").box(16, 16, ${h}, centered=(True, True, False))
         .faces(">Z").workplane().hole(6).translate((40, 0, 0)))

add_part("Kasten", box)
add_part("Block", block, color=(0.85, 0.55, 0.25))
`;

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const vecNear = (a, b, eps = 1e-6) => !!a && a.every((x, i) => near(x, b[i], eps));

try {
  app = await startApp({ name: 'section' });
  const { ev, waitFor, domClick, page } = app;
  const shot = async (name) => {
    if (!process.env.SMOKE_SHOTS) return;
    fs.mkdirSync(path.join(APP, 'test', 'shots'), { recursive: true });
    await sleep(900);
    await app.screenshot(path.join(APP, 'test', 'shots', `${name}.png`)).catch((e) => console.log('Screenshot:', e.message));
  };
  await waitFor('Projekt und Build', () => !!window.__t && !!window.__t.project() && window.__t.status().state === 'ok' && window.__t.partCount() === 2);
  const proj = await ev(() => window.__t.project());
  fs.writeFileSync(path.join(proj.dir, 'model.py'), MODEL(10));
  await waitFor('Testmodell gebaut', () => window.__t.status().state === 'ok' && JSON.stringify(window.__t.treeNames()) === '["Kasten","Block"]', 60000);
  await ev(() => window.__t.viewer.setView('iso'));
  await sleep(300);
  const ids = await ev(() => Object.fromEntries(window.__t.parts().map((p) => [p.name, p.id])));
  const sec = () => ev(() => window.__t.section());
  const vs = () => ev(() => window.__t.viewer.sectionState());
  const screen = (p) => ev((q) => window.__t.viewer.screenAt(q), p);
  const clickAt = (p) => page.click(p.x, p.y);
  const setValue = (v) => ev((x) => {
    const i = document.getElementById('section-value');
    i.focus(); i.value = x;
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    i.blur();
  }, v);
  const settle = () => waitFor('Kamera steht', () => !window.__t.viewer.viewState().animating, 5000).then(() => sleep(150));

  // 1) Einschalten: Ebene senkrecht zu X mitten durch das Modell (x −20..48), die Seite +X fällt weg
  await domClick('btn-section');
  let s = await sec();
  let v = await vs();
  check('„Schnitt": Karte offen, Ebene X in der Mitte (X = 14), weggeschnitten X > 14', s.active && s.axis === 'x' && near(s.value, 14, 1e-3)
    && vecNear(v.plane?.normal, [-1, 0, 0]) && near(v.plane.constant, 14, 1e-3) && s.text.includes('Weggeschnitten: X > 14,00 mm')
    && await ev(() => document.getElementById('btn-section').getAttribute('aria-pressed') === 'true'), JSON.stringify(v.plane));
  check('Alle Bauteile geschnitten, beide mit Deckel, Kontur vorhanden', v.clipped && v.capped.length === 2 && v.contour >= 8, JSON.stringify(v));

  // 2) Lage eingeben (Enter), Pfeiltasten in 1- und 10-mm-Schritten
  await setValue('0');
  s = await sec();
  check('Eingabe „0" + Enter: Ebene bei X = 0, das Feld zeigt danach „0,00"', near(s.value, 0) && near((await vs()).plane.constant, 0) && s.text.includes('X > 0,00 mm')
    && await ev(() => document.getElementById('section-value').value) === '0,00');
  await ev(() => {
    const i = document.getElementById('section-value');
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    i.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true, bubbles: true }));
  });
  s = await sec();
  check('Pfeil hoch: +1 mm, mit Umschalt +10 mm', near(s.value, 11), String(s.value));
  await setValue('−2,5');
  check('Eingabe mit Minuszeichen und Komma: „−2,5" ergibt X = −2.5', near((await sec()).value, -2.5), String((await sec()).value));
  await setValue('0');

  // 3) Blick auf den Schnitt: Kamera von der weggeschnittenen Seite (+X)
  await domClick('btn-section-look');
  await settle();
  const dir = (await ev(() => window.__t.viewer.viewState())).dir;
  check('„Blick auf den Schnitt": Kamera blickt von +X senkrecht auf die Ebene', vecNear(dir, [1, 0, 0], 1e-3), JSON.stringify(dir));
  await ev((id) => window.__t.viewer.setView('right', [id]), ids.Kasten);
  await sleep(300);
  await shot('schnitt-1-x');

  // 4) Schnittfläche gefüllt und schraffiert, durch den Hohlraum sieht man die innere Rückwand (gleichmäßig)
  const wall = await screen([0, 13, 10]);
  const hollow = await screen([0, 0, 12]);
  const capPx = await ev((p) => window.__t.viewer.pixels(p.x, p.y), wall);
  const hollowPx = await ev((p) => window.__t.viewer.pixels(p.x, p.y), hollow);
  check('Schnitt durch die Wand: gefüllt mit Schraffur (starke Helligkeitsspanne)', capPx.span > 25 && capPx.mean > 40, JSON.stringify(capPx));
  check('Durch den Hohlraum: innere Rückwand, ohne Schraffur', hollowPx.span < 12 && hollowPx.mean > 40, JSON.stringify(hollowPx));

  // 5) Klicks: auf die Schnittfläche wählt das Bauteil, durch den Hohlraum die innere Rückwand (x = −16)
  await clickAt(wall);
  await waitFor('Auswahl', () => window.__t.info().startsWith('Kasten'), 5000);
  let pk = await ev(() => window.__t.pick());
  check('Klick auf die Schnittfläche: Kasten gewählt, „Schnittfläche · ganzes Bauteil"', pk?.cut === true && pk.faceId == null
    && (await ev(() => window.__t.info())).includes('Schnittfläche · ganzes Bauteil'), JSON.stringify(pk));
  await clickAt(hollow);
  await waitFor('Fläche gewählt', () => window.__t.pick()?.faceId != null, 5000);
  pk = await ev(() => window.__t.pick());
  check('Klick in den Hohlraum geht durch den Schnitt: innere Rückwand bei x = −16', pk.surface === 'PLANE' && near(pk.point[0], -16, 0.01) && !pk.cut, JSON.stringify(pk));

  // 6) Messen im Schnitt: Kontur außen (y = 15) und innen (y = 11) anklicken ergibt die Wandstärke
  await domClick('btn-measure');
  await clickAt(await screen([0, 15, 10]));
  await waitFor('Messung A', () => !!window.__t.measure().result, 60000);
  let m = await ev(() => window.__t.measure());
  check('Messen: Klick auf die äußere Schnittkontur wählt die Außenfläche (eben)', m.a?.kind === 'face' && m.result?.a.type === 'PLANE', m.error || JSON.stringify(m.a));
  await clickAt(wall);
  await sleep(300);
  m = await ev(() => window.__t.measure());
  check('Klick auf die Schnittfläche selbst: Hinweis, die Messung bleibt', !!m.a && !m.b && m.text.includes('Schnittfläche selbst lässt sich nicht messen'), m.text.slice(0, 120));
  await clickAt(await screen([0, 11, 10]));
  await waitFor('Messung A–B', () => !!window.__t.measure().result?.pair, 60000);
  m = await ev(() => window.__t.measure());
  check('Innere Schnittkontur: Abstand der Ebenen 4,00 mm (Wandstärke)', near(m.result?.pair?.planes?.value ?? 0, 4, 1e-6) && m.text.includes('4,00 mm'), m.error || m.text.replace(/\s+/g, ' ').slice(0, 120));
  await shot('schnitt-2-messen');
  await domClick('btn-measure');

  // 7) Seite wechseln
  await domClick('btn-section-flip');
  v = await vs();
  check('„Seite wechseln": jetzt fällt X < 0 weg', vecNear(v.plane.normal, [1, 0, 0]) && near(v.plane.constant, 0) && (await sec()).text.includes('X < 0,00 mm'));
  check('Text für den Agenten nennt Ebene und weggeschnittene Seite', (await sec()).agent === 'Schnittansicht bei X = 0.000 mm, weggeschnitten ist X < 0.000', (await sec()).agent);

  // 8) An einer Fläche ausrichten: erst die Bohrung (nicht eben), dann die Oberseite des Blocks
  await ev(() => window.__t.viewer.setView('iso'));
  await sleep(300);
  await ev(() => document.querySelector('#section-axes [data-axis="face"]').click());
  s = await sec();
  check('„Fläche": wartet auf einen Klick, Hinweis in der Karte', s.picking && (await vs()).picking && s.text.includes('Ebene Fläche im Modell anklicken'));
  await ev(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
  s = await sec();
  check('Escape bricht das Anklicken ab, die Ebene bleibt bei X', !s.picking && !(await vs()).picking && s.axis === 'x');
  await ev(() => document.querySelector('#section-axes [data-axis="face"]').click());
  await clickAt(await screen([40, 3, 9]));
  await sleep(200);
  s = await sec();
  check('Klick in die Bohrung: „keine ebene Fläche", wartet weiter', s.picking && s.text.includes('keine ebene Fläche'), s.text.slice(0, 120));
  await clickAt(await screen([44, -4, 10]));
  await sleep(200);
  s = await sec();
  v = await vs();
  check('Oberseite des Blocks: Ebene parallel dazu, mitten durch den Block (z = 5, Tiefe 5 mm)', !s.picking && s.axis === 'face' && vecNear(s.face?.normal, [0, 0, 1])
    && vecNear(v.plane.normal, [0, 0, -1]) && near(v.plane.constant, 5, 1e-3) && near(s.shown, 5, 1e-3) && s.text.includes('Tiefe') && s.text.includes('„Block“'), JSON.stringify({ v: v.plane, s: s.face }));
  await setValue('2');
  v = await vs();
  check('Tiefe 2 mm: Ebene bei z = 8', near(v.plane.constant, 8, 1e-6), JSON.stringify(v.plane));
  check('Text für den Agenten: Ebene durch einen Punkt, Fläche, Richtung', /^Schnittansicht, Ebene durch \(40\.000, 0\.000, 8\.000\) mm parallel zu einer Fläche von "Block", weggeschnitten ist die Seite in Richtung \(0, 0, 1\)$/.test((await sec()).agent ?? ''), (await sec()).agent);
  await shot('schnitt-3-flaeche');

  // 9) Ebene Z
  await ev(() => document.querySelector('#section-axes [data-axis="z"]').click());
  v = await vs();
  check('Ebene Z: mitten durch das Modell (z = 10), oben fällt weg', vecNear(v.plane.normal, [0, 0, -1]) && near(v.plane.constant, 10, 1e-3) && (await sec()).text.includes('Z > 10,00 mm'), JSON.stringify(v.plane));

  // 10) Neuer Build: Der Schnitt bleibt, Deckel und Kontur passen zum neuen Modell
  fs.writeFileSync(path.join(proj.dir, 'model.py'), MODEL(14));
  await waitFor('Neuer Build', () => window.__t.status().state === 'ok' && window.__t.partSize('Block')?.[2] === 14, 60000);
  await sleep(300);
  v = await vs();
  s = await sec();
  check('Nach dem Build: Schnitt bei Z = 10 bleibt, beide Teile mit Deckel, Kontur neu', s.active && vecNear(v.plane.normal, [0, 0, -1]) && near(v.plane.constant, 10, 1e-3)
    && v.capped.length === 2 && v.contour >= 8 && v.clipped, JSON.stringify(v));

  // 11) Ausschalten: kein Schnitt mehr, die Außenwand ist wieder zu sehen
  await domClick('btn-section');
  v = await vs();
  s = await sec();
  check('„Schnitt" aus: keine Ebene, keine Deckel, keine Kontur, Karte zu', !s.active && !v.plane && !v.capped.length && !v.contour
    && await ev(() => document.getElementById('section-card').hidden), JSON.stringify(v));
  await ev((id) => { window.__t.viewer.setVisible(id, false); }, ids.Block); // stünde sonst vor der Wand
  await ev((id) => window.__t.viewer.setView('right', [id]), ids.Kasten);
  await sleep(300);
  const outerPx = await ev((p) => window.__t.viewer.pixels(p.x, p.y), await screen([0, 13, 10]));
  check('Ohne Schnitt an derselben Stelle: Außenwand, ohne Schraffur', outerPx.span < 12 && outerPx.mean > 40, JSON.stringify(outerPx));

  const relevant = page.errors.filter((e) => !/favicon/i.test(e));
  check('Keine Konsolenfehler im Renderer', relevant.length === 0, relevant.slice(0, 2).join(' | ').slice(0, 100));
} catch (e) {
  console.log('ABBRUCH:', e.message);
  t.fail();
}
if (app) { await app.stop(); cleanup(app.ud); }
console.log(t.fails ? `\n${t.fails} Prüfung(en) fehlgeschlagen` : '\nALLE PRÜFUNGEN BESTANDEN');
process.exit(t.fails ? 1 : 0);
