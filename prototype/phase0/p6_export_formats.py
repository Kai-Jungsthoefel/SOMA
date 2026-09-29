"""Phase 0, Punkt 6: Einzelexport je registriertem Bauteil in verschiedene Formate (Grundlage fuer `cadide export`)."""
import os, sys, tempfile, time, zipfile
from pathlib import Path
import cadquery as cq
import cadide_proto

# Format -> (cq-Exporttyp / eigene Funktion, Art)
def export_part(shape, fmt, path):
    fmt = fmt.lower()
    if fmt in ("step", "stl", "amf", "vrml", "3mf", "brep"):
        cq.exporters.export(cq.Workplane("XY").add(shape), str(path), exportType={"step": "STEP", "stl": "STL", "amf": "AMF",
                            "vrml": "VRML", "3mf": "3MF", "brep": "BREP"}[fmt])
    elif fmt in ("glb", "gltf"):
        a = cq.Assembly(name="root"); a.add(shape, name="part"); a.export(str(path))
    elif fmt == "dxf":      # 2D: Schnitt in Bauteilmitte
        bb = shape.BoundingBox()
        cq.exporters.exportDXF(cq.Workplane("XY").add(shape).section(bb.center.z), str(path))
    elif fmt == "svg":      # 2D: Projektion
        cq.exporters.export(cq.Workplane("XY").add(shape), str(path), exportType="SVG")
    elif fmt == "iges":     # nicht in CadQuery, direkt ueber OCP
        from OCP.IGESControl import IGESControl_Writer
        w = IGESControl_Writer(); w.AddShape(shape.wrapped); w.ComputeModel()
        if not w.Write(str(path)): raise RuntimeError("IGES-Schreiben fehlgeschlagen")
    elif fmt == "obj":      # nicht in CadQuery, aus unserem Mesh
        import mesher
        m = mesher.mesh_shape(shape)
        lines = [f"v {v[0]:.5f} {v[1]:.5f} {v[2]:.5f}" for v in m["positions"]]
        lines += [f"vn {n[0]:.4f} {n[1]:.4f} {n[2]:.4f}" for n in m["normals"]]
        lines += [f"f {a}//{a} {b}//{b} {c}//{c}" for a, b, c in m["indices"] + 1]
        Path(path).write_text("\n".join(lines) + "\n")
    else:
        raise ValueError(f"Format nicht unterstuetzt: {fmt}")

FORMATS = ["step", "stl", "3mf", "amf", "brep", "vrml", "glb", "gltf", "dxf", "svg", "iges", "obj", "ply", "x_t"]
r = cadide_proto.build("example")
tmp = Path(tempfile.mkdtemp(prefix="p6_"))
res = {}
for fmt in FORMATS:
    ok = 0; err = None; sizes = []
    t = time.perf_counter()
    for name, shp in r["shapes"].items():
        p = tmp / f"{cadide_proto.ascii_name(name)}.{fmt}"
        try:
            export_part(shp, fmt, p); sizes.append(p.stat().st_size); ok += 1
        except Exception as e:
            err = f"{type(e).__name__}: {str(e)[:60]}"
    res[fmt] = (ok, len(r["shapes"]), err, round(time.perf_counter() - t, 2), sum(sizes))
for fmt, (ok, n, err, secs, size) in res.items():
    print(f"{fmt:6s} {ok}/{n}  {secs:5.2f}s  {size/1024:8.1f} KB  {'' if ok == n else err}")

# Stichproben der Ergebnisse: STL-Dreiecke, 3MF ist ZIP mit Modell, STEP-Reimport-Volumen stimmt
import re
stl = (tmp / "Deckel.stl").read_bytes()
tris = len(re.findall(rb"facet normal", stl)) if stl[:5] == b"solid" else int.from_bytes(stl[80:84], "little")
print("Stichprobe STL Deckel: Dreiecke =", tris)
print("Stichprobe 3MF ist gueltiges ZIP:", zipfile.is_zipfile(tmp / "Deckel.3mf"), zipfile.ZipFile(tmp / "Deckel.3mf").namelist()[:3])
v0 = r["shapes"]["Deckel"].Volume(); v1 = cq.importers.importStep(str(tmp / "Deckel.step")).val().Volume()
print(f"Stichprobe STEP-Reimport Volumen: {v0:.3f} -> {v1:.3f}", "OK" if abs(v0 - v1) < 1e-3 else "ABWEICHUNG")

# IGES-Reimport ueber OCP: Volumen gleich?
from OCP.IGESControl import IGESControl_Reader
from OCP.GProp import GProp_GProps
from OCP.BRepGProp import BRepGProp
rd = IGESControl_Reader(); rd.ReadFile(str(tmp / "Deckel.iges")); rd.TransferRoots()
props = GProp_GProps(); BRepGProp.VolumeProperties_s(rd.OneShape(), props)
print(f"Stichprobe IGES-Reimport Volumen: {v0:.3f} -> {props.Mass():.3f}", "OK" if abs(v0 - props.Mass()) < 1e-2 else "ABWEICHUNG")
obj = (tmp / "Deckel.obj").read_text().splitlines()
print("Stichprobe OBJ: v =", sum(l.startswith("v ") for l in obj), " f =", sum(l.startswith("f ") for l in obj))
