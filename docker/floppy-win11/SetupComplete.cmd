@echo off
rem 在安装结束时以 SYSTEM 身份运行：允许 CI SMB 共享的 guest 免密登录
reg add "HKLM\SYSTEM\CurrentControlSet\Services\LanmanWorkstation\Parameters" /v AllowInsecureGuestAuth /t REG_DWORD /d 1 /f >nul 2>&1
reg add "HKLM\SYSTEM\CurrentControlSet\Services\LanmanWorkstation\Parameters" /v RequireSecuritySignature /t REG_DWORD /d 0 /f >nul 2>&1
reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" /v AllowInsecureGuestAuth /t REG_DWORD /d 1 /f >nul 2>&1
echo guestfix-setupcomplete-ran > C:\Windows\Temp\guestfix.txt