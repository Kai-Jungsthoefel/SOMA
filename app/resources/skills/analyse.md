---
title: Analysis
name: Analysis
summary: Overhang, wall thickness and gaps between parts as a value at every spot of the surface (soma analyze), as text and as a colored picture.
order: 30
category: Check and present
default: on-demand
when: you check printability, wall thickness or gaps between parts, or the user asks for an analysis
topics: Analyses; Workflow; Limits; Feedback
---
# Skill: Analysis

`soma analyze` computes a value at every spot of the surface, prints a summary per part and writes
`.soma/results/<name>.glb`. The user sees it in colour in the app (Analysis), you see it with `soma render --result`.

| Command | Value | Critical by default |
|---|---|---|
| `soma analyze overhang` | angle of downward faces from vertical (0 = wall, 90 = ceiling), faces on the bed excluded | above 45° |
| `soma analyze thickness` | wall thickness: distance from the surface to the opposite side of the material | below 1.2 mm |
| `soma analyze clearance` | gap in front of the surface to the next other part, negative inside another part | below 0.5 mm |

Options: `--threshold` (take it from the active skills: overhang, minimum wall, clearance, and say so), `--parts
"Lid,Housing"` (names or groups, default all own parts without references and purchased parts; a part name wins over a
group of the same name, `"Housing/"` is always the group), `--up z` for the print direction of overhangs, `--name` to
keep a second result of the same kind. Parts that touch (gap 0) are not critical, overlaps are. Values within the mesh
accuracy of the threshold count as exactly at the threshold, not critical (a 45° roof, a gap of exactly 0.2 mm).

## Workflow

1. `soma build`, then the analysis. Read the summary: range per part, critical area, worst value and where, then the
   largest critical spots with area, size and position (similar spots such as gear teeth as one line). For overhang
   it names a print direction with clearly less overhang if there is one; parts printed in different orientations
   need one run each (`--parts`, `--up`, `--name`).
2. `soma render --result thickness` (add `--view bottom` for another side) and open the picture: colours green (fine),
   yellow (close to the threshold), red (critical), legend at the bottom right.
3. Change the model, build, analyse again. Report numbers: "thinnest wall 1.4 mm (was 0.8 mm)".

## Limits

- One value per small triangle. Curved faces carry the mesh tolerance, a few hundredths of a millimetre.
- Thickness at sharp inner corners and on tiny features can be off. Check a suspicious spot before you change it.
  Narrow strips along sharp edges (tooth tips, the rim of a countersink) are thin by nature: judge them by their size.
- Clearance is measured along the surface normal: a gap at an angle (a cone in a hole) reads larger than it is.
- Overhang looks at the direction of the surface only. Bridges and small chamfers show as overhang, judge them with
  the skill for the process.
- No loads here: stresses and deflection under load are `soma analyze fem` (skill for FEM).

## Feedback from the user

`[Result: "Wall thickness" (.soma/results/thickness.glb, limit 1.20 mm), part "Lid": 0.80 mm at (12.0, -5.0, 26.0)
mm]`: the user clicked that spot. A markup may say `shows the result "Wall thickness"`: it shows the colours.
