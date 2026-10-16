"""CadQuery rein und raus (E100): "Export as CadQuery" und "New model from CadQuery script".

Export: Der Modellcode bleibt Zeichen fuer Zeichen gleich. Nur die Zeilen `from soma import ...` und
`from soma.fasteners import ...` werden ersetzt: Jede Originalzeile bleibt als Kommentar `# soma-import: ...` stehen,
beim ersten Import folgt ein markierter Block mit add_part(), param(), import_step(), import_assembly() und bei Bedarf
den Normteilen samt Tabellen (cqruntime.py, Apache 2.0, E101). Am Ende ruft ein Fussblock show_object() (CQ-editor,
cq-cli) bzw. ocp_vscode auf und legt `result` an. Ein Modell mit eigenen Modulen (parts/) wird ein Ordner mit
soma_compat.py statt des Blocks.

Import: Die Markierungen werden zurueckgedreht (Block und Fussblock fallen weg, die Originalzeilen kommen zurueck), die
Werte des Parameter-Panels gehen nach parameters.json. Ein Skript ohne Markierungen bleibt unveraendert, es baut im
Kompatibilitaetsmodus (cqcompat.py). Wurde der Block veraendert, bleibt er stehen und das wird gemeldet (E28).
"""
import ast
import hashlib
import json
import re
import shutil
from pathlib import Path

from . import __version__, params
from .build import DEFAULT_ENTRY, read_project_json

CORE = ("add_part", "param", "import_step", "import_assembly")
FASTENERS = ("Screw", "Nut", "Washer", "HeatSetInsert", "lengths", "pick_length", "standards")  # = fasteners.__all__
MARK = "# soma-import: "
BLOCK_START = "# >>> soma-compat"
BLOCK_END = "# <<< soma-compat"
FOOTER_START = "# >>> soma-compat footer"
FOOTER_END = "# <<< soma-compat footer"
CHECK = "# soma-checksum: "
TAG = "  # soma-compat"  # Ende der Importzeile, die im Ordner-Export an die Stelle der soma-Imports tritt
VALUES = "_SOMA_VALUES = "  # die einzige Zeile des Blocks, die der Nutzer aendern darf (nicht in der Pruefsumme)
COMPAT_MODULE = "soma_compat"
_HERE = Path(__file__).parent


class ExportError(Exception):
    pass


# --- Quelltext untersuchen ---------------------------------------------------------------------------------------------

def _soma_imports(tree, rel):
    """soma-Imports der Datei als [(Knoten, Modul, [(Name, Alias)])], nach Zeile. Was der Export nicht abbilden kann
    (import soma, soma.anim, Imports in Funktionen, zwei Anweisungen in einer Zeile), ist ein Fehler mit Zeile."""
    found = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names:
                if a.name == "soma" or a.name.startswith("soma."):
                    raise ExportError(f"{rel}, line {node.lineno}: `import {a.name}` cannot be exported. "
                                      "Write `from soma import add_part, param` (or from soma.fasteners import ...) instead.")
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and (node.module == "soma" or (node.module or "").startswith("soma.")):
            allowed = CORE if node.module == "soma" else FASTENERS if node.module == "soma.fasteners" else None
            if allowed is None:
                raise ExportError(f"{rel}, line {node.lineno}: {node.module} only works in SOMA and cannot be exported.")
            if node not in tree.body:
                raise ExportError(f"{rel}, line {node.lineno}: the import from {node.module} must be at the top level of the file.")
            names = []
            for a in node.names:
                if a.name == "*":
                    names += [(n, n) for n in allowed]
                elif a.name in allowed:
                    names.append((a.name, a.asname or a.name))
                else:
                    raise ExportError(f"{rel}, line {node.lineno}: {node.module}.{a.name} cannot be exported "
                                      f"(possible: {', '.join(allowed)}).")
            found.append((node, node.module, names))
    for node, _, _ in found:
        for other in tree.body:
            if other is not node and other.lineno <= node.end_lineno and other.end_lineno >= node.lineno:
                raise ExportError(f"{rel}, line {node.lineno}: put the import from {node.module} on lines of its own.")
    return sorted(found, key=lambda f: f[0].lineno)


