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
    """Dreiecke an ihrer laengsten Kante halbieren, bis keine Kante laenger als h ist (oder die Hoechstzahl erreicht ist).
    Neue Punkte liegen auf den alten Kanten, die Form aendert sich nicht. Nur so bekommt eine grosse ebene Flaeche mehr als
    vier Messstellen. Nur die laengste Kante: Ein langes, schmales Dreieck (Mantel eines Zylinders) wird so zu einer Reihe.
    Beim Vierteln an allen drei Kanten wurden es Tausende, die Ergebnisse wuchsen auf 70 MB."""
    for _ in range(64):
        p = pos[idx]
        e = np.stack([np.linalg.norm(p[:, 1] - p[:, 0], axis=1), np.linalg.norm(p[:, 2] - p[:, 1], axis=1),
                      np.linalg.norm(p[:, 0] - p[:, 2], axis=1)], axis=1)
        mask = e.max(axis=1) > h
        if not mask.any() or len(idx) + int(mask.sum()) > max_tris:
            break
        sel, k = idx[mask], e[mask].argmax(axis=1)
        r = np.arange(len(sel))
        # Ecken reihum drehen, bis die laengste Kante a-b ist (Kante 0 = Ecke 0-1, 1 = 1-2, 2 = 2-0), die Umlaufrichtung bleibt
        a, b, c = sel[r, k], sel[r, (k + 1) % 3], sel[r, (k + 2) % 3]
        uniq, inv = np.unique(np.sort(np.stack([a, b], axis=1), axis=1), axis=0, return_inverse=True)
        mid_p = (pos[uniq[:, 0]] + pos[uniq[:, 1]]) / 2
        mid_n = nrm[uniq[:, 0]] + nrm[uniq[:, 1]]
        ln = np.linalg.norm(mid_n, axis=1, keepdims=True)
        mid_n = np.where(ln > 1e-12, mid_n / np.maximum(ln, 1e-12), nrm[uniq[:, 0]])
        m = len(pos) + inv.reshape(-1)
        pos, nrm = np.concatenate([pos, mid_p]), np.concatenate([nrm, mid_n])
        idx = np.concatenate([idx[~mask], np.stack([a, m, c], axis=1), np.stack([m, b, c], axis=1)])
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


def _thickness(tri, normals, own_pd, diag, progress=None):
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

    def shoot(p0, d):
        pts.Reset()
        if tree.IntersectWithLine(p0, p0 + d * length, pts, ids) == 0:
            return math.inf
        best = math.inf
        for k in range(pts.GetNumberOfPoints()):
            dist = math.dist(pts.GetPoint(k), p0)
            if eps * 0.5 < dist < best:
                best = dist
        return best

    for i in range(len(cen)):
        if progress and i % 2000 == 0:
            progress.step(min(2000, len(cen) - i))
        p0 = cen[i] - normals[i] * eps
        best = shoot(p0, -normals[i])
        if best == math.inf and np.linalg.norm(normals[i]) > 0.5:  # entartete Dreiecke haben keine Normale
            # Trifft der Strahl genau eine Ecke oder Kante des Netzes (Spitze einer Kugel, Achse eines Kegels), rutscht er
            # mitunter durch. Zwei um knapp 2 Grad gekippte Strahlen, erst wenn alle ins Leere gehen, fehlt die Gegenseite.
            t1 = np.cross(normals[i], (1.0, 0.0, 0.0) if abs(normals[i][0]) < 0.9 else (0.0, 1.0, 0.0))
            t1 /= np.linalg.norm(t1)
            t2 = np.cross(normals[i], t1)
            for t in (t1, t2):
                d = -normals[i] + 0.03 * t
                best = shoot(p0, d / np.linalg.norm(d))
                if best < math.inf:
                    break
        if best < math.inf:
            out[i] = best + eps
    return out


def _clearance(tri, normals, others_pd, limit, contact, progress=None):
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
        if progress and i % 2000 == 0:
            progress.step(min(2000, len(cen) - i))
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

def _group_path(p):
    return "/".join(p.get("group", ()))


def _pick(parts, spec, default_roles):
    """Auswahl wie in soma.anim: ein Bauteilname gilt vor einer gleichnamigen Gruppe, "Gruppe/" (mit Schraegstrich) meint
    immer die Gruppe. Liefert (Bauteile, Hinweise)."""
    if not spec:
        return [p for p in parts if p["role"] in default_roles], []
    out, notes = [], []
    for s in [x.strip() for x in spec.split(",") if x.strip()]:
        path = s.strip("/")
        group = [p for p in parts if _group_path(p) == path or _group_path(p).startswith(path + "/")]
        part = [p for p in parts if p["name"] == s]
        if part and group:
            notes.append(f"{s!r} ist Bauteil und Gruppe: ausgewertet ist das Bauteil, die Gruppe mit --parts \"{path}/\"")
        hit = part or group
        if not hit:
            names = ", ".join(repr(p["name"]) for p in parts[:30])
            groups = sorted({_group_path(p) for p in parts if p.get("group")})
            raise AnalysisError(f"Bauteil oder Gruppe {s!r} gibt es nicht. Bauteile: {names}"
                                + (f". Gruppen: {', '.join(repr(g) for g in groups)}" if groups else ""))
        out += [p for p in hit if p not in out]
    return out, notes


