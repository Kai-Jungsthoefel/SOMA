"""Netze fuer den Export (3MF, AMF, STL, OBJ): ein geschlossenes Netz pro Koerper mit gemeinsamen Ecken.

Die Vernetzung von OCC liefert pro CAD-Flaeche ein eigenes Dreiecksstueck. Die Knoten auf gemeinsamen Kanten liegen
exakt aufeinander, haben aber getrennte Indizes. Fuer den Viewer ist das richtig (harte Normalen pro Flaeche), ein
Slicer sieht darin aber viele offene Flaechen und repariert sie, im schlimmsten Fall mit Rissen in der Wand. Deshalb
werden die Ecken hier pro Koerper zusammengefuehrt und die dabei entartenden Dreiecke (Pole von Kugelflaechen in
Verrundungsecken, Kegelspitzen) verworfen.
"""
import struct
import zipfile
from datetime import datetime, timezone
from xml.sax.saxutils import quoteattr

import numpy as np
from OCP.BRep import BRep_Tool
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.TopAbs import TopAbs_REVERSED
from OCP.TopLoc import TopLoc_Location

# Raster fuer das Zusammenfuehren in mm: weit unter jeder Druckaufloesung und der Netztoleranz (mindestens 0.01 mm),
# weit ueber dem Rundungsrauschen von double
MERGE_GRID = 1e-5
# Winkeltoleranz wie CadQuerys Exporter (0.1 rad, etwa 6 Grad): kleine Bohrungen und Radien bleiben rund
ANGULAR_TOLERANCE = 0.1

# Optionen fuer Netzformate (Issue #8, Export in Game Engines). Einheit: mm je Einheit. Modelliert wird immer in mm mit
# Z nach oben, umgerechnet wird nur beim Schreiben.
UNITS = {"mm": 1.0, "cm": 10.0, "m": 1000.0, "in": 25.4}
# Detailstufe: Faktor auf den Sehnenfehler von print_tolerance und Winkeltoleranz in rad
DETAIL = {"coarse": (4.0, 0.3), "normal": (1.0, ANGULAR_TOLERANCE), "fine": (0.25, 0.05)}
MESH_FORMATS = ("3mf", "amf", "stl", "obj", "glb", "gltf")
# Einheiten in den Formaten, die eine kennen. AMF kennt keine Zentimeter.
_UNIT_3MF = {"mm": "millimeter", "cm": "centimeter", "m": "meter", "in": "inch"}
_UNIT_AMF = {"mm": "millimeter", "m": "meter", "in": "inch"}


def default_options(fmt):
    """Einheit und Achse nach oben, wenn der Benutzer nichts angibt: glTF ist laut Spezifikation in Metern mit Y nach
    oben, alles andere bleibt bei mm und Z nach oben (Slicer erwarten mm, CAD Z nach oben)."""
    return ("m", "y") if fmt in ("glb", "gltf") else ("mm", "z")


def check_options(fmt, units, up, detail):
    """Fehlermeldung fuer unpassende Optionen oder None."""
    if units not in UNITS:
        return f"Unknown unit {units!r}. Supported: {', '.join(UNITS)}"
    if up not in ("z", "y"):
        return f"Unknown up axis {up!r}. Supported: z, y"
    if detail not in DETAIL:
        return f"Unknown detail {detail!r}. Supported: {', '.join(DETAIL)}"
    if fmt == "amf" and units not in _UNIT_AMF:
        return f"AMF does not support the unit {units!r}. Use {', '.join(_UNIT_AMF)}"
    return None


def detail_tolerance(shape, detail="normal", tol=None):
    """Sehnenfehler (mm) und Winkeltoleranz fuer eine Detailstufe. tol ersetzt den Sehnenfehler."""
    f, ang = DETAIL[detail]
    return (tol if tol else print_tolerance(shape) * f), ang


def _convert(p, units, up):
    """Punkte oder Normalen von mm und Z nach oben in die Zieleinheit und -achse. Y nach oben ist eine Drehung um -90 Grad
    um X, wie bei CadQuerys glTF-Export: (x, y, z) -> (x, z, -y). Eine Drehung, die Orientierung bleibt erhalten."""
    if up == "y":
        p = np.column_stack((p[:, 0], p[:, 2], -p[:, 1]))
    return p if units is None else p / UNITS[units]