def _module_files(base, rel, tree):
    """Eigene Module, die die Datei importiert, als Pfade relativ zu `base` (parts/lid.py, parts/__init__.py ...)."""
    pkg = Path(rel).parent
    wanted = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            wanted += [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom):
            if node.level:
                up = pkg
                for _ in range(node.level - 1):
                    up = up.parent
                mod = ".".join([*up.parts, *(node.module.split(".") if node.module else [])])
            else:
                mod = node.module or ""
            if mod:
                wanted += [mod] + [f"{mod}.{a.name}" for a in node.names if a.name != "*"]
    out = []
    for mod in wanted:
        parts = mod.split(".")
        if parts[0] in ("soma", COMPAT_MODULE):
            continue
        for i in range(1, len(parts) + 1):  # auch die Pakete auf dem Weg (parts/__init__.py)
            stem = Path(*parts[:i])
            for cand in (stem.with_suffix(".py"), stem / "__init__.py"):
                if (base / cand).is_file() and cand.as_posix() not in out:
                    out.append(cand.as_posix())
    return out


def _all_files(base, entry, strict=True):
    """Einstiegspunkt und alle eigenen Module, die er (auch ueber andere) importiert. `strict=False` (Import): Eine Datei
    mit Syntaxfehler wird trotzdem uebernommen, nur ihre Imports bleiben unbekannt. Den Fehler meldet dann der Build."""
    files, todo = [], [entry]
    while todo:
        rel = todo.pop(0)
        if rel in files:
            continue
        files.append(rel)
        try:
            tree = _parse(base / rel, rel)
        except ExportError:
            if strict:
                raise
            continue
        todo += [m for m in _module_files(base, rel, tree) if m not in files]
    return files


def _parse(path, rel):
    try:
        return ast.parse(path.read_text(encoding="utf-8-sig"), filename=rel)
    except SyntaxError as e:
        raise ExportError(f"{rel}, line {e.lineno}: syntax error, fix it before exporting ({e.msg}).")
    except OSError as e:
        raise ExportError(f"{rel} cannot be read: {e}")


# --- Block erzeugen ---------------------------------------------------------------------------------------------------

def _literal(text):
    """Text als Python-Literal, moeglichst lesbar (Rohtext in dreifachen Anfuehrungszeichen)."""
    if "'''" not in text and not text.endswith("\\"):
        return "r'''" + text + "'''"
    return repr(text)


def _checksum(lines):
    body = "\n".join(l for l in lines if not l.startswith(VALUES))
    return hashlib.sha256(body.encode("utf-8")).hexdigest()[:16]


