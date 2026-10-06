"""`soma analyze fem <studie.py>`: Festigkeit mit der Finite-Elemente-Methode (E58, E65).

Der Agent beschreibt den Lastfall in einer Python-Datei (analyses/<name>.py) mit `Study`: welche Bauteile, aus welchem
Werkstoff, wo sie gehalten werden und welche Lasten wo angreifen. Flaechen waehlt er mit CadQuery-Selektoren (">X") oder
einem Punkt in der Naehe. Gerechnet wird linear-elastisch:

- Netz: gmsh aus den BREP-Formen des Builds, quadratische Tetraeder (10 Knoten) auf der echten Geometrie. Mehrere Teile
  werden zu einem durchgehenden Netz verschmolzen (fest verbunden, wo sie sich berühren).
- Steifigkeit selbst in numpy (vier Gausspunkte je Element), geloest mit pyamg (CG mit algebraischem Mehrgitter) oder
  bei kleinen Netzen direkt.
- Ergebnis wie bei den anderen Auswertungen: .soma/results/<name>.glb mit dem Sicherheitsfaktor als _VALUE, dazu die
  Vergleichsspannung (_STRESS) und die Verschiebung (_DISP) je Ecke und der Lastfall als Markierungen.

Melden statt glauben: Die Rechnung prueft, ob jedes Teil gehalten ist, nennt die Lagerkräfte, rechnet ein zweites Mal mit
gröberem Netz und sagt, wenn die Höchstspannung davon abhaengt (scharfe Innenkante, Rand einer Einspannung).
"""
import math
import runpy
import sys
import tempfile
import time
import traceback
from pathlib import Path

import numpy as np

from . import analysis, build, gltf, mesher


class FemError(analysis.AnalysisError):
    pass


# ---- Werkstoffe ---------------------------------------------------------------------------------------------------
# Wie im Skill "Festigkeit": E und Festigkeit in MPa, Dichte in g/cm3. Gedruckte Kunststoffe rechnen standardmaessig mit
# der Festigkeit quer zu den Schichten, weil die Rechnung die Druckrichtung nicht kennt (sicher, aber vorsichtig).

MATERIALS = {
    "PLA": dict(E=3500, nu=0.36, strength=45, across=20, density=1.24),
    "PETG": dict(E=2000, nu=0.38, strength=40, across=20, density=1.27),
    "ABS": dict(E=2000, nu=0.35, strength=30, across=15, density=1.05),
    "ASA": dict(E=2000, nu=0.35, strength=30, across=15, density=1.07),
    "PA": dict(E=1500, nu=0.39, strength=50, density=1.14),
    "POM": dict(E=3000, nu=0.35, strength=60, density=1.41),
    "PMMA": dict(E=3200, nu=0.37, strength=60, density=1.19, note="spröde"),
    "Plywood": dict(E=8000, nu=0.3, strength=40, density=0.70, note="Holz ist richtungsabhängig, gerechnet wie ein gleichmäßiger Werkstoff"),
    "Aluminium 6082": dict(E=70000, nu=0.33, strength=250, density=2.70),
    "Steel S235": dict(E=210000, nu=0.3, strength=235, density=7.85),
    "Stainless 1.4301": dict(E=200000, nu=0.3, strength=210, density=7.90),
}
ALIASES = {"nylon": "PA", "acrylic": "PMMA", "acryl": "PMMA", "sperrholz": "Plywood", "aluminium": "Aluminium 6082",
           "aluminum": "Aluminium 6082", "alu": "Aluminium 6082", "steel": "Steel S235", "stahl": "Steel S235",
           "s235": "Steel S235", "stainless": "Stainless 1.4301", "edelstahl": "Stainless 1.4301", "1.4301": "Stainless 1.4301"}


def material(spec, across_layers=True):
    """Werkstoff aus Name oder dict(E=, nu=, strength=, density=). Liefert ein dict mit name, E, nu, strength, density, note."""
    if isinstance(spec, dict):
        missing = [k for k in ("E", "strength") if k not in spec]
        if missing:
            raise FemError(f"Eigener Werkstoff braucht {', '.join(missing)} (MPa), z. B. dict(E=2500, nu=0.35, strength=40, density=1.2)")
        m = dict(name=str(spec.get("name", "eigener Werkstoff")), E=float(spec["E"]), nu=float(spec.get("nu", 0.33)),
                 strength=float(spec["strength"]), density=float(spec.get("density", 1.0)), note=spec.get("note"))
    else:
        key = str(spec).strip()
        found = next((k for k in MATERIALS if k.lower() == key.lower()), None) or ALIASES.get(key.lower())
        if not found:
            raise FemError(f"Werkstoff {spec!r} kenne ich nicht. Bekannt: {', '.join(MATERIALS)}. "
                           "Oder eigener: material=dict(E=..., nu=..., strength=..., density=...) in MPa und g/cm³")
        d = MATERIALS[found]
        strength, note = d["strength"], d.get("note")
        if "across" in d and across_layers:
            strength = d["across"]
            note = f"gedruckt: Festigkeit quer zu den Schichten ({d['across']} statt {d['strength']} MPa)"
        m = dict(name=found, E=float(d["E"]), nu=float(d["nu"]), strength=float(strength), density=float(d["density"]), note=note)
    if not (m["E"] > 0 and m["strength"] > 0 and 0 <= m["nu"] < 0.5):
        raise FemError(f"Werkstoff {m['name']}: E und Festigkeit müssen positiv sein, nu zwischen 0 und 0.5")
    return m


# ---- Lastfall (Datei des Agenten) ---------------------------------------------------------------------------------

_STUDIES = []
AXIS_NAMES = {"x": 0, "y": 1, "z": 2}


