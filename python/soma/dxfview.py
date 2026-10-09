"""DXF fuer die Ansicht der App (E80). Gezeichnet wird mit dem Zeichenmodul von ezdxf, demselben wie fuer PDF und Bild
der technischen Zeichnungen (E76): Linientypen, Schraffuren, Masse und Texte kommen so heraus wie dort. Das Ergebnis
sind Pfade je Layer, Farbe und Strichstaerke, die App zeichnet sie selbst (zoomen, verschieben, Layer ein und aus).

Nur fuer die App: `soma dxfview <datei.dxf> --out <datei.json>`. Die Datei kommt aus dem Projekt und ist nicht
vertrauenswuerdig: gelesen wird mit `ezdxf.recover` (vertraegt beschaedigte Dateien, aendert nichts auf der Platte),
was nicht geht, wird als Meldung zurueckgegeben statt abzustuerzen."""
import json
import math
import random
from pathlib import Path

# Hintergrund der Ansicht (--bg der App). ezdxf richtet danach Farbe 7 aus: hell auf dunklem Grund
BACKGROUND = "#121417"
# Hoechstens so viele Zahlen (Befehle und Koordinaten). Darueber wird nicht weiter gesammelt, die Ansicht sagt es
MAX_NUMBERS = 6_000_000
# $INSUNITS nach DXF-Referenz, 0 heisst ohne Einheit
UNITS = {1: "in", 2: "ft", 3: "mi", 4: "mm", 5: "cm", 6: "m", 7: "km", 8: "µin", 9: "mil", 10: "yd", 11: "Å", 12: "nm",
         13: "µm", 14: "dm", 15: "dam", 16: "hm", 17: "Gm", 18: "AU", 19: "ly", 20: "pc", 21: "ft", 22: "in", 23: "yd",
         24: "mi"}

# Befehle der Pfade, je mit ihren Koordinaten in `xy`: M x y, L x y, Q (Kontrollpunkt, Ende), C (zwei Kontrollpunkte,
# Ende), Z ohne Koordinaten. Die App baut daraus Path2D, Boegen und Texte bleiben Kurven und damit bei jedem Zoom glatt
MOVE, LINE, QUAD, CUBIC, CLOSE = 0, 1, 2, 3, 4


class _Full(Exception):
    """Zu viel Geometrie: abbrechen und zeigen, was bis dahin da ist."""


def _collector():
    from ezdxf.addons.drawing.backend import Backend
    from ezdxf.path import Command

    class Collector(Backend):
        """Sammelt, was das Zeichenmodul ausgibt. Aufeinanderfolgendes mit gleicher Art, Layer, Farbe und Strichstaerke
        landet im selben Stapel, so bleibt die Reihenfolge (Flaechen unter Linien) wie in der Datei."""

        def __init__(self):
            super().__init__()
            self.batches = []
            self.text = False
            self.numbers = 0
            self._cur = None
            self._last = None  # Ende der letzten Linie: Folgt die naechste dort, wird sie angehaengt statt neu begonnen

        def _batch(self, kind, p):
            key = (kind, p.layer, p.color, round(p.lineweight, 3))
            if self._cur is None or self._cur["key"] != key:
                self._cur = {"key": key, "ops": [], "xy": []}
                self.batches.append(self._cur)
                self._last = None
            if self.numbers > MAX_NUMBERS:
                raise _Full()
            return self._cur

        def set_background(self, color):
            pass

        def draw_point(self, pos, p):
            b = self._batch("point", p)
            b["xy"] += (pos.x, pos.y)
            self.numbers += 2

        def draw_line(self, s, e, p):
            b = self._batch("line", p)
            if self._last is None or not self._last.isclose(s):
                b["ops"].append(MOVE)
                b["xy"] += (s.x, s.y)
            b["ops"].append(LINE)
            b["xy"] += (e.x, e.y)
            self._last = e
            self.numbers += 6

        def draw_solid_lines(self, lines, p):
            for s, e in lines:
                self.draw_line(s, e, p)

        def _path(self, b, path, close):
            ops, xy = b["ops"], b["xy"]
            n0 = len(ops) + len(xy)
            ops.append(MOVE)
            xy += (path.start.x, path.start.y)
            for c in path.commands():
                t = c.type
                if t == Command.LINE_TO:
                    ops.append(LINE)
                    xy += (c.end.x, c.end.y)
                elif t == Command.CURVE3_TO:
                    ops.append(QUAD)
                    xy += (c.ctrl.x, c.ctrl.y, c.end.x, c.end.y)
                elif t == Command.CURVE4_TO:
                    ops.append(CUBIC)
                    xy += (c.ctrl1.x, c.ctrl1.y, c.ctrl2.x, c.ctrl2.y, c.end.x, c.end.y)
                elif t == Command.MOVE_TO:
                    ops.append(MOVE)
                    xy += (c.end.x, c.end.y)
            if close:
                ops.append(CLOSE)
            self.numbers += len(ops) + len(xy) - n0
            self._last = None

        def draw_path(self, path, p):
            if len(path):
                self._path(self._batch("line", p), path, False)

        def draw_filled_paths(self, paths, p):
            # Text mit der Fuellregel der Schrift (nonzero), sonst wird das Ø zum Fleck (wie in drawrun._figure).
            # Flaechen und Schraffuren: Loecher ueber gerade/ungerade, wie in allen Ausgaben von ezdxf
            b = self._batch("text" if self.text else "fill", p)
            for path in paths:
                if len(path):
                    self._path(b, path, True)

        def draw_filled_polygon(self, points, p):
            v = points.vertices()
            if len(v) < 3:
                return
            b = self._batch("fill", p)
            b["ops"].append(MOVE)
            b["xy"] += (v[0].x, v[0].y)
            for q in v[1:]:
                b["ops"].append(LINE)
                b["xy"] += (q.x, q.y)
            b["ops"].append(CLOSE)
            self.numbers += 3 * len(v)
            self._last = None

        def draw_image(self, image_data, p):
            pass  # Bilder kommen mit ImagePolicy.RECT als Rahmen ueber draw_path

        def clear(self):
            pass

    return Collector()