def _runtime_lines(values, fasteners):
    lines = (_HERE / "cqruntime.py").read_text(encoding="utf-8").splitlines()
    i = next(k for k, l in enumerate(lines) if l.startswith(VALUES))
    lines[i] = VALUES + repr(dict(values)) + lines[i][lines[i].index("  #"):]
    if fasteners:
        src = (_HERE / "fasteners.py").read_text(encoding="utf-8")
        tables = {p.name: p.read_text(encoding="utf-8-sig") for p in sorted((_HERE / "data" / "fasteners").glob("*.csv"))}
        notice = (_HERE / "data" / "fasteners" / "LICENSE-bd_warehouse.txt")
        lines += [
            "",
            "",
            "# Standard parts of SOMA (soma.fasteners, Apache License 2.0). The dimension tables come from bd_warehouse",
            "# (https://github.com/gumyr/bd_warehouse, Apache License 2.0" + (", see its LICENSE)." if notice.is_file() else ")."),
            "_SOMA_FASTENERS_SOURCE = " + _literal(src),
            "_SOMA_TABLES = {",
            *[f"    {name!r}: {_literal(text)}," for name, text in tables.items()],
            "}",
            "",
            "",
            "def _soma_fasteners():",
            "    import types",
            "    module = types.ModuleType(\"soma_fasteners\")",
            "    module.__file__ = _soma_os.path.join(_SOMA_DIR, \"soma_fasteners.py\")",
            "    _soma_linecache.cache[\"<soma fasteners>\"] = (len(_SOMA_FASTENERS_SOURCE), None,",
            "                                                 _SOMA_FASTENERS_SOURCE.splitlines(True), \"<soma fasteners>\")",
            "    exec(compile(_SOMA_FASTENERS_SOURCE, \"<soma fasteners>\", \"exec\"), module.__dict__)",
            "    module._EMBEDDED.update(_SOMA_TABLES)",
            "    return module",
            "",
            "",
            "_soma_fasteners_module = _soma_fasteners()",
            *[f"{n} = _soma_fasteners_module.{n}" for n in FASTENERS],
        ]
    return lines


def _block(values, fasteners, aliases):
    body = _runtime_lines(values, fasteners) + [f"{alias} = {name}" for name, alias in aliases]
    head = [f"{BLOCK_START} {__version__} (generated by SOMA. Keep this block unchanged, then SOMA can import the script "
            "again. Only the values in _SOMA_VALUES may change.)", CHECK + _checksum(body)]
    return head + body + [BLOCK_END]


def _footer(folder):
    call = ([f"import {COMPAT_MODULE} as _soma_compat", "_soma_compat._soma_show(globals())"] if folder
            else ["_soma_show(globals())"])
    return ["", "", f"{FOOTER_START} (generated by SOMA: shows the parts in CQ-editor or ocp_vscode, `result` is the assembly)",
            *call, FOOTER_END]


def _rewrite(text, imports, mode, block=None, footer=False):
    """Ersetzt die soma-Imports. mode "single": Block beim ersten Import, "folder": Import aus soma_compat."""
    lines = text.splitlines()
    out, i = [], 0
    for k, (node, _, names) in enumerate(imports):
        a, b = node.lineno - 1, node.end_lineno
        out += lines[i:a]
        out += [MARK + l for l in lines[a:b]]
        if mode == "single":
            if k == 0:
                out += block
        else:
            out.append(f"from {COMPAT_MODULE} import " + ", ".join(n if n == al else f"{n} as {al}" for n, al in names) + TAG)
        i = b
    out += lines[i:]
    if footer:
        while out and not out[-1].strip():
            out.pop()
        out += _footer(mode == "folder")
    return "\n".join(out) + "\n"


# --- Export -----------------------------------------------------------------------------------------------------------

def _uses_inputs(texts):
    return any(re.search(r"""["'](\./)?inputs[/\\]""", t) for t in texts)


def _copy_tree(src, dst, warnings, what):
    """Kopiert Dateien, ohne Vorhandenes zu ueberschreiben (das wird gemeldet)."""
    copied = []
    for f in sorted(p for p in src.rglob("*") if p.is_file()):
        target = dst / f.relative_to(src)
        if target.exists():
            warnings.append(f"{what}: {target.name} already exists and was kept.")
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(f, target)
        copied.append(target)
    return copied


