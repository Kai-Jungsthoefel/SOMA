// Test für technische Zeichnungen (soma.drawing, E76): Der Codeblock des Skills „Technical drawings“ baut ohne Hinweise,
// Ansichten, Schnitt, Einzelheit und Maße landen als DXF, PDF und PNG, gleicher Inhalt gibt gleiche Dateien, die Prüfung
// meldet getippte Zahlen, Punkte neben Kanten, verdeckte Kanten, Text außerhalb und übereinander, Fehler nennen Datei und
// Zeile. Die Rückmeldungen des ersten Agent-Tests (Blatt „Feedback“): Zahlen, Ø, Lage des Durchmessertexts, mehrzeiliger
// Text, Schriftfeld, Stückliste, verschiebbare Beschriftung, Stufenschnitt, unterbrochene Ansicht, Gesamt-PDF.
// Dann in der echten App: die PDF öffnet im Code-Panel, Bild und PDF zählen nicht als ungespeicherte Änderung.
// Aufruf: npm run test:drawing (baut vorher). SMOKE_VISIBLE=offscreen SMOKE_SHOTS=1 legt ein Bild ab.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP, checker, cleanup, sleep, startApp } from './harness.mjs';

const t = checker();
const { check } = t;
let app;

const PY = process.env.SOMA_PYTHON || path.join(process.env.LOCALAPPDATA ?? '', 'cadide-phase0', 'venv-full', 'Scripts', 'python.exe');
const py = (args, opts = {}) => spawnSync(PY, args, { encoding: 'utf8', env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, ...opts });
const soma = (dir, ...args) => py(['-m', 'soma', ...args, '--project', dir]);

// Passt zum Codeblock des Skills: Platte L x 60 x T mit vier Bohrungen, dazu ein Bolzen für den Schnitt mit ungeschnittenem Teil
const MODEL = `import cadquery as cq
from soma import add_part

L, W, T, HOLE = 120, 60, 12, 8
plate = (cq.Workplane("XY").box(L, W, T, centered=(True, True, False))
         .faces(">Z").workplane().rarray(90, 35, 2, 2).hole(HOLE)
         .faces(">Z").workplane().hole(10))
add_part("Bracket", plate)
add_part("Pin", cq.Workplane("XY").circle(5).extrude(30).translate((0, 0, -9)))
`;

// Absichtlich fehlerhafte Zeichnung: Jede Zeile löst genau eine Art Hinweis aus
const CHECKS = `from soma.drawing import Sheet
sh = Sheet("Checks", size="A3", scale="1:3")
front = sh.view(["Bracket", "Pin"], "front", at=(150, 200))
front.dim((-60, 0, 0), (60, 0, 0), offset=-10, text="125")
front.dim((-60, 0, 0), (-30, 0, 5), offset=-10)
front.dim((-41, 0, 6), (41, 0, 6), offset=-20)
sh.text("outside", (500, 100))
sh.text("one", (40, 40))
sh.text("one again", (41, 40.5))
sh.text("tiny", (40, 60), height=1.5)
cut = sh.section(["Bracket", "Pin"], "front", through=(0, 0, 0), at=(150, 120), name="A", unhatched=["Pin"])
b = sh.detail(front, (60, 0, 12), 5, at=(320, 120), scale="5:1", name="B")
sh.view("Bracket", "top", at=(330, 230), label="Top", label_at=(150, 188))
`;

