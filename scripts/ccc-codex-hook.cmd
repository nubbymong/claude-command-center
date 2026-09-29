@echo off
rem AI Code Conductor: the Codex hook forwarder (P3.10), for Codex on Windows.
rem Runs the forwarder beside this file; without node it does nothing, and it always exits 0.
where node >nul 2>nul || exit /b 0
node "%~dp0ccc-codex-hook.js"
exit /b 0
