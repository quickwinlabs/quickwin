@echo off
rem ============================================================
rem  QEMU 常驻服务启动器（win7 / xp 共用）
rem  由 bootstrap.bat 在 VM 内调用：关防火墙、配 portproxy、
rem  启动 exec_server（HTTP 8080），不自动跑测试。
rem  结果写 Z:\run-win7.log / Z:\run-xp.log；就绪输出 Ready 行
rem  （run.sh 据此 / 或 host curl 健康检查）。
rem ============================================================
set LOG=Z:\run-win7.log
set EXE=qwin.exe
rem ---- 判断系统版本：XP=5.x，win7=6.x（决定日志文件名 + 用哪个 exe）----
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
rem ---- cwd 到共享目录，启动常驻 exec_server ----
cd /d Z:\quickwin
echo [%date% %time%] exe=[%EXE%] cwd=[%cd%] >> %LOG%
if exist exec_server.exe goto startsvc
echo ERROR: exec_server.exe 不在 [%cd%] >> %LOG%
goto fail

:startsvc
rem start 独立进程，run.bat 退出后服务仍在；cwd 继承 Z:\quickwin
start "exec_server" /min exec_server.exe >> %LOG% 2>&1
echo [%date% %time%] exec_server start requested rc=%errorlevel% >> %LOG%
rem 给服务一点起听时间，再写 Ready（run.sh / host 健康检查另会 curl）
ping 127.0.0.1 -n 3 >nul 2>&1
echo [%date% %time%] Ready >> %LOG%
echo [%date% %time%] Done >> %LOG%
exit /b 0

:fail
echo [%date% %time%] Done >> %LOG%
exit /b 1
