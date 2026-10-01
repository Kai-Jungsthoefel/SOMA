---
title: Toleranzen und Passungen
name: Tolerances and fits
summary: Spiel als benannte Konstanten, Kollisionsprüfung im Code, Durchgangs- und Kernlöcher, Senkungen für Zylinderschrauben, ISO-Passungen.
order: 20
topics: Fertigung: {{process}}; Spiel als benannte Konstanten; Kollisionen und Abstände im Code prüfen; Durchgangslöcher ({{hole_fit}}) und Kernlöcher; Senkungen für Zylinderschrauben; ISO-Passungen für gefertigte Teile; Laser- und Blechteile
var process: unknown | | Fertigung | unknown=noch offen (Agent fragt), 3D printing=3D-Druck, CNC milling=CNC-Fräsen, laser cutting=Laserschneiden, sheet metal=Blech
var hole_fit: medium | | Durchgangslöcher nach ISO 273 | fine=fein, medium=mittel, coarse=grob
var min_gap: 0.2 | mm | Mindestabstand zwischen Teilen | 0..5
var kerf: 0.15 | mm | Spiel für Laserteile je Seite | 0..1
---
# Skill: Tolerances and fits

Every real part deviates from its nominal size. Design so that parts still fit when they do.

## General rules

- Manufacturing process set by the user in the app: **{{process}}**. If it is "unknown" and `NOTES.md` does not say how
  the parts are made (3D printing, CNC milling, laser cutting, sheet metal), ask. The clearances depend on it.
- Put every clearance, fit and allowance into a named constant at the top of `model.py` (`SCREW_CLEARANCE`, `LID_GAP`).
  Never hide them in expressions.
- Mating faces never share the exact same coordinate: leave a defined gap, or a defined overlap for a press fit.
- Parts that must not touch keep at least {{min_gap}} mm distance (`MIN_GAP = {{min_gap}}`).
- Dimension from the functional faces: a hole follows the part it has to meet, not an arbitrary outer edge.
- After building, check the critical gaps (measure them or compute them, see below) and tell the user the values.

## Checking clearances in code

- Interference: `a.intersect(b).val().Volume()` must be (close to) 0 for parts that must not touch, and for a part and
  a reference (`role="reference"`).
- Smallest gap between two shapes in mm: `a.val().distance(b.val())`, at least {{min_gap}} mm.
- Print such checks only while you work on them and remove the debug output afterwards.

## Holes for metric screws

Clearance holes after ISO 273 and tap drills (core holes) for coarse threads, in mm. The user chose the **{{hole_fit}}**
column. For printed parts the 3D printing skill adds to these values.

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

For ISO 4762 (DIN 912) screws, so that the head sits flush. Values in mm, with some room around the head. If the exact
standard matters, say which values you used.

| Thread | Head Ø | Counterbore Ø | Depth |
|---|---|---|---|
| M2 | 3.8 | 4.4 | 2.4 |
| M2.5 | 4.5 | 5.5 | 2.9 |
| M3 | 5.5 | 6.5 | 3.4 |
| M4 | 7.0 | 8.0 | 4.4 |
| M5 | 8.5 | 10.0 | 5.4 |
| M6 | 10.0 | 11.0 | 6.4 |
| M8 | 13.0 | 15.0 | 8.6 |

In CadQuery: `.cboreHole(diameter, cboreDiameter, cboreDepth)`. Countersunk screws (ISO 10642, 90°):
`.cskHole(diameter, cskDiameter, 90)`.

## Fits for machined parts (ISO 286)

- Shaft turning or sliding in a hole: H7/g6. Located, assembled by hand: H7/h6. Press fit: H7/p6.
- Model the nominal size. Write the fit as a comment next to the constant and in `NOTES.md` (`BORE = 8  # H7`). Do not
  build the tolerance band into the geometry.

## Laser-cut and sheet parts

- Slots and tabs: {{kerf}} mm clearance per side (`KERF_CLEARANCE = {{kerf}}`). Keep the material thickness as a constant.
