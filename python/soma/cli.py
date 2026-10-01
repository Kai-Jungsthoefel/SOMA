"""Kommandozeile: `soma build` und `soma export`."""
import argparse
import json
import sys
from pathlib import Path

from . import __version__, build, registry

EXPORT_FORMATS = ["step", "stl", "3mf", "amf", "brep", "iges", "obj", "vrml", "glb", "gltf", "dxf", "svg"]


def _print_build(res, as_json):
    if as_json:
        print(json.dumps(res, ensure_ascii=False))
        return
    if res["status"] == "ok":
        n = len(res.get("parts", []))
        t = res.get("timings", {})
        print(f"Build ok: {n} Bauteil(e), {sum(t.values()):.2f} s -> output/model.step")
        for w in res.get("warnings", []):
            print("Warnung:", w)
    else:
        e = res["error"]
        where = f" ({e['file']}:{e['line']})" if e.get("file") and e.get("line") else (f" ({e['file']})" if e.get("file") else "")
        print(f"Build FEHLER{where}: {e['message']}", file=sys.stderr)
        if e.get("traceback"):
            print(e["traceback"], file=sys.stderr)


def cmd_build(args):
    res = build.run_build(args.project)
    _print_build(res, args.json)
    return 0 if res["status"] == "ok" else 1


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
        from . import mesher
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
    try:
        parts = build.run_model(root)
    except build.BuildError as e:
        print(f"Export nicht moeglich, das Modell laesst sich nicht bauen: {e.message}", file=sys.stderr)
        return 1
    if args.all:
        chosen = [p for p in parts if p["role"] != "reference"]  # Referenzteile sind nicht Teil von --all (E34)
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
            print(f"exportiert: {path.relative_to(root).as_posix()}")
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


def cmd_serve(args):
    """Messdienst der App: JSON-Zeilen auf stdin/stdout (siehe measure.serve)."""
    from . import measure
    sys.stdin.reconfigure(encoding="utf-8")
    measure.serve()
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
    g.add_argument("--all", action="store_true", help="alle Bauteile (ohne Referenzteile)")
    e.add_argument("--format", required=True, help=", ".join(EXPORT_FORMATS))
    e.add_argument("--out", help="Zielordner relativ zum Projekt (Standard: exports)")
    e.add_argument("--project", default=".")
    e.set_defaults(func=cmd_export)

    g = sub.add_parser("glb", help="STEP-Datei in GLB fuer den Viewer umwandeln (Basismodus)")
    g.add_argument("step", help="STEP-Datei")
    g.add_argument("--out", required=True, help="Zielordner (model.glb und model.map.json)")
    g.add_argument("--json", action="store_true")
    g.set_defaults(func=cmd_glb)

    s = sub.add_parser("serve", help="Messdienst fuer die App (JSON-Zeilen auf stdin/stdout)")
    s.set_defaults(func=cmd_serve)

    args = ap.parse_args(argv)
    return args.func(args)
