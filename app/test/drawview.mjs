// Test für das Dokument „Drawings“ (E76): Der Knopf an der Leiste öffnet alle Blätter in der Code-Spalte (keine Seitenleiste),
// leer mit Hinweis, nach `soma drawing build` mit Kopf je Blatt. Zeiger über einer Ansicht hebt sie hervor, ein Klick dreht
// die Kamera in ihre Blickrichtung, ein Schnitt setzt das Schnittwerkzeug auf seine Ebene, ein Maß zeigt seine Punkte und
// die Maßzahl im Bild. Escape hebt alles auf. Ändert sich das Modell, heißt das Blatt „older than the code“, ein neues Blatt
// gibt dem Knopf einen Punkt, solange das Dokument nicht vorne steht.
// Aufruf: npm run build, dann node test/drawview.mjs. SMOKE_VISIBLE=offscreen SMOKE_SHOTS=1 legt Bilder ab.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP, checker, cleanup, sleep, startApp } from './harness.mjs';

const t = checker();
const { check } = t;
let app;

const PY = process.env.SOMA_PYTHON || path.join(process.env.LOCALAPPDATA ?? '', 'soma-dev', 'venv', 'Scripts', 'python.exe');
const soma = (dir, ...args) => spawnSync(PY, ['-m', 'soma', ...args, '--project', dir], { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });

const MODEL = `import cadquery as cq
from soma import add_part

plate = (cq.Workplane("XY").box(120, 60, 12, centered=(True, True, False))
         .faces(">Z").workplane().rarray(90, 35, 2, 2).hole(8))
add_part("Plate", plate)
add_part("Pin", cq.Workplane("XY").circle(5).extrude(30).translate((0, 0, -9)))
`;

// Vorne, Draufsicht, Schnitt A-A von links und eine Einzelheit, Maße in mehreren Ansichten
const SHEET = `from soma.drawing import Sheet

sh = Sheet("Plate", size="A3", scale="1:2")
front = sh.view("Plate", "front", at=(140, 200))
top = sh.view("Plate", "top", at=(140, 110))
cut = sh.section(["Plate", "Pin"], "left", through=(0, 0, 0), at=(300, 200), name="A", parent=front)
det = sh.detail(front, (45, 0, 12), 6, at=(320, 90), scale="5:1", name="B")
front.dim((-60, 0, 0), (60, 0, 0), offset=-12)
front.dim((60, 0, 0), (60, 0, 12), offset=10)
top.diameter((45, 17.5, 12), 4, angle=45, text="4x <>")
`;

/** Bildschirmpunkt der Mitte eines Rechtecks [x0, y0, x1, y1] (Blatt-mm). */
const mid = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];

