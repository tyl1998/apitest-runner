@echo off
rem Windows wrapper: same as "powershell -File start.ps1" with all arguments forwarded.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*