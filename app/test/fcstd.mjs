// Test of the FreeCAD import (python/soma/fcstd.py) without FreeCAD and without the app: the FCStd files are built in the
// test (ZIP with Document.xml, GuiDocument.xml and BREP files written by OCP), so no third-party files are needed. They
// cover a group, a boolean with its inputs, a PartDesign body with a visible tip in an App::Part with a placement, hidden
// objects and a hidden App::Part, links within the file (with and without LinkTransform) and to another file, broken,
// empty and missing shape files, a binary BREP, a non-ASCII label, wire and datum objects, a file without
// GuiDocument.xml and files that cannot be imported. Also consumers that do not hide their inputs (drawing, CAM job,
// hidden boolean), a link to a plain group, damaged ZIP members and a zip bomb. Then `soma fcstd info|convert`, import_assembly()/import_step() in
// `soma build`, and `soma glb` for the viewer. Python only. Run: node test/fcstd.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checker, cleanup } from './harness.mjs';

const t = checker();
// Details only for failures: the outputs are long
const check = (label, ok, detail = '') => t.check(label, ok, ok ? '' : detail);

const PY = process.env.SOMA_PYTHON || path.join(process.env.LOCALAPPDATA ?? '', 'soma-dev', 'venv', 'Scripts', 'python.exe');
const ENV = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
const py = (args, opts = {}) => spawnSync(PY, args, { encoding: 'utf8', env: ENV, windowsHide: true, timeout: 5 * 60 * 1000, ...opts });
const soma = (args, opts) => py(['-m', 'soma', ...args], opts);
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'soma-fcstd-'));

