---
title: CadQuery scripts
name: CadQuery scripts
summary: Plain CadQuery scripts in SOMA: compatibility mode (show_object, ocp_vscode, result), converting them to add_part() and param(), and the block that "Export as CadQuery" writes.
order: 7
category: Way of working
default: on-demand
when: `soma build` reports "Compatibility mode", the model came from an existing CadQuery script, the code calls show_object() or ocp_vscode, or a file contains a "soma-compat" block
topics: Compatibility mode; Converting to add_part and param; Checking the conversion; Exported scripts
---
# Skill: CadQuery scripts

## Compatibility mode

SOMA also builds plain CadQuery scripts that do not call `add_part()`. `soma build` then takes the parts from:

1. `show_object(obj, name=..., options={"color": ..., "alpha": ...})` as in CQ-editor and cq-cli,
2. `show(...)`, `show_object(...)` and `show_all()` of ocp_vscode (SOMA puts a stand-in in place of the package, it opens no viewer),
3. otherwise the variable `result`.

The build reports this as a warning starting with "Compatibility mode". The model works in the app (viewer, measuring, section, click to code on the `show_object()` line). What it lacks: groups, roles (reference, purchased part), parameters in the Parameters panel, and clear part names when `show_object()` has no `name`. `debug()` objects are left out.

As soon as the script calls `add_part()` once, only the `add_part()` parts count and `show_object()` has no effect.

## Converting to add_part and param

Convert only when the user asks for it. The original script is kept in `inputs/` (the import copies it there), do not delete it.

- `show_object(box, name="Box", options={"color": (255, 0, 0)})` becomes `add_part("Box", box, color=(1.0, 0.0, 0.0))`. Colors in SOMA are 0..1, CQ-editor also takes 0..255 and color names. A part with `alpha` below 1 that is only there for orientation is usually a `role="reference"`.
- `show(a, b, names=["A", "B"])` of ocp_vscode becomes one `add_part()` per object. Remove `from ocp_vscode import ...` and calls like `set_port()` or `set_defaults()`.
- `result = ...` alone becomes `add_part("<a good name>", result)`.
- Every part needs a unique, meaningful name. Ask the user if the script does not say what a part is.
- Groups: `group="Housing"` for parts that belong together.
- Constants the user will want to change (length, wall, hole diameter) become `param(...)` with label, range and unit (skill "Parametric models"). Leave internal helper values as constants.
- Do not change the geometry while converting. Improvements come afterwards, as a step of their own.
- Imports: `from soma import add_part, param` at the top, `import cadquery as cq` stays.

## Checking the conversion

Build before and after (`soma build`) and compare `.soma/model.map.json`: the same number of parts, and for each part the same `bbox` and `volume` (rounded to 0.001). Tell the user if anything differs, and why.

## Exported scripts

"Export as CadQuery" in the app (Export menu, "As CadQuery script") writes the model as plain CadQuery that runs in CQ-editor, VS Code with ocp_vscode, cq-cli and plain Python, without soma:

- Each `from soma import ...` line stays as a comment `# soma-import: ...`. The first one is followed by a block between `# >>> soma-compat` and `# <<< soma-compat` that provides `add_part()`, `param()`, `import_step()`, `import_assembly()` and, if used, the standard parts (Apache License 2.0). A footer at the end shows the parts and sets `result` to the assembly.
- The values from the Parameters panel are in `_SOMA_VALUES` in the block. Only that line may change.
- A model with modules in `parts/` becomes a folder with `soma_compat.py` instead of the block.
- Animations, drawings and analyses stay in SOMA.

"New from CadQuery script" in the app brings such a script back: the markers turn into the original imports again and the values go to `parameters.json`. Never edit the block by hand, otherwise SOMA keeps it as it is (it still builds, then in compatibility mode). If you find a block in `model.py`, tell the user that importing the script through "New from CadQuery script" removes it cleanly.
