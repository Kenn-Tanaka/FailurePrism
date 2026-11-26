<#
.SYNOPSIS
  FailurePrism Browser Discovery, Configuration & Launch Helpers (PowerShell)
#>

function Get-BrowserConfigPath([string]$rootDir) {
    return (Join-Path (Join-Path $rootDir ".runtime") "browser.json")
}

function Get-FailurePrismRootConfigPath([string]$rootDir) {
    return (Join-Path $rootDir "failureprism.config.json")
}

function Read-FailurePrismRootConfig([string]$rootDir) {
    $cfgPath = Get-FailurePrismRootConfigPath $rootDir
    if (-not (Test-Path -LiteralPath $cfgPath -PathType Leaf)) {
        return $null
    }
    try {
        $raw = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 -ErrorAction Stop
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        return ($raw | ConvertFrom-Json -ErrorAction Stop)
    } catch {
        return $null
    }
}

function Test-IsChromiumBrowserExecutable([string]$exePathOrName) {
    if ([string]::IsNullOrWhiteSpace($exePathOrName)) { return $false }
    $leaf = [System.IO.Path]::GetFileName($exePathOrName).ToLowerInvariant()
    return ($leaf -in @(
        "chrome.exe",
        "msedge.exe",
        "brave.exe",
        "vivaldi.exe",
        "opera.exe",
        "chromium.exe",
        "arc.exe",
        "island.exe"
    ))
}

function ConvertFrom-LauncherCommandPath([string]$rawCommand) {
    if ([string]::IsNullOrWhiteSpace($rawCommand)) { return $null }
    $trimmed = $rawCommand.Trim()
    if ($trimmed.StartsWith('"')) {
        $endQuote = $trimmed.IndexOf('"', 1)
        if ($endQuote -gt 1) {
            return $trimmed.Substring(1, $endQuote - 1)
        }
    }
    $exeIdx = $trimmed.IndexOf(".exe", [System.StringComparison]::OrdinalIgnoreCase)
    if ($exeIdx -ge 0) {
        return $trimmed.Substring(0, $exeIdx + 4)
    }
    return ($trimmed -split '\s+')[0]
}

function Get-KnownBrowserCatalog {
    $pf = $env:ProgramFiles
    $pfx86 = ${env:ProgramFiles(x86)}
    $localApp = $env:LOCALAPPDATA

    return @(
        [PSCustomObject]@{
            Id         = "chrome"
            Aliases    = @("chrome", "google-chrome", "chrome.exe")
            Name       = "Google Chrome"
            ExeNames   = @("chrome.exe")
            IsChromium = $true
            Candidates = @(
                $(if ($pf) { Join-Path $pf "Google\Chrome\Application\chrome.exe" }),
                $(if ($pfx86) { Join-Path $pfx86 "Google\Chrome\Application\chrome.exe" }),
                $(if ($localApp) { Join-Path $localApp "Google\Chrome\Application\chrome.exe" })
            ) | Where-Object { $_ }
        },
        [PSCustomObject]@{
            Id         = "msedge"
            Aliases    = @("msedge", "edge", "msedge.exe")
            Name       = "Microsoft Edge"
            ExeNames   = @("msedge.exe")
            IsChromium = $true
            Candidates = @(
                $(if ($pfx86) { Join-Path $pfx86 "Microsoft\Edge\Application\msedge.exe" }),
                $(if ($pf) { Join-Path $pf "Microsoft\Edge\Application\msedge.exe" }),
                $(if ($localApp) { Join-Path $localApp "Microsoft\Edge\Application\msedge.exe" })
            ) | Where-Object { $_ }
        },
        [PSCustomObject]@{
            Id         = "firefox"
            Aliases    = @("firefox", "mozilla-firefox", "firefox.exe")
            Name       = "Mozilla Firefox"
            ExeNames   = @("firefox.exe")
            IsChromium = $false
            Candidates = @(
                $(if ($pf) { Join-Path $pf "Mozilla Firefox\firefox.exe" }),
                $(if ($pfx86) { Join-Path $pfx86 "Mozilla Firefox\firefox.exe" }),
                $(if ($localApp) { Join-Path $localApp "Mozilla Firefox\firefox.exe" })
            ) | Where-Object { $_ }
        },
        [PSCustomObject]@{
            Id         = "brave"
            Aliases    = @("brave", "brave-browser", "brave.exe")
            Name       = "Brave Browser"
            ExeNames   = @("brave.exe")
            IsChromium = $true
            Candidates = @(
                $(if ($pf) { Join-Path $pf "BraveSoftware\Brave-Browser\Application\brave.exe" }),
                $(if ($pfx86) { Join-Path $pfx86 "BraveSoftware\Brave-Browser\Application\brave.exe" }),
                $(if ($localApp) { Join-Path $localApp "BraveSoftware\Brave-Browser\Application\brave.exe" })
            ) | Where-Object { $_ }
        },
        [PSCustomObject]@{
            Id         = "vivaldi"
            Aliases    = @("vivaldi", "vivaldi.exe")
            Name       = "Vivaldi"
            ExeNames   = @("vivaldi.exe")
            IsChromium = $true
            Candidates = @(
                $(if ($localApp) { Join-Path $localApp "Vivaldi\Application\vivaldi.exe" }),
                $(if ($pf) { Join-Path $pf "Vivaldi\Application\vivaldi.exe" }),
                $(if ($pfx86) { Join-Path $pfx86 "Vivaldi\Application\vivaldi.exe" })
            ) | Where-Object { $_ }
        },
        [PSCustomObject]@{
            Id         = "opera"
            Aliases    = @("opera", "opera.exe")
            Name       = "Opera"
            ExeNames   = @("opera.exe", "launcher.exe")
            IsChromium = $true
            Candidates = @(
                $(if ($localApp) { Join-Path $localApp "Programs\Opera\opera.exe" }),
                $(if ($localApp) { Join-Path $localApp "Programs\Opera\launcher.exe" }),
                $(if ($pf) { Join-Path $pf "Opera\opera.exe" })
            ) | Where-Object { $_ }
        }
    )
}

