"""Erzeugt das App-Icon von SOMA (E44): resources/icon.svg (Vorlage), icon.png (256 px) und icon.ico (16 bis 256 px).

Das Zeichen ist der Würfel als Sprechblase mit orangem Deckel auf einer Graphit-Fläche. Kleine Größen bekommen einen
dickeren Strich und ein größeres Zeichen, sonst verschwimmt es bei 16 px. Gerastert wird mit Edge ohne Fenster
(SVG wird in jeder Größe einzeln gezeichnet, nicht herunterskaliert), die ICO baut Pillow.

Aufruf (in app/):  python scripts/make-icon.py   Edge-Pfad notfalls über die Umgebungsvariable EDGE.
"""
import os
import pathlib
import subprocess
import tempfile

from PIL import Image

RES = pathlib.Path(__file__).resolve().parent.parent / "resources"
EDGE = os.environ.get("EDGE", r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe")
SIZES = [256, 128, 64, 48, 40, 32, 24, 20, 16]

ORANGE, TILE, BORDER = "#f29a38", "#1b1e23", "#2d323a"
# Würfel als Sprechblase im 64er-Raster; die Spitze links unten ersetzt die Ecke des Würfels
OUTLINE = "M33.5 7 L54.5 19 L54.5 43 L33.5 55 L22 48.4 L8 57 L12.5 37 L12.5 19 Z M12.5 19 L33.5 31 L54.5 19 M33.5 31 L33.5 55"
LID = "33.5,7 54.5,19 33.5,31 12.5,19"


def params(size):
    """Zeichengröße und Strichstärke je Pixelgröße."""
    if size <= 32:
        return 0.86, 5.6
    if size <= 48:
        return 0.82, 4.8
    return 0.78, 4.2


def svg(size):
    scale, sw = params(size)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="{size}" height="{size}" viewBox="0 0 64 64">'
            f'<rect x="0.5" y="0.5" width="63" height="63" rx="14" fill="{TILE}" stroke="{BORDER}"/>'
            f'<g transform="translate(32 32) scale({scale}) translate(-32 -32)">'
            f'<polygon points="{LID}" fill="{ORANGE}"/>'
            f'<path d="{OUTLINE}" fill="none" stroke="{ORANGE}" stroke-width="{sw}" stroke-linecap="round" stroke-linejoin="round"/>'
            f'</g></svg>')


def main():
    RES.mkdir(exist_ok=True)
    (RES / "icon.svg").write_text(svg(256) + "\n", encoding="utf-8", newline="\n")

    # Alle Größen nebeneinander auf transparentem Grund, dann einzeln ausschneiden
    gap, x, cells = 16, 0, []
    for s in SIZES:
        cells.append((s, x))
        x += s + gap
    body = "".join(f'<div style="position:absolute;left:{x}px;top:0">{svg(s)}</div>' for s, x in cells)
    html = f'<!doctype html><html><head><meta charset="utf-8"><style>html,body{{margin:0;background:transparent}}svg{{display:block}}</style></head><body>{body}</body></html>'
    with tempfile.TemporaryDirectory() as tmp:
        page, shot = pathlib.Path(tmp) / "icons.html", pathlib.Path(tmp) / "icons.png"
        page.write_text(html, encoding="utf-8")
        subprocess.run([EDGE, "--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=1",
                        "--default-background-color=00000000", f"--window-size={x},{max(SIZES)}",
                        f"--screenshot={shot}", page.as_uri()], check=True, capture_output=True)
        sheet = Image.open(shot).convert("RGBA")
        images = [sheet.crop((x, 0, x + s, s)) for s, x in cells]
    # Ohne Alphakanal wäre der Grund nicht durchsichtig (dann stimmt die Rasterung nicht)
    assert images[0].getpixel((0, 0))[3] == 0, "Hintergrund ist nicht transparent"
    images[0].save(RES / "icon.png")
    images[0].save(RES / "icon.ico", sizes=[(s, s) for s in SIZES], append_images=images[1:])
    print("geschrieben:", ", ".join(f"icon.{e}" for e in ("svg", "png", "ico")), "in", RES)


if __name__ == "__main__":
    main()
