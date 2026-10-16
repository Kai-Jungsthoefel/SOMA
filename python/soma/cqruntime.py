# SPDX-License-Identifier: Apache-2.0
# SOMA compatibility layer: add_part(), param(), import_step() and import_assembly() in plain CadQuery.
# Copyright the SOMA contributors. Licensed under the Apache License 2.0, https://www.apache.org/licenses/LICENSE-2.0
# (E101). "Export as CadQuery" puts this file into exported models (cqexport.py): as a block in a single script, or as
# soma_compat.py next to it. It must run without soma, with CadQuery only. Everything up to the end marker is copied.
import builtins as _soma_builtins
import inspect as _soma_inspect
import linecache as _soma_linecache
import os as _soma_os
import re as _soma_re

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
    """Imports a STEP file as one shape."""
    return _soma_cq.importers.importStep(_soma_path(path)).val()


def import_assembly(path):
    """Imports a STEP file with its structure as a cq.Assembly."""
    return _soma_cq.Assembly.importStep(_soma_path(path))


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


def add_part(name, obj, role=None, color=None, group=None):
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
                            color=(*rgb, 0.45 if role == "reference" else 1.0)))


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