def _fmt(v, unit):
    v = v + 0.0  # kein "-0.0"
    return f"{v:.1f}{unit}" if unit == "°" else f"{v:.2f} {unit}"


AXES = {"x": (1, 0, 0), "y": (0, 1, 0), "z": (0, 0, 1), "-x": (-1, 0, 0), "-y": (0, -1, 0), "-z": (0, 0, -1)}
MAX_REGIONS = 200  # so viele groesste Stellen je Teil werden vermessen, der Rest nur gezaehlt


def _extent(pts):
    """Ausdehnung einer Stelle (mm), groessere zuerst: das kleinere Rechteck aus Hauptrichtungen und Achsen. Die
    Hauptrichtungen fassen einen schraegen Streifen eng, bei einem quadratischen Ring sind sie aber beliebig (Diagonale)."""
    c = pts - pts.mean(axis=0)
    _u, _s, vt = np.linalg.svd(c, full_matrices=False)
    e1 = sorted(np.ptp(c @ vt.T, axis=0).tolist(), reverse=True)[:2]
    e2 = sorted(np.ptp(pts, axis=0).tolist(), reverse=True)[:2]
    e = e1 if e1[0] * e1[1] < e2[0] * e2[1] - 1e-9 else e2
    return [round(e[0], 2), round(e[1], 2)]


