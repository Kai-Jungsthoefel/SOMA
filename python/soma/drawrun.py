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
SET_PDF = Path("output") / "drawings.pdf"  # alle Blaetter in einer Datei
CACHE_DIR = Path(".soma") / "drawings"
# 2: Ansichten, Maße und Hinweise mit Lage im Modell und auf dem Blatt fuer die App (Zeichnungsansicht)
INDEX_VERSION = 2
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
        return dict(version=INDEX_VERSION, drawings=[], errors=[])


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


class _Rect:
    """Rechteck auf dem Blatt, gedreht wie sein Text: Mitte c, Achsen ex und ey, halbe Breite hx und Hoehe hy."""

    def __init__(self, c, ex, hx, hy):
        self.c, self.ex = np.asarray(c, dtype=float), np.asarray(ex, dtype=float)
        self.ey = np.array([-self.ex[1], self.ex[0]])
        self.hx, self.hy = float(hx), float(hy)

    @classmethod
    def box(cls, b):
        return cls(((b[0] + b[2]) / 2, (b[1] + b[3]) / 2), (1, 0), (b[2] - b[0]) / 2, (b[3] - b[1]) / 2)

    def corners(self):
        return np.array([self.c + sx * self.hx * self.ex + sy * self.hy * self.ey for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))])

    def aabb(self):
        k = self.corners()
        return (float(k[:, 0].min()), float(k[:, 1].min()), float(k[:, 0].max()), float(k[:, 1].max()))

    def hits(self, a, b, shrink=0.0):
        """Welche Strecken a[i] -> b[i] liegen auf dem (um shrink verkleinerten) Rechteck?"""
        hx, hy = self.hx - shrink, self.hy - shrink
        if hx <= 0 or hy <= 0 or not len(a):
            return np.zeros(len(a), dtype=bool)
        m = np.column_stack([self.ex, self.ey])
        return _crosses_box((a - self.c) @ m, (b - self.c) @ m, (-hx, -hy, hx, hy))

    def overlaps(self, other, shrink=0.0):
        """Trennende Achsen: zwei gedrehte Rechtecke, beide um shrink verkleinert."""
        for axis in (self.ex, self.ey, other.ex, other.ey):
            ra = (self.hx - shrink) * abs(float(self.ex @ axis)) + (self.hy - shrink) * abs(float(self.ey @ axis))
            rb = (other.hx - shrink) * abs(float(other.ex @ axis)) + (other.hy - shrink) * abs(float(other.ey @ axis))
            if abs(float((other.c - self.c) @ axis)) >= ra + rb:
                return False
        return True


def _text_rect(e):
    """Rechteck eines Texts (TEXT oder MTEXT), mitgedreht. Gedrehte Maßzahlen haetten als achsparalleles Rechteck viel
    Platz um sich, auf dem dann scheinbar Kanten liegen."""
    t = e.dxftype()
    if t == "TEXT":
        rot = float(e.dxf.get("rotation", 0.0))
    elif t == "MTEXT":
        rot = float(e.get_rotation())
    else:
        return None
    rad = math.radians(rot)
    ex = np.array([math.cos(rad), math.sin(rad)])
    if abs(ex[1]) < 1e-9 and ex[0] > 0:
        b = _box(e)
        return _Rect.box(b) if b else None
    from ezdxf.math import Matrix44
    piv = np.array([e.dxf.insert.x, e.dxf.insert.y])
    try:
        c = e.copy()
        c.transform(Matrix44.chain(Matrix44.translate(-piv[0], -piv[1], 0), Matrix44.z_rotate(-rad),
                                   Matrix44.translate(piv[0], piv[1], 0)))
    except Exception:
        b = _box(e)
        return _Rect.box(b) if b else None
    b = _box(c)
    if not b:
        return None
    mid = np.array([(b[0] + b[2]) / 2, (b[1] + b[3]) / 2]) - piv
    ey = np.array([-ex[1], ex[0]])
    return _Rect(piv + mid[0] * ex + mid[1] * ey, ex, (b[2] - b[0]) / 2, (b[3] - b[1]) / 2)


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


