"""Build: model.py ausfuehren, dann STEP + GLB + Mapping schreiben und den Stand in .soma/build.json festhalten.

Einmal-Prozess, funktioniert ohne App (E24). Jeder Lauf schreibt build.json, auch bei Fehlern, damit App und
Agent dieselbe strukturierte Rueckmeldung bekommen (Status, Fehlerort, Warnungen).
"""
import json
import os
import runpy
import sys
import time
import traceback
import uuid
from pathlib import Path

import cadquery as cq

from . import measure, mesher, registry

DEFAULT_ENTRY = "model.py"


class BuildError(Exception):
    """Fehler mit Ort, der dem Nutzer/Agenten sinnvoll angezeigt werden kann."""

    def __init__(self, message, file=None, line=None, kind="BuildError", tb=""):
        super().__init__(message)
        self.message, self.file, self.line, self.kind, self.tb = message, file, line, kind, tb


def read_project_json(root):
    p = root / ".soma" / "project.json"
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _rel(path, root):
    try:
        return Path(path).resolve().relative_to(root.resolve()).as_posix()
    except (ValueError, OSError):
        return str(path)


def _error_from_exception(exc, root):
    """Fehlerort bestimmen: SyntaxError traegt ihn selbst, sonst der letzte Traceback-Rahmen im Projektordner.
    Der Traceback wird auf Projektzeilen gekuerzt (interne soma-/cadquery-Rahmen sind fuer Agent und Nutzer Rauschen)."""
    frames = traceback.extract_tb(exc.__traceback__)
    mine = [f for f in frames if _is_inside(f.filename, root)]
    file = line = None
    if isinstance(exc, SyntaxError) and exc.filename and _is_inside(exc.filename, root):
        file, line = _rel(exc.filename, root), exc.lineno
    elif mine:
        file, line = _rel(mine[-1].filename, root), mine[-1].lineno
    if mine or isinstance(exc, SyntaxError):
        tb = "".join(traceback.StackSummary.from_list(mine).format()) + "".join(traceback.format_exception_only(type(exc), exc))
    else:
        tb = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
    msg = f"{type(exc).__name__}: {exc}"
    return BuildError(msg, file=file, line=line, kind=type(exc).__name__, tb=tb)


def _is_inside(path, root):
    if str(path).startswith("<"):  # Pseudo-Dateien wie <frozen runpy> gehoeren nie zum Projekt
        return False
    try:
        Path(path).resolve().relative_to(root.resolve())
        return True
    except (ValueError, OSError):
        return False


# Einstiegspunkt und Namensraum des letzten erfolgreichen run_model(). Animationen importieren daraus (`from model import
# ...`), statt das ganze Modell ein zweites Mal auszufuehren (animrun._run_file).
LAST_RUN = None


def run_model(root, entry=None):
    """Fuehrt den Einstiegspunkt aus und liefert die registrierten Bauteile."""
    root = Path(root).resolve()
    entry = entry or read_project_json(root).get("entry") or DEFAULT_ENTRY
    script = (root / entry)
    if not script.is_file():
        raise BuildError(
            f"Einstiegspunkt {entry!r} nicht gefunden. Lege {DEFAULT_ENTRY} an oder setze \"entry\" in .soma/project.json.",
            kind="EntryMissing")
    global LAST_RUN
    registry.REGISTRY.clear()
    LAST_RUN = None
    old_cwd = os.getcwd()
    os.chdir(root)
    sys.path.insert(0, str(root))
    try:
        LAST_RUN = (script, runpy.run_path(str(script), run_name="__main__"))
    except BuildError:
        raise
    except SystemExit as e:
        if e.code not in (None, 0):
            raise BuildError(f"model.py hat sich mit Code {e.code} beendet", file=entry, kind="SystemExit")
    except BaseException as e:  # auch KeyboardInterrupt/Fehler im Nutzercode sauber melden
        raise _error_from_exception(e, root)
    finally:
        os.chdir(old_cwd)
        if sys.path and sys.path[0] == str(root):
            sys.path.pop(0)
    if not registry.REGISTRY:
        raise BuildError(
            "Kein Bauteil registriert. Rufe add_part(name, objekt) fuer jedes Bauteil auf "
            "(from soma import add_part).", file=entry, kind="NoParts")
    return list(registry.REGISTRY)


def auto_tolerance(shapes):
    """Netztoleranz nach Bauteilgroesse (Phase 0: feste 0,05 mm ist fuer grosse Teile zu fein/langsam)."""
    diag = 0.0
    for s in shapes:
        bb = s.BoundingBox()
        diag = max(diag, (bb.xlen ** 2 + bb.ylen ** 2 + bb.zlen ** 2) ** 0.5)
    return max(0.01, min(0.2, diag * 0.0004))


