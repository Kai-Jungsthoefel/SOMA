# Changelog

All notable changes to SOMA. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), version numbers
are major.minor.bugfix. New entries collect under "Unreleased" and move into their own section with date and Git tag when
the version is bumped.

## [Unreleased]

### Added

- Search field above the file tree: it shows only files whose name contains the text, with their folders opened.
- Videos in the Animation tab are sorted by folder, and each folder can be collapsed (remembered per model), so the agent's many short clips no longer hide the main videos.
- Right-click a video in the Animation tab, or click "…" in the video player, to show it in the file tree or in Explorer, rename or delete it.
- The video player has a mute button (M) and a volume slider. Both are remembered.

### Changed

- Folders in the file tree start collapsed. The folder of a file you open in the editor opens by itself.

### Fixed

- Exports as 3MF, AMF, STL and OBJ are now one closed, manifold mesh per body with shared vertices. Before, every CAD face was its own patch, and slicers reported open edges and repaired the mesh, sometimes leaving a crack in the wall along a fillet. Degenerate triangles at the corners of fillets are gone too. Curves are meshed a bit finer (at most 0.05 mm deviation). If a mesh still cannot be closed, for example for an open surface, `soma export` prints a warning.

## [0.10.1] - 2026-10-22

### Added

- The guide (F1) and the README explain how to work with an agent app such as the Codex app or Claude Desktop instead of an agent in SOMA's terminal.

### Changed

- "Send to agent" also copies its note to the clipboard, so you can paste it into an agent app outside SOMA. Without an open terminal it no longer shows an error, the note is in the clipboard.

### Security

- The bundled Python environment uses Pillow 13.0.0 and aiohttp 3.14.4, which fix several reported vulnerabilities (crafted image files, HTTP server limits).

## [0.10.0] - 2026-10-22

### Added

- "Open folder" uses SOMA in a folder of yours, for example a Git repository: viewer, skills, agent instructions and `soma`, without a .soma file. Before anything changes, SOMA lists the files it creates and changes, with Cancel. It adds a section to `AGENTS.md` and a line to `CLAUDE.md` (backed up first), leaves your Git history and `requirements.txt` alone, and never moves or deletes the folder.
- "Copy path for agent app" in the menu for new tabs copies the model folder, so an agent app such as Claude Desktop or the Codex app can work on the model. SOMA shows its changes, and `soma render` works from there too.
- `soma anim build`, `info` and `check` warn about motion that plays back differently than written: jumps within one frame, turns so fast that they wobble between frames, and parts that are still hidden at the end.
- `add_part(..., alpha=)` sets the opacity of a part. A reference with `alpha=1` is opaque, for scenery in animations such as a floor or a logo, and still stays out of `soma export --all`.

### Changed

- Free parts moved with `to()` in an animation follow a rigid-body screw path: a turn runs on the arc about its axis instead of wobbling around the model origin. Animations that combine a large turn with a large shift in one `to()` take a different path than before.

### Fixed

- Long animations with many steps build much faster (a two-minute animation in seconds instead of many minutes), so the app shows them again.
- `soma analyze fem` no longer stops with a raw mesher error when several parts cannot be meshed together (for example parts that overlap slightly). It explains the likely cause and suggests mesh sizes. If only the check with the coarser mesh fails, the result is kept with a note.
- `soma` writes its output as UTF-8, so ° and ² show correctly in agent apps outside the SOMA terminal.
- `soma analyze fem` run from an agent app (through `.soma\env`) finds the bundled CalculiX. Before, it fell back to the built-in solver, without contact and bolt preload.

## [0.9.0] - 2026-10-16

### Added

