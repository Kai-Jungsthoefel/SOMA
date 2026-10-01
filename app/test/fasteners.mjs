// Test für die Normteile (soma.fasteners, E48): Maße aus den Tabellen, Lage mit at/direction/on/sunk, Bohrungen ohne
// Überschneidung, Mutternfallen, Gewindeeinsätze, Fehlermeldungen, Rolle "hardware". Dann in der echten App: Build,
// Bauteilbaum (Zukaufteile bei den eigenen Teilen, nicht unter Referenzen), Auswahl mit „(Zukaufteil)“, export --all
// ohne Normteile. Dazu läuft der Codeblock des Skills „Normteile“, der dem Agenten die Bibliothek erklärt. Aufruf: npm run test:fasteners (baut vorher). SMOKE_VISIBLE=offscreen SMOKE_SHOTS=1 legt ein Bild ab.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { APP, checker, cleanup, sleep, startApp } from './harness.mjs';

const t = checker();
const { check } = t;
let app;

// Dasselbe Python wie die App (paths.ts): SOMA_PYTHON oder die Entwicklungsumgebung aus Phase 0
const PY = process.env.SOMA_PYTHON || path.join(process.env.LOCALAPPDATA ?? '', 'cadide-phase0', 'venv-full', 'Scripts', 'python.exe');
const py = (args, opts = {}) => spawnSync(PY, args, { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, ...opts });

