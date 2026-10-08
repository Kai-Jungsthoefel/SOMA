"""Standard parts: screws, nuts, washers and heat-set inserts, simplified without threads, with matching holes.

    from soma import add_part
    from soma.fasteners import Screw

    s = Screw("ISO 4762", "M3x10", at=(20, 15, 8))   # the head rests at z = 8, the shank points down
    lid = lid.cut(s.clearance_hole())                 # clearance hole, with a counterbore for a sunk head
    add_part("Screw 1", s)                            # role "hardware" (purchased part), not in export --all

Placement, the same for all parts: `at` is the point on the axis where the part rests. `direction` points from there
into the material (default "-Z": from top to bottom). A screw rests with the underside of its head, a nut or washer
with one of its faces. Countersunk screws, set screws and heat-set inserts end flush with their top at `at`.
`sunk=True` sinks the head, nut or washer flush (its outer side is then at `at`), `sunk=0.5` 0.5 mm deeper.
`on=part` finds the seat itself: the line through `at` in direction `direction` hits the part, the first hit counts
(with "-Z" only x and y of `at` matter). `rotate()`, `translate()` and `moved()` work as on CadQuery shapes and
return a moved copy, for example so that a screw moves with its part into another position.

Dimensions come from the tables of bd_warehouse (Apache 2.0, see data/fasteners/QUELLE.md), partly nominal, partly
maximum values. Threads are not modelled: the shank and the bore of the nut have the nominal diameter.
"""
import copy
import csv
import functools
import math
import numbers
import re
from pathlib import Path

import cadquery as cq
from OCP.BRepIntCurveSurface import BRepIntCurveSurface_Inter
from OCP.gp import gp_Ax1, gp_Dir, gp_Lin, gp_Pnt, gp_Trsf

__all__ = ["Screw", "Nut", "Washer", "HeatSetInsert", "lengths", "pick_length", "standards"]

_DATA = Path(__file__).parent / "data" / "fasteners"
INCH = 25.4
# Bohrwerkzeuge ragen so weit ueber die Oberflaeche hinaus: Deckungsgleiche Flaechen machen cut() unzuverlaessig
MARGIN = 1.0
# Durchgangsloecher nach ISO 273, wie im Skill "Toleranzen" benannt, mit den Spalten der Tabelle
FITS = {"fine": "Close", "medium": "Normal", "coarse": "Loose"}
STEEL = (0.45, 0.46, 0.49)
BRASS = (0.80, 0.63, 0.32)
COS30 = math.cos(math.radians(30))

# Regelgewinde nach ISO 261. Manche Tabellen fuehren dasselbe Mass mit mehreren Steigungen, ohne Gewinde zaehlt nur
# der Durchmesser, die Steigung waehlt bei Kernloechern die richtige Zeile.
COARSE_PITCH = {
    1: 0.25, 1.2: 0.25, 1.4: 0.3, 1.6: 0.35, 1.8: 0.35, 2: 0.4, 2.5: 0.45, 3: 0.5, 3.5: 0.6, 4: 0.7, 5: 0.8, 6: 1.0,
    7: 1.0, 8: 1.25, 10: 1.5, 12: 1.75, 14: 2.0, 16: 2.0, 18: 2.5, 20: 2.5, 22: 2.5, 24: 3.0, 27: 3.0, 30: 3.5, 33: 3.5,
    36: 4.0, 39: 4.0, 42: 4.5, 45: 4.5, 48: 5.0, 52: 5.0, 56: 5.5, 60: 5.5, 64: 6.0,
}

# Kopf: socket (Zylinderkopf), button (Linsenkopf), countersunk (Senkkopf), hex (Sechskant), set (Gewindestift)
SCREWS = {
    "iso4762": dict(name="ISO 4762", title="Socket head cap screw", table="socket_head_cap_parameters.csv",
                    col="iso4762", head="socket", cols=("dk", "k", "s", "t")),
    "iso7380": dict(name="ISO 7380", title="Button head socket screw", table="button_head_parameters.csv",
                    col="iso7380_1", head="button", cols=("dk", "dl", "k", "rf", "s", "t")),
    "iso10642": dict(name="ISO 10642", title="Countersunk socket screw", table="countersunk_head_parameters.csv",
                     col="iso10642", head="countersunk", cols=("a", "dk", "k", "s", "t")),
    "iso4017": dict(name="ISO 4017", title="Hex head screw, fully threaded", table="hex_head_parameters.csv",
                    col="iso4017", head="hex", cols=("k", "s")),
    "iso4014": dict(name="ISO 4014", title="Hex head bolt with shank", table="hex_head_parameters.csv",
                    col="iso4014", head="hex", cols=("k", "s")),
    "din931": dict(name="DIN 931", title="Hex head bolt with shank", table="hex_head_parameters.csv",
                   col="din931", head="hex", cols=("k", "s")),
    "iso4026": dict(name="ISO 4026", title="Socket set screw with flat point", table="setscrew_parameters.csv",
                    col="iso4026", head="set", cols=("s", "t")),
}
NUTS = {
    "iso4032": dict(name="ISO 4032", title="Hex nut", table="hex_nut_parameters.csv", col="iso4032", shape="hex"),
    "iso4033": dict(name="ISO 4033", title="Hex nut, high", table="hex_nut_parameters.csv", col="iso4033", shape="hex"),
    "iso4035": dict(name="ISO 4035", title="Hex nut, thin", table="hex_nut_parameters.csv", col="iso4035", shape="hex"),
    "din557": dict(name="DIN 557", title="Square nut", table="square_nut_parameters.csv", col="din557", shape="square"),
}
WASHERS = {
    "iso7089": dict(name="ISO 7089", title="Washer", table="plain_washer_parameters.csv", col="iso7089"),
    "iso7091": dict(name="ISO 7091", title="Washer, coarse", table="plain_washer_parameters.csv", col="iso7091"),
    "iso7093": dict(name="ISO 7093", title="Washer, large", table="plain_washer_parameters.csv", col="iso7093"),
}
INSERT_BRANDS = {"ruthex": "ruthex", "cnckitchen": "CNCKitchen", "mcmaster": "McMaster-Carr", "mcmastercarr": "McMaster-Carr",
                 "hilitchi": "Hilitchi", "aesamzhihui": "AE-SamZhihui"}
