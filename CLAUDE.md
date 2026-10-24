# CLAUDE.md

Instructions for Claude Code when developing SOMA (*Solid Object Modeling with Agents*). Not to be confused with `app/resources/template/CLAUDE.md`, the template for user projects.

## What it is about

A desktop app (Electron, TypeScript) in which a user designs 3D models in CadQuery together with a CLI agent of their choice (Claude Code, OpenCode …). We do **not build our own harness**. The app provides the terminal, 3D viewer, the project format `.soma` (a ZIP with Git, E79) and the Python helper library `soma`.

### Working documents (local only, E88)

`PLAN.md`, `DECISIONS.md` and `IDEA.md` are in `.gitignore` (in the Git history up to `v0.5.0`). If they are missing, there is nothing to update.

- `PLAN.md`: current plan, phase status (section 10), open points (section 11). Takes precedence over `IDEA.md`.
- `DECISIONS.md`: decision log. `(E12)` in plan and code refers to it. New decisions of the user go as a new row at the end, old rows are never rewritten.
- `IDEA.md`: original idea, stays unchanged.

## Structure

Details in `app/README.md`.

**`app/`** Electron app
- `src/main/` main process. Projects: `projects.ts` (save, open, history, export), `git.ts`, `zip.ts`, `workspace.ts`, `folders.ts` ("Open folder", a folder of the user as the model, E103), `files.ts`, `watcher.ts`. Building and display: `build.ts` (prewarmed Python process), `previews.ts` (previews of versions and STEP files from the project), `measure.ts`, `dxf.ts` (E80), `drawings.ts` (document "Drawings", E97), `render.ts` + `bridge.ts` (`soma render`), `animations.ts`. Agent and skills: `terminals.ts`, `agents.ts`, `skills.ts`, `skilllibrary.ts` (own skills, E78). Environment: `packages.ts` (project environment, E67), `params.ts` (parameter panel, E74). App: `log.ts` (log file `logs/soma.log` in the app data, also catches `console.*`), `settings.ts`, `storage.ts`, `about.ts` (E81), `updates.ts` (new version on GitHub, E98), `help.ts` (E83), `dialogs.ts`.
- `src/preload/` the only bridge to the renderer.
- `src/renderer/` interface, wired up in `main.ts`. Viewer: `viewer.ts`, `viewcube.ts`, `tree.ts` (structure tree, E82), tools `sectiontool.ts`, `explodetool.ts`, `measuretool.ts`, `markup.ts`. Panels: `code.ts`, `pdfview.ts`, `dxfview.ts`, `drawings.ts` + `drawlink.ts` (document "Drawings" and its link to 3D, E97), `markdown.ts`, `filetree.ts`, `versions.ts`, `fileview.ts` (STEP file from the project in the viewer), `terminals.ts`, `params.ts`, `skills.ts`, `help.ts`, `settings.ts` + `settingspages.ts`, `tutorial.ts` (guided tour, E94). Animation and analysis: `animtool.ts`, `animpanel.ts`, `animdata.ts`, `overlay.ts`, `resulttool.ts`, `resultview.ts`, `analysispanel.ts`, `videoview.ts`. Render window: `render.ts`/`render.html`. General: `ui.ts`, `icons.ts`, `busy.ts`, `shortcuts.ts`, `style.css`.
- `src/shared/` `types.ts` (IPC contract), `settings.ts` (defaults, validation, mouse bindings, E81), `editable.ts`, `help.ts`, `skillname.ts`, `version.ts`.
- `resources/` `template/` (template for user projects incl. `AGENTS.md`), `skills/` (bundled skills, among them `soma-app.md` as the user guide for help and agent, E83), `help/` (images of the guide), `icon.*` (generated with `scripts/make-icon.py`).
- `test/` test suites, CDP client, screenshots. `SOMA_TEST_EXE` runs them against a packaged app.
- `electron-builder.config.cjs` installation packages, `build-resources/` large icon for them. CI for all three systems in `.github/workflows/dist.yml`.