def _dim_parts(d):
    """Linien (Strecken a, b) und Texte (Rechtecke) eines Maßes, wie ezdxf es zeichnet."""
    try:
        parts = list(d["entity"].virtual_entities())
    except Exception:
        parts = []
    a, b, rects = [], [], []
    for e in parts:
        t = e.dxftype()
        if t == "LINE":
            a.append((e.dxf.start.x, e.dxf.start.y))
            b.append((e.dxf.end.x, e.dxf.end.y))
        elif t == "ARC":
            pts = [(p.x, p.y) for p in e.flattening(0.05)]
            a += pts[:-1]
            b += pts[1:]
        elif t in ("MTEXT", "TEXT"):
            r = _text_rect(e)
            if r:
                rects.append(r)
    return np.array(a, dtype=float).reshape(-1, 2), np.array(b, dtype=float).reshape(-1, 2), rects


def _union(boxes):
    boxes = [b for b in boxes if b]
    if not boxes:
        return None
    return (min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes))


def _round_box(b):
    return [round(float(x), 2) + 0.0 for x in b] if b else None


def _dim_boxes(d):
    """Platz eines Maßes auf dem Blatt: (ganzes Maß mit Maß- und Hilfslinien, Pfeilen und Text, nur der Text), je
    (x0, y0, x1, y1) oder None. Fuer die App (Klick auf ein Maß) und fuer den Ort von Hinweisen; einmal je Maß gerechnet."""
    if "_boxes" in d:
        return d["_boxes"]
    try:
        parts = list(d["entity"].virtual_entities())
    except Exception:
        parts = []
    whole, text = [], []
    for e in parts:
        if e.dxftype() in ("MTEXT", "TEXT"):
            r = _text_rect(e)
            if r:
                text.append(r.aabb())
        else:
            whole.append(_box(e))
    tb = _union(text)
    d["_boxes"] = (_union(whole + [tb]), tb)
    return d["_boxes"]


def _pt_box(q, r=1.5):
    """Kleines Feld um einen Punkt auf dem Blatt, als Ort eines Hinweises."""
    return (float(q[0]) - r, float(q[1]) - r, float(q[0]) + r, float(q[1]) + r)


def _fits(entities, cell):
    """Breite des Texts und Platz in der Zelle (x0, y0, x1, y1), wenn er nicht hineinpasst, sonst None."""
    boxes = [b for b in (_box(e) for e in entities) if b]
    if not boxes:
        return None
    bx0, by0 = min(b[0] for b in boxes), min(b[1] for b in boxes)
    bx1, by1 = max(b[2] for b in boxes), max(b[3] for b in boxes)
    if bx1 <= cell[2] - 0.3 and by0 >= cell[1] - 0.05 and by1 <= cell[3] + 0.05:
        return None
    return bx1 - bx0, cell[2] - 0.3 - bx0, by0 < cell[1] - 0.05 or by1 > cell[3] + 0.05


