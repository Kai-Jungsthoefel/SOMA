# Phase 0: fuehrt alle Pruefungen aus und fasst sie zusammen. Aufruf: powershell -File run_all.ps1 [-Perf]
param([switch]$Perf)
$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot
$py = if ($env:CADIDE_PHASE0_PY) { $env:CADIDE_PHASE0_PY } else { "$env:LOCALAPPDATA\cadide-phase0\venv-full\Scripts\python.exe" }
$port = 8791   # fester Port des Prototyps
$srv = Start-Process -FilePath $py -ArgumentList "-m","http.server",$port,"--bind","127.0.0.1" -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2
$results = [ordered]@{}
function Step($name, [scriptblock]$cmd) { & $cmd | Out-Host; $results[$name] = $LASTEXITCODE }
Step "1  STEP-Namen und Farben"        { & $py p1_step_names.py }
Step "1b Namen: Sonderzeichen (Info)"   { & $py p1b_names_edge.py }
Step "   Beispielplatine erzeugen"      { & $py make_board_step.py }
Step "   Build des Beispielprojekts"    { & $py run_build.py example }
Step "4  Import, Messen, Referenz"      { & $py p4_measure_test.py }
Step "6  Exportformate (Info)"          { & $py p6_export_formats.py }
Step "   Basismodus: STEP -> GLB"       { & $py basic_view.py example/inputs/board.step basic_example }
Step "3  Klick -> Code (Browser)"       { node p3_click_test.mjs }
Step "3b Basismodus (Browser)"          { node p3b_basic_test.mjs }
if ($Perf) { Step "2  Mesher-Leistung (Info)" { & $py p2_mesher_perf.py } }
Stop-Process -Id $srv.Id -Force
"`n=== Zusammenfassung (0 = ok) ==="
$results.GetEnumerator() | ForEach-Object { "{0,-34} {1}" -f $_.Key, $_.Value }
if (($results.Values | Where-Object { $_ -ne 0 }).Count -gt 0) { exit 1 }
