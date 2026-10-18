import { z } from 'zod';
import { EdgeKindSchema, NodeKindSchema } from '../../domain/schema';

// 候補ノード
export const NodeProposalSchema = z.object({
  candidateId: z.string().min(1, 'candidateIdは必須です'),
  label: z.string().min(1, 'ラベルは必須です').max(200, 'ラベルは200文字以内です'),
  kind: NodeKindSchema,
  levelId: z.string().min(1, 'levelIdは必須です'),
  description: z.string().max(10000, '説明は10,000文字以内です').default(''),
  tags: z.array(z.string().max(100)).max(20).default([]),
  rationale: z.string().max(2000, '採用理由は2000文字以内です').default(''),
  assumptions: z.array(z.string().max(2000)).max(20).default([]),
  checks: z.array(z.string().max(2000)).max(20).default([]),
});
export type NodeProposal = z.infer<typeof NodeProposalSchema>;

// 候補エッジ
export const EdgeProposalSchema = z.object({
  sourceRef: z.string().min(1), // existing:<nodeId> または candidate:<candidateId>
  targetRef: z.string().min(1),
  kind: EdgeKindSchema,
  label: z.string().max(200).default(''),
});
export type EdgeProposal = z.infer<typeof EdgeProposalSchema>;

// 展開案・代替案レスポンス
export const ProposalResponseSchema = z.object({
  format: z.literal('thought-expansion-ai'),
  schemaVersion: z.literal(1),
  task: z.enum(['expand', 'alternatives']),
  summary: z.string().max(2000, '要約は2000文字以内です'),
  nodes: z.array(NodeProposalSchema).min(1, 'ノード提案は最低1件必要です').max(10, 'ノード提案は最大10件までです'),
  edges: z.array(EdgeProposalSchema).max(20, 'エッジ提案は最大20件までです'),
});
export type ProposalResponse = z.infer<typeof ProposalResponseSchema>;

// レビュー指摘事項
export const ReviewIssueSchema = z.object({
  severity: z.enum(['info', 'warning']),
  nodeIds: z.array(z.string()).default([]),
  edgeIds: z.array(z.string()).default([]),
  category: z.enum(['missing', 'conflict', 'ambiguity', 'verification']),
  message: z.string().max(2000, '指摘メッセージは2000文字以内です'),
  recommendation: z.string().max(2000, '改善提案は2000文字以内です'),
});
export type ReviewIssue = z.infer<typeof ReviewIssueSchema>;

// レビューレスポンス
export const ReviewResponseSchema = z.object({
  format: z.literal('thought-expansion-review'),
  schemaVersion: z.literal(1),
  task: z.literal('review'),
  summary: z.string().max(2000, '要約は2000文字以内です'),
  issues: z.array(ReviewIssueSchema).max(30, '指摘事項は最大30件までです'),
});
export type ReviewResponse = z.infer<typeof ReviewResponseSchema>;

/**
 * 仕様書 9.5: LLMテキスト出力をJSONとして検証・パース
 * 応答全体が単一の ```json ... ``` フェンスで囲まれている場合のみ外枠を除去
 */
export function extractAndParseAiJson(rawText: string): unknown {
  let cleaned = rawText.trim();

  // 単一の ```json ... ``` または ``` ... ``` コードフェンスの除去
  const fenceRegex = /^```(?:json)?\s*([\s\S]*?)\s*```$/;
  const match = cleaned.match(fenceRegex);
  if (match) {
    cleaned = match[1].trim();
  }

  // 最初と最後が { と } であることを確認 (単一JSONオブジェクト)
  if (!cleaned.startsWith('{') || !cleaned.endsWith('}')) {
    throw new Error('AIの応答が単一のJSONオブジェクトではありません。');
  }

  return JSON.parse(cleaned);
}

export interface ValidationContext {
  validLevelIds: Set<string>;
  existingNodeIds: Set<string>;
  existingEdgeIds?: Set<string>;
}

/**
 * 提案応答の厳密整合性検証
 */
