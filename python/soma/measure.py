"""Exaktes Messen fuer den Viewer (E9): Flaechen, Kanten und Eckpunkte ueber die IDs des Meshers, Abstaende und Winkel mit OCC.

Grundlage ist `geometry/<build>.brep` neben model.map.json, aus demselben Build wie model.glb. BREP erhaelt die
Topologie exakt, daher stimmt die Reihenfolge von Faces()/Edges() mit den IDs des Meshers ueberein. Die Kennung im
Dateinamen und in model.map.json verbindet beides, zusaetzlich prueft jede Anfrage Flaecheninhalt bzw. Kantenlaenge.

`soma serve` beantwortet Anfragen als JSON-Zeilen auf stdin/stdout (langlebiger Dienst der App, E24).
"""
import json
import math
import sys
from pathlib import Path

import cadquery as cq
from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeVertex
from OCP.BRepExtrema import BRepExtrema_DistShapeShape
from OCP.GeomAbs import GeomAbs_Circle, GeomAbs_Cone, GeomAbs_Cylinder, GeomAbs_Line, GeomAbs_Plane, GeomAbs_Sphere, GeomAbs_Torus
from OCP.gp import gp_Pnt
from OCP.TopAbs import TopAbs_REVERSED
from OCP.TopoDS import TopoDS_Iterator

PARALLEL = 1e-6  # Winkeltoleranz (rad) fuer "parallel"


class MeasureError(Exception):
    """Fehler mit verstaendlicher Meldung. `stale`: die Anfrage gehoert zu einem aelteren Build."""

    def __init__(self, message, stale=False):
        super().__init__(message)
        self.stale = stale


def write_geometry(folder, shapes, build_id):
    """Legt die Bauteile als ein BREP ab (Reihenfolge = Reihenfolge in model.map.json) und raeumt alte Staende weg."""
    geo = Path(folder) / "geometry"
    geo.mkdir(parents=True, exist_ok=True)
    cq.Compound.makeCompound(list(shapes)).exportBrep(str(geo / f"{build_id}.brep"))
    for old in geo.glob("*.brep"):
        if old.stem != build_id:
            try:
                old.unlink()
            except OSError:
                pass  # gerade in Benutzung (Messdienst): beim naechsten Build


class Model:
    """Ein gebauter Stand: Bauteile aus dem BREP, Zuordnung ueber model.map.json."""

    def __init__(self, folder):
        folder = Path(folder)
        try:
            self.map = json.loads((folder / "model.map.json").read_text(encoding="utf-8"))
        except (OSError, ValueError) as e:
            raise MeasureError(f"model.map.json is missing or unreadable: {e}")
        self.build = self.map.get("build")
        brep = folder / "geometry" / f"{self.build}.brep"
        if not self.build or not brep.is_file():
            raise MeasureError("There is no geometry to measure for this version. Building it once more helps.")
        comp = cq.Shape.importBrep(str(brep))
        it = TopoDS_Iterator(comp.wrapped)
        self.shapes = []
        while it.More():
            self.shapes.append(cq.Shape.cast(it.Value()))
            it.Next()
        self.parts = {p["id"]: i for i, p in enumerate(self.map.get("parts", []))}
        self.names = {p["id"]: p.get("name", p["id"]) for p in self.map.get("parts", [])}
        if len(self.shapes) != len(self.parts):
            raise MeasureError("Geometry and part list do not match. Building it once more helps.")
        self._cache = {"face": {}, "edge": {}, "vertex": {}}

    def shape(self, part):
        if part not in self.parts:
            raise MeasureError(f"Unknown part {part!r}.", stale=True)
        return self.shapes[self.parts[part]]

    def sub(self, ent):
        """Flaeche, Kante oder Eckpunkt eines Bauteils. Prueft Flaecheninhalt, Laenge bzw. Lage gegen den Viewer."""
        part, kind, i = ent["part"], ent["kind"], int(ent["id"])
        if kind not in self._cache:
            raise MeasureError(f"Unknown kind {kind!r}.")
        cache = self._cache[kind]
        if part not in cache:
            s = self.shape(part)
            cache[part] = s.Faces() if kind == "face" else s.Edges() if kind == "edge" else s.Vertices()
        items = cache[part]
        if not 0 <= i < len(items):
            raise MeasureError("This spot no longer exists in the current version.", stale=True)
        sub = items[i]
        stale = MeasureError("The geometry does not match the version shown. Please click again.", stale=True)
        if kind == "vertex":
            pt = ent.get("point")
            if pt is not None and math.dist(sub.toTuple(), [float(x) for x in pt]) > 1e-3:
                raise stale
            return sub
        check = ent.get("check")
        if check is not None:
            actual = sub.Area() if kind == "face" else sub.Length()
            if abs(actual - float(check)) > max(1e-3, 1e-3 * abs(actual)):
                raise stale
        return sub


def _xyz(p):
    return [round(p.X(), 6), round(p.Y(), 6), round(p.Z(), 6)]


def _vec(d):
    return [round(d.X(), 9), round(d.Y(), 9), round(d.Z(), 9)]


