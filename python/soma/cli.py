"""Command line: `soma build`, `soma export`, `soma anim`, `soma drawing`, `soma analyze` and `soma render`."""
import argparse
import json
import os
import sys
import time
from pathlib import Path

# build (und damit cadquery, rund 4 s) laden nur die Befehle, die es brauchen
from . import _STARTED, __version__

# Ordner beim Start. `python -m` setzt ihn vorn in den Suchpfad, `soma warm` tauscht ihn gegen den Ordner des Auftrags
START_DIR = os.getcwd()

EXPORT_FORMATS = ["step", "stl", "3mf", "amf", "brep", "iges", "obj", "vrml", "glb", "gltf", "dxf", "svg"]


def _print_build(res, as_json, seconds):
    if as_json:
        print(json.dumps(res, ensure_ascii=False))
        return
    from . import params
    line = params.summary(res.get("params"))
    if res["status"] == "ok":
        n = len(res.get("parts", []))
        print(f"Build ok: {n} part(s), {seconds:.1f} s -> output/model.step")
        if line:
            print(line)
        for w in res.get("warnings", []):
            print("Warning:", w)
    else:
        e = res["error"]
        where = f" ({e['file']}:{e['line']})" if e.get("file") and e.get("line") else (f" ({e['file']})" if e.get("file") else "")
        print(f"Build ERROR{where}: {e['message']}", file=sys.stderr)
        if e.get("traceback"):
            print(e["traceback"], file=sys.stderr)
        # Werte aus dem Parameter-Panel koennen die Ursache sein
        if line and any(p.get("source") == "user" for p in res.get("params", [])):
            print(line, file=sys.stderr)
        for w in res.get("warnings", []):
            print("Warning:", w, file=sys.stderr)


def _foreign_shell_note(project):
    """Hinweis, wenn `soma` in einem Arbeitsordner der App laeuft, aber nicht mit der Umgebung ihrer Terminals.

    Manche Agenten (Codex) fuehren Befehle ueber einen Hintergrunddienst mit der Umgebung eines anderen Programms aus:
    `soma` und `pip` fehlen dort im PATH oder sind fremde, `pip install` landete nicht in der Projektumgebung.
    """
    from .render import bridge_file
    root = Path(project).resolve()
    if bridge_file(root) is None:
        return None  # kein Arbeitsordner der laufenden App
    mine = os.environ.get("SOMA_PROJECT")
    try:
        if mine and Path(mine).resolve() == root:
            return None
    except OSError:
        pass
    py = Path(".soma", "env", "Scripts", "python.exe") if os.name == "nt" else Path(".soma", "env", "bin", "python")
    if not (root / py).is_file():
        py = Path(sys.executable)
    note = (f"Note: this shell does not have the environment of the app's terminals. Run soma as `{py} -m soma ...` "
            f"and install packages only with `{py} -m pip install ...`.")
    skill = root / ".soma" / "skills" / "shell-environment.md"
    return note + (" Details: .soma/skills/shell-environment.md" if skill.is_file() else "")


def cmd_build(args):
    from . import build
    res = build.run_build(args.project)
    _print_build(res, args.json, time.perf_counter() - _STARTED)
    note = None if args.json else _foreign_shell_note(args.project)
    if note:
        print(note)
    # Das Aufraeumen von OCP und vtk beim normalen Beenden kostet fast eine Sekunde und bringt nichts:
    # alle Dateien sind geschrieben und geschlossen, also Puffer leeren und sofort beenden
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0 if res["status"] == "ok" else 1)


