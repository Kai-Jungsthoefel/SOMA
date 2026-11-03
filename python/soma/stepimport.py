"""STEP-Dateien als cq.Assembly lesen, auch ohne Baugruppe.

CadQuerys Assembly.importStep verlangt eine Baugruppe als oberste Form ("Step file does not contain an assembly"). Viele
Programme schreiben einen einzelnen Koerper aber ohne Baugruppe (ein Logo, ein Kaufteil), oder mehrere freie Formen
nebeneinander. Dann liest SOMA die freien Formen selbst aus dem XCAF-Dokument, mit Name und Farbe, soweit vorhanden.
"""
from pathlib import Path

import cadquery as cq

NO_ASSEMBLY = "does not contain an assembly"
# Produktname, den OCCT (und damit CadQuery, FreeCAD …) ohne eigenen Namen schreibt: kein brauchbarer Teilname
_PLACEHOLDER = ("Open CASCADE STEP translator",)


def _xcaf_free_shapes(path):
    """Freie Formen der STEP-Datei als [(name, cq.Shape, cq.Color oder None)]."""
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.Quantity import Quantity_ColorRGBA
    from OCP.STEPCAFControl import STEPCAFControl_Reader
    from OCP.TCollection import TCollection_ExtendedString
    from OCP.TDataStd import TDataStd_Name
    from OCP.TDF import TDF_Label, TDF_LabelSequence
    from OCP.TDocStd import TDocStd_Document
    from OCP.XCAFDoc import XCAFDoc_ColorGen, XCAFDoc_ColorSurf, XCAFDoc_DocumentTool

    reader = STEPCAFControl_Reader()
    reader.SetColorMode(True)
    reader.SetNameMode(True)
    if reader.ReadFile(str(path)) != IFSelect_RetDone:
        raise ValueError(f"Error reading STEP file: {path}")
    doc = TDocStd_Document(TCollection_ExtendedString("XmlXCAF"))
    reader.Transfer(doc)
    shapes = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    colors = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
    labels = TDF_LabelSequence()
    shapes.GetFreeShapes(labels)
    out = []
    for i in range(labels.Length()):
        label = labels.Value(i + 1)
        shape = shapes.GetShape_s(label)
        if shape.IsNull():
            continue
        name = ""
        attr = TDataStd_Name()
        if label.FindAttribute(TDataStd_Name.GetID_s(), attr):
            name = str(attr.Get().ToExtString()).strip()
        if shapes.IsReference_s(label):  # Verweis: Name und Farbe stehen oft an der Vorlage
            ref = TDF_Label()
            shapes.GetReferredShape_s(label, ref)
            if not name and ref.FindAttribute(TDataStd_Name.GetID_s(), attr):
                name = str(attr.Get().ToExtString()).strip()
        # Farbe an der Form selbst, sonst an ihren Komponenten (manche Programme setzen sie eine Ebene tiefer). Eine Farbe
        # fuer das ganze Teil, Farben einzelner Flaechen gehen hier verloren.
        color = None
        todo = [label]
        while todo and color is None and len(todo) < 1000:
            lab = todo.pop(0)
            if shapes.IsReference_s(lab):
                ref = TDF_Label()
                shapes.GetReferredShape_s(lab, ref)
                todo.append(ref)
            c = Quantity_ColorRGBA()
            for kind in (XCAFDoc_ColorSurf, XCAFDoc_ColorGen):
                if colors.GetColor(shapes.GetShape_s(lab), kind, c) or colors.GetColor_s(lab, kind, c):
                    rgb = c.GetRGB()
                    color = cq.Color(rgb.Red(), rgb.Green(), rgb.Blue(), c.Alpha())
                    break
            comps = TDF_LabelSequence()
            shapes.GetComponents_s(lab, comps)
            todo.extend(comps.Value(k + 1) for k in range(comps.Length()))
        if name.startswith(_PLACEHOLDER):
            name = ""
        out.append((name, cq.Shape.cast(shape), color))
    return out


def _has_geometry(asm):
    return asm.obj is not None or any(_has_geometry(c) for c in asm.children)


def read_assembly(path, name=None):
    """STEP-Datei als cq.Assembly. Ohne Baugruppe in der Datei: jede freie Form ein Teil. name: Name der Baugruppe und
    der Teile ohne eigenen Namen (ohne Angabe der Dateiname)."""
    path = Path(path)
    try:
        asm = cq.Assembly.importStep(str(path))
        # Eine Verbundform als oberste Form liest CadQuery als Baugruppe ohne Teile: Die Geometrie fehlte dann still
        if _has_geometry(asm):
            return asm
    except ValueError as e:
        if NO_ASSEMBLY not in str(e):
            raise
    base = (name or path.stem).replace("/", "_") or "Part"
    items = _xcaf_free_shapes(path)
    if not items:
        raise ValueError("The STEP file contains no geometry")
    # Die oberste Baugruppe ohne Namen (CadQuery vergibt eine Kennung): add_part und die Vorschau nutzen ihn nicht, und
    # ein Teil darf in cq.Assembly nicht so heissen wie die Baugruppe darueber
    asm = cq.Assembly()
    taken = set()
    for i, (n, shape, color) in enumerate(items):
        # Teilnamen eindeutig und ohne „/“ (trennt in cq.Assembly die Ebenen)
        n = (n or (base if len(items) == 1 else f"{base} {i + 1}")).replace("/", "_")
        unique, k = n, 2
        while unique in taken:
            unique, k = f"{n} ({k})", k + 1
        taken.add(unique)
        asm.add(shape, name=unique, color=color)
    return asm


def read_shape(path):
    """STEP-Datei als eine Form. Mehrere freie Formen werden ein Verbund (vorher kam nur die erste an)."""
    shapes = cq.importers.importStep(str(path)).vals()
    if not shapes:
        raise ValueError("The STEP file contains no geometry")
    return shapes[0] if len(shapes) == 1 else cq.Compound.makeCompound(shapes)
