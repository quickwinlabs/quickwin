@echo off
rem ── WinPE 阶段：改目标安装的离线 SOFTWARE hive（镜像已应用、目标 OS 尚未启动）──
rem   Features\TamperProtection=4 + TamperProtectionSource=2 → 关掉 Tamper Protection
rem   取值有讲究（实测踩过坑）：0 是 Win10 的"关"，Win11 会当无效值、首次启动回落成
rem   出厂默认 1/5（=开着）;Win11 的"关"是 4，Source 5=默认(云端)、2=基于签名，
rem   正是"在安全中心手动关掉"后的样子。
rem 关掉之后（防火墙意义上的"钥匙"）：
rem   1) run.bat 每开机跑的 Set-MpPreference -DisableRealtimeMonitoring $true 才真正生效
rem      （TP 开着时该命令返回成功但被静默忽略）；
rem   2) 实时保护随时可在 Windows 安全中心手动开回来；TP 也能手动开回来——
rem      一开回来 run.bat 那句又会被静默忽略，Defender 即恢复全开。
rem 故意不写策略 GPO（Policies\...\DisableRealtimeMonitoring=1）：那会让 UI 开关变灰
rem   （"由你的组织管理"），把可逆性弄丢。
rem 为什么必须在这时：
rem   OS 一旦启动，WdFilter 内核回调 + ACL 会拒改这些键——specialize/FirstLogon 阶段实测
rem   Access is denied，Set-MpPreference 被静默吞掉、GPO 策略被忽略。Defender 的
rem   Tamper Protection 防的就是这个，运行期无解。
rem 参考：cschneegans/unattend-generator 的 DisableDefender.vbs（同为 PE 阶段离线改 hive，
rem   靠"轮询新出现的 hive 文件"抓住 setup.exe 应用镜像之后的窗口期）。
rem 日志：X:\deftweak-pe.log；成功后再拷一份到目标盘根 C:\deftweak-pe.log（本机可读）。
setlocal enabledelayedexpansion
set LOG=X:\deftweak-pe.log
echo [%date% %time%] pe tweak start >> "%LOG%"
rem WinPE 盘符不固定（实测目标卷 = E:，ESP/安装介质各自也占一个字母），RunSynchronous 只能
rem 用 A..H 探测启动本脚本；这里把"从哪个字母被拉起 + 当前盘符表"写进日志，事后可核对映射。
echo [%date% %time%] launched as %~f0 (drive %~d0) >> "%LOG%"
call :dump start
set N=0
:wait
set TARGET=
for %%d in (C D E F G H I J K) do (
    if exist "%%d:\Windows\System32\config\SOFTWARE" (
        if exist "%%d:\Windows\System32\config\SOFTWARE.LOG1" set TARGET=%%d
        if exist "%%d:\Windows\System32\config\SYSTEM.LOG1" set TARGET=%%d
    )
)
if not defined TARGET (
    set /a N+=1
    if !N! gtr 1500 (
        echo [%date% %time%] give up waiting for target hive >> "%LOG%"
        goto end
    )
    ping -n 3 127.0.0.1 >nul
    goto wait
)
echo [%date% %time%] target=!TARGET!: (waited !N! loops) >> "%LOG%"
call :dump target-found
set HIVE=!TARGET!:\Windows\System32\config\SOFTWARE
set MOUNT=HKLM\qwdef
for /l %%i in (1,1,30) do (
    reg load "%MOUNT%" "%HIVE%" >> "%LOG%" 2>&1 && goto loaded
    ping -n 2 127.0.0.1 >nul
)
echo [%date% %time%] reg load FAILED >> "%LOG%"
goto end
:loaded
echo [%date% %time%] hive loaded, patching >> "%LOG%"
rem 写前/写后各 query 一次，日志里对照即可确认落盘值
echo --- before --- >> "%LOG%"
reg query "%MOUNT%\Microsoft\Windows Defender\Features" >> "%LOG%" 2>&1
rem 键名大小写不敏感：下面两条小写路径即可命中(实机日志中 reg query 已确认)
rem TamperProtection: 0=关(Win10 值，Win11 视为无效并回落默认 1/5) 4=关(Win11 正确值) 1/5=开
rem TamperProtectionSource: 5=默认(云) 2=基于签名(手动在安全中心关掉后即为此值)
reg add "%MOUNT%\Microsoft\Windows Defender\Features" /v TamperProtection /t REG_DWORD /d 4 /f >> "%LOG%" 2>&1
reg add "%MOUNT%\Microsoft\Windows Defender\Features" /v TamperProtectionSource /t REG_DWORD /d 2 /f >> "%LOG%" 2>&1
echo --- after --- >> "%LOG%"
reg query "%MOUNT%\Microsoft\Windows Defender\Features" /v TamperProtection >> "%LOG%" 2>&1
reg query "%MOUNT%\Microsoft\Windows Defender\Features" /v TamperProtectionSource >> "%LOG%" 2>&1
reg unload "%MOUNT%" >> "%LOG%" 2>&1
echo [%date% %time%] unloaded >> "%LOG%"
:end
if defined TARGET copy /y "%LOG%" "!TARGET!:\deftweak-pe.log" >nul 2>&1
endlocal
rem 主流程到此结束：下面是对外 call 的诊断子过程，必须显式跳开（否则会继续往下"执行"）
goto :eof

rem ── 诊断子过程：把 PE 的盘符表写进日志（%1 = 场景名）──
rem   fsutil 给出权威字母表（含 X:），缺失时静默退化；A..K 的根目录清单用来认身份
rem   （ESP 根 = EFI/…；OS 卷根 = Windows/Program Files/…；软盘根 = 本脚本），
rem   X:（PE 自身）故意不列，免得把 PE 的根目录刷进日志。
:dump
echo --- drives (%1) --- >> "%LOG%"
if exist "%SystemRoot%\System32\fsutil.exe" fsutil fsinfo drives >> "%LOG%" 2>&1
for %%d in (A B C D E F G H I J K) do if exist "%%d:\" call :dumpdrive %%d
exit /b

:dumpdrive
echo   [%1:] >> "%LOG%"
dir /b "%1:\" >> "%LOG%" 2>&1
exit /b
