"""Starter model: a small box with a lid. The agent (or you) edits this file.

Rules (see AGENTS.md): every part must be registered with add_part(), names must be unique,
build with `soma build`. Units are millimetres, Z is up.
"""
import cadquery as cq
from soma import add_part, param

# --- parameters: the user can change param() values in the app (Parameters panel) ------
LENGTH = param(60.0, "Length", min=30, max=200, unit="mm")
WIDTH = param(40.0, "Width", min=20, max=150, unit="mm")
HEIGHT = param(25.0, "Height", min=10, max=100, unit="mm")
WALL = param(2.0, "Wall", min=1.2, max=4.0, step=0.1, unit="mm")
# outer corner radius grows with the wall, so the inner corners keep a 2 mm radius
CORNER = WALL + 2.0

# --- body: a box, hollowed out from the top ---------------------------------------------
body = (
    cq.Workplane("XY")
    .box(LENGTH, WIDTH, HEIGHT, centered=(True, True, False))
    .edges("|Z").fillet(CORNER)
    .faces(">Z").shell(-WALL)
)

# --- lid: sits on top, with a lip that fits into the body -------------------------------
lid = (
    cq.Workplane("XY").workplane(offset=HEIGHT)
    .box(LENGTH, WIDTH, WALL, centered=(True, True, False))
    .edges("|Z").fillet(CORNER)
)

add_part("Body", body, color=(0.25, 0.45, 0.75))
add_part("Lid", lid, color=(0.85, 0.85, 0.88))
