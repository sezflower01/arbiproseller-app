@echo off
title Stop ArbiProSeller Print Client
echo.
echo Stopping all ArbiProSeller Print Client processes...
echo.

taskkill /F /IM ArbiProSellerPrintClient.exe 2>nul
if %ERRORLEVEL%==0 (
  echo  - Killed ArbiProSellerPrintClient.exe
) else (
  echo  - No ArbiProSellerPrintClient.exe was running.
)

echo.
echo Checking port 7777...
set "FOUND=0"
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":7777" ^| findstr "LISTENING"') do (
  set "FOUND=1"
  echo  - Killing PID %%a holding port 7777
  taskkill /F /PID %%a 2>nul
)
if "%FOUND%"=="0" echo  - Port 7777 is free.

echo.
echo Done. You can now run Start-ArbiProSellerPrintClient.bat again.
echo.
pause
