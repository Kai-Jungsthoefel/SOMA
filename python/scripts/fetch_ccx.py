"""Holt CalculiX (ccx) von conda-forge und legt es neben die Python-Umgebung (E84).

    python python/scripts/fetch_ccx.py                         # nach <sys.prefix>/ccx, fuer dieses System
    python python/scripts/fetch_ccx.py --platform osx-arm64 --target build/ccx-osx-arm64

Ablauf: micromamba (eine Datei) laden, damit eine Wegwerf-Umgebung mit calculix und OpenBLAS anlegen (ohne Vorgabe
nimmt conda unter Windows MKL, 680 MB statt 53 MB), dann nur das Noetige kopieren:
- Windows: ccx.exe und die DLLs, die es wirklich laedt (Importtabellen gelesen), flach in einen Ordner.
  Windows sucht DLLs zuerst neben der EXE.
- Linux, macOS: bin/ccx und lib/ wie in der Umgebung (ccx findet seine Bibliotheken relativ, $ORIGIN/../lib bzw.
  @loader_path/../lib). Ungetestet, bisher nur unter Windows ausprobiert.
Dazu die Lizenztexte aller Pakete nach licenses/ und die Paketliste nach PACKAGES.txt (fuer den Installer, E30).
"""
import argparse
import json
import os
import platform
import shutil
import struct
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

SPECS = ["calculix=2.23", "libblas=*=*openblas"]


def host_platform():
    m = platform.machine().lower()
    if sys.platform == "win32":
        return "win-64"
    if sys.platform == "darwin":
        return "osx-arm64" if m in ("arm64", "aarch64") else "osx-64"
    return "linux-aarch64" if m in ("arm64", "aarch64") else "linux-64"


def micromamba(cache):
    me = host_platform()
    exe = cache / ("micromamba.exe" if me == "win-64" else "micromamba")
    if not exe.is_file():
        url = f"https://github.com/mamba-org/micromamba-releases/releases/latest/download/micromamba-{me}"
        print(f"Loading micromamba ({url})")
        cache.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(url, exe)
        exe.chmod(0o755)
    return exe


def pe_imports(path):
    """Namen der importierten DLLs einer PE-Datei (EXE/DLL)."""
    data = Path(path).read_bytes()
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    nsec = struct.unpack_from("<H", data, pe + 6)[0]
    opt = pe + 24
    magic = struct.unpack_from("<H", data, opt)[0]
    dirs = opt + (112 if magic == 0x20B else 96)
    imp_rva = struct.unpack_from("<I", data, dirs + 8)[0]
    sec = opt + struct.unpack_from("<H", data, pe + 20)[0]
    sections = []
    for i in range(nsec):
        va, raw_size, raw_ptr = struct.unpack_from("<III", data, sec + 40 * i + 12)
        vsize = struct.unpack_from("<I", data, sec + 40 * i + 8)[0]
        sections.append((va, max(vsize, raw_size), raw_ptr))

    def off(rva):
        for va, size, ptr in sections:
            if va <= rva < va + size:
                return rva - va + ptr
        raise ValueError("RVA outside sections")

    names = []
    if not imp_rva:
        return names
    d = off(imp_rva)
    while True:
        name_rva = struct.unpack_from("<I", data, d + 12)[0]
        if not name_rva:
            break
        o = off(name_rva)
        names.append(data[o:data.index(b"\0", o)].decode("ascii"))
        d += 20
    return names


def copy_windows(env, target):
    dirs = [env / "Library" / "bin", env / "Library" / "mingw-w64" / "bin", env]
    where = {}
    for d in dirs:
        if d.is_dir():
            for f in d.iterdir():
                if f.suffix.lower() in (".dll", ".exe"):
                    where.setdefault(f.name.lower(), f)
    todo, seen = ["ccx.exe"], set()
    while todo:
        name = todo.pop().lower()
        if name in seen or name not in where:
            continue  # Systembibliotheken (KERNEL32, UCRT) bringt Windows mit
        seen.add(name)
        todo += pe_imports(where[name])
        # openblas laedt libblas/liblapack per Weiterleitung: openblas.dll mitnehmen, wenn eine davon dabei ist
        if name in ("libblas.dll", "liblapack.dll"):
            todo.append("openblas.dll")
    # api-ms-win-*.dll und ucrtbase gibt es ab Windows 10 im System
    keep = [n for n in seen if not n.startswith("api-ms-win-") and n != "ucrtbase.dll"]
    for n in sorted(keep):
        shutil.copy2(where[n], target / where[n].name)
    return sorted(where[n].name for n in keep)


def copy_unix(env, target):
    (target / "bin").mkdir(parents=True, exist_ok=True)
    shutil.copy2(env / "bin" / "ccx", target / "bin" / "ccx")
    shutil.copytree(env / "lib", target / "lib", symlinks=True,
                    ignore=shutil.ignore_patterns("*.a", "pkgconfig", "cmake", "python*", "*.la"))
    return ["bin/ccx", "lib/"]


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--platform", default=host_platform())
    ap.add_argument("--target", default=str(Path(sys.prefix) / "ccx"))
    args = ap.parse_args()
    target = Path(args.target)
    cache = Path(tempfile.gettempdir()) / "soma-fetch-ccx"
    mm = micromamba(cache)
    work = Path(tempfile.mkdtemp(prefix="soma-ccx-env-"))
    env = work / "env"
    try:
        cmd = [str(mm), "create", "-y", "-p", str(env), "--platform", args.platform, "-c", "conda-forge",
               "--override-channels", *SPECS]
        print("Creating environment:", " ".join(SPECS), f"({args.platform})")
        subprocess.run(cmd, check=True, env=dict(os.environ, MAMBA_ROOT_PREFIX=str(work / "root")))
        if target.exists():
            backup = target.with_name(target.name + ".old")
            shutil.rmtree(backup, ignore_errors=True)
            target.rename(backup)  # nichts still ueberschreiben: der alte Stand bleibt als ccx.old
            print(f"Previous version moved to {backup}")
        target.mkdir(parents=True)
        files = copy_windows(env, target) if args.platform.startswith("win") else copy_unix(env, target)
        # Paketliste und Lizenzen
        pkgs, lic = [], target / "licenses"
        for meta in sorted((env / "conda-meta").glob("*.json")):
            m = json.loads(meta.read_text(encoding="utf-8"))
            pkgs.append(f"{m['name']} {m['version']} {m['build']} ({m.get('license', '?')})")
            src = Path(m.get("extracted_package_dir") or "") / "info" / "licenses"
            if src.is_dir():
                shutil.copytree(src, lic / m["name"], dirs_exist_ok=True)
        (target / "PACKAGES.txt").write_text("CalculiX for SOMA, from conda-forge\n\n" + "\n".join(pkgs) + "\n", encoding="utf-8")
        size = sum(f.stat().st_size for f in target.rglob("*") if f.is_file())
        print(f"{len(files)} files to {target} ({size / 2**20:.0f} MB with licenses)")
        if args.platform == host_platform():
            exe = target / ("ccx.exe" if args.platform.startswith("win") else "bin/ccx")
            p = subprocess.run([str(exe), "-v"], capture_output=True, text=True, errors="replace",
                               env=dict(os.environ, PATH=str(exe.parent) + os.pathsep + os.environ.get("PATH", "")))
            print("Check:", (p.stdout + p.stderr).strip().splitlines()[-1] if (p.stdout + p.stderr).strip() else "no output")
    finally:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
