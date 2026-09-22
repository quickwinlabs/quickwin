@echo off
setlocal
set LOG=C:\Windows\Temp\bootstrap.log

echo [%date% %time%] bootstrap.bat started >> %LOG%

rem Check network state
echo [%date% %time%] ipconfig: >> %LOG%
ipconfig >> %LOG% 2>&1

rem Wait 10s for network initialization
echo [%date% %time%] Waiting 10s for network... >> %LOG%
ping 127.0.0.1 -n 11 >nul 2>&1

echo [%date% %time%] ipconfig after wait: >> %LOG%
ipconfig >> %LOG% 2>&1

echo [%date% %time%] Attempting SMB mount... >> %LOG%
net use Z: /delete >nul 2>&1
net use Z: \\10.0.2.4\qemu /user:guest "" >> %LOG% 2>&1
if errorlevel 1 (
    echo [%date% %time%] SMB mount FAILED >> %LOG%
    goto end
)

echo [%date% %time%] SMB mount OK >> %LOG%
call "Z:\run.bat"

:end
endlocal
