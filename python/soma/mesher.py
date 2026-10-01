"""Phase 0, Punkt 2: eigener Mesher. Pro Bauteil ein Mesh, pro Flaeche ein zusammenhaengender Dreiecksbereich.

Ergebnis ist ein GLB (glTF 2.0, Z-up, Einheit mm) plus ein Python-Dict mit Flaechen-/Kanten-Tabellen, das
spaeter als model.map.json geschrieben wird. Die Flaechen-IDs gelten nur fuer einen Build (Topological-Naming-
Problem), das ist fuer Phase 0 bewusst so.
"""
import json
import struct

import numpy as np
from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Curve
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.GCPnts import GCPnts_TangentialDeflection
from OCP.TopAbs import TopAbs_REVERSED
from OCP.TopLoc import TopLoc_Location


def srgb_to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def mesh_shape(shape, tol=0.05, ang=0.3):
    """Tesselliert ein cq.Shape. Liefert Dict mit numpy-Arrays und Flaechen-/Kanten-Tabellen."""
    BRepMesh_IncrementalMesh(shape.wrapped, tol, False, ang, True)

    pos, idx, nrm = [], [], []
    faces = []
    voff = 0
    tri_total = 0
    for fi, face in enumerate(shape.Faces()):
        loc = TopLoc_Location()
        tri = BRep_Tool.Triangulation_s(face.wrapped, loc)
        if tri is None:
            faces.append(dict(id=fi, surface=face.geomType(), triStart=tri_total, triCount=0))
            continue
        trsf = loc.Transformation()
        n = tri.NbNodes()
        p = np.empty((n, 3), dtype=np.float32)
        for i in range(n):
            pt = tri.Node(i + 1).Transformed(trsf)
            p[i] = (pt.X(), pt.Y(), pt.Z())
        flip = face.wrapped.Orientation() == TopAbs_REVERSED
        t = np.empty((tri.NbTriangles(), 3), dtype=np.uint32)
        for i in range(tri.NbTriangles()):
            a, b, c = tri.Triangle(i + 1).Get()
            t[i] = (a - 1, c - 1, b - 1) if flip else (a - 1, b - 1, c - 1)
        # Normalen: flaechengewichtet, nur innerhalb einer Flaeche gemittelt (harte Kanten zwischen Flaechen)
        fn = np.cross(p[t[:, 1]] - p[t[:, 0]], p[t[:, 2]] - p[t[:, 0]])
        vn = np.zeros_like(p)
        for k in range(3):
            np.add.at(vn, t[:, k], fn)
        ln = np.linalg.norm(vn, axis=1, keepdims=True)
        vn = np.where(ln > 1e-12, vn / np.maximum(ln, 1e-12), 0).astype(np.float32)

        c = face.Center()
        faces.append(dict(
            id=fi, surface=face.geomType(), area=round(face.Area(), 4),
            center=[round(c.x, 4), round(c.y, 4), round(c.z, 4)],
            triStart=tri_total, triCount=int(t.shape[0]),
        ))
        pos.append(p); nrm.append(vn); idx.append(t + voff)
        voff += n
        tri_total += t.shape[0]

    lines, edges = [], []
    seg_total = 0
    for ei, edge in enumerate(shape.Edges()):
        try:
            crv = BRepAdaptor_Curve(edge.wrapped)
            d = GCPnts_TangentialDeflection(crv, 0.2, tol)
            pts = [d.Value(i + 1) for i in range(d.NbPoints())]
        except Exception:
            continue
        if len(pts) < 2:
            continue
        segs = []
        for a, b in zip(pts[:-1], pts[1:]):
            segs.extend([(a.X(), a.Y(), a.Z()), (b.X(), b.Y(), b.Z())])
        lines.append(np.asarray(segs, dtype=np.float32))
        edges.append(dict(id=ei, curve=edge.geomType(), length=round(edge.Length(), 4),
                          segStart=seg_total, segCount=len(pts) - 1))
        seg_total += len(pts) - 1

    # Eckpunkte zum Fassen beim Messen: exakte Koordinaten, Reihenfolge wie shape.Vertices() (dieselbe wie im Messdienst)
    vertices = [dict(id=vi, p=[round(c, 6) for c in v.toTuple()]) for vi, v in enumerate(shape.Vertices())]

    cat = lambda arrs, shp, dt: np.concatenate(arrs) if arrs else np.zeros(shp, dtype=dt)
    return dict(
        positions=cat(pos, (0, 3), np.float32), normals=cat(nrm, (0, 3), np.float32),
        indices=cat(idx, (0, 3), np.uint32), lines=cat(lines, (0, 3), np.float32),
        faces=faces, edges=edges, vertices=vertices,
    )


