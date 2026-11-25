"""Components: other SOMA models inside this one (GitHub discussion #21).

A component is a copy of another model (its code, parts/, inputs/ and parameter values) in components/<folder>/.
A linked component remembers where it came from: when the original changes, `soma component list` and the app report
it, and `soma component update` copies the new state in (the old one goes into .soma/component-backups/). A copy is
independent and can be changed freely.

    soma component add ../Drawer.soma            # linked
    soma component add ../Drawer.soma --copy     # independent copy
    soma component list | update [NAME] | unlink NAME | remove NAME
    soma component relink NAME ../moved/Drawer.soma  # the original moved or is on another computer

In model.py:

    from soma import add_part, component
    drawer = component("Drawer", WIDTH=500)      # parameters of the component by their constant name
    drawer.loc = cq.Location((0, 0, 120))
    add_part("Drawer top", drawer, group="Drawers")

Anchors: a model names the points where it attaches (`anchor("back", (0, -200, 60))`), the model that uses it puts
them onto each other (`place(drawer, "back", cabinet, "slot 1")`) instead of computing positions.

Management (add, list, update) works without cadquery, so the app and the agent get answers quickly.
"""
import ast
import hashlib
import json
import os
import re
import shutil
import sys
import time
import zipfile
from pathlib import Path

DIR = "components"
META = "component.json"
BACKUPS = Path(".soma") / "component-backups"
DEFAULT_ENTRY = "model.py"
MAX_BYTES = 500 * 1024 ** 2   # a model with half a gigabyte of inputs is not meant to be copied around
MAX_DEPTH = 8                 # components inside components inside ...

# Not part of a component: history, build results, caches, things of the app, and what only the model itself uses
# (animations, drawings, analyses). AGENTS.md and CLAUDE.md are the agent's instructions of the other model.
SKIP_TOP_DIRS = {".git", ".soma", "output", "exports", "renders", "animations", "drawings", "analyses"}
SKIP_DIRS = {"__pycache__", ".venv", "venv", "env", "node_modules"}
SKIP_TOP_FILES = {"AGENTS.md", "CLAUDE.md", META}


class ComponentError(Exception):
    pass


# ---- Files and fingerprints ----------------------------------------------------------------------------------------

def _keep(rel):
    parts = rel.split("/")
    if any(p in ("", ".", "..") for p in parts) or ":" in parts[0]:
        return False  # unsafe paths from a ZIP never leave the component folder
    if any(p in SKIP_DIRS for p in parts[:-1]):
        return False
    if len(parts) > 1 and (parts[0] in SKIP_TOP_DIRS or parts[0].startswith(".")):
        return False
    if len(parts) == 1 and (parts[0] in SKIP_TOP_FILES or parts[0].startswith(".")):
        return False
    return not parts[-1].endswith((".pyc", ".lock"))


def _read_zip(src):
    files, total, project = {}, 0, {}
    try:
        with zipfile.ZipFile(src) as z:
            for info in z.infolist():
                rel = info.filename.replace("\\", "/")
                if rel == ".soma/project.json":
                    try:
                        project = json.loads(z.read(info).decode("utf-8"))
                    except (ValueError, UnicodeDecodeError):
                        pass
                if info.is_dir() or not _keep(rel):
                    continue
                total += info.file_size
                if total > MAX_BYTES:
                    raise ComponentError(f"{src.name} holds more than {MAX_BYTES // 1024 ** 2} MB of model files, too much for a component")
                files[rel] = z.read(info)
    except (zipfile.BadZipFile, OSError) as e:
        raise ComponentError(f"{src} cannot be read as a SOMA model ({e})") from None
    return files, project if isinstance(project, dict) else {}


def _walk(src):
    """(relative path, path) of the model files in a folder, without what _keep() leaves out."""
    for dirpath, dirnames, filenames in os.walk(src):
        rel_dir = Path(dirpath).relative_to(src).as_posix()
        rel_dir = "" if rel_dir == "." else rel_dir + "/"
        dirnames[:] = sorted(d for d in dirnames if not Path(dirpath, d).is_symlink()
                             and _keep(f"{rel_dir}{d}/x"))
        for f in sorted(filenames):
            rel = rel_dir + f
            p = Path(dirpath, f)
            if not p.is_symlink() and _keep(rel):
                yield rel, p