class Study:
    """Ein Lastfall. Einheiten: mm, N, MPa. Beispiel:

        study = Study("Halter unter Last", material="PETG", safety=2)
        study.fix("Halter", faces="<X")
        study.force("Halter", faces=">X", N=(0, 0, -50))
    """

    def __init__(self, title, material="PLA", safety=2.0, mesh=None, across_layers=True, parts=None, check_mesh=True):
        self.title = str(title)
        self.material_spec = material
        self.across_layers = bool(across_layers)
        self.safety = float(safety)
        self.mesh = None if mesh is None else float(mesh)
        self.extra_parts = [parts] if isinstance(parts, str) else list(parts or [])
        self.check_mesh = bool(check_mesh)
        self.materials = {}
        self.bcs = []
        self.gravity_vec = None
        self.where = _caller()
        _STUDIES.append(self)

    def set_material(self, part, material):
        """Anderer Werkstoff fuer ein Bauteil (Standard: der der Studie)."""
        self.materials[str(part)] = material
        return self

    def fix(self, part, faces=None, near=None, axes="xyz"):
        """Flächen festhalten. axes="z": nur in Z gehalten, quer frei (Auflage, Gleitlager)."""
        axes = str(axes).lower()
        if not axes or any(a not in AXIS_NAMES for a in axes):
            raise FemError(f"fix(axes={axes!r}): nur x, y, z, z. B. axes=\"xyz\" oder axes=\"z\"")
        self.bcs.append(dict(kind="fix", part=str(part), faces=faces, near=near, axes=axes, where=_caller()))
        return self

    def force(self, part, N, faces=None, near=None):
        """Gesamtkraft in N als (Fx, Fy, Fz), gleichmaessig auf die gewaehlten Flaechen verteilt."""
        v = _vec(N, "force(N=...)")
        self.bcs.append(dict(kind="force", part=str(part), faces=faces, near=near, vector=v, where=_caller()))
        return self

    def pressure(self, part, MPa, faces=None, near=None):
        """Druck in MPa (= N/mm²) senkrecht auf die Flaechen, positiv drueckt ins Material."""
        self.bcs.append(dict(kind="pressure", part=str(part), faces=faces, near=near, value=float(MPa), where=_caller()))
        return self

    def gravity(self, g=9.81, direction="-z"):
        """Eigengewicht aus der Dichte, g in m/s²."""
        d = str(direction).lower()
        sign = -1.0 if d.startswith("-") else 1.0
        ax = d.lstrip("+-")
        if ax not in AXIS_NAMES:
            raise FemError(f"gravity(direction={direction!r}): x, y, z mit Vorzeichen, z. B. \"-z\"")
        v = [0.0, 0.0, 0.0]
        v[AXIS_NAMES[ax]] = sign * float(g)
        self.gravity_vec = v
        return self


def _vec(v, what):
    try:
        out = [float(x) for x in v]
    except TypeError:
        raise FemError(f"{what}: drei Zahlen (x, y, z) erwartet, nicht {v!r}") from None
    if len(out) != 3 or not all(math.isfinite(x) for x in out):
        raise FemError(f"{what}: drei Zahlen (x, y, z) erwartet, nicht {v!r}")
    return out


def _caller():
    for fr in reversed(traceback.extract_stack()[:-2]):
        if not fr.filename.endswith(("fem.py",)):
            return dict(file=fr.filename, line=fr.lineno)
    return None


def load_study(root, rel):
    """Fuehrt die Studiendatei aus und liefert die (letzte) Study darin."""
    path = (Path(root) / rel).resolve()
    if not path.is_file():
        raise FemError(f"Studie {rel!r} nicht gefunden. Lege sie an, z. B. analyses/halter.py (siehe Skill FEM).")
    _STUDIES.clear()
    old = Path.cwd()
    sys.path.insert(0, str(root))
    import os
    os.chdir(root)
    try:
        runpy.run_path(str(path), run_name="__soma_study__")
    except FemError as e:
        raise FemError(f"{rel}: {e}") from None
    except Exception as e:  # Fehler im Code des Agenten: Zeile nennen
        tb = [f for f in traceback.extract_tb(e.__traceback__) if Path(f.filename).resolve() == path]
        at = f" (Zeile {tb[-1].lineno})" if tb else ""
        raise FemError(f"{rel}{at}: {type(e).__name__}: {e}") from None
    finally:
        os.chdir(old)
        if sys.path and sys.path[0] == str(root):
            sys.path.pop(0)
    if not _STUDIES:
        raise FemError(f"{rel} legt keine Studie an. Erwartet: from soma.fem import Study; study = Study(\"Titel\", material=\"PLA\")")
    st = _STUDIES[-1]
    if not any(b["kind"] == "fix" for b in st.bcs):
        raise FemError(f"{rel}: Die Studie hält nichts fest. Mindestens ein study.fix(...) ist nötig.")
    if not any(b["kind"] != "fix" for b in st.bcs) and st.gravity_vec is None:
        raise FemError(f"{rel}: Die Studie hat keine Last. study.force(...), study.pressure(...) oder study.gravity().")
    return st


# ---- Flaechen waehlen ---------------------------------------------------------------------------------------------

def _describe(bc):
    sel = []
    if bc.get("faces") is not None:
        sel.append(", ".join(bc["faces"]) if isinstance(bc["faces"], (list, tuple)) else str(bc["faces"]))
    if bc.get("near") is not None:
        sel.append("nahe ({:g}, {:g}, {:g})".format(*bc["near"]))
    return f"{bc['part']} {' '.join(sel) if sel else 'alle Flächen'}"


def _select(shape, bc):
    """CadQuery-Flaechen eines Teils zu einer Randbedingung."""
    import cadquery as cq
    faces = shape.Faces()
    sels = bc.get("faces")
    if sels is not None:
        chosen = []
        for s in (sels if isinstance(sels, (list, tuple)) else [sels]):
            try:
                got = cq.Workplane().add(shape).faces(str(s)).vals()
            except Exception as e:
                # Bei Tippfehlern liefert pyparsing die ganze Grammatik: nur die Stelle nennen
                msg = str(e).splitlines()[0]
                if "Expected" in msg and "found" in msg:
                    msg = "kein gültiger CadQuery-Selektor" + (f" ({msg[msg.rfind('found'):]})" if len(msg) > 200 else f" ({msg})")
                raise FemError(f"Selektor {s!r} für {bc['part']!r} geht nicht: {msg[:300]}. Beispiele: \">Z\", \"<X\", "
                               "\"%CYLINDER\", \">Z[-2]\", oder near=(x, y, z)") from None
            chosen += [f for f in got if not any(f.isSame(c) for c in chosen)]
        faces = chosen
    near = bc.get("near")
    if near is not None:
        p = cq.Vertex.makeVertex(*_vec(near, "near=(x, y, z)"))
        if not faces:
            faces = shape.Faces()
        dist = [f.distance(p) for f in faces]
        best = min(dist)
        bb = shape.BoundingBox()
        if best > 0.05 * max(bb.DiagonalLength, 1.0):
            raise FemError(f"Keine Fläche von {bc['part']!r} nahe {tuple(near)}: die nächste ist {best:.1f} mm entfernt")
        faces = [f for f, d in zip(faces, dist) if d <= best + 1e-6]
    if not faces:
        raise FemError(f"{_describe(bc)}: keine Fläche gefunden. Der Selektor wählt am Teil {bc['part']!r}, "
                       f"in dessen Lage im Modell (z. B. \">Z\" oberste Fläche, \"<X\" in -X).")
    return faces


# ---- Netz ---------------------------------------------------------------------------------------------------------

# Tet10 wie in gmsh: Ecken 0-3, dann die Kanten in dieser Reihenfolge (wird beim Einlesen geprueft)
EDGES = [(0, 1), (1, 2), (2, 0), (3, 0), (3, 2), (3, 1)]
FACES = [(1, 2, 3), (0, 3, 2), (0, 1, 3), (0, 2, 1)]  # Flaeche k liegt gegenueber Ecke k