**`python/soma/`** helper library and CLI
- API: `add_part` (with `group=`, `role=`), `param` (`params.py`, E74), `import_step`, `import_assembly`, standard parts in `fasteners.py` (dimension tables from bd_warehouse in `data/fasteners/`). Plain CadQuery scripts (E100): compatibility mode for `show_object`, `ocp_vscode` and `result` in `cqcompat.py`.
- Mesh exports (3MF, AMF, STL, OBJ): `meshexport.py`, one closed mesh per body with shared vertices (slicers need it).
- CadQuery in and out (E100): `soma cadquery export|import` (`cqexport.py`), the block in exported scripts comes from `cqruntime.py`. `cqruntime.py` and `fasteners.py` are also under Apache 2.0 (E101), they must run without soma.
- CLI: `soma build`, `export`, `glb`, `serve` (measuring service, `measure.py`), `anim` (`anim.py`, `animrun.py`), `analyze` (`analysis.py`, FEM in `fem.py`, CalculiX via `ccx.py`, E84), `drawing` (`drawing.py`, `drawrun.py`, E76), `dxfview` (E80), `render` (only via the app), `env` (`env.py`, `.soma/env` and `requirements.txt`, E67).
- `python/scripts/`: `setup_env.ps1` (development environment from `python/requirements-base.txt`), `fetch_ccx.py` (CalculiX), `build_runtime.py` (standalone base environment for the installation packages).

**`design/`** UI drafts, local only (in `.gitignore`, in the Git history up to `v0.8.0`), open in a browser, arrow keys to page
- `startseite-entwurf.html` (implemented): start page with Recent first, New model and Open next to the title, compact agents, update label next to the version.
- `ui-entwurf-2.html` "Aufgeräumt" (E62): reference for layout, colors and texts. Image 6 is the parameter panel (E74).
- `strukturbaum-entwurf.html` (E82, implemented): structure tree, Analysis and Animation tabs, analysis report. Replaces the Parts tab and the switch at the top left in draft 2.
- `ui-entwurf.html` (E38): first draft, colors and building blocks still apply, the layout no longer does.

**`docs/`** `images/` for the README, `phase0-ergebnisse.md` (finished prototype, code in the Git history up to `v0.5.0`).

**Root:** `README.md`, `CHANGELOG.md`, `LICENSE`, `MODEL-EXCEPTION.md`, `THIRD_PARTY_NOTICES.md` (licenses of bundled components, shipped with the packages), `SECURITY.md`, `CONTRIBUTING.md` (issues only, no pull requests for now). Issue templates in `.github/ISSUE_TEMPLATE/`.

## Commands

```
# once: Python environment under %LOCALAPPDATA%\soma-dev\venv with soma, fetches CalculiX into venv/ccx
powershell -File python/scripts/setup_env.ps1

# app (in app/)
npm install
npm start                            # builds and starts
npm run typecheck
npm test                             # builds, then all suites except animation and fem in parallel via test/run-all.mjs
npm run test:all                     # all suites including the slow animation and fem
node test/run-all.mjs smoke editor   # single suites in parallel, after npm run build
npm run test:unit                    # without build, checks the version number among other things
npm run help:shots                   # regenerate the images of the user guide
npm run dist                         # installation package for this system, run build_runtime.py first (app/README.md)

# soma directly
"$LOCALAPPDATA/soma-dev/venv/Scripts/soma.exe" build --project <folder>
```

## Code principles

- **Robustness:** working folder and agent are not trustworthy. Every convention needs a fallback, errors are detected and explained instead of crashing.
- **Report instead of repair (E28):** no automatic repairs and no repair buttons without asking the user.
- **Never silently overwrite or delete:** whatever is replaced goes into a backup (e.g. `workspace-backups/`).
- **Git in user projects only forward (E35):** new commits, no reset, checkout, rebase or branch. Writing Git calls go through `GitRepo` one after another.
- **Renderer without Node access:** everything via `preload.ts` and `src/shared/types.ts`. File access only via `resolveInside`. Text from the project never via `innerHTML`.
- **STEP names ASCII only** (`ascii_name`), display names are in `model.map.json`. `output/` does not count as an unsaved change (STEP files are not byte-stable).
- **Full version first (E37):** in the prototype, first complete and working, no early optimization.
- Comments explain the why, in the style of the surrounding code.

### Language (E73, E89)

- **English:** everything users, contributors or the agent see: interface, messages, dialogs, output and errors of `soma`, docstrings of the public API, skills including their header, handover notes to the agent, `AGENTS.md` and `model.py` of the template. Also all public documents in the repo: `README.md`, `CHANGELOG.md`, this `CLAUDE.md`, `THIRD_PARTY_NOTICES.md`, `SECURITY.md`, issue templates, release texts. Numbers with a decimal point.
- **German:** internal docs (`app/README.md`, `docs/phase0-ergebnisse.md`, the local working documents), code comments, commit messages, test descriptions.
- What the app recognizes from older projects (commit subjects, trailers) it also recognizes in the old German form.
- `README.md` in the root is the start page on GitHub (E70): plain and short, no emojis, images in `docs/images/`.

