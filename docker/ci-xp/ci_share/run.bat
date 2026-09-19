@echo off
set LOG=Z:\run.log
echo [%date% %time%] run.bat started >> %LOG%

Z:

rem Disable Windows Firewall (XP uses netsh firewall, not advfirewall)
echo [%date% %time%] Disabling firewall... >> %LOG%
netsh firewall set opmode disable >nul 2>&1
echo [%date% %time%] Firewall disabled >> %LOG%

rem Check qwin.exe exists via SMB symlink (qwin.exe does not run on XP, only verify visibility)
echo [%date% %time%] Checking qwin.exe... >> %LOG%
if exist Z:\quickwin\qwin.exe (
    echo qwin.exe FOUND >> %LOG%
) else (
    echo qwin.exe NOT FOUND >> %LOG%
)

rem Check examples dir (verify symlink traversal)
if exist Z:\quickwin\examples\exec_server.js (
    echo examples\exec_server.js FOUND >> %LOG%
) else (
    echo examples\exec_server.js NOT FOUND >> %LOG%
)

echo [%date% %time%] Done >> %LOG%
