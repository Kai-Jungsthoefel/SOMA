"""`soma analyze fem <study.py>`: strength with the finite element method (E58, E65, E84).

The agent describes the load case in a Python file (analyses/<name>.py) with `Study`: which parts, of which material,
where they are held and which loads act where. Faces are chosen with CadQuery selectors (">X") or a point nearby.
The material is linear elastic:

- Mesh: gmsh from the BREP shapes of the build, quadratic tetrahedra (10 nodes) on the real geometry. Several parts
  are meshed together and bonded where they touch, unless `study.contact(a, b)` makes the touching faces a contact
  (can lift off, slides without or with friction). `study.bolt(screw)` preloads a screw from soma.fasteners before
  the loads act.
- Solved with CalculiX (ccx, see soma.ccx). Without ccx, and only without contact, with the built-in solver: stiffness
  in numpy (four Gauss points per element), pyamg (CG with algebraic multigrid) or direct for small meshes.
- Result as with the other analyses: .soma/results/<name>.glb with the safety factor as _VALUE, plus the von Mises
  stress (_STRESS), the displacement (_DISP) and with contact the contact pressure (_PRESS) per vertex, and the load
  case as markers.

Report instead of trust: the calculation checks that every part is held, gives the reaction forces, names the parts
that touch and how they are joined, calculates a second time with a coarser mesh and says when the peak stress depends
on it (sharp inner edge, edge of a fixed support).
"""
import math
import os
import runpy
import sys
import tempfile
import time
import traceback
from pathlib import Path

import numpy as np

from . import analysis, build, ccx, gltf, mesher


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
    "PMMA": dict(E=3200, nu=0.37, strength=60, density=1.19, note="brittle"),
    "Plywood": dict(E=8000, nu=0.3, strength=40, density=0.70, note="wood depends on the grain direction, calculated as a uniform material"),
    "Aluminium 6082": dict(E=70000, nu=0.33, strength=250, density=2.70),
    "Steel S235": dict(E=210000, nu=0.3, strength=235, density=7.85),
    "Stainless 1.4301": dict(E=200000, nu=0.3, strength=210, density=7.90),
}
ALIASES = {"nylon": "PA", "acrylic": "PMMA", "acryl": "PMMA", "sperrholz": "Plywood", "aluminium": "Aluminium 6082",
           "aluminum": "Aluminium 6082", "alu": "Aluminium 6082", "steel": "Steel S235", "stahl": "Steel S235",
           "s235": "Steel S235", "stainless": "Stainless 1.4301", "edelstahl": "Stainless 1.4301", "1.4301": "Stainless 1.4301"}


# Festigkeitsklassen von Schrauben: Streckgrenze Rp0.2 in MPa (ISO 898-1 bis M16, ISO 3506-1) und E-Modul
GRADES = {"4.6": (240, 210000), "4.8": (340, 210000), "5.6": (300, 210000), "5.8": (420, 210000), "6.8": (480, 210000),
          "8.8": (640, 210000), "10.9": (940, 210000), "12.9": (1100, 210000), "A2-70": (450, 200000),
          "A4-70": (450, 200000), "A2-80": (600, 200000), "A4-80": (600, 200000)}
# Vorspannung ohne Angabe: 70 % der Streckgrenze im Spannungsquerschnitt (ueblich nach VDI 2230 sind 70 bis 90 %
# einschliesslich der Torsion beim Anziehen, die hier fehlt)
AUTO_PRELOAD = 0.7
# Ab diesem Anteil der Streckgrenze meldet das Ergebnis eine Schraube als ueberlastet (Vergleichsspannung aus Zug und Schub)
BOLT_LIMIT = 0.9


def material(spec, across_layers=True):
    """Material from a name or dict(E=, nu=, strength=, density=). Returns a dict with name, E, nu, strength, density, note."""
    if isinstance(spec, dict):
        missing = [k for k in ("E", "strength") if k not in spec]
        if missing:
            raise FemError(f"A custom material needs {', '.join(missing)} (MPa), e.g. dict(E=2500, nu=0.35, strength=40, density=1.2)")
        m = dict(name=str(spec.get("name", "custom material")), E=float(spec["E"]), nu=float(spec.get("nu", 0.33)),
                 strength=float(spec["strength"]), density=float(spec.get("density", 1.0)), note=spec.get("note"))
    else:
        key = str(spec).strip()
        found = next((k for k in MATERIALS if k.lower() == key.lower()), None) or ALIASES.get(key.lower())
        if not found:
            raise FemError(f"Unknown material {spec!r}. Known: {', '.join(MATERIALS)}. "
                           "Or a custom one: material=dict(E=..., nu=..., strength=..., density=...) in MPa and g/cm³")
        d = MATERIALS[found]
        strength, note = d["strength"], d.get("note")
        if "across" in d and across_layers:
            strength = d["across"]
            note = f"printed: strength across the layers ({d['across']} instead of {d['strength']} MPa)"
        m = dict(name=found, E=float(d["E"]), nu=float(d["nu"]), strength=float(strength), density=float(d["density"]), note=note)
    if not (m["E"] > 0 and m["strength"] > 0 and 0 <= m["nu"] < 0.5):
        raise FemError(f"Material {m['name']}: E and strength must be positive, nu between 0 and 0.5")
    return m


# ---- Lastfall (Datei des Agenten) ---------------------------------------------------------------------------------

_STUDIES = []
AXIS_NAMES = {"x": 0, "y": 1, "z": 2}


