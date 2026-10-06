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

from . import analysis, animrun

VIEWS = ("iso", "front", "back", "left", "right", "top", "bottom")
MAX_SIDE = 3840


class RenderError(Exception):
    pass


def _size(text, default):
    if not text:
        return default
    m = re.fullmatch(r"\s*(\d{2,5})\s*[xX*]\s*(\d{2,5})\s*", text)
    if not m:
        raise RenderError(f"--size {text!r}: erwartet Breite x Hoehe, z. B. 1280x720")
    w, h = int(m.group(1)), int(m.group(2))
    if not (64 <= w <= MAX_SIDE and 64 <= h <= MAX_SIDE):
        raise RenderError(f"--size {text!r}: Breite und Hoehe zwischen 64 und {MAX_SIDE} Pixeln")
    return w, h


def _grid(text):
    if text in (None, True, ""):
        return 3, 3
    m = re.fullmatch(r"\s*(\d)\s*[xX]\s*(\d)\s*", str(text))
    if not m or not (1 <= int(m.group(1)) <= 6 and 1 <= int(m.group(2)) <= 6):
        raise RenderError(f"--sheet {text!r}: erwartet Spalten x Zeilen, z. B. 3x3 (hoechstens 6x6)")
    return int(m.group(1)), int(m.group(2))


def _out(root, out, default, ext):
    rel = Path(out) if out else Path(default)
    if rel.is_absolute():
        try:
            rel = rel.resolve().relative_to(root)
        except ValueError:
            raise RenderError(f"--out {out!r} liegt nicht im Projektordner") from None
    p = rel.as_posix()
    if ".." in rel.parts or p.startswith((".git/", ".soma/")):
        raise RenderError(f"--out {out!r}: Ziel muss im Projektordner liegen, nicht in .git/ oder .soma/")
    if rel.suffix.lower() != ext:
        raise RenderError(f"--out {out!r}: Die Datei muss auf {ext} enden")
    return p


def _num(t):
    return f"{t:.2f}".rstrip("0").rstrip(".") if t else "0"


def prepare(root, args):
    """Auftrag fuer die App aus den Argumenten. Baut eine veraltete Animation vorher neu."""
    root = Path(root).resolve()
    job = dict(project=str(root), view=args.view or None, warnings=[])
    if args.view and args.view not in VIEWS:
        raise RenderError(f"--view {args.view!r} gibt es nicht. Moeglich: {', '.join(VIEWS)}")
    modes = [x for x in ("at", "sheet", "video") if getattr(args, x) not in (None, False)]
    if modes and not args.anim:
        raise RenderError(f"--{modes[0]} gehoert zu einer Animation: --anim \"Name\"")
    if len(modes) > 1:
        raise RenderError("Nur eins von --at, --sheet und --video")
    if args.anim and args.result:
        raise RenderError("--anim und --result gehen nicht zusammen")
    if args.result:
        meta = analysis.find(root, args.result)
        if not meta:
            have = [m["id"] for m in analysis.list_results(root)]
            raise RenderError(f"Kein Ergebnis {args.result!r}. " + (f"Vorhanden: {', '.join(have)}" if have else "Erst auswerten, z. B. soma analyze overhang"))
        if animrun.newest_source(root) > meta["created"]:
            job["warnings"].append(f"Das Ergebnis {meta['id']!r} ist aelter als der Code. Neu berechnen: soma {' '.join(meta['command'])}")
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
                raise RenderError("--fps zwischen 1 und 60")
            job["out"] = _out(root, args.out, f"renders/{entry['id']}.mp4", ".mp4")
        elif args.sheet not in (None, False):
            job["kind"] = "sheet"
            job["grid"] = _grid(args.sheet)
            job["size"] = _size(args.size, (480, 300))  # Groesse eines Einzelbilds
            job["out"] = _out(root, args.out, f"renders/{entry['id']}-uebersicht.png", ".png")
        else:
            t = 0.0 if args.at is None else float(args.at)
            if not 0 <= t <= dur + 1e-6:
                raise RenderError(f"--at {t:g}: Die Animation dauert {dur:g} s")
            job["kind"] = "still"
            job["at"] = t
            job["size"] = _size(args.size, (1280, 800))
            job["out"] = _out(root, args.out, f"renders/{entry['id']}-{_num(t)}s.png", ".png")
    else:
        job["kind"] = "still"
        job["size"] = _size(args.size, (1280, 800))
        name = f"ergebnis-{Path(job['result']).stem}" if args.result else f"ansicht-{args.view or 'iso'}"
        job["out"] = _out(root, args.out, f"renders/{name}.png", ".png")
    return job


def send(job, timeout=900):
    """Schickt den Auftrag an die App und wartet auf das Ergebnis."""
    addr, token = os.environ.get("SOMA_APP"), os.environ.get("SOMA_APP_TOKEN")
    if not addr or not token:
        raise RenderError("soma render braucht die laufende App: Fuehre den Befehl im Terminal der App aus "
                          "(dort sind SOMA_APP und SOMA_APP_TOKEN gesetzt).")
    host, _, port = addr.rpartition(":")
    try:
        conn = http.client.HTTPConnection(host or "127.0.0.1", int(port), timeout=timeout)
        conn.request("POST", "/v1/render", json.dumps(job).encode("utf-8"),
                     {"Content-Type": "application/json", "X-Soma-Token": token})
        resp = conn.getresponse()
        data = json.loads(resp.read().decode("utf-8") or "{}")
    except (OSError, ValueError) as e:
        raise RenderError(f"Die App antwortet nicht ({addr}): {e}. Laeuft sie noch? Neue Terminals bekommen die neue Adresse.") from None
    if not data.get("ok"):
        raise RenderError(data.get("error") or f"Die App meldet einen Fehler (HTTP {resp.status})")
    data["warnings"] = job.get("warnings", []) + data.get("warnings", [])
    return data
