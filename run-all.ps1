# run-all.ps1  (ASCII-only; PowerShell 5.1 compatible)
$ErrorActionPreference = "Stop"

# --- TIMING: START ---
$scriptStart = Get-Date

# Run from this script's folder (project root)
$here = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $here

# --- EXPORT TIMING (after cleanup only) ---
$cleanupDone = $false
$timingFile  = Join-Path $here ("run_timing_{0}.txt")

# Paths
$myScriptPath = Join-Path $here "my-script.txt"
# $ssciPath     = Join-Path $here "ssci.txt"
$combineJs    = Join-Path $here "scripts\combine-email-report.js"
$cleanupJs    = Join-Path $here "scripts\cleanup-temp.js"

# Checks
if (-not (Test-Path $myScriptPath)) { Write-Host "[ERR ] my-script.txt not found: $myScriptPath" -ForegroundColor Red; exit 1 }
# if (-not (Test-Path $ssciPath))     { Write-Host "[ERR ] ssci.txt not found: $ssciPath" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $combineJs))    { Write-Host "[ERR ] combine-email-report.js not found: $combineJs" -ForegroundColor Red; exit 1 }
if (-not (Test-Path $cleanupJs))    { Write-Host "[ERR ] cleanup-temp.js not found: $cleanupJs" -ForegroundColor Red; exit 1 }

try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

function Run-TxtAsChildPs {
  param(
    [Parameter(Mandatory=$true)][string]$TxtPath,
    [string]$WorkingDir = $(Split-Path -Parent $TxtPath)
  )
  if (-not (Test-Path -LiteralPath $TxtPath)) { throw "Script not found: $TxtPath" }

  # Materialize a temp .ps1 to avoid Invoke-Expression quirks
  $content = Get-Content -LiteralPath $TxtPath -Raw -Encoding UTF8
  if (-not $content) { throw "Empty script: $TxtPath" }

  $tempDir = Join-Path $env:TEMP "nm-run"
  if (-not (Test-Path $tempDir)) { New-Item -ItemType Directory -Force -Path $tempDir | Out-Null }

  $base    = [IO.Path]::GetFileNameWithoutExtension($TxtPath)
  $tempPs1 = Join-Path $tempDir ("{0}_{1}.ps1" -f $base, [Guid]::NewGuid().ToString("N"))

  # Normalize line endings + write file
  $content -replace "`r?`n","`r`n" | Out-File -FilePath $tempPs1 -Encoding UTF8 -Force

  Write-Host "[INFO] Running child PowerShell: $TxtPath" -ForegroundColor Cyan
  Push-Location $WorkingDir
  try {
    # Run as a child PowerShell so scope/variables don't collide
    & powershell -NoProfile -ExecutionPolicy Bypass -File $tempPs1
    $code = $LASTEXITCODE
    if ($code -eq $null) { $code = 0 }
    return $code
  }
  finally {
    Pop-Location
    # Optional: keep temp for debugging. Comment next line to keep it.
    Remove-Item -LiteralPath $tempPs1 -Force -ErrorAction SilentlyContinue
  }
}

# --- main flow wrapped so we ALWAYS print timestamps ---
try {

  # STEP 1: my-script.txt (per-suite only)
  $code1 = Run-TxtAsChildPs -TxtPath $myScriptPath
  if ($code1 -ne 0) {
    Write-Host "[WARN] my-script.txt exit code: $code1" -ForegroundColor Yellow
  } else {
    Write-Host "[INFO] my-script.txt OK" -ForegroundColor Green
  }

  # STEP 2: ssci.txt (per-suite only; chained env inside)
  # $code2 = Run-TxtAsChildPs -TxtPath $ssciPath
  # if ($code2 -ne 0) {
  #   Write-Host "[WARN] ssci.txt exit code: $code2" -ForegroundColor Yellow
  # } else {
  #   Write-Host "[INFO] ssci.txt OK" -ForegroundColor Green
  # }

  # STEP 3: combine email report
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "[ERR ] Node.js not found on PATH (required for combine/cleanup)" -ForegroundColor Red
    exit 1
  }
  Write-Host "[INFO] Combining per-suite reports: $combineJs" -ForegroundColor Cyan
  & node $combineJs
  $code3 = $LASTEXITCODE
  if ($code3 -ne 0) {
    Write-Host "[WARN] combine-email-report.js exit code: $code3" -ForegroundColor Yellow
  } else {
    Write-Host "[INFO] combine-email-report.js OK" -ForegroundColor Green
  }

  # STEP 4: cleanup temp
  Write-Host "[INFO] Cleaning Temp: $cleanupJs" -ForegroundColor Cyan
  & node $cleanupJs
  $code4 = $LASTEXITCODE
  $cleanupDone = $true   # <-- marks that cleanup step happened (even if it failed)
  if ($code4 -ne 0) {
    Write-Host "[WARN] cleanup-temp.js exit code: $code4" -ForegroundColor Yellow
  } else {
    Write-Host "[INFO] cleanup-temp.js OK" -ForegroundColor Green
  }

  # Final exit code
  $final = 0
  foreach ($c in @($code1,$code2,$code3,$code4)) { if ($c -gt $final) { $final = $c } }
  if ($final -eq 0) {
    Write-Host "[INFO] All done." -ForegroundColor Green
  } else {
    Write-Host "[WARN] Flow completed with non-zero exit(s). Final code: $final" -ForegroundColor Yellow
  }
  exit $final
}
finally {
  # --- TIMING: END (always prints) ---
  $scriptEnd = Get-Date
  $elapsed = $scriptEnd - $scriptStart

  Write-Host ""
  Write-Host "==================== RUN TIMING ====================" -ForegroundColor Cyan
  Write-Host ("Start : {0}" -f $scriptStart.ToString("yyyy-MM-dd HH:mm:ss"))
  Write-Host ("End   : {0}" -f $scriptEnd.ToString("yyyy-MM-dd HH:mm:ss"))
  Write-Host ("Total : {0:hh\:mm\:ss}" -f $elapsed)
  Write-Host "====================================================" -ForegroundColor Cyan

  # Export timing ONLY after cleanup step happens
  if ($cleanupDone) {
    $out = @()
    $out += "==================== RUN TIMING ===================="
    $out += ("Start : {0}" -f $scriptStart.ToString("yyyy-MM-dd HH:mm:ss"))
    $out += ("End   : {0}" -f $scriptEnd.ToString("yyyy-MM-dd HH:mm:ss"))
    $out += ("Total : {0:hh\:mm\:ss}" -f $elapsed)
    $out += "----------------------------------------------------"
    $out += ("my-script.txt exit : {0}" -f $code1)
    $out += ("ssci.txt exit     : {0}" -f $code2)
    $out += ("combine exit      : {0}" -f $code3)
    $out += ("cleanup exit      : {0}" -f $code4)
    $out += "===================================================="

    $out | Out-File -FilePath $timingFile -Encoding UTF8 -Force
    Write-Host ("[INFO] Timing exported to: {0}" -f $timingFile) -ForegroundColor Cyan
  }
}