def _read_dir(src, skip_meta=False):
    files, total = {}, 0
    for rel, p in _walk(src):
        total += p.stat().st_size
        if total > MAX_BYTES:
            raise ComponentError(f"{src} holds more than {MAX_BYTES // 1024 ** 2} MB of model files, too much for a component")
        files[rel] = p.read_bytes()
    project = {}
    pj = Path(src, ".soma", "project.json")
    if not skip_meta and pj.is_file():
        try:
            project = json.loads(pj.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
    return files, project if isinstance(project, dict) else {}


def read_source(src):
    """Files of the model at `src` (a .soma file or a model folder) and its .soma/project.json."""
    src = Path(src)
    if src.is_file():
        return _read_zip(src)
    if src.is_dir():
        return _read_dir(src)
    raise ComponentError(f"{src} does not exist")


def fingerprint(files):
    """One hash over names and contents. Equal for the same files, whether read from a .soma file or a folder."""
    h = hashlib.sha256()
    for rel in sorted(files):
        h.update(rel.encode("utf-8") + b"\0" + hashlib.sha256(files[rel]).digest())
    return h.hexdigest()[:16]


def _cache_file():
    base = os.environ.get("SOMA_CACHE_DIR")
    if not base:
        if sys.platform == "win32":
            base = os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local"
        elif sys.platform == "darwin":
            base = Path.home() / "Library" / "Caches"
        else:
            base = os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache"
    # Not %LOCALAPPDATA%/soma on Windows: that is the app's own data folder
    return Path(base) / ("soma-cache" if sys.platform == "win32" else "soma") / "component-fingerprints.json"


def _stamp(src):
    """Sizes and modification times of the model files, read without opening them."""
    src = Path(src)
    if src.is_file():
        st = src.stat()
        return f"file {st.st_size} {st.st_mtime_ns}"
    h = hashlib.sha256()
    for rel, p in _walk(src):
        st = p.stat()
        h.update(f"{rel}\0{st.st_size}\0{st.st_mtime_ns}\0".encode("utf-8"))
    return "dir " + h.hexdigest()


def source_fingerprint(src):
    """fingerprint() of the model at `src`. Taken from a cache in the user's cache folder (not in the model) while
    sizes and times of its files stay the same: the app checks often, a large original is only read when it changed."""
    key = str(Path(src).resolve())
    try:
        stamp = _stamp(src)
    except OSError:
        stamp = None
    try:
        cache = json.loads(_cache_file().read_text(encoding="utf-8"))
        cache = cache if isinstance(cache, dict) else {}
    except (OSError, ValueError):
        cache = {}
    hit = cache.get(key)
    if stamp and isinstance(hit, dict) and hit.get("stamp") == stamp and isinstance(hit.get("hash"), str):
        return hit["hash"]
    value = fingerprint(read_source(src)[0])
    if stamp:
        cache[key] = dict(stamp=stamp, hash=value, at=time.time())
        if len(cache) > 500:  # the oldest go
            keep = sorted(cache, key=lambda k: cache[k].get("at", 0) if isinstance(cache[k], dict) else 0)[-400:]
            cache = {k: cache[k] for k in keep}
        try:
            f = _cache_file()
            f.parent.mkdir(parents=True, exist_ok=True)
            tmp = f.with_name(f"{f.name}.{os.getpid()}.tmp")
            tmp.write_text(json.dumps(cache), encoding="utf-8")
            os.replace(tmp, f)
        except OSError:
            pass  # only a cache
    return value


# ---- Components of a model ----------------------------------------------------------------------------------------

def _slug(name):
    s = re.sub(r"[^A-Za-z0-9]+", "-", name.strip()).strip("-").lower()
    return s or "component"


def _read_meta(folder):
    try:
        meta = json.loads((folder / META).read_text(encoding="utf-8-sig"))
    except (OSError, ValueError):
        return None
    return meta if isinstance(meta, dict) else None


def folders(root):
    """Component folders of the model, those without component.json too (copied in by hand: they count as copies)."""
    base = Path(root) / DIR
    if not base.is_dir():
        return []
    return sorted(p for p in base.iterdir() if p.is_dir() and not p.name.startswith((".", "__")))


def _meta_of(folder):
    """component.json with checked fields: a hand-edited file with odd values reads as if they were missing."""
    meta = _read_meta(folder) or {}
    name = meta.get("name") if isinstance(meta.get("name"), str) and meta.get("name").strip() else folder.name
    mode = "link" if meta.get("mode") == "link" else "copy"
    out = dict(meta, name=name.strip(), mode=mode)
    for key in ("source", "entry", "hash", "updated"):
        if not isinstance(out.get(key), str) or not out[key].strip():
            out[key] = None
    return out


def find(root, name):
    """Folder and metadata of the component called `name` (its name or its folder, case does not matter)."""
    key = str(name).strip().lower()
    found = [(f, _meta_of(f)) for f in folders(root)]
    for f, m in found:
        if m["name"].lower() == key or f.name.lower() == key or f.name.lower() == _slug(key):
            return f, m
    names = ", ".join(repr(m["name"]) for _, m in found)
    raise ComponentError(f"No component {name!r} in {DIR}/. " + (f"There are: {names}." if names else
                         "Insert one first: soma component add <model.soma or folder> (or Import in the app)."))


def _scan(folder, entry):
    """Parameters (param() calls assigned to a constant) and anchor names (anchor("name", ...)) as read from the code
    of the component, without running it."""
    return _params_in(folder, entry), _anchors_in(folder, entry)


def _anchors_in(folder, entry):
    out = []
    files = [folder / entry] + sorted((folder / "parts").rglob("*.py")) if (folder / "parts").is_dir() else [folder / entry]
    for f in files:
        try:
            tree = ast.parse(f.read_text(encoding="utf-8"))
        except (OSError, SyntaxError, ValueError):
            continue
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Call) and getattr(node.func, "id", getattr(node.func, "attr", None)) == "anchor"
                    and node.args):
                continue
            arg = node.args[0]
            if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                name = arg.value
            elif isinstance(arg, ast.JoinedStr):  # anchor(f"slot {i + 1}", ...): the pattern, the names come when it runs
                name = "".join(v.value if isinstance(v, ast.Constant) else "{" + ast.unparse(v.value) + "}" for v in arg.values)
            else:
                continue
            if name not in out:
                out.append(name)
    return out