def check(sheet):
    """Hinweise zum Blatt: nur melden, nichts aendern. Liefert [dict(message, file, line)], dazu box (x0, y0, x1, y1)
    in Blatt-mm, wenn der Hinweis einen Ort auf dem Blatt hat (die App markiert ihn dort)."""
    _fonts()  # Texte mit der Schrift messen, mit der sie gezeichnet werden
    warn = []

    def add(msg, file=None, line=None, box=None):
        w = dict(message=msg, file=file, line=line)
        if box:
            w["box"] = _round_box(box)
        warn.append(w)

    x0, y0, x1, y1 = sheet.area
    tb = sheet.titleblock
    if not sheet.views and not sheet._dims and not sheet._labels:
        add("The sheet is empty: no view, dimension or text.", sheet.file, sheet.line)

    # Flaechen, auf denen nichts anderes liegen darf: Schriftfeld und Tabellen (Stueckliste)
    blocked = ([(_Rect.box(tb), "the title block", None)] if tb else []) + \
        [(_Rect.box(t["box"]), f"the table of line {t['line']}", t["owner"]) for t in sheet._tables]

    def place(what, file, line, rects=(), a=None, b=None, owner=None):
        pts = [r.corners() for r in rects] + ([a, b] if a is not None and len(a) else [])
        if not pts:
            return
        pts = np.concatenate(pts)
        box = (float(pts[:, 0].min()), float(pts[:, 1].min()), float(pts[:, 0].max()), float(pts[:, 1].max()))
        out = max(x0 - pts[:, 0].min(), y0 - pts[:, 1].min(), pts[:, 0].max() - x1, pts[:, 1].max() - y1)
        if out > 0.05:
            add(f"{what} reaches {out:.1f} mm beyond the frame.", file, line, box)
        for r, desc, own in blocked:
            if own is not None and own == owner:
                continue
            if any(q.overlaps(r, 0.05) for q in rects) or (a is not None and r.hits(a, b, 0.05).any()):
                add(f"{what} overlaps {desc}.", file, line, box)

    for v in sheet.views:
        place(f"View {v.name}", v.file, v.line, [_Rect.box(v.bbox)])
    for i, v in enumerate(sheet.views):
        for w in sheet.views[i + 1:]:
            if v.phantom or w.phantom:
                continue  # Nachbarteile liegen absichtlich ueber einer anderen Ansicht
            if _overlap(v.bbox, w.bbox, 0.5):
                # Ort: die Flaeche, auf der sich beide ueberdecken
                add(f"View {v.name} (line {v.line}) and view {w.name} (line {w.line}) overlap.", w.file, w.line,
                    (max(v.bbox[0], w.bbox[0]), max(v.bbox[1], w.bbox[1]), min(v.bbox[2], w.bbox[2]), min(v.bbox[3], w.bbox[3])))
    for t in sheet._tables:
        place("The table", t["file"], t["line"], [_Rect.box(t["box"])], owner=t["owner"])
    for an in sheet._annot:
        if an["owner"][0] == "leader":
            place("The leader", an["file"], an["line"], a=an["a"], b=an["b"], owner=an["owner"])

    # Texte: (Rechteck, Beschreibung, Datei, Zeile, Besitzer, Hinweis zum Verschieben)
    texts = []
    for t in sheet._labels:
        r = _text_rect(t["entity"])
        if r:
            place(t["what"], t["file"], t["line"], [r], owner=t.get("owner"))
            texts.append((r, t["what"], t["file"], t["line"], t.get("owner"), t.get("hint")))
        if t["height"] < 2.5:
            add(f"{t['what']} is {t['height']:g} mm high, use at least 2.5 mm (ISO 3098).", t["file"], t["line"],
                r.aabb() if r else None)
    dim_lines = []  # (a, b, Besitzer, Beschreibung)
    for i, d in enumerate(sheet._dims):
        what = f"Dimension {_dim_label(d)}"
        a, b, rects = _dim_parts(d)
        place(what, d["file"], d["line"], rects, a, b)
        owner = ("dim", i)
        dim_lines.append((a, b, owner, f"dimension {_dim_label(d)} (line {d['line']})"))
        for r in rects:
            texts.append((r, what, d["file"], d["line"], owner, "the dimension text with text_at=(x, y) or another offset"))

    def moves(*hints):
        hs = [h for h in dict.fromkeys(hints) if h]
        return f" Move {' or '.join(hs)}." if hs else ""

    # Texte uebereinander
    for i, (ra, wa, fa, la, oa, ha) in enumerate(texts):
        for rb, wb, fb, lb, ob, hb in texts[i + 1:]:
            if oa is not None and oa == ob and oa[0] in ("dim", "table"):
                continue  # Maßzahl und Toleranz eines Maßes, Zellen einer Tabelle (dort meldet die Zellenpruefung)
            if ra.overlaps(rb, 0.2):
                add(f"{wb} overlaps {wa} (line {la}).{moves(hb, ha)}", fb, lb, _union([ra.aabb(), rb.aabb()]))

    # Texte auf Kanten der Ansichten und auf Linien der Beschriftung
    segs = _segments(sheet.views)
    lines = dim_lines + [(an["a"], an["b"], an["owner"], an["desc"]) for an in sheet._annot]
    for r, what, f, ln, owner, hint in texts:
        views = sorted({v.name for a, b, v, kind in segs if kind != "tangent" and r.hits(a, b, 0.3).any()})
        hit = [f"edges of view {', '.join(views)}"] if views else []
        hit += list(dict.fromkeys(desc for a, b, own, desc in lines if own != owner and r.hits(a, b, 0.3).any()))
        if hit:
            add(f"{what} lies on {' and on '.join(hit)}.{moves(hint)}", f, ln, r.aabb())

    # Texte in Tabellen und im Schriftfeld muessen in ihre Zelle passen
    for t in sheet._tables:
        for c in t["cells"]:
            res = _fits(c["entities"], c["cell"])
            if res:
                w, room, tall = res
                add(f"Text \"{drawing._short(c['text'])}\" does not fit its cell of the table: "
                    + ("too high for the row." if tall else f"{w:.1f} mm long, room for {max(room, 0):.1f} mm."),
                    t["file"], t["line"], c["cell"])
    for fd in sheet._fields:
        res = _fits(fd["entities"], fd["cell"])
        if res:
            w, room, tall = res
            add(f"Title block: \"{drawing._short(fd['text'])}\" does not fit the field {fd['caption']}: "
                + ("too high." if tall else f"{w:.1f} mm long, room for {max(room, 0):.1f} mm.")
                + " Shorten it, or draw your own title block (titleblock=False).", sheet.file, sheet.line, fd["cell"])

    # Maße: Punkte auf Kanten, Kreise vorhanden, feste Zahlen wie gemessen
    for d in sheet._dims:
        v = d["view"]
        what = f"Dimension {_dim_label(d)}"
        vsegs = [s for s in segs if s[2] is v]
        dbox, tbox = _dim_boxes(d)
        if d["kind"] in ("diameter", "radius"):
            c = np.array(d["points"][0])
            found = any(np.allclose(np.array(cc), c, atol=1e-3) and abs(r - d["radius"]) < 1e-3
                        for cc, r in v.circles(arcs=True))
            if not found:
                add(f"{what}: view {v.name} has no circle with radius {drawing.num(d['radius'], 3)} around "
                    f"{_p3(c)}.", d["file"], d["line"], dbox)
        else:
            centers = None
            for p in d["points"]:
                q = np.array(v.pt(p))
                dist = _dist_to_lines(q, vsegs)
                if dist["visible"] <= ON_EDGE:
                    continue
                # Mitten von Bohrungen und Bögen sind uebliche Bezugspunkte, auch ohne Kante, ebenso Mittenkreuze und
                # Mittellinien des Agenten (Positionen, die nicht im Modell sind, Symmetrieachsen)
                if centers is None:
                    centers = [np.array(v.pt(c)) for c, _r in v.circles(arcs=True)]
                if any(float(np.linalg.norm(q - c)) <= ON_EDGE for c in centers):
                    continue
                if any(float(drawing._seg_dist(q[None], ref[:-1], ref[1:])[0] if len(ref) > 1
                             else np.linalg.norm(q - ref[0])) <= ON_EDGE for ref in v._refs):
                    continue
                if dist["hidden"] <= ON_EDGE:
                    add(f"{what}: the point {_p3(p)} lies only on a hidden edge (dimension visible edges, ISO 129).",
                        d["file"], d["line"], _pt_box(q))
                else:
                    add(f"{what}: the point {_p3(p)} lies on no edge of view {v.name} "
                        f"({min(dist.values()):.2f} mm away on the sheet). A rounded or chamfered corner? Then take a "
                        "point on the straight edge. A position that is not in the model? Mark it with "
                        "view.center_mark() or view.centerline() first.", d["file"], d["line"], _pt_box(q))
        t = d["text"]
        if t is not None and "<>" not in t:
            nums = [float(x.replace(",", ".")) for x in re.findall(r"\d+(?:[.,]\d+)?", t)]
            value = round(d["value"], 2)
            if nums and not any(abs(x - value) < 0.005 for x in nums):
                add(f"{what}: the text \"{t}\" differs from the measured {drawing.num(d['value'])}. Use \"<>\" for the "
                    "measured value.", d["file"], d["line"], tbox or dbox)

    scales = sorted({v.scale for v in sheet.views} | {sheet.scale})
    for s in scales:
        if not any(abs(s - iso) / iso < 1e-6 for iso in drawing.ISO_SCALES):
            add(f"Scale {drawing.fmt_scale(s)} is not a preferred scale of ISO 5455 (1:2, 1:5, 1:10, 2:1, 5:1 ...).",
                sheet.file, sheet.line)
    return warn


