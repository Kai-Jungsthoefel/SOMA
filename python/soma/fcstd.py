"""FreeCAD files (.FCStd) without FreeCAD: the geometry of the objects that FreeCAD shows, with names, groups and colors.

An FCStd file is a ZIP. `Document.xml` lists the objects and their properties, the computed shape of each object is an
OpenCascade BREP file next to it (`PartShape12.brp`, binary `.bin` if the user chose that), which OCP reads directly.
`GuiDocument.xml` (missing in files saved without the GUI) has visibility and colors. Only the geometry comes along, not
the parametric history: sketches, constraints and features are not translated into CadQuery code (too unreliable).

Which objects become parts (what FreeCAD shows in its 3D view):
- visible objects with a shape. A PartDesign::Body stands for its features: the features (also the visible Tip, which
  carries the same shape as the body) are never parts of their own.
- objects that other objects use as input (booleans, extrusions, arrays, the base of a body) are left out, even when
  visible, because they are already contained in the result. Only if that result is shown: inputs of a hidden result
  stay, and drawings, CAM jobs or FEM analyses that refer to a body never hide it. Sketches, datum and origin objects
  never count.
- App::Part and App::DocumentObjectGroup become groups. A hidden App::Part hides everything in it (as in FreeCAD).
- App::Link: links within the file are resolved with the link's placement. Links into other files are reported.

Coordinates: FreeCAD stores the shape of an object with the object's own Placement already applied (the BREP carries it
as its location; a PartDesign::Body likewise carries the body placement on top of its Tip). The Placement of the
App::Part containers around it is NOT in the stored shape: FreeCAD applies it only when displaying. Checked with
NEMA_17_with_connector.FCStd from the FreeCAD library: Body001 (Placement z 9.6) is stored with location z 9.6, its Tip
"Pocket" at z 0; the connector body in App::Part "Conector" (Placement x 17, z 4) is stored at x 0..10, z 0..5, so only
with the container placement does it sit on the motor's rear plate. This module therefore applies the container
placements itself, and the shapes it returns are in global coordinates.
"""
import lzma
import os
import struct
import sys
import tempfile
import zipfile
import zlib
import xml.etree.ElementTree as ET
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

import cadquery as cq

EXTS = (".fcstd",)
MAX_DEPTH = 32  # nesting of containers and links, deeper means a cycle in a broken file
# Unpacked sizes from the ZIP directory (zipfile never returns more than that): a damaged file or a zip bomb would
# otherwise fill the memory. Real files stay far below: the XML of big assemblies has a few MB
MAX_XML = 200 * 2**20       # Document.xml, GuiDocument.xml
MAX_SHAPES = 2 * 2**30      # all shape files of the objects together
MAX_SIDE = 64 * 2**20       # a color or material list
# What reading a damaged member can raise: broken deflate data (zlib.error), a cut-off member (EOFError), an unknown
# compression method (NotImplementedError), an encrypted member (RuntimeError), a size that does not fit in memory
_ZIP_ERRORS = (zipfile.BadZipFile, OSError, RuntimeError, EOFError, NotImplementedError, MemoryError, ValueError,
               zlib.error, lzma.LZMAError)

# Never parts: 2D, construction and annotation objects. Their shapes (if any) are helpers, not bodies
_SKIP_TYPES = ("Sketcher::", "App::Origin", "App::Line", "App::Plane", "App::Point", "App::Placement",
               "PartDesign::Plane", "PartDesign::Line", "PartDesign::Point", "PartDesign::CoordinateSystem",
               "PartDesign::ShapeBinder", "PartDesign::SubShapeBinder", "Part::Datum", "Spreadsheet::", "TechDraw::",
               "App::TextDocument", "App::VarSet", "App::MaterialObject", "Measure::", "Fem::", "Path::", "CAM::",
               "Mesh::", "Points::", "Assembly::Joint", "App::Annotation")
# Link properties whose targets the object consumes: FreeCAD hides those inputs, the result contains them already.
# Not here: Support/AttachmentSupport (only the position), Group (containment), Tip, Origin, LinkedObject (links show)
_CONSUMING = {"Base", "Tool", "Shapes", "Source", "BaseFeature", "Profile", "Sections", "Spine", "Links", "Objects"}


