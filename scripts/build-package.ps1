<#
.SYNOPSIS
    FailurePrism (TPDD-Editor + VTA-Editor + Full LLM-Gateway v2.0.0) Unified Package Builder
#>
[CmdletBinding()]
param(
    [string]$Version = "1.0.0",
    [switch]$SkipTests,
    [switch]$RebuildGateway
)

$ErrorActionPreference = "Stop"

Write-Host "==================================================================" -ForegroundColor Cyan
Write-Host "  FailurePrism Unified Build & Packaging Pipeline v$Version" -ForegroundColor Cyan
Write-Host "  (TPDD-Editor + VTA-Editor + Full LLM-Gateway v2.0.0)" -ForegroundColor Cyan
Write-Host "==================================================================" -ForegroundColor Cyan

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $scriptDir
$releaseDir = Join-Path $rootDir "release"
$gatewayRoot = Join-Path $rootDir "gateway"
$stageDir = Join-Path $env:TEMP "FailurePrism-pkg\FailurePrism_v$Version"

# 1. Check Node.js & npm
Write-Host "`n[1/6] Checking Node.js environment..." -ForegroundColor Yellow
$nodeCmd = Get-Command "node" -ErrorAction SilentlyContinue
if ((-not $nodeCmd) -and (Test-Path "C:\Program Files\nodejs\node.exe")) {
    $env:PATH = "C:\Program Files\nodejs;" + $env:PATH
    $nodeCmd = Get-Command "node" -ErrorAction SilentlyContinue
}
if (-not $nodeCmd) {
    throw "Node.js (v18+) is not installed or not in PATH."
}
Write-Host "  Node.js: $((& $nodeCmd.Source -v).Trim()) (OK)" -ForegroundColor Green

Push-Location $rootDir
try {
    if (-not (Test-Path "node_modules")) {
        Write-Host "  Installing npm dependencies..." -ForegroundColor Cyan
        cmd /c "npm install"
        if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
    }

    # 2. Typecheck & Automated Unit Tests
    if (-not $SkipTests) {
        Write-Host "`n[2/6] Running TypeScript typecheck & automated unit tests..." -ForegroundColor Yellow
        cmd /c "npm run typecheck"
        if ($LASTEXITCODE -ne 0) { throw "TypeScript typecheck failed." }
        cmd /c "npm test"
        if ($LASTEXITCODE -ne 0) { throw "Unit tests failed." }
        Write-Host "  All typechecks and unit tests passed!" -ForegroundColor Green
    } else {
        Write-Host "`n[2/6] Skipping unit tests (-SkipTests)." -ForegroundColor Gray
    }

    # 3. Build Unified Frontend
    Write-Host "`n[3/6] Building unified frontend (Menu + TPDD-Editor + VTA-Editor)..." -ForegroundColor Yellow
    cmd /c "npm run build"
    if ($LASTEXITCODE -ne 0 -or (-not (Test-Path "dist\index.html"))) {
        throw "Frontend production build failed."
    }
    Write-Host "  Frontend built successfully in dist/." -ForegroundColor Green
} finally {
    Pop-Location
}

# 4. Verify / Build Full LLM-Gateway v2.0.0 Binaries
Write-Host "`n[4/6] Verifying Full LLM-Gateway v2.0.0 binaries..." -ForegroundColor Yellow
if ($RebuildGateway) {
    Push-Location $gatewayRoot
    try {
        Write-Host "  Rebuilding LLM-Gateway v2.0.0 with CMake & Visual Studio 2022..." -ForegroundColor Cyan
        & cmake -S . -B build -G "Visual Studio 17 2022" -A x64
        if ($LASTEXITCODE -ne 0) { throw "CMake configure failed." }
        & cmake --build build --config Release --parallel
        if ($LASTEXITCODE -ne 0) { throw "CMake build failed." }
        & cmake --build build --config Release --target verify_imports
        if ($LASTEXITCODE -ne 0) { throw "verify_imports failed." }
        New-Item -ItemType Directory -Force bin | Out-Null
        Copy-Item "build\Release\llm-gateway.exe" "bin\" -Force
        Copy-Item "build\Release\MaintenanceTool.exe" "bin\" -Force
    } finally {
        Pop-Location
    }
}

$gwExe = Join-Path $gatewayRoot "bin\llm-gateway.exe"
$mtExe = Join-Path $gatewayRoot "bin\MaintenanceTool.exe"
if (-not (Test-Path $gwExe)) { throw "Missing full LLM-Gateway binary: $gwExe" }
if (-not (Test-Path $mtExe)) { throw "Missing MaintenanceTool GUI binary: $mtExe" }

$gwVer = (& $gwExe --version).Trim()
Write-Host "  Verified Gateway binary: $gwVer" -ForegroundColor Green
Write-Host "  Verified GUI binary:     MaintenanceTool.exe" -ForegroundColor Green

# 5. Stage Unified Release Package
Write-Host "`n[5/6] Assembling release staging directory..." -ForegroundColor Yellow
if (Test-Path "$rootDir\scripts\generate-third-party-licenses.mjs") {
    node "$rootDir\scripts\generate-third-party-licenses.mjs" | Out-Null
}
if (Test-Path $stageDir) {
    Get-ChildItem $stageDir -Recurse -Force | ForEach-Object { $_.Attributes = 'Normal' }
    Remove-Item $stageDir -Recurse -Force
}