def _fonts():
    """Schrift der Zeichnungen (DejaVu Sans aus matplotlib) wie in drawing.setup_fonts, ohne cadquery zu laden."""
    try:
        import matplotlib
        from ezdxf.fonts import fonts
        fonts.font_manager.scan_folder(Path(matplotlib.get_data_path(), "fonts", "ttf"))
    except Exception:  # ohne sie nimmt ezdxf eine Ersatzschrift
        pass


def _layout(doc):
    """Modellbereich, ausser er ist leer und ein Papierbereich hat etwas (manche Programme zeichnen nur dort)."""
    msp = doc.modelspace()
    if len(msp):
        return msp
    for name in doc.layouts.names_in_taborder():
        lay = doc.layouts.get(name)
        if not lay.is_modelspace and len(lay):
            return lay
    return msp


def view(path):
    """Liest die DXF und liefert die Geometrie fuer die App als dict (siehe Kopf). Fehler: dict(ok=False, error=...)."""
    import ezdxf
    from ezdxf import recover
    from ezdxf.addons.drawing import Frontend, RenderContext
    from ezdxf.addons.drawing import config as dcfg
    from ezdxf.colors import aci2rgb

    path = Path(path)
    try:
        doc, auditor = recover.readfile(path)
    except OSError as e:
        return {"ok": False, "error": f"The file cannot be read: {e.strerror or e}"}
    except ezdxf.DXFStructureError as e:
        return {"ok": False, "error": f"This is not a readable DXF file: {e}"}

    layout = _layout(doc)
    _fonts()
    cfg = dcfg.Configuration(background_policy=dcfg.BackgroundPolicy.CUSTOM, custom_bg_color=BACKGROUND,
                             line_policy=dcfg.LinePolicy.ACCURATE, image_policy=dcfg.ImagePolicy.RECT,
                             hatching_timeout=10.0)
    ctx = RenderContext(doc)
    # Ausgeschaltete und gefrorene Layer trotzdem zeichnen: Die App blendet sie zunaechst aus, laesst sie aber einschalten
    off = set()

    def all_visible(layers):
        for lp in layers:
            if not lp.is_visible:
                off.add(lp.layer.lower())
            lp.is_visible = True

    ctx.set_layer_properties_override(all_visible)
    skipped = {}

    class Front(Frontend):
        def skip_entity(self, entity, msg):
            # Unsichtbare Objekte sind gewollt, zu kleiner Text ist nur eine Grenze des Zeichnens. Gemeldet wird, was
            # ezdxf nicht zeichnen kann (etwa 3D-Koerper ohne Ersatzgrafik), damit die Ansicht nicht vollstaendig wirkt
            if msg not in ("invisible", "text height too small"):
                skipped[entity.dxftype()] = skipped.get(entity.dxftype(), 0) + 1

    be = _collector()
    fe = Front(ctx, be, config=cfg)
    draw_text = fe.pipeline.draw_text

    def text(*a, **k):
        be.text = True
        try:
            draw_text(*a, **k)
        finally:
            be.text = False

    fe.pipeline.draw_text = text
    truncated = False
    # ezdxf verschiebt Schraffurlinien um einen Zufallswert: fester Startwert, gleiche Datei gibt gleiche Ansicht
    state = random.getstate()
    random.seed(76)
    try:
        fe.draw_layout(layout, finalize=True)
    except _Full:
        truncated = True
    finally:
        random.setstate(state)

    # Layer: Name wie in der Layertabelle, Farbe des Layers, Anzahl Objekte im gezeigten Bereich
    names, counts = {}, {}
    for e in layout:
        key = str(e.dxf.get("layer", "0")).lower()
        counts[key] = counts.get(key, 0) + 1
    for b in be.batches:
        key = str(b["key"][1]).lower()
        names.setdefault(key, b["key"][1])
    for key in counts:
        names.setdefault(key, key)
    layers = []
    for key in sorted(names, key=lambda k: (k != "0", k)):
        entry = doc.layers.get(names[key]) if doc.layers.has_entry(names[key]) else None
        color = "#ffffff"
        if entry is not None:
            if entry.dxf.hasattr("true_color"):
                r, g, bl = entry.rgb
                color = f"#{r:02x}{g:02x}{bl:02x}"
            elif 0 < abs(entry.dxf.color) < 256 and abs(entry.dxf.color) != 7:
                r, g, bl = aci2rgb(abs(entry.dxf.color))
                color = f"#{r:02x}{g:02x}{bl:02x}"
            names[key] = entry.dxf.name
        layers.append({"name": names[key], "color": color, "off": key in off, "count": counts.get(key, 0)})
    index = {x["name"].lower(): i for i, x in enumerate(layers)}

    # Koordinaten relativ zur Mitte: Die App zeichnet mit 32-Bit-Zahlen, weit vom Ursprung (Landeskoordinaten)
    # wuerden Details sonst ungenau. Gerundet auf rund sieben Stellen der Groesse
    xs = [v for b in be.batches for v in b["xy"][0::2]]
    ys = [v for b in be.batches for v in b["xy"][1::2]]
    finite = [(x, y) for x, y in zip(xs, ys) if math.isfinite(x) and math.isfinite(y)]
    if finite:
        x0, x1 = min(p[0] for p in finite), max(p[0] for p in finite)
        y0, y1 = min(p[1] for p in finite), max(p[1] for p in finite)
        ox, oy = (x0 + x1) / 2, (y0 + y1) / 2
        size = max(x1 - x0, y1 - y0, 1e-9)
        nd = max(0, min(10, 7 - math.ceil(math.log10(size))))
        box = [round(x0 - ox, nd), round(y0 - oy, nd), round(x1 - ox, nd), round(y1 - oy, nd)]
    else:
        ox = oy = 0.0
        nd = 6
        box = None
    batches = []
    for b in be.batches:
        kind, layer, color, lw = b["key"]
        xy = b["xy"]
        if not xy:
            continue
        rel = [round(v - (ox if i % 2 == 0 else oy), nd) if math.isfinite(v) else 0.0 for i, v in enumerate(xy)]
        batches.append({"kind": kind, "layer": index.get(str(layer).lower(), 0), "color": color, "lw": lw,
                        "ops": b["ops"], "xy": rel})

    units = UNITS.get(doc.header.get("$INSUNITS", 0))
    issues = len(auditor.fixes) + len(auditor.errors)
    return {"ok": True, "layout": None if layout.is_modelspace else layout.name, "units": units,
            "origin": [ox, oy], "box": box, "layers": layers, "batches": batches, "skipped": skipped,
            "issues": issues, "truncated": truncated, "entities": len(layout)}


def write(path, out):
    """`soma dxfview`: Ergebnis als JSON nach `out`. Auch Fehler landen dort, damit die App sie zeigen kann."""
    try:
        res = view(path)
    except Exception as e:  # unerwarteter Fehler im Zeichenmodul: melden statt abstuerzen
        res = {"ok": False, "error": f"The DXF could not be drawn: {type(e).__name__}: {e}"}
    Path(out).write_text(json.dumps(res, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return res
