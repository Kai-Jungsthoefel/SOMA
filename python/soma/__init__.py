"""soma: Hilfsbibliothek von SOMA. Aus model.py: `from soma import add_part, import_step`.
Normteile (Schrauben, Muttern, Scheiben, Gewindeeinsaetze): `from soma.fasteners import Screw, Nut, Washer, HeatSetInsert`.
Animationen in animations/*.py: `from soma.anim import Animation`."""
import time as _time

# Vor dem Import von cadquery (dauert Sekunden): `soma build` meldet die ganze Wartezeit, nicht nur das Modell
_STARTED = _time.perf_counter()

__version__ = "0.1.0"   # Major.minor.bugfix (E68), eine Nummer fuer App und soma, gleich der in app/package.json
API_VERSION = 1   # steht in .soma/project.json, sichert Abwaertskompatibilitaet (E36)

__all__ = ["add_part", "import_assembly", "import_step", "__version__", "API_VERSION"]


def __getattr__(name):
    # cadquery erst laden, wenn model.py die Funktionen braucht: Befehle wie `soma --version`, `soma render` oder
    # Fehlermeldungen sparen so rund 4 s Start
    if name in ("add_part", "import_assembly", "import_step"):
        from . import registry
        return getattr(registry, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
