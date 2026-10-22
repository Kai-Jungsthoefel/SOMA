"""CalculiX (ccx) als Rechenwerk der FEM (E84).

`soma.fem` vernetzt, baut die Knotenlasten und prueft selbst. Dieses Modul schreibt daraus eine Eingabedatei fuer ccx,
rechnet in einem eigenen Ordner und liest Verschiebungen (aus der .dat, 7 Stellen; die frd hat nur 5, daraus
nachgerechnete Lagerkraefte hatten 0.004 N Querkraft am Kragbalken) und Kontaktgroessen (aus der frd) zurueck. Die Spannungen
rechnet `fem.py` aus den Verschiebungen selbst (je Teil, CalculiX mittelt ueber Werkstoffgrenzen hinweg).

Gefunden wird ccx in dieser Reihenfolge: SOMA_CCX (Pfad zum Programm), mitgeliefert neben der Python-Umgebung
(<sys.prefix>/ccx/ccx.exe unter Windows, <sys.prefix>/ccx/bin/ccx sonst, geholt mit python/scripts/fetch_ccx.py; aus der
Projektumgebung heraus neben deren Basis), dann `ccx` im PATH.

Robustheit: ccx bricht bei einem Teil, das wegrutscht oder abhebt, nicht von selbst ab, sondern rechnet minutenlang
weiter (die Verschiebungen wachsen auf 1e11 mm). Die Ausgabe wird deshalb mitgelesen und die Rechnung abgebrochen,
sobald eine Verschiebung ein Vielfaches der Modellgroesse erreicht oder die Schritte zu klein werden.
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import numpy as np


class CcxError(Exception):
    """Fehler beim Rechnen. `kind`: missing, failed, diverged (ein Teil fliegt weg), chatter (Kontakt pendelt zwischen
    offen und geschlossen), increments (Schritte zu klein oder zu viele)."""

    def __init__(self, message, kind="failed", log=""):
        super().__init__(message)
        self.kind = kind
        self.log = log


# Kanten wie in gmsh (fem.EDGES): (0,1) (1,2) (2,0) (3,0) (3,2) (3,1). CalculiX/Abaqus: 1-2 2-3 3-1 1-4 2-4 3-4
NODE_ORDER = [0, 1, 2, 3, 4, 5, 6, 7, 9, 8]
# Flaeche k von fem (gegenueber Ecke k) -> Flaechennummer S1..S4 von C3D10 (S1 = 1-2-3, S2 = 1-4-2, S3 = 2-4-3, S4 = 3-4-1)
FACE_S = {0: 3, 1: 4, 2: 2, 3: 1}

_found = {}


def find():
    """Pfad zu ccx oder None."""
    if "exe" in _found:
        return _found["exe"]
    cands = []
    if os.environ.get("SOMA_CCX"):
        cands.append(Path(os.environ["SOMA_CCX"]))
    for prefix in [Path(sys.prefix)] + _base_prefixes():
        base = prefix / "ccx"
        cands += [base / "ccx.exe", base / "bin" / "ccx"] if sys.platform == "win32" else [base / "bin" / "ccx", base / "ccx"]
    w = shutil.which("ccx")
    if w:
        cands.append(Path(w))
    exe = next((c for c in cands if c.is_file()), None)
    _found["exe"] = exe
    return exe


def _base_prefixes():
    """Ordner der Basisumgebung, wenn soma aus der Projektumgebung (.soma/env, E67) laeuft. So rufen Agent-Apps ausserhalb
    des SOMA-Terminals soma auf; sys.prefix ist dann die Projektumgebung, ccx liegt aber neben der Basis. Deren Python steht
    in soma-env.json. venv: <prefix>/Scripts/python.exe bzw. bin/python, eigenstaendiges Python unter Windows: <prefix>/python.exe."""
    try:
        import json
        info = json.loads((Path(sys.prefix) / "soma-env.json").read_text(encoding="utf-8"))
        exe = Path(info["base_python"])
    except (OSError, ValueError, KeyError, TypeError):
        return []
    return [exe.parent.parent, exe.parent]


def version(exe=None):
    """Version als Text ("2.23") oder None, wenn ccx fehlt oder nicht startet."""
    exe = exe or find()
    if exe is None:
        return None
    if ("version", exe) in _found:
        return _found[("version", exe)]
    v = None
    try:
        p = subprocess.run([str(exe), "-v"], capture_output=True, text=True, errors="replace", timeout=30, env=_env(exe, 1),
                           creationflags=_NO_WINDOW)
        m = re.search(r"Version\s+([0-9][0-9.]*)", p.stdout + p.stderr)
        v = m.group(1) if m else None
    except (OSError, subprocess.SubprocessError):
        v = None
    _found[("version", exe)] = v
    return v


_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0


def threads():
    # Logische Kerne halbe: Hyperthreading bringt SPOOLES nichts, und die App soll bedienbar bleiben
    return max(1, min(8, (os.cpu_count() or 2) // 2))


def _env(exe, n):
    if sys.platform == "win32":
        # Nur der eigene Ordner und System32: keine fremden DLLs gleichen Namens (libgfortran, openblas) aus dem PATH
        root = os.environ.get("SystemRoot", r"C:\Windows")
        env = {"SystemRoot": root, "PATH": f"{Path(exe).parent};{root}\\System32",
               "TEMP": tempfile.gettempdir(), "TMP": tempfile.gettempdir()}
    else:
        env = dict(os.environ)
    env.update(OMP_NUM_THREADS=str(n), CCX_NPROC_EQUATION_SOLVER=str(n), CCX_NPROC_RESULTS=str(n), CCX_NPROC_STIFFNESS=str(n))
    return env


# ---- Eingabe ------------------------------------------------------------------------------------------------------

def _savetxt(o, rows, fmt):
    if len(rows):
        np.savetxt(o, rows, fmt=fmt)


def write_input(path, nodes, tets, epart, mats, f, fixed, contacts=(), nonlinear=False, law="linear", bolts=()):
    """Eingabedatei. contacts: dict(slave=[(el, k)], master=[(el, k)], friction, stiffness, stick, c0, p0).
    bolts: dict(pairs=(m, 2) Knoten Kopfseite/Spitzenseite, point, normal, preload) je Schraube, siehe unten.

    law "linear": Druck = Steifigkeit mal Ueberschneidung, genau, aber bei Flaechen, die mit Spalt 0 beginnen und sich
    teilweise trennen, pendelt die Rechnung (zwei Platten, die abheben: ueber 40 Iterationen ohne Ende).
    law "exponential": weich einsetzender Druck schon ab dem Spalt c0 (bei Spalt 0 der Druck p0), konvergiert dort in
    5 Iterationen, glaettet aber Pressungsspitzen und laesst die Teile um etwa c0 einsinken."""
    with open(path, "w", newline="\n", encoding="ascii") as o:
        o.write("*HEADING\nsoma fem\n*NODE, NSET=NALL\n")
        _savetxt(o, np.column_stack([np.arange(1, len(nodes) + 1), nodes]), "%d,%.10g,%.10g,%.10g")
        t = tets[:, NODE_ORDER] + 1
        for p in range(len(mats)):
            sel = np.nonzero(epart == p)[0]
            if not len(sel):
                continue
            o.write(f"*ELEMENT, TYPE=C3D10, ELSET=P{p}\n")
            _savetxt(o, np.column_stack([sel + 1, t[sel]]), "%d," * 10 + "%d")
        for p, m in enumerate(mats):
            if not (epart == p).any():
                continue
            o.write(f"*MATERIAL, NAME=M{p}\n*ELASTIC\n{float(m['E']):.10g},{float(m['nu']):.10g}\n"
                    f"*SOLID SECTION, ELSET=P{p}, MATERIAL=M{p}\n")
        for k, c in enumerate(contacts):
            for side in ("slave", "master"):
                o.write(f"*SURFACE, NAME=C{k}{side[0].upper()}, TYPE=ELEMENT\n")
                _savetxt(o, np.array([(e + 1, FACE_S[int(fk)]) for e, fk in c[side]]), "%d,S%d")
            if law == "exponential":
                o.write(f"*SURFACE INTERACTION, NAME=I{k}\n*SURFACE BEHAVIOR, PRESSURE-OVERCLOSURE=EXPONENTIAL\n"
                        f"{c['c0']:.6g},{c['p0']:.6g}\n")
            else:
                o.write(f"*SURFACE INTERACTION, NAME=I{k}\n*SURFACE BEHAVIOR, PRESSURE-OVERCLOSURE=LINEAR\n{c['stiffness']:.6g}\n")
            if c.get("friction"):
                # Haftsteigung: steif genug fuer "haftet", weich genug fuer Konvergenz (zehnmal steifer verdoppelte die Iterationen)
                o.write(f"*FRICTION\n{c['friction']:.6g},{c['stick']:.6g}\n")
            o.write(f"*CONTACT PAIR, INTERACTION=I{k}, TYPE=SURFACE TO SURFACE\nC{k}S,C{k}M\n")
        # Schrauben: ein Vorspannschnitt quer durch den Schaft. soma.fem hat die Knoten dort schon verdoppelt (pairs: Kopfseite,
        # Spitzenseite). Je Paar drei Gleichungen: Die Spitzenseite folgt der Kopfseite, nur entlang der Normale um die
        # Verschiebung eines eigenen Knotens versetzt (wie *PRE-TENSION SECTION, aber mit Knoten, die soma kennt: Die
        # Spannungen rechnet soma selbst aus den Verschiebungen beider Seiten). Schritt 1 zieht diesen Knoten mit der
        # Vorspannkraft, Schritt 2 haelt ihn fest und bringt die Lasten auf: Seine Lagerkraft ist dann die Schraubenkraft
        pre = [len(nodes) + 1 + i for i in range(len(bolts))]
        for i, b in enumerate(bolts):
            o.write(f"*NODE, NSET=B{i}\n{pre[i]},{b['point'][0]:.10g},{b['point'][1]:.10g},{b['point'][2]:.10g}\n*EQUATION\n")
            for a, t in np.asarray(b["pairs"]) + 1:
                for j in range(3):
                    nj = float(b["normal"][j])
                    if abs(nj) > 1e-12:
                        o.write(f"3\n{t},{j + 1},1,{a},{j + 1},-1,{pre[i]},1,{-nj:.12g}\n")
                    else:
                        o.write(f"2\n{t},{j + 1},1,{a},{j + 1},-1\n")
        if bolts:
            o.write("*NSET, NSET=BOLTS\n" + "\n".join(str(n) for n in pre) + "\n")
        if contacts:
            o.write("*NSET, NSET=FIXED\n")
            _savetxt(o, np.unique(np.nonzero(fixed)[0] // 3) + 1, "%d")
        # Zeitschritte nur mit Kontakt: die ganze Last auf einmal (CalculiX teilt selbst, wenn es nicht konvergiert; mit
        # Viertelschritten brauchte ein Block auf einem Block 18 statt 5 Iterationen), kleinster Schritt 1/1000 (darunter ist
        # es kein Rechenproblem mehr, sondern ein Teil, das nicht haelt), hoechstens 200 Schritte
        static = "*STEP, INC=200\n*STATIC\n" + ("1,1,0.001,1\n" if nonlinear else "")
        o.write(static)
        fd = np.nonzero(fixed)[0]
        if len(fd):
            o.write("*BOUNDARY\n")
            _savetxt(o, np.column_stack([fd // 3 + 1, fd % 3 + 1, fd % 3 + 1]), "%d,%d,%d")
        if bolts:
            o.write("*CLOAD\n" + "".join(f"{n},1,{b['preload']:.10g}\n" for n, b in zip(pre, bolts)))
            o.write("*NODE PRINT, NSET=BOLTS\nRF\n*END STEP\n" + static + "*BOUNDARY, FIXED\n"
                    + "".join(f"{n},1,1\n" for n in pre) + "*CLOAD, OP=NEW\n")
        ld = np.nonzero(f)[0]
        if len(ld):
            o.write("" if bolts else "*CLOAD\n")
            _savetxt(o, np.column_stack([ld // 3 + 1, ld % 3 + 1, f[ld]]), "%d,%d,%.12g")
        elif bolts:
            o.write("1,1,0\n")  # OP=NEW braucht eine Zeile: nur die Vorspannung, keine Last
        if bolts:
            o.write("*NODE PRINT, NSET=BOLTS\nRF\n")
        # Nur der letzte Schritt interessiert: FREQUENCY gross, das Ende des Steps schreibt CalculiX immer. Keine
        # Knotenkraefte (RF): Sie wichen um 5 % vom Gleichgewicht ab, die Lagerkraefte rechnet fem.py selbst
        o.write("*NODE PRINT, NSET=NALL, FREQUENCY=1000\nU\n")
        if contacts:
            o.write("*CONTACT FILE, FREQUENCY=1000\nCDIS,CSTR\n")
            # Mit Kontakt die Knotenkraefte an den Lagern von CalculiX: Drueckt ein Kontakt auf eine Kante der gehaltenen
            # Flaeche, fehlt seine Kraft in den Elementkraeften, die fem.py sonst nimmt (Durchsteckschraube: 56 % daneben)
            o.write("*NODE PRINT, NSET=FIXED\nRF\n")
        o.write("*END STEP\n")


# ---- Rechnen ------------------------------------------------------------------------------------------------------

def run(nodes, tets, epart, mats, f, fixed, contacts=(), size=1.0, progress=None, law="linear", bolts=()):
    """Rechnet und liefert dict(u (n, 3), contact (n, 6) oder None, rf (n, 3) Knotenkraefte, nur mit Kontakt, bolts (Kraefte am Vorspannknoten je Schraube am
    Ende, (n, 3) in N, nur x zaehlt) oder None, increments, seconds, threads, version).

    size: Modellgroesse in mm, fuer die Ueberwachung. progress: Rueckruf mit dem Anteil der Lastschritte (0..1).
    law: Kontaktgesetz (siehe write_input)."""
    exe = find()
    if exe is None:
        raise CcxError("CalculiX (ccx) was not found", "missing")
    n_thr = threads()
    nonlinear = bool(contacts)
    steps = 2 if bolts else 1
    tmp = Path(tempfile.mkdtemp(prefix="soma-ccx-"))
    t0 = time.perf_counter()
    try:
        write_input(tmp / "job.inp", nodes, tets, epart, mats, f, fixed, contacts, nonlinear, law, bolts)
        log, increments = _execute(exe, tmp, n_thr, size, progress, steps)
        u = read_dat(tmp / "job.dat", len(nodes)) if (tmp / "job.dat").is_file() else None
        if u is None:
            raise CcxError("CalculiX wrote no displacements. " + _errors(log), "failed", log)
        blocks = read_frd(tmp / "job.frd", len(nodes)) if contacts and (tmp / "job.frd").is_file() else {}
        if contacts and "CONTACT" not in blocks:
            raise CcxError("CalculiX wrote no contact results. " + _errors(log), "failed", log)
        if not np.isfinite(u).all():
            raise CcxError("CalculiX gave no numbers (supports insufficient?)", "failed", log)
        forces = read_forces(tmp / "job.dat", "BOLTS", [len(nodes) + 1 + i for i in range(len(bolts))]) if bolts else None
        if bolts and forces is None:
            raise CcxError("CalculiX wrote no bolt forces. " + _errors(log), "failed", log)
        held = np.unique(np.nonzero(fixed)[0] // 3)
        rf = read_forces(tmp / "job.dat", "FIXED", list(held + 1)) if contacts else None
        if rf is not None:
            full = np.zeros((len(nodes), 3))
            full[held] = rf
            rf = full
        return dict(u=u, contact=blocks.get("CONTACT") if contacts else None, bolts=forces, rf=rf, increments=increments,
                    seconds=time.perf_counter() - t0, threads=n_thr, version=version(exe))
    finally:
        if os.environ.get("SOMA_CCX_KEEP"):  # zur Fehlersuche: Eingabe, Ausgabe und Protokoll bleiben liegen
            print(f"CalculiX files kept in {tmp}", file=sys.stderr)
        else:
            shutil.rmtree(tmp, ignore_errors=True)


def _errors(log):
    errs = []
    lines = log.splitlines()
    for i, line in enumerate(lines):
        if "*ERROR" in line:
            errs.append(" ".join(x.strip() for x in lines[i:i + 3] if x.strip()))
    return ("Messages: " + " | ".join(dict.fromkeys(errs))[:600]) if errs else ""


# Iterationen je Laststufe und insgesamt, ab denen die Rechnung als pendelnd gilt (dann rechnet fem.py mit dem weichen
# Gesetz). Wenn sich die Beruehrflaeche erst finden muss, gibt CalculiX sie Iteration fuer Iteration frei: Eine Platte, die
# zur Haelfte abhebt, brauchte 11 bis 18, eine, die fast ganz abhebt, 88 (das weiche Gesetz dort 4). Mit 12 brach SOMA
# die erste ab und das weiche Gesetz drueckte die Teile auseinander
MAX_ITERATIONS = 30
MAX_TOTAL_ITERATIONS = 60


def _execute(exe, tmp, n_thr, size, progress, steps=1):
    """Startet ccx, liest die Ausgabe mit und bricht bei Divergenz ab. Liefert (Ausgabe, Zahl der Lastschritte).
    steps: Zahl der Rechenschritte (*STEP) fuer den Fortschritt. Die Grenzen fuer Iterationen gelten je Schritt."""
    p = subprocess.Popen([str(exe), "-i", "job"], cwd=tmp, env=_env(exe, n_thr), stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL, creationflags=_NO_WINDOW)
    lines = []
    state = dict(reason=None, increments=0, done=0.0, size=None, iters=0, total=0, step=1)
    limit = 10.0 * max(size, 1.0)

    def stop(reason):
        if state["reason"] is None:
            state["reason"] = reason
            p.kill()

    def reader():
        for raw in iter(p.stdout.readline, b""):
            line = raw.decode("latin-1", "replace").rstrip()
            lines.append(line)
            if line.startswith(" STEP "):
                try:
                    state.update(step=int(line.split()[1]), done=0.0, total=0)
                except (IndexError, ValueError):
                    pass
            elif " attempt " in line and line.lstrip().startswith("increment"):
                state["iters"] = 0
            elif line.startswith(" increment size="):
                try:
                    state["size"] = float(line.split("=")[1])
                except ValueError:
                    pass
            elif line.startswith(" sum of previous increments="):
                try:
                    state["done"] = float(line.split("=")[1])
                except ValueError:
                    pass
            elif line.startswith(" convergence") or line.startswith(" convergence;"):
                state["increments"] += 1
                if state["size"] is not None:
                    state["done"] += state["size"]
                if progress:
                    progress(min(1.0, (state["step"] - 1 + min(1.0, state["done"])) / steps))
            elif line.startswith(" largest increment of disp="):
                try:
                    d = float(line.split("=")[1])
                except ValueError:
                    continue
                state["iters"] += 1
                state["total"] += 1
                if not d < limit:
                    stop("diverged")
                elif state["iters"] > MAX_ITERATIONS or state["total"] > MAX_TOTAL_ITERATIONS:
                    # Eine Laststufe, die so lange nicht konvergiert, pendelt (Kontakt springt zwischen offen und zu)
                    stop("chatter")

    th = threading.Thread(target=reader, daemon=True)
    th.start()
    p.wait()
    th.join(timeout=10)
    log = "\n".join(lines)
    if os.environ.get("SOMA_CCX_KEEP"):
        (tmp / "job.log").write_text(log, encoding="utf-8")
    if state["reason"] == "chatter":
        raise CcxError(f"The contact does not settle (more than {MAX_ITERATIONS} iterations in one load step).", "chatter", log)
    if state["reason"] == "diverged":
        raise CcxError("A part moves without limit: it is not held, or a contact cannot carry the load (it slides or lifts off).",
                       "diverged", log)
    if "increment size smaller than minimum" in log or "too many attempts" in log.lower():
        raise CcxError("The contact calculation does not converge (the load steps became too small).", "increments", log)
    if "maximum number of increments" in log.lower() or "the maximum number of increments" in log:
        raise CcxError("The contact calculation needs more than 200 load steps.", "increments", log)
    if p.returncode not in (0, None) and not (tmp / "job.frd").is_file():
        raise CcxError(f"CalculiX stopped (exit code {p.returncode}). " + _errors(log), "failed", log)
    if "*ERROR" in log and not (tmp / "job.frd").is_file():
        raise CcxError("CalculiX reported an error. " + _errors(log), "failed", log)
    return log, state["increments"]


# ---- Ergebnis -----------------------------------------------------------------------------------------------------

def read_dat(path, n):
    """Verschiebungen aus der .dat (letzter Block "displacements (vx,vy,vz) for set NALL"): (n, 3) oder None."""
    lines = Path(path).read_text(encoding="latin-1").splitlines()
    starts = [i for i, line in enumerate(lines) if line.lstrip().startswith("displacements (vx,vy,vz) for set NALL")]
    if not starts:
        return None
    u = np.zeros((n, 3))
    for line in lines[starts[-1] + 1:]:
        parts = line.split()
        if not parts:
            continue
        if len(parts) != 4 or not parts[0].isdigit():
            break
        node = int(parts[0])
        if 0 < node <= n:
            u[node - 1] = [float(x) for x in parts[1:]]
    return u


def read_forces(path, nset, ids):
    """Knotenkraefte aus dem letzten Block "forces (fx,fy,fz) for set <nset>" der .dat: (len(ids), 3) oder None."""
    lines = Path(path).read_text(encoding="latin-1").splitlines()
    starts = [i for i, line in enumerate(lines) if line.lstrip().startswith(f"forces (fx,fy,fz) for set {nset.upper()} ")]
    if not starts:
        return None
    pos = {n: k for k, n in enumerate(ids)}
    out = np.full((len(ids), 3), np.nan)
    for line in lines[starts[-1] + 1:]:
        parts = line.split()
        if not parts:
            continue
        if len(parts) != 4 or not parts[0].isdigit():
            break
        if int(parts[0]) in pos:
            out[pos[int(parts[0])]] = [float(x) for x in parts[1:]]
    return None if np.isnan(out).any() else out


def read_frd(path, n):
    """Liest die Knotenbloecke einer ASCII-frd. Je Blockname der letzte (spaetester Lastschritt): (n, Werte)."""
    out = {}
    cur = None
    width = None
    with open(path, "r", encoding="latin-1") as fh:
        for line in fh:
            if line.startswith(" -4"):
                parts = line.split()
                name, ncomp = parts[1], int(parts[2])
                cur = np.zeros((n, max(ncomp, 1)))
                out[name] = cur
                width = None
                continue
            if cur is None:
                continue
            if line.startswith(" -1"):
                rest = line[3:].rstrip("\r\n")
                if width is None:
                    width = 10 if (len(rest) - 10) % 12 == 0 else 5
                node = int(rest[:width])
                k = (len(rest) - width) // 12
                if 0 < node <= n:
                    vals = [float(rest[width + 12 * i:width + 12 * (i + 1)]) for i in range(min(k, cur.shape[1]))]
                    cur[node - 1, :len(vals)] = vals
            elif line.startswith(" -3"):
                cur = None
    return out
