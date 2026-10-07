@echo off
rem README capture for a scheduled task (/it puts it on the interactive desktop):
rem   run-shoot.cmd <shot list> <staging root> <checkout>
rem shoot.js runs from the checkout (it needs stage\stage-root.js and launch.js's record for the root);
rem playwright-core and upng-js come from this runner folder's own install.
set "CCC_STAGE_ROOT=%~2"
set "NODE_PATH=%~dp0node_modules"
node "%~3\scripts\readme-shots\shoot.js" "%~1" > "%~dp0shoot.out" 2>&1