def _export_one(shape, fmt, path):
    import cadquery as cq
    cq_type = {"step": "STEP", "stl": "STL", "amf": "AMF", "vrml": "VRML", "3mf": "3MF", "brep": "BREP", "svg": "SVG"}
    wp = cq.Workplane("XY").add(shape)
    if fmt in cq_type:
        cq.exporters.export(wp, str(path), exportType=cq_type[fmt])
    elif fmt in ("glb", "gltf"):
        a = cq.Assembly(name="root")
        a.add(shape, name="part")
        a.export(str(path))
    elif fmt == "dxf":  # 2D: Schnitt in Bauteilmitte
        cq.exporters.exportDXF(wp.section(shape.BoundingBox().center.z), str(path))
    elif fmt == "iges":
        from OCP.IGESControl import IGESControl_Writer
        w = IGESControl_Writer()
        w.AddShape(shape.wrapped)
        w.ComputeModel()
        if not w.Write(str(path)):
            raise RuntimeError("Writing the IGES file failed")
    elif fmt == "obj":
        from . import build, mesher
        m = mesher.mesh_shape(shape, build.auto_tolerance([shape]), 0.3)
        lines = [f"v {v[0]:.5f} {v[1]:.5f} {v[2]:.5f}" for v in m["positions"]]
        lines += [f"vn {n[0]:.4f} {n[1]:.4f} {n[2]:.4f}" for n in m["normals"]]
        lines += [f"f {a}//{a} {b}//{b} {c}//{c}" for a, b, c in m["indices"] + 1]
        Path(path).write_text("\n".join(lines) + "\n")
    else:
        raise ValueError(f"Format not supported: {fmt}")


def cmd_export(args):
    root = Path(args.project).resolve()
    fmt = args.format.lower()
    if fmt not in EXPORT_FORMATS:
        print(f"Format {fmt!r} not supported. Supported: {', '.join(EXPORT_FORMATS)}", file=sys.stderr)
        return 2
    from . import build
    try:
        parts = build.run_model(root)
    except build.BuildError as e:
        print(f"Cannot export, the model does not build: {e.message}", file=sys.stderr)
        return 1
    if args.all:
        # Referenzen (E34) und Zukaufteile wie Schrauben (E48) gehoeren nicht zu --all, einzeln gehen sie
        chosen = [p for p in parts if p["role"] not in ("reference", "hardware")]
        skipped = len(parts) - len(chosen)
        if skipped:
            print(f"not exported: {skipped} reference and purchased part(s)")
    else:
        chosen = [p for p in parts if p["name"] == args.part or p["step_name"] == args.part]
        if not chosen:
            names = ", ".join(repr(p["name"]) for p in parts)
            print(f"Part {args.part!r} not found. Registered: {names}", file=sys.stderr)
            return 1
    out_dir = root / (args.out or "exports")
    out_dir.mkdir(parents=True, exist_ok=True)
    for p in chosen:
        path = out_dir / f"{p['step_name']}.{fmt}"
        try:
            _export_one(p["shape"], fmt, path)
            # Im Projekt relativ (so liest es der Agent), ein Ziel ausserhalb (Speicherdialog der App) absolut
            print(f"exported: {path.relative_to(root).as_posix() if path.is_relative_to(root) else path.as_posix()}")
        except Exception as e:
            print(f"Export of {p['name']!r} as {fmt} failed: {type(e).__name__}: {e}", file=sys.stderr)
            return 1
    return 0


def cmd_glb(args):
    """STEP -> GLB im Basismodus (Vorschau alter Staende, fremde Dateien)."""
    from . import preview
    try:
        parts = preview.step_to_glb(args.step, args.out)
    except Exception as e:
        print(f"Conversion failed: {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    print(json.dumps(dict(status="ok", parts=[p["name"] for p in parts]), ensure_ascii=False) if args.json
          else f"{len(parts)} part(s) to {args.out}")
    return 0


