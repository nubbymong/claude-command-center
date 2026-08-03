@echo off
setlocal
REM ============================================================================
REM ccc - launch AI Code Conductor (DEV) alongside a running PROD install.
REM
REM Distributed WITH the repo (scripts\ccc.cmd) so its data-isolation / seed /
REM cleanup logic is versioned and updates with the code. Your PATH `ccc` is a
REM thin shim that forwards here (see the shim in %APPDATA%\npm\ccc.cmd).
REM
REM   ccc                     start dev (reuse existing dev data), vision ON
REM   ccc --seed              copy PROD's CONFIG into the dev data dir first
REM   ccc --clean             wipe the dev data dir first (fresh; wizard skipped)
REM   ccc -nv | --no-vision   vision browser auto-launch OFF
REM Flags combine, e.g.  ccc --clean --seed -nv
REM
REM Dev is fully isolated from prod: its OWN data dir (CCC_DEV_DATA_DIR) and
REM separate MCP/CDP/hooks/vite ports. The window auto-closes on exit and every
REM dev process is killed (electron, vite, MCP/update servers, headless Chrome),
REM so nothing leaks between runs or into your prod instance.
REM ============================================================================

if /I "%~1"=="__run" goto :run

REM ---- launcher: resolve repo + flags, refuse a 2nd dev, spawn the window ----
for %%I in ("%~dp0..") do set "CCC_REPO=%%~fI"
set "CCC_DEV_DATA_DIR=%LOCALAPPDATA%\Claude Command Center\dev"
set "CCC_DISABLE_VISION="
set "CCC_SEED="
set "CCC_CLEAN="
:parse
if "%~1"=="" goto parsed
if /I "%~1"=="-nv"         set "CCC_DISABLE_VISION=1"
if /I "%~1"=="--no-vision" set "CCC_DISABLE_VISION=1"
if /I "%~1"=="--seed"      set "CCC_SEED=1"
if /I "%~1"=="--clean"     set "CCC_CLEAN=1"
shift
goto parse
:parsed

REM Refuse a second dev instance (it would collide on the dev data dir + ports).
powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 5173 -State Listen -EA SilentlyContinue) { exit 9 }"
if errorlevel 9 (
  echo [ccc] A dev instance is already running ^(port 5173 in use^). Close it first.
  echo.
  pause
  exit /b 1
)

start "AI Code Conductor (dev)" cmd /c "%~f0" __run
exit /b 0

:run
REM Re-derive (robust if __run is invoked directly); env is also inherited.
for %%I in ("%~dp0..") do set "CCC_REPO=%%~fI"
if not defined CCC_DEV_DATA_DIR set "CCC_DEV_DATA_DIR=%LOCALAPPDATA%\Claude Command Center\dev"
if not exist "%CCC_REPO%\package.json" (
  echo [ccc] Repo not found at "%CCC_REPO%"
  echo.
  pause
  goto :eof
)
cd /d "%CCC_REPO%"
title AI Code Conductor (dev)

set "CCC_BRANCH=?"
for /f "delims=" %%b in ('git rev-parse --abbrev-ref HEAD 2^>nul') do set "CCC_BRANCH=%%b"

echo [ccc] AI Code Conductor (dev)
echo [ccc]   repo:     %CCC_REPO%
echo [ccc]   branch:   %CCC_BRANCH%
echo [ccc]   dev data: %CCC_DEV_DATA_DIR%
if defined CCC_DISABLE_VISION echo [ccc]   vision:   DISABLED
if defined CCC_CLEAN echo [ccc]   --clean:  wiping dev data dir
if defined CCC_SEED  echo [ccc]   --seed:   copying prod CONFIG into dev
echo.

REM --- clean / seed the dev data dir BEFORE the log dir is created ---
if defined CCC_CLEAN powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Test-Path $env:CCC_DEV_DATA_DIR) { Remove-Item -LiteralPath $env:CCC_DEV_DATA_DIR -Recurse -Force -EA SilentlyContinue; Write-Host '[ccc] dev data dir wiped.' }"
if defined CCC_SEED powershell -NoProfile -ExecutionPolicy Bypass -Command "$prodRes=(Get-ItemProperty 'HKCU:\Software\Claude Command Center' -EA SilentlyContinue).ResourcesDirectory; if (-not $prodRes) { $prodRes = Join-Path $env:LOCALAPPDATA 'Claude Command Center\resources' }; $src = Join-Path $prodRes 'CONFIG'; $dst = Join-Path $env:CCC_DEV_DATA_DIR 'resources\CONFIG'; if (Test-Path $src) { New-Item -ItemType Directory -Force -Path $dst | Out-Null; Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force -EA SilentlyContinue; Write-Host ('[ccc] seeded dev CONFIG from ' + $src) } else { Write-Host ('[ccc] --seed: prod CONFIG not found at ' + $src) }"

REM --- log setup (DEV-scoped, under the dev data root) ---
set "CCC_LOGDIR=%CCC_DEV_DATA_DIR%\dev-logs"
if not exist "%CCC_LOGDIR%" mkdir "%CCC_LOGDIR%" 2>nul
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set "TS=%%i"
set "CCC_LOGFILE=%CCC_LOGDIR%\ccc-dev-%TS%.log"
> "%CCC_LOGDIR%\ccc-dev-latest.txt" echo %CCC_LOGFILE%
echo [ccc]   log:      %CCC_LOGFILE%
echo.

REM --- run dev, tee to log, and ALWAYS kill the dev process set on exit ---
REM   * headless vision Chrome -- matched by --user-data-dir=...chrome-debug-9322
REM   * dev port holders       -- 5173 vite, 9847 update, 19433 MCP, 9322 CDP, 19434 hooks
REM   * dev electron           -- matched by the hyphenated repo path in the exe path
> "%CCC_LOGFILE%" echo [ccc] repo=%CCC_REPO% branch=%CCC_BRANCH% vision=%CCC_DISABLE_VISION% seed=%CCC_SEED% clean=%CCC_CLEAN% ts=%TS%
powershell -NoProfile -ExecutionPolicy Bypass -Command "$sw=[System.IO.StreamWriter]::new('%CCC_LOGFILE%',$true);$sw.AutoFlush=$true;try{ npm run dev 2>&1 | ForEach-Object { Write-Host $_; $sw.WriteLine([string]$_) } } finally { $ErrorActionPreference='SilentlyContinue'; Write-Host '[ccc] cleaning up dev processes...'; $sw.WriteLine('[ccc] cleaning up dev processes...'); for ($i=0; $i -lt 6; $i++) { foreach ($p in 5173,9847,19433,9322,19434) { Get-NetTCPConnection -LocalPort $p -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force } }; $c = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -match 'chrome-debug-9322' }; $e = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'electron.exe' -and $_.ExecutablePath -match 'claude-command-center' }; $all = @($c) + @($e); if (-not $all) { break }; $all | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Start-Sleep -Milliseconds 500 }; $left = (Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -match 'chrome-debug-9322' } | Measure-Object).Count; $sw.WriteLine('[ccc] cleanup done; chrome-debug-9322 remaining=' + $left); Write-Host ('[ccc] cleanup done; chrome-debug-9322 remaining=' + $left); $sw.Close() }"

goto :eof
