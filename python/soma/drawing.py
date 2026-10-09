"""Technical drawings (E76): sheets with views, sections, details, dimensions and free drawing, written as DXF, PDF and
PNG by `soma drawing build`. The agent decides what goes where; soma projects the geometry, measures the values and
reports problems.

    from soma.drawing import Sheet

    sh = Sheet("Bracket", size="A3", scale="1:2", material="AlMg3", tolerance="ISO 2768-m")
    front = sh.view("Bracket", "front", at=(150, 180))
    top = sh.view("Bracket", "top", at=(150, 90))
    front.dim((-60, 0, 0), (60, 0, 0), offset=-12)
    sh.msp.add_line((20, 20), (60, 20), dxfattribs={"layer": "THIN"})   # anything else directly with ezdxf

Coordinates on the sheet are millimetres from the lower left corner of the paper. Points of the model stay in model
millimetres, every view converts them with view.pt().
"""
import datetime
import inspect
import math
import re
from pathlib import Path

import cadquery as cq
import ezdxf
import numpy as np
from ezdxf.enums import TextEntityAlignment
from OCP.BRepAdaptor import BRepAdaptor_Curve, BRepAdaptor_Surface
from OCP.BRepAlgoAPI import BRepAlgoAPI_Common
from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
from OCP.BRepLib import BRepLib
from OCP.BRepTools import BRepTools_WireExplorer
from OCP.GCPnts import GCPnts_QuasiUniformDeflection
from OCP.GeomAbs import GeomAbs_Circle, GeomAbs_Ellipse, GeomAbs_Line
from OCP.gp import gp_Ax2, gp_Ax3, gp_Dir, gp_Pnt, gp_Trsf, gp_Vec
from OCP.HLRAlgo import HLRAlgo_Projector
from OCP.HLRBRep import HLRBRep_Algo, HLRBRep_HLRToShape
from OCP.TopAbs import TopAbs_REVERSED

from . import registry

__all__ = ["Sheet", "View"]

SHEETS = []    # Blaetter des laufenden Zeichnungsskripts, drawrun.py sammelt sie ein
_PARTS = None  # Bauteile aus dem Build (Liste wie registry.REGISTRY), gesetzt von drawrun.py

# Papierformate nach ISO 5457 als (kurze, lange) Seite
SIZES = {"A4": (210, 297), "A3": (297, 420), "A2": (420, 594), "A1": (594, 841), "A0": (841, 1189)}
# Bevorzugte Maßstäbe nach ISO 5455, andere meldet die Prüfung nur als Hinweis
ISO_SCALES = [50, 20, 10, 5, 2, 1, 1 / 2, 1 / 5, 1 / 10, 1 / 20, 1 / 50, 1 / 100, 1 / 200, 1 / 500, 1 / 1000]
# Blickrichtung (vom Teil zum Betrachter) und die Richtung im Modell, die auf dem Blatt nach oben zeigt. Wie in der App
# und in soma.anim: front schaut von -Y, left von -X. top hat +Y oben, bottom -Y (Projektionsmethode 1 und 3 gleich)
VIEWS = {
    "front": ((0, -1, 0), (0, 0, 1)), "back": ((0, 1, 0), (0, 0, 1)),
    "left": ((-1, 0, 0), (0, 0, 1)), "right": ((1, 0, 0), (0, 0, 1)),
    "top": ((0, 0, 1), (0, 1, 0)), "bottom": ((0, 0, -1), (0, -1, 0)),
    "iso": ((1, -1, 1), (0, 0, 1)),
}
STANDARD_VIEWS = ("front", "back", "left", "right", "top", "bottom")

# Linienbreiten in 1/100 mm nach ISO 128 (Liniengruppe 0.5)
THICK, MEDIUM, THIN = 50, 35, 25
LAYERS = {
    # Name: (Farbe, Breite, Linienart, Bedeutung)
    "VISIBLE": (7, THICK, "Continuous", "visible edges"),
    "HIDDEN": (8, THIN, "SOMA_HIDDEN", "hidden edges"),
    "TANGENT": (8, THIN, "Continuous", "tangent edges (fillets)"),
    "CENTER": (3, THIN, "SOMA_CENTER", "center lines and axes"),
    "PHANTOM": (8, THIN, "SOMA_PHANTOM", "adjacent parts, extreme positions"),
    "THIN": (7, THIN, "Continuous", "thin continuous lines (detail circles, leaders, notes)"),
    "HATCH": (8, THIN, "Continuous", "hatching of cut faces"),
    "CUT": (3, THIN, "SOMA_CENTER", "cutting planes"),
    "DIM": (5, THIN, "Continuous", "dimensions"),
    "TEXT": (7, MEDIUM, "Continuous", "texts and labels"),
    "FRAME": (7, 70, "Continuous", "frame"),
    "TITLE": (7, MEDIUM, "Continuous", "title block"),
}
LINETYPES = {
    # Muster in Blatt-mm: Strich positiv, Luecke negativ, erste Zahl die Gesamtlaenge
    "SOMA_HIDDEN": ([4.0, 3.0, -1.0], "Hidden __ __ __"),
    "SOMA_CENTER": ([13.5, 10.0, -1.5, 0.5, -1.5], "Center ____ . ____"),
    "SOMA_PHANTOM": ([15.5, 10.0, -1.5, 0.5, -1.5, 0.5, -1.5], "Phantom ____ . . ____"),
}
TEXT_HEIGHT = 3.5     # Maßzahlen und Texte (ISO 3098, mindestens 2.5)
LABEL_HEIGHT = 5.0    # Bezeichnungen von Ansichten, Schnitten, Einzelheiten
LINE_SPACING = 1.6    # Abstand der Grundlinien mehrzeiliger Texte in Schrifthoehen
BREAK_GAP = 6.0       # Luecke einer unterbrochenen Ansicht auf dem Blatt (mm)
FONT = "DejaVuSans.ttf"  # liegt matplotlib bei, damit die PDF auf jedem Rechner gleich aussieht

TITLE_LABELS = {
    "en": dict(owner="Owner", title="Title", drawn="Drawn by", date="Date", number="Drawing number", revision="Rev.",
               material="Material", tolerance="General tolerances", scale="Scale", size="Size", projection="Projection",
               sheet="Sheet"),
    "de": dict(owner="Firma", title="Benennung", drawn="Gezeichnet", date="Datum", number="Zeichnungsnummer",
               revision="Index", material="Werkstoff", tolerance="Allgemeintoleranzen", scale="Maßstab", size="Format",
               projection="Projektion", sheet="Blatt"),
}


# ---- Hilfen ---------------------------------------------------------------------------------------------------------

def _where():
    """Datei und Zeile des Aufrufs im Zeichnungsskript: der erste Rahmen ausserhalb des soma-Pakets."""
    here = Path(__file__).resolve().parent
    f = inspect.currentframe()
    while f is not None:
        try:
            inside = Path(f.f_code.co_filename).resolve().parent == here
        except (OSError, ValueError):
            inside = False
        if not inside and not f.f_code.co_filename.startswith("<"):
            return f.f_code.co_filename, f.f_lineno
        f = f.f_back
    return None, None


def _vec(v, what):
    try:
        t = tuple(float(x) for x in v)
    except (TypeError, ValueError):
        t = ()
    if len(t) != 3 or not all(math.isfinite(x) for x in t):
        raise ValueError(f"{what} must be a point or direction (x, y, z), not {v!r}")
    return np.array(t)


def _pt2(v, what):
    try:
        t = tuple(float(x) for x in v)
    except (TypeError, ValueError):
        t = ()
    if len(t) != 2 or not all(math.isfinite(x) for x in t):
        raise ValueError(f"{what} must be a point on the sheet (x, y) in mm, not {v!r}")
    return np.array(t)


def _unit(v, what):
    v = _vec(v, what)
    n = float(np.linalg.norm(v))
    if n < 1e-12:
        raise ValueError(f"{what} must not be zero")
    return v / n


def parse_scale(s, what="scale"):
    """"1:2" -> 0.5, "5:1" -> 5, 0.5 -> 0.5."""
    if isinstance(s, str):
        m = re.fullmatch(r"\s*([0-9.]+)\s*:\s*([0-9.]+)\s*", s)
        if not m:
            raise ValueError(f"{what} must be like \"1:2\" or \"5:1\" or a number, not {s!r}")
        try:
            a, b = float(m.group(1)), float(m.group(2))
        except ValueError:
            raise ValueError(f"{what} must be like \"1:2\" or \"5:1\", not {s!r}") from None
        v = a / b if b else 0.0
    else:
        try:
            v = float(s)
        except (TypeError, ValueError):
            raise ValueError(f"{what} must be like \"1:2\" or a number, not {s!r}") from None
    if not (v > 0 and math.isfinite(v)):
        raise ValueError(f"{what} must be greater than 0, not {s!r}")
    return v


def fmt_scale(v):
    """0.5 -> "1:2", 5 -> "5:1", 0.4 -> "1:2.5"."""
    return f"{num(v)}:1" if v >= 1 else f"1:{num(1 / v)}"


def num(v, dec=2):
    """Zahl wie auf der Zeichnung: 120.00 -> "120", 12.50 -> "12.5", Punkt als Dezimalzeichen."""
    s = f"{float(v):.{max(0, int(dec))}f}"
    if "." in s:  # Nullen nur hinter dem Komma streichen, sonst wird aus 130 mit dec=0 "13"
        s = s.rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


_FONTS_READY = False


def setup_fonts():
    """Die Schrift der Zeichnungen liegt matplotlib bei, ezdxf kennt den Ordner aber nicht von sich aus. Muss vor dem
    ersten Messen eines Texts laufen: ezdxf behaelt die Ersatzschrift sonst fuer den ganzen Lauf, auch beim Zeichnen."""
    global _FONTS_READY
    if _FONTS_READY:
        return
    import matplotlib
    from ezdxf.fonts import fonts
    try:
        fonts.font_manager.scan_folder(Path(matplotlib.get_data_path(), "fonts", "ttf"))
    except Exception:  # ohne sie nimmt ezdxf eine Ersatzschrift
        pass
    _FONTS_READY = True


def _no_prefix(text, prefix):
    """Ø vor dem Durchmesser und R vor dem Radius setzt ezdxf selbst: "Ø<> H7" ergaebe sonst "ØØ8 H7"."""
    if not isinstance(text, str):
        return text
    return re.sub(rf"(?:{prefix})\s*<>", "<>", text)


def _layer(name):
    if name not in LAYERS:
        raise ValueError(f"Unknown layer {name!r}. Layers: {', '.join(LAYERS)}")
    return name


