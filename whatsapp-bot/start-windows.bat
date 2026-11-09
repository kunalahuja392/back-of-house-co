@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing for the first time...
  call npm install
)
:loop
node bot.js
echo Bot stopped - restarting in 10 seconds. Close this window to stop it.
timeout /t 10
goto loop