function Find-ExecutableFromAppPaths([string]$exeName) {
    $regRoots = @(
        "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$exeName",
        "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\$exeName",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\$exeName"
    )
    foreach ($rk in $regRoots) {
        try {
            if (Test-Path -LiteralPath $rk) {
                $val = (Get-ItemProperty -LiteralPath $rk -ErrorAction SilentlyContinue).'(default)'
                $parsed = ConvertFrom-LauncherCommandPath $val
                if ($parsed -and (Test-Path -LiteralPath $parsed -PathType Leaf)) {
                    return [System.IO.Path]::GetFullPath($parsed)
                }
            }
        } catch {}
    }
    return $null
}

function Get-InstalledBrowsers {
    $results = @()
    $seenPaths = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)

    foreach ($entry in (Get-KnownBrowserCatalog)) {
        $foundPath = $null
        foreach ($exeName in $entry.ExeNames) {
            $appPath = Find-ExecutableFromAppPaths $exeName
            if ($appPath) {
                $foundPath = $appPath
                break
            }
        }
        if (-not $foundPath) {
            foreach ($cand in $entry.Candidates) {
                if (Test-Path -LiteralPath $cand -PathType Leaf) {
                    $foundPath = [System.IO.Path]::GetFullPath($cand)
                    break
                }
            }
        }
        if (-not $foundPath) {
            foreach ($exeName in $entry.ExeNames) {
                $cmd = Get-Command $exeName -ErrorAction SilentlyContinue
                if ($cmd -and $cmd.Source -and (Test-Path -LiteralPath $cmd.Source -PathType Leaf)) {
                    $foundPath = [System.IO.Path]::GetFullPath($cmd.Source)
                    break
                }
            }
        }
        if ($foundPath -and $seenPaths.Add($foundPath)) {
            $results += [PSCustomObject]@{
                Id             = $entry.Id
                Name           = $entry.Name
                ExecutablePath = $foundPath
                IsChromium     = [bool]$entry.IsChromium
            }
        }
    }

    $startMenuRoots = @(
        "HKCU:\SOFTWARE\Clients\StartMenuInternet",
        "HKLM:\SOFTWARE\Clients\StartMenuInternet",
        "HKLM:\SOFTWARE\WOW6432Node\Clients\StartMenuInternet"
    )
    foreach ($smRoot in $startMenuRoots) {
        try {
            if (-not (Test-Path -LiteralPath $smRoot)) { continue }
            foreach ($subKey in (Get-ChildItem -LiteralPath $smRoot -ErrorAction SilentlyContinue)) {
                $cmdKey = Join-Path $subKey.PSPath "shell\open\command"
                if (-not (Test-Path -LiteralPath $cmdKey)) { continue }
                $rawCmd = (Get-ItemProperty -LiteralPath $cmdKey -ErrorAction SilentlyContinue).'(default)'
                $exePath = ConvertFrom-LauncherCommandPath $rawCmd
                if (-not $exePath -or -not (Test-Path -LiteralPath $exePath -PathType Leaf)) { continue }
                $fullExe = [System.IO.Path]::GetFullPath($exePath)
                $leafLower = [System.IO.Path]::GetFileName($fullExe).ToLowerInvariant()
                if ($leafLower -eq "iexplore.exe") { continue }
                if (-not $seenPaths.Add($fullExe)) { continue }

                $dispName = (Get-ItemProperty -LiteralPath $subKey.PSPath -ErrorAction SilentlyContinue).'(default)'
                if ([string]::IsNullOrWhiteSpace($dispName)) {
                    $dispName = [System.IO.Path]::GetFileNameWithoutExtension($fullExe)
                }
                $idSlug = ([System.IO.Path]::GetFileNameWithoutExtension($fullExe)).ToLowerInvariant()
                $results += [PSCustomObject]@{
                    Id             = $idSlug
                    Name           = [string]$dispName
                    ExecutablePath = $fullExe
                    IsChromium     = (Test-IsChromiumBrowserExecutable $fullExe)
                }
            }
        } catch {}
    }

    return $results
}

