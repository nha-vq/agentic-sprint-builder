@echo off
setlocal

cd /d "%~dp0"

if not exist ".env.local" (
  echo Creating .env.local from .env.example...
  copy ".env.example" ".env.local" >nul
)

if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "if (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>nul
if not errorlevel 1 (
  echo Agentic Sprint Builder is already running at http://localhost:3000
  start "" "http://localhost:3000"
  exit /b 0
)

echo Starting Agentic Sprint Builder at http://localhost:3000
call npm run dev -- -p 3000
