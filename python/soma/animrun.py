"""`soma anim`: Animationsdateien (animations/*.py) ausfuehren, abtasten und als glTF-Animation schreiben (E58).

Ergebnis je Animation: .soma/anim/<id>.glb mit einem Knoten je bewegtem Bauteil (Name wie in add_part), einer Kamera und
ihrem Zielpunkt, abgetastet mit 30 Bildern je Sekunde. Texte, Hervorhebungen und der Ablauf stehen in den extras.
Dazu .soma/anim/index.json: welche Animationen es gibt, aus welcher Datei, und Fehler je Datei.
"""
import json
import math
import os
import runpy
import sys
import time
import types
from pathlib import Path

import numpy as np

from . import anim, build, cqcompat, gltf, registry

ANIM_DIR = "animations"
OUT_DIR = Path(".soma") / "anim"
# Arten eines Treffers in soma anim check. Vor E73 standen sie deutsch in .check.json, read_check() setzt sie um
COLLISION, TOO_CLOSE = "collision", "too close"
_OLD_KINDS = {"Kollision": COLLISION, "zu nah": TOO_CLOSE}


class AnimError(Exception):
    pass


def _rel(p, root):
    return build._rel(p, root)


def anim_files(root):
    d = Path(root) / ANIM_DIR
    return sorted(p for p in d.glob("*.py") if p.is_file() and not p.name.startswith("_")) if d.is_dir() else []


def newest_source(root, extra=()):
    """Neuester Aenderungszeitpunkt des Modells (Einstiegspunkt, *.py im Projektordner, parts/, inputs/, die Werte aus dem
    Parameter-Panel in parameters.json) und weiterer Dateien. Gleiche Regel wie newestSourceMtime in der App (build.ts)."""
    root = Path(root)
    newest = 0.0
    for top in ("parts", "inputs"):
        for dirpath, dirs, files in os.walk(root / top):
            dirs[:] = [d for d in dirs if d != "__pycache__"]
            for f in files:
                try:
                    newest = max(newest, os.path.getmtime(os.path.join(dirpath, f)))
                except OSError:
                    pass
    for p in list(root.glob("*.py")) + [root / "parameters.json"] + [Path(x) for x in extra]:
        try:
            newest = max(newest, p.stat().st_mtime)
        except OSError:
            pass
    return newest


