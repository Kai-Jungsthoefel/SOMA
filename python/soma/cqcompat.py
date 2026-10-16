"""Kompatibilitaetsmodus (E100): CadQuery-Skripte ohne add_part() bauen trotzdem.

Ein Skript aus CQ-editor ruft `show_object(obj, name=..., options={"color": ..., "alpha": ...})`, eines fuer VS Code
`from ocp_vscode import show` und `show(a, b, names=[...], colors=[...])`, manche legen nur `result` an. Waehrend
run_model() stehen dafuer Ersatzfunktionen bereit, die die Aufrufe mit Datei und Zeile sammeln. Hat das Skript kein
add_part() aufgerufen, werden daraus die Bauteile (Klick->Code zeigt auf den Aufruf), der Build meldet das als Warnung.
Ruft das Skript add_part(), gelten nur diese Teile, show_object() bleibt dann wirkungslos.
"""
import builtins
import contextlib
import inspect
import sys
import types

import cadquery as cq

from . import registry

SHOWN = []  # je Lauf von hooks() geleert: dict(obj, name, color, alpha, file, line, end_line)
WARNING = ("Compatibility mode: the script calls no add_part(), so its {n} part(s) come from {how}. Names and colors are "
           "taken from there. To convert it to add_part() and param(), ask the agent (skill \"CadQuery scripts\", .soma/skills/cadquery-scripts.md).")


def _where(depth):
    """Datei und Zeilen des Aufrufs im Skript, `depth` Rahmen ueber dem Aufrufer dieser Funktion."""
    frame = inspect.currentframe().f_back
    for _ in range(depth):
        frame = frame.f_back
    pos = inspect.getframeinfo(frame, context=0).positions
    line = pos.lineno if pos and pos.lineno else frame.f_lineno
    return frame, dict(file=frame.f_code.co_filename, line=line, end_line=(pos.end_lineno if pos and pos.end_lineno else line))


def _var_name(frame, obj):
    """Name der Variablen, die `obj` haelt (wie ocp_vscode ihn zeigt), sonst None."""
    for ns in (frame.f_locals, frame.f_globals):
        for k, v in ns.items():
            if v is obj and not k.startswith("_"):
                return k
    return None


def _color(c):
    """Farbe aus CQ-editor/ocp_vscode als ((r, g, b) 0..1, alpha) oder (None, None). Unbekanntes wird ignoriert."""
    if c is None:
        return None, None
    try:
        if isinstance(c, cq.Color):
            t = c.toTuple()
            return tuple(t[:3]), (t[3] if len(t) > 3 else None)
        if isinstance(c, str):
            s = c.strip()
            if s.startswith("#") and len(s) in (7, 9):
                v = [int(s[i:i + 2], 16) / 255 for i in range(1, len(s), 2)]
                return tuple(v[:3]), (v[3] if len(v) > 3 else None)
            t = cq.Color(s).toTuple()  # Farbnamen von OCCT, etwa "red", "steelblue"
            return tuple(t[:3]), None
        v = [float(x) for x in c]
        if len(v) in (3, 4):
            if any(x > 1 for x in v[:3]):  # CQ-editor nimmt auch 0..255
                v[:3] = [x / 255 for x in v[:3]]
            return tuple(max(0.0, min(1.0, x)) for x in v[:3]), (v[3] if len(v) > 3 else None)
    except Exception:  # noqa: BLE001  (fremde Farbangaben duerfen den Build nicht kosten)
        pass
    return None, None


def _collect(obj, name, color, alpha, where, frame, how="show_object()"):
    if registry.IGNORE_ADD:  # Animation/Zeichnung importiert das Modell: die Teile sind schon bekannt
        return
    if isinstance(obj, (list, tuple)):
        for o in obj:
            _collect(o, None, color, alpha, where, frame, how)
        return
    rgb, a = _color(color)
    SHOWN.append(dict(obj=obj, name=name or _var_name(frame, obj), color=rgb,
                      alpha=alpha if alpha is not None else a, how=how, **where))


def show_object(obj, name=None, options=None, **_kw):
    """Ersatz fuer show_object() aus CQ-editor (und cq-cli): merkt sich das Objekt fuer den Build."""
    frame, where = _where(1)
    options = options if isinstance(options, dict) else {}
    alpha = options.get("alpha")
    _collect(obj, name, options.get("color"), float(alpha) if isinstance(alpha, (int, float)) else None, where, frame)


def debug(_obj, *_a, **_kw):
    """debug() aus CQ-editor zeigt Hilfsgeometrie in Rot. Sie gehoert nicht zum Modell."""


def log(*a, **_kw):
    print(*a, file=sys.stderr)


class _Noop:
    """Fuer alles, was ocp_vscode sonst noch bietet (set_port, Camera.RESET, ...): tut nichts."""

    def __call__(self, *_a, **_kw):
        return None

    def __getattr__(self, _name):
        return self