def _mesh(parts, bcs, h, progress=None):
    """Vernetzt die Teile gemeinsam. Liefert Knoten, Tet10, Teil je Element und je Randbedingung die Flaechendreiecke
    (Ecken als Knotenindizes) samt Flaechenvergleich."""
    import gmsh
    tmp = Path(tempfile.mkdtemp(prefix="soma-fem-"))
    gmsh.initialize(readConfigFiles=False, interruptible=False)
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.option.setNumber("General.NumThreads", 0)
        gmsh.model.add("soma")
        vols = []
        for k, p in enumerate(parts):
            f = tmp / f"{k}.brep"
            p["shape"].exportBrep(str(f))
            dt = [d for d in gmsh.model.occ.importShapes(str(f)) if d[0] == 3]
            if not dt:
                raise FemError(f"{p['name']!r} ist kein Volumenkörper (nur Flächen oder Linien), so lässt es sich nicht rechnen.")
            vols.append(dt)
        owner = {}
        if len(parts) > 1:
            flat = [d for v in vols for d in v]
            _out, out_map = gmsh.model.occ.fragment(flat[:1], flat[1:])
            k = 0
            for pi, v in enumerate(vols):
                for _ in v:
                    for d in out_map[k]:
                        owner.setdefault(d[1], pi)  # Überschneidung: das zuerst genannte Teil bekommt das Stueck
                    k += 1
        else:
            owner = {d[1]: 0 for d in vols[0]}
        gmsh.model.occ.synchronize()
        gmsh.option.setNumber("Mesh.MeshSizeMax", h)
        gmsh.option.setNumber("Mesh.MeshSizeMin", h / 20)
        gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 12)
        gmsh.option.setNumber("Mesh.Optimize", 1)
        gmsh.model.mesh.generate(3)
        if progress:
            progress.step(1)  # die Vernetzung als ein Schritt, danach zaehlen die Elemente
        gmsh.model.mesh.setOrder(2)
        tags, xyz, _ = gmsh.model.mesh.getNodes()
        lut = np.full(int(tags.max()) + 1, -1, dtype=np.int64)
        lut[tags.astype(np.int64)] = np.arange(len(tags))
        nodes = xyz.reshape(-1, 3).astype(float)
        tets, epart = [], []
        for _dim, vt in gmsh.model.getEntities(3):
            types, _et, enodes = gmsh.model.mesh.getElements(3, vt)
            for ty, en in zip(types, enodes):
                if ty != 11:  # 11 = Tetraeder mit 10 Knoten
                    continue
                t = lut[en.astype(np.int64)].reshape(-1, 10)
                tets.append(t)
                epart.append(np.full(len(t), owner.get(vt, 0)))
        if not tets:
            raise FemError("gmsh hat kein Volumennetz erzeugt (Form defekt oder zu klein?)")
        tets, epart = np.concatenate(tets), np.concatenate(epart)
        # Je Randbedingung die gmsh-Flaechen, die auf den gewaehlten CadQuery-Flaechen liegen
        import cadquery as cq
        diag = float(np.linalg.norm(nodes.max(axis=0) - nodes.min(axis=0)))
        tol = max(1e-3, diag * 2e-4)
        surf = {}
        for _d, st in gmsh.model.getEntities(2):
            up, _down = gmsh.model.getAdjacencies(2, st)
            bb = gmsh.model.getBoundingBox(2, st)
            stags, sxyz, _ = gmsh.model.mesh.getNodes(2, st, includeBoundary=False)
            pts = sxyz.reshape(-1, 3)
            if not len(pts):
                _t, cxyz, _ = gmsh.model.mesh.getNodes(2, st, includeBoundary=True)
                pts = cxyz.reshape(-1, 3).mean(axis=0, keepdims=True)
            if len(pts) > 8:
                pts = pts[np.linspace(0, len(pts) - 1, 8).astype(int)]
            ty, _et, en = gmsh.model.mesh.getElements(2, st)
            tri = [lut[e.astype(np.int64)].reshape(-1, 6)[:, :3] for t2, e in zip(ty, en) if t2 == 9]
            surf[st] = dict(parts={owner.get(v) for v in up}, bb=bb, pts=pts, tri=np.concatenate(tri) if tri else np.zeros((0, 3), int),
                            area=gmsh.model.occ.getMass(2, st))
        out = []
        for bc in bcs:
            pi = bc["part_index"]
            tris, area_sel, area_hit = [], 0.0, 0.0
            for face in bc["cq_faces"]:
                fb = face.BoundingBox()
                area_sel += face.Area()
                for st, s in surf.items():
                    if pi not in s["parts"]:
                        continue
                    b = s["bb"]
                    if (b[0] < fb.xmin - tol or b[1] < fb.ymin - tol or b[2] < fb.zmin - tol
                            or b[3] > fb.xmax + tol or b[4] > fb.ymax + tol or b[5] > fb.zmax + tol):
                        continue
                    if all(face.distance(cq.Vertex.makeVertex(*map(float, q))) <= tol for q in s["pts"]):
                        tris.append(s["tri"])
                        area_hit += s["area"]
            bc_tris = np.unique(np.sort(np.concatenate(tris), axis=1), axis=0) if tris else np.zeros((0, 3), int)
            out.append(dict(tris=bc_tris, area_sel=area_sel, area_hit=area_hit))
        return nodes, tets, epart, out
    finally:
        gmsh.finalize()
        for f in tmp.glob("*"):
            try:
                f.unlink()
            except OSError:
                pass
        try:
            tmp.rmdir()
        except OSError:
            pass


def _check_edges(nodes, tets):
    """Prueft die Reihenfolge der Kantenknoten (gmsh-Konvention) an geraden Elementen."""
    x = nodes[tets[:2000]]
    for k, (a, b) in enumerate(EDGES):
        mid = (x[:, a] + x[:, b]) / 2
        size = np.linalg.norm(x[:, a] - x[:, b], axis=1)
        ok = np.linalg.norm(x[:, 4 + k] - mid, axis=1) < 0.25 * size + 1e-9
        if ok.mean() < 0.9:
            raise FemError("Unerwartete Knotenreihenfolge im Netz von gmsh (Kante %d). Bitte melden." % k)


# ---- Elemente -----------------------------------------------------------------------------------------------------

def _dshape(xi):
    """Ableitungen der 10 Formfunktionen nach (xi, eta, zeta) an einem Punkt: (10, 3)."""
    L = np.array([1 - xi[0] - xi[1] - xi[2], xi[0], xi[1], xi[2]])
    dL = np.array([[-1, -1, -1], [1, 0, 0], [0, 1, 0], [0, 0, 1]], dtype=float)
    d = np.zeros((10, 3))
    for i in range(4):
        d[i] = (4 * L[i] - 1) * dL[i]
    for k, (a, b) in enumerate(EDGES):
        d[4 + k] = 4 * (L[b] * dL[a] + L[a] * dL[b])
    return d


