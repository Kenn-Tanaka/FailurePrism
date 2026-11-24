import { BUILTIN_DEFAULT_MODEL_ID } from '../../../../shared/llm/defaultModels';
import {
  getCatalogModels,
  getPresetModels,
  getSharedModelMetadata,
} from '../../../../shared/llm/modelRegistry';

export interface ModelCatalogEntry {
  id: string; // prefix付きGatewayモデルID
  name: string; // UI表示名
  description: string;
  isRecommended: boolean;
}

export interface ModelPreset {
  id: string; // カタログまたは設定で定義するGatewayモデルID
  name: string;
}

export const DEFAULT_MODEL_ID = BUILTIN_DEFAULT_MODEL_ID;

export function getTpddModelPresets(): ModelPreset[] {
  return getPresetModels('tpdd').map((entry) => ({
    id: entry.id,
    name: entry.name,
  }));
}

export function getTpddDefaultModels(): ModelCatalogEntry[] {
  return getCatalogModels('tpdd').map((entry) => ({
    id: entry.id,
    name: entry.name,
    description: entry.description,
    isRecommended: entry.isRecommended,
  }));
}

export const MODEL_PRESETS: ModelPreset[] = getTpddModelPresets();

/**
 * 推奨モデル・カタログ一覧 (補助メタデータ)
 * 仕様書 8.4.5: カタログにあるだけで取得済み実在モデル一覧へ混ぜない
 */
export const DEFAULT_MODELS: ModelCatalogEntry[] = getTpddDefaultModels();

/**
 * モデルIDからカタログの表示名や説明を取得するヘルパー
 */
export function getModelMetadata(modelId: string): {
  displayName: string;
  description: string;
  isRecommended: boolean;
} {
  const shared = getSharedModelMetadata(modelId);
  return {
    displayName: shared.displayName,
    description: shared.description,
    isRecommended: shared.isRecommended,
  };
}

