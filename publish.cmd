@echo off
rem ---------------------------------------------------------------------------
rem dsh-codex-effort-slider-ultra - one click publish to GitHub (Windows entry)
rem
rem The real logic lives in publish.ps1 next to this file. This wrapper only:
rem   1. locates publish.ps1
rem   2. prefers pwsh (PowerShell 7) and falls back to powershell.exe (5.1)
rem   3. forwards every argument and returns the real exit code
rem
rem Usage:
rem   publish.cmd                    double click / interactive default flow
rem   publish.cmd -Help              show help
rem   publish.cmd -NoPush            local steps only (init/add/commit/origin)
rem   publish.cmd -Token ghp_xxxx    create the repo through the GitHub REST API
rem
rem Notes: messages from publish.ps1 are Chinese; this wrapper stays ASCII so it
rem renders correctly in any console code page.
rem ---------------------------------------------------------------------------
setlocal
set "SCRIPT=%~dp0publish.ps1"
if not exist "%SCRIPT%" (
  echo [x] publish.ps1 not found next to this file.
  if "%~1"=="" pause
  exit /b 1
)

where pwsh.exe >nul 2>nul
if not errorlevel 1 goto use_pwsh
where pwsh >nul 2>nul
if not errorlevel 1 goto use_pwsh
goto use_windows_powershell

:use_pwsh
pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
goto done

:use_windows_powershell
where powershell.exe >nul 2>nul
if errorlevel 1 (
  echo [x] Neither pwsh nor powershell.exe was found on this machine.
  if "%~1"=="" pause
  exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*

:done
set "CODE=%ERRORLEVEL%"
if "%CODE%"=="0" goto finish
echo.
echo [x] publish failed with exit code %CODE%, see the messages above.
:finish
if "%~1"=="" pause
exit /b %CODE%
