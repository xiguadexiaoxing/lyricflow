@echo off
setlocal
cd /d "%~dp0"

if defined ELECTRON_RUN_AS_NODE (
  echo [LyricFlow] NOTE: ELECTRON_RUN_AS_NODE is set, so this window is from the
  echo            harness sandbox. The web server will run, but player detection
  echo            may not see desktop windows. Prefer double-clicking this file
  echo            from Windows Explorer.
  echo.
)
set "ELECTRON_RUN_AS_NODE="

if not exist "node_modules\ws\package.json" (
  echo [LyricFlow] Dependencies are missing.
  echo            Run: npm install
  echo.
  pause
  exit /b 1
)

echo [LyricFlow] Web server starting...
echo            Lyrics : http://localhost:3721
echo            Console: http://localhost:3721/gui
echo            LAN address is printed below.
echo.
node server.js
set "ERR=%errorlevel%"

if not "%ERR%"=="0" (
  echo.
  echo [LyricFlow] Server exited with code %ERR%.
  echo.
  pause
)