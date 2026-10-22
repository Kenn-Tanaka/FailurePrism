import { z } from 'zod';

export const PROJECT_SCHEMA_VERSION = 2 as const;

// ノード種別の表示パレット
export const NodePaletteKeySchema = z.enum([
  'blue',
  'cyan',
  'teal',
  'lime',
  'yellow',
  'orange',
  'pink',
  'olive',
  'gray',
]).catch('gray');
export type NodePaletteKey = z.infer<typeof NodePaletteKeySchema>;

// プロジェクトごとのノード種別定義。配列順が表示順。
export const NodeKindDefinitionSchema = z.object({
  id: z.string().min(1, '種別IDは空にできません'),
  label: z.string().min(1, '種別名は空にできません').max(200, '種別名は200文字以内です'),
  description: z.string().max(2000, '種別の説明は2,000文字以内です'),
  paletteKey: NodePaletteKeySchema,
});
export type NodeKindDefinition = z.infer<typeof NodeKindDefinitionSchema>;

// ノード状態
export const NodeStatusSchema = z.enum([
  'draft',
  'candidate',
  'adopted',
  'rejected',
]);
export type NodeStatus = z.infer<typeof NodeStatusSchema>;

// エッジ種別
export const EdgeKindSchema = z.enum([
  'decomposition',
  'dependency',
  'constraint',
  'reference',
]);
export type EdgeKind = z.infer<typeof EdgeKindSchema>;

// 抽象度列定義 (1〜12列)。配列順が左から右の列順。
export const LevelDefinitionSchema = z.object({
  id: z.string().min(1, '列IDは空にできません'),
  label: z.string().min(1, '列名は空にできません').max(200, '列名は200文字以内です'),
  description: z.string().max(2000, '列の説明は2,000文字以内です'),
});
export type LevelDefinition = z.infer<typeof LevelDefinitionSchema>;

// 来歴情報
export const ProvenanceSchema = z.object({
  origin: z.enum(['manual', 'llm']),
  createdAt: z.string().datetime({ message: 'ISO 8601形式のUTC日時である必要があります' }),
  modelId: z.string().optional(),
  task: z.enum(['expand', 'alternatives']).optional(),
  promptVersion: z.string().optional(),
  requestId: z.string().optional(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

// 上限・境界定数
export const TPDD_LIMITS = {
  LABEL_MAX_LENGTH: 200,
  DESCRIPTION_MAX_LENGTH: 10000,
  TAG_MAX_LENGTH: 100,
  MAX_TAGS_PER_NODE: 20,
  LINK_MAX_LENGTH: 2048,
  MAX_LINKS_PER_NODE: 20,
  MAX_NODE_KINDS: 24,
  MAX_LEVELS: 12,
  MAX_DIAGRAMS: 100,
  MAX_NODES_PER_DIAGRAM: 500,
  MAX_EDGES_PER_DIAGRAM: 1000,
  MAX_TOTAL_NODES: 5000,
  MAX_TOTAL_EDGES: 10000,
} as const;

// ノード定義
export const ThoughtNodeSchema = z.object({
  id: z.string().min(1, 'ノードIDは空にできません'),
  label: z.string().min(1, 'ラベルは空にできません').max(TPDD_LIMITS.LABEL_MAX_LENGTH, 'ラベルは200文字以内です'),
  kindId: z.string().min(1, 'ノード種別IDは必須です'),
  status: NodeStatusSchema,
  levelId: z.string().min(1, '抽象度列IDは必須です'),
  x: z.number().finite().min(-1000000).max(1000000),
  y: z.number().finite().min(-1000000).max(1000000),
  width: z.number().finite().min(120, '幅は120以上').max(1000, '幅は1000以下'),
  height: z.number().finite().min(48, '高さは48以上').max(2000, '高さは2000以下'),
  childDiagramId: z.string().optional(),
  meta: z.object({
    description: z.string().max(TPDD_LIMITS.DESCRIPTION_MAX_LENGTH, '説明は10,000文字以内です'),
    tags: z
      .array(z.string().min(1, 'タグは空にできません').max(TPDD_LIMITS.TAG_MAX_LENGTH, 'タグは100文字以内です'))
      .max(TPDD_LIMITS.MAX_TAGS_PER_NODE, 'タグは最大20個までです'),
    sourceLinks: z.array(
      z.string().url('URL形式が不正です').max(TPDD_LIMITS.LINK_MAX_LENGTH, 'リンクは2048文字以内です')
        .refine((url) => url.startsWith('http://') || url.startsWith('https://'), {
          message: 'リンクはhttpまたはhttpsのみ許可されます',
        })
    ).max(TPDD_LIMITS.MAX_LINKS_PER_NODE, 'リンクは最大20件までです'),
  }),
  provenance: ProvenanceSchema,
});
export type ThoughtNode = z.infer<typeof ThoughtNodeSchema>;

// エッジ定義
export const ThoughtEdgeSchema = z.object({
  id: z.string().min(1, 'エッジIDは空にできません'),
  sourceId: z.string().min(1, '始点ノードIDは必須です'),
  targetId: z.string().min(1, '終点ノードIDは必須です'),
  kind: EdgeKindSchema,
  label: z.string().max(200, 'エッジラベルは200文字以内です'),
});
export type ThoughtEdge = z.infer<typeof ThoughtEdgeSchema>;

// 図定義
export const DiagramSchema = z.object({
  id: z.string().min(1, '図IDは空にできません'),
  title: z.string().min(1, '図タイトルは空にできません').max(200, '図タイトルは200文字以内です'),
  nodes: z.array(ThoughtNodeSchema).max(500, '1図あたりのノード上限は500件です'),
  edges: z.array(ThoughtEdgeSchema).max(1000, '1図あたりのエッジ上限は1000件です'),
});
export type Diagram = z.infer<typeof DiagramSchema>;

// AI設定
export const AiPreferencesSchema = z.object({
  modelId: z.string().min(1),
  timeoutSeconds: z.number().int().min(30).max(1800),
  temperature: z.number().min(0).max(2).nullable(),
  stream: z.boolean(),
});
export type AiPreferences = z.infer<typeof AiPreferencesSchema>;

// プロジェクト定義 (正本)
export const ProjectSchema = z.object({
  format: z.literal('tpdd-project'),
  schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
  id: z.string().min(1, 'プロジェクトIDは空にできません'),
  title: z.string().min(1, 'プロジェクト名は空にできません').max(200, 'プロジェクト名は200文字以内です'),
  description: z.string().max(10000, '説明は10,000文字以内です'),
  createdAt: z.string().datetime({ message: 'ISO 8601形式のUTC日時である必要があります' }),
  updatedAt: z.string().datetime({ message: 'ISO 8601形式のUTC日時である必要があります' }),
  rootDiagramId: z.string().min(1, 'ルート図IDは必須です'),
  nodeKinds: z
    .array(NodeKindDefinitionSchema)
    .min(1, 'ノード種別は最低1件必要です')
    .max(TPDD_LIMITS.MAX_NODE_KINDS, 'ノード種別は最大24件までです'),
  levels: z.array(LevelDefinitionSchema).min(1, '抽象度列は最低1列必要です').max(12, '抽象度列は最大12列までです'),
  diagrams: z.array(DiagramSchema).min(1, '図は最低1つ必要です').max(100, '図は最大100個までです'),
  aiPreferences: AiPreferencesSchema,
});
export type Project = z.infer<typeof ProjectSchema>;