ALIASES = {"iso73801": "iso7380"}
# Alte DIN-Bezeichnungen: melden statt still umdeuten, weil manche Masse abweichen
HINTS = {
    "din912": "ISO 4762", "din7380": "ISO 7380", "din7991": "ISO 10642 (head height differs slightly)",
    "din933": "ISO 4017 (M10, M12, M14 and M22 have a different width across flats than DIN 933)", "din913": "ISO 4026 (different point)",
    "din916": "ISO 4026 (different point)", "din934": "ISO 4032 (M10, M12, M14 and M22 have a different width across flats than DIN 934)",
    "din439": "ISO 4035", "din125": "ISO 7089", "din9021": "ISO 7093",
}


# --- Tabellen ----------------------------------------------------------------------------------------------------------

@functools.cache
def _table(name):
    """CSV als Liste von (Schluessel, {Spalte: Wert}). Kopfzeilen haben teils Leerzeichen am Rand, die fallen weg."""
    with open(_DATA / name, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.reader(f))
    head = [h.strip() for h in rows[0]]
    return [(r[0].strip(), {h: v.strip() for h, v in zip(head[1:], r[1:])}) for r in rows[1:] if r and r[0].strip()]


_KEY = re.compile(r"^M(\d+(?:\.\d+)?)(?:-(\d+(?:\.\d+)?))?(?:-(.*))?$")


def _key(key):
    """"M3-0.5" -> (3.0, 0.5, ""), "M3-0.5-5.7" -> (3.0, 0.5, "5.7"), "M3" -> (3.0, None, ""). Zoll-Zeilen: None."""
    m = _KEY.match(key)
    if not m:
        return None, None, ""
    return float(m.group(1)), float(m.group(2)) if m.group(2) else None, m.group(3) or ""


def _num(text):
    return float(text.replace(",", "."))


def _rows(table, col, cols):
    """Alle metrischen Zeilen mit Werten fuer jede Spalte in `cols`: [(d, steigung, rest, {spalte: zahl})]."""
    out = []
    for key, row in _table(table):
        d, pitch, rest = _key(key)
        if d is None:
            continue
        vals = {c: row.get(f"{col}:{c}", "") if col else row.get(c, "") for c in cols}
        if all(vals.values()):
            try:
                out.append((d, pitch, rest, {c: v if c in ("drill", "part") else _num(v) for c, v in vals.items()}))
            except ValueError:
                continue
    return out


def _lookup(table, col, cols, d, what):
    """Werte fuer M<d>. Bevorzugt die Zeile mit Regelgewinde, sonst die erste Zeile mit Werten."""
    rows = [r for r in _rows(table, col, cols) if abs(r[0] - d) < 1e-9]
    if not rows:
        sizes = sorted({r[0] for r in _rows(table, col, cols)})
        raise ValueError(f"{what}: size M{_fmt(d)} is not in the table. Available: "
                         + ", ".join(f"M{_fmt(x)}" for x in sizes))
    coarse = [r for r in rows if r[1] is None or abs(r[1] - COARSE_PITCH.get(d, -1)) < 1e-9]
    return (coarse or rows)[0][3]


def _fmt(x):
    """3.0 -> "3", 2.5 -> "2.5": Zahlen so, wie man sie in Bezeichnungen schreibt."""
    return f"{x:g}"


def _norm_standard(standard, table, kind):
    if not isinstance(standard, str) or not standard.strip():
        raise ValueError(f"{kind}: give the standard as text, e.g. {next(iter(table.values()))['name']!r}")
    key = re.sub(r"[\s_.-]", "", standard.lower())
    key = ALIASES.get(key, key)
    if key in table:
        return key
    known = ", ".join(v["name"] for v in table.values())
    if key in HINTS:
        raise ValueError(f"{kind}: {standard!r} is now called {HINTS[key]}. Available: {known}")
    raise ValueError(f"{kind}: there is no standard {standard!r} here. Available: {known}")


_SIZE = re.compile(r"^\s*M\s*(\d+(?:[.,]\d+)?)\s*(?:[xX×*]\s*(\d+(?:[.,]\d+)?)\s*(?:mm)?)?\s*$", re.IGNORECASE)


def _parse_size(size, length, kind):
    """"M3" oder "M3x10" (auch "M3 x 10", "M3×10") -> (3.0, Laenge oder None)."""
    if not isinstance(size, str):
        raise ValueError(f"{kind}: give the size as text, e.g. \"M3\" or \"M3x10\", not {size!r}")
    m = _SIZE.match(size)
    if not m:
        raise ValueError(f"{kind}: cannot read the size {size!r}. Expected e.g. \"M3\" or \"M3x10\"")
    d = _num(m.group(1))
    if m.group(2):
        from_size = _num(m.group(2))
        if length is not None and abs(float(length) - from_size) > 1e-9:
            raise ValueError(f"{kind}: length given twice with different values ({size!r} and length={length})")
        length = from_size
    return d, (float(length) if length is not None else None)


