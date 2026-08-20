@echo off
cd /d "%~dp0"
start "Claude Chat Manager" cmd /k node server.js
timeout /t 2 /nobreak >nul
start "" http://localhost:5173