export function validateProposalResponse(
  rawJson: unknown,
  context: ValidationContext
): { valid: boolean; data?: ProposalResponse; error?: string } {
  const parseResult = ProposalResponseSchema.safeParse(rawJson);
  if (!parseResult.success) {
    const msg = parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    return { valid: false, error: `スキーマ検証エラー: ${msg}` };
  }

  const data = parseResult.data;

  // candidateId の重複チェック
  const candidateIds = new Set<string>();
  for (const node of data.nodes) {
    if (candidateIds.has(node.candidateId)) {
      return { valid: false, error: `candidateId「${node.candidateId}」が重複しています。` };
    }
    candidateIds.add(node.candidateId);

    // levelId の存在確認
    if (!context.validLevelIds.has(node.levelId)) {
      return { valid: false, error: `提案ノードに存在しない抽象度列ID「${node.levelId}」が含まれています。` };
    }
  }

  // エッジ参照の解決と正規化（Gemma等のモデルがプレフィックスを省略して "c2" と出力した場合にも自動補完）
  const normalizeRef = (ref: string): string | null => {
    const trimmed = ref.trim();
    if (trimmed.startsWith('candidate:')) {
      const cId = trimmed.slice('candidate:'.length).trim();
      return candidateIds.has(cId) ? `candidate:${cId}` : null;
    }
    if (trimmed.startsWith('existing:')) {
      const eId = trimmed.slice('existing:'.length).trim();
      return context.existingNodeIds.has(eId) ? `existing:${eId}` : null;
    }
    // プレフィックス省略時のフォールバック (c1, c2 または 既存ノードID)
    if (candidateIds.has(trimmed)) {
      return `candidate:${trimmed}`;
    }
    if (context.existingNodeIds.has(trimmed)) {
      return `existing:${trimmed}`;
    }
    return null;
  };

  const edgeSet = new Set<string>();

  for (const edge of data.edges) {
    const normalizedSource = normalizeRef(edge.sourceRef);
    if (!normalizedSource) {
      return { valid: false, error: `エッジ始点参照「${edge.sourceRef}」が存在しないノードを参照しています。` };
    }

    const normalizedTarget = normalizeRef(edge.targetRef);
    if (!normalizedTarget) {
      return { valid: false, error: `エッジ終点参照「${edge.targetRef}」が存在しないノードを参照しています。` };
    }

    if (normalizedSource === normalizedTarget) {
      return { valid: false, error: `自己エッジ参照は禁止されています (${edge.sourceRef})。` };
    }

    // 正規化した参照に書き戻す (下流の proposalAdopter が安全に処理できるようにする)
    edge.sourceRef = normalizedSource;
    edge.targetRef = normalizedTarget;

    const key = `${normalizedSource}-->${normalizedTarget}::${edge.kind}`;
    if (edgeSet.has(key)) {
      return { valid: false, error: `重複エッジ提案は禁止されています (${key})。` };
    }
    edgeSet.add(key);
  }

  return { valid: true, data };
}

/**
 * レビュー応答の厳密整合性検証
 */
export function validateReviewResponse(
  rawJson: unknown,
  context: ValidationContext
): { valid: boolean; data?: ReviewResponse; error?: string } {
  const parseResult = ReviewResponseSchema.safeParse(rawJson);
  if (!parseResult.success) {
    const msg = parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    return { valid: false, error: `スキーマ検証エラー: ${msg}` };
  }

  const data = parseResult.data;

  // 指摘内のnodeIds, edgeIdsが存在するか確認
  for (const issue of data.issues) {
    for (const nId of issue.nodeIds) {
      if (!context.existingNodeIds.has(nId)) {
        return { valid: false, error: `レビュー指摘に存在しないノードID「${nId}」が含まれています。` };
      }
    }
    if (context.existingEdgeIds) {
      for (const eId of issue.edgeIds) {
        if (!context.existingEdgeIds.has(eId)) {
          return { valid: false, error: `レビュー指摘に存在しないエッジID「${eId}」が含まれています。` };
        }
      }
    }
  }

  return { valid: true, data };
}