def _split_designation(standard, size):
    """"ISO 4762 M3x10" als ein Text -> ("ISO 4762", "M3x10")."""
    if size is None and isinstance(standard, str):
        m = re.match(r"^\s*(.*?)\s+(M\s*\d.*)$", standard, re.IGNORECASE)
        if m:
            return m.group(1), m.group(2)
    return standard, size


@functools.cache
def _nominal_lengths():
    out = {}
    with open(_DATA / "nominal_screw_lengths.csv", encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f):
            if row["Unit"].strip() == "mm":
                out[row["Screw_Type"].strip()] = [_num(x) for x in row["Nominal_Sizes"].split(",") if x.strip()]
    return out


def _length_range(spec, d):
    """Kleinste und groesste Laenge der Tabelle fuer diese Groesse."""
    vals = _lookup(spec["table"], spec["col"], ("short", "long"), d, spec["name"])
    return vals["short"], vals["long"]


def lengths(standard, size):
    """Standard lengths of a screw in mm, e.g. lengths("ISO 4762", "M3") -> [5, 6, 8, 10, 12, 16, 20, 25, 30]."""
    key = _norm_standard(standard, SCREWS, "Screw")
    spec = SCREWS[key]
    d, _ = _parse_size(size, None, spec["name"])
    short, long_ = _length_range(spec, d)
    series = _nominal_lengths().get(spec["col"], [])
    return [x for x in series if short - 1e-9 <= x <= long_ + 1e-9]


def pick_length(standard, size, min_length, max_length=None):
    """Shortest standard length that is at least `min_length` (and at most `max_length`, if given)."""
    options = lengths(standard, size)
    fitting = [x for x in options if x >= min_length - 1e-9 and (max_length is None or x <= max_length + 1e-9)]
    if not fitting:
        span = f"{_fmt(min_length)} to {_fmt(max_length)}" if max_length is not None else f"of at least {_fmt(min_length)}"
        raise ValueError(f"{standard} {size}: no standard length {span} mm. Standard lengths: "
                         + ", ".join(_fmt(x) for x in options))
    return fitting[0]


def standards():
    """What is available: {"screws": {"ISO 4762": "Socket head cap screw", ...}, "nuts": ..., "washers": ...,
    "heat_set_inserts": [brands]}."""
    return {
        "screws": {v["name"]: v["title"] for v in SCREWS.values()},
        "nuts": {v["name"]: v["title"] for v in NUTS.values()},
        "washers": {v["name"]: v["title"] for v in WASHERS.values()},
        "heat_set_inserts": sorted(set(INSERT_BRANDS.values())),
    }


def _clearance(d, fit):
    if fit not in FITS:
        raise ValueError(f"fit must be one of {tuple(FITS)} (ISO 273 fine, medium, coarse), not {fit!r}")
    rows = [r for r in _rows("clearance_hole_sizes.csv", None, (FITS[fit],)) if abs(r[0] - d) < 1e-9]
    if not rows:
        raise ValueError(f"The table has no clearance hole for M{_fmt(d)}")
    return rows[0][3][FITS[fit]]


def _tap_drill(d):
    return _lookup("tap_hole_sizes.csv", None, ("Soft",), d, "Tap drill hole")["Soft"]


@functools.cache
def _drills():
    with open(_DATA / "drill_sizes.csv", encoding="utf-8-sig", newline="") as f:
        return {r[0].strip(): _num(r[1].strip()) * INCH for r in list(csv.reader(f))[1:] if len(r) > 1}


def _drill_mm(code):
    """Bohrergroesse der Tabelle in mm: Nummern ("#21") und Buchstaben ("F") sind Zollbohrer. Anderes (die Tabelle
    nennt bei M10 "M14", groesser als der Einsatz) gilt als unbekannt."""
    return _drills().get(code.strip())


# --- Lage --------------------------------------------------------------------------------------------------------------

def _vec(v, what):
    if isinstance(v, cq.Vector):
        return v
    if isinstance(v, cq.Vertex):
        return cq.Vector(*v.toTuple())
    if isinstance(v, (tuple, list)) and len(v) == 3 and all(isinstance(x, numbers.Real) for x in v):
        return cq.Vector(*map(float, v))
    raise ValueError(f"{what}: expected (x, y, z), not {v!r}")


def _direction(spec):
    if isinstance(spec, str):
        m = re.match(r"^\s*([+-]?)\s*([xyz])\s*$", spec, re.IGNORECASE)
        if not m:
            raise ValueError(f"direction: expected \"-Z\", \"+X\" etc. or (x, y, z), not {spec!r}")
        v = cq.Vector(*[(-1.0 if m.group(1) == "-" else 1.0) if a == m.group(2).lower() else 0.0 for a in "xyz"])
    else:
        v = _vec(spec, "direction")
    if v.Length < 1e-9:
        raise ValueError("direction must not be (0, 0, 0)")
    return v.normalized()


