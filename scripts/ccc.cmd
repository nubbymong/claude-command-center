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
REM   ccc --seed              copy PROD's CONFIG only into the dev data dir first
REM   ccc --seed-accounts     copy PROD's signed-in account credentials into dev
REM   ccc --clean             wipe the dev data dir first (fresh; wizard skipped)
REM   ccc -nv | --no-vision   vision browser auto-launch OFF
REM Flags combine, e.g.  ccc --clean --seed --seed-accounts -nv
REM
REM --seed and --seed-accounts are SEPARATE because they copy different things and
REM carry different risk. CONFIG is settings. Accounts are live OAuth tokens, and
REM copying them leaves dev and prod sharing one refresh token -- whichever
REM refreshes first invalidates the other. See scripts\seed-dev-accounts.mjs and
REM issue #257.
REM
REM Dev is STRONGLY isolated from prod: its OWN data dir (CCC_DEV_DATA_DIR)
REM carries config, sessions, transcripts, logs, account profiles and the
REM claude.ai partitions, and it uses separate MCP/CDP/hooks/vite ports. A few
REM things are still shared -- the app's userData (source-hash.json), the HKCU
REM registry keys, and the global ~/.claude home for any spawn not scoped to a
REM profile -- none of which can destroy a prod login. See
REM docs\dev-alongside-prod.md for the exact isolation table. The window
REM auto-closes on exit and every dev process is killed (electron, vite,
REM MCP/update servers, headless Chrome), so nothing leaks between runs or into
REM your prod instance.
REM ============================================================================

if /I "%~1"=="__run" goto :run

REM ---- launcher: resolve repo + flags, refuse a 2nd dev, spawn the window ----
for %%I in ("%~dp0..") do set "CCC_REPO=%%~fI"
REM CAPTURE OUR OWN PATH BEFORE THE PARSE LOOP. `shift` shifts %0 as well as
REM %1..%9, so after parsing even one flag, `%~f0` is no longer this script -- it
REM is the flag, resolved against the current directory. The `start` below then
REM launched "<cwd>\--seed-accounts", the child cmd could not find it and exited
REM instantly, and the window vanished before the log file was ever created.
REM
REM That broke EVERY flag (--seed, --seed-accounts, --clean, -nv) while plain
REM `ccc` worked, because with no arguments the loop exits before it ever shifts.
REM The tell was in every log header ever written: `vision= seed= clean=`, empty
REM in runs where a flag had been passed.
set "CCC_SELF=%~f0"
set "CCC_DEV_DATA_DIR=%LOCALAPPDATA%\Claude Command Center\dev"
set "CCC_DISABLE_VISION="
set "CCC_SEED="
set "CCC_SEED_ACCOUNTS="
set "CCC_CLEAN="
:parse
if "%~1"=="" goto parsed
if /I "%~1"=="-nv"             set "CCC_DISABLE_VISION=1"
if /I "%~1"=="--no-vision"     set "CCC_DISABLE_VISION=1"
if /I "%~1"=="--seed"          set "CCC_SEED=1"
if /I "%~1"=="--seed-accounts" set "CCC_SEED_ACCOUNTS=1"
if /I "%~1"=="--clean"         set "CCC_CLEAN=1"
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

start "AI Code Conductor (dev)" cmd /c "%CCC_SELF%" __run
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
if defined CCC_SEED_ACCOUNTS echo [ccc]   --seed-accounts: copying prod account credentials into dev
echo.

REM --- clean the dev data dir BEFORE the log dir is created ---
REM FAILS LOUDLY ON A PARTIAL WIPE. Since #261 moved Electron's sessionData under
REM the dev data root, `--clean` now deletes a LIVE session store if an instance is
REM using this data dir. Chromium holds locks on LevelDB and Network files, so
REM Remove-Item leaves those behind -- and swallowing that (the old
REM `-EA SilentlyContinue` with no check) launched straight into a half-deleted
REM profile holding a stale-but-live claude.ai session. The port-5173 refusal above
REM covers the usual case, but it races an instance that has not bound the port yet
REM and does not help when CCC_DEV_DATA_DIR is pointed by hand at a dir another
REM instance owns. So: attempt the wipe, then VERIFY it is gone; if not, stop rather
REM than run against wreckage.
if defined CCC_CLEAN (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$d=$env:CCC_DEV_DATA_DIR; if (Test-Path $d) { Remove-Item -LiteralPath $d -Recurse -Force -EA SilentlyContinue; if (Test-Path $d) { Write-Host '[ccc] --clean: could NOT fully wipe the dev data dir -- files are locked, which means an instance is still using it:'; Write-Host ('[ccc]   ' + $d); exit 3 } else { Write-Host '[ccc] dev data dir wiped.' } }"
  if errorlevel 3 (
    echo.
    echo [ccc] Refusing to launch against a half-deleted data dir. Close any running
    echo [ccc] dev instance ^(or one sharing this CCC_DEV_DATA_DIR^) and try again.
    echo.
    pause
    goto :eof
  )
)

