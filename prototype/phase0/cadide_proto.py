"""Phase 0: Prototyp der Hilfsbibliothek `cadide` (Arbeitsname). Nur so viel, wie die Pruefpunkte brauchen.

    from cadide_proto import add_part, import_step
    add_part("Deckel", obj, role="part", color=(0.8, 0.8, 0.8))

`build(projektordner)` fuehrt model.py aus und schreibt
    output/model.step        Hauptergebnis, Namen (ASCII) + Farben, Referenzteile in eigenem Ast "Referenz"
    .cadide/model.glb        Viewer-Cache mit Flaechen-/Kanten-IDs
    .cadide/model.map.json   Bauteil -> Datei/Zeile, Anzeigename, Rolle, Bounding-Box, Volumen
"""
import inspect
import json
import os
import runpy
import sys
import time
import unicodedata
from pathlib import Path

import cadquery as cq

import mesher

_REGISTRY = []  # wird pro build() geleert
DEFAULT_COLORS = {"part": (0.62, 0.66, 0.72), "reference": (0.1, 0.65, 0.3)}
REF_ALPHA = 0.45

_TRANSLIT = {"ä": "ae", "ö": "oe", "ü": "ue", "Ä": "Ae", "Ö": "Oe", "Ü": "Ue", "ß": "ss", "×": "x"}


def ascii_name(name):
    """STEP-Namen nur ASCII: der CadQuery-/OCCT-Export kodiert Nicht-ASCII doppelt (siehe ERGEBNISSE.md)."""
    s = "".join(_TRANSLIT.get(ch, ch) for ch in name)
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    s = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in s.strip()).strip("_")
    return s or "part"


def _to_shape(obj):
    if isinstance(obj, cq.Workplane):
        vals = obj.vals()
        if not vals:
            raise ValueError("Workplane ist leer (keine Geometrie)")
        return vals[0] if len(vals) == 1 else cq.Compound.makeCompound(vals)
    if isinstance(obj, cq.Shape):
        return obj
    raise TypeError(f"add_part erwartet cq.Workplane oder cq.Shape, nicht {type(obj).__name__}")


def add_part(name, obj, role="part", color=None):
    """Registriert ein Bauteil. Merkt sich Datei und Zeile des Aufrufs (fuer Klick -> Code)."""
    if role not in ("part", "reference"):
        raise ValueError(f"role muss 'part' oder 'reference' sein, nicht {role!r}")
    if any(p["name"] == name for p in _REGISTRY):
        raise ValueError(f"Bauteilname {name!r} ist schon vergeben (Namen muessen eindeutig sein)")
    step_name = ascii_name(name)
    if any(p["step_name"] == step_name for p in _REGISTRY):
        raise ValueError(f"Bauteilname {name!r} ergibt den STEP-Namen {step_name!r}, der schon vergeben ist")
    fr = inspect.currentframe().f_back
    pos = inspect.getframeinfo(fr, context=0).positions  # Python >= 3.11: Start- und Endzeile des Aufrufs
    rgb = color or DEFAULT_COLORS[role]
    alpha = REF_ALPHA if role == "reference" else 1.0
    _REGISTRY.append(dict(
        name=name, step_name=step_name, role=role, shape=_to_shape(obj), color=(*rgb[:3], alpha),
        file=fr.f_code.co_filename, line=pos.lineno, end_line=pos.end_lineno,
    ))


def import_step(path):
    """Importiert eine mitgebrachte STEP-Datei als Shape (Geometrie; Namen/Farben siehe xcaf_tools)."""
    return cq.importers.importStep(str(path)).val()


def _rel(path, root):
    try:
        return Path(path).resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return str(path)


def build(project_dir, tol=0.05, ang=0.3):
    root = Path(project_dir).resolve()
    _REGISTRY.clear()
    timings = {}
    old_cwd = os.getcwd()
    os.chdir(root)
    sys.path.insert(0, str(Path(__file__).parent))
    try:
        t = time.perf_counter()
        runpy.run_path(str(root / "model.py"), run_name="__main__")
        timings["model.py"] = time.perf_counter() - t
    finally:
        os.chdir(old_cwd)
    if not _REGISTRY:
        raise RuntimeError("model.py hat kein Bauteil ueber add_part(...) registriert")

    # STEP: Hauptergebnis mit Namen und Farben
    t = time.perf_counter()
    asm = cq.Assembly(name=ascii_name(root.name))
    refs = [p for p in _REGISTRY if p["role"] == "reference"]
    for p in (q for q in _REGISTRY if q["role"] != "reference"):
        asm.add(p["shape"], name=p["step_name"], color=cq.Color(*p["color"]))
    if refs:
        ref_asm = cq.Assembly(name="Referenz")
        for p in refs:
            ref_asm.add(p["shape"], name=p["step_name"], color=cq.Color(*p["color"]))
        asm.add(ref_asm, name="Referenz")
    (root / "output").mkdir(exist_ok=True)
    asm.export(str(root / "output" / "model.step"))
    timings["step"] = time.perf_counter() - t

    # GLB + Mapping
    t = time.perf_counter()
    (root / ".cadide").mkdir(exist_ok=True)
    glb_parts, map_parts = [], []
    for i, p in enumerate(_REGISTRY):
        pid = f"{i}:{p['step_name']}"
        bb = p["shape"].BoundingBox()
        map_parts.append(dict(
            id=pid, name=p["name"], step_name=p["step_name"], role=p["role"],
            file=_rel(p["file"], root), line=p["line"], end_line=p["end_line"],
            bbox=[[round(bb.xmin, 3), round(bb.ymin, 3), round(bb.zmin, 3)],
                  [round(bb.xmax, 3), round(bb.ymax, 3), round(bb.zmax, 3)]],
            volume=round(p["shape"].Volume(), 3),
        ))
        glb_parts.append(dict(
            meta=dict(partId=pid, name=p["name"], role=p["role"]),
            mesh=mesher.mesh_shape(p["shape"], tol, ang), color=p["color"]))
    size = mesher.write_glb(root / ".cadide" / "model.glb", glb_parts)
    (root / ".cadide" / "model.map.json").write_text(
        json.dumps(dict(version=0, parts=map_parts), indent=1, ensure_ascii=False), encoding="utf-8")
    timings["glb"] = time.perf_counter() - t
    return dict(parts=len(_REGISTRY), glb_bytes=size, timings={k: round(v, 3) for k, v in timings.items()},
                shapes={p["name"]: p["shape"] for p in _REGISTRY})
