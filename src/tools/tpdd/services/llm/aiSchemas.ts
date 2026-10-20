import { z } from 'zod';
import { TPDD_LIMITS } from '../../domain/schema';

function normalizeText(
  value: unknown,
  maxLength: number,
  trim = false
): string {
  if (typeof value !== 'string') return '';
  const normalized = trim ? value.trim() : value;
  return normalized.slice(0, maxLength);
}

function textSchema(
  maxLength: number,
  options: { trim?: boolean; requiredMessage?: string } = {}
) {
  const output = options.requiredMessage
    ? z.string().min(1, options.requiredMessage)
    : z.string();
  return z.preprocess(
    (value) => normalizeText(value, maxLength, options.trim),
    output
  );
}

function normalizeStringList(
  value: unknown,
  maxItems: number,
  maxItemLength: number
): string[] {
  if (!Array.isArray(value)) return [];
  const normalized = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().slice(0, maxItemLength))
    .filter(Boolean);
  return Array.from(new Set(normalized)).slice(0, maxItems);
}

function stringListSchema(maxItems: number, maxItemLength: number) {
  return z.preprocess(
    (value) => normalizeStringList(value, maxItems, maxItemLength),
    z.array(z.string())
  );
}

/**
 * LLMにはProject内の永続IDを生成させない。
 * 応答は内容と短い参照記号だけに絞り、永続IDへの解決はアプリ側で行う。
 */
export const NodeProposalSchema = z.object({
  label: textSchema(TPDD_LIMITS.LABEL_MAX_LENGTH, {
    trim: true,
    requiredMessage: 'ラベルは必須です',
  }),
  kindRef: textSchema(TPDD_LIMITS.LABEL_MAX_LENGTH, { trim: true }),
  description: textSchema(TPDD_LIMITS.DESCRIPTION_MAX_LENGTH),
  tags: stringListSchema(TPDD_LIMITS.MAX_TAGS_PER_NODE, TPDD_LIMITS.TAG_MAX_LENGTH),
  rationale: textSchema(2000),
  assumptions: stringListSchema(20, 2000),
  checks: stringListSchema(20, 2000),
});

export const ProposalResponseSchema = z.object({
  summary: textSchema(2000),
  nodes: z.preprocess(
    (value) => {
      if (Array.isArray(value)) return value.slice(0, 10);
      if (typeof value === 'object' && value !== null) return [value];
      return value;
    },
    z.array(NodeProposalSchema).min(1, 'ノード提案は最低1件必要です')
  ),
});

type ParsedProposalResponse = z.infer<typeof ProposalResponseSchema>;

export interface NodeProposal extends Omit<z.infer<typeof NodeProposalSchema>, 'kindRef'> {
  /** UI内だけで使う一時ID。LLMには生成させない。 */
  candidateId: string;
  /** LLMが返した参照記号。診断表示用に保持する。 */
  kindRef: string;
  /** 解決できない場合はnull。候補カード上でユーザーが修正できる。 */
  kindId: string | null;
}

export interface ProposalResponse {
  summary: string;
  nodes: NodeProposal[];
}

export const ReviewIssueSchema = z.object({
  severity: z.preprocess(
    (value) => typeof value === 'string' ? value.trim().toLowerCase() : value,
    z.enum(['info', 'warning'])
  ),
  nodeRefs: stringListSchema(50, TPDD_LIMITS.LABEL_MAX_LENGTH),
  edgeRefs: stringListSchema(50, TPDD_LIMITS.LABEL_MAX_LENGTH),
  category: z.preprocess(
    (value) => typeof value === 'string' ? value.trim().toLowerCase() : value,
    z.enum(['missing', 'conflict', 'ambiguity', 'verification'])
  ),
  message: textSchema(2000, { requiredMessage: '指摘メッセージは必須です' }),
  recommendation: textSchema(2000, { requiredMessage: '改善提案は必須です' }),
});

export const ReviewResponseSchema = z.object({
  summary: textSchema(2000),
  issues: z.preprocess(
    (value) => {
      if (Array.isArray(value)) return value.slice(0, 30);
      if (typeof value === 'object' && value !== null) return [value];
      if (value == null) return [];
      return value;
    },
    z.array(ReviewIssueSchema)
  ),
});

