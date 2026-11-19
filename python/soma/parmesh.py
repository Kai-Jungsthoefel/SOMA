"""Mesh many parts for the viewer, in parallel worker processes when the model is large (issue #16).

OCCT holds the GIL in every call, so threads do not help: the work goes to spawned processes. Each worker gets packets
of parts as binary BREP (BinTools, much faster than the text BREP) and sends back what `mesh_part` gives for each:
the mesh from mesher.mesh_shape plus bounding box and volume, which are expensive for freeform parts too.
Small models stay in the build process, starting the workers (importing cadquery) would cost more than it saves.

The build process keeps working meanwhile (the STEP export runs while the workers mesh), see `MeshJob`.
"""
import io
import os
import queue
import sys
import time
import traceback
import types

from . import mesher
from .progress import Progress

# Below this many faces the model is meshed in the build process. The boat from issue #13 (32,000 faces) needs about
# 6 ms per face, so the threshold is a few seconds of work, about what starting the workers costs
PARALLEL_MIN_FACES = 3000
MAX_WORKERS = 8  # each worker holds cadquery and its packets in memory, more brings little on typical machines
PACKETS_PER_WORKER = 4  # several packets per worker, so one with a few large parts does not hold up the rest


def worker_count(n_faces):
    """Number of workers for a model with `n_faces` faces, 0 for meshing in the build process.
    SOMA_BUILD_WORKERS overrides it (0 or 1: no workers), e.g. for tests or a machine with little memory."""
    env = os.environ.get("SOMA_BUILD_WORKERS", "").strip()
    if env:
        try:
            n = int(env)
        except ValueError:
            n = None
        if n is not None:
            return n if n > 1 else 0
    if n_faces < PARALLEL_MIN_FACES:
        return 0
    return max(0, min(MAX_WORKERS, (os.cpu_count() or 1) - 1))


def _packets(weights, n):
    """Split part indices into about n packets of similar weight, heaviest packets first. Order inside stays as is."""
    total = sum(weights) or 1
    target = total / n
    out, cur, w = [], [], 0
    for i, wt in enumerate(weights):
        cur.append(i)
        w += wt
        if w >= target:
            out.append((w, cur))
            cur, w = [], 0
    if cur:
        out.append((w, cur))
    out.sort(key=lambda x: -x[0])
    return [idx for _, idx in out]


def mesh_part(shape, tol, ang, parallel=True):
    """Mesh, exact bounding box and volume of one part, the expensive per-part work of a build."""
    bb = shape.BoundingBox()
    return dict(mesh=mesher.mesh_shape(shape, tol, ang, parallel=parallel),
                bbox=[[bb.xmin, bb.ymin, bb.zmin], [bb.xmax, bb.ymax, bb.zmax]], volume=shape.Volume())


def _to_bin(shapes):
    import cadquery as cq
    buf = io.BytesIO()
    cq.Compound.makeCompound(list(shapes)).exportBin(buf)
    return buf.getvalue()


def _from_bin(data):
    import cadquery as cq
    from OCP.TopoDS import TopoDS_Iterator
    comp = cq.Shape.importBin(io.BytesIO(data))
    it, shapes = TopoDS_Iterator(comp.wrapped), []
    while it.More():
        shapes.append(cq.Shape.cast(it.Value()))
        it.Next()
    return shapes


def _watch_parent():
    """End this worker when the build process ends. The queue alone does not tell: every worker holds both ends of its
    pipe, so a dead build process never shows as EOF. On Windows the job object (_KillOnClose) does this too. During a
    long OCCT call the thread only gets its turn afterwards, which is fine (it ends one part later)."""
    import multiprocessing as mp
    import threading
    parent = mp.parent_process()
    if parent is None:
        return

    def wait():
        parent.join()
        os._exit(1)
    threading.Thread(target=wait, daemon=True).start()


def _worker(tasks, results, ang):
    """Worker process: mesh packets until the None at the end of the queue. OCCT meshes single-threaded here, the
    workers already use the cores (its own threads on top only compete with them)."""
    _watch_parent()
    try:
        import cadquery  # noqa: F401  (load before the first packet, while the build process still serializes)
        while True:
            task = tasks.get()
            if task is None:
                return
            key, data, tols = task
            try:
                shapes = _from_bin(data)
                results.put((key, [mesh_part(s, t, ang, parallel=False) for s, t in zip(shapes, tols)], None))
            except Exception:  # noqa: BLE001  (reported by the build process, which then meshes this packet itself)
                results.put((key, None, traceback.format_exc()))
    except (KeyboardInterrupt, EOFError, OSError):
        pass


