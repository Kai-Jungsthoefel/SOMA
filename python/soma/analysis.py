"""`soma analyze`: Auswertungen am Modell mit einem Wert je Stelle der Oberflaeche (E58).

- overhang:  Ueberhangwinkel fuer den 3D-Druck (0 = senkrechte Wand, 90 = waagerecht nach unten)
- thickness: Wandstaerke (Strahl von der Oberflaeche nach innen bis zur Gegenseite)
- clearance: Abstand zu den anderen Bauteilen (negativ: Ueberschneidung)

Ergebnis je Auswertung: .soma/results/<name>.glb. Jedes Bauteil ist ein Netz mit dem Attribut _VALUE (ein Wert je
Dreieck, an seinen drei Ecken), die Kanten als Linien. Die Metadaten (Groesse, Einheit, Grenzwert, Zusammenfassung)
stehen in extras.soma_result. Der Viewer faerbt danach, `soma render --result <name>` zeigt es dem Agenten als Bild.
"""
import math
import time
from pathlib import Path

import numpy as np

from . import build, gltf, mesher

OUT_DIR = Path(".soma") / "results"

KINDS = {
    "overhang": dict(title="Überhang", quantity="Überhangwinkel", unit="°", bad="high", threshold=45.0,
                     help="Winkel zur Senkrechten fuer nach unten zeigende Flaechen, kritisch ueber dem Grenzwert"),
    "thickness": dict(title="Wandstärke", quantity="Wandstärke", unit="mm", bad="low", threshold=1.2,
                      help="Abstand zur Gegenseite des Materials, kritisch unter dem Grenzwert"),
    "clearance": dict(title="Abstand", quantity="Abstand zu anderen Bauteilen", unit="mm", bad="low", threshold=0.5,
                      help="kleinster Abstand zu einem anderen Bauteil, negativ bei Ueberschneidung, kritisch unter dem Grenzwert"),
}


class AnalysisError(Exception):
    pass


# ---- Netz -------------------------------------------------------------------------------------------------------

def _subdivide(pos, nrm, idx, h, max_tris):
    """Dreiecke halbieren, bis keine Kante laenger als h ist (oder die Hoechstzahl erreicht ist). Neue Punkte liegen auf den
    alten Kanten, die Form aendert sich nicht. Nur so bekommt eine grosse ebene Flaeche mehr als vier Messstellen."""
    for _ in range(10):
        p = pos[idx]
        l = np.max(np.stack([np.linalg.norm(p[:, 0] - p[:, 1], axis=1), np.linalg.norm(p[:, 1] - p[:, 2], axis=1),
                             np.linalg.norm(p[:, 2] - p[:, 0], axis=1)]), axis=0)
        mask = l > h
        if not mask.any() or len(idx) + 3 * int(mask.sum()) > max_tris:
            break
        sel = idx[mask]
        edges = np.concatenate([sel[:, [0, 1]], sel[:, [1, 2]], sel[:, [2, 0]]])
        uniq, inv = np.unique(np.sort(edges, axis=1), axis=0, return_inverse=True)
        inv = inv.reshape(-1)
        mid_p = (pos[uniq[:, 0]] + pos[uniq[:, 1]]) / 2
        mid_n = nrm[uniq[:, 0]] + nrm[uniq[:, 1]]
        ln = np.linalg.norm(mid_n, axis=1, keepdims=True)
        mid_n = np.where(ln > 1e-12, mid_n / np.maximum(ln, 1e-12), nrm[uniq[:, 0]])
        base = len(pos)
        pos, nrm = np.concatenate([pos, mid_p]), np.concatenate([nrm, mid_n])
        n = len(sel)
        ab, bc, ca = base + inv[:n], base + inv[n:2 * n], base + inv[2 * n:]
        a, b, c = sel[:, 0], sel[:, 1], sel[:, 2]
        new = np.concatenate([np.stack([a, ab, ca], 1), np.stack([ab, b, bc], 1), np.stack([ca, bc, c], 1), np.stack([ab, bc, ca], 1)])
        idx = np.concatenate([idx[~mask], new])
    return pos, nrm, idx