def _dim_label(d):
    val = drawing.num(d["value"])
    if d["kind"] == "diameter":
        val = "Ø" + val
    elif d["kind"] == "radius":
        val = "R" + val
    elif d["kind"] == "angle":
        val += "°"
    if d["text"] is not None:
        return f"\"{drawing._short(d['text'].replace('<>', val))}\""
    return val


def _p3(p):
    return "(" + ", ".join(drawing.num(float(x), 3) for x in p) + ")"


# ---- Ausgabe --------------------------------------------------------------------------------------------------------

def _fonts():
    drawing.setup_fonts()


def _plain_texts(entities, depth=0):
    """TEXT und MTEXT des Blatts, auch in Maßen, Tabellen und Bloecken (deren Teile als virtuelle Objekte)."""
    for e in entities:
        t = e.dxftype()
        if t in ("TEXT", "MTEXT"):
            yield e
        elif t in ("DIMENSION", "INSERT") and depth < 4:
            try:
                parts = list(e.virtual_entities())
            except Exception:
                continue
            yield from _plain_texts(parts, depth + 1)


def _text_layer(fig, msp):
    """Unsichtbarer Text ueber dem gezeichneten (wie OCR ueber einem Scan): Das Zeichenmodul legt Schrift als Konturen
    ab, ohne diese Ebene liesse sich in der PDF nichts markieren, suchen oder zitieren. Jede Zeile sitzt mittig auf dem
    Rechteck ihres Texts, die Groesse so, dass die Breite stimmt (dann deckt die Markierung die sichtbaren Zeichen)."""
    from matplotlib.font_manager import FontProperties
    from matplotlib.textpath import TextPath
    ax = fig.axes[0]
    prop = FontProperties(family="DejaVu Sans")
    for e in _plain_texts(msp):
        try:
            raw = e.plain_text()
            r = _text_rect(e)
        except Exception:
            continue
        lines = [x.strip() for x in str(raw).replace("\r", "").split("\n")]
        lines = [x for x in lines if x]
        if not r or not lines or r.hx <= 0 or r.hy <= 0:
            continue
        ex = np.asarray(r.ex, dtype=float)
        ey = np.array([-ex[1], ex[0]])
        deg = math.degrees(math.atan2(ex[1], ex[0]))
        step = 2 * r.hy / len(lines)
        for i, s in enumerate(lines):
            c = np.asarray(r.c, dtype=float) + ey * (r.hy - step * (i + 0.5))
            try:
                w1 = TextPath((0, 0), s, size=1, prop=prop).get_extents().width
            except Exception:
                continue
            if w1 <= 0:
                continue
            # Breite der Zeile: bei mehreren Zeilen die laengste am Rechteck, die anderen im selben Verhaeltnis
            longest = max(TextPath((0, 0), x, size=1, prop=prop).get_extents().width for x in lines)
            size_pt = min(2 * r.hx * 72 / 25.4 / max(longest, 1e-9), step * 72 / 25.4 * 1.3)
            ax.text(float(c[0]), float(c[1]), s, fontproperties=prop, fontsize=size_pt, rotation=deg, rotation_mode="anchor",
                    ha="center", va="center", color=(0, 0, 0, 0), zorder=1e6)


