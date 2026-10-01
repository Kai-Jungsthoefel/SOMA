---
title: Normteile
name: Standard parts
summary: Maße von Schrauben, Muttern, Scheiben, Kugellagern, Passstiften und Alu-Profilen, Mutternfallen, Normteile im Modell.
order: 22
category: Konstruktionswissen
default: off
topics: Schrauben, Muttern, Scheiben; Mutternfallen; Kugellager; Passstifte und Profile; Normteile im Modell
---
# Skill: Standard parts

Nominal sizes in mm. Real parts vary: if the user has the parts, ask them to measure what matters. Other purchased
parts (motors, switches, displays): never guess, ask for a datasheet or a STEP file.

## Screws, nuts, washers

| Thread | Pitch | Socket head ISO 4762 Ø × height | Hex key | Countersunk ISO 10642 head Ø | Nut ISO 4032 across flats × height | Washer ISO 7089 Ø × thickness |
|---|---|---|---|---|---|---|
| M2 | 0.4 | 3.8 × 2 | 1.5 | – | 4 × 1.6 | 5 × 0.3 |
| M2.5 | 0.45 | 4.5 × 2.5 | 2 | – | 5 × 2 | 6 × 0.5 |
| M3 | 0.5 | 5.5 × 3 | 2.5 | 6.7 | 5.5 × 2.4 | 7 × 0.5 |
| M4 | 0.7 | 7 × 4 | 3 | 9.0 | 7 × 3.2 | 9 × 0.8 |
| M5 | 0.8 | 8.5 × 5 | 4 | 11.2 | 8 × 4.7 | 10 × 1 |
| M6 | 1 | 10 × 6 | 5 | 13.4 | 10 × 5.2 | 12 × 1.6 |
| M8 | 1.25 | 13 × 8 | 6 | 17.9 | 13 × 6.8 | 16 × 1.6 |

## Nut traps

`polygon()` takes the diameter across the corners, not across the flats. Hexagonal pocket for a nut with across flats
`AF`, corners pointing along X, depth nut height + 0.2 mm:

```python
.polygon(6, (AF + 2 * CLEARANCE) / math.cos(math.radians(30))).cutBlind(-(NUT_H + 0.2))
```

## Ball bearings (d × D × width)

- 623: 3 × 10 × 4, 624: 4 × 13 × 5, 625: 5 × 16 × 5, 626: 6 × 19 × 6, 608: 8 × 22 × 7, 688: 8 × 16 × 5.
- 6000: 10 × 26 × 8, 6001: 12 × 28 × 8, 6002: 15 × 32 × 9, 6200: 10 × 30 × 9, 6201: 12 × 32 × 10.
- Shoulders: on the shaft about d + 0.2 × (D − d), in the housing about D − 0.2 × (D − d).
- Machined seats: housing H7, shaft k6. Printed seats: start with D and adjust after a test print.

## Pins and profiles

- Dowel pins ISO 8734 (m6): Ø 2, 3, 4, 5, 6, 8 mm, lengths 6, 8, 10, 12, 16, 20 mm and more. Holes H7.
- Aluminium extrusions, typical: 2020 slot 6 with M5, 3030 slot 8 with M6, 4040 slot 8 with M8. Systems differ: ask
  which one.

## In the model

Purchased parts may be modeled simplified (screw: head and shank without thread, bearing: a ring) with
`group="Hardware"` and `role="reference"`: visible and checked for collisions, but not exported. List them in the
parts list in `NOTES.md`.
