"""soma: Hilfsbibliothek von SOMA. Aus model.py: `from soma import add_part, import_step`.
Normteile (Schrauben, Muttern, Scheiben, Gewindeeinsaetze): `from soma.fasteners import Screw, Nut, Washer, HeatSetInsert`.
Animationen in animations/*.py: `from soma.anim import Animation`."""
import time as _time

# Vor dem Import von cadquery (dauert Sekunden): `soma build` meldet die ganze Wartezeit, nicht nur das Modell
_STARTED = _time.perf_counter()

from .registry import add_part, import_assembly, import_step  # noqa: E402

__version__ = "0.1.0"
API_VERSION = 1   # steht in .soma/project.json, sichert Abwaertskompatibilitaet (E36)

__all__ = ["add_part", "import_assembly", "import_step", "__version__", "API_VERSION"]
