@echo off
setlocal
cd /d "%~dp0"

if defined ELECTRON_RUN_AS_NODE (
  echo [LyricFlow] WARNING: ELECTRON_RUN_AS_NODE is set in this shell.
  echo            That means this window was opened by the harness sandbox,
  echo            which cannot start Electron. Close it and double-click this
  echo            file in Windows Explorer instead.
  echo.
)
set "ELECTRON_RUN_AS_NODE="

if not exist "node_modules\electron\dist\electron.exe" (
  echo [LyricFlow] Electron runtime is missing.
  echo            Run: npm install
  echo.
  pause
  exit /b 1
)

echo [LyricFlow] Starting desktop console...
echo.
"node_modules\electron\dist\electron.exe" "."
set "ERR=%errorlevel%"

if not "%ERR%"=="0" (
  echo.
  echo [LyricFlow] Electron exited with code %ERR%.
  echo.
  echo If the code looks like 0x80000003 or 0xC0000005, the shell was restricted:
  echo open File Explorer, go to this folder, and double-click start-gui.bat.
  echo For the browser-only version use start-web.bat.
  echo.
  if exist "%TEMP%\lyricflow-main.log" (
    echo ---------- startup log ----------
    powershell -NoProfile -Command "Get-Content -LiteralPath '%TEMP%\lyricflow-main.log' -Tail 15"
    echo ---------------------------------
  ) else (
    echo No startup log was written, so Electron crashed before running main.js.
    echo This confirms the shell/host is blocking the GUI, not an app error.
  )
  echo.
  pause
)