"""Parameters: values of the model that the user can change in the app, in the Parameters panel.

    from soma import param

    BORE = param(38.0, "Cylinder bore", min=30, max=42, step=0.5, unit="mm", group="Crank train")
    TEETH = param(18, "Teeth", min=12, max=30)                        # whole number
    COUNTERWEIGHT = param(True, "Counterweight")                     # switch
    BEARING = param("sleeve", "Bearing", options=["sleeve", "ball"])  # choice

The first argument is the default. The user's values are kept in parameters.json in the project folder and take the
place of the defaults. Constants without param() stay internal and do not show up in the app.
"""
import ast
import inspect
import json
import math
import numbers
import re
from pathlib import Path

USER_FILE = "parameters.json"
FILE_NOTE = "Values the user set in the Parameters panel of SOMA. They take the place of the defaults of param() in the code."
KINDS = ("number", "int", "bool", "choice", "text")
MAX_TEXT = 1000

PARAMS = []        # je Build geleert (begin), Reihenfolge wie im Code
WARNINGS = []
_USER = None       # Werte aus parameters.json (Name -> Wert). None: noch nicht gelesen
_TREES = {}        # Syntaxbaeume je Datei, fuer den Namen der Konstante
_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def read_user_values(root):
    """Werte des Nutzers aus parameters.json und ggf. ein Hinweis, warum die Datei nicht gilt."""
    p = Path(root) / USER_FILE
    if not p.is_file():
        return {}, None
    try:
        data = json.loads(p.read_text(encoding="utf-8-sig"))  # -sig: von Hand gespeichert, oft mit BOM
    except (OSError, ValueError) as e:
        return {}, f"{USER_FILE} cannot be read ({e}). The defaults from the code apply."
    values = data.get("values") if isinstance(data, dict) else None
    if not isinstance(values, dict):
        return {}, f"{USER_FILE} has no \"values\" object. The defaults from the code apply."
    return {str(k): v for k, v in values.items()}, None


def begin(root):
    """Vor dem Ausfuehren des Modells (build.run_model): Liste leeren, Werte des Nutzers frisch lesen."""
    global _USER
    PARAMS.clear()
    WARNINGS.clear()
    _TREES.clear()
    _USER, problem = read_user_values(root)
    if problem:
        WARNINGS.append(problem)


def _assigned_name(file, line, col):
    """Name der Konstante, der der Aufruf zugewiesen wird (`BORE = param(...)`), sonst None."""
    tree = _TREES.get(file)
    if tree is None:
        try:
            tree = ast.parse(Path(file).read_text(encoding="utf-8"))
        except (OSError, SyntaxError, ValueError):
            tree = False
        _TREES[file] = tree
    if not tree:
        return None
    found = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.Assign, ast.AnnAssign)) and isinstance(node.value, ast.Call) and node.value.lineno == line:
            targets = node.targets if isinstance(node, ast.Assign) else [node.target]
            if len(targets) == 1 and isinstance(targets[0], ast.Name):
                found.append((node.value.col_offset, targets[0].id))
    exact = [n for c, n in found if c == col]
    if exact:
        return exact[0]
    return found[0][1] if len(found) == 1 else None


def _number(v, what):
    if isinstance(v, bool) or not isinstance(v, numbers.Real) or not math.isfinite(float(v)):
        raise ValueError(f"{what} must be a number, not {v!r}")
    return float(v)


def _scalar(v):
    """Wert, der so in JSON passt: Zahlen aus numpy werden zu int oder float."""
    if isinstance(v, (bool, str)):
        return v
    if isinstance(v, numbers.Integral):
        return int(v)
    if isinstance(v, numbers.Real) and math.isfinite(float(v)):
        return float(v)
    raise ValueError(f"options can only hold numbers, texts or True/False, not {v!r}")


def _same(a, b):
    """Gleicher Wert einer Auswahl. True und 1 sind hier verschieden, 8 und 8.0 nicht."""
    return a == b and isinstance(a, bool) == isinstance(b, bool)


