---
title: Blech
name: Sheet metal
summary: {{material}}, {{thickness}} mm, Innenradius {{bend_radius}} mm: Biegungen modellieren, Schenkel, Freistiche, Abstände zur Biegung, Abwicklung mit K-Faktor {{k_factor}}.
order: 14
category: Fertigungsverfahren
default: off
topics: Material und Dicke; Biegungen modellieren; Schenkel, Löcher, Freistiche; Abwicklung; Gewinde und Verbindungen
var material: steel | | Material | steel=Stahl (DC01), stainless steel=Edelstahl, aluminium=Aluminium
var thickness: 1.5 | mm | Blechdicke | 0.3..10
var bend_radius: 1.5 | mm | Innenradius der Biegung | 0..30
var k_factor: 0.4 | | K-Faktor | 0.2..0.5
---
# Skill: Sheet metal

The parts are cut and bent from sheet metal: **{{material}}**. The values apply unless the user says otherwise in the
chat or in `NOTES.md`. Constants at the top: `T = {{thickness}}` (thickness), `R = {{bend_radius}}` (inner bend radius),
`K = {{k_factor}}` (K-factor). R at least T, for aluminium at least 1.5 × T (ask for the alloy).

## Modeling bends

CadQuery has no sheet metal tools. Build the flanges as boxes of thickness T, join them and round the bend: inner edge
R, outer edge R + T. The thickness then stays T in the bend. Example, an L-bracket with outer sizes A (along X), B
(along Z) and width W:

```python
a = cq.Workplane("XY").box(A, W, T, centered=(False, True, False))
b = cq.Workplane("XY").box(T, W, B, centered=(False, True, False))
part = (a.union(b)
        .edges(cq.selectors.NearestToPointSelector((T, 0, T))).fillet(R)
        .edges(cq.selectors.NearestToPointSelector((0, 0, 0))).fillet(R + T))
```

## Rules

- Constant thickness T everywhere, the same radius R for all bends, preferably 90°.
- Flanges at least 4 × T + R long (outside size).
- Holes at least T in diameter, at least 2 × T from an edge and 2.5 × T + R from a bend, otherwise they deform.
- A bend that ends inside the sheet needs a relief notch: T wide, R + T deep. Where two flanges meet at a corner,
  leave a gap of at least T.
- Bent dimensions vary by about ±0.5 mm and ±1°: precise hole patterns on one flange, not across a bend.

## Flat pattern

- Flat length = straight parts + for each bend `angle / 180 × π × (R + K × T)`. For 90° bends, the straight part of a
  flange is its outside size − (R + T) per bend. Write the flat size into `NOTES.md`.
- Most sheet metal services unfold the STEP themselves: ask the user. If a DXF is needed: constant `FLAT = False`, with
  `FLAT = True` the flat blank is registered lying on XY instead of the bent part. Set it, `soma build`,
  `soma export "Bracket" --format dxf`, set it back, build again. Note the bend lines in `NOTES.md`.

## Threads and joints

- Tapped holes only if T is at least 3 thread pitches (M3 1.5 mm, M4 2.1 mm, M5 2.4 mm). Otherwise press-in nuts or
  rivet nuts: note the type in `NOTES.md`.
- Join sheets with screws, rivets or tabs and slots. Welding only if the user asks for it.