class FcstdError(ValueError):
    """The file cannot be imported at all, with a message for the user."""


class _TooLarge(Exception):
    pass


def _read_member(zf, member, limit):
    """Bytes of a ZIP member, _TooLarge if it unpacks to more than limit. KeyError if it is missing."""
    info = zf.getinfo(member)
    if info.file_size > limit:
        raise _TooLarge(info.file_size)
    return zf.read(info)


def _mb(n):
    return f"{n / 2**20:,.0f} MB"


def _zip_why(e):
    """Reason for a member that cannot be unpacked. zlib calls its exception just "error"."""
    if isinstance(e, zlib.error):
        return f"damaged compressed data: {e}"
    return f"{type(e).__name__}: {e}" if str(e) else type(e).__name__


@dataclass
class Part:
    name: str                 # FreeCAD label as the user sees it (any characters)
    shape: cq.Shape           # in global coordinates
    color: tuple = None       # (r, g, b, a) 0..1 or None
    group: tuple = ()         # labels of the containers (App::Part, groups, links to containers) from the top
    source: str = ""          # internal object name in Document.xml, for messages
    kind: str = ""            # FreeCAD type, e.g. PartDesign::Body


@dataclass
class Result:
    parts: list = field(default_factory=list)
    warnings: list = field(default_factory=list)   # problems: something visible could not be imported
    notes: list = field(default_factory=list)      # left out on purpose, for the curious
    program: str = ""                              # FreeCAD version that saved the file


def is_fcstd(path):
    return str(path).lower().endswith(EXTS)


# ---- Reading Document.xml ---------------------------------------------------------------------------------------------

class _Obj:
    __slots__ = ("name", "type", "label", "props", "ext")

    def __init__(self, name, type_):
        self.name, self.type, self.label, self.props, self.ext = name, type_ or "", name, {}, ()

    def prop(self, name):
        return self.props.get(name)

    def links(self, name):
        """Object names a link property points to (Link, LinkList, LinkSub, LinkSubList, XLink)."""
        p = self.props.get(name)
        out = []
        if p is None:
            return out
        for el in p.iter():
            if el.tag in ("Link", "LinkSub"):
                v = el.get("value") or el.get("obj")
            elif el.tag == "XLink":
                v = None if el.get("file") else el.get("name")
            else:
                continue
            if v and v not in out:
                out.append(v)
        return out

    @property
    def children(self):
        # Group: App::Part, groups, bodies from 0.17 on. Model: bodies of FreeCAD 0.16
        return self.links("Group") or self.links("Model")

    @property
    def is_container(self):
        return "Group" in self.props or (self.type == "PartDesign::Body" and "Model" in self.props)

    @property
    def is_body(self):
        return self.type.startswith("PartDesign::Body")

    @property
    def is_link(self):
        return self.type.startswith("App::Link") and self.type != "App::LinkGroup"

    @property
    def shape_file(self):
        p = self.props.get("Shape")
        el = p.find("Part") if p is not None else None
        return el.get("file") if el is not None else None


def _bool(p):
    el = p.find("Bool") if p is not None else None
    return None if el is None else el.get("value") == "true"


def _int(p, default=0):
    el = p.find("Integer") if p is not None else None
    try:
        return int(el.get("value")) if el is not None else default
    except (TypeError, ValueError):
        return default


def _float_attr(el, key, default=0.0):
    try:
        return float(el.get(key, default))
    except (TypeError, ValueError):
        return default


def _location(p):
    """App::PropertyPlacement as cq.Location. Q0..Q3 is the quaternion (x, y, z, w), older files may only have the
    axis and angle (A, Ox, Oy, Oz)."""
    el = p.find("PropertyPlacement") if p is not None else None
    if el is None:
        return cq.Location()
    from OCP.gp import gp_Ax1, gp_Dir, gp_Pnt, gp_Quaternion, gp_Trsf, gp_Vec
    t = gp_Trsf()
    if el.get("Q3") is not None:
        q = [_float_attr(el, k) for k in ("Q0", "Q1", "Q2", "Q3")]
        if sum(x * x for x in q) > 1e-12:
            t.SetRotation(gp_Quaternion(*q))
    elif abs(_float_attr(el, "A")) > 1e-12:
        axis = [_float_attr(el, k) for k in ("Ox", "Oy", "Oz")]
        if sum(x * x for x in axis) > 1e-12:
            t.SetRotation(gp_Ax1(gp_Pnt(0, 0, 0), gp_Dir(*axis)), _float_attr(el, "A"))
    t.SetTranslationPart(gp_Vec(_float_attr(el, "Px"), _float_attr(el, "Py"), _float_attr(el, "Pz")))
    return cq.Location(t)