def cmd_cadquery(args):
    """Export als CadQuery-Skript bzw. Import eines CadQuery-Skripts (E100)."""
    from . import cqexport
    try:
        if args.action == "export":
            if not args.out:
                print("export needs --out (a .py file, or a folder for models with parts/)", file=sys.stderr)
                return 2
            r = cqexport.export(args.project, args.out)
        else:
            if not args.script:
                print("import needs the script, e.g. soma cadquery import box.py --project .", file=sys.stderr)
                return 2
            r = cqexport.import_script(args.script, args.project, backup=args.backup)
    except cqexport.ExportError as e:
        print(json.dumps(dict(status="error", error=str(e)), ensure_ascii=False) if args.json else str(e),
              file=sys.stdout if args.json else sys.stderr)
        return 1
    if args.json:
        print(json.dumps(dict(status="ok", **r), ensure_ascii=False))
    else:
        verb = "exported" if args.action == "export" else "imported"
        for f in r["files"]:
            print(f"{verb}: {f}")
        for w in r["warnings"]:
            print(f"Note: {w}")
    return 0


def cmd_warm(args):
    """Vorgewaermter Prozess der App: Python und cadquery sind geladen (rund 3 s), bevor es etwas zu tun gibt. Den Auftrag
    schickt die App als eine JSON-Zeile, z. B. {"cwd": "<Ordner>", "argv": ["build", "--project", "<Ordner>", "--json"]}.
    Es bleibt bei einem Auftrag je Prozess (E24). EOF (App beendet oder Prozess verworfen) heisst: nichts tun."""
    from . import build, preview  # noqa: F401  (laedt cadquery, Bauen und Vorschau)
    line = sys.stdin.readline()
    if not line.strip():
        return 0
    try:
        job = json.loads(line)
        argv = [str(a) for a in job["argv"]]
        cwd = str(job["cwd"])
        if not argv or argv[0] == "warm":
            raise ValueError("no command")
        os.chdir(cwd)
    except (ValueError, KeyError, TypeError, OSError) as e:
        return _fail(f"Invalid job for the prewarmed process: {type(e).__name__}: {e}")
    # Wie bei `python -m soma` im Ordner des Auftrags: dieser Ordner vorn im Suchpfad (gestartet wurde in einem leeren Ordner)
    if sys.path and sys.path[0] in ("", START_DIR):
        sys.path[0] = os.getcwd()
    else:
        sys.path.insert(0, os.getcwd())
    global _STARTED
    _STARTED = time.perf_counter()  # die Dauer zaehlt ab dem Auftrag, nicht ab dem Vorwaermen
    return main(argv)


def cmd_env(args):
    """Projektumgebung anlegen oder auf den Stand der Basis bringen (E67). Nur fuer die App: Sie ruft das beim Oeffnen."""
    from . import env
    res = env.ensure(args.project)
    print(json.dumps(res, ensure_ascii=False) if args.json else (res.get("note") or res.get("error") or f"Project environment: {res['env']}"))
    return 0 if res["ok"] else 1


def cmd_dxfview(args):
    """DXF fuer die Ansicht der App (E80): Geometrie als JSON nach --out, auch Fehler stehen dort (dxfview.write)."""
    from . import dxfview
    res = dxfview.write(args.file, args.out)
    return 0 if res["ok"] else 1


def cmd_serve(args):
    """Messdienst der App: JSON-Zeilen auf stdin/stdout (siehe measure.serve)."""
    from . import measure
    sys.stdin.reconfigure(encoding="utf-8")
    measure.serve()
    return 0


def _fail(msg, code=1):
    print(msg, file=sys.stderr)
    return code


