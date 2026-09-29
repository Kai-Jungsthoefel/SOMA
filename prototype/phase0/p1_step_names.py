"""Phase 0, Punkt 1: STEP mit Bauteilnamen und Farben (5 Bauteile), Namensbaum nach Export und Reimport intakt?"""
import sys, tempfile, os
import cadquery as cq
from xcaf_tools import dump_step_tree

PARTS = [  # (name, Objekt, Farbe RGBA)
    ("Boden",   cq.Workplane("XY").box(60, 40, 3),                        (0.15, 0.15, 0.15, 1.0)),
    ("Deckel",  cq.Workplane("XY").box(60, 40, 3).translate((0, 0, 30)),  (0.85, 0.85, 0.85, 1.0)),
    ("Wand",    cq.Workplane("XY").rect(60, 40).rect(56, 36).extrude(27).translate((0, 0, 3)), (0.2, 0.5, 0.9, 1.0)),
    ("Taster",  cq.Workplane("XY").circle(4).extrude(6).translate((15, 0, 33)),                (0.9, 0.1, 0.1, 1.0)),
    ("Schraube_1", cq.Workplane("XY").circle(1.5).extrude(10).translate((25, 15, 3)),          (0.7, 0.7, 0.0, 1.0)),
]
REF = ("Platine", cq.Workplane("XY").box(50, 30, 1.6).translate((0, 0, 6)), (0.0, 0.6, 0.2, 0.5))

def build():
    asm = cq.Assembly(name="Gehaeuse")
    for n, o, c in PARTS:
        asm.add(o, name=n, color=cq.Color(*c))
    ref = cq.Assembly(name="Referenz")
    ref.add(REF[1], name=REF[0], color=cq.Color(*REF[2]))
    asm.add(ref, name="Referenz")
    return asm

if __name__ == "__main__":
    asm = build()
    path = os.path.join(tempfile.gettempdir(), "p1_test.step")
    asm.export(path)          # CadQuery-Standardexport, Modus "default"
    tree = dump_step_tree(path)
    for t in tree:
        print("  " * t["depth"] + f'{t["name"]!r:16} {t["kind"]:9} {t["color"]}')

    expected = {n: c for n, _, c in PARTS} | {REF[0]: REF[2]}
    got = {t["name"]: t for t in tree if t["kind"] == "part"}
    fails = 0
    for n, c in expected.items():
        g = got.get(n)
        if g is None:
            print(f"FEHLT: {n}"); fails += 1; continue
        ok = g["color"] is not None and all(abs(a - b) < 0.01 for a, b in zip(g["color"][:3], c[:3]))
        alpha_ok = g["color"] is not None and abs(g["color"][3] - c[3]) < 0.01
        if not ok: print(f"FARBE falsch: {n}: erwartet {c}, gelesen {g['color']}"); fails += 1
        elif not alpha_ok: print(f"ALPHA verloren: {n}: erwartet {c[3]}, gelesen {g['color'][3]}"); fails += 1
    nested = [t for t in tree if t["name"] == REF[0]]
    if not nested or nested[0]["depth"] < 2: print("VERSCHACHTELUNG verloren"); fails += 1
    print("ERGEBNIS:", "BESTANDEN" if not fails else f"{fails} Abweichung(en)")
    sys.exit(1 if fails else 0)
