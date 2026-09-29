"""Phase 0: eigener, unabhaengiger XCAF-Leser fuer STEP-Dateien (prueft die Datei, nicht CadQuerys Deutung)."""
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDF import TDF_Label, TDF_LabelSequence
from OCP.TDocStd import TDocStd_Document
from OCP.TDataStd import TDataStd_Name, TDataStd_TreeNode
from OCP.STEPCAFControl import STEPCAFControl_Reader
from OCP.IFSelect import IFSelect_RetDone
from OCP.TopAbs import TopAbs_SOLID
from OCP.TopExp import TopExp_Explorer
from OCP.Interface import Interface_Static
from OCP.Quantity import Quantity_ColorRGBA, Quantity_TOC_sRGB
from OCP.XCAFDoc import XCAFDoc, XCAFDoc_DocumentTool, XCAFDoc_ColorTool, XCAFDoc_ColorType, XCAFDoc_ColorSurf


def _name(label):
    if label.IsAttribute(TDataStd_Name.GetID_s()):
        attr = TDataStd_Name()
        label.FindAttribute(TDataStd_Name.GetID_s(), attr)
        return str(attr.Get().ToExtString())
    return ""


def _srgb(c):
    r, g, b = c.GetRGB().Values(Quantity_TOC_sRGB)
    return (round(r, 3), round(g, 3), round(b, 3), round(c.Alpha(), 3))


def _ref_color(label):
    for ctype in (XCAFDoc_ColorType.XCAFDoc_ColorSurf, XCAFDoc_ColorType.XCAFDoc_ColorGen):
        guid = XCAFDoc.ColorRefGUID_s(ctype)
        if label.IsAttribute(guid):
            node = TDataStd_TreeNode()
            label.FindAttribute(guid, node)
            c = Quantity_ColorRGBA()
            XCAFDoc_ColorTool.GetColor_s(node.Father().Label(), c)
            return _srgb(c)
    return None


def load_doc(path):
    reader = STEPCAFControl_Reader()
    reader.SetColorMode(True); reader.SetNameMode(True); reader.SetLayerMode(True)
    Interface_Static.SetIVal_s("read.stepcaf.subshapes.name", 1)
    if reader.ReadFile(str(path)) != IFSelect_RetDone:
        raise ValueError(f"STEP nicht lesbar: {path}")
    doc = TDocStd_Document(TCollection_ExtendedString("XmXCAF"))
    reader.Transfer(doc)
    return doc


def dump_step_tree(path):
    """Liefert eine flache Liste [{depth, name, kind, color}] der Baumstruktur, direkt aus der STEP-Datei."""
    doc = load_doc(path)
    st = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    ct = XCAFDoc_DocumentTool.ColorTool_s(doc.Main())
    out = []

    def shape_color(lbl):
        """Farbe des Teils; bei Compounds mit mehreren Koerpern haengt sie an den Einzelkoerpern."""
        c = Quantity_ColorRGBA()
        shp = st.GetShape_s(lbl)
        cands = [shp]
        ex = TopExp_Explorer(shp, TopAbs_SOLID)
        while ex.More():
            cands.append(ex.Current()); ex.Next()
        for s in cands:
            for t in (XCAFDoc_ColorSurf, XCAFDoc_ColorType.XCAFDoc_ColorGen):
                if ct.GetColor(s, t, c):
                    return _srgb(c)
        return None

    def walk(lbl, depth):
        comps = TDF_LabelSequence()
        st.GetComponents_s(lbl, comps)
        for i in range(1, comps.Length() + 1):
            comp = comps.Value(i)
            ref = TDF_Label()
            st.GetReferredShape_s(comp, ref)
            is_asm = st.IsAssembly_s(ref)
            name = (_name(ref) or _name(comp)) if is_asm else (_name(comp) or _name(ref))
            color = _ref_color(comp) or (None if is_asm else shape_color(ref))
            out.append(dict(depth=depth, name=name, kind="assembly" if is_asm else "part", color=color))
            if is_asm:
                walk(ref, depth + 1)

    free = TDF_LabelSequence()
    st.GetFreeShapes(free)
    for i in range(1, free.Length() + 1):
        top = free.Value(i)
        if st.IsReference_s(top):
            ref = TDF_Label(); st.GetReferredShape_s(top, ref); top = ref
        out.append(dict(depth=0, name=_name(top), kind="assembly" if st.IsAssembly_s(top) else "part", color=None))
        walk(top, 1)
    return out
