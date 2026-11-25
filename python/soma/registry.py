"""Part registry: add_part records the object, role and color plus the file and line range of the call."""
import inspect
import math
import unicodedata

import cadquery as cq

REGISTRY = []  # wird pro Build geleert (siehe build.py)
# Beim Ausfuehren von Animationsdateien (animrun.py): Die Bauteile sind schon bekannt. Importiert eine Animation das Modell
# (`from model import HINGE_Y`), laeuft model.py ein zweites Mal, add_part() bleibt dann wirkungslos.
IGNORE_ADD = False
# Warnings of imported FreeCAD files (objects that could not be read), cleared per build like REGISTRY
IMPORT_WARNINGS = []
DEFAULT_COLORS = {"part": (0.62, 0.66, 0.72), "reference": (0.1, 0.65, 0.3), "hardware": (0.45, 0.46, 0.49)}
REFERENCE_ALPHA = 0.45
ROLES = ("part", "reference", "hardware")

_TRANSLIT = {"ä": "ae", "ö": "oe", "ü": "ue", "Ä": "Ae", "Ö": "Oe", "Ü": "Ue", "ß": "ss", "×": "x"}


def ascii_name(name):
    """STEP-Namen nur ASCII: der OCCT-Export kodiert Nicht-ASCII doppelt (Phase 0, docs/phase0-ergebnisse.md)."""
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
    """Teile einer Baugruppe mit Lage, Gruppenpfad und Farbe (ohne eigene Farbe gilt die der Gruppe darueber).
    Also the metadata of the node: role and opacity of the parts of a component (components.py)."""
    loc = loc * node.loc
    color = node.color if node.color is not None else color
    meta = getattr(node, "metadata", None) or {}
    label = meta.get("soma_name") or node.name  # components.py keeps the real name here when cq.Assembly needs another
    if node.obj is not None:
        yield groups, label, node.obj, color, loc, meta
    for child in node.children:
        yield from _leaves(child, loc, groups + (label,), color)


def _unique(name, taken):
    """Name, der noch nicht vergeben ist: bei Gleichstand "Schraube (2)" (Hersteller-STEP wiederholen Namen oft)."""
    if name not in taken:
        return name
    i = 2
    while f"{name} ({i})" in taken:
        i += 1
    return f"{name} ({i})"


def add_part(name, obj, role=None, color=None, group=None, alpha=None):
    """Registers a part. Required for every part, otherwise the viewer and the export do not know it.

    name   unique name (any characters, in the STEP file it is written as ASCII)
    obj    cq.Workplane or cq.Shape, a standard part from soma.fasteners (Screw, Nut ...) or an assembly from
           import_assembly() or component(): then every body becomes a part of its own with its name and color,
           the sub-assemblies become groups under `name`
    role   "part" (own part, default), "reference" (part brought along: semi-transparent, own branch, not in the
           export) or "hardware" (purchased part like screws: opaque, in the STEP file with its group, not in
           export --all). Standard parts from soma.fasteners are "hardware" if not given
    color  optional (r, g, b) with values 0..1 (for an assembly for all parts). Standard parts have their own
    group  optional, group in the part tree and in the STEP file, nested with "/", e.g. "Housing/Screws"
    alpha  optional opacity above 0 up to 1 (opaque). References are 0.45 if not given: alpha=1 makes an
           opaque reference, e.g. a floor or a logo for an animation that should not be exported
    """
    if IGNORE_ADD:
        return
    if alpha is not None:
        try:
            alpha = float(alpha)
        except (TypeError, ValueError):
            raise ValueError(f"alpha must be a number above 0 up to 1, not {alpha!r}") from None
        if not 0 < alpha <= 1:  # faengt auch nan ab. Unsichtbar: in Animationen hide()
            raise ValueError(f"alpha must be a number above 0 up to 1, not {alpha!r}")
    frame = inspect.currentframe().f_back
    pos = inspect.getframeinfo(frame, context=0).positions  # Startzeile und Endzeile des Aufrufs
    _add(name, obj, role, color, group, dict(file=frame.f_code.co_filename, line=pos.lineno, end_line=pos.end_lineno), alpha=alpha)


def _add(name, obj, role, color, group, where, alpha=None):
    """add_part ohne Blick auf den Aufrufer: Der Kompatibilitaetsmodus (cqcompat.py) nennt die Stelle von show_object().
    `alpha` < 1: halbtransparent wie in CQ-editor (options={"alpha": ...}). Unbrauchbare Werte gelten als nicht angegeben."""
    standard_part = hasattr(obj, "__soma_shape__")
    if isinstance(obj, cq.Assembly):
        _add_assembly(name, obj, role, color, _group_path(group), where, alpha)
        return
    if role is None:
        role = getattr(obj, "role", "part") if standard_part else "part"
    if color is None and standard_part:
        color = getattr(obj, "color", None)
    if role not in ROLES:
        raise ValueError(f"role must be one of {ROLES}, not {role!r}")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("The part name must be a non-empty text")
    groups = _group_path(group)
    if any(p["name"] == name for p in REGISTRY):
        owner = next(p for p in REGISTRY if p["name"] == name).get("component")
        hint = (f" by a part of the component in the group {owner['group']!r}. Choose another name" if owner else
                " (names must be unique)")
        raise ValueError(f"Part name {name!r} is already taken{hint}")
    _register(name, to_shape(obj), role, color, groups, where, axis=_axis(obj), fastener=obj if standard_part else None, alpha=alpha)