def render(sheet, pdf_path, png_path, dpi):
    """PDF und PNG aus derselben DXF (Zeichenmodul von ezdxf mit matplotlib), Papier exakt im Format des Blatts.
    Liefert die Groesse des Bilds in Pixeln und die Seite fuer output/drawings.pdf."""
    fig = _figure(sheet.doc, sheet.width, sheet.height)
    w, h = sheet.width, sheet.height
    dpi = min(float(dpi), MAX_PX / (max(w, h) / 25.4))
    _text_layer(fig, sheet.msp)
    _atomic(pdf_path, lambda p: _save_pdf(fig, p))
    _atomic(png_path, lambda p: fig.savefig(p, format="png", dpi=dpi, facecolor="white"))
    return (round(w / 25.4 * dpi), round(h / 25.4 * dpi)), fig


def _figure(doc, w, h):
    """Das Blatt als matplotlib-Figur von w x h mm."""
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
    fig = Figure(figsize=(w / 25.4, h / 25.4))
    FigureCanvasAgg(fig)
    ax = fig.add_axes((0, 0, 1, 1))
    ax.set_axis_off()
    cfg = dcfg.Configuration(background_policy=dcfg.BackgroundPolicy.WHITE, color_policy=dcfg.ColorPolicy.BLACK,
                             lineweight_policy=dcfg.LineweightPolicy.ABSOLUTE, line_policy=dcfg.LinePolicy.ACCURATE,
                             lineweight_scaling=72 / 25.4, min_lineweight=0.13 * 72 / 25.4)
    be = Backend(ax)
    fe = Frontend(RenderContext(doc), be, config=cfg)
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
        fe.draw_layout(doc.modelspace(), finalize=False)
    finally:
        random.setstate(state)
    ax.set_xlim(0, w)
    ax.set_ylim(0, h)
    ax.set_aspect("equal")
    return fig


