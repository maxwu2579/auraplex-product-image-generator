@echo off
rem Double-click to stop the Auraplex Image Tool services started from this folder.
start "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0launcher\Stop-Auraplex.ps1"
