"""Phase 0, Punkt 1 (Randfaelle): Umlaute/Leerzeichen/Sonderzeichen, doppelte Namen."""
import os, tempfile
import cadquery as cq
from xcaf_tools import dump_step_tree

b = lambda x: cq.Workplane("XY").box(x, x, x)
path = os.path.join(tempfile.gettempdir(), "p1b.step")

asm = cq.Assembly(name="Gehäuse Größe/1")
for n in ["Lüfter Halterung", "Deckel (oben)", "M3×8 Schraube", "日本語"]:
    asm.add(b(5), name=n, color=cq.Color(0.5, 0.5, 0.5, 1))
asm.export(path)
print("Sonderzeichen:", [t["name"] for t in dump_step_tree(path)])

dup = cq.Assembly(name="dup")
try:
    dup.add(b(5), name="Schraube"); dup.add(b(5), name="Schraube")
    dup.export(path)
    print("Doppelte Namen:", [t["name"] for t in dump_step_tree(path)])
except Exception as e:
    print("Doppelte Namen -> Fehler:", type(e).__name__, e)