class Study:
    """A load case. Units: mm, N, MPa. Example:

        study = Study("Bracket under load", material="PETG", safety=2)
        study.fix("Bracket", faces="<X")
        study.force("Bracket", faces=">X", N=(0, 0, -50))
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
        self.contacts = []
        self.bolts = []
        self.gravity_vec = None
        self.where = _caller()
        _STUDIES.append(self)

    def set_material(self, part, material):
        """Another material for one part (default: the material of the study)."""
        self.materials[str(part)] = material
        return self

    def fix(self, part, faces=None, near=None, axes="xyz"):
        """Hold faces fixed. axes="z": held only in Z, free across (a support, a sliding bearing)."""
        axes = str(axes).lower()
        if not axes or any(a not in AXIS_NAMES for a in axes):
            raise FemError(f"fix(axes={axes!r}): only x, y, z, e.g. axes=\"xyz\" or axes=\"z\"")
        self.bcs.append(dict(kind="fix", part=str(part), faces=faces, near=near, axes=axes, where=_caller()))
        return self

    def force(self, part, N, faces=None, near=None):
        """Total force in N as (Fx, Fy, Fz), spread evenly over the chosen faces."""
        v = _vec(N, "force(N=...)")
        self.bcs.append(dict(kind="force", part=str(part), faces=faces, near=near, vector=v, where=_caller()))
        return self

    def pressure(self, part, MPa, faces=None, near=None):
        """Pressure in MPa (= N/mm²) normal to the faces, positive presses into the material."""
        self.bcs.append(dict(kind="pressure", part=str(part), faces=faces, near=near, value=float(MPa), where=_caller()))
        return self

    def contact(self, part_a, part_b, friction=0.0):
        """The faces where the two parts touch become a contact instead of bonded: they press on each other, can lift
        off and slide. friction=0: slides freely; friction=0.2 (steel on steel, dry) to 0.5 (plastic, rubber): sticks
        until the sideways force exceeds friction times the pressing force."""
        a, b = str(part_a), str(part_b)
        if a == b:
            raise FemError(f"contact({a!r}, {b!r}): two different parts are needed")
        try:
            mu = float(friction)
        except (TypeError, ValueError):
            raise FemError(f"contact(friction={friction!r}): a number, e.g. 0.2") from None
        if not 0 <= mu <= 2:
            raise FemError(f"contact(friction={mu:g}): between 0 and 2 (dry steel about 0.2, plastics 0.3 to 0.5)")
        if any({c["a"], c["b"]} == {a, b} for c in self.contacts):
            raise FemError(f"contact({a!r}, {b!r}) is given twice")
        self.contacts.append(dict(a=a, b=b, friction=mu, where=_caller()))
        return self

    def bolt(self, screw, preload=None, grade="8.8"):
        """A screw from soma.fasteners as a preloaded bolt: it is tightened with `preload` first, then the loads act.
        Head and thread (tapped hole or nut) are bonded, the shank in the clearance hole is free and stretches.
        preload: force in N. None: 70 % of the yield strength of the screw, at most what the faces under the head bear.
        grade: property class "8.8" (default), "10.9", "12.9", "A2-70" ... Give the faces between the clamped parts a
        contact, study.contact(a, b, friction=0.2): then the result shows whether the joint opens or slips."""
        name = str(screw)
        g = str(grade).strip().upper()
        if g not in GRADES:
            raise FemError(f"bolt({name!r}, grade={grade!r}): known property classes are {', '.join(GRADES)}")
        pf = None
        if preload is not None:
            try:
                pf = float(preload)
            except (TypeError, ValueError):
                raise FemError(f"bolt({name!r}, preload={preload!r}): a force in N, e.g. preload=2000, or leave it out") from None
            if not pf > 0:
                raise FemError(f"bolt({name!r}, preload={pf:g}): the preload must be greater than 0 N")
        if any(b["part"] == name for b in self.bolts):
            raise FemError(f"bolt({name!r}) is given twice")
        self.bolts.append(dict(part=name, preload=pf, grade=g, where=_caller()))
        return self

    def gravity(self, g=9.81, direction="-z"):
        """Self-weight from the density, g in m/s²."""
        d = str(direction).lower()
        sign = -1.0 if d.startswith("-") else 1.0
        ax = d.lstrip("+-")
        if ax not in AXIS_NAMES:
            raise FemError(f"gravity(direction={direction!r}): x, y, z with a sign, e.g. \"-z\"")
        v = [0.0, 0.0, 0.0]
        v[AXIS_NAMES[ax]] = sign * float(g)
        self.gravity_vec = v
        return self


def _vec(v, what):
    try:
        out = [float(x) for x in v]
    except TypeError:
        raise FemError(f"{what}: expected three numbers (x, y, z), not {v!r}") from None
    if len(out) != 3 or not all(math.isfinite(x) for x in out):
        raise FemError(f"{what}: expected three numbers (x, y, z), not {v!r}")
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
        raise FemError(f"Study {rel!r} not found. Create it, e.g. analyses/bracket.py (see the skill \"Strength with FEM\").")
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
        at = f" (line {tb[-1].lineno})" if tb else ""
        raise FemError(f"{rel}{at}: {type(e).__name__}: {e}") from None
    finally:
        os.chdir(old)
        if sys.path and sys.path[0] == str(root):
            sys.path.pop(0)
    if not _STUDIES:
        raise FemError(f"{rel} creates no study. Expected: from soma.fem import Study; study = Study(\"Title\", material=\"PLA\")")
    st = _STUDIES[-1]
    if not any(b["kind"] == "fix" for b in st.bcs):
        raise FemError(f"{rel}: The study holds nothing fixed. At least one study.fix(...) is needed.")
    if not any(b["kind"] != "fix" for b in st.bcs) and st.gravity_vec is None and not st.bolts:
        raise FemError(f"{rel}: The study has no load. study.force(...), study.pressure(...) or study.gravity().")
    return st


# ---- Flaechen waehlen ---------------------------------------------------------------------------------------------

def _describe(bc):
    sel = []
    if bc.get("faces") is not None:
        sel.append(", ".join(bc["faces"]) if isinstance(bc["faces"], (list, tuple)) else str(bc["faces"]))
    if bc.get("near") is not None:
        sel.append("near ({:g}, {:g}, {:g})".format(*bc["near"]))
    return f"{bc['part']} {' '.join(sel) if sel else 'all faces'}"


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
                    msg = "not a valid CadQuery selector" + (f" ({msg[msg.rfind('found'):]})" if len(msg) > 200 else f" ({msg})")
                raise FemError(f"Selector {s!r} for {bc['part']!r} does not work: {msg[:300]}. Examples: \">Z\", \"<X\", "
                               "\"%CYLINDER\", \">Z[-2]\", or near=(x, y, z)") from None
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
            raise FemError(f"No face of {bc['part']!r} near {tuple(near)}: the nearest is {best:.1f} mm away")
        faces = [f for f, d in zip(faces, dist) if d <= best + 1e-6]
    if not faces:
        raise FemError(f"{_describe(bc)}: no face found. The selector picks on the part {bc['part']!r}, "
                       f"in its position in the model (e.g. \">Z\" the top face, \"<X\" in -X).")
    return faces


# ---- Netz ---------------------------------------------------------------------------------------------------------

# Tet10 wie in gmsh: Ecken 0-3, dann die Kanten in dieser Reihenfolge (wird beim Einlesen geprueft)
EDGES = [(0, 1), (1, 2), (2, 0), (3, 0), (3, 2), (3, 1)]
FACES = [(1, 2, 3), (0, 3, 2), (0, 1, 3), (0, 2, 1)]  # Flaeche k liegt gegenueber Ecke k


def _mesh_failure(e, parts, h):
    """Verstaendliche Meldung, wenn gmsh nicht vernetzen kann (die Meldung von gmsh steht am Ende fuer Rueckfragen)."""
    msg = str(e).strip().splitlines()[-1] if str(e).strip() else type(e).__name__
    other = [round(h * 1.6, 2), round(h / 2, 2)]
    text = f"The mesher could not mesh the {'parts' if len(parts) > 1 else 'part'} (edge length {h:g} mm). "
    if len(parts) > 1:
        text += ("This usually comes from parts that overlap or almost touch, which leaves very thin slivers between them, "
                 "or from very small details. Check the overlaps with soma analyze clearance, calculate fewer parts at once, or ")
    else:
        text += "This usually comes from very small details or sharp spots. "
    size = f"set a different mesh size, e.g. Study(mesh={other[0]:g}) or Study(mesh={other[1]:g})"
    return text + (size if len(parts) > 1 else size[0].upper() + size[1:]) + f". (gmsh: {msg[:200]})"


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
                raise FemError(f"{p['name']!r} is not a solid (only faces or lines), so it cannot be calculated.")
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
        # gmsh wirft rohe Meldungen ("unable to find 106 1110 0 1" aus der Randrekonstruktion). Typisch bei mehreren Teilen,
        # die sich etwas durchdringen: fragment hinterlaesst dort hauchduenne Splitter, an denen das 3D-Netz scheitert
        try:
            gmsh.model.mesh.generate(3)
            if progress:
                progress.step(1)  # die Vernetzung als ein Schritt, danach zaehlen die Elemente
            gmsh.model.mesh.setOrder(2)
        except Exception as e:
            raise FemError(_mesh_failure(e, parts, h)) from None

        def extract():
            tags, xyz, _ = gmsh.model.mesh.getNodes()
            lut = np.full(int(tags.max()) + 1, -1, dtype=np.int64)
            lut[tags.astype(np.int64)] = np.arange(len(tags))
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
                raise FemError("gmsh created no volume mesh (broken or too small shape?)")
            return lut, xyz.reshape(-1, 3).astype(float), np.concatenate(tets), np.concatenate(epart)
        lut, nodes, tets, epart = extract()
        # Beim Kruemmen auf die Geometrie klappen in engen Spalten einzelne Elemente um (Scheibe M8 mit 8.4 mm Bohrung
        # auf der Mutter: 0.2 mm Ring, 25 Elemente). Die elastische Glaettung von gmsh behebt das in wenigen Sekunden,
        # nur dann, damit Netze ohne Fehler gleich bleiben
        if _check_jacobians(nodes, tets):
            gmsh.model.mesh.optimize("HighOrderElastic")
            lut, nodes, tets, epart = extract()
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
            raise FemError("Unexpected node order in the gmsh mesh (edge %d). Please report this." % k)


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

MODE_NAMES = ["moving in X", "moving in Y", "moving in Z", "turning about X", "turning about Y", "turning about Z"]


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


def _check_held(nodes, tets, fixed, part_names, epart, links=None, normals=None):
    """Jeder zusammenhaengende Körper muss gegen alle sechs Starrkoerperbewegungen gehalten sein.

    links: Knotenpaare (m, 2), die als verbunden gelten (Kontakt mit Reibung haelt wie verklebt, solange er nicht
    rutscht, das zeigt erst die Rechnung). normals: (Knoten, Normale) an Kontaktflaechen ohne Reibung, sie halten
    nur senkrecht zur Flaeche."""
    from scipy.sparse import coo_matrix
    from scipy.sparse.csgraph import connected_components
    n = len(nodes)
    c4 = tets[:, :4]
    rows = np.repeat(c4[:, 0], 3)
    cols = c4[:, 1:].reshape(-1)
    if links is not None and len(links):
        rows = np.concatenate([rows, links[:, 0]])
        cols = np.concatenate([cols, links[:, 1]])
    _k, lab = connected_components(coo_matrix((np.ones(len(rows)), (rows, cols)), shape=(n, n)), directed=False)
    used = np.zeros(n, bool)
    used[tets.reshape(-1)] = True
    nn_nodes, nn_vec = normals if normals is not None else (np.zeros(0, int), np.zeros((0, 3)))
    problems = []
    for comp in np.unique(lab[tets[:, 0]]):
        nd = np.nonzero((lab == comp) & used)[0]
        names = sorted({part_names[p] for p in np.unique(epart[lab[tets[:, 0]] == comp])})
        R = _rigid_modes(nodes[nd])
        dofs = (3 * nd[:, None] + np.arange(3)).reshape(-1)
        mask = fixed[dofs]
        C = [R[mask]]
        # Kontakt ohne Reibung: je Knoten der Flaeche eine Zeile n . (Bewegung des Knotens)
        sel = np.isin(nn_nodes, nd)
        if sel.any():
            pos = np.searchsorted(nd, nn_nodes[sel])
            Rn = R.reshape(len(nd), 3, 6)[pos]
            C.append(np.einsum("ij,ijk->ik", nn_vec[sel], Rn))
        C = np.concatenate(C)
        if not len(C):
            problems.append(f"{', '.join(names)}: not held (no fix() on this body; do the parts really touch?)")
            continue
        _u, sv, vt = np.linalg.svd(C, full_matrices=True)
        rank = int((sv > sv[0] * 1e-6).sum())
        if rank < 6:
            free = []
            for v in vt[rank:]:
                free.append(MODE_NAMES[int(np.argmax(np.abs(v)))])
            via = " (held only by a contact without friction, which does not hold sideways)" if sel.any() and not mask.any() else ""
            problems.append(f"{', '.join(names)}: still free ({', '.join(dict.fromkeys(free))}){via}")
    if problems:
        hint = (" Fix more faces, use axes=\"xyz\", give the contact friction= or leave the parts bonded."
                if len(nn_nodes) else " Fix more faces or use axes=\"xyz\".")
        raise FemError("The supports are not enough, the parts can move as a whole: " + "; ".join(problems) + "." + hint)


# ---- Beruehrflaechen und Kontakt ----------------------------------------------------------------------------------

def _interfaces(tets, epart):
    """Elementflaechen, die zwei Teile gemeinsam haben (gemeinsames Netz aus fragment): {(pa, pb): (el_a, k_a, el_b, k_b)}
    mit pa < pb."""
    key = np.sort(tets[:, FACES].reshape(-1, 3), axis=1)
    _u, inv, cnt = np.unique(key, axis=0, return_inverse=True, return_counts=True)
    inv = inv.reshape(-1)
    shared = np.nonzero(cnt[inv] == 2)[0]
    if not len(shared):
        return {}
    pairs = shared[np.argsort(inv[shared], kind="stable")].reshape(-1, 2)
    e1, e2 = pairs[:, 0] // 4, pairs[:, 1] // 4
    p1, p2 = epart[e1], epart[e2]
    out = {}
    diff = p1 != p2
    pairs, p1, p2 = pairs[diff], p1[diff], p2[diff]
    swap = p1 > p2
    pairs[swap] = pairs[swap][:, ::-1]
    lo, hi = np.minimum(p1, p2), np.maximum(p1, p2)
    for a, b in set(zip(lo.tolist(), hi.tolist())):
        s = np.nonzero((lo == a) & (hi == b))[0]
        fa, fb = pairs[s, 0], pairs[s, 1]
        out[(a, b)] = (fa // 4, fa % 4, fb // 4, fb % 4)
    return out


def _face6(tets, el, k):
    """Knoten einer Elementflaeche (Ecken, dann Kantenmitten), ohne Ausrichtung: (n, 6)."""
    edge_of = {frozenset(e): 4 + i for i, e in enumerate(EDGES)}
    out = np.zeros((len(el), 6), dtype=np.int64)
    for f in range(4):
        s = k == f
        a, b, c = FACES[f]
        out[s] = tets[el[s]][:, [a, b, c, edge_of[frozenset((a, b))], edge_of[frozenset((b, c))], edge_of[frozenset((c, a))]]]
    return out


def _split(nodes, tets, epart, faces, side):
    """Trennt die Knoten einer Beruehrflaeche: Die Elemente von Teil `side` bekommen eigene Kopien aller Knoten auf den
    Flaechen `faces` (el, k dieses Teils). Liefert (nodes, tets, remap fuer die Knoten des Teils, Paare alt/neu)."""
    dup = np.unique(_face6(tets, faces[0], faces[1]).reshape(-1))
    new = np.arange(len(nodes), len(nodes) + len(dup))
    remap = np.arange(len(nodes) + len(dup))
    remap[dup] = new
    tets = tets.copy()
    own = epart == side
    tets[own] = remap[tets[own]]
    # Ein drittes Teil, das an einer Kante der Beruehrflaeche mit `side` verklebt ist, haengt danach dort am anderen
    # Teil. Selten (drei Teile an einer Kante) und an einer Linie, das aendert das Ergebnis kaum
    return np.vstack([nodes, nodes[dup]]), tets, remap, np.column_stack([dup, new])


def _reactions(nodes, tets, D, u, f, fixed):
    """Lagerkraefte K u - f, nur aus den Elementen an gehaltenen Knoten (an freien Knoten ist es 0). Die Knotenkraefte, die
    CalculiX in die frd schreibt, taugen dafuer nicht: Am Winkel aus dem Skill fehlten 5 % (45.4 statt 49 N), obwohl seine
    Verschiebungen mit K u = f bis auf 1e-6 stimmten."""
    held = np.zeros(len(nodes), bool)
    held[np.nonzero(fixed)[0] // 3] = True
    sel = np.nonzero(held[tets].any(axis=1))[0]
    return np.where(fixed, _internal(nodes, tets, D, u, sel) - f, 0.0)


def _internal(nodes, tets, D, u, sel):
    """Innere Knotenkraefte K_e u_e der Elemente sel, summiert je Knoten: (3 n,)."""
    r = np.zeros(3 * len(nodes))
    if len(sel):
        t = tets[sel]
        x = nodes[t]
        ue = u.reshape(-1, 3)[t].reshape(len(t), 30)
        fe = np.zeros((len(t), 30))
        for xi, w in GAUSS:
            g, det = _gradients(x, xi)
            B = _bmat(g)
            sig = np.einsum("eij,ejk,ek->ei", D[sel], B, ue)
            fe += np.einsum("eki,ek->ei", B, sig) * (w * det)[:, None]
        np.add.at(r, (3 * t[:, :, None] + np.arange(3)).reshape(-1), fe.reshape(-1))
    return r


def _check_jacobians(nodes, tets, chunk=20000):
    """Zahl verzerrter Elemente (det J <= 0 an einem Gausspunkt), wie in _assemble, ohne die Matrix zu bauen."""
    bad = 0
    for s in range(0, len(tets), chunk):
        x = nodes[tets[s:s + chunk]]
        for xi, _w in GAUSS:
            dn = _dshape(xi)
            bad += int((np.linalg.det(np.einsum("eni,nj->eij", x, dn)) <= 0).sum())
    return bad


def _solve(K, f, fixed, nodes):
    from scipy.sparse.linalg import spsolve
    free = np.nonzero(~fixed)[0]
    Kff = K[free][:, free].tocsr()
    ff = f[free]
    u = np.zeros(len(f))
    method = "direct"
    if len(free) <= 12000:  # SuperLU wird bei 3D-Netzen schnell langsam (36000 Unbekannte: 21 s), pyamg braucht dort 1 s
        uf = spsolve(Kff.tocsc(), ff, permc_spec="MMD_AT_PLUS_A")
    else:
        import pyamg
        B = _rigid_modes(nodes)[free]
        ml = pyamg.smoothed_aggregation_solver(Kff, B=B, symmetry="symmetric", max_coarse=500, coarse_solver="splu")
        res = []
        uf = ml.solve(ff, tol=1e-8, accel="cg", maxiter=800, residuals=res)
        rel = res[-1] / max(res[0], 1e-30) if res else 1.0
        method = f"pyamg, {len(res) - 1} iterations"
        if not rel < 1e-6:
            raise FemError(f"The solver did not converge (residual {rel:.1e}). Use a coarser mesh (Study(mesh=...)) or check the supports.")
    u[free] = uf
    if not np.isfinite(u).all():
        raise FemError("The calculation gave no numbers (supports insufficient?)")
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


# ---- Schrauben (bolt) ----------------------------------------------------------------------------------------------

def _bb_overlap(a, b, tol=0.05):
    return not (a.xmax < b.xmin - tol or b.xmax < a.xmin - tol or a.ymax < b.ymin - tol or b.ymax < a.ymin - tol
                or a.zmax < b.zmin - tol or b.zmax < a.zmin - tol)


def _bolt_groups(study, all_parts, by_name):
    """Je Schraube die Teile, die zur Verschraubung gehoeren: alles, was die Schraube beruehrt oder schneidet, und weiter
    ueber Normteile (Mutter, Scheibe), nicht ueber die verschraubten Teile hinaus. {Schraube: [Namen]}"""
    from .fasteners import Screw
    out = {}
    cands = [p for p in all_parts if p["role"] != "reference"]
    for b in study.bolts:
        p = by_name[b["part"]]
        obj = p.get("fastener")
        if not isinstance(obj, Screw):
            raise FemError(f"bolt({b['part']!r}): not a screw from soma.fasteners. bolt() needs Screw(...) passed to "
                           "add_part (it knows size, head and axis). Model other screws with fix() on the face under the "
                           "head, or leave them bonded.")
        if obj.head == "set":
            raise FemError(f"bolt({b['part']!r}): a set screw has no head to clamp with. Leave it bonded.")
        names, todo = [p["name"]], [p]
        while todo:
            cur = todo.pop()
            bb = cur["shape"].BoundingBox()
            for q in cands:
                if q["name"] in names or not _bb_overlap(bb, q["shape"].BoundingBox()):
                    continue
                if cur["shape"].distance(q["shape"]) < 1e-3:
                    names.append(q["name"])
                    if q.get("fastener") is not None:
                        todo.append(q)
        out[b["part"]] = names
    return out


def _stress_area(d, pitch):
    """Spannungsquerschnitt des Gewindes (ISO 898-1): aus Flanken- und Kerndurchmesser."""
    d2, d3 = d - 0.649519 * pitch, d - 1.226869 * pitch
    return math.pi / 4 * ((d2 + d3) / 2) ** 2


def _prepare_bolts(study, parts, mats, groups):
    """Formen fuer die Rechnung und je Schraube die Angaben fuer den Vorspannschnitt. Aendert parts (Kopien)."""
    import cadquery as cq
    from .fasteners import Screw
    if not study.bolts:
        return []
    names = [p["name"] for p in parts]
    # Schrauben aus Teilen schneiden, in die sie hineinragen: Das Kernloch ist kleiner als der Schaft (Gewinde). Sonst
    # entsteht beim gemeinsamen Vernetzen ein duenner Ring aus verzerrten Elementen. Danach liegen Schaft und Gewindeteil
    # flaechig aneinander und sind dort verklebt
    for p in parts:
        if not isinstance(p.get("fastener"), Screw):
            continue
        sb = p["shape"].BoundingBox()
        vol = p["shape"].Volume()
        for q in parts:
            if q is p or q.get("fastener") is not None or not _bb_overlap(sb, q["shape"].BoundingBox(), 0.0):
                continue
            if q["shape"].intersect(p["shape"]).Volume() > 1e-6 * vol:
                q["shape"] = q["shape"].cut(p["shape"])
    out = []
    for b in study.bolts:
        pi = names.index(b["part"])
        p = parts[pi]
        sc = p["fastener"]
        d = float(sc.d)
        seat = cq.Vector(*sc.seat)
        ax = cq.Vector(*sc.direction).normalized()  # vom Sitz in das Material, zur Spitze
        ref = cq.Vector(1, 0, 0) if abs(ax.x) < 0.9 else cq.Vector(0, 1, 0)
        e1 = ref.cross(ax).normalized()
        e2 = ax.cross(e1)
        others = [q for q in parts if q is not p and q["name"] in groups[b["part"]]]
        t0 = sc.head_height if sc.head == "countersunk" else 0.0

        def holder(t, r):
            """Das Teil (ausser der Schraube), in dem Punkte im Abstand r von der Achse bei t liegen, sonst None."""
            for a in range(8):
                ang = 2 * math.pi * a / 8
                pt = seat + ax * t + e1 * (r * math.cos(ang)) + e2 * (r * math.sin(ang))
                for q in others:
                    if q["shape"].isInside(pt, 1e-6):
                        return q
            return None
        # Gewinde: wo knapp ausserhalb des Schafts (0.51 d) Material ist. Durchgangsloecher (ISO 273) sind mindestens 1.05 d
        step = max(0.05, min(0.25, d / 20))
        t, engaged = t0 + step / 2, None
        while t < sc.length:
            engaged = holder(t, 0.51 * d)
            if engaged is not None:
                break
            t += step
        if engaged is None:
            raise FemError(f"bolt({b['part']!r}): the thread grips nothing. A bolt needs a nut or a tapped hole in a part "
                           "of the model (Nut(...) on the shank, or cut(screw.tap_hole())).")
        free = t - t0
        if free < max(0.5, 0.2 * d):
            raise FemError(f"bolt({b['part']!r}): the shank is gripped right under the head (by {engaged['name']!r}), so "
                           "it cannot stretch. The clamped part needs a clearance hole: cut(screw.clearance_hole()).")
        ts = t0 + free / 2
        point = seat + ax * ts
        # Schaft quer teilen: zwei Koerper derselben Schraube, das gemeinsame Netz hat dort eine ebene Flaeche
        tool = cq.Solid.makeCylinder(2 * sc.head_diameter + d, 2 * sc.length + 10, point, ax)
        lower, upper = p["shape"].intersect(tool), p["shape"].cut(tool)
        p["shape"] = cq.Compound.makeCompound([upper, lower])
        rp = mats[pi]["strength"]
        As = _stress_area(d, sc.pitch)
        preload, limit = b["preload"], None
        if preload is None:
            preload, limit = AUTO_PRELOAD * rp * As, "screw"
            # Auflage unter dem Kopf: erstes verschraubtes Teil (kein Normteil) unter dem Kopf, halb zwischen Loch und Rand
            dw = sc.key if sc.head == "hex" else sc.head_diameter
            dh = sc.clearance("medium")
            r_mid = (dw + dh) / 4
            tt, under = 0.05, None
            while tt < min(free + t0, sc.length) and under is None:
                for a in range(8):
                    ang = 2 * math.pi * a / 8
                    pt = seat + ax * tt + e1 * (r_mid * math.cos(ang)) + e2 * (r_mid * math.sin(ang))
                    hit = next((q for q in others if q.get("fastener") is None and q["shape"].isInside(pt, 1e-6)), None)
                    if hit is not None:
                        under = hit
                        break
                tt += step
            if under is not None:
                bearing = mats[names.index(under["name"])]["strength"] * math.pi / 4 * max(dw ** 2 - dh ** 2, 0.0)
                if 0 < bearing < preload:
                    preload, limit = bearing, under["name"]
        out.append(dict(part=b["part"], index=pi, designation=sc.designation, grade=b["grade"], d=d, As=As, yield_=rp,
                        preload=float(preload), auto=b["preload"] is None, limit=limit, engaged=engaged["name"],
                        point=np.array(point.toTuple()), axis=np.array(ax.toTuple()),
                        hardware=[q["name"] for q in parts if q["name"] in groups[b["part"]] and q.get("fastener") is not None]))
    return out


def _cut_shank(nodes, tets, epart, b):
    """Trennt die Knoten im Vorspannschnitt: Die Elemente auf der Seite der Spitze bekommen eigene Kopien. Liefert
    (nodes, tets, Paare Kopfseite/Spitzenseite, Elemente der Spitzenseite)."""
    P, ax, d = b["point"], b["axis"], b["d"]
    own = np.nonzero(epart == b["index"])[0]
    cen = nodes[tets[own, :4]].mean(axis=1)
    tip = own[(cen - P) @ ax > 0]
    tol = 1e-5 * max(d, 1.0)
    F = np.array(FACES)
    el, k = [], []
    for f in range(4):
        c = nodes[tets[tip][:, F[f]]] - P
        dist = c @ ax
        rad = np.linalg.norm(c - dist[..., None] * ax, axis=2)
        on = (np.abs(dist) < tol).all(axis=1) & (rad < 0.55 * d).all(axis=1)
        el.append(tip[on])
        k.append(np.full(int(on.sum()), f))
    el, k = np.concatenate(el), np.concatenate(k)
    want = math.pi / 4 * d * d
    area = _faces_area(nodes, _tri6(nodes, tets, el, k)) if len(el) else 0.0
    if abs(area - want) > 0.1 * want:
        raise FemError(f"bolt({b['part']!r}): the shank could not be cut for the preload (found {area:.1f} of {want:.1f} mm² "
                       "in the mesh). A finer mesh may help: Study(mesh=...)")
    dup = np.unique(_face6(tets, el, k).reshape(-1))
    new = np.arange(len(nodes), len(nodes) + len(dup))
    remap = np.arange(len(nodes) + len(dup))
    remap[dup] = new
    tets = tets.copy()
    tets[tip] = remap[tets[tip]]
    return np.vstack([nodes, nodes[dup]]), tets, np.column_stack([dup, new]), tip


def _bolt_results(nodes, tets, D, u, bolts, cuts, forces):
    """Je Schraube Kraft am Ende (vom Vorspannknoten), Querkraft im Schnitt (innere Kraefte der Spitzenseite an den
    Schnittknoten) und Auslastung der Streckgrenze aus Zug und Schub im Spannungsquerschnitt."""
    out = []
    for b, (pairs, tip), fv in zip(bolts, cuts, forces):
        r = _internal(nodes, tets, D, u, tip)
        F = r.reshape(-1, 3)[pairs[:, 1]].sum(axis=0)
        ax = b["axis"]
        axial = float(fv[0])
        shear = float(np.linalg.norm(F - (F @ ax) * ax))
        sig, tau = axial / b["As"], shear / b["As"]
        use = math.sqrt(sig ** 2 + 3 * tau ** 2) / b["yield_"]
        out.append(dict(part=b["part"], designation=b["designation"], grade=b["grade"], preload=round(b["preload"], 1),
                        auto=b["auto"], limit=b["limit"], force=round(axial, 1), shear=round(shear, 1),
                        stress=round(sig, 2), utilization=round(use, 4), engaged=b["engaged"],
                        at=[round(float(x), 3) for x in b["point"]], hardware=b["hardware"]))
    return out


def _analyse(parts, study, mats, h, progress=None, bolts=()):
    """Eine Rechnung mit Netzgroesse h. Liefert alles, was fuer Ergebnis und Pruefungen nötig ist."""
    names = [p["name"] for p in parts]
    index = {n: i for i, n in enumerate(names)}
    nodes, tets, epart, bc_faces = _mesh(parts, study.bcs, h, progress)
    _check_edges(nodes, tets)
    diag = float(np.linalg.norm(nodes.max(axis=0) - nodes.min(axis=0)))
    # Beruehrflaechen fuer den Bericht, vor dem Trennen
    inter = _interfaces(tets, epart)
    touching = {key: _faces_area(nodes, _tri6(nodes, tets, v[0], v[1])) for key, v in inter.items()}
    # Schrauben: Schaft im Vorspannschnitt trennen (CalculiX koppelt die Seiten wieder, siehe soma.ccx)
    cuts, links = [], []
    for b in bolts:
        nodes, tets, pairs, tip = _cut_shank(nodes, tets, epart, b)
        cuts.append((pairs, tip))
        links.append(pairs)  # fuer die Haltpruefung haengen die Seiten zusammen
    # Kontakt: Knoten der Beruehrflaeche trennen. Das weichere Teil ist die Slave-Seite (bei gleichem E das zweite)
    contacts, splits = [], []
    for c in study.contacts:
        a, b = index[c["a"]], index[c["b"]]
        key = (min(a, b), max(a, b))
        if key not in inter:
            raise FemError(f"contact({c['a']!r}, {c['b']!r}): the parts do not touch (no common faces in the mesh). A contact "
                           "needs faces that lie on each other; a gap or a part that only touches along a line or a point "
                           "does not count. Model the parts touching, or leave out contact().")
        ea, ka, eb, kb = inter[key]
        lo, hi = key
        if mats[lo]["E"] < mats[hi]["E"]:
            slave, sf, master, mf = lo, (ea, ka), hi, (eb, kb)
        else:
            slave, sf, master, mf = hi, (eb, kb), lo, (ea, ka)
        nodes, tets, remap, pairs = _split(nodes, tets, epart, sf, slave)
        splits.append((slave, remap))
        if c["friction"] > 0:
            links.append(pairs)
        e_min = min(mats[lo]["E"], mats[hi]["E"])
        # Kontaktgesetz (soma.ccx.write_input): linear mit dem E-Modul. Das Zehnfache (Empfehlung von CalculiX: 5 bis 50)
        # brauchte bei einer Platte, die zum Teil abhebt, 18 statt 11 Iterationen und pendelte bei einer, die fast ganz
        # abhebt, ohne Ende; die Verschiebungen unterschieden sich um 0.4 %. Rueckfall exponentiell mit Spalt c0 und Druck
        # p0 bei Spalt 0 (p0 folgt unten aus der Last)
        contacts.append(dict(spec=c, slave=slave, master=master, sf=sf, mf=mf, key=key, stiffness=e_min, stick=e_min,
                             c0=min(0.05, max(0.002, 1e-4 * diag)), e_min=e_min))
    # Flaechen der Randbedingungen in der Nummerierung nach dem Trennen
    for bc, bf in zip(study.bcs, bc_faces):
        for side, remap in splits:
            if bc["part_index"] == side and len(bf["tris"]):
                bf["tris"] = np.sort(remap[bf["tris"]], axis=1)
    E = np.array([mats[p]["E"] for p in epart])
    nu = np.array([mats[p]["nu"] for p in epart])
    D = _dmat(E, nu)
    if progress:
        progress.total += len(tets)  # Fortschritt nach Elementen, sobald ihre Zahl bekannt ist
    use_ccx = os.environ.get("SOMA_FEM_SOLVER", "").lower() != "builtin" and ccx.find() is not None
    if (contacts or bolts) and not use_ccx:
        what = "contact()" if contacts else "bolt()"
        raise FemError(f"{what} needs CalculiX (ccx), which was not found. It comes with SOMA (in the folder ccx next to "
                       f"the Python environment); without it, leave out {what} so the parts are bonded.")
    K = None
    if use_ccx:
        bad = _check_jacobians(nodes, tets)
    else:
        K, bad = _assemble(nodes, tets, D, progress)
    if bad:
        raise FemError(f"{bad} distorted elements in the mesh (very small or sharp spots). Choose a finer mesh: Study(mesh=...)")
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
            raise FemError(f"{_describe(bc)}: the faces are not on the outside of the mesh (inside, against another part?)")
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
    # Kontaktflaechen als Dreiecke mit 6 Knoten (nach dem Trennen), ohne Reibung halten sie nur senkrecht
    nrm_nodes, nrm_vec = [], []
    load = float(np.linalg.norm(f.reshape(-1, 3), axis=1).sum())
    for c in contacts:
        c["s6"] = _tri6(nodes, tets, *c["sf"])
        c["m6"] = _tri6(nodes, tets, *c["mf"])
        # Druck bei Spalt 0 im weichen Gesetz: ein Zwanzigstel der mittleren Pressung, wenn die ganze Last ueber diese
        # Flaeche ginge. Vorher E/70000 (3 MPa bei Stahl): Bei 200 N auf 3600 mm² (0.06 MPa) drueckte das die Teile
        # auseinander, die Rechnung lief davon
        c["p0"] = float(np.clip(0.05 * load / max(touching[c["key"]], 1e-9), 1e-6, max(0.1, c["e_min"] / 70000)))
        if c["spec"]["friction"] == 0:
            for t6 in (c["s6"], c["m6"]):
                p = nodes[t6[:, :3]]
                nv = np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0])
                nv /= np.maximum(np.linalg.norm(nv, axis=1, keepdims=True), 1e-30)
                nrm_nodes.append(t6[:, :3].reshape(-1))
                nrm_vec.append(np.repeat(nv, 3, axis=0))
    _check_held(nodes, tets, fixed, names, epart, links=np.concatenate(links) if links else None,
                normals=(np.concatenate(nrm_nodes), np.concatenate(nrm_vec)) if nrm_nodes else None)
    notes = []
    cvals = None
    u = None
    bolts_out = []
    if use_ccx:
        done = [0]

        def step(frac):
            if progress:
                n = int(frac * len(tets)) - done[0]
                if n > 0:
                    progress.step(n)
                    done[0] += n
        spec = [dict(slave=list(zip(*c["sf"])), master=list(zip(*c["mf"])), friction=c["spec"]["friction"],
                     stiffness=c["stiffness"], stick=c["stick"], c0=c["c0"], p0=c["p0"]) for c in contacts]
        bspec = [dict(pairs=pairs, point=b["point"], normal=-b["axis"], preload=b["preload"]) for b, (pairs, _t) in zip(bolts, cuts)]
        try:
            try:
                res = ccx.run(nodes, tets, epart, mats, f, fixed, spec, size=diag, progress=step, bolts=bspec)
            except ccx.CcxError as e:
                if e.kind != "chatter" or not contacts:
                    raise
                # Pendelt der Kontakt, mit dem weichen Gesetz noch einmal (gemeldet, nicht still)
                res = ccx.run(nodes, tets, epart, mats, f, fixed, spec, size=diag, progress=step, law="exponential", bolts=bspec)
                notes.append(f"The contact did not settle with the stiff contact law and was calculated with a softer one "
                             f"(pressure starts {contacts[0]['c0']:.2g} mm before touching). Pressure peaks at edges are "
                             "smoothed, the parts sink into each other by about that much.")
            u, cvals = res["u"].reshape(-1), res["contact"]
            if res.get("rf") is not None:
                # CalculiX zaehlt Lasten, die auf gehaltenen Knoten sitzen, nicht mit (dort nimmt sie das Lager direkt auf)
                r = np.where(fixed, res["rf"].reshape(-1) - f, 0.0)
            else:
                r = _reactions(nodes, tets, D, u, f, fixed)
            method = f"CalculiX {res['version'] or ''}".strip() + f", {res['threads']} threads"
            if contacts:
                method += f", {res['increments']} load step{'s' if res['increments'] != 1 else ''}"
            if bolts:
                bolts_out = _bolt_results(nodes, tets, D, u, bolts, cuts, res["bolts"])
        except ccx.CcxError as e:
            if contacts or bolts:
                raise FemError(_contact_failure(e, study.contacts, study.bolts)) from None
            notes.append(f"CalculiX failed ({e}). Calculated with the built-in solver instead.")
            K, _bad = _assemble(nodes, tets, D, None)
        if progress and done[0] < len(tets):
            progress.step(len(tets) - done[0])
    elif os.environ.get("SOMA_FEM_SOLVER", "").lower() != "builtin":
        notes.append("CalculiX (ccx) was not found, calculated with the built-in solver (no contact possible).")
    if u is None:
        u, method = _solve(K, f, fixed, nodes)
        r = K @ u - f
    for b in bcs_out:
        if b["kind"] == "fix":
            nd = np.unique(b["tri"].reshape(-1))
            b["reaction"] = r.reshape(-1, 3)[nd].sum(axis=0) * np.array([a in b["axes"] for a in "xyz"])
    vm = _stresses(nodes, tets, epart, D, u, len(parts))
    press, contacts_out = (_contact_results(nodes, u.reshape(-1, 3), contacts, cvals, f, np.where(fixed, r, 0.0), tets, D) if contacts
                           else (None, []))
    return dict(nodes=nodes, tets=tets, epart=epart, tri6=tri6, el=el, u=u.reshape(-1, 3), vm=vm, bcs=bcs_out,
                applied=applied, reaction=np.where(fixed, r, 0.0).reshape(-1, 3).sum(axis=0), method=method,
                dofs=int((~fixed).sum()), touching=touching, contacts=contacts_out, press=press, notes=notes, bolts=bolts_out)


def _contact_failure(e, specs, bolts=()):
    pairs = ", ".join([f"{c['a']} – {c['b']}" + (f" (friction {c['friction']:g})" if c["friction"] else " (no friction)") for c in specs]
                      + [f"bolt {b['part']}" for b in bolts])
    if e.kind == "diverged":
        return (f"The calculation with contact does not hold together: a part moves without limit. Contact: {pairs}. "
                "Usually a part held only by a contact slides (friction too low for the sideways force, or no friction) "
                "or lifts off (the load pulls it away). Add friction, a fix() on that part, or leave the parts bonded.")
    if e.kind == "increments":
        return (f"The calculation with contact does not converge ({e}). Contact: {pairs}. Check that the parts are held, "
                "try friction=, a coarser mesh (Study(mesh=...)), or leave the parts bonded.")
    return f"CalculiX failed with contact ({pairs}): {e}"


def _face_integrals(nodes, tri6, vals):
    """Je Dreieck mit 6 Knoten die Flaeche und das Integral eines Knotenwerts (vals: (n, 6)), mit den Formfunktionen."""
    x = nodes[tri6]
    area = np.zeros(len(tri6))
    integral = np.zeros(len(tri6))
    for (r, s), w in TRI_GAUSS:
        n, d = _tri_shape(r, s)
        tr = np.einsum("eni,nj->eji", x, d)
        ja = np.linalg.norm(np.cross(tr[:, 0], tr[:, 1]), axis=1)
        area += w * ja
        integral += w * ja * (vals @ n)
    return area, integral


def _contact_results(nodes, u, contacts, cvals, f, r, tets, D):
    """Je Kontaktpaar Kennzahlen, dazu die Pressung je Knoten auf beiden Seiten (fuer das Bild).

    Pressung und Schub kommen von CalculiX (an der Slave-Seite). Spalt und Gleitweg rechnet soma selbst aus den
    Verschiebungen: Gegenueberliegende Knoten liegen am Anfang an derselben Stelle (das Netz ist dort deckungsgleich).
    CalculiX gibt die Oeffnung nur nahe der Flaeche aus, bei 16 mm Spalt stand dort 0.

    Getragene Kraft: an den Knoten der Slave-Seite das Gleichgewicht, innere Kraefte der anliegenden Elemente minus Lasten
    und Lagerkraefte dort. Das ist genau die Kraft des Kontakts. Das Integral der Pressungen lag an Kanten weit daneben (1058
    statt 1000 N, an einer klaffenden Fuge 13858 statt 8000 N), das Gleichgewicht des ganzen Teils gilt nur, wenn es sonst
    nirgends haengt (nicht an einer Schraube)."""
    from scipy.spatial import cKDTree
    press = np.zeros(len(nodes))
    p_all, tau_all = np.maximum(cvals[:, 3], 0.0), np.hypot(cvals[:, 4], cvals[:, 5])
    out = []
    for c in contacts:
        s6, m6 = c["s6"], c["m6"]
        nd = np.unique(s6.reshape(-1))
        mn = np.unique(m6.reshape(-1))
        _d, near = cKDTree(nodes[mn]).query(nodes[nd])
        partner = mn[near]
        # Normale je Knoten der Slave-Seite (zur Gegenseite hin), gemittelt ueber die anliegenden Flaechen
        pts = nodes[s6[:, :3]]
        fn = np.cross(pts[:, 1] - pts[:, 0], pts[:, 2] - pts[:, 0])
        acc = np.zeros((len(nodes), 3))
        np.add.at(acc, s6.reshape(-1), np.repeat(fn, 6, axis=0))
        nrm = acc[nd] / np.maximum(np.linalg.norm(acc[nd], axis=1, keepdims=True), 1e-30)
        rel = u[partner] - u[nd]
        gap_n = np.einsum("ij,ij->i", rel, nrm)  # positiv: die Gegenseite entfernt sich
        slip_n = np.linalg.norm(rel - gap_n[:, None] * nrm, axis=1)
        gap = np.zeros(len(nodes))
        gap[nd] = gap_n
        p = np.zeros(len(nodes))
        p[nd] = p_all[nd]
        press[nd] = p[nd]
        _d, back = cKDTree(nodes[nd]).query(nodes[mn])
        press[mn] = np.maximum(press[mn], p[nd][back])
        area, total = _face_integrals(nodes, s6, p[s6])
        a_all = float(area.sum())
        force, shear = float(total.sum()), None
        # Kraft des Kontakts auf die Slave-Seite: K u - Lasten - Lagerkraefte an ihren Knoten (dort haengen nur Elemente
        # dieser Seite, die Gegenseite hat eigene Knoten)
        at = np.zeros(len(nodes), bool)
        at[nd] = True
        sel = np.nonzero(at[tets].any(axis=1))[0]
        F = (_internal(nodes, tets, D, u.reshape(-1), sel) - f - r).reshape(-1, 3)[nd].sum(axis=0)
        n_avg = (fn / 2).sum(axis=0)
        n_avg /= max(np.linalg.norm(n_avg), 1e-30)
        fn_n = float(-F @ n_avg)  # n_avg zeigt aus der Slave-Seite zur Gegenseite, Druck schiebt zurueck
        # Nur fuer ebene Beruehrflaechen ist die Richtung eindeutig: sonst (Welle in Bohrung) bleibt das Integral
        if np.linalg.norm(fn / 2, axis=1).sum() * 0.98 <= np.linalg.norm((fn / 2).sum(axis=0)):
            force, shear = fn_n, float(np.linalg.norm(F + fn_n * n_avg))
        # Offen: deutlich getrennt (mehr als die Weichheit des Kontaktgesetzes) an allen Ecken der Flaeche
        open_f = (gap[s6[:, :3]] > 2 * c["c0"]).all(axis=1)
        w = nd[int(np.argmax(p[nd]))]
        mu = c["spec"]["friction"]
        entry = dict(a=c["spec"]["a"], b=c["spec"]["b"], friction=mu, area=round(a_all, 3), force=round(force, 3),
                     maxPressure=dict(value=round(float(p[w]), 4), at=[round(float(x), 3) for x in nodes[w]]),
                     openArea=round(float(area[open_f].sum()), 3), maxGap=round(float(max(gap_n.max(initial=0.0), 0.0)), 5),
                     maxSlip=round(float(slip_n.max(initial=0.0)), 5))
        if mu > 0:
            # Gleiten, wo die Schubspannung die Haftgrenze erreicht (die Haftsteigung laesst auch beim Haften kleine Wege zu)
            tau = np.zeros(len(nodes))
            tau[nd] = tau_all[nd]
            pc = p[s6]
            sl = (pc > 1e-3) & (tau[s6] >= 0.95 * mu * pc)
            entry["slideArea"] = round(float(area[sl.mean(axis=1) >= 0.5].sum()), 3)
        if shear is not None:
            entry["shear"] = round(shear, 3)
        out.append(entry)
    return press, out


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
        raise FemError(f"The model does not build: {e.message}" + (f" ({e.file}:{e.line})" if e.file and e.line else "")) from None
    rel = Path(study_rel).as_posix()
    study = load_study(root, rel)
    safety = float(threshold) if threshold is not None else study.safety
    if not safety > 0:
        raise FemError("The safety factor must be greater than 0")
    by_name = {}
    for p in all_parts:
        by_name.setdefault(p["name"], p)
    wanted = list(dict.fromkeys([b["part"] for b in study.bcs] + [c[x] for c in study.contacts for x in ("a", "b")]
                                + [str(x) for x in study.extra_parts] + list(study.materials) + [b["part"] for b in study.bolts]))
    missing = [w for w in wanted if w not in by_name]
    if missing:
        names = ", ".join(repr(p["name"]) for p in all_parts[:30])
        raise FemError(f"There is no part {missing[0]!r}. Parts: {names}")
    # Schrauben: was sie beruehren (Mutter, Scheibe, verschraubte Teile), rechnet mit
    groups = _bolt_groups(study, all_parts, by_name)
    for grp in groups.values():
        wanted += [n for n in grp if n not in wanted]
    # Kopien: Fuer die Rechnung aendert sich die Form (Schraube aus dem Gewindeteil geschnitten, Schaft geteilt)
    parts = [dict(by_name[w], orig=by_name[w]) for w in wanted]
    index = {p["name"]: i for i, p in enumerate(parts)}
    bolt_grade = {n: b["grade"] for b in study.bolts for n in groups[b["part"]] if by_name[n].get("fastener") is not None}
    mats = []
    for p in parts:
        spec = study.materials.get(p["name"])
        if spec is None and p["name"] in bolt_grade:  # Schraube, Mutter, Scheibe einer Verschraubung: Stahl der Klasse
            rp, e = GRADES[bolt_grade[p["name"]]]
            spec = dict(name=f"steel {bolt_grade[p['name']]}", E=e, nu=0.3, strength=rp, density=7.85)
        mats.append(material(spec if spec is not None else study.material_spec, study.across_layers))
    for bc in study.bcs:
        bc["part_index"] = index[bc["part"]]
        bc["cq_faces"] = _select(by_name[bc["part"]]["shape"], bc)
    lo = np.min([[p["shape"].BoundingBox().xmin, p["shape"].BoundingBox().ymin, p["shape"].BoundingBox().zmin] for p in parts], axis=0)
    hi = np.max([[p["shape"].BoundingBox().xmax, p["shape"].BoundingBox().ymax, p["shape"].BoundingBox().zmax] for p in parts], axis=0)
    diag = float(np.linalg.norm(hi - lo))
    h = study.mesh or round(max(diag / 30, 0.3), 3)
    t_start = time.perf_counter()
    bolts = _prepare_bolts(study, parts, mats, groups)
    progress = Progress("soma analyze fem", 1, "elements")
    fine = _analyse(parts, study, mats, h, progress, bolts)
    coarse = None
    if study.check_mesh:
        # Die Gegenprobe darf das fertige Ergebnis nicht verhindern: scheitert nur das grobe Netz, fehlt die Pruefung (mit Hinweis)
        try:
            coarse = _analyse(parts, study, mats, h * 1.6, None, bolts)
        except FemError as e:
            fine["notes"] = list(fine.get("notes") or []) + [f"The check with a coarser mesh ({h * 1.6:g} mm) failed, so it is "
                                                            f"not known whether the peak stress depends on the mesh: {e}"]
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
    notes, part_fem = list(fine.get("notes") or []), []
    press = fine.get("press")
    for pi, p in enumerate(parts):
        t6 = fine["tri6"][epart_b == pi]
        if not len(t6):
            continue
        strength = mats[pi]["strength"]
        node_vm = vm[pi]
        sf = np.minimum(strength / np.maximum(node_vm, 1e-12), VALUE_CAP)
        sub = t6[:, SUB].reshape(-1, 3)  # Knoten je ebenem Dreieck
        tri = nodes[sub]
        area = np.linalg.norm(np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]), axis=1) / 2
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
                  material=dict(name=mats[pi]["name"], E=mats[pi]["E"], nu=mats[pi]["nu"], density=mats[pi]["density"],
                                strength=strength, note=mats[pi]["note"]))
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
            flags.append("at the edge of a fixed support")
        if len(load_nodes) and np.min(np.linalg.norm(nodes[load_nodes] - nodes[w_s], axis=1)) < 1.5 * h:
            flags.append("at a loaded face")
        st["peakAt"] = flags
        stats.append(st)
        # Netz fuers Bild: die geschlossene Huelle des Teils. Wo es ein anderes Teil beruehrt, liegt die Flaeche im Ganzen innen und
        # fehlt in t6. Ohne sie waere das Netz dort offen, und der Schnitt der App (Deckel ueber den Schablonenpuffer) schraffierte
        # alles, was hinter der Beruehrflaeche liegt. Kennzahlen oben bleiben bei der Aussenflaeche
        own = np.nonzero(fine["epart"] == pi)[0]
        oel, ok = _boundary(fine["tets"][own])
        img = _tri6(nodes, fine["tets"], own[oel], ok)[:, SUB].reshape(-1, 3)
        ip = nodes[img]
        inrm = np.cross(ip[:, 1] - ip[:, 0], ip[:, 2] - ip[:, 0])
        inrm = inrm / np.maximum(np.linalg.norm(inrm, axis=1, keepdims=True), 1e-12)
        # jede Ecke eigen, Werte an den Ecken (die Farben verlaufen)
        flat = img.reshape(-1)
        prims = [dict(mode=4, material=face_mat, attributes=dict(
            POSITION=g.accessor(nodes[flat], "VEC3", gltf.ARRAY_BUFFER, True), NORMAL=g.accessor(np.repeat(inrm, 3, axis=0), "VEC3", gltf.ARRAY_BUFFER),
            _VALUE=g.accessor(sf[flat], "SCALAR", gltf.ARRAY_BUFFER), _STRESS=g.accessor(node_vm[flat], "SCALAR", gltf.ARRAY_BUFFER),
            _DISP=g.accessor(u[flat], "VEC3", gltf.ARRAY_BUFFER)))]
        if press is not None:
            prims[0]["attributes"]["_PRESS"] = g.accessor(press[flat], "SCALAR", gltf.ARRAY_BUFFER)
        m = mesher.mesh_shape(p["shape"], tol, 0.3)
        if m["lines"].size:
            lines = np.asarray(m["lines"], dtype=float).reshape(-1, 3)
            _d, near = cKDTree(nodes[on]).query(lines)
            prims.append(dict(mode=1, material=edge_mat, attributes=dict(
                POSITION=g.accessor(lines, "VEC3", gltf.ARRAY_BUFFER, True), _DISP=g.accessor(u[on][near], "VEC3", gltf.ARRAY_BUFFER))))
        i = next(k for k, q in enumerate(all_parts) if q is p.get("orig", p))  # partId wie im Modell, damit Ausblenden und Auswahl passen
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
            notes.append(f"{b['label']}: found {hit:.1f} of {sel:.1f} mm² in the mesh. Check the marking in the picture.")
        if b["kind"] == "fix":
            entry["axes"] = b["axes"]
            entry["reaction"] = [round(float(x), 3) + 0.0 for x in b["reaction"]]
        else:
            entry["total"] = [round(float(x), 3) + 0.0 for x in b["total"]]
            if b["kind"] == "pressure":
                entry["value"] = b["value"]
        bcs_meta.append(entry)
    # Beruehrende Teile: verklebt, sofern die Studie keinen Kontakt nennt
    joined = {frozenset((c["a"], c["b"])): c for c in study.contacts}
    # Teile einer Verschraubung (Schraube, Mutter, Scheibe): verklebt gehoert dort zum Modell (Kopf und Gewinde)
    hardware = {n for b in fine["bolts"] for n in b["hardware"]}
    touching = []
    for (a, b), area in sorted(fine["touching"].items()):
        c = joined.get(frozenset((parts[a]["name"], parts[b]["name"])))
        joint = "contact" if c else ("bolt" if {parts[a]["name"], parts[b]["name"]} & hardware else "bonded")
        touching.append(dict(a=parts[a]["name"], b=parts[b]["name"], area=round(float(area), 2),
                             joint=joint, friction=c["friction"] if c else None))
    if any(t["joint"] == "bonded" for t in touching):
        notes.append("Touching parts are bonded (glued) where they touch. If a part only rests on another or can slide, "
                     "add study.contact(\"A\", \"B\") (with friction=0.2 or so when clamped or screwed together).")
    for c in fine["contacts"]:
        if c["openArea"] > 0.5 * c["area"]:
            notes.append(f"Contact {c['a']} – {c['b']}: open on {100 * c['openArea'] / c['area']:.0f} % of the touching faces "
                         "(lifts off there). Check that the load really presses the parts together.")
        if c.get("slideArea", 0) > 0.5 * c["area"]:
            notes.append(f"Contact {c['a']} – {c['b']}: slides on {100 * c['slideArea'] / c['area']:.0f} % of the touching "
                         f"faces (friction {c['friction']:g} at its limit). It may start to slip in reality.")
    for b in fine["bolts"]:
        if b["utilization"] > BOLT_LIMIT:
            notes.append(f"Bolt {b['part']} ({b['designation']}, {b['grade']}): {100 * b['utilization']:.0f} % of its yield "
                         "strength from pull and shear. Use a larger screw, a higher property class or less preload.")
        if b["auto"] and b["limit"] not in (None, "screw"):
            notes.append(f"Bolt {b['part']}: preload {b['preload']:.0f} N, limited to what {b['limit']} bears under the head "
                         "(its strength times the bearing area). Give preload= if you know how tight it is.")
    max_disp = float(disp.max())
    if max_disp > 0.05 * diag:  # ab etwa 5 % der Modellgröße aendert die Verformung die Lastwege merklich
        notes.append(f"The deformation is large ({max_disp:.2f} mm, {100 * max_disp / diag:.1f} % of the model size). The linear "
                     "calculation is then only a rough guide, real stresses and displacements differ.")
    for st in stats:
        ch = st.get("coarse", {}).get("change")
        where = " and ".join(st["peakAt"])
        # Kaum belastete Teile (etwa die Gegenseite eines Kontakts, der abhebt) nicht melden: Dort ist jede Spitze klein
        loaded = st["stress"]["value"] > 0.02 * st["material"]["strength"]
        if ch is not None and abs(ch) > 0.15 and loaded:
            notes.append(f"{st['name']}: The peak stress depends on the mesh ({st['coarse']['stress']:.1f} MPa coarse, {st['stress']['value']:.1f} MPa fine)"
                         + (f", it is {where}" if where else ", probably at a sharp inner edge")
                         + ". The value is not reliable there: add a radius or judge the spot from a little distance.")
        elif where and loaded:
            notes.append(f"{st['name']}: The peak stress is {where}. A rigid fixed support or a load on a small face "
                         "often gives too high a peak there: judge values a little away from it.")
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
    meta = dict(version=1, id=rid, kind="fem", title=study.title, quantity="Safety factor", unit="", bad="low", threshold=safety,
                tolerance=None, range=rng, up=None, parts=stats, notes=list(dict.fromkeys(notes)), created=time.time(), neutral=None,
                seconds=round(seconds, 2),
                command=["analyze", "fem", rel] + ([f"--threshold={safety:g}"] if safety != study.safety else []) + ([f"--name={name}"] if name else []),
                fem=dict(study=rel, bcs=bcs_meta, applied=[round(float(x), 3) + 0.0 for x in applied],
                         reaction=[round(float(x), 3) + 0.0 for x in reaction], balance=round(balance, 6),
                         gravity=study.gravity_vec, maxDisp=round(max_disp, 4), diag=round(diag, 3),
                         touching=touching, contacts=fine["contacts"], bolts=fine["bolts"],
                         # auto: Die Studie gibt keine Netzgroesse vor, sie folgt der Modellgroesse (der Bericht sagt das dazu)
                         mesh=dict(size=h, auto=not study.mesh, nodes=int(len(nodes)), elements=int(len(fine["tets"])), dofs=fine["dofs"],
                                   solver=fine["method"]),
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
    # + 0.0 nach dem Runden: kein "-0.0" fuer winzige negative Werte
    return "({}) {}".format(", ".join(f"{round(x, 1) + 0.0:.1f}" for x in v), unit)


def summary_text(meta):
    fe = meta["fem"]
    safety = meta["threshold"]
    extra = [w for w, on in (("contact", fe.get("contacts")), ("bolts", fe.get("bolts"))) if on]
    kind = "linear elastic" + (f", with {' and '.join(extra)}" if extra else "")
    lines = [f"FEM \"{meta['title']}\" ({fe['study']}, {kind}, safety factor {safety:g} required, critical below):"]
    for b in fe["bcs"]:
        if b["kind"] == "fix":
            ax = "" if b["axes"] == "xyz" else f" only in {', '.join(b['axes'].upper())}"
            lines.append(f"  fixed{ax}: {b['label']} ({b['area']:.1f} mm²), reaction force {_v(b['reaction'])}")
        elif b["kind"] == "force":
            lines.append(f"  force: {b['label']} ({b['area']:.1f} mm²), {_v(b['total'])}")
        else:
            lines.append(f"  pressure: {b['label']} ({b['area']:.1f} mm²), {b['value']:g} MPa, in total {_v(b['total'])}")
    if fe.get("gravity"):
        lines.append(f"  self-weight: {_v(fe['gravity'], 'm/s²')}")
    contacts = {frozenset((c["a"], c["b"])): c for c in fe.get("contacts") or []}
    for t in fe.get("touching") or []:
        c = contacts.get(frozenset((t["a"], t["b"])))
        if c is None:
            how = "bonded (bolt: head and thread)" if t.get("joint") == "bolt" else "bonded"
            lines.append(f"  touching: {t['a']} – {t['b']} ({t['area']:.1f} mm²), {how}")
            continue
        fr = f"friction {c['friction']:g}" if c["friction"] else "no friction"
        mp = c["maxPressure"]
        state = [f"open on {100 * c['openArea'] / max(c['area'], 1e-12):.0f} % (gap up to {c['maxGap']:.3f} mm)" if c["openArea"] > 0 else "closed everywhere"]
        if c.get("slideArea"):
            state.append(f"slides on {100 * c['slideArea'] / max(c['area'], 1e-12):.0f} %")
        state.append(f"slip up to {c['maxSlip']:.3f} mm")
        side = f" and {c['shear']:.1f} N sideways" if c.get("shear") is not None and c["friction"] else ""
        lines.append(f"  contact: {c['a']} – {c['b']} ({c['area']:.1f} mm², {fr}), carries {c['force']:.1f} N{side}, highest pressure "
                     f"{mp['value']:.2f} MPa at {analysis._where(mp['at'])}, {', '.join(state)}")
    for b in fe.get("bolts") or []:
        how = "automatic" if b["auto"] else "given"
        lines.append(f"  bolt: {b['part']} ({b['designation']}, {b['grade']}, thread in {b['engaged']}), preload {b['preload']:.0f} N "
                     f"({how}), in the end {b['force']:.0f} N pull and {b['shear']:.0f} N across, "
                     f"{100 * b['utilization']:.0f} % of its yield strength")
    for st in meta["parts"]:
        mat = st["material"]
        s, d, w = st["stress"], st["displacement"], st["worst"]
        crit = f"{st['critical'] / 100:.2f} cm² below {safety:g}" if st["critical"] > 0 else f"nothing below {safety:g}"
        lines.append(f"  {st['name']} ({mat['name']}, E {mat['E']:g} MPa, strength {mat['strength']:g} MPa): highest von Mises stress "
                     f"{s['value']:.1f} MPa at {analysis._where(s['at'])}, lowest safety factor {w['value']:.2f}, {crit}, "
                     f"largest displacement {d['value']:.3f} mm at {analysis._where(d['at'])}")
        for r in st.get("regions", []):
            lines.append(f"    {analysis._region_line(r, '')}")
        if st.get("regionsMore"):
            mo = st["regionsMore"]
            lines.append(f"    and {mo['count']} more spot{'s' if mo['count'] > 1 else ''}, {analysis._mm2(mo['area'])} in total")
    m = fe["mesh"]
    check = f"Mesh {m['elements']} tetrahedra (10 nodes, edge length up to {m['size']:g} mm), {m['dofs']} unknowns, {m['solver']}"
    for st in meta["parts"]:
        if st.get("coarse"):
            check += f"; {st['name']} with a coarser mesh {st['coarse']['stress']:.1f} MPa (fine mesh {round(100 * st['coarse']['change']) + 0:+d} %)"
    lines.append(f"Check: reaction forces in total {_v(fe['reaction'])}, loads {_v(fe['applied'])}"
                 f"{' (in equilibrium)' if fe['balance'] < 1e-3 else f' (deviation {100 * fe['balance']:.2f} %)'}. {check}.")
    for n in meta.get("notes") or []:
        lines.append(f"Note: {n}")
    return "\n".join(lines)