def _add_assembly(name, obj, role, color, groups, where, alpha):
    """An assembly from import_assembly() or component(): every body becomes a part, sub-assemblies become groups.
    Parts of a component keep their own role and opacity unless add_part gives one."""
    if role is not None and role not in ROLES:
        raise ValueError(f"role must be one of {ROLES}, not {role!r}")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("The part name must be a non-empty text")
    comp = (getattr(obj, "metadata", None) or {}).get("soma_component")
    leaves = list(_leaves(obj, cq.Location(), (), None))
    if not leaves:
        raise ValueError(f"The assembly for {name!r} contains no geometry")
    # Only one body: one part under the given name, without a group of its own. A component always gets its group,
    # the app recognizes the instance by it
    if len(leaves) == 1 and not comp:
        _, _, o, c, loc, _meta = leaves[0]
        _register(name, to_shape(o).moved(loc), role or "part", color or (c.toTuple()[:3] if c else None), groups, where, alpha=alpha)
        return
    taken = {p["name"] for p in REGISTRY}
    inst = groups + (name,)
    if comp and any(p["group"][:len(inst)] == inst for p in REGISTRY):
        raise ValueError(f"There is already a group {'/'.join(inst)!r}: give every instance of a component its own name")
    info = dict(name=comp, group="/".join(inst)) if comp else None
    for sub_groups, leaf_name, o, c, loc, meta in leaves:
        # The top assembly carries the name from add_part, below it the names from the file or the component
        path = inst + sub_groups[1:]
        nm = leaf_name or "Part"
        if comp and nm in taken:  # a component used several times: "Front (Drawer 2)"
            nm = f"{nm} ({name})"
        nm = _unique(nm, taken)
        taken.add(nm)
        leaf_role = role or meta.get("soma_role") or "part"
        leaf_alpha = alpha if alpha is not None else meta.get("soma_alpha")
        # A standard part of a component: moved with the instance, so exploding and FEM bolt() know where it is
        fastener = meta.get("soma_fastener")
        fastener = fastener.moved(loc) if fastener is not None and hasattr(fastener, "moved") else None
        _register(nm, to_shape(o).moved(loc), leaf_role, color or (c.toTuple()[:3] if c else None), path, where, unique_step=True,
                  alpha=leaf_alpha, component=info, axis=_axis(fastener) if fastener is not None else None, fastener=fastener)


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


def _register(name, shape, role, color, groups, where, unique_step=False, axis=None, fastener=None, alpha=None, component=None):
    step_name = ascii_name(name)
    if any(p["step_name"] == step_name for p in REGISTRY):
        if not unique_step:
            raise ValueError(f"Part name {name!r} gives the STEP name {step_name!r}, which is already taken")
        i = 2
        while any(p["step_name"] == f"{step_name}_{i}" for p in REGISTRY):
            i += 1
        step_name = f"{step_name}_{i}"
    rgb = tuple(color[:3]) if color else DEFAULT_COLORS[role]
    if alpha is None or not 0 < alpha <= 1:
        alpha = REFERENCE_ALPHA if role == "reference" else 1.0
    REGISTRY.append(dict(
        name=name, step_name=step_name, role=role, shape=shape, group=tuple(groups),
        color=(*rgb, alpha), axis=axis, **where,
        # Das Normteil selbst (Screw, Nut ...), nur im Speicher: soma.fem liest daraus Groesse, Kopf und Lage (bolt())
        fastener=fastener,
        # Instance of a component (components.py): its folder and the group of the instance, for the app
        component=component,
    ))


def _import_notes(path, res):
    """Warnings of a FreeCAD import go into the build result (soma build prints them, the app shows them)."""
    for w in res.warnings:
        text = f"{path}: {w}"
        if text not in IMPORT_WARNINGS:
            IMPORT_WARNINGS.append(text)


def import_step(path):
    """Imports a STEP file brought along (e.g. from inputs/) as one shape. The parts and groups of the file merge into
    one body. To keep them: import_assembly(). Also reads FreeCAD files (.FCStd): the geometry of the visible objects."""
    from . import fcstd
    if fcstd.is_fcstd(path):
        shape, res = fcstd.read_shape(path)
        _import_notes(path, res)
        return shape
    from . import stepimport
    return stepimport.read_shape(path)


def import_assembly(path):
    """Imports a STEP file with its structure: parts with names and colors, sub-assemblies as groups.
    Move it as a whole with `asm.loc = cq.Location((x, y, z))`, register it with add_part("Name", asm).
    A file without an assembly (a single body, or several side by side) gives one part per body.
    FreeCAD files (.FCStd) work the same: the visible bodies and objects with their labels and colors, App::Part
    containers and groups as groups. Only the geometry comes along, not the parametric history."""
    from . import fcstd
    if fcstd.is_fcstd(path):
        asm, res = fcstd.read_assembly(path)
        _import_notes(path, res)
        return asm
    from . import stepimport
    return stepimport.read_assembly(path)
