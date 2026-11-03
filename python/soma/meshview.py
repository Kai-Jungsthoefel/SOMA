"""Netzdateien (STL, 3MF, AMF, OBJ) fuer den Viewer: Klick im Dateibaum der App, wie bei STEP-Dateien (`soma glb`).

Netze haben keine CAD-Geometrie: kein Messen, keine Flaechen und Kanten im Sinne von CAD. Jedes Objekt der Datei wird ein
Teil, flach schattiert (jedes Dreieck eigene Ecken, so sieht man die Facetten wie im Slicer), dazu Linien an scharfen
Knicken und offenen Raendern, damit die Form lesbar bleibt. Einheiten aus 3MF und AMF werden in mm umgerechnet, STL und OBJ
kennen keine und gelten als mm.
"""
import json
import re
import struct
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

import numpy as np

MESH_EXTS = (".stl", ".3mf", ".amf", ".obj")
# Knick ab diesem Winkel zwischen zwei Dreiecken bekommt eine Linie (wie die Kanten im Viewer bei CAD)
CREASE_DEG = 30.0
# Raster zum Zusammenfuehren der Ecken in mm (STL hat keine gemeinsamen Ecken)
WELD_GRID = 1e-4
_UNIT_MM = {"micron": 0.001, "micrometer": 0.001, "millimeter": 1.0, "centimeter": 10.0, "meter": 1000.0,
            "inch": 25.4, "foot": 304.8, "feet": 304.8}
DEFAULT_COLOR = (0.62, 0.66, 0.72, 1.0)


class MeshFileError(ValueError):
    """Datei nicht lesbar, mit einer Meldung fuer den Benutzer."""


# ---- Leser: liefern [(name, positions (n,3) in mm, triangles (m,3))] und Hinweise -----------------------------------