// Writes the test files into sys.argv[1]. Shapes are stored the way FreeCAD stores them: with the object's own
// Placement as location, a body with its placement on top of the tip; the App::Part placement is not in the shape.
const MAKE = String.raw`
import math, struct, sys, zipfile
from pathlib import Path
from xml.sax.saxutils import quoteattr
import cadquery as cq
from OCP.BinTools import BinTools
from OCP.BRepTools import BRepTools

out = Path(sys.argv[1])

def brep(shape, binary=False):
    p = out / "tmp.bin"
    (BinTools.Write_s if binary else BRepTools.Write_s)(shape.wrapped, str(p))
    data = p.read_bytes()
    p.unlink()
    return data

def pl(x=0, y=0, z=0, angle_deg=0):  # rotation about Z only, enough here
    a = math.radians(angle_deg) / 2
    return (f'<Property name="Placement" type="App::PropertyPlacement"><PropertyPlacement Px="{x}" Py="{y}" Pz="{z}" '
            f'Q0="0" Q1="0" Q2="{math.sin(a)}" Q3="{math.cos(a)}" A="{math.radians(angle_deg)}" Ox="0" Oy="0" Oz="1"/></Property>')

def loc(x=0, y=0, z=0, angle_deg=0):
    return cq.Location(cq.Vector(x, y, z), cq.Vector(0, 0, 1), angle_deg)

def label(v):
    return f'<Property name="Label" type="App::PropertyString"><String value={quoteattr(v)}/></Property>'

def links(name, names, kind="App::PropertyLinkList"):
    return f'<Property name="{name}" type="{kind}"><LinkList count="{len(names)}">' + "".join(f'<Link value="{n}"/>' for n in names) + '</LinkList></Property>'

def link(name, v):
    return f'<Property name="{name}" type="App::PropertyLink"><Link value="{v}"/></Property>'

def xlink(v, file=""):
    f = f' file="{file}" stamp="2024-01-01T00:00:00Z"' if file else ""
    return f'<Property name="LinkedObject" type="App::PropertyXLink"><XLink{f} name="{v}"/></Property>'

def boolp(name, v):
    return f'<Property name="{name}" type="App::PropertyBool"><Bool value="{"true" if v else "false"}"/></Property>'

def write(name, objects, gui=True):
    """objects: (name, type, label, props, shape bytes or None or "missing", visible, color, diffuse list)"""
    files = {}
    data = []
    for i, (n, typ, lab, props, shape, *_ ) in enumerate(objects):
        extra = ""
        if shape is not None:
            fname = f"PartShape{i}.{'bin' if isinstance(shape, tuple) else 'brp'}"
            if shape != "missing":
                files[fname] = shape[0] if isinstance(shape, tuple) else shape
            extra = f'<Property name="Shape" type="Part::PropertyPartShape"><Part file="{fname}"/></Property>'
        data.append(f'<Object name="{n}"><Properties>{label(lab)}{props}{extra}</Properties></Object>')
    doc = ('<?xml version="1.0" encoding="utf-8"?><Document SchemaVersion="4" ProgramVersion="0.21.2" FileVersion="1">'
           '<Objects>' + "".join(f'<Object type="{o[1]}" name="{o[0]}"/>' for o in objects) + '</Objects>'
           '<ObjectData>' + "".join(data) + '</ObjectData></Document>')
    vps = []
    for n, typ, lab, props, shape, vis, color, diffuse in objects:
        p = f'<Property name="Visibility" type="App::PropertyBool"><Bool value="{"true" if vis else "false"}"/></Property>'
        if color:
            r, g, b = color
            p += f'<Property name="ShapeColor" type="App::PropertyColor"><PropertyColor value="{(r << 24) | (g << 16) | (b << 8)}"/></Property>'
        if diffuse:
            files[f"DiffuseColor_{n}"] = struct.pack(f"<I{len(diffuse)}I", len(diffuse), *[(r << 24) | (g << 16) | (b << 8) for r, g, b in diffuse])
            p += f'<Property name="DiffuseColor" type="App::PropertyColorList"><ColorList file="DiffuseColor_{n}"/></Property>'
        vps.append(f'<ViewProvider name="{n}"><Properties>{p}</Properties></ViewProvider>')
    with zipfile.ZipFile(out / name, "w") as z:
        z.writestr("Document.xml", doc)
        if gui:
            z.writestr("GuiDocument.xml", '<?xml version="1.0" encoding="utf-8"?><Document SchemaVersion="1"><ViewProviderData>'
                       + "".join(vps) + '</ViewProviderData></Document>')
        for f, b in files.items():
            z.writestr(f, b)

box = lambda x, y, z: cq.Solid.makeBox(x, y, z)
tip_local = box(30, 10, 8)
O = lambda n, typ, lab, props="", shape=None, vis=True, color=None, diffuse=None: (n, typ, lab, props, shape, vis, color, diffuse)
write("parts.FCStd", [
    O("Group", "App::DocumentObjectGroup", "Group A", links("Group", ["Plate"])),
    O("Plate", "Part::Box", "Plate", pl(), brep(box(40, 20, 5)), color=(255, 0, 0)),
    O("BoxA", "Part::Box", "BoxA", pl(), brep(box(10, 10, 10)), vis=False),
    O("Cyl", "Part::Cylinder", "Cyl", pl(), brep(cq.Solid.makeCylinder(2, 20))),  # visible input: left out with a note
    O("Cut", "Part::Cut", "Cut", pl(200) + link("Base", "BoxA") + link("Tool", "Cyl"),
      brep(box(10, 10, 10).cut(cq.Solid.makeCylinder(2, 20)).moved(loc(200)))),
    O("Assembly", "App::Part", "Assembly", pl(100, 0, 0, 90) + links("Group", ["Body"])),
    O("Body", "PartDesign::Body", "Bracket", pl(0, 0, 5) + links("Group", ["Sketch", "Pad", "Pad001"]) + link("Tip", "Pad001"),
      brep(tip_local.moved(loc(0, 0, 5))), diffuse=[(0, 255, 0), (0, 255, 0), (0, 0, 255)]),
    O("Sketch", "Sketcher::SketchObject", "Sketch", pl(), brep(cq.Wire.makePolygon([(0, 0, 0), (30, 0, 0), (30, 10, 0)], close=True))),
    O("Pad", "PartDesign::Pad", "Pad", pl(), brep(box(30, 10, 4)), vis=False),
    O("Pad001", "PartDesign::Pad", "Pad001", pl() + link("BaseFeature", "Pad"), brep(tip_local)),  # visible tip: no duplicate
    O("HiddenBox", "Part::Box", "Hidden box", pl(), brep(box(1, 1, 1)), vis=False),
    O("HiddenPart", "App::Part", "Hidden part", pl() + links("Group", ["Inner"]), vis=False),
    O("Inner", "Part::Box", "Inner box", pl(), brep(box(2, 2, 2))),
    O("Link", "App::Link", "Bracket link", pl(0, 50, 0) + xlink("Body") + boolp("LinkTransform", False)),
    O("Link001", "App::Link", "Assembly link", pl(0, -100, 0) + xlink("Assembly") + boolp("LinkTransform", True)),
    O("Link002", "App::Link", "Foreign link", pl() + xlink("Body", "other.FCStd")),
    O("Broken", "Part::Feature", "Broken", pl(), b"CASCADE Topology V3, (c) Open Cascade\nLocations 0\nnonsense\n"),
    O("Empty", "Part::Feature", "Empty", pl(), b""),
    O("Missing", "Part::Feature", "Missing", pl(), "missing"),
    O("Housing", "Part::Feature", "Gehäuse ×2", pl(0, -50, 0), (brep(box(5, 5, 5).moved(loc(0, -50, 0)), binary=True),)),
    O("Wire", "Part::Feature", "Wire", pl(), brep(cq.Edge.makeLine(cq.Vector(0, 0, 0), cq.Vector(5, 0, 0)))),
    O("Datum", "PartDesign::Plane", "Datum plane", pl(), brep(cq.Face.makePlane(10, 10))),
])

# Without GuiDocument.xml, visibility in Document.xml as in newer files; the boolean still hides its inputs
write("novis.FCStd", [
    O("Box1", "Part::Box", "Box1", pl() + boolp("Visibility", True), brep(box(1, 1, 1))),
    O("Box2", "Part::Box", "Box2", pl(10) + boolp("Visibility", False), brep(box(1, 1, 1).moved(loc(10)))),
    O("Box3", "Part::Box", "Box3", pl(20), brep(box(2, 2, 2).moved(loc(20)))),
    O("Box4", "Part::Box", "Box4", pl(21), brep(box(2, 2, 2).moved(loc(21)))),
    O("Fusion", "Part::MultiFuse", "Fusion", pl() + links("Shapes", ["Box3", "Box4"]),
      brep(box(2, 2, 2).moved(loc(20)).fuse(box(2, 2, 2).moved(loc(21))))),
], gui=False)

write("nogeo.FCStd", [
    O("Sketch", "Sketcher::SketchObject", "Sketch", pl(), brep(cq.Wire.makePolygon([(0, 0, 0), (1, 0, 0), (1, 1, 0)], close=True))),
    O("Broken", "Part::Feature", "Broken", pl(), b"garbage"),
])
(out / "notzip.FCStd").write_text("hello")

# Consumers that do not show their inputs: a drawing view and a CAM job refer to a body, a hidden Cut uses two boxes.
# A hidden Cut2 inside a visible Fusion: its inputs are in the Fusion, so they stay out
write("consumers.FCStd", [
    O("Bracket", "Part::Box", "Bracket", pl(), brep(box(10, 10, 10))),
    O("View", "TechDraw::DrawViewPart", "View", links("Source", ["Bracket"])),
    O("Job", "Path::FeaturePython", "Job", link("Base", "Bracket")),
    O("A", "Part::Box", "A", pl(), brep(box(1, 1, 1))),
    O("B", "Part::Box", "B", pl(), brep(box(1, 1, 1))),
    O("Cut", "Part::Cut", "Cut", pl() + link("Base", "A") + link("Tool", "B"), brep(box(1, 1, 1)), vis=False),
    O("C", "Part::Box", "C", pl(), brep(box(2, 2, 2))),
    O("D", "Part::Box", "D", pl(), brep(box(2, 2, 2))),
    O("Cut2", "Part::Cut", "Cut2", pl() + link("Base", "C") + link("Tool", "D"), brep(box(2, 2, 2)), vis=False),
    O("Fusion", "Part::MultiFuse", "Fusion", pl() + links("Shapes", ["Cut2"]), brep(box(2, 2, 2))),
])
# A link (without LinkTransform) to a plain group, which has no placement: the link's placement moves its content
write("linkgroup.FCStd", [
    O("Grp", "App::DocumentObjectGroup", "Grp", links("Group", ["Box"]), vis=False),
    O("Box", "Part::Box", "Box", pl(), brep(box(10, 10, 10))),
    O("Link", "App::Link", "Lnk", pl(0, 50, 0) + xlink("Grp") + boolp("LinkTransform", False)),
])
write("meshonly.FCStd", [O("Mesh", "Mesh::Feature", "Scan")])

# Damaged ZIP members: deflate data of one member garbled
import zlib
def deflated(name, members):
    with zipfile.ZipFile(out / name, "w", zipfile.ZIP_DEFLATED) as z:
        for k, v in members.items():
            z.writestr(k, v)

def garble(name, member):
    f = out / name
    with zipfile.ZipFile(f) as z:
        info = z.getinfo(member)
    b = bytearray(f.read_bytes())
    start = info.header_offset + 30 + len(member.encode()) + len(info.extra)
    for k in range(start + 2, start + min(info.compress_size - 2, 40)):
        b[k] ^= 0x5A
    f.write_bytes(bytes(b))

def simple_doc(objs, extra=""):
    return ('<?xml version="1.0" encoding="utf-8"?><Document SchemaVersion="4" ProgramVersion="0.21.2" FileVersion="1"><Objects>'
            + "".join(f'<Object type="Part::Box" name="{n}"/>' for n in objs) + '</Objects><ObjectData>'
            + "".join(f'<Object name="{n}"><Properties>{label(n)}<Property name="Shape" type="Part::PropertyPartShape"><Part file="{n}.brp"/></Property></Properties></Object>' for n in objs)
            + '</ObjectData></Document>' + extra)

big_gui = ('<Document SchemaVersion="1"><ViewProviderData>' + "".join(f'<ViewProvider name="V{i}"><Properties></Properties></ViewProvider>' for i in range(200))
           + '</ViewProviderData></Document>')
cube = brep(box(3, 3, 3))
deflated("badshape.FCStd", {"Document.xml": simple_doc(["Good", "Bad"]), "Good.brp": cube, "Bad.brp": cube})
garble("badshape.FCStd", "Bad.brp")
deflated("badgui.FCStd", {"Document.xml": simple_doc(["Good"]), "GuiDocument.xml": big_gui, "Good.brp": cube})
garble("badgui.FCStd", "GuiDocument.xml")
deflated("baddoc.FCStd", {"Document.xml": simple_doc(["Good"] * 1) + " " * 4000, "Good.brp": cube})
garble("baddoc.FCStd", "Document.xml")
# Zip bomb: a Document.xml that unpacks to more than 200 MB (a few hundred KB packed)
deflated("xmlbomb.FCStd", {"Document.xml": simple_doc(["Good"], " " * (201 * 2**20)), "Good.brp": cube})
print("ok")
`;