def _at(at, on):
    """Punkt und (falls ableitbar) Richtung aus `at`: Tupel, Vector, Vertex, Location oder Workplane."""
    if at is None:
        raise ValueError("at is missing: the point where the part rests, e.g. at=(10, 5, 8)")
    if isinstance(at, cq.Location):
        pos = cq.Vector(*at.toTuple()[0])
        z = gp_Dir(0, 0, 1).Transformed(at.wrapped.Transformation())
        return pos, -cq.Vector(z.X(), z.Y(), z.Z())
    if isinstance(at, cq.Workplane):
        objs = at.objects
        if not objs:  # Workplane auf einer Flaeche: Ursprung der Ebene, ins Material gegen die Normale
            return at.plane.origin, -at.plane.zDir
        if len(objs) == 1:
            return _at(objs[0], on)[0], -at.plane.zDir
        raise ValueError(f"at: the Workplane holds {len(objs)} points. Pass one point per part (loop over .vals())")
    if isinstance(at, (tuple, list)) and len(at) == 2:
        if on is None:
            raise ValueError("at needs x, y and z. Only (x, y) works with on=part, then the seat is searched for")
        return cq.Vector(float(at[0]), float(at[1]), 0.0), None
    return _vec(at, "at"), None


def _shape_of(obj, what="on"):
    if hasattr(obj, "__soma_shape__"):
        return obj.__soma_shape__()
    if isinstance(obj, cq.Workplane):
        vals = [v for v in obj.vals() if isinstance(v, cq.Shape)]
        if not vals:
            raise ValueError(f"{what}: the Workplane contains no geometry")
        return vals[0] if len(vals) == 1 else cq.Compound.makeCompound(vals)
    if isinstance(obj, cq.Assembly):
        return obj.toCompound()
    if isinstance(obj, cq.Shape):
        return obj
    raise ValueError(f"{what}: expected a part (cq.Workplane or cq.Shape), not {type(obj).__name__}")


def _surface_hit(on, point, d):
    """Erster Schnittpunkt der Geraden durch `point` in Richtung `d` mit `on`, von aussen her gesehen."""
    shape = _shape_of(on)
    inter = BRepIntCurveSurface_Inter()
    inter.Init(shape.wrapped, gp_Lin(gp_Pnt(*point.toTuple()), gp_Dir(*d.toTuple())), 1e-7)
    best = None
    while inter.More():
        if best is None or inter.W() < best[0]:
            p = inter.Pnt()
            best = (inter.W(), cq.Vector(p.X(), p.Y(), p.Z()))
        inter.Next()
    if best is None:
        raise ValueError(f"on: the line through {_pt(point)} in direction {_pt(d)} does not hit the part. "
                         "Check at and direction")
    return best[1]


def _pt(v):
    return "(" + ", ".join(_fmt(round(c, 4)) for c in v.toTuple()) + ")"


def _sink(sunk, kind):
    """None: nicht versenkt, sonst die Tiefe unter `at` (0 bei sunk=True)."""
    if sunk is False or sunk is None:
        return None
    if sunk is True:
        return 0.0
    if isinstance(sunk, numbers.Real) and sunk >= 0:
        return float(sunk)
    raise ValueError(f"{kind}: sunk is True, False or a depth in mm (>= 0), not {sunk!r}")


class _Part:
    """Gemeinsame Lage. Lokal: Auflage bei z = 0, +Z zeigt aus dem Material, die Oberflaeche (`at`) liegt bei z = _zs."""

    role = "hardware"
    color = STEEL

    def _place(self, at, direction, on, angle, zs):
        point, derived = _at(at, on)
        d = _direction(direction) if direction is not None else (derived.normalized() if derived is not None else _direction("-Z"))
        if on is not None:
            point = _surface_hit(on, point, d)
        if not isinstance(angle, numbers.Real):
            raise ValueError(f"angle: rotation about the axis in degrees, not {angle!r}")
        ref = cq.Vector(1, 0, 0) if abs(d.x) < 0.99 else cq.Vector(0, 1, 0)
        x = (ref - d * ref.dot(d)).normalized()
        n = -d  # lokale Z-Achse
        a = math.radians(angle)
        x = x * math.cos(a) + n.cross(x) * math.sin(a)
        self._dir, self._zs = d, zs
        self._surface = point
        self._plane = cq.Plane(origin=point + d * zs, xDir=x, normal=n)
        self._loc = cq.Location(self._plane)

    def _world(self, local):
        return local.moved(self._loc)

    def _local_point(self, z):
        return (self._plane.origin + self._plane.zDir * z).toTuple()

    @property
    def direction(self):
        """Unit vector from the seat into the material."""
        return self._dir.toTuple()

    @property
    def seat(self):
        """Point on the axis at the seat (underside of the head, face of the nut)."""
        return self._local_point(0.0)

    @property
    def surface(self):
        """Point on the axis on the surface the part sits on (`at`, with on= the point found)."""
        return self._surface.toTuple()

    def point(self, distance):
        """Point on the axis, `distance` mm from the seat into the material (e.g. for the nut at the other end)."""
        return self._local_point(-float(distance))

    @property
    def shape(self):
        """The part as a cq.Solid in its position."""
        return self._world(self._local())

    def __soma_shape__(self):
        return self.shape

    # Lage aendern wie bei CadQuery-Formen: liefert eine Kopie, Bezeichnung, Masse und Bohrungen bleiben. So wandert eine
    # Schraube mit ihrem Teil (etwa in eine andere Stellung), ohne sie dort neu anzulegen.

    def moved(self, loc):
        """Copy moved by loc (cq.Location), like cq.Shape.moved()."""
        if not isinstance(loc, cq.Location):
            raise ValueError(f"moved() expects a cq.Location, not {loc!r}")
        t = loc.wrapped.Transformation()

        def pnt(v):
            p = gp_Pnt(*v.toTuple()).Transformed(t)
            return cq.Vector(p.X(), p.Y(), p.Z())

        def dirn(v):
            d = gp_Dir(*v.toTuple()).Transformed(t)
            return cq.Vector(d.X(), d.Y(), d.Z())

        new = copy.copy(self)
        new._plane = cq.Plane(origin=pnt(self._plane.origin), xDir=dirn(self._plane.xDir), normal=dirn(self._plane.zDir))
        new._loc = cq.Location(new._plane)
        new._dir, new._surface = dirn(self._dir), pnt(self._surface)
        return new

    def translate(self, vector):
        """Copy shifted by vector (x, y, z), like cq.Shape.translate()."""
        return self.moved(cq.Location(_vec(vector, "translate")))

    def rotate(self, startVector, endVector, angleDegrees):
        """Copy rotated about the axis from startVector to endVector (degrees), like cq.Shape.rotate()."""
        p1, p2 = _vec(startVector, "rotate: startVector"), _vec(endVector, "rotate: endVector")
        if (p2 - p1).Length < 1e-9:
            raise ValueError("rotate: startVector and endVector must differ (they define the axis)")
        if not isinstance(angleDegrees, numbers.Real):
            raise ValueError(f"rotate: angle in degrees, not {angleDegrees!r}")
        t = gp_Trsf()
        t.SetRotation(gp_Ax1(gp_Pnt(*p1.toTuple()), gp_Dir(*(p2 - p1).toTuple())), math.radians(angleDegrees))
        return self.moved(cq.Location(t))

    def __repr__(self):
        return f"<{self.designation} at {_pt(cq.Vector(*self.seat))}, direction {_pt(self._dir)}>"


