@echo off
title ResQTech One-Click Launcher
echo ===================================================
echo             ResQTech One-Click Launcher            
echo ===================================================
echo.

:: Check if venv exists
if not exist "venv\Scripts\python.exe" (
    echo [WARNING] Virtual environment 'venv' not found in this directory!
    echo Creating virtual environment...
    python -m venv venv
    if errorlevel 1 (
        echo [ERROR] Failed to create virtual environment. Please install Python 3.10 or 3.11.
        pause
        exit /b
    )
)

echo [1/3] Activating virtual environment...
call venv\Scripts\activate

echo [2/3] Verifying and installing dependencies...
python -m pip install -r backend\requirements.txt
if errorlevel 1 (
    echo [ERROR] Failed to install requirements.
    pause
    exit /b
)

echo [3/3] Starting ResQTech Application...
echo The application will be available at: http://127.0.0.1:8000
echo.
echo Opening browser...
start http://127.0.0.1:8000

python backend\app.py
pause
