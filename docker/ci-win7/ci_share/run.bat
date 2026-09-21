@echo off
set LOG=Z:\run.log
echo [%date% %time%] run.bat started >> %LOG%

Z:

rem Disable Windows Firewall (QEMU SLIRP forwarded connections are blocked by it)
echo [%date% %time%] Disabling firewall... >> %LOG%
netsh advfirewall set allprofiles state off >nul 2>&1
echo [%date% %time%] Firewall disabled >> %LOG%

rem Forward guest ports to host test server (10.0.2.2)
rem (basic-fetch and net tests hit the container serve_test via these proxies)
echo [%date% %time%] Setting up portproxy... >> %LOG%
for %%P in (18923 18924) do (
    netsh interface portproxy delete v4tov4 listenaddress=127.0.0.1 listenport=%%P >nul 2>&1
    netsh interface portproxy add v4tov4 listenaddress=127.0.0.1 listenport=%%P connectaddress=10.0.2.2 connectport=%%P >> %LOG% 2>&1
    netsh interface portproxy delete v6tov4 listenaddress=:: listenport=%%P >nul 2>&1
    netsh interface portproxy add v6tov4 listenaddress=:: listenport=%%P connectaddress=10.0.2.2 connectport=%%P >> %LOG% 2>&1
)
echo [%date% %time%] portproxy setup rc=%errorlevel% >> %LOG%

rem Start exec_server in background
echo [%date% %time%] Starting exec_server... >> %LOG%
start "exec_server" /min cmd /c "cd /d Z:\quickwin && qwin.exe examples\exec_server.js >> Z:\exec_server.log 2>&1"
echo [%date% %time%] exec_server started >> %LOG%