// Jede Prüfung als JSON-Zeile [Text, ok, Detail]
const LIB_CHECKS = String.raw`
import json, math, time
import cadquery as cq
from soma import registry
from soma.fasteners import Screw, Nut, Washer, HeatSetInsert, lengths, pick_length

def out(label, ok, detail=""):
    print(json.dumps([label, bool(ok), str(detail)[:90]]), flush=True)

def bb(s):
    b = s.BoundingBox()
    return [round(v, 3) for v in (b.xmin, b.xmax, b.ymin, b.ymax, b.zmin, b.zmax)]

def near(a, b, tol=0.01):
    return all(abs(x - y) <= tol for x, y in zip(a, b))

def overlap(a, b):
    return a.intersect(b).Volume()

# 1) Jede Norm baut einen gueltigen Koerper mit den Massen der Tabelle
rows = []
ok = True
for std, size, head_d, head_h, top in [("ISO 4762", "M3x10", 5.68, 3, 3), ("ISO 7380", "M3x10", 5.7, 1.65, 1.65), ("ISO 10642", "M3x10", 6, 1.5, 0),
                                       ("ISO 4017", "M5x20", 8 / math.cos(math.radians(30)), 3.74, 3.74), ("ISO 4014", "M5x30", None, 3.5, 3.5),
                                       ("DIN 931", "M10x40", None, 6.4, 6.4), ("ISO 4026", "M3x6", 3, 0, 0)]:
    s = Screw(std, size, at=(0, 0, 0))
    b = bb(s.shape)
    good = s.shape.isValid() and len(s.shape.Solids()) == 1 and abs(b[4] + s.length) < 1e-6 and abs(b[5] - top) < 1e-6
    good = good and (head_d is None or abs(s.head_diameter - head_d) < 0.01) and abs(s.head_height - head_h) < 0.01
    ok = ok and good
    rows.append(f"{s.designation}:{'ok' if good else b}")
out("Sieben Schraubennormen: gültig, Länge und Kopf wie in der Tabelle", ok, " ".join(rows))
n = Nut("ISO 4032", "M3", at=(0, 0, 0)); w = Washer("ISO 7089", "M3", at=(0, 0, 0)); sq = Nut("DIN 557", "M5", at=(0, 0, 0))
out("Mutter ISO 4032 M3 (SW 5,5 × 2,4), Scheibe ISO 7089 M3 (3,2/7 × 0,55), Vierkant DIN 557 M5",
    n.key == 5.5 and n.height == 2.4 and near(bb(n.shape)[2:], [-2.75, 2.75, 0, 2.4]) and (w.inner, w.outer_diameter, w.thickness) == (3.2, 7.0, 0.55)
    and near(bb(sq.shape), [-4, 4, -4, 4, 0, 4]) and n.shape.isValid() and w.shape.isValid(), bb(n.shape))
out("Normlängen ISO 4762 M3 und pick_length (kürzeste passende, mit Obergrenze)",
    lengths("ISO 4762", "M3") == [5, 6, 8, 10, 12, 16, 20, 25, 30] and pick_length("ISO 4762", "M3", 9) == 10 and pick_length("ISO 7380", "M3", 6.5, 8.7) == 8,
    lengths("ISO 4762", "M3"))
out("Schreibweisen: \"ISO 4762 M3x10\" als ein Text, \"iso 4762\" mit \"m3 x 10\", ISO 7380-1",
    Screw("ISO 4762 M3x10", at=(0, 0, 0)).designation == "ISO 4762 M3x10" and Screw("iso 4762", "m3 x 10", at=(0, 0, 0)).designation == "ISO 4762 M3x10"
    and Screw("ISO 7380-1", "M4", 10, at=(0, 0, 0)).designation == "ISO 7380 M4x10")

# 2) Lage
s = Screw("ISO 4762", "M3x10", at=(10, 10, 5))
out("Kopf liegt an at auf, Schaft entlang -Z: seat, tip, outer", near(s.seat, (10, 10, 5)) and near(s.tip, (10, 10, -5)) and near(s.outer, (10, 10, 8)), (s.seat, s.tip, s.outer))
h = Screw("ISO 4762", "M3x10", at=(20, 0, 2.5), direction="-X")
out("Waagerecht mit direction=\"-X\": Kopf zeigt nach +X", near(bb(h.shape)[:2], [10, 23]), bb(h.shape))
plate = cq.Workplane().box(40, 40, 5, centered=(True, True, False))
o = Screw("ISO 7380", "M3x8", at=(10, -10), on=plate)
out("on=Platte mit at=(x, y): Auflage auf der Oberseite gefunden", near(o.seat, (10, -10, 5)), o.seat)
wpl = Screw("ISO 4762", "M3x6", at=cq.Workplane().box(20, 20, 10).faces(">X").workplane())
loc = Screw("ISO 4762", "M3x6", at=cq.Location(cq.Vector(0, 0, 5), cq.Vector(1, 0, 0), 90))
out("at als Workplane auf einer Fläche und als cq.Location: Richtung gegen deren Normale",
    near(wpl.seat, (10, 0, 0)) and near(wpl.direction, (-1, 0, 0)) and near(loc.direction, (0, 1, 0)), (wpl.direction, loc.direction))

# 3) Bohrungen: nach dem cut ueberschneiden sich Schraube und Platte nicht
P = plate.val()
cut = plate.cut(s.clearance_hole()).val()
removed = P.Volume() - cut.Volume()
out("Durchgangsloch mittel (M3: 3,4 mm) durch 5 mm Platte, Schraube frei", abs(removed - math.pi * 1.7 ** 2 * 5) < 0.01 and overlap(s.shape, cut) < 1e-6, round(removed, 3))
sk = Screw("ISO 4762", "M3x10", at=(-10, 10, 5), sunk=True)
cut2 = plate.cut(sk.clearance_hole()).val()
out("sunk=True: Kopf bündig in der Senkung (Kopf oben bei z = 5), keine Überschneidung", near(sk.outer, (-10, 10, 5)) and overlap(sk.shape, cut2) < 1e-6 and cut2.isValid(), sk.seat)
cs = Screw("ISO 10642", "M4x12", at=(-10, -10, 5))
cut3 = plate.cut(cs.clearance_hole()).val()
out("Senkschraube: Oberseite an at, Kegelsenkung, keine Überschneidung", abs(bb(cs.shape)[5] - 5) < 1e-6 and overlap(cs.shape, cut3) < 1e-6, bb(cs.shape))
fine = plate.cut(s.clearance_hole(fit="fine", oversize=0.2)).val()
out("fit=\"fine\" mit oversize=0.2 ergibt 3,4 mm (3,2 + 0,2)", abs(P.Volume() - fine.Volume() - math.pi * 1.7 ** 2 * 5) < 0.01)
tap = Screw("ISO 4762", "M3x10", at=(0, 0, 5)).tap_hole()
out("Kernloch M3: 2,5 mm, bis 3 Steigungen hinter das Schaftende", abs(bb(tap)[1] - 1.25) < 1e-3 and abs(bb(tap)[4] - (-5 - 1.5)) < 1e-3, bb(tap))

# 4) Mutter und Scheibe am anderen Ende
bolt = Screw("ISO 4017", "M5x16", at=(0, 0, 5))
wa = Washer("ISO 7089", "M5", at=bolt.point(5), direction="+Z")
nu = Nut("ISO 4032", "M5", at=wa.outer, direction="+Z")
out("Scheibe an point(5) unter der Platte, Mutter an washer.outer, nichts überschneidet sich",
    near(wa.seat, (0, 0, 0)) and near(wa.outer, (0, 0, -1.1)) and abs(bb(nu.shape)[4] + 5.8) < 1e-3 and overlap(nu.shape, bolt.shape) < 1e-6
    and overlap(wa.shape, P) < 1e-6, bb(nu.shape))

# 5) Mutternfallen
nt = Nut("ISO 4032", "M3", at=(10, 10, 0), direction="+Z", sunk=True)
cut4 = plate.cut(nt.trap()).val()
out("Versenkte Mutter von unten: Tasche offen zur Unterseite, Mutter frei", near(bb(nt.shape)[4:], [0, 2.4]) and overlap(nt.shape, cut4) < 1e-6 and cut4.isValid(), bb(nt.shape))
w0 = Nut("ISO 4032", "M3", at=(0, 0, 1), direction="+Z").trap(slot="+X", slot_length=30).BoundingBox().ylen
w30 = Nut("ISO 4032", "M3", at=(0, 0, 1), direction="+Z", angle=30).trap(slot="+Y", slot_length=30).BoundingBox().xlen
w0y = Nut("ISO 4032", "M3", at=(0, 0, 1), direction="+Z").trap(slot="+Y", slot_length=30).BoundingBox().xlen
out("Schlitz: entlang X so breit wie SW + Spiel (5,9), entlang Y mit angle=30 auch, ohne Drehung Eckmaß",
    abs(w0 - 5.9) < 1e-3 and abs(w30 - 5.9) < 1e-3 and abs(w0y - 5.9 / math.cos(math.radians(30))) < 1e-3, (round(w0, 3), round(w30, 3), round(w0y, 3)))

# 6) Gewindeeinsaetze
ins = HeatSetInsert("M3x5.7", at=(0, 0, 10))
hb = bb(ins.hole())
voron = HeatSetInsert("M3x4", variant="Voron", at=(0, 0, 0))
plain = HeatSetInsert("M3x4", at=(0, 0, 0))
out("Einsatz ruthex M3x5.7: Ø 4,6, Bohrung Ø 4,04 (Bohrer #21), 6,7 mm tief, Teilenummer",
    ins.diameter == 4.6 and abs(ins.hole_diameter - 4.0386) < 1e-3 and abs(hb[4] - (10 - 6.7)) < 1e-6 and near(bb(ins.shape)[4:], [4.3, 10]) and ins.part_number == "GE-M3x57-001",
    (round(ins.hole_diameter, 4), hb[4], ins.part_number))
out("M3x4 ohne Zusatz: die normale Ausführung, mit variant=\"Voron\" Ø 5", plain.diameter == 4.6 and voron.diameter == 5.0 and voron.designation.endswith("Voron"), voron.designation)

# 7) Fehler werden erklaert
def err(f):
    try:
        f()
    except Exception as e:
        return f"{type(e).__name__}: {e}"
    return "kein Fehler"
msgs = {
    "din": err(lambda: Screw("DIN 912", "M3x10", at=(0, 0, 0))),
    "len": err(lambda: Screw("ISO 4762", "M3x11", at=(0, 0, 0))),
    "size": err(lambda: Screw("ISO 4762", "M7x10", at=(0, 0, 0))),
    "at": err(lambda: Screw("ISO 4762", "M3x10")),
    "xy": err(lambda: Screw("ISO 4762", "M3x10", at=(1, 2))),
    "miss": err(lambda: Screw("ISO 4762", "M3x10", at=(50, 50), on=plate)),
    "m10": err(lambda: HeatSetInsert("M10x12.7", at=(0, 0, 0))),
    "amb": err(lambda: HeatSetInsert("M3", at=(0, 0, 0))),
}
out("DIN 912: Hinweis auf ISO 4762", "heisst heute ISO 4762" in msgs["din"], msgs["din"])
out("M3x11: keine Normlänge, Liste und check_length=False genannt", "Normlaengen: 5, 6, 8, 10, 12" in msgs["len"] and "check_length=False" in msgs["len"]
    and Screw("ISO 4762", "M3x11", at=(0, 0, 0), check_length=False).length == 11, msgs["len"])
out("M7 gibt es nicht: vorhandene Größen genannt", "Vorhanden: M1.6, M2" in msgs["size"], msgs["size"])
out("at fehlt, (x, y) ohne on, Gerade verfehlt das Teil: je eine Erklärung", "at fehlt" in msgs["at"] and "on=teil" in msgs["xy"] and "trifft das Teil nicht" in msgs["miss"],
    msgs["miss"])
out("Einsatz M10 (Tabelle nennt Bohrer M14): abgelehnt statt falscher Bohrung", "keine brauchbare Bohrung" in msgs["m10"], msgs["m10"])
out("Einsatz M3 ohne Länge: nicht eindeutig, Längen genannt", "nicht eindeutig" in msgs["amb"] and "5.7" in msgs["amb"], msgs["amb"])

# 8) Viele gleiche Schrauben: die Geometrie wird nur einmal gebaut
t0 = time.perf_counter()
many = [Screw("ISO 4762", "M4x16", at=(i * 10.0, 0, 0)).shape for i in range(60)]
dt = time.perf_counter() - t0
out("60 Schrauben M4x16 an verschiedenen Stellen in unter 1,5 s", dt < 1.5 and abs(bb(many[59])[0] - (590 - 3.61)) < 0.01, f"{dt:.2f} s")

# 9) add_part: Rolle und Farbe der Normteile, ueberschreibbar
registry.REGISTRY.clear()
registry.add_part("Schraube", s)
registry.add_part("Einsatz", ins, group="Normteile")
registry.add_part("Als Referenz", nu, role="reference")
registry.add_part("Platte", plate)
r = {p["name"]: p for p in registry.REGISTRY}
out("add_part: Normteile ohne Angabe role \"hardware\" mit eigener Farbe, role= überschreibt, Platte bleibt \"part\"",
    r["Schraube"]["role"] == "hardware" and r["Einsatz"]["role"] == "hardware" and r["Als Referenz"]["role"] == "reference" and r["Platte"]["role"] == "part"
    and near(r["Einsatz"]["color"][:3], (0.80, 0.63, 0.32)) and isinstance(r["Schraube"]["shape"], cq.Shape),
    {k: v["role"] for k, v in r.items()})
registry.REGISTRY.clear()
`;