def _shape(xi):
    L = np.array([1 - xi[0] - xi[1] - xi[2], xi[0], xi[1], xi[2]])
    n = np.zeros(10)
    n[:4] = L * (2 * L - 1)
    for k, (a, b) in enumerate(EDGES):
        n[4 + k] = 4 * L[a] * L[b]
    return n


_A, _B = 0.5854101966249685, 0.1381966011250105
GAUSS = [((_B, _B, _B), 1 / 24), ((_A, _B, _B), 1 / 24), ((_B, _A, _B), 1 / 24), ((_B, _B, _A), 1 / 24)]
NODE_XI = [(0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1)] + [
    tuple((np.array([(0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1)][a]) + np.array([(0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1)][b])) / 2)
    for a, b in EDGES]


def _gradients(x, xi):
    """Ableitungen nach x je Element (ne, 10, 3) und det J (ne)."""
    dn = _dshape(xi)
    J = np.einsum("eni,nj->eij", x, dn)  # J_ij = dx_i / dxi_j
    det = np.linalg.det(J)
    inv = np.linalg.inv(J)
    return np.einsum("nj,eji->eni", dn, inv), det


def _bmat(g):
    """Verzerrungs-Matrix (ne, 6, 30) in Voigt-Notation xx, yy, zz, yz, xz, xy (Gleitungen doppelt)."""
    ne = len(g)
    B = np.zeros((ne, 6, 30))
    gx, gy, gz = g[:, :, 0], g[:, :, 1], g[:, :, 2]
    B[:, 0, 0::3] = gx
    B[:, 1, 1::3] = gy
    B[:, 2, 2::3] = gz
    B[:, 3, 1::3] = gz
    B[:, 3, 2::3] = gy
    B[:, 4, 0::3] = gz
    B[:, 4, 2::3] = gx
    B[:, 5, 0::3] = gy
    B[:, 5, 1::3] = gx
    return B


def _dmat(E, nu):
    """Elastizitaetsmatrix je Element (ne, 6, 6)."""
    lam = E * nu / ((1 + nu) * (1 - 2 * nu))
    mu = E / (2 * (1 + nu))
    D = np.zeros((len(E), 6, 6))
    for i in range(3):
        for j in range(3):
            D[:, i, j] = lam
        D[:, i, i] = lam + 2 * mu
        D[:, 3 + i, 3 + i] = mu
    return D


def _assemble(nodes, tets, D, progress=None, chunk=8000):
    from scipy.sparse import coo_matrix
    n = 3 * len(nodes)
    K = None
    bad = 0
    for s in range(0, len(tets), chunk):
        t = tets[s:s + chunk]
        x = nodes[t]
        Ke = np.zeros((len(t), 30, 30))
        for xi, w in GAUSS:
            g, det = _gradients(x, xi)
            bad += int((det <= 0).sum())
            B = _bmat(g)
            Ke += np.einsum("eki,ekl,elj->eij", B, D[s:s + chunk], B, optimize=True) * (w * det)[:, None, None]
        dofs = (3 * t[:, :, None] + np.arange(3)).reshape(len(t), 30)
        rows = np.repeat(dofs, 30, axis=1).reshape(-1)
        cols = np.tile(dofs, (1, 30)).reshape(-1)
        part = coo_matrix((Ke.reshape(-1), (rows, cols)), shape=(n, n)).tocsr()
        K = part if K is None else K + part
        if progress:
            progress.step(len(t))
    return K, bad


# ---- Lasten -------------------------------------------------------------------------------------------------------

def _boundary(tets):
    """Aussenflaechen: (Element, Flaeche k) fuer Dreiecke, die nur zu einem Element gehoeren."""
    tri = tets[:, FACES].reshape(-1, 3)
    key = np.sort(tri, axis=1)
    _u, inv, cnt = np.unique(key, axis=0, return_inverse=True, return_counts=True)
    ext = np.nonzero(cnt[inv.reshape(-1)] == 1)[0]
    return ext // 4, ext % 4


def _tri6(nodes, tets, el, k):
    """Aussenflaeche als Dreieck mit 6 Knoten, nach aussen gerichtet: (n, 6) Knotenindizes."""
    edge_of = {frozenset(e): 4 + i for i, e in enumerate(EDGES)}
    out = np.zeros((len(el), 6), dtype=np.int64)
    for f in range(4):
        sel = k == f
        a, b, c = FACES[f]
        loc = [a, b, c, edge_of[frozenset((a, b))], edge_of[frozenset((b, c))], edge_of[frozenset((c, a))]]
        out[sel] = tets[el[sel]][:, loc]
    # Ausrichtung pruefen: Normale weg von der gegenueberliegenden Ecke
    p = nodes[out[:, :3]]
    nrm = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0])
    opp = nodes[tets[el, k]]
    flip = np.einsum("ij,ij->i", nrm, opp - p.mean(axis=1)) > 0
    out[flip] = out[flip][:, [0, 2, 1, 5, 4, 3]]
    return out


TRI_GAUSS = [((1 / 6, 1 / 6), 1 / 6), ((2 / 3, 1 / 6), 1 / 6), ((1 / 6, 2 / 3), 1 / 6)]


def _tri_shape(r, s):
    L = np.array([1 - r - s, r, s])
    dL = np.array([[-1, -1], [1, 0], [0, 1]], dtype=float)
    n = np.zeros(6)
    d = np.zeros((6, 2))
    n[:3] = L * (2 * L - 1)
    for i in range(3):
        d[i] = (4 * L[i] - 1) * dL[i]
    for k, (a, b) in enumerate([(0, 1), (1, 2), (2, 0)]):
        n[3 + k] = 4 * L[a] * L[b]
        d[3 + k] = 4 * (L[b] * dL[a] + L[a] * dL[b])
    return n, d


def _surface_load(nodes, tri6, traction):
    """Knotenkraefte aus einer Flaechenlast. traction(normal) -> (n, 3) N/mm². Liefert (f, Flaeche, Kraft gesamt)."""
    f = np.zeros(3 * len(nodes))
    area = 0.0
    total = np.zeros(3)
    x = nodes[tri6]
    for (r, s), w in TRI_GAUSS:
        n, d = _tri_shape(r, s)
        tr = np.einsum("eni,nj->eji", x, d)  # (n, 2, 3) Tangenten
        cr = np.cross(tr[:, 0], tr[:, 1])
        ja = np.linalg.norm(cr, axis=1)
        normal = cr / np.maximum(ja, 1e-30)[:, None]
        t = traction(normal)
        area += float((w * ja).sum())
        total += (t * (w * ja)[:, None]).sum(axis=0)
        contrib = n[None, :, None] * t[:, None, :] * (w * ja)[:, None, None]  # (n, 6, 3)
        np.add.at(f, (3 * tri6[:, :, None] + np.arange(3)).reshape(-1), contrib.reshape(-1))
    return f, area, total