def _cyl(d, z0, z1):
    """Zylinder entlang Z von z0 bis z1."""
    lo, hi = min(z0, z1), max(z0, z1)
    return cq.Solid.makeCylinder(d / 2, hi - lo, cq.Vector(0, 0, lo), cq.Vector(0, 0, 1))


def _hex_prism(s, z0, z1):
    """Sechskant mit Schluesselweite s, zwei Flaechen parallel zur lokalen X-Achse."""
    return cq.Workplane().workplane(offset=z0).polygon(6, s / COS30).extrude(z1 - z0).val()


def _chamfered_hex(s, h, both):
    """Sechskant mit 30-Grad-Fase an den Ecken (oben, bei Muttern auch unten), wie bei Kopf und Mutter ueblich."""
    e = s / COS30
    c = (e - s) / 2 * math.tan(math.radians(30))
    pts = [(0, 0), (s / 2, 0), (e / 2, c), (e / 2, h - c), (s / 2, h), (0, h)] if both else \
        [(0, 0), (e / 2, 0), (e / 2, h - c), (s / 2, h), (0, h)]
    body = cq.Workplane("XZ").polyline(pts).close().revolve(360, (0, 0, 0), (0, 1, 0)).val()
    return _hex_prism(s, 0, h).intersect(body)


def _socket(solid, s, t, z_top):
    """Innensechskant mit Schluesselweite s und Tiefe t von der Oberseite z_top aus."""
    return solid.cut(_hex_prism(s, z_top - t, z_top + 0.01))


def _one(shape):
    """Boolesche Operationen liefern teils einen Compound mit einem Koerper: dann den Koerper selbst."""
    shape = shape.clean()
    solids = shape.Solids()
    return solids[0] if len(solids) == 1 else shape


def _arc_mid(p1, p2, r):
    """Mittelpunkt des Bogens mit Radius r von p1 nach p2, nach aussen gewoelbt (Linsenkopf)."""
    (x1, z1), (x2, z2) = p1, p2
    vx, vz = x2 - x1, z2 - z1
    c = math.hypot(vx, vz)
    h = math.sqrt(max(r * r - c * c / 4, 0.0))
    nx, nz = -vz / c, vx / c  # Normale zur Achse hin und nach unten
    if nx > 0:
        nx, nz = -nx, -nz
    mx, mz = (x1 + x2) / 2, (z1 + z2) / 2
    return mx - (r - h) * nx, mz - (r - h) * nz


# --- Schrauben ---------------------------------------------------------------------------------------------------------

@functools.cache
def _screw_local(head, d, length, pitch, dims):
    p = dict(dims)
    tip = min(0.6 * pitch, 0.2 * d)
    if head == "set":  # ganz im Material: Oberseite bei z = 0, Kegelstumpf an beiden Enden
        body = cq.Workplane().circle(d / 2).extrude(-length).faces("<Z or >Z").chamfer(tip).val()
        return _one(_socket(body, p["s"], p["t"], 0.0))
    shank = cq.Workplane().circle(d / 2).extrude(-length).faces("<Z").chamfer(tip).val()
    if head == "socket":
        cap = cq.Workplane().circle(p["dk"] / 2).extrude(p["k"]).faces(">Z").chamfer(0.06 * p["dk"]).val()
        cap = _socket(cap, p["s"], p["t"], p["k"])
    elif head == "button":
        mid = _arc_mid((p["dk"] / 2, 0), (p["dl"] / 2, p["k"]), p["rf"])
        cap = (cq.Workplane("XZ").moveTo(0, 0).lineTo(p["dk"] / 2, 0).threePointArc(mid, (p["dl"] / 2, p["k"]))
               .lineTo(0, p["k"]).close().revolve(360, (0, 0, 0), (0, 1, 0)).val())
        cap = _socket(cap, p["s"], p["t"], p["k"])
    elif head == "countersunk":  # Kegel unter der Oberseite, die Laenge zaehlt ab der Oberseite
        hc = (p["dk"] - d) / 2 / math.tan(math.radians(p["a"] / 2))
        cap = cq.Solid.makeCone(d / 2, p["dk"] / 2, hc, cq.Vector(0, 0, -hc), cq.Vector(0, 0, 1))
        cap = _socket(cap, p["s"], p["t"], 0.0)
    elif head == "hex":
        cap = _chamfered_hex(p["s"], p["k"], both=False)
    else:
        raise ValueError(f"Unknown head shape {head!r}")
    return _one(cap.fuse(shank))