REM --- log setup (DEV-scoped, under the dev data root) ---
REM DELIBERATELY BEFORE THE SEED STEPS. It used to come after them, so anything
REM that went wrong while seeding happened with nowhere to write it: this window
REM is a `cmd /c` that closes the moment the batch ends, so the error went with
REM it and left no log behind to diagnose from. Only --clean has to run first,
REM because it wipes the directory the log lives in.
set "CCC_LOGDIR=%CCC_DEV_DATA_DIR%\dev-logs"
if not exist "%CCC_LOGDIR%" mkdir "%CCC_LOGDIR%" 2>nul
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set "TS=%%i"
set "CCC_LOGFILE=%CCC_LOGDIR%\ccc-dev-%TS%.log"
> "%CCC_LOGDIR%\ccc-dev-latest.txt" echo %CCC_LOGFILE%
REM Write the header HERE, with `>`, so it is the line that creates the file.
REM It used to be written just before `npm run dev` -- which truncated whatever
REM the seed steps had already appended, silently discarding exactly the output
REM that made a failed seed diagnosable.
> "%CCC_LOGFILE%" echo [ccc] repo=%CCC_REPO% branch=%CCC_BRANCH% vision=%CCC_DISABLE_VISION% seed=%CCC_SEED% seedAccounts=%CCC_SEED_ACCOUNTS% clean=%CCC_CLEAN% ts=%TS%
echo [ccc]   log:      %CCC_LOGFILE%
echo.

REM --- seed AFTER the log exists, teed so the console AND the log both get it ---
if defined CCC_SEED powershell -NoProfile -ExecutionPolicy Bypass -Command "$prodRes=(Get-ItemProperty 'HKCU:\Software\Claude Command Center' -EA SilentlyContinue).ResourcesDirectory; if (-not $prodRes) { $prodRes = Join-Path $env:LOCALAPPDATA 'Claude Command Center\resources' }; $src = Join-Path $prodRes 'CONFIG'; $dst = Join-Path $env:CCC_DEV_DATA_DIR 'resources\CONFIG'; if (Test-Path $src) { New-Item -ItemType Directory -Force -Path $dst | Out-Null; Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force -EA SilentlyContinue; Write-Host ('[ccc] seeded dev CONFIG from ' + $src) } else { Write-Host ('[ccc] --seed: prod CONFIG not found at ' + $src) }" 2>&1 | powershell -NoProfile -Command "$sw=[System.IO.StreamWriter]::new($env:CCC_LOGFILE,$true);$sw.AutoFlush=$true;try{ $input | ForEach-Object { Write-Host $_; $sw.WriteLine([string]$_) } } finally { $sw.Close() }"

REM Accounts are seeded by a versioned script rather than an inline one-liner: it
REM asserts every write stays under the dev data dir, backs up what it replaces,
REM and prints a before/after identity table. Runs here, before electron starts,
REM because the app rewrites these files from memory on exit.
if defined CCC_SEED_ACCOUNTS node "%CCC_REPO%\scripts\seed-dev-accounts.mjs" 2>&1 | powershell -NoProfile -Command "$sw=[System.IO.StreamWriter]::new($env:CCC_LOGFILE,$true);$sw.AutoFlush=$true;try{ $input | ForEach-Object { Write-Host $_; $sw.WriteLine([string]$_) } } finally { $sw.Close() }"
if defined CCC_SEED_ACCOUNTS echo.

REM --- run dev, tee to log, and ALWAYS kill the dev process set on exit ---
REM   * headless vision Chrome -- matched by --user-data-dir=...chrome-debug-9322
REM   * dev port holders       -- 5173 vite, 9847 update, 19433 MCP, 9322 CDP, 19434 hooks
REM   * dev electron           -- matched by the hyphenated repo path in the exe path
powershell -NoProfile -ExecutionPolicy Bypass -Command "$sw=[System.IO.StreamWriter]::new('%CCC_LOGFILE%',$true);$sw.AutoFlush=$true;try{ npm run dev 2>&1 | ForEach-Object { Write-Host $_; $sw.WriteLine([string]$_) } } finally { $ErrorActionPreference='SilentlyContinue'; Write-Host '[ccc] cleaning up dev processes...'; $sw.WriteLine('[ccc] cleaning up dev processes...'); for ($i=0; $i -lt 6; $i++) { foreach ($p in 5173,9847,19433,9322,19434) { Get-NetTCPConnection -LocalPort $p -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force } }; $c = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -match 'chrome-debug-9322' }; $e = Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'electron.exe' -and $_.ExecutablePath -match 'claude-command-center' }; $all = @($c) + @($e); if (-not $all) { break }; $all | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Start-Sleep -Milliseconds 500 }; $left = (Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'chrome.exe' -and $_.CommandLine -match 'chrome-debug-9322' } | Measure-Object).Count; $sw.WriteLine('[ccc] cleanup done; chrome-debug-9322 remaining=' + $left); Write-Host ('[ccc] cleanup done; chrome-debug-9322 remaining=' + $left); $sw.Close() }"

REM NEVER CLOSE ON A FAILURE. This window is a `cmd /c`, so it disappears the
REM instant the batch ends -- taking the reason with it. "the window won't stay
REM open and no GUI shows" is undiagnosable from the outside precisely because
REM the error was never written down anywhere. Hold the window on a non-zero
REM exit and say where the log is.
if errorlevel 1 (
  echo.
  echo [ccc] dev exited with a NON-ZERO status.
  echo [ccc] log: %CCC_LOGFILE%
  echo.
  pause
)

goto :eof
