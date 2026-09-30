@echo off
rem Start a benchmark using run.json. This makes model calls and uses provider quota.
pwsh.exe -NoProfile -File "%~dp0run.ps1" -Execute %*
exit /b %ERRORLEVEL%
