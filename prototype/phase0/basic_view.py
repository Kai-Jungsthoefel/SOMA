"""Phase 0: Basismodus. Beliebige STEP -> GLB + map.json ohne Code-Bezug (fuer fremde Dateien in inputs/)."""
import json, sys
from pathlib import Path
import cadquery as cq
import mesher


def _flat(assy, loc=None):
    loc = (loc or cq.Location()) * assy.loc
    if assy.obj is not None:
        yield assy.name, assy.obj, assy.color, loc
    for c in assy.children:
        yield from _flat(c, loc)


def step_to_glb(step_path, out_dir, tol=0.05, ang=0.3):
    out = Path(out_dir); (out / ".cadide").mkdir(parents=True, exist_ok=True)
    assy = cq.Assembly.importStep(str(step_path))
    parts, mp = [], []
    for i, (name, obj, color, loc) in enumerate(_flat(assy)):
        shape = (obj.val() if isinstance(obj, cq.Workplane) else obj).moved(loc)
        rgba = color.toTuple() if color is not None else (0.62, 0.66, 0.72, 1.0)
        pid = f"{i}:{name}"
        parts.append(dict(meta=dict(partId=pid, name=name, role="basic"), mesh=mesher.mesh_shape(shape, tol, ang), color=rgba))
        mp.append(dict(id=pid, name=name, role="basic"))
    mesher.write_glb(out / ".cadide" / "model.glb", parts)
    (out / ".cadide" / "model.map.json").write_text(json.dumps(dict(version=0, parts=mp), indent=1, ensure_ascii=False), encoding="utf-8")
    return mp


if __name__ == "__main__":
    for p in step_to_glb(sys.argv[1], sys.argv[2]):
        print(p)
