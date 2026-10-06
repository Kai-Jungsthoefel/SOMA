---
title: Toleranzen und Passungen
name: Tolerances and fits
summary: Spiel als benannte Konstanten, Kollisionsprüfung im Code, Durchgangs- und Kernlöcher, Senkungen für Zylinderschrauben, ISO-Passungen.
order: 20
category: Konstruktionswissen
default: on-demand
when: parts must fit together: clearances, holes for screws, sliding or press fits
topics: Fertigung: {{process}}; Spiel als benannte Konstanten; Kollisionen und Abstände im Code prüfen; Durchgangslöcher ({{hole_fit}}) und Kernlöcher; Senkungen für Zylinderschrauben; ISO-Passungen für gefertigte Teile
var process: unknown | | Fertigung | unknown=noch offen (Agent fragt), 3D printing=3D-Druck, CNC milling=CNC-Fräsen, laser cutting=Laserschneiden, sheet metal=Blech
var hole_fit: medium | | Durchgangslöcher nach ISO 273 | fine=fein, medium=mittel, coarse=grob
var min_gap: 0.2 | mm | Mindestabstand zwischen Teilen | 0..5
---
# Skill: Tolerances and fits

Every real part deviates from its nominal size. Design so that parts still fit when they do.

## General rules

- Manufacturing process from the app: **{{process}}**. If it is "unknown" and `NOTES.md` does not say how the parts
  are made, ask: the clearances depend on it. The skill for the process (if you follow one) has more specific values,
  they take precedence over this one.
- Every clearance, fit and allowance is a named constant at the top of `model.py` (`SCREW_CLEARANCE`, `LID_GAP`), never
  hidden in expressions.
- Mating faces never share the exact same coordinate: a defined gap, or a defined overlap for a press fit.
- Parts that must not touch keep at least {{min_gap}} mm distance (`MIN_GAP = {{min_gap}}`).
- Dimension from the functional faces: a hole follows the part it has to meet, not an arbitrary outer edge.
- Tight tolerances only where they matter. Everything else: general tolerance ISO 2768-m.

## Checking clearances in code

- Interference: `a.intersect(b).val().Volume()` is (close to) 0 for parts that must not touch, also for a part and a
  reference (`role="reference"`).
- Smallest gap in mm: `a.val().distance(b.val())`, at least {{min_gap}} mm.
- Tell the user the critical gaps. Remove the debug output afterwards.

## Holes for metric screws

Clearance holes after ISO 273 and tap drills for coarse threads, in mm. The user chose the **{{hole_fit}}** column.

| Thread | Fine | Medium | Coarse | Tap drill |
|---|---|---|---|---|
| M2 | 2.2 | 2.4 | 2.6 | 1.6 |
| M2.5 | 2.7 | 2.9 | 3.1 | 2.05 |
| M3 | 3.2 | 3.4 | 3.6 | 2.5 |
| M4 | 4.3 | 4.5 | 4.8 | 3.3 |
| M5 | 5.3 | 5.5 | 5.8 | 4.2 |
| M6 | 6.4 | 6.6 | 7.0 | 5.0 |
| M8 | 8.4 | 9.0 | 10.0 | 6.8 |

## Counterbores for socket head screws

ISO 4762 (DIN 912), head flush, with some room around it:

| Thread | M2 | M2.5 | M3 | M4 | M5 | M6 | M8 |
|---|---|---|---|---|---|---|---|
| Counterbore Ø | 4.4 | 5.5 | 6.5 | 8.0 | 10.0 | 11.0 | 15.0 |
| Depth | 2.4 | 2.9 | 3.4 | 4.4 | 5.4 | 6.4 | 8.6 |

In CadQuery: `.cboreHole(diameter, cboreDiameter, cboreDepth)`. Countersunk screws (ISO 10642, 90°):
`.cskHole(diameter, cskDiameter, 90)`.

## Fits for machined parts (ISO 286)

- Shaft turning or sliding in a hole: H7/g6. Located, assembled by hand: H7/h6. Press fit: H7/p6.
- Model the nominal size and write the fit as a comment and in `NOTES.md` (`BORE = 8  # H7`). Do not build the
  tolerance band into the geometry.
