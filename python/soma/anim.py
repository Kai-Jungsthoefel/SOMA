"""Animationen (E58): Bewegungen, Kamerafahrten und Texte, beschrieben in animations/*.py.

Der Agent beschreibt eine Animation in Python, aehnlich wie in manim (`play`, `wait`, `run_time`) und mit Drehachsen wie
in CadQuery (`rotate(p1, p2, winkel)`). `soma anim build` fuehrt die Datei aus, tastet die Bewegung ab und schreibt eine
glTF-Animation nach .soma/anim/. Viewer, Video und Bilder entstehen daraus, die Animation selbst ist kein Video.

    from soma.anim import Animation

    a = Animation("Deckel oeffnen")
    lid = a.hinge("Deckel", (0, 20, 25), (1, 20, 25))     # Drehachse durch zwei Punkte, wie cq rotate()
    a.camera.set(view="iso")
    a.caption("Der Deckel oeffnet bis 110 Grad")
    a.play(lid.to(110), run_time=2)
    a.play(a.camera.orbit(90), run_time=3)

Laengen in mm, Winkel in Grad, Zeiten in Sekunden. Bauteile heissen wie in add_part(), Gruppen wie in group=.
"""
import inspect
import math

import numpy as np

from . import registry

ANIMATIONS = []          # fuellt sich beim Ausfuehren einer Animationsdatei (siehe animrun.py)
_PARTS = None            # Bauteile des Modells: Liste von dict(name, group, bbox), setzt animrun.py
SAMPLE_FPS = 30          # Abtastung der Bewegung, der Viewer interpoliert dazwischen
FOV = 35.0               # senkrechter Bildwinkel in Grad, wie im Viewer
MAX_TEXT = 300

VIEWS = {
    "iso": (0.8, -1.2, 0.9), "front": (0, -1, 0), "back": (0, 1, 0), "top": (0, -0.0001, 1),
    "bottom": (0, -0.0001, -1), "right": (1, 0, 0), "left": (-1, 0, 0),
}


def _cubic_in_out(s):
    return 4 * s ** 3 if s < 0.5 else 1 - (-2 * s + 2) ** 3 / 2


EASES = {
    "linear": lambda s: s,
    "smooth": _cubic_in_out,
    "in_out": _cubic_in_out,
    "in": lambda s: s ** 3,
    "out": lambda s: 1 - (1 - s) ** 3,
}


def _ease(ease):
    if callable(ease):
        return ease
    if ease not in EASES:
        raise ValueError(f"ease={ease!r} gibt es nicht. Moeglich: {', '.join(EASES)} oder eine Funktion f(s) fuer s von 0 bis 1")
    return EASES[ease]


# ---- Mathematik (4x4-Matrizen, Quaternionen x, y, z, w wie in glTF) ---------------------------------------------------

def _vec(v, what):
    try:
        a = np.asarray([float(x) for x in v], dtype=float)
    except (TypeError, ValueError):
        raise ValueError(f"{what} muss drei Zahlen haben, z. B. (0, 0, 10), nicht {v!r}") from None
    if a.shape != (3,) or not np.all(np.isfinite(a)):
        raise ValueError(f"{what} muss drei Zahlen haben, z. B. (0, 0, 10), nicht {v!r}")
    return a


def _unit(v, what):
    v = _vec(v, what)
    n = np.linalg.norm(v)
    if n < 1e-12:
        raise ValueError(f"{what} darf nicht die Laenge 0 haben")
    return v / n


def _translation(v):
    m = np.eye(4)
    m[:3, 3] = v
    return m


def _rotation(axis, deg):
    """Drehung um eine Achse durch den Ursprung (Rodrigues)."""
    x, y, z = axis
    a = math.radians(deg)
    c, s, t = math.cos(a), math.sin(a), 1 - math.cos(a)
    m = np.eye(4)
    m[:3, :3] = [[t * x * x + c, t * x * y - s * z, t * x * z + s * y],
                 [t * x * y + s * z, t * y * y + c, t * y * z - s * x],
                 [t * x * z - s * y, t * y * z + s * x, t * z * z + c]]
    return m