def read_stl(path):
    data = Path(path).read_bytes()
    if len(data) >= 84:
        n = struct.unpack("<I", data[80:84])[0]
        if 84 + 50 * n == len(data):
            rec = np.frombuffer(data, dtype=np.dtype([("n", "<f4", 3), ("v", "<f4", (3, 3)), ("a", "<u2")]), count=n, offset=84)
            p = rec["v"].reshape(-1, 3).astype(np.float64)
            return [(Path(path).stem, p, np.arange(len(p)).reshape(-1, 3))], []
    text = data.decode("latin-1")
    if not re.match(r"\s*solid", text):
        raise MeshFileError("The file is not a valid STL file (neither binary nor ASCII).")
    parts = []
    for m in re.finditer(r"solid([^\n]*)\n(.*?)endsolid", text, re.S):
        nums = re.findall(r"vertex\s+(\S+)\s+(\S+)\s+(\S+)", m.group(2))
        if not nums:
            continue
        try:
            p = np.array(nums, dtype=np.float64)
        except ValueError:
            raise MeshFileError("The ASCII STL file contains a coordinate that is not a number.") from None
        p = p[: len(p) // 3 * 3]
        parts.append((m.group(1).strip() or Path(path).stem, p, np.arange(len(p)).reshape(-1, 3)))
    if not parts:
        raise MeshFileError("The STL file contains no triangles.")
    return parts, []


def _local(tag):
    return tag.rsplit("}", 1)[-1]


def _children(el, name):
    return [c for c in el if _local(c.tag) == name]


def _child(el, name):
    for c in el:
        if _local(c.tag) == name:
            return c
    return None


def _xml(data, what):
    try:
        return ET.fromstring(data)
    except ET.ParseError as e:
        raise MeshFileError(f"The {what} file is damaged: {e}") from None


def _mat3mf(s):
    """3MF-Transformation (12 Zahlen, Zeilenvektor: p' = p * M) als 4x4 fuer Spaltenvektoren."""
    if not s:
        return np.eye(4)
    v = [float(x) for x in s.split()]
    if len(v) != 12:
        return np.eye(4)
    m = np.eye(4)
    m[:3, :3] = np.array(v[:9]).reshape(3, 3).T
    m[:3, 3] = v[9:12]
    return m


def read_3mf(path):
    try:
        z = zipfile.ZipFile(path)
    except zipfile.BadZipFile:
        raise MeshFileError("The 3MF file is not a valid ZIP package.") from None
    with z:
        names = set(z.namelist())
        model_name = "3D/3dmodel.model"
        if "_rels/.rels" in names:  # Das Hauptmodell nennt die Beziehungsdatei, meist 3D/3dmodel.model
            for r in _xml(z.read("_rels/.rels"), "3MF").iter():
                if _local(r.tag) == "Relationship" and r.get("Type", "").endswith("/3dmodel"):
                    model_name = r.get("Target", model_name).lstrip("/")
        if model_name not in names:
            raise MeshFileError("The 3MF file has no 3D model.")
        root = _xml(z.read(model_name), "3MF")
    scale = _UNIT_MM.get(root.get("unit", "millimeter"), 1.0)
    notes = []
    res = _child(root, "resources")
    objects = {}
    for o in (_children(res, "object") if res is not None else []):
        mesh = _child(o, "mesh")
        entry = dict(name=o.get("name"), mesh=None, comps=[])
        if mesh is not None:
            vs, ts = _child(mesh, "vertices"), _child(mesh, "triangles")
            p = np.array([[float(v.get("x", 0)), float(v.get("y", 0)), float(v.get("z", 0))] for v in _children(vs, "vertex")]
                         if vs is not None else np.zeros((0, 3)), dtype=np.float64).reshape(-1, 3)
            t = np.array([[int(t.get("v1", 0)), int(t.get("v2", 0)), int(t.get("v3", 0))] for t in _children(ts, "triangle")]
                         if ts is not None else np.zeros((0, 3)), dtype=np.int64).reshape(-1, 3)
            entry["mesh"] = (p, t)
        comps = _child(o, "components")
        for c in (_children(comps, "component") if comps is not None else []):
            if any(_local(k) == "path" for k in c.attrib):
                if "external" not in notes:
                    notes.append("external")
                continue
            entry["comps"].append((c.get("objectid"), _mat3mf(c.get("transform"))))
        objects[o.get("id")] = entry
    parts = []

    def walk(oid, m, name, depth=0):
        o = objects.get(oid)
        if o is None or depth > 32:
            return
        label = o["name"] or name
        if o["mesh"] is not None and len(o["mesh"][1]):
            p, t = o["mesh"]
            if t.min() < 0 or t.max() >= len(p):
                raise MeshFileError(f"The 3MF file is damaged: object {label!r} refers to vertices that do not exist.")
            ph = np.c_[p, np.ones(len(p))] @ m.T
            parts.append((label, ph[:, :3] * scale, t))
        for cid, cm in o["comps"]:
            walk(cid, m @ cm, label, depth + 1)

    build = _child(root, "build")
    items = _children(build, "item") if build is not None else []
    for i, it in enumerate(items):
        walk(it.get("objectid"), _mat3mf(it.get("transform")), f"Object {i + 1}")
    if not parts:
        raise MeshFileError("The 3MF file contains no triangles.")
    msgs = ["Parts from other files inside the 3MF package (production extension) are not shown."] if notes else []
    return parts, msgs


def read_amf(path):
    data = Path(path).read_bytes()
    if data[:2] == b"PK":  # AMF darf ZIP-komprimiert sein, mit der eigentlichen Datei als einzigem Eintrag
        try:
            with zipfile.ZipFile(path) as z:
                data = z.read(z.namelist()[0])
        except (zipfile.BadZipFile, IndexError):
            raise MeshFileError("The compressed AMF file is damaged.") from None
    root = _xml(data, "AMF")
    scale = _UNIT_MM.get(root.get("unit", "millimeter"), 1.0)
    parts = []
    for i, o in enumerate(_children(root, "object")):
        name = next((m.text for m in _children(o, "metadata") if m.get("type") == "name" and m.text), f"Object {i + 1}")
        mesh = _child(o, "mesh")
        if mesh is None:
            continue
        vs = _child(mesh, "vertices")
        p = []
        for v in (_children(vs, "vertex") if vs is not None else []):
            c = _child(v, "coordinates")
            p.append([float((_child(c, k).text if c is not None and _child(c, k) is not None else 0) or 0) for k in "xyz"])
        p = np.array(p, dtype=np.float64).reshape(-1, 3)
        t = [[int(_child(tr, k).text) for k in ("v1", "v2", "v3")] for vol in _children(mesh, "volume") for tr in _children(vol, "triangle")]
        t = np.array(t, dtype=np.int64).reshape(-1, 3)
        if len(t) and (t.min() < 0 or t.max() >= len(p)):
            raise MeshFileError(f"The AMF file is damaged: object {name!r} refers to vertices that do not exist.")
        if len(t):
            parts.append((name, p * scale, t))
    if not parts:
        raise MeshFileError("The AMF file contains no triangles.")
    return parts, []


def read_obj(path):
    text = Path(path).read_text(encoding="utf-8", errors="replace")
    verts, parts, cur, name = [], [], [], Path(path).stem

    def flush():
        if cur:
            parts.append((name, list(cur)))
        cur.clear()

    for line in text.splitlines():
        s = line.split()
        if not s:
            continue
        if s[0] == "v" and len(s) >= 4:
            verts.append((float(s[1]), float(s[2]), float(s[3])))
        elif s[0] in ("o", "g") and len(s) > 1:
            flush()
            name = " ".join(s[1:])
        elif s[0] == "f" and len(s) >= 4:
            idx = []
            for tok in s[1:]:
                k = int(tok.split("/")[0])
                idx.append(k - 1 if k > 0 else len(verts) + k)  # negative Indizes zaehlen vom Ende
            for j in range(1, len(idx) - 1):  # Vielecke als Faecher
                cur.append((idx[0], idx[j], idx[j + 1]))
    flush()
    p = np.array(verts, dtype=np.float64).reshape(-1, 3)
    out = []
    for n, tris in parts:
        t = np.array(tris, dtype=np.int64).reshape(-1, 3)
        if t.min() < 0 or t.max() >= len(p):
            raise MeshFileError(f"The OBJ file is damaged: {n!r} refers to vertices that do not exist.")
        used, inv = np.unique(t, return_inverse=True)  # nur die Ecken des Teils
        out.append((n, p[used], inv.reshape(-1, 3)))
    if not out:
        raise MeshFileError("The OBJ file contains no faces.")
    return out, []


READERS = {".stl": read_stl, ".3mf": read_3mf, ".amf": read_amf, ".obj": read_obj}


# ---- Fuer den Viewer aufbereiten ------------------------------------------------------------------------------------

def _viewer_mesh(p, t):
    """Flach schattiertes Netz im Format von mesher.mesh_shape, mit Linien an Knicken und offenen Raendern."""
    _, inv = np.unique(np.round(p / WELD_GRID).astype(np.int64), axis=0, return_inverse=True)
    w = inv.reshape(-1)[t]
    keep = (w[:, 0] != w[:, 1]) & (w[:, 1] != w[:, 2]) & (w[:, 0] != w[:, 2])
    t, w = t[keep], w[keep]
    tri = p[t]  # (m, 3, 3)
    fn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    area2 = np.linalg.norm(fn, axis=1)
    un = fn / np.maximum(area2, 1e-30)[:, None]
    # Kanten: jedes Dreieck drei, ungerichtet zusammengefasst. Linie, wo nur ein Dreieck anliegt (offener Rand), mehr als
    # zwei (nicht mannigfaltig) oder zwei mit starkem Knick.
    e = np.concatenate([w[:, [0, 1]], w[:, [1, 2]], w[:, [2, 0]]])
    ep = np.concatenate([t[:, [0, 1]], t[:, [1, 2]], t[:, [2, 0]]])  # Koordinaten aus den Originalecken
    owner = np.tile(np.arange(len(w)), 3)
    key = np.sort(e, axis=1)
    _, first, ek, cnt = np.unique(key, axis=0, return_index=True, return_inverse=True, return_counts=True)
    ek = ek.reshape(-1)
    order = np.argsort(ek, kind="stable")
    starts = np.r_[0, np.cumsum(cnt)[:-1]]
    line = cnt != 2
    two = np.nonzero(cnt == 2)[0]
    a, b = owner[order[starts[two]]], owner[order[starts[two] + 1]]
    line[two] = np.einsum("ij,ij->i", un[a], un[b]) < np.cos(np.radians(CREASE_DEG))
    segs = p[ep[first[line]]].reshape(-1, 3)

    m = len(t)
    pos = tri.reshape(-1, 3).astype(np.float32)
    nrm = np.repeat(un, 3, axis=0).astype(np.float32)
    # Eine „Flaeche“ fuer das ganze Netz, ohne Flaecheninhalt: Beim Anklicken gaelte er sonst als der einer CAD-Flaeche
    c = tri.reshape(-1, 3).mean(axis=0) if m else np.zeros(3)
    face = dict(id=0, surface="MESH", center=[round(float(x), 4) for x in c], triStart=0, triCount=int(m))
    return dict(positions=pos, normals=nrm, indices=np.arange(3 * m, dtype=np.uint32).reshape(-1, 3),
                lines=segs.astype(np.float32), faces=[face], edges=[], vertices=[]), dict(
                    triangles=int(m), open_edges=int((cnt == 1).sum()),
                    volume=float(np.einsum("ij,ij->i", tri[:, 0], np.cross(tri[:, 1], tri[:, 2])).sum() / 6))


def mesh_to_glb(src, out_dir, name=None):
    """Schreibt <out_dir>/model.glb und model.map.json fuer eine Netzdatei. Liefert die Bauteilliste und Hinweise.
    name: fuer Teile ohne eigenen Namen statt des Dateinamens."""
    from . import mesher
    src, out = Path(src), Path(out_dir)
    reader = READERS.get(src.suffix.lower())
    if reader is None:
        raise MeshFileError(f"Not a mesh file: {src.name}")
    if not src.is_file():
        raise FileNotFoundError(f"File not found: {src}")
    try:
        parts, notes = reader(src)
    except MeshFileError:
        raise
    except (ValueError, IndexError, AttributeError, TypeError) as e:
        raise MeshFileError(f"The {src.suffix[1:].upper()} file could not be read: {e}") from None
    if name:  # Teile ohne eigenen Namen heissen wie die Datei: bei einer Arbeitskopie (source.stl) wie das Original
        parts = [(name if n == src.stem else n, p, t) for n, p, t in parts]
    out.mkdir(parents=True, exist_ok=True)
    glb_parts, map_parts, taken = [], [], set()
    for i, (name, p, t) in enumerate(parts):
        if not len(t):
            continue
        name = name or f"Part {i + 1}"
        base, k = name, 2
        while name in taken:  # Namen im Baum eindeutig, sonst waeren Teile nicht auseinanderzuhalten
            name, k = f"{base} ({k})", k + 1
        taken.add(name)
        mesh, info = _viewer_mesh(p, t)
        if not info["triangles"]:
            continue
        pid = f"{i}:{name}"
        lo, hi = p[np.unique(t)].min(axis=0), p[np.unique(t)].max(axis=0)
        closed = info["open_edges"] == 0
        entry = dict(id=pid, name=name, role="basic", group=None,
                     bbox=[[round(float(x), 3) for x in lo], [round(float(x), 3) for x in hi]],
                     triangles=info["triangles"], closed=closed)
        if closed:  # Volumen nur bei geschlossenem Netz, sonst ist die Zahl bedeutungslos
            entry["volume"] = round(abs(info["volume"]), 3)
        map_parts.append(entry)
        glb_parts.append(dict(meta=dict(partId=pid, name=name, role="basic", group=None, solid=closed),
                              mesh=mesh, color=DEFAULT_COLOR))
    if not glb_parts:
        raise MeshFileError("The file contains no triangles.")
    mesher.write_glb(out / "model.glb", glb_parts)
    # Kein build: Ohne CAD-Geometrie gibt es nichts zu messen. mesh=true sagt der App, warum.
    (out / "model.map.json").write_text(json.dumps(dict(version=0, mesh=True, notes=notes, parts=map_parts), indent=1,
                                                   ensure_ascii=False), encoding="utf-8")
    return map_parts, notes