def _assembly(name, items, taken):
    """Baugruppe aus Teilen mit Gruppenpfad, von unten nach oben gebaut (cq.Assembly kopiert beim Hinzufuegen).
    Gruppennamen werden ASCII und eindeutig, wie die Teilnamen (der STEP-Export verlangt beides)."""
    asm = cq.Assembly(name=name)
    for groups, p in items:
        if not groups:
            asm.add(p["shape"], name=p["step_name"], color=cq.Color(*p["color"]))
    order = []
    for groups, _ in items:
        if groups and groups[0] not in order:
            order.append(groups[0])
    for seg in order:
        sub_name = registry.ascii_name(seg)
        base, i = sub_name, 2
        while sub_name in taken:
            sub_name, i = f"{base}_{i}", i + 1
        taken.add(sub_name)
        asm.add(_assembly(sub_name, [(g[1:], p) for g, p in items if g and g[0] == seg], taken), name=sub_name)
    return asm


def write_outputs(root, parts, project_name):
    tol = auto_tolerance([p["shape"] for p in parts])
    timings = {}

    t = time.perf_counter()
    # Gruppen werden Unterbaugruppen der STEP-Datei, Referenzen stehen unter "Referenz" (E34)
    taken = {p["step_name"] for p in parts} | {"Referenz"}
    root_name = registry.ascii_name(project_name)
    taken.add(root_name)
    asm = _assembly(root_name, [(p.get("group", ()), p) for p in parts if p["role"] != "reference"], taken)
    refs = [p for p in parts if p["role"] == "reference"]
    if refs:
        asm.add(_assembly("Referenz", [(p.get("group", ()), p) for p in refs], taken), name="Referenz")
    (root / "output").mkdir(exist_ok=True)
    asm.export(str(root / "output" / "model.step"))
    timings["step"] = time.perf_counter() - t

    t = time.perf_counter()
    (root / ".soma").mkdir(exist_ok=True)
    # Kennung dieses Builds: verbindet model.glb, model.map.json und die exakte Geometrie fuer das Messen (E9)
    build_id = uuid.uuid4().hex
    measure.write_geometry(root / ".soma", [p["shape"] for p in parts], build_id)
    glb_parts, map_parts = [], []
    for i, p in enumerate(parts):
        pid = f"{i}:{p['step_name']}"
        bb = p["shape"].BoundingBox()
        group = "/".join(p.get("group", ())) or None
        map_parts.append(dict(
            id=pid, name=p["name"], step_name=p["step_name"], role=p["role"], group=group,
            file=_rel(p["file"], root), line=p["line"], end_line=p["end_line"],
            bbox=[[round(bb.xmin, 3), round(bb.ymin, 3), round(bb.zmin, 3)],
                  [round(bb.xmax, 3), round(bb.ymax, 3), round(bb.zmax, 3)]],
            volume=round(p["shape"].Volume(), 3)))
        # solid: geschlossener Koerper. Nur dann fuellt der Viewer die Schnittflaeche (bei offenen Flaechen waere das falsch)
        meta = dict(partId=pid, name=p["name"], role=p["role"], group=group, solid=bool(p["shape"].Solids()))
        # axis: Normteile werden in der Explosionsansicht entlang ihrer Achse herausgezogen
        if p.get("axis"):
            meta["axis"] = list(p["axis"])
        glb_parts.append(dict(meta=meta, mesh=mesher.mesh_shape(p["shape"], tol, 0.3), color=p["color"]))
    glb_size = mesher.write_glb(root / ".soma" / "model.glb", glb_parts)
    (root / ".soma" / "model.map.json").write_text(
        json.dumps(dict(version=0, build=build_id, parts=map_parts), indent=1, ensure_ascii=False), encoding="utf-8")
    timings["glb"] = time.perf_counter() - t
    return dict(glb_bytes=glb_size, tolerance=round(tol, 4), timings=timings, map_parts=map_parts)


def run_build(project_dir):
    """Kompletter Build. Schreibt .soma/build.json und gibt das Ergebnis-Dict zurueck (status ok/error)."""
    root = Path(project_dir).resolve()
    started = time.time()
    timings = {}
    result = dict(status="ok", started=started, warnings=[])
    try:
        pj = read_project_json(root)
        t = time.perf_counter()
        parts = run_model(root, pj.get("entry"))
        timings["model"] = time.perf_counter() - t
        out = write_outputs(root, parts, pj.get("name") or root.name)
        timings.update(out["timings"])
        result.update(parts=[dict(name=p["name"], role=p["role"], file=p["file"], line=p["line"]) for p in out["map_parts"]],
                      glb_bytes=out["glb_bytes"], tolerance=out["tolerance"])
    except BuildError as e:
        result.update(status="error", error=dict(kind=e.kind, message=e.message, file=e.file, line=e.line, traceback=e.tb))
    except BaseException as e:  # Fehler im Ausgabeteil (Export, Mesher): melden statt abstuerzen
        err = _error_from_exception(e, root)
        result.update(status="error", error=dict(kind="OutputError", message=err.message, file=None, line=None, traceback=err.tb))
    result["timings"] = {k: round(v, 3) for k, v in timings.items()}
    result["finished"] = time.time()
    try:
        (root / ".soma").mkdir(exist_ok=True)
        (root / ".soma" / "build.json").write_text(json.dumps(result, indent=1, ensure_ascii=False), encoding="utf-8")
    except OSError as e:
        result["warnings"].append(f"build.json konnte nicht geschrieben werden: {e}")
    return result
