---
title: Parametric models
name: Parametric models
summary: Design intent first, at most {{max_params}} driving parameters, everything else derived, ranges in which every value builds, features that survive changes, ranges checked at both ends.
order: 3
category: Way of working
default: always
when: you create a model, add or change param() values, or the user wants a model they can adjust or reuse
topics: Design intent; Choosing the parameters; Ranges that always build; Derive everything else; Robust to change; Fields in the panel; Checking the ranges ({{check}}); Changing parameters later
var max_params: 15 | | Parameters at most | 3..40
var check: full | | Range check | full=every parameter at both ends, main=main dimensions and choices only, off=only when the user asks
---
# Skill: Parametric models

The user changes `param()` values in the Parameters panel without you. Every value inside the ranges you set must give
a valid, sensible part that changes the way the user expects.

## Design intent

Decide first, and write it as a comment above the parameters:

- **What drives the size:** contents, installation space, the hole pattern of a mating part, a standard.
- **What stays put:** the mounting face, the axis, the hole pattern. Put the origin there: a longer bracket then grows
  away from the wall, and its wall holes stay where they are.
- **Inside or outside:** a box for a board is defined by its inner size, a part for a slot by its outer size. Use the
  size the user knows.

## Choosing the parameters

- Parameters: main dimensions in the user's terms, counts, variants (switches, choices), fit values the user tunes
  after a test part, positions that show motion (angle, stroke: they move parts, never change their shape).
- At most {{max_params}}. With more candidates, ask which ones the user wants to change.
- Plain constants: derived values, helper geometry, sizes from datasheets, standards and files in `inputs/` (take them
  from `BoundingBox()`), manufacturing rules such as the minimum wall.
- **Independent:** no two parameters that must agree. Of outer width, inner width and wall, only two are parameters.
- **The default decides the field:** dimensions as float (`60.0`), counts as int (`4`). `param(60, ...)` only takes
  whole numbers.
- **Discrete values as a choice** (screw size, sheet thickness, bearing), the choice picks a row of a table:

```python
# Plate on XY, bearing axis on Z. The hole rows grow with the length, the seat follows the bearing.
LENGTH = param(160.0, "Plate length", min=100, max=300, step=1, unit="mm", group="Plate")
HOLES = param(2, "Holes per side", min=1, max=6, group="Plate")
BEARING = param("608", "Bearing", options=["608", "6000", "6001"], group="Shaft")

EDGE, HOLE_D, MIN_WEB = 8.0, 5.5, 3.0
BORE, BEARING_OD, BEARING_W = {"608": (8, 22, 7), "6000": (10, 26, 8), "6001": (12, 28, 8)}[BEARING]
PITCH = ((LENGTH - BEARING_OD) / 2 - 2 * EDGE) / HOLES  # derived, never a second parameter
if PITCH < HOLE_D + MIN_WEB:
    raise ValueError(f"{HOLES} holes per side do not fit into a plate of {LENGTH:g} mm: fewer holes or a longer plate")
```

## Ranges that always build

- Every number gets `min` and `max`: what makes sense for function and manufacturing, not as wide as possible. The
  default is a typical value, not an end of the range.
- **Choose parameters whose ranges do not depend on each other:** inner size and wall instead of outer size and wall,
  a count with the pitch derived instead of count and pitch.
- A combination that still cannot work: check it below the parameters and stop with a message in the user's terms
  (example above). Never shrink a value silently, only cosmetic radii may adapt (`R = min(EDGE_R, WALL * 0.8)`).
- Counts at their ends: `1` must not divide by `n - 1`, `0` only if it means "none" and the code handles it.

## Derive everything else

- **One source of truth:** mating parts use the same parameter plus a named clearance (`LID_IN = BODY_OUT + 2 * FIT`).
- Feature positions are computed from parameters (a list for `pushPoints`), never typed coordinates.
- **Do not scale everything with the size:** walls, holes, screws and radii follow function and manufacturing. A box
  twice as long keeps its 2 mm wall and its M3 screws.

## Robust to change

When a parameter changes the number of holes or faces, "the third edge" or `>X[2]` is a different edge.

- Create features at computed positions (sketch, `pushPoints`, a tool body) instead of selecting existing edges. Select
  by direction and position (`edges("|Z")`, `NearestToPointSelector` at a computed point) or by tag, never by index
  where the count depends on a parameter. Check the count of a selection before a fillet or cut.
- Optional features (`if WITH_EARS:`) are whole bodies, added or cut at the end of their part.
- Keep the checks of each part (`isValid`, number of solids, critical gaps) in the code as `assert` with a message: a
  value that breaks a part then fails the build instead of giving a broken model.
- Every change in the panel rebuilds the whole model: keep it fast.

## Fields in the panel

- `label` in the user's words and language, saying what is measured ("Inner length", not "L"). `unit="mm"` or
  `"deg"`. `step` as fine as it matters: 0.1 mm for walls and fits, 1 mm for main dimensions, 5 or 15 deg for angles.
- `group` by function or part ("Housing", "Mounting", "Fit", "Motion"). The order in the code is the order in the
  panel, the most important first. `help` when the label is not enough ("Measured inside, the outer size adds 2 x wall").
- **The constant name is the key in `parameters.json`.** Renaming a parameter leaves the user's value behind. If its
  meaning changes (inner to outer size), give it a new name, or the old value applies to the new meaning. Tell the user.

## Checking the ranges

Range check: **{{check}}**. "full": every parameter. "main": main dimensions, counts and choices. "off": only when the
user asks.

After adding parameters or changing ranges, build at the ends of the ranges. Never write the user's `parameters.json`
for this, the app would rebuild with the test values:

1. Copy the project to a temporary folder outside it, without `.git`, `.soma`, `output`, `exports` and `renders`.
2. Per case write `parameters.json` into the copy (`{"values": {"WALL": 4.0}}`, the rest keeps the defaults) and run
   `soma build --project <copy>`. Loop over the cases in a short script.
3. Cases: each number at `min` and at `max`, every option, every switch flipped, then all dimensions at `min` together
   and all at `max` together.
4. Each parameter alone at its ends must give "Build ok", combinations may stop with your message. Fix the rest
   (better parameters, a narrower range, a message), delete the copy and tell the user which ranges you narrowed.

## Changing parameters later

- Values the user set differ from the code: read the `soma build` line "set by the user in the app" first. A new value
  for one of them: AGENTS.md, rule 7.
- A parameter that is no longer needed: remove it. `soma build` then reports the user's value as unused, the user
  removes it in the panel.
- Report new or changed parameters: name, range, what grows and what stays put.
