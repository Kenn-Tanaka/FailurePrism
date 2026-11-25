import { BUILTIN_DEFAULT_MODEL_ID, BUILTIN_LLM_SEED } from './defaultModels';
import {
  classifyModel,
  LLMModelsSeed,
  LLMModelsSeedSchema,
  ManagedLLMRegistryState,
  ManagedLLMRegistryStateSchema,
  ManagedModelEntry,
  ManagedModelEntrySchema,
  ModelProviderId,
  TOOL_ID_REGEX,
  validateModelId,
} from './modelTypes';

export const LLM_REGISTRY_STORAGE_KEY = 'failureprism_llm_registry_v1';
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

export type LLMRegistrySource = 'user' | 'seed' | 'builtin';

export interface LLMRegistrySnapshot {
  state: ManagedLLMRegistryState;
  source: LLMRegistrySource;
  seedLoaded: boolean;
  seedWarning: string | null;
  seedState: LLMModelsSeed;
}

export interface LLMSeedLoadResult {
  loadedFromSeedFile: boolean;
  seed: LLMModelsSeed;
  warning: string | null;
}

const memoryStorageMap = new Map<string, string>();
const memoryStorageFallback: Storage = {
  get length() {
    return memoryStorageMap.size;
  },
  clear: () => memoryStorageMap.clear(),
  getItem: (key: string) => (memoryStorageMap.has(key) ? memoryStorageMap.get(key)! : null),
  key: (index: number) => Array.from(memoryStorageMap.keys())[index] ?? null,
  removeItem: (key: string) => {
    memoryStorageMap.delete(key);
  },
  setItem: (key: string, value: string) => {
    memoryStorageMap.set(key, String(value));
  },
};

function getStorage(): Storage {
  try {
    if (typeof window !== 'undefined' && window.localStorage) {
      return window.localStorage;
    }
    if (typeof globalThis !== 'undefined' && (globalThis as { localStorage?: Storage }).localStorage) {
      return (globalThis as { localStorage: Storage }).localStorage;
    }
  } catch {
    // Fallback to in-memory storage when browser storage is blocked
  }
  return memoryStorageFallback;
}

let cachedSeed: LLMModelsSeed | null = null;
let seedLoaded = false;
let lastSeedWarning: string | null = null;
let inflightSeedPromise: Promise<LLMSeedLoadResult> | null = null;

const listeners = new Set<() => void>();
let storageListenerAttached = false;

let lastCacheKey: string | null = null;
let lastCachedSeedRef: LLMModelsSeed | null = null;
let lastCachedSeedLoaded = false;
let lastCachedWarning: string | null = null;
let lastSnapshot: LLMRegistrySnapshot | null = null;

function ensureStorageListener(): void {
  if (storageListenerAttached || typeof window === 'undefined' || typeof window.addEventListener !== 'function') {
    return;
  }
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === null || event.key === LLM_REGISTRY_STORAGE_KEY) {
      invalidateSnapshotCache();
      notifyListeners();
    }
  });
  storageListenerAttached = true;
}

function invalidateSnapshotCache(): void {
  lastSnapshot = null;
}

function notifyListeners(): void {
  for (const listener of Array.from(listeners)) {
    try {
      listener();
    } catch (err) {
      console.warn('[LLMRegistry] Listener notification failed:', err);
    }
  }
}

function sortModels(models: ReadonlyArray<ManagedModelEntry>): ManagedModelEntry[] {
  return [...models].sort((a, b) => {
    if (a.order !== b.order) return a.order - b.order;
    return a.name.localeCompare(b.name);
  });
}

function normalizeState(
  raw: Omit<ManagedLLMRegistryState, 'schemaVersion' | 'updatedAt'> & { updatedAt?: string }
): ManagedLLMRegistryState {
  const cleanedToolDefaults: Record<string, string> = {};
  for (const [toolId, modelId] of Object.entries(raw.toolDefaultModelIds || {})) {
    const trimmedTool = toolId.trim().toLowerCase();
    const trimmedModel = typeof modelId === 'string' ? modelId.trim() : '';
    if (trimmedTool && trimmedModel && TOOL_ID_REGEX.test(trimmedTool)) {
      cleanedToolDefaults[trimmedTool] = trimmedModel;
    }
  }

  const parsed = ManagedLLMRegistryStateSchema.parse({
    schemaVersion: 1,
    defaultModelId: raw.defaultModelId,
    toolDefaultModelIds: cleanedToolDefaults,
    models: sortModels(raw.models).map((entry, idx) => ({
      ...entry,
      order: Number.isFinite(entry.order) ? entry.order : (idx + 1) * 10,
    })),
    updatedAt: raw.updatedAt ?? new Date().toISOString(),
  });

  return {
    ...parsed,
    models: sortModels(parsed.models),
  };
}