def _polydata(pos, idx):
    from vtkmodules.util.numpy_support import numpy_to_vtk, numpy_to_vtkIdTypeArray
    from vtkmodules.vtkCommonCore import vtkPoints
    from vtkmodules.vtkCommonDataModel import vtkCellArray, vtkPolyData
    pts = vtkPoints()
    pts.SetData(numpy_to_vtk(np.ascontiguousarray(pos, dtype=np.float64), deep=True))
    cells = vtkCellArray()
    conn = np.ascontiguousarray(idx.reshape(-1).astype(np.int64))
    offs = np.arange(0, len(conn) + 1, 3, dtype=np.int64)
    cells.SetData(numpy_to_vtkIdTypeArray(offs, deep=True), numpy_to_vtkIdTypeArray(conn, deep=True))
    pd = vtkPolyData()
    pd.SetPoints(pts)
    pd.SetPolys(cells)
    return pd


# ---- Auswertungen -----------------------------------------------------------------------------------------------

def _overhang(tri, normals, up):
    d = np.clip(-(normals @ up), -1.0, 1.0)
    angle = np.degrees(np.arcsin(np.clip(d, 0.0, 1.0)))
    # Flaechen, die auf dem Druckbett liegen, sind kein Ueberhang (unterste Ebene in Druckrichtung)
    h = tri @ up
    low = h.min()
    tol = max(1e-3, (h.max() - low) * 1e-4)
    bed = (angle > 89.0) & np.all(h <= low + tol, axis=1)
    angle[bed] = 0.0
    return angle


def _thickness(tri, normals, own_pd, diag):
    from vtkmodules.vtkCommonCore import vtkIdList, vtkPoints
    from vtkmodules.vtkFiltersGeneral import vtkOBBTree
    tree = vtkOBBTree()
    tree.SetDataSet(own_pd)
    tree.BuildLocator()
    eps = max(1e-4, diag * 1e-5)
    length = diag * 1.5
    cen = tri.mean(axis=1)
    pts, ids = vtkPoints(), vtkIdList()
    out = np.full(len(cen), np.nan)
    for i in range(len(cen)):
        p0 = cen[i] - normals[i] * eps
        p1 = cen[i] - normals[i] * length
        pts.Reset()
        if tree.IntersectWithLine(p0, p1, pts, ids) == 0 or pts.GetNumberOfPoints() == 0:
            continue
        best = math.inf
        for k in range(pts.GetNumberOfPoints()):
            q = pts.GetPoint(k)
            d = math.dist(q, p0)
            if d > eps * 0.5 and d < best:
                best = d
        if best < math.inf:
            out[i] = best + eps
    return out


def _clearance(tri, normals, others_pd, limit, contact):
    """Spalt vor jeder Stelle: Strahl entlang der Flaechennormalen nach aussen bis zum naechsten anderen Bauteil. So zaehlt
    der Spalt zwischen Stift und Bohrung, nicht aber eine Wand, die nur neben einer Auflageflaeche endet. Liegt die
    Stelle in einem anderen Bauteil, ist der Wert negativ (Eindringtiefe), auf einer Auflageflaeche 0."""
    from vtkmodules.vtkCommonCore import vtkIdList, vtkPoints
    from vtkmodules.vtkFiltersCore import vtkImplicitPolyDataDistance
    from vtkmodules.vtkFiltersGeneral import vtkOBBTree
    f = vtkImplicitPolyDataDistance()
    f.SetInput(others_pd)
    tree = vtkOBBTree()
    tree.SetDataSet(others_pd)
    tree.BuildLocator()
    cen = tri.mean(axis=1)
    eps = contact * 0.5
    pts, ids = vtkPoints(), vtkIdList()
    out = np.full(len(cen), float(limit))
    for i in range(len(cen)):
        sd = f.EvaluateFunction(cen[i])
        if sd < -contact:
            out[i] = max(sd, -limit)
            continue
        if abs(sd) <= contact:
            out[i] = 0.0
            continue
        if sd >= limit:
            continue
        p0 = cen[i] + normals[i] * eps
        pts.Reset()
        if tree.IntersectWithLine(p0, cen[i] + normals[i] * limit, pts, ids) and pts.GetNumberOfPoints():
            out[i] = min(math.dist(pts.GetPoint(k), cen[i]) for k in range(pts.GetNumberOfPoints()))
    return out


