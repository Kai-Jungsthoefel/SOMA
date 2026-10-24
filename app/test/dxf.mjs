// Test der DXF-Ansicht (E80): `soma dxfview` liefert Einheit, Größe, Layer mit Farbe und Zustand in der Datei, Linien,
// Flächen, Text und Punkte (Bögen und Text als Kurven, Linientypen als Striche) und nennt, was ezdxf nicht zeichnen kann.
// Eine kaputte Datei gibt eine Meldung statt eines Absturzes. In der echten App: Klick im Dateibaum öffnet die DXF im
// Code-Panel, ein in der Datei ausgeschalteter Layer ist zunächst aus, Layer lassen sich aus- und einblenden (auch über
// das Menü), Zoom, Neuladen nach einer Änderung von außen (Ausschnitt und Layer bleiben), „Mark up view“ mit Ausschnitt
// im Namen, kaputte Datei mit Meldung, gelöschte Datei schließt den Reiter.
// Aufruf: npm run test:dxf (baut vorher). SMOKE_VISIBLE=offscreen SMOKE_SHOTS=1 legt Bilder ab.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP, checker, cleanup, sleep, startApp } from './harness.mjs';

const t = checker();
const { check } = t;
let app;

const PY = process.env.SOMA_PYTHON || path.join(process.env.LOCALAPPDATA ?? '', 'soma-dev', 'venv', 'Scripts', 'python.exe');
const py = (args, opts = {}) => spawnSync(PY, args, { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, ...opts });

