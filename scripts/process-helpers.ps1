<#
.SYNOPSIS
  FailurePrism Process Matching & Verification Helper (PowerShell)
#>

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

function Test-IsMatchingGatewayProcess($pidToQuery, $expectedDirOrPath) {
    $info = Get-ProcessDetails $pidToQuery
    if (-not $info) { return $false }

    if ($info.ProcessName -notmatch '^llm-gateway(\.exe)?$') {
        return $false
    }

    if ($expectedDirOrPath) {
        $normExpected = [System.IO.Path]::GetFullPath($expectedDirOrPath).TrimEnd('\', '/')
        if ($info.ExecutablePath) {
            $normActual = [System.IO.Path]::GetFullPath($info.ExecutablePath)
            if ($normActual.StartsWith($normExpected, [System.StringComparison]::OrdinalIgnoreCase)) {
                return $true
            }
        }
        if ($info.CommandLine -and $info.CommandLine.IndexOf($normExpected, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return $true
        }
        return $false
    }

    return $true
}

function Test-IsMatchingServerProcess($pidToQuery, $expectedServerScriptPath) {
    $info = Get-ProcessDetails $pidToQuery
    if (-not $info) { return $false }

    if ($info.ProcessName -notmatch '^node(\.exe)?$') {
        return $false
    }

    if ($expectedServerScriptPath) {
        $normScript = [System.IO.Path]::GetFullPath($expectedServerScriptPath)
        $scriptName = [System.IO.Path]::GetFileName($normScript)
        if ($info.CommandLine -and ($info.CommandLine.IndexOf($normScript, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or $info.CommandLine.IndexOf($scriptName, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)) {
            return $true
        }
        return $false
    }

    return $true
}