def _axis_rotation(p1, axis, deg):
    """Drehung um die Gerade durch p1 mit Richtung axis."""
    return _translation(p1) @ _rotation(axis, deg) @ _translation(-p1)


def _quat(m):
    """Quaternion (x, y, z, w) aus der Drehung einer 4x4-Matrix."""
    r = m[:3, :3]
    tr = r[0, 0] + r[1, 1] + r[2, 2]
    if tr > 0:
        s = math.sqrt(tr + 1.0) * 2
        q = ((r[2, 1] - r[1, 2]) / s, (r[0, 2] - r[2, 0]) / s, (r[1, 0] - r[0, 1]) / s, 0.25 * s)
    elif r[0, 0] > r[1, 1] and r[0, 0] > r[2, 2]:
        s = math.sqrt(1.0 + r[0, 0] - r[1, 1] - r[2, 2]) * 2
        q = (0.25 * s, (r[0, 1] + r[1, 0]) / s, (r[0, 2] + r[2, 0]) / s, (r[2, 1] - r[1, 2]) / s)
    elif r[1, 1] > r[2, 2]:
        s = math.sqrt(1.0 + r[1, 1] - r[0, 0] - r[2, 2]) * 2
        q = ((r[0, 1] + r[1, 0]) / s, 0.25 * s, (r[1, 2] + r[2, 1]) / s, (r[0, 2] - r[2, 0]) / s)
    else:
        s = math.sqrt(1.0 + r[2, 2] - r[0, 0] - r[1, 1]) * 2
        q = ((r[0, 2] + r[2, 0]) / s, (r[1, 2] + r[2, 1]) / s, 0.25 * s, (r[1, 0] - r[0, 1]) / s)
    q = np.asarray(q)
    return q / np.linalg.norm(q)


def _quat_matrix(q):
    x, y, z, w = q
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])


def _slerp(q0, q1, s):
    d = float(np.dot(q0, q1))
    if d < 0:
        q1, d = -q1, -d
    if d > 0.9995:
        q = q0 + (q1 - q0) * s
        return q / np.linalg.norm(q)
    th = math.acos(d)
    return (math.sin((1 - s) * th) * q0 + math.sin(s * th) * q1) / math.sin(th)


def _blend(m0, m1, s):
    """Zwischenlage zweier Lagen: Ursprung geradlinig, Drehung auf kuerzestem Weg."""
    out = np.eye(4)
    out[:3, :3] = _quat_matrix(_slerp(_quat(m0), _quat(m1), s))
    out[:3, 3] = m0[:3, 3] + (m1[:3, 3] - m0[:3, 3]) * s
    return out


def _placement(loc):
    """Lage als 4x4-Matrix: cq.Location, eine 4x4-Matrix oder (x, y, z) fuer eine reine Verschiebung."""
    if hasattr(loc, "wrapped") and hasattr(loc.wrapped, "Transformation"):  # cq.Location
        t = loc.wrapped.Transformation()
        m = np.eye(4)
        for r in range(3):
            for c in range(4):
                m[r, c] = t.Value(r + 1, c + 1)
        return m
    a = np.asarray(loc, dtype=float) if not isinstance(loc, str) else None
    if a is not None and a.shape == (4, 4):
        return a.copy()
    return _translation(_vec(loc, "Die Lage"))


# ---- Bauteile ---------------------------------------------------------------------------------------------------

def _parts():
    if _PARTS is None:
        raise RuntimeError("Animationen laufen ueber `soma anim build` (dort kennt soma die Bauteile des Modells), "
                           "nicht direkt mit python.")
    return _PARTS