def _pdf_fonts():
    """Schrift als TrueType einbetten: Mit Typ-3-Schriften (Vorgabe von matplotlib) liefern PDF-Leser fuer Zeichen wie
    Ø keinen Text."""
    import matplotlib
    return matplotlib.rc_context({"pdf.fonttype": 42})


def _save_pdf(fig, path):
    with _pdf_fonts():
        fig.savefig(path, format="pdf", metadata={"CreationDate": None})


def write_set(root, drawings, figs):
    """Alle Blaetter in einer PDF (output/drawings.pdf), in der Reihenfolge des Index (Datei, dann Zeile). Blaetter, die
    in diesem Lauf nicht gebaut wurden, kommen aus ihrer DXF. Liefert dict(pdf, sheets, missing) oder None."""
    import ezdxf
    from matplotlib.backends.backend_pdf import PdfPages
    pages, missing = [], []
    for x in drawings:
        fig = figs.get(x["id"])
        if fig is None:
            try:
                doc = ezdxf.readfile(Path(root) / x["dxf"])
                fig = _figure(doc, x["width"], x["height"])
                _text_layer(fig, doc.modelspace())
            except (OSError, ezdxf.DXFError):
                missing.append(x["name"])
                continue
        pages.append(fig)
    if not pages:
        return None

    def write(p):
        with _pdf_fonts(), PdfPages(p, metadata={"CreationDate": None}) as pdf:
            for fig in pages:
                pdf.savefig(fig)

    _atomic(Path(root) / SET_PDF, write)
    return dict(pdf=SET_PDF.as_posix(), sheets=len(pages), missing=missing)


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


def _v3(v):
    return [round(float(x), 4) + 0.0 for x in v]


def _view_3d(v):
    """Was die App braucht, um eine Ansicht im 3D-Viewer nachzustellen. Alle Punkte und Richtungen im Modell (mm, globale
    Lage wie in output/model.step, Z oben wie in CadQuery). direction zeigt vom Teil zum Betrachter, right und up sind
    die Richtungen im Modell, die auf dem Blatt nach rechts und nach oben zeigen."""
    g = v._geo
    out = dict(parts=list(g.names), right=_v3(g.x), up=_v3(g.y))
    if v._detail is not None:
        c, r, parent = v._detail
        out["center"] = _v3(c)
    else:
        out["center"] = _v3(g.center)
    # Grobe Ausdehnung im Modell (mm), damit die Kamera die Ansicht einpassen kann
    b = v.bbox
    out["size"] = round(max(b[2] - b[0], b[3] - b[1]) / v.scale, 3)
    # Blattpunkt (sx, sy) -> Ansichtskoordinaten: u = (sx - at[0]) / scale + o[0], v entsprechend. Bei Unterbrechungen
    # [Achse 0 = u / 1 = v, von, bis] (aufsteigend) ist das die verkuerzte Lage: der Reihe nach, wenn u >= von + gap,
    # kommt (bis - von - gap) dazu; davor zwischen von und von + gap liegt die Luecke. Modellpunkt = u * right + v * up
    # + w * direction mit unbekannter Tiefe w
    out["map"] = dict(at=[round(float(x), 4) for x in v.at], o=[round(float(x), 4) + 0.0 for x in v._o],
                      scale=round(float(v.scale), 6))
    if v.breaks:
        out["map"]["breaks"] = [[ax, round(lo, 4), round(hi, 4)] for ax, lo, hi in v.breaks]
        out["map"]["gap"] = round(float(v._gap), 4)
    if v.kind == "section" and v._section is not None:
        s = v._section
        # Ebener Schnitt: weggeschnitten ist der Halbraum, in den normal zeigt (zum Betrachter, gleich direction).
        # Stufen- und Halbschnitte (path) und Ausbrueche (region) haben keine einzelne Ebene
        out["section"] = dict(kind="plane", point=_v3(s["point"]), normal=_v3(s["normal"])) if s["kind"] == "plane" \
            else dict(kind=s["kind"])
    if v._detail is not None:
        c, r, parent = v._detail
        out["detail"] = dict(center=_v3(c), radius=round(float(r), 4), parent=parent.name)
    return out


