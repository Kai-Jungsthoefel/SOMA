---
title: Gehäusebau
name: Enclosure design
summary: Gehäuse um eine Platine oder ein Gerät: Wand und Deckel mit Falz, Abstand zur Referenz, Dome für Schrauben, Ausschnitte, Belüftung.
order: 30
topics: Aufbau aus Unterteil, Deckel und Referenz; Startwerte für Wand, Boden und Abstand; Dome für die Platine; Ausschnitte, Belüftung, Kabel; Prüfungen vor dem Abschluss
---
# Skill: Enclosure design

Build enclosures around a circuit board or another part the user brought.

## Structure

- Separate parts for base and lid (more if needed), in one group: `add_part("Base", base, group="Enclosure")`,
  `add_part("Lid", lid, group="Enclosure")`.
- The board or device stays a reference (`role="reference"`, usually loaded with `import_assembly`). Never change or
  export it.
- Derive positions from the reference instead of typing numbers: `asm.toCompound().BoundingBox()` for an assembly,
  `shape.val().BoundingBox()` for a single shape. Write the key dimensions of the reference into `NOTES.md`.
- Constants at the top: `WALL`, `FLOOR`, `LID`, `GAP` (reference to wall), `CLEARANCE` (lid to base), the screw size.

## Starting values

Change them when the user or another active skill says otherwise.

- Wall 2 mm, floor and lid 2 mm. Inner corner radius at least the wall thickness, outer edges rounded 1 to 2 mm.
- At least 1 mm between the reference and every inner wall, 2 mm above the tallest component.
- Lid with a lip 1.5 to 2 mm high that reaches into the base, 0.2 to 0.3 mm clearance per side. Or a flat lid on screws.

## Mounting the board

- Standoffs under the mounting holes of the board: outer Ø about 2.2 × the screw size, hole for a heat-set insert or a
  tap drill, high enough that the lowest component on the underside clears the floor by 1 mm.
- The hole positions must match the reference exactly. Take them from the reference and check them with a measurement.

## Openings

- Cutouts for connectors, buttons, LEDs and displays come from the position of the part in the reference, plus 0.5 mm
  clearance per side (1 mm for plugs with molded housings).
- Ventilation: slots 1.5 to 2 mm wide with webs of at least 2 mm, not where liquid could drip in.
- Cable entry: a hole or slot with rounded edges, optionally with a strain relief.

## Checks before you finish

- No part may intersect the reference or another part: `base.intersect(board).val().Volume()` is 0 for every pair that
  matters (for an assembly use `board = asm.toCompound()`).
- The lid can be removed: no undercuts in the direction it comes off.
- Tell the user how the enclosure goes together: which screws, how many, what length.