class Screw(_Part):
    """Screw without thread. Screw("ISO 4762", "M3x10", at=(x, y, z)) or Screw("ISO 4762", "M3", 10, at=...).

    standard      "ISO 4762" (socket head), "ISO 7380" (button head), "ISO 10642" (countersunk), "ISO 4017", "ISO 4014",
                  "DIN 931" (hex head), "ISO 4026" (set screw)
    at            seat of the underside of the head (countersunk screw, set screw: the top), (x, y, z) or cq.Location
    direction     from the seat into the material, default "-Z"
    on            part the screw sits on: the seat is searched for along `direction`
    sunk          True: head flush in a counterbore, 0.5: 0.5 mm deeper. Countersunk screws always sit flush
    angle         rotation about the axis in degrees (orientation of the hex)
    check_length  False allows lengths that are not standard lengths
    """

    def __init__(self, standard, size=None, length=None, *, at=None, direction=None, on=None, sunk=False, angle=0.0,
                 check_length=True):
        standard, size = _split_designation(standard, size)
        self.standard_key = _norm_standard(standard, SCREWS, "Screw")
        spec = SCREWS[self.standard_key]
        self.standard = spec["name"]
        self.d, length = _parse_size(size, length, spec["name"])
        if length is None:
            raise ValueError(f"{spec['name']} M{_fmt(self.d)}: the length is missing, e.g. \"M{_fmt(self.d)}x10\". "
                             f"Standard lengths: {', '.join(_fmt(x) for x in lengths(standard, size))}")
        if length <= 0:
            raise ValueError(f"{spec['name']}: the length must be greater than 0")
        self.dims = _lookup(spec["table"], spec["col"], spec["cols"], self.d, spec["name"])
        self.length = length
        self.head = spec["head"]
        self.pitch = COARSE_PITCH.get(self.d, 0.1 * self.d)
        if check_length:
            options = lengths(standard, f"M{_fmt(self.d)}")
            if options and not any(abs(length - x) < 1e-9 for x in options):
                raise ValueError(f"{self.designation}: {_fmt(length)} mm is not a standard length. Standard lengths: "
                                 f"{', '.join(_fmt(x) for x in options)}. Non-standard length: check_length=False")
        if self.head == "set" and length < self.dims["t"]:
            raise ValueError(f"{self.designation}: shorter than the depth of the hex socket ({_fmt(self.dims['t'])} mm)")
        sink = _sink(sunk, spec["name"])
        self.sunk = sink is not None
        if self.head in ("countersunk", "set"):  # sitzen ohnehin im Material, `sunk` legt sie nur tiefer
            zs = sink or 0.0
        else:
            zs = self.head_height + sink if sink is not None else 0.0
        self._place(at, direction, on, angle, zs)

    @property
    def designation(self):
        return f"{self.standard} M{_fmt(self.d)}x{_fmt(self.length)}"

    @property
    def head_diameter(self):
        """Head diameter, for a hex head the width across corners."""
        if self.head == "hex":
            return self.dims["s"] / COS30
        return self.dims["dk"] if "dk" in self.dims else self.d

    @property
    def head_height(self):
        if self.head == "countersunk":
            return (self.dims["dk"] - self.d) / 2 / math.tan(math.radians(self.dims["a"] / 2))
        return self.dims.get("k", 0.0)

    @property
    def key(self):
        """Width across flats: of the hex socket, or of the hex head."""
        return self.dims["s"]

    @property
    def tip(self):
        """Point on the axis at the end of the shank."""
        return self.point(self.length)

    @property
    def outer(self):
        """Point on the axis at the top of the head."""
        return self._local_point(0.0 if self.head in ("countersunk", "set") else self.head_height)

    @property
    def lengths(self):
        return lengths(self.standard, f"M{_fmt(self.d)}")

    def clearance(self, fit="medium"):
        """Diameter of the clearance hole to ISO 273: fit "fine", "medium" or "coarse"."""
        return _clearance(self.d, fit)

    @property
    def tap_drill(self):
        """Tap drill diameter for the coarse thread."""
        return _tap_drill(self.d)

    def _local(self):
        return _screw_local(self.head, self.d, self.length, self.pitch, tuple(sorted(self.dims.items())))

    def clearance_hole(self, fit="medium", depth=None, oversize=0.0, recess=None):
        """Tool for cut(): clearance hole, with a counterbore for a sunk head, with a 90 degree cone for countersunk screws.

        fit       ISO 273: "fine", "medium" (default) or "coarse"
        depth     depth from the surface (`at`), default: to 1 mm beyond the end of the shank
        oversize  added to all diameters (3D printing: holes come out smaller)
        recess    diameter of the counterbore instead of head + clearance (e.g. room for a socket wrench)
        """
        c0 = self.clearance(fit)
        c = c0 + oversize
        top = self._zs + MARGIN
        bottom = self._zs - depth if depth is not None else -(self.length + 1.0)
        tool = _cyl(c, bottom, top)
        gap = c0 - self.d + oversize  # Spiel am Kopf wie am Schaft
        if self.head == "countersunk":
            big = recess or self.dims["dk"] + gap
            h = (big - c) / 2 / math.tan(math.radians(self.dims["a"] / 2))
            cone = cq.Solid.makeCone(c / 2, big / 2, h, cq.Vector(0, 0, -h), cq.Vector(0, 0, 1))
            tool = tool.fuse(cone, _cyl(big, 0.0, top))
        elif self.sunk and self.head != "set":
            tool = tool.fuse(_cyl(recess or self.head_diameter + gap, 0.0, top))
        return self._world(_one(tool))

    def tap_hole(self, depth=None, diameter=None, oversize=0.0):
        """Tool for cut(): tap drill hole for a thread (or for screwing into plastic with your own `diameter`).
        depth: depth from the surface, default to 3 pitches beyond the end of the shank."""
        dia = (diameter or self.tap_drill) + oversize
        bottom = self._zs - depth if depth is not None else -(self.length + 3 * self.pitch)
        return self._world(_cyl(dia, bottom, self._zs + MARGIN))