# ---- Ablauf -----------------------------------------------------------------------------------------------------

def _pick(parts, spec, default_roles):
    if not spec:
        return [p for p in parts if p["role"] in default_roles]
    out = []
    for s in [x.strip() for x in spec.split(",") if x.strip()]:
        hit = [p for p in parts if p["name"] == s or "/".join(p.get("group", ())) == s or "/".join(p.get("group", ())).startswith(s + "/")]
        if not hit:
            names = ", ".join(repr(p["name"]) for p in parts[:30])
            raise AnalysisError(f"Bauteil oder Gruppe {s!r} gibt es nicht. Bauteile: {names}")
        out += [p for p in hit if p not in out]
    return out


def _fmt(v, unit):
    v = v + 0.0  # kein "-0.0"
    return f"{v:.1f}{unit}" if unit == "°" else f"{v:.2f} {unit}"


def run(root, kind, parts_spec=None, threshold=None, up="z", name=None):
    """Fuehrt eine Auswertung aus, schreibt .soma/results/<name>.glb und gibt die Metadaten zurueck."""
    if kind not in KINDS:
        raise AnalysisError(f"Unbekannte Auswertung {kind!r}. Moeglich: {', '.join(KINDS)}")
    spec = KINDS[kind]
    thr = spec["threshold"] if threshold is None else float(threshold)
    root = Path(root).resolve()
    try:
        parts = build.run_model(root)
    except build.BuildError as e:
        raise AnalysisError(f"Das Modell laesst sich nicht bauen: {e.message}" + (f" ({e.file}:{e.line})" if e.file and e.line else "")) from None
    chosen = _pick(parts, parts_spec, ("part",))
    if not chosen:
        raise AnalysisError("Keine Bauteile zum Auswerten (ohne --parts zaehlen nur eigene Teile, keine Referenzen und Zukaufteile).")
    axis = {"x": (1, 0, 0), "y": (0, 1, 0), "z": (0, 0, 1), "-x": (-1, 0, 0), "-y": (0, -1, 0), "-z": (0, 0, -1)}
    if up not in axis:
        raise AnalysisError(f"--up {up!r} gibt es nicht. Moeglich: {', '.join(axis)}")
    upv = np.asarray(axis[up], dtype=float)
    tol = build.auto_tolerance([p["shape"] for p in parts])
    meshes = {p["name"]: mesher.mesh_shape(p["shape"], tol, 0.3) for p in parts}
    lo = np.min([m["positions"].min(axis=0) for m in meshes.values() if len(m["positions"])], axis=0)
    hi = np.max([m["positions"].max(axis=0) for m in meshes.values() if len(m["positions"])], axis=0)
    diag_all = float(np.linalg.norm(hi - lo))
    h = max(diag_all / 100, 0.2)
    # Beruehrung: innerhalb der Netztoleranz gilt ein Abstand als 0 (gekruemmte Flaechen weichen um die Toleranz ab)
    contact = round(max(0.01, 2 * tol), 4)
    if kind == "clearance" and len(parts) < 2:
        raise AnalysisError("Der Abstand braucht mindestens zwei Bauteile.")
    g = gltf.Glb()
    edge_mat = g.material(name="edge", pbrMetallicRoughness=dict(baseColorFactor=[0.05, 0.05, 0.05, 1.0], metallicFactor=0, roughnessFactor=1))
    face_mat = g.material(name="result", doubleSided=True, pbrMetallicRoughness=dict(baseColorFactor=[1, 1, 1, 1], metallicFactor=0, roughnessFactor=0.7))
    children, stats = [], []
    t_start = time.perf_counter()
    for i, p in enumerate(parts):
        if p not in chosen:
            continue
        m = meshes[p["name"]]
        if not m["indices"].size:
            continue
        pos, nrm, idx = m["positions"].astype(float), m["normals"].astype(float), m["indices"].astype(np.int64)
        pos2, nrm2, idx2 = _subdivide(pos, nrm, idx, h, 150000)
        tri = pos2[idx2]
        fn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        area = np.linalg.norm(fn, axis=1) / 2
        fn = fn / np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-12)
        if kind == "overhang":
            vals = _overhang(tri, fn, upv)
        elif kind == "thickness":
            diag = float(np.linalg.norm(pos.max(axis=0) - pos.min(axis=0)))
            vals = _thickness(tri, fn, _polydata(pos, idx), diag)
        else:
            from vtkmodules.vtkFiltersCore import vtkAppendPolyData
            app = vtkAppendPolyData()
            for q in parts:
                if q is not p and meshes[q["name"]]["indices"].size:
                    app.AddInputData(_polydata(meshes[q["name"]]["positions"].astype(float), meshes[q["name"]]["indices"].astype(np.int64)))
            app.Update()
            others = app.GetOutput()
            vals = _clearance(tri, fn, others, max(10 * thr, 5.0), contact)
        valid = ~np.isnan(vals)
        if kind == "thickness":
            vals = np.where(valid, vals, np.nan)
        crit = (vals > thr) if spec["bad"] == "high" else (vals < thr)
        crit &= valid
        if kind == "clearance":  # Beruehrung (aufliegender Deckel, Stift in Bohrung) ist gewollt, nicht kritisch
            crit &= np.abs(vals) > contact
        st = dict(name=p["name"], group="/".join(p.get("group", ())) or None, area=round(float(area.sum()), 3),
                  critical=round(float(area[crit].sum()), 3), triangles=int(len(idx2)))
        if valid.any():
            vv = vals[valid]
            st["min"], st["max"] = round(float(vv.min()), 4), round(float(vv.max()), 4)
            w = int(np.nanargmax(vals) if spec["bad"] == "high" else np.nanargmin(vals))
            st["worst"] = dict(value=round(float(vals[w]), 4), at=[round(float(x), 3) for x in tri[w].mean(axis=0)])
        if kind == "clearance":
            st["overlap"] = round(float(area[valid & (vals < -contact)].sum()), 3)
            st["contact"] = round(float(area[valid & (np.abs(vals) <= contact)].sum()), 3)
        if kind == "thickness":
            st["open"] = int((~valid).sum())
        stats.append(st)
        # Je Dreieck drei eigene Ecken: der Wert gilt fuer das ganze Dreieck
        flat_pos = tri.reshape(-1, 3)
        flat_nrm = nrm2[idx2].reshape(-1, 3)
        flat_val = np.repeat(np.nan_to_num(vals, nan=-1.0 if spec["bad"] == "low" else 0.0), 3)
        prims = [dict(mode=4, material=face_mat, attributes=dict(
            POSITION=g.accessor(flat_pos, "VEC3", gltf.ARRAY_BUFFER, True), NORMAL=g.accessor(flat_nrm, "VEC3", gltf.ARRAY_BUFFER),
            _VALUE=g.accessor(flat_val, "SCALAR", gltf.ARRAY_BUFFER)))]
        if m["lines"].size:
            prims.append(dict(mode=1, material=edge_mat, attributes=dict(POSITION=g.accessor(m["lines"], "VEC3", gltf.ARRAY_BUFFER, True))))
        mesh = g.mesh(p["step_name"], prims)
        children.append(g.node(name=f"{i}:{p['step_name']}", mesh=mesh, extras=dict(soma=dict(
            partId=f"{i}:{p['step_name']}", name=p["name"], role=p["role"], group=st["group"], result=True))))
    seconds = time.perf_counter() - t_start
    unit = spec["unit"]
    if kind == "overhang":
        rng = [0.0, 90.0]
    elif kind == "thickness":
        rng = [0.0, round(max(3 * thr, 1.0), 3)]
    else:
        rng = [round(-thr, 3), round(max(4 * thr, 2.0), 3)]
    rid = name or kind
    meta = dict(version=1, id=rid, kind=kind, title=spec["title"], quantity=spec["quantity"], unit=unit, bad=spec["bad"],
                threshold=thr, range=rng, up=up if kind == "overhang" else None, parts=stats, created=time.time(),
                neutral=[-contact, contact] if kind == "clearance" else None,
                seconds=round(seconds, 2), command=["analyze", kind] + ([f"--parts={parts_spec}"] if parts_spec else [])
                + [f"--threshold={thr:g}"] + ([f"--up={up}"] if kind == "overhang" and up != "z" else []) + ([f"--name={name}"] if name else []))
    meta["summary"] = summary_text(meta)
    out = root / OUT_DIR
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"{rid}.glb"
    tmp = path.with_suffix(".glb.part")
    g.write(tmp, [g.node(name="soma-result", children=children)], extras=dict(soma_result=meta))
    gltf.replace(tmp, path)
    meta["file"] = path.relative_to(root).as_posix()
    return meta