### Interface

- Colors with a fixed meaning: orange for action and selection, violet for preview, green/yellow/red for status. Tokens at the top of `style.css`.
- Icons only via `icons.ts`, no emoji.
- Menu entries that tests or shortcuts need are fixed in `index.html`.

## Tests

- After changes run `npm run typecheck` and `npm test`. Also run `node test/run-all.mjs animation fem` (after `npm run build`) when animations, analysis, FEM, the render window or their Python side change, and `npm run test:all` before a version bump. The npm scripts build first, `node test/*.mjs` without a build tests stale `dist/` files.
- The suites start the real app. Windows stay invisible (`SOMA_HIDDEN=1`), otherwise they flash up for the user. Invisible windows do not repaint: for screenshots use `SMOKE_VISIBLE=offscreen`, for UI changes also `SMOKE_SHOTS=1`, and look at the images in `app/test/shots/`.
- **User guide (E83):** when the interface changes, run `npm run help:shots`, look at the images in `app/resources/help/` and update `app/resources/skills/soma-app.md`. Crops and numbers are in `app/test/helpshots-spec.mjs`, the labels there and under the images must match.
- Answer native dialogs via `app.answers([...])` (`src/main/dialogs.ts`).
- Control via our own CDP client (`test/cdp.mjs`). puppeteer-core does not work with Electron 44 (`Input.dispatchMouseEvent` and `Page.captureScreenshot` hang in invisible windows).
- Redirect long runs to a file instead of piping through `grep` (buffering hides hangs).
- Locally only Windows is tested. Say so when reporting.

## Development on Windows

- **Network drives:** Electron's sandboxed processes do not start there (black window, `launch-failed` code 18). Electron therefore runs from a local copy (`app/scripts/electron-local.mjs`), never start `node_modules/electron/dist/electron.exe` directly. The Python environment is local for the same reason.
- **Proxy:** Node downloads (Electron binary, dugite) need `NODE_USE_ENV_PROXY=1`.
- **Ports:** single tests without `SOMA_TEST_PORT` use 9333, `run-all.mjs` picks free ports. With several sessions at once each needs its own ports.
- **Processes:** only end them selectively (repo path or `soma-dev` in the command line), never all `electron.exe` or `node.exe` across the board.
- **Short names** (`NAME~1`) in temp paths: do not compare paths as strings.

## Pitfalls

- Do not write files with backslash escapes (`\n` in strings) via a Bash heredoc, the escapes turn into real line breaks. Use the Edit or Write tool.
- Python patches: `pathlib.Path.write_text(..., newline="\n")` instead of `open(..., "w")` (otherwise CRLF), guard every replacement with `assert s.count(old) == 1`.
- Line endings: `.gitattributes` checks out all text files with LF, even with `core.autocrlf=true`. Template and skills go into user projects that way, tests compare with `\n`.
- Pin CadQuery exactly: cadquery 2.8.0 needs `cadquery-ocp<8` and `multimethod<2`.
- `dugite` stays external in the esbuild bundle (its Git path is relative to the package).

## Docs and way of working

- The maintainer speaks German: answer in German. If a decision is really theirs, ask a single question. What I decide without asking goes into `PLAN.md` under "Noch nicht ausdrücklich bestätigt".
- After a step, update:
  - `PLAN.md`: phase status, open points, risks.
  - `app/README.md` when commands or structure change, and the structure here.
  - `CHANGELOG.md`: what the user notices, briefly under "Unreleased", in English (E70, E89).
  - `README.md` only for big new features.
  - `THIRD_PARTY_NOTICES.md` when a bundled component is added, removed or changes its license.
- Commits only on request, split by topic (e.g. `python/`, `app/`, docs), with a German message.
- **Version number (E68):** major.minor.bugfix, one for app and `soma`, in `app/package.json` and `python/soma/__init__.py` (change both the same, `npm run test:unit` checks it). Bump only on request: bugfix for fixes, minor for new features, major for breaks with older models or agent instructions. "Unreleased" in the changelog then becomes the new version with date, plus an annotated tag `vX.Y.Z`.