# --- Muttern, Scheiben, Gewindeeinsaetze -------------------------------------------------------------------------------

@functools.cache
def _nut_local(shape, d, m, s):
    if shape == "hex":
        body = _chamfered_hex(s, m, both=True)
    else:
        body = cq.Solid.makeBox(s, s, m, cq.Vector(-s / 2, -s / 2, 0))
    return _one(body.cut(_cyl(d, -0.01, m + 0.01)))


class Nut(_Part):
    """Nut. Nut("ISO 4032", "M3", at=(x, y, z), direction="+Z"): rests with one face at `at`, `direction` points
    from there into the material (so upwards for a nut under a plate).

    standard  "ISO 4032" (hex), "ISO 4033" (high), "ISO 4035" (thin), "DIN 557" (square)
    sunk      True: sunk flush (outer side at `at`), 0.5: 0.5 mm deeper. trap() gives the pocket for it
    angle     rotation about the axis in degrees. At 0 two flats are parallel to the X axis (for axis X: to the Y axis)
    """

    def __init__(self, standard, size=None, *, at=None, direction=None, on=None, sunk=False, angle=0.0):
        standard, size = _split_designation(standard, size)
        self.standard_key = _norm_standard(standard, NUTS, "Nut")
        spec = NUTS[self.standard_key]
        self.standard, self.shape_kind = spec["name"], spec["shape"]
        self.d, length = _parse_size(size, None, spec["name"])
        if length is not None:
            raise ValueError(f"{spec['name']}: nuts have no length, give only \"M{_fmt(self.d)}\"")
        vals = _lookup(spec["table"], spec["col"], ("m", "s"), self.d, spec["name"])
        self.height, self.key = vals["m"], vals["s"]
        sink = _sink(sunk, spec["name"])
        self.sunk = sink is not None
        self._place(at, direction, on, angle, self.height + sink if sink is not None else 0.0)

    @property
    def designation(self):
        return f"{self.standard} M{_fmt(self.d)}"

    @property
    def outer(self):
        return self._local_point(self.height)

    def _local(self):
        return _nut_local(self.shape_kind, self.d, self.height, self.key)

    def trap(self, clearance=0.2, slot=None, slot_length=None):
        """Tool for cut(): pocket for the nut, `clearance` per side and in height.

        Sunk nut: open up to the surface. slot="+X" with slot_length: slot to insert the nut from the side, as wide as
        the nut across the slot (with angle=0 and axis Z that is the width across flats for "+X").
        """
        sc = self.key + 2 * clearance
        top = self._zs + MARGIN if self.sunk else self.height + clearance
        pocket = _hex_prism(sc, 0.0, top) if self.shape_kind == "hex" else \
            cq.Solid.makeBox(sc, sc, top, cq.Vector(-sc / 2, -sc / 2, 0))
        if slot is not None:
            if not slot_length or slot_length <= 0:
                raise ValueError("trap: slot needs slot_length, the length of the slot from the axis in mm")
            u = _direction(slot)
            if abs(u.dot(self._dir)) > 1e-6:
                raise ValueError("trap: slot must be perpendicular to the axis of the nut")
            ux, uy = u.dot(self._plane.xDir), u.dot(self._plane.yDir)
            if self.shape_kind == "hex":
                corners = [(sc / COS30 / 2 * math.cos(math.radians(60 * i)), sc / COS30 / 2 * math.sin(math.radians(60 * i)))
                           for i in range(6)]
            else:
                corners = [(sx * sc / 2, sy * sc / 2) for sx in (-1, 1) for sy in (-1, 1)]
            across = [-x * uy + y * ux for x, y in corners]
            width = max(across) - min(across)
            box = cq.Solid.makeBox(slot_length, width, top, cq.Vector(0, -width / 2, 0))
            box = box.rotate(cq.Vector(0, 0, 0), cq.Vector(0, 0, 1), math.degrees(math.atan2(uy, ux)))
            pocket = pocket.fuse(box)
        return self._world(_one(pocket))


@functools.cache
def _ring_local(d1, d2, h):
    return _one(_cyl(d2, 0, h).cut(_cyl(d1, -0.01, h + 0.01)))