def summary_text(meta):
    unit, thr = meta["unit"], meta["threshold"]
    worse = "über" if meta["bad"] == "high" else "unter"
    head = f"{meta['title']} (Grenzwert {_fmt(thr, unit)}, kritisch {worse} dem Grenzwert)"
    if meta["kind"] == "overhang":
        head += f", Druckrichtung +{meta['up'].lstrip('-')}" if not (meta["up"] or "").startswith("-") else f", Druckrichtung {meta['up']}"
    lines = [head + ":"]
    for st in meta["parts"]:
        if "min" not in st:
            lines.append(f"  {st['name']}: keine Werte")
            continue
        rng = f"{_fmt(st['min'], unit)} bis {_fmt(st['max'], unit)}"
        crit = f"{st['critical'] / 100:.2f} cm² {worse} {_fmt(thr, unit)}" if st["critical"] > 0 else f"nichts {worse} {_fmt(thr, unit)}"
        w = st["worst"]
        where = " bei ({:.1f}, {:.1f}, {:.1f})".format(*w["at"])
        extra = ""
        if st.get("overlap"):
            extra += f", davon {st['overlap'] / 100:.2f} cm² Ueberschneidung"
        if st.get("contact"):
            extra += f", {st['contact'] / 100:.2f} cm² Beruehrung (nicht kritisch)"
        if st.get("open"):
            extra += f", {st['open']} Stellen ohne Gegenseite (offene Flaeche?)"
        worst = f", {'groesster' if meta['bad'] == 'high' else 'kleinster'} Wert {_fmt(w['value'], unit)}{where}" if st["critical"] > 0 else ""
        lines.append(f"  {st['name']}: {rng}, {crit}{extra}{worst}")
    return "\n".join(lines)


def list_results(root):
    out = []
    d = Path(root) / OUT_DIR
    for p in sorted(d.glob("*.glb")) if d.is_dir() else []:
        try:
            meta = gltf.read_json(p)["extras"]["soma_result"]
            meta["file"] = p.relative_to(Path(root)).as_posix()
            out.append(meta)
        except (OSError, ValueError, KeyError):
            continue
    return out


def find(root, name):
    return next((m for m in list_results(root) if name in (m["id"], m["title"], m["kind"])), None)