function seedToState(seed: LLMModelsSeed): ManagedLLMRegistryState {
  return {
    schemaVersion: 1,
    defaultModelId: seed.defaultModelId,
    toolDefaultModelIds: { ...seed.toolDefaultModelIds },
    models: sortModels(seed.models),
    updatedAt: '',
  };
}

/**
 * Returns the active LLM registry snapshot (user localStorage > distribution seed > built-in fallback).
 * Referentially stable across calls when backing state has not changed (for React useSyncExternalStore).
 */
export function getLLMRegistrySnapshot(): LLMRegistrySnapshot {
  const storage = getStorage();
  let raw: string | null = null;
  try {
    raw = storage.getItem(LLM_REGISTRY_STORAGE_KEY);
  } catch {
    raw = null;
  }

  const activeSeed = cachedSeed ?? BUILTIN_LLM_SEED;

  if (
    lastSnapshot &&
    lastCacheKey === raw &&
    lastCachedSeedRef === cachedSeed &&
    lastCachedSeedLoaded === seedLoaded &&
    lastCachedWarning === lastSeedWarning
  ) {
    return lastSnapshot;
  }

  let resolvedState: ManagedLLMRegistryState = seedToState(activeSeed);
  let resolvedSource: LLMRegistrySource = cachedSeed ? 'seed' : 'builtin';

  if (raw) {
    try {
      const parsedJson = JSON.parse(raw);
      const validated = ManagedLLMRegistryStateSchema.safeParse(parsedJson);
      if (validated.success) {
        resolvedState = {
          ...validated.data,
          models: sortModels(validated.data.models),
        };
        resolvedSource = 'user';
      }
    } catch {
      // Malformed storage entry falls back safely to seed/builtin
    }
  }

  const nextSnapshot: LLMRegistrySnapshot = {
    state: resolvedState,
    source: resolvedSource,
    seedLoaded,
    seedWarning: lastSeedWarning,
    seedState: activeSeed,
  };

  lastCacheKey = raw;
  lastCachedSeedRef = cachedSeed;
  lastCachedSeedLoaded = seedLoaded;
  lastCachedWarning = lastSeedWarning;
  lastSnapshot = nextSnapshot;
  return nextSnapshot;
}

/**
 * Resolves the effective default model ID for a tool (tool override > global default > built-in fallback).
 */
export function getDefaultModelId(toolId?: string): string {
  const { state } = getLLMRegistrySnapshot();
  if (toolId) {
    const normalizedToolId = toolId.trim().toLowerCase();
    const override = state.toolDefaultModelIds[normalizedToolId];
    if (override && override.trim().length > 0) {
      return override.trim();
    }
  }
  return state.defaultModelId || BUILTIN_DEFAULT_MODEL_ID;
}

/**
 * Returns catalog models sorted by `order`, optionally filtered by target tool ID.
 */
export function getCatalogModels(toolId?: string): ManagedModelEntry[] {
  const { state } = getLLMRegistrySnapshot();
  if (!toolId) {
    return state.models;
  }
  const normalizedTool = toolId.trim().toLowerCase();
  return state.models.filter((m) => m.targetTools.includes(normalizedTool));
}

export function getRecommendedModels(toolId?: string): ManagedModelEntry[] {
  return getCatalogModels(toolId).filter((m) => m.isRecommended);
}

export function getPresetModels(toolId?: string): ManagedModelEntry[] {
  return getCatalogModels(toolId).filter((m) => m.isPreset);
}

export function getSharedModelMetadata(modelId: string): {
  id: string;
  displayName: string;
  description: string;
  provider: ModelProviderId;
  isRecommended: boolean;
  isReasoning: boolean;
  isPreset: boolean;
  isRegistered: boolean;
} {
  const { state } = getLLMRegistrySnapshot();
  const entry = state.models.find((m) => m.id === modelId);
  if (entry) {
    return {
      id: entry.id,
      displayName: entry.name,
      description: entry.description || 'Gateway経由で利用可能なモデルです。',
      provider: entry.provider,
      isRecommended: entry.isRecommended,
      isReasoning: entry.isReasoning,
      isPreset: entry.isPreset,
      isRegistered: true,
    };
  }

  const classified = classifyModel(modelId);
  return {
    id: modelId,
    displayName: classified.name,
    description: 'Gateway経由で利用可能なモデルです。',
    provider: classified.provider,
    isRecommended: false,
    isReasoning: classified.isReasoning,
    isPreset: false,
    isRegistered: false,
  };
}

