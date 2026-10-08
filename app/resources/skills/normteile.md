---
title: Standard parts
name: Standard parts
summary: Screws, nuts, washers and threaded inserts from soma.fasteners with matching holes, nut traps, sizes of ball bearings, dowel pins and aluminium extrusions.
order: 22
category: Design knowledge
default: always
when: the model needs screws, nuts, washers, threaded inserts, bearings, dowel pins or profiles
topics: Screws, nuts, washers and inserts with soma.fasteners; Position and holes; Nut traps; Ball bearings; Pins and profiles; Standard parts in the model
---
# Skill: Standard parts

Nominal sizes in mm. Real parts vary: if the user has the parts, ask them to measure what matters. Other purchased
parts (motors, switches, displays): never guess, ask for a datasheet or a STEP file.

## Screws, nuts, washers, inserts: `soma.fasteners`

Never model them by hand. `soma.fasteners` builds them simplified (no thread) with dimensions from standard tables and
brings the matching holes as tools for `cut()`:

```python
from soma.fasteners import Screw, Nut, Washer, HeatSetInsert, pick_length

s = Screw("ISO 4762", "M3x10", at=(20, 15, LID_TOP))  # head rests on the surface at `at`, shank along -Z
lid = lid.cut(s.clearance_hole())                      # ISO 273 fit="medium", oversize=0.2 for printed holes
ins = HeatSetInsert("M3x5.7", at=(20, 15, BOSS_TOP))   # top flush with `at`
base = base.cut(ins.hole())                            # or base.cut(s.tap_hole()) for a tapped hole
add_part("Screw 1", s, group="Hardware")               # role "hardware" automatically
```

- Position: `at` is the point on the axis where the part rests, `direction` (default `"-Z"`) points from there into
  the material. With `at=(x, y), on=lid` the surface is found along `direction`. `sunk=True` sinks a head, nut or
  washer flush with `at` (the hole gets the counterbore). Countersunk screws, set screws and inserts always sit flush.
- Moving: `s.rotate(p1, p2, angle)`, `s.translate((x, y, z))` and `s.moved(loc)` return a moved copy, like CadQuery
  shapes. Build a moving part with its screws in one place, then move both the same way.
- Other end: `s.point(d)` is the point `d` mm from the seat along the axis, `.outer` the opposite face. Under a plate
  of thickness `T`: `w = Washer("ISO 7089", "M3", at=s.point(T), direction="+Z")`, then
  `Nut("ISO 4032", "M3", at=w.outer, direction="+Z")`.
- Standards: screws ISO 4762 (socket head, the default), ISO 7380 (button head, low), ISO 10642 (countersunk),
  ISO 4017, ISO 4014, DIN 931 (hex head), ISO 4026 (set screw). Nuts ISO 4032, thin ISO 4035, high ISO 4033, square
  DIN 557. Washers ISO 7089, large ISO 7093 on soft material. Inserts by ruthex (default), CNCKitchen, McMaster-Carr,
  Hilitchi. In prints, heat-set inserts instead of nuts where the screw is opened often.
- Read sizes from the objects instead of typing numbers: `s.head_diameter`, `s.head_height`, `s.key`, `s.clearance()`,
  `nut.key`, `nut.height`, `ins.diameter`, `ins.length`.
- Only standard lengths: `pick_length("ISO 4762", "M3", min_length, max_length)` returns the shortest that fits.
  Through a nut at least grip + washers + nut height + 2 × pitch, into an insert between grip + half and grip + the
  whole insert length.
- Cut each hole only from the part it belongs to. All options are in the docstrings of the file
  `python -c "import soma.fasteners as f; print(f.__file__)"` prints.

## Nut traps

`nut.trap(clearance=0.2)` is the pocket for the nut, open to the surface with `sunk=True`. With `slot="+X",
slot_length=…` the nut slides in from the side. At `angle=0` two flats are parallel to X, so a slot along X is exactly
as wide as the nut. For a slot along Y use `angle=30`.

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

Parts from `soma.fasteners` get `role="hardware"` by themselves: opaque, part of `output/model.step`, skipped by
`soma export --all`. Model other purchased parts (bearings, pins) simplified, also with `role="hardware"`. A heat-set
insert is wider than its hole (it is melted in): leave it out of interference checks with its part. List every part
in `NOTES.md` (`s.designation` gives "ISO 4762 M3x10", `ins.part_number` the manufacturer's number).
