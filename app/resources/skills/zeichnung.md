---
title: Technical drawings
name: Technical drawings
summary: Drawings in drawings/*.py to {{standard}}: views, sections, details and dimensions measured from the model, as PDF and DXF.
order: 33
category: Check and present
default: on-demand
when: the user wants a technical drawing, a manufacturing or assembly drawing, a PDF or DXF with dimensions, or a parts list
topics: Before drawing; Sheet and views; Sections and details; Dimensions; Tolerances and notes; Assembly drawings; Free drawing; Build and check; Feedback
var standard: ISO | | Standard | ISO=ISO (first angle projection), ASME=ASME (third angle projection)
var size: A3 | | Usual sheet size | A4, A3, A2, A1, A0
var tolerance: ISO 2768-m | | General tolerances | ISO 2768-f=ISO 2768-f (fine), ISO 2768-m=ISO 2768-m (medium), ISO 2768-c=ISO 2768-c (coarse), none=none
var language: en | | Language on the drawing | en=English, de=German
---
# Skill: Technical drawings

A drawing is Python in `drawings/<name>.py`. You decide what goes where. soma projects the model (visible and
hidden edges), cuts sections, measures every dimension from the geometry and writes PDF and DXF. For this model:
standard {{standard}}, sheet {{size}}, general tolerances {{tolerance}}, texts on the drawing in language
"{{language}}". Do not change `model.py` for a drawing.

```python
from soma.drawing import Sheet
from model import L, W, T, HOLE             # the model's constants (add_part has no effect here)

sh = Sheet("Bracket", size="{{size}}", scale="1:2", number="BR-001", material="AlMg3",
           tolerance="{{tolerance}}", projection="first", language="{{language}}")
front = sh.view("Bracket", "front", at=(140, 190))   # at: sheet point (mm) for the middle of the part
top = sh.view("Bracket", "top", at=(140, 95))        # same x: lined up under the front view
a = sh.section("Bracket", "left", through=(0, 0, 0), at=(300, 190), name="A", parent=front)
b = sh.detail(front, (20, 0, T), 4, at=(330, 80), scale="5:1", name="B")
top.dim((-L / 2, -W / 2, T), (L / 2, -W / 2, T), offset=-10)  # model points on an edge; soma measures
top.diameter((45, 17.5, T), HOLE / 2, text="4x <>")
top.center_marks()
sh.text("Deburr all edges", (30, 30))
```

## Before drawing

- Ask what the drawing is for: making a part (workshop, supplier), assembly, inspection. A part that is only laser or
  water-jet cut needs a 1:1 DXF of its outline, not a drawing (skill for laser cutting).
- Plan first and write the plan as comments at the top of the file: sheet and scale, views, sections, details, the
  dimensions per view and their datums.
- One part per sheet for manufacturing drawings, the assembly on a sheet of its own. Several `Sheet(...)` per file are
  fine, names are unique.
- Dimensions follow the function: which faces mate, which holes line up, which edge is the datum. Ask the user when
  it is not clear from the model or `NOTES.md`.

## Sheet and views

- The smallest sheet on which views and dimensions fit with room. Scales of ISO 5455: 1:1, 1:2, 1:5, 1:10, 2:1, 5:1,
  10:1. Text stays 3.5 mm at any scale.
- Front view: the view that shows most of the shape, in the position of use or of machining. As few views as needed:
  often front and top or front and side, a turned part needs one view with Ø.
- ISO uses first angle projection (`projection="first"`): top view below the front view, the view from the left to
  its right. ASME uses third angle (`projection="third"`): top view above, the view from the right to its right. A
  row of views shares x (column) or y (row) of `at`. The default origin is the middle of the part, so views of the
  same parts line up.
- 15 to 25 mm between views for dimensions. Everything stays inside the frame and off the title block:
  `soma drawing info` prints the drawing area.
- Hidden edges (`hidden=`, on in the six standard views) only where they explain something. A section is clearer.
  Iso views without hidden edges and without dimensions, smaller, top right.
- `what` is a part, a group, a list, `"*"` or any CadQuery shape built in the drawing file: `sh.shape("Housing")` gives
  the geometry to cut, move or simplify first.
- `direction` can be a vector from the part to the viewer (auxiliary view of an inclined face), `up=` turns the view.
- `style="phantom"`: adjacent parts and extreme positions as thin dash-double-dot lines. Give it the same `origin=`
  (a model point) and `at=` as the view it belongs to.
- Long parts (shafts, profiles, rails): `breaks=[(p1, p2)]` leaves out the part between two model points and draws
  break lines. Dimensions across the break show the full length. Give views in a row the same breaks.
- Labels soma places itself (view label, "A-A", the letters of a cutting line or detail) move with `label_at=`,
  `letters_at=[(x, y), (x, y)]` and `letter_at=` (sheet points) when they get in the way of dimensions.

## Sections and details

- Section where inner shape matters: bores, pockets, walls. `sh.section(what, direction, through=point, ...)` removes
  everything between the viewer and the plane through `point`. `name="A"` with `parent=front` draws the cutting line,
  arrows and letters, and "A-A" above the section.
- Stepped section through features that do not lie in one plane: `path=[p1, p2, p3, ...]` (model points, seen in
  `parent`) instead of `through`. Everything on the viewer's side of the path is removed, the cutting line gets thick
  ends and bends. Half section: a path from outside to the axis and then towards the viewer, e.g.
  `path=[(-50, 0, 0), (0, 0, 0), (0, -50, 0)]`.
- Local break-out: `region=` a solid that is removed, without `parent`. Where a cut is seen edge-on (steps, the middle of
  a half section, the border of a break-out) soma draws no edge: add a center line (half section) or a thin freehand
  line (break-out) yourself.
- Not cut along their axis (ISO 128-40): screws, nuts, washers, pins, shafts, keys, rolling elements, ribs. List them
  in `unhatched=`.
- Hatching is 45° and alternates between neighbouring parts. Thin walls (under 2 mm on the sheet): `hatch="solid"`.
- Details for small features (grooves, chamfers, undercuts): `sh.detail(parent, center, radius, at, scale, name="B")`,
  usually 2:1 to 10:1.

## Dimensions

- Never type a value: give model points, soma measures. `"<>"` in `text` is the measured value: `"<> ±0.1"`,
  `"4x <>"`, `"(<>)"` for an auxiliary dimension. Typed numbers that differ from the model are reported.
  `view.diameter()` and `view.radius()` add Ø and R themselves (`text="<> H7"` gives "Ø8 H7"), `"Ø<>"` is for a
  diameter dimensioned from the side with `view.dim()`.
- Every feature is dimensioned once, in the view where it shows best. Dimension visible edges, not hidden ones. Points
  lie on an edge or on a circle center of that view: on rounded or chamfered corners take a point on the straight
  edge, not the virtual corner.
- Functional dimensions first. Hole positions that matter from one datum (baseline), chains only where the function
  is a chain. Never close a chain: leave one out or make it auxiliary.
- Small dimensions near the part, bigger ones outside: first line about 10 mm from the edge, then 7 to 8 mm steps
  (`offset`). Dimension lines do not cross each other, texts never sit on edges.
- Diameters with `view.diameter(center, r)` where the hole is a circle, on a side view a linear dimension with
  `"Ø<>"`. Radii with `view.radius(center, r)`. `angle=` is the direction from the center to the text (0 right, 90 up),
  pointing away from other dimensions and edges. Patterns: one dimension `"4x <>"`, positions from a datum or the
  pattern center, `view.center_marks()`.
- Positions that are not in the model (screws fitted later, holes drilled on assembly): mark them with
  `view.center_mark(point, r)` and dimension to its center. Dimensions may also end on a `view.centerline()`.
- Threads: `"M5"` or `"M5 - 10 deep"` on the hole. soma models threads without the helix (tap drill or core), so
  always name the thread. Through holes: `"Ø<> THRU"` or a leader.
- Angles: `view.angle(vertex, p1, p2)` in views where both lines lie in the paper plane.
- `view.circles()` and `soma drawing info` list the circle centers and diameters per view: use them for hole
  positions instead of guessing.

## Tolerances and notes

- The general tolerance stands in the title block. Single tolerances only where the function needs them: `tol=0.1`,
  `tol=(0.1, -0.05)`, fits `"Ø<> H7"` on holes and `"Ø<> g6"` on shafts. The skill for tolerances helps choose.
- Surface roughness (`Ra 1.6`) and geometrical tolerances only where needed: a leader with text, or draw the symbol
  with ezdxf.
- Notes above the title block or bottom left: "Deburr all edges", "Break sharp edges 0.3 x 45°", heat treatment.
- Title block: `number`, `material`, `author`, `owner`, `revision`, `tolerance`. Take company and drawing number from
  `NOTES.md` or ask the user, do not invent them. With `titleblock=False` you draw your own.

## Assembly drawings

- Views of the assembly, often a section along the main axis with the screws unhatched. Only overall, connecting and
  fitting dimensions.
- Item numbers with `view.leader(point_on_part, "1", at=..., end="dot")`, lined up in a row or column next to the
  views and off the parts list, the same part always gets the same number.
- Parts list with `sh.table(rows, at)` on the title block (columns as wide as their texts, or give `widths` in mm): item, name, quantity, material or designation (for
  standard parts the designation of `soma.fasteners`, e.g. "ISO 4762 M5x16").

## Free drawing

- `sh.msp` is the ezdxf model space in sheet millimetres: lines, arcs, polylines, hatches, texts, blocks. Layers
  VISIBLE (0.5 mm), THIN, CENTER, HIDDEN, PHANTOM, HATCH, CUT, DIM, TEXT, text style and dimension style "ISO". Own
  ezdxf dimensions in a view need `override={"dimlfac": 1 / view.scale}`.
- `view.pt((x, y, z))` is the sheet point of a model point. Draw what soma does not offer yourself: surface and weld
  symbols, datum triangles, a different title block.
- `sh.text(text, at, height=3.5, align=, rotation=)`. Several lines with `\n`: the first line at `at`, the others below,
  leading spaces indent. Heights: 3.5 mm, view names 5 mm, never under 2.5 mm.
- Place texts by measuring, not by trying: `sh.text_width(text, height)` is the width in mm before you build.
  `leader(..., at=, side=)`: the text starts at `at` going right, or ends there with `side="left"`. Without `side`
  it points away from the leader's point.

## Build and check

1. `soma drawing build` (or `soma drawing build drawings/x.py`). Errors name file and line. Warnings report texts on
   edges, on dimension, leader or cutting lines or on each other, things outside the frame or on the title block or a
   table, texts too long for their cell or title block field, points on no edge, typed numbers that differ from the
   model and uncommon scales. Fix them, or tell the user why one is fine.
2. **Open the picture and look at it** (`.soma/drawings/<id>.png`, the build prints the path). It is large and gets scaled down when you open it:
   crop parts of it (Pillow is installed) to read small texts and check every dimension and hatching.
3. `soma drawing info "Name"`: views with their place on the sheet, circles, every dimension with its value. Compare
   with your plan: every feature dimensioned once, nothing crowded.
4. PDF and DXF are in `output/drawings/`, all sheets in one PDF in `output/drawings.pdf` (ordered by file name, then
   by their order in the file; written only when no drawing has errors). After model changes build the drawings again
   before you commit.

## Feedback

The user opens the PDF in the app and marks it up: `[Markup: .soma/feedback/... , drawn on output/drawings/x.pdf p. 1]`
shows what to change. Open the picture, change the drawing file (never the PDF) and build again.