def write_glb(path, parts):
    """parts: Liste von Dicts {meta:{...}, mesh:{...aus mesh_shape}, color:(r,g,b,a) in sRGB}.
    meta wandert 1:1 in node.extras.soma (z. B. partId, role, faceRanges)."""
    blob = bytearray()
    views, accessors, materials, meshes, nodes = [], [], [], [], []

    def add_view(arr, target):
        while len(blob) % 4:
            blob.append(0)
        views.append(dict(buffer=0, byteOffset=len(blob), byteLength=arr.nbytes, target=target))
        blob.extend(arr.tobytes())
        return len(views) - 1

    def add_acc(arr, ctype, target, minmax=False):
        v = add_view(arr, target)
        comp = {"SCALAR": 1, "VEC3": 3}[ctype]
        acc = dict(bufferView=v, componentType=5125 if arr.dtype == np.uint32 else 5126,
                   count=int(arr.size // comp), type=ctype)
        if minmax:
            flat = arr.reshape(-1, 3)
            acc["min"] = flat.min(axis=0).tolist(); acc["max"] = flat.max(axis=0).tolist()
        accessors.append(acc)
        return len(accessors) - 1

    line_mat = len(materials)
    materials.append(dict(name="edge", pbrMetallicRoughness=dict(baseColorFactor=[0.05, 0.05, 0.05, 1.0],
                                                                   metallicFactor=0, roughnessFactor=1)))
    for p in parts:
        m = p["mesh"]
        r, g, b, a = p["color"]
        mat = dict(name=p["meta"]["partId"], doubleSided=True, pbrMetallicRoughness=dict(
            baseColorFactor=[srgb_to_linear(r), srgb_to_linear(g), srgb_to_linear(b), a],
            metallicFactor=0.0, roughnessFactor=0.6))
        if a < 1.0:
            mat["alphaMode"] = "BLEND"
        materials.append(mat)
        prims = []
        if m["indices"].size:
            prims.append(dict(mode=4, material=len(materials) - 1, attributes=dict(
                POSITION=add_acc(m["positions"], "VEC3", 34962, True),
                NORMAL=add_acc(m["normals"], "VEC3", 34962)),
                indices=add_acc(m["indices"].reshape(-1), "SCALAR", 34963)))
        if m["lines"].size:
            prims.append(dict(mode=1, material=line_mat, attributes=dict(
                POSITION=add_acc(m["lines"], "VEC3", 34962, True))))
        meshes.append(dict(name=p["meta"]["partId"], primitives=prims))
        meta = dict(p["meta"])
        meta["faces"] = m["faces"]; meta["edges"] = m["edges"]; meta["vertices"] = m.get("vertices", [])
        nodes.append(dict(name=p["meta"]["partId"], mesh=len(meshes) - 1, extras=dict(soma=meta)))

    root = dict(name="soma-root", children=list(range(1, len(nodes) + 1)))
    gltf = dict(asset=dict(version="2.0", generator="soma"), scene=0, scenes=[dict(nodes=[0])],
                nodes=[root] + nodes, meshes=meshes, materials=materials, accessors=accessors,
                bufferViews=views, buffers=[dict(byteLength=len(blob))])
    js = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    js += b" " * (-len(js) % 4)
    while len(blob) % 4:
        blob.append(0)
    total = 12 + 8 + len(js) + 8 + len(blob)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<II", len(js), 0x4E4F534A)); f.write(js)
        f.write(struct.pack("<II", len(blob), 0x004E4942)); f.write(blob)
    return total