def _resolve(spec, what="Bauteil"):
    """Bauteilname, Gruppe ("Gehaeuse" oder "Gehaeuse/Schrauben") oder eine Liste davon -> Liste von Bauteilnamen."""
    parts = _parts()
    if isinstance(spec, (list, tuple, set)):
        out = []
        for s in spec:
            for n in _resolve(s, what):
                if n not in out:
                    out.append(n)
        if not out:
            raise ValueError(f"{what}: leere Liste")
        return out
    if not isinstance(spec, str) or not spec.strip():
        raise ValueError(f"{what} muss ein Bauteilname oder eine Gruppe sein, nicht {spec!r}")
    if any(p["name"] == spec for p in parts):
        return [spec]
    path = spec.strip("/")
    hit = [p["name"] for p in parts if p["group"] and ("/".join(p["group"]) == path or "/".join(p["group"]).startswith(path + "/"))]
    if hit:
        return hit
    names = ", ".join(repr(p["name"]) for p in parts[:30]) + (" ..." if len(parts) > 30 else "")
    groups = sorted({"/".join(p["group"][:i + 1]) for p in parts for i in range(len(p["group"]))})
    extra = f" Gruppen: {', '.join(repr(g) for g in groups)}." if groups else ""
    raise ValueError(f"{what} {spec!r} gibt es im Modell nicht. Bauteile: {names}.{extra}")


def _where():
    """Datei und Zeile des Aufrufs im Projekt (fuer Fehlermeldungen und die Anzeige)."""
    frame = inspect.currentframe().f_back.f_back
    return frame.f_code.co_filename, frame.f_lineno


def _text(text, what):
    if not isinstance(text, str):
        raise ValueError(f"{what} muss ein Text sein, nicht {type(text).__name__}")
    t = " ".join(text.split())
    if len(t) > MAX_TEXT:
        raise ValueError(f"{what} ist laenger als {MAX_TEXT} Zeichen")
    return t


def _num(v, what, lo=None):
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise ValueError(f"{what} muss eine Zahl sein, nicht {v!r}") from None
    if not math.isfinite(f) or (lo is not None and f < lo):
        raise ValueError(f"{what} muss eine Zahl{'' if lo is None else f' ab {lo}'} sein, nicht {v!r}")
    return f


# ---- Gelenke ----------------------------------------------------------------------------------------------------

class _Action:
    """Eine Bewegung, die play() in die Zeitleiste legt. `target` ist ein Gelenk oder die Kamera."""

    def __init__(self, target, make, describe):
        self.target, self.make, self.describe = target, make, describe


class Joint:
    """Bauteile, die sich gemeinsam bewegen. Entsteht ueber Animation.hinge(), slider() oder part()."""

    unit = None  # Einheit des Gelenkwerts (Grad, mm), None bei frei bewegten Teilen

    def __init__(self, anim, kind, parts, parent, value):
        self.anim, self.kind, self.parts, self.parent = anim, kind, parts, parent
        self.value = value            # Stand am Ende der bisher beschriebenen Zeitleiste
        self.start = value
        self.segments = []            # (t0, t1, f(s) -> Wert, ease)
        self.label = ", ".join(parts[:3]) + (" ..." if len(parts) > 3 else "")

    def _own(self, value):
        raise NotImplementedError

    def value_at(self, t):
        v = self.start
        for t0, t1, f, ease in self.segments:
            if t >= t1:
                v = f(1.0)
            elif t >= t0:
                return f(ease((t - t0) / (t1 - t0)) if t1 > t0 else 1.0)
            else:
                break
        return v

    def matrix(self, t):
        """Lage aller Bauteile dieses Gelenks zur Zeit t (mit den Gelenken darueber)."""
        m = self._own(self.value_at(t))
        return self.parent.matrix(t) @ m if self.parent else m


class _Hinge(Joint):
    unit = "Grad"

    def __init__(self, anim, parts, p1, axis, parent, angle):
        super().__init__(anim, "hinge", parts, parent, angle)
        self.p1, self.axis = p1, axis

    def _own(self, value):
        return _axis_rotation(self.p1, self.axis, value)

    def to(self, angle):
        """Auf diesen Winkel drehen (Grad, 0 = Lage im Modell)."""
        a1 = _num(angle, "Der Winkel")
        return _Action(self, lambda a0: (lambda s: a0 + (a1 - a0) * s, a1), lambda a0: f"{self.label}: {a0:g} -> {a1:g} Grad")

    def by(self, delta):
        """Um diesen Winkel weiterdrehen (Grad)."""
        d = _num(delta, "Der Winkel")
        return _Action(self, lambda a0: (lambda s: a0 + d * s, a0 + d), lambda a0: f"{self.label}: {a0:g} -> {a0 + d:g} Grad")