function persistState(state: ManagedLLMRegistryState): ManagedLLMRegistryState {
  const storage = getStorage();
  storage.setItem(LLM_REGISTRY_STORAGE_KEY, JSON.stringify(state));
  invalidateSnapshotCache();
  notifyListeners();
  return state;
}

export function saveLLMRegistryState(
  next: Omit<ManagedLLMRegistryState, 'schemaVersion' | 'updatedAt'>
): ManagedLLMRegistryState {
  const normalized = normalizeState({
    ...next,
    updatedAt: new Date().toISOString(),
  });
  return persistState(normalized);
}

export function setDefaultModelId(modelId: string, toolId?: string): ManagedLLMRegistryState {
  const current = getLLMRegistrySnapshot().state;
  const trimmedModel = modelId.trim();

  if (toolId) {
    const normalizedTool = toolId.trim().toLowerCase();
    if (!TOOL_ID_REGEX.test(normalizedTool)) {
      throw new Error(`ツールID '${toolId}' の形式が不正です。`);
    }
    const nextToolDefaults = { ...current.toolDefaultModelIds };
    if (!trimmedModel) {
      delete nextToolDefaults[normalizedTool];
    } else {
      const check = validateModelId(trimmedModel);
      if (!check.valid) {
        throw new Error(check.message || 'モデルIDの形式が不正です。');
      }
      nextToolDefaults[normalizedTool] = trimmedModel;
    }
    return saveLLMRegistryState({
      defaultModelId: current.defaultModelId,
      toolDefaultModelIds: nextToolDefaults,
      models: current.models,
    });
  }

  const check = validateModelId(trimmedModel);
  if (!check.valid) {
    throw new Error(check.message || 'モデルIDの形式が不正です。');
  }

  return saveLLMRegistryState({
    defaultModelId: trimmedModel,
    toolDefaultModelIds: current.toolDefaultModelIds,
    models: current.models,
  });
}

export function upsertModelEntry(
  entryInput: Omit<ManagedModelEntry, 'order'> & { order?: number },
  previousId?: string
): ManagedLLMRegistryState {
  const current = getLLMRegistrySnapshot().state;
  const maxOrder = current.models.reduce((max, m) => Math.max(max, m.order), 0);
  const parsedEntry = ManagedModelEntrySchema.parse({
    ...entryInput,
    order: entryInput.order ?? maxOrder + 10,
  });

  const targetOldId = previousId?.trim();
  const collision = current.models.find(
    (m) => m.id === parsedEntry.id && (!targetOldId || m.id !== targetOldId)
  );
  if (collision) {
    throw new Error(`モデルID '${parsedEntry.id}' は既に登録されています。`);
  }

  let nextModels: ManagedModelEntry[];
  let nextDefaultModelId = current.defaultModelId;
  const nextToolDefaults = { ...current.toolDefaultModelIds };

  if (targetOldId && current.models.some((m) => m.id === targetOldId)) {
    nextModels = current.models.map((m) => (m.id === targetOldId ? parsedEntry : m));
    if (targetOldId !== parsedEntry.id) {
      if (nextDefaultModelId === targetOldId) {
        nextDefaultModelId = parsedEntry.id;
      }
      for (const [k, v] of Object.entries(nextToolDefaults)) {
        if (v === targetOldId) {
          nextToolDefaults[k] = parsedEntry.id;
        }
      }
    }
  } else {
    nextModels = [...current.models, parsedEntry];
  }

  return saveLLMRegistryState({
    defaultModelId: nextDefaultModelId,
    toolDefaultModelIds: nextToolDefaults,
    models: nextModels,
  });
}

export function removeModelEntry(modelId: string): ManagedLLMRegistryState {
  const current = getLLMRegistrySnapshot().state;
  if (!current.models.some((m) => m.id === modelId)) {
    return current;
  }
  if (current.models.length <= 1) {
    throw new Error('カタログには最低1件のモデルを残す必要があります。');
  }

  return saveLLMRegistryState({
    defaultModelId: current.defaultModelId,
    toolDefaultModelIds: current.toolDefaultModelIds,
    models: current.models.filter((m) => m.id !== modelId),
  });
}

