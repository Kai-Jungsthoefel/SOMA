---
title: Clean modeling (CadQuery)
name: Clean CadQuery modeling
summary: Parameters at the top, one function per part, a fixed order of operations, robust selectors, avoiding typical errors, checking every part.
order: 2
category: Way of working
default: always
when: you write or restructure CadQuery code
topics: Parameters and structure; Order of operations; Selectors; Typical errors; Check every part; Fast builds
---
# Skill: Clean CadQuery modeling

## Parameters and structure

- Base dimensions are named constants at the top of `model.py`, everything else is derived (`INNER_W = WIDTH - 2 *
  WALL`). Never type the same number twice.
- The base dimensions the user would want to change themselves become `param()` with a range in which the model works
  (`WIDTH = param(40.0, "Width", min=20, max=80, unit="mm")`), see AGENTS.md. Derived values never do.
- One function per part (`def make_lid(): ... return lid`), the `add_part` calls at the end of `model.py`. Move parts
  into `parts/` when `model.py` grows beyond about 200 lines. The constants then move to `parts/params.py`, imported
  by `model.py` and the part modules.
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
- No helical threads: model the hole (clearance hole or tap drill) and name the thread in a comment.

## Check every part

```python
s = part.val()
assert s.isValid() and len(part.solids().vals()) == 1
bb = s.BoundingBox()  # compare bb.xlen, bb.ylen, bb.zlen with the intended size
```

Several solids where you expect one: the pieces do not overlap where they should be joined.

Check each part once, where it is registered, not again in helper functions: on large freeform parts `isValid()`
can cost as much as building them.

## Fast builds

`soma build` prints how long the build took, `timings.model` in `.soma/build.json` the time of your code alone. When
a build takes longer than a minute:

- Cut or join many bodies in one call: `pushPoints(...).hole(d)`, or collect the tools as shapes and cut them at
  once, `body.cut(cq.Compound.makeCompound(tools))` on a Workplane, `shape.cut(*tools)` and `first.fuse(*rest)` on
  shapes. A loop of single cuts or unions is 20 to 40 times slower.
- Build identical parts once and place copies with `.moved(cq.Location((x, y, z)))` instead of rebuilding each.
- Do not fuse what are separate pieces in reality (chain links, planks, a row of bolts): register them as one part
  from `cq.Compound.makeCompound([...])` or as single parts in a group. Fusing bodies that only touch is slow and
  fragile.
- Fillet all edges of a part in one call. For a pattern of pockets, fillet the tool once before cutting.
- Clip or intersect with a large freeform body only the parts that stick out: compare bounding boxes first.
- Cache helpers that build the same geometry several times in one run with `functools.lru_cache`.
