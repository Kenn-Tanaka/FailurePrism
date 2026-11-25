import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getHashForView, getTitleForView, resolveViewFromLocation } from '../../src/shell/gatewayBridge';
import { installedTools } from '../../src/shell/toolLoader';
import {
  resetLLMRegistryForTests,
  setDefaultModelId,
  upsertModelEntry,
} from '../../src/shared/llm/modelRegistry';
import { LLMManagerApp } from '../../src/tools/llm-manager/App';
import {
  fetchExternalCatalogModels,
  fetchGatewayModels,
  loadDiscoveredModelsCache,
  loadVtaDiscoveredModelsCache,
  OPENROUTER_PUBLIC_API_URL,
  pingGatewayModel,
  saveDiscoveredModelsCache,
  VTA_DISCOVERED_STORAGE_KEY,
} from '../../src/tools/llm-manager/services/gatewayModels';
import { createNewProject } from '../../src/tools/tpdd/domain/commands';
import { getModelMetadata, getTpddModelPresets } from '../../src/tools/tpdd/features/settings/modelCatalog';
import { getVtaDefaultModels, getVtaModelPresets } from '../../src/tools/vta/features/vta/data/modelCatalog';
import { LLMConfigSection } from '../../src/tools/vta/components/control-panel/LLMConfigSection';
import { useVTAStore } from '../../src/tools/vta/features/vta/store/vtaStore';

function installMockLocalStorage(): Record<string, string> {
  const store: Record<string, string> = {};
  const mockStorage: Storage = {
    get length() {
      return Object.keys(store).length;
    },
    clear: () => {
      for (const key of Object.keys(store)) delete store[key];
    },
    getItem: (key: string) => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : null),
    key: (index: number) => Object.keys(store)[index] ?? null,
    removeItem: (key: string) => {
      delete store[key];
    },
    setItem: (key: string, value: string) => {
      store[key] = String(value);
    },
  };
  vi.stubGlobal('localStorage', mockStorage);
  return store;
}

