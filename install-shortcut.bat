@echo off
chcp 65001 >nul
setlocal
set "TARGET=%~dp0start-all.bat"
set "SHORTCUT=%USERPROFILE%\Desktop\FailurePrism 起動.lnk"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ws = New-Object -ComObject WScript.Shell; $s = $ws.CreateShortcut('%SHORTCUT%'); $s.TargetPath = '%TARGET%'; $s.WorkingDirectory = '%~dp0'; $s.Description = 'FailurePrism (TPDD-Editor & VTA-Editor)'; $s.Save()"

echo デスクトップに「FailurePrism 起動」ショートカットを作成しました。
pause
