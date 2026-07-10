@echo off
REM ============================================================
REM Build a single self-contained .exe for the print client.
REM Output: print-clients\windows\dist\ArbiProSellerPrintClient.exe
REM Requires: .NET 8 SDK installed on the machine doing the build
REM           (end users do NOT need .NET — the exe is self-contained)
REM ============================================================

setlocal
cd /d "%~dp0"

echo.
echo === Publishing self-contained Windows print client ===
echo.

dotnet publish ArbiProSeller.PrintClient.csproj ^
  -c Release ^
  -r win-x64 ^
  --self-contained true ^
  /p:PublishSingleFile=true ^
  /p:IncludeNativeLibrariesForSelfExtract=true ^
  /p:EnableCompressionInSingleFile=true ^
  -o dist

if errorlevel 1 (
  echo.
  echo BUILD FAILED. Make sure .NET 8 SDK is installed: https://dotnet.microsoft.com/download
  exit /b 1
)

echo.
echo === Done. ===
echo Single-file exe created at:
echo   %cd%\dist\ArbiProSellerPrintClient.exe
echo.
echo Double-click it on any Windows 10/11 x64 machine to start the print client.
echo.
endlocal