export interface ReviewIssue {
  severity: 'info' | 'warning';
  nodeIds: string[];
  edgeIds: string[];
  category: 'missing' | 'conflict' | 'ambiguity' | 'verification';
  message: string;
  recommendation: string;
}

export interface ReviewResponse {
  summary: string;
  issues: ReviewIssue[];
}

/**
 * LLMテキスト出力をJSONとして検証・パースする。
 * 応答全体が単一のJSONコードフェンスで囲まれている場合だけ外枠を除去する。
 */
export function extractAndParseAiJson(rawText: string): unknown {
  let cleaned = rawText.trim();
  const fenceRegex = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;
  const match = cleaned.match(fenceRegex);
  if (match) {
    cleaned = match[1].trim();
  }

  if (!cleaned.startsWith('{') || !cleaned.endsWith('}')) {
    throw new Error('AIの応答が単一のJSONオブジェクトではありません。');
  }

  return JSON.parse(cleaned);
}

export interface ProposalValidationContext {
  /** K1, K2... からProject内の種別IDへの対応。 */
  kindRefToId: ReadonlyMap<string, string>;
}

export interface ReviewValidationContext {
  /** N1, N2... / E1, E2... からProject内IDへの対応。 */
  nodeRefToId: ReadonlyMap<string, string>;
  edgeRefToId: ReadonlyMap<string, string>;
}

function normalizeAlias(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * 提案応答を最小スキーマで検証し、参照記号をアプリ側のIDへ解決する。
 * kindRefが不明でも応答全体は捨てず、その候補だけ未解決として返す。
 */
export function validateProposalResponse(
  rawJson: unknown,
  context: ProposalValidationContext
): { valid: boolean; data?: ProposalResponse; error?: string } {
  const parseResult = ProposalResponseSchema.safeParse(rawJson);
  if (!parseResult.success) {
    const msg = parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    return { valid: false, error: `スキーマ検証エラー: ${msg}` };
  }

  const parsed: ParsedProposalResponse = parseResult.data;
  const normalizedKinds = new Map<string, string>();
  for (const [ref, id] of context.kindRefToId) {
    normalizedKinds.set(normalizeAlias(ref), id);
  }

  return {
    valid: true,
    data: {
      summary: parsed.summary,
      nodes: parsed.nodes.map((node, index) => ({
        ...node,
        candidateId: `p${index + 1}`,
        kindId: normalizedKinds.get(normalizeAlias(node.kindRef)) ?? null,
      })),
    },
  };
}

/**
 * レビュー応答の短い参照記号を実IDへ戻す。
 * 不明な参照だけを除外し、有用なレビュー本文は残す。
 */
export function validateReviewResponse(
  rawJson: unknown,
  context: ReviewValidationContext
): { valid: boolean; data?: ReviewResponse; error?: string } {
  const parseResult = ReviewResponseSchema.safeParse(rawJson);
  if (!parseResult.success) {
    const msg = parseResult.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ');
    return { valid: false, error: `スキーマ検証エラー: ${msg}` };
  }

  const nodeRefs = new Map<string, string>();
  for (const [ref, id] of context.nodeRefToId) {
    nodeRefs.set(normalizeAlias(ref), id);
  }
  const edgeRefs = new Map<string, string>();
  for (const [ref, id] of context.edgeRefToId) {
    edgeRefs.set(normalizeAlias(ref), id);
  }

  return {
    valid: true,
    data: {
      summary: parseResult.data.summary,
      issues: parseResult.data.issues.map((issue) => ({
        severity: issue.severity,
        nodeIds: issue.nodeRefs
          .map((ref) => nodeRefs.get(normalizeAlias(ref)))
          .filter((id): id is string => Boolean(id)),
        edgeIds: issue.edgeRefs
          .map((ref) => edgeRefs.get(normalizeAlias(ref)))
          .filter((id): id is string => Boolean(id)),
        category: issue.category,
        message: issue.message,
        recommendation: issue.recommendation,
      })),
    },
  };
}
