---
title: Components
name: Components
summary: Other SOMA models inside this one (a drawer in a workbench, a motor unit in a machine): insert linked or as a copy, set their parameters, place several instances by anchors, update linked ones.
order: 25
category: Design knowledge
default: on-demand
when: another SOMA model (.soma file or model folder) should become part of this one, or components/ exists
topics: Linked or copy; Inserting; Using in model.py; Sizes of a component; Instances and placing; Anchors; Updating; Changing a component; Moved originals; Export
---
# Skill: Components

A component is another SOMA model inside this one. It lives as a copy in `components/<folder>/` (its `model.py`,
`parts/`, `inputs/` and `parameters.json`), so this model keeps working when it is shared or the original is gone.

## Linked or copy

- **Linked** (default): the copy remembers its original. When the original is saved with changes, the app marks the
  component in the part tree and offers an update. Do not edit a linked component, change the original instead.
- **Copy** (`--copy`): independent. Edit it freely in `components/<folder>/`, the original is no longer involved.
- Ask the user which one when it is not clear. Linked fits parts shared by several products, a copy fits a part this
  product needs in its own variant.

## Inserting

```
soma component add "C:/Models/Drawer.soma"            # linked
soma component add ../drawer-folder --copy             # copy, from a model folder
soma component add Drawer.soma --name "Drawer small"   # second component from the same model
soma component list                                    # components, state, parameters, anchors
```

The user can also click Import in the app and choose a .soma file or a model folder, or drag one into the window. The app then adds
`add_part("Name", component("Name"))` at the end of `model.py`: place it properly (below).

## Using it in model.py

```python
import cadquery as cq
from soma import add_part, component, param

WIDTH = param(900.0, "Bench width", min=600, max=1500, unit="mm")

drawer = component("Drawer", WIDTH=WIDTH - 2 * 18)     # parameters by their constant name
drawer.loc = cq.Location((0, 0, 420))                  # place the whole component
add_part("Drawer", drawer, group="Drawers")
```

- `component("Name", **values)` returns an assembly. `add_part` makes every part of it a part of this model, in a
  group named like the `add_part` call (here `Drawers/Drawer`), with the component's own groups, colors and roles
  (its references stay references).
- `soma component list` shows the parameters of each component. A name it does not have stops the build with the
  list of the ones it has. Values not given are the component's own (its code and its `parameters.json`).
- The component runs in its own folder with its own `parts/`: its modules and parameters do not mix with this model's.
  Its parameters do not appear in the app's Parameters panel. Make the values the user should change parameters of
  this model and pass them on, as `WIDTH` above.
- A value of the wrong type stops the build. A value outside the component's range is used, with a warning.

## Sizes of a component

Read sizes from the returned assembly instead of guessing or looking for parts by name:

```python
drawer = component("Drawer", WIDTH=500)
drawer.metadata["soma_params"]          # all its parameter values as built: {"WIDTH": 500.0, "DEPTH": 400.0, ...}
drawer.metadata["soma_anchors"]["back"] # (point, x direction, normal) in the component's own coordinates
bb = drawer.toCompound().BoundingBox()  # its size before placing: bb.xlen, bb.ylen, bb.zlen, bb.zmin ...
```

Better still: anchors for the points that matter, then `place()` needs no numbers at all.

## Instances and placing

- One `component()` call per instance, each with its own name in `add_part`. Equal values are built only once.
- Place with `.loc`: `cq.Location((x, y, z))`, rotated `cq.Location((x, y, z), (0, 0, 1), 90)` (axis, degrees).
- Positions come from the dimensions of this model, not from typed numbers, so the components follow when sizes
  change: `cq.Location((0, 0, LEG_H + i * (DRAWER_H + GAP)))`.

```python
for i in range(COUNT):
    d = component("Drawer", WIDTH=INNER_W, HEIGHT=DRAWER_H)
    d.loc = cq.Location((0, FRONT_Y, BASE_Z + i * (DRAWER_H + GAP)))
    add_part(f"Drawer {i + 1}", d, group="Drawers")
```

- A part name that comes twice gets the instance in brackets: `Front (Drawer 2)`.
- One instance different from the others (round handles only in this cabinet): best a parameter of the component
  (`HANDLE="round"`, in its original, or in a copy). Only if that is not possible, change the returned assembly of that
  one instance, e.g. replace a part's shape: `next(c for c in d.children if c.name == "Handle").obj = round_handle`.

## Anchors

A model names the points where it attaches, the model that uses it puts them onto each other. No positions to
compute, and the parts stay together when a component changes its size.

In the component's model (the original, or a copy in `components/`):

```python
anchor("back", (0, DEPTH / 2, 0), normal=(0, 1, 0))   # point in this model, mm; normal optional (default +Z)
anchor("bottom", (0, 0, 0))
```

In the model that uses it:

```python
cabinet = component("Cabinet")
cabinet.loc = cq.Location((0, 0, LEG_H))
drawer = place(component("Drawer"), "back", cabinet, "slot 1", flip=True)   # place the target first
add_part("Cabinet", cabinet)
add_part("Drawer", drawer)
anchor("floor", (500, 0, 0))                    # an anchor of this model ...
place(component("Bin"), "bottom", "floor")      # ... as a target by its name
place(component("Bin"), "bottom", (500, 0, 0))  # or a point, or a cq.Location
```

- `place()` sets `.loc` of the component and returns it. Without normals it only moves. With normals it also turns:
  by default the two anchors point the same way, `flip=True` puts them face to face (a drawer back against the back
  wall of a cabinet: their normals point against each other). `x_dir=` in `anchor()` fixes the turn about the normal.
- `soma component list` shows the anchors of each component. Anchors named in a loop show as a pattern
  (`slot {i + 1}`): the names are `slot 1`, `slot 2`, ... An unknown name stops the build with the list.
- Add anchors to a linked component in its original (ask the user), to a copy in `components/<folder>/`.
- Anchors are not parts and are not drawn. Give a model anchors when it is meant to be used as a component.

## Updating

- `soma component list` shows `OUT OF DATE` when the original of a linked component changed. `soma component update`
  updates all of them (`soma component update "Drawer"` only one), then run `soma build` and check the result: new
  or renamed parameters of the component may need changes in `model.py`.
- Update only when the user asks for it or agrees. The app has an Update button for the user as well.
- A linked component that was changed in this model is not updated, the command says so. `--force` replaces the
  changes (they go into `.soma/component-backups/`), `soma component unlink "Drawer"` keeps them as a copy instead.

## Changing a component

- Copy: edit the files in `components/<folder>/` like this model's own, then `soma build` here.
- Linked: tell the user the change belongs in the original model (or unlink first, after asking).
- Remove a component: delete its `component()`/`add_part` lines, then `soma component remove "Drawer"` (its folder goes
  into `.soma/component-backups/`).
- The user can open the original in a second SOMA window (right-click the component in the tree or one of its parts
  in the viewer, "Open the original"), change and save it there: the Update note shows in this window.

## Moved originals

`original not found` in `soma component list`: the original was moved, renamed, or the model is on another computer.
The component keeps working with its copy. When the user tells you where the original is now:
`soma component relink "Drawer" "D:/Models/Drawer.soma"`. The list then shows whether an update is due. In the app the
user right-clicks the component: Find the original.

## Export

`soma cadquery export` (Export as CadQuery in the app) writes a model with components as a folder: `components/` goes
along and `soma_compat.py` runs them with plain CadQuery, anchors and `place()` included. The path of the original
stays out of the export.
