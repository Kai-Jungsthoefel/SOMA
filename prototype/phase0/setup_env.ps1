# Phase 0: baut die Python-Umgebung (lokal, nicht auf einem Netzlaufwerk) und installiert die Node-Pakete.
# Voraussetzungen: uv, Python 3.12, Node.js, Microsoft Edge (fuer den Browsertest).
$ErrorActionPreference = "Stop"
$root = "$env:LOCALAPPDATA\cadide-phase0"
New-Item -ItemType Directory -Force $root | Out-Null
if (-not (Test-Path "$root\venv-full\Scripts\python.exe")) { uv venv --python 3.12 "$root\venv-full" }
uv pip install --python "$root\venv-full\Scripts\python.exe" -r "$PSScriptRoot\requirements-phase0.txt"
Push-Location $PSScriptRoot; npm install --no-audit --no-fund; Pop-Location
Write-Host "Umgebung bereit: $root\venv-full"
