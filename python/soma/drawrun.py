"""`soma drawing`: Zeichnungsskripte (drawings/*.py) ausfuehren, pruefen und als DXF, PDF und PNG schreiben (E76).

Ergebnis je Blatt: output/drawings/<id>.dxf und .pdf (Lieferdateien, im Verlauf wie output/model.step),
.soma/drawings/<id>.png (Bild fuer den Agenten, eine Datei in hoher Aufloesung) und .soma/drawings/index.json mit
Ansichten, Maßen und Hinweisen fuer `soma drawing info`. Die Pruefung meldet nur und aendert nichts (E28).
"""
import json
import math
import os
import random
import re
import runpy
import sys
import time
import types
from pathlib import Path

import numpy as np

from . import build, drawing

DRAW_DIR = "drawings"
OUT_DIR = Path("output") / "drawings"
CACHE_DIR = Path(".soma") / "drawings"
DPI = 200
MAX_PX = 7000  # laengste Seite des Bildes, A0 mit 200 dpi waeren 9400 px und 250 MB im Speicher
ON_EDGE = 0.05  # mm auf dem Blatt: so nah muss ein Maßpunkt an einer Kante der Ansicht liegen


class DrawingError(Exception):
    pass


def _rel(p, root):
    return build._rel(p, root)


def drawing_files(root):
    d = Path(root) / DRAW_DIR
    return sorted(p for p in d.glob("*.py") if p.is_file() and not p.name.startswith("_")) if d.is_dir() else []


