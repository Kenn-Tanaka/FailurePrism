$ErrorActionPreference = "Continue"

Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  Stopping FailurePrism Services (Web Server & LLM-Gateway)" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan

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
$procJsonPath = Join-Path $runtimeDir "processes.json"
$meta = $null
if (Test-Path $procJsonPath) {
    try {
        $meta = Get-Content $procJsonPath -Raw | ConvertFrom-Json -ErrorAction SilentlyContinue
    } catch {}
}

$hasConflict = $false

# 1. Stop Web Server on Port 3000
try {
    $webConns = Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
    $serverScriptCandidates = @(
        (Join-Path $rootDir "app\server.mjs"),
        (Join-Path $rootDir "scripts\server.mjs")
    )
    $serverScript = $serverScriptCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1

    if ($webConns) {
        $uniquePids = $webConns | Select-Object -ExpandProperty OwningProcess -Unique
        foreach ($p in $uniquePids) {
            $metaWeb = if ($meta -and $meta.webServer) { $meta.webServer } else { $null }
            $isTarget = Test-ShouldStopServerProcess $p $serverScript $metaWeb

            if ($isTarget) {
                Write-Host "Stopping Web Server process (PID: $p)..." -ForegroundColor Yellow
                Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
                Write-Host "  Web Server stopped." -ForegroundColor Green
            } else {
                $hasConflict = $true
                $pInfo = Get-ProcessDetails $p
                $pName = if ($pInfo) { $pInfo.ProcessName } else { "Unknown" }
                Write-Host "  [CONFLICT] Port 3000 is occupied by an unverified or unrelated process '$pName' (PID: $p). Refusing to stop." -ForegroundColor Yellow
            }
        }
    } else {
        Write-Host "  Web Server (port 3000) is not running." -ForegroundColor Gray
    }
} catch {
    Write-Host "  Error checking port 3000: $_" -ForegroundColor DarkGray
}

# 2. Stop LLM-Gateway on Port 8765
try {
    $gwConns = Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue
    $gatewayDir = Join-Path $rootDir "gateway"

    if ($gwConns) {
        $uniquePids = $gwConns | Select-Object -ExpandProperty OwningProcess -Unique
        foreach ($p in $uniquePids) {
            $metaGw = if ($meta -and $meta.gateway) { $meta.gateway } else { $null }
            $isTarget = Test-ShouldStopGatewayProcess $p $gatewayDir $metaGw

            if ($isTarget) {
                Write-Host "Stopping LLM-Gateway process (PID: $p)..." -ForegroundColor Yellow
                
                # 2.1 Attempt graceful shutdown via POST /admin/shutdown
                $shutdownAccepted = $false
                try {
                    $res = Invoke-RestMethod -Uri "http://127.0.0.1:8765/admin/shutdown" -Method Post -TimeoutSec 2 -ErrorAction SilentlyContinue
                    if ($res -and $res.status -eq "shutting_down") {
                        $shutdownAccepted = $true
                        Write-Host "  Shutdown signal accepted by LLM-Gateway. Waiting for exit..." -ForegroundColor Gray
                    }
                } catch {}

                # Wait up to 3 seconds for graceful exit
                $exited = $false
                for ($i = 0; $i -lt 15; $i++) {
                    if (-not (Get-Process -Id $p -ErrorAction SilentlyContinue)) {
                        $exited = $true
                        break
                    }
                    Start-Sleep -Milliseconds 200
                }

                if (-not $exited) {
                    Write-Host "  Force terminating LLM-Gateway (PID: $p)..." -ForegroundColor Yellow
                    Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
                }
                Write-Host "  LLM-Gateway stopped." -ForegroundColor Green
            } else {
                $hasConflict = $true
                $pInfo = Get-ProcessDetails $p
                $pName = if ($pInfo) { $pInfo.ProcessName } else { "Unknown" }
                Write-Host "  [CONFLICT] Port 8765 is occupied by an unverified or unrelated process '$pName' (PID: $p). Refusing to stop." -ForegroundColor Yellow
            }
        }
    } else {
        Write-Host "  LLM-Gateway (port 8765) is not running." -ForegroundColor Gray
    }
} catch {
    Write-Host "  Error checking port 8765: $_" -ForegroundColor DarkGray
}

# クリーンアップ
if (Test-Path $procJsonPath) {
    Remove-Item -Force $procJsonPath -ErrorAction SilentlyContinue
}

Write-Host "Done." -ForegroundColor Green
Start-Sleep -Seconds 1