def _params_in(folder, entry):
    out = []
    files = [folder / entry] + sorted((folder / "parts").rglob("*.py")) if (folder / "parts").is_dir() else [folder / entry]
    for f in files:
        try:
            tree = ast.parse(f.read_text(encoding="utf-8"))
        except (OSError, SyntaxError, ValueError):
            continue
        for node in ast.walk(tree):
            if not (isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name)):
                continue
            call = node.value
            if not (isinstance(call, ast.Call) and getattr(call.func, "id", getattr(call.func, "attr", None)) == "param"):
                continue
            item = dict(name=node.targets[0].id)
            try:
                if call.args:
                    item["default"] = ast.literal_eval(call.args[0])
                if len(call.args) > 1:
                    item["label"] = ast.literal_eval(call.args[1])
                for kw in call.keywords:
                    if kw.arg in ("label", "unit", "min", "max"):
                        item[kw.arg] = ast.literal_eval(kw.value)
            except ValueError:
                pass
            out.append(item)
    return out


def status(root, check_source=True):
    """List of the components with their state:
    copy      independent copy
    current   linked, same as the original
    outdated  linked, the original has changed: update
    missing   linked, the original is not found (the component keeps working with its copy)
    `changed`: the copy in this model differs from the state it was copied in."""
    out = []
    for folder in folders(root):
        try:
            out.append(_status_of(folder, check_source))
        except (OSError, ComponentError, ValueError) as e:
            out.append(dict(name=folder.name, folder=f"{DIR}/{folder.name}", mode="copy", source=None, updated=None,
                            changed=False, entry=DEFAULT_ENTRY, params=[], anchors=[], state="missing",
                            message=f"{DIR}/{folder.name} cannot be read: {e}"))
    return out