export interface BulkUpsertModelsOptions {
  conflictStrategy?: 'skip' | 'overwrite';
}

export interface BulkUpsertModelsResult {
  state: ManagedLLMRegistryState;
  addedCount: number;
  updatedCount: number;
  skippedCount: number;
  invalidEntries: Array<{ id: string; reason: string }>;
}

/**
 * Inserts or updates multiple model entries in a single atomic registry write.
 */
export function upsertModelEntriesBulk(
  entriesInput: ReadonlyArray<Omit<ManagedModelEntry, 'order'> & { order?: number }>,
  options?: BulkUpsertModelsOptions
): BulkUpsertModelsResult {
  const conflictStrategy = options?.conflictStrategy ?? 'skip';
  const current = getLLMRegistrySnapshot().state;

  let nextOrder = current.models.reduce((max, m) => Math.max(max, m.order), 0) + 10;
  const existingIndexById = new Map<string, number>();
  const nextModels = [...current.models];
  nextModels.forEach((m, idx) => existingIndexById.set(m.id, idx));

  const seenInputIds = new Set<string>();
  let addedCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  const invalidEntries: Array<{ id: string; reason: string }> = [];

  for (const rawEntry of entriesInput) {
    const rawId = typeof rawEntry.id === 'string' ? rawEntry.id.trim() : '';
    if (!rawId) {
      invalidEntries.push({ id: '(empty)', reason: 'モデルIDが空です' });
      continue;
    }
    if (seenInputIds.has(rawId)) {
      skippedCount += 1;
      continue;
    }
    seenInputIds.add(rawId);

    const existingIdx = existingIndexById.get(rawId);
    if (existingIdx !== undefined && conflictStrategy === 'skip') {
      skippedCount += 1;
      continue;
    }

    const assignedOrder =
      rawEntry.order ??
      (existingIdx !== undefined ? nextModels[existingIdx].order : nextOrder);

    const parsed = ManagedModelEntrySchema.safeParse({
      ...rawEntry,
      id: rawId,
      order: assignedOrder,
    });

    if (!parsed.success) {
      invalidEntries.push({
        id: rawId,
        reason: parsed.error.issues[0]?.message || '入力形式が不正です',
      });
      continue;
    }

    if (existingIdx !== undefined) {
      nextModels[existingIdx] = parsed.data;
      updatedCount += 1;
    } else {
      existingIndexById.set(parsed.data.id, nextModels.length);
      nextModels.push(parsed.data);
      addedCount += 1;
      if (rawEntry.order === undefined) {
        nextOrder += 10;
      }
    }
  }

  if (addedCount === 0 && updatedCount === 0) {
    return {
      state: current,
      addedCount: 0,
      updatedCount: 0,
      skippedCount,
      invalidEntries,
    };
  }

  const saved = saveLLMRegistryState({
    defaultModelId: current.defaultModelId,
    toolDefaultModelIds: current.toolDefaultModelIds,
    models: nextModels,
  });

  return {
    state: saved,
    addedCount,
    updatedCount,
    skippedCount,
    invalidEntries,
  };
}

export interface BulkRemoveModelsOptions {
  reassignDefaultsIfDeleted?: boolean;
}

export interface BulkRemoveModelsResult {
  state: ManagedLLMRegistryState;
  removedCount: number;
  removedIds: string[];
  reassignedGlobalDefaultTo: string | null;
  clearedToolDefaults: string[];
}

/**
 * Deletes multiple models in a single atomic registry write while preserving at least 1 model
 * and automatically healing deleted default/tool-override references when requested.
 */
