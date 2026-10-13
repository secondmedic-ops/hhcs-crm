@echo off
cd /d "%~dp0"
title CareDesk CRM - WhatsApp Central Bridge
echo ================================================================
echo   CareDesk CRM - Central WhatsApp Bridge
echo   NOTE: The WhatsApp bridge runs centrally on the host/server.
echo   You DO NOT need to run this on individual agent PCs!
echo   All computers access live WhatsApp chats automatically.
echo ================================================================
node scripts/ensure-bridge.mjs
echo Central bridge is running in background. You can close this window.
timeout /t 5 >nul

