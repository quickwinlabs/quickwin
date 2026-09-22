@echo off
set LOG=C:\OEM\install.log

echo [%date% %time%] Registering bootstrap.bat to HKLM\Run... >> %LOG%
reg add "HKLM\Software\Microsoft\Windows\CurrentVersion\Run" /v bootstrap /t REG_SZ /d "C:\OEM\bootstrap.bat" /f >> %LOG% 2>&1
echo [%date% %time%] reg add exit code: %errorlevel% >> %LOG%

echo [%date% %time%] Shutting down... >> %LOG%
shutdown -s -f -t 0
