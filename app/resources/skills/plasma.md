---
title: Plasma cutting
name: Plasma cutting
summary: {{material}}, {{thickness}} mm, kerf {{kerf}} mm: holes at least {{min_hole}} mm, no falling islands, webs, heat distortion, tab and slot for welding, one DXF per plate.
order: 15
category: Manufacturing
default: on-demand
when: parts will be cut from metal plate on a CNC plasma table
topics: Material and plate; Kerf and accuracy; Holes; Islands, text and webs; Heat and edges; Tab and slot for welding; Structure in the model; Checks and export as DXF
var material: mild steel | | Material | mild steel=Mild steel, stainless steel=Stainless steel, aluminium=Aluminium
var thickness: 3 | mm | Plate thickness | 0.5..50
var kerf: 1.5 | mm | Kerf | 0.5..5
var min_hole: 5 | mm | Smallest hole that is cut | 1..50
---
# Skill: Plasma cutting

The parts are cut by a CNC plasma torch from **{{material}}** plate, {{thickness}} mm thick. The values apply unless the
user says otherwise in the chat or in `NOTES.md`. Constants at the top: `THICKNESS = {{thickness}}`, `KERF = {{kerf}}`,
`MIN_HOLE = {{min_hole}}`. Plasma only cuts metal. Plastic or wood: the laser cutting or CNC skill.

## Kerf and accuracy

- The torch removes about `KERF` along every cut (1 to 2 mm on air plasma, depending on amperage and nozzle). The CAM
  program (SheetCam, Fusion, the table software) almost always offsets the path by half the kerf. Model nominal sizes
  and ask the user to confirm the kerf setting in their CAM. Only if they say it does not compensate, add `KERF / 2` to
  every outline and subtract it from every hole.
- Expect ±0.5 mm on a hobby table. Fits tighter than that (bearing seats, dowel holes, threads) are drilled, reamed or
  machined after cutting: cut them undersized or not at all and write it in `NOTES.md`.
- The arc lags behind the torch: outer corners come out slightly rounded and inner corners get a radius of about
  `KERF / 2`. A tab that has to sit in a slot needs a 1 mm chamfer on its corners, or the slot corners need a relief.

## Holes

- Holes below `MIN_HOLE` (and below 1.5 × `THICKNESS` on air plasma) come out tapered, oval or not at all: the pierce
  and lead-in need room. Leave them out of the cut part, keep their centers in `NOTES.md` (or as a small cut mark if the
  table can mark), and drill them.
- Holes that get a thread: cut them smaller than the tap drill, or not at all, then drill and tap. The cut edge is
  hardened by the heat, a tap breaks in it.
- Clearance holes for screws: cut 0.5 mm over the ISO 273 medium size, the hole is narrower at the bottom of the plate.

## Islands, text and webs

- Every closed cutout drops whatever is inside it. Text: the insides of A, B, D, O, P, Q, R, 0, 4, 6, 8, 9 fall out.
  Use a stencil font or add bridges at least 1.5 × `THICKNESS` wide that join the insides to the plate.
- Text and fine details: strokes at least 1.5 × `THICKNESS` and at least 3 mm wide, letters at least 10 × `THICKNESS`
  high. Smaller details burn away.
- Webs between cuts and distances to the edge at least 1.5 × `THICKNESS`, never below 3 mm. Thinner webs warp and
  melt.
- Slots at least 1.5 × `THICKNESS` wide, otherwise the arc fills them up.

## Heat and edges

- Long narrow parts bend from the heat (length over 20 × width): make them wider or warn the user. Many cutouts
  close together in one plate warp it too: spread them or leave more material between them.
- The bottom edge has dross that is ground off, and the cut faces are 1 to 3° off square. Faces that have to be square
  or exact are machined afterwards: note them in `NOTES.md`.
- Bending after cutting: follow the sheet metal skill for radii and distances to the bend. Holes that end up close
  to a bend are better drilled after bending.

## Tab and slot for welding

Plasma parts are often welded. Tabs and slots locate the plates so the assembly needs no fixture:

- Slot: `THICKNESS + 0.5` mm wide, 0.5 mm longer than the tab. The tab is `THICKNESS` to 2 × `THICKNESS` long and
  sticks out by `THICKNESS` (room for a fillet weld) or ends flush (ground after welding).
- At least two tabs per joint, at least 3 × `THICKNESS` from the ends of the edge, and the slot keeps the web rule
  above from every edge.
- Corners of the tab chamfered (see the arc lag above), the slot ends square.
- Ask before adding weld preparation (bevels): most small parts are welded with a plain fillet.

## In the model

- One part per plate. A function builds it lying flat on XY (an extruded 2D profile, thickness along Z), then it is
  rotated and moved into the assembly.
- Constant `FLAT = False` at the top. With `FLAT = True`, `model.py` registers the plates flat on XY next to each other
  instead of assembled. `soma export` writes a DXF from a section through the middle of the part, so it only works on
  flat plates.
- Drill positions, bend lines, threads and machined faces go into `NOTES.md` per plate, they are not in the cut DXF.

## Checks and export

- Each plate is one piece: `len(plate.solids().vals()) == 1`. More than one solid means an island falls out (see text
  above).
- Holes: `[2 * e.radius() for e in plate.edges("%CIRCLE").vals() if e.IsClosed()]` are all at least `MIN_HOLE`,
  smaller ones are listed for drilling instead.
- Plates that are not welded together do not intersect: `a.intersect(b).val().Volume()` is 0. Tabs overlap their slot
  plate only inside the slot.
- Every plate fits the table and the plate stock: ask for the size when a part is longer than 1000 mm (common tables
  and sheets: 1220 × 1220, 1250 × 2500, 1500 × 3000 mm).
- DXF files: set `FLAT = True`, `soma build`, `soma export "Side" --format dxf` for each plate, then `FLAT = False` and
  build again. Tell the user the DXF is in mm and that the CAM program must add the kerf offset and lead-ins.
