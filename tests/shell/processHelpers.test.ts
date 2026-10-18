import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const ROOT_DIR = process.cwd();
const HELPERS_PATH = path.resolve(ROOT_DIR, 'scripts', 'process-helpers.ps1');
const STOP_SCRIPT_PATH = path.resolve(ROOT_DIR, 'scripts', 'stop-all.ps1');

function getPowerShellExecutable(): string | null {
  const candidates = process.platform === 'win32'
    ? ['powershell.exe', 'pwsh.exe']
    : ['pwsh', 'powershell'];

  for (const cmd of candidates) {
    const res = spawnSync(cmd, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], {
      encoding: 'utf-8',
    });
    if (!res.error && res.status === 0) {
      return cmd;
    }
  }
  return null;
}

const psExe = getPowerShellExecutable();

function runPowerShell(script: string): string {
  if (!psExe) {
    throw new Error('PowerShell executable not found');
  }
  const res = spawnSync(
    psExe,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf-8' }
  );
  if (res.error) {
    throw res.error;
  }
  if (res.status !== 0) {
    throw new Error(`PowerShell exited with code ${res.status}: ${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

describe('Process Verification & Safe Stop Helpers (R2-1)', () => {
  const appServerScript = path.resolve(ROOT_DIR, 'scripts', 'server.mjs');
  const otherServerScript = path.resolve(ROOT_DIR, '..', 'other-project', 'server.mjs');
  const appGatewayDir = path.resolve(ROOT_DIR, 'gateway');
  const appGatewayExe = path.resolve(ROOT_DIR, 'gateway', 'bin', 'llm-gateway.exe');
  const otherGatewayExe = path.resolve(ROOT_DIR, '..', 'other-project', 'gateway', 'llm-gateway.exe');

  it('rejects server.mjs running from a different directory', () => {
    const psScript = `
      $ErrorActionPreference = 'Stop'
      function Get-ProcessDetails($pidToQuery) {
        return [PSCustomObject]@{
          Id = $pidToQuery
          ProcessName = 'node'
          ExecutablePath = 'C:\\Program Files\\nodejs\\node.exe'
          CommandLine = 'node "${otherServerScript.replace(/"/g, '`"')}"'
          StartTime = [datetime]'2026-10-18T10:00:00Z'
        }
      }
      . '${HELPERS_PATH.replace(/'/g, "''")}'
      $match = Test-IsMatchingServerProcess 9001 '${appServerScript.replace(/'/g, "''")}'
      $shouldStop = Test-ShouldStopServerProcess 9001 '${appServerScript.replace(/'/g, "''")}' $null
      @{ match = $match; shouldStop = $shouldStop } | ConvertTo-Json -Compress
    `;

    const result = JSON.parse(runPowerShell(psScript));
    expect(result.match).toBe(false);
    expect(result.shouldStop).toBe(false);
  });

  it('identifies this application server.mjs when full script path matches', () => {
    const psScript = `
      $ErrorActionPreference = 'Stop'
      $t = [datetime]'2026-10-18T10:00:00Z'
      function Get-ProcessDetails($pidToQuery) {
        return [PSCustomObject]@{
          Id = $pidToQuery
          ProcessName = 'node'
          ExecutablePath = 'C:\\Program Files\\nodejs\\node.exe'
          CommandLine = '"C:\\Program Files\\nodejs\\node.exe" "${appServerScript.replace(/"/g, '`"')}"'
          StartTime = $t
        }
      }
      . '${HELPERS_PATH.replace(/'/g, "''")}'
      $metaWeb = [PSCustomObject]@{
        pid = 9002
        port = 3000
        script = '${appServerScript.replace(/'/g, "''")}'
        startTime = $t.ToString('o')
      }
      $match = Test-IsMatchingServerProcess 9002 '${appServerScript.replace(/'/g, "''")}' $metaWeb.startTime
      $shouldStop = Test-ShouldStopServerProcess 9002 '${appServerScript.replace(/'/g, "''")}' $metaWeb
      @{ match = $match; shouldStop = $shouldStop } | ConvertTo-Json -Compress
    `;

    const result = JSON.parse(runPowerShell(psScript));
    expect(result.match).toBe(true);
    expect(result.shouldStop).toBe(true);
  });

  it('refuses to stop when metadata PID is reused by another process or has mismatched startTime', () => {
    const psScript = `
      $ErrorActionPreference = 'Stop'
      $recordedTime = [datetime]'2026-10-18T08:00:00Z'
      $reusedProcessStartTime = [datetime]'2026-10-18T09:30:00Z'

      function Get-ProcessDetails($pidToQuery) {
        if ($pidToQuery -eq 9003) {
          # Reused PID running an unrelated node server
          return [PSCustomObject]@{
            Id = 9003
            ProcessName = 'node'
            ExecutablePath = 'C:\\Program Files\\nodejs\\node.exe'
            CommandLine = 'node "${otherServerScript.replace(/"/g, '`"')}"'
            StartTime = $reusedProcessStartTime
          }
        }
        if ($pidToQuery -eq 9004) {
          # Reused PID with newer startTime even if command line looks similar
          return [PSCustomObject]@{
            Id = 9004
            ProcessName = 'node'
            ExecutablePath = 'C:\\Program Files\\nodejs\\node.exe'
            CommandLine = 'node "${appServerScript.replace(/"/g, '`"')}"'
            StartTime = $reusedProcessStartTime
          }
        }
        if ($pidToQuery -eq 9005) {
          # Reused PID for gateway from another directory or newer startTime
          return [PSCustomObject]@{
            Id = 9005
            ProcessName = 'llm-gateway'
            ExecutablePath = '${otherGatewayExe.replace(/'/g, "''")}'
            CommandLine = '"${otherGatewayExe.replace(/"/g, '`"')}"'
            StartTime = $reusedProcessStartTime
          }
        }
        return $null
      }

      . '${HELPERS_PATH.replace(/'/g, "''")}'

      $metaReusedUnrelated = [PSCustomObject]@{
        pid = 9003
        port = 3000
        script = '${appServerScript.replace(/'/g, "''")}'
        startTime = $recordedTime.ToString('o')
      }
      $metaReusedNewStartTime = [PSCustomObject]@{
        pid = 9004
        port = 3000
        script = '${appServerScript.replace(/'/g, "''")}'
        startTime = $recordedTime.ToString('o')
      }
      $metaMissingStartTime = [PSCustomObject]@{
        pid = 9004
        port = 3000
        script = '${appServerScript.replace(/'/g, "''")}'
      }
      $metaGatewayReused = [PSCustomObject]@{
        pid = 9005
        port = 8765
        executable = '${appGatewayExe.replace(/'/g, "''")}'
        startTime = $recordedTime.ToString('o')
      }

      @{
        stopUnrelated = (Test-ShouldStopServerProcess 9003 '${appServerScript.replace(/'/g, "''")}' $metaReusedUnrelated)
        stopMismatchedTime = (Test-ShouldStopServerProcess 9004 '${appServerScript.replace(/'/g, "''")}' $metaReusedNewStartTime)
        stopMissingTime = (Test-ShouldStopServerProcess 9004 '${appServerScript.replace(/'/g, "''")}' $metaMissingStartTime)
        stopGatewayReused = (Test-ShouldStopGatewayProcess 9005 '${appGatewayDir.replace(/'/g, "''")}' $metaGatewayReused)
      } | ConvertTo-Json -Compress
    `;

    const result = JSON.parse(runPowerShell(psScript));
    expect(result.stopUnrelated).toBe(false);
    expect(result.stopMismatchedTime).toBe(false);
    expect(result.stopMissingTime).toBe(false);
    expect(result.stopGatewayReused).toBe(false);
  });

  it('stop-all.ps1 only stops verified processes and reports conflicts using mocked process operations', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-stop-test-'));
    try {
      const scriptsDir = path.join(tempRoot, 'scripts');
      const runtimeDir = path.join(tempRoot, '.runtime');
      const gatewayDir = path.join(tempRoot, 'gateway');
      fs.mkdirSync(scriptsDir, { recursive: true });
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.mkdirSync(gatewayDir, { recursive: true });

      const tempServerScript = path.join(scriptsDir, 'server.mjs');
      const tempGatewayExe = path.join(gatewayDir, 'llm-gateway.exe');
      fs.writeFileSync(tempServerScript, '// dummy server\n', 'utf-8');
      fs.writeFileSync(tempGatewayExe, '', 'utf-8');
      fs.copyFileSync(HELPERS_PATH, path.join(scriptsDir, 'process-helpers.ps1'));
      fs.copyFileSync(STOP_SCRIPT_PATH, path.join(scriptsDir, 'stop-all.ps1'));

      const validStartTime = '2026-10-18T10:00:00.0000000Z';
      const staleStartTime = '2026-10-17T10:00:00.0000000Z';

      // Scenario 1: Stale PID on port 3000 (reused by another server.mjs) + Valid Gateway on port 8765
      fs.writeFileSync(
        path.join(runtimeDir, 'processes.json'),
        JSON.stringify({
          webServer: {
            pid: 5001,
            port: 3000,
            script: tempServerScript,
            startTime: staleStartTime,
          },
          gateway: {
            pid: 6001,
            port: 8765,
            executable: tempGatewayExe,
            startTime: validStartTime,
          },
        }),
        'utf-8'
      );

      const psScript = `
        $ErrorActionPreference = 'Stop'
        $script:stoppedPids = @()
        $script:hostLogs = @()

        function Write-Host {
          param([Parameter(ValueFromRemainingArguments=$true)]$Object, $ForegroundColor)
          $script:hostLogs += ($Object -join ' ')
        }
        function Start-Sleep { param($Seconds, $Milliseconds) }
        function Invoke-RestMethod { return $null }
        function Get-Process { param($Id, $ErrorAction) return [PSCustomObject]@{ Id = $Id } }
        function Stop-Process {
          param($Id, [switch]$Force, $ErrorAction)
          $script:stoppedPids += [int]$Id
        }
        function Get-NetTCPConnection {
          param($LocalPort, $State, $ErrorAction)
          if ($LocalPort -eq 3000) {
            return @([PSCustomObject]@{ OwningProcess = 5001 })
          }
          if ($LocalPort -eq 8765) {
            return @([PSCustomObject]@{ OwningProcess = 6001 })
          }
          return @()
        }
        function Get-ProcessDetails($pidToQuery) {
          if ($pidToQuery -eq 5001) {
            return [PSCustomObject]@{
              Id = 5001
              ProcessName = 'node'
              ExecutablePath = 'C:\\Program Files\\nodejs\\node.exe'
              CommandLine = 'node "${otherServerScript.replace(/"/g, '`"')}"'
              StartTime = [datetime]'2026-10-18T11:00:00Z'
            }
          }
          if ($pidToQuery -eq 6001) {
            return [PSCustomObject]@{
              Id = 6001
              ProcessName = 'llm-gateway'
              ExecutablePath = '${tempGatewayExe.replace(/'/g, "''")}'
              CommandLine = '"${tempGatewayExe.replace(/"/g, '`"')}"'
              StartTime = [datetime]'${validStartTime}'
            }
          }
          return $null
        }

        . '${path.join(scriptsDir, 'stop-all.ps1').replace(/'/g, "''")}'
        @{
          stoppedPids = @($script:stoppedPids)
          logs = @($script:hostLogs)
        } | ConvertTo-Json -Compress
      `;

      const result = JSON.parse(runPowerShell(psScript));
      expect(result.stoppedPids).not.toContain(5001);
      expect(result.stoppedPids).toContain(6001);
      expect(result.logs.some((l: string) => l.includes('[CONFLICT]') && l.includes('5001'))).toBe(true);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});
