@echo off
setlocal
set LOG=C:\Windows\Temp\bootstrap.log

rem Suppress Network Location dialog
reg add HKLM\SYSTEM\CurrentControlSet\Control\Network\NewNetworkWindowOff /f >nul 2>&1
reg add HKLM\SYSTEM\CurrentControlSet\Control\Network\NetworkLocationWizard /v HideWizard /t REG_DWORD /d 1 /f >nul 2>&1

rem Allow insecure guest logons for CI SMB share (dockur-proven)
reg add "HKLM\SYSTEM\CurrentControlSet\Services\LanmanWorkstation\Parameters" /v AllowInsecureGuestAuth /t REG_DWORD /d 1 /f >nul 2>&1
reg add "HKLM\SYSTEM\CurrentControlSet\Services\LanmanWorkstation\Parameters" /v RequireSecuritySignature /t REG_DWORD /d 0 /f >nul 2>&1
reg add "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" /v AllowInsecureGuestAuth /t REG_DWORD /d 1 /f >nul 2>&1
rem Disconnect existing SMB connection (fix error 85)
net use Z: /delete >nul 2>&1

rem Mount QEMU SMB share
echo [%date% %time%] Mounting SMB... >> %LOG%
net use Z: \\10.0.2.4\qemu /user:guest "" >nul 2>&1
if errorlevel 1 (
    echo [%date% %time%] SMB mount FAILED >> %LOG%
    goto end
)
echo [%date% %time%] SMB mount OK >> %LOG%
copy "%LOG%" Z:\bootstrap.log >nul 2>&1

rem Start run.bat
if exist "Z:\run.bat" (
    echo [%date% %time%] Starting run.bat... >> %LOG%
    call "Z:\run.bat"
) else (
    echo [%date% %time%] Z:\run.bat NOT FOUND >> %LOG%
)

:end
endlocal