// Platte w x 100 mm mit allem, was in DXF-Dateien üblich ist. Der Layer „Helpers“ ist in der Datei ausgeschaltet, der
// 3D-Körper hat keine Ersatzgrafik (ezdxf kann ihn nicht zeichnen)
const MAKE = `
import sys, ezdxf
from ezdxf.enums import TextEntityAlignment
out, w = sys.argv[1], float(sys.argv[2])
doc = ezdxf.new("R2010", setup=True)
doc.header["$INSUNITS"] = 4
for name, color in (("Contour", 1), ("Holes", 3), ("Text", 7), ("Helpers", 5)):
    doc.layers.add(name, color=color)
doc.layers.get("Helpers").off()
msp = doc.modelspace()
msp.add_lwpolyline([(0, 0), (w, 0), (w, 100), (0, 100)], close=True, dxfattribs={"layer": "Contour"})
for x in (20, w - 20):
    msp.add_circle((x, 20), 5, dxfattribs={"layer": "Holes"})
msp.add_arc((w / 2, 50), 30, 0, 180, dxfattribs={"layer": "Contour"})
msp.add_line((0, 50), (w, 50), dxfattribs={"layer": "Helpers", "linetype": "CENTER"})
msp.add_text("Ø10 PLATE", height=5, dxfattribs={"layer": "Text"}).set_placement((60, 80), align=TextEntityAlignment.LEFT)
h = msp.add_hatch(dxfattribs={"layer": "Contour"})
h.set_pattern_fill("ANSI31", scale=0.5)
h.paths.add_polyline_path([(w - 50, 60), (w - 10, 60), (w - 10, 90), (w - 50, 90)], is_closed=True)
msp.add_linear_dim(base=(w / 2, -15), p1=(0, 0), p2=(w, 0), override={"dimtxt": 3.5, "dimasz": 3}, dxfattribs={"layer": "Contour"}).render()
msp.add_spline([(10, 60), (30, 90), (50, 60), (70, 90)], dxfattribs={"layer": "Contour"})
msp.add_point((w / 2, 90), dxfattribs={"layer": "Contour"})
solid = msp.add_3dsolid()
solid.sat = ["700 0 1 0", "@33 Spatial Corp. ACIS 7.0 NT 24 Thu Jan 01 00:00:00 2026", "1 9.9999999999999995e-07 1e-10",
             "body $-1 -1 $-1 $-1 $-1 $-1 #", "End-of-ACIS-data"]
doc.saveas(out)
`;
const make = (file, w) => py(['-c', MAKE, file, String(w)]);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-dxf-'));
try {
  // 1) soma dxfview direkt
  const plate = path.join(dir, 'plate.dxf'), out = path.join(dir, 'plate.json');
  const mk = make(plate, 200);
  check('Test-DXF mit ezdxf angelegt', mk.status === 0 && fs.existsSync(plate), mk.stderr.slice(-200));
  const v = py(['-m', 'soma', 'dxfview', plate, '--out', out]);
  const r = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, 'utf8')) : {};
  // Etwas breiter als die Platte: Die Maßpfeile ragen hinaus
  const w = r.box ? r.box[2] - r.box[0] : 0;
  check('soma dxfview: Einheit mm, Breite 200, Koordinaten relativ zur Mitte', v.status === 0 && r.ok && r.units === 'mm' && w >= 200 && w < 205
    && Math.abs(r.origin?.[0] - 100) < 1 && Math.abs(r.box[0] + r.box[2]) < 1e-3, `${v.stderr.slice(-200)} ${JSON.stringify(r.box)} ${JSON.stringify(r.origin)}`);
  const layer = (n) => r.layers?.find((l) => l.name === n);
  check('Layer mit Farbe, der in der Datei ausgeschaltete ist markiert', ['0', 'Contour', 'Helpers', 'Holes', 'Text'].every((n) => layer(n))
    && layer('Helpers').off && !layer('Contour').off && layer('Contour').color === '#ff0000' && layer('Holes').color === '#00ff00', JSON.stringify(r.layers));
  const kinds = new Set((r.batches ?? []).map((b) => b.kind));
  check('Linien, Flächen (Schraffur, Maßpfeile), Text und Punkt', ['line', 'fill', 'text', 'point'].every((k) => kinds.has(k)), [...kinds].join(','));
  const ops = (n) => (r.batches ?? []).filter((b) => r.layers[b.layer].name === n).flatMap((b) => b.ops);
  // Die Maßzahl steht in einer TrueType-Schrift (Kurven), der TEXT im Stil „Standard“ in der Strichschrift von ezdxf (Linien)
  const textOps = (r.batches ?? []).filter((b) => b.kind === 'text').flatMap((b) => b.ops);
  check('Bögen und Schrift bleiben Kurven (Befehle Q oder C)', ops('Holes').includes(3) && textOps.includes(2), `${ops('Holes').length} ${textOps.length}`);
  check('Linientyp CENTER als Striche aufgelöst', ops('Helpers').filter((o) => o === 0).length > 5, `${ops('Helpers').filter((o) => o === 0).length} Striche`);
  check('Nicht Zeichenbares wird genannt (3D-Körper ohne Ersatzgrafik)', r.skipped?.['3DSOLID'] === 1 && r.entities === 11, JSON.stringify(r.skipped));
  const v2 = py(['-m', 'soma', 'dxfview', plate, '--out', out + '2']);
  check('Gleiche Datei, gleiche Ausgabe', v2.status === 0 && fs.readFileSync(out + '2', 'utf8') === fs.readFileSync(out, 'utf8'));
  const bad = path.join(dir, 'broken.dxf');
  fs.writeFileSync(bad, 'garbage\nnot a dxf\n');
  const vb = py(['-m', 'soma', 'dxfview', bad, '--out', out + 'b']);
  const rb = fs.existsSync(out + 'b') ? JSON.parse(fs.readFileSync(out + 'b', 'utf8')) : {};
  check('Kaputte Datei: Meldung statt Absturz', vb.status === 1 && rb.ok === false && rb.error?.includes('not a readable DXF') && !vb.stderr.includes('Traceback'), rb.error ?? vb.stderr.slice(-200));

  // 2) In der App
  app = await startApp({ name: 'dxf' });
  const { ev, waitFor } = app;
  const ed = () => ev(() => window.__t.editor.state());
  const dxf = async () => (await ed()).dxf;
  const shot = async (name) => {
    if (!process.env.SMOKE_SHOTS) return;
    fs.mkdirSync(path.join(APP, 'test', 'shots'), { recursive: true });
    await sleep(500);
    await app.screenshot(path.join(APP, 'test', 'shots', `${name}.png`)).catch((e) => console.log('Screenshot:', e.message));
  };
  await waitFor('Projekt und Build', () => !!window.__t && !!window.__t.project() && window.__t.status().state === 'ok');
  const proj = await ev(() => window.__t.project());
  fs.mkdirSync(path.join(proj.dir, 'cut'), { recursive: true });
  const file = path.join(proj.dir, 'cut', 'plate.dxf');
  make(file, 200);
  await ev(() => window.__t.showPanel('files'));
  await ev(() => window.__t.revealFile('cut/plate.dxf'));
  await waitFor('Datei im Dateibaum', () => window.__t.fileRows().includes('plate.dxf'), 20000).catch(() => {});
  await ev(() => document.querySelector('#tab-files .frow[data-path="cut/plate.dxf"]')?.click());
  await waitFor('DXF gezeichnet', () => { const s = window.__t.editor.state().dxf; return s && !s.loading && s.batches > 0; }, 60000).catch(() => {});
  let s = await ed();
  check('Klick im Dateibaum öffnet die DXF im Code-Panel', s.file === 'cut/plate.dxf' && s.dxf?.units === 'mm' && !s.dxf.error, JSON.stringify(s.dxf)?.slice(0, 200));
  const ink1 = await ev(() => window.__t.editor.dxfInked());
  check('Linien und Text sind auf der Zeichenfläche', ink1 > 1000, `${ink1} Bildpunkte`);
  // Breite etwas über 200: Die Maßpfeile ragen über die Platte hinaus
  check('Leiste: Größe mit Einheit, in der Datei ausgeschalteter Layer zunächst aus', /^Layers 4\/5 \| 20\d(\.\d+)? × 11\d(\.\d+)? mm$/.test(s.dxf?.bar ?? '')
    && s.dxf.layers.find((l) => l.name === 'Helpers')?.on === false, s.dxf?.bar);
  check('Hinweis nennt, was nicht gezeigt wird', s.dxf?.note === 'Not shown: 1 × 3DSOLID.', s.dxf?.note);
  await shot('20-dxf');

  // Vergleichswert erst, wenn neu Zeichnen dasselbe ergibt: Nach einigen Auslesungen zeichnet Chromium die Fläche in
  // Software statt auf der Grafikkarte, die Kantenglättung und damit die Zahl der Bildpunkte ändert sich
  let ink0 = -1;
  for (let i = 0, last = -2; i < 6 && ink0 !== last; i++) {
    last = ink0;
    await ev(() => window.__t.editor.dxfLayers([], true));
    ink0 = await ev(() => window.__t.editor.dxfInked());
  }
  await ev(() => window.__t.editor.dxfLayers(['Contour'], false));
  const ink2 = await ev(() => window.__t.editor.dxfInked());
  await ev(() => window.__t.editor.dxfLayers(['contour'], true)); // Groß- und Kleinschreibung zählt bei Layern nicht
  const ink3 = await ev(() => window.__t.editor.dxfInked());
  check('Layer ausblenden zeichnet weniger, wieder einblenden alles', ink2 < ink0 * 0.8 && ink3 === ink0, `${ink0} -> ${ink2} -> ${ink3}`);
  // Über das Menü: in der Datei ausgeschalteten Layer einschalten
  await ev(() => document.querySelector('.dxfview:not([hidden]) .pdf-bar button').click());
  const menu = await ev(() => [...document.querySelectorAll('.dxf-layers:not([hidden]) .mi[role=menuitemcheckbox]')].map((b) => `${b.textContent}:${b.getAttribute('aria-checked')}`));
  check('Layer-Menü: alle Layer mit Zustand, ausgeschaltete gekennzeichnet', menu.length === 5 && menu.includes('Helpersoff in file:false') && menu.includes('Contour:true'), menu.join(' | '));
  await ev(() => [...document.querySelectorAll('.dxf-layers .mi[role=menuitemcheckbox]')].find((b) => b.textContent.startsWith('Helpers')).click());
  s = await ed();
  const ink4 = await ev(() => window.__t.editor.dxfInked());
  check('Klick im Menü blendet den Layer ein, das Menü bleibt offen', s.dxf.layers.find((l) => l.name === 'Helpers').on && s.dxf.bar.startsWith('Layers |') && ink4 > ink3
    && await ev(() => !document.querySelector('.dxf-layers').hidden), `${s.dxf.bar} ${ink4}`);
  await shot('20b-dxf-layer');
  await ev(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));

  await ev(() => window.__t.editor.dxfZoom(4));
  const z = await dxf();
  check('Zoom: 400 %, nicht mehr eingepasst, Mitte bleibt', z.zoom === 400 && !z.fitted && Math.abs(z.center[0] - s.dxf.center[0]) < 1e-6, `${z.zoom} ${JSON.stringify(z.center)}`);
  // Von außen geändert (etwa vom Agenten): neu zeichnen, Ausschnitt und Layer bleiben
  make(file, 300);
  await waitFor('Neue Fassung gezeichnet', () => { const b = window.__t.editor.state().dxf?.box; return b && b[2] - b[0] > 299; }, 60000).catch(() => {});
  const z2 = await dxf();
  check('Geänderte Datei: neu gezeichnet, Ausschnitt und eingeblendeter Layer bleiben', z2.box?.[2] - z2.box?.[0] > 299 && !z2.fitted
    && Math.abs(z2.center[0] - z.center[0]) < 1e-3 && Math.abs(z2.center[1] - z.center[1]) < 1e-3 && z2.layers.find((l) => l.name === 'Helpers').on,
  `${JSON.stringify(z2.box)} ${JSON.stringify(z2.center)} vs ${JSON.stringify(z.center)}`);

  await ev(() => window.__t.editor.dxfMark());
  await waitFor('Zeichenfläche', () => window.__t.markup().active, 10000).catch(() => {});
  const m = await ev(() => window.__t.markup());
  check('„Mark up view“: Ausschnitt auf der Zeichenfläche, Name mit Bereich', m.active && /^cut\/plate\.dxf, area x [\d.]+ to [\d.]+, y [-\d.]+ to [-\d.]+ mm$/.test(m.source ?? ''), m.source);
  await ev(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await ev(() => window.__t.editor.dxfFit());
  check('Eingepasst: Name ohne Bereich', (await dxf()).label === 'cut/plate.dxf', (await dxf()).label);

  fs.writeFileSync(path.join(proj.dir, 'cut', 'broken.dxf'), 'garbage\nnot a dxf\n');
  await ev(() => window.__t.openCode('cut/broken.dxf'));
  await waitFor('Fehlermeldung', () => !!window.__t.editor.state().dxf?.error, 60000).catch(() => {});
  s = await ed();
  check('Kaputte DXF: Meldung in der Ansicht, App läuft weiter', s.file === 'cut/broken.dxf' && s.dxf?.message.includes('not a readable DXF')
    && await ev(() => [...document.querySelectorAll('.dxf-msg')].some((x) => x.offsetParent && x.textContent.includes('not a readable DXF'))), s.dxf?.error ?? '');

  fs.rmSync(file);
  await waitFor('Reiter geschlossen', () => !window.__t.editor.state().files.includes('cut/plate.dxf'), 20000).catch(() => {});
  check('Gelöschte DXF: Reiter geht zu', !(await ed()).files.includes('cut/plate.dxf'), (await ed()).files.join(', '));
  await sleep(1000);
  const relevant = app.page.errors.filter((e) => !/favicon/i.test(e));
  check('Keine Konsolenfehler im Renderer', relevant.length === 0, relevant.slice(0, 2).join(' | ').slice(0, 100));
} catch (e) {
  console.log('ABBRUCH:', e.message);
  t.fail();
}
if (app) { await app.stop(); cleanup(app.ud); }
cleanup(dir);
console.log(t.fails ? `\n${t.fails} Prüfung(en) fehlgeschlagen` : '\nALLE PRÜFUNGEN BESTANDEN');
process.exit(t.fails ? 1 : 0);