const MODEL = `import cadquery as cq
from soma import add_part
from soma.fasteners import Screw, Nut, HeatSetInsert, pick_length

L, W, H, LID = 60.0, 40.0, 20.0, 3.0
CORNERS = [(sx * 22, sy * 12) for sx in (-1, 1) for sy in (-1, 1)]

body = cq.Workplane().box(L, W, H, centered=(True, True, False)).faces(">Z").shell(-2)
for x, y in CORNERS:
    body = body.union(cq.Workplane().circle(4).extrude(H).translate((x, y, 0)))
lid = cq.Workplane().box(L, W, LID, centered=(True, True, False)).translate((0, 0, H))

length = pick_length("ISO 7380", "M3", LID + 3, LID + 5.7)
for i, (x, y) in enumerate(CORNERS, 1):
    ins = HeatSetInsert("M3x5.7", at=(x, y, H))
    s = Screw("ISO 7380", "M3", length, at=(x, y), on=lid)
    body = body.cut(ins.hole())
    lid = lid.cut(s.clearance_hole(oversize=0.2))
    add_part(f"Einsatz {i}", ins, group="Normteile/Einsätze")
    add_part(f"Schraube {i}", s, group="Normteile/Schrauben")

# Klemmschraube seitlich durch die Wand in einen Block, die Mutter wird von oben eingelegt
body = body.union(cq.Workplane().box(11, 12, 16, centered=False).translate((17, -6, 2)))
side = Screw("ISO 4762", "M3x12", at=(L / 2, 0, 10), direction="-X")
nut = Nut("ISO 4032", "M3", at=side.point(7), direction="+X", angle=30)
body = body.cut(side.clearance_hole()).cut(nut.trap(slot="+Z", slot_length=15))
add_part("Klemmschraube", side, group="Normteile")
add_part("Mutter", nut, group="Normteile")

add_part("Gehäuse", body, color=(0.25, 0.45, 0.75))
add_part("Deckel", lid, color=(0.85, 0.85, 0.88))
`;