export function removeModelEntriesBulk(
  modelIds: ReadonlyArray<string>,
  options?: BulkRemoveModelsOptions
): BulkRemoveModelsResult {
  const reassignDefaults = options?.reassignDefaultsIfDeleted ?? true;
  const current = getLLMRegistrySnapshot().state;
  const targetSet = new Set(modelIds.map((id) => id.trim()).filter(Boolean));

  if (targetSet.size === 0) {
    return {
      state: current,
      removedCount: 0,
      removedIds: [],
      reassignedGlobalDefaultTo: null,
      clearedToolDefaults: [],
    };
  }

  const removedIds = current.models.filter((m) => targetSet.has(m.id)).map((m) => m.id);
  if (removedIds.length === 0) {
    return {
      state: current,
      removedCount: 0,
      removedIds: [],
      reassignedGlobalDefaultTo: null,
      clearedToolDefaults: [],
    };
  }

  const remaining = current.models.filter((m) => !targetSet.has(m.id));
  if (remaining.length === 0) {
    throw new Error(
      'カタログには最低1件のモデルを残す必要があります。残したいモデルを少なくとも1件選択解除してください。'
    );
  }

  const sortedRemaining = sortModels(remaining).map((m, idx) => ({
    ...m,
    order: (idx + 1) * 10,
  }));

  let nextDefaultModelId = current.defaultModelId;
  let reassignedGlobalDefaultTo: string | null = null;
  const nextToolDefaults = { ...current.toolDefaultModelIds };
  const clearedToolDefaults: string[] = [];

  if (reassignDefaults) {
    if (targetSet.has(nextDefaultModelId)) {
      const fallback =
        sortedRemaining.find((m) => m.isRecommended)?.id ?? sortedRemaining[0].id;
      nextDefaultModelId = fallback;
      reassignedGlobalDefaultTo = fallback;
    }
    for (const [toolId, toolModelId] of Object.entries(nextToolDefaults)) {
      if (targetSet.has(toolModelId)) {
        delete nextToolDefaults[toolId];
        clearedToolDefaults.push(toolId);
      }
    }
  }

  const saved = saveLLMRegistryState({
    defaultModelId: nextDefaultModelId,
    toolDefaultModelIds: nextToolDefaults,
    models: sortedRemaining,
  });

  return {
    state: saved,
    removedCount: removedIds.length,
    removedIds,
    reassignedGlobalDefaultTo,
    clearedToolDefaults,
  };
}

/**
 * Updates flags (`isRecommended`, `isPreset`, `targetTools`) across multiple catalog models atomically.
 */
export function updateModelEntriesFlagsBulk(
  modelIds: ReadonlyArray<string>,
  patch: Partial<Pick<ManagedModelEntry, 'isRecommended' | 'isPreset' | 'targetTools'>>
): ManagedLLMRegistryState {
  const current = getLLMRegistrySnapshot().state;
  const targetSet = new Set(modelIds.map((id) => id.trim()).filter(Boolean));
  if (targetSet.size === 0) return current;

  let changed = false;
  const nextModels = current.models.map((m) => {
    if (!targetSet.has(m.id)) return m;
    const nextTargetTools =
      patch.targetTools !== undefined ? patch.targetTools : m.targetTools;
    if (nextTargetTools.length === 0) return m;
    const updated: ManagedModelEntry = {
      ...m,
      ...(patch.isRecommended !== undefined ? { isRecommended: patch.isRecommended } : {}),
      ...(patch.isPreset !== undefined ? { isPreset: patch.isPreset } : {}),
      targetTools: nextTargetTools,
    };
    if (
      updated.isRecommended !== m.isRecommended ||
      updated.isPreset !== m.isPreset ||
      updated.targetTools.join(',') !== m.targetTools.join(',')
    ) {
      changed = true;
    }
    return updated;
  });

  if (!changed) return current;

  return saveLLMRegistryState({
    defaultModelId: current.defaultModelId,
    toolDefaultModelIds: current.toolDefaultModelIds,
    models: nextModels,
  });
}

export function moveModelEntry(modelId: string, direction: -1 | 1): ManagedLLMRegistryState {
  const current = getLLMRegistrySnapshot().state;
  const sorted = sortModels(current.models);
  const index = sorted.findIndex((m) => m.id === modelId);
  const targetIndex = index + direction;
  if (index < 0 || targetIndex < 0 || targetIndex >= sorted.length) {
    return current;
  }

  const reordered = [...sorted];
  const [moved] = reordered.splice(index, 1);
  reordered.splice(targetIndex, 0, moved);

  const normalizedModels = reordered.map((m, idx) => ({
    ...m,
    order: (idx + 1) * 10,
  }));

  return saveLLMRegistryState({
    defaultModelId: current.defaultModelId,
    toolDefaultModelIds: current.toolDefaultModelIds,
    models: normalizedModels,
  });
}

export function resetRegistryToSeed(): ManagedLLMRegistryState {
  const storage = getStorage();
  try {
    storage.removeItem(LLM_REGISTRY_STORAGE_KEY);
  } catch {
    // Ignore storage error
  }
  invalidateSnapshotCache();
  notifyListeners();
  return getLLMRegistrySnapshot().state;
}

export function exportRegistryJson(): string {
  const { state } = getLLMRegistrySnapshot();
  return JSON.stringify(
    {
      schemaVersion: state.schemaVersion,
      defaultModelId: state.defaultModelId,
      toolDefaultModelIds: state.toolDefaultModelIds,
      models: state.models,
      updatedAt: state.updatedAt || new Date().toISOString(),
    },
    null,
    2
  );
}

