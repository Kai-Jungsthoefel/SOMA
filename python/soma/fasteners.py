"""Normteile: Schrauben, Muttern, Scheiben und Gewindeeinsaetze, vereinfacht ohne Gewinde, mit passenden Bohrungen.

    from soma import add_part
    from soma.fasteners import Screw

    s = Screw("ISO 4762", "M3x10", at=(20, 15, 8))   # Kopf liegt bei z = 8 auf, der Schaft zeigt nach unten
    lid = lid.cut(s.clearance_hole())                 # Durchgangsloch, bei versenktem Kopf mit Senkung
    add_part("Schraube 1", s)                         # Rolle "hardware" (Zukaufteil), nicht in export --all

Lage, fuer alle Teile gleich: `at` ist der Punkt auf der Achse, an dem das Teil aufliegt. `direction` zeigt von dort
ins Material (Standard "-Z": von oben nach unten). Eine Schraube liegt mit der Kopfunterseite auf, eine Mutter oder
Scheibe mit einer Stirnseite. Senkschraube, Gewindestift und Gewindeeinsatz schliessen mit ihrer Oberseite an `at` ab.
`sunk=True` versenkt Kopf, Mutter oder Scheibe buendig (die Aussenseite liegt dann an `at`), `sunk=0.5` 0,5 mm tiefer.
`on=teil` sucht die Auflage selbst: Die Gerade durch `at` in Richtung `direction` trifft das Teil, der erste Treffer
gilt (bei "-Z" zaehlen dann nur x und y von `at`).

Die Masse stammen aus den Tabellen von bd_warehouse (Apache 2.0, siehe data/fasteners/QUELLE.md), teils Nenn-, teils
Groesstmasse. Gewinde werden nicht modelliert: Schaft und Bohrung der Mutter haben den Nenndurchmesser.
"""
import csv
import functools
import math
import numbers
import re
from pathlib import Path

import cadquery as cq
from OCP.BRepIntCurveSurface import BRepIntCurveSurface_Inter
from OCP.gp import gp_Dir, gp_Lin, gp_Pnt

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
    "iso4762": dict(name="ISO 4762", title="Zylinderschraube mit Innensechskant", table="socket_head_cap_parameters.csv",
                    col="iso4762", head="socket", cols=("dk", "k", "s", "t")),
    "iso7380": dict(name="ISO 7380", title="Linsenkopfschraube mit Innensechskant", table="button_head_parameters.csv",
                    col="iso7380_1", head="button", cols=("dk", "dl", "k", "rf", "s", "t")),
    "iso10642": dict(name="ISO 10642", title="Senkschraube mit Innensechskant", table="countersunk_head_parameters.csv",
                     col="iso10642", head="countersunk", cols=("a", "dk", "k", "s", "t")),
    "iso4017": dict(name="ISO 4017", title="Sechskantschraube mit Gewinde bis Kopf", table="hex_head_parameters.csv",
                    col="iso4017", head="hex", cols=("k", "s")),
    "iso4014": dict(name="ISO 4014", title="Sechskantschraube mit Schaft", table="hex_head_parameters.csv",
                    col="iso4014", head="hex", cols=("k", "s")),
    "din931": dict(name="DIN 931", title="Sechskantschraube mit Schaft", table="hex_head_parameters.csv",
                   col="din931", head="hex", cols=("k", "s")),
    "iso4026": dict(name="ISO 4026", title="Gewindestift mit Innensechskant und Kegelstumpf", table="setscrew_parameters.csv",
                    col="iso4026", head="set", cols=("s", "t")),
}
NUTS = {
    "iso4032": dict(name="ISO 4032", title="Sechskantmutter", table="hex_nut_parameters.csv", col="iso4032", shape="hex"),
    "iso4033": dict(name="ISO 4033", title="Sechskantmutter, hoch", table="hex_nut_parameters.csv", col="iso4033", shape="hex"),
    "iso4035": dict(name="ISO 4035", title="Sechskantmutter, flach", table="hex_nut_parameters.csv", col="iso4035", shape="hex"),
    "din557": dict(name="DIN 557", title="Vierkantmutter", table="square_nut_parameters.csv", col="din557", shape="square"),
}
WASHERS = {
    "iso7089": dict(name="ISO 7089", title="Scheibe", table="plain_washer_parameters.csv", col="iso7089"),
    "iso7091": dict(name="ISO 7091", title="Scheibe, grob", table="plain_washer_parameters.csv", col="iso7091"),
    "iso7093": dict(name="ISO 7093", title="Scheibe, gross", table="plain_washer_parameters.csv", col="iso7093"),
}
INSERT_BRANDS = {"ruthex": "ruthex", "cnckitchen": "CNCKitchen", "mcmaster": "McMaster-Carr", "mcmastercarr": "McMaster-Carr",
                 "hilitchi": "Hilitchi", "aesamzhihui": "AE-SamZhihui"}
