@echo off
setlocal
chcp 65001 >nul

REM Go to the folder where this .bat file is located
cd /d "%~dp0"

start "" /wait powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\run-all.ps1"
endlocal
exit /b 0