# ---- Bauteile -------------------------------------------------------------------------------------------------------

def _parts():
    if _PARTS is None:
        raise RuntimeError("Drawings run through `soma drawing build` (there soma knows the parts of the model), "
                           "not directly with python.")
    return _PARTS


def _resolve(spec):
    """Was eine Ansicht zeigt -> Liste (Name oder None, cq.Shape). Bauteilname, Gruppe ("Housing" oder
    "Housing/Screws"), "*" fuer alle Bauteile ohne Referenzen, eine Liste davon, oder eine eigene CadQuery-Form."""
    if isinstance(spec, (cq.Workplane, cq.Shape)) or hasattr(spec, "__soma_shape__"):
        return [(None, registry.to_shape(spec))]
    parts = _parts()
    if isinstance(spec, (list, tuple, set)):
        out = []
        for s in spec:
            for item in _resolve(s):
                if item[0] is None or all(item[0] != o[0] for o in out):
                    out.append(item)
        if not out:
            raise ValueError("The list of parts is empty")
        return out
    if spec is None or spec == "*":
        out = [(p["name"], p["shape"]) for p in parts if p["role"] != "reference"]
        if not out:
            raise ValueError("The model has no parts besides references")
        return out
    if not isinstance(spec, str) or not spec.strip():
        raise ValueError(f"Expected a part name, a group, \"*\", a list of them or a CadQuery shape, not {spec!r}")
    hit = [(p["name"], p["shape"]) for p in parts if p["name"] == spec]
    if hit:
        return hit
    path = spec.strip("/")
    hit = [(p["name"], p["shape"]) for p in parts
           if p["group"] and ("/".join(p["group"]) == path or "/".join(p["group"]).startswith(path + "/"))]
    if hit:
        return hit
    names = ", ".join(repr(p["name"]) for p in parts[:30]) + (" ..." if len(parts) > 30 else "")
    groups = sorted({"/".join(p["group"][:i + 1]) for p in parts for i in range(len(p["group"]))})
    extra = f" Groups: {', '.join(repr(g) for g in groups)}." if groups else ""
    raise ValueError(f"Part {spec!r} does not exist in the model. Parts: {names}.{extra}")


def _bbox(shapes):
    bb = None
    for s in shapes:
        b = s.BoundingBox()
        bb = b if bb is None else bb.add(b)
    return bb


# ---- Projektion -----------------------------------------------------------------------------------------------------

def _basis(direction, up):
    """Blickrichtung -> (N zum Betrachter, X nach rechts, Y nach oben auf dem Blatt)."""
    if isinstance(direction, str):
        if direction not in VIEWS:
            raise ValueError(f"direction must be one of {', '.join(VIEWS)} or a vector (x, y, z) from the part to the "
                             f"viewer, not {direction!r}")
        n, default_up = VIEWS[direction]
    else:
        n, default_up = direction, None
    n = _unit(n, "direction")
    if up is None:
        up = default_up if default_up is not None else ((0, 0, 1) if abs(n[2]) < 0.999 else (0, 1, 0))
    u = _unit(up, "up")
    x = np.cross(u, n)
    if np.linalg.norm(x) < 1e-9:
        raise ValueError("up must not be parallel to the viewing direction")
    x = x / np.linalg.norm(x)
    return n, x, np.cross(n, x)


def _hlr(shape, n, x, hidden, tangent):
    """Verdeckte Kanten mit HLR aus OCP. Liefert Kanten in Ansichtskoordinaten (u nach X, v nach Y, w = 0)."""
    algo = HLRBRep_Algo()
    algo.Add(shape.wrapped)
    algo.Projector(HLRAlgo_Projector(gp_Ax2(gp_Pnt(0, 0, 0), gp_Dir(*map(float, n)), gp_Dir(*map(float, x)))))
    algo.Update()
    algo.Hide()
    h = HLRBRep_HLRToShape(algo)

    def edges(*getters):
        out = []
        for g in getters:
            s = g()
            if not s.IsNull():
                # HLR liefert nur Kurven in der Ebene. Ohne 3D-Kurven stuerzen Boolesche Operationen (Einzelheiten) ab
                BRepLib.BuildCurves3d_s(s, 1e-6)
                out += [e.wrapped for e in cq.Shape.cast(s).Edges()]
        return out

    return dict(visible=edges(h.VCompound, h.OutLineVCompound),
                tangent=edges(h.Rg1LineVCompound) if tangent else [],
                hidden=edges(h.HCompound, h.OutLineHCompound) if hidden else [])


def _to_local(shape, n, x, w0=0.0):
    """Form in Ansichtskoordinaten: u = p.X, v = p.Y, w = p.N - w0 (Schnittflaechen liegen dann bei w = 0)."""
    t = gp_Trsf()
    t.SetTransformation(gp_Ax3(gp_Pnt(0, 0, 0), gp_Dir(*map(float, n)), gp_Dir(*map(float, x))))
    s = BRepBuilderAPI_Transform(shape, t, True).Shape()
    if abs(w0) > 0:
        t2 = gp_Trsf()
        t2.SetTranslation(gp_Vec(0, 0, -w0))
        s = BRepBuilderAPI_Transform(s, t2, True).Shape()
    return s


def _common(shape, disc):
    op = BRepAlgoAPI_Common(shape, disc)
    if not op.IsDone():
        return None
    return op.Shape()


def _sample(edge, defl, xyz=False):
    """Punkte (u, v) entlang einer Kante in ihrer Richtung im Draht, mit xyz=True die Punkte im Raum."""
    c = BRepAdaptor_Curve(edge)
    u1, u2 = c.FirstParameter(), c.LastParameter()
    if c.GetType() == GeomAbs_Line:
        pts = [c.Value(u1), c.Value(u2)]
    else:
        d = GCPnts_QuasiUniformDeflection(c, max(defl, 1e-4), u1, u2)
        if d.IsDone() and d.NbPoints() >= 2:
            pts = [d.Value(i) for i in range(1, d.NbPoints() + 1)]
        else:
            pts = [c.Value(u1 + (u2 - u1) * k / 48) for k in range(49)]
    arr = np.array([(p.X(), p.Y(), p.Z()) if xyz else (p.X(), p.Y()) for p in pts], dtype=float)
    return arr[::-1] if edge.Orientation() == TopAbs_REVERSED else arr


def _seg_dist(p, a, b):
    """Abstand der Punkte p (N x 2) zur naechsten der Strecken a[i] -> b[i] (M x 2)."""
    d = b - a
    L = (d * d).sum(axis=1)
    t = ((p[:, None, :] - a[None]) * d[None]).sum(axis=2) / np.where(L > 1e-18, L, 1)[None]
    q = a[None] + d[None] * np.where(L > 1e-18, t, 0.0).clip(0, 1)[..., None]
    return np.sqrt(((q - p[:, None, :]) ** 2).sum(axis=2)).min(axis=1)


def _straight(pts, tol=1e-4):
    """Liegen die Punkte auf ihrer Sehne? HLR liefert gerade Kanten manchmal als B-Spline."""
    if len(pts) < 3:
        return True
    a, b = pts[0], pts[-1]
    d = b - a
    n = float(np.linalg.norm(d))
    if n < 1e-9:
        return False
    off = np.abs(d[0] * (pts[:, 1] - a[1]) - d[1] * (pts[:, 0] - a[0])) / n
    return float(off.max()) < tol


def _loops(face, defl):
    """Aussen- und Innenraender einer ebenen Flaeche in Ansichtskoordinaten als geschlossene Punktfolgen."""
    out = []
    f = cq.Face(face)
    for wire in [f.outerWire()] + f.innerWires():
        pts = []
        ex = BRepTools_WireExplorer(wire.wrapped)
        while ex.More():
            e = ex.Current()
            s = _sample(e, defl)
            if e.Orientation() != ex.Orientation():
                s = s[::-1]
            pts.extend(s if not pts else s[1:])
            ex.Next()
        if len(pts) >= 3:
            out.append(np.array(pts))
    return out


class _Geometry:
    """Projizierte Geometrie einer Ansicht in Ansichtskoordinaten (mm im Modell, unabhaengig vom Maßstab).
    Einzelheiten schneiden daraus nur einen Kreis aus, statt neu zu projizieren."""

    def __init__(self, n, x, y, edges, hatch, shapes, center, bounds):
        self.n, self.x, self.y = n, x, y
        self.edges = edges        # {"visible": [TopoDS_Edge], "hidden": [...], "tangent": [...]}
        self.hatch = hatch        # [(TopoDS_Face in Ansichtskoordinaten, Stil)]
        self.shapes = shapes      # gezeigte Formen im Modell (fuer circles())
        self.center = center      # Mitte der Begrenzung im Modell, Standard fuer origin
        self.bounds = bounds      # die 8 Ecken der Begrenzung im Modell (Ausdehnung einer unterbrochenen Ansicht)

    def clip(self, cu, cv, r):
        """Nur was im Kreis um (cu, cv) liegt (Einzelheit)."""
        return self._clip(cq.Face.makeFromWires(cq.Wire.makeCircle(r, cq.Vector(cu, cv, 0), cq.Vector(0, 0, 1))).wrapped)

    def clip_box(self, u0, u1, v0, v1):
        """Nur was im Rechteck liegt (ein Stueck einer unterbrochenen Ansicht)."""
        pts = [cq.Vector(u0, v0, 0), cq.Vector(u1, v0, 0), cq.Vector(u1, v1, 0), cq.Vector(u0, v1, 0)]
        return self._clip(cq.Face.makeFromWires(cq.Wire.makePolygon(pts, close=True)).wrapped)

    def _clip(self, disc):
        edges = {}
        for k, es in self.edges.items():
            if not es:
                edges[k] = []
                continue
            res = _common(cq.Compound.makeCompound([cq.Edge(e) for e in es]).wrapped, disc)
            edges[k] = [e.wrapped for e in cq.Shape.cast(res).Edges()] if res is not None and not res.IsNull() else []
        hatch = []
        for face, style in self.hatch:
            res = _common(face, disc)
            if res is not None and not res.IsNull():
                hatch += [(f.wrapped, style) for f in cq.Shape.cast(res).Faces()]
        return _Geometry(self.n, self.x, self.y, edges, hatch, self.shapes, self.center, self.bounds)


def _on_region(region, face):
    """Liegt die Flaeche ganz auf dem Rand des weggeschnittenen Koerpers, ist also durch den Schnitt entstanden?"""
    return all(region.distance(v) <= 1e-6 for v in face.Vertices())