New-Item -ItemType Directory -Path `
    $stageDir, `
    "$stageDir\app\dist", `
    "$stageDir\scripts", `
    "$stageDir\gateway\config", `
    "$stageDir\gateway\THIRD_PARTY_LICENSES", `
    "$stageDir\samples", `
    "$stageDir\docs" -Force | Out-Null

# 5.1 App (Frontend + Server)
Copy-Item -Recurse -Force "$rootDir\dist\*" "$stageDir\app\dist\"
Copy-Item -Force "$rootDir\scripts\server.mjs" "$stageDir\app\server.mjs"
Set-Content -Path "$stageDir\app\start-app.bat" -Value "@echo off`r`ncd /d `"%~dp0`"`r`nnode server.mjs`r`npause" -Encoding ASCII

# 5.2 Full LLM-Gateway v2.0.0 (Both EXEs in gateway/ per FILE_LAYOUT.md)
Copy-Item -Force $gwExe "$stageDir\gateway\llm-gateway.exe"
Copy-Item -Force $mtExe "$stageDir\gateway\MaintenanceTool.exe"
Copy-Item -Force "$gatewayRoot\config\llm-gateway.default.json" "$stageDir\gateway\config\llm-gateway.default.json"
Copy-Item -Force "$gatewayRoot\config\llm-gateway.default.json" "$stageDir\gateway\config\llm-gateway.json"
Copy-Item -Force "$gatewayRoot\config\llm-gateway.example.json" "$stageDir\gateway\config\llm-gateway.example.json"
Copy-Item -Force "$gatewayRoot\config\llm-gateway.external-only.example.json" "$stageDir\gateway\config\llm-gateway.external-only.example.json"
Copy-Item -Force -Path "$gatewayRoot\FILE_LAYOUT.md", "$gatewayRoot\CONFIG_COMPATIBILITY.md", "$gatewayRoot\NOTICE.md", "$gatewayRoot\LICENSE", "$gatewayRoot\README.md" -Destination "$stageDir\gateway\"
if (Test-Path "$gatewayRoot\THIRD_PARTY_LICENSES\*") {
    Copy-Item -Force "$gatewayRoot\THIRD_PARTY_LICENSES\*" "$stageDir\gateway\THIRD_PARTY_LICENSES\"
}
Set-Content -Path "$stageDir\gateway\start-gateway.bat" -Value "@echo off`r`ncd /d `"%~dp0`"`r`nllm-gateway.exe --config `"%~dp0config\llm-gateway.json`"`r`npause" -Encoding ASCII

# 5.3 Root Launcher Scripts, License, Notices, Samples, Docs & THIRD_PARTY_LICENSES
Copy-Item -Force -Path "$rootDir\start-all.bat", "$rootDir\stop-all.bat", "$rootDir\maintenance-tool.bat", "$rootDir\README.md", "$rootDir\LICENSE", "$rootDir\NOTICE.md" -Destination $stageDir
if (Test-Path "$rootDir\install-shortcut.bat") {
    Copy-Item -Force "$rootDir\install-shortcut.bat" "$stageDir\"
}
Copy-Item -Force "$rootDir\scripts\start-all.ps1", "$rootDir\scripts\stop-all.ps1", "$rootDir\scripts\process-helpers.ps1" "$stageDir\scripts\"
Copy-Item -Force "$rootDir\samples\*" "$stageDir\samples\"
if (Test-Path "$rootDir\THIRD_PARTY_LICENSES") {
    Copy-Item -Recurse -Force "$rootDir\THIRD_PARTY_LICENSES" -Destination (Join-Path $stageDir "THIRD_PARTY_LICENSES")
}
if (Test-Path "$rootDir\docs\PLUGIN_ARCHITECTURE.md") {
    Copy-Item -Force "$rootDir\docs\PLUGIN_ARCHITECTURE.md" "$stageDir\docs\"
}
Get-ChildItem -Path "$rootDir\docs" -Directory | ForEach-Object {
    Copy-Item -Recurse -Force $_.FullName "$stageDir\docs\"
}

# 6. Create Release ZIP & SHA256SUMS.txt
Write-Host "`n[6/6] Compressing release archive..." -ForegroundColor Yellow
New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
$zipPath = Join-Path $releaseDir "FailurePrism_Release_v$Version.zip"
if (Test-Path $zipPath) {
    Remove-Item $zipPath -Force
}

Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($stageDir, $zipPath, [System.IO.Compression.CompressionLevel]::Optimal, $false)

$zipItem = Get-Item $zipPath
$zipSizeMb = [Math]::Round($zipItem.Length / 1MB, 2)
$zipHash = (Get-FileHash $zipPath -Algorithm SHA256).Hash
Set-Content -Path (Join-Path $releaseDir "SHA256SUMS.txt") -Value "$zipHash  $($zipItem.Name)" -Encoding ASCII

Write-Host "`n==================================================================" -ForegroundColor Green
Write-Host "  FailurePrism Release Package Generated Successfully!" -ForegroundColor Green
Write-Host "  Archive: $zipPath ($zipSizeMb MB)" -ForegroundColor White
Write-Host "  SHA256:  $zipHash" -ForegroundColor Gray
Write-Host "==================================================================" -ForegroundColor Green