def _dim_3d(d):
    """Maßpunkte im Modell und Platz des Maßes auf dem Blatt, fuer die App (Klick auf ein Maß zeigt es im 3D-Viewer)."""
    box, text_box = _dim_boxes(d)
    out = dict(points=[_v3(p) for p in d["points"]])
    if d.get("radius") is not None:
        out["radius"] = round(float(d["radius"]), 4)
    out["box"] = _round_box(box)
    if text_box:
        out["text_box"] = _round_box(text_box)
    return out


def _entry(root, sheet, warnings, px):
    rel = lambda p: p.relative_to(root).as_posix()
    views = []
    for v in sheet.views:
        circles = v._circles()
        views.append(dict(name=v.name, kind=v.kind, scale=drawing.fmt_scale(v.scale), line=v.line,
                          file=_rel(v.file, root) if v.file else None, direction=[round(x, 4) + 0.0 for x in v.direction],
                          at=[round(float(x), 2) for x in v.at], bbox=[round(x, 2) for x in v.bbox],
                          circles=[dict(center=list(c), diameter=round(2 * r, 4), arc=not full) for c, r, full in circles[:60]],
                          circles_total=len(circles), **_view_3d(v)))
    dims = [dict(kind=d["kind"], value=round(d["value"], 4), text=d["text"], label=_dim_label(d), view=d["view"].name,
                 line=d["line"], file=_rel(d["file"], root) if d["file"] else None, **_dim_3d(d)) for d in sheet._dims]
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
    # Ein Index aelterer Fassung: alle Blaetter neu bauen, sonst fehlten den uebrigen Eintraegen die neuen Felder
    if only is not None and (old.get("version", 1) >= INDEX_VERSION or not old.get("drawings")):
        files = [f for f in files if f.resolve() == Path(only).resolve()]
    done_files = {_rel(f, root) for f in files}
    keep = [x for x in old.get("drawings", []) if x.get("file") not in done_files and (root / x.get("file", "")).is_file()]
    old_errors = [x for x in old.get("errors", []) if x.get("file") not in done_files and (root / x.get("file", "")).is_file()]
    errors = []
    taken = {x["id"]: x["file"] for x in keep}
    built, figs = [], {}
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
                    px, figs[sh.id] = render(sh, root / OUT_DIR / f"{sh.id}.pdf", root / CACHE_DIR / f"{sh.id}.png", dpi)
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
    index = dict(version=INDEX_VERSION, drawings=sorted(keep + built, key=lambda x: (x["file"] or "", x["line"] or 0)), errors=old_errors + errors)
    (root / CACHE_DIR).mkdir(parents=True, exist_ok=True)
    (root / CACHE_DIR / "index.json").write_text(json.dumps(index, indent=1, ensure_ascii=False), encoding="utf-8")
    # Alle Blaetter in einer PDF, aber nur vollstaendig: Mit Fehlern bliebe ein Blatt still weg
    pdf_set = None
    if index["errors"]:
        pdf_set = dict(pdf=SET_PDF.as_posix(), skipped=True)
    elif index["drawings"]:
        pdf_set = write_set(root, index["drawings"], figs)
    elif (root / SET_PDF).is_file():
        orphans.append(SET_PDF.as_posix())
    return dict(built=built, errors=errors, orphans=orphans, index=index, set=pdf_set)


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
