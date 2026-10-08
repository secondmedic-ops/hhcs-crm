@echo off
rem ONE button for every change: commits everything, pushes, and watches the pipeline
rem (checks -> database -> backend + frontend -> live smoke test). Prints LIVE or the failed step.
cd /d "%~dp0"
set /p MSG=What did you change? 
node scripts\ship.mjs "%MSG%"
pause
