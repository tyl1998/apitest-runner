@echo off
rem Windows wrapper: same as "powershell -File stop.ps1" with all arguments forwarded.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop.ps1" %*