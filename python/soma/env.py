"""Projektumgebung (E25, E67): eine kleine venv je Modell unter .soma/env, die die Basisumgebung mitbenutzt.

Zusatzpakete sind der Sonderfall. Der Agent installiert sie einfach mit pip: Die Terminals der App leiten pip per
PIP_PYTHON in diese Umgebung. Die Basisumgebung bleibt unveraendert. Ihre Pakete gelten als vorhanden (eine .pth-Datei
haengt sie ein) und sind ueber die pip.ini der Umgebung auf ihre Version festgelegt, damit kein Zusatzpaket z. B. numpy
gegen eine Version tauscht, mit der CadQuery nicht laeuft.

Die Umgebung wandert weder in die ZIP noch in Git. `soma build` haelt in requirements.txt fest, welche Zusatzpakete das
Modell importiert, und auf einem anderen Rechner installiert die App diese Liste neu.
"""
import importlib.metadata
import json
import os
import re
import site
import sys
import sysconfig
import venv
from pathlib import Path, PurePosixPath

ENV_DIR = Path(".soma") / "env"
REQUIREMENTS = "requirements.txt"
INFO = "soma-env.json"
CONSTRAINTS = "base-constraints.txt"
BASE_PTH = "_soma_base.pth"
# Fassung der Umgebung. Erhoehen, wenn sich an .pth, pip.ini oder INFO etwas aendert (die App prueft sie, app/src/main/packages.ts)
FORMAT = 1

REQ_HEADER = ("# Extra Python packages this model imports, on top of the app's base environment.\n"
              "# Written by `soma build`. Install packages with pip, the app installs this list when the model is opened elsewhere.\n")


def requirements_path(root):
    """Paketliste des Modells. Ein geoeffneter Ordner (Ordner-Modus) hat sie in .soma/, weil eine requirements.txt dort dem
    Nutzer gehoert: project.json nennt dann "requirements". Nur ein Pfad innerhalb des Projekts gilt."""
    root = Path(root).resolve()
    try:
        rel = json.loads((root / ".soma" / "project.json").read_text(encoding="utf-8")).get("requirements")
    except (OSError, ValueError, AttributeError):
        rel = None
    if isinstance(rel, str) and rel and _inside(root / rel, root):
        return root / rel
    return root / REQUIREMENTS


def env_dir(project):
    return Path(project).resolve() / ENV_DIR


def env_site(env):
    """site-packages der Projektumgebung (gleiche Python-Version wie die laufende Basis)."""
    return Path(sysconfig.get_path("purelib", "venv", vars={"base": str(env), "platbase": str(env)}))


def _base_sites():
    seen = []
    for key in ("purelib", "platlib"):
        p = sysconfig.get_path(key)
        if p and p not in seen:
            seen.append(p)
    return seen


def _inside(path, folder):
    try:
        return Path(path).resolve().is_relative_to(Path(folder).resolve())
    except OSError:
        return False


def _norm(name):
    return re.sub(r"[-_.]+", "-", name).lower()


def _mtime_ms(p):
    try:
        return os.stat(p).st_mtime_ns // 1_000_000
    except OSError:
        return None


