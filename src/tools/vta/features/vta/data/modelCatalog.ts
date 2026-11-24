import { classifyModel, ManagedModelEntry, ModelProviderId } from '../../../../../shared/llm/modelTypes';
import { getCatalogModels, getPresetModels } from '../../../../../shared/llm/modelRegistry';

export interface LLMModelOption {
  id: string;
  name: string;
  provider: ModelProviderId;
  isRecommended?: boolean;
  isReasoning?: boolean;
  description?: string;
}

export function toVtaModelOption(entry: ManagedModelEntry): LLMModelOption {
  return {
    id: entry.id,
    name: entry.name,
    provider: entry.provider,
    isRecommended: entry.isRecommended,
    isReasoning: entry.isReasoning,
    description: entry.description,
  };
}

export function getVtaDefaultModels(): LLMModelOption[] {
  return getCatalogModels('vta').map(toVtaModelOption);
}

export function getVtaModelPresets(): Array<{ id: string; name: string }> {
  return [
    ...getPresetModels('vta').map((entry) => ({
      id: entry.id,
      name: entry.isRecommended ? `${entry.name} (推奨)` : entry.name,
    })),
    { id: 'custom', name: '✏️ カスタムモデルIDを入力...' },
  ];
}

export const DEFAULT_MODELS: LLMModelOption[] = getVtaDefaultModels();

export { classifyModel };

export const MODEL_PRESETS: Array<{ id: string; name: string }> = getVtaModelPresets();