def read_index(root):
    try:
        return json.loads((Path(root) / CACHE_DIR / "index.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return dict(version=1, drawings=[], errors=[])


# ---- Ausfuehren -----------------------------------------------------------------------------------------------------

def _run_file(root, path):
    """Fuehrt ein Zeichnungsskript aus und liefert seine Blaetter. `from model import ...` fuehrt das Modell nicht noch
    einmal aus: Sein Namensraum vom Build wird das Modul (wie bei den Animationen)."""
    drawing.SHEETS.clear()
    old_cwd = os.getcwd()
    os.chdir(root)
    sys.path.insert(0, str(root))
    from . import registry
    registry.IGNORE_ADD = True
    mod_name, old_mod = None, None
    if build.LAST_RUN and Path(build.LAST_RUN[0]).resolve().parent == Path(root).resolve() and build.LAST_RUN[0].stem.isidentifier():
        script, ns = build.LAST_RUN
        mod_name, old_mod = script.stem, sys.modules.get(script.stem)
        mod = types.ModuleType(mod_name)
        mod.__dict__.update(ns)
        mod.__name__, mod.__file__ = mod_name, str(script)
        sys.modules[mod_name] = mod
    try:
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
    found = list(drawing.SHEETS)
    drawing.SHEETS.clear()
    if not found:
        raise build.BuildError(f"{_rel(path, root)} creates no sheet. Start with sh = Sheet(\"Name\") "
                               "(from soma.drawing import Sheet).", file=_rel(path, root), kind="NoSheet")
    return found


# ---- Pruefen --------------------------------------------------------------------------------------------------------

def _box(entity):
    import ezdxf.bbox
    try:
        bb = ezdxf.bbox.extents([entity], fast=False)
    except Exception:  # Messen scheitert (z. B. fehlende Schrift): dann ohne diese Pruefung
        return None
    if not bb.has_data:
        return None
    return (bb.extmin.x, bb.extmin.y, bb.extmax.x, bb.extmax.y)


def _overlap(a, b, shrink=0.0):
    return (min(a[2], b[2]) - max(a[0], b[0]) > 2 * shrink) and (min(a[3], b[3]) - max(a[1], b[1]) > 2 * shrink)


def _segments(views):
    """Alle Kanten der Ansichten als Strecken (a, b) auf dem Blatt, mit Ansicht und Art."""
    out = []
    for v in views:
        for pts, kind in v._lines:
            if len(pts) >= 2:
                out.append((pts[:-1], pts[1:], v, kind))
    return out


def _crosses_box(a, b, box):
    """Welche Strecken a[i] -> b[i] schneiden das Rechteck box (x0, y0, x1, y1)?"""
    x0, y0, x1, y1 = box
    lo, hi = np.minimum(a, b), np.maximum(a, b)
    near = (hi[:, 0] >= x0) & (lo[:, 0] <= x1) & (hi[:, 1] >= y0) & (lo[:, 1] <= y1)
    if not near.any():
        return near
    d = b - a
    corners = np.array([(x0, y0), (x1, y0), (x0, y1), (x1, y1)])
    # Vorzeichen der Ecken zur Geraden: alle auf einer Seite -> kein Schnitt
    s = np.stack([d[:, 0] * (c[1] - a[:, 1]) - d[:, 1] * (c[0] - a[:, 0]) for c in corners], axis=1)
    return near & ~((s > 0).all(axis=1) | (s < 0).all(axis=1))


def _dist_to_lines(p, segs):
    """Kleinster Abstand des Blattpunkts p zu den Strecken, getrennt nach sichtbar und verdeckt."""
    best = {"visible": math.inf, "hidden": math.inf}
    for a, b, _v, kind in segs:
        d = b - a
        L = (d * d).sum(axis=1)
        t = np.where(L > 1e-18, ((p - a) * d).sum(axis=1) / np.where(L > 1e-18, L, 1), 0.0).clip(0, 1)
        q = a + d * t[:, None]
        m = float(np.sqrt(((q - p) ** 2).sum(axis=1)).min()) if len(q) else math.inf
        key = "hidden" if kind == "hidden" else "visible"
        best[key] = min(best[key], m)
    return best


def check(sheet):
    """Hinweise zum Blatt: nur melden, nichts aendern. Liefert [dict(message, file, line)]."""
    _fonts()  # Texte mit der Schrift messen, mit der sie gezeichnet werden
    warn = []

    def add(msg, file=None, line=None):
        warn.append(dict(message=msg, file=file, line=line))

    x0, y0, x1, y1 = sheet.area
    tb = sheet.titleblock
    if not sheet.views and not sheet._dims and not sheet._labels:
        add("The sheet is empty: no view, dimension or text.", sheet.file, sheet.line)

    def place(what, box, file, line):
        if box is None:
            return
        out = max(x0 - box[0], y0 - box[1], box[2] - x1, box[3] - y1)
        if out > 0.05:
            add(f"{what} reaches {out:.1f} mm beyond the frame.", file, line)
        if tb and _overlap(box, tb, 0.05):
            add(f"{what} overlaps the title block.", file, line)

    for v in sheet.views:
        place(f"View {v.name}", v.bbox, v.file, v.line)
    for i, v in enumerate(sheet.views):
        for w in sheet.views[i + 1:]:
            if v.phantom or w.phantom:
                continue  # Nachbarteile liegen absichtlich ueber einer anderen Ansicht
            if _overlap(v.bbox, w.bbox, 0.5):
                add(f"View {v.name} (line {v.line}) and view {w.name} (line {w.line}) overlap.", w.file, w.line)

    texts = []  # (Rechteck, Beschreibung, Datei, Zeile)
    for t in sheet._labels:
        box = _box(t["entity"])
        what = f"Text \"{_short(t['text'])}\""
        place(what, box, t["file"], t["line"])
        if box:
            texts.append((box, what, t["file"], t["line"]))
        if t["height"] < 2.5:
            add(f"{what} is {t['height']:g} mm high, use at least 2.5 mm (ISO 3098).", t["file"], t["line"])
    for d in sheet._dims:
        what = f"Dimension {_dim_label(d)}"
        place(what, _box(d["entity"]), d["file"], d["line"])
        try:
            parts = list(d["entity"].virtual_entities())
        except Exception:
            parts = []
        for e in parts:
            if e.dxftype() in ("MTEXT", "TEXT"):
                box = _box(e)
                if box:
                    texts.append((box, what, d["file"], d["line"]))

    # Texte uebereinander und Texte auf Kanten der Ansichten
    for i, (a, wa, fa, la) in enumerate(texts):
        for b, wb, fb, lb in texts[i + 1:]:
            if _overlap(a, b, 0.2):
                add(f"{wb} overlaps {wa} (line {la}).", fb, lb)
    segs = _segments(sheet.views)
    for box, what, f, ln in texts:
        shrunk = (box[0] + 0.3, box[1] + 0.3, box[2] - 0.3, box[3] - 0.3)
        if shrunk[0] >= shrunk[2] or shrunk[1] >= shrunk[3]:
            continue
        hit = {v.name for a, b, v, kind in segs if kind != "tangent" and _crosses_box(a, b, shrunk).any()}
        if hit:
            add(f"{what} lies on edges of view {', '.join(sorted(hit))}.", f, ln)

    # Maße: Punkte auf Kanten, Kreise vorhanden, feste Zahlen wie gemessen
    for d in sheet._dims:
        v = d["view"]
        what = f"Dimension {_dim_label(d)}"
        vsegs = [s for s in segs if s[2] is v]
        if d["kind"] in ("diameter", "radius"):
            c = np.array(d["points"][0])
            found = any(np.allclose(np.array(cc), c, atol=1e-3) and abs(r - d["radius"]) < 1e-3
                        for cc, r in v.circles(arcs=True))
            if not found:
                add(f"{what}: view {v.name} has no circle with radius {drawing.num(d['radius'], 3)} around "
                    f"{_p3(c)}.", d["file"], d["line"])
        else:
            centers = None
            for p in d["points"]:
                q = np.array(v.pt(p))
                dist = _dist_to_lines(q, vsegs)
                if dist["visible"] <= ON_EDGE:
                    continue
                # Mitten von Bohrungen und Bögen sind uebliche Bezugspunkte, auch ohne Kante
                if centers is None:
                    centers = [np.array(v.pt(c)) for c, _r in v.circles(arcs=True)]
                if any(float(np.linalg.norm(q - c)) <= ON_EDGE for c in centers):
                    continue
                if dist["hidden"] <= ON_EDGE:
                    add(f"{what}: the point {_p3(p)} lies only on a hidden edge (dimension visible edges, ISO 129).",
                        d["file"], d["line"])
                else:
                    add(f"{what}: the point {_p3(p)} lies on no edge of view {v.name} "
                        f"({min(dist.values()):.2f} mm away on the sheet). A rounded or chamfered corner? Then take a "
                        "point on the straight edge.", d["file"], d["line"])
        t = d["text"]
        if t is not None and "<>" not in t:
            nums = [float(x.replace(",", ".")) for x in re.findall(r"\d+(?:[.,]\d+)?", t)]
            value = round(d["value"], 2)
            if nums and not any(abs(x - value) < 0.005 for x in nums):
                add(f"{what}: the text \"{t}\" differs from the measured {drawing.num(d['value'])}. Use \"<>\" for the "
                    "measured value.", d["file"], d["line"])

    scales = sorted({v.scale for v in sheet.views} | {sheet.scale})
    for s in scales:
        if not any(abs(s - iso) / iso < 1e-6 for iso in drawing.ISO_SCALES):
            add(f"Scale {drawing.fmt_scale(s)} is not a preferred scale of ISO 5455 (1:2, 1:5, 1:10, 2:1, 5:1 ...).",
                sheet.file, sheet.line)
    return warn


def _short(t, n=30):
    t = " ".join(str(t).split())
    return t if len(t) <= n else t[:n - 3] + "..."


def _dim_label(d):
    val = drawing.num(d["value"])
    if d["kind"] == "diameter":
        val = "Ø" + val
    elif d["kind"] == "radius":
        val = "R" + val
    elif d["kind"] == "angle":
        val += "°"
    if d["text"] is not None:
        return f"\"{_short(d['text'].replace('<>', val))}\""
    return val


def _p3(p):
    return "(" + ", ".join(drawing.num(float(x), 3) for x in p) + ")"


# ---- Ausgabe --------------------------------------------------------------------------------------------------------

_FONTS_READY = False


def _fonts():
    """Die Schrift der Zeichnungen liegt matplotlib bei, ezdxf kennt den Ordner aber nicht von sich aus."""
    global _FONTS_READY
    if _FONTS_READY:
        return
    import matplotlib
    from ezdxf.fonts import fonts
    try:
        fonts.font_manager.scan_folder(Path(matplotlib.get_data_path(), "fonts", "ttf"))
    except Exception:  # ohne sie nimmt ezdxf eine Ersatzschrift
        pass
    _FONTS_READY = True


def render(sheet, pdf_path, png_path, dpi):
    """PDF und PNG aus derselben DXF (Zeichenmodul von ezdxf mit matplotlib), Papier exakt im Format des Blatts."""
    from ezdxf.addons.drawing import Frontend, RenderContext
    from ezdxf.addons.drawing import config as dcfg
    from ezdxf.addons.drawing.matplotlib import MatplotlibBackend
    from ezdxf.npshapes import to_matplotlib_path
    from matplotlib.backends.backend_agg import FigureCanvasAgg
    from matplotlib.figure import Figure
    from matplotlib.patches import PathPatch

    class Backend(MatplotlibBackend):
        # ezdxf sucht in gefuellten Pfaden Loecher ueber Verschachtelung. Bei Zeichen aus sich kreuzenden Konturen
        # (Ø in jeder Schrift) wird daraus ein schwarzer Fleck. Text deshalb mit der Fuellregel der Schrift
        text_mode = False

        def draw_filled_paths(self, paths, properties):
            if not self.text_mode:
                return super().draw_filled_paths(paths, properties)
            try:
                patch = PathPatch(to_matplotlib_path(paths, detect_holes=False), color=properties.color, linewidth=0,
                                  fill=True, zorder=self._get_z())
            except ValueError:
                return
            self.ax.add_patch(patch)

    _fonts()
    w, h = sheet.width, sheet.height
    fig = Figure(figsize=(w / 25.4, h / 25.4))
    FigureCanvasAgg(fig)
    ax = fig.add_axes((0, 0, 1, 1))
    ax.set_axis_off()
    cfg = dcfg.Configuration(background_policy=dcfg.BackgroundPolicy.WHITE, color_policy=dcfg.ColorPolicy.BLACK,
                             lineweight_policy=dcfg.LineweightPolicy.ABSOLUTE, line_policy=dcfg.LinePolicy.ACCURATE,
                             lineweight_scaling=72 / 25.4, min_lineweight=0.13 * 72 / 25.4)
    be = Backend(ax)
    fe = Frontend(RenderContext(sheet.doc), be, config=cfg)
    draw_text = fe.pipeline.draw_text

    def text(*a, **k):
        be.text_mode = True
        try:
            draw_text(*a, **k)
        finally:
            be.text_mode = False

    fe.pipeline.draw_text = text
    # ezdxf verschiebt Schraffurlinien um einen kleinen Zufallswert (gegen Treffer genau auf Ecken). Fester Startwert:
    # gleiche Zeichnung, gleiche PDF
    state = random.getstate()
    random.seed(76)
    try:
        fe.draw_layout(sheet.msp, finalize=False)
    finally:
        random.setstate(state)
    ax.set_xlim(0, w)
    ax.set_ylim(0, h)
    ax.set_aspect("equal")
    dpi = min(float(dpi), MAX_PX / (max(w, h) / 25.4))
    _atomic(pdf_path, lambda p: fig.savefig(p, format="pdf", metadata={"CreationDate": None}))
    _atomic(png_path, lambda p: fig.savefig(p, format="png", dpi=dpi, facecolor="white"))
    return (round(w / 25.4 * dpi), round(h / 25.4 * dpi))


def _atomic(path, write):
    """Erst vollstaendig schreiben, dann ersetzen: Die App liest die PDF nie halb geschrieben."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".part")
    write(tmp)
    os.replace(tmp, path)


def save_dxf(sheet, path):
    import ezdxf
    old = ezdxf.options.write_fixed_meta_data_for_testing
    # Feste Zeitstempel und GUIDs: gleiche Zeichnung, gleiche Datei. Sonst aendert jeder Lauf die Datei im Verlauf
    ezdxf.options.write_fixed_meta_data_for_testing = True
    # Die Klassen kommen bei ezdxf aus einer Menge, ihre Reihenfolge wechselt von Lauf zu Lauf: sortiert schreiben
    classes = sheet.doc.classes
    export = classes.export_dxf

    def sorted_export(tagwriter):
        classes.classes = dict(sorted(classes.classes.items()))
        export(tagwriter)

    classes.export_dxf = sorted_export
    try:
        _atomic(path, lambda p: sheet.doc.saveas(p))
    finally:
        ezdxf.options.write_fixed_meta_data_for_testing = old


def _entry(root, sheet, warnings, px):
    rel = lambda p: p.relative_to(root).as_posix()
    views = []
    for v in sheet.views:
        circles = v._circles()
        views.append(dict(name=v.name, kind=v.kind, scale=drawing.fmt_scale(v.scale), line=v.line,
                          file=_rel(v.file, root) if v.file else None, direction=[round(x, 4) + 0.0 for x in v.direction],
                          at=[round(float(x), 2) for x in v.at], bbox=[round(x, 2) for x in v.bbox],
                          circles=[dict(center=list(c), diameter=round(2 * r, 4), arc=not full) for c, r, full in circles[:60]],
                          circles_total=len(circles)))
    dims = [dict(kind=d["kind"], value=round(d["value"], 4), text=d["text"], label=_dim_label(d), view=d["view"].name,
                 line=d["line"], file=_rel(d["file"], root) if d["file"] else None) for d in sheet._dims]
    return dict(id=sheet.id, name=sheet.name, file=_rel(sheet.file, root) if sheet.file else None, line=sheet.line,
                size=sheet.size, width=sheet.width, height=sheet.height, scale=drawing.fmt_scale(sheet.scale),
                area=[round(x, 2) for x in sheet.area], titleblock=[round(x, 2) for x in sheet.titleblock] if sheet.titleblock else None,
                pdf=rel(root / OUT_DIR / f"{sheet.id}.pdf"), dxf=rel(root / OUT_DIR / f"{sheet.id}.dxf"),
                png=rel(root / CACHE_DIR / f"{sheet.id}.png"), png_size=list(px), views=views, dims=dims,
                warnings=[dict(w, file=_rel(w["file"], root) if w.get("file") else None) for w in warnings],
                built=time.time())


def build_all(root, only=None, dpi=DPI):
    """Baut alle Zeichnungen (oder die einer Datei). Liefert dict(built=[...], errors=[...], orphans=[...]). errors sind die
    Fehler dieses Laufs, der Index behaelt auch die anderer Dateien, die nicht neu gebaut wurden."""
    root = Path(root).resolve()
    old = read_index(root)
    try:
        parts = build.run_model(root)
    except build.BuildError as e:
        raise DrawingError(f"The model does not build, so no drawing does either: {e.message}"
                           + (f" ({e.file}:{e.line})" if e.file and e.line else "")) from None
    drawing._PARTS = parts
    files = drawing_files(root)
    if only is not None:
        files = [f for f in files if f.resolve() == Path(only).resolve()]
    done_files = {_rel(f, root) for f in files}
    keep = [x for x in old.get("drawings", []) if x.get("file") not in done_files and (root / x.get("file", "")).is_file()]
    old_errors = [x for x in old.get("errors", []) if x.get("file") not in done_files and (root / x.get("file", "")).is_file()]
    errors = []
    taken = {x["id"]: x["file"] for x in keep}
    built = []
    try:
        for f in files:
            rel = _rel(f, root)
            try:
                sheets = _run_file(root, f)
            except build.BuildError as e:
                errors.append(dict(file=e.file or rel, line=e.line, message=e.message, traceback=e.tb))
                continue
            for sh in sheets:
                try:
                    if sh.id in taken:
                        raise build.BuildError(f"The sheet {sh.name!r} already exists (in {taken[sh.id]}). Names must be "
                                               "unique.", file=rel, line=sh.line, kind="DuplicateName")
                    taken[sh.id] = rel
                    warnings = check(sh)
                    save_dxf(sh, root / OUT_DIR / f"{sh.id}.dxf")
                    px = render(sh, root / OUT_DIR / f"{sh.id}.pdf", root / CACHE_DIR / f"{sh.id}.png", dpi)
                    built.append(_entry(root, sh, warnings, px))
                except build.BuildError as e:
                    errors.append(dict(file=e.file or rel, line=e.line, message=e.message, traceback=e.tb))
                except Exception as e:  # Fehler beim Pruefen oder Schreiben
                    err = build._error_from_exception(e, root)
                    errors.append(dict(file=err.file or rel, line=err.line, message=err.message, traceback=err.tb))
    finally:
        drawing._PARTS = None
    # Blaetter, die es nicht mehr gibt: das Bild ist Zwischenstand der App und geht, PDF und DXF bleiben (nichts still
    # loeschen), die Ausgabe nennt sie
    ids = {x["id"] for x in keep} | {x["id"] for x in built}
    orphans = []
    for x in old.get("drawings", []):
        if x["id"] in ids:
            continue
        try:
            (root / CACHE_DIR / f"{x['id']}.png").unlink()
        except OSError:
            pass
        orphans += [p for p in (x.get("pdf"), x.get("dxf")) if p and (root / p).is_file()]
    index = dict(version=1, drawings=sorted(keep + built, key=lambda x: (x["file"] or "", x["line"] or 0)), errors=old_errors + errors)
    (root / CACHE_DIR).mkdir(parents=True, exist_ok=True)
    (root / CACHE_DIR / "index.json").write_text(json.dumps(index, indent=1, ensure_ascii=False), encoding="utf-8")
    return dict(built=built, errors=errors, orphans=orphans, index=index)


def find(root, name):
    for x in read_index(root).get("drawings", []):
        if name in (x["name"], x["id"]) or Path(name).as_posix() in (x["file"], x["pdf"], x["dxf"]):
            return x
    return None


def is_stale(root, entry):
    from .animrun import newest_source
    try:
        built = (Path(root) / entry["pdf"]).stat().st_mtime
    except OSError:
        return True
    return newest_source(root, [Path(root) / entry["file"]] if entry.get("file") else []) > built


# ---- Text fuer den Agenten ------------------------------------------------------------------------------------------

def warning_text(w):
    where = f"{w['file']}:{w['line']}" if w.get("file") and w.get("line") else (w.get("file") or "")
    return f"Warning ({where}): {w['message']}" if where else f"Warning: {w['message']}"


def info_text(entry):
    e = entry
    x0, y0, x1, y1 = e["area"]
    lines = [f"Drawing \"{e['name']}\" ({e['file']} line {e['line']}): {e['size']}, {drawing.num(e['width'])} x "
             f"{drawing.num(e['height'])} mm, scale {e['scale']}",
             f"Files: {e['pdf']}, {e['dxf']}; picture {e['png']} ({e['png_size'][0]} x {e['png_size'][1]} px)",
             f"Drawing area inside the frame: x {drawing.num(x0)} to {drawing.num(x1)}, y {drawing.num(y0)} to {drawing.num(y1)} mm"
             + (f"; title block x {drawing.num(e['titleblock'][0])} to {drawing.num(e['titleblock'][2])}, y "
                f"{drawing.num(e['titleblock'][1])} to {drawing.num(e['titleblock'][3])}" if e.get("titleblock") else ""),
             "", "Views:"]
    if not e["views"]:
        lines.append("  none")
    for v in e["views"]:
        b = v["bbox"]
        lines.append(f"  {v['name']} ({v['kind']}, line {v['line']}): scale {v['scale']}, on the sheet x {drawing.num(b[0])} "
                     f"to {drawing.num(b[2])}, y {drawing.num(b[1])} to {drawing.num(b[3])}")
        for arc, title in ((False, "circles"), (True, "arcs")):
            groups = {}
            for c in v["circles"]:
                if bool(c.get("arc")) == arc:
                    groups.setdefault(c["diameter"], []).append(_p3(c["center"]))
            if not groups:
                continue
            sym = (lambda d: "R" + drawing.num(d / 2, 3)) if arc else (lambda d: "Ø" + drawing.num(d, 3))
            txt = "; ".join(f"{sym(d)} x{len(cs)} at {', '.join(cs[:6])}{' ...' if len(cs) > 6 else ''}"
                            for d, cs in sorted(groups.items(), key=lambda g: -g[0]))
            lines.append(f"    {title}: {txt}")
        if v["circles_total"] > len(v["circles"]):
            lines.append(f"    ... and {v['circles_total'] - len(v['circles'])} more circles and arcs")
    lines += ["", "Dimensions:"]
    if not e["dims"]:
        lines.append("  none")
    for d in e["dims"]:
        lines.append(f"  line {d['line']}: {d['label']} ({d['kind']}, {d['view']})")
    lines += [""]
    if e["warnings"]:
        lines += ["Warnings:"] + ["  " + warning_text(w) for w in e["warnings"]]
    else:
        lines.append("Warnings: none")
    return "\n".join(lines)
