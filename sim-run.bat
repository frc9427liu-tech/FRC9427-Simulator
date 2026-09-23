@echo off
title LEO-Simulator (close this window to stop)
set "JAVA_HOME=C:\Users\Public\wpilib\2026\jdk"
cd /d "%~1"
call "%~1\gradlew.bat" simulateJava -I "%~dp0sim-ws.gradle"
echo.
echo Simulator stopped. Press any key to close.
pause >nul
