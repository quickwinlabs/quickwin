@echo off
rem ============================================================
rem  QEMU CI 测试运行器（win7 / xp 共用）
rem  由 bootstrap.bat 在 VM 内调用，直接跑完整测试套件。
rem  win7/xp 差别：防火墙命令语法、portproxy listen 地址、exe 名。
rem  结果写 Z:\run-win7.log / Z:\run-xp.log（按系统版本区分，run.sh 据此等待），最后输出 Done 行。
rem ============================================================
set LOG=Z:\run-win7.log
set EXE=qwin.exe
rem ---- 判断系统版本：XP=5.x，win7=6.x（决定日志文件名 + 用哪个 exe）----
rem xp 必须用 32 位的 qwin-x86.exe，win7 用 64 位的 qwin.exe
ver | findstr /r /c:"5\." >nul 2>&1
if not errorlevel 1 (set LOG=Z:\run-xp.log & set EXE=qwin-x86.exe)
echo [%date% %time%] run.bat started >> %LOG%

Z:

rem ---- 判断系统版本：XP=5.x，win7=6.x ----
ver | findstr /r /c:"5\." >nul 2>&1
if %errorlevel%==0 goto xp

rem ---------------- win7 ----------------
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
goto run

rem ---------------- xp ----------------
:xp
netsh firewall set opmode disable >nul 2>&1

rem XP portproxy 需要 IPv6 协议（占位符号链接），且用 0.0.0.0 监听
echo [%date% %time%] Setting up portproxy (xp)... >> %LOG%
netsh interface ipv6 install >nul 2>&1
for %%P in (18923 18924) do (
    netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=%%P >nul 2>&1
    netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=%%P connectaddress=10.0.2.2 connectport=%%P >nul 2>&1
    netsh interface portproxy delete v6tov4 listenaddress=:: listenport=%%P >nul 2>&1
    netsh interface portproxy add v6tov4 listenaddress=:: listenport=%%P connectaddress=10.0.2.2 connectport=%%P >nul 2>&1
)
netsh interface portproxy show all >> %LOG% 2>&1

:run
rem ---- 选可执行文件：xp 用 qwin-x86.exe（32 位），win7 用 qwin.exe（64 位）----
cd /d Z:\quickwin
echo [%date% %time%] exe=[%EXE%] cwd=[%cd%] >> %LOG%
if exist %EXE% goto runtest
echo ERROR: %EXE% 不在 [%cd%]，测试套件缺失 >> %LOG%
goto finish

:runtest
%EXE% test/run.js >> %LOG% 2>&1
echo --- Exit: %ERRORLEVEL% --- >> %LOG%

:finish
echo [%date% %time%] Done >> %LOG%