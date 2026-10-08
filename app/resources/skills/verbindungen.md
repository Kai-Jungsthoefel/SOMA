---
title: Joints
name: Joints and fasteners
summary: Screws (preferably {{screw}}) with thread engagement and edge distance, snap fits, hinges, pins and positive locking, magnets, glue.
order: 21
category: Design knowledge
default: on-demand
when: parts are joined: screws, snap fits, hinges, pins, magnets or glue
topics: Screws; Snap fits; Hinges; Pins and positive locking; Magnets and glue
var screw: M3 | | Preferred screw | M2, M2.5, M3, M4, M5, M6, M8
---
# Skill: Joints and fasteners

Preferred screw size from the app. It applies unless the user says otherwise in the chat or in `NOTES.md`.
Clearances for sliding fits come from the process or tolerances skill.

## Screws

- Prefer **{{screw}}** and as few different sizes as possible. Larger only where the load needs it.
- Thread engagement: 1.5 × d in steel and brass, 2 × d in aluminium, 2.5 × d in plastics.
- Hole centre at least 1.5 × d from an edge, 2 × d in plastics.
- Free line along the screw axis for the screwdriver or hex key, also when the other parts are already mounted.
- Only standard lengths (`lengths("ISO 4762", "M3")` and `pick_length()` from `soma.fasteners`). Choose one, then
  design around it.
- Every screw, nut and insert goes into the parts list in `NOTES.md`: size, length, count.

## Snap fits

- Cantilever hook: length L at least 5 × the thickness t at the root, root fillet about 0.5 × t.
- Hook depth at most `0.67 × e × L² / t`. Allowed strain e: PLA 1 %, PETG and ABS 2 %, PA, POM and PP 4 %.
- Lead-in slope about 30°. Retaining face square (permanent) or at 45° (can be opened again).

## Hinges

- Pin hinge: pin at least Ø 3 mm. A screw or steel pin is stronger than a printed pin.
- Living hinges only in PP or PE, 0.3 to 0.5 mm thick.

## Pins and positive locking

- Alignment with two dowel pins: one in a round hole, the other in a slot, so the parts are not over-constrained.
- Parts that look alike go together only one way: an off-centre pin or tab.
- Sliding joints (dovetail, T-slot): sliding fit clearance per side, chamfer at the entry.

## Magnets and glue

- Magnet pockets: magnet Ø + 0.1 to 0.2 mm, glue the magnets in. Note the polarity in `NOTES.md`.
- Glued joints: gap 0.1 to 0.2 mm, large faces, loaded in shear, not in peel.
