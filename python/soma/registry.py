"""Part registry: add_part records the object, role and color plus the file and line range of the call."""
import inspect
import math
import unicodedata

import cadquery as cq

REGISTRY = []  # wird pro Build geleert (siehe build.py)
# Beim Ausfuehren von Animationsdateien (animrun.py): Die Bauteile sind schon bekannt. Importiert eine Animation das Modell
# (`from model import HINGE_Y`), laeuft model.py ein zweites Mal, add_part() bleibt dann wirkungslos.
IGNORE_ADD = False
DEFAULT_COLORS = {"part": (0.62, 0.66, 0.72), "reference": (0.1, 0.65, 0.3), "hardware": (0.45, 0.46, 0.49)}
REFERENCE_ALPHA = 0.45
ROLES = ("part", "reference", "hardware")

_TRANSLIT = {"ä": "ae", "ö": "oe", "ü": "ue", "Ä": "Ae", "Ö": "Oe", "Ü": "Ue", "ß": "ss", "×": "x"}


def ascii_name(name):
    """STEP-Namen nur ASCII: der OCCT-Export kodiert Nicht-ASCII doppelt (Phase 0, ERGEBNISSE.md)."""
    s = "".join(_TRANSLIT.get(ch, ch) for ch in name)
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    s = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in s.strip()).strip("_")
    return s or "part"


def to_shape(obj):
    if hasattr(obj, "__soma_shape__"):  # Normteile aus soma.fasteners
        return obj.__soma_shape__()
    if isinstance(obj, cq.Workplane):
        vals = obj.vals()
        if not vals:
            raise ValueError("The Workplane is empty (no geometry). Check the operations before it.")
        return vals[0] if len(vals) == 1 else cq.Compound.makeCompound(vals)
    if isinstance(obj, cq.Shape):
        return obj
    raise TypeError(f"add_part expects a cq.Workplane, a cq.Shape or a standard part from soma.fasteners, not {type(obj).__name__}")


def _group_path(group):
    """"Gehaeuse/Schrauben" -> ("Gehaeuse", "Schrauben"). Leere Teile fallen weg."""
    if group is None:
        return ()
    if not isinstance(group, str):
        raise ValueError("group must be a text, e.g. \"Housing\" or \"Housing/Screws\"")
    return tuple(s.strip() for s in group.split("/") if s.strip())


def _leaves(node, loc, groups, color):
    """Teile einer Baugruppe mit Lage, Gruppenpfad und Farbe (ohne eigene Farbe gilt die der Gruppe darueber)."""
    loc = loc * node.loc
    color = node.color if node.color is not None else color
    if node.obj is not None:
        yield groups, node.name, node.obj, color, loc
    for child in node.children:
        yield from _leaves(child, loc, groups + (node.name,), color)


def _unique(name, taken):
    """Name, der noch nicht vergeben ist: bei Gleichstand "Schraube (2)" (Hersteller-STEP wiederholen Namen oft)."""
    if name not in taken:
        return name
    i = 2
    while f"{name} ({i})" in taken:
        i += 1
    return f"{name} ({i})"


