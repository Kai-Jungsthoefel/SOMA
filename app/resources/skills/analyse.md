---
title: Analyse
name: Analysis
summary: Überhang, Wandstärke und Spalt zwischen Teilen als Wert an jeder Stelle der Oberfläche (soma analyze), als Text und farbiges Bild.
order: 30
category: Prüfen und Zeigen
default: on-demand
when: you check printability, wall thickness or gaps between parts, or the user asks for an analysis
topics: Auswertungen; Ablauf; Grenzen; Rückmeldung
---
# Skill: Analysis

`soma analyze` computes a value at every spot of the surface, prints a summary per part and writes
`.soma/results/<name>.glb`. The user sees it in colour in the app (Analyse), you see it with `soma render --result`.

| Command | Value | Critical by default |
|---|---|---|
| `soma analyze overhang` | angle of downward faces from vertical (0 = wall, 90 = ceiling), faces on the bed excluded | above 45° |
| `soma analyze thickness` | wall thickness: distance from the surface to the opposite side of the material | below 1.2 mm |
| `soma analyze clearance` | gap in front of the surface to the next other part, negative inside another part | below 0.5 mm |

Options: `--threshold` (take it from the active skills: overhang, minimum wall, clearance, and say so), `--parts
"Lid,Housing"` (names or groups, default all own parts without references and purchased parts), `--up z` for the
print direction of overhangs, `--name` to keep a second result of the same kind. Parts that touch (gap 0) are not
critical, overlaps are.

## Workflow

1. `soma build`, then the analysis. Read the summary: range per part, critical area, worst value and where.
2. `soma render --result thickness` (add `--view bottom` for another side) and open the picture: colours green (fine),
   yellow (close to the threshold), red (critical), legend at the bottom right.
3. Change the model, build, analyse again. Report numbers: "thinnest wall 1.4 mm (was 0.8 mm)".

## Limits

- One value per small triangle. Curved faces carry the mesh tolerance, a few hundredths of a millimetre.
- Thickness at sharp inner corners and on tiny features can be off. Check a suspicious spot before you change it.
- Clearance is measured along the surface normal: a gap at an angle (a cone in a hole) reads larger than it is.
- Overhang looks at the direction of the surface only. Bridges and small chamfers show as overhang, judge them with
  the skill for the process.
- No strength analysis: loads and stresses need the skill for strength.

## Feedback from the user

`[Ergebnis: "Wandstärke" (.soma/results/thickness.glb, Grenzwert 1.20 mm), Bauteil "Lid": 0.80 mm bei (12.0, -5.0,
26.0) mm]`: the user clicked that spot. A marking may say `zeigt das Ergebnis „Wandstärke“`: it shows the colours.