- The start page shows a small label next to the version number when a newer version is available on GitHub, it opens the release page. Turn it off under Settings > About.
- Click a STEP file in Files to view it in the 3D viewer, with measuring, section, explode and the structure tree. "Back to model" returns to your model, builds wait until then.
- "New from CadQuery script" in the model menu: make a model from an existing CadQuery script, with a loading screen while it builds for the first time. Scripts with `show_object()` (CQ-editor), `ocp_vscode` or `result` build as they are.
- "As CadQuery script" in the Export menu: the model as plain CadQuery that runs in CQ-editor, VS Code and other tools without SOMA, with parameters and standard parts. Importing it again gives back the original code.
- `soma cadquery export` and `soma cadquery import` on the command line, and the on-demand skill "CadQuery scripts" for converting scripts to `add_part()` and `param()`.
- A portable ZIP for Windows on the releases page, to run SOMA without installing it.
- Origin and main axes in the 3D viewer (red X, green Y, blue Z): the new button next to the view cube or the display menu turns them on. Settings > Viewer shows them for every model.
- A log file for bug reports (`logs/soma.log` in the app data): errors, builds, which agent was started and its version. "Copy system info" under Settings > About now adds the end of the log, the folder is listed there and under Storage. Nothing is sent anywhere.

### Changed

- A tidier start page: Recent models come first, with a filter by name. New model and Open sit next to the title, "From CadQuery script" in the arrow menu of New model. The agents take less space, and any other CLI agent works too. "Back to …" names the open model, Esc goes back as well.

### Fixed

- The cards of Measure, Section and Explode no longer hide behind the banner of a version preview.

## [0.8.0] - 2026-10-13

### Added

- "Import" button next to Export: choose files in a file dialog to add them to `inputs/`, the same as dragging them into the window.
- "Drawings" on the left: all technical drawings in one view next to the 3D viewer, with size, scale, warnings and "older than the code" above each sheet, and buttons to open the code or DXF, rebuild or send a sheet to the agent.
- Click a view on a drawing to look at the model from that direction (a section sets the section tool to the same plane, a detail zooms in), click a dimension to see its points and value on the model.
- PDF viewer: single page or all pages, page previews on the left, fit the whole page.
- Text in drawing PDFs can be selected and quoted to the agent (it was drawn as outlines only). Rebuild older drawings to get it.
- Export drawings from the "Drawings" view: all sheets as one PDF, each sheet as PDF, DXF or both into a folder, or a single sheet.

### Changed

- PDF viewer: no floating "Quote to agent" button next to selected text any more; the button in the bar turns orange instead.
- `soma drawing build` writes more to `.soma/drawings/index.json` (parts, axes and section planes of the views, model points and positions of the dimensions, positions of warnings), so the app can link sheet and model.

## [0.7.2] - 2026-10-13

### Fixed

- Agents that run their commands outside the app's terminal (seen with Codex on Windows, which uses a background service with the environment of another program) can use `soma render` again: it now finds the running app without the terminal's environment variables.

### Added

- `soma build` notes when the shell lacks the environment of the app's terminals and says how to call `soma` and `pip` instead.
- New skill "Shell environment" (on demand for new models): what the agent does when `soma` or `pip` is not found, or umlauts in files look garbled in Windows PowerShell.

## [0.7.1] - 2026-10-12

### Fixed

