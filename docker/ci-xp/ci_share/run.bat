@echo off
set LOG=Z:\run.log
echo [%date% %time%] run.bat started >> %LOG%
netsh firewall set opmode disable >nul 2>&1
Z:
cd /d Z:/quickwin

rem --- XP portproxy to host test server (10.0.2.2) ---
rem Requires IPv6 protocol: netsh interface ipv6 install (XP loads IPV6MON.DLL for portproxy)
rem Add BOTH v4tov4 (IPv4 loopback -> host) and v6tov4 (IPv6 loopback -> host, needed for ipv6 suite)
netsh interface ipv6 install >nul 2>&1
for %%P in (18923 18924) do (
    netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=%%P >nul 2>&1
    netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=%%P connectaddress=10.0.2.2 connectport=%%P >nul 2>&1
    netsh interface portproxy delete v6tov4 listenaddress=:: listenport=%%P >nul 2>&1
    netsh interface portproxy add v6tov4 listenaddress=:: listenport=%%P connectaddress=10.0.2.2 connectport=%%P >nul 2>&1
)
netsh interface portproxy show all >> %LOG% 2>&1

rem --- WebSocket 已加 scheme 校验（ws:/wss:），XP 不再挂死 ---
qwin.exe test/run.js >> %LOG% 2>&1
echo --- Exit: %ERRORLEVEL% --- >> %LOG%

echo [%date% %time%] Done >> %LOG%