def convert_bodies(bodies, units, up):
    """Rechnet die Koerper von body_meshes um. Erst nach dem Zusammenfuehren, MERGE_GRID gilt in mm."""
    if units == "mm" and up == "z":
        return bodies
    return [dict(b, positions=_convert(b["positions"], units, up), normals=_convert(b["normals"], None, up)) for b in bodies]


def print_tolerance(shape):
    """Sehnenfehler fuer den Export: wie im Viewer nach Bauteilgroesse, aber hoechstens 0.05 mm, damit Rundungen auch
    an grossen Teilen nicht als Facetten im Druck sichtbar werden."""
    from . import build
    return min(0.05, build.auto_tolerance([shape]))


def _face_mesh(face):
    """Knoten, Dreiecke (nach aussen gerichtet) und Knotennormalen einer schon vernetzten Flaeche oder None."""
    loc = TopLoc_Location()
    tri = BRep_Tool.Triangulation_s(face.wrapped, loc)
    if tri is None or tri.NbTriangles() == 0:
        return None
    trsf = loc.Transformation()
    n = tri.NbNodes()
    p = np.empty((n, 3), dtype=np.float64)
    for i in range(n):
        pt = tri.Node(i + 1).Transformed(trsf)
        p[i] = (pt.X(), pt.Y(), pt.Z())
    flip = face.wrapped.Orientation() == TopAbs_REVERSED
    t = np.empty((tri.NbTriangles(), 3), dtype=np.int64)
    for i in range(tri.NbTriangles()):
        a, b, c = tri.Triangle(i + 1).Get()
        t[i] = (a - 1, c - 1, b - 1) if flip else (a - 1, b - 1, c - 1)
    # Normalen flaechengewichtet und nur innerhalb der Flaeche gemittelt (harte Kanten im OBJ wie im Viewer)
    fn = np.cross(p[t[:, 1]] - p[t[:, 0]], p[t[:, 2]] - p[t[:, 0]])
    vn = np.zeros_like(p)
    for k in range(3):
        np.add.at(vn, t[:, k], fn)
    ln = np.linalg.norm(vn, axis=1, keepdims=True)
    vn = np.where(ln > 1e-12, vn / np.maximum(ln, 1e-12), 0.0)
    return p, t, vn


def _face_info(face):
    """Art, Flaeche und Lage einer Flaeche, damit der Benutzer sie findet (Issue #10). Fehler beim Abfragen sollen den
    Export nicht abbrechen, die Flaeche wird dann ohne Angaben gezaehlt."""
    try:
        bb = face.BoundingBox()
        return dict(type=face.geomType(), area=face.Area(),
                    box=((bb.xmin, bb.xmax), (bb.ymin, bb.ymax), (bb.zmin, bb.zmax)))
    except Exception:
        return None


def _body(faces, name):
    pos, tris, nrm, missing, off = [], [], [], [], 0
    for f in faces:
        m = _face_mesh(f)
        if m is None:
            missing.append(_face_info(f))
            continue
        pos.append(m[0]); tris.append(m[1] + off); nrm.append(m[2])
        off += len(m[0])
    if not pos:
        return None
    raw_p, raw_t, raw_n = np.concatenate(pos), np.concatenate(tris), np.concatenate(nrm)
    _, first, inv = np.unique(np.round(raw_p / MERGE_GRID).astype(np.int64), axis=0, return_index=True, return_inverse=True)
    inv = inv.reshape(-1)
    t = inv[raw_t]
    keep = (t[:, 0] != t[:, 1]) & (t[:, 1] != t[:, 2]) & (t[:, 0] != t[:, 2])
    return dict(name=name, positions=raw_p[first], triangles=t[keep], normals=raw_n, normal_index=raw_t[keep],
                missing_faces=len(missing), missing=missing, dropped=int((~keep).sum()))