- Measuring no longer gets stuck at "The model has been rebuilt in the meantime" after the agent ran `soma build` in the terminal. The viewer now picks up builds made outside the app, and the measuring tool reloads the model itself if it still finds an older one.
- Two builds of the same model (the app's automatic build and `soma build` in the terminal) no longer write into the same files at once. The second one waits and says so in the terminal. Viewer files are replaced in one step, so the viewer and the measuring service never read a half-written file.

### Changed

- Time limits in the app: builds, animations and exports may take 10 minutes (was 5), analyses run again from the app 60 minutes (was 5).

## [0.7.0] - 2026-10-12

### Added

- The packages include `THIRD_PARTY_NOTICES.md` and the license texts of all bundled npm packages.
- `SECURITY.md` explains how to report vulnerabilities privately, and issue templates ask for the system info from Settings > About.
- Tutorial for new users: the start page shows "New to SOMA?" with "Start tutorial" and "Got it". The tutorial opens an example model and walks through the window in ten steps (agent, code, selecting, measuring, mark up, parameters, history, saving and export, help), with the right button highlighted. Help can start it again at any time.

### Changed

- This changelog is now in English, also for older versions.
- Questions such as "Save the model before closing?" appear as a dark window inside the app instead of a white system dialog. Enter picks the highlighted button, Escape cancels.
- Windows: the title bar of the window is dark instead of white.

### Fixed

- New models: the box of the template failed to build with a wall of exactly 3 mm, although the Parameters panel allows 1.2 to 4 mm. The corner radius now grows with the wall.

## [0.6.2] - 2026-10-11

### Fixed

- Linux: On machines with a graphics card the app wrongly switched to software rendering at startup and then no longer started. Now it only switches when the 3D view really gets no WebGL, remembers that and restarts once.

## [0.6.1] - 2026-10-11

### Added

- Installation packages for download under the GitHub releases, for Windows, Linux and macOS (Apple Silicon).
- Linux without a usable graphics driver (virtual machine, remote desktop): the app restarts once with software rendering instead of staying without a 3D view. If that fails too, it says that WebGL is missing.

### Changed

- At startup the app shows a short loading screen until the start page is ready. Before, the empty interface flashed up briefly.

### Fixed

- macOS: The terminal did not open in the installation package. If a shell does not start, the app now names the reason on all systems.
- Linux: The package brings the libraries gmsh needs for FEM (libGLU and a few X11 libraries). Without them the import failed on many systems.

## [0.6.0] - 2026-10-10

### Added

- Installation packages: installer for Windows, AppImage and tar.gz for Linux, dmg for macOS with Apple Silicon, with Python, CadQuery, `soma`, CalculiX and Git included. So far only tested on Windows, the packages are not signed yet.
- FEM with bolts: `study.bolt("Bolt 1")` preloads a bolt from `soma.fasteners`, then the loads act. The result lists preload, tension and shear force at the end and the utilization of the yield strength for each bolt, the contact of the joint shows whether it opens or slips. Without a value 70 % of the yield strength, for plastic parts limited to what the area under the head can carry. Nut, washer and clamped parts are included automatically.

### Changed

- The bundled skills have English file names, for example `3d-printing.md` instead of `3d-druck.md`. Older models keep their copies under the old name, the app still recognizes them as the same skill. Your own versions of bundled skills in the settings move along at startup.

### Fixed

- Overhang in the viewer: the worst spot is labeled "Max" instead of "Min".
- A click on Analysis or Animation in the left bar shows the list instead of opening a result right away.
- FEM: The force carried by a contact is now correct even when the part is also supported elsewhere or the contact presses on the edge of a support. Before, contact force and the balance of the reaction forces could be clearly off there.
- FEM: Meshes with single inverted elements in narrow gaps (for example between washer and nut) are smoothed instead of failing with "distorted elements".
- FEM: No more "-0.0" in forces in the result.
- FEM with contact: A plate held only by the contact (for example a holder with an arm) failed with "a part moves without limit" or "The contact does not settle". SOMA took the search for the contact area for oscillation too early, and the soft fallback law pushed the parts apart. Now the contact is softer (stiffness equal to the Young's modulus instead of ten times, displacements differ by 0.4 %), may search longer, and the fallback law follows the load.
- Skill "Strength with FEM": friction between bolted parts only holds with `bolt()`, the skill now says so.

## [0.5.0] - 2026-10-10

FEM runs on CalculiX and knows contact between parts: lifting off, sliding, with and without friction.

### Added

- FEM with contact: `study.contact("Lid", "Housing")` turns the touching area of two parts into a contact that can lift off and slide, with `friction=` also with friction. The result lists the force carried, the highest pressure, where it is open and where it slides for each contact. The image has the quantity "Contact pressure", the report one line per contact.
- FEM lists all parts that touch each other, with area and whether they are bonded, and points to `contact()`.
- FEM runs on CalculiX instead of the built-in solver, two to three times faster at usual model sizes with the same numbers. CalculiX comes with SOMA (Windows: 53 MB). Without CalculiX the built-in solver still works, only without contact.
- Settings, "About" tab: lists gmsh and CalculiX with version.

### Changed

- FEM: The note that the peak stress depends on the mesh is left out for barely loaded parts (below 2 % of the strength).

## [0.4.1] - 2026-10-10

Help with numbered screenshots that the agent knows as a skill, plus improvements from an agent's review: `soma render` with free direction and hiding, reading PDFs, drawings with text measurement.

### Added

- Help: The "Help" button in the bar (also on the start page, key F1) opens a short guide to all areas of the app, with screenshots on which the elements are numbered. The agent gets the same guide as the skill "Using the app" (by default "On demand") with images, so it can answer questions about using the app.
- Settings, "About" tab: names Kai Jungsthöfel as author.
- `soma render`: free view direction (`--view=1,-2,1`), hide parts or groups (`--hide`) or show only them (`--only`), fit to parts (`--fit`) and `--zoom`. The agent can look inside a model this way without writing an animation.
- The agent can read PDFs from `inputs/`: pdfplumber (MIT) is in the base environment, with text, lines and coordinates.
- Technical drawings: `sh.text_width()` measures text before building, `leader(..., side="left"/"right")` sets the side of the note, `sh.table()` without `widths` fits the columns to the text.
- Animations also address parts by their group (`"Housing/Lid"`).

### Changed

- `AGENTS.md`: The front of a model faces −Y (front view from −Y, X to the right), so agents orient models correctly from the start.

### Fixed

- Technical drawings: The docstring of `Sheet` named the image `.soma/drawings/<name>.png`, the file is named after the ASCII identifier (`Washer_small.png`).
- Markup: The drawing area adapts to the viewer. When it grows, for example because the PDF next to it is closed, the area grows with it instead of staying small in the corner. The mouse wheel zooms around the pointer (up to 8x), dragging with the right or middle mouse button pans, Ctrl+0 fits again. The image for the agent keeps its full resolution.

## [0.4.0] - 2026-10-09

Structure tree in the viewer, Analysis and Animation tabs with a calm report, multi-selection and keys, settings for Viewer, Shortcuts, Storage and About.

### Added

- Structure tree in the viewer: the parts sit at the top left of the view like in CATIA, without background. Collapsed it shows only the model name (with "· 2 hidden" when something is hidden), expanded one level of groups (the next opens on demand) with tree lines, eye and half circle right before each name, references as a group at the end, search, "Show all" at the bottom. F3 opens and closes it. A click in the model highlights the part in the tree, in a collapsed group the group. The same tree applies to the model, the analysis (only the computed bodies) and the animation.
- Multi-selection in the viewer and the tree: Ctrl+click and Shift+click, ranges with Shift in the tree, box selection with Alt + drag in the viewer (left to right fully inside, right to left touching). Dragging across the eyes in the tree hides several parts at once. Keys H (hide), Shift+H (show all), I (isolate), T (transparent), Esc (clear selection). Right-click now also works in the view, for one part or the whole selection. A new "Shortcuts" tab in the settings lists all keys.
- "Analysis" and "Animation" tabs in the left bar, a dot signals something new from the agent. Analysis shows the list of results and a calm report: one big number, whether it holds, the critical parts with a jump to the spot, the assumptions one line each to expand (supports, forces, material, mesh), the parts as a table, computation and notes. Animation shows animations and videos, the steps from the subtitles (a click jumps there) and the videos of the animation.
- Analysis in the view: narrow legend at the bottom right, the scale is set with the "Auto ▾" button in it, display options in a bar at the bottom (safety factor, stress and now displacement, exaggeration, load case), force and minimum value as labels at their place. Animation: playback bar at the bottom with markers for the steps. The × in the bar returns to the model.
- Settings, "Viewer" tab: mouse bindings like SolidWorks, Fusion 360 and Inventor, Onshape, Creo, NX and Blender or Rhino, with legend. Reversible zoom direction. Orthographic view without vanishing points, the image stays put when switching. Display when a model opens (edges, wireframe, transparent). Decimal places for measuring (0 to 4), the text for the agent keeps three. Everything applies immediately.
- Settings, "Storage" tab: how much space SOMA uses on the computer, split into models, backups, preview cache, start page images and your own skills, with a button to open the folder. The preview cache can be cleared.
- Settings, "About" tab: versions of SOMA, soma, Python, CadQuery, OCP, Electron and Git, detected agents, folders and all components with license. "Copy system info" puts the details for a bug report on the clipboard.

### Changed

- The "Parts" tab and the switch at the top left of the viewer are gone: parts are in the structure tree, analyses and animations in their tabs. The sidebar is closed on first start.
- `soma analyze fem` also writes Poisson's ratio and density per material into the result, and whether the mesh size was chosen automatically, for the report.
- In the viewer only a left click selects, no longer also the right or middle button. So briefly rotating or panning with these buttons selects nothing.

## [0.3.0] - 2026-10-09

Technical drawings, your own skills, the `.soma` file format and the DXF view.

### Added

- DXF view: DXF files open in the code panel with a click in the file tree, drawn like the technical drawings (line types, hatches, dimensions, text). Zoom with the mouse wheel, pan by dragging, show and hide layers, size and coordinates under the pointer. "Mark up view" gives the visible area with its coordinates to the agent. When the agent changes the file, the view redraws and keeps the area. What cannot be drawn (for example 3D solids) is named in a note.
- Your own skills: "Settings" at the bottom of the left bar (grayed out before) and on the start page opens the settings. There you can change bundled skills and create, duplicate, import from Markdown files and delete your own. The editor with preview checks header, settings and placeholders as you type. Your own skills apply to all models on this computer and are switched on and off in the "Skills" panel like the bundled ones. Changed bundled skills can be reset at any time, deleted and replaced files go to the backup.
- Technical drawings: the agent describes a drawing in `drawings/*.py` (`soma.drawing`) with views, sections, details, dimensions, text and parts list, `soma drawing build` writes PDF and DXF to `output/drawings/`, all sheets together to `output/drawings.pdf`, and an image the agent uses to check its result. Long parts can be drawn broken, sections also with a stepped section line. Dimensions are always measured on the model, a check reports text overlapping edges, dimensions and parts list, entries too long for the title block, dimensions next to edges and typed numbers. Plus the skill "Technical drawings" with the rules according to ISO.
- Skill "Parametric models", always on for new models: the agent first decides what determines the size and what stays fixed when changing it, exposes a few independent values as parameters, derives the rest from them and test-builds the model at the limits of each range. The maximum number of parameters and the extent of this check are configurable.

### Changed

- Models are saved as a `.soma` file instead of `.zip`. The app still opens ZIP files. A model from a ZIP is saved as `.soma` next to it on the next save, the ZIP stays. If you need the whole model as a ZIP, you find "Everything as ZIP" in the export menu.
- The file tree shows the copies of the skills from `.soma/skills/` as their own group "Skills", collapsed and read-only. They are still switched on and off in the "Skills" panel.
- Every row in the "Parameters" panel shows the range the agent set without expanding ("30–200 mm", "3 options"), red when the value is outside.
- Smaller ZIP on save: images and videos from `renders/` are no longer included, and the version history is packed first, so similar versions of the model take hardly any extra space. For the engine model the history shrinks from 81 to 35 MB.

### Fixed

- In the editor the header of a skill (between two `---`) appeared bold like a heading. It now shows dimmed as its own block.
- Bold text in the terminal (for example the agent's headings) looked shaky, round letters sat one pixel lower than straight ones. The app now brings the real bold face of the terminal font instead of having bold synthesized.
- Skills and other Markdown files with a header between two `---` (front matter) showed this header as a huge heading in the document view. It now shows small as source text at the top.
- After changing a parameter, `soma anim` and `soma render --result` still considered animations and results up to date. Now `parameters.json` counts as part of the model, as in the app.

## [0.2.0] - 2026-10-08

Parameters for the user, the app in English, start on the start page and the license.

### Added

- The app starts on the start page. A new model that still matches the template and was never saved disappears when you leave it. Other models can be removed on the start page, the working folder goes to the recycle bin.
- README in English with images for the start page of the repository, plus this changelog.
- License: GPL-3.0 or later, text in `LICENSE`. Users' models are exempt from it (`MODEL-EXCEPTION.md`).
- Parameters: with `param()` the agent exposes single values, for example dimensions, counts, options or an angle. In the new "Parameters" panel you change them yourself, the model rebuilds. Your values are stored in `parameters.json`, the agent's value stays in the code, and every field can be reset to it. Values outside the range are reported and built anyway. The template for new models has four parameters.

### Changed

- The app is now in English: interface, messages, output and error messages of `soma`, skills and the notes to the agent. Numbers use a decimal point. Older models open as before.

## [0.1.0] - 2026-10-08

First numbered version. It sums up the state of the prototype.

### Added

- Desktop app with a terminal next to the 3D viewer. The agent is your choice (Claude Code, OpenCode, Codex, Gemini CLI …), the app detects common agents and starts them.
- Models as Python code with CadQuery (`model.py`, `parts/`), helper library `soma` with `add_part`, groups and roles, STEP import of single parts and whole assemblies.
- Build on every change (can be turned off), errors with file and line, a prewarmed Python process, opening without rebuilding.
- Viewer with selection and jump to the code, view cube, pivot point, part tree with groups, transparency and isolation.
- Measuring on the exact geometry: faces, edges, distances, hole spacing.
- Section and exploded view with disassembly analysis, step-by-step playback.
- Handing over to the agent: selection, measurements, section and markup (drawing on the view) as text or image into the terminal.
- Editor for code and Markdown, PDF view with quoting to the agent.
- Model as a ZIP file with Git history, timeline with preview and restore, saving only explicitly.
- Skills: 15 bundled rule sets (3D printing, CNC, sheet metal, tolerances, strength with FEM …), per model off, on demand or always, with settings.
- Standard parts according to ISO and DIN with matching holes, countersinks and nut traps (`soma.fasteners`).
- Animations in Python, analyses (overhang, wall thickness, clearance, strength with FEM), images and videos via `soma render`.
- Export to STEP, STL, 3MF, glTF, DXF, SVG and other formats.
- Extra packages: `pip install` in the terminal goes into a small environment per model, `requirements.txt` travels with the model, on another computer the app reinstalls the packages.
- Version number on the start page, on the logo and in `project.json`.

[Unreleased]: https://github.com/Kai-Jungsthoefel/SOMA/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/Kai-Jungsthoefel/SOMA/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/Kai-Jungsthoefel/SOMA/compare/v0.7.2...v0.8.0
[0.7.2]: https://github.com/Kai-Jungsthoefel/SOMA/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/Kai-Jungsthoefel/SOMA/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/Kai-Jungsthoefel/SOMA/compare/v0.6.2...v0.7.0
[0.6.2]: https://github.com/Kai-Jungsthoefel/SOMA/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/Kai-Jungsthoefel/SOMA/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/Kai-Jungsthoefel/SOMA/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/Kai-Jungsthoefel/SOMA/compare/v0.4.1...v0.5.0
[0.4.1]: https://github.com/Kai-Jungsthoefel/SOMA/compare/v0.4.0...v0.4.1
[0.4.0]: https://github.com/Kai-Jungsthoefel/SOMA/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/Kai-Jungsthoefel/SOMA/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/Kai-Jungsthoefel/SOMA/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/Kai-Jungsthoefel/SOMA/releases/tag/v0.1.0
