"""soma: Hilfsbibliothek von SOMA. Aus model.py: `from soma import add_part, import_step`."""
from .registry import add_part, import_assembly, import_step

__version__ = "0.1.0"
API_VERSION = 1   # steht in .soma/project.json, sichert Abwaertskompatibilitaet (E36)

__all__ = ["add_part", "import_assembly", "import_step", "__version__", "API_VERSION"]
