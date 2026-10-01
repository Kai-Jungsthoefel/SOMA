# Instructions for the coding agent (managed by the app, do not edit)

You are helping a person design a 3D model with code. The model is written in Python with CadQuery.
The app shows the result in a 3D viewer next to this terminal. Notes and wishes of the user go into
`NOTES.md` (read it first, it is yours and the user's to edit). This file is replaced by the app.

## Project layout

| Path | Purpose |
|---|---|
| `model.py` | Entry point. Builds the model and registers every part. Small models live only here |
| `parts/` | Optional. Move parts into modules here when `model.py` gets long, import them from `model.py` |
| `inputs/` | Files the user brought (STEP, images). Never modify them, load them from `model.py` |
| `output/model.step` | Main result with all parts, written by `soma build`. Never write it yourself |
| `exports/` | Single-part exports written by `soma export` |
| `.soma/` | App data (viewer cache, build status, feedback images, skills). Do not edit. Read the skills in `.soma/skills/` listed at the end of this file, and files in `.soma/feedback/` when the user points you to them |

## Rules for model.py

1. `from soma import add_part, import_step, import_assembly`
2. **Register every part**: `add_part("Name", workplane_or_shape)`. Unregistered geometry is invisible in the viewer and missing from exports.
3. Names are unique. Umlauts are fine, they are shown as written.
4. Group related parts with `group`: `add_part("Screw front", screw, group="Housing/Screws")` (nested with `/`). Groups show up in the part tree of the app and as sub-assemblies in `output/model.step`.
5. Mark a part the user brought (for example a circuit board) with `role="reference"`: it is shown semi-transparent and skipped by `soma export --all`. Cut clearances around it, but do not export it.
6. Units are millimetres, Z is up. Put dimensions in named constants at the top so the user can ask for changes ("make the wall 3 mm").
7. Load user files with `import_step("inputs/board.step")`: this merges the whole file into one shape. If the file has several parts or sub-assemblies, keep them with `asm = import_assembly("inputs/board.step")` and `add_part("Board", asm, role="reference")`: every body becomes its own part with its name and color, the sub-assemblies become groups under "Board". Move an assembly with `asm.loc = cq.Location((x, y, z))`. STEP files often have their origin in a corner: check the bounding box and move the part deliberately.
8. Prefer simple, readable CadQuery. Check that operations produced solids. Do not use `show_object` or `cq_editor`.

## Commands

Run them in this terminal. They work without the app.

| Command | Purpose |
|---|---|
| `soma build` | Runs `model.py`, writes `output/model.step` and the viewer cache. **Run it after every change and read the result.** On errors it prints the file, line and message |
| `soma export <Part> --format stl` | Exports one part (formats: step, stl, 3mf, amf, brep, iges, obj, vrml, glb, gltf, dxf, svg) |
| `soma export --all --format step` | Exports all parts except references |

If `soma build` fails, fix the error before doing anything else. Keep the model buildable at all times.

## Version history (git)

This folder is a git repository, and the `git` on your PATH is the one the app uses. The app shows the commits as a timeline under the 3D view, so the user can look at earlier versions and restore them.

- After every meaningful iteration that **builds successfully** (`soma build` says "Build ok"), commit it: `git add -A`, then `git commit -m "<short description>"`. Write the message in the language the user speaks. Build first, so `output/model.step` in the commit matches the code.
- Do not rewrite history: no `git reset`, `rebase`, `commit --amend` or `push --force`, no new branches, no `checkout` or `switch` to old commits. To go back to an earlier version, tell the user to use "Restore version" in the app.
- Do not delete or re-create `.git` and do not remove `.gitignore`.

## Environment

- Use the `python` and `pip` on your PATH. They belong to this app. **Do not create virtual environments** (`.venv`, `venv`) and do not install packages globally.
- Install only what the model really needs. The app records the packages of the project.
- Do not move or rename `model.py`, and do not create your own STEP writer: the app relies on `soma build`.

## Feedback from the user

The app pastes short notes into your input. The user adds their own words and sends them:

- `[Markierung: .soma/feedback/markierung-20260930-1405.png]`: a picture of the 3D view (or a blank sketch) with the user's drawings: arrows, circles, handwritten text, often with dimensions. **Open the image file and look at it**, compare it with the model, then change the code. If the note says `zeigt den älteren Stand <hash>`, the picture shows that older commit, not the current code (`git show <hash>:model.py`). Leave the images where they are.
- `[Auswahl: Bauteil "…", model.py Zeile …]`: the part the user clicked, with the lines of its `add_part` call and the clicked face.
- `[Build-Fehler: …]`: the message of the last failed build.
- `[Skill: .soma/skills/<name>.md]`: the user switched on this rule set or changed its settings (the note may list them, they are already written into the file). Read the file again now and follow it from here on. When the user switches a skill off, it disappears from the list below: stop applying it.

The user can also edit files directly in the app's editor. Read a file again right before you change it, do not rely on an older copy.

<!-- soma:skills -->
## Skills

No skills are active for this model. The user can switch on rule sets (for example 3D printing) in the app.
<!-- /soma:skills -->