def add_part(name, obj, role=None, color=None, group=None):
    """Registers a part. Required for every part, otherwise the viewer and the export do not know it.

    name   unique name (any characters, in the STEP file it is written as ASCII)
    obj    cq.Workplane or cq.Shape, a standard part from soma.fasteners (Screw, Nut ...) or an assembly from
           import_assembly(): then every body becomes a part of its own with its name and color, the
           sub-assemblies become groups under `name`
    role   "part" (own part, default), "reference" (part brought along: semi-transparent, own branch, not in the
           export) or "hardware" (purchased part like screws: opaque, in the STEP file with its group, not in
           export --all). Standard parts from soma.fasteners are "hardware" if not given
    color  optional (r, g, b) with values 0..1 (for an assembly for all parts). Standard parts have their own
    group  optional, group in the part tree and in the STEP file, nested with "/", e.g. "Housing/Screws"
    """
    if IGNORE_ADD:
        return
    standard_part = hasattr(obj, "__soma_shape__")
    if role is None:
        role = getattr(obj, "role", "part") if standard_part else "part"
    if color is None and standard_part:
        color = getattr(obj, "color", None)
    if role not in ROLES:
        raise ValueError(f"role must be one of {ROLES}, not {role!r}")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("The part name must be a non-empty text")
    groups = _group_path(group)
    frame = inspect.currentframe().f_back
    pos = inspect.getframeinfo(frame, context=0).positions  # Startzeile und Endzeile des Aufrufs
    where = dict(file=frame.f_code.co_filename, line=pos.lineno, end_line=pos.end_lineno)
    if isinstance(obj, cq.Assembly):
        leaves = list(_leaves(obj, cq.Location(), (), None))
        if not leaves:
            raise ValueError(f"The assembly for {name!r} contains no geometry")
        if len(leaves) == 1:  # nur ein Koerper: ein Bauteil unter dem angegebenen Namen, ohne eigene Gruppe
            _, _, o, c, loc = leaves[0]
            _register(name, to_shape(o).moved(loc), role, color or (c.toTuple()[:3] if c else None), groups, where)
            return
        taken = {p["name"] for p in REGISTRY}
        for sub_groups, leaf_name, o, c, loc in leaves:
            # Die oberste Baugruppe traegt den Namen aus add_part, darunter die Namen aus der Datei
            path = groups + (name,) + sub_groups[1:]
            nm = _unique(leaf_name or "Part", taken)
            taken.add(nm)
            _register(nm, to_shape(o).moved(loc), role, color or (c.toTuple()[:3] if c else None), path, where, unique_step=True)
        return
    if any(p["name"] == name for p in REGISTRY):
        raise ValueError(f"Part name {name!r} is already taken (names must be unique)")
    _register(name, to_shape(obj), role, color, groups, where, axis=_axis(obj))


def _axis(obj):
    """Achse eines Normteils als Einheitsvektor aus dem Material heraus (Gegenrichtung von `direction`). Daran zieht
    die Explosionsansicht das Teil heraus. Andere Objekte haben keine Achse."""
    if not hasattr(obj, "__soma_shape__"):
        return None
    try:
        d = [float(x) for x in obj.direction]
    except Exception:  # fremdes Objekt mit __soma_shape__, aber ohne brauchbare Richtung: dann eben ohne Achse
        return None
    n = math.sqrt(sum(x * x for x in d)) if len(d) == 3 else 0.0
    if not n > 1e-9:  # faengt auch nan ab
        return None
    return tuple(round(-x / n, 6) + 0.0 for x in d)  # + 0.0: kein "-0.0" in den Metadaten


def _register(name, shape, role, color, groups, where, unique_step=False, axis=None):
    step_name = ascii_name(name)
    if any(p["step_name"] == step_name for p in REGISTRY):
        if not unique_step:
            raise ValueError(f"Part name {name!r} gives the STEP name {step_name!r}, which is already taken")
        i = 2
        while any(p["step_name"] == f"{step_name}_{i}" for p in REGISTRY):
            i += 1
        step_name = f"{step_name}_{i}"
    rgb = tuple(color[:3]) if color else DEFAULT_COLORS[role]
    REGISTRY.append(dict(
        name=name, step_name=step_name, role=role, shape=shape, group=tuple(groups),
        color=(*rgb, REFERENCE_ALPHA if role == "reference" else 1.0), axis=axis, **where,
    ))


def import_step(path):
    """Imports a STEP file brought along (e.g. from inputs/) as one shape. The parts and groups of the file merge into
    one body. To keep them: import_assembly()."""
    return cq.importers.importStep(str(path)).val()


def import_assembly(path):
    """Imports a STEP file with its structure: parts with names and colors, sub-assemblies as groups.
    Move it as a whole with `asm.loc = cq.Location((x, y, z))`, register it with add_part("Name", asm)."""
    return cq.Assembly.importStep(str(path))