class _Slider(Joint):
    unit = "mm"

    def __init__(self, anim, parts, direction, parent, position):
        super().__init__(anim, "slider", parts, parent, position)
        self.direction = direction

    def _own(self, value):
        return _translation(self.direction * value)

    def to(self, distance):
        """An diese Stelle schieben (mm entlang der Richtung, 0 = Lage im Modell)."""
        d1 = _num(distance, "Der Weg")
        return _Action(self, lambda d0: (lambda s: d0 + (d1 - d0) * s, d1), lambda d0: f"{self.label}: {d0:g} -> {d1:g} mm")

    def by(self, delta):
        """Um diesen Weg weiterschieben (mm)."""
        d = _num(delta, "Der Weg")
        return _Action(self, lambda d0: (lambda s: d0 + d * s, d0 + d), lambda d0: f"{self.label}: {d0:g} -> {d0 + d:g} mm")


class _Free(Joint):
    def __init__(self, anim, parts, parent):
        super().__init__(anim, "free", parts, parent, np.eye(4))

    def _own(self, value):
        return value

    def to(self, location):
        """In diese Lage bewegen (cq.Location oder (x, y, z), bezogen auf die Lage im Modell). Ohne Drehachse geht der
        Ursprung geradlinig: Fuer Drehungen um eine Achse hinge() oder rotate() nehmen."""
        m1 = _placement(location)
        return _Action(self, lambda m0: (lambda s: _blend(m0, m1, s), m1), lambda m0: f"{self.label}: in neue Lage")

    def translate(self, vector):
        """Um diesen Vektor verschieben (mm)."""
        v = _vec(vector, "Die Verschiebung")
        return _Action(self, lambda m0: (lambda s: _translation(v * s) @ m0, _translation(v) @ m0),
                       lambda m0: f"{self.label}: verschieben um ({v[0]:g}, {v[1]:g}, {v[2]:g}) mm")

    def rotate(self, p1, p2, angle):
        """Um die Achse durch p1 und p2 drehen (Grad), wie cq rotate(). Die Achse liegt im Modell, nicht im Teil."""
        a, b = _vec(p1, "Der erste Achspunkt"), _vec(p2, "Der zweite Achspunkt")
        axis = _unit(b - a, "Die Drehachse (p2 - p1)")
        deg = _num(angle, "Der Winkel")
        return _Action(self, lambda m0: (lambda s: _axis_rotation(a, axis, deg * s) @ m0, _axis_rotation(a, axis, deg) @ m0),
                       lambda m0: f"{self.label}: drehen um {deg:g} Grad")


# ---- Kamera -----------------------------------------------------------------------------------------------------

