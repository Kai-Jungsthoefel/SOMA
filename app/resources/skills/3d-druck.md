---
title: 3D-Druck (FDM)
name: 3D printing (FDM)
summary: Druckbare Wandstärken, Überhänge bis {{overhang}}°, Spiel für Passungen, Ausrichtung auf dem Druckbett, Gewinde über Einschmelzmuttern.
order: 10
category: Fertigungsverfahren
default: on-demand
when: the parts will be 3D printed on a filament printer (FDM)
topics: Drucker und Material; Wände und kleine Details; Überhänge und Brücken; Ausrichtung und Bauraum; Spiel und Passungen; Schrauben und Gewinde; Prüfen und Export
var material: PLA | | Material | PLA, PETG, ABS, ASA, TPU
var nozzle: 0.4 | mm | Düse | 0.1..1.2
var layer: 0.2 | mm | Schichthöhe | 0.04..0.8
var bed_x: 220 | mm | Bauraum X | 30..2000
var bed_y: 220 | mm | Bauraum Y | 30..2000
var bed_z: 250 | mm | Bauraum Z | 30..2000
var overhang: 45 | ° | Max. Überhangwinkel | 10..85
var bridge: 10 | mm | Max. Brücke ohne Stütze | 0..200
var min_wall: 1.2 | mm | Mindestwand | 0.2..20
var clearance: 0.3 | mm | Spiel je Seite (Gleitpassung) | 0..3
---
# Skill: 3D printing (FDM)

The parts are printed on a filament printer (FDM). Settings from the app, they apply unless the user says otherwise
in the chat or in `NOTES.md`:

| Setting | Value |
|---|---|
| Material | {{material}} |
| Nozzle | {{nozzle}} mm |
| Layer height | {{layer}} mm |
| Build volume | {{bed_x}} × {{bed_y}} × {{bed_z}} mm |
| Max. overhang without support | {{overhang}}° from vertical |
| Max. bridge without support | {{bridge}} mm |
| Minimum wall | {{min_wall}} mm |
| Clearance per side for sliding fits | {{clearance}} mm |

Constants at the top of `model.py` (or in `parts/params.py`): `NOZZLE = {{nozzle}}`, `CLEARANCE = {{clearance}}`, `MAX_OVERHANG = {{overhang}}`,
`BED = ({{bed_x}}, {{bed_y}}, {{bed_z}})`.

## Walls and small features

- Walls at least {{min_wall}} mm, more where the part carries load or holds screws. Prefer multiples of the nozzle width.
- No feature thinner than two nozzle widths, no gap narrower than 0.5 mm, no pin thinner than 2 mm.
- Text: at least three layers high or deep, letters at least 5 mm tall.

## Overhangs and bridges

- Overhangs up to {{overhang}}° from vertical (0° is a vertical wall, 90° a flat ceiling) print without support. Avoid
  shapes that need support, or say where they do.
- Bridges (flat ceilings between two walls) up to {{bridge}} mm are fine.
- Horizontal holes: pointed (teardrop) or flat top instead of round when the top would overhang too much.
- Edges on the bed: chamfer 0.5 to 1 mm, no fillet. A fillet there is an overhang, the chamfer also hides the
  squashed first layer.

## Orientation and size

- Largest flat face on the bed. Say which orientation you assume.
- Layers are the weak direction (about half the strength). Loads run along the layers, snap hooks and clips lie flat.
- Parts larger than the build volume: split them (alignment pins or a lap joint), each piece its own `add_part`.
- One `add_part` per printed body.

## Material

PLA: stiff, soft above about 55 °C. PETG: tougher, add 0.1 mm to sliding clearances. ABS and ASA: shrink and warp,
round the corners of large flat parts. TPU: flexible, thicker walls, no press fits.

## Fits and clearances

- Sliding or turning: {{clearance}} mm per side. Loose: add 0.1 mm. Press fit: 0.1 mm or less, suggest a test print.
- Printed holes come out 0.1 to 0.2 mm small: model screw holes 0.2 mm larger than the nominal clearance hole.
- Mating faces never touch with zero gap.

## Screws and threads

- No printed metric threads below M6: heat-set inserts or self-tapping screws.
- Heat-set inserts (short ones), hole Ø: M2 3.2, M2.5 3.6, M3 4.0, M4 5.6, M5 6.4 mm, depth insert length + 1 mm.
  Makers differ: note your assumption in `NOTES.md`.
- Self-tapping screws for plastic (about 3 mm): hole Ø 2.5 mm.
- Screw bosses: outer Ø at least 2.5 × the hole, joined to a wall or ribs.

## Checks before you finish

Rotate a copy of each part into print orientation (bed at Z = 0), then:

```python
import math
bb = part.val().BoundingBox()
assert bb.xlen <= BED[0] and bb.ylen <= BED[1] and bb.zlen <= BED[2]

def overhang_faces(part):
    """Flat faces pointing down more than MAX_OVERHANG, not on the bed: bridges or support."""
    s = part.val()
    zmin, lim = s.BoundingBox().zmin, -math.sin(math.radians(MAX_OVERHANG))
    return [f for f in s.Faces() if f.geomType() == "PLANE" and f.normalAt().z < lim and f.Center().z > zmin + 0.01]
```

Curved faces (holes, fillets underneath) are not covered here. `soma analyze overhang --threshold {{overhang}}` and
`soma analyze thickness --threshold {{min_wall}}` check every spot, curved faces too (skill for analysis). Export each
printable part as STL or 3MF: `soma export "Lid" --format 3mf`. References are not printed.