def export(project, out):
    """Schreibt das Modell als CadQuery: `out` ist eine .py-Datei (eine Datei) oder ein Ordner (mit parts/).
    Liefert dict(mode, files, warnings). Ein Ordner muss leer sein oder fehlen, eine .py-Datei wird ersetzt (der
    Speicherdialog hat gefragt)."""
    root = Path(project).resolve()
    entry = read_project_json(root).get("entry") or DEFAULT_ENTRY
    if not (root / entry).is_file():
        raise ExportError(f"Entry point {entry!r} not found.")
    files = _all_files(root, entry)
    values, problem = params.read_user_values(root)
    warnings = [problem] if problem else []
    texts = {rel: (root / rel).read_text(encoding="utf-8-sig") for rel in files}
    imports = {rel: _soma_imports(_parse(root / rel, rel), rel) for rel in files}
    used = {m for rel in files for _, m, _ in imports[rel]}
    fasteners = "soma.fasteners" in used
    out = Path(out)
    written = []
    if len(files) == 1:
        mode = "single"
        if out.suffix.lower() != ".py":
            out = out.with_suffix(".py")
        imp = imports[entry]
        aliases = sorted({(n, al) for _, _, names in imp for n, al in names if n != al})
        text = _rewrite(texts[entry], imp, "single", _block(values, fasteners, aliases), footer=bool(imp)) if imp else texts[entry]
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(text, encoding="utf-8", newline="\n")
        written.append(out)
        base = out.parent
    else:
        mode = "folder"
        if out.suffix.lower() == ".py":  # die App nennt vorab nur einen Namen: box.py wird der Ordner box
            out = out.with_suffix("")
        if out.exists() and (not out.is_dir() or any(out.iterdir())):
            raise ExportError(f"{out} already exists and is not an empty folder. Choose a new folder for the export.")
        out.mkdir(parents=True, exist_ok=True)
        for rel in files:
            target = out / ("model.py" if rel == entry else rel)
            target.parent.mkdir(parents=True, exist_ok=True)
            imp = imports[rel]
            text = _rewrite(texts[rel], imp, "folder", footer=rel == entry and bool(used)) if imp or rel == entry and used else texts[rel]
            target.write_text(text, encoding="utf-8", newline="\n")
            written.append(target)
        if used:
            body = _runtime_lines(values, fasteners)
            head = [f"# {COMPAT_MODULE}.py, generated by SOMA {__version__}: add_part(), param() and the standard parts in plain "
                    "CadQuery. Keep it unchanged, then SOMA can import the model again.", CHECK + _checksum(body)]
            (out / f"{COMPAT_MODULE}.py").write_text("\n".join(head + body) + "\n", encoding="utf-8", newline="\n")
            written.append(out / f"{COMPAT_MODULE}.py")
        base = out
    if (root / "inputs").is_dir() and _uses_inputs(texts.values()):
        written += _copy_tree(root / "inputs", base / "inputs", warnings, "inputs")
    for extra in ("animations", "drawings", "analyses"):
        if (root / extra).is_dir() and any((root / extra).glob("*.py")):
            warnings.append(f"{extra}/ only works in SOMA and is not part of the export.")
    if values:
        warnings.append(f"The values from the Parameters panel ({', '.join(sorted(values))}) are in _SOMA_VALUES.")
    return dict(mode=mode, files=[p.as_posix() for p in written], warnings=warnings)


# --- Import -----------------------------------------------------------------------------------------------------------

def restore(text):
    """Dreht den Export zurueck. Liefert (Text, Werte aus _SOMA_VALUES oder None, Warnungen). Ist der Block veraendert
    oder unvollstaendig, bleibt der Text, wie er ist."""
    lines = text.splitlines()
    out, values, found, i = [], None, False, 0
    while i < len(lines):
        line = lines[i]
        if line.startswith(MARK):
            found = True
            while i < len(lines) and lines[i].startswith(MARK):
                out.append(lines[i][len(MARK):])
                i += 1
            if i < len(lines) and lines[i].startswith(BLOCK_START) and not lines[i].startswith(FOOTER_START):
                end = next((k for k in range(i + 1, len(lines)) if lines[k] == BLOCK_END), None)
                if end is None:
                    return text, None, ["The SOMA compatibility block has no end marker. The script was kept as it is."]
                body = lines[i + 1:end]
                if not body or not body[0].startswith(CHECK) or body[0][len(CHECK):].strip() != _checksum(body[1:]):
                    return text, None, ["The SOMA compatibility block was changed. The script was kept as it is, it builds "
                                        "with its own copy of add_part() and param()."]
                values = _values(body)
                i = end + 1
            elif i < len(lines) and lines[i].endswith(TAG):
                i += 1
            continue
        if line.startswith(FOOTER_START):
            end = next((k for k in range(i + 1, len(lines)) if lines[k] == FOOTER_END), None)
            if end is not None:
                while out and not out[-1].strip():
                    out.pop()
                i = end + 1
                continue
        out.append(line)
        i += 1
    if not found:
        return text, None, []
    return "\n".join(out) + "\n", values, []