def cmd_anim(args):
    """Animationen in animations/*.py (E58): bauen, auflisten, beschreiben, auf Kollisionen pruefen."""
    from . import animrun
    root = Path(args.project).resolve()
    try:
        if args.action == "build":
            target = None
            if args.name and args.name.endswith(".py"):
                target = root / args.name
                if not target.is_file():
                    return _fail(f"{args.name} does not exist")
            res = animrun.build_all(root, target)
            if args.json:
                print(json.dumps(dict(built=res["built"], errors=res["errors"]), ensure_ascii=False))
            else:
                for b in res["built"]:
                    print(f"Animation ok: \"{b['name']}\" ({b['duration']:.2f} s, {b['parts']} moving part(s)) from {b['file']}")
                    for w in b["warnings"]:
                        print(animrun.warning_text(w))
                for e in res["errors"]:
                    where = f"{e['file']}{':' + str(e['line']) if e.get('line') else ''}"
                    print(f"Animation ERROR ({where}): {e['message']}", file=sys.stderr)
                    if e.get("traceback"):
                        print(e["traceback"], file=sys.stderr)
                if not res["built"] and not res["errors"]:
                    print(f"No animations: create a file in {animrun.ANIM_DIR}/ (from soma.anim import Animation).")
            if args.name and not args.name.endswith(".py") and not animrun.find(root, args.name):
                return _fail(f"No animation {args.name!r} found")
            return 1 if res["errors"] else 0
        if args.action == "list":
            idx = animrun.read_index(root)
            rows = [dict(x, stale=animrun.is_stale(root, x)) for x in idx.get("animations", [])]
            if args.json:
                print(json.dumps(dict(animations=rows, errors=idx.get("errors", [])), ensure_ascii=False))
                return 0
            for x in rows:
                print(f"\"{x['name']}\"  {x['duration']:.2f} s  {x['file']}{'  (outdated, soma anim build)' if x['stale'] else ''}")
            for e in idx.get("errors", []):
                print(f"ERROR {e['file']}{':' + str(e['line']) if e.get('line') else ''}: {e['message']}")
            if not rows and not idx.get("errors"):
                print("No animation built yet (soma anim build).")
            return 0
        if not args.name:
            return _fail(f"soma anim {args.action} needs the name of the animation")
        entry = animrun.ensure(root, args.name)
        if args.action == "info":
            if args.json:
                print(json.dumps(dict(meta=animrun.read_meta(root, entry), check=animrun.read_check(root, entry)), ensure_ascii=False))
            else:
                print(animrun.info_text(root, entry))
            return 0
        res = animrun.check(root, args.name, step=args.step, gap=args.gap)
        if args.json:
            print(json.dumps(dict(res, warnings=animrun.read_meta(root, entry).get("warnings")), ensure_ascii=False))
        else:
            print(animrun.check_text(res))
            if "warnings" in (meta := animrun.read_meta(root, entry)):
                print(animrun.warnings_text(meta["warnings"]))
        return 1 if any(r["kind"] == animrun.COLLISION and not p["atRest"] for p in res["pairs"] for r in p["ranges"]) else 0
    except animrun.AnimError as e:
        return _fail(str(e))