def _spec(name, default, label, lo, hi, step, unit, options, group, help_):
    """Pruefen, was der Agent angegeben hat. Fehler hier sind Fehler im Code: mit klarer Meldung abbrechen."""
    where = f"param {name}"
    if options is not None:
        if isinstance(options, dict):
            opts = [dict(value=_scalar(k), label=str(v)) for k, v in options.items()]
        elif isinstance(options, (list, tuple)):
            opts = [dict(value=_scalar(v), label=str(v)) for v in options]
        else:
            raise ValueError(f"{where}: options must be a list of values (or a dict value -> label), not {type(options).__name__}")
        if not opts:
            raise ValueError(f"{where}: options must not be empty")
        if lo is not None or hi is not None or step is not None:
            raise ValueError(f"{where}: options and min/max/step do not go together")
        default = _scalar(default)
        if not any(_same(o["value"], default) for o in opts):
            raise ValueError(f"{where}: the default {default!r} is not one of the options")
        kind = "choice"
    elif isinstance(default, bool):
        kind, opts = "bool", None
    elif isinstance(default, numbers.Integral):
        kind, opts, default = "int", None, int(default)
    elif isinstance(default, numbers.Real):
        kind, opts, default = "number", None, _number(default, f"{where}: the default")
    elif isinstance(default, str):
        kind, opts = "text", None
        if len(default) > MAX_TEXT:
            raise ValueError(f"{where}: the default text is longer than {MAX_TEXT} characters")
    else:
        raise ValueError(f"{where}: the default must be a number, True/False or a text, not {type(default).__name__}. "
                         "For a choice pass options=[...]")
    if kind in ("bool", "text") and (lo is not None or hi is not None or step is not None):
        raise ValueError(f"{where}: min, max and step only work with numbers")
    if lo is not None:
        lo = _number(lo, f"{where}: min")
    if hi is not None:
        hi = _number(hi, f"{where}: max")
    if step is not None:
        step = _number(step, f"{where}: step")
        if step <= 0:
            raise ValueError(f"{where}: step must be greater than 0")
    if kind == "int":
        for v, what in ((lo, "min"), (hi, "max"), (step, "step")):
            if v is not None and v != int(v):
                raise ValueError(f"{where}: {what} must be a whole number like the default")
        lo, hi, step = (int(v) if v is not None else None for v in (lo, hi, step))
    if lo is not None and hi is not None and lo > hi:
        raise ValueError(f"{where}: min ({lo:g}) is greater than max ({hi:g})")
    if kind in ("number", "int") and lo is not None and default < lo:
        raise ValueError(f"{where}: the default {default:g} is less than min={lo:g}")
    if kind in ("number", "int") and hi is not None and default > hi:
        raise ValueError(f"{where}: the default {default:g} is greater than max={hi:g}")
    for v, what in ((label, "label"), (unit, "unit"), (group, "group"), (help_, "help")):
        if v is not None and not isinstance(v, str):
            raise ValueError(f"{where}: {what} must be a text, not {type(v).__name__}")
    label = (label or "").strip() or name.replace("_", " ").strip().capitalize()
    return dict(name=name, label=label, kind=kind, default=default, min=lo, max=hi, step=step,
                unit=(unit or "").strip() or None, options=opts, group=(group or "").strip() or None,
                help=(help_ or "").strip() or None)


def fmt(spec, v):
    """Wert mit Einheit fuer Meldungen: Zahlen mit Punkt, ohne ueberfluessige Nullen."""
    if isinstance(v, float):
        s = f"{v:.6f}".rstrip("0").rstrip(".")
    elif isinstance(v, str):
        s = repr(v)
    else:
        s = str(v)
    return f"{s} {spec['unit']}" if spec.get("unit") and spec["kind"] in ("number", "int") else s


def _coerce(spec, raw):
    """Wert aus parameters.json in den Typ des Parameters bringen. (Wert, None) oder (None, Grund)."""
    kind = spec["kind"]
    if kind in ("number", "int"):
        if isinstance(raw, str):  # von Hand eingetragen, etwa "40" oder "40,5"
            try:
                raw = float(raw.strip().replace(",", "."))
            except ValueError:
                return None, "not a number"
        if isinstance(raw, bool) or not isinstance(raw, (int, float)) or not math.isfinite(raw):
            return None, "not a number"
        if kind == "int":
            if raw != int(raw):
                return None, "not a whole number"
            return int(raw), None
        return float(raw), None
    if kind == "bool":
        return (raw, None) if isinstance(raw, bool) else (None, "not true or false")
    if kind == "text":
        if not isinstance(raw, str):
            return None, "not a text"
        return (raw, None) if len(raw) <= MAX_TEXT else (None, f"longer than {MAX_TEXT} characters")
    for o in spec["options"]:
        if _same(o["value"], raw):
            return o["value"], None
    return None, "not one of the options"