def _status_of(folder, check_source):
    meta = _meta_of(folder)
    local = source_fingerprint(folder)
    entry = meta.get("entry") if isinstance(meta.get("entry"), str) else DEFAULT_ENTRY
    found_params, found_anchors = _scan(folder, entry)
    item = dict(name=meta["name"], folder=f"{DIR}/{folder.name}", mode=meta["mode"], source=meta.get("source"),
                updated=meta.get("updated"), changed=bool(meta.get("hash")) and local != meta.get("hash"),
                entry=entry, params=found_params, anchors=found_anchors, state="copy", message=None)
    if meta["mode"] == "link" and check_source:
        src = meta.get("source")
        if not src or not Path(src).exists():
            where = f"The original is not found ({src})." if src else "The component does not know its original."
            item.update(state="missing", message=f"{where} The component keeps its copy. "
                        "Connect it again with `soma component relink` (in the app: Find the original).")
        else:
            try:
                theirs = source_fingerprint(src)
                item["state"] = "current" if theirs == meta.get("hash") else "outdated"
            except ComponentError as e:
                item.update(state="missing", message=str(e))
    elif meta["mode"] == "link":
        item["state"] = "current"
    return item


def _write_files(folder, files):
    for rel, data in files.items():
        p = folder / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)


def _now():
    return time.strftime("%Y-%m-%dT%H:%M:%S")


