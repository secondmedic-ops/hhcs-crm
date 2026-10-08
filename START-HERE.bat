@echo off
rem One-time setup for the one-push pipeline. Safe to run again.
cd /d "%~dp0"
node scripts\setup.mjs
pause
