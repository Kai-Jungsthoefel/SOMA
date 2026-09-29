"""Phase 0, Punkt 2 (Leistung): Wie lange braucht der Python-Mesher bei grossen Bauteilen?"""
import time, sys
import cadquery as cq
import mesher
from OCP.BRepMesh import BRepMesh_IncrementalMesh

def bench(label, shape, tol=0.05, ang=0.3):
    t = time.perf_counter(); BRepMesh_IncrementalMesh(shape.wrapped, tol, False, ang, True); t_occ = time.perf_counter() - t
    t = time.perf_counter(); m = mesher.mesh_shape(shape, tol, ang); t_all = time.perf_counter() - t   # enthaelt erneutes (gecachtes) Meshen
    tris = m["indices"].shape[0]; nf = len(m["faces"]); ne = len(m["edges"])
    t = time.perf_counter(); size = mesher.write_glb("_perf.glb", [dict(meta=dict(partId="0:x", name="x", role="part"), mesh=m, color=(.6, .6, .6, 1))]); t_glb = time.perf_counter() - t
    print(f"{label:34s} Flaechen {nf:5d} Kanten {ne:5d} Dreiecke {tris:7d} | OCC-Mesh {t_occ:5.2f}s  Python-Mesher {t_all:5.2f}s  GLB {t_glb:4.2f}s ({size/1e6:.1f} MB)")

t = time.perf_counter()
pts = [(x * 6 - 90, y * 6 - 90) for x in range(31) for y in range(31)]
plate = cq.Workplane("XY").box(200, 200, 8).faces(">Z").workplane().pushPoints(pts).hole(3.0)
print(f"Bauzeit Platte mit {len(pts)} Loechern: {time.perf_counter()-t:.2f}s")
bench("Platte 961 Loecher, tol 0.05", plate.val())
bench("Platte 961 Loecher, tol 0.01", plate.val(), 0.01, 0.1)
pins = cq.Workplane("XY").box(200, 200, 8).faces(">Z").workplane().pushPoints(pts[::2]).circle(1.5).extrude(5)
bench("Platte + 480 Zapfen (Union), tol 0.05", pins.val())
bench("Kugel R50 fein, tol 0.005", cq.Workplane("XY").sphere(50).val(), 0.005, 0.05)
import os; os.remove("_perf.glb")
