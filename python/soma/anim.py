"""Animations: movements, camera moves and texts, described in animations/*.py.

An animation is described in Python, similar to manim (`play`, `wait`, `run_time`) and with rotation axes as in
CadQuery (`rotate(p1, p2, angle)`). `soma anim build` runs the file, samples the movement and writes a glTF animation
to .soma/anim/. The viewer, videos and pictures are made from it, the animation itself is not a video.

    from soma.anim import Animation

    a = Animation("Open lid")
    lid = a.hinge("Lid", (0, 20, 25), (1, 20, 25))     # rotation axis through two points, like cq rotate()
    a.camera.set(view="iso")
    a.caption("The lid opens to 110 degrees")
    a.play(lid.to(110), run_time=2)
    a.play(a.camera.orbit(90), run_time=3)

Lengths in mm, angles in degrees, times in seconds. Parts are named as in add_part(), groups as in group=.
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
        raise ValueError(f"ease={ease!r} does not exist. Possible: {', '.join(EASES)} or a function f(s) for s from 0 to 1")
    return EASES[ease]


# ---- Mathematik (4x4-Matrizen, Quaternionen x, y, z, w wie in glTF) ---------------------------------------------------

def _vec(v, what):
    try:
        a = np.asarray([float(x) for x in v], dtype=float)
    except (TypeError, ValueError):
        raise ValueError(f"{what} needs three numbers, e.g. (0, 0, 10), not {v!r}") from None
    if a.shape != (3,) or not np.all(np.isfinite(a)):
        raise ValueError(f"{what} needs three numbers, e.g. (0, 0, 10), not {v!r}")
    return a


def _unit(v, what):
    v = _vec(v, what)
    n = np.linalg.norm(v)
    if n < 1e-12:
        raise ValueError(f"{what} must not have length 0")
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
    return _translation(_vec(loc, "The location"))


# ---- Bauteile ---------------------------------------------------------------------------------------------------

def _parts():
    if _PARTS is None:
        raise RuntimeError("Animations run through `soma anim build` (there soma knows the parts of the model), "
                           "not directly with python.")
    return _PARTS


def _resolve(spec, what="Part"):
    """Bauteilname, Gruppe ("Gehaeuse" oder "Gehaeuse/Schrauben") oder eine Liste davon -> Liste von Bauteilnamen."""
    parts = _parts()
    if isinstance(spec, (list, tuple, set)):
        out = []
        for s in spec:
            for n in _resolve(s, what):
                if n not in out:
                    out.append(n)
        if not out:
            raise ValueError(f"{what}: empty list")
        return out
    if not isinstance(spec, str) or not spec.strip():
        raise ValueError(f"{what} must be a part name or a group, not {spec!r}")
    if any(p["name"] == spec for p in parts):
        return [spec]
    path = spec.strip("/")
    hit = [p["name"] for p in parts if p["group"] and ("/".join(p["group"]) == path or "/".join(p["group"]).startswith(path + "/"))]
    if hit:
        return hit
    names = ", ".join(repr(p["name"]) for p in parts[:30]) + (" ..." if len(parts) > 30 else "")
    groups = sorted({"/".join(p["group"][:i + 1]) for p in parts for i in range(len(p["group"]))})
    extra = f" Groups: {', '.join(repr(g) for g in groups)}." if groups else ""
    raise ValueError(f"{what} {spec!r} does not exist in the model. Parts: {names}.{extra}")


def _where():
    """Datei und Zeile des Aufrufs im Projekt (fuer Fehlermeldungen und die Anzeige)."""
    frame = inspect.currentframe().f_back.f_back
    return frame.f_code.co_filename, frame.f_lineno


def _text(text, what):
    if not isinstance(text, str):
        raise ValueError(f"{what} must be a text, not {type(text).__name__}")
    t = " ".join(text.split())
    if len(t) > MAX_TEXT:
        raise ValueError(f"{what} is longer than {MAX_TEXT} characters")
    return t


def _num(v, what, lo=None):
    try:
        f = float(v)
    except (TypeError, ValueError):
        raise ValueError(f"{what} must be a number, not {v!r}") from None
    if not math.isfinite(f) or (lo is not None and f < lo):
        raise ValueError(f"{what} must be a number{'' if lo is None else f' of at least {lo}'}, not {v!r}")
    return f


# ---- Gelenke ----------------------------------------------------------------------------------------------------

class _Action:
    """Eine Bewegung, die play() in die Zeitleiste legt. `target` ist ein Gelenk oder die Kamera."""

    def __init__(self, target, make, describe):
        self.target, self.make, self.describe = target, make, describe


class Joint:
    """Parts that move together. Created by Animation.hinge(), slider() or part()."""

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
        """Position of all parts of this joint at time t (including the joints above it), as a 4x4 matrix."""
        m = self._own(self.value_at(t))
        return self.parent.matrix(t) @ m if self.parent else m


class _Hinge(Joint):
    unit = "deg"

    def __init__(self, anim, parts, p1, axis, parent, angle):
        super().__init__(anim, "hinge", parts, parent, angle)
        self.p1, self.axis = p1, axis

    def _own(self, value):
        return _axis_rotation(self.p1, self.axis, value)

    def to(self, angle):
        """Rotate to this angle (degrees, 0 = position in the model)."""
        a1 = _num(angle, "The angle")
        return _Action(self, lambda a0: (lambda s: a0 + (a1 - a0) * s, a1), lambda a0: f"{self.label}: {a0:g} -> {a1:g} deg")

    def by(self, delta):
        """Rotate further by this angle (degrees)."""
        d = _num(delta, "The angle")
        return _Action(self, lambda a0: (lambda s: a0 + d * s, a0 + d), lambda a0: f"{self.label}: {a0:g} -> {a0 + d:g} deg")


class _Slider(Joint):
    unit = "mm"

    def __init__(self, anim, parts, direction, parent, position):
        super().__init__(anim, "slider", parts, parent, position)
        self.direction = direction

    def _own(self, value):
        return _translation(self.direction * value)

    def to(self, distance):
        """Slide to this position (mm along the direction, 0 = position in the model)."""
        d1 = _num(distance, "The distance")
        return _Action(self, lambda d0: (lambda s: d0 + (d1 - d0) * s, d1), lambda d0: f"{self.label}: {d0:g} -> {d1:g} mm")

    def by(self, delta):
        """Slide further by this distance (mm)."""
        d = _num(delta, "The distance")
        return _Action(self, lambda d0: (lambda s: d0 + d * s, d0 + d), lambda d0: f"{self.label}: {d0:g} -> {d0 + d:g} mm")


class _Free(Joint):
    def __init__(self, anim, parts, parent):
        super().__init__(anim, "free", parts, parent, np.eye(4))

    def _own(self, value):
        return value

    def to(self, location):
        """Move to this location (cq.Location or (x, y, z), relative to the position in the model). Without a rotation
        axis the origin moves in a straight line: for rotations about an axis use hinge() or rotate()."""
        m1 = _placement(location)
        return _Action(self, lambda m0: (lambda s: _blend(m0, m1, s), m1), lambda m0: f"{self.label}: to new location")

    def translate(self, vector):
        """Move by this vector (mm)."""
        v = _vec(vector, "The translation")
        return _Action(self, lambda m0: (lambda s: _translation(v * s) @ m0, _translation(v) @ m0),
                       lambda m0: f"{self.label}: move by ({v[0]:g}, {v[1]:g}, {v[2]:g}) mm")

    def rotate(self, p1, p2, angle):
        """Rotate about the axis through p1 and p2 (degrees), like cq rotate(). The axis is in the model, not in the part."""
        a, b = _vec(p1, "The first axis point"), _vec(p2, "The second axis point")
        axis = _unit(b - a, "The rotation axis (p2 - p1)")
        deg = _num(angle, "The angle")
        return _Action(self, lambda m0: (lambda s: _axis_rotation(a, axis, deg * s) @ m0, _axis_rotation(a, axis, deg) @ m0),
                       lambda m0: f"{self.label}: rotate by {deg:g} deg")


# ---- Kamera -----------------------------------------------------------------------------------------------------

class Camera:
    """Camera of an animation. set() jumps, move(), orbit() and zoom() are movements for play()."""

    def __init__(self, anim):
        self.anim = anim
        self.ops = []   # dict(t0, t1, kind, spec, ease)

    def _spec(self, view, fit, zoom, target, distance):
        spec = {}
        if view is not None:
            if isinstance(view, str):
                if view not in VIEWS:
                    raise ValueError(f"view={view!r} does not exist. Possible: {', '.join(VIEWS)} or a direction (x, y, z)")
                spec["dir"] = _unit(VIEWS[view], "The view direction")
            else:
                spec["dir"] = _unit(view, "The view direction (from the center to the camera)")
            spec["view"] = view if isinstance(view, str) else "direction"
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
        """Set the camera at once. view: "iso", "front", "back", "left", "right", "top", "bottom" or a direction from the
        center to the camera. fit: parts or groups that should be fully in the picture (over the whole movement), default
        all. zoom: greater than 1 is closer. target and distance set the center and the distance (mm) directly."""
        spec = self._spec(view, fit, zoom, target, distance)
        if "fit" not in spec and "target" not in spec and "distance" not in spec:
            spec["fit"] = None  # ohne Angabe: alles einpassen
        t = self.anim.time
        self.ops.append(dict(t0=t, t1=t, kind="set", spec=spec, ease=EASES["linear"]))
        self.anim._step(t, t, "Camera: " + _describe_camera(spec))

    def move(self, view=None, fit=None, zoom=None, target=None, distance=None):
        """Camera move to a new view (for play). What is not given stays: without fit, target and distance the center
        and the distance stay, and the camera only swings around."""
        spec = self._spec(view, fit, zoom, target, distance)
        return _Action(self, ("move", spec), lambda _v: "Camera: move " + _describe_camera(spec))

    def orbit(self, degrees, tilt=0.0):
        """Circle around the center (degrees about the vertical axis Z, positive is counterclockwise seen from above).
        tilt raises or lowers the camera (degrees)."""
        spec = dict(orbit=_num(degrees, "The angle"), tilt=_num(tilt, "tilt"))
        return _Action(self, ("orbit", spec), lambda _v: f"Camera: orbit {spec['orbit']:g} deg" + (f", tilt {spec['tilt']:g} deg" if spec["tilt"] else ""))

    def zoom(self, factor):
        """Closer (factor greater than 1) or farther away (less than 1)."""
        f = _num(factor, "The factor", 0.01)
        return _Action(self, ("zoom", dict(zoom=f)), lambda _v: f"Camera: zoom x{f:g}")


def _describe_camera(spec):
    bits = []
    if "view" in spec:
        bits.append(f"view {spec['view']}")
    if "fit" in spec:
        bits.append("everything in the picture" if spec["fit"] is None else f"in the picture: {', '.join(spec['fit'][:4])}")
    if "zoom" in spec:
        bits.append(f"zoom x{spec['zoom']:g}")
    if "target" in spec:
        bits.append("center ({:g}, {:g}, {:g})".format(*spec["target"]))
    if "distance" in spec:
        bits.append(f"distance {spec['distance']:g} mm")
    return ", ".join(bits) or "unchanged"


# ---- Animation --------------------------------------------------------------------------------------------------

class Animation:
    """An animation with a name. Several per file are allowed, names must be unique in the project.

    Timeline as in manim: play() moves (all given movements at the same time) and advances the time by run_time,
    wait() waits, title() shows a title card and advances. caption(), label(), highlight(), hide(), show() and ghost()
    apply from the current time and do not advance it.
    """

    def __init__(self, name):
        self.name = _text(name, "The name of the animation")
        if not self.name:
            raise ValueError("The animation needs a name, e.g. Animation(\"Open lid\")")
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
                raise ValueError(f"{sorted(twice)[0]!r} is already on a joint of this animation. A part has one joint, "
                                 "movements on top of it come with parent=.")
        if joint.parent is not None and not isinstance(joint.parent, Joint):
            raise ValueError("parent must be a joint of this animation (returned by hinge(), slider() or part())")
        self.joints.append(joint)
        return joint

    def hinge(self, parts, p1, p2, parent=None, angle=0.0):
        """Revolute joint: parts (name, group or list) rotate about the axis through p1 and p2, like cq rotate(p1, p2, a).
        Positive angles turn right-handed about the direction p2 - p1. angle is the angle at the start (degrees, 0 = as in
        the model). parent: joint this one sits on (the axis is then given in the model position)."""
        a, b = _vec(p1, "The first axis point"), _vec(p2, "The second axis point")
        return self._joint(_Hinge(self, _resolve(parts), a, _unit(b - a, "The rotation axis (p2 - p1)"), parent, _num(angle, "angle")))

    def slider(self, parts, direction, parent=None, position=0.0):
        """Prismatic joint: parts slide along direction. position is the distance at the start (mm)."""
        return self._joint(_Slider(self, _resolve(parts), _unit(direction, "The direction"), parent, _num(position, "position")))

    def part(self, parts, parent=None):
        """Freely moving parts: to(location), translate((x, y, z)), rotate(p1, p2, angle)."""
        return self._joint(_Free(self, _resolve(parts), parent))

    # -- Zeitleiste --

    def _step(self, t0, t1, text, **move):
        """Eintrag im Ablauf. move (bei Bewegungen): key (Gelenk oder Kamera), label, unit, v0, v1 bzw. orbit, tilt.
        Damit fasst `soma anim info` viele kurze Schritte desselben Gelenks zu einer Zeile zusammen."""
        self.steps.append(dict(start=round(t0, 4), end=round(t1, 4), text=text, **move))

    def play(self, *actions, run_time=1.0, ease="smooth"):
        """Run movements at the same time, then the time advances by run_time (seconds).
        ease: "smooth" (default, gentle start and stop), "linear", "in", "out" or a function f(s)."""
        rt = _num(run_time, "run_time", 0.0)
        f = _ease(ease)
        if not actions:
            raise ValueError("play() needs at least one movement, e.g. play(lid.to(90)). To wait: wait()")
        seen = set()
        t0, t1 = self.time, self.time + rt
        for act in actions:
            if not isinstance(act, _Action):
                raise ValueError(f"play() expects movements like joint.to(90) or a.camera.orbit(90), not {act!r}")
            if id(act.target) in seen:
                raise ValueError("A joint (or the camera) appears twice in the same play()")
            seen.add(id(act.target))
            if isinstance(act.target, Camera):
                kind, spec = act.make
                act.target.ops.append(dict(t0=t0, t1=t1, kind=kind, spec=spec, ease=f))
                self._step(t0, t1, act.describe(None), key="camera",
                           **(dict(orbit=spec["orbit"], tilt=spec["tilt"]) if kind == "orbit" else {}))
                continue
            j = act.target
            if j.anim is not self:
                raise ValueError("This movement belongs to another animation")
            func, end = act.make(j.value)
            j.segments.append((t0, t1, func, f))
            move = dict(key=f"joint{self.joints.index(j)}", label=j.label)
            if j.unit:
                move.update(unit=j.unit, v0=round(float(j.value), 4), v1=round(float(end), 4))
            self._step(t0, t1, act.describe(j.value), **move)
            j.value = end
        self.time = t1

    def wait(self, seconds=1.0):
        """Nothing moves, the time advances."""
        s = _num(seconds, "The waiting time", 0.0)
        self._step(self.time, self.time + s, "Pause")
        self.time += s

    # -- Texte und Hervorhebungen --

    def title(self, text, subtitle=None, duration=2.0):
        """Title card in the middle of the picture. The time advances by duration (like wait)."""
        d = _num(duration, "duration", 0.0)
        t = dict(start=self.time, end=self.time + d, text=_text(text, "The title"))
        if subtitle:
            t["subtitle"] = _text(subtitle, "The subtitle")
        self.titles.append(t)
        self._step(self.time, self.time + d, f"Title: {t['text']}")
        self.time += d

    def caption(self, text, duration=None):
        """Caption at the bottom of the picture, from now until the next caption (or duration seconds). caption(None) hides it."""
        if text is None or text == "":
            self.captions.append(dict(start=self.time, end=None, text=""))
            return
        d = None if duration is None else _num(duration, "duration", 0.0)
        c = dict(start=self.time, end=None if d is None else self.time + d, text=_text(text, "The caption"))
        self.captions.append(c)
        self._step(self.time, self.time if d is None else self.time + d, f"Caption: {c['text']}")

    def label(self, text, part=None, at=None, duration=None):
        """Label at a spot in the model, from now on (until the end or duration seconds). part: the label moves with this
        part. at: point (mm, in the position in the model), without at the center of the part."""
        if part is None and at is None:
            raise ValueError("label() needs part= or at=")
        names = _resolve(part, "part") if part is not None else []
        if len(names) > 1:
            raise ValueError(f"label(part=...) needs a single part, {part!r} are {len(names)}")
        d = None if duration is None else _num(duration, "duration", 0.0)
        lb = dict(start=self.time, end=None if d is None else self.time + d, text=_text(text, "The label"),
                  part=names[0] if names else None, at=None if at is None else [float(x) for x in _vec(at, "at")])
        self.labels.append(lb)
        self._step(self.time, self.time, f"Label: {lb['text']}")

    def _event(self, kind, parts, what):
        names = _resolve(parts)
        self.events.append(dict(t=self.time, kind=kind, parts=names))
        self._step(self.time, self.time, f"{what}: {', '.join(names[:4])}{' ...' if len(names) > 4 else ''}")

    def highlight(self, parts, duration=None):
        """Highlight parts (orange), from now until unhighlight() or duration seconds."""
        self._event("highlight", parts, "Highlight")
        if duration is not None:
            d = _num(duration, "duration", 0.0)
            self.events.append(dict(t=self.time + d, kind="unhighlight", parts=_resolve(parts)))

    def unhighlight(self, parts):
        """End the highlight of parts."""
        self._event("unhighlight", parts, "Highlight off")

    def hide(self, parts):
        """Hide parts (until show())."""
        self._event("hide", parts, "Hide")

    def show(self, parts):
        """Show hidden parts again."""
        self._event("show", parts, "Show")

    def ghost(self, parts, on=True):
        """Show parts transparent (on=False: opaque again). So you can see what is behind them."""
        self._event("ghost" if on else "solid", parts, "Transparent" if on else "Opaque again")

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