describe('LLM Manager Plugin & Cross-Tool Integration', () => {
  beforeEach(() => {
    installMockLocalStorage();
    resetLLMRegistryForTests();
  });

  afterEach(() => {
    resetLLMRegistryForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('auto-discovers llm-manager plugin in FailurePrism Shell after tpdd and vta', () => {
    const ids = installedTools.map((t) => t.id);
    expect(ids.slice(0, 3)).toEqual(['tpdd', 'vta', 'llm-manager']);
    expect(resolveViewFromLocation('#llm-manager', '')).toBe('llm-manager');
    expect(resolveViewFromLocation('', '?app=llm-manager')).toBe('llm-manager');
    expect(getHashForView('llm-manager')).toBe('#llm-manager');
    expect(getTitleForView('llm-manager')).toContain('LLM管理');
  });

  it('renders LLMManagerApp with default model controls, catalog, and Gateway discovery without exposing secrets', () => {
    const html = renderToStaticMarkup(
      <LLMManagerApp
        isActive={true}
        gatewayToken="secret-token-should-not-appear-in-markup"
        onGatewayTokenChange={() => {}}
      />
    );

    expect(html).toContain('LLMモデル管理');
    expect(html).toContain('デフォルト LLM 設定');
    expect(html).toContain('推奨 LLM・プリセットカタログ');
    expect(html).toContain('LLM-Gateway 連携・モデル取込');
    expect(html).toContain('TPDD-Editor 用デフォルト');
    expect(html).toContain('VTA-Editor 用デフォルト');
    expect(html).toContain('openrouter/google/gemini-3.8-flash');
  });

  it('propagates new defaults and recommended models to TPDD and VTA without mutating existing open/saved sessions', () => {
    // 1. Existing open TPDD project and VTA store keep their current models
    const existingTpddProject = createNewProject('既存プロジェクト');
    expect(existingTpddProject.aiPreferences.modelId).toBe('openrouter/google/gemini-3.8-flash');
    useVTAStore.setState({
      llmConfig: {
        ...useVTAStore.getState().llmConfig,
        selectedModel: 'openrouter/openai/gpt-4o',
      },
    });

    // 2. Manage defaults and catalog via shared registry (used by llm-manager)
    setDefaultModelId('openrouter/anthropic/claude-3.5-sonnet', 'tpdd');
    upsertModelEntry({
      id: 'openrouter/google/gemini-2.5-pro',
      name: 'Gemini 2.5 Pro Custom',
      provider: 'google',
      description: 'Added via LLM Manager',
      isRecommended: true,
      isPreset: true,
      isReasoning: true,
      targetTools: ['tpdd', 'vta'],
    });

    // Existing open sessions remain untouched
    expect(existingTpddProject.aiPreferences.modelId).toBe('openrouter/google/gemini-3.8-flash');
    expect(useVTAStore.getState().llmConfig.selectedModel).toBe('openrouter/openai/gpt-4o');

    // Newly created TPDD project receives the managed TPDD default
    const nextTpddProject = createNewProject('新規プロジェクト2');
    expect(nextTpddProject.aiPreferences.modelId).toBe('openrouter/anthropic/claude-3.5-sonnet');

    // TPDD & VTA catalogs and rendered preset UI reflect the newly registered recommended model
    expect(getTpddModelPresets().some((p) => p.id === 'openrouter/google/gemini-2.5-pro')).toBe(true);
    expect(getModelMetadata('openrouter/google/gemini-2.5-pro').displayName).toBe('Gemini 2.5 Pro Custom');
    expect(getVtaDefaultModels().some((m) => m.id === 'openrouter/google/gemini-2.5-pro')).toBe(true);
    expect(getVtaModelPresets().some((p) => p.id === 'openrouter/google/gemini-2.5-pro')).toBe(true);

    const vtaConfigHtml = renderToStaticMarkup(<LLMConfigSection />);
    expect(vtaConfigHtml).toContain('LLM設定');
  });

  it('fetches Gateway models and pings a selected model safely', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            data: [
              { id: 'openrouter/google/gemini-3.8-flash' },
              { id: 'openrouter/anthropic/claude-3.5-sonnet:beta' },
              { id: 'openrouter/google/gemini-3.8-flash' },
            ],
          }),
          { status: 200 }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'pong' }, finish_reason: 'stop' }],
          }),
          { status: 200 }
        )
      );

    vi.stubGlobal('fetch', fetchMock);

    const models = await fetchGatewayModels({
      gatewayUrl: '/v1',
      gatewayAuthEnabled: true,
      gatewayToken: 'gw-token',
    });
    expect(models.map((m) => m.id)).toEqual([
      'openrouter/google/gemini-3.8-flash',
      'openrouter/anthropic/claude-3.5-sonnet:beta',
    ]);

    const ping = await pingGatewayModel(
      {
        gatewayUrl: '/v1',
        gatewayAuthEnabled: true,
        gatewayToken: 'gw-token',
      },
      'openrouter/google/gemini-3.8-flash'
    );
    expect(ping.success).toBe(true);

    // Rejects remote non-loopback URLs
    await expect(
      fetchGatewayModels({
        gatewayUrl: 'https://evil.example.com/v1',
        gatewayAuthEnabled: false,
        gatewayToken: '',
      })
    ).rejects.toThrow(/loopback/);
  });

  it('fetches external OpenRouter catalog without leaking Gateway Token and supports discovery caches', async () => {
    const store = installMockLocalStorage();
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            {
              id: 'google/gemini-2.5-pro',
              name: 'Google: Gemini 2.5 Pro',
              description: 'Advanced reasoning and long context model.',
              context_length: 1048576,
              supported_parameters: ['temperature', 'reasoning'],
            },
            {
              id: 'anthropic/claude-sonnet-4',
              name: 'Anthropic: Claude Sonnet 4',
              description: 'Balanced coding and analysis model.',
              context_length: 200000,
            },
          ],
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal('fetch', fetchMock);

    const models = await fetchExternalCatalogModels(OPENROUTER_PUBLIC_API_URL);
    expect(models).toEqual([
      {
        id: 'google/gemini-2.5-pro',
        name: 'Google: Gemini 2.5 Pro',
        description: 'Advanced reasoning and long context model.',
        contextLength: 1048576,
        isReasoningHint: true,
      },
      {
        id: 'anthropic/claude-sonnet-4',
        name: 'Anthropic: Claude Sonnet 4',
        description: 'Balanced coding and analysis model.',
        contextLength: 200000,
      },
    ]);

    // Verify no Authorization header was sent to external host (COM-N01)
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe('https://openrouter.ai/api/v1/models');
    expect((calledInit?.headers as Record<string, string>)?.Authorization).toBeUndefined();

    // Rejects plain HTTP external URLs
    await expect(fetchExternalCatalogModels('http://openrouter.ai/api/v1')).rejects.toThrow(
      /https:\/\//
    );

    // Persists and restores discovery cache cleanly
    saveDiscoveredModelsCache({
      sourceId: 'openrouter',
      sourceLabel: 'OpenRouter 公式カタログ',
      fetchedAt: '22:00:00',
      models,
    });
    const restored = loadDiscoveredModelsCache();
    expect(restored?.sourceId).toBe('openrouter');
    expect(restored?.models).toHaveLength(2);

    // Reads VTA discovered cache when present
    store[VTA_DISCOVERED_STORAGE_KEY] = JSON.stringify([
      { id: 'openrouter/deepseek/deepseek-r1', name: 'DeepSeek R1', isReasoning: true },
    ]);
    const vtaCached = loadVtaDiscoveredModelsCache();
    expect(vtaCached).toEqual([
      { id: 'openrouter/deepseek/deepseek-r1', name: 'DeepSeek R1', isReasoningHint: true },
    ]);

    // Rendered UI exposes bulk import and selection controls without exposing secrets
    const html = renderToStaticMarkup(
      <LLMManagerApp
        isActive={true}
        gatewayToken="secret-gw-token-must-not-leak"
        onGatewayTokenChange={() => {}}
      />
    );
    expect(html).toContain('モデル一覧から一括取込');
    expect(html).toContain('既定モデル以外を選択');
    expect(html).toContain('OpenRouter 最新一覧を取得');
    expect(html).toContain('type="password"');
    expect(JSON.stringify(store)).not.toContain('secret-gw-token-must-not-leak');
  });
});