function Resolve-BrowserExecutable([string]$browserSpec, $installedBrowsers = $null) {
    if ([string]::IsNullOrWhiteSpace($browserSpec)) { return $null }
    $spec = $browserSpec.Trim().Trim('"')
    if (Test-Path -LiteralPath $spec -PathType Leaf) {
        return [System.IO.Path]::GetFullPath($spec)
    }

    $specLower = $spec.ToLowerInvariant()
    $installed = if ($null -ne $installedBrowsers) { $installedBrowsers } else { Get-InstalledBrowsers }

    foreach ($b in $installed) {
        if ($b.Id.ToLowerInvariant() -eq $specLower -or
            $b.Name.ToLowerInvariant() -eq $specLower -or
            [System.IO.Path]::GetFileName($b.ExecutablePath).ToLowerInvariant() -eq $specLower) {
            if (Test-Path -LiteralPath $b.ExecutablePath -PathType Leaf) {
                return $b.ExecutablePath
            }
        }
    }

    foreach ($entry in (Get-KnownBrowserCatalog)) {
        if ($specLower -in $entry.Aliases) {
            foreach ($exeName in $entry.ExeNames) {
                $appPath = Find-ExecutableFromAppPaths $exeName
                if ($appPath) { return $appPath }
            }
            foreach ($cand in $entry.Candidates) {
                if (Test-Path -LiteralPath $cand -PathType Leaf) {
                    return [System.IO.Path]::GetFullPath($cand)
                }
            }
        }
    }

    $cmd = Get-Command $spec -ErrorAction SilentlyContinue
    if ($cmd -and $cmd.Source -and (Test-Path -LiteralPath $cmd.Source -PathType Leaf)) {
        return [System.IO.Path]::GetFullPath($cmd.Source)
    }

    return $null
}

function Read-SavedBrowserConfig([string]$rootDir) {
    $cfgPath = Get-BrowserConfigPath $rootDir
    if (-not (Test-Path -LiteralPath $cfgPath -PathType Leaf)) {
        return $null
    }
    try {
        $raw = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 -ErrorAction Stop
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        return ($raw | ConvertFrom-Json -ErrorAction Stop)
    } catch {
        return $null
    }
}

