@echo off
set LOG=Z:\run.log
echo [%date% %time%] run.bat started >> %LOG%
Z:
netsh firewall set opmode disable >nul 2>&1
cd /d Z:\quickwin
echo === basic test === >> %LOG%
qwin.exe test/run.js basic >> %LOG% 2>&1
echo Exit: %ERRORLEVEL% >> %LOG%
echo [%date% %time%] Done >> %LOG%
Place your right index finger on the fingerprint reader
