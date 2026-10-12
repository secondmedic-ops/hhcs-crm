@echo off
cd /d "%~dp0"
title CareDesk CRM - WhatsApp QR Bridge
echo ================================================================
echo   CareDesk CRM - WhatsApp QR Bridge
echo   Open https://hhcs-caredesk.secondmedic.workers.dev/whatsapp
echo   and click "Scan QR to login" to scan from your phone.
echo ================================================================
node scripts/whatsapp-bridge.mjs
pause

