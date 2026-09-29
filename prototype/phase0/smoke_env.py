"""Phase 0, Punkt 5: Funktionstest der schlanken Umgebung (ohne scipy/numba/matplotlib/trame)."""
import sys, tempfile, os
import cadquery as cq

print("python", sys.version.split()[0], "cadquery", cq.__version__)
body = cq.Workplane("XY").box(40, 30, 10).edges("|Z").fillet(3)
body = body.faces(">Z").workplane().rect(30, 20).cutBlind(-5)
body = body.faces(">Z").workplane().hole(4)
print("volume", round(body.val().Volume(), 1), "faces", body.faces().size())

txt = cq.Workplane("XY").text("CAD", 8, 1)
print("text ok, solids:", txt.solids().size())

asm = cq.Assembly(name="root").add(body, name="body", color=cq.Color(0.2, 0.4, 0.8))
tmp = os.path.join(tempfile.gettempdir(), "cadide_smoke.step")
asm.export(tmp)
print("step size", os.path.getsize(tmp))

# STL-Export und weitere Formate
for ext in ("stl", "3mf", "dxf", "svg", "amf", "vrml", "glb", "gltf"):
    p = os.path.join(tempfile.gettempdir(), "cadide_smoke." + ext)
    try:
        if ext in ("glb", "gltf"):
            asm.export(p)
        elif ext in ("dxf", "svg"):
            cq.exporters.export(body.section(-1) if ext == "dxf" else body, p)
        else:
            cq.exporters.export(body, p)
        print(f"export {ext}: OK ({os.path.getsize(p)} B)")
    except Exception as e:
        print(f"export {ext}: FEHLER {type(e).__name__}: {str(e)[:100]}")
