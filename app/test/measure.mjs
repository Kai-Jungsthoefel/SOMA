// Test des Messens (E9): Messmodus, Fläche und Kante anklicken, exakte Werte aus dem Python-Dienst, Abstand paralleler
// Ebenen, Abstand zweier Bohrungen, verdeckte Kanten, Text für den Agenten, neuer Build, Vorschau eines alten Stands.
// Aufruf: npm run test:measure (baut vorher). SMOKE_VISIBLE=offscreen SMOKE_SHOTS=1 legt Bilder in test/shots/ ab.
import fs from 'node:fs';
import path from 'node:path';
import { APP, checker, cleanup, sleep, startApp } from './harness.mjs';

const t = checker();
const { check } = t;
let app;

// Bekannte Maße: Platte 40 × 30 × 5 mit zwei Bohrungen Ø 6 bei x = ±10, Block 20 × 20 × 5 auf z = 15..20
const MODEL = `import cadquery as cq
from cadide import add_part

plate = (cq.Workplane("XY").box(40, 30, 5, centered=(True, True, False))
         .faces(">Z").workplane().pushPoints([(-10, 0), (10, 0)]).hole(6))
block = cq.Workplane("XY").box(20, 20, 5, centered=(True, True, False)).translate((45, 0, 15))

add_part("Platte", plate)
add_part("Block", block, color=(0.85, 0.55, 0.25))
`;