// Rückmeldungen aus dem ersten Agent-Test: Zahlen ohne Nachkommastellen, kein doppeltes Ø, Text des Durchmessers in
// Richtung angle, eingerückter mehrzeiliger Text, Schriftfeld zu schmal, verschobene Beschriftung, Stufenschnitt mit
// Schnittverlauf, unterbrochene Ansicht, Maß auf ein Mittenkreuz ohne Bohrung, Positionsnummer in der Stückliste
const FEEDBACK = `from soma.drawing import Sheet, num
assert (num(130, 0), num(-0.0, 0), num(12.5)) == ("130", "0", "12.5"), num(130, 0)
sh = Sheet("Feedback", size="A3", scale="1:1", material="Birke Multiplex 18 mm")
top = sh.view("Bracket", "top", at=(100, 200), origin=(0, 0, 12))
top.diameter((0, 0, 12), 5, angle=90, text="Ø<> H7")
top.center_mark((20, -20, 12), 2.5)
top.dim((-60, -30, 12), (20, -20, 12), offset=-12)
sh.text("Notes:\\n  1. Deburr all edges, break sharp edges 0.3 x 45 degrees\\n  2. Anodize", (30, 280))
front = sh.view("Bracket", "front", at=(300, 230), breaks=[((-30, 0, 0), (30, 0, 0))], label="Shortened", label_at=(300, 255))
front.dim((-60, -30, 0), (60, -30, 0), offset=-10)
a = sh.section("Bracket", "front", path=[(-70, 17.5, 0), (-20, 17.5, 0), (-20, 0, 0), (70, 0, 0)], parent=top, name="A",
               at=(100, 110), letters_at=[(25, 225), (175, 225)])
sh.table([["1", "Bracket", "1"]], at=(230, 70), widths=[10, 40, 10])
top.leader((0, 0, 12), "1", at=(235, 65), end="dot")
`;

const BROKEN = `from soma.drawing import Sheet
sh = Sheet("Broken")
sh.view("Brackett", "front", at=(100, 100))
`;