def _regions(tri, area, vals, crit, high, weld):
    """Zusammenhaengende kritische Stellen: Dreiecke mit gemeinsamer Ecke gehoeren zusammen. Liefert (Stellen, Anzahl
    aller Stellen, Flaeche aller Stellen). Je Stelle Flaeche (mm2), Ausdehnung, schlechtester Wert und seine Lage."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    ids = np.nonzero(crit)[0]
    if not len(ids):
        return [], 0, 0.0
    # Die Flaechen eines Teils sind einzeln vernetzt: gleiche Ecken an den Kanten erst zusammenfuehren
    _, vid = np.unique(np.round(tri[ids].reshape(-1, 3) / weld).astype(np.int64), axis=0, return_inverse=True)
    vid = vid.reshape(-1)
    n, nv = len(ids), int(vid.max()) + 1
    graph = coo_matrix((np.ones(3 * n), (np.repeat(np.arange(n), 3), n + vid)), shape=(n + nv, n + nv))
    _k, lab = connected_components(graph, directed=False)
    lab = lab[:n]
    order = np.argsort(lab, kind="stable")
    starts = np.r_[0, np.nonzero(np.diff(lab[order]))[0] + 1]
    ends = np.r_[starts[1:], n]
    comp_area = np.add.reduceat(area[ids][order], starts)
    out = []
    for k in np.argsort(-comp_area)[:MAX_REGIONS]:
        sel = ids[order[starts[k]:ends[k]]]
        v = vals[sel]
        w = sel[int(np.argmax(v) if high else np.argmin(v))]
        out.append(dict(area=round(float(comp_area[k]), 2), size=_extent(tri[sel].reshape(-1, 3)),
                        worst=round(float(vals[w]), 4), at=[round(float(x), 2) for x in tri[w].mean(axis=0)]))
    return out, len(starts), float(comp_area.sum())


def _similar(regions, val_tol):
    """Gleichartige Stellen (Zahnspitzen, gleiche Bohrungen) zu Gruppen: Flaeche und Ausdehnung auf 15 % gleich, Wert auf
    val_tol. Groesste Gesamtflaeche zuerst."""
    groups = []
    for r in regions:
        for g in groups:
            f = g[0]
            if (abs(r["area"] - f["area"]) <= 0.15 * f["area"] + 0.01 and abs(r["worst"] - f["worst"]) <= val_tol
                    and all(abs(a - b) <= 0.15 * b + 0.05 for a, b in zip(r["size"], f["size"]))):
                g.append(r)
                break
        else:
            groups.append([r])
    groups.sort(key=lambda g: -sum(r["area"] for r in g))
    return [dict(g[0], count=len(g), total=round(sum(r["area"] for r in g), 2)) for g in groups]


def run(root, kind, parts_spec=None, threshold=None, up="z", name=None):
    """Fuehrt eine Auswertung aus, schreibt .soma/results/<name>.glb und gibt die Metadaten zurueck."""
    from .progress import Progress
    if kind not in KINDS:
        raise AnalysisError(f"Unbekannte Auswertung {kind!r}. Moeglich: {', '.join(KINDS)}")
    spec = KINDS[kind]
    high = spec["bad"] == "high"
    thr = spec["threshold"] if threshold is None else float(threshold)
    root = Path(root).resolve()
    try:
        parts = build.run_model(root)
    except build.BuildError as e:
        raise AnalysisError(f"Das Modell laesst sich nicht bauen: {e.message}" + (f" ({e.file}:{e.line})" if e.file and e.line else "")) from None
    chosen, notes = _pick(parts, parts_spec, ("part",))
    if not chosen:
        raise AnalysisError("Keine Bauteile zum Auswerten (ohne --parts zaehlen nur eigene Teile, keine Referenzen und Zukaufteile).")
    if up not in AXES:
        raise AnalysisError(f"--up {up!r} gibt es nicht. Moeglich: {', '.join(AXES)}")
    upv = np.asarray(AXES[up], dtype=float)
    tol = build.auto_tolerance([p["shape"] for p in parts])
    meshes = {p["name"]: mesher.mesh_shape(p["shape"], tol, 0.3) for p in parts}
    lo = np.min([m["positions"].min(axis=0) for m in meshes.values() if len(m["positions"])], axis=0)
    hi = np.max([m["positions"].max(axis=0) for m in meshes.values() if len(m["positions"])], axis=0)
    diag_all = float(np.linalg.norm(hi - lo))
    h = max(diag_all / 100, 0.2)
    # Beruehrung: innerhalb der Netztoleranz gilt ein Abstand als 0 (gekruemmte Flaechen weichen um die Toleranz ab)
    contact = round(max(0.01, 2 * tol), 4)
    # Werte so nah am Grenzwert, wie das Netz genau ist, zaehlen als genau auf dem Grenzwert, also nicht kritisch: Ein Dach
    # mit genau 45 Grad oder genau 0,2 mm Spiel lag durch Rundung sonst knapp darueber.
    band = 0.5 if kind == "overhang" else round(max(0.005, tol), 4)
    if kind == "clearance" and len(parts) < 2:
        raise AnalysisError("Der Abstand braucht mindestens zwei Bauteile.")
    g = gltf.Glb()
    edge_mat = g.material(name="edge", pbrMetallicRoughness=dict(baseColorFactor=[0.05, 0.05, 0.05, 1.0], metallicFactor=0, roughnessFactor=1))
    face_mat = g.material(name="result", doubleSided=True, pbrMetallicRoughness=dict(baseColorFactor=[1, 1, 1, 1], metallicFactor=0, roughnessFactor=0.7))
    children, stats = [], []
    t_start = time.perf_counter()
    work = []
    for i, p in enumerate(parts):
        m = meshes[p["name"]]
        if p not in chosen or not m["indices"].size:
            continue
        pos, nrm, idx = m["positions"].astype(float), m["normals"].astype(float), m["indices"].astype(np.int64)
        work.append((i, p, m, pos, idx, _subdivide(pos, nrm, idx, h, 150000)))
    progress = Progress(f"soma analyze {kind}", sum(len(w[5][2]) for w in work), "Messstellen")
    for i, p, m, pos, idx, (pos2, nrm2, idx2) in work:
        tri = pos2[idx2]
        fn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        area = np.linalg.norm(fn, axis=1) / 2
        fn = fn / np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-12)
        if kind == "overhang":
            vals = _overhang(tri, fn, upv)
            progress.step(len(tri))
        elif kind == "thickness":
            diag = float(np.linalg.norm(pos.max(axis=0) - pos.min(axis=0)))
            vals = _thickness(tri, fn, _polydata(pos, idx), diag, progress)
        else:
            from vtkmodules.vtkFiltersCore import vtkAppendPolyData
            app = vtkAppendPolyData()
            for q in parts:
                if q is not p and meshes[q["name"]]["indices"].size:
                    app.AddInputData(_polydata(meshes[q["name"]]["positions"].astype(float), meshes[q["name"]]["indices"].astype(np.int64)))
            app.Update()
            others = app.GetOutput()
            vals = _clearance(tri, fn, others, max(10 * thr, 5.0), contact, progress)
        valid = ~np.isnan(vals)
        vals = np.where(valid & (np.abs(vals - thr) <= band), thr, vals)
        crit = (vals > thr) if high else (vals < thr)
        crit &= valid
        if kind == "clearance":  # Beruehrung (aufliegender Deckel, Stift in Bohrung) ist gewollt, nicht kritisch
            crit &= np.abs(vals) > contact
        st = dict(name=p["name"], group=_group_path(p) or None, area=round(float(area.sum()), 3),
                  critical=round(float(area[crit].sum()), 3), triangles=int(len(idx2)))
        limit = float(area[valid & (vals == thr)].sum())
        if limit >= 0.5:
            st["limit"] = round(limit, 3)
        if valid.any():
            vv = vals[valid]
            st["min"], st["max"] = round(float(vv.min()), 4), round(float(vv.max()), 4)
            w = int(np.nanargmax(vals) if high else np.nanargmin(vals))
            st["worst"] = dict(value=round(float(vals[w]), 4), at=[round(float(x), 3) for x in tri[w].mean(axis=0)])
        if crit.any():
            regs, count, total = _regions(tri, area, vals, crit, high, max(1e-4, diag_all * 1e-7))
            groups = _similar(regs, max(band, 0.1 * abs(thr)))
            st["regions"] = groups[:3]
            shown = sum(gr["count"] for gr in st["regions"])
            if count > shown:
                st["regionsMore"] = dict(count=count - shown, area=round(total - sum(gr["total"] for gr in st["regions"]), 2))
        if kind == "overhang" and st["critical"] > 0:
            # Eine andere Druckrichtung, die deutlich weniger Ueberhang hat? Kostet nichts, es haengt nur an den Normalen.
            best = min(((ax, float(area[_overhang(tri, fn, np.asarray(v, dtype=float)) > thr + band].sum())) for ax, v in AXES.items()),
                       key=lambda x: x[1])
            if best[0] != up and best[1] < 0.5 * st["critical"] and st["critical"] - best[1] >= 10.0:
                st["betterUp"] = dict(up=best[0], critical=round(best[1], 3))
        if kind == "clearance":
            st["overlap"] = round(float(area[valid & (vals < -contact)].sum()), 3)
            st["contact"] = round(float(area[valid & (np.abs(vals) <= contact)].sum()), 3)
        if kind == "thickness":  # ohne entartete Dreiecke (Flaeche 0, keine Richtung fuer den Strahl)
            st["open"] = int((~valid & (area > 1e-9)).sum())
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
    progress.finish()
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
                threshold=thr, tolerance=band, range=rng, up=up if kind == "overhang" else None, parts=stats, notes=notes,
                created=time.time(), neutral=[-contact, contact] if kind == "clearance" else None,
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


def _where(at):
    return "({:.1f}, {:.1f}, {:.1f})".format(*at)


def _mm2(a):
    return f"{a:.1f} mm²" if a >= 1 else f"{a:.2f} mm²"


def _region_line(r, unit):
    size = f"{r['size'][0]:.1f} x {r['size'][1]:.1f} mm"
    if r.get("count", 1) > 1:
        return f"{r['count']} gleichartige Stellen je {_mm2(r['area'])} in {size}, bis {_fmt(r['worst'], unit)}, z. B. bei {_where(r['at'])}"
    return f"{_mm2(r['area'])} in {size}, bis {_fmt(r['worst'], unit)} bei {_where(r['at'])}"


def summary_text(meta):
    unit, thr = meta["unit"], meta["threshold"]
    worse = "über" if meta["bad"] == "high" else "unter"
    head = f"{meta['title']} (Grenzwert {_fmt(thr, unit)}, kritisch {worse} dem Grenzwert"
    if meta.get("tolerance"):
        head += f", auf ±{meta['tolerance']:g}{'°' if unit == '°' else ' ' + unit} genau"
    head += ")"
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
        extra = ""
        if st.get("limit"):
            extra += f", {st['limit'] / 100:.2f} cm² genau am Grenzwert"
        if st.get("overlap"):
            extra += f", davon {st['overlap'] / 100:.2f} cm² Ueberschneidung"
        if st.get("contact"):
            extra += f", {st['contact'] / 100:.2f} cm² Beruehrung (nicht kritisch)"
        if st.get("open"):
            extra += f", {st['open']} Stellen ohne Gegenseite (offene Flaeche?)"
        if st.get("betterUp"):
            b = st["betterUp"]
            extra += f", mit --up {b['up']} nur {b['critical'] / 100:.2f} cm²"
        worst = f", {'groesster' if meta['bad'] == 'high' else 'kleinster'} Wert {_fmt(w['value'], unit)} bei {_where(w['at'])}" if st["critical"] > 0 else ""
        lines.append(f"  {st['name']}: {rng}, {crit}{extra}{worst}")
        for r in st.get("regions", []):
            lines.append(f"    {_region_line(r, unit)}")
        if st.get("regionsMore"):
            mo = st["regionsMore"]
            lines.append(f"    und {mo['count']} weitere Stelle{'n' if mo['count'] > 1 else ''}, zusammen {_mm2(mo['area'])}")
    for n in meta.get("notes") or []:
        lines.append(f"Hinweis: {n}")
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
