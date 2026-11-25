import { z } from 'zod';

export const ModelProviderIdSchema = z.enum([
  'anthropic',
  'deepseek',
  'google',
  'openai',
  'qwen',
  'local',
  'other',
]);
export type ModelProviderId = z.infer<typeof ModelProviderIdSchema>;

export const TOOL_ID_REGEX = /^[a-z0-9][a-z0-9-_]*$/;

export const KNOWN_LLM_CONSUMER_TOOLS: ReadonlyArray<{ id: 'tpdd' | 'vta'; label: string }> = [
  { id: 'tpdd', label: 'TPDD-Editor' },
  { id: 'vta', label: 'VTA-Editor' },
];

/**
 * Validates Gateway model IDs in `<provider_id>/<upstream_model_id>` format.
 */
export function validateModelId(input: string): { valid: boolean; message?: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { valid: false, message: 'モデルIDを入力してください。' };
  }
  if (trimmed.length > 1024) {
    return { valid: false, message: 'モデルIDは1024文字以内である必要があります。' };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    return { valid: false, message: 'モデルIDに制御文字を含めることはできません。' };
  }

  const slashIndex = trimmed.indexOf('/');
  if (slashIndex === -1) {
    return {
      valid: false,
      message:
        'モデルIDは <provider_id>/<upstream_model_id> の形式（例: lmstudio/my-model）である必要があります。',
    };
  }

  const providerId = trimmed.slice(0, slashIndex).trim();
  const upstreamModelId = trimmed.slice(slashIndex + 1).trim();

  if (!providerId) {
    return { valid: false, message: 'プロバイダーID (最初のスラッシュの前) を入力してください。' };
  }
  if (!upstreamModelId) {
    return { valid: false, message: '上流モデルID (最初のスラッシュの後) を入力してください。' };
  }

  return { valid: true };
}

export const ModelIdSchema = z
  .string()
  .transform((v) => v.trim())
  .superRefine((val, ctx) => {
    const res = validateModelId(val);
    if (!res.valid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: res.message || 'モデルIDの形式が不正です。',
      });
    }
  });

export const ManagedModelEntrySchema = z.object({
  id: ModelIdSchema,
  name: z.string().trim().min(1, '表示名は空にできません').max(200, '表示名は200文字以内です'),
  provider: ModelProviderIdSchema,
  description: z.string().max(2000, '説明は2,000文字以内です').default(''),
  isRecommended: z.boolean().default(true),
  isPreset: z.boolean().default(false),
  isReasoning: z.boolean().default(false),
  targetTools: z
    .array(z.string().trim().regex(TOOL_ID_REGEX, 'ツールID形式が不正です'))
    .default(['tpdd', 'vta']),
  order: z.number().finite().int().min(0).max(100000).default(100),
});
export type ManagedModelEntry = z.infer<typeof ManagedModelEntrySchema>;

export const LLMModelsSeedSchema = z
  .object({
    schemaVersion: z.literal(1),
    defaultModelId: ModelIdSchema,
    toolDefaultModelIds: z
      .record(
        z.string().trim().regex(TOOL_ID_REGEX, 'ツールID形式が不正です'),
        z.string().transform((v) => v.trim())
      )
      .default({}),
    models: z.array(ManagedModelEntrySchema).min(1, '少なくとも1件のモデル定義が必要です'),
  })
  .superRefine((seed, ctx) => {
    const seen = new Set<string>();
    seed.models.forEach((m, index) => {
      if (seen.has(m.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['models', index, 'id'],
          message: `モデルID '${m.id}' が重複しています`,
        });
      }
      seen.add(m.id);
    });

    for (const [toolId, modelId] of Object.entries(seed.toolDefaultModelIds)) {
      if (!modelId) continue;
      const validation = validateModelId(modelId);
      if (!validation.valid) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['toolDefaultModelIds', toolId],
          message: validation.message || 'モデルIDの形式が不正です',
        });
      }
    }
  });
export type LLMModelsSeed = z.infer<typeof LLMModelsSeedSchema>;

export const ManagedLLMRegistryStateSchema = LLMModelsSeedSchema.safeExtend({
  updatedAt: z.string().default(() => new Date().toISOString()),
});
export type ManagedLLMRegistryState = z.infer<typeof ManagedLLMRegistryStateSchema>;

export interface ClassifiedModelInfo {
  id: string;
  name: string;
  provider: ModelProviderId;
  isRecommended: boolean;
  isReasoning: boolean;
}

/**
 * Classifies a raw Gateway model ID into provider, friendly name, and hint flags.
 */
export function classifyModel(rawId: string, rawName?: string): ClassifiedModelInfo {
  const lowerId = rawId.toLowerCase();

  let provider: ModelProviderId = 'other';
  if (lowerId.includes('anthropic') || lowerId.includes('claude')) {
    provider = 'anthropic';
  } else if (lowerId.includes('deepseek')) {
    provider = 'deepseek';
  } else if (lowerId.includes('google') || lowerId.includes('gemini')) {
    provider = 'google';
  } else if (
    lowerId.includes('openai') ||
    lowerId.includes('gpt') ||
    lowerId.includes('o1') ||
    lowerId.includes('o3') ||
    lowerId.includes('o4')
  ) {
    provider = 'openai';
  } else if (lowerId.includes('qwen') || lowerId.includes('qwq')) {
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
    lowerId.includes('reasoner') ||
    lowerId.includes('deepseek-v') ||
    lowerId.includes('r1') ||
    lowerId.includes('qwq') ||
    lowerId.includes('o1') ||
    lowerId.includes('o3') ||
    lowerId.includes('o4') ||
    lowerId.includes('pro');

  const parts = rawId.split('/');
  const shortName = parts[parts.length - 1] || rawId;

  return {
    id: rawId,
    name: rawName?.trim() || shortName,
    provider,
    isRecommended,
    isReasoning,
  };
}

const KNOWN_GATEWAY_PREFIXES = ['openrouter/', 'lmstudio/', 'lmstudio_remote/', 'ollama/', 'embedded/'];

/**
 * Normalizes an upstream model ID into Gateway `<provider_id>/<upstream_model_id>` format when requested.
 * Avoids double-prefixing if the ID already starts with the target prefix or a known local Gateway prefix.
 */
export function normalizeImportedModelId(
  rawId: string,
  options?: { gatewayProviderPrefix?: string }
): string {
  const trimmed = rawId.trim();
  if (!trimmed) return '';

  const prefixRaw = options?.gatewayProviderPrefix?.trim().replace(/^\/+|\/+$/g, '') ?? '';
  if (!prefixRaw) {
    return trimmed;
  }

  const lowerId = trimmed.toLowerCase();
  const lowerPrefix = `${prefixRaw.toLowerCase()}/`;
  if (lowerId.startsWith(lowerPrefix)) {
    return `${prefixRaw}/${trimmed.slice(lowerPrefix.length)}`;
  }

  if (prefixRaw.toLowerCase() === 'openrouter') {
    for (const known of KNOWN_GATEWAY_PREFIXES) {
      if (lowerId.startsWith(known)) {
        return trimmed;
      }
    }
  }

  return `${prefixRaw}/${trimmed}`;
}