def body_meshes(shape, name="part", tol=None, ang=ANGULAR_TOLERANCE):
    """Vernetzt ein cq.Shape fuer den Export. Liefert pro Koerper (Solid) ein Dict mit positions (n,3), triangles (m,3)
    mit gemeinsamen Ecken, normals und normal_index (Normalen pro Flaeche fuer OBJ), missing_faces, missing (Art, Flaeche
    und Lage jeder nicht vernetzten Flaeche oder None) und dropped.
    Flaechen ausserhalb von Solids (offene Flaechen, Schalen) kommen als eigener, offener Koerper dazu statt zu fehlen."""
    tol = print_tolerance(shape) if tol is None else tol
    BRepMesh_IncrementalMesh(shape.wrapped, tol, False, ang, True)
    solids = shape.Solids()
    groups = [s.Faces() for s in solids]
    in_solids = {f for g in groups for f in g}
    loose = [f for f in shape.Faces() if f not in in_solids]
    if loose:
        groups.append(loose)
    bodies = []
    for i, faces in enumerate(groups):
        b = _body(faces, name if len(groups) == 1 else f"{name} {i + 1}")
        if b is not None:
            bodies.append(b)
    return bodies


def edge_report(triangles):
    """Kanten eines Netzes: offene (nur ein Dreieck), nicht-mannigfaltige (mehr als zwei) und solche, an denen zwei
    Dreiecke gegenlaeufig orientiert sind (beide durchlaufen die Kante in derselben Richtung)."""
    t = np.asarray(triangles, dtype=np.int64)
    if not len(t):
        return dict(open=0, nonmanifold=0, flipped=0)
    d = np.concatenate([t[:, [0, 1]], t[:, [1, 2]], t[:, [2, 0]]])
    und = np.sort(d, axis=1)
    _, cnt = np.unique(und, axis=0, return_counts=True)
    _, dcnt = np.unique(d, axis=0, return_counts=True)
    return dict(open=int((cnt == 1).sum()), nonmanifold=int((cnt > 2).sum()), flipped=int((dcnt > 1).sum()))


# Flaechen darunter (mm²) nennt die Warnung einen wahrscheinlichen Splitter: Reste, wo zwei Verrundungen oder Fasen
# aufeinandertreffen, sind typisch weit unter 0.01 mm², echte kleine Flaechen eines Bauteils kaum
SLIVER_AREA = 0.01
# So viele nicht vernetzte Flaechen beschreibt die Warnung einzeln, den Rest nur als Anzahl
MAX_LISTED = 5


def _span(lo, hi):
    def f(v):
        s = f"{v:.1f}"
        return "0.0" if s == "-0.0" else s
    return f((lo + hi) / 2) if abs(hi - lo) < 0.05 else f"{f(lo)}..{f(hi)}"


def _describe(info):
    if info is None:
        return "unknown face"
    (x0, x1), (y0, y1), (z0, z1) = info["box"]
    a = info["area"]
    area = f"{a:.1f} mm²" if a >= 1 else f"{a:.2g} mm²"
    sliver = ", probably a sliver" if a < SLIVER_AREA else ""
    return f"{info['type']}, {area}{sliver} at x {_span(x0, x1)}, y {_span(y0, y1)}, z {_span(z0, z1)}"


def problems(bodies):
    """Hinweise fuer den Benutzer, wenn ein Netz trotzdem nicht geschlossen ist (Bericht statt Reparatur, E28)."""
    out = []
    for b in bodies:
        r = edge_report(b["triangles"])
        bits = []
        if b["missing_faces"]:
            miss = b.get("missing") or []
            desc = "; ".join(_describe(i) for i in miss[:MAX_LISTED])
            if len(miss) > MAX_LISTED:
                desc += f"; and {len(miss) - MAX_LISTED} more"
            bits.append(f"{b['missing_faces']} face(s) could not be meshed" + (f" ({desc})" if desc else ""))
        if r["open"]:
            bits.append(f"{r['open']} open edge(s)")
        if r["nonmanifold"]:
            bits.append(f"{r['nonmanifold']} non-manifold edge(s)")
        if r["flipped"]:
            bits.append(f"{r['flipped']} edge(s) with inconsistent triangle orientation")
        if bits:
            out.append(f"mesh of {b['name']!r} is not closed: {', '.join(bits)}. A slicer may repair it differently "
                       "than intended. Check the geometry (open surfaces, overlapping or touching bodies).")
    return out