try {
  app = await startApp({ name: 'measure' });
  const { ev, waitFor, domClick, page } = app;
  const shot = async (name) => {
    if (!process.env.SMOKE_SHOTS) return;
    fs.mkdirSync(path.join(APP, 'test', 'shots'), { recursive: true });
    await sleep(900);
    await app.screenshot(path.join(APP, 'test', 'shots', `${name}.png`)).catch((e) => console.log('Screenshot:', e.message));
  };
  await waitFor('Projekt und Build', () => !!window.__t && !!window.__t.project() && window.__t.status().state === 'ok' && window.__t.partCount() === 2);
  const proj = await ev(() => window.__t.project());
  fs.writeFileSync(path.join(proj.dir, 'model.py'), MODEL);
  await waitFor('Testmodell gebaut', () => window.__t.status().state === 'ok' && JSON.stringify(window.__t.treeNames()) === '["Platte","Block"]', 60000);
  await ev(() => window.__t.viewer.setView('iso'));
  await sleep(300);
  const ids = await ev(() => Object.fromEntries(window.__t.parts().map((p) => [p.name, p.id])));
  const ms = () => ev(() => window.__t.measure());
  const clickAt = (p) => page.click(p.x, p.y);
  const topFace = (name, z) => ev(([pid, z]) => {
    const f = window.__t.viewer.facesOf(pid).find((x) => x.surface === 'PLANE' && Math.abs(x.center[2] - z) < 1e-6);
    return f ? { id: f.id, area: f.area, screen: window.__t.viewer.screenOf(pid, f.id) } : null;
  }, [ids[name], z]);
  const result = (pred) => waitFor('Messergebnis', pred, 60000).catch(() => null);

  // 1) Messmodus
  await domClick('btn-measure');
  let s = await ms();
  check('„Messen": Modus an, Karte mit Hinweis, Auswahlkarte tritt zurück', s.active && s.text.includes('Klick auf einen Punkt, eine Kante oder eine Fläche')
    && await ev(() => document.getElementById('btn-measure').getAttribute('aria-pressed') === 'true' && getComputedStyle(document.getElementById('selcard')).display === 'none'));

  // 2) Eine Fläche: exakte Werte, Maße des Bauteils. Der erste Aufruf startet den Messdienst.
  const plateTop = await topFace('Platte', 5);
  await clickAt(plateTop.screen);
  await result(() => !!window.__t.measure().result);
  s = await ms();
  const expArea = 40 * 30 - 2 * Math.PI * 9;
  check('Klick auf die Oberseite der Platte: Fläche eben, exakter Flächeninhalt, Normale +Z', s.result?.a.type === 'PLANE' && Math.abs(s.result.a.area - expArea) < 1e-6
    && s.text.includes('Fläche · eben') && s.text.includes('+Z'), s.error || `${s.result?.a.area}`);
  check('Karte nennt die Maße des Bauteils: 40,00 × 30,00 × 5,00 mm', s.text.includes('40,00 × 30,00 × 5,00 mm'), s.text.replace(/\s+/g, ' ').slice(0, 90));
  await shot('11-messen-flaeche');

  // 3) Zweite Fläche: Abstand der parallelen Ebenen, Beschriftung im Viewer
  const blockTop = await topFace('Block', 20);
  await clickAt(blockTop.screen);
  await result(() => !!window.__t.measure().result?.pair);
  s = await ms();
  check('Zweiter Klick auf die Oberseite des Blocks: Abstand der Ebenen 15,00 mm, parallel', Math.abs((s.result?.pair?.planes?.value ?? 0) - 15) < 1e-9
    && s.text.includes('Abstand der Ebenen') && s.text.includes('15,00 mm') && s.text.includes('0° (parallel)'), s.error || s.text.replace(/\s+/g, ' ').slice(0, 90));
  check('Im Viewer: Beschriftung „15,00 mm" und zwei Messpunkte', await ev(() => document.querySelector('.v-label')?.textContent === '15,00 mm' && document.querySelectorAll('.v-pt').length === 2));
  await shot('12-messen-abstand');

  // 4) Kanten: obere Ränder der beiden Bohrungen (Kreise). Dritter Klick beginnt von vorn.
  const rims = await ev((pid) => window.__t.viewer.edgesOf(pid).filter((e) => e.curve === 'CIRCLE' && Math.abs(e.mid[2] - 5) < 1e-3).sort((a, b) => a.mid[0] - b.mid[0]), ids.Platte);
  const left = rims[0], right = rims[rims.length - 1];
  await clickAt(left.screen);
  await result(() => !!window.__t.measure().result && !window.__t.measure().b && window.__t.measure().a?.kind === 'edge');
  s = await ms();
  check('Klick auf den Rand der linken Bohrung: Kante Kreis, Ø 6,00 mm', s.result?.a.type === 'CIRCLE' && Math.abs(s.result.a.radius - 3) < 1e-9 && s.text.includes('Ø 6,00 mm'),
    s.error || `${s.a?.kind} ${s.result?.a.type}`);
  await clickAt(right.screen);
  await result(() => !!window.__t.measure().result?.pair);
  s = await ms();
  check('Rand der rechten Bohrung dazu: Abstand der Mittelpunkte 20,00 mm', Math.abs((s.result?.pair?.axes?.value ?? 0) - 20) < 1e-9 && s.text.includes('Abstand der Mittelpunkte'),
    s.error || s.text.replace(/\s+/g, ' ').slice(0, 90));
  await shot('13-messen-bohrungen');

  // 5) An den Agenten
  const tid = await ev(() => window.__t.terminals.activeId);
  await domClick('btn-measure-agent');
  await waitFor('Messung im Terminal', (id) => window.__t.termText(id).includes('[Messung:'), 10000, tid).catch(() => {});
  const txt = await ev((id) => window.__t.termText(id), tid);
  // Den genauen Text prüft das Werkzeug selbst: Im Terminal kann beim Zeilenumbruch der Darstellung ein Zeichen fehlen
  const agentText = (await ms()).agentText ?? '';
  check('„An Agent geben": Text mit Bauteil, Elementen und Wert (Punkt als Dezimalzeichen), steht im Terminal',
    agentText.startsWith('[Messung: Bauteil "Platte" Kante Kreis und Bauteil "Platte" Kante Kreis: Abstand der Mittelpunkte 20.000 mm') && txt.includes('[Messung: Bauteil'),
    agentText.slice(0, 90));
  await ev((id) => window.cadide.term.write(id, '\x03'), tid);

  // 6) Verdeckte Kante: Die untere hintere Kante der Platte liegt hinter der Oberseite und darf nicht getroffen werden
  const hidden = await ev((pid) => window.__t.viewer.edgesOf(pid).find((e) => e.curve === 'LINE' && Math.abs(e.mid[2]) < 1e-3 && Math.abs(e.mid[1] - 15) < 1e-3), ids.Platte);
  const probe = await ev((p) => window.__t.viewer.probe(p.x, p.y), hidden.screen);
  check('Verdeckte Kante wird nicht getroffen, dort liegt die Oberseite', !!probe && !(probe.kind === 'edge' && probe.id === hidden.id), probe ? `${probe.kind} ${probe.type}` : 'nichts');

  // 6b) Punkte fassen: Ecken der Platte. Ein Klick in der Nähe fasst den Punkt, auch wo Kanten zusammenlaufen.
  const verts = await ev((pid) => window.__t.viewer.verticesOf(pid), ids.Platte);
  const vAt = (x, y, z) => verts.find((v) => Math.abs(v.p[0] - x) < 1e-6 && Math.abs(v.p[1] - y) < 1e-6 && Math.abs(v.p[2] - z) < 1e-6);
  const cornerR = vAt(20, -15, 5), cornerL = vAt(-20, -15, 5), cornerHidden = vAt(-20, 15, 0);
  await page.click(cornerR.screen.x + 4, cornerR.screen.y + 3); // knapp daneben: Der Punkt wird trotzdem gefasst
  await result(() => window.__t.measure().a?.kind === 'vertex' && !!window.__t.measure().result && !window.__t.measure().b);
  s = await ms();
  check('Klick nahe einer Ecke fasst den Punkt (vor den Kanten dort): X 20,00 · Y −15,00 · Z 5,00', s.a?.kind === 'vertex' && s.result?.a.type === 'VERTEX'
    && s.text.includes('Punkt') && s.text.includes('−15,00 mm') && await ev(() => document.querySelector('.v-label')?.textContent === 'X 20,00 · Y −15,00 · Z 5,00'),
    s.error || `${s.a?.kind} ${s.text.replace(/\s+/g, ' ').slice(0, 60)}`);
  await clickAt(cornerL.screen);
  await result(() => !!window.__t.measure().result?.pair);
  s = await ms();
  check('Zweiter Punkt: Abstand der Punkte 40,00 mm (ΔX −40,00)', Math.abs((s.result?.pair?.points?.value ?? 0) - 40) < 1e-9 && s.text.includes('Abstand der Punkte') && s.text.includes('40,00 mm') && s.text.includes('ΔX −40,00'),
    s.error || s.text.replace(/\s+/g, ' ').slice(0, 80));
  await shot('14-messen-punkte');
  await clickAt(cornerR.screen);
  await result(() => window.__t.measure().a?.kind === 'vertex' && !window.__t.measure().b && !!window.__t.measure().result);
  await clickAt(blockTop.screen);
  await result(() => !!window.__t.measure().result?.pair);
  s = await ms();
  check('Punkt und Fläche: Abstand zur Ebene 15,00 mm', Math.abs((s.result?.pair?.toPlane?.value ?? 0) - 15) < 1e-9 && s.text.includes('Abstand zur Ebene'), s.error || s.text.replace(/\s+/g, ' ').slice(0, 80));
  check('Text für den Agenten nennt den Punkt mit Lage', (s.agentText ?? '').startsWith('[Messung: Bauteil "Platte" Punkt und Bauteil "Block" Fläche eben: Abstand zur Ebene 15.000 mm'), (s.agentText ?? '').slice(0, 90));
  const probeV = await ev((q) => window.__t.viewer.probe(q.x, q.y), cornerHidden.screen);
  check('Verdeckte Ecke lässt sich nicht fassen', !!probeV && !(probeV.kind === 'vertex' && probeV.id === cornerHidden.id), probeV ? `${probeV.kind} ${probeV.type}` : 'nichts');

  // 7) Escape: erst die Messung verwerfen, dann den Modus verlassen. Danach wählt ein Klick wieder das Bauteil.
  await ev(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  s = await ms();
  check('Escape verwirft die Messung, der Modus bleibt', s.active && !s.a && !s.result && await ev(() => !document.querySelector('.v-label')));
  await ev(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await clickAt(plateTop.screen);
  await sleep(300);
  check('Zweites Escape beendet das Messen, ein Klick wählt wieder das Bauteil', !(await ms()).active && await ev(() => document.getElementById('measure-card').hidden)
    && (await ev(() => window.__t.info())).startsWith('Platte'));

  // 8) Neuer Build während einer Messung: Die Nummern gelten nicht mehr, die Messung beginnt von vorn
  await domClick('btn-measure');
  await clickAt(plateTop.screen);
  await result(() => !!window.__t.measure().result);
  fs.writeFileSync(path.join(proj.dir, 'model.py'), MODEL.replace('translate((45, 0, 15))', 'translate((45, 0, 18))'));
  await waitFor('neu gebaut', () => window.__t.status().state === 'ok' && !window.__t.measure().a, 60000).catch(() => {});
  s = await ms();
  check('Neuer Build: Messung zurückgesetzt, Modus bleibt an', s.active && !s.a && !s.result && s.text.includes('Klick auf einen Punkt'));
  const blockTop2 = await topFace('Block', 23);
  await clickAt(plateTop.screen);
  await result(() => !!window.__t.measure().result);
  await clickAt(blockTop2.screen);
  await result(() => !!window.__t.measure().result?.pair);
  s = await ms();
  check('Nach dem Build misst der Dienst den neuen Stand (Abstand jetzt 18,00 mm)', Math.abs((s.result?.pair?.planes?.value ?? 0) - 18) < 1e-9, s.error || s.text.replace(/\s+/g, ' ').slice(0, 80));

  // 9) Vorschau eines alten Stands (Startcommit, Vorlagenmodell) lässt sich ebenfalls vermessen
  await ev(() => document.querySelectorAll('#vdots .vdot')[0].click());
  await waitFor('Vorschau', () => !!window.__t.versions().previewing && JSON.stringify(window.__t.treeNames()) === '["Body","Lid"]', 60000).catch(() => {});
  s = await ms();
  check('Vorschau: Messung zurückgesetzt', s.active && !s.a);
  await ev(() => window.__t.viewer.setView('iso'));
  await sleep(300);
  const lidTop = await ev((pid) => {
    const f = window.__t.viewer.facesOf(pid).filter((x) => x.surface === 'PLANE').sort((a, b) => b.center[2] - a.center[2])[0];
    return { id: f.id, screen: window.__t.viewer.screenOf(pid, f.id) };
  }, await ev(() => window.__t.parts().find((p) => p.name === 'Lid').id));
  await clickAt(lidTop.screen);
  await result(() => !!window.__t.measure().result || !!window.__t.measure().error);
  s = await ms();
  check('In der Vorschau: Oberseite des Deckels vermessen (Deckel 60 × 40, Radius 3 in den Ecken)', s.result?.a.type === 'PLANE' && Math.abs(s.result.a.area - (60 * 40 - (4 - Math.PI) * 9)) < 1e-6,
    s.error || `${s.result?.a.area}`);

  const relevant = page.errors.filter((e) => !/favicon/i.test(e));
  check('Keine Konsolenfehler im Renderer', relevant.length === 0, relevant.slice(0, 2).join(' | ').slice(0, 100));
} catch (e) {
  console.log('ABBRUCH:', e.message);
  t.fail();
}
if (app) { await app.stop(); cleanup(app.ud); }
console.log(t.fails ? `\n${t.fails} Prüfung(en) fehlgeschlagen` : '\nALLE PRÜFUNGEN BESTANDEN');
process.exit(t.fails ? 1 : 0);