try {
  app = await startApp({ name: 'drawview' });
  const { ev, waitFor } = app;
  await waitFor('Projekt und Build', () => !!window.__t && !!window.__t.project() && window.__t.status().state === 'ok');
  const proj = await ev(() => window.__t.project());
  fs.writeFileSync(path.join(proj.dir, 'model.py'), MODEL);
  await waitFor('Modell gebaut', () => window.__t.status().state === 'ok' && window.__t.partCount() === 2, 90000).catch(() => {});

  // 1) Leer: Knopf öffnet das Dokument in der Code-Spalte, eine offene Seitenleiste geht zu
  await ev(() => window.__t.showPanel('files'));
  await ev(() => document.getElementById('btn-rail-drawings').click());
  await waitFor('Dokument offen', () => window.__t.editor.state().pane === 'soma:drawings', 5000).catch(() => {});
  const lay = await ev(() => ({ ...window.__t.layout(), pressed: document.getElementById('btn-rail-drawings').getAttribute('aria-pressed'), empty: document.querySelector('.dw-empty')?.textContent ?? null }));
  check('Leiste öffnet „Drawings“ in der Code-Spalte, ohne Seitenleiste, Knopf gedrückt', lay.code && !lay.side && lay.pressed === 'true', JSON.stringify(lay));
  check('Ohne Zeichnungen: Hinweis, wie man den Agenten fragt', /No drawings yet/.test(lay.empty ?? '') && /drawings\/\*\.py/.test(lay.empty ?? ''), lay.empty);

  // 2) Gebaut aus dem Terminal (wie der Agent): Das Dokument zieht von selbst nach
  fs.mkdirSync(path.join(proj.dir, 'drawings'), { recursive: true });
  fs.writeFileSync(path.join(proj.dir, 'drawings', 'plate.py'), SHEET);
  const b = soma(proj.dir, 'drawing', 'build');
  check('soma drawing build im Projekt', b.status === 0, (b.stderr || b.stdout).slice(-300));
  await waitFor('Blatt im Dokument', () => (window.__t.drawings()?.sheets.length ?? 0) === 1 && (window.__t.drawings()?.pdf.pages ?? 0) >= 1, 20000).catch(() => {});
  let st = await ev(() => window.__t.drawings());
  check('Ein Blatt mit Kopf: Name, Format, Maßstab, Ansichten und Maße', st?.heads.length === 1 && /Plate/.test(st.heads[0]) && /A3/.test(st.heads[0]) && /1:2/.test(st.heads[0]) && /4 views/.test(st.heads[0]) && /3 dimensions/.test(st.heads[0]), JSON.stringify(st?.heads));
  check('Knopf ohne Punkt, solange das Dokument vorne steht', !(await ev(() => window.__t.rail().drawings)));
  await waitFor('Seite gezeichnet', () => (window.__t.drawings()?.pdf.rendered ?? []).length > 0, 20000).catch(() => {});

  // Index lesen, um die Ziele auf dem Blatt zu finden
  const idx = JSON.parse(fs.readFileSync(path.join(proj.dir, '.soma', 'drawings', 'index.json'), 'utf8')).drawings[0];
  const view = (n) => idx.views.find((v) => v.name === n);
  const at = async (x, y) => ev(([x, y]) => window.__t.drawingsScreen('Plate', x, y), [x, y]);
  const move = (p) => ev(({ x, y }) => {
    const target = document.elementFromPoint(x, y);
    target?.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true, buttons: 0 }));
    return target?.closest('.pdf-page') ? true : target?.className ?? null;
  }, p);
  const click = async (p) => { await app.page.click(p.x, p.y); await sleep(150); };

  // 3) Zeiger über der Vorderansicht (zwischen den Maßen, auf der Platte)
  const fp = await at(...mid(view('front').bbox));
  const onPage = await move(fp);
  await sleep(100);
  st = await ev(() => window.__t.drawings());
  check('Zeiger über der Vorderansicht hebt sie hervor', onPage === true && /front/.test(st?.hover ?? ''), `${JSON.stringify(onPage)} ${st?.hover}`);

  // 4) Klick: Kamera schaut von vorne (-Y)
  await click(fp);
  await waitFor('Kamera steht', () => !window.__t.viewer.viewState().animating, 5000).catch(() => {});
  let vs = await ev(() => window.__t.viewer.viewState());
  st = await ev(() => window.__t.drawings());
  const ghost = await ev(() => window.__t.viewer.partLook(window.__t.viewer.partList().find((p) => p.name === 'Pin').id));
  check('Ansicht zeigt nur die Platte: der Stift ist durchsichtig', !!ghost && ghost.opacity < 0.9, JSON.stringify(ghost));
  check('Klick auf die Vorderansicht: Auswahl, Karte, Kamera von vorne', /front/.test(st?.selected?.label ?? '') && /View front/.test(st?.card ?? '') && vs.dir[1] < -0.99, `${JSON.stringify(st?.selected)} dir=${vs.dir.map((x) => x.toFixed(2))}`);

  // 5) Schnitt A-A: Schnittwerkzeug mit derselben Ebene (von links gesehen, -X weggenommen)
  const cp = await at(...mid(view('A-A').bbox));
  await click(cp);
  const sec = await ev(() => window.__t.section());
  vs = await ev(() => window.__t.viewer.viewState());
  check('Klick auf den Schnitt: Schnittwerkzeug auf seiner Ebene, Kamera von links', sec.active && sec.axis === 'face' && sec.face?.normal[0] < -0.99 && Math.abs(sec.value) < 1e-6 && vs.dir[0] < -0.99,
    `${JSON.stringify({ active: sec.active, axis: sec.axis, n: sec.face?.normal, v: sec.value })} dir=${vs.dir.map((x) => x.toFixed(2))}`);
  check('Schnitt nennt die Zeichnung (Karte des Werkzeugs, Text für den Agenten)', /A-A/.test(sec.agent ?? '') && /Plate/.test(sec.agent ?? ''), sec.agent);

  // 6) Maß 120: Punkte und Maßzahl im Bild, der Schnitt der Zeichnung geht wieder weg
  const dim = idx.dims.find((d) => d.label === '120');
  const dp = await at(...mid(dim.text_box ?? dim.box));
  await click(dp);
  const marks = await ev(() => ({ labels: [...document.querySelectorAll('.v-label')].map((x) => x.textContent), pts: document.querySelectorAll('.v-pt').length }));
  st = await ev(() => window.__t.drawings());
  check('Klick auf ein Maß: Maßzahl und zwei Punkte im Bild', marks.labels.includes('120') && marks.pts === 2 && /measured 120 mm/.test(st?.card ?? ''), JSON.stringify(marks) + ' ' + st?.card);
  check('Schnitt aus der Zeichnung wieder aus', !(await ev(() => window.__t.section().active)));

  // 7) Durchmesser in der Draufsicht: Kreis um den Mittelpunkt
  const dd = idx.dims.find((d) => d.kind === 'diameter');
  await click(await at(...mid(dd.text_box ?? dd.box)));
  const dl = await ev(() => [...document.querySelectorAll('.v-label')].map((x) => x.textContent));
  check('Durchmesser: Maßzahl im Bild', dl.some((x) => /Ø8/.test(x)), JSON.stringify(dl));
  if (process.env.SMOKE_SHOTS) {
    fs.mkdirSync(path.join(APP, 'test', 'shots'), { recursive: true });
    await sleep(800);
    await app.screenshot(path.join(APP, 'test', 'shots', '30-drawings.png')).catch((e) => console.log('Screenshot:', e.message));
  }

  // 8) Escape: Auswahl und Marken weg
  await ev(() => document.querySelector('.dwview .pdf-scroll')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await sleep(100);
  st = await ev(() => window.__t.drawings());
  const left = await ev(() => document.querySelectorAll('.v-label').length);
  const look = await ev(() => window.__t.viewer.partLook(window.__t.viewer.partList().find((p) => p.name === 'Pin').id));
  check('Escape hebt Auswahl und Marken auf, alle Teile wieder normal', !st?.selected && st?.card === null && left === 0 && look?.opacity === 1, `${JSON.stringify(st?.selected)} labels=${left} ${JSON.stringify(look)}`);

  // 9) Einzelheit: Kamera rückt heran (Abstand deutlich kleiner als bei der Ansicht)
  await click(fp);
  const far = (await ev(() => window.__t.viewer.viewState())).dist;
  await click(await at(...mid(view('B').bbox)));
  const near = (await ev(() => window.__t.viewer.viewState())).dist;
  check('Klick auf die Einzelheit: Kamera rückt heran', near < far * 0.4, `${far.toFixed(1)} -> ${near.toFixed(1)}`);
  await ev(() => window.__t.drawingsSelectNone());

  // 10) Modell geändert: Blatt veraltet
  fs.appendFileSync(path.join(proj.dir, 'model.py'), '# geändert\n');
  // Dateiänderungen frischen die offenen Reiter auf, auch das Dokument
  await waitFor('veraltet', () => window.__t.drawings()?.sheets[0]?.stale === true, 10000).catch(() => {});
  st = await ev(() => window.__t.drawings());
  check('Geändertes Modell: Blatt „older than the code“', st?.sheets[0]?.stale === true && /older than the code/.test(st.heads[0] ?? ''), JSON.stringify(st?.heads));

  // 11) Neues Blatt, während das Dokument nicht vorne steht: Punkt am Knopf
  await waitFor('Modell neu gebaut', () => window.__t.status().state === 'ok', 90000).catch(() => {});
  await ev(() => window.__t.openCode('model.py'));
  fs.writeFileSync(path.join(proj.dir, 'drawings', 'second.py'), 'from soma.drawing import Sheet\nsh = Sheet("Second", size="A4", scale="1:2")\nsh.view("Pin", "front", at=(105, 150))\n');
  const b2 = soma(proj.dir, 'drawing', 'build', 'drawings/second.py');
  check('Zweites Blatt gebaut', b2.status === 0, (b2.stderr || b2.stdout).slice(-300));
  await waitFor('Punkt am Knopf', () => window.__t.rail().drawings, 15000).catch(() => {});
  check('Neues Blatt: Punkt am Knopf „Drawings“', await ev(() => window.__t.rail().drawings));
  await ev(() => document.getElementById('btn-rail-drawings').click());
  await waitFor('zwei Blätter', () => (window.__t.drawings()?.sheets.length ?? 0) === 2 && !window.__t.rail().drawings, 15000).catch(() => {});
  st = await ev(() => window.__t.drawings());
  check('Dokument zeigt beide Blätter, der Punkt ist weg', st?.sheets.length === 2 && st.pdf.pages >= 2 && !(await ev(() => window.__t.rail().drawings)), JSON.stringify(st?.sheets));

  // 11b) Export: alle Blätter als eine PDF, je Blatt PDF und DXF in einen Ordner, ein Blatt als DXF
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-drawexport-'));
  const menu = () => ev(() => [...document.querySelectorAll('#menu-ctx:not([hidden]) .mi')].map((x) => x.textContent));
  await ev(() => [...document.querySelectorAll('.dw-bar button')].find((b) => /Export/.test(b.textContent)).click());
  const items = await menu();
  check('Export-Menü oben: eine PDF, je Blatt PDF, DXF, beides', items.length === 4 && /one PDF/.test(items[0]) && /DXF/.test(items[2]), JSON.stringify(items));
  await app.answers([path.join(out, 'set.pdf')]);
  await ev(() => [...document.querySelectorAll('#menu-ctx .mi')][0].click());
  await waitFor('Sammel-PDF', () => /Exported/.test(window.__t.toast().text ?? ''), 10000).catch(() => {});
  const setPdf = path.join(out, 'set.pdf');
  check('Alle Blätter als eine PDF exportiert (Kopie von output/drawings.pdf)', fs.existsSync(setPdf) && fs.readFileSync(setPdf).equals(fs.readFileSync(path.join(proj.dir, 'output', 'drawings.pdf'))), (await ev(() => window.__t.toast().text)) ?? '');
  const dirOut = path.join(out, 'folder');
  fs.mkdirSync(dirOut);
  await app.answers([dirOut]);
  await ev(() => [...document.querySelectorAll('.dw-bar button')].find((b) => /Export/.test(b.textContent)).click());
  await ev(() => [...document.querySelectorAll('#menu-ctx .mi')][3].click());
  await waitFor('Ordner', () => /4 files exported/.test(window.__t.toast().text ?? ''), 10000).catch(() => {});
  const files = fs.readdirSync(dirOut).sort();
  const toastText = (await ev(() => window.__t.toast().text)) ?? '';
  check('PDF und DXF je Blatt im Ordner, Hinweis auf das veraltete Blatt', JSON.stringify(files) === JSON.stringify(['Plate.dxf', 'Plate.pdf', 'Second.dxf', 'Second.pdf']) && /Older than the code: Plate/.test(toastText), `${JSON.stringify(files)} ${toastText}`);
  await app.answers([path.join(out, 'second.dxf')]);
  await ev(() => [...document.querySelectorAll('.dw-head')].find((h) => /Second/.test(h.textContent)).querySelector('button[aria-label^="Export"]').click());
  const sheetItems = await menu();
  await ev(() => [...document.querySelectorAll('#menu-ctx .mi')][1].click());
  await waitFor('Blatt-DXF', () => /Exported/.test(window.__t.toast().text ?? ''), 10000).catch(() => {});
  check('Export je Blatt im Kopf: PDF oder DXF, DXF in die gewählte Datei', JSON.stringify(sheetItems) === JSON.stringify(['PDF …', 'DXF …']) && fs.existsSync(path.join(out, 'second.dxf')), JSON.stringify(sheetItems));
  cleanup(out);

  // 12) Index eines älteren soma (Version 1): Hinweis mit Rebuild, die Karte sagt, was fehlt
  const ip = path.join(proj.dir, '.soma', 'drawings', 'index.json');
  const old = JSON.parse(fs.readFileSync(ip, 'utf8'));
  fs.writeFileSync(ip, JSON.stringify({ ...old, version: 1 }));
  await waitFor('Hinweis älteres soma', () => !document.querySelector('.dw-note')?.hidden, 10000).catch(() => {});
  const note = await ev(() => { const n = document.querySelector('.dw-note'); return n && !n.hidden ? n.textContent : null; });
  check('Älterer Index: Hinweis „Built with an older soma“ mit Rebuild', /older soma/.test(note ?? '') && /Rebuild/.test(note ?? ''), note);
  await ev(() => window.__t.drawingsGoTo('Plate'));
  await sleep(300);
  await click(await at(...mid(view('front').bbox)));
  st = await ev(() => window.__t.drawings());
  check('Älterer Index: Karte erklärt, dass erst ein Neubau verknüpft', /older soma/.test(st?.card ?? ''), st?.card);
  await ev(() => window.__t.drawingsSelectNone());
  fs.writeFileSync(ip, JSON.stringify(old));

  // 13) Zweiter Klick auf den Knopf schließt die Code-Spalte
  await ev(() => document.getElementById('btn-rail-drawings').click());
  check('Knopf bei vorne stehendem Dokument: Code-Spalte zu', !(await ev(() => window.__t.layout().code)));

  const relevant = app.page.errors.filter((e) => !/favicon/i.test(e));
  check('Keine Konsolenfehler im Renderer', relevant.length === 0, relevant.slice(0, 2).join(' | ').slice(0, 200));
} catch (e) {
  console.log('ABBRUCH:', e.message);
  t.fail();
}
if (app) { await app.stop(); cleanup(app.ud); }
console.log(t.fails ? `\n${t.fails} Prüfung(en) fehlgeschlagen` : '\nALLE PRÜFUNGEN BESTANDEN');
process.exit(t.fails ? 1 : 0);
