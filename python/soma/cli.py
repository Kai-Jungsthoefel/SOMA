"""Kommandozeile: `soma build`, `soma export`, `soma anim`, `soma analyze` und `soma render`."""
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
    if res["status"] == "ok":
        n = len(res.get("parts", []))
        print(f"Build ok: {n} Bauteil(e), {seconds:.1f} s -> output/model.step")
        for w in res.get("warnings", []):
            print("Warnung:", w)
    else:
        e = res["error"]
        where = f" ({e['file']}:{e['line']})" if e.get("file") and e.get("line") else (f" ({e['file']})" if e.get("file") else "")
        print(f"Build FEHLER{where}: {e['message']}", file=sys.stderr)
        if e.get("traceback"):
            print(e["traceback"], file=sys.stderr)


def cmd_build(args):
    from . import build
    res = build.run_build(args.project)
    _print_build(res, args.json, time.perf_counter() - _STARTED)
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
            raise RuntimeError("IGES-Schreiben fehlgeschlagen")
    elif fmt == "obj":
        from . import build, mesher
        m = mesher.mesh_shape(shape, build.auto_tolerance([shape]), 0.3)
        lines = [f"v {v[0]:.5f} {v[1]:.5f} {v[2]:.5f}" for v in m["positions"]]
        lines += [f"vn {n[0]:.4f} {n[1]:.4f} {n[2]:.4f}" for n in m["normals"]]
        lines += [f"f {a}//{a} {b}//{b} {c}//{c}" for a, b, c in m["indices"] + 1]
        Path(path).write_text("\n".join(lines) + "\n")
    else:
        raise ValueError(f"Format nicht unterstuetzt: {fmt}")


def cmd_export(args):
    root = Path(args.project).resolve()
    fmt = args.format.lower()
    if fmt not in EXPORT_FORMATS:
        print(f"Format {fmt!r} nicht unterstuetzt. Moeglich: {', '.join(EXPORT_FORMATS)}", file=sys.stderr)
        return 2
    from . import build
    try:
        parts = build.run_model(root)
    except build.BuildError as e:
        print(f"Export nicht moeglich, das Modell laesst sich nicht bauen: {e.message}", file=sys.stderr)
        return 1
    if args.all:
        # Referenzen (E34) und Zukaufteile wie Schrauben (E48) gehoeren nicht zu --all, einzeln gehen sie
        chosen = [p for p in parts if p["role"] not in ("reference", "hardware")]
        skipped = len(parts) - len(chosen)
        if skipped:
            print(f"nicht exportiert: {skipped} Referenz- und Zukaufteil(e)")
    else:
        chosen = [p for p in parts if p["name"] == args.part or p["step_name"] == args.part]
        if not chosen:
            names = ", ".join(repr(p["name"]) for p in parts)
            print(f"Bauteil {args.part!r} nicht gefunden. Registriert: {names}", file=sys.stderr)
            return 1
    out_dir = root / (args.out or "exports")
    out_dir.mkdir(parents=True, exist_ok=True)
    for p in chosen:
        path = out_dir / f"{p['step_name']}.{fmt}"
        try:
            _export_one(p["shape"], fmt, path)
            # Im Projekt relativ (so liest es der Agent), ein Ziel ausserhalb (Speicherdialog der App) absolut
            print(f"exportiert: {path.relative_to(root).as_posix() if path.is_relative_to(root) else path.as_posix()}")
        except Exception as e:
            print(f"Export von {p['name']!r} als {fmt} fehlgeschlagen: {type(e).__name__}: {e}", file=sys.stderr)
            return 1
    return 0