def _edge_on(face, n):
    """Sieht der Betrachter die Flaeche nur als Linie (eben parallel zur Blickrichtung, Zylinder mit Achse entlang)?"""
    gt = face.geomType()
    if gt == "PLANE":
        nrm = face.normalAt(face.Center())
        return abs(float(np.dot((nrm.x, nrm.y, nrm.z), n))) < 1e-6
    if gt == "CYLINDER":
        ax = BRepAdaptor_Surface(face.wrapped).Cylinder().Axis().Direction()
        return abs(abs(ax.X() * n[0] + ax.Y() * n[1] + ax.Z() * n[2]) - 1) < 1e-6
    return False


def _drop_borders(edges, faces, x, y):
    """Kanten weglassen, die nur Schnittflaechen von der Seite zeigen: Stufen eines Schnittverlaufs, die Grenze eines
    Halbschnitts, der Rand eines Ausbruchs. Dort steht nach ISO 128-44 keine Kante, sondern nichts, eine Mittellinie oder
    eine Freihandlinie."""
    tol, defl = 5e-3, 1e-3
    a, b = [], []
    for f in faces:
        for e in f.Edges():
            p = _sample(e.wrapped, defl, xyz=True)
            uv = np.column_stack([p @ x, p @ y])
            a.append(uv[:-1] if len(uv) > 1 else uv)
            b.append(uv[1:] if len(uv) > 1 else uv)
    if not a:
        return edges
    a, b = np.concatenate(a), np.concatenate(b)
    out = {}
    for k, es in edges.items():
        keep = []
        for e in es:
            pts = _sample(e, defl)
            if not (len(pts) and float(_seg_dist(pts, a, b).max()) <= tol):
                keep.append(e)
        out[k] = keep
    return out


def _project(items, n, x, y, hidden, tangent, region=None, unhatched=(), hatch=None, borders=False):
    """items: [(Name, Form)]. region: Koerper, der weggeschnitten wird (Schnitt), sonst None. borders: Kanten von
    Schnittflaechen, die der Betrachter nur von der Seite sieht, weglassen (Schnittverlauf, Halbschnitt, Ausbruch)."""
    shapes, faces, edge_on = [], [], []
    styles = _hatch_styles(hatch, [nm for nm, _s in items if nm not in unhatched])
    k = 0
    for nm, s in items:
        if region is None or (nm is not None and nm in unhatched):
            shapes.append(s)
            continue
        cut = s.cut(region)
        if not cut.Solids() and not cut.Faces():
            continue  # ganz im weggeschnittenen Bereich
        shapes.append(cut)
        style = styles[k] if nm not in unhatched else None
        k += 1
        for f in cut.Faces():
            if borders and _edge_on(f, n) and _on_region(region, f):
                edge_on.append(f)
                continue
            if style is None or f.geomType() != "PLANE":
                continue
            c = f.Center()
            nrm = f.normalAt(c)
            if float(np.dot((nrm.x, nrm.y, nrm.z), n)) < 1 - 1e-6:
                continue  # nur Flaechen, die zum Betrachter zeigen
            if region.distance(cq.Vertex.makeVertex(c.x, c.y, c.z)) > 1e-6:
                continue  # nicht durch den Schnitt entstanden
            w0 = float(np.dot((c.x, c.y, c.z), n))
            faces.append((_to_local(f.wrapped, n, x, w0), style))
    if not shapes:
        raise ValueError("Nothing left to show: the section removes everything")
    comp = shapes[0] if len(shapes) == 1 else cq.Compound.makeCompound(shapes)
    edges = _hlr(comp, n, x, hidden, tangent)
    if edge_on:
        edges = _drop_borders(edges, edge_on, x, y)
    bb = _bbox([s for _n, s in items])
    center = np.array([(bb.xmin + bb.xmax) / 2, (bb.ymin + bb.ymax) / 2, (bb.zmin + bb.zmax) / 2])
    bounds = np.array([(a, b, c) for a in (bb.xmin, bb.xmax) for b in (bb.ymin, bb.ymax) for c in (bb.zmin, bb.zmax)])
    return _Geometry(n, x, y, edges, faces, shapes, center, bounds)


