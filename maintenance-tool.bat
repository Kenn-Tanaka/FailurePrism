@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "CONFIG_PATH=%~dp0gateway\config\llm-gateway.json"
if not exist "%CONFIG_PATH%" (
    if exist "%~dp0gateway\config\llm-gateway.default.json" (
        copy /Y "%~dp0gateway\config\llm-gateway.default.json" "%CONFIG_PATH%" >nul
    )
)

if exist "%~dp0gateway\MaintenanceTool.exe" (
    start "" "%~dp0gateway\MaintenanceTool.exe" --config "%CONFIG_PATH%"
    goto :eof
)

if exist "%~dp0gateway\bin\MaintenanceTool.exe" (
    start "" "%~dp0gateway\bin\MaintenanceTool.exe" --config "%CONFIG_PATH%"
    goto :eof
)

echo [Error] MaintenanceTool.exe was not found in gateway\ or gateway\bin\.
pause