def cmd_glb(args):
    """STEP -> GLB im Basismodus (Vorschau alter Staende, fremde Dateien)."""
    from . import preview
    try:
        parts = preview.step_to_glb(args.step, args.out)
    except Exception as e:
        print(f"Umwandlung fehlgeschlagen: {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    print(json.dumps(dict(status="ok", parts=[p["name"] for p in parts]), ensure_ascii=False) if args.json
          else f"{len(parts)} Bauteil(e) nach {args.out}")
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
            raise ValueError("kein Befehl")
        os.chdir(cwd)
    except (ValueError, KeyError, TypeError, OSError) as e:
        return _fail(f"Ungueltiger Auftrag fuer den vorgewaermten Prozess: {type(e).__name__}: {e}")
    # Wie bei `python -m soma` im Ordner des Auftrags: dieser Ordner vorn im Suchpfad (gestartet wurde in einem leeren Ordner)
    if sys.path and sys.path[0] in ("", START_DIR):
        sys.path[0] = os.getcwd()
    else:
        sys.path.insert(0, os.getcwd())
    global _STARTED
    _STARTED = time.perf_counter()  # die Dauer zaehlt ab dem Auftrag, nicht ab dem Vorwaermen
    return main(argv)


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
                    return _fail(f"{args.name} gibt es nicht")
            res = animrun.build_all(root, target)
            if args.json:
                print(json.dumps(dict(built=res["built"], errors=res["errors"]), ensure_ascii=False))
            else:
                for b in res["built"]:
                    print(f"Animation ok: \"{b['name']}\" ({b['duration']:.2f} s, {b['parts']} bewegte(s) Bauteil(e)) aus {b['file']}")
                for e in res["errors"]:
                    where = f"{e['file']}{':' + str(e['line']) if e.get('line') else ''}"
                    print(f"Animation FEHLER ({where}): {e['message']}", file=sys.stderr)
                    if e.get("traceback"):
                        print(e["traceback"], file=sys.stderr)
                if not res["built"] and not res["errors"]:
                    print(f"Keine Animationen: Lege eine Datei in {animrun.ANIM_DIR}/ an (from soma.anim import Animation).")
            if args.name and not args.name.endswith(".py") and not animrun.find(root, args.name):
                return _fail(f"Keine Animation {args.name!r} gefunden")
            return 1 if res["errors"] else 0
        if args.action == "list":
            idx = animrun.read_index(root)
            rows = [dict(x, stale=animrun.is_stale(root, x)) for x in idx.get("animations", [])]
            if args.json:
                print(json.dumps(dict(animations=rows, errors=idx.get("errors", [])), ensure_ascii=False))
                return 0
            for x in rows:
                print(f"\"{x['name']}\"  {x['duration']:.2f} s  {x['file']}{'  (veraltet, soma anim build)' if x['stale'] else ''}")
            for e in idx.get("errors", []):
                print(f"FEHLER {e['file']}{':' + str(e['line']) if e.get('line') else ''}: {e['message']}")
            if not rows and not idx.get("errors"):
                print("Noch keine Animation gebaut (soma anim build).")
            return 0
        if not args.name:
            return _fail(f"soma anim {args.action} braucht den Namen der Animation")
        entry = animrun.ensure(root, args.name)
        if args.action == "info":
            if args.json:
                print(json.dumps(dict(meta=animrun.read_meta(root, entry), check=animrun.read_check(root, entry)), ensure_ascii=False))
            else:
                print(animrun.info_text(root, entry))
            return 0
        res = animrun.check(root, args.name, step=args.step, gap=args.gap)
        print(json.dumps(res, ensure_ascii=False) if args.json else animrun.check_text(res))
        return 1 if any(r["kind"] == "Kollision" and not p["atRest"] for p in res["pairs"] for r in p["ranges"]) else 0
    except animrun.AnimError as e:
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
            print("Noch keine Ergebnisse (soma analyze overhang | thickness | clearance | fem <studie.py>).")
        return 0
    try:
        if args.kind == "fem":
            from . import fem
            if not args.study:
                return _fail("soma analyze fem braucht die Datei mit dem Lastfall, z. B. soma analyze fem analyses/halter.py (Skill FEM)")
            meta = fem.run(root, args.study, args.name, args.threshold)
        else:
            if args.study:
                return _fail(f"Unerwartete Angabe {args.study!r}: nur soma analyze fem nimmt eine Datei")
            meta = analysis.run(root, args.kind, args.parts, args.threshold, args.up, args.name)
    except analysis.AnalysisError as e:
        return _fail(str(e))
    if args.json:
        print(json.dumps(meta, ensure_ascii=False))
    else:
        print(meta["summary"])
        print(f"Ergebnis: {meta['file']}. Als Bild mit Farben: soma render --result {meta['id']}")
    return 0


def cmd_render(args):
    """Bild oder Video ueber die App (E58)."""
    from . import render
    root = Path(args.project).resolve()
    try:
        job = render.prepare(root, args)
        res = render.send(job)
    except render.RenderError as e:
        return _fail(f"Render FEHLER: {e}")
    if args.json:
        print(json.dumps(res, ensure_ascii=False))
        return 0
    for w in res.get("warnings", []):
        print("Hinweis:", w)
    for f in res.get("files", []):
        print(f"geschrieben: {f}")
    if job["kind"] == "video":
        print("Das Video selbst kannst du nicht ansehen, die Uebersicht (PNG) zeigt Standbilder mit Zeitstempel.")
    else:
        print("Oeffne das Bild, um es anzusehen.")
    return 0


