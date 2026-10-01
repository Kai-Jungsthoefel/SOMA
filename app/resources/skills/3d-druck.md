---
title: 3D-Druck (FDM)
name: 3D printing (FDM)
summary: Druckbare Wandstärken, Überhänge bis {{overhang}}°, Spiel für Passungen, Ausrichtung auf dem Druckbett, Gewinde über Einschmelzmuttern.
order: 10
topics: Drucker und Material; Wände und kleine Details; Überhänge und Brücken; Ausrichtung und Bauraum; Spiel und Passungen; Schrauben und Gewinde; Export als STL oder 3MF
var material: PLA | | Material | PLA, PETG, ABS, ASA, TPU
var nozzle: 0.4 | mm | Düse | 0.1..1.2
var layer: 0.2 | mm | Schichthöhe | 0.04..0.8
var bed_x: 220 | mm | Bauraum X | 30..2000
var bed_y: 220 | mm | Bauraum Y | 30..2000
var bed_z: 250 | mm | Bauraum Z | 30..2000
var overhang: 45 | ° | Max. Überhangwinkel | 10..85
var bridge: 10 | mm | Max. Brücke ohne Stütze | 0..200
var min_wall: 1.2 | mm | Mindestwand | 0.2..20
var clearance: 0.3 | mm | Spiel je Seite (Gleitpassung) | 0..3
---
# Skill: 3D printing (FDM)

The parts will be printed on a filament printer (FDM). The user set these values in the app, they are binding unless
the user says otherwise in the chat or in `NOTES.md`:

| Setting | Value |
|---|---|
| Material | {{material}} |
| Nozzle | {{nozzle}} mm |
| Layer height | {{layer}} mm |
| Build volume | {{bed_x}} × {{bed_y}} × {{bed_z}} mm |
| Max. overhang without support | {{overhang}}° from vertical |
| Max. bridge without support | {{bridge}} mm |
| Minimum wall | {{min_wall}} mm |
| Clearance per side for sliding fits | {{clearance}} mm |

Put them into named constants at the top of `model.py` (`NOZZLE = {{nozzle}}`, `CLEARANCE = {{clearance}}`,
`MAX_OVERHANG = {{overhang}}`, `BED = ({{bed_x}}, {{bed_y}}, {{bed_z}})`) and use the constants, not the numbers.

## Walls and small features

- Walls at least {{min_wall}} mm, more where the part carries load or holds screws. Prefer multiples of the nozzle width
  ({{nozzle}} mm).
- No feature thinner than two nozzle widths, no gap narrower than 0.5 mm, no pin thinner than 2 mm.
- Embossed or engraved text: at least three layers high or deep, letters at least 5 mm tall.

## Overhangs and bridges

- Overhangs up to {{overhang}}° from vertical (0° is a vertical wall, 90° a flat ceiling) print without support. Avoid
  shapes that need support, or say clearly where they do.
- Bridges (flat ceilings between two walls) up to {{bridge}} mm are fine.
- Horizontal holes whose top would overhang more than {{overhang}}°: give them a pointed (teardrop) or flat top instead
  of a round one.
- Edges on the print bed: chamfer them (0.5 to 1 mm) instead of filleting. A fillet there becomes an overhang.

## Orientation and size

- Design each part with its largest flat face on the bed and say which orientation you assume.
- Layers are the weak direction. Loads should run along the layers, not pull them apart. Snap hooks and clips lie flat.
- If a part does not fit the build volume of {{bed_x}} × {{bed_y}} × {{bed_z}} mm, split it into pieces that do (with
  alignment pins or a lap joint) and register every piece with `add_part`.
- One `add_part` per printed body. Do not merge parts that are printed separately.

## Fits and clearances

- Parts that slide or turn in each other: {{clearance}} mm clearance per side. Loose fit: add 0.1 mm. Press fit: 0.1 mm
  or less, suggest a small test print first.
- Lids, drawers and sliding parts: at least {{clearance}} mm gap on every side.
- Printed holes come out about 0.1 to 0.2 mm smaller than modeled. Model screw holes 0.2 mm larger than the nominal
  clearance hole.
- Every clearance is a named constant. Mating faces never touch with zero gap.

## Screws and threads

- Do not print metric threads below M6. Use heat-set inserts or self-tapping screws instead.
- Heat-set inserts, typical hole sizes for short inserts: M2 Ø 3.2, M2.5 Ø 3.6, M3 Ø 4.0, M4 Ø 5.6, M5 Ø 6.4 mm, depth
  insert length + 1 mm. Sizes differ between makers: note your assumption in `NOTES.md` or ask the user.
- Self-tapping screws for plastic (about 3 mm): hole Ø 2.5 mm.
- Screw bosses: outer diameter at least 2.5 × the hole, joined to the wall or with ribs, never free-standing and thin.

## Export

- Printable parts go out as STL or 3MF, one file per part: `soma export "Lid" --format 3mf`. References are not printed.
