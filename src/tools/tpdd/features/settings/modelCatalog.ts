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

export const DEFAULT_MODEL_ID = 'lmstudio/default';

export const MODEL_PRESETS: ModelPreset[] = [
  {
    id: 'lmstudio/default',
    name: 'LM Studio (ローカル・ロード済モデル)',
  },
  {
    id: 'lmstudio_remote/default',
    name: 'LM Studio Remote (Tailscale経由)',
  },
];

/**
 * 推奨モデル・カタログ一覧 (補助メタデータ)
 * 仕様書 8.4.5: カタログにあるだけで取得済み実在モデル一覧へ混ぜない
 */
export const DEFAULT_MODELS: ModelCatalogEntry[] = [
  {
    id: 'lmstudio/default',
    name: 'LM Studio (ローカル・ロード済)',
    description: 'LM Studioでロード済みのローカルモデルを使用します。',
    isRecommended: true,
  },
  {
    id: 'lmstudio_remote/default',
    name: 'LM Studio Remote (Tailscale)',
    description: 'リモートPC上のLM StudioへTailscale等を経由して接続します。',
    isRecommended: false,
  },
  {
    id: 'openrouter/google/gemini-2.5-flash',
    name: 'Gemini 2.5 Flash (OpenRouter)',
    description: '高速かつ構造化出力と論理推論に優れた軽量クラウドモデルです。',
    isRecommended: true,
  },
  {
    id: 'openrouter/anthropic/claude-3.5-sonnet',
    name: 'Claude 3.5 Sonnet (OpenRouter)',
    description: '高い文脈理解・構造化展開能力を持つフラッグシップモデルです。',
    isRecommended: true,
  },
  {
    id: 'ollama/llama3.1:8b',
    name: 'Llama 3.1 8B (Ollama)',
    description: 'ローカルで軽量に動作するオープンモデルです。',
    isRecommended: false,
  },
];

/**
 * モデルIDからカタログの表示名や説明を取得するヘルパー
 */
export function getModelMetadata(modelId: string): {
  displayName: string;
  description: string;
  isRecommended: boolean;
} {
  const entry = DEFAULT_MODELS.find((m) => m.id === modelId);
  const preset = MODEL_PRESETS.find((p) => p.id === modelId);

  return {
    displayName: entry?.name || preset?.name || modelId,
    description: entry?.description || 'Gateway経由で利用可能なモデルです。',
    isRecommended: entry?.isRecommended || false,
  };
}
