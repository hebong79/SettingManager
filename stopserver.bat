@echo off
rem SettingManager server shutdown - counterpart of startserver.bat.
rem Logic lives in scripts\stop-settingmanager.ps1 (Korean messages there).
rem This file stays ASCII-only on purpose: cmd.exe reads .bat as ANSI, so
rem non-ASCII text here corrupts parsing, not just the display.
rem
rem Usage:  stopserver.bat          (port 13030)
rem         stopserver.bat -Port 9000
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\stop-settingmanager.ps1" %*
exit /b %ERRORLEVEL%