function Save-BrowserConfig(
    [string]$rootDir,
    [ValidateSet("default", "none", "browser")]
    [string]$mode,
    [string]$browser = "",
    [string]$executablePath = "",
    [bool]$appMode = $false,
    [string[]]$extraArgs = @()
) {
    $runtimeDir = Join-Path $rootDir ".runtime"
    $cfgPath = Get-BrowserConfigPath $rootDir
    $rootCfgPath = Get-FailurePrismRootConfigPath $rootDir
    $defaultRootCfgPath = Join-Path $rootDir "failureprism.config.default.json"

    $cleanArgs = @()
    if ($extraArgs) {
        foreach ($a in $extraArgs) {
            if (-not [string]::IsNullOrWhiteSpace($a)) {
                $cleanArgs += $a.Trim()
            }
        }
    }

    # Sync root failureprism.config.json whenever it (or its default template) exists in rootDir
    if ((Test-Path -LiteralPath $rootCfgPath -PathType Leaf) -or (Test-Path -LiteralPath $defaultRootCfgPath -PathType Leaf)) {
        $rootObj = Read-FailurePrismRootConfig $rootDir
        $startHash = "#menu"
        $webPort = 3000
        $gwPort = 8765
        if ($rootObj) {
            if ($rootObj.browser -and $rootObj.browser.startHash) {
                $startHash = [string]$rootObj.browser.startHash
            }
            if ($rootObj.ports) {
                if ($rootObj.ports.web) { $webPort = [int]$rootObj.ports.web }
                if ($rootObj.ports.gateway) { $gwPort = [int]$rootObj.ports.gateway }
            }
        }
        $rootPayload = [ordered]@{
            schema_version = 1
            browser        = [ordered]@{
                mode           = $mode
                target         = $(if ($mode -eq "browser") { $browser } else { "" })
                executablePath = $(if ($mode -eq "browser") { $executablePath } else { "" })
                appMode        = $(if ($mode -eq "browser") { [bool]$appMode } else { $false })
                args           = $(if ($mode -eq "browser") { $cleanArgs } else { @() })
                startHash      = $startHash
            }
            ports          = [ordered]@{
                web     = $webPort
                gateway = $gwPort
            }
        }
        $rootPayload | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $rootCfgPath -Encoding UTF8
    }

    if ($mode -eq "default") {
        if (Test-Path -LiteralPath $cfgPath) {
            Remove-Item -LiteralPath $cfgPath -Force -ErrorAction SilentlyContinue
        }
        return $null
    }

    if (-not (Test-Path -LiteralPath $runtimeDir)) {
        New-Item -ItemType Directory -Path $runtimeDir -Force | Out-Null
    }

    $payload = [ordered]@{
        version        = 1
        mode           = $mode
        browser        = $browser
        executablePath = $executablePath
        appMode        = [bool]$appMode
        extraArgs      = $cleanArgs
        updatedAt      = (Get-Date).ToString("o")
    }
    $payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $cfgPath -Encoding UTF8
    return [PSCustomObject]$payload
}

function Split-CommandLineArgs([string]$rawArgs) {
    if ([string]::IsNullOrWhiteSpace($rawArgs)) { return @() }
    $tokens = @()
    $pattern = '"([^"]*)"|''([^'']*)''|(\S+)'
    foreach ($m in [regex]::Matches($rawArgs, $pattern)) {
        if ($m.Groups[1].Success) {
            $tokens += $m.Groups[1].Value
        } elseif ($m.Groups[2].Success) {
            $tokens += $m.Groups[2].Value
        } elseif ($m.Groups[3].Success) {
            $tokens += $m.Groups[3].Value
        }
    }
    return $tokens
}

function Format-ProcessArgument([string]$arg) {
    if ($null -eq $arg) { return '""' }
    if ($arg.Length -gt 0 -and $arg -notmatch '[\s"]') {
        return $arg
    }
    $escaped = $arg -replace '(\\*)"', '$1$1\"'
    $escaped = $escaped -replace '(\\+)$', '$1$1'
    return '"' + $escaped + '"'
}