ALIASES = {"iso73801": "iso7380"}
# Alte DIN-Bezeichnungen: melden statt still umdeuten, weil manche Masse abweichen
HINTS = {
    "din912": "ISO 4762", "din7380": "ISO 7380", "din7991": "ISO 10642 (Kopfhoehe weicht etwas ab)",
    "din933": "ISO 4017 (bei M10, M12, M14 und M22 andere Schluesselweite als DIN 933)", "din913": "ISO 4026 (Ende anders)",
    "din916": "ISO 4026 (Ende anders)", "din934": "ISO 4032 (bei M10, M12, M14 und M22 andere Schluesselweite als DIN 934)",
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
        raise ValueError(f"{what}: Groesse M{_fmt(d)} gibt es in der Tabelle nicht. Vorhanden: "
                         + ", ".join(f"M{_fmt(x)}" for x in sizes))
    coarse = [r for r in rows if r[1] is None or abs(r[1] - COARSE_PITCH.get(d, -1)) < 1e-9]
    return (coarse or rows)[0][3]


def _fmt(x):
    """3.0 -> "3", 2.5 -> "2.5": Zahlen so, wie man sie in Bezeichnungen schreibt."""
    return f"{x:g}"


def _norm_standard(standard, table, kind):
    if not isinstance(standard, str) or not standard.strip():
        raise ValueError(f"{kind}: Norm als Text angeben, z. B. {next(iter(table.values()))['name']!r}")
    key = re.sub(r"[\s_.-]", "", standard.lower())
    key = ALIASES.get(key, key)
    if key in table:
        return key
    known = ", ".join(v["name"] for v in table.values())
    if key in HINTS:
        raise ValueError(f"{kind}: {standard!r} heisst heute {HINTS[key]}. Moeglich: {known}")
    raise ValueError(f"{kind}: Norm {standard!r} gibt es hier nicht. Moeglich: {known}")


_SIZE = re.compile(r"^\s*M\s*(\d+(?:[.,]\d+)?)\s*(?:[xX×*]\s*(\d+(?:[.,]\d+)?)\s*(?:mm)?)?\s*$", re.IGNORECASE)


def _parse_size(size, length, kind):
    """"M3" oder "M3x10" (auch "M3 x 10", "M3×10") -> (3.0, Laenge oder None)."""
    if not isinstance(size, str):
        raise ValueError(f"{kind}: Groesse als Text angeben, z. B. \"M3\" oder \"M3x10\", nicht {size!r}")
    m = _SIZE.match(size)
    if not m:
        raise ValueError(f"{kind}: Groesse {size!r} nicht lesbar. Erwartet z. B. \"M3\" oder \"M3x10\"")
    d = _num(m.group(1))
    if m.group(2):
        from_size = _num(m.group(2))
        if length is not None and abs(float(length) - from_size) > 1e-9:
            raise ValueError(f"{kind}: Laenge doppelt und verschieden angegeben ({size!r} und length={length})")
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
    """Normlaengen einer Schraube in mm, z. B. lengths("ISO 4762", "M3") -> [5, 6, 8, 10, 12, 16, 20, 25, 30]."""
    key = _norm_standard(standard, SCREWS, "Schraube")
    spec = SCREWS[key]
    d, _ = _parse_size(size, None, spec["name"])
    short, long_ = _length_range(spec, d)
    series = _nominal_lengths().get(spec["col"], [])
    return [x for x in series if short - 1e-9 <= x <= long_ + 1e-9]


def pick_length(standard, size, min_length, max_length=None):
    """Kuerzeste Normlaenge, die mindestens `min_length` lang ist (und hoechstens `max_length`, wenn angegeben)."""
    options = lengths(standard, size)
    fitting = [x for x in options if x >= min_length - 1e-9 and (max_length is None or x <= max_length + 1e-9)]
    if not fitting:
        span = f"{_fmt(min_length)} bis {_fmt(max_length)}" if max_length is not None else f"mindestens {_fmt(min_length)}"
        raise ValueError(f"{standard} {size}: keine Normlaenge {span} mm. Normlaengen: "
                         + ", ".join(_fmt(x) for x in options))
    return fitting[0]


def standards():
    """Was es gibt: {"Schrauben": {"ISO 4762": "Zylinderschraube ..."}, ...}."""
    return {
        "Schrauben": {v["name"]: v["title"] for v in SCREWS.values()},
        "Muttern": {v["name"]: v["title"] for v in NUTS.values()},
        "Scheiben": {v["name"]: v["title"] for v in WASHERS.values()},
        "Gewindeeinsaetze": sorted(set(INSERT_BRANDS.values())),
    }


def _clearance(d, fit):
    if fit not in FITS:
        raise ValueError(f"fit muss einer von {tuple(FITS)} sein (ISO 273 fein, mittel, grob), nicht {fit!r}")
    rows = [r for r in _rows("clearance_hole_sizes.csv", None, (FITS[fit],)) if abs(r[0] - d) < 1e-9]
    if not rows:
        raise ValueError(f"Fuer M{_fmt(d)} gibt es kein Durchgangsloch in der Tabelle")
    return rows[0][3][FITS[fit]]


def _tap_drill(d):
    return _lookup("tap_hole_sizes.csv", None, ("Soft",), d, "Kernloch")["Soft"]


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
    raise ValueError(f"{what}: erwartet (x, y, z), nicht {v!r}")


def _direction(spec):
    if isinstance(spec, str):
        m = re.match(r"^\s*([+-]?)\s*([xyz])\s*$", spec, re.IGNORECASE)
        if not m:
            raise ValueError(f"direction: erwartet \"-Z\", \"+X\" usw. oder (x, y, z), nicht {spec!r}")
        v = cq.Vector(*[(-1.0 if m.group(1) == "-" else 1.0) if a == m.group(2).lower() else 0.0 for a in "xyz"])
    else:
        v = _vec(spec, "direction")
    if v.Length < 1e-9:
        raise ValueError("direction darf nicht (0, 0, 0) sein")
    return v.normalized()


def _at(at, on):
    """Punkt und (falls ableitbar) Richtung aus `at`: Tupel, Vector, Vertex, Location oder Workplane."""
    if at is None:
        raise ValueError("at fehlt: der Punkt, an dem das Teil aufliegt, z. B. at=(10, 5, 8)")
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
        raise ValueError(f"at: die Workplane traegt {len(objs)} Punkte. Je Teil einen Punkt uebergeben (Schleife ueber .vals())")
    if isinstance(at, (tuple, list)) and len(at) == 2:
        if on is None:
            raise ValueError("at braucht x, y und z. Nur (x, y) geht mit on=teil, dann wird die Auflage gesucht")
        return cq.Vector(float(at[0]), float(at[1]), 0.0), None
    return _vec(at, "at"), None


def _shape_of(obj, what="on"):
    if hasattr(obj, "__soma_shape__"):
        return obj.__soma_shape__()
    if isinstance(obj, cq.Workplane):
        vals = [v for v in obj.vals() if isinstance(v, cq.Shape)]
        if not vals:
            raise ValueError(f"{what}: die Workplane enthaelt keine Geometrie")
        return vals[0] if len(vals) == 1 else cq.Compound.makeCompound(vals)
    if isinstance(obj, cq.Assembly):
        return obj.toCompound()
    if isinstance(obj, cq.Shape):
        return obj
    raise ValueError(f"{what}: erwartet ein Teil (cq.Workplane oder cq.Shape), nicht {type(obj).__name__}")


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
        raise ValueError(f"on: die Gerade durch {_pt(point)} in Richtung {_pt(d)} trifft das Teil nicht. "
                         "Pruefe at und direction")
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
    raise ValueError(f"{kind}: sunk ist True, False oder eine Tiefe in mm (>= 0), nicht {sunk!r}")


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
            raise ValueError(f"angle: Drehung um die Achse in Grad, nicht {angle!r}")
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
        """Einheitsvektor von der Auflage ins Material."""
        return self._dir.toTuple()

    @property
    def seat(self):
        """Punkt auf der Achse an der Auflage (Kopfunterseite, Stirnseite der Mutter)."""
        return self._local_point(0.0)

    @property
    def surface(self):
        """Punkt auf der Achse an der Oberflaeche, auf der das Teil sitzt (`at`, mit on= der gefundene Punkt)."""
        return self._surface.toTuple()

    def point(self, distance):
        """Punkt auf der Achse, `distance` mm von der Auflage ins Material (z. B. fuer die Mutter am anderen Ende)."""
        return self._local_point(-float(distance))

    @property
    def shape(self):
        """Das Teil als cq.Solid an seiner Lage."""
        return self._world(self._local())

    def __soma_shape__(self):
        return self.shape

    def __repr__(self):
        return f"<{self.designation} an {_pt(cq.Vector(*self.seat))}, Richtung {_pt(self._dir)}>"


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
        raise ValueError(f"Kopfform {head!r} unbekannt")
    return _one(cap.fuse(shank))


class Screw(_Part):
    """Schraube ohne Gewinde. Screw("ISO 4762", "M3x10", at=(x, y, z)) oder Screw("ISO 4762", "M3", 10, at=...).

    standard      "ISO 4762" (Zylinderkopf), "ISO 7380" (Linsenkopf), "ISO 10642" (Senkkopf), "ISO 4017", "ISO 4014",
                  "DIN 931" (Sechskant), "ISO 4026" (Gewindestift)
    at            Auflage der Kopfunterseite (Senkschraube, Gewindestift: Oberseite), (x, y, z) oder cq.Location
    direction     von der Auflage ins Material, Standard "-Z"
    on            Teil, auf dem die Schraube sitzt: Die Auflage wird entlang `direction` gesucht
    sunk          True: Kopf buendig in einer Senkung, 0.5: 0,5 mm tiefer. Senkschrauben sitzen immer buendig
    angle         Drehung um die Achse in Grad (Lage des Sechskants)
    check_length  False erlaubt Laengen, die keine Normlaenge sind
    """

    def __init__(self, standard, size=None, length=None, *, at=None, direction=None, on=None, sunk=False, angle=0.0,
                 check_length=True):
        standard, size = _split_designation(standard, size)
        self.standard_key = _norm_standard(standard, SCREWS, "Schraube")
        spec = SCREWS[self.standard_key]
        self.standard = spec["name"]
        self.d, length = _parse_size(size, length, spec["name"])
        if length is None:
            raise ValueError(f"{spec['name']} M{_fmt(self.d)}: Laenge fehlt, z. B. \"M{_fmt(self.d)}x10\". "
                             f"Normlaengen: {', '.join(_fmt(x) for x in lengths(standard, size))}")
        if length <= 0:
            raise ValueError(f"{spec['name']}: Laenge muss groesser als 0 sein")
        self.dims = _lookup(spec["table"], spec["col"], spec["cols"], self.d, spec["name"])
        self.length = length
        self.head = spec["head"]
        self.pitch = COARSE_PITCH.get(self.d, 0.1 * self.d)
        if check_length:
            options = lengths(standard, f"M{_fmt(self.d)}")
            if options and not any(abs(length - x) < 1e-9 for x in options):
                raise ValueError(f"{self.designation}: {_fmt(length)} mm ist keine Normlaenge. Normlaengen: "
                                 f"{', '.join(_fmt(x) for x in options)}. Sonderlaenge: check_length=False")
        if self.head == "set" and length < self.dims["t"]:
            raise ValueError(f"{self.designation}: kuerzer als der Innensechskant tief ist ({_fmt(self.dims['t'])} mm)")
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
        """Kopfdurchmesser, beim Sechskant das Eckmass."""
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
        """Schluesselweite: Innensechskant oder Sechskant aussen."""
        return self.dims["s"]

    @property
    def tip(self):
        """Punkt auf der Achse am Ende des Schafts."""
        return self.point(self.length)

    @property
    def outer(self):
        """Punkt auf der Achse an der Kopfoberseite."""
        return self._local_point(0.0 if self.head in ("countersunk", "set") else self.head_height)

    @property
    def lengths(self):
        return lengths(self.standard, f"M{_fmt(self.d)}")

    def clearance(self, fit="medium"):
        """Durchmesser des Durchgangslochs nach ISO 273: fit "fine", "medium" oder "coarse"."""
        return _clearance(self.d, fit)

    @property
    def tap_drill(self):
        """Kernlochdurchmesser fuer das Regelgewinde."""
        return _tap_drill(self.d)

    def _local(self):
        return _screw_local(self.head, self.d, self.length, self.pitch, tuple(sorted(self.dims.items())))

    def clearance_hole(self, fit="medium", depth=None, oversize=0.0, recess=None):
        """Werkzeug fuer cut(): Durchgangsloch, bei versenktem Kopf mit Senkung, bei Senkschrauben mit 90-Grad-Kegel.

        fit       ISO 273: "fine", "medium" (Standard) oder "coarse"
        depth     Tiefe ab der Oberflaeche (`at`), Standard: bis 1 mm hinter das Schaftende
        oversize  zusaetzlich auf alle Durchmesser (3D-Druck: Loecher kommen kleiner heraus)
        recess    Durchmesser der Senkung statt Kopf + Spiel (z. B. Platz fuer einen Steckschluessel)
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
        """Werkzeug fuer cut(): Kernloch fuer ein Gewinde (oder zum Eindrehen in Kunststoff mit eigenem `diameter`).
        depth: Tiefe ab der Oberflaeche, Standard bis 3 Steigungen hinter das Schaftende."""
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
    """Mutter. Nut("ISO 4032", "M3", at=(x, y, z), direction="+Z"): liegt mit einer Stirnseite an `at`, `direction`
    zeigt von dort ins Material (bei einer Mutter unter einer Platte also nach oben).

    standard  "ISO 4032" (Sechskant), "ISO 4033" (hoch), "ISO 4035" (flach), "DIN 557" (Vierkant)
    sunk      True: buendig versenkt (aussen an `at`), 0.5: 0,5 mm tiefer. Die Tasche dafuer liefert trap()
    angle     Drehung um die Achse in Grad. Bei 0 liegen zwei Flaechen parallel zur X-Achse (bei Achse X: zur Y-Achse)
    """

    def __init__(self, standard, size=None, *, at=None, direction=None, on=None, sunk=False, angle=0.0):
        standard, size = _split_designation(standard, size)
        self.standard_key = _norm_standard(standard, NUTS, "Mutter")
        spec = NUTS[self.standard_key]
        self.standard, self.shape_kind = spec["name"], spec["shape"]
        self.d, length = _parse_size(size, None, spec["name"])
        if length is not None:
            raise ValueError(f"{spec['name']}: Muttern haben keine Laenge, nur \"M{_fmt(self.d)}\" angeben")
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
        """Werkzeug fuer cut(): Tasche fuer die Mutter, `clearance` Spiel je Seite und in der Hoehe.

        Versenkte Mutter: offen bis zur Oberflaeche. slot="+X" mit slot_length: Schlitz zum seitlichen Einschieben,
        so breit wie die Mutter quer zum Schlitz (bei angle=0 und Achse Z ist das fuer "+X" die Schluesselweite).
        """
        sc = self.key + 2 * clearance
        top = self._zs + MARGIN if self.sunk else self.height + clearance
        pocket = _hex_prism(sc, 0.0, top) if self.shape_kind == "hex" else \
            cq.Solid.makeBox(sc, sc, top, cq.Vector(-sc / 2, -sc / 2, 0))
        if slot is not None:
            if not slot_length or slot_length <= 0:
                raise ValueError("trap: slot braucht slot_length, die Laenge des Schlitzes ab der Achse in mm")
            u = _direction(slot)
            if abs(u.dot(self._dir)) > 1e-6:
                raise ValueError("trap: slot muss quer zur Achse der Mutter liegen")
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
    """Scheibe. Washer("ISO 7089", "M3", at=(x, y, z)): liegt mit einer Seite an `at`, `outer` ist die andere Seite,
    auf der dann Kopf oder Mutter sitzt.

    standard  "ISO 7089" (normal), "ISO 7091" (grob), "ISO 7093" (gross)
    """

    def __init__(self, standard, size=None, *, at=None, direction=None, on=None, sunk=False, angle=0.0):
        standard, size = _split_designation(standard, size)
        self.standard_key = _norm_standard(standard, WASHERS, "Scheibe")
        spec = WASHERS[self.standard_key]
        self.standard = spec["name"]
        self.d, length = _parse_size(size, None, spec["name"])
        if length is not None:
            raise ValueError(f"{spec['name']}: Scheiben haben keine Laenge, nur \"M{_fmt(self.d)}\" angeben")
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
    """Gewindeeinsatz zum Einschmelzen (3D-Druck). HeatSetInsert("M3x5.7", at=(x, y, z)): die Oberseite schliesst an
    `at` ab, der Einsatz reicht in Richtung `direction` ins Material. hole() liefert die Bohrung dafuer.

    size     "M3x5.7" (Gewinde x Laenge). Ohne Laenge nur, wenn es beim Hersteller nur eine gibt
    brand    "ruthex" (Standard), "CNCKitchen", "McMaster-Carr", "Hilitchi", "AE-SamZhihui"
    variant  bei gleicher Laenge, z. B. "Voron" (ruthex M3x4 mit 5 mm Aussendurchmesser)
    sunk     0.5: Oberseite 0,5 mm unter `at`
    """

    color = BRASS

    def __init__(self, size, length=None, *, brand="ruthex", variant=None, at=None, direction=None, on=None, sunk=False,
                 angle=0.0):
        key = re.sub(r"[\s_.-]", "", str(brand).lower())
        if key not in INSERT_BRANDS:
            raise ValueError(f"Gewindeeinsatz: Hersteller {brand!r} unbekannt. Moeglich: "
                             + ", ".join(sorted(set(INSERT_BRANDS.values()))))
        self.brand = INSERT_BRANDS[key]
        self.d, length = _parse_size(size, length, "Gewindeeinsatz")
        rows = [r for r in _inserts(self.brand) if abs(r[0] - self.d) < 1e-9]
        if not rows:
            sizes = sorted({r[0] for r in _inserts(self.brand)})
            raise ValueError(f"Gewindeeinsatz {self.brand}: M{_fmt(self.d)} gibt es nicht. Vorhanden: "
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
            what = "passt keiner" if not found else "ist nicht eindeutig"
            raise ValueError(f"Gewindeeinsatz {self.brand} M{_fmt(self.d)}: {what}. Laengen: {options} "
                             f"(z. B. \"M{_fmt(self.d)}x{label(rows[0]).split()[0]}\", Zusatz mit variant=)")
        row = found[0][3]
        self.variant = re.sub(r"^\d+(?:\.\d+)?", "", found[0][2]).strip(" -") or None
        self.diameter, self.length, self.part_number = row["s"], row["m"], row["part"]
        self.hole_diameter = _drill_mm(row["drill"])
        if self.hole_diameter is None or not self.d < self.hole_diameter < self.diameter:
            raise ValueError(f"{self.designation}: die Tabelle nennt keine brauchbare Bohrung (Bohrer {row['drill']!r}). "
                             "Bohrung beim Hersteller nachsehen, den Einsatz selbst modellieren")
        sink = _sink(sunk, "Gewindeeinsatz")
        self.sunk = sink is not None
        self._place(at, direction, on, angle, sink or 0.0)

    @property
    def designation(self):
        return f"Gewindeeinsatz {self.brand} M{_fmt(self.d)}x{_fmt(self.length)}" + (f" {self.variant}" if self.variant else "")

    @property
    def outer(self):
        return self._local_point(0.0)

    def _local(self):
        return _insert_local(self.d, self.diameter, self.length)

    def hole(self, extra_depth=1.0, oversize=0.0):
        """Werkzeug fuer cut(): Bohrung fuer den Einsatz nach Herstellerangabe, `extra_depth` mm tiefer als der Einsatz
        lang ist (Platz fuer verdraengten Kunststoff), `oversize` zusaetzlich auf den Durchmesser."""
        return self._world(_cyl(self.hole_diameter + oversize, -(self.length + extra_depth), self._zs + MARGIN))