def _ocp_show(*objs, names=None, colors=None, alphas=None, **_kw):
    frame, where = _where(1)
    for i, o in enumerate(objs):
        pick = lambda seq: seq[i] if isinstance(seq, (list, tuple)) and i < len(seq) else None  # noqa: E731
        a = pick(alphas)
        _collect(o, pick(names), pick(colors), float(a) if isinstance(a, (int, float)) else None, where, frame,
                 "show() of ocp_vscode")


def _ocp_show_object(obj, name=None, options=None, **kw):
    frame, where = _where(1)
    options = options if isinstance(options, dict) else {}
    alpha = options.get("alpha", kw.get("alpha"))
    _collect(obj, name, options.get("color", kw.get("color")), float(alpha) if isinstance(alpha, (int, float)) else None, where, frame,
             "show_object() of ocp_vscode")


def _ocp_show_all(*_a, **_kw):
    """show_all() zeigt alle CadQuery-Objekte im Namensraum des Aufrufers."""
    frame, where = _where(1)
    for k, v in list(frame.f_locals.items()):
        if not k.startswith("_") and isinstance(v, (cq.Workplane, cq.Shape, cq.Assembly)):
            _collect(v, k, None, None, where, frame, "show_all() of ocp_vscode")


def _ocp_module():
    mod = types.ModuleType("ocp_vscode")
    mod.__doc__ = "Stand-in of SOMA for ocp_vscode: show() and show_object() hand the objects to soma build."
    mod.show, mod.show_object, mod.show_all = _ocp_show, _ocp_show_object, _ocp_show_all
    mod.__all__ = ["show", "show_object", "show_all", "show_clear", "reset_show", "set_port", "set_defaults",
                   "get_defaults", "reset_defaults", "set_viewer_config", "Camera", "Collapse", "Animation", "status"]
    noop = _Noop()

    def attr(name):
        if name.startswith("__"):  # importlib und pickle fragen nach __path__, __spec__ ...
            raise AttributeError(name)
        return noop
    mod.__getattr__ = attr
    return mod


def script_globals():
    """Fuer den Namensraum des Einstiegspunkts, wie CQ-editor ihn vorbelegt: Viele Skripte fragen
    `if "show_object" in globals()` und exportieren sonst selbst eine Datei. Die eingebauten Namen aus hooks() sieht diese
    Abfrage nicht."""
    return dict(show_object=show_object, debug=debug, log=log)


@contextlib.contextmanager
def hooks():
    """Ersatzfunktionen fuer die Dauer eines Laufs: show_object/debug/log als eingebaute Namen (wie CQ-editor sie
    bereitstellt, so finden auch Module in parts/ sie) und ein Ersatzmodul ocp_vscode. Danach alles wie vorher."""
    SHOWN.clear()
    missing = object()
    saved = {k: getattr(builtins, k, missing) for k in ("show_object", "debug", "log")}
    old_mod = sys.modules.get("ocp_vscode", missing)
    builtins.show_object, builtins.debug, builtins.log = show_object, debug, log
    sys.modules["ocp_vscode"] = _ocp_module()
    try:
        yield
    finally:
        for k, v in saved.items():
            if v is missing:
                with contextlib.suppress(AttributeError):
                    delattr(builtins, k)
            else:
                setattr(builtins, k, v)
        if old_mod is missing:
            sys.modules.pop("ocp_vscode", None)
        else:
            sys.modules["ocp_vscode"] = old_mod


def _unique(name, taken):
    base, i = name, 2
    while name in taken:
        name, i = f"{base} ({i})", i + 1
    return name


def register_shown(namespace, script):
    """Nach dem Lauf, wenn kein add_part() kam: gesammelte Objekte als Bauteile eintragen, sonst `result`.
    Liefert die Warnung fuer build.json oder None, wenn es nichts gab. Fehler einzelner Objekte werden Warnungen."""
    items = list(SHOWN)
    if not items:
        res = namespace.get("result")
        if isinstance(res, (cq.Workplane, cq.Shape, cq.Assembly)) or hasattr(res, "__soma_shape__"):
            items = [dict(obj=res, name="result", color=None, alpha=None, how="the variable result",
                          file=str(script), line=None, end_line=None)]
    if not items:
        return None
    taken, skipped = set(), []
    for i, it in enumerate(items):
        name = _unique(str(it["name"] or f"Part {i + 1}").strip() or f"Part {i + 1}", taken)
        try:
            registry._add(name, it["obj"], None, it["color"], None,
                          dict(file=it["file"], line=it["line"], end_line=it["end_line"]), alpha=it["alpha"])
            taken.add(name)
        except (TypeError, ValueError) as e:
            skipped.append(f"{name}: {e}")
    hows = sorted({it["how"] for it in items})
    msg = WARNING.format(n=len(registry.REGISTRY), how=" and ".join(hows))
    if skipped:
        msg += " Skipped: " + "; ".join(skipped)
    return msg
