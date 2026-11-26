import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequestHandler } from '../../scripts/server.mjs';
import {
  DEFAULT_UI_THEME,
  getUITheme,
  hydrateUIThemeFromServer,
  resetUIThemeForTests,
  setUITheme,
  toggleUITheme,
  UI_THEME_STORAGE_KEY,
} from '../../src/shared/theme/themeStore';
import { TopTabBar } from '../../src/shell/TopTabBar';
import { installedTools } from '../../src/shell/toolLoader';

describe('Global UI Theme System & Cross-Restart Persistence (ADR-0093)', () => {
  let tempDir: string;
  let server: http.Server | null = null;
  let baseUrl = '';

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'failureprism-theme-test-'));
    fs.writeFileSync(path.join(tempDir, 'index.html'), '<!doctype html><html><body></body></html>', 'utf-8');
    resetUIThemeForTests('light', true);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
    if (tempDir && fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    resetUIThemeForTests('light', true);
  });

  async function startTestServer(prefsPath: string) {
    const handler = createRequestHandler({
      distDir: tempDir,
      host: '127.0.0.1',
      port: 0,
      gatewayPort: 65530,
      uiPreferencesPath: prefsPath,
    });
    server = http.createServer(handler);
    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        const addr = server!.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  }

  it('defaults to light theme on initial startup and updates localStorage + DOM data-theme on toggle', () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);

    const mockDocument = {
      documentElement: {
        dataset: {} as Record<string, string>,
        style: { colorScheme: '' },
      },
    };
    const storageMap = new Map<string, string>();
    const mockWindow = {
      localStorage: {
        getItem: (k: string) => storageMap.get(k) ?? null,
        setItem: (k: string, v: string) => storageMap.set(k, v),
        removeItem: (k: string) => storageMap.delete(k),
      },
    };
    vi.stubGlobal('document', mockDocument);
    vi.stubGlobal('window', mockWindow);

    resetUIThemeForTests('light', true);
    expect(DEFAULT_UI_THEME).toBe('light');
    expect(getUITheme()).toBe('light');
    expect(mockDocument.documentElement.dataset.theme).toBe('light');
    expect(mockDocument.documentElement.style.colorScheme).toBe('light');

    // Toggle to dark
    const toggled = toggleUITheme();
    expect(toggled).toBe('dark');
    expect(getUITheme()).toBe('dark');
    expect(storageMap.get(UI_THEME_STORAGE_KEY)).toBe('dark');
    expect(mockDocument.documentElement.dataset.theme).toBe('dark');
    expect(mockDocument.documentElement.style.colorScheme).toBe('dark');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/ui-preferences',
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({ theme: 'dark' }),
      })
    );

    // Toggle back to light
    expect(toggleUITheme()).toBe('light');
    expect(storageMap.get(UI_THEME_STORAGE_KEY)).toBe('light');
    expect(mockDocument.documentElement.dataset.theme).toBe('light');
  });

  it('persists UI theme across server restarts and hydrates fresh browser sessions from /api/ui-preferences', async () => {
    const prefsPath = path.join(tempDir, '.runtime', 'ui-preferences.json');
    await startTestServer(prefsPath);

    // 1. Fresh server with no saved file -> defaults to light, persisted: false
    const initialRes = await fetch(`${baseUrl}/api/ui-preferences`);
    expect(initialRes.status).toBe(200);
    expect(await initialRes.json()).toEqual({ theme: 'light', persisted: false });

    // 2. Reject invalid theme values safely
    const badRes = await fetch(`${baseUrl}/api/ui-preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: 'neon' }),
    });
    expect(badRes.status).toBe(400);

    // 3. Save 'dark' theme
    const saveRes = await fetch(`${baseUrl}/api/ui-preferences`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ theme: 'dark' }),
    });
    expect(saveRes.status).toBe(200);
    expect(await saveRes.json()).toEqual({ ok: true, theme: 'dark', persisted: true });
    expect(fs.existsSync(prefsPath)).toBe(true);

    // 4. Simulate server restart on a new port & fresh browser session (empty localStorage)
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
    await startTestServer(prefsPath);

    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = String(input);
      if (urlStr.startsWith('/')) {
        return realFetch(`${baseUrl}${urlStr}`, init);
      }
      return realFetch(input, init);
    });

    resetUIThemeForTests('light', true);
    expect(getUITheme()).toBe('light');

    const hydrated = await hydrateUIThemeFromServer();
    expect(hydrated).toBe('dark');
    expect(getUITheme()).toBe('dark');
  });

  it('renders global theme toggle in TopTabBar reflecting light and dark states', () => {
    resetUIThemeForTests('light', true);
    const lightHtml = renderToStaticMarkup(
      <TopTabBar
        activeView="menu"
        onSelectView={() => {}}
        tools={installedTools}
        toolStatuses={{}}
        gatewayHealth={{ online: true, checkedAt: '12:00:00', version: '2.0.0' }}
        isCheckingHealth={false}
        onRefreshHealth={() => {}}
      />
    );
    expect(lightHtml).toContain('data-testid="global-theme-toggle"');
    expect(lightHtml).toContain('ライト');

    setUITheme('dark', { syncServer: false });
    const darkHtml = renderToStaticMarkup(
      <TopTabBar
        activeView="menu"
        onSelectView={() => {}}
        tools={installedTools}
        toolStatuses={{}}
        gatewayHealth={{ online: true, checkedAt: '12:00:00', version: '2.0.0' }}
        isCheckingHealth={false}
        onRefreshHealth={() => {}}
      />
    );
    expect(darkHtml).toContain('ダーク');
  });
});
