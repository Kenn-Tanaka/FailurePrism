import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_DEFAULT_MODEL_ID, BUILTIN_LLM_SEED } from '../../../src/shared/llm/defaultModels';
import {
  exportRegistryJson,
  getCatalogModels,
  getDefaultModelId,
  getLLMRegistrySnapshot,
  getPresetModels,
  getRecommendedModels,
  getSharedModelMetadata,
  importRegistryJson,
  LLM_REGISTRY_STORAGE_KEY,
  loadLLMModelSeed,
  moveModelEntry,
  removeModelEntriesBulk,
  removeModelEntry,
  resetLLMRegistryForTests,
  resetRegistryToSeed,
  setDefaultModelId,
  subscribeLLMRegistry,
  updateModelEntriesFlagsBulk,
  upsertModelEntriesBulk,
  upsertModelEntry,
} from '../../../src/shared/llm/modelRegistry';
import { validateCatalogFetchUrl } from '../../../src/shared/llm/gatewayUrl';
import {
  classifyModel,
  LLMModelsSeedSchema,
  normalizeImportedModelId,
  validateModelId,
} from '../../../src/shared/llm/modelTypes';

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

describe('Shared LLM Model Registry & Seed', () => {
  beforeEach(() => {
    installMockLocalStorage();
    resetLLMRegistryForTests();
  });

  afterEach(() => {
    resetLLMRegistryForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps public/llm-models.json valid and synchronized with BUILTIN_LLM_SEED', () => {
    const seedPath = path.resolve(__dirname, '../../../public/llm-models.json');
    const raw = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
    const parsed = LLMModelsSeedSchema.safeParse(raw);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual(BUILTIN_LLM_SEED);
    }
  });

  it('validates model IDs and classifies providers cleanly', () => {
    expect(validateModelId('').valid).toBe(false);
    expect(validateModelId('no-slash').valid).toBe(false);
    expect(validateModelId('/missing-provider').valid).toBe(false);
    expect(validateModelId('provider/').valid).toBe(false);
    expect(validateModelId('openrouter/google/gemini-3.8-flash').valid).toBe(true);

    expect(classifyModel('openrouter/deepseek/deepseek-r1')).toMatchObject({
      provider: 'deepseek',
      isReasoning: true,
    });
    expect(classifyModel('openrouter/anthropic/claude-3.5-sonnet')).toMatchObject({
      provider: 'anthropic',
      isReasoning: false,
    });
  });

  it('resolves global default and optional per-tool overrides (Option A)', () => {
    expect(getDefaultModelId()).toBe(BUILTIN_DEFAULT_MODEL_ID);
    expect(getDefaultModelId('tpdd')).toBe(BUILTIN_DEFAULT_MODEL_ID);
    expect(getDefaultModelId('vta')).toBe(BUILTIN_DEFAULT_MODEL_ID);

    // Changing global default updates tools that inherit global default
    setDefaultModelId('openrouter/anthropic/claude-3.5-sonnet');
    expect(getDefaultModelId('tpdd')).toBe('openrouter/anthropic/claude-3.5-sonnet');
    expect(getDefaultModelId('vta')).toBe('openrouter/anthropic/claude-3.5-sonnet');

    // Setting per-tool override only affects that tool
    setDefaultModelId('openrouter/deepseek/deepseek-r1', 'vta');
    expect(getDefaultModelId('vta')).toBe('openrouter/deepseek/deepseek-r1');
    expect(getDefaultModelId('tpdd')).toBe('openrouter/anthropic/claude-3.5-sonnet');

    // Clearing per-tool override reverts back to global inheritance
    setDefaultModelId('', 'vta');
    expect(getDefaultModelId('vta')).toBe('openrouter/anthropic/claude-3.5-sonnet');
  });

  it('supports catalog CRUD, rename propagation, reordering, and last-item protection', () => {
    upsertModelEntry({
      id: 'openrouter/openai/gpt-4.1',
      name: 'GPT-4.1',
      provider: 'openai',
      description: 'Test model',
      isRecommended: true,
      isPreset: true,
      isReasoning: false,
      targetTools: ['tpdd'],
    });

    expect(getCatalogModels('tpdd').some((m) => m.id === 'openrouter/openai/gpt-4.1')).toBe(true);
    expect(getCatalogModels('vta').some((m) => m.id === 'openrouter/openai/gpt-4.1')).toBe(false);
    expect(getRecommendedModels('tpdd').some((m) => m.id === 'openrouter/openai/gpt-4.1')).toBe(true);
    expect(getPresetModels('tpdd').some((m) => m.id === 'openrouter/openai/gpt-4.1')).toBe(true);

    // Duplicate ID check
    expect(() =>
      upsertModelEntry({
        id: 'openrouter/openai/gpt-4.1',
        name: 'Duplicate',
        provider: 'openai',
        description: '',
        isRecommended: false,
        isPreset: false,
        isReasoning: false,
        targetTools: ['tpdd'],
      })
    ).toThrow(/既に登録されています/);

    // Rename propagates to defaultModelId / toolDefaultModelIds
    setDefaultModelId('openrouter/openai/gpt-4.1', 'tpdd');
    upsertModelEntry(
      {
        id: 'openrouter/openai/gpt-4.1-mini',
        name: 'GPT-4.1 Mini',
        provider: 'openai',
        description: 'Renamed',
        isRecommended: true,
        isPreset: true,
        isReasoning: false,
        targetTools: ['tpdd', 'vta'],
      },
      'openrouter/openai/gpt-4.1'
    );
    expect(getDefaultModelId('tpdd')).toBe('openrouter/openai/gpt-4.1-mini');
    expect(getSharedModelMetadata('openrouter/openai/gpt-4.1-mini').displayName).toBe('GPT-4.1 Mini');

    // Reordering
    const beforeFirst = getCatalogModels()[0].id;
    const secondId = getCatalogModels()[1].id;
    moveModelEntry(secondId, -1);
    expect(getCatalogModels()[0].id).toBe(secondId);
    expect(getCatalogModels()[1].id).toBe(beforeFirst);

    // Deleting models down to 1
    const allIds = getCatalogModels().map((m) => m.id);
    for (let i = 0; i < allIds.length - 1; i++) {
      removeModelEntry(allIds[i]);
    }
    expect(getCatalogModels()).toHaveLength(1);
    expect(() => removeModelEntry(allIds[allIds.length - 1])).toThrow(/最低1件/);
  });

  it('loads public/llm-models.json seed, prioritizes user storage over seed, and resets cleanly', async () => {
    const customSeed = {
      schemaVersion: 1,
      defaultModelId: 'openrouter/anthropic/claude-3.5-sonnet',
      toolDefaultModelIds: { vta: 'openrouter/deepseek/deepseek-r1' },
      models: [
        {
          id: 'openrouter/anthropic/claude-3.5-sonnet',
          name: 'Seed Claude',
          provider: 'anthropic',
          description: 'Seeded default',
          isRecommended: true,
          isPreset: true,
          isReasoning: false,
          targetTools: ['tpdd', 'vta'],
          order: 10,
        },
        {
          id: 'openrouter/deepseek/deepseek-r1',
          name: 'Seed R1',
          provider: 'deepseek',
          description: 'Seeded VTA model',
          isRecommended: true,
          isPreset: true,
          isReasoning: true,
          targetTools: ['vta'],
          order: 20,
        },
      ],
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify(customSeed), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );

    const loadRes = await loadLLMModelSeed({ force: true });
    expect(loadRes.loadedFromSeedFile).toBe(true);
    expect(loadRes.warning).toBeNull();
    expect(getLLMRegistrySnapshot().source).toBe('seed');
    expect(getDefaultModelId('tpdd')).toBe('openrouter/anthropic/claude-3.5-sonnet');
    expect(getDefaultModelId('vta')).toBe('openrouter/deepseek/deepseek-r1');

    // User override takes precedence over seed
    setDefaultModelId('lmstudio/custom-local', 'tpdd');
    expect(getLLMRegistrySnapshot().source).toBe('user');
    expect(getDefaultModelId('tpdd')).toBe('lmstudio/custom-local');

    // Reset returns to loaded distribution seed
    resetRegistryToSeed();
    expect(getLLMRegistrySnapshot().source).toBe('seed');
    expect(getDefaultModelId('tpdd')).toBe('openrouter/anthropic/claude-3.5-sonnet');
  });

  it('falls back safely to BUILTIN_LLM_SEED with warning when seed fetch fails or is invalid', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('invalid-json', { status: 404 }))
    );

    const loadRes = await loadLLMModelSeed({ force: true });
    expect(loadRes.loadedFromSeedFile).toBe(false);
    expect(loadRes.warning).toContain('llm-models.json');
    expect(getLLMRegistrySnapshot().source).toBe('builtin');
    expect(getDefaultModelId()).toBe(BUILTIN_DEFAULT_MODEL_ID);
  });

  it('exports/imports JSON without secrets and keeps snapshot references stable for useSyncExternalStore', () => {
    const storage: Record<string, string> = installMockLocalStorage();
    const s1 = getLLMRegistrySnapshot();
    const s2 = getLLMRegistrySnapshot();
    expect(s1).toBe(s2);

    const listener = vi.fn();
    const unsubscribe = subscribeLLMRegistry(listener);

    setDefaultModelId('openrouter/openai/gpt-4o');
    expect(listener).toHaveBeenCalledTimes(1);
    const s3 = getLLMRegistrySnapshot();
    expect(s3).not.toBe(s1);
    expect(getLLMRegistrySnapshot()).toBe(s3);

    const exported = exportRegistryJson();
    expect(exported).not.toContain('gatewayToken');
    expect(storage[LLM_REGISTRY_STORAGE_KEY]).toBeDefined();

    resetRegistryToSeed();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getDefaultModelId()).toBe(BUILTIN_DEFAULT_MODEL_ID);

    const importRes = importRegistryJson(exported);
    expect(importRes.success).toBe(true);
    expect(getDefaultModelId()).toBe('openrouter/openai/gpt-4o');

    expect(importRegistryJson('{broken').success).toBe(false);
    expect(importRegistryJson(JSON.stringify({ schemaVersion: 99 })).success).toBe(false);

    unsubscribe();
  });

  it('validates catalog fetch URLs and normalizes upstream OpenRouter model IDs', () => {
    expect(validateCatalogFetchUrl('/v1')).toMatchObject({
      valid: true,
      isExternal: false,
      normalizedBaseUrl: '/v1',
    });
    expect(validateCatalogFetchUrl('http://127.0.0.1:8765/v1/')).toMatchObject({
      valid: true,
      isExternal: false,
      normalizedBaseUrl: 'http://127.0.0.1:8765/v1',
    });
    expect(validateCatalogFetchUrl('https://openrouter.ai/api/v1/')).toMatchObject({
      valid: true,
      isExternal: true,
      normalizedBaseUrl: 'https://openrouter.ai/api/v1',
    });

    // Reject plain HTTP on external hosts, private LAN IPs, credentials, query strings
    expect(validateCatalogFetchUrl('http://openrouter.ai/api/v1').valid).toBe(false);
    expect(validateCatalogFetchUrl('https://192.168.1.10/v1').valid).toBe(false);
    expect(validateCatalogFetchUrl('https://10.0.0.5/v1').valid).toBe(false);
    expect(validateCatalogFetchUrl('https://172.20.0.1/v1').valid).toBe(false);
    expect(validateCatalogFetchUrl('https://user:pass@openrouter.ai/api/v1').valid).toBe(false);
    expect(validateCatalogFetchUrl('https://openrouter.ai/api/v1?key=1').valid).toBe(false);

    // Prefix normalization
    expect(
      normalizeImportedModelId('google/gemini-2.5-pro', { gatewayProviderPrefix: 'openrouter' })
    ).toBe('openrouter/google/gemini-2.5-pro');
    expect(
      normalizeImportedModelId('openrouter/google/gemini-2.5-pro', {
        gatewayProviderPrefix: 'openrouter',
      })
    ).toBe('openrouter/google/gemini-2.5-pro');
    expect(
      normalizeImportedModelId('lmstudio/local-qwen', { gatewayProviderPrefix: 'openrouter' })
    ).toBe('lmstudio/local-qwen');
    expect(normalizeImportedModelId('google/gemini-2.5-pro')).toBe('google/gemini-2.5-pro');
  });

  it('supports atomic bulk model import, bulk flag updates, and bulk deletion of obsolete models', () => {
    const initialCount = getCatalogModels().length;

    // 1. Bulk import with recommended=false, preset=false, conflictStrategy='skip'
    const bulkImport = upsertModelEntriesBulk(
      [
        {
          id: 'openrouter/google/gemini-2.5-pro',
          name: 'Gemini 2.5 Pro',
          provider: 'google',
          description: 'Imported from OpenRouter',
          isRecommended: false,
          isPreset: false,
          isReasoning: true,
          targetTools: ['tpdd', 'vta'],
        },
        {
          id: 'openrouter/anthropic/claude-sonnet-4',
          name: 'Claude Sonnet 4',
          provider: 'anthropic',
          description: 'Imported from OpenRouter',
          isRecommended: false,
          isPreset: false,
          isReasoning: false,
          targetTools: ['tpdd', 'vta'],
        },
        // Existing model should be skipped when conflictStrategy='skip'
        {
          id: BUILTIN_DEFAULT_MODEL_ID,
          name: 'Should Not Overwrite',
          provider: 'google',
          description: 'Skipped',
          isRecommended: false,
          isPreset: false,
          isReasoning: false,
          targetTools: ['vta'],
        },
      ],
      { conflictStrategy: 'skip' }
    );

    expect(bulkImport.addedCount).toBe(2);
    expect(bulkImport.updatedCount).toBe(0);
    expect(bulkImport.skippedCount).toBe(1);
    expect(getCatalogModels()).toHaveLength(initialCount + 2);
    expect(getRecommendedModels().some((m) => m.id === 'openrouter/google/gemini-2.5-pro')).toBe(
      false
    );

    // 2. Bulk flag toggle promotes imported models to recommended
    updateModelEntriesFlagsBulk(['openrouter/google/gemini-2.5-pro'], {
      isRecommended: true,
      isPreset: true,
    });
    expect(getRecommendedModels().some((m) => m.id === 'openrouter/google/gemini-2.5-pro')).toBe(
      true
    );

    // 3. Bulk delete obsolete models including active global/tool defaults heals default references
    setDefaultModelId('openrouter/openai/gpt-4o');
    setDefaultModelId('openrouter/deepseek/deepseek-r1', 'vta');

    const keepIds = new Set([
      'openrouter/google/gemini-2.5-pro',
      'openrouter/anthropic/claude-sonnet-4',
    ]);
    const obsoleteIds = getCatalogModels()
      .map((m) => m.id)
      .filter((id) => !keepIds.has(id));

    const removeRes = removeModelEntriesBulk(obsoleteIds);
    expect(removeRes.removedCount).toBe(obsoleteIds.length);
    expect(getCatalogModels().map((m) => m.id)).toEqual([
      'openrouter/google/gemini-2.5-pro',
      'openrouter/anthropic/claude-sonnet-4',
    ]);
    // Global default automatically healed to remaining recommended model; deleted VTA override cleared
    expect(removeRes.reassignedGlobalDefaultTo).toBe('openrouter/google/gemini-2.5-pro');
    expect(removeRes.clearedToolDefaults).toContain('vta');
    expect(getDefaultModelId('vta')).toBe('openrouter/google/gemini-2.5-pro');

    // Attempting to bulk-delete ALL remaining models throws last-item protection error
    expect(() =>
      removeModelEntriesBulk([
        'openrouter/google/gemini-2.5-pro',
        'openrouter/anthropic/claude-sonnet-4',
      ])
    ).toThrow(/最低1件/);
  });
});