class Camera:
    """Kamera einer Animation. set() springt, move(), orbit() und zoom() sind Bewegungen fuer play()."""

    def __init__(self, anim):
        self.anim = anim
        self.ops = []   # dict(t0, t1, kind, spec, ease)

    def _spec(self, view, fit, zoom, target, distance):
        spec = {}
        if view is not None:
            if isinstance(view, str):
                if view not in VIEWS:
                    raise ValueError(f"view={view!r} gibt es nicht. Moeglich: {', '.join(VIEWS)} oder eine Richtung (x, y, z)")
                spec["dir"] = _unit(VIEWS[view], "Die Blickrichtung")
            else:
                spec["dir"] = _unit(view, "Die Blickrichtung (von der Mitte zur Kamera)")
            spec["view"] = view if isinstance(view, str) else "Richtung"
        if fit is not None:
            spec["fit"] = None if fit == "all" else _resolve(fit, "fit")
        if zoom is not None:
            spec["zoom"] = _num(zoom, "zoom", 0.01)
        if target is not None:
            spec["target"] = _vec(target, "target")
        if distance is not None:
            spec["distance"] = _num(distance, "distance", 0.01)
        return spec

    def set(self, view=None, fit=None, zoom=None, target=None, distance=None):
        """Kamera sofort setzen. view: "iso", "front", "back", "left", "right", "top", "bottom" oder eine Richtung von der
        Mitte zur Kamera. fit: Bauteile oder Gruppen, die ganz ins Bild sollen (ueber die ganze Bewegung), Standard alle.
        zoom: groesser als 1 naeher heran. target und distance setzen Mitte und Abstand (mm) direkt."""
        spec = self._spec(view, fit, zoom, target, distance)
        if "fit" not in spec and "target" not in spec and "distance" not in spec:
            spec["fit"] = None  # ohne Angabe: alles einpassen
        t = self.anim.time
        self.ops.append(dict(t0=t, t1=t, kind="set", spec=spec, ease=EASES["linear"]))
        self.anim._step(t, t, "Kamera: " + _describe_camera(spec))

    def move(self, view=None, fit=None, zoom=None, target=None, distance=None):
        """Kamerafahrt zu einer neuen Ansicht (fuer play). Was nicht angegeben ist, bleibt: Ohne fit, target und distance
        bleiben Mitte und Abstand, und die Kamera schwenkt nur."""
        spec = self._spec(view, fit, zoom, target, distance)
        return _Action(self, ("move", spec), lambda _v: "Kamera: Fahrt " + _describe_camera(spec))

    def orbit(self, degrees, tilt=0.0):
        """Um die Mitte kreisen (Grad um die Hochachse Z, positiv gegen den Uhrzeigersinn von oben). tilt hebt oder
        senkt die Kamera (Grad)."""
        spec = dict(orbit=_num(degrees, "Der Winkel"), tilt=_num(tilt, "tilt"))
        return _Action(self, ("orbit", spec), lambda _v: f"Kamera: Umlauf {spec['orbit']:g} Grad" + (f", Neigung {spec['tilt']:g} Grad" if spec["tilt"] else ""))

    def zoom(self, factor):
        """Naeher heran (factor groesser als 1) oder weiter weg (kleiner als 1)."""
        f = _num(factor, "Der Faktor", 0.01)
        return _Action(self, ("zoom", dict(zoom=f)), lambda _v: f"Kamera: Zoom x{f:g}")


def _describe_camera(spec):
    bits = []
    if "view" in spec:
        bits.append(f"Ansicht {spec['view']}")
    if "fit" in spec:
        bits.append("alles im Bild" if spec["fit"] is None else f"im Bild: {', '.join(spec['fit'][:4])}")
    if "zoom" in spec:
        bits.append(f"Zoom x{spec['zoom']:g}")
    if "target" in spec:
        bits.append("Mitte ({:g}, {:g}, {:g})".format(*spec["target"]))
    if "distance" in spec:
        bits.append(f"Abstand {spec['distance']:g} mm")
    return ", ".join(bits) or "unveraendert"


# ---- Animation --------------------------------------------------------------------------------------------------

