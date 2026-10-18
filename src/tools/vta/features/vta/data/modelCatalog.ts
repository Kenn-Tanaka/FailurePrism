export interface LLMModelOption {
  id: string;
  name: string;
  provider: 'anthropic' | 'deepseek' | 'google' | 'openai' | 'qwen' | 'local' | 'other';
  isRecommended?: boolean;
  isReasoning?: boolean;
  description?: string;
}

export const DEFAULT_MODELS: LLMModelOption[] = [
  {
    id: 'openrouter/google/gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    provider: 'google',
    isRecommended: true,
    description: 'VTA-Editorのデフォルトモデル',
  },
  {
    id: 'openrouter/deepseek/deepseek-r1',
    name: 'DeepSeek R1',
    provider: 'deepseek',
    isRecommended: true,
    isReasoning: true,
    description: '【思考モデル】詳細なヒューマンファクタ要因分析・根本原因の深掘りに最適',
  },
  {
    id: 'openrouter/google/gemini-2.0-flash-001',
    name: 'Gemini 2.0 Flash',
    provider: 'google',
    isRecommended: true,
    description: '広大なコンテキスト対応、長文事故調査報告書の一括分析に強い',
  },
  {
    id: 'openrouter/openai/gpt-4o',
    name: 'GPT-4o (Omni)',
    provider: 'openai',
    isRecommended: true,
    description: '汎用性の高い標準モデル、安定したJSONスキーマ出力',
  },
  {
    id: 'openrouter/anthropic/claude-3.5-sonnet',
    name: 'Claude 3.5 Sonnet',
    provider: 'anthropic',
    isRecommended: true,
    description: '安定した推論能力で複雑な多段階事故シナリオを高精度に分解',
  },
  {
    id: 'openrouter/deepseek/deepseek-chat',
    name: 'DeepSeek V3 (Chat)',
    provider: 'deepseek',
    description: '超高速レスポンス、ドラフト作成やテスト抽出向け',
  },
  {
    id: 'openrouter/google/gemini-2.0-pro-exp-02-05',
    name: 'Gemini 2.0 Pro',
    provider: 'google',
    description: '高度な推論力とコード・構造化データ解析に強い',
  },
  {
    id: 'openrouter/openai/gpt-4o-mini',
    name: 'GPT-4o Mini',
    provider: 'openai',
    description: 'コスト効率に優れた軽量モデル',
  },
  {
    id: 'lmstudio/local-model',
    name: 'LM Studio / Local Model',
    provider: 'local',
    isRecommended: true,
    description: '完全オフライン・機密データ対応のローカルLLM接続',
  },
];

/**
 * Classifies raw model ID into provider and friendly metadata
 */
export function classifyModel(rawId: string, rawName?: string): LLMModelOption {
  const lowerId = rawId.toLowerCase();

  let provider: LLMModelOption['provider'] = 'other';
  if (lowerId.includes('anthropic') || lowerId.includes('claude')) {
    provider = 'anthropic';
  } else if (lowerId.includes('deepseek')) {
    provider = 'deepseek';
  } else if (lowerId.includes('google') || lowerId.includes('gemini')) {
    provider = 'google';
  } else if (lowerId.includes('openai') || lowerId.includes('gpt') || lowerId.includes('o1') || lowerId.includes('o3')) {
    provider = 'openai';
  } else if (lowerId.includes('qwen')) {
    provider = 'qwen';
  } else if (lowerId.includes('local') || lowerId.includes('lmstudio') || lowerId.includes('ollama')) {
    provider = 'local';
  }

  const isRecommended =
    lowerId.includes('gemini-3.8-flash') ||
    lowerId.includes('claude-3.5-sonnet') ||
    lowerId.includes('deepseek-r1') ||
    lowerId.includes('gemini-2.0-flash') ||
    lowerId.includes('gpt-4o') ||
    lowerId.includes('local-model');

  const isReasoning =
    lowerId.includes('think') ||
    lowerId.includes('deepseek-v') ||
    lowerId.includes('r1') ||
    lowerId.includes('o1') ||
    lowerId.includes('o3') ||
    lowerId.includes('pro');

  // Friendly name extraction
  const parts = rawId.split('/');
  const shortName = parts[parts.length - 1] || rawId;

  return {
    id: rawId,
    name: rawName || shortName,
    provider,
    isRecommended,
    isReasoning,
  };
}

export const MODEL_PRESETS = [
  { id: 'openrouter/google/gemini-3.8-flash', name: 'Gemini 3.8 Flash (推奨・高速)' },
  { id: 'openrouter/deepseek/deepseek-r1', name: 'DeepSeek R1 (思考モデル・詳細)' },
  { id: 'openrouter/google/gemini-2.0-flash-001', name: 'Gemini 2.0 Flash (高速・長文対応)' },
  { id: 'openrouter/openai/gpt-4o', name: 'GPT-4o (標準)' },
  { id: 'openrouter/anthropic/claude-3.5-sonnet', name: 'Claude 3.5 Sonnet (安定版)' },
  { id: 'lmstudio/local-model', name: 'LM Studio (ローカルLLM)' },
  { id: 'custom', name: '✏️ カスタムモデルIDを入力...' },
];
