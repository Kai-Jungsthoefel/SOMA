# SPDX-License-Identifier: Apache-2.0
# SOMA compatibility layer: add_part(), param(), import_step(), import_assembly(), component(), anchor() and place()
# in plain CadQuery.
# Copyright the SOMA contributors. Licensed under the Apache License 2.0, https://www.apache.org/licenses/LICENSE-2.0
# (E101). "Export as CadQuery" puts this file into exported models (cqexport.py): as a block in a single script, or as
# soma_compat.py next to it. It must run without soma, with CadQuery only. Everything up to the end marker is copied.
import builtins as _soma_builtins
import inspect as _soma_inspect
import json as _soma_json
import linecache as _soma_linecache
import os as _soma_os
import re as _soma_re
import runpy as _soma_runpy
import sys as _soma_sys

import cadquery as _soma_cq

_SOMA_VALUES = {}  # values set in the Parameters panel of SOMA, they take the place of the defaults of param()
_SOMA_PARTS = []
_SOMA_COLORS = {"part": (0.62, 0.66, 0.72), "reference": (0.1, 0.65, 0.3), "hardware": (0.45, 0.46, 0.49)}
_SOMA_ASSIGN = _soma_re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]*)?=\s*param\s*\(")
try:
    _SOMA_DIR = _soma_os.path.dirname(_soma_os.path.abspath(__file__))
except NameError:  # some viewers run the code without a file name
    _SOMA_DIR = _soma_os.getcwd()


def param(default, label=None, *, name=None, **_spec):
    """A value the user can change in SOMA. Here: the value set in SOMA when the model was exported, else the default."""
    if name is None:
        frame = _soma_inspect.currentframe().f_back
        pos = getattr(_soma_inspect.getframeinfo(frame, context=0), "positions", None)  # Python 3.11+: start of the call
        line = _soma_linecache.getline(frame.f_code.co_filename, pos.lineno if pos and pos.lineno else frame.f_lineno)
        match = _SOMA_ASSIGN.match(line)
        name = match.group(1) if match else None
    value = _soma_value(name, default)
    if name is not None:
        _SOMA_PARAM_NAMES[name] = value
    return value


def _soma_value(name, default):
    if name not in _SOMA_VALUES:
        return default
    value = _SOMA_VALUES[name]
    if isinstance(default, bool) or isinstance(value, bool):
        return value if isinstance(default, bool) and isinstance(value, bool) else default
    if isinstance(default, (int, float)):
        if not isinstance(value, (int, float)):
            return default
        return int(value) if isinstance(default, int) and float(value).is_integer() else value
    return value if isinstance(value, type(default)) else default


def _soma_path(path):
    """Paths like "inputs/board.step" relative to the script, if they are not found relative to the working folder."""
    path = str(path)
    if _soma_os.path.isabs(path) or _soma_os.path.exists(path):
        return path
    return _soma_os.path.join(_SOMA_DIR, path)


def import_step(path):
    """Imports a STEP file as one shape. Several bodies side by side become one compound."""
    shapes = _soma_cq.importers.importStep(_soma_path(path)).vals()
    return shapes[0] if len(shapes) == 1 else _soma_cq.Compound.makeCompound(shapes)


def import_assembly(path):
    """Imports a STEP file with its structure as a cq.Assembly. A file without an assembly gives one part per body."""
    try:
        asm = _soma_cq.Assembly.importStep(_soma_path(path))
        if any(a.obj is not None for _, a in asm.traverse()):  # a compound on top reads as an assembly without parts
            return asm
    except ValueError as e:
        if "does not contain an assembly" not in str(e):
            raise
    name = _soma_os.path.splitext(_soma_os.path.basename(str(path)))[0] or "Part"
    shapes = _soma_cq.importers.importStep(_soma_path(path)).vals()
    asm = _soma_cq.Assembly()  # unnamed: a part may not have the name of the assembly above it
    for i, s in enumerate(shapes):
        asm.add(s, name=name if len(shapes) == 1 else f"{name} {i + 1}")
    return asm


# ---- Components and anchors: other SOMA models inside this one, in components/<folder>/ ----------------------------

_SOMA_ANCHORS = {}       # anchors of the model being run: name -> (origin, x direction, normal)
_SOMA_PARAM_NAMES = {}   # param() names and values of the model being run (component(): unknown names, soma_params)
_SOMA_STACK = []         # folders of the components being run, inside each other
_SOMA_BUILT = {}         # (folder, values) -> (parts, anchors): a component used several times is built once


def _soma_vec(v, what):
    if hasattr(v, "x") and hasattr(v, "y") and hasattr(v, "z"):
        v = (v.x, v.y, v.z)
    try:
        x, y, z = (float(c) for c in v)
    except (TypeError, ValueError):
        raise ValueError(f"{what} must be three numbers (x, y, z), not {v!r}") from None
    return x, y, z


def _soma_anchor_data(name, at, normal, x_dir):
    """Checks an anchor and gives it a full frame: x direction at right angles to the normal."""
    if not isinstance(name, str) or not name.strip():
        raise ValueError("An anchor needs a name, e.g. anchor(\"back\", (0, 0, 0))")
    o = _soma_vec(at, f"anchor {name!r}: the point")
    n = _soma_cq.Vector(*_soma_vec(normal, f"anchor {name!r}: normal"))
    if n.Length < 1e-9:
        raise ValueError(f"anchor {name!r}: the normal must not be (0, 0, 0)")
    n = n.normalized()
    if x_dir is not None:
        x = _soma_cq.Vector(*_soma_vec(x_dir, f"anchor {name!r}: x_dir"))
    else:  # any direction at right angles: world X, or world Y when the normal is along X
        x = _soma_cq.Vector(1, 0, 0) if abs(n.x) < 0.9 else _soma_cq.Vector(0, 1, 0)
    x = x - n * x.dot(n)
    if x.Length < 1e-9:
        raise ValueError(f"anchor {name!r}: x_dir must not point along the normal")
    x = x.normalized()
    return o, (x.x, x.y, x.z), (n.x, n.y, n.z)


def _soma_frame(data):
    o, x, n = data
    return _soma_cq.Location(_soma_cq.Plane(_soma_cq.Vector(*o), _soma_cq.Vector(*x), _soma_cq.Vector(*n)))


def _soma_place(obj, anchor, to, to_anchor, flip, own):
    """Location for `obj` so that its anchor sits on the target (place()). `own`: anchors of the model itself."""
    def anchors_of(asm, what):
        found = (getattr(asm, "metadata", None) or {}).get("soma_anchors")
        if not isinstance(asm, _soma_cq.Assembly) or found is None:
            raise ValueError(f"place(): {what} is not a component (component(\"Name\")), it has no anchors")
        return found

    def pick(found, name, what):
        if name not in found:
            raise ValueError(f"place(): {what} has no anchor {name!r}. Its anchors: {', '.join(map(repr, found)) or 'none'}"
                             ". Define one in its model with anchor(\"name\", (x, y, z))")
        return _soma_frame(found[name])

    mine = pick(anchors_of(obj, f"{getattr(obj, 'name', obj)!r}"), anchor, f"{getattr(obj, 'name', 'the component')!r}")
    if isinstance(to, _soma_cq.Assembly):
        if to_anchor is None:
            raise ValueError("place(): name the anchor of the target too, e.g. place(drawer, \"back\", cabinet, \"slot 1\")")
        target = to.loc * pick(anchors_of(to, repr(to.name)), to_anchor, repr(to.name))
    elif isinstance(to, str):
        target = pick(own, to, "this model")
    elif isinstance(to, _soma_cq.Location):
        target = to
    else:
        target = _soma_cq.Location(_soma_cq.Vector(*_soma_vec(to, "place(): the target")))
    if flip:  # face to face: the normals point against each other, the x directions agree
        target = target * _soma_cq.Location(_soma_cq.Vector(0, 0, 0), _soma_cq.Vector(1, 0, 0), 180)
    return target * mine.inverse


def anchor(name, at=(0, 0, 0), normal=(0, 0, 1), x_dir=None):
    """A named point of this model where it attaches to others (SOMA). Here: kept for place()."""
    _SOMA_ANCHORS[str(name)] = _soma_anchor_data(name, at, normal, x_dir)


def place(obj, anchor, to, to_anchor=None, flip=False):
    """Moves a component so that its anchor sits on the target (SOMA). Returns the component."""
    obj.loc = _soma_place(obj, anchor, to, to_anchor, flip, _SOMA_ANCHORS)
    return obj


def _soma_find(root, name):
    base = _soma_os.path.join(root, "components")
    key = str(name).strip().lower()
    slug = _soma_re.sub(r"[^A-Za-z0-9]+", "-", key).strip("-")
    names = []
    for d in sorted(_soma_os.listdir(base)) if _soma_os.path.isdir(base) else []:
        folder = _soma_os.path.join(base, d)
        if d.startswith((".", "__")) or not _soma_os.path.isdir(folder):
            continue
        try:
            with open(_soma_os.path.join(folder, "component.json"), encoding="utf-8-sig") as f:
                meta = _soma_json.load(f)
        except (OSError, ValueError):
            meta = {}
        meta = meta if isinstance(meta, dict) else {}
        label = meta["name"].strip() if isinstance(meta.get("name"), str) and meta["name"].strip() else d
        names.append(repr(label))
        if label.lower() == key or d.lower() in (key, slug):
            return _soma_os.path.abspath(folder), label, meta
    raise ValueError(f"No component {name!r} in {base}. There are: {', '.join(names) or 'none'}")


def _soma_inside(module, folder):
    paths = [getattr(module, "__file__", None)] + list(getattr(module, "__path__", None) or [])
    for p in paths:
        try:
            if p and _soma_os.path.commonpath([_soma_os.path.abspath(p), folder]) == folder:
                return True
        except ValueError:  # other drive
            continue
    return False


def _soma_run(folder, label, meta, values):
    """Runs the component's model in its own folder, with its own modules and parameter values. What belongs to the
    model around it (parts, values, anchors, its modules in sys.modules) is put aside and restored afterwards."""
    entry = _soma_os.path.join(folder, meta["entry"] if isinstance(meta.get("entry"), str) else "model.py")
    if not _soma_os.path.isfile(entry):
        raise ValueError(f"Component {label!r} has no {_soma_os.path.basename(entry)}")
    try:
        with open(_soma_os.path.join(folder, "parameters.json"), encoding="utf-8-sig") as f:
            own = _soma_json.load(f).get("values") or {}
    except (OSError, ValueError, AttributeError):
        own = {}
    outer = _SOMA_STACK[-1] if _SOMA_STACK else _SOMA_DIR
    saved = (list(_SOMA_PARTS), dict(_SOMA_VALUES), dict(_SOMA_ANCHORS), dict(_SOMA_PARAM_NAMES))
    me = _soma_sys.modules.get(__name__)
    stash = {k: m for k, m in list(_soma_sys.modules.items())
             if m is not None and m is not me and k != "__main__" and _soma_inside(m, outer)}
    for k in stash:
        del _soma_sys.modules[k]
    old_cwd, old_path = _soma_os.getcwd(), list(_soma_sys.path)
    _SOMA_PARTS.clear()
    _SOMA_VALUES.clear()
    _SOMA_VALUES.update(own if isinstance(own, dict) else {}, **values)
    _SOMA_ANCHORS.clear()
    _SOMA_PARAM_NAMES.clear()
    _SOMA_STACK.append(folder)
    shown = []  # a component that is a plain CadQuery script: show_object() or `result`, as SOMA builds it
    try:
        _soma_os.chdir(folder)
        _soma_sys.path.insert(0, folder)
        ns = _soma_runpy.run_path(entry, run_name="__main__", init_globals={
            "show_object": lambda obj, name=None, options=None, **_kw: shown.append((obj, name, options)),
            "debug": lambda *_a, **_kw: None, "log": lambda *_a, **_kw: None})
        if not _SOMA_PARTS:
            items = shown or ([(ns["result"], "result", None)] if ns.get("result") is not None else [])
            for i, (obj, nm, options) in enumerate(items):
                rgb = (options or {}).get("color") if isinstance(options, dict) else None
                add_part(str(nm or f"Part {i + 1}"), obj, color=tuple(rgb[:3]) if isinstance(rgb, (tuple, list)) and len(rgb) >= 3 else None)
        if not _SOMA_PARTS:
            raise ValueError(f"Component {label!r} registers no parts with add_part()")
        unknown = [k for k in values if k not in _SOMA_PARAM_NAMES]
        if unknown:
            raise ValueError(f"Component {label!r} has no parameter {', '.join(unknown)}. "
                             f"Its parameters: {', '.join(_SOMA_PARAM_NAMES) or 'none'}")
        result = (list(_SOMA_PARTS), dict(_SOMA_ANCHORS), dict(_SOMA_PARAM_NAMES))
    finally:
        _SOMA_STACK.pop()
        _soma_os.chdir(old_cwd)
        _soma_sys.path[:] = old_path
        for k, m in list(_soma_sys.modules.items()):
            if m is not None and m is not me and k != "__main__" and _soma_inside(m, folder):
                del _soma_sys.modules[k]
        _soma_sys.modules.update(stash)
        _SOMA_PARTS[:] = saved[0]
        _SOMA_VALUES.clear()
        _SOMA_VALUES.update(saved[1])
        _SOMA_ANCHORS.clear()
        _SOMA_ANCHORS.update(saved[2])
        _SOMA_PARAM_NAMES.clear()
        _SOMA_PARAM_NAMES.update(saved[3])
    return result


def component(name, **values):
    """Another SOMA model inside this one, from components/ (SOMA). Here: runs it and returns its parts as a
    cq.Assembly. `values`: its parameters by their constant name."""
    root = _SOMA_STACK[-1] if _SOMA_STACK else _SOMA_DIR
    folder, label, meta = _soma_find(root, name)
    if folder in _SOMA_STACK:
        raise ValueError(f"Component {label!r} contains itself")
    key = (folder, tuple(sorted((k, repr(v)) for k, v in values.items())))
    if key not in _SOMA_BUILT:
        _SOMA_BUILT[key] = _soma_run(folder, label, meta, values)
    parts, anchors, used = _SOMA_BUILT[key]

    def build(asm_name, items, metadata=None):
        asm = _soma_cq.Assembly(name=asm_name, metadata=metadata or {})
        used, done = {asm_name}, set()

        def free(wanted):
            unique, i = wanted, 2
            while unique in used:
                unique, i = f"{wanted} ({i})", i + 1
            used.add(unique)
            return unique

        for groups, p in items:  # in the order of the component
            if not groups:
                if isinstance(p["shape"], _soma_cq.Assembly):
                    asm.add(p["shape"], name=free(p["name"]))
                else:
                    asm.add(p["shape"], name=free(p["name"]), color=_soma_cq.Color(*p["color"]))
            elif groups[0] not in done:
                done.add(groups[0])
                sub = free(groups[0])
                asm.add(build(sub, [(g[1:], q) for g, q in items if g and g[0] == groups[0]]), name=sub)
        return asm

    return build(label, [(tuple(p["groups"]), p) for p in parts], {"soma_anchors": anchors, "soma_params": used})


def _soma_shape(obj):
    if hasattr(obj, "__soma_shape__"):  # standard parts (Screw, Nut ...)
        return obj.__soma_shape__()
    if isinstance(obj, _soma_cq.Workplane):
        vals = obj.vals()
        if not vals:
            raise ValueError("The Workplane is empty (no geometry).")
        return vals[0] if len(vals) == 1 else _soma_cq.Compound.makeCompound(vals)
    if isinstance(obj, (_soma_cq.Shape, _soma_cq.Assembly)):
        return obj
    raise TypeError(f"add_part expects a cq.Workplane, a cq.Shape, a cq.Assembly or a standard part, not {type(obj).__name__}")


def add_part(name, obj, role=None, color=None, group=None, alpha=None):
    """Registers a part (SOMA). Here: collects it for the assembly `result` and for show_object() of the viewer."""
    standard = hasattr(obj, "__soma_shape__")
    role = role or (getattr(obj, "role", "part") if standard else "part")
    if color is None and standard:
        color = getattr(obj, "color", None)
    groups = tuple(s.strip() for s in str(group or "").split("/") if s.strip())
    if role == "reference":
        groups = ("Reference",) + groups
    rgb = tuple(color[:3]) if color else _SOMA_COLORS.get(role, _SOMA_COLORS["part"])
    _SOMA_PARTS.append(dict(name=str(name), shape=_soma_shape(obj), role=role, groups=groups,
                            color=(*rgb, float(alpha) if alpha is not None else 0.45 if role == "reference" else 1.0)))


def _soma_assembly(name="Model"):
    """All parts as a cq.Assembly, groups as sub-assemblies. cq.Assembly needs names that differ from the assembly
    they are added to and from their siblings (SOMA allows a part "X beam" in the group "X beam"): such names get
    " (2)" in the assembly. show_object() keeps the names from add_part()."""
    root = _soma_cq.Assembly(name=name)
    subs, used = {(): root}, {(): {name}}

    def free(parent, wanted):
        taken, unique, i = used[parent], wanted, 2
        while unique in taken:
            unique, i = f"{wanted} ({i})", i + 1
        taken.add(unique)
        return unique

    for p in _SOMA_PARTS:
        for i in range(1, len(p["groups"]) + 1):
            key = p["groups"][:i]
            if key not in subs:
                subs[key] = _soma_cq.Assembly(name=free(key[:-1], key[-1]))
                used[key] = {subs[key].name}
        parent = subs[p["groups"]]
        unique = free(p["groups"], p["name"])
        if isinstance(p["shape"], _soma_cq.Assembly):
            parent.add(p["shape"], name=unique)
        else:
            parent.add(p["shape"], name=unique, color=_soma_cq.Color(*p["color"]))
    # Inner groups first: cq.Assembly copies a sub-assembly when it is added
    for key in sorted((k for k in subs if k), key=len, reverse=True):
        subs[key[:-1]].add(subs[key], name=subs[key].name)
    return root


def _soma_show(namespace):
    """End of the script: `result` for cq-cli and others, show_object() in CQ-editor, else ocp_vscode if installed."""
    assembly = _soma_assembly()
    namespace.setdefault("result", assembly)
    show = namespace.get("show_object") or getattr(_soma_builtins, "show_object", None)
    if show is not None:
        for p in _SOMA_PARTS:
            show(p["shape"], name=p["name"], options={"color": tuple(p["color"][:3]), "alpha": p["color"][3]})
    elif namespace.get("__name__") == "__main__":
        try:
            from ocp_vscode import show as ocp_show
        except ImportError:
            print(f"{len(_SOMA_PARTS)} part(s) in the assembly `result`. To see them, open the script in CQ-editor "
                  "or install ocp_vscode (VS Code).")
        else:
            ocp_show(assembly)
