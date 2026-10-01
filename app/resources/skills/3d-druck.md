---
title: 3D-Druck (FDM)
name: 3D printing (FDM)
summary: Druckbare Wandstärken, Überhänge bis 45°, Spiel für Passungen, Ausrichtung auf dem Druckbett, Gewinde über Einschmelzmuttern.
order: 10
topics: Wände und kleine Details; Überhänge und Brücken; Ausrichtung und Bauraum; Spiel und Passungen; Schrauben und Gewinde; Export als STL oder 3MF
---
# Skill: 3D printing (FDM)

The parts will be printed on a filament printer (FDM). Unless `NOTES.md` or the user says otherwise, assume a 0.4 mm
nozzle, 0.2 mm layers, PLA or PETG and a build volume of 220 × 220 × 250 mm. Put these assumptions into named constants
at the top of `model.py` (`NOZZLE = 0.4`, `CLEARANCE = 0.3`, `BED = (220, 220, 250)`) so the user can change them.

## Walls and small features

- Walls at least 1.2 mm (three lines of 0.4 mm), 2 mm or more where the part carries load or holds screws. Prefer
  multiples of the line width (0.8, 1.2, 1.6, 2.0 mm).
- No feature thinner than 0.8 mm, no gap narrower than 0.5 mm, no pin thinner than 2 mm.
- Embossed or engraved text: at least 0.6 mm high or deep, letters at least 5 mm tall.

## Overhangs and bridges

- Overhangs up to 45° from vertical print without support. Avoid shapes that need support, or say clearly where they do.
- Bridges (flat ceilings between two walls) up to about 10 mm are fine.
- Horizontal holes larger than about 8 mm: give them a pointed (teardrop) or flat top instead of a round one.
- Edges on the print bed: chamfer them (0.5 to 1 mm) instead of filleting. A fillet there becomes an overhang.

## Orientation and size

- Design each part with its largest flat face on the bed and say which orientation you assume.
- Layers are the weak direction. Loads should run along the layers, not pull them apart. Snap hooks and clips lie flat.
- If a part does not fit the build volume, split it into pieces that do (with alignment pins or a lap joint) and register
  every piece with `add_part`.
- One `add_part` per printed body. Do not merge parts that are printed separately.

## Fits and clearances

- Parts that slide or turn in each other: 0.3 mm clearance per side. Loose fit 0.4 mm. Press fit 0.1 mm or less,
  suggest a small test print first.
- Lids, drawers and sliding parts: 0.3 to 0.5 mm gap on every side.
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
