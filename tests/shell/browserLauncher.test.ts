import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const ROOT_DIR = process.cwd();
const BROWSER_HELPERS_PATH = path.resolve(ROOT_DIR, 'scripts', 'browser-helpers.ps1');
const SELECT_BROWSER_PATH = path.resolve(ROOT_DIR, 'scripts', 'select-browser.ps1');
const LAUNCHER_EXE_PATH = fs.existsSync(path.resolve(ROOT_DIR, 'FailurePrism.exe'))
  ? path.resolve(ROOT_DIR, 'FailurePrism.exe')
  : path.resolve(ROOT_DIR, 'launcher', 'bin', 'FailurePrism.exe');
const ICON_PATH = path.resolve(ROOT_DIR, 'launcher', 'assets', 'failureprism.ico');

function getPowerShellExecutable(): string | null {
  const candidates =
    process.platform === 'win32' ? ['powershell.exe', 'pwsh.exe'] : ['pwsh', 'powershell'];

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

function runPowerShell(script: string, extraEnv?: NodeJS.ProcessEnv): string {
  if (!psExe) {
    throw new Error('PowerShell executable not found');
  }
  const res = spawnSync(
    psExe,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    {
      encoding: 'utf-8',
      env: { ...process.env, ...extraEnv },
    }
  );
  if (res.error) {
    throw res.error;
  }
  if (res.status !== 0) {
    throw new Error(`PowerShell exited with code ${res.status}: ${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

describe('Browser Selection & Launcher Helpers (select-browser.ps1 / browser-helpers.ps1)', () => {
  it('saves, resolves, launches custom Chromium browser in app mode with profile args, and resets cleanly', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-browser-test-'));
    try {
      const scriptsDir = path.join(tempRoot, 'scripts');
      const fakeBinDir = path.join(tempRoot, 'fake-browsers');
      fs.mkdirSync(scriptsDir, { recursive: true });
      fs.mkdirSync(fakeBinDir, { recursive: true });

      const fakeChrome = path.join(fakeBinDir, 'chrome.exe');
      const fakeFirefox = path.join(fakeBinDir, 'firefox.exe');
      fs.writeFileSync(fakeChrome, '', 'utf-8');
      fs.writeFileSync(fakeFirefox, '', 'utf-8');

      fs.copyFileSync(BROWSER_HELPERS_PATH, path.join(scriptsDir, 'browser-helpers.ps1'));
      fs.copyFileSync(SELECT_BROWSER_PATH, path.join(scriptsDir, 'select-browser.ps1'));

      // 1. Configure custom chrome.exe via select-browser.ps1 CLI mode with -AppMode and profile arg
      runPowerShell(
        `& '${path.join(scriptsDir, 'select-browser.ps1').replace(/'/g, "''")}' -Browser '${fakeChrome.replace(/'/g, "''")}' -AppMode -BrowserArgs '--profile-directory=Profile 1'`,
        { FAILUREPRISM_BROWSER: '' }
      );

      const savedJsonPath = path.join(tempRoot, '.runtime', 'browser.json');
      expect(fs.existsSync(savedJsonPath)).toBe(true);
      const saved = JSON.parse(fs.readFileSync(savedJsonPath, 'utf-8').replace(/^\uFEFF/, ''));
      expect(saved.mode).toBe('browser');
      expect(saved.appMode).toBe(true);
      expect(saved.executablePath.toLowerCase()).toBe(fakeChrome.toLowerCase());

      // 2. Verify Open-FailurePrismBrowser invokes Start-Process with chrome.exe and --app=<url>
      const launchCheckScript = `
        $ErrorActionPreference = 'Stop'
        $script:captured = $null
        function Write-Host { param([Parameter(ValueFromRemainingArguments=$true)]$Object, $ForegroundColor) }
        function Start-Process {
          param($FilePath, $ArgumentList)
          $script:captured = [PSCustomObject]@{
            FilePath = $FilePath
            ArgumentList = $ArgumentList
          }
        }
        . '${path.join(scriptsDir, 'browser-helpers.ps1').replace(/'/g, "''")}'
        $cfg = Resolve-FailurePrismBrowserConfig -rootDir '${tempRoot.replace(/'/g, "''")}'
        $res = Open-FailurePrismBrowser -url 'http://127.0.0.1:3000/?build=abc123#menu' -browserConfig $cfg
        @{
          source = $cfg.Source
          launchedMode = $res.LaunchedMode
          filePath = $script:captured.FilePath
          argList = $script:captured.ArgumentList
        } | ConvertTo-Json -Compress
      `;
      const launched = JSON.parse(
        runPowerShell(launchCheckScript, { FAILUREPRISM_BROWSER: '' })
      );
      expect(launched.source).toBe('config');
      expect(launched.launchedMode).toBe('browser');
      expect(launched.filePath.toLowerCase()).toBe(fakeChrome.toLowerCase());
      expect(launched.argList).toContain('"--profile-directory=Profile 1"');
      expect(launched.argList).toContain('--app=http://127.0.0.1:3000/?build=abc123#menu');

      // 3. CLI override (-Browser firefox) takes precedence over saved config without mutating browser.json
      const overrideScript = `
        $ErrorActionPreference = 'Stop'
        $script:captured = $null
        function Write-Host { param([Parameter(ValueFromRemainingArguments=$true)]$Object, $ForegroundColor) }
        function Start-Process {
          param($FilePath, $ArgumentList)
          $script:captured = [PSCustomObject]@{ FilePath = $FilePath; ArgumentList = $ArgumentList }
        }
        . '${path.join(scriptsDir, 'browser-helpers.ps1').replace(/'/g, "''")}'
        $cfg = Resolve-FailurePrismBrowserConfig -rootDir '${tempRoot.replace(/'/g, "''")}' -cliBrowser '${fakeFirefox.replace(/'/g, "''")}'
        $res = Open-FailurePrismBrowser -url 'http://127.0.0.1:3000/#menu' -browserConfig $cfg
        @{
          source = $cfg.Source
          filePath = $script:captured.FilePath
          argList = $script:captured.ArgumentList
        } | ConvertTo-Json -Compress
      `;
      const overridden = JSON.parse(
        runPowerShell(overrideScript, { FAILUREPRISM_BROWSER: '' })
      );
      expect(overridden.source).toBe('cli');
      expect(overridden.filePath.toLowerCase()).toBe(fakeFirefox.toLowerCase());
      expect(overridden.argList).toBe('http://127.0.0.1:3000/#menu');

      // 4. Status outputs current browser info and Reset removes .runtime/browser.json
      const statusOut = runPowerShell(
        `& '${path.join(scriptsDir, 'select-browser.ps1').replace(/'/g, "''")}' -Status`,
        { FAILUREPRISM_BROWSER: '' }
      );
      expect(statusOut).toContain('現在の設定');
      expect(statusOut.toLowerCase()).toContain('chrome.exe');

      runPowerShell(
        `& '${path.join(scriptsDir, 'select-browser.ps1').replace(/'/g, "''")}' -Reset`,
        { FAILUREPRISM_BROWSER: '' }
      );
      expect(fs.existsSync(savedJsonPath)).toBe(false);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 30000);

  it('supports -NoBrowser / mode=none and gracefully falls back to system default when configured binary is missing', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-browser-fallback-'));
    try {
      const scriptsDir = path.join(tempRoot, 'scripts');
      fs.mkdirSync(scriptsDir, { recursive: true });
      fs.copyFileSync(BROWSER_HELPERS_PATH, path.join(scriptsDir, 'browser-helpers.ps1'));

      const psScript = `
        $ErrorActionPreference = 'Stop'
        $script:calls = @()
        function Write-Host { param([Parameter(ValueFromRemainingArguments=$true)]$Object, $ForegroundColor) }
        function Start-Process {
          param($FilePath, $ArgumentList)
          $script:calls += [PSCustomObject]@{ FilePath = $FilePath; ArgumentList = $ArgumentList }
        }
        . '${path.join(scriptsDir, 'browser-helpers.ps1').replace(/'/g, "''")}'

        # A) -cliNoBrowser skips Start-Process completely
        $cfgNone = Resolve-FailurePrismBrowserConfig -rootDir '${tempRoot.replace(/'/g, "''")}' -cliNoBrowser
        $resNone = Open-FailurePrismBrowser -url 'http://127.0.0.1:3000/#menu' -browserConfig $cfgNone

        # B) Missing binary falls back to system default URL launch without throwing
        Save-BrowserConfig -rootDir '${tempRoot.replace(/'/g, "''")}' -mode 'browser' -browser 'nonexistent-browser-xyz' -executablePath 'C:\\nonexistent\\browser.exe' | Out-Null
        $cfgMissing = Resolve-FailurePrismBrowserConfig -rootDir '${tempRoot.replace(/'/g, "''")}'
        $resFallback = Open-FailurePrismBrowser -url 'http://127.0.0.1:3000/#menu' -browserConfig $cfgMissing -installedBrowsers @()

        @{
          noneMode = $resNone.LaunchedMode
          fallbackMode = $resFallback.LaunchedMode
          callCount = $script:calls.Count
          fallbackTarget = $script:calls[0].FilePath
        } | ConvertTo-Json -Compress
      `;
      const result = JSON.parse(runPowerShell(psScript, { FAILUREPRISM_BROWSER: '' }));
      expect(result.noneMode).toBe('none');
      expect(result.fallbackMode).toBe('fallback_default');
      expect(result.callCount).toBe(1);
      expect(result.fallbackTarget).toBe('http://127.0.0.1:3000/#menu');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 30000);

  it('verifies FailurePrism.exe native launcher embeds multi-size prism icon and resolves config, CLI flags, env vars, and start-all.ps1 sync', () => {
    expect(fs.existsSync(ICON_PATH)).toBe(true);
    const icoBuf = fs.readFileSync(ICON_PATH);
    // ICONDIR header: reserved=0, type=1 (ICO), count=7 frames (16, 24, 32, 48, 64, 128, 256)
    expect(icoBuf.readUInt16LE(0)).toBe(0);
    expect(icoBuf.readUInt16LE(2)).toBe(1);
    expect(icoBuf.readUInt16LE(4)).toBe(7);

    if (process.platform !== 'win32') return;
    expect(fs.existsSync(LAUNCHER_EXE_PATH)).toBe(true);
    const exeBuf = fs.readFileSync(LAUNCHER_EXE_PATH);
    // Verify MZ PE header and embedded UTF-16LE VS_VERSION_INFO ProductName "FailurePrism"
    expect(exeBuf.subarray(0, 2).toString('ascii')).toBe('MZ');
    expect(exeBuf.includes(Buffer.from('FailurePrism', 'utf16le'))).toBe(true);

    const verRes = spawnSync(LAUNCHER_EXE_PATH, ['--version'], { encoding: 'utf-8' });
    expect(verRes.status).toBe(0);
    expect(verRes.stdout).toContain('FailurePrism Launcher v');

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-native-exe-test-'));
    try {
      const appDistDir = path.join(tempRoot, 'app', 'dist');
      const fakeBinDir = path.join(tempRoot, 'browsers');
      const scriptsDir = path.join(tempRoot, 'scripts');
      fs.mkdirSync(appDistDir, { recursive: true });
      fs.mkdirSync(fakeBinDir, { recursive: true });
      fs.mkdirSync(scriptsDir, { recursive: true });
      fs.writeFileSync(path.join(tempRoot, 'app', 'server.mjs'), '// stub', 'utf-8');
      fs.writeFileSync(path.join(appDistDir, 'index.html'), '<html>FailurePrism</html>', 'utf-8');
      fs.copyFileSync(BROWSER_HELPERS_PATH, path.join(scriptsDir, 'browser-helpers.ps1'));

      const fakeEdge = path.join(fakeBinDir, 'msedge.exe');
      const fakeFirefox = path.join(fakeBinDir, 'firefox.exe');
      fs.writeFileSync(fakeEdge, '', 'utf-8');
      fs.writeFileSync(fakeFirefox, '', 'utf-8');

      // 1. Save persistent browser preference via FailurePrism.exe --set-browser
      const setRes = spawnSync(
        LAUNCHER_EXE_PATH,
        [
          '--root',
          tempRoot,
          '--set-browser',
          fakeEdge,
          '--app',
          '--browser-arg',
          '--profile-directory=Work Profile',
        ],
        { encoding: 'utf-8', env: { ...process.env, FAILUREPRISM_BROWSER: '' } }
      );
      expect(setRes.status).toBe(0);

      const rootCfgPath = path.join(tempRoot, 'failureprism.config.json');
      expect(fs.existsSync(rootCfgPath)).toBe(true);
      const rootCfg = JSON.parse(fs.readFileSync(rootCfgPath, 'utf-8'));
      expect(rootCfg.browser.mode).toBe('browser');
      expect(rootCfg.browser.appMode).toBe(true);
      expect(rootCfg.browser.args).toEqual(['--profile-directory=Work Profile']);

      // 2. Verify --dry-run-json resolves config file + SHA-256 build hash + --app URL
      const dryCfgRes = spawnSync(LAUNCHER_EXE_PATH, ['--root', tempRoot, '--dry-run-json'], {
        encoding: 'utf-8',
        env: { ...process.env, FAILUREPRISM_BROWSER: '' },
      });
      expect(dryCfgRes.status).toBe(0);
      const dryCfg = JSON.parse(dryCfgRes.stdout);
      expect(dryCfg.source).toBe('config');
      expect(dryCfg.launchedMode).toBe('browser');
      expect(dryCfg.resolvedExecutable.toLowerCase()).toBe(fakeEdge.toLowerCase());
      expect(dryCfg.url).toMatch(/^http:\/\/127\.0\.0\.1:3000\/\?build=[0-9a-f]{12}#menu$/);
      expect(dryCfg.arguments).toEqual([
        '--profile-directory=Work Profile',
        `--app=${dryCfg.url}`,
      ]);

      // 3. Verify PowerShell browser-helpers.ps1 (used by start-all.bat) reads the exact same failureprism.config.json
      const psSyncJson = JSON.parse(
        runPowerShell(
          `. '${path.join(scriptsDir, 'browser-helpers.ps1').replace(/'/g, "''")}'; $c = Resolve-FailurePrismBrowserConfig -rootDir '${tempRoot.replace(/'/g, "''")}'; @{ source=$c.Source; mode=$c.Mode; exe=$c.ExecutablePath; app=$c.AppMode; args=$c.ExtraArgs } | ConvertTo-Json -Compress`,
          { FAILUREPRISM_BROWSER: '' }
        )
      );
      expect(psSyncJson.source).toBe('config');
      expect(psSyncJson.mode).toBe('browser');
      expect(psSyncJson.exe.toLowerCase()).toBe(fakeEdge.toLowerCase());
      expect(psSyncJson.app).toBe(true);

      // 4. Verify CLI override (--browser <firefox> --view vta) overrides config without mutating failureprism.config.json
      const dryCliRes = spawnSync(
        LAUNCHER_EXE_PATH,
        ['--root', tempRoot, '--browser', fakeFirefox, '--view', 'vta', '--dry-run-json'],
        { encoding: 'utf-8', env: { ...process.env, FAILUREPRISM_BROWSER: '' } }
      );
      expect(dryCliRes.status).toBe(0);
      const dryCli = JSON.parse(dryCliRes.stdout);
      expect(dryCli.source).toBe('cli');
      expect(dryCli.resolvedExecutable.toLowerCase()).toBe(fakeFirefox.toLowerCase());
      expect(dryCli.url.endsWith('#vta')).toBe(true);
      expect(dryCli.arguments).toEqual([dryCli.url]);

      // 5. Verify --reset-browser resets failureprism.config.json to default and removes .runtime/browser.json
      const resetRes = spawnSync(LAUNCHER_EXE_PATH, ['--root', tempRoot, '--reset-browser'], {
        encoding: 'utf-8',
        env: { ...process.env, FAILUREPRISM_BROWSER: '' },
      });
      expect(resetRes.status).toBe(0);
      expect(fs.existsSync(path.join(tempRoot, '.runtime', 'browser.json'))).toBe(false);
      const afterReset = JSON.parse(fs.readFileSync(rootCfgPath, 'utf-8'));
      expect(afterReset.browser.mode).toBe('default');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }, 30000);
});