def read_index(root):
    try:
        return json.loads((Path(root) / OUT_DIR / "index.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return dict(version=1, animations=[], errors=[])


def _parts_info(parts):
    out = []
    for p in parts:
        bb = p["shape"].BoundingBox()
        out.append(dict(name=p["name"], group=tuple(p.get("group", ())), bbox=((bb.xmin, bb.ymin, bb.zmin), (bb.xmax, bb.ymax, bb.zmax))))
    return out


def _run_file(root, path):
    """Fuehrt eine Animationsdatei aus und gibt ihre Animationen zurueck. Die Datei darf `from model import ...` nutzen:
    add_part() bleibt dabei wirkungslos, die Bauteile kennt soma schon aus dem Build."""
    anim.ANIMATIONS.clear()
    old_cwd = os.getcwd()
    os.chdir(root)
    sys.path.insert(0, str(root))
    registry.IGNORE_ADD = True
    # Das Modell ist eben gelaufen: sein Namensraum wird das Modul `model`, `from model import ...` fuehrt es nicht noch
    # einmal aus (das kostete bei grossen Modellen so lange wie ein ganzer Build).
    mod_name, old_mod = None, None
    if build.LAST_RUN and Path(build.LAST_RUN[0]).resolve().parent == Path(root).resolve() and build.LAST_RUN[0].stem.isidentifier():
        script, ns = build.LAST_RUN
        mod_name, old_mod = script.stem, sys.modules.get(script.stem)
        mod = types.ModuleType(mod_name)
        mod.__dict__.update(ns)
        mod.__name__, mod.__file__ = mod_name, str(script)
        sys.modules[mod_name] = mod
    try:
        with cqcompat.hooks():  # importiert die Datei ein CadQuery-Skript mit show_object(), bleibt das wirkungslos
            runpy.run_path(str(path), run_name="__main__")
    except SystemExit as e:
        if e.code not in (None, 0):
            raise build.BuildError(f"{_rel(path, root)} exited with code {e.code}", file=_rel(path, root), kind="SystemExit")
    except BaseException as e:
        raise build._error_from_exception(e, root)
    finally:
        registry.IGNORE_ADD = False
        if mod_name:
            if old_mod is None:
                sys.modules.pop(mod_name, None)
            else:
                sys.modules[mod_name] = old_mod
        os.chdir(old_cwd)
        if sys.path and sys.path[0] == str(root):
            sys.path.pop(0)
    found = list(anim.ANIMATIONS)
    if not found:
        raise build.BuildError(f"{_rel(path, root)} creates no animation. Start with a = Animation(\"Name\") "
                               "(from soma.anim import Animation).", file=_rel(path, root), kind="NoAnimation")
    return found


def load(root, only=None):
    """Modell bauen (nur ausfuehren) und Animationsdateien laufen lassen. Liefert (Bauteile, [(datei, [Animation] | BuildError)])."""
    root = Path(root).resolve()
    parts = build.run_model(root)
    anim._PARTS = _parts_info(parts)
    files = anim_files(root)
    if only is not None:
        files = [f for f in files if f.resolve() == Path(only).resolve()]
    results = []
    for f in files:
        try:
            results.append((f, _run_file(root, f)))
        except build.BuildError as e:
            results.append((f, e))
    return parts, results


# ---- Abtasten ---------------------------------------------------------------------------------------------------

def sample_times(duration):
    n = max(2, int(math.ceil(duration * anim.SAMPLE_FPS)) + 1)
    return np.linspace(0.0, duration, n)


def _corners(bbox):
    (x0, y0, z0), (x1, y1, z1) = bbox
    return np.array([[x, y, z, 1.0] for x in (x0, x1) for y in (y0, y1) for z in (z0, z1)])


def _fit(a, names, times, poses):
    """Mitte und Abstand, damit die Bauteile ueber die ganze Bewegung ins Bild passen (wie viewer.setView)."""
    info = {p["name"]: p for p in anim._PARTS}
    pts = []
    for n in names or info.keys():
        c = _corners(info[n]["bbox"])
        if n in poses[0]:
            for k in range(len(times)):
                pts.append((poses[k][n] @ c.T).T[:, :3])
        else:
            pts.append(c[:, :3])
    pts = np.concatenate(pts)
    lo, hi = pts.min(axis=0), pts.max(axis=0)
    center = (lo + hi) / 2
    radius = max(float(np.linalg.norm(hi - lo)) / 2, 1.0)
    return center, radius / math.sin(math.radians(anim.FOV / 2)) * 1.05


def _slerp_dir(d0, d1, s):
    d = float(np.clip(np.dot(d0, d1), -1, 1))
    if d > 0.9995:
        v = d0 + (d1 - d0) * s
        return v / np.linalg.norm(v)
    if d < -0.9995:  # genau gegenueber: ueber die Hochachse herumschwenken
        perp = np.cross(d0, (0, 0, 1))
        perp = perp / np.linalg.norm(perp) if np.linalg.norm(perp) > 1e-9 else np.array([1.0, 0, 0])
        th = math.pi * s
        return d0 * math.cos(th) + perp * math.sin(th)
    th = math.acos(d)
    return (math.sin((1 - s) * th) * d0 + math.sin(s * th) * d1) / math.sin(th)


def _rot_z(d, deg):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return np.array([c * d[0] - s * d[1], s * d[0] + c * d[1], d[2]])


def _tilt(d, deg):
    el = math.asin(max(-1.0, min(1.0, d[2])))
    az = math.atan2(d[1], d[0])
    el = max(-math.radians(89), min(math.radians(89), el + math.radians(deg)))
    return np.array([math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el)])


def camera_track(a, times, poses):
    """Kamera je Abtastzeit: (Mitte, Richtung zur Kamera, Abstand). auto: Die Animation legt keine Kamera fest."""
    fit_cache = {}

    def fit(names):
        key = tuple(names) if names else None
        if key not in fit_cache:
            fit_cache[key] = _fit(a, names, times, poses)
        return fit_cache[key]

    def resolve(spec, cur):
        target, d, dist = cur
        if "dir" in spec:
            d = np.asarray(spec["dir"], dtype=float)
        if "fit" in spec:
            target, dist = fit(spec["fit"])
        if "target" in spec:
            target = np.asarray(spec["target"], dtype=float)
        if "distance" in spec:
            dist = spec["distance"]
        if "zoom" in spec:
            dist = dist / spec["zoom"]
        return (np.asarray(target, dtype=float), d / np.linalg.norm(d), float(dist))

    t0, dist0 = fit(None)
    start = (t0, np.asarray(anim.VIEWS["iso"], dtype=float) / np.linalg.norm(anim.VIEWS["iso"]), dist0)
    ops = a.camera.ops
    # Jede Bewegung beginnt beim Ende der vorigen
    plan, cur = [], start
    for op in ops:
        if op["kind"] in ("set", "move"):
            end = resolve(op["spec"], cur)
        elif op["kind"] == "orbit":
            d = _tilt(_rot_z(cur[1], op["spec"]["orbit"]), op["spec"]["tilt"])
            end = (cur[0], d, cur[2])
        else:
            end = (cur[0], cur[1], cur[2] / op["spec"]["zoom"])
        plan.append((op, cur, end))
        cur = end

    def at(t):
        state = start
        for op, s0, s1 in plan:
            if t >= op["t1"] and not (op["t0"] == op["t1"] and t < op["t0"]):
                state = s1
            elif op["t0"] <= t < op["t1"]:
                s = op["ease"]((t - op["t0"]) / (op["t1"] - op["t0"]))
                if op["kind"] == "orbit":
                    d = _tilt(_rot_z(s0[1], op["spec"]["orbit"] * s), op["spec"]["tilt"] * s)
                    return (s0[0], d, s0[2])
                if op["kind"] == "zoom":
                    return (s0[0], s0[1], s0[2] / op["spec"]["zoom"] ** s)
                target = s0[0] + (s1[0] - s0[0]) * s
                dist = math.exp(math.log(s0[2]) + (math.log(s1[2]) - math.log(s0[2])) * s)
                return (target, _slerp_dir(s0[1], s1[1], s), dist)
            else:
                break
        return state

    return [at(t) for t in times], not ops


def _camera_quat(d):
    """Lage einer glTF-Kamera (schaut entlang -Z, oben +Y), die entlang -d blickt, mit Z nach oben."""
    z = d / np.linalg.norm(d)
    x = np.cross((0.0, 0.0, 1.0), z)
    if np.linalg.norm(x) < 1e-9:
        x = np.array([1.0, 0.0, 0.0])
    x = x / np.linalg.norm(x)
    y = np.cross(z, x)
    m = np.eye(4)
    m[:3, 0], m[:3, 1], m[:3, 2] = x, y, z
    return anim._quat(m)


def _spans(a, duration):
    """Hervorhebungen, ausgeblendete und durchsichtige Bauteile als Zeitspannen je Bauteil."""
    pairs = {"highlight": ("highlight", "unhighlight"), "hidden": ("hide", "show"), "ghost": ("ghost", "solid")}
    out = {}
    for key, (on, off) in pairs.items():
        spans, open_ = {}, {}
        for e in sorted(a.events, key=lambda e: e["t"]):
            for p in e["parts"]:
                if e["kind"] == on and p not in open_:
                    open_[p] = e["t"]
                elif e["kind"] == off and p in open_:
                    spans.setdefault(p, []).append([round(open_.pop(p), 4), round(e["t"], 4)])
        for p, t in open_.items():
            spans.setdefault(p, []).append([round(t, 4), round(duration, 4)])
        out[key] = spans
    return out


def finalize(a):
    """Abgetastete Daten einer Animation (fuer die Datei, die Textausgabe und die Pruefung)."""
    duration = a.duration
    if duration <= 0:
        raise build.BuildError(f"The animation {a.name!r} is empty: it needs play(), wait() or title() for time to pass.",
                               file=a.file, line=a.line, kind="EmptyAnimation")
    times = sample_times(duration)
    poses = [a.poses(t) for t in times]
    cams, auto = camera_track(a, times, poses)
    captions = []
    for i, c in enumerate(a.captions):
        nxt = next((x["start"] for x in a.captions[i + 1:] if x["start"] >= c["start"]), duration)
        end = c["end"] if c["end"] is not None else nxt
        if c["text"] and end > c["start"]:
            captions.append(dict(start=round(c["start"], 4), end=round(min(end, duration), 4), text=c["text"]))
    info = {p["name"]: p for p in anim._PARTS}
    labels = []
    for lb in a.labels:
        at = lb["at"]
        if at is None:
            (x0, y0, z0), (x1, y1, z1) = info[lb["part"]]["bbox"]
            at = [(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]
        labels.append(dict(start=round(lb["start"], 4), end=round(lb["end"] if lb["end"] is not None else duration, 4),
                           text=lb["text"], part=lb["part"], at=[round(v, 4) for v in at]))
    return dict(times=times, poses=poses, cams=cams, auto=auto, duration=duration, captions=captions, labels=labels,
                titles=[dict(t, start=round(t["start"], 4), end=round(t["end"], 4)) for t in a.titles],
                spans=_spans(a, duration))


def write_glb(root, a, data):
    """.soma/anim/<id>.glb: Knoten je bewegtem Bauteil, Kamera und Ziel, eine Animation, Metadaten in extras."""
    g = gltf.Glb()
    times = data["times"]
    t_acc = g.accessor(times.astype(np.float32), "SCALAR", minmax=True)
    channels, samplers, children = [], [], []

    def channel(node, path, values, kind):
        samplers.append(dict(input=t_acc, output=g.accessor(np.asarray(values, dtype=np.float32), kind), interpolation="LINEAR"))
        channels.append(dict(sampler=len(samplers) - 1, target=dict(node=node, path=path)))

    for name in a.moving_parts():
        ms = [p[name] for p in data["poses"]]
        n = g.node(name=name, extras=dict(soma=dict(part=name)))
        children.append(n)
        channel(n, "translation", [m[:3, 3] for m in ms], "VEC3")
        quats = [anim._quat(m) for m in ms]
        for i in range(1, len(quats)):  # auf derselben Halbkugel bleiben, sonst dreht die Interpolation den langen Weg
            if np.dot(quats[i - 1], quats[i]) < 0:
                quats[i] = -quats[i]
        channel(n, "rotation", quats, "VEC4")
    cam = g.node(name="camera", camera=g.camera(math.radians(anim.FOV)), extras=dict(soma=dict(camera=True)))
    tgt = g.node(name="camera-target", extras=dict(soma=dict(cameraTarget=True)))
    children += [cam, tgt]
    channel(cam, "translation", [c[0] + c[1] * c[2] for c in data["cams"]], "VEC3")
    quats = [_camera_quat(c[1]) for c in data["cams"]]
    for i in range(1, len(quats)):
        if np.dot(quats[i - 1], quats[i]) < 0:
            quats[i] = -quats[i]
    channel(cam, "rotation", quats, "VEC4")
    channel(tgt, "translation", [c[0] for c in data["cams"]], "VEC3")
    g.animations.append(dict(name=a.name, channels=channels, samplers=samplers))
    root_node = g.node(name="soma-animation", children=children)
    meta = dict(version=1, id=a.id, name=a.name, file=_rel(a.file, root), line=a.line, duration=round(data["duration"], 4),
                fps=anim.SAMPLE_FPS, fov=anim.FOV, cameraAuto=data["auto"], parts=a.moving_parts(),
                captions=data["captions"], titles=data["titles"], labels=data["labels"], states=data["spans"],
                steps=a.steps, built=time.time())
    out = Path(root) / OUT_DIR
    out.mkdir(parents=True, exist_ok=True)
    path = out / f"{a.id}.glb"
    tmp = path.with_suffix(".glb.part")
    g.write(tmp, [root_node], extras=dict(soma_animation=meta))
    gltf.replace(tmp, path)
    return path


def build_all(root, only=None):
    """Baut alle Animationen (oder die einer Datei). Liefert dict(built=[...], errors=[...]) und schreibt index.json.
    Ein kaputtes Modell ist ein Fehler fuer alle Animationen."""
    root = Path(root).resolve()
    old = read_index(root)
    try:
        _parts, results = load(root, only)
    except build.BuildError as e:
        raise AnimError(f"The model does not build, so no animation does either: {e.message}"
                        + (f" ({e.file}:{e.line})" if e.file and e.line else "")) from None
    done_files = {_rel(f, root) for f, _ in results}
    keep = [x for x in old.get("animations", []) if x.get("file") not in done_files and (root / x.get("file", "")).is_file()]
    errors = [x for x in old.get("errors", []) if x.get("file") not in done_files and (root / x.get("file", "")).is_file()]
    built, taken = [], {x["id"]: x["file"] for x in keep}
    for f, res in results:
        rel = _rel(f, root)
        if isinstance(res, build.BuildError):
            errors.append(dict(file=res.file or rel, line=res.line, message=res.message, traceback=res.tb))
            continue
        for a in res:
            try:
                if a.id in taken:
                    raise build.BuildError(f"The animation {a.name!r} already exists (in {taken[a.id]}). Names must be unique.",
                                           file=_rel(a.file, root), line=a.line, kind="DuplicateName")
                taken[a.id] = rel
                data = finalize(a)
                path = write_glb(root, a, data)
                built.append(dict(id=a.id, name=a.name, file=rel, line=a.line, duration=round(data["duration"], 4),
                                  built=time.time(), glb=path.relative_to(root).as_posix(), parts=len(a.moving_parts())))
            except build.BuildError as e:
                errors.append(dict(file=e.file or rel, line=e.line, message=e.message, traceback=e.tb))
            except Exception as e:  # Fehler beim Abtasten, etwa unbrauchbare Werte
                err = build._error_from_exception(e, root)
                errors.append(dict(file=err.file or rel, line=err.line, message=err.message, traceback=err.tb))
    # Dateien von Animationen, die es nicht mehr gibt (umbenannt oder geloescht), sind Zwischenstaende der App
    keep_ids = {x["id"] for x in keep} | {x["id"] for x in built}
    for x in old.get("animations", []):
        if x["id"] not in keep_ids:
            for suffix in (".glb", ".check.json"):
                try:
                    (root / OUT_DIR / f"{x['id']}{suffix}").unlink()
                except OSError:
                    pass
    index = dict(version=1, animations=sorted(keep + built, key=lambda x: (x["file"], x["line"] or 0)), errors=errors)
    (root / OUT_DIR).mkdir(parents=True, exist_ok=True)
    (root / OUT_DIR / "index.json").write_text(json.dumps(index, indent=1, ensure_ascii=False), encoding="utf-8")
    return dict(built=built, errors=errors, index=index)


def find(root, name):
    """Eintrag einer Animation im Index: nach Name, Kennung oder Datei."""
    idx = read_index(root)
    for x in idx.get("animations", []):
        if name in (x["name"], x["id"]) or Path(name).as_posix() == x["file"]:
            return x
    return None


def is_stale(root, entry):
    try:
        built = (Path(root) / entry["glb"]).stat().st_mtime
    except OSError:
        return True
    return newest_source(root, [Path(root) / entry["file"]]) > built


def ensure(root, name):
    """Animation fertig gebaut und aktuell? Sonst bauen. Liefert den Index-Eintrag oder wirft AnimError mit Erklaerung."""
    root = Path(root).resolve()
    e = find(root, name)
    if e is not None and not is_stale(root, e):
        return e
    # Veraltet: nur die eigene Datei neu bauen. Unbekannt: alle (vielleicht ist die Datei neu)
    res = build_all(root, root / e["file"] if e else None)
    e = find(root, name)
    if e is None:  # Eine Datei mit Fehler verliert ihre Eintraege, die Meldung nennt den Fehler
        names = [x["name"] for x in res["index"]["animations"]]
        msg = f"No animation {name!r}."
        if res["errors"]:
            msg += " Errors: " + "; ".join(f"{x['file']}{':' + str(x['line']) if x.get('line') else ''}: {x['message']}" for x in res["errors"])
        msg += f" Available: {', '.join(repr(n) for n in names)}." if names else f" There is no animation without errors in {ANIM_DIR}/ yet."
        raise AnimError(msg)
    return e


def read_meta(root, entry):
    return gltf.read_json(Path(root) / entry["glb"])["extras"]["soma_animation"]


# ---- Text fuer den Agenten --------------------------------------------------------------------------------------

def _t(x):
    return f"{x:.2f}"


SHORT_STEP = 0.5  # s: kuerzere Bewegungen desselben Gelenks ohne Luecke fasst der Ablauf zusammen


def _g(v):
    return f"{round(v, 2):g}"


def _merge(run):
    """Eine Folge kurzer Schritte eines Gelenks (oder der Kamera) als ein Eintrag."""
    first, n = run[0], len(run)
    s = dict(start=first["start"], end=run[-1]["end"])
    if first.get("unit"):
        vals = [x["v0"] for x in run] + [x["v1"] for x in run]
        v0, v1, lo, hi = first["v0"], run[-1]["v1"], min(vals), max(vals)
        text = f"{first['label']}: {_g(v0)} -> {_g(v1)} {first['unit']}"
        if lo < min(v0, v1) - 1e-6 or hi > max(v0, v1) + 1e-6:
            text += f", in between {_g(lo)} to {_g(hi)} {first['unit']}"
    elif first["key"] == "camera" and all("orbit" in x for x in run):
        orbit, tilt = sum(x["orbit"] for x in run), sum(x["tilt"] for x in run)
        text = f"Camera: orbit {_g(orbit)} deg" + (f", tilt {_g(tilt)} deg" if abs(tilt) > 1e-9 else "")
    else:
        text = first["text"].split(":")[0] + ": movement"
    s["text"] = f"{text} ({n} steps)"
    return s


def _compact_steps(steps):
    """Viele kurze, lueckenlose Schritte desselben Gelenks (Schleife mit play(), etwa fuer eine gekoppelte Bewegung) als eine
    Zeile. Andere Eintraege (Untertitel, Pausen, lange Bewegungen) unterbrechen eine Folge, damit der Ablauf lesbar bleibt."""
    out, runs = [], {}

    def flush(key):
        run = runs.pop(key)
        if len(run) >= 3:
            out.append(_merge(run))
        else:
            out.extend(run)

    for s in steps:
        key = s.get("key")
        if key is None or s["end"] - s["start"] > SHORT_STEP:
            for k in list(runs):
                flush(k)
            out.append(s)
            continue
        run = runs.get(key)
        if run and abs(run[-1]["end"] - s["start"]) > 1e-6:
            flush(key)
            run = None
        if run is None:
            runs[key] = [s]
        else:
            run.append(s)
    for k in list(runs):
        flush(k)
    return sorted(out, key=lambda s: s["start"])


def info_text(root, entry):
    m = read_meta(root, entry)
    lines = [f"Animation \"{m['name']}\" ({m['file']} line {m['line']}), duration {_t(m['duration'])} s",
             f"Moving parts: {', '.join(m['parts']) or 'none'}",
             "Camera: " + ("none of its own (default view iso, everything in the picture)" if m["cameraAuto"] else "own settings and moves"),
             "", "Sequence:"]
    for s in _compact_steps(m["steps"]):
        span = f"{_t(s['start'])}-{_t(s['end'])} s" if s["end"] > s["start"] else f"{_t(s['start'])} s"
        lines.append(f"  {span:<16} {s['text']}")
    if m["captions"]:
        lines += ["", "Captions:"] + [f"  {_t(c['start'])}-{_t(c['end'])} s  \"{c['text']}\"" for c in m["captions"]]
    if m["labels"]:
        lines += ["", "Labels:"] + [
            f"  {_t(lb['start'])}-{_t(lb['end'])} s  \"{lb['text']}\"" + (f" on {lb['part']}" if lb["part"] else "")
            + " at ({:.1f}, {:.1f}, {:.1f})".format(*lb["at"]) for lb in m["labels"]]
    chk = read_check(root, entry)
    if chk:
        lines += ["", check_text(chk)]
    else:
        lines += ["", "Collisions: not checked (soma anim check \"" + m["name"] + "\")"]
    return "\n".join(lines)


# ---- Kollisionspruefung -----------------------------------------------------------------------------------------

def _location(m):
    import cadquery as cq
    from OCP.gp import gp_Trsf
    t = gp_Trsf()
    t.SetValues(*[float(m[r, c]) for r in range(3) for c in range(4)])
    return cq.Location(t)


def _signed(f, pts):
    """Vorzeichenbehafteter Abstand der Punkte zur Oberflaeche (negativ: innen), in einem Aufruf ueber VTK."""
    from vtkmodules.util.numpy_support import numpy_to_vtk, vtk_to_numpy
    from vtkmodules.vtkCommonCore import vtkDoubleArray
    if not len(pts):
        return np.empty(0)
    out = vtkDoubleArray()
    f.FunctionValue(numpy_to_vtk(np.ascontiguousarray(pts, dtype=np.float64), deep=True), out)
    return vtk_to_numpy(out).copy()


VOL_MIN = 1e-3  # mm3: kleinere Schnittmengen der B-Rep-Koerper sind Rechenrauschen an Beruehrflaechen


def check(root, name, step=0.1, gap=0.0):
    """Prueft die Bewegung: Ueberschneiden sich Bauteile (oder kommen sich naeher als gap mm)? Bewegte Bauteile gegen alle
    anderen, zu jedem Zeitpunkt im Abstand step und am Ende jeder laengeren Bewegung. Schreibt .soma/anim/<id>.check.json.

    Gerechnet wird auf den Dreiecksnetzen (VTK): Wie tief liegen Ecken des einen Teils im anderen, wie nah kommen sie ihm?
    Der genaue Abstand zweier B-Rep-Koerper (BRepExtrema) brauchte bei Zahnraedern Sekunden je Paar und Zeitpunkt.
    Genau ist das auf die doppelte Netztoleranz (`tolerance`, wie die Beruehrung in soma analyze). vtkCollisionDetection-
    Filter (schneiden sich die Oberflaechen?) stuerzte zusammen mit vtkImplicitPolyDataDistance gelegentlich ab, deshalb
    nur Abstaende an den Ecken der unterteilten Netze. Teile, die sich schon in der Lage im Modell beruehren (Nocken und Stoessel, Bolzen in der Bohrung), sind
    eine gewollte Beruehrung: Kollision erst, wenn eines tiefer eindringt. Bei allen anderen entscheidet ueber eine
    Beruehrung ohne tiefe Ecke die Schnittmenge der B-Rep-Koerper. Ebenso ist Spiel aus dem Modell, das enger als gap ist,
    so konstruiert: "zu nah" nur, wenn es in der Bewegung enger wird."""
    from vtkmodules.vtkCommonCore import vtkObject, vtkSMPTools
    vtkObject.GlobalWarningDisplayOff()  # OBB-Baeume melden flache Zellen als Warnung, hier kein Fehler
    # FunctionValue rechnet mit vtkSMPTools parallel, vtkImplicitPolyDataDistance haelt aber Zwischenwerte im Objekt
    backend = vtkSMPTools.GetBackend()
    vtkSMPTools.SetBackend("Sequential")
    try:
        return _check(root, name, step, gap)
    finally:
        vtkSMPTools.SetBackend(backend)


def _check(root, name, step, gap):
    from scipy.spatial import cKDTree
    from vtkmodules.vtkFiltersCore import vtkImplicitPolyDataDistance
    from . import mesher
    from .analysis import _polydata, _subdivide
    from .progress import Progress
    t_start = time.perf_counter()
    root = Path(root).resolve()
    entry = ensure(root, name)
    parts, results = load(root, root / entry["file"])
    a = next((x for _f, res in results if not isinstance(res, build.BuildError) for x in res if x.id == entry["id"]), None)
    if a is None:
        raise AnimError(f"The animation {name!r} could not be loaded again.")
    tol = build.auto_tolerance([p["shape"] for p in parts])
    pen = round(max(0.01, 2 * tol), 4)
    raw = {p["name"]: mesher.mesh_shape(p["shape"], tol, 0.3) for p in parts}
    raw = {n: m for n, m in raw.items() if m["indices"].size}
    lo_all = np.min([m["positions"].min(axis=0) for m in raw.values()], axis=0)
    hi_all = np.max([m["positions"].max(axis=0) for m in raw.values()], axis=0)
    # Gemessen wird an den Ecken der Netze. Lange Kanten werden deshalb unterteilt: Eine Welle durch eine Wand haette sonst
    # nur Ecken an ihren Enden, keine davon laege in der Wand. Aufloesung `resolution`, wie die Messstellen von soma analyze.
    res_h = max(float(np.linalg.norm(hi_all - lo_all)) / 100, 0.2)
    meshes = {}
    for n, m in raw.items():
        pos, _nrm, idx = _subdivide(m["positions"].astype(float), m["normals"].astype(float), m["indices"].astype(np.int64), res_h, 60000)
        f = vtkImplicitPolyDataDistance()
        f.SetInput(_polydata(m["positions"].astype(float), m["indices"].astype(np.int64)))
        pos = np.unique(pos, axis=0)
        meshes[n] = dict(pos=pos, tree=cKDTree(pos), lo=pos.min(0), hi=pos.max(0), dist=f,
                         shape=next(p["shape"] for p in parts if p["name"] == n))

    duration = a.duration
    step = max(float(step), 0.01)
    times = set(np.round(np.arange(0.0, duration + 1e-9, step), 4).tolist())
    times.add(round(duration, 4))
    for s in a.steps:
        # Endlagen laengerer Bewegungen zusaetzlich, nicht jede Grenze vieler kleiner Schritte (Schleifen mit play())
        if s["end"] - s["start"] >= max(0.5, 3 * step):
            times.update((round(s["start"], 4), round(s["end"], 4)))
    times = sorted(t for t in times if 0 <= t <= duration + 1e-9)
    joint_of = a.part_joint()
    moving = [n for n in a.moving_parts() if n in meshes]
    pairs = []
    for i, m in enumerate(moving):
        for o in meshes:
            if o == m or joint_of.get(o) is joint_of[m] or (o in moving and moving.index(o) < i):
                continue
            pairs.append((m, o))
    eye = np.eye(4)
    margin = max(gap, pen) + tol
    # Jede Stelle der Oberflaeche liegt hoechstens res_h von einer Ecke entfernt. Ecken, die weiter als reach von allen
    # Ecken des anderen Teils liegen, sind weiter als margin von ihm weg oder liegen tief in ihm. Tief drin heisst: Es gibt
    # auch Ecken naeher am Rand mit mehr als pen Tiefe. Nur die uebrigen bekommen den (teuren) Abstand ueber VTK.
    reach = margin + 2 * res_h
    cache, volumes = {}, {}

    def near(pts, other):
        if not len(pts):
            return pts
        dd, _ = meshes[other]["tree"].query(pts, distance_upper_bound=reach)
        return pts[np.isfinite(dd)]

    def measure(m, o, R):
        """R: Lage von m im System von o. Liefert (tiefste Ecke im anderen Teil, kleinster Abstand einer Ecke zum anderen
        Teil) oder None, wenn die Teile weiter als margin auseinander liegen."""
        A, B = meshes[m], meshes[o]
        c = (R @ _corners((A["lo"], A["hi"])).T).T[:, :3]
        lo, hi = np.maximum(c.min(0), B["lo"]) - margin, np.minimum(c.max(0), B["hi"]) + margin
        if np.any(lo > hi):
            return None
        key = (m, o, np.round(R[:3], 5).tobytes())  # gleiche Relativlage (Pause, gleichlaeufige Teile): einmal rechnen
        if key in cache:
            return cache[key]
        pa = A["pos"] @ R[:3, :3].T + R[:3, 3]
        pb = B["pos"]
        Ri = np.linalg.inv(R)
        pa = near(pa[np.all((pa >= lo) & (pa <= hi), axis=1)], o)
        pb = near(pb[np.all((pb >= lo) & (pb <= hi), axis=1)] @ Ri[:3, :3].T + Ri[:3, 3], m)
        d = np.concatenate([_signed(B["dist"], pa), _signed(A["dist"], pb)])
        if not len(d):
            cache[key] = res = (0.0, margin)
        else:
            low = float(d.min())
            cache[key] = res = (max(0.0, -low), max(0.0, low))
        return res

    def overlap(m, o, ma, mb):
        """Schnittmenge der B-Rep-Koerper: (Volumen, Dicke). Die Dicke 2 V / Flaeche ist bei einem flachen Span an einer
        Beruehrflaeche die Eindringtiefe, sie unterscheidet Rechenrauschen von echter Ueberschneidung besser als das Volumen."""
        key = (m, o, np.round(ma[:3], 5).tobytes(), np.round(mb[:3], 5).tobytes())
        if key not in volumes:
            sa = meshes[m]["shape"].moved(_location(ma)) if ma is not eye else meshes[m]["shape"]
            sb = meshes[o]["shape"].moved(_location(mb)) if mb is not eye else meshes[o]["shape"]
            try:
                common = sa.intersect(sb)
                vol, area = common.Volume(), common.Area()
                volumes[key] = (vol, 2 * vol / area if area > 1e-9 else 0.0)
            except Exception:
                volumes[key] = (float("nan"), float("nan"))
        return volumes[key]

    def judge(m, o, R, ma, mb, rest):
        """("Kollision" | "zu nah" | None, Messwerte) fuer ein Paar in einer Lage. rest: kleinster Abstand in der Lage im
        Modell (0 bei gewollter Beruehrung). Gemeldet wird nur, was in der Bewegung schlechter wird als dort."""
        wanted = rest <= pen
        r = measure(m, o, R)
        if r is None:
            return None, None
        depth, dist = r
        hit = dict(distance=round(dist, 4), depth=round(depth, 4))
        if depth > pen:
            return COLLISION, hit
        if dist <= pen and not wanted:
            # Beruehrung oder flaches Eindringen, keine Ecke liegt tief im anderen Teil: die B-Rep-Koerper entscheiden
            vol, thick = overlap(m, o, ma, mb)
            if math.isnan(vol) or (vol > VOL_MIN and thick > pen):
                hit["volume"] = None if math.isnan(vol) else round(vol, 4)
                hit["depth"] = round(max(depth, 0.0 if math.isnan(thick) else thick), 4)
                return COLLISION, hit
        # Wie bei soma analyze: Werte innerhalb der Genauigkeit um den Grenzwert gelten als genau auf dem Grenzwert
        if gap > 0 and dist < gap - pen and dist < rest - pen:
            return TOO_CLOSE, hit
        return None, hit

    # Lage im Modell: Beruehrung und Spiel dort sind so konstruiert, eine Kollision dort meldet die Pruefung als schon vorhanden
    rest, at_rest = {}, {}
    for m, o in pairs:
        kind, hit = judge(m, o, eye, eye, eye, math.inf)
        at_rest[(m, o)] = kind if kind == COLLISION else None
        rest[(m, o)] = math.inf if hit is None or kind == COLLISION else hit["distance"]
    progress = Progress("soma anim check", len(times), "time steps")
    found = {}
    for t in times:
        poses = a.poses(t)
        for m, o in pairs:
            ma, mb = poses.get(m, eye), poses.get(o, eye)
            kind, hit = judge(m, o, np.linalg.inv(mb) @ ma, ma, mb, rest[(m, o)])
            if kind:
                found.setdefault((m, o), []).append(dict(t=t, kind=kind, **hit))
        progress.step()
    progress.finish()
    index = {t: i for i, t in enumerate(times)}
    out = []
    for (m, o), hits in found.items():
        ranges, cur = [], None
        for h in hits:
            if cur and cur["kind"] == h["kind"] and index[h["t"]] - index[cur["end"]] == 1:
                cur["end"] = h["t"]
                cur["depth"] = max(cur["depth"], h["depth"])
                cur["distance"] = min(cur["distance"], h["distance"])
                if h.get("volume") is not None:
                    cur["volume"] = max(cur.get("volume") or 0.0, h["volume"])
            else:
                cur = dict(kind=h["kind"], start=h["t"], end=h["t"], depth=h["depth"], distance=h["distance"], volume=h.get("volume"))
                ranges.append(cur)
        out.append(dict(a=m, b=o, atRest=at_rest[(m, o)] is not None and any(r["kind"] == at_rest[(m, o)] for r in ranges),
                        ranges=ranges))
    res = dict(version=2, id=entry["id"], name=a.name, step=step, gap=gap, tolerance=pen, checked=time.time(),
               samples=len(times), seconds=round(time.perf_counter() - t_start, 1), pairs=out,
               contacts=[[m, o] for m, o in pairs if rest[(m, o)] <= pen],
               clearances=[[m, o, round(rest[(m, o)], 3)] for m, o in pairs if pen < rest[(m, o)] < gap - pen])
    (root / OUT_DIR / f"{entry['id']}.check.json").write_text(json.dumps(res, indent=1, ensure_ascii=False), encoding="utf-8")
    return res


def read_check(root, entry):
    p = Path(root) / OUT_DIR / f"{entry['id']}.check.json"
    try:
        if p.stat().st_mtime < (Path(root) / entry["glb"]).stat().st_mtime:
            return None  # gehoert zu einem aelteren Stand der Animation
        res = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    # Pruefungen von vor E73 nennen die Arten deutsch
    for pair in res.get("pairs", []) if isinstance(res, dict) else []:
        for r in pair.get("ranges", []):
            r["kind"] = _OLD_KINDS.get(r.get("kind"), r.get("kind"))
    return res


def check_text(res):
    tol = res.get("tolerance")
    head = (f"Collisions (step {res['step']:g} s, {res['samples']} time steps" + (f", minimum distance {res['gap']:g} mm" if res["gap"] else "")
            + (f", accurate to {tol:g} mm" if tol else "") + "):")
    lines = [head + ("" if res["pairs"] else " none")]
    for p in res["pairs"]:
        note = " (also in the assembled position)" if p["atRest"] else ""
        for r in p["ranges"]:
            span = f"{_t(r['start'])}-{_t(r['end'])} s" if r["end"] > r["start"] else f"{_t(r['start'])} s"
            if r["kind"] != COLLISION:
                val = f"distance down to {r['distance']:.3f} mm"
            elif r.get("depth"):
                val = f"up to {r['depth']:.2f} mm deep" + (f", overlap {r['volume']:.3f} mm3" if r.get("volume") else "")
            else:
                val = f"overlap up to {r['volume']:.3f} mm3" if r.get("volume") else "surfaces intersect"
            lines.append(f"  {span:<16} {p['a']} / {p['b']}: {r['kind']}, {val}{note}")
    contacts = res.get("contacts") or []
    if contacts:
        names = ", ".join(f"{m} / {o}" for m, o in contacts[:6]) + (f" and {len(contacts) - 6} more" if len(contacts) > 6 else "")
        lines.append(f"Already touching in the model (intended, only deeper penetration is reported): {names}")
    near = res.get("clearances") or []
    if near:
        names = ", ".join(f"{m} / {o} {d:.2f} mm" for m, o, d in near[:6]) + (f" and {len(near) - 6} more" if len(near) > 6 else "")
        lines.append(f"Already closer than {res['gap']:g} mm in the model (reported only if it gets tighter): {names}")
    return "\n".join(lines)