def _num(v):
    s = f"{v:.6f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def _coords(p):
    return [(_num(x), _num(y), _num(z)) for x, y, z in p]


def write_3mf(path, bodies, name, units="mm"):
    """3MF Core: ein Objekt pro Koerper. Mehrere Koerper fasst ein Objekt mit Komponenten zusammen, damit der Slicer sie
    als ein Teil auf das Druckbett legt und nicht einzeln verteilt."""
    res = []
    for i, b in enumerate(bodies, start=1):
        vs = "".join(f'<vertex x="{x}" y="{y}" z="{z}"/>' for x, y, z in _coords(b["positions"]))
        ts = "".join(f'<triangle v1="{a}" v2="{c}" v3="{d}"/>' for a, c, d in b["triangles"].tolist())
        res.append(f'<object id="{i}" type="model" name={quoteattr(b["name"])}><mesh><vertices>{vs}</vertices>'
                   f'<triangles>{ts}</triangles></mesh></object>')
    item = 1
    if len(bodies) > 1:
        item = len(bodies) + 1
        comps = "".join(f'<component objectid="{i}"/>' for i in range(1, len(bodies) + 1))
        res.append(f'<object id="{item}" type="model" name={quoteattr(name)}><components>{comps}</components></object>')
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    model = ('<?xml version="1.0" encoding="UTF-8"?>\n'
             f'<model unit="{_UNIT_3MF[units]}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
             f'<metadata name="Application">SOMA</metadata><metadata name="CreationDate">{stamp}</metadata>'
             f'<resources>{"".join(res)}</resources><build><item objectid="{item}"/></build></model>')
    types = ('<?xml version="1.0" encoding="UTF-8"?>\n'
             '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
             '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
             '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')
    rels = ('<?xml version="1.0" encoding="UTF-8"?>\n'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Target="/3D/3dmodel.model" Id="rel0" '
            'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", types)
        z.writestr("_rels/.rels", rels)
        z.writestr("3D/3dmodel.model", model)


def write_amf(path, bodies, name, units="mm"):
    """AMF: ein Objekt, eine gemeinsame Eckenliste, ein volume pro Koerper (so lesen Slicer mehrere Koerper als ein Teil)."""
    parts, vols, off = [], [], 0
    for b in bodies:
        parts.extend(f"<vertex><coordinates><x>{x}</x><y>{y}</y><z>{z}</z></coordinates></vertex>"
                     for x, y, z in _coords(b["positions"]))
        tri = "".join(f"<triangle><v1>{a}</v1><v2>{c}</v2><v3>{d}</v3></triangle>"
                      for a, c, d in (b["triangles"] + off).tolist())
        vols.append(f'<volume><metadata type="name">{_xml_text(b["name"])}</metadata>{tri}</volume>')
        off += len(b["positions"])
    text = (f'<?xml version="1.0" encoding="UTF-8"?>\n<amf unit="{_UNIT_AMF[units]}" version="1.1">'
            f'<metadata type="producer">SOMA</metadata><object id="0"><metadata type="name">{_xml_text(name)}</metadata>'
            f'<mesh><vertices>{"".join(parts)}</vertices>{"".join(vols)}</mesh></object></amf>\n')
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def _xml_text(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def write_stl(path, bodies, name, units="mm"):
    """Binaeres STL. Das Format kennt keine Indizes, Slicer verbinden ueber die Koordinaten; entartete Dreiecke fehlen
    aber auch hier, und die Koordinaten kommen aus demselben Netz wie bei 3MF. Keine Einheit im Format, die Koordinaten
    sind schon umgerechnet."""
    t = [b["positions"][b["triangles"]] for b in bodies]
    tri = np.concatenate(t) if t else np.zeros((0, 3, 3))
    n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    n = np.where(ln > 1e-30, n / np.maximum(ln, 1e-30), 0.0)
    rec = np.zeros(len(tri), dtype=np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")]))
    rec["n"] = n
    rec["v"] = tri
    head = f"SOMA binary STL {name}".encode("ascii", "replace")[:80].ljust(80, b" ")
    with open(path, "wb") as f:
        f.write(head)
        f.write(struct.pack("<I", len(tri)))
        f.write(rec.tobytes())


def write_obj(path, bodies, name, units="mm"):
    """OBJ mit gemeinsamen Ecken (v) und Normalen pro Flaeche (vn), damit Kanten in Grafikprogrammen hart bleiben. OBJ
    kennt keine Einheit, sie steht nur im Kommentar."""
    lines = [f"# SOMA export: {name}", f"# units: {units}"]
    voff = noff = 0
    for b in bodies:
        lines.append(f"o {' '.join(b['name'].split())}")
        lines += [f"v {x} {y} {z}" for x, y, z in _coords(b["positions"])]
        lines += [f"vn {nx:.4f} {ny:.4f} {nz:.4f}" for nx, ny, nz in b["normals"].tolist()]
        for (a, c, d), (na, nc, nd) in zip((b["triangles"] + voff + 1).tolist(), (b["normal_index"] + noff + 1).tolist()):
            lines.append(f"f {a}//{na} {c}//{nc} {d}//{nd}")
        voff += len(b["positions"])
        noff += len(b["normals"])
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")


WRITERS = {"3mf": write_3mf, "amf": write_amf, "stl": write_stl, "obj": write_obj}


def export_gltf(shape, path, name="part", units="m", up="y", detail="normal", tol=None):
    """glTF/GLB ueber OCCT. Vorher CadQuerys exportGLTF: drehte nach Y oben, liess aber mm stehen, wo glTF Meter meint
    (ein Teil von 100 mm kam in Blender oder einer Engine 100 m gross an), und vernetzte fest mit 0.001 mm. Der
    Koordinatenumrechner des Writers erledigt Einheit und Achse, die Vernetzung folgt der Detailstufe."""
    import cadquery as cq
    from cadquery.occ_impl.assembly import toCAF
    from OCP.Message import Message_ProgressRange
    from OCP.RWGltf import RWGltf_CafWriter
    from OCP.RWMesh import RWMesh_CoordinateSystem
    from OCP.TCollection import TCollection_AsciiString
    from OCP.TColStd import TColStd_IndexedDataMapOfStringString
    lin, ang = detail_tolerance(shape, detail, tol)
    a = cq.Assembly(name="root")
    a.add(shape, name="part")
    _, doc = toCAF(a, True, True, lin, ang)
    writer = RWGltf_CafWriter(TCollection_AsciiString(str(path)), not str(path).lower().endswith(".gltf"))
    # Eine Primitive pro Teil statt pro CAD-Flaeche: Engines machen sonst aus jeder Flaeche ein eigenes Submesh
    writer.SetMergeFaces(True)
    cs = writer.ChangeCoordinateSystemConverter()
    cs.SetInputLengthUnit(0.001)
    cs.SetInputCoordinateSystem(RWMesh_CoordinateSystem.RWMesh_CoordinateSystem_Zup)
    cs.SetOutputLengthUnit(UNITS[units] / 1000)
    cs.SetOutputCoordinateSystem(RWMesh_CoordinateSystem.RWMesh_CoordinateSystem_Yup if up == "y"
                                 else RWMesh_CoordinateSystem.RWMesh_CoordinateSystem_Zup)
    if not writer.Perform(doc, TColStd_IndexedDataMapOfStringString(), Message_ProgressRange()):
        raise RuntimeError("Writing the glTF file failed")
    return []


def export_mesh(shape, fmt, path, name="part", units=None, up=None, detail="normal", tol=None):
    """Schreibt shape als Netz im Format fmt (MESH_FORMATS). units und up ohne Angabe nach default_options. Liefert
    Hinweise, wenn ein Netz nicht geschlossen ist."""
    du, dup = default_options(fmt)
    units, up = units or du, up or dup
    err = check_options(fmt, units, up, detail)
    if err:
        raise ValueError(err)
    if fmt in ("glb", "gltf"):
        return export_gltf(shape, path, name, units, up, detail, tol)
    lin, ang = detail_tolerance(shape, detail, tol)
    bodies = body_meshes(shape, name, lin, ang)
    if not bodies:
        raise RuntimeError("The part could not be meshed (no faces with triangles)")
    WRITERS[fmt](path, convert_bodies(bodies, units, up), name, units)
    return problems(bodies)
