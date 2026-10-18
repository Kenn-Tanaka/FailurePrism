$ErrorActionPreference = "Stop"

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  FailurePrism (TPDD-Editor + VTA-Editor + LLM-Gateway v2.0)" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

# 1. Node.js Check
$node = Get-Command "node" -ErrorAction SilentlyContinue
if ((-not $node) -and (Test-Path "C:\Program Files\nodejs\node.exe")) {
    $env:PATH = "C:\Program Files\nodejs;" + $env:PATH
    $node = Get-Command "node" -ErrorAction SilentlyContinue
}
if (-not $node) {
    Write-Host "[ERROR] Node.js is not found in PATH." -ForegroundColor Red
    Write-Host "Please install Node.js (v18 or later) to run the Web Server." -ForegroundColor Yellow
    Read-Host "Press Enter to exit..."
    exit 1
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
if ((Split-Path -Leaf $scriptDir) -eq "scripts") {
    $rootDir = Split-Path -Parent $scriptDir
} else {
    $rootDir = $scriptDir
}

$helpersPath = Join-Path $rootDir "scripts\process-helpers.ps1"
if (Test-Path $helpersPath) {
    . $helpersPath
}

$runtimeDir = Join-Path $rootDir ".runtime"
if (-not (Test-Path $runtimeDir)) {
    New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
}
$procJsonPath = Join-Path $runtimeDir "processes.json"

function Get-PortListeners($port) {
    try {
        $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        return ($conns | Select-Object -ExpandProperty OwningProcess -Unique)
    } catch {
        return @()
    }
}

# Gateway EXE & Config 解決
$gatewayCandidates = @(
    (Join-Path $rootDir "gateway\llm-gateway.exe"),
    (Join-Path $rootDir "gateway\bin\llm-gateway.exe")
)
$gatewayExe = $gatewayCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
$gatewayDir = if ($gatewayExe) { Split-Path -Parent $gatewayExe } else { Join-Path $rootDir "gateway" }
$configFile = Join-Path $rootDir "gateway\config\llm-gateway.json"
$defaultConfigFile = Join-Path $rootDir "gateway\config\llm-gateway.default.json"
if ((-not (Test-Path $configFile)) -and (Test-Path $defaultConfigFile)) {
    Copy-Item -Force $defaultConfigFile $configFile
}

# 2. Check & Start Full LLM-Gateway v2.0.0 (Port 8765)
$gwExistingPids = Get-PortListeners 8765
$gwPid = $null

if ($gwExistingPids.Count -gt 0) {
    $matched = $false
    foreach ($p in $gwExistingPids) {
        if (Test-IsMatchingGatewayProcess $p $gatewayDir) {
            Write-Host "[1/2] LLM-Gateway is already running on port 8765 (PID: $p). Reusing existing instance." -ForegroundColor Yellow
            $gwPid = $p
            $matched = $true
            break
        }
    }
    if (-not $matched) {
        $conflictPids = $gwExistingPids -join ", "
        Write-Host "[ERROR] Port 8765 is occupied by an unrelated process (PID: $conflictPids)." -ForegroundColor Red
        Write-Host "Please terminate the conflicting process or change LLM-Gateway port in config." -ForegroundColor Red
        exit 1
    }
} elseif ($gatewayExe -and (Test-Path $configFile)) {
    Write-Host "[1/2] Starting Full LLM-Gateway v2.0.0 on port 8765..." -ForegroundColor Green
    $proc = Start-Process -FilePath $gatewayExe `
        -ArgumentList "--config", "`"$configFile`"" `
        -WorkingDirectory $gatewayDir `
        -WindowStyle Minimized `
        -PassThru
    $gwPid = $proc.Id
    Start-Sleep -Seconds 2
} else {
    Write-Host "[1/2] Warning: llm-gateway.exe or config not found. Starting Web UI only." -ForegroundColor Yellow
}

# 3. Check & Start Web Server (Port 3000)
$serverScriptCandidates = @(
    (Join-Path $rootDir "app\server.mjs"),
    (Join-Path $rootDir "scripts\server.mjs")
)
$serverScript = $serverScriptCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $serverScript) {
    Write-Host "[ERROR] server.mjs not found." -ForegroundColor Red
    exit 1
}

$webExistingPids = Get-PortListeners 3000
$webPid = $null

if ($webExistingPids.Count -gt 0) {
    $matched = $false
    foreach ($p in $webExistingPids) {
        if (Test-IsMatchingServerProcess $p $serverScript) {
            Write-Host "[2/2] Web Server is already running on port 3000 (PID: $p). Reusing existing server." -ForegroundColor Yellow
            $webPid = $p
            $matched = $true
            break
        }
    }
    if (-not $matched) {
        $conflictPids = $webExistingPids -join ", "
        Write-Host "[ERROR] Port 3000 is occupied by an unrelated process (PID: $conflictPids)." -ForegroundColor Red
        Write-Host "Please terminate the conflicting process or change Web Server port." -ForegroundColor Red
        exit 1
    }
} else {
    Write-Host "[2/2] Starting FailurePrism Web Server on port 3000..." -ForegroundColor Green
    $serverWorkDir = Split-Path -Parent $serverScript
    $proc = Start-Process -FilePath $node.Source `
        -ArgumentList "`"$serverScript`"" `
        -WorkingDirectory $serverWorkDir `
        -WindowStyle Minimized `
        -PassThru
    $webPid = $proc.Id
    Start-Sleep -Seconds 2
}

# メタデータファイル記録
$runtimeData = @{
    gateway = @{
        pid = $gwPid
        port = 8765
        executable = $gatewayExe
        updatedAt = (Get-Date).ToString("o")
    }
    webServer = @{
        pid = $webPid
        port = 3000
        script = $serverScript
        updatedAt = (Get-Date).ToString("o")
    }
}
$runtimeData | ConvertTo-Json -Depth 4 | Set-Content -Path $procJsonPath -Encoding utf8

# 4. Open Default Browser to Launcher Menu
Write-Host "Opening browser to FailurePrism Menu..." -ForegroundColor Green
Start-Process "http://127.0.0.1:3000/#menu"

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  FailurePrism started successfully!" -ForegroundColor Cyan
Write-Host "  - Menu (Launcher): http://127.0.0.1:3000/#menu" -ForegroundColor White
Write-Host "  - TPDD-Editor:     http://127.0.0.1:3000/#tpdd" -ForegroundColor White
Write-Host "  - VTA-Editor:      http://127.0.0.1:3000/#vta" -ForegroundColor White
Write-Host "  - LLM-Gateway:     http://127.0.0.1:8765/health" -ForegroundColor White
Write-Host "  ※ APIキー設定・Gateway管理GUIは maintenance-tool.bat を実行してください。" -ForegroundColor Gray
Write-Host "  ※ 終了する場合は stop-all.bat を実行してください。" -ForegroundColor Gray
Write-Host "============================================================" -ForegroundColor Cyan
Start-Sleep -Seconds 2