function Resolve-FailurePrismBrowserConfig(
    [string]$rootDir,
    [string]$cliBrowser = "",
    [string[]]$cliBrowserArgs = @(),
    [switch]$cliAppMode,
    [switch]$cliNoBrowser
) {
    if ($cliNoBrowser) {
        return [PSCustomObject]@{
            Source         = "cli"
            Mode           = "none"
            Browser        = "none"
            ExecutablePath = ""
            AppMode        = $false
            ExtraArgs      = @()
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($cliBrowser)) {
        $norm = $cliBrowser.Trim().ToLowerInvariant()
        if ($norm -in @("none", "off", "false", "0")) {
            return [PSCustomObject]@{
                Source         = "cli"
                Mode           = "none"
                Browser        = "none"
                ExecutablePath = ""
                AppMode        = $false
                ExtraArgs      = @()
            }
        }
        if ($norm -in @("default", "system", "auto")) {
            return [PSCustomObject]@{
                Source         = "cli"
                Mode           = "default"
                Browser        = "default"
                ExecutablePath = ""
                AppMode        = $false
                ExtraArgs      = @()
            }
        }
        return [PSCustomObject]@{
            Source         = "cli"
            Mode           = "browser"
            Browser        = $cliBrowser.Trim()
            ExecutablePath = ""
            AppMode        = [bool]$cliAppMode
            ExtraArgs      = @($cliBrowserArgs | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        }
    }

    $envBrowser = $env:FAILUREPRISM_BROWSER
    if (-not [string]::IsNullOrWhiteSpace($envBrowser)) {
        $normEnv = $envBrowser.Trim().ToLowerInvariant()
        if ($normEnv -in @("none", "off", "false", "0")) {
            return [PSCustomObject]@{
                Source         = "env"
                Mode           = "none"
                Browser        = "none"
                ExecutablePath = ""
                AppMode        = $false
                ExtraArgs      = @()
            }
        }
        if ($normEnv -in @("default", "system", "auto")) {
            return [PSCustomObject]@{
                Source         = "env"
                Mode           = "default"
                Browser        = "default"
                ExecutablePath = ""
                AppMode        = $false
                ExtraArgs      = @()
            }
        }
        $envApp = ($env:FAILUREPRISM_BROWSER_APP_MODE -in @("1", "true", "yes")) -or [bool]$cliAppMode
        $envExtra = Split-CommandLineArgs $env:FAILUREPRISM_BROWSER_ARGS
        return [PSCustomObject]@{
            Source         = "env"
            Mode           = "browser"
            Browser        = $envBrowser.Trim()
            ExecutablePath = ""
            AppMode        = $envApp
            ExtraArgs      = @($envExtra + @($cliBrowserArgs | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }))
        }
    }

    $rootSaved = Read-FailurePrismRootConfig $rootDir
    if ($rootSaved -and $rootSaved.browser) {
        $rb = $rootSaved.browser
        $rMode = if ($rb.mode) { ([string]$rb.mode).Trim().ToLowerInvariant() } else { "default" }
        $rTarget = if ($rb.target) { ([string]$rb.target).Trim() } elseif ($rb.browser) { ([string]$rb.browser).Trim() } else { "" }
        $rExe = if ($rb.executablePath) { ([string]$rb.executablePath).Trim() } else { "" }
        if ($rMode -eq "none" -or ($rTarget.ToLowerInvariant() -in @("none", "off", "false", "0"))) {
            return [PSCustomObject]@{
                Source         = "config"
                Mode           = "none"
                Browser        = "none"
                ExecutablePath = ""
                AppMode        = $false
                ExtraArgs      = @()
            }
        }
        if ($rMode -eq "browser" -or ((-not [string]::IsNullOrWhiteSpace($rTarget)) -and ($rTarget.ToLowerInvariant() -notin @("default", "system", "auto"))) -or (-not [string]::IsNullOrWhiteSpace($rExe))) {
            $rArgs = @()
            $rawList = if ($rb.args) { $rb.args } elseif ($rb.extraArgs) { $rb.extraArgs } else { @() }
            foreach ($a in $rawList) {
                if (-not [string]::IsNullOrWhiteSpace([string]$a)) {
                    $rArgs += ([string]$a).Trim()
                }
            }
            return [PSCustomObject]@{
                Source         = "config"
                Mode           = "browser"
                Browser        = $rTarget
                ExecutablePath = $rExe
                AppMode        = ([bool]$rb.appMode -or [bool]$cliAppMode)
                ExtraArgs      = @($rArgs + @($cliBrowserArgs | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }))
            }
        }
    }

    $saved = Read-SavedBrowserConfig $rootDir
    if ($saved -and $saved.mode) {
        $savedMode = ([string]$saved.mode).ToLowerInvariant()
        if ($savedMode -eq "none") {
            return [PSCustomObject]@{
                Source         = "config"
                Mode           = "none"
                Browser        = "none"
                ExecutablePath = ""
                AppMode        = $false
                ExtraArgs      = @()
            }
        }
        if ($savedMode -eq "browser") {
            $savedArgs = @()
            if ($saved.extraArgs) {
                foreach ($a in $saved.extraArgs) {
                    if (-not [string]::IsNullOrWhiteSpace([string]$a)) {
                        $savedArgs += ([string]$a).Trim()
                    }
                }
            }
            return [PSCustomObject]@{
                Source         = "config"
                Mode           = "browser"
                Browser        = [string]$saved.browser
                ExecutablePath = [string]$saved.executablePath
                AppMode        = ([bool]$saved.appMode -or [bool]$cliAppMode)
                ExtraArgs      = @($savedArgs + @($cliBrowserArgs | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }))
            }
        }
    }

    return [PSCustomObject]@{
        Source         = "default"
        Mode           = "default"
        Browser        = "default"
        ExecutablePath = ""
        AppMode        = $false
        ExtraArgs      = @()
    }
}