def _dot(a, b):
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def _sub(a, b):
    return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]


def _norm(a):
    return math.sqrt(_dot(a, a))


def _cross(a, b):
    return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]


def _angle(u, v):
    """Winkel zwischen zwei Richtungen in rad (0..pi)."""
    c = _dot(u, v) / max(_norm(u) * _norm(v), 1e-300)
    return math.acos(max(-1.0, min(1.0, c)))


def _dist(a, b):
    """Kuerzester Abstand zweier Formen mit den beiden naechsten Punkten."""
    d = BRepExtrema_DistShapeShape(a, b)
    if not d.IsDone() or d.NbSolution() < 1:
        raise MeasureError("The distance could not be determined.")
    return d.Value(), _xyz(d.PointOnShape1(1)), _xyz(d.PointOnShape2(1))


def _project(sub, point):
    """Naechster Punkt auf der Flaeche/Kante zum angeklickten Punkt (der Klick liegt auf dem Netz, nicht exakt darauf)."""
    if point is None:
        return None
    v = BRepBuilderAPI_MakeVertex(gp_Pnt(*[float(x) for x in point])).Vertex()
    return _dist(v, sub.wrapped)[2]


def describe(model, ent):
    """Exakte Angaben zu einer Flaeche, Kante oder einem Eckpunkt."""
    sub = model.sub(ent)
    info = dict(kind=ent["kind"], part=ent["part"], name=model.names.get(ent["part"]), point=_project(sub, ent.get("point")))
    if ent["kind"] == "vertex":
        info.update(type="VERTEX", point=[round(c, 6) for c in sub.toTuple()])
    elif ent["kind"] == "face":
        info.update(type=sub.geomType(), area=sub.Area())
        ad = BRepAdaptor_Surface(sub.wrapped)
        t = ad.GetType()
        rev = sub.wrapped.Orientation() == TopAbs_REVERSED
        if t == GeomAbs_Plane:
            pln = ad.Plane()
            n = _vec(pln.Axis().Direction())
            info.update(normal=[-x for x in n] if rev else n, origin=_xyz(pln.Location()))
        elif t == GeomAbs_Cylinder:
            c = ad.Cylinder()
            info.update(radius=c.Radius(), axis=dict(point=_xyz(c.Location()), dir=_vec(c.Axis().Direction())))
        elif t == GeomAbs_Cone:
            c = ad.Cone()
            info.update(semiAngle=math.degrees(c.SemiAngle()), refRadius=c.RefRadius(),
                        axis=dict(point=_xyz(c.Location()), dir=_vec(c.Axis().Direction())))
        elif t == GeomAbs_Sphere:
            s = ad.Sphere()
            info.update(radius=s.Radius(), center=_xyz(s.Location()))
        elif t == GeomAbs_Torus:
            s = ad.Torus()
            info.update(majorRadius=s.MajorRadius(), minorRadius=s.MinorRadius(),
                        axis=dict(point=_xyz(s.Location()), dir=_vec(s.Axis().Direction())))
    else:
        info.update(type=sub.geomType(), length=sub.Length(), start=_xyz(sub.startPoint().toPnt()), end=_xyz(sub.endPoint().toPnt()))
        ad = BRepAdaptor_Curve(sub.wrapped)
        t = ad.GetType()
        if t == GeomAbs_Line:
            info.update(dir=_vec(ad.Line().Direction()))
        elif t == GeomAbs_Circle:
            c = ad.Circle()
            info.update(radius=c.Radius(), center=_xyz(c.Location()), axis=dict(point=_xyz(c.Location()), dir=_vec(c.Axis().Direction())),
                        closed=sub.IsClosed())
    return info, sub


def _foot_on_line(p, q, d):
    """Lotfusspunkt von p auf die Gerade durch q mit Richtung d."""
    along = _dot(_sub(p, q), d) / _dot(d, d)
    return [round(q[k] + along * d[k], 6) for k in range(3)]


def _point_to(v, o):
    """Ein Punkt und ein anderes Element: Abstand zur Ebene, zur Achse oder zur Geraden (jeweils unbegrenzt gedacht)."""
    p = v["point"]
    if o.get("normal") and o.get("origin"):
        n = o["normal"]
        s = _dot(_sub(p, o["origin"]), n) / _norm(n)
        foot = [round(p[k] - s * n[k] / _norm(n), 6) for k in range(3)]
        return "toPlane", dict(value=abs(s), p1=p, p2=foot)
    if o.get("axis"):
        foot = _foot_on_line(p, o["axis"]["point"], o["axis"]["dir"])
        return "toAxis", dict(value=_norm(_sub(p, foot)), p1=p, p2=foot)
    if o.get("dir") and o.get("start"):
        foot = _foot_on_line(p, o["start"], o["dir"])
        return "toLine", dict(value=_norm(_sub(p, foot)), p1=p, p2=foot)
    return None, None