def cmd_drawing(args):
    """Technische Zeichnungen in drawings/*.py (E76): bauen, auflisten, beschreiben."""
    from . import drawrun
    root = Path(args.project).resolve()
    try:
        if args.action == "build":
            target = None
            if args.name and args.name.endswith(".py"):
                target = root / args.name
                if not target.is_file():
                    return _fail(f"{args.name} does not exist")
            res = drawrun.build_all(root, target, args.dpi)
            if args.json:
                print(json.dumps(dict(built=res["built"], errors=res["errors"], orphans=res["orphans"], set=res["set"]),
                                 ensure_ascii=False))
            else:
                for b in res["built"]:
                    print(f"Drawing ok: \"{b['name']}\" ({b['size']}, {b['scale']}, {len(b['views'])} view(s), "
                          f"{len(b['dims'])} dimension(s)) from {b['file']}")
                    print(f"  {b['pdf']}, {b['dxf']}")
                    print(f"  Picture: {b['png']} ({b['png_size'][0]} x {b['png_size'][1]} px). Open it to check the "
                          "drawing, crop it to read small text.")
                    for w in b["warnings"]:
                        print("  " + drawrun.warning_text(w))
                for e in res["errors"]:
                    where = f"{e['file']}{':' + str(e['line']) if e.get('line') else ''}"
                    print(f"Drawing ERROR ({where}): {e['message']}", file=sys.stderr)
                    if e.get("traceback"):
                        print(e["traceback"], file=sys.stderr)
                st = res["set"]
                if st and st.get("skipped"):
                    print(f"Note: {st['pdf']} (all sheets in one file) is not updated while a drawing has errors.")
                elif st:
                    print(f"All sheets in one file: {st['pdf']} ({st['sheets']} sheet(s))"
                          + (f", missing (no DXF): {', '.join(st['missing'])}" if st["missing"] else ""))
                for p in res["orphans"]:
                    print(f"Note: {p} belongs to no sheet anymore (renamed or removed). Delete it if it is not needed.")
                if not res["built"] and not res["errors"]:
                    print(f"No drawings: create a file in {drawrun.DRAW_DIR}/ (from soma.drawing import Sheet).")
            if args.name and not args.name.endswith(".py") and not drawrun.find(root, args.name):
                return _fail(f"No drawing {args.name!r} found")
            return 1 if res["errors"] else 0
        idx = drawrun.read_index(root)
        if args.action == "list":
            rows = [dict(x, stale=drawrun.is_stale(root, x)) for x in idx.get("drawings", [])]
            if args.json:
                print(json.dumps(dict(drawings=rows, errors=idx.get("errors", [])), ensure_ascii=False))
                return 0
            for x in rows:
                print(f"\"{x['name']}\"  {x['size']}  {x['scale']}  {x['pdf']}  from {x['file']}"
                      + ("  (outdated, soma drawing build)" if x["stale"] else "")
                      + (f"  {len(x['warnings'])} warning(s)" if x["warnings"] else ""))
            for e in idx.get("errors", []):
                print(f"ERROR {e['file']}{':' + str(e['line']) if e.get('line') else ''}: {e['message']}")
            if not rows and not idx.get("errors"):
                print("No drawing built yet (soma drawing build).")
            return 0
        entries = idx.get("drawings", [])
        if not args.name and len(entries) != 1:
            return _fail("soma drawing info needs the name of the sheet" + (
                f": {', '.join(repr(x['name']) for x in entries)}" if entries else " (none built yet: soma drawing build)"))
        entry = drawrun.find(root, args.name) if args.name else entries[0]
        if entry is None:
            return _fail(f"No drawing {args.name!r} found (soma drawing list)")
        if args.json:
            print(json.dumps(entry, ensure_ascii=False))
        else:
            print(drawrun.info_text(entry))
            if drawrun.is_stale(root, entry):
                print("\nOutdated: the model or the drawing changed since (soma drawing build).")
        return 0
    except drawrun.DrawingError as e:
        return _fail(str(e))


def cmd_analyze(args):
    """Auswertung mit einem Wert je Stelle der Oberflaeche (E58)."""
    from . import analysis
    root = Path(args.project).resolve()
    if args.kind == "list":
        res = analysis.list_results(root)
        if args.json:
            print(json.dumps(res, ensure_ascii=False))
            return 0
        for m in res:
            print(f"{m['id']}: {m['title']} ({m['file']})")
        if not res:
            print("No results yet (soma analyze overhang | thickness | clearance | fem <study.py>).")
        return 0
    try:
        if args.kind == "fem":
            from . import fem
            if not args.study:
                return _fail("soma analyze fem needs the file with the load case, e.g. soma analyze fem analyses/bracket.py (skill \"Strength with FEM\")")
            meta = fem.run(root, args.study, args.name, args.threshold)
        else:
            if args.study:
                return _fail(f"Unexpected argument {args.study!r}: only soma analyze fem takes a file")
            meta = analysis.run(root, args.kind, args.parts, args.threshold, args.up, args.name)
    except analysis.AnalysisError as e:
        return _fail(str(e))
    if args.json:
        print(json.dumps(meta, ensure_ascii=False))
    else:
        print(meta["summary"])
        print(f"Result: {meta['file']}. As a picture with colors: soma render --result {meta['id']}")
    return 0