// Reads the files with soma.fcstd and prints one JSON line per check: [label, ok, detail]
const CHECKS = String.raw`
import json, sys
from pathlib import Path
from soma import fcstd

d = Path(sys.argv[1])

def out(label, ok, detail=""):
    print(json.dumps([label, bool(ok), str(detail)[:300]]), flush=True)

def box(p):
    b = p.shape.BoundingBox()
    return [round(v, 3) + 0.0 for v in (b.xmin, b.ymin, b.zmin, b.xmax, b.ymax, b.zmax)]

res = fcstd.read(d / "parts.FCStd")
by = {(p.group, p.name): p for p in res.parts}
names = sorted("/".join(p.group + (p.name,)) for p in res.parts)
expected = sorted(["Group A/Plate", "Cut", "Assembly/Bracket", "Bracket link", "Assembly link/Bracket", "Gehäuse ×2"])
out("Six parts: visible objects, body once, links resolved", names == expected, names)
out("Group: plate in its group with color from ShapeColor", by.get((("Group A",), "Plate")) and box(by[(("Group A",), "Plate")]) == [0, 0, 0, 40, 20, 5]
    and by[(("Group A",), "Plate")].color == (1.0, 0.0, 0.0, 1.0), by.get((("Group A",), "Plate")) and by[(("Group A",), "Plate")].color)
out("Boolean: result at its placement, inputs left out", box(by[((), "Cut")]) == [200, 0, 0, 210, 10, 10], box(by[((), "Cut")]))
out("Visible input of the boolean: note, not imported", any("'Cyl' is visible but used by 'Cut'" in n for n in res.notes), res.notes)
b = by[(("Assembly",), "Bracket")]
out("Body in App::Part: container placement applied (rotated, moved)", box(b) == [90, 0, 5, 100, 30, 13], box(b))
out("Body color: most frequent of the face colors", b.color == (0.0, 1.0, 0.0, 1.0), b.color)
out("Body: tip and features are not parts of their own", not any(p.source in ("Pad", "Pad001", "Sketch") for p in res.parts))
out("Link without LinkTransform: link placement replaces the body's", box(by[((), "Bracket link")]) == [0, 50, 0, 30, 60, 8], box(by[((), "Bracket link")]))
out("Link with LinkTransform to an App::Part: group named like the link", box(by[(("Assembly link",), "Bracket")]) == [90, -100, 5, 100, -70, 13], box(by[(("Assembly link",), "Bracket")]))
out("Link into another file: warning", any("'Foreign link' links to 'Body' in another file (other.FCStd)" in w for w in res.warnings), res.warnings)
out("Hidden object and hidden App::Part: not imported", not any(p.name in ("Hidden box", "Inner box") for p in res.parts))
out("Broken BREP: warning with the reason", any(w.startswith("'Broken' not imported: its shape file") and "cannot be read" in w for w in res.warnings), res.warnings)
out("Empty shape: warning", any(w.startswith("'Empty' has no stored geometry") for w in res.warnings), res.warnings)
out("Missing shape file: warning", any("'Missing' not imported: its shape file PartShape18.brp is missing" in w for w in res.warnings), res.warnings)
out("Exactly four warnings", len(res.warnings) == 4, res.warnings)
out("Binary BREP and non-ASCII label read", box(by[((), "Gehäuse ×2")]) == [0, -50, 0, 5, -45, 5], box(by[((), "Gehäuse ×2")]))
out("Wire without faces: note, datum plane silently left out", any("'Wire' has no faces" in n for n in res.notes) and not any(p.name == "Datum plane" for p in res.parts), res.notes)
out("FreeCAD version from the file", res.program == "0.21.2", res.program)

asm = fcstd.to_assembly(res)
leaves = sorted(n for n, a in asm.traverse() if a.obj is not None)
out("Assembly: six leaves with unique names", len(leaves) == 6 and "Bracket (2)" in leaves, leaves)
groups = sorted(a.name for a in asm.children if a.obj is None)
out("Assembly: containers as sub-assemblies", groups == ["Assembly", "Assembly link", "Group A"], groups)

nv = fcstd.read(d / "novis.FCStd")
out("Without GuiDocument.xml: visibility from Document.xml, inputs of the boolean left out", sorted(p.name for p in nv.parts) == ["Box1", "Fusion"], [p.name for p in nv.parts])
out("Without GuiDocument.xml: no colors", all(p.color is None for p in nv.parts))
single = fcstd.to_assembly(fcstd.Result(parts=[nv.parts[0]]))
out("One part: assembly with one leaf", len([a for _, a in single.traverse() if a.obj is not None]) == 1)

for f, want in (("nogeo.FCStd", "The FreeCAD file contains no usable geometry: 'Broken' not imported"), ("notzip.FCStd", "The file is not a FreeCAD file (not a ZIP archive"),
                ("absent.FCStd", "FreeCAD file not found")):
    try:
        fcstd.read(d / f)
        out(f"{f}: error", False, "no error")
    except fcstd.FcstdError as e:
        out(f"{f}: clear error", want in str(e), str(e))

cs = fcstd.read(d / "consumers.FCStd")
cn = sorted(p.name for p in cs.parts)
out("Drawing view and CAM job do not hide the body they refer to", "Bracket" in cn, cn)
out("Inputs of a hidden Cut stay, inputs of a hidden Cut inside a visible Fusion do not", cn == ["A", "B", "Bracket", "Fusion"], cn)
lg = fcstd.read(d / "linkgroup.FCStd")
lb = {p.group: box(p) for p in lg.parts}
out("Link without LinkTransform to a plain group: link placement applied", lb.get(("Lnk",)) == [0, 50, 0, 10, 60, 10] and lb.get(("Grp",)) == [0, 0, 0, 10, 10, 10], lb)
bs = fcstd.read(d / "badshape.FCStd")
out("Damaged shape member: warning naming the object, the rest imported", [p.name for p in bs.parts] == ["Good"]
    and any(w.startswith("'Bad' not imported: its shape file Bad.brp cannot be unpacked") for w in bs.warnings), bs.warnings)
bg = fcstd.read(d / "badgui.FCStd")
out("Damaged GuiDocument.xml: parts imported, warning about colors and visibility", [p.name for p in bg.parts] == ["Good"]
    and any("view data in the FreeCAD file is damaged" in w and "all objects count as visible" in w for w in bg.warnings), bg.warnings)
for f, want in (("baddoc.FCStd", "The document in the FreeCAD file is damaged (Document.xml: damaged compressed data"),
                ("xmlbomb.FCStd", "would unpack to 201 MB, more than the 200 MB"),
                ("meshonly.FCStd", "contains no usable geometry: 'Scan' is a mesh (Mesh::Feature), not imported"),
                ("nogeo.FCStd", "'Sketch' is a sketch")):
    try:
        fcstd.read(d / f)
        out(f"{f}: error", False, "no error")
    except fcstd.FcstdError as e:
        out(f"{f}: clear error", want in str(e), str(e))
    except Exception as e:  # noqa: BLE001
        out(f"{f}: clear error", False, f"{type(e).__name__}: {e}")
old = fcstd.MAX_SHAPES
fcstd.MAX_SHAPES = 100  # the real limit (2 GB) would need a 2 GB test file
try:
    fcstd.read(d / "badshape.FCStd")
    out("Shape files over the limit: error", False, "no error")
except fcstd.FcstdError as e:
    out("Shape files over the limit: clear error", "shape files in the FreeCAD file would unpack to" in str(e), str(e))
finally:
    fcstd.MAX_SHAPES = old
`;

