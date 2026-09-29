"""Bauteil-Registrierung: add_part merkt sich Objekt, Rolle, Farbe sowie Datei und Zeilenbereich des Aufrufs."""
import inspect
import unicodedata

import cadquery as cq

REGISTRY = []  # wird pro Build geleert (siehe build.py)
DEFAULT_COLORS = {"part": (0.62, 0.66, 0.72), "reference": (0.1, 0.65, 0.3)}
REFERENCE_ALPHA = 0.45
ROLES = ("part", "reference")

_TRANSLIT = {"ä": "ae", "ö": "oe", "ü": "ue", "Ä": "Ae", "Ö": "Oe", "Ü": "Ue", "ß": "ss", "×": "x"}


def ascii_name(name):
    """STEP-Namen nur ASCII: der OCCT-Export kodiert Nicht-ASCII doppelt (Phase 0, ERGEBNISSE.md)."""
    s = "".join(_TRANSLIT.get(ch, ch) for ch in name)
    s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode("ascii")
    s = "".join(ch if ch.isalnum() or ch in "-_." else "_" for ch in s.strip()).strip("_")
    return s or "part"


def to_shape(obj):
    if isinstance(obj, cq.Workplane):
        vals = obj.vals()
        if not vals:
            raise ValueError("Die Workplane ist leer (keine Geometrie). Pruefe die Operationen davor.")
        return vals[0] if len(vals) == 1 else cq.Compound.makeCompound(vals)
    if isinstance(obj, cq.Shape):
        return obj
    raise TypeError(f"add_part erwartet cq.Workplane oder cq.Shape, nicht {type(obj).__name__}")


def add_part(name, obj, role="part", color=None):
    """Registriert ein Bauteil. Pflicht fuer jedes Bauteil, sonst kennen Viewer und Export es nicht.

    name   eindeutiger Name (Umlaute erlaubt, in der STEP-Datei wird er als ASCII geschrieben)
    obj    cq.Workplane oder cq.Shape
    role   "part" (Standard) oder "reference" (mitgebrachtes Teil: halbtransparent, eigener Ast, nicht im Export)
    color  optional (r, g, b) mit Werten 0..1
    """
    if role not in ROLES:
        raise ValueError(f"role muss einer von {ROLES} sein, nicht {role!r}")
    if not isinstance(name, str) or not name.strip():
        raise ValueError("Der Bauteilname muss ein nichtleerer Text sein")
    if any(p["name"] == name for p in REGISTRY):
        raise ValueError(f"Bauteilname {name!r} ist schon vergeben (Namen muessen eindeutig sein)")
    step_name = ascii_name(name)
    if any(p["step_name"] == step_name for p in REGISTRY):
        raise ValueError(f"Bauteilname {name!r} ergibt den STEP-Namen {step_name!r}, der schon vergeben ist")
    frame = inspect.currentframe().f_back
    pos = inspect.getframeinfo(frame, context=0).positions  # Startzeile und Endzeile des Aufrufs
    rgb = tuple(color[:3]) if color else DEFAULT_COLORS[role]
    REGISTRY.append(dict(
        name=name, step_name=step_name, role=role, shape=to_shape(obj),
        color=(*rgb, REFERENCE_ALPHA if role == "reference" else 1.0),
        file=frame.f_code.co_filename, line=pos.lineno, end_line=pos.end_lineno,
    ))


def import_step(path):
    """Importiert eine mitgebrachte STEP-Datei (z. B. aus inputs/) als Shape."""
    return cq.importers.importStep(str(path)).val()
