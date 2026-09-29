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
| `output/model.step` | Main result with all parts, written by `cadide build`. Never write it yourself |
| `exports/` | Single-part exports written by `cadide export` |
| `.cadide/` | App data (viewer cache, build status, feedback images). Do not edit, except reading files in `.cadide/feedback/` when the user points you to them |

## Rules for model.py

1. `from cadide import add_part, import_step`
2. **Register every part**: `add_part("Name", workplane_or_shape)`. Unregistered geometry is invisible in the viewer and missing from exports.
3. Names are unique. Umlauts are fine, they are shown as written.
4. Mark a part the user brought (for example a circuit board) with `role="reference"`: it is shown semi-transparent and skipped by `cadide export --all`. Cut clearances around it, but do not export it.
5. Units are millimetres, Z is up. Put dimensions in named constants at the top so the user can ask for changes ("make the wall 3 mm").
6. Load user files with `import_step("inputs/board.step")`. STEP files often have their origin in a corner: check the bounding box and move the part deliberately.
7. Prefer simple, readable CadQuery. Check that operations produced solids. Do not use `show_object` or `cq_editor`.

## Commands

Run them in this terminal. They work without the app.

| Command | Purpose |
|---|---|
| `cadide build` | Runs `model.py`, writes `output/model.step` and the viewer cache. **Run it after every change and read the result.** On errors it prints the file, line and message |
| `cadide export <Part> --format stl` | Exports one part (formats: step, stl, 3mf, amf, brep, iges, obj, vrml, glb, gltf, dxf, svg) |
| `cadide export --all --format step` | Exports all parts except references |

If `cadide build` fails, fix the error before doing anything else. Keep the model buildable at all times.

## Environment

- Use the `python` and `pip` on your PATH. They belong to this app. **Do not create virtual environments** (`.venv`, `venv`) and do not install packages globally.
- Install only what the model really needs. The app records the packages of the project.
- Do not move or rename `model.py`, and do not create your own STEP writer: the app relies on `cadide build`.

## Feedback from the user

The user can send screenshots and sketches. They arrive as image files in `.cadide/feedback/`, the path is pasted into your input. Look at the image, compare it with the model, and change `model.py`.