def cmd_render(args):
    """Bild oder Video ueber die App (E58)."""
    from . import render
    root = Path(args.project).resolve()
    try:
        job = render.prepare(root, args)
        res = render.send(job)
    except render.RenderError as e:
        return _fail(f"Render ERROR: {e}")
    if args.json:
        print(json.dumps(res, ensure_ascii=False))
        return 0
    for w in res.get("warnings", []):
        print("Note:", w)
    for f in res.get("files", []):
        print(f"written: {f}")
    if job["kind"] == "video":
        print("You cannot watch the video itself, the contact sheet (PNG) shows stills with timestamps.")
    else:
        print("Open the picture to look at it.")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog="soma", description="Helper tool of SOMA")
    ap.add_argument("--version", action="version", version=f"soma {__version__}")
    sub = ap.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build", help="run model.py and write STEP, GLB and mapping")
    b.add_argument("--project", default=".", help="project folder (default: current folder)")
    b.add_argument("--json", action="store_true", help="print the result as JSON")
    b.set_defaults(func=cmd_build)

    e = sub.add_parser("export", help="export single parts")
    g = e.add_mutually_exclusive_group(required=True)
    g.add_argument("part", nargs="?", help="name of the part")
    g.add_argument("--all", action="store_true", help="all parts (without reference and purchased parts)")
    e.add_argument("--format", required=True, help=", ".join(EXPORT_FORMATS))
    e.add_argument("--out", help="target folder, relative to the project or absolute (default: exports)")
    e.add_argument("--project", default=".")
    e.set_defaults(func=cmd_export)

    q = sub.add_parser("cadquery", help="export the model as a plain CadQuery script, or import one (round trip)")
    q.add_argument("action", choices=["export", "import"])
    q.add_argument("script", nargs="?", help="import: the CadQuery script (.py)")
    q.add_argument("--out", help="export: target .py file (a folder for models with parts/)")
    q.add_argument("--backup", help="import: folder for files of the model that the import replaces")
    q.add_argument("--project", default=".")
    q.add_argument("--json", action="store_true")
    q.set_defaults(func=cmd_cadquery)

    g = sub.add_parser("glb", help="convert a STEP file to GLB for the viewer (basic mode)")
    g.add_argument("step", help="STEP file")
    g.add_argument("--out", required=True, help="target folder (model.glb and model.map.json)")
    g.add_argument("--json", action="store_true")
    g.set_defaults(func=cmd_glb)

    a = sub.add_parser("anim", help="build, list, describe and check animations from animations/*.py")
    a.add_argument("action", choices=["build", "list", "info", "check"])
    a.add_argument("name", nargs="?", help="name of the animation (for build also a file animations/x.py)")
    a.add_argument("--step", type=float, default=0.1, help="check: time between samples in seconds (default 0.1)")
    a.add_argument("--gap", type=float, default=0.0, help="check: minimum distance in mm, closer counts as too close")
    a.add_argument("--project", default=".")
    a.add_argument("--json", action="store_true")
    a.set_defaults(func=cmd_anim)

    d = sub.add_parser("drawing", help="build, list and describe technical drawings from drawings/*.py (DXF, PDF, PNG)")
    d.add_argument("action", choices=["build", "list", "info"])
    d.add_argument("name", nargs="?", help="name of the sheet (for build also a file drawings/x.py)")
    d.add_argument("--dpi", type=int, default=200, help="build: resolution of the picture (default 200)")
    d.add_argument("--project", default=".")
    d.add_argument("--json", action="store_true")
    d.set_defaults(func=cmd_drawing)

    z = sub.add_parser("analyze", help="analysis: overhang (3D printing), thickness (wall thickness), clearance (gap to other parts), fem (strength)")
    z.add_argument("kind", choices=["overhang", "thickness", "clearance", "fem", "list"])
    z.add_argument("study", nargs="?", help="fem: file with the load case, e.g. analyses/bracket.py")
    z.add_argument("--parts", help="parts or groups, separated by commas, \"Group/\" always means the group (default: all own parts)")
    z.add_argument("--threshold", type=float, help="limit (default: overhang 45 degrees, thickness 1.2 mm, clearance 0.5 mm, fem the safety factor of the study)")
    z.add_argument("--up", default="z", help="overhang: print direction (z, -z, x, -x, y, -y)")
    z.add_argument("--name", help="name of the result (default: like the analysis)")
    z.add_argument("--project", default=".")
    z.add_argument("--json", action="store_true")
    z.set_defaults(func=cmd_analyze)

    r = sub.add_parser("render", help="picture or video of the model (through the app), to renders/")
    r.add_argument("--view", help="iso, front, back, left, right, top, bottom or a direction x,y,z from the model to the camera "
                   "(--view=-1,0,0 with a leading minus; default iso, for animations their camera)")
    r.add_argument("--hide", action="append", metavar="NAME", help="hide a part or group (\"Housing\", \"Housing/Lid\"), repeatable")
    r.add_argument("--only", action="append", metavar="NAME", help="show only these parts or groups, repeatable")
    r.add_argument("--fit", action="append", metavar="NAME", help="frame these parts or groups, repeatable (default: all visible)")
    r.add_argument("--zoom", type=float, help="closer than framed (2 = twice as close), 0.05 to 50")
    r.add_argument("--size", help="width x height in pixels, e.g. 1280x800")
    r.add_argument("--anim", help="name of an animation")
    r.add_argument("--at", type=float, help="moment in the animation (seconds)")
    r.add_argument("--sheet", nargs="?", const=True, help="contact sheet: stills of the animation with time, e.g. 3x3")
    r.add_argument("--video", action="store_true", help="video (MP4) of the animation")
    r.add_argument("--fps", type=int, default=30, help="frames per second in the video")
    r.add_argument("--result", help="show the result of an analysis (soma analyze) in color")
    r.add_argument("--out", help="target file in the project (default: renders/...)")
    r.add_argument("--project", default=".")
    r.add_argument("--json", action="store_true")
    r.set_defaults(func=cmd_render)

    s = sub.add_parser("serve", help="measuring service for the app (JSON lines on stdin/stdout)")
    s.set_defaults(func=cmd_serve)

    w = sub.add_parser("warm", help=argparse.SUPPRESS)  # nur fuer die App: vorgewaermt auf einen Auftrag warten
    w.set_defaults(func=cmd_warm)

    v = sub.add_parser("env", help=argparse.SUPPRESS)  # nur fuer die App: Projektumgebung anlegen (E67)
    v.add_argument("--project", default=".")
    v.add_argument("--json", action="store_true")
    v.set_defaults(func=cmd_env)

    x = sub.add_parser("dxfview", help=argparse.SUPPRESS)  # nur fuer die App: DXF fuer die Ansicht im Code-Panel (E80)
    x.add_argument("file")
    x.add_argument("--out", required=True)
    x.set_defaults(func=cmd_dxfview)

    args = ap.parse_args(argv)
    # Ausgabe immer UTF-8: Agenten ausserhalb des SOMA-Terminals (ohne PYTHONUTF8) lesen die Pipe als UTF-8, Python schriebe
    # dort die ANSI-Codepage, und ° oder ² kaemen als "�" an. In der Windows-Konsole aendert das nichts (die schreibt UTF-16)
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError, OSError):
            pass
    # Zusatzpakete des Projekts (E67): soma laeuft mit dem Python der Basis, das Modell darf sie trotzdem importieren
    if args.cmd != "env" and getattr(args, "project", None) is not None:
        from . import env
        env.activate(args.project)
    return args.func(args)
