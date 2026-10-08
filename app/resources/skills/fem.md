---
title: Strength with FEM
name: Strength with FEM
summary: Stresses, safety factor and deformation under load with the finite element method (soma analyze fem), load case as a Python file, colored result in the app.
order: 32
category: Check and present
default: on-demand
when: a part carries a real load and the user wants to know whether it holds, where it is weakest or how far it bends
topics: Load case; Compute and read; Check the result; Limits; Feedback
var safety: 2 | | Safety factor | 1..10
---
# Skill: Strength with FEM

`soma analyze fem <study.py>` computes stresses and deflection of parts under load (linear-elastic finite elements) and
colours the surface by the safety factor: strength divided by the von Mises stress. Required safety from the app:
`SAFETY = {{safety}}`. Red is below it, yellow just above, green fine. Units: mm, N, MPa (= N/mm²).

Use it after the design rules and the rough calculation of the strength skill, not instead of them. For parts that carry
people, hang overhead or lift loads, still say clearly that a real calculation and a test are needed.

## The load case

One file per load case in `analyses/`, for example `analyses/bracket.py`:

```python
from soma.fem import Study

study = Study("Bracket, 5 kg on the arm", material="PETG", safety=2)
study.fix("Bracket", faces="<Z")                       # held: the screwed-on bottom face
study.force("Bracket", faces=">X", N=(0, 0, -49))      # total force on the face, spread evenly
```

- `Study(title, material="PLA", safety=2, mesh=None, across_layers=True, parts=None)`. Materials: PLA, PETG, ABS, ASA,
  PA, POM, PMMA, Plywood, Aluminium 6082, Steel S235, Stainless 1.4301, or your own `dict(E=, nu=, strength=, density=)`
  (MPa, g/cm³). Printed plastics use the strength across the layers unless `across_layers=False`.
  `study.set_material("Shaft", "Steel S235")` for one part.
- Parts are named as in `add_part`. All parts in one study are meshed together and **bonded where they touch** (glued,
  no sliding, no gaps). Leave out parts that only bear on each other and replace them by `fix` and loads.
  `parts=["Cover"]` adds a part without loads.
- Faces: `faces=` takes a CadQuery selector on the part in its place in the model (`">Z"`, `"<X"`, `"%CYLINDER"`,
  `">Z[-2]"`), or a list of them. `near=(x, y, z)` takes the face closest to a point, also within the selected faces.
  When the user clicked a spot, use its coordinates with `near=`.
- `study.fix(part, faces=..., axes="xyz")` holds the faces. `axes="z"` holds only in Z (a part resting on a table).
  Every body needs enough support against moving and turning, otherwise the command says what is still free.
- `study.force(part, N=(fx, fy, fz), faces=...)`: total force in N. 1 kg weighs 9.81 N.
- `study.pressure(part, MPa=..., faces=...)`: pressure normal to the faces, positive presses into the material.
  0.1 MPa = 1 bar.
- `study.gravity()`: the weight of the parts themselves (`direction="-z"`).

Model a screw by holding the face under its head or the inside of its hole. Put a load where it really acts: on the
face the hand, the shelf or the shaft touches, not on a whole side.

## Compute and read

1. `soma build`, then `soma analyze fem analyses/bracket.py`. Takes from seconds to about a minute. The summary lists the
   load case with areas (check them: wrong faces are the most common mistake), the support forces, per part the highest
   stress, smallest safety and largest deflection with their positions, the critical spots, then the checks.
2. `soma render --result bracket` and open the picture: colours by safety, the load case in blue (held faces strong,
   loaded faces light, forces as arrows), the deflection exaggerated as the legend says. Check that it bends the way you
   expect. A part that bends the wrong way has the wrong load or support.
3. Change the design, build, compute again. Report numbers: "smallest safety 2.4 (was 0.9), highest stress 8.3 MPa,
   deflection 0.6 mm at the tip".

## Check the result

- **Support forces** must carry the loads ("in equilibrium"). If a support force is far from what you expect, the
  wrong faces are held.
- **Mesh check:** every run computes a second time with a coarser mesh. If the highest stress changes by more than 15 %,
  it says so: the peak sits at a sharp inner corner or at the edge of a support or load. There the value grows without
  limit with finer meshes. Add a fillet if it is a real corner, otherwise judge the stress a little away from it.
- `Study(..., mesh=1.0)` sets the element size in mm for thin walls or small details (default: about 1/30 of the size).
  Finer is slower.
- A large deflection (over 5 % of the size) is reported: then the linear calculation is only rough.

## Limits

- Linear-elastic: no yielding, no buckling, no contact, no sliding, no pre-tension of screws, no creep of plastics.
- Bonded parts, no joints. Bearings, hinges and screws are only modelled through supports and loads.
- Even materials: printing infill, layer direction and wood grain are not modelled. Printed parts are therefore computed
  with the weaker strength across layers. Infill below 100 % makes them weaker still.
- Static loads only. Impacts, vibration and fatigue need more safety or a test.

## Feedback from the user

`[Result: "Bracket, 5 kg on the arm" (.soma/results/bracket.glb, limit 2.00), part "Bracket": safety factor 0.90
(22.2 MPa, displacement 0.412 mm) at (12.0, -5.0, 26.0) mm]`: the user clicked that spot. The point is in the
undeformed model.
