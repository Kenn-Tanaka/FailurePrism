import { useMemo, useSyncExternalStore } from 'react';
import {
  getDefaultModelId,
  getLLMRegistrySnapshot,
  LLMRegistrySnapshot,
  subscribeLLMRegistry,
} from './modelRegistry';
import type { ManagedModelEntry } from './modelTypes';

export function useLLMRegistry(): LLMRegistrySnapshot {
  return useSyncExternalStore(
    subscribeLLMRegistry,
    getLLMRegistrySnapshot,
    getLLMRegistrySnapshot
  );
}

export interface ToolModelCatalogView {
  snapshot: LLMRegistrySnapshot;
  defaultModelId: string;
  allModels: ManagedModelEntry[];
  recommendedModels: ManagedModelEntry[];
  presetModels: ManagedModelEntry[];
}

export function useToolModelCatalog(toolId: string): ToolModelCatalogView {
  const snapshot = useLLMRegistry();
  const normalizedToolId = toolId.trim().toLowerCase();

  return useMemo(() => {
    const toolModels = snapshot.state.models.filter((m) =>
      m.targetTools.includes(normalizedToolId)
    );
    return {
      snapshot,
      defaultModelId: getDefaultModelId(normalizedToolId),
      allModels: toolModels,
      recommendedModels: toolModels.filter((m) => m.isRecommended),
      presetModels: toolModels.filter((m) => m.isPreset),
    };
  }, [snapshot, normalizedToolId]);
}