class Animation:
    """Eine Animation mit Namen. Mehrere je Datei sind erlaubt, Namen muessen im Projekt eindeutig sein.

    Zeitleiste wie in manim: play() bewegt (alle uebergebenen Bewegungen gleichzeitig) und rueckt die Zeit um run_time
    weiter, wait() wartet, title() zeigt eine Titelkarte und rueckt weiter. caption(), label(), highlight(), hide(),
    show() und ghost() gelten ab der aktuellen Zeit und ruecken nicht weiter.
    """

    def __init__(self, name):
        self.name = _text(name, "Der Name der Animation")
        if not self.name:
            raise ValueError("Die Animation braucht einen Namen, z. B. Animation(\"Deckel oeffnen\")")
        self.id = registry.ascii_name(self.name).lower().replace("_", "-")
        self.file, self.line = _where()
        self.time = 0.0
        self.joints, self.camera = [], Camera(self)
        self.captions, self.titles, self.labels, self.events, self.steps = [], [], [], [], []
        _parts()
        ANIMATIONS.append(self)

    # -- Gelenke --

    def _joint(self, joint):
        for j in self.joints:
            twice = set(j.parts) & set(joint.parts)
            if twice:
                raise ValueError(f"{sorted(twice)[0]!r} haengt schon an einem Gelenk dieser Animation. Ein Bauteil hat "
                                 "ein Gelenk, Bewegungen darueber kommen mit parent=.")
        if joint.parent is not None and not isinstance(joint.parent, Joint):
            raise ValueError("parent muss ein Gelenk dieser Animation sein (Rueckgabe von hinge(), slider() oder part())")
        self.joints.append(joint)
        return joint

    def hinge(self, parts, p1, p2, parent=None, angle=0.0):
        """Drehgelenk: Bauteile (Name, Gruppe oder Liste) drehen um die Achse durch p1 und p2, wie cq rotate(p1, p2, w).
        Positive Winkel drehen rechtsherum um die Richtung p2 - p1. angle ist der Winkel am Anfang (Grad, 0 = wie im
        Modell). parent: Gelenk, auf dem dieses sitzt (die Achse liegt dann in der Modelllage)."""
        a, b = _vec(p1, "Der erste Achspunkt"), _vec(p2, "Der zweite Achspunkt")
        return self._joint(_Hinge(self, _resolve(parts), a, _unit(b - a, "Die Drehachse (p2 - p1)"), parent, _num(angle, "angle")))

    def slider(self, parts, direction, parent=None, position=0.0):
        """Schubgelenk: Bauteile verschieben sich entlang direction. position ist der Weg am Anfang (mm)."""
        return self._joint(_Slider(self, _resolve(parts), _unit(direction, "Die Richtung"), parent, _num(position, "position")))

    def part(self, parts, parent=None):
        """Frei bewegte Bauteile: to(lage), translate((x, y, z)), rotate(p1, p2, winkel)."""
        return self._joint(_Free(self, _resolve(parts), parent))

    # -- Zeitleiste --

    def _step(self, t0, t1, text, **move):
        """Eintrag im Ablauf. move (bei Bewegungen): key (Gelenk oder Kamera), label, unit, v0, v1 bzw. orbit, tilt.
        Damit fasst `soma anim info` viele kurze Schritte desselben Gelenks zu einer Zeile zusammen."""
        self.steps.append(dict(start=round(t0, 4), end=round(t1, 4), text=text, **move))

    def play(self, *actions, run_time=1.0, ease="smooth"):
        """Bewegungen gleichzeitig ablaufen lassen, dann geht die Zeit um run_time (Sekunden) weiter.
        ease: "smooth" (Standard, sanft an und aus), "linear", "in", "out" oder eine Funktion f(s)."""
        rt = _num(run_time, "run_time", 0.0)
        f = _ease(ease)
        if not actions:
            raise ValueError("play() braucht mindestens eine Bewegung, z. B. play(deckel.to(90)). Zum Warten: wait()")
        seen = set()
        t0, t1 = self.time, self.time + rt
        for act in actions:
            if not isinstance(act, _Action):
                raise ValueError(f"play() erwartet Bewegungen wie gelenk.to(90) oder a.camera.orbit(90), nicht {act!r}")
            if id(act.target) in seen:
                raise ValueError("Ein Gelenk (oder die Kamera) kommt zweimal im selben play() vor")
            seen.add(id(act.target))
            if isinstance(act.target, Camera):
                kind, spec = act.make
                act.target.ops.append(dict(t0=t0, t1=t1, kind=kind, spec=spec, ease=f))
                self._step(t0, t1, act.describe(None), key="camera",
                           **(dict(orbit=spec["orbit"], tilt=spec["tilt"]) if kind == "orbit" else {}))
                continue
            j = act.target
            if j.anim is not self:
                raise ValueError("Diese Bewegung gehoert zu einer anderen Animation")
            func, end = act.make(j.value)
            j.segments.append((t0, t1, func, f))
            move = dict(key=f"joint{self.joints.index(j)}", label=j.label)
            if j.unit:
                move.update(unit=j.unit, v0=round(float(j.value), 4), v1=round(float(end), 4))
            self._step(t0, t1, act.describe(j.value), **move)
            j.value = end
        self.time = t1

    def wait(self, seconds=1.0):
        """Nichts bewegt sich, die Zeit geht weiter."""
        s = _num(seconds, "Die Wartezeit", 0.0)
        self._step(self.time, self.time + s, "Pause")
        self.time += s

    # -- Texte und Hervorhebungen --

    def title(self, text, subtitle=None, duration=2.0):
        """Titelkarte in der Bildmitte. Die Zeit geht um duration weiter (wie wait)."""
        d = _num(duration, "duration", 0.0)
        t = dict(start=self.time, end=self.time + d, text=_text(text, "Der Titel"))
        if subtitle:
            t["subtitle"] = _text(subtitle, "Der Untertitel")
        self.titles.append(t)
        self._step(self.time, self.time + d, f"Titel: {t['text']}")
        self.time += d

    def caption(self, text, duration=None):
        """Untertitel unten im Bild, ab jetzt bis zum naechsten Untertitel (oder duration Sekunden). caption(None) blendet aus."""
        if text is None or text == "":
            self.captions.append(dict(start=self.time, end=None, text=""))
            return
        d = None if duration is None else _num(duration, "duration", 0.0)
        c = dict(start=self.time, end=None if d is None else self.time + d, text=_text(text, "Der Untertitel"))
        self.captions.append(c)
        self._step(self.time, self.time if d is None else self.time + d, f"Untertitel: {c['text']}")

    def label(self, text, part=None, at=None, duration=None):
        """Beschriftung an einer Stelle im Modell, ab jetzt (bis zum Ende oder duration Sekunden). part: Das Schild wandert
        mit diesem Bauteil. at: Punkt (mm, in der Lage im Modell), ohne at die Mitte des Bauteils."""
        if part is None and at is None:
            raise ValueError("label() braucht part= oder at=")
        names = _resolve(part, "part") if part is not None else []
        if len(names) > 1:
            raise ValueError(f"label(part=...) braucht ein einzelnes Bauteil, {part!r} sind {len(names)}")
        d = None if duration is None else _num(duration, "duration", 0.0)
        lb = dict(start=self.time, end=None if d is None else self.time + d, text=_text(text, "Die Beschriftung"),
                  part=names[0] if names else None, at=None if at is None else [float(x) for x in _vec(at, "at")])
        self.labels.append(lb)
        self._step(self.time, self.time, f"Beschriftung: {lb['text']}")

    def _event(self, kind, parts, what):
        names = _resolve(parts)
        self.events.append(dict(t=self.time, kind=kind, parts=names))
        self._step(self.time, self.time, f"{what}: {', '.join(names[:4])}{' ...' if len(names) > 4 else ''}")

    def highlight(self, parts, duration=None):
        """Bauteile hervorheben (orange), ab jetzt bis unhighlight() oder duration Sekunden."""
        self._event("highlight", parts, "Hervorheben")
        if duration is not None:
            d = _num(duration, "duration", 0.0)
            self.events.append(dict(t=self.time + d, kind="unhighlight", parts=_resolve(parts)))

    def unhighlight(self, parts):
        self._event("unhighlight", parts, "Hervorhebung aus")

    def hide(self, parts):
        """Bauteile ausblenden (bis show())."""
        self._event("hide", parts, "Ausblenden")

    def show(self, parts):
        self._event("show", parts, "Einblenden")

    def ghost(self, parts, on=True):
        """Bauteile durchsichtig zeigen (on=False: wieder deckend). So sieht man, was dahinter liegt."""
        self._event("ghost" if on else "solid", parts, "Durchsichtig" if on else "Wieder deckend")

    # -- Auswertung (fuer animrun.py) --

    @property
    def duration(self):
        ends = [self.time] + [e["t"] for e in self.events]
        ends += [c["end"] for c in self.captions + self.labels if c["end"] is not None]
        return max(ends)

    def part_joint(self):
        """Bauteilname -> Gelenk."""
        return {p: j for j in self.joints for p in j.parts}

    def moving_parts(self):
        return [p for j in self.joints for p in j.parts]

    def poses(self, t):
        """Lage jedes bewegten Bauteils zur Zeit t (4x4-Matrix)."""
        return {p: j.matrix(t) for j in self.joints for p in j.parts}
