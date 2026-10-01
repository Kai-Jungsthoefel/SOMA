"""Bauteil-Registrierung: add_part merkt sich Objekt, Rolle, Farbe sowie Datei und Zeilenbereich des Aufrufs."""
import inspect
import unicodedata

import cadquery as cq

REGISTRY = []  # wird pro Build geleert (siehe build.py)
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
            raise ValueError("Die Workplane ist leer (keine Geometrie). Pruefe die Operationen davor.")
        return vals[0] if len(vals) == 1 else cq.Compound.makeCompound(vals)
    if isinstance(obj, cq.Shape):
        return obj
    raise TypeError(f"add_part erwartet cq.Workplane, cq.Shape oder ein Normteil aus soma.fasteners, nicht {type(obj).__name__}")


def _group_path(group):
    """"Gehaeuse/Schrauben" -> ("Gehaeuse", "Schrauben"). Leere Teile fallen weg."""
    if group is None:
        return ()
    if not isinstance(group, str):
        raise ValueError("group muss ein Text sein, z. B. \"Gehaeuse\" oder \"Gehaeuse/Schrauben\"")
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
    """Registriert ein Bauteil. Pflicht fuer jedes Bauteil, sonst kennen Viewer und Export es nicht.

    name   eindeutiger Name (Umlaute erlaubt, in der STEP-Datei wird er als ASCII geschrieben)
    obj    cq.Workplane oder cq.Shape, ein Normteil aus soma.fasteners (Screw, Nut ...) oder eine Baugruppe aus
           import_assembly(): Dann wird jeder Koerper ein eigenes Bauteil mit seinem Namen und seiner Farbe, die
           Unterbaugruppen werden Gruppen unter `name`
    role   "part" (eigenes Teil, Standard), "reference" (mitgebrachtes Teil: halbtransparent, eigener Ast, nicht im
           Export) oder "hardware" (Zukaufteil wie Schrauben: deckend, in der STEP bei seiner Gruppe, nicht in
           export --all). Normteile aus soma.fasteners sind ohne Angabe "hardware"
    color  optional (r, g, b) mit Werten 0..1 (bei einer Baugruppe fuer alle Teile). Normteile haben eine eigene
    group  optional, Gruppe im Bauteilbaum und in der STEP-Datei, verschachtelt mit "/", z. B. "Gehaeuse/Schrauben"
    """
    standard_part = hasattr(obj, "__soma_shape__")
    if role is None:
        role = getattr(obj, "role", "part") if standard_part else "part"
    if color is None and standard_part:
        color = getattr(obj, "color", None)
    if role not in ROLES:
        raise ValueError(f"role muss einer von {ROLES} sein, nicht {role!r}")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("Der Bauteilname muss ein nichtleerer Text sein")
    groups = _group_path(group)
    frame = inspect.currentframe().f_back
    pos = inspect.getframeinfo(frame, context=0).positions  # Startzeile und Endzeile des Aufrufs
    where = dict(file=frame.f_code.co_filename, line=pos.lineno, end_line=pos.end_lineno)
    if isinstance(obj, cq.Assembly):
        leaves = list(_leaves(obj, cq.Location(), (), None))
        if not leaves:
            raise ValueError(f"Die Baugruppe fuer {name!r} enthaelt keine Geometrie")
        if len(leaves) == 1:  # nur ein Koerper: ein Bauteil unter dem angegebenen Namen, ohne eigene Gruppe
            _, _, o, c, loc = leaves[0]
            _register(name, to_shape(o).moved(loc), role, color or (c.toTuple()[:3] if c else None), groups, where)
            return
        taken = {p["name"] for p in REGISTRY}
        for sub_groups, leaf_name, o, c, loc in leaves:
            # Die oberste Baugruppe traegt den Namen aus add_part, darunter die Namen aus der Datei
            path = groups + (name,) + sub_groups[1:]
            nm = _unique(leaf_name or "Teil", taken)
            taken.add(nm)
            _register(nm, to_shape(o).moved(loc), role, color or (c.toTuple()[:3] if c else None), path, where, unique_step=True)
        return
    if any(p["name"] == name for p in REGISTRY):
        raise ValueError(f"Bauteilname {name!r} ist schon vergeben (Namen muessen eindeutig sein)")
    _register(name, to_shape(obj), role, color, groups, where)


def _register(name, shape, role, color, groups, where, unique_step=False):
    step_name = ascii_name(name)
    if any(p["step_name"] == step_name for p in REGISTRY):
        if not unique_step:
            raise ValueError(f"Bauteilname {name!r} ergibt den STEP-Namen {step_name!r}, der schon vergeben ist")
        i = 2
        while any(p["step_name"] == f"{step_name}_{i}" for p in REGISTRY):
            i += 1
        step_name = f"{step_name}_{i}"
    rgb = tuple(color[:3]) if color else DEFAULT_COLORS[role]
    REGISTRY.append(dict(
        name=name, step_name=step_name, role=role, shape=shape, group=tuple(groups),
        color=(*rgb, REFERENCE_ALPHA if role == "reference" else 1.0), **where,
    ))


def import_step(path):
    """Importiert eine mitgebrachte STEP-Datei (z. B. aus inputs/) als eine Form. Teile und Gruppen der Datei gehen
    dabei in einem Koerper auf. Sollen sie erhalten bleiben: import_assembly()."""
    return cq.importers.importStep(str(path)).val()


def import_assembly(path):
    """Importiert eine STEP-Datei mit ihrer Struktur: Teile mit Namen und Farben, Unterbaugruppen als Gruppen.
    Verschieben als Ganzes mit `asm.loc = cq.Location((x, y, z))`, registrieren mit add_part("Name", asm)."""
    return cq.Assembly.importStep(str(path))
