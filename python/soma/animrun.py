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
from pathlib import Path

import numpy as np

from . import anim, build, gltf, registry

ANIM_DIR = "animations"
OUT_DIR = Path(".soma") / "anim"


class AnimError(Exception):
    pass


def _rel(p, root):
    return build._rel(p, root)


def anim_files(root):
    d = Path(root) / ANIM_DIR
    return sorted(p for p in d.glob("*.py") if p.is_file() and not p.name.startswith("_")) if d.is_dir() else []


def newest_source(root, extra=()):
    """Neuester Aenderungszeitpunkt des Modells (Einstiegspunkt, *.py im Projektordner, parts/, inputs/) und weiterer Dateien."""
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
    for p in list(root.glob("*.py")) + [Path(x) for x in extra]:
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
    try:
        runpy.run_path(str(path), run_name="__main__")
    except SystemExit as e:
        if e.code not in (None, 0):
            raise build.BuildError(f"{_rel(path, root)} hat sich mit Code {e.code} beendet", file=_rel(path, root), kind="SystemExit")
    except BaseException as e:
        raise build._error_from_exception(e, root)
    finally:
        registry.IGNORE_ADD = False
        os.chdir(old_cwd)
        if sys.path and sys.path[0] == str(root):
            sys.path.pop(0)
    found = list(anim.ANIMATIONS)
    if not found:
        raise build.BuildError(f"{_rel(path, root)} legt keine Animation an. Beginne mit a = Animation(\"Name\") "
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
        raise build.BuildError(f"Die Animation {a.name!r} ist leer: Sie braucht play(), wait() oder title(), damit Zeit vergeht.",
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
        raise AnimError(f"Das Modell laesst sich nicht bauen, deshalb auch keine Animation: {e.message}"
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
                    raise build.BuildError(f"Die Animation {a.name!r} gibt es schon (in {taken[a.id]}). Namen muessen eindeutig sein.",
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
        msg = f"Keine Animation {name!r}."
        if res["errors"]:
            msg += " Fehler: " + "; ".join(f"{x['file']}{':' + str(x['line']) if x.get('line') else ''}: {x['message']}" for x in res["errors"])
        msg += f" Vorhanden: {', '.join(repr(n) for n in names)}." if names else f" In {ANIM_DIR}/ liegt noch keine fehlerfreie Animation."
        raise AnimError(msg)
    return e


def read_meta(root, entry):
    return gltf.read_json(Path(root) / entry["glb"])["extras"]["soma_animation"]


# ---- Text fuer den Agenten --------------------------------------------------------------------------------------

def _t(x):
    return f"{x:.2f}"


def info_text(root, entry):
    m = read_meta(root, entry)
    lines = [f"Animation \"{m['name']}\" ({m['file']} Zeile {m['line']}), Dauer {_t(m['duration'])} s",
             f"Bewegte Bauteile: {', '.join(m['parts']) or 'keine'}",
             "Kamera: " + ("keine eigene (Standardansicht iso, alles im Bild)" if m["cameraAuto"] else "eigene Einstellungen und Fahrten"),
             "", "Ablauf:"]
    for s in m["steps"]:
        span = f"{_t(s['start'])}-{_t(s['end'])} s" if s["end"] > s["start"] else f"{_t(s['start'])} s"
        lines.append(f"  {span:<16} {s['text']}")
    if m["captions"]:
        lines += ["", "Untertitel:"] + [f"  {_t(c['start'])}-{_t(c['end'])} s  \"{c['text']}\"" for c in m["captions"]]
    if m["labels"]:
        lines += ["", "Beschriftungen:"] + [
            f"  {_t(lb['start'])}-{_t(lb['end'])} s  \"{lb['text']}\"" + (f" an {lb['part']}" if lb["part"] else "")
            + " bei ({:.1f}, {:.1f}, {:.1f})".format(*lb["at"]) for lb in m["labels"]]
    chk = read_check(root, entry)
    if chk:
        lines += ["", check_text(chk)]
    else:
        lines += ["", "Kollisionen: nicht geprueft (soma anim check \"" + m["name"] + "\")"]
    return "\n".join(lines)


# ---- Kollisionspruefung -----------------------------------------------------------------------------------------

def _location(m):
    import cadquery as cq
    from OCP.gp import gp_Trsf
    t = gp_Trsf()
    t.SetValues(*[float(m[r, c]) for r in range(3) for c in range(4)])
    return cq.Location(t)


def check(root, name, step=0.1, gap=0.0):
    """Prueft die Bewegung: Ueberschneiden sich Bauteile (oder kommen sich naeher als gap mm)? Bewegte Bauteile gegen alle
    anderen, zu jeder Abtastzeit im Abstand step und an den Grenzen jedes Schritts. Schreibt .soma/anim/<id>.check.json."""
    from OCP.BRepExtrema import BRepExtrema_DistShapeShape
    root = Path(root).resolve()
    entry = ensure(root, name)
    parts, results = load(root, root / entry["file"])
    a = next((x for _f, res in results if not isinstance(res, build.BuildError) for x in res if x.id == entry["id"]), None)
    if a is None:
        raise AnimError(f"Die Animation {name!r} liess sich nicht neu laden.")
    shapes = {p["name"]: p["shape"] for p in parts}
    info = {p["name"]: p for p in anim._PARTS}
    duration = a.duration
    times = set(np.round(np.arange(0.0, duration + 1e-9, max(step, 0.01)), 4).tolist())
    for s in a.steps:
        times.update((round(s["start"], 4), round(s["end"], 4)))
    times = sorted(t for t in times if 0 <= t <= duration + 1e-9)
    joint_of = a.part_joint()
    moving = a.moving_parts()
    pairs = []
    for i, m in enumerate(moving):
        for o in shapes:
            if o == m or joint_of.get(o) is joint_of[m] or (o in joint_of and moving.index(o) < i):
                continue
            pairs.append((m, o))
    corners = {n: _corners(info[n]["bbox"]) for n in shapes}
    eye = np.eye(4)
    found = {}
    for t in times:
        poses = a.poses(t)
        locs = {}
        for m, o in pairs:
            ma, mb = poses.get(m, eye), poses.get(o, eye)
            ca, cb = (ma @ corners[m].T).T[:, :3], (mb @ corners[o].T).T[:, :3]
            lo, hi = np.maximum(ca.min(0), cb.min(0)), np.minimum(ca.max(0), cb.max(0))
            if np.any(lo - hi > gap + 1e-6):
                continue
            for n, mm in ((m, ma), (o, mb)):
                if n not in locs:
                    locs[n] = shapes[n].moved(_location(mm)) if mm is not eye else shapes[n]
            sa, sb = locs[m], locs[o]
            dist = BRepExtrema_DistShapeShape(sa.wrapped, sb.wrapped)
            d = dist.Value() if dist.IsDone() else float("nan")
            vol = 0.0
            if d <= 1e-6:
                try:
                    vol = sa.intersect(sb).Volume()
                except Exception:
                    vol = float("nan")
            if vol > 1e-3 or (gap > 0 and d < gap) or math.isnan(vol):
                found.setdefault((m, o), []).append(dict(t=t, distance=round(d, 4), volume=round(vol, 4)))
    out = []
    for (m, o), hits in found.items():
        ranges, cur = [], None
        for h in hits:
            kind = "Kollision" if h["volume"] > 1e-3 or math.isnan(h["volume"]) else "zu nah"
            if cur and cur["kind"] == kind and abs(times.index(h["t"]) - times.index(cur["end"])) == 1:
                cur["end"] = h["t"]
                cur["volume"] = max(cur["volume"], h["volume"])
                cur["distance"] = min(cur["distance"], h["distance"])
            else:
                cur = dict(kind=kind, start=h["t"], end=h["t"], volume=h["volume"], distance=h["distance"])
                ranges.append(cur)
        out.append(dict(a=m, b=o, atRest=hits[0]["t"] == 0, ranges=ranges))
    res = dict(version=1, id=entry["id"], name=a.name, step=step, gap=gap, checked=time.time(), samples=len(times), pairs=out)
    (root / OUT_DIR / f"{entry['id']}.check.json").write_text(json.dumps(res, indent=1, ensure_ascii=False), encoding="utf-8")
    return res


def read_check(root, entry):
    p = Path(root) / OUT_DIR / f"{entry['id']}.check.json"
    try:
        if p.stat().st_mtime < (Path(root) / entry["glb"]).stat().st_mtime:
            return None  # gehoert zu einem aelteren Stand der Animation
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def check_text(res):
    head = f"Kollisionen (Schritt {res['step']:g} s, {res['samples']} Zeitpunkte" + (f", Mindestabstand {res['gap']:g} mm" if res["gap"] else "") + "):"
    if not res["pairs"]:
        return head + " keine"
    lines = [head]
    for p in res["pairs"]:
        note = " (schon in der Lage im Modell)" if p["atRest"] else ""
        for r in p["ranges"]:
            span = f"{_t(r['start'])}-{_t(r['end'])} s" if r["end"] > r["start"] else f"{_t(r['start'])} s"
            val = f"Ueberschneidung bis {r['volume']:.3f} mm3" if r["kind"] == "Kollision" else f"Abstand bis {r['distance']:.3f} mm"
            lines.append(f"  {span:<16} {p['a']} / {p['b']}: {r['kind']}, {val}{note}")
    return "\n".join(lines)
