"""Kleiner GLB-Schreiber (glTF 2.0, binaer) fuer Animationen und Analyse-Ergebnisse (E58).

Das Modell selbst schreibt mesher.write_glb. Hier geht es um Dateien, die andere Programme ebenfalls lesen sollen:
Animationen (Knoten mit Bewegung, Kamera) und Ergebnisse (Netze mit einem Wert je Eckpunkt). Einheit mm, Z oben.
"""
import json
import struct

import numpy as np

FLOAT, UINT = 5126, 5125
ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER = 34962, 34963
_COMPONENTS = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}


class Glb:
    """Sammelt Puffer, Zugriffe, Knoten, Netze, Kameras und Animationen und schreibt sie als eine GLB-Datei."""

    def __init__(self):
        self.blob = bytearray()
        self.views, self.accessors, self.materials, self.meshes = [], [], [], []
        self.nodes, self.cameras, self.animations = [], [], []

    def accessor(self, arr, kind, target=None, minmax=False):
        """Legt ein Feld ab und gibt die Nummer des Zugriffs zurueck. Indizes (target ELEMENT_ARRAY_BUFFER) als uint32,
        alles andere als float32."""
        arr = np.ascontiguousarray(arr, dtype=np.uint32 if target == ELEMENT_ARRAY_BUFFER else np.float32)
        while len(self.blob) % 4:
            self.blob.append(0)
        view = dict(buffer=0, byteOffset=len(self.blob), byteLength=arr.nbytes)
        if target:
            view["target"] = target
        self.views.append(view)
        self.blob.extend(arr.tobytes())
        n = _COMPONENTS[kind]
        acc = dict(bufferView=len(self.views) - 1, componentType=UINT if arr.dtype == np.uint32 else FLOAT,
                   count=int(arr.size // n), type=kind)
        if minmax and arr.size:
            flat = arr.reshape(-1, n)
            acc["min"] = [float(x) for x in flat.min(axis=0)]
            acc["max"] = [float(x) for x in flat.max(axis=0)]
        self.accessors.append(acc)
        return len(self.accessors) - 1

    def material(self, **m):
        self.materials.append(m)
        return len(self.materials) - 1

    def mesh(self, name, primitives):
        self.meshes.append(dict(name=name, primitives=primitives))
        return len(self.meshes) - 1

    def node(self, **n):
        self.nodes.append(n)
        return len(self.nodes) - 1

    def camera(self, yfov, znear=0.5, zfar=20000.0, aspect=None):
        cam = dict(yfov=float(yfov), znear=float(znear), zfar=float(zfar))
        if aspect:
            cam["aspectRatio"] = float(aspect)
        self.cameras.append(dict(type="perspective", perspective=cam))
        return len(self.cameras) - 1

    def write(self, path, roots, extras=None, scene_extras=None):
        gltf = dict(asset=dict(version="2.0", generator="soma"), scene=0, scenes=[dict(nodes=list(roots))], nodes=self.nodes)
        if scene_extras:
            gltf["scenes"][0]["extras"] = scene_extras
        for key in ("meshes", "materials", "cameras", "animations", "accessors"):
            if getattr(self, key):
                gltf[key] = getattr(self, key)
        if self.views:
            gltf["bufferViews"] = self.views
            gltf["buffers"] = [dict(byteLength=len(self.blob))]
        if extras:
            gltf["extras"] = extras
        js = json.dumps(gltf, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        js += b" " * (-len(js) % 4)
        while len(self.blob) % 4:
            self.blob.append(0)
        total = 12 + 8 + len(js) + (8 + len(self.blob) if self.blob else 0)
        with open(path, "wb") as f:
            f.write(struct.pack("<III", 0x46546C67, 2, total))
            f.write(struct.pack("<II", len(js), 0x4E4F534A))
            f.write(js)
            if self.blob:
                f.write(struct.pack("<II", len(self.blob), 0x004E4942))
                f.write(self.blob)
        return total


def replace(tmp, path, tries=20):
    """Fertige Datei an ihren Platz. Unter Windows schlaegt das fehl, solange ein anderer Prozess die alte gerade liest
    (App und Agent bauen gleichzeitig): kurz warten und noch einmal."""
    import os
    import time
    for i in range(tries):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            if i == tries - 1:
                raise
            time.sleep(0.1)


def read_json(path):
    """Nur den JSON-Teil einer GLB-Datei lesen (Metadaten in extras), ohne die Binaerdaten."""
    with open(path, "rb") as f:
        magic, _version, _total = struct.unpack("<III", f.read(12))
        if magic != 0x46546C67:
            raise ValueError(f"{path} ist keine GLB-Datei")
        length, kind = struct.unpack("<II", f.read(8))
        if kind != 0x4E4F534A:
            raise ValueError(f"{path}: JSON-Teil fehlt")
        return json.loads(f.read(length).decode("utf-8"))
