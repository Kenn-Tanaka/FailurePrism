param(
    [string]$Browser = "",
    [string[]]$BrowserArgs = @(),
    [switch]$AppMode,
    [switch]$Reset,
    [switch]$List,
    [switch]$Status
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

# Pure-ASCII Unicode unescape helper (immune to Windows PowerShell 5.1 CP932/BOM encoding quirks)
function Format-Jp([string]$escaped) {
    return [regex]::Unescape($escaped)
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ((Split-Path -Leaf $scriptDir) -eq "scripts") {
    $rootDir = Split-Path -Parent $scriptDir
} else {
    $rootDir = $scriptDir
}

$browserHelpersPath = Join-Path $rootDir "scripts\browser-helpers.ps1"
if (-not (Test-Path -LiteralPath $browserHelpersPath)) {
    throw "Missing helper script: $browserHelpersPath"
}
. $browserHelpersPath

function Show-CurrentStatus([string]$targetRoot) {
    $cfgPath = Get-BrowserConfigPath $targetRoot
    $saved = Read-SavedBrowserConfig $targetRoot
    Write-Host "------------------------------------------------------------" -ForegroundColor DarkCyan
    if (-not $saved -or $saved.mode -eq "default") {
        Write-Host (Format-Jp "  \u73fe\u5728\u306e\u8a2d\u5b9a: \u30b7\u30b9\u30c6\u30e0\u65e2\u5b9a\u306e\u30d6\u30e9\u30a6\u30b6 (default)") -ForegroundColor White
    } elseif ($saved.mode -eq "none") {
        Write-Host (Format-Jp "  \u73fe\u5728\u306e\u8a2d\u5b9a: \u30d6\u30e9\u30a6\u30b6\u3092\u81ea\u52d5\u3067\u958b\u304b\u306a\u3044 (none)") -ForegroundColor Yellow
        Write-Host ("  Config:     " + $cfgPath) -ForegroundColor Gray
    } else {
        $modeLabel = if ($saved.appMode) {
            Format-Jp "\u30a2\u30d7\u30ea\u30a6\u30a3\u30f3\u30c9\u30a6 (--app)"
        } else {
            Format-Jp "\u901a\u5e38\u30bf\u30d6 / \u30a6\u30a3\u30f3\u30c9\u30a6"
        }
        $extraLabel = if ($saved.extraArgs -and $saved.extraArgs.Count -gt 0) {
            ($saved.extraArgs -join " ")
        } else {
            "(none)"
        }
        Write-Host ((Format-Jp "  \u73fe\u5728\u306e\u8a2d\u5b9a: ") + $saved.browser) -ForegroundColor Green
        Write-Host ("  Executable: " + $saved.executablePath) -ForegroundColor White
        Write-Host ("  Mode:       " + $modeLabel) -ForegroundColor White
        Write-Host ("  ExtraArgs:  " + $extraLabel) -ForegroundColor Gray
        Write-Host ("  Config:     " + $cfgPath) -ForegroundColor Gray
    }
    Write-Host "------------------------------------------------------------" -ForegroundColor DarkCyan
}

$installed = @(Get-InstalledBrowsers)

# 1. Non-interactive CLI modes (-List / -Status / -Reset / -Browser)
if ($List) {
    Write-Host (Format-Jp "\u691c\u51fa\u3055\u308c\u305f\u30d6\u30e9\u30a6\u30b6\u4e00\u89a7:") -ForegroundColor Cyan
    if ($installed.Count -eq 0) {
        Write-Host "  (No registered browsers detected)" -ForegroundColor Yellow
    } else {
        foreach ($b in $installed) {
            Write-Host ("  - {0,-10} : {1} ({2})" -f $b.Id, $b.Name, $b.ExecutablePath)
        }
    }
    exit 0
}

if ($Status) {
    Show-CurrentStatus $rootDir
    exit 0
}

if ($Reset) {
    Save-BrowserConfig -rootDir $rootDir -mode "default" | Out-Null
    Write-Host (Format-Jp "[OK] \u8d77\u52d5\u30d6\u30e9\u30a6\u30b6\u8a2d\u5b9a\u3092\u30ea\u30bb\u30c3\u30c8\u3057\u3001\u30b7\u30b9\u30c6\u30e0\u65e2\u5b9a\u306e\u30d6\u30e9\u30a6\u30b6\u306b\u623b\u3057\u307e\u3057\u305f\u3002") -ForegroundColor Green
    exit 0
}

if (-not [string]::IsNullOrWhiteSpace($Browser)) {
    $norm = $Browser.Trim().ToLowerInvariant()
    if ($norm -in @("default", "system", "auto")) {
        Save-BrowserConfig -rootDir $rootDir -mode "default" | Out-Null
        Write-Host (Format-Jp "[OK] \u30b7\u30b9\u30c6\u30e0\u65e2\u5b9a\u306e\u30d6\u30e9\u30a6\u30b6\u3092\u4f7f\u7528\u3059\u308b\u3088\u3046\u8a2d\u5b9a\u3057\u307e\u3057\u305f\u3002") -ForegroundColor Green
        exit 0
    }
    if ($norm -in @("none", "off", "false", "0")) {
        Save-BrowserConfig -rootDir $rootDir -mode "none" | Out-Null
        Write-Host (Format-Jp "[OK] start-all.bat \u5b9f\u884c\u6642\u306b\u30d6\u30e9\u30a6\u30b6\u3092\u81ea\u52d5\u3067\u958b\u304b\u306a\u3044\u3088\u3046\u8a2d\u5b9a\u3057\u307e\u3057\u305f\u3002") -ForegroundColor Green
        exit 0
    }
    $resolvedExe = Resolve-BrowserExecutable $Browser $installed
    if (-not $resolvedExe) {
        Write-Host ((Format-Jp "[ERROR] \u6307\u5b9a\u3055\u308c\u305f\u30d6\u30e9\u30a6\u30b6\u304c\u898b\u3064\u304b\u308a\u307e\u305b\u3093: ") + $Browser) -ForegroundColor Red
        Write-Host (Format-Jp "select-browser.bat -List \u3067\u4e00\u89a7\u3092\u78ba\u8a8d\u3059\u308b\u304b\u3001.exe \u306e\u30d5\u30eb\u30d1\u30b9\u3092\u6307\u5b9a\u3057\u3066\u304f\u3060\u3055\u3044\u3002") -ForegroundColor Yellow
        exit 1
    }
    $matchedEntry = $installed | Where-Object { $_.ExecutablePath -eq $resolvedExe } | Select-Object -First 1
    $browserLabel = if ($matchedEntry) { $matchedEntry.Id } else { [System.IO.Path]::GetFileNameWithoutExtension($resolvedExe) }
    Save-BrowserConfig `
        -rootDir $rootDir `
        -mode "browser" `
        -browser $browserLabel `
        -executablePath $resolvedExe `
        -appMode ([bool]$AppMode) `
        -extraArgs $BrowserArgs | Out-Null
    Write-Host ((Format-Jp "[OK] \u8d77\u52d5\u30d6\u30e9\u30a6\u30b6\u3092\u8a2d\u5b9a\u3057\u307e\u3057\u305f: ") + "$browserLabel ($resolvedExe)") -ForegroundColor Green
    exit 0
}

# 2. Interactive Menu Mode
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host (Format-Jp "  FailurePrism \u8d77\u52d5\u30d6\u30e9\u30a6\u30b6\u8a2d\u5b9a\u30c4\u30fc\u30eb (start-all.bat \u7528)") -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Show-CurrentStatus $rootDir

Write-Host ""
Write-Host (Format-Jp "start-all.bat \u5b9f\u884c\u6642\u306b\u4f7f\u7528\u3059\u308b\u30d6\u30e9\u30a6\u30b6\u3092\u9078\u629e\u3057\u3066\u304f\u3060\u3055\u3044:") -ForegroundColor Cyan
Write-Host (Format-Jp "  [0] \u30b7\u30b9\u30c6\u30e0\u65e2\u5b9a\u306e\u30d6\u30e9\u30a6\u30b6\u306b\u623b\u3059 (\u8a2d\u5b9a\u30ea\u30bb\u30c3\u30c8)") -ForegroundColor White

for ($i = 0; $i -lt $installed.Count; $i++) {
    $b = $installed[$i]
    $idx = $i + 1
    Write-Host ("  [{0}] {1} ({2})" -f $idx, $b.Name, $b.ExecutablePath) -ForegroundColor Green
}

Write-Host (Format-Jp "  [C] \u4efb\u610f\u306e\u30d6\u30e9\u30a6\u30b6\u5b9f\u884c\u30d5\u30a1\u30a4\u30eb (.exe) \u3092\u76f4\u63a5\u6307\u5b9a\u3059\u308b") -ForegroundColor White
Write-Host (Format-Jp "  [N] \u8d77\u52d5\u6642\u306b\u30d6\u30e9\u30a6\u30b6\u3092\u81ea\u52d5\u3067\u958b\u304b\u306a\u3044 (\u30b5\u30fc\u30d0\u30fc\u8d77\u52d5\u306e\u307f)") -ForegroundColor Yellow
Write-Host (Format-Jp "  [Q] \u30ad\u30e3\u30f3\u30bb\u30eb (\u5909\u66f4\u305b\u305a\u7d42\u4e86)") -ForegroundColor Gray
Write-Host ""

$choice = (Read-Host (Format-Jp "\u756a\u53f7\u307e\u305f\u306f\u8a18\u53f7\u3092\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044")).Trim()
if ([string]::IsNullOrWhiteSpace($choice) -or $choice.ToUpperInvariant() -eq "Q") {
    Write-Host (Format-Jp "\u5909\u66f4\u305b\u305a\u306b\u7d42\u4e86\u3057\u307e\u3057\u305f\u3002") -ForegroundColor Gray
    exit 0
}

if ($choice -eq "0") {
    Save-BrowserConfig -rootDir $rootDir -mode "default" | Out-Null
    Write-Host ("`n" + (Format-Jp "[OK] \u30b7\u30b9\u30c6\u30e0\u65e2\u5b9a\u306e\u30d6\u30e9\u30a6\u30b6\u3092\u4f7f\u7528\u3059\u308b\u3088\u3046\u8a2d\u5b9a\u3057\u307e\u3057\u305f\u3002")) -ForegroundColor Green
    Read-Host "Press Enter to exit"
    exit 0
}

if ($choice.ToUpperInvariant() -eq "N") {
    Save-BrowserConfig -rootDir $rootDir -mode "none" | Out-Null
    Write-Host ("`n" + (Format-Jp "[OK] start-all.bat \u5b9f\u884c\u6642\u306b\u30d6\u30e9\u30a6\u30b6\u3092\u81ea\u52d5\u3067\u958b\u304b\u306a\u3044\u3088\u3046\u8a2d\u5b9a\u3057\u307e\u3057\u305f\u3002")) -ForegroundColor Green
    Read-Host "Press Enter to exit"
    exit 0
}

$selectedExe = $null
$selectedId = $null
$selectedName = $null
$isChromium = $false

if ($choice.ToUpperInvariant() -eq "C") {
    $pickedPath = $null
    try {
        $pickedPath = powershell.exe -NoProfile -STA -Command "Add-Type -AssemblyName System.Windows.Forms; `$dlg = New-Object System.Windows.Forms.OpenFileDialog; `$dlg.Filter = 'Browser Executable (*.exe)|*.exe|All Files (*.*)|*.*'; `$dlg.Title = 'Select Browser Executable (.exe)'; if (`$dlg.ShowDialog() -eq 'OK') { Write-Output `$dlg.FileName }" 2>$null
        if ($pickedPath) { $pickedPath = ($pickedPath | Select-Object -Last 1).Trim() }
    } catch {}

    if ([string]::IsNullOrWhiteSpace($pickedPath)) {
        $pickedPath = (Read-Host (Format-Jp "\u30d6\u30e9\u30a6\u30b6\u5b9f\u884c\u30d5\u30a1\u30a4\u30eb (.exe) \u306e\u30d5\u30eb\u30d1\u30b9\u3092\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044")).Trim().Trim('"')
    }
    if ([string]::IsNullOrWhiteSpace($pickedPath) -or -not (Test-Path -LiteralPath $pickedPath -PathType Leaf)) {
        Write-Host (Format-Jp "[ERROR] \u6709\u52b9\u306a\u5b9f\u884c\u30d5\u30a1\u30a4\u30eb\u304c\u6307\u5b9a\u3055\u308c\u306a\u304b\u3063\u305f\u305f\u3081\u4e2d\u65ad\u3057\u307e\u3057\u305f\u3002") -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
    $selectedExe = [System.IO.Path]::GetFullPath($pickedPath)
    $selectedId = [System.IO.Path]::GetFileNameWithoutExtension($selectedExe).ToLowerInvariant()
    $selectedName = [System.IO.Path]::GetFileName($selectedExe)
    $isChromium = Test-IsChromiumBrowserExecutable $selectedExe
} else {
    $num = 0
    if (-not [int]::TryParse($choice, [ref]$num) -or $num -lt 1 -or $num -gt $installed.Count) {
        Write-Host ((Format-Jp "[ERROR] \u7121\u52b9\u306a\u9078\u629e\u3067\u3059: ") + $choice) -ForegroundColor Red
        Read-Host "Press Enter to exit"
        exit 1
    }
    $picked = $installed[$num - 1]
    $selectedExe = $picked.ExecutablePath
    $selectedId = $picked.Id
    $selectedName = $picked.Name
    $isChromium = [bool]$picked.IsChromium
}

$useAppMode = $false
if ($isChromium) {
    Write-Host ""
    Write-Host (Format-Jp "\u8868\u793a\u30e2\u30fc\u30c9\u3092\u9078\u629e\u3057\u3066\u304f\u3060\u3055\u3044:") -ForegroundColor Cyan
    Write-Host (Format-Jp "  [1] \u901a\u5e38\u306e\u30d6\u30e9\u30a6\u30b6\u30bf\u30d6 / \u30a6\u30a3\u30f3\u30c9\u30a6\u3067\u958b\u304f (default)") -ForegroundColor White
    Write-Host (Format-Jp "  [2] \u30a2\u30d7\u30ea\u30a6\u30a3\u30f3\u30c9\u30a6\u30e2\u30fc\u30c9 (--app: \u30a2\u30c9\u30ec\u30b9\u30d0\u30fc\u306a\u3057\u306e\u5c02\u7528\u30a6\u30a3\u30f3\u30c9\u30a6)") -ForegroundColor White
    $modeChoice = (Read-Host "Select [1/2, default=1]").Trim()
    if ($modeChoice -eq "2") {
        $useAppMode = $true
    }
}

Write-Host ""
Write-Host (Format-Jp "\u8ffd\u52a0\u306e\u8d77\u52d5\u5f15\u6570\u304c\u3042\u308c\u3070\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044 (\u30d7\u30ed\u30d5\u30a1\u30a4\u30eb\u6307\u5b9a\u306a\u3069)") -ForegroundColor Cyan
Write-Host '  e.g. --profile-directory="Profile 1"  /  --incognito  /  --inprivate' -ForegroundColor Gray
$rawExtra = (Read-Host "Extra args [Enter to skip]").Trim()
$parsedExtraArgs = Split-CommandLineArgs $rawExtra

Save-BrowserConfig `
    -rootDir $rootDir `
    -mode "browser" `
    -browser $selectedId `
    -executablePath $selectedExe `
    -appMode $useAppMode `
    -extraArgs $parsedExtraArgs | Out-Null

Write-Host ""
Write-Host (Format-Jp "[OK] \u8d77\u52d5\u30d6\u30e9\u30a6\u30b6\u8a2d\u5b9a\u3092\u4fdd\u5b58\u3057\u307e\u3057\u305f\uff01") -ForegroundColor Green
Show-CurrentStatus $rootDir
Write-Host ((Format-Jp "\u6b21\u56de\u304b\u3089 start-all.bat \u3092\u5b9f\u884c\u3059\u308b\u3068 ") + "'$selectedName'" + (Format-Jp " \u3067\u8d77\u52d5\u3057\u307e\u3059\u3002")) -ForegroundColor Cyan
Read-Host "Press Enter to exit"
