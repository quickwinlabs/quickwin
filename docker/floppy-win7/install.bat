@echo off
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v bootstrap /t REG_SZ /d "C:\OEM\bootstrap.bat" /f >nul 2>&1
shutdown -s -t 5