let dir;
try {
  // 1) soma drawing ohne App
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-drawing-'));
  fs.mkdirSync(path.join(dir, 'drawings'));
  fs.writeFileSync(path.join(dir, 'model.py'), MODEL);
  const skill = fs.readFileSync(path.join(APP, 'resources', 'skills', 'zeichnung.md'), 'utf8');
  // Platzhalter mit den Standardwerten aus dem Kopf, wie die App sie in die Kopie schreibt
  const defaults = Object.fromEntries([...skill.matchAll(/^var (\w+): ([^|]*?) \|/gm)].map((m) => [m[1], m[2].trim()]));
  const block = (/```python\r?\n([\s\S]*?)\r?\n```/.exec(skill)?.[1] ?? '').replace(/\{\{(\w+)\}\}/g, (all, k) => defaults[k] ?? all);
  fs.writeFileSync(path.join(dir, 'drawings', 'skill.py'), block + '\n');
  fs.writeFileSync(path.join(dir, 'drawings', 'checks.py'), CHECKS);
  fs.writeFileSync(path.join(dir, 'drawings', 'broken.py'), BROKEN);
  fs.writeFileSync(path.join(dir, 'drawings', 'feedback.py'), FEEDBACK);

  const b1 = soma(dir, 'drawing', 'build', '--json');
  let res = null;
  try { res = JSON.parse(b1.stdout); } catch { /* unten gemeldet */ }
  check('soma drawing build --json: drei Blätter gebaut, ein Fehler, Rückgabe 1', !!res && res.built.length === 3 && res.errors.length === 1 && b1.status === 1,
    (b1.stderr || b1.stdout).slice(-200));
  check('Gesamt-PDF wird bei einem Fehler nicht geschrieben (es fehlte ein Blatt)', res?.set?.skipped === true && !fs.existsSync(path.join(dir, 'output', 'drawings.pdf')),
    JSON.stringify(res?.set));
  const by = Object.fromEntries((res?.built ?? []).map((x) => [x.name, x]));
  const br = by.Bracket;
  check('Skill-Codeblock: Blatt "Bracket" mit 4 Ansichten (Vorder-, Draufsicht, Schnitt A-A, Einzelheit B) und ohne Hinweise',
    block.includes('soma.drawing') && br?.views.length === 4 && br.views.map((v) => v.kind).join(',') === 'view,view,section,detail' && br.warnings.length === 0,
    JSON.stringify(br?.warnings ?? res)?.slice(0, 200));
  check('Maße gemessen: 120 (L) und "4x Ø8" am Durchmesser', br?.dims.some((d) => d.label === '120') && br.dims.some((d) => d.label === '"4x Ø8"'),
    br?.dims.map((d) => d.label).join(' '));
  check('Dateien: PDF und DXF in output/drawings/, Bild in .soma/drawings/ (A3, 200 dpi)', ['output/drawings/Bracket.pdf', 'output/drawings/Bracket.dxf', '.soma/drawings/Bracket.png']
    .every((f) => fs.existsSync(path.join(dir, f))) && fs.readFileSync(path.join(dir, 'output/drawings/Bracket.pdf')).subarray(0, 5).toString() === '%PDF-'
    && br.png_size[0] === 3307, JSON.stringify(br?.png_size));
  const draw = br?.views.find((v) => v.name === 'top');
  check('Ansicht von oben kennt die Bohrungen: 4 x Ø8 mit Mitten, Ø10 in der Mitte', draw?.circles.filter((c) => c.diameter === 8 && !c.arc).length === 4
    && draw.circles.some((c) => c.diameter === 10 && c.center.join(',') === '0,0,12'), JSON.stringify(draw?.circles)?.slice(0, 160));

  const w = (by.Checks?.warnings ?? []).map((x) => `${x.line}: ${x.message}`);
  const has = (line, part) => w.some((m) => m.startsWith(`${line}: `) && m.includes(part));
  check('Prüfung: getippte Zahl "125" statt gemessener 120', has(4, 'differs from the measured 120'), w.join(' | ').slice(0, 200));
  check('Prüfung: Punkt (-30, 0, 5) liegt auf keiner Kante', has(5, 'lies on no edge'), w.filter((m) => m.startsWith('5:')).join(' | '));
  check('Prüfung: Maß an verdeckter Kante (Bohrungen in der Vorderansicht)', has(6, 'only on a hidden edge'), w.filter((m) => m.startsWith('6:')).join(' | '));
  check('Prüfung: Text außerhalb des Rahmens, Texte übereinander, Text unter 2.5 mm, Maßstab 1:3', has(7, 'beyond the frame') && has(9, 'overlaps Text "one"')
    && has(10, 'at least 2.5 mm') && has(2, 'Scale 1:3'), w.join(' | ').slice(0, 200));
  check('Keine Hinweise ohne Grund (Schnitt, Einzelheit, Gesamtmaß 120 an echten Kanten)', !w.some((m) => /^(3|11|12): /.test(m)),
    w.filter((m) => /^(3|11|12): /.test(m)).join(' | '));
  check('Prüfung: Ansichtstitel auf einem Maß, mit Hinweis auf label_at', has(13, 'Label "Top" lies on dimension') && has(13, 'label_at=(x, y)'),
    w.filter((m) => m.startsWith('13:')).join(' | '));

  const fb = by.Feedback;
  const fw = (fb?.warnings ?? []).map((x) => `${x.line}: ${x.message}`);
  const fhas = (line, part) => fw.some((m) => m.startsWith(`${line}: `) && m.includes(part));
  check('Schriftfeld: zu langer Werkstoff wird gemeldet', fhas(3, 'Title block: "Birke Multiplex 18 mm" does not fit the field Material'), fw.join(' | ').slice(0, 300));
  check('Positionsnummer in der Stückliste wird gemeldet (Text und Hinweislinie)', fhas(14, 'Text "1" overlaps the table of line 13') && fhas(14, 'The leader overlaps the table'),
    fw.join(' | ').slice(0, 300));
  check('Sonst keine Hinweise: Ø-Text frei, Maß auf das Mittenkreuz, mehrzeiliger Text im Rahmen, Stufenschnitt, unterbrochene Ansicht',
    !fw.some((m) => /^([4-9]|1[0-2]): /.test(m)), fw.filter((m) => /^([4-9]|1[0-2]): /.test(m)).join(' | '));
  check('Maße: Ø nicht doppelt ("Ø10 H7"), 80 bis zum Mittenkreuz, 120 über die Unterbrechung', ['"Ø10 H7"', '80', '120'].every((l) => fb?.dims.some((d) => d.label === l)),
    fb?.dims.map((d) => d.label).join(' '));
  const fbCheck = py(['-c', String.raw`
import json, sys, math, ezdxf
doc = ezdxf.readfile(sys.argv[1])
msp = doc.modelspace()
texts = [(t.dxf.text, tuple(round(v, 2) for v in t.dxf.align_point)[:2]) for t in msp.query("TEXT")]
dia = [d for d in msp.query("DIMENSION") if "H7" in d.dxf.text]
mt = [e for d in dia for e in d.virtual_entities() if e.dxftype() == "MTEXT"]
step = [l for l in msp.query("LINE[layer=='VISIBLE']") if abs(l.dxf.start.x - 80) < 0.01 and abs(l.dxf.end.x - 80) < 0.01 and 95 < l.dxf.start.y < 125]
print(json.dumps(dict(
    indent=any(t.startswith("  1. Deburr") for t, _p in texts), mtext=len(msp.query("MTEXT")),
    dimtext=[d.dxf.text for d in dia], ø=[e.plain_text() for e in mt], up=[round(e.dxf.insert.y - 200, 2) for e in mt],
    letters=sorted(p for t, p in texts if t == "A"), label=[p for t, p in texts if t == "Shortened"],
    breaks=len([p for p in msp.query("LWPOLYLINE[layer=='THIN']") if len(p) == 6]),
    cut=[len(p) for p in msp.query("LWPOLYLINE[layer=='CUT']")], step=len(step))))
`, path.join(dir, 'output', 'drawings', 'Feedback.dxf')]);
  let fx = null;
  try { fx = JSON.parse(fbCheck.stdout); } catch { /* unten */ }
  check('Mehrzeiliger Text als Zeilen (kein MTEXT), Einrückung bleibt', fx?.indent === true && fx.mtext === 0, (fbCheck.stderr || fbCheck.stdout).slice(-200));
  check('Durchmesser: "Ø<> H7" wird "Ø10 H7", der Text steht in Richtung angle=90 (über der Mitte)', fx?.dimtext?.[0] === '<> H7' && fx.ø[0] === 'Ø10 H7' && fx.up[0] > 5,
    JSON.stringify(fx && { dimtext: fx.dimtext, ø: fx.ø, up: fx.up }));
  check('Buchstaben des Schnittverlaufs an letters_at, Titel an label_at', JSON.stringify(fx?.letters) === '[[25,225],[175,225]]' && JSON.stringify(fx?.label) === '[[300,255]]',
    JSON.stringify(fx && { letters: fx.letters, label: fx.label }));
  check('Stufenschnitt: Schnittverlauf mit 4 Punkten und zwei dicken Knicken, keine Kante an der Stufe; zwei Bruchlinien', JSON.stringify(fx?.cut) === '[4,3,3]' && fx.step === 0 && fx.breaks === 2,
    JSON.stringify(fx && { cut: fx.cut, step: fx.step, breaks: fx.breaks }));
  const err = res?.errors[0];
  check('Fehler: Datei, Zeile und die vorhandenen Bauteile', err?.file === 'drawings/broken.py' && err.line === 3 && err.message.includes("'Brackett' does not exist")
    && err.message.includes("'Bracket'"), JSON.stringify(err)?.slice(0, 160));

  // DXF: echte Maße, Schraffur nur am geschnittenen Teil, Linien der Einzelheit nur im Kreis
  const dxfCheck = py(['-c', String.raw`
import json, sys, math, ezdxf
from ezdxf import recover
doc, aud = recover.readfile(sys.argv[1])
msp = doc.modelspace()
types = {}
for e in msp:
    types[e.dxftype()] = types.get(e.dxftype(), 0) + 1
layers = sorted(l.dxf.name for l in doc.layers)
ok_detail = True
for e in msp.query("LINE[layer=='VISIBLE']"):
    for p in (e.dxf.start, e.dxf.end):
        if 290 < p.x < 370 and 40 < p.y < 120 and math.hypot(p.x - 330, p.y - 80) > 20.01:
            ok_detail = False
print(json.dumps(dict(errors=len(aud.errors), types=types, layers=layers, detail=ok_detail, hatches=len(msp.query("HATCH")))))
`, path.join(dir, 'output', 'drawings', 'Bracket.dxf')]);
  let dx = null;
  try { dx = JSON.parse(dxfCheck.stdout); } catch { /* unten */ }
  check('DXF ohne Fehler: 2 Maße als DIMENSION, Schraffur, Layer nach ISO 128', dx?.errors === 0 && dx.types.DIMENSION === 2 && dx.hatches >= 1
    && ['VISIBLE', 'HIDDEN', 'CENTER', 'DIM', 'HATCH', 'CUT'].every((l) => dx.layers.includes(l)), (dxfCheck.stderr || dxfCheck.stdout).slice(-200));
  check('Einzelheit B: Kanten nur im Kreis um ihre Mitte', dx?.detail === true);

  const before = ['Bracket.pdf', 'Bracket.dxf'].map((f) => fs.readFileSync(path.join(dir, 'output', 'drawings', f)));
  const png = fs.readFileSync(path.join(dir, '.soma', 'drawings', 'Bracket.png'));
  const b2 = soma(dir, 'drawing', 'build', 'drawings/skill.py');
  const after = ['Bracket.pdf', 'Bracket.dxf'].map((f) => fs.readFileSync(path.join(dir, 'output', 'drawings', f)));
  check('Gleicher Inhalt, gleiche Dateien: PDF, DXF und Bild bytegleich nach erneutem Bauen', b2.status === 0 && before.every((b, i) => b.equals(after[i]))
    && png.equals(fs.readFileSync(path.join(dir, '.soma', 'drawings', 'Bracket.png'))), b2.stdout.slice(0, 160));
  check('Ausgabe für den Agenten: Dateien und Hinweis auf das Bild', b2.stdout.includes('Drawing ok: "Bracket"') && b2.stdout.includes('output/drawings/Bracket.pdf')
    && b2.stdout.includes('.soma/drawings/Bracket.png (3307 x 2339 px)'), b2.stdout.slice(0, 300));
  const info = soma(dir, 'drawing', 'info', 'Bracket');
  check('soma drawing info: Ansichten mit Platz auf dem Blatt, Kreise, Maße mit Zeile', info.status === 0 && info.stdout.includes('Views:')
    && info.stdout.includes('circles: Ø10 x1 at (0, 0, 12); Ø8 x4') && /line \d+: 120 \(linear, top\)/.test(info.stdout), info.stdout.slice(0, 300));
  const list = soma(dir, 'drawing', 'list');
  check('soma drawing list: beide Blätter, der Fehler mit Zeile', list.stdout.includes('"Bracket"') && list.stdout.includes('"Checks"')
    && list.stdout.includes('ERROR drawings/broken.py:3'), list.stdout.slice(0, 300));

  fs.rmSync(path.join(dir, 'drawings', 'checks.py'));
  const b3 = soma(dir, 'drawing', 'build');
  check('Gelöschtes Blatt: PDF und DXF bleiben, die Ausgabe nennt sie, das Bild geht', b3.stdout.includes('Note: output/drawings/Checks.pdf belongs to no sheet anymore')
    && fs.existsSync(path.join(dir, 'output', 'drawings', 'Checks.pdf')) && !fs.existsSync(path.join(dir, '.soma', 'drawings', 'Checks.png')), b3.stdout.slice(-300));
  // Ohne Fehler: alle Blätter in output/drawings.pdf, nach Datei geordnet. Ein Teilbau holt die übrigen Blätter aus der DXF
  fs.rmSync(path.join(dir, 'drawings', 'broken.py'));
  const b5 = soma(dir, 'drawing', 'build');
  const setPdf = path.join(dir, 'output', 'drawings.pdf');
  const pages = (buf) => (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  const set1 = fs.existsSync(setPdf) ? fs.readFileSync(setPdf) : Buffer.alloc(0);
  check('Gesamt-PDF output/drawings.pdf mit beiden Blättern', b5.status === 0 && b5.stdout.includes('All sheets in one file: output/drawings.pdf (2 sheet(s))')
    && pages(set1) === 2, `${pages(set1)} Seiten; ${b5.stdout.slice(-200)}`);
  soma(dir, 'drawing', 'build', 'drawings/skill.py');
  check('Gesamt-PDF bytegleich nach Teilbau (Blatt aus der DXF gleich dem frisch gebauten)', fs.existsSync(setPdf) && set1.equals(fs.readFileSync(setPdf)));

  fs.appendFileSync(path.join(dir, 'model.py'), 'raise ValueError("kaputt")\n');
  const b4 = soma(dir, 'drawing', 'build');
  check('Modell baut nicht: Meldung mit Ort, keine Zeichnung', b4.status === 1 && b4.stderr.includes('The model does not build, so no drawing does either')
    && b4.stderr.includes('model.py:10'), b4.stderr.slice(-200));

  // 2) In der App: PDF im Code-Panel, nichts davon zählt als ungespeicherte Änderung
  app = await startApp({ name: 'drawing' });
  const { ev, waitFor } = app;
  await waitFor('Projekt und Build', () => !!window.__t && !!window.__t.project() && window.__t.status().state === 'ok');
  const proj = await ev(() => window.__t.project());
  fs.writeFileSync(path.join(proj.dir, 'model.py'), MODEL);
  fs.mkdirSync(path.join(proj.dir, 'drawings'), { recursive: true });
  fs.writeFileSync(path.join(proj.dir, 'drawings', 'bracket.py'), block + '\n');
  await waitFor('Modell gebaut', () => window.__t.status().state === 'ok' && window.__t.partCount() === 2, 90000).catch(() => {});
  await waitFor('Speicherstand', () => !!window.__t.saveState(), 10000).catch(() => {});
  const dirty0 = (await ev(() => window.__t.saveState())).dirtyFiles;
  const ab = soma(proj.dir, 'drawing', 'build');
  check('Im Projekt der App gebaut', ab.status === 0 && fs.existsSync(path.join(proj.dir, 'output', 'drawings', 'Bracket.pdf')), (ab.stderr || ab.stdout).slice(-200));
  await ev(() => window.__t.openCode('output/drawings/Bracket.pdf'));
  await waitFor('PDF gezeichnet', () => (window.__t.editor.state().pdf?.rendered ?? []).includes(1), 20000).catch(() => {});
  const pdf = (await ev(() => window.__t.editor.state())).pdf;
  const dark = await ev(() => {
    const c = document.querySelector('.pdf-page[data-page="1"] canvas');
    if (!c) return 0;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 100) n++;
    return n;
  });
  check('PDF öffnet im Code-Panel: eine Seite im Querformat, mit Linien gezeichnet', pdf?.pages === 1 && dark > 1000, `${JSON.stringify(pdf)?.slice(0, 100)} dark=${dark}`);
  await sleep(1500); // Dateibeobachtung und Speicherstand nachziehen lassen
  const dirty1 = (await ev(() => window.__t.saveState())).dirtyFiles;
  check('PDF, DXF und Bild zählen nicht als ungespeicherte Änderung', dirty1 === dirty0, `${dirty0} -> ${dirty1}`);
  if (process.env.SMOKE_SHOTS) {
    fs.mkdirSync(path.join(APP, 'test', 'shots'), { recursive: true });
    await sleep(600);
    await app.screenshot(path.join(APP, 'test', 'shots', '19-zeichnung.png')).catch((e) => console.log('Screenshot:', e.message));
  }
  const relevant = app.page.errors.filter((e) => !/favicon/i.test(e));
  check('Keine Konsolenfehler im Renderer', relevant.length === 0, relevant.slice(0, 2).join(' | ').slice(0, 100));
} catch (e) {
  console.log('ABBRUCH:', e.message);
  t.fail();
}
if (app) { await app.stop(); cleanup(app.ud); }
if (dir) cleanup(dir);
console.log(t.fails ? `\n${t.fails} Prüfung(en) fehlgeschlagen` : '\nALLE PRÜFUNGEN BESTANDEN');
process.exit(t.fails ? 1 : 0);
