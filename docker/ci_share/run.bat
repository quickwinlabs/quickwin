@echo off
rem ============================================================
rem  QEMU 常驻服务启动器（win7 / xp / win11 共用）
rem  由 bootstrap.bat 在 VM 内调用：关防火墙、配 portproxy、
rem  启动 execd（HTTP 8080），不自动跑测试。
rem  结果写 Z:\run-win7.log / Z:\run-xp.log / Z:\run-win11.log
rem  （run.sh 据此 / 或 host curl 健康检查）。
rem ============================================================
rem ---- 系统判定：取 ver 中 '[' 括号内的版本串，再去掉本地化的"词" ----
rem   en: "Microsoft Windows [Version 10.0.19045.3803]"
rem   zh: "Microsoft Windows XP [版本 5.1.2600]"
rem   词会被本地化，但数字段不带语言；抽出后做前缀比较（非子串匹配）
set "VER="
for /f "tokens=2 delims=[]" %%v in ('ver') do set "VER=%%v"
for /f "tokens=1,*" %%a in ("%VER%") do if "%%b"=="" (set "VER=%%a") else (set "VER=%%b")

set "LOG=Z:\run-win7.log"
set "EXE=qwin.exe"
set "ISXP=0"
rem 前缀比较：否则 10.0.19045.x 里的 "5." 子串会被误判成 XP
if "%VER:~0,4%"=="5.1." (
    set "ISXP=1"
    set "LOG=Z:\run-xp.log"
    set "EXE=qwin-x86.exe"
)
if "%VER:~0,5%"=="10.0." set "LOG=Z:\run-win11.log"
echo [%date% %time%] run.bat started ver=[%VER%] >> %LOG%

Z:

if "%ISXP%"=="1" goto xp

rem ---------------- win11 / win7 ----------------
rem Disable Windows Firewall (QEMU SLIRP forwarded connections are blocked by it)
echo [%date% %time%] Disabling firewall... >> %LOG%
netsh advfirewall set allprofiles state off >nul 2>&1
echo [%date% %time%] Firewall disabled >> %LOG%

rem ---- Win11（标准 tiny11 自带 Defender）：关实时保护，服务保留只是不扫/不拦测试负载 ----
if "%VER:~0,5%"=="10.0." powershell -NoProfile -Command "Set-MpPreference -DisableRealtimeMonitoring $true" >> %LOG% 2>&1

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
rem ---- cwd 到共享目录，启动常驻 execd ----
rem 注：部署新 exe 必须"先删再写同一文件名"（新 inode），
rem 直接覆盖同名会命中 SMB 缓存读到旧版（改名也可绕过，见 .agents/CONSOLE_STDOUT_MECHANISM.md §7.5）。
cd /d Z:\quickwin
echo [%date% %time%] exe=[%EXE%] cwd=[%cd%] >> %LOG%
if exist execd.exe goto startsvc
echo ERROR: execd.exe 不在 [%cd%] >> %LOG%
goto fail

:startsvc
rem start 独立进程，run.bat 退出后服务仍在；cwd 继承 Z:\quickwin
start "execd" /min execd.exe >> %LOG% 2>&1
echo [%date% %time%] execd start requested rc=%errorlevel% >> %LOG%
rem 给服务一点起听时间，再写 Ready（run.sh / host 健康检查另会 curl）
ping 127.0.0.1 -n 3 >nul 2>&1
echo [%date% %time%] Ready >> %LOG%
echo [%date% %time%] Done >> %LOG%
exit /b 0

:fail
echo [%date% %time%] Done >> %LOG%
exit /b 1