class _KillOnClose:
    """Windows: the app stops a build by ending the build process only (child.kill()). Workers in a job object with
    KILL_ON_JOB_CLOSE end with it, because the job handle closes when the build process ends, however it ends.
    Elsewhere the workers notice the closed pipe. If the job cannot be set up, the build goes on without it."""

    def __init__(self):
        self.job = None
        if os.name != "nt":
            return
        try:
            import ctypes
            from ctypes import wintypes
            k32 = ctypes.WinDLL("kernel32", use_last_error=True)
            k32.CreateJobObjectW.restype = wintypes.HANDLE
            k32.CreateJobObjectW.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
            k32.SetInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD)
            k32.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)

            class BASIC(ctypes.Structure):
                _fields_ = [("PerProcessUserTimeLimit", ctypes.c_int64), ("PerJobUserTimeLimit", ctypes.c_int64),
                            ("LimitFlags", wintypes.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                            ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wintypes.DWORD),
                            ("Affinity", ctypes.c_size_t), ("PriorityClass", wintypes.DWORD),
                            ("SchedulingClass", wintypes.DWORD)]

            class IO(ctypes.Structure):
                _fields_ = [(n, ctypes.c_uint64) for n in ("r", "w", "o", "rb", "wb", "ob")]

            class EXTENDED(ctypes.Structure):
                _fields_ = [("Basic", BASIC), ("Io", IO), ("ProcessMemoryLimit", ctypes.c_size_t),
                            ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
                            ("PeakJobMemoryUsed", ctypes.c_size_t)]

            job = k32.CreateJobObjectW(None, None)
            if not job:
                return
            info = EXTENDED()
            info.Basic.LimitFlags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if not k32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):  # ExtendedLimitInformation
                k32.CloseHandle(job)
                return
            self.k32, self.job = k32, job
        except Exception:  # noqa: BLE001
            self.job = None

    def add(self, proc):
        if self.job:
            try:
                self.k32.AssignProcessToJobObject(self.job, proc.sentinel)  # on Windows the sentinel is the process handle
            except Exception:  # noqa: BLE001
                pass

    def close(self):
        if self.job:
            try:
                self.k32.CloseHandle(self.job)
            except Exception:  # noqa: BLE001
                pass
            self.job = None


class MeshJob:
    """Meshes `shapes` with `mesh_part`, each with its own tolerance from `tols`. With workers, start() hands the
    packets out and returns at once, result() waits for them. Without workers result() meshes in the build process. The
    result is the same either way: one dict from mesh_part per shape in the given order. A packet a worker could not mesh (crash, error) is meshed here instead,
    so the build only fails where the sequential build would have failed too."""

    def __init__(self, shapes, tols, ang=0.3, workers=None):
        self.shapes, self.tols, self.ang = list(shapes), list(tols), ang
        self.weights = [len(s.Faces()) + 1 for s in self.shapes]
        self.n = worker_count(sum(self.weights)) if workers is None else workers
        self.procs, self.packets, self.notes = [], [], []
        self.job = None

    def start(self):
        if self.n < 2 or len(self.shapes) < 2:
            self.n = 0
            return self
        try:
            import multiprocessing as mp
            ctx = mp.get_context("spawn")
            self.tasks, self.results = ctx.Queue(), ctx.Queue()
            self.job = _KillOnClose()
            # Start the workers first: they import cadquery (a few seconds) while the packets are being serialized.
            # A spawned process runs the main script of its parent again, unless it is guarded by __name__ == "__main__".
            # A script that calls run_build() without that guard would build in every worker, so the workers see an
            # empty main module (only soma.parmesh._worker is needed there)
            main = sys.modules.get("__main__")
            sys.modules["__main__"] = types.ModuleType("__main__")
            try:
                for _ in range(self.n):
                    p = ctx.Process(target=_worker, args=(self.tasks, self.results, self.ang), daemon=True)
                    p.start()
                    self.job.add(p)
                    self.procs.append(p)
            finally:
                if main is not None:
                    sys.modules["__main__"] = main
            self.packets = _packets(self.weights, self.n * PACKETS_PER_WORKER)
            for key, idx in enumerate(self.packets):
                self.tasks.put((key, _to_bin(self.shapes[i] for i in idx), [self.tols[i] for i in idx]))
            for _ in self.procs:
                self.tasks.put(None)
        except Exception as e:  # noqa: BLE001  (no workers: mesh everything here, as before)
            self.notes.append(f"Parallel meshing unavailable ({type(e).__name__}: {e}), meshed in one process.")
            self._stop()
            self.n, self.packets = 0, []
        return self

    def result(self):
        meshes = [None] * len(self.shapes)
        # Counted in faces, not parts: packets come back in very different sizes
        progress = Progress("Meshing for the viewer", sum(self.weights), "faces")
        if self.n:
            self._collect(meshes, progress)
        for i, m in enumerate(meshes):  # sequential, or what the workers left over
            if m is None:
                meshes[i] = mesh_part(self.shapes[i], self.tols[i], self.ang)
                progress.step(self.weights[i])
        progress.finish()
        return meshes

    def _collect(self, meshes, progress):
        open_keys = set(range(len(self.packets)))
        try:
            while open_keys:
                try:
                    key, got, err = self.results.get(timeout=0.5)
                except queue.Empty:
                    if not any(p.is_alive() for p in self.procs):
                        try:  # a last result may still be in the pipe
                            key, got, err = self.results.get(timeout=1)
                        except queue.Empty:
                            self.notes.append("Meshing workers ended early, the rest was meshed in one process.")
                            return
                    else:
                        continue
                open_keys.discard(key)
                if err:
                    print(f"Meshing a packet in a worker failed, meshing it here:\n{err}", file=sys.stderr, flush=True)
                    continue
                for i, m in zip(self.packets[key], got):
                    meshes[i] = m
                progress.step(sum(self.weights[i] for i in self.packets[key]))
        finally:
            self._stop()

    def close(self):
        """End the workers if they still run (the build failed before result()). Safe to call more than once."""
        self._stop()

    def _stop(self):
        for p in self.procs:
            p.join(timeout=2)
            if p.is_alive():
                p.kill()
        for q in (getattr(self, "tasks", None), getattr(self, "results", None)):
            if q is not None:
                q.cancel_join_thread()
                q.close()
        if self.job:
            self.job.close()
        self.procs = []
