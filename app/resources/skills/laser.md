---
title: Laserschneiden
name: Laser cutting
summary: Teile aus {{material}}, {{thickness}} mm: Steckverbindungen mit Schnittbreite {{kerf}} mm, Mindeststege, Zusammenbau in 3D, DXF je Platte.
order: 13
category: Fertigungsverfahren
default: on-demand
when: parts will be laser cut from flat sheets (plywood, MDF, acrylic)
topics: Material und Plattenstärke; Schnittbreite und Steckverbindungen; Stege, Löcher, Ecken; Aufbau im Modell; Prüfen und Export als DXF
var material: plywood | | Material | plywood=Sperrholz, MDF=MDF, acrylic=Acryl (PMMA), cardboard=Karton
var thickness: 3 | mm | Plattenstärke | 0.5..25
var kerf: 0.15 | mm | Schnittbreite | 0..1
---
# Skill: Laser cutting

The parts are cut by a laser from flat sheets of **{{material}}**, {{thickness}} mm thick. The values apply unless the
user says otherwise in the chat or in `NOTES.md`. Constants at the top: `THICKNESS = {{thickness}}`, `KERF = {{kerf}}`.
Real sheets differ from nominal (plywood "3 mm" is often 2.8 to 3.2 mm): ask the user to measure when fits matter.

## Kerf and joints

- The laser burns away `KERF` along every cut: holes and slots come out `KERF` wider, outlines and tabs `KERF` smaller.
  Ask whether the laser compensates this already. If it does, model nominal sizes.
- Snug slot for a plate: `THICKNESS - KERF` wide. Slip fit: 0.1 mm more.
- Finger joints and tabs: draw the fingers `KERF` wider and the gaps `KERF` narrower than nominal.
- Acrylic cracks under press fits: slip fit plus glue or screws. Wood and MDF take press fits.
- Screwed joints: T-slot with a captive nut in the plate that the screw enters.

## Webs, holes, corners

- Webs between cuts and distances to the edge at least 1.5 × `THICKNESS`, never below 2 mm.
- Holes at least `THICKNESS` in diameter.
- Acrylic: inner corners with 0.5 mm radius against cracks. Sharp inner corners are fine in wood.

## In the model

- One part per plate. A function builds it lying flat on XY (an extruded 2D profile, thickness along Z), then it is
  rotated and moved into the assembly.
- Constant `FLAT = False` at the top. With `FLAT = True`, `model.py` registers the plates flat on XY next to each other
  instead of assembled. `soma export` writes a DXF from a section through the middle of the part, so it only works on
  flat plates.
- Engravings (lines, text) are not in the cut DXF: list them in `NOTES.md` or ask how the user's laser takes them.

## Checks and export

- Plates that are not joined do not intersect: `a.intersect(b).val().Volume()` is 0. Joined plates overlap only by the
  kerf allowance.
- Every plate fits the sheet or laser bed: ask for its size when a part is longer than 300 mm.
- DXF files: set `FLAT = True`, `soma build`, `soma export "Side" --format dxf` for each plate, then `FLAT = False` and
  build again.