def _parse_xml(zf, member, what):
    try:
        return ET.fromstring(_read_member(zf, member, MAX_XML))
    except KeyError:
        return None
    except _TooLarge as e:
        raise FcstdError(f"The {what} in the FreeCAD file ({member}) would unpack to {_mb(e.args[0])}, more than the "
                         f"{_mb(MAX_XML)} a real FreeCAD file has: the file is damaged or not a FreeCAD file.") from None
    except (ET.ParseError, *_ZIP_ERRORS) as e:
        raise FcstdError(f"The {what} in the FreeCAD file is damaged ({member}: {_zip_why(e)}).") from None


# ---- Shapes --------------------------------------------------------------------------------------------------------

class _CaptureStdout:
    """OCCT reports read errors ("File was not written with this version of the topology") on the C++ stdout. That
    would end up in the output of `soma build --json`, so it is caught on file descriptor 1 and becomes the reason in
    the warning instead."""

    def __enter__(self):
        self.text = ""
        try:
            sys.stdout.flush()
            self._saved = os.dup(1)
            self._tmp = tempfile.TemporaryFile()
            os.dup2(self._tmp.fileno(), 1)
        except (OSError, ValueError, AttributeError):  # no real stdout (embedded): then OCCT may just print
            self._saved = None
        return self

    def __exit__(self, *exc):
        if self._saved is None:
            return False
        try:
            os.dup2(self._saved, 1)
        finally:
            os.close(self._saved)
        try:
            self._tmp.seek(0)
            self.text = self._tmp.read().decode("utf-8", "replace").strip()
        finally:
            self._tmp.close()
        return False


def _read_shape(zf, member, tmpdir):
    """(TopoDS_Shape, None) or (None, reason). Empty file: (None, "") (FreeCAD writes that for an empty shape)."""
    from OCP.BinTools import BinTools
    from OCP.BRep import BRep_Builder
    from OCP.BRepTools import BRepTools
    from OCP.TopoDS import TopoDS_Shape
    try:
        data = _read_member(zf, member, MAX_SHAPES)
    except KeyError:
        return None, f"its shape file {member} is missing in the FCStd file"
    except _TooLarge as e:
        return None, f"its shape file {member} would unpack to {_mb(e.args[0])}, too large"
    except _ZIP_ERRORS as e:
        return None, f"its shape file {member} cannot be unpacked ({_zip_why(e)})"
    if not data.strip():
        return None, ""
    path = Path(tmpdir) / ("shape.bin" if b"Open CASCADE Topology" in data[:200] else "shape.brp")
    path.write_bytes(data)
    readers = [("text", lambda s: BRepTools.Read_s(s, str(path), BRep_Builder())), ("binary", lambda s: BinTools.Read_s(s, str(path)))]
    if path.suffix == ".bin":
        readers.reverse()
    # The header decides the reader, the other one is only a fallback for an unusual header. The reason in the
    # warning comes from the first: the fallback's complaint about the wrong format would only confuse
    reasons = []
    for i, (_, read) in enumerate(readers):
        shape = TopoDS_Shape()
        with _CaptureStdout() as cap:
            try:
                ok = read(shape)
            except Exception as e:  # noqa: BLE001  OCP raises Storage_StreamReadError and others
                ok = False
                if i == 0:
                    reasons.append(type(e).__name__)
        if cap.text and i == 0:
            reasons.append(cap.text.splitlines()[0])
        if ok and not shape.IsNull():
            return shape, None
    why = "; ".join(dict.fromkeys(r for r in reasons if r)) or "unknown reason"
    return None, f"its shape file {member} cannot be read ({why})"


def _has_faces(shape):
    from OCP.TopAbs import TopAbs_FACE
    from OCP.TopExp import TopExp_Explorer
    return TopExp_Explorer(shape, TopAbs_FACE).More()


