<#
.SYNOPSIS
  FailurePrism Process Matching & Verification Helper (PowerShell)
#>

if (-not (Test-Path Function:\Get-ProcessDetails)) {
    function Get-ProcessDetails($pidToQuery) {
        if (-not $pidToQuery) { return $null }
        try {
            $proc = Get-Process -Id $pidToQuery -ErrorAction SilentlyContinue
            if (-not $proc) { return $null }

            $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $pidToQuery" -ErrorAction SilentlyContinue
            $execPath = if ($cim -and $cim.ExecutablePath) { $cim.ExecutablePath } else { $proc.Path }
            $cmdLine = if ($cim -and $cim.CommandLine) { $cim.CommandLine } else { "" }

            return [PSCustomObject]@{
                Id             = $proc.Id
                ProcessName    = $proc.ProcessName
                ExecutablePath = $execPath
                CommandLine    = $cmdLine
                StartTime      = $proc.StartTime
            }
        } catch {
            return $null
        }
    }
}

function Test-ProcessStartTimeMatches($actualStartTime, $expectedStartTime) {
    if (-not $expectedStartTime) { return $true }
    if (-not $actualStartTime) { return $false }
    try {
        $actualUtc = ([datetime]$actualStartTime).ToUniversalTime()
        $expectedUtc = ([datetime]$expectedStartTime).ToUniversalTime()
        $diffSeconds = [Math]::Abs(($actualUtc - $expectedUtc).TotalSeconds)
        return ($diffSeconds -le 2)
    } catch {
        return $false
    }
}

function Test-CommandLineContainsFullPath($commandLine, $expectedFullPath) {
    if ([string]::IsNullOrWhiteSpace($commandLine) -or [string]::IsNullOrWhiteSpace($expectedFullPath)) {
        return $false
    }
    $normPath = [System.IO.Path]::GetFullPath($expectedFullPath)
    $normPathSlash = $normPath.Replace('\', '/')

    foreach ($candidate in @($normPath, $normPathSlash)) {
        $idx = $commandLine.IndexOf($candidate, [System.StringComparison]::OrdinalIgnoreCase)
        while ($idx -ge 0) {
            $afterIdx = $idx + $candidate.Length
            $validEnd = ($afterIdx -ge $commandLine.Length) -or ($commandLine[$afterIdx] -match '[\s"'']')
            $validStart = ($idx -eq 0) -or ($commandLine[$idx - 1] -match '[\s"'']')
            if ($validStart -and $validEnd) {
                return $true
            }
            $idx = $commandLine.IndexOf($candidate, $idx + 1, [System.StringComparison]::OrdinalIgnoreCase)
        }
    }
    return $false
}

function Test-IsMatchingGatewayProcess($pidToQuery, $expectedDirOrPath, $expectedStartTime = $null) {
    if ([string]::IsNullOrWhiteSpace($expectedDirOrPath)) { return $false }

    $info = Get-ProcessDetails $pidToQuery
    if (-not $info) { return $false }

    if ($info.ProcessName -notmatch '^llm-gateway(\.exe)?$') {
        return $false
    }

    if (-not (Test-ProcessStartTimeMatches $info.StartTime $expectedStartTime)) {
        return $false
    }

    $normExpected = [System.IO.Path]::GetFullPath($expectedDirOrPath).TrimEnd('\', '/')
    $pathMatched = $false

    if ($info.ExecutablePath) {
        try {
            $normActual = [System.IO.Path]::GetFullPath($info.ExecutablePath)
            if ($normActual.Equals($normExpected, [System.StringComparison]::OrdinalIgnoreCase) -or
                $normActual.StartsWith($normExpected + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
                $pathMatched = $true
            }
        } catch {}
    }

    if ((-not $pathMatched) -and $info.CommandLine) {
        if ($normExpected.EndsWith('.exe', [System.StringComparison]::OrdinalIgnoreCase)) {
            $pathMatched = Test-CommandLineContainsFullPath $info.CommandLine $normExpected
        } else {
            $exeInDir = Join-Path $normExpected 'llm-gateway.exe'
            $pathMatched = Test-CommandLineContainsFullPath $info.CommandLine $exeInDir
        }
    }

    return $pathMatched
}

function Test-IsMatchingServerProcess($pidToQuery, $expectedServerScriptPath, $expectedStartTime = $null) {
    if ([string]::IsNullOrWhiteSpace($expectedServerScriptPath)) { return $false }

    $info = Get-ProcessDetails $pidToQuery
    if (-not $info) { return $false }

    if ($info.ProcessName -notmatch '^node(\.exe)?$') {
        return $false
    }

    if (-not (Test-ProcessStartTimeMatches $info.StartTime $expectedStartTime)) {
        return $false
    }

    return (Test-CommandLineContainsFullPath $info.CommandLine $expectedServerScriptPath)
}

function Test-ShouldStopServerProcess($pidToQuery, $expectedServerScriptPath, $metaWebServer = $null) {
    if ([string]::IsNullOrWhiteSpace($expectedServerScriptPath)) { return $false }

    if ($metaWebServer -and ($null -ne $metaWebServer.pid) -and ($metaWebServer.pid -eq $pidToQuery)) {
        if (-not $metaWebServer.startTime) {
            return $false
        }
        if ($metaWebServer.script) {
            try {
                $metaScriptFull = [System.IO.Path]::GetFullPath($metaWebServer.script)
                $expectedFull = [System.IO.Path]::GetFullPath($expectedServerScriptPath)
                if (-not $metaScriptFull.Equals($expectedFull, [System.StringComparison]::OrdinalIgnoreCase)) {
                    return $false
                }
            } catch {
                return $false
            }
        }
        return (Test-IsMatchingServerProcess $pidToQuery $expectedServerScriptPath $metaWebServer.startTime)
    }

    return (Test-IsMatchingServerProcess $pidToQuery $expectedServerScriptPath $null)
}

function Test-ShouldStopGatewayProcess($pidToQuery, $expectedGatewayDirOrPath, $metaGateway = $null) {
    if ([string]::IsNullOrWhiteSpace($expectedGatewayDirOrPath)) { return $false }

    if ($metaGateway -and ($null -ne $metaGateway.pid) -and ($metaGateway.pid -eq $pidToQuery)) {
        if (-not $metaGateway.startTime) {
            return $false
        }
        $targetPath = if ($metaGateway.executable) { $metaGateway.executable } else { $expectedGatewayDirOrPath }
        try {
            $normExpected = [System.IO.Path]::GetFullPath($expectedGatewayDirOrPath).TrimEnd('\', '/')
            $normTarget = [System.IO.Path]::GetFullPath($targetPath).TrimEnd('\', '/')
            if (-not ($normTarget.Equals($normExpected, [System.StringComparison]::OrdinalIgnoreCase) -or
                      $normTarget.StartsWith($normExpected + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase))) {
                return $false
            }
        } catch {
            return $false
        }
        return (Test-IsMatchingGatewayProcess $pidToQuery $targetPath $metaGateway.startTime)
    }

    return (Test-IsMatchingGatewayProcess $pidToQuery $expectedGatewayDirOrPath $null)
}

