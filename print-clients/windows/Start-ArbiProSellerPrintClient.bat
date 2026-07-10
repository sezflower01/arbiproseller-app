@echo off
setlocal
cd /d "%~dp0"
title ArbiProSeller Print Client

set "LOGDIR=%LOCALAPPDATA%\ArbiProSeller\PrintClient"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set "LOGFILE=%LOGDIR%\launcher.log"

echo ArbiProSeller Print Client launcher started > "%LOGFILE%"
echo Date/time: %DATE% %TIME% >> "%LOGFILE%"
echo Folder: %CD% >> "%LOGFILE%"
echo. >> "%LOGFILE%"

echo ArbiProSeller Print Client
echo.
echo This window must stay open while printing labels.
echo.

echo Stopping any existing ArbiProSellerPrintClient.exe processes...
echo Stopping any existing ArbiProSellerPrintClient.exe processes... >> "%LOGFILE%"
taskkill /F /IM ArbiProSellerPrintClient.exe >> "%LOGFILE%" 2>&1
timeout /t 2 /nobreak >nul

echo Freeing port 7777 if held by another process...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":7777" ^| findstr "LISTENING"') do (
  echo Killing PID %%a holding port 7777 >> "%LOGFILE%"
  taskkill /F /PID %%a >> "%LOGFILE%" 2>&1
)
timeout /t 1 /nobreak >nul

echo Starting local print service on http://127.0.0.1:7777 ...
echo.

if not exist "ArbiProSellerPrintClient.exe" (
  echo ERROR: ArbiProSellerPrintClient.exe was not found in this folder.
  echo ERROR: ArbiProSellerPrintClient.exe was not found in this folder. >> "%LOGFILE%"
  echo.
  echo Put this launcher in the same folder as ArbiProSellerPrintClient.exe.
  echo Log file: %LOGFILE%
  pause
  exit /b 1
)

"%CD%\ArbiProSellerPrintClient.exe" >> "%LOGFILE%" 2>&1
set "EXITCODE=%ERRORLEVEL%"

echo.
echo The print client stopped or failed to start. Exit code: %EXITCODE%
echo Exit code: %EXITCODE% >> "%LOGFILE%"
echo.
echo Log file: %LOGFILE%
echo.
echo Last log lines:
echo ----------------------------------------
type "%LOGFILE%"
echo ----------------------------------------
echo.
echo Press any key to close this window.
pause >nul
exit /b %EXITCODE%