def ensure(project):
    """Legt die Projektumgebung an oder bringt sie auf den Stand der Basis. Gibt ein Ergebnis-Dict zurueck, wirft nicht.

    Gleiche Python-Version: Die Pakete bleiben (nur Verweise und Constraints werden neu geschrieben). Andere Version (neue
    App): Die alten Pakete laufen dort nicht, die Umgebung wird geleert und die App installiert requirements.txt neu."""
    env = env_dir(project)
    if _inside(sys.prefix, env):
        return dict(ok=False, error="soma env must run with the Python of the base environment, not from the project environment.")
    version = f"{sys.version_info[0]}.{sys.version_info[1]}"
    old = {}
    try:
        old = json.loads((env / INFO).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        pass
    exists = (env / "pyvenv.cfg").is_file()
    cleared = exists and old.get("version") not in (None, version)
    # Nur wenn noetig: Ein laufendes python.exe der Umgebung (Terminal) liesse sich nicht ersetzen
    if not exists or cleared or old.get("base_python") != sys.executable:
        try:
            venv.EnvBuilder(with_pip=False, clear=cleared, upgrade=exists and not cleared, symlinks=os.name != "nt").create(str(env))
        except Exception as e:  # noqa: BLE001  (Rechte, volle Platte, fehlende venv-Dateien: melden)
            return dict(ok=False, error=f"The project environment could not be created: {type(e).__name__}: {e}")

    sp = env_site(env)
    bases = _base_sites()
    try:
        sp.mkdir(parents=True, exist_ok=True)
        # Basis hinten anhaengen: Pakete der Basis sind fuer Python und pip vorhanden, ohne kopiert zu werden
        (sp / BASE_PTH).write_text("".join(f"import site; site.addsitedir({p!r})\n" for p in bases), encoding="utf-8", newline="\n")
        pins = {}
        for d in importlib.metadata.distributions(path=bases):
            name = d.metadata["Name"]
            if name and _norm(name) not in pins:
                pins[_norm(name)] = f"{name}=={d.version}"
        (env / CONSTRAINTS).write_text("# Versions of the base environment. Extra packages must work with them.\n"
                                       + "".join(f"{v}\n" for _, v in sorted(pins.items())), encoding="utf-8", newline="\n")
        # pip liest die pip.ini im Ordner der Umgebung bei jedem Lauf darin. Als URL, weil pip Pfade mit Leerzeichen dort trennt
        conf = "pip.ini" if os.name == "nt" else "pip.conf"
        (env / conf).write_text("[global]\ndisable-pip-version-check = true\n\n[install]\n"
                                f"constraint = {(env / CONSTRAINTS).as_uri()}\n", encoding="utf-8", newline="\n")
        info = dict(format=FORMAT, version=version, base_python=sys.executable, base_sites=bases,
                    base_mtimes=[_mtime_ms(p) for p in bases], site=os.path.relpath(sp, env))
        (env / INFO).write_text(json.dumps(info, indent=1), encoding="utf-8", newline="\n")
    except OSError as e:
        return dict(ok=False, error=f"The project environment could not be set up: {e}")
    res = dict(ok=True, env=str(env), site=str(sp), created=not exists, cleared=cleared)
    if cleared:
        res["note"] = f"The project environment was for Python {old.get('version')} and was created again for Python {version}."
    return res


def activate(project):
    """Pakete der Projektumgebung fuer diesen Prozess sichtbar machen (soma laeuft mit dem Python der Basis). Sie kommen
    hinten in den Suchpfad: Was die Basis hat, gilt."""
    env = env_dir(project)
    sp = env_site(env)
    if sp.is_dir() and not _inside(sys.prefix, env):
        site.addsitedir(str(sp))


def _top_names(dist):
    """Oberste Modulnamen eines Pakets laut RECORD (Ordner oder einzelne Datei wie six.py oder x.cp312-win_amd64.pyd)."""
    out = set()
    for f in dist.files or []:
        parts = PurePosixPath(str(f)).parts
        if not parts or parts[0] == ".." or parts[0].endswith((".dist-info", ".egg-info", ".data")) or parts[0] == "__pycache__":
            continue
        out.add(parts[0] if len(parts) > 1 else parts[0].split(".")[0])
    return out


def _parse_requirements(text):
    """Zeilen von requirements.txt als (normierter Name oder None, Zeile). Kommentare fallen weg."""
    out = []
    for raw in text.splitlines():
        line = raw.split(" #")[0].strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"([A-Za-z0-9][A-Za-z0-9._-]*)", line)
        out.append((_norm(m.group(1)) if m and not line.startswith("-") else None, line))
    return out


def record_requirements(project):
    """Nach einem erfolgreichen Build: Zusatzpakete, deren Module das Modell geladen hat, mit Version in requirements.txt.

    Was in der Liste steht, aber hier nicht installiert ist (anderer Rechner, Installation noch nicht gelaufen oder
    gescheitert), bleibt stehen: Es geht nichts verloren, nur weil ein Paket gerade fehlt. Ohne Projektumgebung (soma ohne
    App) und ohne Zusatzpakete entsteht keine Datei. Gibt eine Warnung zurueck oder None."""
    root = Path(project).resolve()
    sp = env_site(env_dir(root))
    if not sp.is_dir():
        return None
    by_top = {}
    installed = {}
    for d in importlib.metadata.distributions(path=[str(sp)]):
        name = d.metadata["Name"]
        if not name:
            continue
        installed[_norm(name)] = f"{name}=={d.version}"
        for t in _top_names(d):
            by_top.setdefault(t, set()).add(_norm(name))
    # Module aus der Umgebung kamen ueber den Pfad, den activate() eingetragen hat: ein Vergleich der Anfaenge genuegt
    # (schneller als jeden der vielen Pfade von cadquery und vtk aufzuloesen)
    prefix = os.path.normcase(str(sp)).rstrip("\\/") + os.sep
    used = set()
    for m in list(sys.modules.values()):
        f = getattr(m, "__file__", None)
        if not isinstance(f, str) or not os.path.normcase(f).startswith(prefix):
            continue
        rel = Path(f[len(prefix):])
        top = rel.parts[0] if len(rel.parts) > 1 else rel.parts[0].split(".")[0]
        used |= by_top.get(top, set())
    req = requirements_path(root)
    name = req.relative_to(root).as_posix()
    try:
        old = req.read_text(encoding="utf-8") if req.is_file() else None
    except (OSError, UnicodeDecodeError) as e:
        return f"{name} is not readable ({e}) and was not updated."
    lines = {n: installed[n] for n in used}
    for name, line in _parse_requirements(old or ""):
        if name is None or name not in installed:
            lines.setdefault(name or line, line)
    if old is None and not lines:
        return None
    text = REQ_HEADER + "".join(f"{v}\n" for _, v in sorted(lines.items(), key=lambda kv: kv[0]))
    if text != old:
        try:
            req.parent.mkdir(parents=True, exist_ok=True)
            req.write_text(text, encoding="utf-8", newline="\n")
        except OSError as e:
            return f"{name} could not be written: {e}"
    return None