# ---- Colors (GuiDocument.xml) --------------------------------------------------------------------------------------

def _unpack(v):
    """Packed FreeCAD color r<<24 | g<<16 | b<<8 | a. The last byte is transparency before FreeCAD 1.1 and alpha after,
    so it is not used: the Transparency property says it unambiguously."""
    v = int(v) & 0xFFFFFFFF
    return ((v >> 24) & 255) / 255, ((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255


def _color_list(zf, member):
    try:
        b = _read_member(zf, member, MAX_SIDE)
        n = struct.unpack("<I", b[:4])[0]
        if n == 0 or len(b) < 4 + 4 * n:
            return []
        return list(struct.unpack(f"<{n}I", b[4:4 + 4 * n]))
    except (KeyError, struct.error, _TooLarge, *_ZIP_ERRORS):  # colors only: a damaged list leaves the default
        return []


def _material_list(zf, el):
    """ShapeAppearance of FreeCAD 1.0 and later (App::PropertyMaterialList): [(diffuse packed, transparency 0..1)].
    Per entry four packed colors (ambient, diffuse, specular, emissive), shininess and transparency as float."""
    try:
        b = _read_member(zf, el.get("file"), MAX_SIDE)
        pos = 0
        if el.get("version") not in ("2", "3"):  # older layout: an int32 version first if negative, else the count
            first = struct.unpack("<i", b[:4])[0]
            pos = 4 if first < 0 else 0
        n = struct.unpack("<I", b[pos:pos + 4])[0]
        pos += 4
        out = []
        for i in range(min(n, (len(b) - pos) // 24)):
            _, diffuse, _, _, _, transp = struct.unpack("<4I2f", b[pos + 24 * i:pos + 24 * (i + 1)])
            out.append((diffuse, transp))
        return out
    except (KeyError, TypeError, struct.error, _TooLarge, *_ZIP_ERRORS):
        return []


def _colors(zf, gui):
    """Object name -> (r, g, b, a) from the view providers. Per-face colors (DiffuseColor) give the most frequent one,
    a part has a single color in SOMA."""
    out, vis = {}, {}
    if gui is None:
        return out, vis
    for vp in gui.iter("ViewProvider"):
        name = vp.get("name")
        props = {}
        for p in vp.iter("Property"):
            props.setdefault(p.get("name"), p)
        v = _bool(props.get("Visibility"))
        if v is not None:
            vis[name] = v
        rgb, transp = None, None
        if "Transparency" in props:
            transp = max(0, min(100, _int(props["Transparency"]))) / 100
        el = props["DiffuseColor"].find("ColorList") if "DiffuseColor" in props else None
        packed = _color_list(zf, el.get("file")) if el is not None and el.get("file") else []
        if packed:
            rgb = _unpack(Counter(packed).most_common(1)[0][0])
        el = props["ShapeAppearance"].find("MaterialList") if "ShapeAppearance" in props else None
        if rgb is None and el is not None and el.get("file"):
            mats = _material_list(zf, el)
            if mats:
                diffuse, t = Counter(mats).most_common(1)[0][0]
                rgb = _unpack(diffuse)
                if transp is None and 0 <= t <= 1:
                    transp = t
        el = props["ShapeColor"].find("PropertyColor") if "ShapeColor" in props else None
        if rgb is None and el is not None:
            try:
                rgb = _unpack(el.get("value"))
            except (TypeError, ValueError):
                pass
        # App::Link with its own material instead of the one of the linked object
        if _bool(props.get("OverrideMaterial")) and "ShapeMaterial" in props:
            m = props["ShapeMaterial"].find("PropertyMaterial")
            if m is not None and m.get("diffuseColor"):
                try:
                    rgb = _unpack(m.get("diffuseColor"))
                    transp = float(m.get("transparency", transp or 0))
                except (TypeError, ValueError):
                    pass
        if rgb is not None:
            a = 1.0 - (transp or 0.0)
            out[name] = (*rgb, a if a > 0.05 else 1.0)  # fully transparent would be invisible in SOMA: show it opaque
    return out, vis


# ---- Picking the parts ---------------------------------------------------------------------------------------------

class _Reader:
    def __init__(self, zf, doc, gui, tmpdir):
        self.zf, self.tmpdir = zf, tmpdir
        self.res = Result(program=doc.get("ProgramVersion", ""))
        self.objs = {}
        objects = doc.find("Objects")
        data = doc.find("ObjectData")
        if objects is None or data is None:
            raise FcstdError("The FreeCAD file has no objects (Document.xml without Objects).")
        for el in objects:
            if el.get("name"):
                self.objs[el.get("name")] = _Obj(el.get("name"), el.get("type"))
        for el in data:
            o = self.objs.get(el.get("name"))
            if o is None:
                continue
            props = el.find("Properties")
            for p in (props if props is not None else []):
                o.props.setdefault(p.get("name"), p)
            lab = o.props.get("Label")
            s = lab.find("String") if lab is not None else None
            if s is not None and (s.get("value") or "").strip():
                o.label = s.get("value").strip()
            ext = el.find("Extensions")
            o.ext = tuple(e.get("type", "") for e in ext) if ext is not None else ()
        self.colors, gui_vis = _colors(zf, gui)
        # Visibility: GuiDocument.xml, newer files also (or only) in Document.xml. Unknown counts as visible
        self.visible = {}
        for n, o in self.objs.items():
            v = gui_vis.get(n)
            self.visible[n] = v if v is not None else (_bool(o.prop("Visibility")) is not False)
        self.parent = {}
        for n, o in self.objs.items():
            # ElementList: the elements of a link array belong to the array (reported there), they are no parts of their own
            for c in (o.children if o.is_container else []) + o.links("ElementList"):
                if c in self.objs and c != n:
                    self.parent.setdefault(c, n)
        # Who uses whom as input: those inputs are inside the result already. All consumers, not only the first: an
        # input is left out only if one of them really shows it (see consumer())
        self.used_by = {}
        for n, o in self.objs.items():
            # Drawings, CAM jobs, FEM analyses, measurements, spreadsheets refer to a body but never show it
            if o.type.startswith(_SKIP_TYPES):
                continue
            clone = "Clone" in ((o.prop("Proxy").find("Python").get("class") or "") if o.prop("Proxy") is not None
                                and o.prop("Proxy").find("Python") is not None else "")
            for pname in sorted(_CONSUMING):
                if pname == "Objects" and clone:  # a Draft clone leaves its original visible
                    continue
                for t in o.links(pname):
                    if t in self.objs and t != n and n not in self.used_by.setdefault(t, []):
                        self.used_by[t].append(n)
        # Targets of links within the file: a hidden object shown through a link is shown all the same
        self.link_targets = {}
        for n, o in self.objs.items():
            if o.is_link:
                for t in o.links("LinkedObject"):
                    self.link_targets.setdefault(t, []).append(n)
        self._counts = {}
        self.taken_shapes = {}

    def shown(self, name, seen=frozenset()):
        """Does FreeCAD show the object: visible and not inside a hidden App::Part, or shown through a visible link.
        A feature inside a body counts as shown when the body is (the body shows the result of its features)."""
        if name in seen or len(seen) > MAX_DEPTH or name not in self.objs:
            return False
        seen = seen | {name}
        if any(self.shown(lk, seen) for lk in self.link_targets.get(name, ())):
            return True
        if not self.visible.get(name, True) and not (self.parent.get(name) in self.objs
                                                      and self.objs[self.parent[name]].is_body):
            return False
        p = self.parent.get(name)
        while p is not None and p in self.objs and p not in seen:
            po = self.objs[p]
            if po.is_body:  # the body decides, its features are hidden apart from the Tip
                return self.shown(p, seen)
            if po.is_container and po.shape_file is None and "Placement" in po.props and not self.visible.get(p, True):
                return False  # a hidden App::Part hides everything in it, a plain group does not
            seen = seen | {p}
            p = self.parent.get(p)
        return True

    def consumer(self, name, seen=frozenset()):
        """The consumer that contains this object in a shown result, or None. A consumer counts if it is shown itself
        or if it is in turn used by such a consumer (A in a hidden Cut, the Cut in a visible Fusion)."""
        if name in self._counts:
            return self._counts[name]
        found = None
        for c in self.used_by.get(name, ()):
            if c in seen or len(seen) > MAX_DEPTH:
                continue
            if self.shown(c) or self.consumer(c, seen | {name}) is not None:
                found = c
                break
        if not seen:  # only the complete answer is kept, one inside a cycle may lack a branch
            self._counts[name] = found
        return found

    def label(self, name):
        o = self.objs.get(name)
        return o.label if o else name

    def warn(self, text):
        if text not in self.res.warnings:
            self.res.warnings.append(text)

    def note(self, text):
        if text not in self.res.notes:
            self.res.notes.append(text)

    def run(self):
        for n, o in self.objs.items():
            if n not in self.parent:
                self.walk(n, cq.Location(), (), None, None, False, 0)
        # Containers that contain each other (a broken file) have no top: nothing above would ever reach them
        cyclic = set()
        for n in self.objs:
            seen, p = {n}, self.parent.get(n)
            while p is not None and p not in seen:
                seen.add(p)
                p = self.parent.get(p)
            if p is not None and p == n:
                cyclic.add(n)
        if cyclic:
            self.warn("Containers contain each other in a cycle (the file is damaged), their content is not imported: "
                      + ", ".join(f"'{self.label(n)}'" for n in sorted(cyclic)) + ".")

    def walk(self, name, loc, groups, replace, rename, forced, depth):
        """Collects the parts of one object. loc: placement of the containers around it. replace: a link without
        LinkTransform puts the object at this placement instead of its own. rename: label of the link that shows it.
        forced: shown through a link, its own visibility does not count."""
        o = self.objs[name]
        label = rename or o.label
        if depth > MAX_DEPTH:
            self.warn(f"'{label}': containers or links nested too deeply (a cycle?), not imported.")
            return
        visible = forced or self.visible.get(name, True)
        if o.type.startswith(_SKIP_TYPES):
            if visible and o.type.startswith(("Mesh::", "Points::")):
                self.note(f"'{label}' is a {'mesh' if o.type.startswith('Mesh::') else 'point cloud'} ({o.type}), "
                          "not imported: only solids and surfaces come along. In FreeCAD, Part > Create shape from "
                          "mesh and Part > Convert to solid turn a mesh into a solid.")
            elif visible and o.type.startswith("Sketcher::"):
                self.note(f"'{label}' is a sketch ({o.type}), not imported: sketches are 2D construction geometry.")
            return
        if o.is_link:
            if visible:
                self.link(o, loc, groups, replace, rename, depth)
            return
        if o.type == "App::LinkGroup":
            if visible:
                self.warn(f"'{label}' is a link group (App::LinkGroup), which is not supported yet: not imported.")
            return
        if o.is_container and not o.is_body and o.shape_file is None:
            if "Placement" in o.props:  # App::Part, assemblies: hidden hides all inside, the placement moves all inside
                if not visible:
                    return
                loc = loc * (replace if replace is not None else _location(o.prop("Placement")))
            elif replace is not None:  # a plain group has no placement of its own: the link's moves all inside
                loc = loc * replace
            for c in o.children:
                if c in self.objs and self.parent.get(c) == name:
                    self.walk(c, loc, groups + (label,), None, None, False, depth + 1)
            return
        if not visible or o.shape_file is None:
            return
        user = None if forced else self.consumer(name)
        if user is not None:
            self.note(f"'{o.label}' is visible but used by '{self.label(user)}', left out (it is part of that result).")
            return
        shape = self.shape(o)
        if shape is None:
            return
        if replace is not None:  # the stored shape carries the own placement: take it off, put the link's on
            shape = shape.moved(replace * _location(o.prop("Placement")).inverse)
        self.res.parts.append(Part(name=label, shape=shape.moved(loc), color=self.colors.get(name), group=groups,
                                   source=name, kind=o.type))

    def shape(self, o):
        if o.name in self.taken_shapes:
            return self.taken_shapes[o.name]
        shape, why = _read_shape(self.zf, o.shape_file, self.tmpdir)
        result = None
        if shape is None:
            if why == "":
                if o.is_body:
                    self.note(f"'{o.label}' is an empty body, nothing to import.")
                else:
                    self.warn(f"'{o.label}' has no stored geometry (an empty shape, maybe it failed to recompute in "
                              "FreeCAD), not imported.")
            else:
                self.warn(f"'{o.label}' not imported: {why}.")
        elif not _has_faces(shape):
            self.note(f"'{o.label}' has no faces (lines or points only), left out.")
        else:
            result = cq.Shape.cast(shape)
        self.taken_shapes[o.name] = result
        return result

    def link(self, o, loc, groups, replace, rename, depth):
        label = rename or o.label
        p = o.prop("LinkedObject")
        el = None
        if p is not None:
            el = next((e for e in p.iter() if e.tag in ("XLink", "Link", "LinkSub")), None)
        target = (el.get("name") or el.get("value")) if el is not None else None
        if el is not None and el.get("file"):
            self.warn(f"'{label}' links to '{target}' in another file ({el.get('file')}), not imported. Import that "
                      "file on its own.")
            return
        if not target:
            self.warn(f"'{label}' is a link without a target, not imported.")
            return
        if target not in self.objs:
            self.warn(f"'{label}' links to '{target}', which is not in the file, not imported.")
            return
        sub = el.get("sub") or next((s.get("value") for s in el.iter("Sub") if s.get("value")), "")
        if sub:
            self.warn(f"'{label}' links to a part of '{self.label(target)}' ({sub}), which is not supported yet: "
                      "not imported.")
            return
        if _int(o.prop("ElementCount")) > 0:
            self.warn(f"'{label}' is a link array, which is not supported yet: not imported.")
            return
        scale = o.prop("ScaleVector")
        sv = scale.find("PropertyVector") if scale is not None else None
        if sv is not None and any(abs(_float_attr(sv, k, 1.0) - 1) > 1e-9 for k in ("valueX", "valueY", "valueZ")):
            self.warn(f"'{label}' is a scaled link: imported without the scale.")
        place = replace if replace is not None else _location(o.prop("Placement") if "Placement" in o.props
                                                               else o.prop("LinkPlacement"))
        before = len(self.res.parts)
        # The target is shown under the link's label: a single body as a part, a container as a group
        if _bool(o.prop("LinkTransform")):  # link placement on top of the target's own
            self.walk(target, loc * place, groups, None, label, True, depth + 1)
        else:  # the link placement instead of the target's own (FreeCAD's default)
            self.walk(target, loc, groups, place, label, True, depth + 1)
        color = self.colors.get(o.name) if _bool(o.prop("OverrideMaterial")) else None
        if color:
            for part in self.res.parts[before:]:
                part.color = color


def read(path):
    """Reads an FCStd file. Result with the parts (global coordinates), warnings and notes. FcstdError if the file is
    not a FreeCAD file or contains no usable geometry."""
    path = Path(path)
    if not path.is_file():
        raise FcstdError(f"FreeCAD file not found: {path}")
    try:
        zf = zipfile.ZipFile(path)
    except (zipfile.BadZipFile, OSError) as e:
        raise FcstdError(f"The file is not a FreeCAD file (not a ZIP archive: {e}).") from None
    with zf, tempfile.TemporaryDirectory(prefix="soma-fcstd-") as tmp:
        doc = _parse_xml(zf, "Document.xml", "document")
        if doc is None:
            raise FcstdError("The file is not a FreeCAD file (Document.xml is missing).")
        warn_gui = None
        try:
            gui = _parse_xml(zf, "GuiDocument.xml", "view data")
        except FcstdError as e:  # colors and visibility only: go on without them
            gui, warn_gui = None, str(e)
        r = _Reader(zf, doc, gui, tmp)
        # A zip bomb in the shape files: refuse up front instead of filling the memory part by part
        total = 0
        for member in {o.shape_file for o in r.objs.values() if o.shape_file}:
            try:
                total += zf.getinfo(member).file_size
            except KeyError:
                pass  # reported for the object that needs it
        if total > MAX_SHAPES:
            raise FcstdError(f"The shape files in the FreeCAD file would unpack to {_mb(total)}, more than "
                             f"{_mb(MAX_SHAPES)}: the file is damaged or too large to import.")
        if warn_gui:
            # Newer FreeCAD versions also store the visibility in Document.xml, the reader falls back to it
            known = any(o.prop("Visibility") is not None for o in r.objs.values())
            r.warn(f"{warn_gui} Colors are unknown, "
                   + ("visibility comes from Document.xml." if known else "all objects count as visible (hidden "
                      "construction bodies may show up as parts)."))
        r.run()
        res = r.res
    if not res.parts:
        # Say why: what could not be imported first, then what was left out on purpose (meshes, sketches, inputs)
        reasons = res.warnings + res.notes
        details = " ".join(reasons[:5]) + (f" (and {len(reasons) - 5} more)" if len(reasons) > 5 else "")
        raise FcstdError("The FreeCAD file contains no usable geometry"
                         + (f": {details}" if details else " (no visible solid or surface objects).")
                         + ("" if reasons else " Check in FreeCAD that the bodies are visible and recomputed, "
                            "then save again."))
    return res


def _uniq(name, taken):
    name = (name or "Part").replace("/", "_")  # "/" separates the levels in cq.Assembly
    unique, i = name, 2
    while unique in taken:
        unique, i = f"{name} ({i})", i + 1
    taken.add(unique)
    return unique


def to_assembly(res):
    """cq.Assembly from a Result: containers as sub-assemblies, parts with name and color. If everything lies in one
    top container (an App::Part around the whole model), that container is the assembly itself, so add_part() puts its
    own name in its place, as with the top assembly of a STEP file."""
    parts = res.parts
    tops = {p.group[0] if p.group else None for p in parts}
    strip = 1 if len(tops) == 1 and None not in tops else 0
    taken = set()

    def build(items, label):
        asm = cq.Assembly(name=_uniq(label, taken)) if label is not None else cq.Assembly()
        for p in items:
            if not p.group:
                asm.add(p.shape, name=_uniq(p.name, taken), color=cq.Color(*p.color) if p.color else None)
        order = []
        for p in items:
            if p.group and p.group[0] not in order:
                order.append(p.group[0])
        for g in order:
            sub = [Part(p.name, p.shape, p.color, p.group[1:], p.source, p.kind) for p in items if p.group and p.group[0] == g]
            child = build(sub, g)
            asm.add(child, name=child.name)
        return asm

    items = [Part(p.name, p.shape, p.color, p.group[strip:], p.source, p.kind) for p in parts]
    top = list(tops)[0] if strip else None
    return build(items, top)


def read_assembly(path):
    """FCStd file as cq.Assembly plus the warnings and notes (see read)."""
    res = read(path)
    return to_assembly(res), res


def read_shape(path):
    """All parts of the FCStd file as one shape (a compound if there are several)."""
    res = read(path)
    shapes = [p.shape for p in res.parts]
    return (shapes[0] if len(shapes) == 1 else cq.Compound.makeCompound(shapes)), res


def summary_lines(res):
    """Lines for the command line: each part with group and size."""
    lines = []
    for p in res.parts:
        bb = p.shape.BoundingBox()
        where = "/".join(p.group)
        lines.append(f"{(where + '/') if where else ''}{p.name}  ({p.kind}, {bb.xlen:.1f} x {bb.ylen:.1f} x {bb.zlen:.1f} mm"
                     f", {len(p.shape.Solids())} solid(s))")
    return lines


def write_step(res, out, name):
    """Writes the parts as one STEP assembly (groups as sub-assemblies, names ASCII as everywhere in SOMA, colors).
    First into a temporary file next to the target: a failed export leaves no half file behind."""
    from . import build, registry
    parts, taken = [], set()
    for p in res.parts:
        step = registry.ascii_name(p.name)
        unique, i = step, 2
        while unique in taken:
            unique, i = f"{step}_{i}", i + 1
        taken.add(unique)
        parts.append(dict(shape=p.shape, step_name=unique, role="part", group=p.group,
                          color=p.color or (*registry.DEFAULT_COLORS["part"], 1.0)))
    out = Path(out)
    tmp = out.with_name(f".{out.stem}.tmp-{os.getpid()}.step")
    try:
        build.step_assembly(parts, name).export(str(tmp))
        if not tmp.is_file():  # OCCT can fail without an exception and write nothing
            raise FcstdError(f"The STEP export wrote no file (in {out.parent.as_posix()}). Check that the folder is "
                             "writable and the parts are valid solids.")
        os.replace(tmp, out)
    finally:
        if tmp.exists():
            tmp.unlink()