def _hatch_styles(hatch, names):
    """Schraffur je geschnittenem Teil: benachbarte Teile abwechselnd 45 und 135 Grad, ab dem dritten mit groesserem
    Abstand (ISO 128-50). hatch: None (so), dict(angle=, spacing=, pattern=) fuer alle, "solid" oder {Teil: ...}."""
    out = []
    for i, nm in enumerate(names):
        base = dict(pattern="ANSI31", angle=45 if i % 2 == 0 else 135, spacing=2.5 * (1 + 0.6 * ((i // 2) % 2)))
        h = hatch
        if isinstance(hatch, dict) and nm is not None and nm in hatch:
            h = hatch[nm]
        elif isinstance(hatch, dict) and not ({"angle", "spacing", "pattern"} & set(hatch)):
            h = None  # Zuordnung je Teil, dieses Teil nicht genannt
        if h is False:
            out.append(None)
        elif h == "solid":
            out.append(dict(pattern="SOLID"))
        elif isinstance(h, dict):
            unknown = set(h) - {"angle", "spacing", "pattern"}
            if unknown:
                raise ValueError(f"hatch knows angle, spacing and pattern, not {', '.join(sorted(unknown))}")
            out.append({**base, **h})
        elif h is None:
            out.append(base)
        else:
            raise ValueError(f"hatch must be None, \"solid\", False, dict(angle=, spacing=, pattern=) or a dict per part, not {h!r}")
    return out


def _short(t, n=30):
    t = " ".join(str(t).split())
    return t if len(t) <= n else t[:n - 3] + "..."


def _breaks(spec, x, y):
    """breaks=[(p1, p2), ...] -> [(0 = waagerecht / 1 = senkrecht auf dem Blatt, von, bis)] in Ansichtskoordinaten."""
    if spec is None or (hasattr(spec, "__len__") and len(spec) == 0):
        return []
    msg = f"breaks must be a list of model point pairs [((x, y, z), (x, y, z)), ...], not {spec!r}"
    if isinstance(spec, (str, bytes)) or not hasattr(spec, "__iter__"):
        raise ValueError(msg)
    spec = list(spec)
    # Ein einzelnes Paar ohne die Liste darum
    if len(spec) == 2 and all(hasattr(q, "__len__") and len(q) == 3 for q in spec) \
            and all(isinstance(c, (int, float, np.number)) for c in spec[0]):
        spec = [spec]
    out = []
    for item in spec:
        if isinstance(item, (str, bytes)) or not hasattr(item, "__len__") or len(item) != 2:
            raise ValueError(msg)
        a, b = _vec(item[0], "break point"), _vec(item[1], "break point")
        du, dv = float(np.dot(b - a, x)), float(np.dot(b - a, y))
        ax = 0 if abs(du) >= abs(dv) else 1
        if max(abs(du), abs(dv)) < 1e-9:
            raise ValueError(f"The two points of the break {item!r} coincide in this view")
        axis = (x, y)[ax]
        out.append((ax, *sorted((float(np.dot(a, axis)), float(np.dot(b, axis))))))
    for ax in (0, 1):
        bs = sorted(b for b in out if b[0] == ax)
        for b1, b2 in zip(bs, bs[1:]):
            if b2[1] < b1[2]:
                raise ValueError("Breaks must not overlap")
    return out


def _check_parent(parent, n):
    if not isinstance(parent, View):
        raise ValueError("parent must be a view of this sheet")
    if abs(float(np.dot(np.array(parent._geo.n), n))) > 1e-6:
        raise ValueError("The cutting plane must be seen edge-on in the parent view (section direction "
                         "perpendicular to the parent's viewing direction)")


def _exit(p, d, box):
    """Wie weit von p in Richtung d bis zum Rand des Rechtecks? 0, wenn p schon draussen liegt."""
    x0, y0, x1, y1 = box
    if not (x0 < p[0] < x1 and y0 < p[1] < y1):
        return 0.0
    ts = []
    for k, (lo, hi) in enumerate(((x0, x1), (y0, y1))):
        if d[k] > 1e-12:
            ts.append((hi - p[k]) / d[k])
        elif d[k] < -1e-12:
            ts.append((lo - p[k]) / d[k])
    return min(ts) if ts else 0.0


def _path_region(items, parent, n, pts):
    """Koerper, den ein Schnittverlauf wegschneidet: alles auf der Seite des Betrachters der Linie durch pts, gesehen
    in der Ausgangsansicht und durch die ganze Tiefe."""
    g = parent._geo
    q = []
    for p in pts:
        uv = np.array([float(np.dot(p, g.x)), float(np.dot(p, g.y))])
        if not q or np.linalg.norm(uv - q[-1]) > 1e-9:
            q.append(uv)
    if len(q) < 2:
        raise ValueError("The points of path coincide in the parent view")
    q = np.array(q)
    n2 = np.array([float(np.dot(n, g.x)), float(np.dot(n, g.y))])
    n2 = n2 / np.linalg.norm(n2)
    bb = _bbox([s for _n, s in items])
    corners = np.array([(a, b, c) for a in (bb.xmin, bb.xmax) for b in (bb.ymin, bb.ymax) for c in (bb.zmin, bb.zmax)])
    uv = corners @ np.column_stack([g.x, g.y])
    big = 2 * (float(np.abs(uv).max()) + float(np.abs(q).max())) + 10
    d0 = (q[0] - q[1]) / np.linalg.norm(q[0] - q[1])
    d1 = (q[-1] - q[-2]) / np.linalg.norm(q[-1] - q[-2])
    poly = [q[0] + d0 * big, *q, q[-1] + d1 * big, q[-1] + d1 * big + n2 * big, q[0] + d0 * big + n2 * big]
    depth = corners @ np.array(g.n)
    w0, w1 = float(depth.min()) - 1, float(depth.max()) + 1
    pn = np.array(g.n)
    try:
        wire = cq.Wire.makePolygon([cq.Vector(*(u * g.x + v * g.y + w0 * pn)) for u, v in poly], close=True)
        region = cq.Solid.extrudeLinear(cq.Face.makeFromWires(wire), cq.Vector(*(pn * (w1 - w0))))
        ok = region.isValid() and region.Volume() > 0
    except Exception:
        ok = False
    if not ok:
        raise ValueError("The cutting line of path crosses itself or turns back: give its points in order along the line")
    return region


# ---- Ansicht --------------------------------------------------------------------------------------------------------

class View:
    """One view on the sheet. Created with Sheet.view(), Sheet.section() or Sheet.detail(). Converts model points to
    the sheet (pt) and places dimensions, center lines and leaders at model points, the values come from the geometry."""

    def __init__(self, sheet, geo, kind, name, at, scale, origin, clip, layer, file, line, breaks=(), auto_origin=False):
        self.sheet, self._geo, self.kind, self.name = sheet, geo, kind, name
        self.phantom = layer == "PHANTOM"
        self.at, self.scale = np.array(at, dtype=float), scale
        self.origin = np.array(origin, dtype=float)
        self.clip = clip  # (u, v, r) in Ansichtskoordinaten oder None
        self.file, self.line = file, line
        # Unterbrechungen [(0 = waagerecht / 1 = senkrecht auf dem Blatt, von, bis)] in Ansichtskoordinaten (mm im Modell)
        self.breaks = sorted(breaks)
        self._gap = BREAK_GAP / scale
        for _ax, lo, hi in self.breaks:
            if hi - lo <= self._gap:
                raise ValueError(f"A break must leave out more than the gap of {num(BREAK_GAP)} mm on the sheet, that is "
                                 f"more than {num(self._gap)} mm of the model at this scale")
        if self.breaks and auto_origin:
            # Mitte der verkuerzten Ansicht, damit Ansichten mit gleichen Unterbrechungen fluchten
            uv = geo.bounds @ np.column_stack([geo.x, geo.y])
            self._o = np.array([(self._bshift(uv[:, k].min(), k) + self._bshift(uv[:, k].max(), k)) / 2 for k in (0, 1)])
        else:
            self._o = np.array([self._bshift(float(np.dot(self.origin, geo.x)), 0),
                                self._bshift(float(np.dot(self.origin, geo.y)), 1)])
        self._off = np.zeros(2)  # Versatz des gerade gezeichneten Stuecks einer unterbrochenen Ansicht
        self._lines = []  # [(Punkte auf dem Blatt, "visible" | "hidden" | "tangent")] fuer die Pruefung
        self._refs = []   # Mittenkreuze und Mittellinien des Agenten (Punkte auf dem Blatt): gueltige Bezugspunkte für Maße
        self._emit(layer)
        pts = np.concatenate([p for p, _k in self._lines]) if self._lines else self.at.reshape(1, 2)
        self.bbox = (float(pts[:, 0].min()), float(pts[:, 1].min()), float(pts[:, 0].max()), float(pts[:, 1].max()))
        self._break_lines()

    # -- Umrechnung

    @property
    def direction(self):
        """Direction from the part to the viewer (unit vector in the model)."""
        return tuple(float(v) for v in self._geo.n)

    def pt(self, p):
        """Model point (x, y, z) -> point on the sheet (x, y) in mm."""
        u, v = self._model_uv(p)
        u, v = self._bshift(u, 0), self._bshift(v, 1)
        return (float(self.at[0] + self.scale * (u - self._o[0])), float(self.at[1] + self.scale * (v - self._o[1])))

    def _model_uv(self, p):
        p = _vec(p, "point")
        return float(np.dot(p, self._geo.x)), float(np.dot(p, self._geo.y))

    def _bshift(self, c, axis):
        """Ansichtskoordinate nach dem Herausnehmen der Unterbrechungen. Punkte in einer Luecke landen an ihrem Anfang."""
        s = 0.0
        for ax, lo, hi in self.breaks:
            if ax != axis:
                continue
            if c >= hi:
                s -= (hi - lo) - self._gap
            elif c > lo:
                return lo + s
        return c + s

    def _uv(self, u, v):
        return (self.at[0] + self.scale * (u + self._off[0] - self._o[0]),
                self.at[1] + self.scale * (v + self._off[1] - self._o[1]))

    def _sheet_pts(self, arr):
        return np.column_stack([self.at[0] + self.scale * (arr[:, 0] + self._off[0] - self._o[0]),
                                self.at[1] + self.scale * (arr[:, 1] + self._off[1] - self._o[1])])

    # -- Geometrie zeichnen

    def _pieces(self):
        """Stuecke einer unterbrochenen Ansicht: (Geometrie, Versatz in Ansichtskoordinaten)."""
        if not self.breaks:
            return [(self._geo, (0.0, 0.0))]
        uv = self._geo.bounds @ np.column_stack([self._geo.x, self._geo.y])
        m = float(np.ptp(uv)) + 10.0
        lo, hi = uv.min(axis=0) - m, uv.max(axis=0) + m

        def intervals(axis):
            out, start, s = [], -math.inf, 0.0
            for ax, b0, b1 in self.breaks:
                if ax == axis:
                    out.append((start, b0, s))
                    s -= (b1 - b0) - self._gap
                    start = b1
            return out + [(start, math.inf, s)]

        out = []
        for u0, u1, su in intervals(0):
            for v0, v1, sv in intervals(1):
                u0c, u1c, v0c, v1c = max(u0, lo[0]), min(u1, hi[0]), max(v0, lo[1]), min(v1, hi[1])
                if u1c - u0c > 1e-9 and v1c - v0c > 1e-9:
                    out.append((self._geo.clip_box(u0c, u1c, v0c, v1c), (su, sv)))
        return out

    def _emit(self, layer):
        msp = self.sheet.msp
        defl = 0.01 / self.scale  # 0.01 mm auf dem Blatt
        layers = {"visible": layer or "VISIBLE", "hidden": "HIDDEN", "tangent": "TANGENT"}
        for geo, off in self._pieces():
            self._off = np.array(off)
            for face, style in geo.hatch:
                loops = _loops(face, defl)
                if not loops:
                    continue
                h = msp.add_hatch(color=256, dxfattribs={"layer": "HATCH"})
                for lp in loops:
                    h.paths.add_polyline_path([tuple(p) for p in self._sheet_pts(lp)], is_closed=True)
                if style["pattern"] == "SOLID":
                    h.set_solid_fill(color=256)
                else:
                    # ANSI31 hat 3.175 mm Abstand bei 45 Grad
                    h.set_pattern_fill(style["pattern"], color=256, scale=style["spacing"] / 3.175, angle=style["angle"] - 45)
            for kind, edges in geo.edges.items():
                for e in edges:
                    pts = self._edge(msp, e, layers[kind], defl)
                    if pts is not None:
                        self._lines.append((pts, kind))
        self._off = np.zeros(2)

    def _break_lines(self):
        """Bruchlinien nach ISO 128-2 (schmale Zickzacklinie) an beiden Seiten jeder Luecke, so lang wie die Kanten,
        die dort enden, und 2 mm darueber hinaus."""
        for ax, lo, _hi in self.breaks:
            p0 = self.at[ax] + self.scale * (self._bshift(lo, ax) - self._o[ax])
            for p in (p0, p0 + BREAK_GAP):
                across = [pts[np.abs(pts[:, ax] - p) < 0.02, 1 - ax] for pts, _k in self._lines]
                across = np.concatenate(across) if across else np.zeros(0)
                if len(across):
                    q0, q1 = float(across.min()), float(across.max())
                else:
                    q0, q1 = (self.bbox[1], self.bbox[3]) if ax == 0 else (self.bbox[0], self.bbox[2])
                m = (q0 + q1) / 2
                zig = [(0, q0 - 2), (0, m - 2), (1.6, m - 0.8), (-1.6, m + 0.8), (0, m + 2), (0, q1 + 2)]
                pts = [(p + o, t) if ax == 0 else (t, p + o) for o, t in zig]
                self.sheet.msp.add_lwpolyline(pts, dxfattribs={"layer": "THIN"})
                self.sheet._annotate([np.array(pts)], ("break",), "a break line")

    def _edge(self, msp, e, layer, defl):
        """Eine projizierte Kante als LINE, ARC, CIRCLE, ELLIPSE oder LWPOLYLINE. Liefert die Punkte auf dem Blatt."""
        c = BRepAdaptor_Curve(e)
        u1, u2 = c.FirstParameter(), c.LastParameter()
        if not (math.isfinite(u1) and math.isfinite(u2)) or abs(u2 - u1) < 1e-12:
            return None
        t = c.GetType()
        s = self.scale
        att = {"layer": layer}
        if t == GeomAbs_Circle:
            circ = c.Circle()
            ctr, r = circ.Location(), circ.Radius()
            cx, cy = self._uv(ctr.X(), ctr.Y())
            if abs(u2 - u1 - 2 * math.pi) < 1e-9:
                msp.add_circle((cx, cy), r * s, dxfattribs=att)
            else:
                a1 = math.degrees(math.atan2(c.Value(u1).Y() - ctr.Y(), c.Value(u1).X() - ctr.X()))
                a2 = math.degrees(math.atan2(c.Value(u2).Y() - ctr.Y(), c.Value(u2).X() - ctr.X()))
                if circ.Axis().Direction().Z() < 0:
                    a1, a2 = a2, a1
                msp.add_arc((cx, cy), r * s, a1, a2, dxfattribs=att)
            return self._sheet_pts(_sample(e, defl))
        if t == GeomAbs_Ellipse:
            el = c.Ellipse()
            ctr, xd = el.Location(), el.XAxis().Direction()
            cx, cy = self._uv(ctr.X(), ctr.Y())
            a, b = el.MajorRadius(), el.MinorRadius()
            if a > 1e-12:
                if el.Axis().Direction().Z() < 0:
                    p1, p2 = -u2, -u1
                else:
                    p1, p2 = u1, u2
                full = abs(u2 - u1 - 2 * math.pi) < 1e-9
                msp.add_ellipse((cx, cy), (xd.X() * a * s, xd.Y() * a * s, 0), min(1.0, b / a),
                                0 if full else p1, 2 * math.pi if full else p2, dxfattribs=att)
                return self._sheet_pts(_sample(e, defl))
        pts = _sample(e, defl)
        sp = self._sheet_pts(pts)
        if t == GeomAbs_Line or _straight(sp):
            msp.add_line(tuple(sp[0]), tuple(sp[-1]), dxfattribs=att)
            return sp[[0, -1]]
        msp.add_lwpolyline([tuple(p) for p in sp], dxfattribs=att)
        return sp

    # -- Abfragen

    def circles(self, diameter=None, arcs=False):
        """Circles of the shown geometry seen as circles in this view (axis along the viewing direction): holes,
        pins, round outlines. Returns [(center (x, y, z), radius)], each center and radius once. diameter= filters,
        arcs=True also returns arcs (rounded corners, fillets seen end-on)."""
        return [(c, r) for c, r, full in self._circles(diameter) if full or arcs]

    def _circles(self, diameter=None):
        seen, out = {}, []
        n = self._geo.n
        for s in self._geo.shapes:
            for e in s.Edges():
                if e.geomType() != "CIRCLE":
                    continue
                ad = BRepAdaptor_Curve(e.wrapped)
                full = abs(ad.LastParameter() - ad.FirstParameter() - 2 * math.pi) < 1e-6
                c = ad.Circle()
                ax = c.Axis().Direction()
                if abs(abs(ax.X() * n[0] + ax.Y() * n[1] + ax.Z() * n[2]) - 1) > 1e-6:
                    continue
                p = np.array([c.Location().X(), c.Location().Y(), c.Location().Z()])
                r = c.Radius()
                if diameter is not None and abs(2 * r - float(diameter)) > 1e-6:
                    continue
                u, v = float(np.dot(p, self._geo.x)), float(np.dot(p, self._geo.y))
                if self.clip and math.hypot(u - self.clip[0], v - self.clip[1]) > self.clip[2] + 1e-9:
                    continue
                if any(lo + 1e-9 < (u, v)[ax] < hi - 1e-9 for ax, lo, hi in self.breaks):
                    continue  # in der Luecke einer unterbrochenen Ansicht
                key = (round(u, 4), round(v, 4), round(r, 4), full)
                item = (tuple(round(float(x), 6) + 0.0 for x in p), round(r, 6), full)
                # Gleiche Mitte in der Ansicht (Ober- und Unterkante einer Bohrung): die Lage naeher am Betrachter
                if key in seen:
                    i = seen[key]
                    if float(np.dot(p, n)) > float(np.dot(out[i][0], n)) + 1e-9:
                        out[i] = item
                    continue
                seen[key] = len(out)
                out.append(item)
        # Ein Vollkreis verdeckt Boegen mit gleicher Mitte und gleichem Radius (Bohrung, die eine Fase anschneidet)
        fulls = {(round(float(np.dot(c, self._geo.x)), 4), round(float(np.dot(c, self._geo.y)), 4), round(r, 4))
                 for c, r, f in out if f}
        out = [(c, r, f) for c, r, f in out if f or (round(float(np.dot(c, self._geo.x)), 4),
                                                       round(float(np.dot(c, self._geo.y)), 4), round(r, 4)) not in fulls]
        return sorted(out, key=lambda c: (not c[2], -c[1], c[0]))

    # -- Maße

    def dim(self, p1, p2, offset=10, direction=None, text=None, tol=None, text_at=None):
        """Linear dimension between two model points; the value is measured, not typed.

        offset     distance in mm on the sheet from the outer point to the dimension line. Positive: above (horizontal)
                   or right (vertical), negative: below or left. For "aligned": positive is left of p1 -> p2
        direction  "h" horizontal, "v" vertical or "aligned" on the sheet. Default: "h" if the points are further
                   apart horizontally than vertically, else "v"
        text       None: the measured value. "<>" stands for it, e.g. "Ø<> H7" (diameter seen from the side),
                   "<> ±0.1", "2x <>"
        tol        0.1 for ±0.1 or (0.1, -0.05) for +0.1/-0.05 in small text after the value
        text_at    optional point on the sheet for the text instead of the middle

        Across a break of the view the dimension shows the full length of the model."""
        file, line = _where()
        a, b = np.array(self.pt(p1)), np.array(self.pt(p2))
        (u1, v1), (u2, v2) = self._model_uv(p1), self._model_uv(p2)
        d = b - a
        if direction is None:
            direction = "h" if abs(d[0]) >= abs(d[1]) else "v"
        offset = float(offset)
        msp = self.sheet.msp
        if direction == "h":
            measured, shown = abs(u2 - u1), abs(d[0]) / self.scale
            dimargs = self._dimargs(text, measured, shown)
            y = (max(a[1], b[1]) + offset) if offset >= 0 else (min(a[1], b[1]) + offset)
            dim = msp.add_linear_dim(base=((a[0] + b[0]) / 2, y), p1=tuple(a), p2=tuple(b), angle=0, **dimargs)
        elif direction == "v":
            measured, shown = abs(v2 - v1), abs(d[1]) / self.scale
            dimargs = self._dimargs(text, measured, shown)
            x = (max(a[0], b[0]) + offset) if offset >= 0 else (min(a[0], b[0]) + offset)
            dim = msp.add_linear_dim(base=(x, (a[1] + b[1]) / 2), p1=tuple(a), p2=tuple(b), angle=90, **dimargs)
        elif direction == "aligned":
            if np.linalg.norm(d) < 1e-9:
                raise ValueError("The two points coincide in this view")
            measured, shown = math.hypot(u2 - u1, v2 - v1), float(np.linalg.norm(d)) / self.scale
            dim = msp.add_aligned_dim(p1=tuple(a), p2=tuple(b), distance=offset, **self._dimargs(text, measured, shown))
        else:
            raise ValueError(f"direction must be \"h\", \"v\" or \"aligned\", not {direction!r}")
        return self._finish(dim, "linear", measured, text, tol, text_at, [p1, p2], file, line)

    def diameter(self, center, radius, angle=45, text=None, tol=None, text_at=None):
        """Diameter dimension of a circle seen as a circle in this view (center in the model, radius in mm).
        angle: direction on the sheet in degrees from the center towards the text (0 right, 90 up). Ø is added
        automatically: text="<> H7" gives "Ø8 H7", a Ø typed before <> is not doubled."""
        file, line = _where()
        r = float(radius)
        text = _no_prefix(text, r"Ø|ø|⌀|%%[cC]")
        # ezdxf legt den Text ans Ende gegenueber von angle
        dim = self.sheet.msp.add_diameter_dim(center=self.pt(center), radius=r * self.scale, angle=float(angle) + 180,
                                              **self._dimargs(text))
        return self._finish(dim, "diameter", 2 * r, text, tol, text_at, [center], file, line, radius=r)

    def radius(self, center, radius, angle=45, text=None, tol=None, text_at=None):
        """Radius dimension of an arc seen as an arc in this view. angle: direction on the sheet in degrees from the
        center towards the text. R is added automatically: text="<>" gives "R4", a typed R before <> is not doubled."""
        file, line = _where()
        r = float(radius)
        text = _no_prefix(text, r"R")
        dim = self.sheet.msp.add_radius_dim(center=self.pt(center), radius=r * self.scale, angle=float(angle),
                                            **self._dimargs(text))
        return self._finish(dim, "radius", r, text, tol, text_at, [center], file, line, radius=r)

    def angle(self, vertex, p1, p2, distance=15, text=None, text_at=None):
        """Angle between the lines vertex -> p1 and vertex -> p2 (model points), the arc at distance mm on the sheet
        from the vertex. The value is the angle on the sheet: use it in views where both lines lie in the paper."""
        file, line = _where()
        c, a, b = (np.array(self.pt(p)) for p in (vertex, p1, p2))
        da, db = a - c, b - c
        if np.linalg.norm(da) < 1e-9 or np.linalg.norm(db) < 1e-9:
            raise ValueError("p1 and p2 must differ from the vertex in this view")
        mid = da / np.linalg.norm(da) + db / np.linalg.norm(db)
        mid = mid / np.linalg.norm(mid) if np.linalg.norm(mid) > 1e-9 else np.array([-da[1], da[0]]) / np.linalg.norm(da)
        base = c + mid * float(distance)
        dim = self.sheet.msp.add_angular_dim_3p(base=tuple(base), center=tuple(c), p1=tuple(a), p2=tuple(b),
                                                **self._dimargs(text))
        cosv = float(np.dot(da, db) / (np.linalg.norm(da) * np.linalg.norm(db)))
        measured = math.degrees(math.acos(max(-1.0, min(1.0, cosv))))
        return self._finish(dim, "angle", measured, text, None, text_at, [vertex, p1, p2], file, line)

    def _dimargs(self, text, measured=None, shown=None):
        if text is not None and not isinstance(text, str):
            raise ValueError(f"text must be a text like \"<> H7\", not {text!r}")
        text = "<>" if text is None else text
        if measured is not None and abs(measured - shown) > 1e-6:
            # Ueber eine Unterbrechung misst ezdxf die verkuerzte Strecke, deshalb der Wert aus dem Modell
            text = text.replace("<>", num(measured))
        return dict(text=text, dimstyle="ISO", override={"dimlfac": 1.0 / self.scale}, dxfattribs={"layer": "DIM"})

    def _finish(self, dim, kind, measured, text, tol, text_at, points, file, line, radius=None):
        if tol is not None:
            if isinstance(tol, (int, float)):
                dim.set_tolerance(abs(float(tol)))
            else:
                try:
                    up, lo = (float(v) for v in tol)
                except (TypeError, ValueError):
                    raise ValueError(f"tol must be 0.1 (for ±0.1) or (upper, lower) like (0.1, -0.05), not {tol!r}") from None
                dim.set_tolerance(up, -lo)
        if text_at is not None:
            dim.set_location(tuple(_pt2(text_at, "text_at")), leader=False)
        dim.render()
        rec = dict(kind=kind, value=measured, text=text, view=self, points=[tuple(_vec(p, "point")) for p in points],
                   radius=radius, entity=dim.dimension, file=file, line=line)
        self.sheet._dims.append(rec)
        return dim.dimension

    # -- Mittellinien, Hinweise

    def center_mark(self, center, radius, extend=2.5):
        """Center lines across a circle seen in this view (center in the model, radius in mm), extend mm beyond it.
        Small circles (under 5 mm on the sheet) get thin continuous lines as in ISO 128. Also marks positions that are
        not in the model (screws, holes drilled on assembly): dimensions to the center are fine."""
        cx, cy = self.pt(center)
        r = float(radius) * self.scale + float(extend)
        layer = "CENTER" if float(radius) * self.scale >= 2.5 else "THIN"
        msp = self.sheet.msp
        lines = [np.array([(cx - r, cy), (cx + r, cy)]), np.array([(cx, cy - r), (cx, cy + r)])]
        for ln in lines:
            msp.add_line(tuple(ln[0]), tuple(ln[1]), dxfattribs={"layer": layer})
        self._refs.append(np.array([(cx, cy)]))
        self.sheet._annotate(lines, ("center",), f"a center mark (line {_where()[1]})")

    def center_marks(self, diameter=None, extend=2.5):
        """center_mark() for every circle of circles(diameter)."""
        for c, r in self.circles(diameter):
            self.center_mark(c, r, extend)

    def centerline(self, p1, p2, extend=2.5):
        """Axis or symmetry line from model point p1 to p2, extend mm beyond both ends on the sheet. Dimensions may
        end on it (distance from an edge to the axis)."""
        a, b = np.array(self.pt(p1)), np.array(self.pt(p2))
        d = b - a
        n = float(np.linalg.norm(d))
        if n < 1e-9:
            raise ValueError("The two points of the center line coincide in this view")
        d = d / n * float(extend)
        ln = np.array([a - d, b + d])
        self.sheet.msp.add_line(tuple(ln[0]), tuple(ln[1]), dxfattribs={"layer": "CENTER"})
        self._refs.append(ln)
        self.sheet._annotate([ln], ("center",), f"a center line (line {_where()[1]})")

    def leader(self, point, text, at, end="arrow", height=TEXT_HEIGHT):
        """Leader from a model point to a text at the sheet point `at`. end: "arrow" (ends on an edge), "dot" (ends
        inside a surface) or "none". The text sits on a short horizontal line at `at`."""
        return self.sheet.leader(self.pt(point), text, at, end, height)


# ---- Blatt ----------------------------------------------------------------------------------------------------------

class Sheet:
    """A drawing sheet with frame and title block (ISO 5457 and ISO 7200). Every Sheet(...) in drawings/*.py becomes
    output/drawings/<name>.pdf and .dxf plus a picture .soma/drawings/<name>.png. output/drawings.pdf holds all sheets
    of the model in one file.

    name        unique name, also the file name
    size        "A4" (portrait), "A3", "A2", "A1", "A0" (landscape) or (width, height) in mm
    scale       scale of the views unless a view sets its own: "1:2", "2:1", 1
    landscape   True/False to override the orientation of a standard size
    title, number, material, author, date, tolerance, owner, revision, sheet
                fields of the title block. date: default today. tolerance e.g. "ISO 2768-m"
    projection  "first" (ISO, Europe) or "third" (ASME): symbol in the title block, None without
    language    "en" or "de" for the captions of the title block
    titleblock  False: no title block (draw your own), frame: False: no frame

    The ezdxf document is sh.doc, its model space sh.msp: everything not covered here can be drawn directly in sheet
    coordinates (mm). Layers: VISIBLE, HIDDEN, TANGENT, CENTER, PHANTOM, THIN, HATCH, CUT, DIM, TEXT, FRAME, TITLE.
    Dimension style "ISO", text style "ISO"."""

    def __init__(self, name, size="A3", scale=1, *, landscape=None, title=None, number=None, material=None,
                 author=None, date=None, tolerance=None, owner=None, revision=None, sheet="1/1", projection="first",
                 language="en", titleblock=True, frame=True):
        self.file, self.line = _where()
        setup_fonts()
        if not isinstance(name, str) or not name.strip():
            raise ValueError("The sheet needs a name, e.g. Sheet(\"Bracket\")")
        self.name = name.strip()
        self.id = registry.ascii_name(self.name)
        if any(s.id == self.id for s in SHEETS):
            raise ValueError(f"There is already a sheet named {name!r} (names must be unique, also as file names)")
        if isinstance(size, str):
            key = size.strip().upper()
            if key not in SIZES:
                raise ValueError(f"size must be one of {', '.join(SIZES)} or (width, height) in mm, not {size!r}")
            short, long_ = SIZES[key]
            land = (key != "A4") if landscape is None else bool(landscape)
            self.width, self.height = (long_, short) if land else (short, long_)
            self.size = key
        else:
            w, h = _pt2(size, "size")
            if w < 50 or h < 50 or w > 5000 or h > 5000:
                raise ValueError(f"size must be between 50 and 5000 mm, not {size!r}")
            self.width, self.height = float(w), float(h)
            self.size = f"{num(w)} x {num(h)}"
        self.scale = parse_scale(scale)
        if projection not in ("first", "third", None):
            raise ValueError(f"projection must be \"first\", \"third\" or None, not {projection!r}")
        if language not in TITLE_LABELS:
            raise ValueError(f"language must be one of {', '.join(TITLE_LABELS)}, not {language!r}")
        self.projection = projection
        self._dims, self.views, self._labels = [], [], []
        # Fuer die Pruefung: Linien der Beschriftung (Hinweislinien, Schnittverlauf, Mittellinien ...), Tabellen und
        # Felder des Schriftfelds
        self._annot, self._tables, self._fields = [], [], []
        self._owners = 0
        self._new_doc()
        left = 20.0 if frame else 0.0
        m = 10.0 if frame else 0.0
        # Zeichenflaeche innerhalb des Rahmens (ISO 5457: links 20 mm Heftrand, sonst 10 mm)
        self.area = (left, m, self.width - m, self.height - m)
        if frame:
            self._frame(titleblock)
        self.titleblock = None
        if titleblock:
            fields = dict(owner=owner, title=self.name if title is None else title, drawn=author,
                          date=datetime.date.today().isoformat() if date is None else date, number=number,
                          revision=revision, material=material, tolerance=tolerance, scale=fmt_scale(self.scale),
                          size=self.size, sheet=sheet)
            self.titleblock = self._title_block(fields, TITLE_LABELS[language])
        SHEETS.append(self)

    # -- Dokument

    def _new_doc(self):
        # Feste Kennung "erstellt von ezdxf" statt Uhrzeit: gleiche Zeichnung, gleiche Datei (siehe drawrun.save_dxf)
        old = ezdxf.options.write_fixed_meta_data_for_testing
        ezdxf.options.write_fixed_meta_data_for_testing = True
        try:
            doc = ezdxf.new("R2018", units=4)
        finally:
            ezdxf.options.write_fixed_meta_data_for_testing = old
        doc.header["$MEASUREMENT"] = 1
        doc.header["$LWDISPLAY"] = 1
        doc.header["$LTSCALE"] = 1.0
        for nm, (pattern, desc) in LINETYPES.items():
            doc.linetypes.add(nm, pattern=pattern, description=desc)
        for nm, (color, lw, lt, desc) in LAYERS.items():
            layer = doc.layers.add(nm, color=color, lineweight=lw, linetype=lt)
            layer.description = desc
        doc.styles.add("ISO", font=FONT)
        ds = doc.dimstyles.new("ISO")
        for k, v in dict(dimtxsty="ISO", dimtxt=TEXT_HEIGHT, dimasz=3.0, dimexe=2.0, dimexo=0.0, dimgap=1.0, dimtad=1,
                         dimtih=0, dimtoh=0, dimdec=2, dimzin=8, dimtzin=8, dimtdec=2, dimadec=1, dimazin=2,
                         dimdsep=ord("."), dimclrd=256,
                         dimclre=256, dimclrt=256, dimlwd=-1, dimlwe=-1, dimtfac=0.7).items():
            ds.set_dxf_attrib(k, v)
        doc.header["$DIMSTYLE"] = "ISO"
        self.doc, self.msp = doc, doc.modelspace()

    def _frame(self, titleblock):
        x0, y0, x1, y1 = self.area
        msp = self.msp
        msp.add_lwpolyline([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], close=True, dxfattribs={"layer": "FRAME"})
        # Mittenmarken von der Blattkante bis 5 mm in den Rahmen, unten nicht ins Schriftfeld (A4 hoch: volle Breite)
        cx, cy = self.width / 2, self.height / 2
        bottom = y0 if titleblock and cx >= x1 - 180 else y0 + 5
        for a, b in (((cx, 0), (cx, bottom)), ((cx, self.height), (cx, y1 - 5)),
                     ((0, cy), (x0 + 5, cy)), ((self.width, cy), (x1 - 5, cy))):
            msp.add_line(a, b, dxfattribs={"layer": "FRAME"})

    def _title_block(self, f, lab):
        """Schriftfeld 180 mm breit unten rechts im Rahmen (ISO 7200). Liefert seinen Rahmen (x0, y0, x1, y1)."""
        x1, y0 = self.area[2], self.area[1]
        w, rh = 180.0, 10.0
        x0 = x1 - w
        msp = self.msp
        rows = [  # von unten: (Feld, Breite)
            [("material", 50), ("tolerance", 40), ("scale", 20), ("size", 20), ("projection", 20), ("sheet", 30)],
            [("drawn", 50), ("date", 40), ("number", 60), ("revision", 30)],
            [("owner", 50), ("title", 130)],
        ]
        heights = [rh, rh, 14.0]
        y = y0
        for row, h in zip(rows, heights):
            x = x0
            for key, cw in row:
                msp.add_lwpolyline([(x, y), (x + cw, y), (x + cw, y + h), (x, y + h)], close=True,
                                   dxfattribs={"layer": "TITLE"})
                self.text(lab[key], (x + 1.2, y + h - 1.2 - 1.8), height=1.8, layer="TITLE", _check=False)
                if key == "projection":
                    if self.projection:
                        self._projection_symbol(x + cw / 2, y + (h - 2.5) / 2)
                else:
                    val = f.get(key)
                    if val is not None and str(val) != "":
                        th = 5.0 if key == "title" else TEXT_HEIGHT
                        e = self.text(str(val), (x + 1.5, y + 1.6), height=th, layer="TITLE", _check=False)
                        self._fields.append(dict(key=key, caption=lab[key], text=str(val), entities=e if isinstance(e, list) else [e],
                                                 cell=(x, y, x + cw, y + h - 3.2)))
                x += cw
            y += h
        msp.add_lwpolyline([(x0, y0), (x1, y0), (x1, y), (x0, y)], close=True,
                           dxfattribs={"layer": "FRAME", "lineweight": THICK})
        return (x0, y0, x1, y)

    def _projection_symbol(self, cx, cy):
        """Symbol der Projektionsmethode (ISO 5456-2): Kegelstumpf und seine Stirnansicht, das kleine Ende des Kegels
        zeigt bei Methode 1 von den Kreisen weg, bei Methode 3 zu ihnen hin."""
        msp, att = self.msp, {"layer": "TITLE", "lineweight": THIN}
        r1, r2 = 1.6, 3.0
        cone_l = 6.0
        if self.projection == "first":
            kx, ky = cx - 5.0, cy
            circles = (cx + 4.5, cy)
            msp.add_lwpolyline([(kx - cone_l / 2, ky - r1), (kx + cone_l / 2, ky - r2), (kx + cone_l / 2, ky + r2),
                                (kx - cone_l / 2, ky + r1)], close=True, dxfattribs=att)
        else:
            kx, ky = cx + 5.0, cy
            circles = (cx - 4.5, cy)
            msp.add_lwpolyline([(kx - cone_l / 2, ky - r1), (kx + cone_l / 2, ky - r2), (kx + cone_l / 2, ky + r2),
                                (kx - cone_l / 2, ky + r1)], close=True, dxfattribs=att)
        msp.add_circle(circles, r2, dxfattribs=att)
        msp.add_circle(circles, r1, dxfattribs=att)
        msp.add_line((cx - 10, cy), (cx + 9, cy), dxfattribs={"layer": "CENTER"})

    # -- Geometrie aus dem Modell

    def shape(self, what):
        """The geometry of parts as one CadQuery shape (in model position), to change it before showing it:
        sh.view(sh.shape("Housing").cut(...), ...). what: part name, group, "*" or a list."""
        items = _resolve(what)
        shapes = [s for _n, s in items]
        return shapes[0] if len(shapes) == 1 else cq.Compound.makeCompound(shapes)

    def view(self, what, direction="front", at=None, scale=None, *, origin=None, up=None, hidden=None, tangent=False,
             style=None, label=None, label_at=None, breaks=None):
        """Projects parts onto the sheet with visible (and hidden) edges.

        what       part name, group ("Housing", "Housing/Screws"), "*" (all parts without references), a list of
                   them, or any CadQuery shape built here
        direction  "front", "back", "left", "right", "top", "bottom", "iso" or a vector (x, y, z) from the part to
                   the viewer
        at         point (x, y) on the sheet in mm where `origin` lands
        scale      own scale ("2:1"), default the scale of the sheet
        origin     model point placed at `at`, default the middle of the bounding box. Views of the same parts with
                   the default origin line up when they share x (or y) of `at`
        up         model direction pointing up on the sheet (default Z, for top/bottom Y)
        hidden     hidden edges dashed (default: in the six standard views, not in iso and other directions)
        tangent    thin lines where fillets meet faces (default False)
        style      None, or "phantom" for adjacent parts and extreme positions (thin, dash-double-dot)
        label      text above the view, e.g. "View X"; label_at: sheet point for the middle of the label instead
        breaks     shortened view of a long part: [(p1, p2), ...] model points, the part between them (horizontally or
                   vertically on the sheet) is left out and break lines are drawn. Dimensions across show the full length

        Returns a View: view.pt(), view.dim() ..."""
        file, line = _where()
        items = _resolve(what)
        n, x, y = _basis(direction, up)
        if hidden is None:
            hidden = isinstance(direction, str) and direction in STANDARD_VIEWS
        geo = _project(items, n, x, y, bool(hidden), bool(tangent))
        return self._add_view(geo, "view", direction, at, scale, origin, None, style, label, file, line,
                              label_at=label_at, breaks=_breaks(breaks, x, y))

    def section(self, what, direction="front", through=(0, 0, 0), at=None, scale=None, *, region=None, path=None,
                origin=None, up=None, name=None, parent=None, unhatched=(), hatch=None, hidden=False, label=True,
                label_at=None, letters_at=None, breaks=None):
        """Section view: like view(), but the material between the viewer and a plane through `through`
        (perpendicular to the viewing direction) is removed. Cut faces are hatched.

        path       stepped section or half section: model points of the cutting line in the parent view, e.g.
                   [(-60, 0, 0), (0, 0, 0), (0, 20, 0), (60, 20, 0)]. Everything on the viewer's side of the line is
                   removed, the line with thick ends and bends, arrows and letters is drawn in `parent`
        region     instead of plane or path: any solid that is removed (local break-out). With parent= also give path=
                   for the cutting line. Flat faces of the cut that face the viewer are hatched
        name       letter of the section, e.g. "A": label "A-A" above the view
        parent     view in which the cutting line is drawn (chain line, thick ends, arrows, letters)
        unhatched  parts that are not cut (screws, shafts, pins, rolling elements, ribs in ISO 128-40)
        hatch      None (45/135 degrees alternating per part, 2.5 mm), "solid" (thin walls), False, dict(angle=,
                   spacing=, pattern=) for all, or {part: one of these}
        label      True: "A-A" (plus the scale if it differs from the sheet), a text, or False
        label_at   sheet point for the middle of the label instead of above the view
        letters_at two sheet points for the letters at the ends of the cutting line instead of beside the arrows
        breaks     shortened section, as in view()

        With path= or region=, cuts seen edge-on (the steps, the middle of a half section, the border of a
        break-out) get no edge: draw a center line or a thin freehand line there yourself (ISO 128-44)."""
        file, line = _where()
        items = _resolve(what)
        n, x, y = _basis(direction, up)
        unhatched = tuple([unhatched] if isinstance(unhatched, str) else unhatched)
        for u in unhatched:
            if all(nm != u for nm, _s in items):
                raise ValueError(f"unhatched: {u!r} is not among the parts of this section")
        if parent is not None:
            _check_parent(parent, n)
            if not name:
                raise ValueError("parent= draws the cutting line with its letter: give the section a name, e.g. name=\"A\"")
        elif letters_at is not None:
            raise ValueError("letters_at= places the letters of the cutting line: it needs parent=")
        pts = None
        if path is not None:
            if parent is None:
                raise ValueError("path= is the cutting line in a view: give that view as parent= too")
            if isinstance(path, (str, bytes)) or not hasattr(path, "__iter__"):
                raise ValueError(f"path must be a list of model points, not {path!r}")
            pts = [_vec(q, "path point") for q in path]
            if len(pts) < 2:
                raise ValueError("path needs at least two points")
        elif region is not None and parent is not None:
            raise ValueError("With region= give the cutting line in the parent view as path=[point, point, ...], or "
                             "leave out parent= (a break-out needs no cutting line)")
        custom = region is not None
        if custom:
            region = registry.to_shape(region)
        elif pts is not None:
            region = _path_region(items, parent, n, pts)
        else:
            p = _vec(through, "through")
            bb = _bbox([s for _n, s in items])
            size = 4 * max(bb.DiagonalLength, 1.0)
            face = cq.Face.makePlane(size, size, basePnt=cq.Vector(*p), dir=cq.Vector(*n))
            region = cq.Solid.extrudeLinear(face, cq.Vector(*(n * size)))
        geo = _project(items, n, x, y, bool(hidden), False, region, unhatched, hatch, borders=custom or pts is not None)
        lab = None
        if label is True and name:
            sc = parse_scale(scale) if scale is not None else self.scale
            lab = f"{name}-{name}" + (f" ({fmt_scale(sc)})" if abs(sc - self.scale) > 1e-9 else "")
        elif isinstance(label, str):
            lab = label
        v = self._add_view(geo, "section", direction, at, scale, origin, None, None, lab, file, line,
                           label_at=label_at, breaks=_breaks(breaks, x, y))
        v.name = f"{name}-{name}" if name else v.name
        if parent is not None:
            self._cutting_line(parent, n, _vec(through, "through") if pts is None else None, pts, name, letters_at)
        return v

    def detail(self, parent, center, radius, at, scale, *, name=None, label=True, border=True, label_at=None,
               letter_at=None):
        """Detail view: a circle of `radius` (model mm) around the model point `center` of view `parent`, enlarged to
        `scale` (e.g. "5:1"), placed with its center at `at`. Draws the thin circle and the letter in the parent view,
        "B (5:1)" above the detail and (border=True) a thin circle around it. label_at and letter_at: sheet points for
        the middle of the label and of the letter in the parent view instead of the default places."""
        file, line = _where()
        if not isinstance(parent, View):
            raise ValueError("parent must be a view of this sheet")
        r = float(radius)
        if not r > 0:
            raise ValueError("radius must be greater than 0")
        c = _vec(center, "center")
        cu, cv = float(np.dot(c, parent._geo.x)), float(np.dot(c, parent._geo.y))
        geo = parent._geo.clip(cu, cv, r)
        sc = parse_scale(scale)
        lab = None
        if label is True and name:
            lab = f"{name} ({fmt_scale(sc)})"
        elif isinstance(label, str):
            lab = label
        if label_at is not None and not lab:
            raise ValueError("label_at= places the label: give the detail a name or a label")
        if letter_at is not None and not name:
            raise ValueError("letter_at= places the letter of the detail: give it a name")
        v = View(self, geo, "detail", name or f"detail {len(self.views) + 1}", _pt2(at, "at"), sc, c,
                 (cu, cv, r), None, file, line)
        self.views.append(v)
        if border:
            self.msp.add_circle(tuple(v.at), r * sc, dxfattribs={"layer": "THIN"})
            v.bbox = (v.at[0] - r * sc, v.at[1] - r * sc, v.at[0] + r * sc, v.at[1] + r * sc)
        if lab:
            self._view_label(v, lab, label_at)
        # Kreis und Buchstabe in der Ausgangsansicht
        px, py = parent.pt(c)
        rr = r * parent.scale
        self.msp.add_circle((px, py), rr, dxfattribs={"layer": "THIN"})
        owner = self._new_owner("detail")
        t = np.linspace(0, 2 * math.pi, 73)
        self._annotate([np.column_stack([px + rr * np.cos(t), py + rr * np.sin(t)])], owner,
                       f"the circle of detail {v.name}")
        if name:
            d = math.sqrt(0.5)
            if letter_at is None:
                pos, align = (px + (rr + 1.5) * d, py + (rr + 1.5) * d), "left"
            else:
                pos, align = _pt2(letter_at, "letter_at"), "middle"
            self.text(name, pos, height=LABEL_HEIGHT, align=align, layer="TEXT", _owner=owner,
                      _what=f"Letter \"{name}\" of detail {name}", _hint="the letter with letter_at=(x, y)")
        return v

    def _add_view(self, geo, kind, direction, at, scale, origin, clip, style, label, file, line, label_at=None, breaks=()):
        if at is None:
            raise ValueError("at=(x, y) is missing: where on the sheet (mm) the view goes")
        at = _pt2(at, "at")
        sc = parse_scale(scale, "scale") if scale is not None else self.scale
        org = _vec(origin, "origin") if origin is not None else geo.center
        if style not in (None, "phantom"):
            raise ValueError(f"style must be None or \"phantom\", not {style!r}")
        if label_at is not None and not label:
            raise ValueError("label_at= places the label: give the view a label")
        name = direction if isinstance(direction, str) else "view"
        if any(w.name == name for w in self.views):
            name = f"{name} {sum(1 for w in self.views if w.name.split(' ')[0] == name) + 1}"
        v = View(self, geo, kind, name, at, sc, org, clip,
                 "PHANTOM" if style == "phantom" else None, file, line, breaks=breaks, auto_origin=origin is None)
        self.views.append(v)
        if label:
            self._view_label(v, label, label_at)
        return v

    def _view_label(self, v, text, at=None):
        x0, _y0, x1, y1 = v.bbox
        if at is None:
            pos, align = ((x0 + x1) / 2, y1 + 5), "center"
        else:
            pos, align = _pt2(at, "label_at"), "middle"
        self.text(str(text), pos, height=LABEL_HEIGHT, align=align, layer="TEXT", _what=f"Label \"{text}\"",
                  _hint="the label with label_at=(x, y)")

    def _cutting_line(self, parent, n, through, path, name, letters_at):
        """Schnittverlauf in der Ausgangsansicht nach ISO 128-44: duenne Strichpunktlinie, dick an den Enden und an
        Knicken, Pfeile in Blickrichtung, Buchstaben neben den Pfeilen."""
        look = -np.array([float(np.dot(n, parent._geo.x)), float(np.dot(n, parent._geo.y))])
        look = look / np.linalg.norm(look)
        x0, y0, x1, y1 = parent.bbox
        if path is None:
            pn = np.array(parent._geo.n)
            d3 = np.cross(n, pn)
            d = np.array([float(np.dot(d3, parent._geo.x)), float(np.dot(d3, parent._geo.y))])
            d = d / np.linalg.norm(d)
            p = np.array(parent.pt(through))
            ts = [float(np.dot(np.array(c) - p, d)) for c in ((x0, y0), (x1, y0), (x0, y1), (x1, y1))]
            pts = [p + d * (min(ts) - 4), p + d * (max(ts) + 4)]
        else:
            pts = []
            for q in path:
                q = np.array(parent.pt(q))
                if not pts or np.linalg.norm(q - pts[-1]) > 1e-6:
                    pts.append(q)
            if len(pts) < 2:
                raise ValueError("The points of path coincide in the parent view")
            # Enden, die in der Ansicht liegen, bis 4 mm darueber hinaus verlaengern
            box = (x0 - 4, y0 - 4, x1 + 4, y1 + 4)
            for i, j in ((0, 1), (-1, -2)):
                dd = (pts[i] - pts[j]) / np.linalg.norm(pts[i] - pts[j])
                pts[i] = pts[i] + dd * _exit(pts[i], dd, box)
        pts = np.array(pts)
        owner = self._new_owner("cut")
        msp = self.msp
        thick = {"layer": "CUT", "linetype": "Continuous", "lineweight": 70}
        msp.add_lwpolyline([tuple(q) for q in pts], dxfattribs={"layer": "CUT"})
        lines = [pts]
        # Dick an Knicken, je 3 mm in beide Richtungen
        for i in range(1, len(pts) - 1):
            a, b = pts[i - 1] - pts[i], pts[i + 1] - pts[i]
            a = pts[i] + a / np.linalg.norm(a) * min(3.0, float(np.linalg.norm(a)))
            b = pts[i] + b / np.linalg.norm(b) * min(3.0, float(np.linalg.norm(b)))
            msp.add_lwpolyline([tuple(a), tuple(pts[i]), tuple(b)], dxfattribs=thick)
        ends = []
        for end, nxt in ((pts[0], pts[1]), (pts[-1], pts[-2])):
            out = (end - nxt) / np.linalg.norm(end - nxt)
            inner = end - out * min(6.0, float(np.linalg.norm(end - nxt)))
            msp.add_line(tuple(end), tuple(inner), dxfattribs=thick)
            tail = end - out * 2.5
            tip = tail + look * 7
            side = np.array([-look[1], look[0]])
            msp.add_line(tuple(tail), tuple(tip - look * 3), dxfattribs={"layer": "THIN"})
            msp.add_solid([tuple(tip), tuple(tip - look * 3 + side * 0.9), tuple(tip - look * 3 - side * 0.9)],
                          dxfattribs={"layer": "THIN"})
            lines.append(np.array([tail, tip]))
            ends.append(tail + look * 4 + out * 4)
        if letters_at is not None:
            if isinstance(letters_at, (str, bytes)) or not hasattr(letters_at, "__iter__") or len(list(letters_at)) != 2:
                raise ValueError(f"letters_at must be two sheet points [(x, y), (x, y)], not {letters_at!r}")
            given = [_pt2(q, "letters_at") for q in letters_at]
            # Jeder Buchstabe an das naehere Ende, die Reihenfolge ist egal
            straight = np.linalg.norm(given[0] - ends[0]) + np.linalg.norm(given[1] - ends[1])
            crossed = np.linalg.norm(given[0] - ends[1]) + np.linalg.norm(given[1] - ends[0])
            ends = given if straight <= crossed else given[::-1]
        self._annotate(lines, owner, f"the cutting line of section {name}-{name}")
        for pos in ends:
            self.text(name, tuple(pos), height=LABEL_HEIGHT, align="middle", layer="TEXT", _owner=owner,
                      _what=f"Letter \"{name}\" of the cutting line", _hint="the letters with letters_at=[(x, y), (x, y)]")

    def _new_owner(self, kind):
        """Kennung einer Beschriftung: ihre eigenen Texte duerfen auf ihren Linien liegen."""
        self._owners += 1
        return (kind, self._owners)

    def _annotate(self, lines, owner, desc):
        """Linien der Beschriftung fuer die Pruefung merken: Texte sollen nicht darauf liegen."""
        lines = [np.asarray(ln, dtype=float) for ln in lines if len(ln) >= 2]
        if lines:
            file, line = _where()
            self._annot.append(dict(a=np.concatenate([ln[:-1] for ln in lines]), b=np.concatenate([ln[1:] for ln in lines]),
                                    owner=owner, desc=desc, file=file, line=line))

    # -- Text, Hinweise, Tabellen

    def text(self, text, at, height=TEXT_HEIGHT, align="left", rotation=0, layer="TEXT", _check=True, _owner=None,
             _what=None, _hint=None):
        """Text at the sheet point `at` (mm). align: "left", "center", "right" (on the baseline) or "middle" (centered
        both ways). Several lines with "\\n": the first line at `at`, the next ones below it ("middle": the whole block
        centered), spaces at the start of a line indent it. Returns the ezdxf entity, a list of them for several
        lines."""
        if not isinstance(text, str):
            text = str(text)
        at = _pt2(at, "at")
        h = float(height)
        if not h > 0:
            raise ValueError("height must be greater than 0")
        aligns = {"left": TextEntityAlignment.LEFT, "center": TextEntityAlignment.CENTER,
                  "right": TextEntityAlignment.RIGHT, "middle": TextEntityAlignment.MIDDLE_CENTER}
        if align not in aligns:
            raise ValueError(f"align must be one of {', '.join(aligns)}, not {align!r}")
        att = {"layer": _layer(layer), "style": "ISO"}
        rot = float(rotation)
        # Eine TEXT-Zeile je Zeile statt MTEXT: MTEXT verschluckt Einrueckungen, und ezdxf misst es mit Umbruechen,
        # die beim Zeichnen nicht entstehen
        lines = text.expandtabs(4).split("\n")
        down = np.array([math.sin(math.radians(rot)), -math.cos(math.radians(rot))]) * LINE_SPACING * h
        first = at - down * (len(lines) - 1) / 2 if align == "middle" else at
        f, ln = _where() if _check else (None, None)
        out = []
        for i, t in enumerate(lines):
            if not t.strip():
                continue
            e = self.msp.add_text(t, height=h, rotation=rot, dxfattribs=att)
            e.set_placement(tuple(first + down * i), align=aligns[align])
            out.append(e)
            if _check:
                self._labels.append(dict(entity=e, text=t, height=h, file=f, line=ln, owner=_owner,
                                         what=_what or f"Text \"{_short(t)}\"", hint=_hint))
        return out if len(lines) > 1 else (out[0] if out else None)

    def leader(self, point, text, at, end="arrow", height=TEXT_HEIGHT):
        """Leader from the sheet point `point` to a text at `at` (both in mm on the sheet). end: "arrow", "dot" or
        "none". View.leader() takes a model point instead. Several lines stack above the short horizontal line."""
        p, a = _pt2(point, "point"), _pt2(at, "at")
        if end not in ("arrow", "dot", "none"):
            raise ValueError(f"end must be \"arrow\", \"dot\" or \"none\", not {end!r}")
        if not isinstance(text, str):
            text = str(text)
        msp = self.msp
        owner = self._new_owner("leader")
        left = a[0] < p[0]
        up = (text.count("\n")) * LINE_SPACING * float(height)  # die letzte Zeile steht auf der Linie
        e = self.text(text, (a[0] - 1 if left else a[0] + 1, a[1] + 1 + up), height=height,
                      align="right" if left else "left", _owner=owner)
        width = 0.0
        for x in (e if isinstance(e, list) else [e] if e is not None else []):
            try:
                from ezdxf.tools.text_size import text_size
                width = max(width, text_size(x).width)
            except Exception:  # Schrift nicht messbar: ungefaehre Breite
                width = max(width, 0.6 * float(height) * len(x.dxf.text))
        shoulder = a + np.array([-(width + 2) if left else width + 2, 0])
        msp.add_line(tuple(p), tuple(a), dxfattribs={"layer": "THIN"})
        msp.add_line(tuple(a), tuple(shoulder), dxfattribs={"layer": "THIN"})
        self._annotate([np.array([p, a, shoulder])], owner, f"the leader of line {_where()[1]}")
        d = a - p
        if np.linalg.norm(d) > 1e-9 and end == "arrow":
            d = d / np.linalg.norm(d)
            side = np.array([-d[1], d[0]])
            msp.add_solid([tuple(p), tuple(p + d * 3 + side * 0.9), tuple(p + d * 3 - side * 0.9)], dxfattribs={"layer": "THIN"})
        elif end == "dot":
            h = msp.add_hatch(color=256, dxfattribs={"layer": "THIN"})
            h.paths.add_edge_path().add_arc(tuple(p), 0.6, 0, 360)
            h.set_solid_fill(color=256)
        return e

    def table(self, rows, at, widths, row_height=7.0, text_height=TEXT_HEIGHT):
        """Table, e.g. a parts list: rows is a list of rows (lists of texts), at the top left corner on the sheet,
        widths the column widths in mm. Returns the bounding box (x0, y0, x1, y1). Nothing else may lie on it, and its
        texts must fit their cells (the check reports both)."""
        x0, y_top = _pt2(at, "at")
        widths = [float(w) for w in widths]
        owner = self._new_owner("table")
        file, line = _where()
        cells = []
        y = y_top
        for row in rows:
            if len(row) > len(widths):
                raise ValueError(f"The row {row!r} has more cells than widths")
            x = x0
            for cell, w in zip(row, widths):
                self.msp.add_lwpolyline([(x, y - row_height), (x + w, y - row_height), (x + w, y), (x, y)], close=True,
                                        dxfattribs={"layer": "TITLE"})
                if cell is not None and str(cell) != "":
                    e = self.text(str(cell), (x + 1.5, y - row_height + (row_height - text_height) / 2),
                                  height=text_height, _owner=owner)
                    cells.append(dict(text=str(cell), entities=e if isinstance(e, list) else [e] if e is not None else [],
                                      cell=(x, y - row_height, x + w, y)))
                x += w
            y -= row_height
        box = (x0, y, x0 + sum(widths), y_top)
        self._tables.append(dict(box=box, owner=owner, cells=cells, file=file, line=line))
        return box
