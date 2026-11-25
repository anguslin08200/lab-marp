@echo off
rem Open the integrated Markdown editor, draggable preview, and PDF export interface.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
if errorlevel 1 pause
