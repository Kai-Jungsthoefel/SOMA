---
title: Baugruppen und Bewegung
name: Assemblies and motion
summary: Teile in Einbaulage aus gemeinsamen Bezügen, Schnittstellen nur einmal definiert, Montierbarkeit, bewegliche Teile über den ganzen Weg prüfen ({{motion_gap}} mm Abstand), Stückliste.
order: 24
category: Konstruktionswissen
default: on-demand
when: several parts are assembled or move against each other
topics: Bezüge und Einbaulage; Schnittstellen; Montierbarkeit; Bewegliche Teile; Stückliste
var motion_gap: 1 | mm | Mindestabstand bewegter Teile | 0..20
---
# Skill: Assemblies and motion

Minimum gap between moving parts, from the app: `MOTION_GAP = {{motion_gap}}`. It applies unless the user says
otherwise in the chat or in `NOTES.md`.

## Positions

- One coordinate system for the whole model, origin at the main mounting face or axis.
- Each part is built in its own frame by a function, then placed with `.translate()` and `.rotate()`.
- Positions come from other parts, not from typed numbers: `LID_Z = BASE_H`, `shaft.translate((0, 0, BEARING_Z))`.
- Register parts in their assembled position, one group per sub-assembly (`group="Drive"`).

## Interfaces

Define every interface once and use it for both sides: one list `HOLES = [(x, y), ...]` for the bracket and the plate,
one constant for a shaft diameter, used for the shaft and (plus clearance) for the bore. Then both sides change
together.

## Assembly

- Every part goes in along a free path, in an order you can name. For more than three parts, write the order into
  `NOTES.md`.
- Every screw is reachable with its tool when the parts around it are in place.
- No part is trapped: nothing is enclosed that has to go in later.

## Moving parts

- The position of a moving part is a constant (`LID_ANGLE = 0`, `SLIDE_TRAVEL = 0`) with its range in a comment. The
  model shows the normal position.
- Check the whole range, at least both end positions and the middle:

```python
for a in (0, 45, 90):  # range of LID_ANGLE
    moved = lid.rotate((0, HINGE_Y, HINGE_Z), (1, HINGE_Y, HINGE_Z), a)
    print(a, base.intersect(moved).val().Volume(), base.val().distance(moved.val()))
```

The volume must be 0, the distance at least `MOTION_GAP`, except where parts are meant to touch (pin, guide). Remove
the output afterwards. For motions with several steps or parts, write an animation (skill for animation) and run
`soma anim check "Name" --gap {{motion_gap}}`: it checks every moment. `soma analyze clearance` shows tight gaps in
the model position.

## Parts list

A table in `NOTES.md`: part, count, material or process, and for purchased parts size and length. Update it with every
new part.
