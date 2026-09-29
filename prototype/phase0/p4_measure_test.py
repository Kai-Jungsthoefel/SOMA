"""Phase 0, Punkt 4: Import einer mitgebrachten STEP, Messen, Aussparung, Anzeige als Referenz.
Prueft ausserdem, dass die Flaechen-/Kanten-IDs aus dem GLB auf die richtigen OCC-Flaechen zeigen
(Voraussetzung dafuer, dass der Python-Dienst 'Flaeche f7' exakt vermessen kann)."""
import json, struct, sys
from pathlib import Path
import cadide_proto
from xcaf_tools import dump_step_tree

P = Path("example")
r = cadide_proto.build(P)
S = r["shapes"]
fails = 0
def check(label, ok, detail=""):
    global fails
    print(("OK     " if ok else "FEHLER ") + label.ljust(58) + detail)
    fails += 0 if ok else 1

# 1) Import: Ursprung in der Ecke -> Bounding-Box der Original-STEP
import cadquery as cq
orig = cq.importers.importStep(str(P / "inputs/board.step")).val().BoundingBox()
check("Original-STEP: Laenge/Breite (USB ragt 1.5 mm ueber)", abs(orig.xlen - 53.0) < 1e-3 and abs(orig.ylen - 28.0) < 1e-3,
      f"x={orig.xlen:.3f} y={orig.ylen:.3f} z={orig.zlen:.3f}")

# 2) Abstaende Gehaeuse <-> Platine (exakt, OCC)
board, base, lid = S["Platine"], S["Boden"], S["Deckel"]
d_base = base.distance(board); d_lid = lid.distance(board)
check("Abstand Boden-Platine = Luft 0.3 mm (Aussparung)", abs(d_base - 0.3) < 1e-6, f"{d_base:.6f} mm")
check("Abstand Deckel-Platine = 16 - 13.6 = 2.4 mm", abs(d_lid - 2.4) < 1e-6, f"{d_lid:.6f} mm")
check("Platine kollidiert nicht mit Boden (Schnittvolumen 0)", base.intersect(board).Volume() < 1e-9)

# 3) Flaechen-IDs aus dem GLB -> OCC-Flaechen: gleiche Flaeche? (Flaeche, Schwerpunkt)
glb = Path(P / ".cadide/model.glb").read_bytes()
jlen = struct.unpack_from("<I", glb, 12)[0]
gltf = json.loads(glb[20:20 + jlen])
bad = 0; n = 0
for node in gltf["nodes"][1:]:
    meta = node["extras"]["cadide"]; sh = S[meta["name"]]
    faces = sh.Faces(); edges = sh.Edges()
    for f in meta["faces"]:
        n += 1
        of = faces[f["id"]]; c = of.Center()
        if abs(of.Area() - f["area"]) > 1e-3 or max(abs(c.x - f["center"][0]), abs(c.y - f["center"][1]), abs(c.z - f["center"][2])) > 1e-3:
            bad += 1
    for e in meta["edges"]:
        n += 1
        if abs(edges[e["id"]].Length() - e["length"]) > 1e-3: bad += 1
check(f"GLB-IDs zeigen auf die richtigen OCC-Flaechen/Kanten ({n} geprueft)", bad == 0, f"{bad} Abweichungen")

# 4) Exaktes Messen ueber IDs: Montageloch-Radius und Flaechenabstand
meta_of = lambda name: [n["extras"]["cadide"] for n in gltf["nodes"][1:] if n["extras"]["cadide"]["name"] == name][0]
node = meta_of("Platine")
circles = [e for e in node["edges"] if e["curve"] == "CIRCLE"]
radii = sorted({round(board.Edges()[e["id"]].radius(), 3) for e in circles})
check("Montagelocher der Platine: Radius 1.4 mm aus Kanten-IDs", 1.4 in radii, f"Radien {radii}")
top = max((f for f in node["faces"] if f["surface"] == "PLANE"), key=lambda f: f["center"][2])
floor_id = [f for f in meta_of("Boden")["faces"] if f["surface"] == "PLANE" and abs(f["center"][2] - 2.0) < 1e-6][0]
d_faces = board.Faces()[top["id"]].distance(base.Faces()[floor_id["id"]])
check("Abstand Platinen-Oberseite (Bauteilhoehe) zur Bodenflaeche", d_faces > 0, f"{d_faces:.3f} mm (Flaechen-IDs f{top['id']} und f{floor_id['id']})")

# 5) Referenz: eigener Ast im STEP, transparent im GLB
tree = dump_step_tree(P / "output/model.step")
pl = [t for t in tree if t["name"] == "Platine"][0]
check("STEP: Platine liegt im Ast 'Referenz', Alpha 0.45", pl["depth"] == 2 and pl["color"] and abs(pl["color"][3] - 0.45) < 1e-3, str(pl["color"]))
mat = [m for m in gltf["materials"] if m.get("name") == "5:Platine"][0]
check("GLB: Referenz-Material transparent (BLEND)", mat.get("alphaMode") == "BLEND", str(mat["pbrMetallicRoughness"]["baseColorFactor"]))
print("ERGEBNIS:", "BESTANDEN" if not fails else f"{fails} Fehler")
sys.exit(1 if fails else 0)
