// Test für die Netz-Exporte (3MF, AMF, STL, OBJ) ohne App: Ein Projekt mit vielen Geometrien (Verrundungen, Fasen,
// Bohrungen, Kugel, Torus, Kegelspitze, Drehteil, Loft, Feder, Text, Schale, Boolesche Vereinigung, zwei Körper in einem
// Teil, sehr kleines und sehr großes Teil, verschobenes und gedrehtes Teil, Normschraube) geht durch `soma export --all`.
// Ein eigener Leser (nicht der Code aus meshexport.py) prüft jede Datei: ein geschlossenes, mannigfaltiges Netz pro
// Körper mit gemeinsamen Ecken und einheitlicher Orientierung nach außen, Volumen und Hüllquader wie im CAD, keine
// entarteten Dreiecke. Dazu: eine offene Fläche wird mit Warnung exportiert statt abzubrechen. Aufruf: npm run test:meshexport.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checker, cleanup } from './harness.mjs';

const t = checker();
const { check } = t;

const PY = process.env.SOMA_PYTHON || path.join(process.env.LOCALAPPDATA ?? '', 'soma-dev', 'venv', 'Scripts', 'python.exe');
const ENV = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
const soma = (args) => spawnSync(PY, ['-m', 'soma', ...args], { encoding: 'utf8', env: ENV, windowsHide: true, timeout: 10 * 60 * 1000 });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-mesh-'));
const FORMATS = ['3mf', 'amf', 'stl', 'obj'];

const MODEL = String.raw`import math
import cadquery as cq
from soma import add_part
from soma.fasteners import Screw

add_part("Rounded box", cq.Workplane().box(40, 30, 20).edges().fillet(4))
add_part("Chamfered box", cq.Workplane().box(30, 20, 10).edges().chamfer(1.5))
add_part("Plate with holes", cq.Workplane().box(60, 40, 8).faces(">Z").workplane()
         .rarray(40, 20, 2, 2).cboreHole(4, 7, 3).faces(">Z").workplane().hole(10))
add_part("Cylinder", cq.Workplane().cylinder(30, 8))
add_part("Sphere", cq.Workplane().sphere(12))
add_part("Torus", cq.Workplane().add(cq.Solid.makeTorus(15, 4)))
add_part("Cone", cq.Workplane().add(cq.Solid.makeCone(10, 0, 20)))
add_part("Vase", cq.Workplane("XZ").moveTo(0, 0).lineTo(10, 0).spline([(14, 15), (8, 30), (11, 40)], includeCurrent=True)
         .lineTo(0, 40).close().revolve(360, (0, 0, 0), (0, 1, 0)))
add_part("Loft", cq.Workplane().rect(20, 20).workplane(offset=25).circle(8).loft())
helix = cq.Wire.makeHelix(pitch=6, height=24, radius=10)
spring = cq.Workplane("XZ").center(10, 0).circle(1.5).sweep(cq.Workplane().add(helix), isFrenet=True)
add_part("Spring", spring)
add_part("Text", cq.Workplane().text("SOMA 8", 12, 3))
add_part("Shell", cq.Workplane().box(30, 30, 20).edges("|Z").fillet(5).faces(">Z").shell(-1.5))
add_part("Pipe cross", cq.Workplane().cylinder(40, 5).union(cq.Workplane("YZ").cylinder(40, 5))
         .union(cq.Workplane().sphere(7)))
add_part("Two bodies", cq.Workplane().box(10, 10, 10).union(cq.Workplane().center(20, 0).box(10, 10, 10)))
add_part("Tiny", cq.Workplane().box(1, 1, 0.6).edges().fillet(0.2))
add_part("Large", cq.Workplane().box(800, 400, 60).edges("|Z").fillet(50).faces(">Z").workplane().hole(120))
add_part("Moved", cq.Workplane().box(20, 10, 5).edges().fillet(1).val().rotate((0, 0, 0), (1, 1, 0), 33).translate((100, -50, 25)))
add_part("Tapered", cq.Workplane().polygon(6, 20).extrude(15, taper=8).edges(">Z").fillet(1))
add_part("Screw", Screw("ISO 4762", "M5x20", at=(0, 0, 0)).shape)
`;

