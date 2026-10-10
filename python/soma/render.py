"""`soma render`: Bilder und Videos des Modells, gerendert von der App (E58).

Die App zeichnet mit demselben Viewer wie auf dem Bildschirm, in einem unsichtbaren Fenster. Dieser Befehl bereitet den
Auftrag vor (Animation bauen, Ergebnis suchen) und schickt ihn ueber eine lokale Verbindung an die App. Die Adresse und
ein Schluessel stehen in den Umgebungsvariablen der Terminals der App (SOMA_APP, SOMA_APP_TOKEN).
"""
import http.client
import json
import os
import re
from pathlib import Path

VIEWS = ("iso", "front", "back", "left", "right", "top", "bottom")
MAX_SIDE = 3840


class RenderError(Exception):
    pass


def _size(text, default):
    if not text:
        return default
    m = re.fullmatch(r"\s*(\d{2,5})\s*[xX*]\s*(\d{2,5})\s*", text)
    if not m:
        raise RenderError(f"--size {text!r}: expected width x height, e.g. 1280x720")
    w, h = int(m.group(1)), int(m.group(2))
    if not (64 <= w <= MAX_SIDE and 64 <= h <= MAX_SIDE):
        raise RenderError(f"--size {text!r}: width and height between 64 and {MAX_SIDE} pixels")
    return w, h


def _grid(text):
    if text in (None, True, ""):
        return 3, 3
    m = re.fullmatch(r"\s*(\d)\s*[xX]\s*(\d)\s*", str(text))
    if not m or not (1 <= int(m.group(1)) <= 6 and 1 <= int(m.group(2)) <= 6):
        raise RenderError(f"--sheet {text!r}: expected columns x rows, e.g. 3x3 (at most 6x6)")
    return int(m.group(1)), int(m.group(2))


def _out(root, out, default, ext):
    rel = Path(out) if out else Path(default)
    if rel.is_absolute():
        try:
            rel = rel.resolve().relative_to(root)
        except ValueError:
            raise RenderError(f"--out {out!r} is not in the project folder") from None
    p = rel.as_posix()
    if ".." in rel.parts or p.startswith((".git/", ".soma/")):
        raise RenderError(f"--out {out!r}: the target must be in the project folder, not in .git/ or .soma/")
    if rel.suffix.lower() != ext:
        raise RenderError(f"--out {out!r}: the file must end in {ext}")
    return p


def _num(t):
    return f"{t:.2f}".rstrip("0").rstrip(".") if t else "0"


def prepare(root, args):
    """Auftrag fuer die App aus den Argumenten. Baut eine veraltete Animation vorher neu."""
    root = Path(root).resolve()
    job = dict(project=str(root), view=None, warnings=[])
    view = (getattr(args, "view", None) or "").strip()
    if view and view not in VIEWS:
        try:
            d = [float(x) for x in view.split(",")]
        except ValueError:
            d = []
        if len(d) != 3 or not any(d):
            raise RenderError(f"--view {view!r} does not exist. Possible: {', '.join(VIEWS)} or a direction x,y,z "
                              "from the model to the camera, e.g. 1,-2,1")
        job["dir"] = d
    elif view:
        job["view"] = view
    for key in ("hide", "only", "fit"):
        names = [n for n in (getattr(args, key, None) or []) if n.strip()]
        if names:
            job[key] = names
    zoom = getattr(args, "zoom", None)
    if zoom is not None:
        if not 0.05 <= zoom <= 50:
            raise RenderError("--zoom between 0.05 and 50")
        job["zoom"] = zoom
    modes = [x for x in ("at", "sheet", "video") if getattr(args, x) not in (None, False)]
    if modes and not args.anim:
        raise RenderError(f"--{modes[0]} belongs to an animation: --anim \"Name\"")
    if len(modes) > 1:
        raise RenderError("Only one of --at, --sheet and --video")
    if args.anim and args.result:
        raise RenderError("--anim and --result do not go together")
    # analysis und animrun laden cadquery (rund 4 s), deshalb erst hier: eine Ansicht des Modells braucht es nicht
    if args.result or args.anim:
        from . import analysis, animrun
    if args.result:
        meta = analysis.find(root, args.result)
        if not meta:
            have = [m["id"] for m in analysis.list_results(root)]
            raise RenderError(f"No result {args.result!r}. " + (f"Available: {', '.join(have)}" if have else "Run an analysis first, e.g. soma analyze overhang"))
        if animrun.newest_source(root) > meta["created"]:
            job["warnings"].append(f"The result {meta['id']!r} is older than the code. Recalculate: soma {' '.join(meta['command'])}")
        job["result"] = meta["file"]
    if args.anim:
        try:
            entry = animrun.ensure(root, args.anim)
        except animrun.AnimError as e:
            raise RenderError(str(e)) from None
        job["anim"] = entry["glb"]
        dur = entry["duration"]
        if args.video:
            job["kind"] = "video"
            job["size"] = _size(args.size, (1280, 720))
            job["fps"] = args.fps
            if not 1 <= args.fps <= 60:
                raise RenderError("--fps between 1 and 60")
            job["out"] = _out(root, args.out, f"renders/{entry['id']}.mp4", ".mp4")
        elif args.sheet not in (None, False):
            job["kind"] = "sheet"
            job["grid"] = _grid(args.sheet)
            job["size"] = _size(args.size, (480, 300))  # Groesse eines Einzelbilds
            job["out"] = _out(root, args.out, f"renders/{entry['id']}-sheet.png", ".png")
        else:
            t = 0.0 if args.at is None else float(args.at)
            if not 0 <= t <= dur + 1e-6:
                raise RenderError(f"--at {t:g}: the animation lasts {dur:g} s")
            job["kind"] = "still"
            job["at"] = t
            job["size"] = _size(args.size, (1280, 800))
            job["out"] = _out(root, args.out, f"renders/{entry['id']}-{_num(t)}s.png", ".png")
    else:
        job["kind"] = "still"
        job["size"] = _size(args.size, (1280, 800))
        name = f"result-{Path(job['result']).stem}" if args.result else f"view-{job['view'] or ('custom' if 'dir' in job else 'iso')}"
        job["out"] = _out(root, args.out, f"renders/{name}.png", ".png")
    return job


def send(job, timeout=900):
    """Schickt den Auftrag an die App und wartet auf das Ergebnis."""
    addr, token = os.environ.get("SOMA_APP"), os.environ.get("SOMA_APP_TOKEN")
    if not addr or not token:
        raise RenderError("soma render needs the running app: run the command in a terminal of the app "
                          "(SOMA_APP and SOMA_APP_TOKEN are set there).")
    host, _, port = addr.rpartition(":")
    try:
        conn = http.client.HTTPConnection(host or "127.0.0.1", int(port), timeout=timeout)
        conn.request("POST", "/v1/render", json.dumps(job).encode("utf-8"),
                     {"Content-Type": "application/json", "X-Soma-Token": token})
        resp = conn.getresponse()
        data = json.loads(resp.read().decode("utf-8") or "{}")
    except (OSError, ValueError) as e:
        raise RenderError(f"The app does not answer ({addr}): {e}. Is it still running? New terminals get the new address.") from None
    if not data.get("ok"):
        raise RenderError(data.get("error") or f"The app reports an error (HTTP {resp.status})")
    data["warnings"] = job.get("warnings", []) + data.get("warnings", [])
    return data