def main(argv=None):
    ap = argparse.ArgumentParser(prog="soma", description="Hilfsprogramm von SOMA")
    ap.add_argument("--version", action="version", version=f"soma {__version__}")
    sub = ap.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build", help="model.py ausfuehren und STEP, GLB und Mapping schreiben")
    b.add_argument("--project", default=".", help="Projektordner (Standard: aktueller Ordner)")
    b.add_argument("--json", action="store_true", help="Ergebnis als JSON ausgeben")
    b.set_defaults(func=cmd_build)

    e = sub.add_parser("export", help="Einzelne Bauteile exportieren")
    g = e.add_mutually_exclusive_group(required=True)
    g.add_argument("part", nargs="?", help="Name des Bauteils")
    g.add_argument("--all", action="store_true", help="alle Bauteile (ohne Referenz- und Zukaufteile)")
    e.add_argument("--format", required=True, help=", ".join(EXPORT_FORMATS))
    e.add_argument("--out", help="Zielordner, relativ zum Projekt oder absolut (Standard: exports)")
    e.add_argument("--project", default=".")
    e.set_defaults(func=cmd_export)

    g = sub.add_parser("glb", help="STEP-Datei in GLB fuer den Viewer umwandeln (Basismodus)")
    g.add_argument("step", help="STEP-Datei")
    g.add_argument("--out", required=True, help="Zielordner (model.glb und model.map.json)")
    g.add_argument("--json", action="store_true")
    g.set_defaults(func=cmd_glb)

    a = sub.add_parser("anim", help="Animationen aus animations/*.py bauen, auflisten, beschreiben, pruefen")
    a.add_argument("action", choices=["build", "list", "info", "check"])
    a.add_argument("name", nargs="?", help="Name der Animation (bei build auch eine Datei animations/x.py)")
    a.add_argument("--step", type=float, default=0.1, help="check: Abstand der Zeitpunkte in Sekunden (Standard 0.1)")
    a.add_argument("--gap", type=float, default=0.0, help="check: Mindestabstand in mm, darunter gilt es als zu nah")
    a.add_argument("--project", default=".")
    a.add_argument("--json", action="store_true")
    a.set_defaults(func=cmd_anim)

    z = sub.add_parser("analyze", help="Auswertung: overhang (3D-Druck), thickness (Wandstaerke), clearance (Spalt zu anderen Teilen), fem (Festigkeit)")
    z.add_argument("kind", choices=["overhang", "thickness", "clearance", "fem", "list"])
    z.add_argument("study", nargs="?", help="fem: Datei mit dem Lastfall, z. B. analyses/halter.py")
    z.add_argument("--parts", help="Bauteile oder Gruppen, mit Komma getrennt, \"Gruppe/\" immer die Gruppe (Standard: alle eigenen Teile)")
    z.add_argument("--threshold", type=float, help="Grenzwert (Standard: overhang 45 Grad, thickness 1.2 mm, clearance 0.5 mm, fem der Sicherheitsfaktor der Studie)")
    z.add_argument("--up", default="z", help="overhang: Druckrichtung (z, -z, x, -x, y, -y)")
    z.add_argument("--name", help="Name des Ergebnisses (Standard: wie die Auswertung)")
    z.add_argument("--project", default=".")
    z.add_argument("--json", action="store_true")
    z.set_defaults(func=cmd_analyze)

    r = sub.add_parser("render", help="Bild oder Video des Modells (ueber die App), nach renders/")
    r.add_argument("--view", help="iso, front, back, left, right, top, bottom (Standard iso, bei Animationen ihre Kamera)")
    r.add_argument("--size", help="Breite x Hoehe in Pixeln, z. B. 1280x800")
    r.add_argument("--anim", help="Name einer Animation")
    r.add_argument("--at", type=float, help="Zeitpunkt in der Animation (Sekunden)")
    r.add_argument("--sheet", nargs="?", const=True, help="Uebersicht: Standbilder der Animation mit Zeit, z. B. 3x3")
    r.add_argument("--video", action="store_true", help="Video (MP4) der Animation")
    r.add_argument("--fps", type=int, default=30, help="Bilder je Sekunde im Video")
    r.add_argument("--result", help="Ergebnis einer Auswertung (soma analyze) farbig zeigen")
    r.add_argument("--out", help="Zieldatei im Projekt (Standard: renders/...)")
    r.add_argument("--project", default=".")
    r.add_argument("--json", action="store_true")
    r.set_defaults(func=cmd_render)

    s = sub.add_parser("serve", help="Messdienst fuer die App (JSON-Zeilen auf stdin/stdout)")
    s.set_defaults(func=cmd_serve)

    w = sub.add_parser("warm", help=argparse.SUPPRESS)  # nur fuer die App: vorgewaermt auf einen Auftrag warten
    w.set_defaults(func=cmd_warm)

    args = ap.parse_args(argv)
    return args.func(args)
