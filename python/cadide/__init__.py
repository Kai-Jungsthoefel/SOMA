"""cadide: Hilfsbibliothek der CAD-IDE (Arbeitsname). Aus model.py: `from cadide import add_part, import_step`."""
from .registry import add_part, import_step

__version__ = "0.1.0"
API_VERSION = 1   # steht in .cadide/project.json, sichert Abwaertskompatibilitaet (E36)

__all__ = ["add_part", "import_step", "__version__", "API_VERSION"]
