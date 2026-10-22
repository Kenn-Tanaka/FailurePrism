import { z } from 'zod';
import { PROJECT_PRESETS, ProjectPresetDefinition } from './commands';
import { LevelDefinitionSchema, NodeKindDefinitionSchema, TPDD_LIMITS } from './schema';

const ProjectPresetSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1).max(200),
  description: z.string().max(2000),
  nodeKinds: z.array(NodeKindDefinitionSchema).min(1).max(TPDD_LIMITS.MAX_NODE_KINDS),
  levels: z.array(LevelDefinitionSchema).min(1).max(TPDD_LIMITS.MAX_LEVELS),
}).superRefine((preset, context) => {
  for (const [field, items] of [['nodeKinds', preset.nodeKinds], ['levels', preset.levels]] as const) {
    const ids = items.map((item) => item.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: 'IDは重複できません' });
    }
  }
});

const ProjectPresetsSchema = z.array(ProjectPresetSchema).min(1).superRefine((presets, context) => {
  const ids = presets.map((preset) => preset.id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'プリセットIDは重複できません' });
  }
});

const fallbackPresets = Object.values(PROJECT_PRESETS);

export interface ProjectPresetsLoadResult {
  presets: ProjectPresetDefinition[];
  warning?: string;
}

/** Installed public JSON can be edited by the installation operator. Invalid files fall back safely. */
export async function loadProjectPresets(): Promise<ProjectPresetsLoadResult> {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}tpdd-presets.json`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const parsed = ProjectPresetsSchema.safeParse(await response.json());
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new Error(`${issue?.path.join('.') || '設定'}: ${issue?.message || '形式が不正です'}`);
    }
    return { presets: parsed.data };
  } catch (error) {
    const detail = error instanceof Error ? error.message : '設定を読み込めませんでした';
    return {
      presets: fallbackPresets,
      warning: `プリセット設定を読み込めなかったため、組み込み設定を使用します (${detail})`,
    };
  }
}