try {
  const mk = py(['-c', MAKE, work]);
  check('Test files written', mk.status === 0 && mk.stdout.trim() === 'ok', (mk.stdout + mk.stderr).slice(-400));

  const r = py(['-c', CHECKS, work]);
  const lines = r.stdout.split(/\r?\n/).filter((l) => l.startsWith('['));
  for (const l of lines) { const [label, ok, detail] = JSON.parse(l); check(label, ok, ok ? '' : detail); }
  check('Checks ran to the end', r.status === 0 && lines.length >= 36,`${lines.length} checks, ${r.stderr.slice(-400)}`);

  // CLI: info as JSON (the OCCT message about the broken BREP must not end up in stdout), convert, no silent overwrite
  const parts = path.join(work, 'parts.FCStd');
  const info = soma(['fcstd', 'info', parts, '--json']);
  let j = null;
  try { j = JSON.parse(info.stdout); } catch { /* checked below */ }
  check('soma fcstd info --json: clean JSON with six parts and four warnings', info.status === 0 && j?.parts?.length === 6 && j.warnings.length === 4, (info.stdout + info.stderr).slice(-300));
  const plain = soma(['fcstd', 'info', parts]);
  check('soma fcstd info: lists parts with group and size, warnings', plain.status === 0 && /^parts\.FCStd: 6 part\(s\)/m.test(plain.stdout)
    && plain.stdout.includes('Assembly/Bracket  (PartDesign::Body, 10.0 x 30.0 x 8.0 mm') && /^Warning: 'Broken' not imported/m.test(plain.stdout), plain.stdout.slice(-600));
  const conv = soma(['fcstd', 'convert', parts]);
  const step = path.join(work, 'parts.step');
  check('soma fcstd convert: STEP next to the file', conv.status === 0 && fs.existsSync(step) && /written: .*parts\.step/.test(conv.stdout), (conv.stdout + conv.stderr).slice(-300));
  const before = fs.statSync(step).mtimeMs;
  const again = soma(['fcstd', 'convert', parts]);
  check('Existing STEP file: refused without --overwrite, file untouched', again.status === 1 && /already exists.*--overwrite/.test(again.stderr) && fs.statSync(step).mtimeMs === before, again.stderr.slice(-300));
  const over = soma(['fcstd', 'convert', parts, '--overwrite']);
  check('--overwrite replaces it', over.status === 0 && /written: /.test(over.stdout), (over.stdout + over.stderr).slice(-300));
  const wrongExt = soma(['fcstd', 'convert', parts, '--out', path.join(work, 'x.stl')]);
  check('--out must be STEP', wrongExt.status === 2 && /must be a \.step or \.stp file/.test(wrongExt.stderr), wrongExt.stderr.slice(-200));
  const jsonOf = (r) => { try { return JSON.parse(r.stdout); } catch { return null; } };
  const againJ = soma(['fcstd', 'convert', parts, '--json']);
  check('--json: existing STEP file as status error JSON', againJ.status === 1 && jsonOf(againJ)?.status === 'error' && /already exists/.test(jsonOf(againJ)?.error), (againJ.stdout + againJ.stderr).slice(-300));
  const wrongJ = soma(['fcstd', 'convert', parts, '--out', path.join(work, 'x.stl'), '--json']);
  check('--json: --out must be STEP as status error JSON', wrongJ.status === 2 && jsonOf(wrongJ)?.status === 'error' && /must be a \.step/.test(jsonOf(wrongJ)?.error), (wrongJ.stdout + wrongJ.stderr).slice(-300));
  const bad = soma(['fcstd', 'convert', path.join(work, 'nogeo.FCStd')]);
  check('No geometry: error, no file written', bad.status === 1 && /^nogeo\.FCStd: The FreeCAD file contains no usable geometry/.test(bad.stderr) && !fs.existsSync(path.join(work, 'nogeo.step')), bad.stderr.slice(-300));
  const back = py(['-c', String.raw`
import json, sys
import cadquery as cq
from soma import stepimport
asm = stepimport.read_assembly(sys.argv[1])
leaves = sorted(n for n, a in asm.traverse() if a.obj is not None)
colors = {n: a.color.toTuple()[:3] for n, a in asm.traverse() if a.obj is not None and a.color is not None}
print(json.dumps(dict(leaves=leaves, plate=[round(c, 2) for c in colors.get("Plate", ())], ascii=all(n.isascii() for n in leaves))))
`, step]);
  let b = null;
  try { b = JSON.parse(back.stdout); } catch { /* checked below */ }
  check('STEP read back: six parts, ASCII names, colors', b?.leaves?.length === 6 && b.ascii && b.leaves.includes('Gehaeuse_x2') && JSON.stringify(b.plate) === '[1,0,0]', (back.stdout + back.stderr).slice(-300));

  // In model.py like a STEP file: import_assembly with groups and names, import_step as one shape, warnings in the build
  const proj = path.join(work, 'proj');
  fs.mkdirSync(path.join(proj, 'inputs'), { recursive: true });
  fs.copyFileSync(parts, path.join(proj, 'inputs', 'bracket.FCStd'));
  fs.writeFileSync(path.join(proj, 'model.py'), [
    'from soma import add_part, import_assembly, import_step',
    'add_part("FreeCAD", import_assembly("inputs/bracket.FCStd"))',
    'add_part("Merged", import_step("inputs/bracket.FCStd").translate((0, 0, 100)), role="reference")',
    '',
  ].join('\n'));
  const bld = soma(['build', '--project', proj, '--json']);
  let res = null;
  try { res = JSON.parse(bld.stdout); } catch { /* checked below */ }
  check('soma build with import_assembly/import_step of an FCStd: ok, seven parts', res?.status === 'ok' && res.parts.length === 7, (bld.stdout + bld.stderr).slice(-400));
  check('Build warnings name the file and the broken objects (once each)', res && res.warnings.filter((w) => w.startsWith('inputs/bracket.FCStd: ')).length === 4,
    JSON.stringify(res?.warnings).slice(0, 400));
  let map = null;
  try { map = JSON.parse(fs.readFileSync(path.join(proj, '.soma', 'model.map.json'), 'utf8')); } catch { /* checked below */ }
  const g = Object.fromEntries((map?.parts ?? []).map((p) => [p.name, p.group]));
  check('Groups under the add_part name, display names kept', g.Plate === 'FreeCAD/Group A' && g['Gehäuse ×2'] === 'FreeCAD' && g['Bracket (2)'] === 'FreeCAD/Assembly link' && g.Merged === null,
    JSON.stringify(g));

  // Viewer: soma glb converts an FCStd from the project like a STEP file
  const glbDir = path.join(work, 'glb');
  const glb = soma(['glb', parts, '--out', glbDir, '--name', 'parts', '--json']);
  let gm = null;
  try { gm = JSON.parse(fs.readFileSync(path.join(glbDir, 'model.map.json'), 'utf8')); } catch { /* checked below */ }
  check('soma glb with an FCStd: six parts with groups for the viewer', glb.status === 0 && gm?.parts?.length === 6 && fs.existsSync(path.join(glbDir, 'model.glb'))
    && gm.parts.some((p) => p.name === 'Plate' && p.group === 'Group A'), (glb.stdout + glb.stderr).slice(-300));
  // The viewer toasts the notes of model.map.json, also for a cached preview
  const gj = jsonOf(glb);
  check('soma glb with an FCStd: the four warnings in the JSON result and as notes in model.map.json', gj?.warnings?.length === 4 && gm?.notes?.length === 4
    && gm.notes.some((n) => n.startsWith("'Broken' not imported")), (glb.stdout + JSON.stringify(gm?.notes)).slice(-400));
  const glbBad = soma(['glb', path.join(work, 'nogeo.FCStd'), '--out', path.join(work, 'glb-bad')]);
  check('soma glb with an FCStd without geometry: clear error', glbBad.status === 1 && /contains no usable geometry/.test(glbBad.stderr), glbBad.stderr.slice(-300));
} catch (e) {
  check('Run without exception', false, String(e?.stack ?? e).slice(0, 300));
} finally {
  cleanup(work);
}
process.exit(t.fails ? 1 : 0);
