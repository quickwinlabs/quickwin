@echo off
set LOG=Z:\run.log
echo [%date% %time%] run.bat started >> %LOG%

Z:

rem Disable Windows Firewall (QEMU SLIRP forwarded connections are blocked by it)
echo [%date% %time%] Disabling firewall... >> %LOG%
netsh advfirewall set allprofiles state off >nul 2>&1
echo [%date% %time%] Firewall disabled >> %LOG%

rem Start exec_server in background
echo [%date% %time%] Starting exec_server... >> %LOG%
start "exec_server" /min cmd /c "cd /d Z:\quickwin && qwin.exe examples\exec_server.js >> Z:\exec_server.log 2>&1"
echo [%date% %time%] exec_server started >> %LOG%
