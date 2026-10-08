"""Basismodus: beliebige STEP-Datei in GLB und Namenstabelle umwandeln, ohne Code-Bezug.

Wird fuer die Vorschau alter Staende (Versions-Schieber) und fuer fremde STEP-Dateien im Viewer gebraucht (E33, E35).
"""
import json
import uuid
from pathlib import Path

import cadquery as cq

from . import build, measure, mesher


def _flatten(assy, loc=None, groups=None):
    """Teile mit Lage und Gruppenpfad. Die oberste Baugruppe ist das Modell selbst, erst darunter beginnen Gruppen."""
    loc = (loc or cq.Location()) * assy.loc
    if assy.obj is not None:
        yield assy.name, assy.obj, assy.color, loc, groups or ()
    inner = () if groups is None else groups + (assy.name,)
    for child in assy.children:
        yield from _flatten(child, loc, inner)


def step_to_glb(step_path, out_dir):
    """Schreibt <out_dir>/model.glb und model.map.json. Liefert die Bauteilliste."""
    step_path, out = Path(step_path), Path(out_dir)
    if not step_path.is_file():
        raise FileNotFoundError(f"STEP file not found: {step_path}")
    out.mkdir(parents=True, exist_ok=True)
    assy = cq.Assembly.importStep(str(step_path))
    items = []
    groups = []
    for name, obj, color, loc, grp in _flatten(assy):
        shape = (obj.val() if isinstance(obj, cq.Workplane) else obj).moved(loc)
        items.append((name, shape, color.toTuple() if color is not None else (0.62, 0.66, 0.72, 1.0)))
        groups.append("/".join(grp) or None)
    if not items:
        raise ValueError("The STEP file contains no geometry")
    tol = build.auto_tolerance([s for _, s, _ in items])
    build_id = uuid.uuid4().hex
    measure.write_geometry(out, [s for _, s, _ in items], build_id)  # damit sich auch alte Staende vermessen lassen
    glb_parts, map_parts = [], []
    for i, (name, shape, rgba) in enumerate(items):
        name = name or f"Part {i + 1}"
        pid = f"{i}:{name}"
        bb = shape.BoundingBox()
        map_parts.append(dict(id=pid, name=name, role="basic", group=groups[i],
                              bbox=[[round(bb.xmin, 3), round(bb.ymin, 3), round(bb.zmin, 3)],
                                    [round(bb.xmax, 3), round(bb.ymax, 3), round(bb.zmax, 3)]],
                              volume=round(shape.Volume(), 3)))
        glb_parts.append(dict(meta=dict(partId=pid, name=name, role="basic", group=groups[i], solid=bool(shape.Solids())),
                              mesh=mesher.mesh_shape(shape, tol, 0.3), color=rgba))
    mesher.write_glb(out / "model.glb", glb_parts)
    (out / "model.map.json").write_text(json.dumps(dict(version=0, build=build_id, parts=map_parts), indent=1, ensure_ascii=False), encoding="utf-8")
    return map_parts
