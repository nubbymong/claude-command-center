@echo off
rem AI Code Conductor: the Codex hook forwarder (P3.10), for Codex on Windows.
rem Runs the forwarder beside this file; without node it does nothing, and it always exits 0.
rem It resolves node from the PATH, the same way from any start folder.
setlocal
set "NoDefaultCurrentDirectoryInExePath=1"
where /q $PATH:node >nul 2>nul || exit /b 0
node "%~dp0ccc-codex-hook.js"
exit /b 0
