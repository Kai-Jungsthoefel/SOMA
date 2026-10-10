"""Baut die mitgelieferte Python-Basisumgebung fuer die Auslieferung (PLAN.md, Abschnitt 8).

    python python/scripts/build_runtime.py                      # nach app/python-runtime, fuer dieses System
    python python/scripts/build_runtime.py --target <ordner>

Eigenstaendiges Python (python-build-standalone, geholt mit uv) statt venv: Eine venv verweist mit absolutem Pfad auf ihr
Basis-Python und laesst sich nicht verschieben, die App liegt aber dort, wo der Nutzer sie installiert. Darin landen die
Pakete aus requirements-base.txt, soma (nicht editierbar) und CalculiX (fetch_ccx.py). electron-builder legt den Ordner
als resources/python neben die App (app/electron-builder.yml), paths.ts findet ihn dort.

Wheels sind je Betriebssystem verschieden: Gebaut wird immer fuer das laufende System (in der CI je eines).
Voraussetzung: uv im PATH.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# Feste Python-Version der Auslieferung. Muss uv kennen (`uv python list --only-downloads`), in der CI ist uv gepinnt.
PYTHON = "3.12.15"
ROOT = Path(__file__).resolve().parents[2]
WIN = sys.platform == "win32"


def run(*cmd, **kw):
    print(">", " ".join(str(c) for c in cmd), flush=True)
    subprocess.run([str(c) for c in cmd], check=True, **kw)


def python_exe(rt):
    return rt / "python.exe" if WIN else rt / "bin" / "python3"


def install_python(target):
    """python-build-standalone ueber uv in einen leeren Ordner, dann als `target` verschieben."""
    tmp = Path(tempfile.mkdtemp(prefix="soma-runtime-", dir=target.parent))
    try:
        # --no-bin/--no-registry: nichts ausserhalb des Ordners anlegen (kein python3.12 im PATH, kein Eintrag in der Registry)
        run("uv", "python", "install", PYTHON, "--install-dir", tmp, "--no-bin", *(["--no-registry"] if WIN else []))
        # Neben der Installation legt uv Verweise auf die Unterversion an (cpython-3.12-…), die zaehlen nicht
        found = [d for d in tmp.iterdir() if d.name.startswith(f"cpython-{PYTHON}-") and not d.is_symlink()]
        if len(found) != 1:
            sys.exit(f"Unexpected uv layout in {tmp}: {[d.name for d in tmp.iterdir()]}")
        shutil.move(str(found[0]), str(target))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def console_scripts(rt):
    """Startprogramme (Name -> "modul:funktion") aller installierten Pakete laut entry_points.txt."""
    code = ("import importlib.metadata as m, json; "
            "print(json.dumps({e.name: e.value for e in m.entry_points(group='console_scripts')}))")
    return json.loads(subprocess.run([str(python_exe(rt)), "-I", "-c", code], check=True, capture_output=True, text=True).stdout)


# Startprogramme mit relativem Pfad zum Python. pip und uv schreiben den absoluten Pfad des Bau-Rechners hinein
# (Windows: in die .exe, sonst in die Shebang-Zeile), nach der Installation woanders liefen sie ins Leere.
SH_WIN = '#!/bin/sh\nexec "$(dirname -- "$0")/../python.exe" {args} "$@"\n'
CMD_WIN = '@"%~dp0..\\python.exe" {args} %*\r\n'
# Wie die verschiebbaren Startprogramme von uv: sh startet Python mit dieser Datei als Skript, Python liest die zweite
# Zeile als Zeichenkette und dann das eigentliche Skript
SH_UNIX = "#!/bin/sh\n'''exec' \"$(dirname -- \"$(realpath -- \"$0\")\")/python3\" \"$0\" \"$@\"\n' '''\n"


def write_launchers_windows(rt):
    """Ersetzt die .exe-Startprogramme der console_scripts durch .cmd (PowerShell, cmd) und eine Datei ohne Endung (Git Bash,
    dort laufen etwa die Befehle von Claude Code). Skripte, die Pakete als Datei mitbringen (numba, gmsh.bat), bleiben:
    Sie gehoeren nicht zur Bedienung."""
    bindir = rt / "Scripts"
    scripts = console_scripts(rt)
    for name, value in sorted(scripts.items()):
        mod, _, func = value.partition(":")
        mod, func = mod.strip(), func.split("[")[0].strip()
        if not re.fullmatch(r"[\w.]+", mod) or not re.fullmatch(r"[\w.]+", func):
            print(f"  skipped {name} ({value})")
            continue
        (bindir / f"{name}.exe").unlink(missing_ok=True)
        top = mod.split(".")[0]
        # pip und soma ueber -m (Paket mit __main__, sys.argv[0] stimmt), alle anderen ueber einen kurzen Aufruf
        if top in ("pip", "soma"):
            cmd = sh = f"-m {top}"
        else:
            cmd = f'-c "import sys; from {mod} import {func}; sys.exit({func}())"'
            sh = f"-c 'import sys; from {mod} import {func}; sys.exit({func}())'"
        (bindir / f"{name}.cmd").write_bytes(CMD_WIN.format(args=cmd).encode())
        (bindir / name).write_bytes(SH_WIN.format(args=sh).encode())
    print(f"{len(scripts)} launchers in {bindir}")


def write_launchers_unix(rt):
    """Shebang aller Python-Skripte in bin/ auf das Python daneben umschreiben (console_scripts und Skripte aus Paketen)."""
    bindir, n = rt / "bin", 0
    for p in sorted(bindir.iterdir()):
        if p.is_symlink() or not p.is_file():
            continue
        first, _, rest = p.read_bytes().partition(b"\n")
        if not first.startswith(b"#!") or b"python" not in first:
            continue
        p.write_bytes(SH_UNIX.encode() + rest)
        p.chmod(0o755)
        n += 1
    print(f"{n} launchers in {bindir}")


# libgmsh aus dem Wheel von gmsh braucht unter Linux Bibliotheken des Systems. libGL, libX11, GTK 3 usw. hat jeder
# Desktop, auf dem Electron laeuft. Diese hier fehlen dagegen oft (auch auf den Runnern der CI): Sie kommen neben
# libgmsh nach lib/, dort sucht es zuerst (RUNPATH $ORIGIN/../lib). Lizenzen: SGI Free B (libGLU), MIT (die uebrigen).
LINUX_BUNDLE = ["libGLU.so.1", "libXft.so.2", "libXinerama.so.1", "libXcursor.so.1"]


def bundle_linux_libs(rt):
    cache = subprocess.run(["ldconfig", "-p"], check=True, capture_output=True, text=True).stdout
    for soname in LINUX_BUNDLE:
        m = re.search(rf"^\s*{re.escape(soname)} \(libc6,x86-64[^)]*\) => (\S+)$", cache, re.M)
        if not m:
            sys.exit(f"{soname} not found on this system. Install it first (Ubuntu: libglu1-mesa libxft2 libxinerama1 libxcursor1).")
        src = Path(m.group(1)).resolve()
        shutil.copy2(src, rt / "lib" / soname)
        print(f"  bundled {soname} from {src}")


def check(rt):
    """Laeuft die Umgebung von einem anderen Ort aus? Kopie in einen Ordner mit Leerzeichen, dort soma und Basispakete."""
    with tempfile.TemporaryDirectory(prefix="soma check ") as tmp:
        moved = Path(tmp) / "py rt"
        shutil.copytree(rt, moved, symlinks=True)
        py = python_exe(moved)
        if sys.platform.startswith("linux"):
            # Alles, was libgmsh braucht, muss sich aufloesen lassen, die mitgelieferten aus dem verschobenen Ordner
            libgmsh = next((moved / "lib").glob("libgmsh.so*"))
            ldd = subprocess.run(["ldd", str(libgmsh)], check=True, capture_output=True, text=True).stdout
            print(ldd)
            if "not found" in ldd or any(f"{s} => {moved / 'lib'}" not in ldd for s in LINUX_BUNDLE):
                sys.exit(f"Libraries of {libgmsh.name} do not resolve to the runtime (see ldd above)")
        run(py, "-I", "-c", "import cadquery, OCP, vtk, gmsh, numpy, scipy, ezdxf, pdfplumber, soma, soma.ccx as c; "
                            "print('cadquery', cadquery.__version__, '| soma', soma.__version__, '| ccx', c.version())")
        # Startprogramme ueber den PATH wie im Terminal der App, die Ausgabe muss vom verschobenen Ordner kommen
        bindir = moved / ("Scripts" if WIN else "bin")
        env = dict(os.environ, PATH=str(bindir) + os.pathsep + os.environ.get("PATH", ""))
        for name, expect in (("soma", "soma "), ("pip", str(moved))):
            exe = shutil.which(name, path=str(bindir))
            out = subprocess.run([exe, "--version"], env=env, capture_output=True, text=True).stdout if exe else ""
            print(f"{name} --version: {out.strip()}")
            if expect not in out:
                sys.exit(f"Launcher {name} does not work from {bindir}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--target", default=str(ROOT / "app" / "python-runtime"))
    ap.add_argument("--skip-ccx", action="store_true", help="without CalculiX (FEM falls back to the own solver)")
    args = ap.parse_args()
    target = Path(args.target).resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        # Nichts still loeschen: der vorige Stand bleibt als .old, bis zum naechsten Lauf
        old = target.with_name(target.name + ".old")
        shutil.rmtree(old, ignore_errors=True)
        target.rename(old)
        print(f"Previous runtime moved to {old}")

    install_python(target)
    py = python_exe(target)
    # Basis wie in der Entwicklung, dazu soma als normales Paket. EXTERNALLY-MANAGED von python-build-standalone
    # bleibt: Es schuetzt die Basis zur Laufzeit vor pip, Zusatzpakete gehen in die Projektumgebung (E67).
    uvpip = ["uv", "pip", "install", "--python", py, "--break-system-packages", "--link-mode=copy", "--compile-bytecode"]
    run(*uvpip, "-r", ROOT / "python" / "requirements-base.txt")
    # setuptools baut in python/build/. Ein alter Stand dort braechte geloeschte Module mit ins Paket, also vorher und
    # nachher weg (nur dieser Zwischenordner, sonst nichts)
    shutil.rmtree(ROOT / "python" / "build", ignore_errors=True)
    run(*uvpip, "--no-deps", "--reinstall-package", "soma", ROOT / "python")
    shutil.rmtree(ROOT / "python" / "build", ignore_errors=True)
    if not args.skip_ccx:
        run(py, ROOT / "python" / "scripts" / "fetch_ccx.py", "--target", target / "ccx")
    write_launchers_windows(target) if WIN else write_launchers_unix(target)
    if sys.platform.startswith("linux"):
        bundle_linux_libs(target)
    freeze = subprocess.run([str(py), "-m", "pip", "list", "--format=freeze"], check=True, capture_output=True, text=True).stdout
    (target / "SOMA-RUNTIME.txt").write_text(f"Python {PYTHON} for SOMA ({sys.platform})\n\n{freeze}", encoding="utf-8", newline="\n")
    check(target)
    size = sum(f.stat().st_size for f in target.rglob("*") if f.is_file() and not f.is_symlink())
    print(f"Runtime ready: {target} ({size / 2**20:.0f} MB)")


if __name__ == "__main__":
    main()
