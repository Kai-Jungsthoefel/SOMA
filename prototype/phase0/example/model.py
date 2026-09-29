"""Beispielprojekt fuer Phase 0: Gehaeuse fuer eine mitgebrachte Mikrocontroller-Platine."""
import cadquery as cq
from cadide_proto import add_part, import_step

CLEARANCE = 0.3   # Luft zwischen Platine und Gehaeusewand
WALL = 2.0
FLOOR = 2.0
STANDOFF = 1.5    # Platine schwebt so weit ueber dem Boden
HEIGHT = 16.0

# --- mitgebrachte Platine: Ursprung liegt in der Ecke, wir zentrieren sie
board = import_step("inputs/board.step")
bb = board.BoundingBox()
board = board.moved(cq.Location(cq.Vector(-bb.center.x, -bb.center.y, FLOOR + STANDOFF - bb.zmin)))
bb = board.BoundingBox()

# --- Gehaeuse: Aussparung (Tasche) aus der Platinen-Huelle plus Luft
inner_l, inner_w = bb.xlen + 2 * CLEARANCE, bb.ylen + 2 * CLEARANCE
outer = cq.Workplane("XY").box(inner_l + 2 * WALL, inner_w + 2 * WALL, HEIGHT, centered=(True, True, False))
cavity = (cq.Workplane("XY").workplane(offset=FLOOR)
          .box(inner_l, inner_w, HEIGHT, centered=(True, True, False)))
usb_cut = (cq.Workplane("XY").box(WALL + 2, 9.5, 5.0)
           .translate((-(inner_l / 2 + WALL / 2), 0, FLOOR + STANDOFF + 1.6 + 1.6)))
base = outer.cut(cavity).cut(usb_cut)

lid = (cq.Workplane("XY").workplane(offset=HEIGHT)
       .box(inner_l + 2 * WALL, inner_w + 2 * WALL, WALL, centered=(True, True, False))
       .faces(">Z").workplane().pushPoints([(10, 0)]).hole(7.0))
button = cq.Workplane("XY").workplane(offset=HEIGHT - 1).center(10, 0).circle(3.2).extrude(WALL + 2.5)
screw1 = cq.Workplane("XY").workplane(offset=HEIGHT - 6).center(-inner_l / 2 + 3, -inner_w / 2 + 3).circle(1.25).extrude(6 + WALL)
screw2 = cq.Workplane("XY").workplane(offset=HEIGHT - 6).center(inner_l / 2 - 3, inner_w / 2 - 3).circle(1.25).extrude(6 + WALL)

add_part("Boden", base, color=(0.2, 0.25, 0.3))
add_part("Deckel", lid, color=(0.85, 0.85, 0.88))
add_part(
    "Taster",
    button,
    color=(0.85, 0.15, 0.1),
)
add_part("Schraube links", screw1, color=(0.7, 0.7, 0.2))
add_part("Schraube rechts", screw2, color=(0.7, 0.7, 0.2))
add_part("Platine", cq.Workplane("XY").add(board), role="reference")