def param(default, label=None, *, min=None, max=None, step=None, unit=None, options=None, group=None, help=None, name=None):  # noqa: A002
    """A value the user can change in the app (Parameters panel). Returns the user's value or the default.

    default  the value from the code: a number (float or int), True/False or a text. The type decides the field
    label    name in the app, e.g. "Cylinder bore" (default: from the name of the constant)
    min, max range for numbers. Choose it so the model builds and makes sense over the whole range
    step     step for the slider and the arrow keys (int: whole numbers)
    unit     shown next to the value, e.g. "mm" or "deg"
    options  a choice instead of a free value: a list of values, or a dict value -> label
    group    heading in the app, e.g. "Crank train"
    help     one or two sentences shown in the app
    name     only needed when the call is not assigned to a constant (`BORE = param(...)` gives the name BORE)

    The user's values live in parameters.json (written by the app) and take the place of the default.
    """
    global _USER
    frame = inspect.currentframe().f_back
    pos = inspect.getframeinfo(frame, context=0).positions
    file = frame.f_code.co_filename
    line = pos.lineno if pos and pos.lineno else frame.f_lineno
    if name is None:
        name = _assigned_name(file, line, pos.col_offset if pos else None)
        if name is None:
            raise ValueError("param() needs a name: assign it to a constant (BORE = param(38.0, ...)) or pass name=\"BORE\"")
    elif not isinstance(name, str) or not _NAME.match(name):
        raise ValueError(f"name must look like a Python name (letters, digits, _), not {name!r}")
    spec = _spec(name, default, label, min, max, step, unit, options, group, help)
    for p in PARAMS:
        if p["name"] == name:
            # Dieselbe Stelle noch einmal (eine Animation importiert das Modell): derselbe Wert, kein zweiter Eintrag
            if (p["file"], p["line"]) == (file, line):
                return p["value"]
            raise ValueError(f"Parameter {name} is already defined in {Path(p['file']).name}, line {p['line']} (names must be unique)")
    if _USER is None:  # Modell ohne soma build ausgefuehrt (etwa importiert): Werte aus dem aktuellen Ordner
        _USER = read_user_values(Path.cwd())[0]
    value, source = spec["default"], "code"
    if name in _USER:
        raw = _USER[name]
        v, why = _coerce(spec, raw)
        if why:
            WARNINGS.append(f"{USER_FILE}: the value {raw!r} for {name} is {why}, the default from the code applies ({fmt(spec, spec['default'])}).")
        else:
            value, source = v, "user"
            lo, hi = spec["min"], spec["max"]
            if spec["kind"] in ("number", "int") and ((lo is not None and v < lo) or (hi is not None and v > hi)):
                WARNINGS.append(f"{name} = {fmt(spec, v)} (set in the app) lies outside the range {fmt(spec, lo) if lo is not None else '...'} "
                                f"to {fmt(spec, hi) if hi is not None else '...'} of the code. It is used anyway.")
    PARAMS.append(dict(spec, file=file, line=line, value=value, source=source))
    return value


def unused_warnings():
    """Werte in parameters.json, zu denen das Modell keinen Parameter (mehr) hat. Nur nach einem vollstaendigen Lauf."""
    known = {p["name"] for p in PARAMS}
    return [f"{USER_FILE} has a value for {n}, but the model has no parameter {n} (anymore). It is not used."
            for n in (_USER or {}) if n not in known]


def export(rel):
    """Liste fuer build.json und die App. `rel` macht Dateipfade relativ zum Projekt."""
    return [dict(p, file=rel(p["file"])) for p in PARAMS]


def summary(params):
    """Eine Zeile fuer `soma build`: Anzahl und die Werte, die der Nutzer gesetzt hat."""
    if not params:
        return None
    user = [p for p in params if p.get("source") == "user"]
    head = f"Parameters: {len(params)}"
    if not user:
        return f"{head}, all at the defaults from the code"
    return f"{head}, set by the user in the app: " + ", ".join(f"{p['name']} = {fmt(p, p['value'])} (code: {fmt(p, p['default'])})" for p in user)