try {
  // 1) Bibliothek direkt, ohne App
  const lib = py(['-c', LIB_CHECKS]);
  const lines = lib.stdout.split(/\r?\n/).filter((l) => l.startsWith('['));
  for (const l of lines) { const [label, ok, detail] = JSON.parse(l); check(label, ok, ok ? '' : detail); }
  check('Python-Prüfungen liefen durch', lib.status === 0 && lines.length >= 26, lib.status !== 0 ? lib.stderr.slice(-300) : String(lines.length));

  // Der Skill „Normteile“ erklärt dem Agenten die Bibliothek: sein Codeblock und die genannten Aufrufe müssen laufen
  const skill = fs.readFileSync(path.join(APP, 'resources', 'skills', 'normteile.md'), 'utf8');
  const block = /```python\r?\n([\s\S]*?)\r?\n```/.exec(skill)?.[1] ?? '';
  const run = py(['-c', [
    'import cadquery as cq',
    'from soma import add_part',
    'LID_TOP, BOSS_TOP = 23.0, 20.0',
    'lid = cq.Workplane().box(40, 40, 3, centered=(True, True, False)).translate((0, 0, 20))',
    'base = cq.Workplane().box(40, 40, 20, centered=(True, True, False))',
    block,
    'T = 3.0',
    'w = Washer("ISO 7089", "M3", at=s.point(T), direction="+Z")',
    'n = Nut("ISO 4032", "M3", at=w.outer, direction="+Z")',
    'o = Screw("ISO 7380", "M3x8", at=(-10, -10), on=lid)',
    'info = (s.head_diameter, s.head_height, s.key, s.clearance(), n.key, n.height, ins.diameter, ins.length, s.designation, ins.part_number)',
    'assert lid.val().isValid() and base.val().isValid() and abs(o.seat[2] - 23) < 1e-6',
    'print("ok", pick_length("ISO 4762", "M3", 9))',
  ].join('\n')]);
  check('Skill „Normteile“: Codeblock und die genannten Aufrufe laufen', block.includes('soma.fasteners') && run.status === 0 && run.stdout.startsWith('ok 10'),
    (run.stderr || run.stdout).slice(-160));

  // 2) In der App
  app = await startApp({ name: 'fasteners' });
  const { ev, waitFor } = app;
  await waitFor('Projekt und Build', () => !!window.__t && !!window.__t.project() && window.__t.status().state === 'ok' && window.__t.partCount() === 2);
  const proj = await ev(() => window.__t.project());
  fs.writeFileSync(path.join(proj.dir, 'model.py'), MODEL);
  await waitFor('Modell mit Normteilen gebaut', () => window.__t.status().state === 'ok' && window.__t.partCount() === 12, 90000).catch(() => {});
  const status = await ev(() => window.__t.status());
  check('Build: Gehäuse, Deckel, 4 Einsätze, 4 Schrauben, Klemmschraube und Mutter', (await ev(() => window.__t.partCount())) === 12,
    `${status.text} ${status.detail} ${status.viewerMsg ?? ''}`.slice(0, 120));
  const parts = await ev(() => window.__t.parts().map((p) => ({ name: p.name, role: p.role, group: p.group, color: p.color })));
  const byName = Object.fromEntries(parts.map((p) => [p.name, p]));
  check('Rollen: Normteile "hardware", Gehäuse und Deckel "part"', parts.filter((p) => p.role === 'hardware').length === 10 && byName['Gehäuse']?.role === 'part'
    && byName['Schraube 1']?.group === 'Normteile/Schrauben', parts.map((p) => `${p.name}:${p.role}`).join(' ').slice(0, 100));

  const outline = await ev(() => [...document.querySelectorAll('#tab-model .row, #tab-model .grp')].map((r) => (r.classList.contains('grp') ? '#' : '')
    + ((r.querySelector('.gname') ?? r.querySelector('.pname'))?.textContent ?? r.textContent)).join(' '));
  check('Bauteilbaum: Normteile als Gruppe bei den eigenen Teilen, keine Referenzen-Überschrift', outline.includes('Normteile') && outline.includes('Einsätze')
    && !outline.includes('#REFERENZEN'), outline.slice(0, 120));

  await ev(() => [...document.querySelectorAll('#tab-model .row:not(.gr)')].find((r) => r.querySelector('.pname')?.textContent === 'Schraube 1').querySelector('.nm').click());
  await waitFor('Auswahl', () => window.__t.info() !== '', 5000).catch(() => {});
  const info = await ev(() => window.__t.info());
  check('Auswahl einer Schraube: Name mit „(Zukaufteil)“, Codestelle wie bei eigenen Teilen', info.startsWith('Schraube 1 (Zukaufteil)'), info.slice(0, 60));
  await ev(() => window.__t.viewer.setView('iso'));
  if (process.env.SMOKE_SHOTS) {
    fs.mkdirSync(path.join(APP, 'test', 'shots'), { recursive: true });
    await sleep(900);
    await app.screenshot(path.join(APP, 'test', 'shots', '17-normteile.png')).catch((e) => console.log('Screenshot:', e.message));
  }

  // 3) Export: --all ohne Normteile, einzeln gehen sie
  const exp = py(['-m', 'soma', 'export', '--all', '--format', 'stl', '--project', proj.dir, '--out', 'exp-test']);
  const files = fs.existsSync(path.join(proj.dir, 'exp-test')) ? fs.readdirSync(path.join(proj.dir, 'exp-test')).sort() : [];
  check('soma export --all: nur Gehäuse und Deckel, Meldung über 10 übersprungene Teile', exp.status === 0 && files.join(',') === 'Deckel.stl,Gehaeuse.stl'
    && exp.stdout.includes('nicht exportiert: 10'), `${files.join(',')} ${exp.stderr.slice(-120)}`);
  const one = py(['-m', 'soma', 'export', 'Klemmschraube', '--format', 'step', '--project', proj.dir, '--out', 'exp-test']);
  check('Einzeln exportiert: soma export Klemmschraube', one.status === 0 && fs.existsSync(path.join(proj.dir, 'exp-test', 'Klemmschraube.step')), one.stderr.slice(-120));
  fs.rmSync(path.join(proj.dir, 'exp-test'), { recursive: true, force: true });

  const relevant = app.page.errors.filter((e) => !/favicon/i.test(e));
  check('Keine Konsolenfehler im Renderer', relevant.length === 0, relevant.slice(0, 2).join(' | ').slice(0, 100));
} catch (e) {
  console.log('ABBRUCH:', e.message);
  t.fail();
}
if (app) { await app.stop(); cleanup(app.ud); }
console.log(t.fails ? `\n${t.fails} Prüfung(en) fehlgeschlagen` : '\nALLE PRÜFUNGEN BESTANDEN');
process.exit(t.fails ? 1 : 0);