def _values(lines):
    line = next((l for l in lines if l.startswith(VALUES)), None)
    if line is None:
        return None
    src = line[len(VALUES):].split("  #")[0].strip()
    try:
        v = ast.literal_eval(src)
    except (ValueError, SyntaxError):
        return None
    return v if isinstance(v, dict) else None


def _free(path):
    """Freier Dateiname: board.py, board (2).py ..."""
    i = 2
    cand = path
    while cand.exists():
        cand = path.with_name(f"{path.stem} ({i}){path.suffix}")
        i += 1
    return cand


def import_script(script, project, backup=None):
    """Uebernimmt ein CadQuery-Skript (und seine eigenen Module) als Modell des Projekts. Das Original kommt als Sicherung
    nach inputs/. Vorhandene Dateien werden nur ersetzt, wenn `backup` (Ordner) angegeben ist, dorthin kommen sie vorher.
    Liefert dict(mode "soma" | "cadquery", files, warnings)."""
    src, root = Path(script).resolve(), Path(project).resolve()
    if not src.is_file() or src.suffix.lower() != ".py":
        raise ExportError(f"{src} is not a Python file.")
    base = src.parent
    files = _all_files(base, src.name, strict=False) if base != root else [src.name]
    warnings, written, all_values, mode = [], [], {}, "cadquery"
    plan = []
    for rel in files:
        text = (base / rel).read_text(encoding="utf-8-sig")
        new, values, w = restore(text)
        warnings += [f"{rel}: {m}" for m in w]
        if new != text:
            mode = "soma"
        all_values.update(values or {})
        plan.append(("model.py" if rel == src.name else rel, new))
    compat = base / f"{COMPAT_MODULE}.py"
    if compat.is_file() and mode == "soma":  # Ordner-Export: die Werte stehen in soma_compat.py
        all_values.update(_values(compat.read_text(encoding="utf-8-sig").splitlines()) or {})
    for rel, text in plan:
        target = root / rel
        if target.exists() and target.read_text(encoding="utf-8-sig") != text:
            if backup is None:
                raise ExportError(f"{rel} already exists in the model. Import into a new model.")
            b = Path(backup) / rel
            b.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target, b)
    for rel, text in plan:
        target = root / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8", newline="\n")
        written.append(rel)
    (root / "inputs").mkdir(exist_ok=True)
    keep = _free(root / "inputs" / src.name)
    shutil.copy2(src, keep)
    written.append(keep.relative_to(root).as_posix())
    if (base / "inputs").is_dir() and base != root:
        written += [p.relative_to(root).as_posix() for p in _copy_tree(base / "inputs", root / "inputs", warnings, "inputs")]
    if all_values:
        (root / params.USER_FILE).write_text(json.dumps(dict(note=params.FILE_NOTE, values=all_values), indent=2, ensure_ascii=False) + "\n",
                                             encoding="utf-8", newline="\n")
        written.append(params.USER_FILE)
    if mode == "cadquery":
        warnings.append("Plain CadQuery script: it builds in compatibility mode (show_object(), ocp_vscode or result). "
                        "To convert it to add_part() and param(), ask the agent.")
    return dict(mode=mode, files=written, warnings=warnings)