// Liest die Dateien selbst und vergleicht mit den Körpern aus dem Modell. Jede Prüfung als JSON-Zeile [Text, ok, Detail]
const CHECKS = String.raw`
import json, re, struct, sys, zipfile
from pathlib import Path
import numpy as np
from soma import build

root, out_dir, formats = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3].split(",")

def out(label, ok, detail=""):
    print(json.dumps([label, bool(ok), str(detail)[:120]]), flush=True)

def read_3mf(p):
    z = zipfile.ZipFile(p)
    names = set(z.namelist())
    assert {"[Content_Types].xml", "_rels/.rels", "3D/3dmodel.model"} <= names, names
    xml = z.read("3D/3dmodel.model").decode()
    assert 'unit="millimeter"' in xml and "<build>" in xml
    bodies = []
    for m in re.finditer(r"<mesh>(.*?)</mesh>", xml, re.S):
        V = [[float(a) for a in v] for v in re.findall(r'<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"', m.group(1))]
        T = [[int(a) for a in v] for v in re.findall(r'<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"', m.group(1))]
        bodies.append((np.array(V), np.array(T)))
    return bodies

def read_amf(p):
    xml = p.read_text(encoding="utf-8")
    V = np.array([[float(a) for a in v] for v in re.findall(r"<x>([^<]+)</x><y>([^<]+)</y><z>([^<]+)</z>", xml)])
    bodies = []
    for vol in re.findall(r"<volume>(.*?)</volume>", xml, re.S):
        T = np.array([[int(a) for a in v] for v in re.findall(r"<v1>(\d+)</v1><v2>(\d+)</v2><v3>(\d+)</v3>", vol)])
        used, inv = np.unique(T, return_inverse=True)
        bodies.append((V[used], inv.reshape(-1, 3)))
    return bodies

def read_obj(p):
    bodies, V, T = [], [], []
    base = 0
    for line in p.read_text(encoding="utf-8").splitlines():
        if line.startswith("o ") and V:
            bodies.append((np.array(V), np.array(T) - base)); base += len(V); V, T = [], []
        elif line.startswith("v "):
            V.append([float(a) for a in line.split()[1:]])
        elif line.startswith("f "):
            T.append([int(a.split("/")[0]) - 1 for a in line.split()[1:]])
    bodies.append((np.array(V), np.array(T) - base))
    return bodies

def read_stl(p):
    data = p.read_bytes()
    n = struct.unpack("<I", data[80:84])[0]
    assert len(data) == 84 + 50 * n, "length"
    rec = np.frombuffer(data[84:], dtype=np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")]))
    P = rec["v"].reshape(-1, 3).astype(np.float64)
    # STL hat keine Indizes: ueber die Koordinaten verbinden, wie es ein Slicer tut, dann in Koerper zerlegen
    V, inv = np.unique(P, axis=0, return_inverse=True)
    return split(V, inv.reshape(-1, 3))

def split(V, T):
    parent = np.arange(len(V))
    def f(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]; x = parent[x]
        return x
    for a, b, c in T:
        ra, rb, rc = f(a), f(b), f(c)
        parent[rb] = ra; parent[rc] = ra
    roots = np.array([f(a) for a in T[:, 0]])
    res = []
    for r in np.unique(roots):
        sub = T[roots == r]
        used, inv = np.unique(sub, return_inverse=True)
        res.append((V[used], inv.reshape(-1, 3)))
    return res

def analyse(V, T):
    d = np.concatenate([T[:, [0, 1]], T[:, [1, 2]], T[:, [2, 0]]])
    _, cnt = np.unique(np.sort(d, axis=1), axis=0, return_counts=True)
    _, dcnt = np.unique(d, axis=0, return_counts=True)
    degenerate = int(((T[:, 0] == T[:, 1]) | (T[:, 1] == T[:, 2]) | (T[:, 0] == T[:, 2])).sum())
    a, b, c = V[T[:, 0]], V[T[:, 1]], V[T[:, 2]]
    vol = float(np.einsum("ij,ij->i", a, np.cross(b, c)).sum() / 6)
    # Ecken, die nach Koordinaten doppelt vorkommen: gemeinsame Ecken fehlen
    dup = len(V) - len(np.unique(np.round(V, 4), axis=0))
    return dict(open=int((cnt == 1).sum()), nonmanifold=int((cnt > 2).sum()), flipped=int((dcnt > 1).sum()),
                degenerate=degenerate, volume=vol, dup=dup, lo=V.min(axis=0), hi=V.max(axis=0))

readers = {"3mf": read_3mf, "amf": read_amf, "obj": read_obj, "stl": read_stl}
parts = [p for p in build.run_model(root) if p["role"] not in ("reference", "hardware")]
for fmt in formats:
    bad = []
    for p in parts:
        shape = p["shape"]
        f = out_dir / f"{p['step_name']}.{fmt}"
        if not f.is_file():
            bad.append(f"{p['name']}: file missing"); continue
        try:
            bodies = readers[fmt](f)
        except Exception as e:
            bad.append(f"{p['name']}: unreadable {type(e).__name__} {e}"); continue
        solids = shape.Solids()
        tol = min(0.05, build.auto_tolerance([shape]))
        if len(bodies) != len(solids):
            bad.append(f"{p['name']}: {len(bodies)} meshes for {len(solids)} solids")
        a = [analyse(V, T) for V, T in bodies]
        for k in ("open", "nonmanifold", "flipped", "degenerate", "dup"):
            s = sum(x[k] for x in a)
            if s:
                bad.append(f"{p['name']}: {s} {k}")
        if any(x["volume"] <= 0 for x in a):
            bad.append(f"{p['name']}: mesh inside out (volume <= 0)")
        vol, cad = sum(x["volume"] for x in a), shape.Volume()
        # Sehnenfehler hoechstens tol: das Volumen weicht um hoechstens Oberflaeche mal tol ab
        if abs(vol - cad) > shape.Area() * tol + 1e-6:
            bad.append(f"{p['name']}: volume {vol:.3f} vs CAD {cad:.3f}")
        bb = shape.BoundingBox()
        lo = np.min([x["lo"] for x in a], axis=0); hi = np.max([x["hi"] for x in a], axis=0)
        # BoundingBox von OCC ist etwas groesser als die Geometrie, das Netz liegt innerhalb der Sehnentoleranz
        slack = 2 * tol + 0.01 + 1e-4 * max(bb.xlen, bb.ylen, bb.zlen)
        ref = np.array([bb.xmin, bb.ymin, bb.zmin, bb.xmax, bb.ymax, bb.zmax])
        if np.abs(np.concatenate([lo, hi]) - ref).max() > slack:
            bad.append(f"{p['name']}: bounding box {np.round(lo, 2)} {np.round(hi, 2)} vs {np.round(ref, 2)}")
    out(f"{fmt}: {len(parts)} parts closed, manifold, outward, volume and size as in CAD", not bad, "; ".join(bad))
`;

