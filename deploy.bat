@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "APP_NAME=qsc-backend"
set "NODE_ENV=production"

echo ==============================
echo       QSC BACKEND DEPLOY
echo ==============================
echo.

echo [1/4] Pulling latest code...
git pull
if errorlevel 1 goto :fail

echo.
echo [2/4] Installing dependencies...
call npm install
if errorlevel 1 goto :fail

echo.
echo [3/4] Building backend...
call npm run build
if errorlevel 1 goto :fail

echo.
echo [4/4] Restarting backend...
call npx pm2 describe "%APP_NAME%" >nul 2>&1
if errorlevel 1 (
  call npx pm2 start ecosystem.config.cjs
) else (
  call npx pm2 restart "%APP_NAME%" --update-env
)
if errorlevel 1 goto :fail

call npx pm2 save >nul 2>&1

echo.
echo ==============================
echo       DEPLOY OK
echo ==============================
call npx pm2 status "%APP_NAME%"
exit /b 0

:fail
echo.
echo ==============================
echo       DEPLOY FAILED
echo ==============================
echo Current running version was NOT restarted.
exit /b 1
