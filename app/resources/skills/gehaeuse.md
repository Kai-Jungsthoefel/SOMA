---
title: Gehäusebau
name: Enclosure design
summary: Gehäuse um eine Platine oder ein Gerät: Wand {{wall}} mm, Deckel mit Falz, Abstand zur Referenz, Dome für {{screw}}-Schrauben, Ausschnitte, Belüftung.
order: 30
topics: Aufbau aus Unterteil, Deckel und Referenz; Maße für Wand, Boden und Abstand; Dome für die Platine; Ausschnitte, Belüftung, Kabel; Prüfungen vor dem Abschluss
var wall: 2 | mm | Wandstärke | 0.5..20
var floor: 2 | mm | Boden und Deckel | 0.5..20
var gap: 1 | mm | Abstand zur Referenz | 0..50
var headroom: 2 | mm | Luft über dem höchsten Bauteil | 0..100
var lid: lip | | Deckel | lip=mit Falz, screwed=flach und verschraubt
var lid_clearance: 0.25 | mm | Spiel Deckel zu Unterteil je Seite | 0..2
var screw: M3 | | Schrauben | M2, M2.5, M3, M4, M5
var edge_radius: 1.5 | mm | Außenkanten gerundet | 0..20
var opening_clearance: 0.5 | mm | Spiel an Ausschnitten je Seite | 0..5
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
- Constants at the top: `WALL = {{wall}}`, `FLOOR = {{floor}}`, `GAP = {{gap}}` (reference to wall),
  `HEADROOM = {{headroom}}`, `LID_CLEARANCE = {{lid_clearance}}`, `SCREW = "{{screw}}"`.

## Dimensions

The user set these values in the app. They apply unless the user says otherwise in the chat or in `NOTES.md`.

- Wall {{wall}} mm, floor and lid {{floor}} mm. Inner corner radius at least the wall thickness, outer edges rounded
  {{edge_radius}} mm.
- At least {{gap}} mm between the reference and every inner wall, {{headroom}} mm above the tallest component.
- Lid style: **{{lid}}**. "lip": the lid has a lip 1.5 to 2 mm high that reaches into the base. "screwed": a flat lid
  held by screws into the standoffs or extra bosses in the corners. Either way {{lid_clearance}} mm clearance per side
  between lid and base.

## Mounting the board

- Standoffs under the mounting holes of the board for {{screw}} screws: outer Ø about 2.2 × the screw size, hole for a
  heat-set insert or a tap drill, high enough that the lowest component on the underside clears the floor by 1 mm.
- The hole positions must match the reference exactly. Take them from the reference and check them with a measurement.

## Openings

- Cutouts for connectors, buttons, LEDs and displays come from the position of the part in the reference, plus
  {{opening_clearance}} mm clearance per side (more for plugs with molded housings).
- Ventilation: slots 1.5 to 2 mm wide with webs of at least 2 mm, not where liquid could drip in.
- Cable entry: a hole or slot with rounded edges, optionally with a strain relief.

## Checks before you finish

- No part may intersect the reference or another part: `base.intersect(board).val().Volume()` is 0 for every pair that
  matters (for an assembly use `board = asm.toCompound()`).
- The lid can be removed: no undercuts in the direction it comes off.
- Tell the user how the enclosure goes together: which screws, how many, what length.