def _axis_distance(a, b):
    """Abstand zweier paralleler Achsen und die Verbindung zwischen ihnen (in Hoehe des ersten Achspunkts)."""
    pa, d = a["point"], a["dir"]
    w = _sub(b["point"], pa)
    along = _dot(w, d) / _dot(d, d)
    foot = [b["point"][k] - along * d[k] for k in range(3)]  # Punkt auf Achse B auf Hoehe von pa
    return _norm(_sub(foot, pa)), pa, [round(x, 6) for x in foot]


def pair(ia, sa, ib, sb):
    """Abstaende und Winkel zwischen zwei Elementen. Welche Angabe die wichtigste ist, entscheidet die Oberflaeche."""
    out = {}
    value, p1, p2 = _dist(sa.wrapped, sb.wrapped)
    out["min"] = dict(value=value, p1=p1, p2=p2)
    if ia.get("point") and ib.get("point"):
        out["points"] = dict(value=_norm(_sub(ib["point"], ia["point"])), p1=ia["point"], p2=ib["point"],
                             delta=[round(ib["point"][k] - ia["point"][k], 6) for k in range(3)])
    va, vb = ia["kind"] == "vertex", ib["kind"] == "vertex"
    if va != vb:
        key, span = _point_to(ia, ib) if va else _point_to(ib, ia)
        if key:
            out[key] = span
        return out
    if va and vb:
        return out  # zwei Punkte: der Abstand steht schon in "points"
    na, nb = ia.get("normal"), ib.get("normal")
    da = ia.get("dir") or (ia.get("axis") or {}).get("dir")
    db = ib.get("dir") or (ib.get("axis") or {}).get("dir")
    if na and nb:
        ang = _angle(na, nb)
        par = ang < PARALLEL or abs(ang - math.pi) < PARALLEL
        out["angle"] = 0.0 if par else math.degrees(min(ang, math.pi - ang))
        if par:
            # Wandstaerke, Spaltmass: Abstand der Ebenen, gezeichnet als Lot vom angeklickten Punkt auf Ebene B
            start = ia.get("point") or ia["origin"]
            s = _dot(_sub(start, ib["origin"]), nb)
            foot = [round(start[k] - s * nb[k] / _dot(nb, nb), 6) for k in range(3)]
            out["planes"] = dict(value=abs(s) / _norm(nb), p1=start, p2=foot)
    elif ia.get("axis") and ib.get("axis"):
        ang = _angle(da, db)
        if ang < PARALLEL or abs(ang - math.pi) < PARALLEL:
            # Bohrungen, Wellen: Abstand der Achsen (bei Kreisen der Mittelpunkte in derselben Ebene)
            v, p1, p2 = _axis_distance(ia["axis"], ib["axis"])
            out["axes"] = dict(value=v, p1=p1, p2=p2)
        else:
            out["angle"] = math.degrees(min(ang, math.pi - ang))
    elif da and db:
        ang = _angle(da, db)
        out["angle"] = math.degrees(min(ang, math.pi - ang))
    elif (na and db) or (nb and da):
        n, d = (na, db) if na else (nb, da)
        out["angle"] = abs(90.0 - math.degrees(_angle(n, d)))  # Winkel zwischen Gerade/Achse und Ebene
        out["angle"] = min(out["angle"], 90.0)
    return out


def measure(model, req):
    ia, sa = describe(model, req["a"])
    res = dict(build=model.build, a=ia)
    if req.get("b"):
        ib, sb = describe(model, req["b"])
        res["b"] = ib
        res["pair"] = pair(ia, sa, ib, sb)
    return res


def serve(stdin=sys.stdin, stdout=sys.stdout):
    """Anfragen als JSON-Zeilen: {"id", "folder", "build", "a", "b"?}. Antwort: {"id", "ok", "result"|"error", "stale"?}.
    Geladene Staende bleiben im Speicher, bis sich die Kennung in model.map.json aendert. {"prepare": true} statt "a" laedt
    nur den Stand (bei grossen Baugruppen dauert das), damit der erste Klick nicht darauf warten muss."""
    models = {}
    stdout.write(json.dumps(dict(ready=True)) + "\n")
    stdout.flush()
    for line in stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get("id")
            folder = str(req["folder"])
            current = json.loads((Path(folder) / "model.map.json").read_text(encoding="utf-8")).get("build")
            if req.get("build") and req["build"] != current:
                raise MeasureError("The model has been rebuilt in the meantime. Please click again.", stale=True)
            m = models.get(folder)
            if m is None or m.build != current:
                m = models[folder] = Model(folder)
            if req.get("prepare"):
                out = dict(id=rid, ok=True, result=dict(build=m.build, parts=len(m.shapes)))
            else:
                out = dict(id=rid, ok=True, result=measure(m, req))
        except MeasureError as e:
            out = dict(id=rid, ok=False, error=str(e), stale=e.stale)
        except Exception as e:  # nie abstuerzen: der Dienst bedient auch die naechste Anfrage
            out = dict(id=rid, ok=False, error=f"{type(e).__name__}: {e}")
        stdout.write(json.dumps(out) + "\n")
        stdout.flush()
