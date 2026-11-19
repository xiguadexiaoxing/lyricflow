@echo off
setlocal
cd /d "%~dp0portable\LyricFlow"

if not exist "LyricFlow.exe" (
  echo [LyricFlow] portable\LyricFlow\LyricFlow.exe not found.
  pause
  exit /b 1
)

echo [LyricFlow] Starting portable build (embedded runtime, updated app)...
echo.
"LyricFlow.exe"
set "ERR=%errorlevel%"

if not "%ERR%"=="0" (
  echo.
  echo [LyricFlow] Exited with code %ERR%.
  if exist "%TEMP%\lyricflow-main.log" (
    echo ---------- startup log ----------
    type "%TEMP%\lyricflow-main.log"
    echo ---------------------------------
  ) else (
    echo No startup log exists; Electron failed before loading the app.
  )
  pause
)