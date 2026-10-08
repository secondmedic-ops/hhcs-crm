@echo off
rem Replace the Cloudflare deploy key in GitHub (checked with Cloudflare first), then re-run the failed deploy.
cd /d "%~dp0"
node scripts\cloudflare-token.mjs
pause
