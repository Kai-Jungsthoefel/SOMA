# Baut die Python-Basisumgebung fuer die Entwicklung (lokal, nicht auf einem Netzlaufwerk: Tausende kleine Dateien)
# und installiert soma darin editierbar. Die App findet sie unter %LOCALAPPDATA%\soma-dev\venv (src/main/paths.ts).
# Voraussetzungen: uv, Python 3.12.
$ErrorActionPreference = "Stop"
$root = "$env:LOCALAPPDATA\soma-dev"
$venv = "$root\venv"
$py = "$venv\Scripts\python.exe"
New-Item -ItemType Directory -Force $root | Out-Null
if (-not (Test-Path $py)) { uv venv --python 3.12 $venv }
uv pip install --python $py -r "$PSScriptRoot\..\requirements-base.txt"
uv pip install --python $py -e "$PSScriptRoot\.."
# CalculiX fuer die FEM (E84): von conda-forge nach venv\ccx, nur wenn es noch fehlt
if (-not (Test-Path "$venv\ccx\ccx.exe")) { & $py "$PSScriptRoot\fetch_ccx.py" }
Write-Host "Environment ready: $venv"
