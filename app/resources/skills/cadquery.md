---
title: Sauber modellieren (CadQuery)
name: Clean CadQuery modeling
summary: Parameter oben, ein Teil je Funktion, feste Reihenfolge der Schritte, robuste Selektoren, typische Fehler vermeiden, jedes Teil prüfen.
order: 2
category: Arbeitsweise
default: always
when: you write or restructure CadQuery code
topics: Parameter und Aufbau; Reihenfolge der Schritte; Selektoren; Typische Fehler; Jedes Teil prüfen
---
# Skill: Clean CadQuery modeling

## Parameters and structure

- Base dimensions are named constants at the top, everything else is derived (`INNER_W = WIDTH - 2 * WALL`). Never
  type the same number twice.
- One function per part (`def make_lid(): ... return lid`), the `add_part` calls at the end of `model.py`. Move parts
  into `parts/` when `model.py` grows beyond about 200 lines.
- Build each part around a sensible origin (mounting face on XY, symmetric parts centered), then place it with
  `.translate()` and `.rotate()`.

## Order of operations

1. Base solid: `box`, `extrude`, `revolve`.
2. Additions and cuts: bosses, pockets, openings.
3. Holes: `hole`, `cboreHole`, `cskHole`, many at once with `pushPoints`.
4. Fillets and chamfers last, only on edges you selected precisely.

## Selectors

- Select while the part is still simple and check the count: `assert body.edges("|Z").size() == 4`.
- On complex parts use `.tag("name")` and `workplaneFromTagged("name")` instead of long selector chains.
- One specific edge or face: `cq.selectors.NearestToPointSelector((x, y, z))`.

## Typical errors

- Fillet fails (`StdFail_NotDone`, `command not done`): radius too large for the adjacent faces. Use a smaller radius
  or fewer edges at once.
- Cutting tools that end exactly on a face leave skins or fail: let them run through by at least 0.1 mm. Bodies that
  are joined overlap a little instead of touching.
- Many single cuts in a loop are slow: one tool with `pushPoints`, or union the tools first.
- No helical threads: model the hole (clearance hole or tap drill) and name the thread in a comment.

## Check every part

```python
s = part.val()
assert s.isValid() and len(part.solids().vals()) == 1
bb = s.BoundingBox()  # compare bb.xlen, bb.ylen, bb.zlen with the intended size
```

Several solids where you expect one: the pieces do not overlap where they should be joined.
