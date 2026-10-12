"""soma: helper library of SOMA. In model.py: `from soma import add_part, param, import_step, import_assembly`.
Values the user can change in the app (Parameters panel): `WIDTH = param(40.0, "Width", min=20, max=80, unit="mm")`.
Standard parts (screws, nuts, washers, heat-set inserts): `from soma.fasteners import Screw, Nut, Washer, HeatSetInsert`.
Animations in animations/*.py: `from soma.anim import Animation`."""
import time as _time

# Vor dem Import von cadquery (dauert Sekunden): `soma build` meldet die ganze Wartezeit, nicht nur das Modell
_STARTED = _time.perf_counter()

__version__ = "0.7.0"   # Major.minor.bugfix (E68), eine Nummer fuer App und soma, gleich der in app/package.json
API_VERSION = 1   # steht in .soma/project.json, sichert Abwaertskompatibilitaet (E36)

__all__ = ["add_part", "import_assembly", "import_step", "param", "__version__", "API_VERSION"]


def __getattr__(name):
    # cadquery erst laden, wenn model.py die Funktionen braucht: Befehle wie `soma --version`, `soma render` oder
    # Fehlermeldungen sparen so rund 4 s Start
    if name in ("add_part", "import_assembly", "import_step"):
        from . import registry
        return getattr(registry, name)
    if name == "param":  # ohne cadquery
        from . import params
        return params.param
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
