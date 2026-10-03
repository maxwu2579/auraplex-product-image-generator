@echo off
rem Double-click to start Auraplex Image Tool (starts services if needed and opens the app).
start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0launcher\Start-Auraplex.ps1"