def add(root, source, link=True, name=None):
    """Copies the model at `source` into components/ and returns its entry from status()."""
    root = Path(root).resolve()
    src = Path(source).expanduser().resolve()
    if src == root or root in src.parents:
        raise ComponentError("A model cannot contain itself or a folder of its own")
    files, project = read_source(src)
    entry = project.get("entry") if isinstance(project.get("entry"), str) else DEFAULT_ENTRY
    if entry not in files:
        raise ComponentError(f"{src.name} is not a SOMA model: {entry} is missing")
    own = project.get("name") if isinstance(project.get("name"), str) else None
    display = str(name or own or src.stem).strip()
    if not display:
        raise ComponentError("The component needs a name")
    folder = root / DIR / _slug(display)
    taken = [m for m in status(root, check_source=False) if m["name"].lower() == display.lower()]
    if folder.exists() or taken:
        raise ComponentError(f"There is already a component {display!r} ({DIR}/{folder.name}). Update it with "
                             f"`soma component update \"{display}\"` or choose another name with --name")
    _write_files(folder, files)
    meta = dict(name=display, mode="link" if link else "copy", source=str(src), entry=entry,
                hash=fingerprint(files), updated=_now())
    (folder / META).write_text(json.dumps(meta, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    return next(m for m in status(root, check_source=False) if m["folder"] == f"{DIR}/{folder.name}")


def _backup(root, folder):
    # Backups stay out of the history and the model file: the old state is in the history already
    ignore = Path(root) / BACKUPS / ".gitignore"
    if not ignore.is_file():
        ignore.parent.mkdir(parents=True, exist_ok=True)
        ignore.write_text("# Backups of components (soma component update/remove), not part of the history\n*\n",
                          encoding="utf-8", newline="\n")
    dst = Path(root) / BACKUPS / f"{folder.name}-{time.strftime('%Y%m%d-%H%M%S')}"
    i = 2
    while dst.exists():
        dst = dst.with_name(f"{dst.name}-{i}")
        i += 1
    shutil.copytree(folder, dst, ignore=shutil.ignore_patterns("__pycache__"))
    return dst


def update(root, name, force=False):
    """Copies the current state of the original into the linked component. Returns (status entry, backup or None).
    Refuses when the copy in this model was changed, unless `force` (the changes go into the backup)."""
    root = Path(root).resolve()
    folder, meta = find(root, name)
    if meta["mode"] != "link":
        raise ComponentError(f"{meta['name']!r} is an independent copy, it has no original to update from")
    src = meta.get("source")
    if not src or not Path(src).exists():
        raise ComponentError(f"The original of {meta['name']!r} is not found: {src}")
    files, project = read_source(src)
    new_hash = fingerprint(files)
    local = source_fingerprint(folder)
    changed = bool(meta.get("hash")) and local != meta.get("hash")
    if new_hash == meta.get("hash") and not changed:
        return next(m for m in status(root) if m["folder"] == f"{DIR}/{folder.name}"), None
    if changed and not force:
        raise ComponentError(f"{meta['name']!r} was changed in this model ({DIR}/{folder.name}). Updating replaces "
                             "those changes. Run it again with --force to update anyway (the changed copy goes into "
                             f"{BACKUPS.as_posix()}/), or unlink it to keep it as an independent copy")
    entry = project.get("entry") if isinstance(project.get("entry"), str) else meta.get("entry") or DEFAULT_ENTRY
    if entry not in files:
        raise ComponentError(f"The original of {meta['name']!r} has no {entry} anymore, the component stays as it is")
    backup = _backup(root, folder)
    for p in list(folder.iterdir()):
        if p.name == META:
            continue
        shutil.rmtree(p) if p.is_dir() and not p.is_symlink() else p.unlink()
    _write_files(folder, files)
    meta.update(entry=entry, hash=new_hash, updated=_now())
    (folder / META).write_text(json.dumps(meta, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    return next(m for m in status(root) if m["folder"] == f"{DIR}/{folder.name}"), backup


def unlink(root, name):
    """Turns a linked component into an independent copy."""
    folder, meta = find(root, name)
    meta["mode"] = "copy"
    (folder / META).write_text(json.dumps(meta, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    return next(m for m in status(root, check_source=False) if m["folder"] == f"{DIR}/{folder.name}")


def remove(root, name):
    """Takes a component out of the model: its folder goes into the backups. The add_part lines in the model's code
    stay, the caller removes them (the build names them otherwise)."""
    folder, meta = find(root, name)
    backup = _backup(root, folder)
    shutil.rmtree(folder)
    return meta["name"], backup


def relink(root, name, source):
    """Connects a component to its original again, after the original moved (or on another computer), or links a
    copy. The files stay as they are: the state then says whether an update is due."""
    folder, meta = find(root, name)
    src = Path(source).expanduser().resolve()
    files, project = read_source(src)
    entry = project.get("entry") if isinstance(project.get("entry"), str) else DEFAULT_ENTRY
    if entry not in files:
        raise ComponentError(f"{src.name} is not a SOMA model: {entry} is missing")
    root = Path(root).resolve()
    if src == root or root in src.parents:
        raise ComponentError("A model cannot contain itself or a folder of its own")
    raw = _read_meta(folder) or {}
    raw.update(name=meta["name"], mode="link", source=str(src), entry=raw.get("entry") if isinstance(raw.get("entry"), str) else entry)
    if not isinstance(raw.get("hash"), str):  # copied in by hand: the files as they are count as the copied state
        raw["hash"] = source_fingerprint(folder)
    _write_meta(folder, raw)
    return next(m for m in status(root) if m["folder"] == f"{DIR}/{folder.name}")


def _write_meta(folder, meta):
    (folder / META).write_text(json.dumps(meta, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")


# ---- Running a component inside the model (needs cadquery) ---------------------------------------------------------

_STACK = []   # model folders being run: the model, then the component being run inside it, ...
_CACHE = {}   # (folder, parameter values) -> (parts, anchors). A component used several times is built once
ANCHORS = {}  # anchors of the model being run: name -> (point, x direction, normal)


def begin(root):
    """Before the model runs (build.run_model)."""
    _STACK[:] = [Path(root).resolve()]
    _CACHE.clear()
    ANCHORS.clear()


def anchor(name, at=(0, 0, 0), normal=(0, 0, 1), x_dir=None):
    """A named point of this model where it attaches to others, when it is used as a component.

    name     e.g. "back", "slot 1"
    at       the point (x, y, z) in this model, mm
    normal   direction of the anchor (default up, +Z). Only matters when place() should also turn the component
    x_dir    second direction, at right angles to the normal (default: along X). Fixes the turn about the normal

    The model that uses this one as a component places it with place(). Anchors do nothing else, they are not parts.
    """
    from . import cqruntime
    ANCHORS[str(name)] = cqruntime._soma_anchor_data(name, at, normal, x_dir)


def place(obj, anchor, to, to_anchor=None, flip=False):
    """Moves a component so that its anchor sits on a target, and returns it.

    obj        a component: component("Drawer")
    anchor     name of one of its anchors (soma component list shows them)
    to         another component with `to_anchor` (one of its anchors; place that one first), the name of an anchor
               of this model, or a point (x, y, z) or cq.Location
    flip       False: the anchors' directions agree. True: face to face, the normals point against each other

        cabinet = component("Cabinet")
        drawer = place(component("Drawer"), "back", cabinet, "slot 1")
        add_part("Cabinet", cabinet)
        add_part("Drawer", drawer)
    """
    from . import cqruntime
    obj.loc = cqruntime._soma_place(obj, anchor, to, to_anchor, flip, ANCHORS)
    return obj


def _inside(module, root):
    paths = []
    f = getattr(module, "__file__", None)
    if f:
        paths.append(f)
    paths.extend(getattr(module, "__path__", None) or [])  # namespace packages like parts/ without __init__.py
    for p in paths:
        try:
            Path(p).resolve().relative_to(root)
            return True
        except (ValueError, OSError, TypeError):
            continue
    return False


def component(name, **values):
    """Another SOMA model inside this one, as an assembly to register with add_part.

    name     the component in components/ (its name or folder). Insert one with `soma component add` or Import
    values   parameters of the component by their constant name, e.g. component("Drawer", WIDTH=500, HANDLE=False).
             Not given: the component's own values

    Every part of the component becomes a part of this model, in a group named like the add_part call, with the
    groups, colors and roles of the component. Place it with `asm.loc = cq.Location((x, y, z), (0, 0, 1), angle)`.
    Several instances: call component() once per instance (it is built only once per set of values).
    """
    import cadquery as cq
    root = _STACK[-1] if _STACK else Path.cwd().resolve()
    folder, meta = find(root, name)
    folder = folder.resolve()
    if folder in _STACK:
        raise ComponentError(f"Component {meta['name']!r} contains itself")
    if len(_STACK) > MAX_DEPTH:
        raise ComponentError(f"Components are nested more than {MAX_DEPTH} levels deep")
    key = (str(folder), tuple(sorted((k, repr(v)) for k, v in values.items())))
    if key not in _CACHE:
        _CACHE[key] = _run(folder, meta, values)
    return _assembly(cq, meta["name"], folder.name, *_CACHE[key])


def _run(folder, meta, values):
    """Runs the model of the component in its own folder, with its own parts and parameters. Everything of the model
    around it (registered parts, parameters, its modules such as parts.params) is put aside and restored afterwards."""
    import runpy
    from . import cqcompat, params, registry
    entry = folder / (meta.get("entry") if isinstance(meta.get("entry"), str) else DEFAULT_ENTRY)
    if not entry.is_file():
        raise ComponentError(f"Component {meta['name']!r} has no {entry.name} ({DIR}/{folder.name})")
    outer = _STACK[-1] if _STACK else Path.cwd().resolve()
    saved = dict(reg=list(registry.REGISTRY), ignore=registry.IGNORE_ADD, params=list(params.PARAMS),
                 warnings=list(params.WARNINGS), user=params._USER, trees=dict(params._TREES), shown=list(cqcompat.SHOWN),
                 anchors=dict(ANCHORS), given=params._GIVEN)
    stash = {k: m for k, m in list(sys.modules.items()) if m is not None and _inside(m, outer)}
    for k in stash:
        del sys.modules[k]
    old_cwd, old_path = os.getcwd(), list(sys.path)
    registry.REGISTRY.clear()
    registry.IGNORE_ADD = False  # also when an animation imports the model: the component has to deliver its parts
    cqcompat.SHOWN.clear()
    ANCHORS.clear()
    params.begin(folder)  # the component's own parameters.json
    params._GIVEN = dict(values)  # values from component(): checked as such, not as values set in the app
    _STACK.append(folder)
    try:
        os.chdir(folder)
        sys.path.insert(0, str(folder))
        ns = runpy.run_path(str(entry), init_globals=cqcompat.script_globals(), run_name="__main__")
        if not registry.REGISTRY:
            cqcompat.register_shown(ns, entry)
        if not registry.REGISTRY:
            raise ComponentError(f"Component {meta['name']!r} registers no parts")
        known = [p["name"] for p in params.PARAMS]
        unknown = [k for k in values if k not in known]
        if unknown:
            raise ComponentError(f"Component {meta['name']!r} has no parameter {', '.join(unknown)}. "
                                 f"Its parameters: {', '.join(known) or 'none'}")
        parts = [dict(name=p["name"], shape=p["shape"], role=p["role"], color=p["color"], group=p["group"],
                      fastener=p.get("fastener")) for p in registry.REGISTRY]
        used = {p["name"]: p["value"] for p in params.PARAMS}
        warnings = [f"Component {meta['name']}: {w}" for w in params.WARNINGS]
        anchors = dict(ANCHORS)
    finally:
        _STACK.pop()
        os.chdir(old_cwd)
        sys.path[:] = old_path
        for k, m in list(sys.modules.items()):
            if m is not None and _inside(m, folder):
                del sys.modules[k]
        sys.modules.update(stash)
        registry.REGISTRY[:] = saved["reg"]
        registry.IGNORE_ADD = saved["ignore"]
        params.PARAMS[:] = saved["params"]
        params.WARNINGS[:] = saved["warnings"]
        params._USER = saved["user"]
        params._GIVEN = saved["given"]
        params._TREES.clear()
        params._TREES.update(saved["trees"])
        cqcompat.SHOWN[:] = saved["shown"]
        ANCHORS.clear()
        ANCHORS.update(saved["anchors"])
    params.WARNINGS.extend(w for w in warnings if w not in params.WARNINGS)
    return parts, anchors, used


def _assembly(cq, name, slug, parts, anchors, used):
    """The parts as a cq.Assembly with the groups of the component. Built from the bottom up (add() copies).
    cq.Assembly wants names that differ from the assembly above and from their siblings ("Gear" in the model "Gear"):
    such nodes get " (2)", their real name is in the metadata (soma_name), which registry._leaves reads."""
    def build(asm_name, label, items, metadata):
        asm = cq.Assembly(name=asm_name, metadata=dict(metadata, soma_name=label))
        used_names, done = {asm_name}, set()

        def free(wanted):
            unique, i = wanted, 2
            while unique in used_names:
                unique, i = f"{wanted} ({i})", i + 1
            used_names.add(unique)
            return unique

        for groups, p in items:  # in the order of the component, so the tree shows it the same way
            if not groups:
                meta = dict(soma_role=p["role"], soma_alpha=p["color"][3], soma_name=p["name"])
                if p.get("fastener") is not None:
                    meta["soma_fastener"] = p["fastener"]
                asm.add(p["shape"], name=free(p["name"]), color=cq.Color(*p["color"][:3]), metadata=meta)
            elif groups[0] not in done:
                done.add(groups[0])
                sub = free(groups[0])
                asm.add(build(sub, groups[0], [(g[1:], q) for g, q in items if g and g[0] == groups[0]], {}), name=sub)
        return asm
    return build(name, name, [(tuple(p["group"]), p) for p in parts],
                 dict(soma_component=slug, soma_anchors=anchors, soma_params=dict(used)))