try {
  const proj = path.join(work, 'proj');
  fs.mkdirSync(proj);
  fs.writeFileSync(path.join(proj, 'model.py'), MODEL);
  const exp = path.join(work, 'out');
  for (const fmt of FORMATS) {
    const r = soma(['export', '--all', '--format', fmt, '--project', proj, '--out', exp]);
    const n = (r.stdout.match(/^exported: /gm) ?? []).length;
    check(`soma export --all --format ${fmt} ohne Warnung`, r.status === 0 && n >= 19 && !/warning/i.test(r.stdout + r.stderr), `${n} Dateien ${(r.stderr || r.stdout.split('\n').filter((l) => /warning/i.test(l)).join(' ')).slice(-200)}`);
  }
  const r = spawnSync(PY, ['-c', CHECKS, proj, exp, FORMATS.join(',')], { encoding: 'utf8', env: ENV, windowsHide: true, timeout: 10 * 60 * 1000 });
  const lines = r.stdout.split('\n').filter((l) => l.startsWith('['));
  check('Prüfskript läuft', r.status === 0 && lines.length === FORMATS.length, (r.stderr || '').slice(-300));
  for (const l of lines) { const [label, ok, detail] = JSON.parse(l); check(label, ok, detail); }

  // 3MF: ein Teil aus zwei Körpern bleibt ein Objekt (Komponenten), der Name des Teils steht drin
  const zipText = spawnSync(PY, ['-c', 'import sys, zipfile; print(zipfile.ZipFile(sys.argv[1]).read("3D/3dmodel.model").decode())', path.join(exp, 'Two_bodies.3mf')], { encoding: 'utf8', env: ENV });
  const items = (zipText.stdout.match(/<item /g) ?? []).length;
  check('3MF mit zwei Körpern: ein Objekt mit zwei Komponenten im Build', items === 1 && (zipText.stdout.match(/<component /g) ?? []).length === 2 && zipText.stdout.includes('name="Two bodies"'), `${items} items`);

  // Offene Fläche: Export klappt, die Warnung erklärt es (Bericht statt Reparatur, E28)
  const open = path.join(work, 'open');
  fs.mkdirSync(open);
  fs.writeFileSync(path.join(open, 'model.py'), 'import cadquery as cq\nfrom soma import add_part\nadd_part("Sheet", cq.Workplane().box(10, 10, 10).faces(">Z").val())\n');
  const o = soma(['export', 'Sheet', '--format', '3mf', '--project', open, '--out', path.join(work, 'out-open')]);
  check('Offene Fläche: exportiert mit Warnung zu offenen Kanten', o.status === 0 && /exported: /.test(o.stdout) && /warning: mesh of 'Sheet' is not closed: \d+ open edge/.test(o.stdout), (o.stdout + o.stderr).slice(-200));
} catch (e) {
  check('Ablauf ohne Ausnahme', false, String(e?.stack ?? e).slice(0, 300));
} finally {
  cleanup(work);
}
process.exit(t.fails ? 1 : 0);