function Open-FailurePrismBrowser([string]$url, $browserConfig, $installedBrowsers = $null) {
    if (-not $browserConfig -or $browserConfig.Mode -eq "default") {
        Write-Host "Opening system default browser to FailurePrism Menu..." -ForegroundColor Green
        Start-Process -FilePath $url | Out-Null
        return [PSCustomObject]@{
            LaunchedMode   = "default"
            ExecutablePath = ""
            Arguments      = @($url)
        }
    }

    if ($browserConfig.Mode -eq "none") {
        Write-Host "Skipping automatic browser launch (mode: none)." -ForegroundColor Yellow
        return [PSCustomObject]@{
            LaunchedMode   = "none"
            ExecutablePath = ""
            Arguments      = @()
        }
    }

    $exePath = $null
    if (-not [string]::IsNullOrWhiteSpace($browserConfig.ExecutablePath) -and
        (Test-Path -LiteralPath $browserConfig.ExecutablePath -PathType Leaf)) {
        $exePath = [System.IO.Path]::GetFullPath($browserConfig.ExecutablePath)
    }
    if (-not $exePath -and -not [string]::IsNullOrWhiteSpace($browserConfig.Browser)) {
        $exePath = Resolve-BrowserExecutable $browserConfig.Browser $installedBrowsers
    }

    if (-not $exePath) {
        $requested = if ($browserConfig.Browser) { $browserConfig.Browser } else { $browserConfig.ExecutablePath }
        Write-Host "[WARN] Configured browser '$requested' was not found. Falling back to system default browser." -ForegroundColor Yellow
        Start-Process -FilePath $url | Out-Null
        return [PSCustomObject]@{
            LaunchedMode   = "fallback_default"
            ExecutablePath = ""
            Arguments      = @($url)
        }
    }

    $rawArgs = @()
    if ($browserConfig.ExtraArgs) {
        foreach ($a in $browserConfig.ExtraArgs) {
            if (-not [string]::IsNullOrWhiteSpace([string]$a)) {
                $rawArgs += [string]$a
            }
        }
    }

    if ($browserConfig.AppMode -and (Test-IsChromiumBrowserExecutable $exePath)) {
        $rawArgs += "--app=$url"
    } else {
        $rawArgs += $url
    }

    $formattedArgString = ($rawArgs | ForEach-Object { Format-ProcessArgument $_ }) -join " "
    Write-Host "Opening browser ($([System.IO.Path]::GetFileName($exePath))) to FailurePrism Menu..." -ForegroundColor Green
    Start-Process -FilePath $exePath -ArgumentList $formattedArgString | Out-Null

    return [PSCustomObject]@{
        LaunchedMode   = "browser"
        ExecutablePath = $exePath
        Arguments      = $rawArgs
    }
}
