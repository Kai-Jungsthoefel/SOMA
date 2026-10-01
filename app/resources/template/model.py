"""Starter model: a small box with a lid. The agent (or you) edits this file.

Rules (see AGENTS.md): every part must be registered with add_part(), names must be unique,
build with `soma build`. Units are millimetres, Z is up.
"""
import cadquery as cq
from soma import add_part

# --- parameters -------------------------------------------------------------------------
LENGTH = 60.0
WIDTH = 40.0
HEIGHT = 25.0
WALL = 2.0

# --- body: a box, hollowed out from the top ---------------------------------------------
body = (
    cq.Workplane("XY")
    .box(LENGTH, WIDTH, HEIGHT, centered=(True, True, False))
    .edges("|Z").fillet(3.0)
    .faces(">Z").shell(-WALL)
)

# --- lid: sits on top, with a lip that fits into the body -------------------------------
lid = (
    cq.Workplane("XY").workplane(offset=HEIGHT)
    .box(LENGTH, WIDTH, WALL, centered=(True, True, False))
    .edges("|Z").fillet(3.0)
)

add_part("Body", body, color=(0.25, 0.45, 0.75))
add_part("Lid", lid, color=(0.85, 0.85, 0.88))