def _faces_area(nodes, tri6):
    _f, a, _t = _surface_load(nodes, tri6, lambda nrm: np.zeros_like(nrm))
    return a


# ---- Loesen -------------------------------------------------------------------------------------------------------

MODE_NAMES = ["Verschiebung in X", "Verschiebung in Y", "Verschiebung in Z", "Drehung um X", "Drehung um Y", "Drehung um Z"]


def _rigid_modes(x):
    c = x - x.mean(axis=0)
    n = len(x)
    R = np.zeros((3 * n, 6))
    for i in range(3):
        R[i::3, i] = 1.0
    R[1::3, 3], R[2::3, 3] = -c[:, 2], c[:, 1]
    R[0::3, 4], R[2::3, 4] = c[:, 2], -c[:, 0]
    R[0::3, 5], R[1::3, 5] = -c[:, 1], c[:, 0]
    scale = np.maximum(np.linalg.norm(R, axis=0), 1e-30)
    return R / scale


def _check_held(nodes, tets, fixed, part_names, epart):
    """Jeder zusammenhaengende Körper muss gegen alle sechs Starrkoerperbewegungen gehalten sein."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    n = len(nodes)
    c4 = tets[:, :4]
    rows = np.repeat(c4[:, 0], 3)
    cols = c4[:, 1:].reshape(-1)
    _k, lab = connected_components(coo_matrix((np.ones(len(rows)), (rows, cols)), shape=(n, n)), directed=False)
    used = np.zeros(n, bool)
    used[tets.reshape(-1)] = True
    problems = []
    for comp in np.unique(lab[tets[:, 0]]):
        nd = np.nonzero((lab == comp) & used)[0]
        names = sorted({part_names[p] for p in np.unique(epart[lab[tets[:, 0]] == comp])})
        R = _rigid_modes(nodes[nd])
        dofs = (3 * nd[:, None] + np.arange(3)).reshape(-1)
        mask = fixed[dofs]
        if not mask.any():
            problems.append(f"{', '.join(names)}: nicht gehalten (kein fix() an diesem Körper; berühren sich die Teile wirklich?)")
            continue
        _u, sv, vt = np.linalg.svd(R[mask], full_matrices=True)
        rank = int((sv > sv[0] * 1e-6).sum())
        if rank < 6:
            free = []
            for v in vt[rank:]:
                free.append(MODE_NAMES[int(np.argmax(np.abs(v)))])
            problems.append(f"{', '.join(names)}: noch frei beweglich ({', '.join(dict.fromkeys(free))})")
    if problems:
        raise FemError("Lagerung reicht nicht, die Teile können sich als Ganzes bewegen: " + "; ".join(problems)
                       + ". Mehr Flächen festhalten oder axes=\"xyz\" verwenden.")


def _solve(K, f, fixed, nodes):
    from scipy.sparse.linalg import spsolve
    free = np.nonzero(~fixed)[0]
    Kff = K[free][:, free].tocsr()
    ff = f[free]
    u = np.zeros(len(f))
    method = "direkt"
    if len(free) <= 12000:  # SuperLU wird bei 3D-Netzen schnell langsam (36000 Unbekannte: 21 s), pyamg braucht dort 1 s
        uf = spsolve(Kff.tocsc(), ff, permc_spec="MMD_AT_PLUS_A")
    else:
        import pyamg
        B = _rigid_modes(nodes)[free]
        ml = pyamg.smoothed_aggregation_solver(Kff, B=B, symmetry="symmetric", max_coarse=500, coarse_solver="splu")
        res = []
        uf = ml.solve(ff, tol=1e-8, accel="cg", maxiter=800, residuals=res)
        rel = res[-1] / max(res[0], 1e-30) if res else 1.0
        method = f"pyamg, {len(res) - 1} Schritte"
        if not rel < 1e-6:
            raise FemError(f"Der Löser kam nicht ans Ziel (Rest {rel:.1e}). Netz gröber (Study(mesh=...)) oder Lagerung prüfen.")
    u[free] = uf
    if not np.isfinite(u).all():
        raise FemError("Die Rechnung lieferte keine Zahlen (Lagerung unzureichend?)")
    return u, method


def _stresses(nodes, tets, epart, D, u, nparts):
    """Vergleichsspannung (von Mises) an den Knoten, je Teil gemittelt (an Teilgrenzen nicht ueber den Werkstoff hinweg)."""
    vm_sum = np.zeros((nparts, len(nodes)))
    cnt = np.zeros((nparts, len(nodes)))
    ue = u.reshape(-1, 3)[tets].reshape(len(tets), 30)
    x = nodes[tets]
    for j, xi in enumerate(NODE_XI):
        g, _det = _gradients(x, xi)
        s = np.einsum("eij,ejk,ek->ei", D, _bmat(g), ue)
        vm = np.sqrt(0.5 * ((s[:, 0] - s[:, 1]) ** 2 + (s[:, 1] - s[:, 2]) ** 2 + (s[:, 2] - s[:, 0]) ** 2)
                     + 3 * (s[:, 3] ** 2 + s[:, 4] ** 2 + s[:, 5] ** 2))
        np.add.at(vm_sum, (epart, tets[:, j]), vm)
        np.add.at(cnt, (epart, tets[:, j]), 1)
    return vm_sum / np.maximum(cnt, 1)


def _gravity_load(nodes, tets, dens_e, g):
    f = np.zeros(3 * len(nodes))
    x = nodes[tets]
    gv = np.asarray(g, dtype=float)
    for xi, w in GAUSS:
        _g, det = _gradients(x, xi)
        n = _shape(xi)
        m = dens_e * 1e-6 * w * det  # Masse in kg: 1 g/cm³ = 1e-6 kg/mm³, mal m/s² ergibt N
        contrib = n[None, :, None] * m[:, None, None] * gv[None, None, :]
        np.add.at(f, (3 * tets[:, :, None] + np.arange(3)).reshape(-1), contrib.reshape(-1))
    return f


def _analyse(parts, study, mats, h, progress=None):
    """Eine Rechnung mit Netzgroesse h. Liefert alles, was fuer Ergebnis und Pruefungen nötig ist."""
    names = [p["name"] for p in parts]
    nodes, tets, epart, bc_faces = _mesh(parts, study.bcs, h, progress)
    _check_edges(nodes, tets)
    E = np.array([mats[p]["E"] for p in epart])
    nu = np.array([mats[p]["nu"] for p in epart])
    D = _dmat(E, nu)
    if progress:
        progress.total += len(tets)  # Fortschritt nach Elementen, sobald ihre Zahl bekannt ist
    K, bad = _assemble(nodes, tets, D, progress)
    if bad:
        raise FemError(f"{bad} verzerrte Elemente im Netz (sehr kleine oder spitze Stellen). Netz feiner wählen: Study(mesh=...)")
    el, k = _boundary(tets)
    tri6 = _tri6(nodes, tets, el, k)
    key = np.sort(tri6[:, :3], axis=1)
    N = len(nodes)
    code = (key[:, 0] * N + key[:, 1]) * N + key[:, 2]
    order = np.argsort(code)
    f = np.zeros(3 * N)
    fixed = np.zeros(3 * N, bool)
    applied = np.zeros(3)
    bcs_out = []
    for bc, bf in zip(study.bcs, bc_faces):
        c = (bf["tris"][:, 0] * N + bf["tris"][:, 1]) * N + bf["tris"][:, 2] if len(bf["tris"]) else np.zeros(0, np.int64)
        pos = np.searchsorted(code[order], c)
        pos = np.clip(pos, 0, len(order) - 1)
        hit = order[pos][code[order][pos] == c]
        if not len(hit):
            raise FemError(f"{_describe(bc)}: die Flächen liegen nicht außen am Netz (innen an einem anderen Teil?)")
        t6 = tri6[hit]
        out = dict(kind=bc["kind"], part=bc["part"], label=_describe(bc), tri=t6, el=el[hit])
        if bc["kind"] == "fix":
            nd = np.unique(t6.reshape(-1))
            for a in bc["axes"]:
                fixed[3 * nd + AXIS_NAMES[a]] = True
            out["area"] = _faces_area(nodes, t6)
            out["axes"] = bc["axes"]
        elif bc["kind"] == "force":
            area = _faces_area(nodes, t6)
            t = np.asarray(bc["vector"]) / area
            fb, area, total = _surface_load(nodes, t6, lambda nrm: np.broadcast_to(t, nrm.shape))
            f += fb
            applied += total
            out.update(area=area, total=total.tolist())
        else:
            fb, area, total = _surface_load(nodes, t6, lambda nrm: -bc["value"] * nrm)
            f += fb
            applied += total
            out.update(area=area, total=total.tolist(), value=bc["value"])
        out["match"] = (bf["area_hit"], bf["area_sel"])
        bcs_out.append(out)
    if study.gravity_vec is not None:
        dens = np.array([mats[p]["density"] for p in epart])
        fg = _gravity_load(nodes, tets, dens, study.gravity_vec)
        f += fg
        applied += fg.reshape(-1, 3).sum(axis=0)
    _check_held(nodes, tets, fixed, names, epart)
    u, method = _solve(K, f, fixed, nodes)
    r = K @ u - f
    for b in bcs_out:
        if b["kind"] == "fix":
            nd = np.unique(b["tri"].reshape(-1))
            b["reaction"] = r.reshape(-1, 3)[nd].sum(axis=0) * np.array([a in b["axes"] for a in "xyz"])
    vm = _stresses(nodes, tets, epart, D, u, len(parts))
    return dict(nodes=nodes, tets=tets, epart=epart, tri6=tri6, el=el, u=u.reshape(-1, 3), vm=vm, bcs=bcs_out,
                applied=applied, reaction=np.where(fixed, r, 0.0).reshape(-1, 3).sum(axis=0), method=method,
                dofs=int((~fixed).sum()))


# ---- Ablauf -------------------------------------------------------------------------------------------------------

SUB = [(0, 3, 5), (3, 1, 4), (5, 4, 2), (3, 4, 5)]  # Tri6 in vier ebene Dreiecke
VALUE_CAP = 99.0


def run(root, study_rel, name=None, threshold=None):
    """Rechnet die Studie und schreibt .soma/results/<name>.glb. Liefert die Metadaten."""
    from .progress import Progress
    root = Path(root).resolve()
    try:
        all_parts = build.run_model(root)
    except build.BuildError as e:
        raise FemError(f"Das Modell lässt sich nicht bauen: {e.message}" + (f" ({e.file}:{e.line})" if e.file and e.line else "")) from None
    rel = Path(study_rel).as_posix()
    study = load_study(root, rel)
    safety = float(threshold) if threshold is not None else study.safety
    if not safety > 0:
        raise FemError("Der Sicherheitsfaktor muss größer als 0 sein")
    by_name = {}
    for p in all_parts:
        by_name.setdefault(p["name"], p)
    wanted = list(dict.fromkeys([b["part"] for b in study.bcs] + [str(x) for x in study.extra_parts] + list(study.materials)))
    missing = [w for w in wanted if w not in by_name]
    if missing:
        names = ", ".join(repr(p["name"]) for p in all_parts[:30])
        raise FemError(f"Bauteil {missing[0]!r} gibt es nicht. Bauteile: {names}")
    parts = [by_name[w] for w in wanted]
    index = {p["name"]: i for i, p in enumerate(parts)}
    mats = [material(study.materials.get(p["name"], study.material_spec), study.across_layers) for p in parts]
    for bc in study.bcs:
        bc["part_index"] = index[bc["part"]]
        bc["cq_faces"] = _select(by_name[bc["part"]]["shape"], bc)
    lo = np.min([[p["shape"].BoundingBox().xmin, p["shape"].BoundingBox().ymin, p["shape"].BoundingBox().zmin] for p in parts], axis=0)
    hi = np.max([[p["shape"].BoundingBox().xmax, p["shape"].BoundingBox().ymax, p["shape"].BoundingBox().zmax] for p in parts], axis=0)
    diag = float(np.linalg.norm(hi - lo))
    h = study.mesh or round(max(diag / 30, 0.3), 3)
    t_start = time.perf_counter()
    progress = Progress("soma analyze fem", 1, "Elemente")
    fine = _analyse(parts, study, mats, h, progress)
    coarse = None
    if study.check_mesh:
        coarse = _analyse(parts, study, mats, h * 1.6, None)
    progress.finish()
    seconds = time.perf_counter() - t_start
    return _write(root, rel, study, all_parts, parts, mats, fine, coarse, h, diag, safety, name, seconds)


def _write(root, rel, study, all_parts, parts, mats, fine, coarse, h, diag, safety, name, seconds):
    from scipy.spatial import cKDTree
    nodes, u, vm = fine["nodes"], fine["u"], fine["vm"]
    disp = np.linalg.norm(u, axis=1)
    tol = build.auto_tolerance([p["shape"] for p in parts])
    g = gltf.Glb()
    edge_mat = g.material(name="edge", pbrMetallicRoughness=dict(baseColorFactor=[0.05, 0.05, 0.05, 1.0], metallicFactor=0, roughnessFactor=1))
    face_mat = g.material(name="result", doubleSided=True, pbrMetallicRoughness=dict(baseColorFactor=[1, 1, 1, 1], metallicFactor=0, roughnessFactor=0.7))
    mark_mat = g.material(name="marker", doubleSided=True, pbrMetallicRoughness=dict(baseColorFactor=[0.5, 0.5, 0.5, 1], metallicFactor=0, roughnessFactor=1))
    children, stats = [], []
    epart_b = fine["epart"][fine["el"]]
    fixed_nodes = np.unique(np.concatenate([b["tri"].reshape(-1) for b in fine["bcs"] if b["kind"] == "fix"]))
    load_nodes = [np.unique(b["tri"].reshape(-1)) for b in fine["bcs"] if b["kind"] != "fix"]
    load_nodes = np.unique(np.concatenate(load_nodes)) if load_nodes else np.zeros(0, int)
    notes, part_fem = [], []
    for pi, p in enumerate(parts):
        t6 = fine["tri6"][epart_b == pi]
        if not len(t6):
            continue
        strength = mats[pi]["strength"]
        node_vm = vm[pi]
        sf = np.minimum(strength / np.maximum(node_vm, 1e-12), VALUE_CAP)
        sub = t6[:, SUB].reshape(-1, 3)  # Knoten je ebenem Dreieck
        tri = nodes[sub]
        fn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        area = np.linalg.norm(fn, axis=1) / 2
        fn = fn / np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-12)
        vals = sf[sub].min(axis=1)  # schlechteste Ecke: kritisch ist die Stelle, wenn eine Ecke es ist
        crit = vals < safety
        on = np.unique(t6.reshape(-1))
        w_s = on[int(np.argmax(node_vm[on]))]
        w_d = on[int(np.argmax(disp[on]))]
        st = dict(name=p["name"], group="/".join(p.get("group", ())) or None, area=round(float(area.sum()), 3),
                  critical=round(float(area[crit].sum()), 3), triangles=int(len(sub)),
                  min=round(float(sf[on].min()), 4), max=round(float(sf[on].max()), 4),
                  worst=dict(value=round(float(sf[w_s]), 4), at=[round(float(x), 3) for x in nodes[w_s]]),
                  stress=dict(value=round(float(node_vm[w_s]), 3), at=[round(float(x), 3) for x in nodes[w_s]]),
                  displacement=dict(value=round(float(disp[w_d]), 4), at=[round(float(x), 3) for x in nodes[w_d]]),
                  material=dict(name=mats[pi]["name"], E=mats[pi]["E"], strength=strength, note=mats[pi]["note"]))
        if crit.any():
            regs, count, total = analysis._regions(tri, area, vals, crit, False, max(1e-4, diag * 1e-7))
            groups = analysis._similar(regs, 0.1 * safety)
            st["regions"] = groups[:3]
            shown = sum(gr["count"] for gr in st["regions"])
            if count > shown:
                st["regionsMore"] = dict(count=count - shown, area=round(total - sum(gr["total"] for gr in st["regions"]), 2))
        # Pruefungen an der Höchstspannung
        if coarse is not None:
            cvm = coarse["vm"][pi]
            con = np.unique(coarse["tri6"][coarse["epart"][coarse["el"]] == pi].reshape(-1))
            if len(con):
                c_max = float(cvm[con].max())
                change = (float(node_vm[w_s]) - c_max) / max(c_max, 1e-12)
                st["coarse"] = dict(stress=round(c_max, 3), change=round(change, 4))
        flags = []
        if len(fixed_nodes) and np.min(np.linalg.norm(nodes[fixed_nodes] - nodes[w_s], axis=1)) < 1.5 * h:
            flags.append("am Rand einer Einspannung")
        if len(load_nodes) and np.min(np.linalg.norm(nodes[load_nodes] - nodes[w_s], axis=1)) < 1.5 * h:
            flags.append("an einer Lastfläche")
        st["peakAt"] = flags
        stats.append(st)
        # Netz fuers Bild: jede Ecke eigen, Werte an den Ecken (die Farben verlaufen)
        flat = sub.reshape(-1)
        prims = [dict(mode=4, material=face_mat, attributes=dict(
            POSITION=g.accessor(nodes[flat], "VEC3", gltf.ARRAY_BUFFER, True), NORMAL=g.accessor(np.repeat(fn, 3, axis=0), "VEC3", gltf.ARRAY_BUFFER),
            _VALUE=g.accessor(sf[flat], "SCALAR", gltf.ARRAY_BUFFER), _STRESS=g.accessor(node_vm[flat], "SCALAR", gltf.ARRAY_BUFFER),
            _DISP=g.accessor(u[flat], "VEC3", gltf.ARRAY_BUFFER)))]
        m = mesher.mesh_shape(p["shape"], tol, 0.3)
        if m["lines"].size:
            lines = np.asarray(m["lines"], dtype=float).reshape(-1, 3)
            _d, near = cKDTree(nodes[on]).query(lines)
            prims.append(dict(mode=1, material=edge_mat, attributes=dict(
                POSITION=g.accessor(lines, "VEC3", gltf.ARRAY_BUFFER, True), _DISP=g.accessor(u[on][near], "VEC3", gltf.ARRAY_BUFFER))))
        i = next(k for k, q in enumerate(all_parts) if q is p)  # partId wie im Modell, damit Ausblenden und Auswahl passen
        mesh = g.mesh(p["step_name"], prims)
        children.append(g.node(name=f"{i}:{p['step_name']}", mesh=mesh, extras=dict(soma=dict(
            partId=f"{i}:{p['step_name']}", name=p["name"], role=p["role"], group=st["group"], result=True))))
    # Lastfall als Markierungen: Flaechen (eben, nur Ecken) und je Last ein Pfeil in den Metadaten
    bcs_meta = []
    for k, b in enumerate(fine["bcs"]):
        t3 = b["tri"][:, SUB].reshape(-1, 3)
        flat = t3.reshape(-1)
        pos = nodes[flat]
        mesh = g.mesh(f"bc{k}", [dict(mode=4, material=mark_mat, attributes=dict(
            POSITION=g.accessor(pos, "VEC3", gltf.ARRAY_BUFFER, True), _DISP=g.accessor(u[flat], "VEC3", gltf.ARRAY_BUFFER)))])
        children.append(g.node(name=f"bc{k}", mesh=mesh, extras=dict(soma=dict(marker=b["kind"], bc=k))))
        tri = nodes[t3]
        a = np.linalg.norm(np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]), axis=1) / 2
        c = (tri.mean(axis=1) * a[:, None]).sum(axis=0) / max(a.sum(), 1e-12)
        entry = dict(kind=b["kind"], part=b["part"], label=b["label"], area=round(float(b["area"]), 2), at=[round(float(x), 2) for x in c])
        hit, sel = b["match"]
        if sel > 0 and abs(hit - sel) > 0.02 * sel:
            notes.append(f"{b['label']}: im Netz {hit:.1f} von {sel:.1f} mm² gefunden. Prüfe die Markierung im Bild.")
        if b["kind"] == "fix":
            entry["axes"] = b["axes"]
            entry["reaction"] = [round(float(x), 3) + 0.0 for x in b["reaction"]]
        else:
            entry["total"] = [round(float(x), 3) + 0.0 for x in b["total"]]
            if b["kind"] == "pressure":
                entry["value"] = b["value"]
        bcs_meta.append(entry)
    max_disp = float(disp.max())
    if max_disp > 0.05 * diag:  # ab etwa 5 % der Modellgröße aendert die Verformung die Lastwege merklich
        notes.append(f"Die Verformung ist groß ({max_disp:.2f} mm, {100 * max_disp / diag:.1f} % der Modellgröße). Die lineare "
                     "Rechnung gilt dann nur grob, echte Spannungen und Wege weichen ab.")
    for st in stats:
        ch = st.get("coarse", {}).get("change")
        where = " und ".join(st["peakAt"])
        if ch is not None and abs(ch) > 0.15:
            notes.append(f"{st['name']}: Die Höchstspannung haengt vom Netz ab ({st['coarse']['stress']:.1f} MPa grob, {st['stress']['value']:.1f} MPa fein)"
                         + (f", sie liegt {where}" if where else ", vermutlich an einer scharfen Innenkante")
                         + ". Dort ist der Wert nicht verlässlich: Radius vorsehen oder die Stelle mit etwas Abstand beurteilen.")
        elif where:
            notes.append(f"{st['name']}: Die Höchstspannung liegt {where}. Eine starre Einspannung oder eine Last auf kleiner Fläche "
                         "erzeugt dort oft eine zu hohe Spitze: Werte mit etwas Abstand davon beurteilen.")
        if st["material"]["note"]:
            notes.append(f"{st['name']} ({st['material']['name']}): {st['material']['note']}")
    rid = name or Path(rel).stem
    # Spanne bis zum Vierfachen der kleinsten Sicherheit (höchstens 10-fach gefordert): Ein sicheres Teil waere sonst ganz grau
    # ("weit vom Grenzwert"), man saehe nicht, wo es belastet ist
    smin = min((st["min"] for st in stats), default=safety)
    rng = [0.0, round(max(2 * safety, safety + 1, min(4 * smin, 10 * safety)), 3)]
    applied = fine["applied"]
    reaction = fine["reaction"]
    balance = float(np.linalg.norm(applied + reaction) / max(np.linalg.norm(applied), 1e-12))
    meta = dict(version=1, id=rid, kind="fem", title=study.title, quantity="Sicherheit", unit="", bad="low", threshold=safety,
                tolerance=None, range=rng, up=None, parts=stats, notes=list(dict.fromkeys(notes)), created=time.time(), neutral=None,
                seconds=round(seconds, 2),
                command=["analyze", "fem", rel] + ([f"--threshold={safety:g}"] if safety != study.safety else []) + ([f"--name={name}"] if name else []),
                fem=dict(study=rel, bcs=bcs_meta, applied=[round(float(x), 3) + 0.0 for x in applied],
                         reaction=[round(float(x), 3) + 0.0 for x in reaction], balance=round(balance, 6),
                         gravity=study.gravity_vec, maxDisp=round(max_disp, 4), diag=round(diag, 3),
                         mesh=dict(size=h, nodes=int(len(nodes)), elements=int(len(fine["tets"])), dofs=fine["dofs"], solver=fine["method"]),
                         coarse=dict(size=round(h * 1.6, 3), elements=int(len(coarse["tets"]))) if coarse else None))
    meta["summary"] = summary_text(meta)
    out = root / analysis.OUT_DIR
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"{rid}.glb"
    tmp = path.with_suffix(".glb.part")
    g.write(tmp, [g.node(name="soma-result", children=children)], extras=dict(soma_result=meta))
    gltf.replace(tmp, path)
    meta["file"] = path.relative_to(root).as_posix()
    return meta


def _v(v, unit="N"):
    return "({}) {}".format(", ".join(f"{x:.1f}" for x in v), unit)


def summary_text(meta):
    fe = meta["fem"]
    safety = meta["threshold"]
    lines = [f"FEM \"{meta['title']}\" ({fe['study']}, linear-elastisch, Sicherheit {safety:g} gefordert, kritisch darunter):"]
    for b in fe["bcs"]:
        if b["kind"] == "fix":
            ax = "" if b["axes"] == "xyz" else f" nur in {', '.join(b['axes'].upper())}"
            lines.append(f"  fest{ax}: {b['label']} ({b['area']:.1f} mm²), Lagerkraft {_v(b['reaction'])}")
        elif b["kind"] == "force":
            lines.append(f"  Kraft: {b['label']} ({b['area']:.1f} mm²), {_v(b['total'])}")
        else:
            lines.append(f"  Druck: {b['label']} ({b['area']:.1f} mm²), {b['value']:g} MPa, zusammen {_v(b['total'])}")
    if fe.get("gravity"):
        lines.append(f"  Eigengewicht: {_v(fe['gravity'], 'm/s²')}")
    for st in meta["parts"]:
        mat = st["material"]
        s, d, w = st["stress"], st["displacement"], st["worst"]
        crit = f"{st['critical'] / 100:.2f} cm² unter {safety:g}" if st["critical"] > 0 else f"nichts unter {safety:g}"
        lines.append(f"  {st['name']} ({mat['name']}, E {mat['E']:g} MPa, Festigkeit {mat['strength']:g} MPa): höchste Vergleichsspannung "
                     f"{s['value']:.1f} MPa bei {analysis._where(s['at'])}, kleinste Sicherheit {w['value']:.2f}, {crit}, "
                     f"größte Verschiebung {d['value']:.3f} mm bei {analysis._where(d['at'])}")
        for r in st.get("regions", []):
            lines.append(f"    {analysis._region_line(r, '')}")
        if st.get("regionsMore"):
            mo = st["regionsMore"]
            lines.append(f"    und {mo['count']} weitere Stelle{'n' if mo['count'] > 1 else ''}, zusammen {analysis._mm2(mo['area'])}")
    m = fe["mesh"]
    check = f"Netz {m['elements']} Tetraeder (10 Knoten, Kantenlänge bis {m['size']:g} mm), {m['dofs']} Unbekannte, {m['solver']}"
    for st in meta["parts"]:
        if st.get("coarse"):
            check += f"; {st['name']} mit gröberem Netz {st['coarse']['stress']:.1f} MPa ({round(100 * st['coarse']['change']) + 0:+d} % zum feinen)"
    lines.append(f"Kontrolle: Lagerkräfte zusammen {_v(fe['reaction'])}, Lasten {_v(fe['applied'])}"
                 f"{' (im Gleichgewicht)' if fe['balance'] < 1e-3 else f' (Abweichung {100 * fe['balance']:.2f} %)'}. {check}.")
    for n in meta.get("notes") or []:
        lines.append(f"Hinweis: {n}")
    return "\n".join(lines)
