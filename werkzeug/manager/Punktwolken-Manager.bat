@echo off
REM Startet den Punktwolken-Manager (Doppelklick). pythonw = ohne schwarzes Konsolenfenster.
cd /d "%~dp0"
if not exist ".venv\Scripts\pythonw.exe" (
    echo Noch nicht eingerichtet: einmal einrichten.bat ausfuehren.
    pause
    exit /b 1
)
start "" ".venv\Scripts\pythonw.exe" "manager.py"
