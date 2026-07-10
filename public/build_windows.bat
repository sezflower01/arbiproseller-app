
@echo off
echo ArbiProSeller C: Drive Installer
echo ===============================
echo.

REM Check for admin privileges
net session >nul 2>&1
if %errorLevel% neq 0 (
  echo This script requires administrator privileges.
  echo Please right-click on this file and select "Run as administrator"
  pause
  exit /b 1
)

echo Checking for ArbiProSeller_Installer.zip in current directory...
if not exist "ArbiProSeller_Installer.zip" (
  echo ERROR: ArbiProSeller_Installer.zip not found in current directory.
  echo Please make sure the ZIP file is in the same folder as this batch file.
  pause
  exit /b 1
)

echo Creating installation directory...
if not exist "C:\ArbiProSeller" mkdir "C:\ArbiProSeller"

echo Extracting files to C:\ArbiProSeller...
powershell -command "Expand-Archive -Path 'ArbiProSeller_Installer.zip' -DestinationPath 'C:\ArbiProSeller' -Force"

echo Creating desktop shortcut...
powershell -command "$WshShell = New-Object -ComObject WScript.Shell; $Shortcut = $WshShell.CreateShortcut($env:USERPROFILE + '\Desktop\ArbiProSeller.lnk'); $Shortcut.TargetPath = 'C:\ArbiProSeller\Debug\ArbiProSeller.exe'; $Shortcut.Save()"

echo.
echo Installation complete!
echo ArbiProSeller has been installed to C:\ArbiProSeller
echo A shortcut has been created on your desktop
echo.
echo Please launch ArbiProSeller from your desktop shortcut
echo or navigate to C:\ArbiProSeller\Debug and run ArbiProSeller.exe
echo.
pause