export function importRegistryJson(rawJson: string): {
  success: boolean;
  state?: ManagedLLMRegistryState;
  error?: string;
} {
  const byteSize = new TextEncoder().encode(rawJson).byteLength;
  if (byteSize > MAX_IMPORT_BYTES) {
    return {
      success: false,
      error: 'インポートファイルが上限 (2 MiB) を超えています。',
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawJson);
  } catch {
    return {
      success: false,
      error: '有効なJSON形式ではありません。',
    };
  }

  const result = ManagedLLMRegistryStateSchema.safeParse(parsedJson);
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      success: false,
      error: `設定形式エラー (${issue?.path.join('.') || 'root'}): ${issue?.message || '不正な値です'}`,
    };
  }

  const saved = saveLLMRegistryState({
    defaultModelId: result.data.defaultModelId,
    toolDefaultModelIds: result.data.toolDefaultModelIds,
    models: result.data.models,
  });

  return {
    success: true,
    state: saved,
  };
}

function getSeedUrl(): string {
  const metaEnv = (import.meta as unknown as { env?: { BASE_URL?: string } }).env;
  const base = typeof metaEnv?.BASE_URL === 'string' && metaEnv.BASE_URL ? metaEnv.BASE_URL : '/';
  const normalized = base.endsWith('/') ? base : `${base}/`;
  return `${normalized}llm-models.json`;
}

/**
 * Loads `public/llm-models.json` as the distribution seed. Falls back cleanly to BUILTIN_LLM_SEED on error.
 */
export async function loadLLMModelSeed(options?: {
  force?: boolean;
  timeoutMs?: number;
}): Promise<LLMSeedLoadResult> {
  if (seedLoaded && !options?.force) {
    return {
      loadedFromSeedFile: cachedSeed !== null,
      seed: cachedSeed ?? BUILTIN_LLM_SEED,
      warning: lastSeedWarning,
    };
  }

  if (inflightSeedPromise && !options?.force) {
    return inflightSeedPromise;
  }

  const run = async (): Promise<LLMSeedLoadResult> => {
    if (typeof fetch !== 'function') {
      seedLoaded = true;
      return {
        loadedFromSeedFile: false,
        seed: BUILTIN_LLM_SEED,
        warning: null,
      };
    }

    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutMs = options?.timeoutMs ?? 2000;
    const timer =
      controller && timeoutMs > 0
        ? setTimeout(() => {
            controller.abort();
          }, timeoutMs)
        : null;

    try {
      const response = await fetch(getSeedUrl(), {
        cache: 'no-store',
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const raw = await response.json();
      const parsed = LLMModelsSeedSchema.safeParse(raw);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(`${issue?.path.join('.') || '設定'}: ${issue?.message || '形式が不正です'}`);
      }

      cachedSeed = {
        ...parsed.data,
        models: sortModels(parsed.data.models),
      };
      seedLoaded = true;
      lastSeedWarning = null;
      invalidateSnapshotCache();
      notifyListeners();

      return {
        loadedFromSeedFile: true,
        seed: cachedSeed,
        warning: null,
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : '読み込めませんでした';
      cachedSeed = null;
      seedLoaded = true;
      lastSeedWarning = `配布シード設定 (llm-models.json) を読み込めなかったため、組み込み既定値を使用します (${detail})`;
      invalidateSnapshotCache();
      notifyListeners();

      return {
        loadedFromSeedFile: false,
        seed: BUILTIN_LLM_SEED,
        warning: lastSeedWarning,
      };
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
      inflightSeedPromise = null;
    }
  };

  inflightSeedPromise = run();
  return inflightSeedPromise;
}

export async function preloadLLMModelSeed(options?: { timeoutMs?: number }): Promise<void> {
  await loadLLMModelSeed({ timeoutMs: options?.timeoutMs ?? 500 });
}

export function subscribeLLMRegistry(listener: () => void): () => void {
  ensureStorageListener();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Resets module-level caches and fallback storage for deterministic unit testing.
 */
export function resetLLMRegistryForTests(): void {
  cachedSeed = null;
  seedLoaded = false;
  lastSeedWarning = null;
  inflightSeedPromise = null;
  memoryStorageMap.clear();
  try {
    getStorage().removeItem(LLM_REGISTRY_STORAGE_KEY);
  } catch {
    // Ignore
  }
  invalidateSnapshotCache();
}
