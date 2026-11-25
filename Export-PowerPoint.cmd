@echo off
rem Rebuild the PowerPoint from the single Markdown source.
cd /d "%~dp0"
call npm.cmd run export:pptx
if errorlevel 1 (pause & exit /b 1)
start "" "%~dp0output\lab-meeting.pptx"
