---
title: Strength and stiffness
name: Strength and stiffness
summary: Design rules without simulation: avoid notches, ribs instead of mass, short load paths, rough calculation with safety factor {{safety}}, material values, weight.
order: 23
category: Design knowledge
default: on-demand
when: a part carries load or must be stiff, strong or light
topics: Design rules; Rough calculation; Material values; Weight
var safety: 2 | | Safety factor | 1..10
---
# Skill: Strength and stiffness

Design for strength with rules and a rough calculation. To check a design under a real load, the skill for FEM
computes stresses and deflection (`soma analyze fem`). Safety factor from the app:
`SAFETY = {{safety}}`. For parts that carry people, hang overhead or lift loads, say clearly that a real calculation and
a test are needed.

## Design rules

- Inner corners in the load path get a radius of at least half the wall, at least 1 mm. Sharp corners are where parts
  break.
- Even walls. Change thickness gradually (taper about 1:3).
- Stiffness grows with the cube of the height: make a beam taller, not thicker. L, U and box sections, ribs and edges
  turned up are much stiffer than flat plates. Closed boxes resist twisting.
- Ribs: about 0.6 × the wall thick, up to 3 × the wall high, with a fillet at the base.
- Short, direct load paths. Bosses and mounting points are tied to walls with ribs, not free-standing.
- Holes and cut-outs where stress is low: near the middle of a bent beam, not at its edges or corners.
- Printed parts are weaker across the layers (FDM: about half).

## Rough calculation

When the user names a load: cantilever with force F at the free end, length L, rectangular section b × h (N, mm, MPa):

- Stress `6 × F × L / (b × h²)`, at most strength / `SAFETY`.
- Deflection `4 × F × L³ / (E × b × h³)`.

Put the numbers into the report and into `NOTES.md`.

## Material values (rough)

Strength: tensile strength for plastics and wood, yield strength for metals.

| Material | E (MPa) | Strength (MPa) | Density (g/cm³) |
|---|---|---|---|
| PLA, printed | 3500 | 45, across layers 20 | 1.24 |
| PETG, printed | 2000 | 40, across layers 20 | 1.27 |
| ABS / ASA, printed | 2000 | 30, across layers 15 | 1.05 |
| PA (nylon) | 1500 | 50 | 1.14 |
| POM | 3000 | 60 | 1.41 |
| Acrylic (PMMA) | 3200 | 60, brittle | 1.19 |
| Plywood (birch) | 8000 | 40 | 0.70 |
| Aluminium 6082 | 70000 | 250 | 2.70 |
| Steel S235 | 210000 | 235 | 7.85 |
| Stainless steel 1.4301 | 200000 | 210 | 7.90 |

## Weight

`mass_g = part.val().Volume() / 1000 * DENSITY` (volume in mm³, density in g/cm³). Printed parts weigh less because of
the infill.
