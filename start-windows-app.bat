@echo off
setlocal

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Please install Node.js, then run this file again.
  pause
  exit /b 1
)

set "PACKAGED_EXE=dist-electron\win-unpacked\Sonic Topography.exe"

if exist "%PACKAGED_EXE%" (
  echo Found packaged app, starting Sonic Topography...
  start "" "%PACKAGED_EXE%"
  exit /b 0
)

if not exist node_modules (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

echo Starting Electron development mode...
call npm run electron:dev
if errorlevel 1 (
  pause
  exit /b 1
)

pause
