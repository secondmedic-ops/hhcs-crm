@echo off
setlocal
title CareDesk CRM - local test (safe test database)
cd /d "%~dp0"

echo ============================================================
echo  CareDesk CRM local test
echo  API     : http://localhost:8787  (the same Worker code as
echo            the live site, on an in-memory TEST database with
echo            a week of sample data, wiped when you close it.
echo            The live Supabase data is NOT touched. Login is
echo            off: pick any role on the start screen.)
echo  Frontend: http://localhost:3000
echo  Close the two new windows to stop.
echo ============================================================

node scripts\retire.mjs
set "BACKEND_URL=http://localhost:8787"

start "CareDesk API (TEST database)" /D "%~dp0cloudflare" cmd /k "npm install --no-audit --no-fund --loglevel=error && node test\local.mjs"
start "CareDesk frontend" /D "%~dp0" cmd /k "npm install --no-audit --no-fund --loglevel=error && npm run dev"

echo.
echo Waiting for both to start (about a minute the first time)...
node -e "setTimeout(()=>{},45000)"
start "" http://localhost:3000
echo Opened http://localhost:3000 - the top bar must say LOCAL TEST.
echo If it says DEMO, wait until the API window shows
echo "Ready on http://127.0.0.1:8787", then refresh the page.
echo.
pause
