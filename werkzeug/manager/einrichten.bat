@echo off
REM Richtet den Punktwolken-Manager unter Windows ein (einmalig, und nach Updates).
REM Braucht: Python 3 (winget install Python.Python.3.12), Node.js (winget install OpenJS.NodeJS.LTS),
REM          rclone (winget install Rclone.Rclone) mit dem Remote "r2:".
cd /d "%~dp0"
where py >nul 2>nul || (echo Python fehlt: winget install Python.Python.3.12 & pause & exit /b 1)
where npm >nul 2>nul || (echo Node.js fehlt: winget install OpenJS.NodeJS.LTS & pause & exit /b 1)
if not exist ".venv\Scripts\python.exe" py -3 -m venv .venv
".venv\Scripts\python.exe" -m pip install -q --upgrade pip
".venv\Scripts\python.exe" -m pip install -q -r requirements.txt
call npm install --no-audit --no-fund --silent
echo.
echo Fertig. Start mit Doppelklick auf Punktwolken-Manager.bat
pause