class Washer(_Part):
    """Washer. Washer("ISO 7089", "M3", at=(x, y, z)): rests with one side at `at`, `outer` is the other side, where
    the head or nut then sits.

    standard  "ISO 7089" (normal), "ISO 7091" (coarse), "ISO 7093" (large)
    """

    def __init__(self, standard, size=None, *, at=None, direction=None, on=None, sunk=False, angle=0.0):
        standard, size = _split_designation(standard, size)
        self.standard_key = _norm_standard(standard, WASHERS, "Washer")
        spec = WASHERS[self.standard_key]
        self.standard = spec["name"]
        self.d, length = _parse_size(size, None, spec["name"])
        if length is not None:
            raise ValueError(f"{spec['name']}: washers have no length, give only \"M{_fmt(self.d)}\"")
        vals = _lookup(spec["table"], spec["col"], ("d1", "d2", "h"), self.d, spec["name"])
        self.inner, self.outer_diameter, self.thickness = vals["d1"], vals["d2"], vals["h"]
        sink = _sink(sunk, spec["name"])
        self.sunk = sink is not None
        self._place(at, direction, on, angle, self.thickness + sink if sink is not None else 0.0)

    @property
    def designation(self):
        return f"{self.standard} M{_fmt(self.d)}"

    @property
    def outer(self):
        return self._local_point(self.thickness)

    def _local(self):
        return _ring_local(self.inner, self.outer_diameter, self.thickness)


def _inserts(brand):
    return _rows("heatset_nut_parameters.csv", brand, ("s", "m", "dc", "drill", "part"))


@functools.cache
def _insert_local(d, s, m):
    return _one(_cyl(s, -m, 0).cut(_cyl(d, -m - 0.01, 0.01)))


class HeatSetInsert(_Part):
    """Heat-set insert (3D printing). HeatSetInsert("M3x5.7", at=(x, y, z)): the top ends flush at `at`, the insert
    reaches into the material in direction `direction`. hole() gives the hole for it.

    size     "M3x5.7" (thread x length). Without a length only if the manufacturer has just one
    brand    "ruthex" (default), "CNCKitchen", "McMaster-Carr", "Hilitchi", "AE-SamZhihui"
    variant  for the same length, e.g. "Voron" (ruthex M3x4 with 5 mm outer diameter)
    sunk     0.5: top 0.5 mm below `at`
    """

    color = BRASS

    def __init__(self, size, length=None, *, brand="ruthex", variant=None, at=None, direction=None, on=None, sunk=False,
                 angle=0.0):
        key = re.sub(r"[\s_.-]", "", str(brand).lower())
        if key not in INSERT_BRANDS:
            raise ValueError(f"Heat-set insert: unknown brand {brand!r}. Available: "
                             + ", ".join(sorted(set(INSERT_BRANDS.values()))))
        self.brand = INSERT_BRANDS[key]
        self.d, length = _parse_size(size, length, "Heat-set insert")
        rows = [r for r in _inserts(self.brand) if abs(r[0] - self.d) < 1e-9]
        if not rows:
            sizes = sorted({r[0] for r in _inserts(self.brand)})
            raise ValueError(f"Heat-set insert {self.brand}: there is no M{_fmt(self.d)}. Available: "
                             + ", ".join(f"M{_fmt(x)}" for x in sizes))

        def label(r):  # "5.7", "4 Voron": wie man die Auswahl nennt
            extra = re.sub(r"^\d+(?:\.\d+)?", "", r[2]).strip(" -")
            return _fmt(r[3]["m"]) + (f" {extra}" if extra else "")

        found = rows
        if length is not None:
            found = [r for r in found if abs(r[3]["m"] - length) < 0.05]
        if variant is not None:
            found = [r for r in found if str(variant).lower() in r[2].lower()]
        elif len(found) > 1:  # ohne Variante: die Zeile ohne Zusatz ("4.0", nicht "4.0Voron")
            plain = [r for r in found if re.fullmatch(r"\d+(?:\.\d+)?", r[2])]
            found = plain if len(plain) == 1 else found
        if len(found) != 1:
            options = ", ".join(sorted({label(r) for r in rows}))
            what = "no length matches" if not found else "the length is ambiguous"
            raise ValueError(f"Heat-set insert {self.brand} M{_fmt(self.d)}: {what}. Lengths: {options} "
                             f"(e.g. \"M{_fmt(self.d)}x{label(rows[0]).split()[0]}\", the extra with variant=)")
        row = found[0][3]
        self.variant = re.sub(r"^\d+(?:\.\d+)?", "", found[0][2]).strip(" -") or None
        self.diameter, self.length, self.part_number = row["s"], row["m"], row["part"]
        self.hole_diameter = _drill_mm(row["drill"])
        if self.hole_diameter is None or not self.d < self.hole_diameter < self.diameter:
            raise ValueError(f"{self.designation}: the table gives no usable hole (drill {row['drill']!r}). "
                             "Look up the hole at the manufacturer and model the insert yourself")
        sink = _sink(sunk, "Heat-set insert")
        self.sunk = sink is not None
        self._place(at, direction, on, angle, sink or 0.0)

    @property
    def designation(self):
        return f"Heat-set insert {self.brand} M{_fmt(self.d)}x{_fmt(self.length)}" + (f" {self.variant}" if self.variant else "")

    @property
    def outer(self):
        return self._local_point(0.0)

    def _local(self):
        return _insert_local(self.d, self.diameter, self.length)

    def hole(self, extra_depth=1.0, oversize=0.0):
        """Tool for cut(): hole for the insert as the manufacturer specifies, `extra_depth` mm deeper than the insert is
        long (room for displaced plastic), `oversize` added to the diameter."""
        return self._world(_cyl(self.hole_diameter + oversize, -(self.length + extra_depth), self._zs + MARGIN))
