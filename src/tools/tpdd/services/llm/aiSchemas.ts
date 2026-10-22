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

const ReportSectionIdSchema = z.enum([
  'requirement',
  'breakdown',
  'concretization',
  'realization',
]);

const ReportStatementSchema = z.object({
  text: textSchema(3000, { trim: true, requiredMessage: '説明文は必須です' }),
  nodeRefs: stringListSchema(50, TPDD_LIMITS.LABEL_MAX_LENGTH),
  edgeRefs: stringListSchema(50, TPDD_LIMITS.LABEL_MAX_LENGTH),
}).refine((statement) => statement.nodeRefs.length + statement.edgeRefs.length > 0, {
  message: '各説明文に根拠参照が必要です',
});

export const RequirementReportResponseSchema = z.object({
  sections: z.preprocess(
    (value) => Array.isArray(value) ? value.slice(0, 4) : value,
    z.array(z.object({
      id: ReportSectionIdSchema,
      statements: z.preprocess(
        (value) => Array.isArray(value) ? value.slice(0, 12) : value,
        z.array(ReportStatementSchema)
      ),
    })).max(4)
  ),
});

export type ReportSectionId = z.infer<typeof ReportSectionIdSchema>;
export type ReportStatement = z.infer<typeof ReportStatementSchema>;
export interface RequirementReportResponse {
  sections: Array<{ id: ReportSectionId; statements: ReportStatement[] }>;
}

export interface RequirementReportEdgeEvidence {
  kind: string;
  sourceNodeRef: string;
  targetNodeRef: string;
}

export interface RequirementReportValidationContext {
  rootNodeRef: string;
  nodeRefs: ReadonlySet<string>;
  edgesByRef: ReadonlyMap<string, RequirementReportEdgeEvidence>;
}

/** Validate evidence references and discard claims that do not meet their section's evidence rule. */
export function validateRequirementReportResponse(
  rawJson: unknown,
  context: RequirementReportValidationContext
): { valid: boolean; data?: RequirementReportResponse; warnings?: string[]; error?: string } {
  const parsed = RequirementReportResponseSchema.safeParse(rawJson);
  if (!parsed.success) {
    const message = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ');
    return { valid: false, error: `説明文出力の形式を検証できません: ${message}` };
  }

  const nodesByNormalizedRef = new Map(Array.from(context.nodeRefs, (ref) => [normalizeAlias(ref), ref]));
  const edgesByNormalizedRef = new Map(Array.from(context.edgesByRef.keys(), (ref) => [normalizeAlias(ref), ref]));
  const normalizeRefs = (refs: string[], allowed: ReadonlyMap<string, string>) =>
    refs.map((ref) => allowed.get(normalizeAlias(ref)));

  const warnings: string[] = [];
  const sections: RequirementReportResponse['sections'] = [];
  const seenSections = new Set<ReportSectionId>();
  for (const section of parsed.data.sections) {
    if (seenSections.has(section.id)) {
      warnings.push('重複した節を除外しました。');
      continue;
    }
    seenSections.add(section.id);
    const statements: ReportStatement[] = [];
    for (const statement of section.statements) {
      const nodeRefs = normalizeRefs(statement.nodeRefs, nodesByNormalizedRef);
      const edgeRefs = normalizeRefs(statement.edgeRefs, edgesByNormalizedRef);
      if (nodeRefs.some((ref) => !ref) || edgeRefs.some((ref) => !ref)) {
        warnings.push('範囲外の参照を含む説明文を除外しました。');
        continue;
      }
      const resolvedNodeRefsSet = new Set(nodeRefs as string[]);
      const resolvedEdgeRefs = edgeRefs as string[];
      for (const ref of resolvedEdgeRefs) {
        const edge = context.edgesByRef.get(ref);
        if (edge) {
          resolvedNodeRefsSet.add(edge.sourceNodeRef);
          resolvedNodeRefsSet.add(edge.targetNodeRef);
        }
      }
      const resolvedNodeRefs = Array.from(resolvedNodeRefsSet);
      if (
        section.id === 'requirement' &&
        !nodeRefs.includes(context.rootNodeRef)
      ) {
        warnings.push('起点要求を根拠に含まない説明文を除外しました。');
        continue;
      }
      if (
        section.id === 'breakdown' &&
        !resolvedEdgeRefs.some((ref) => context.edgesByRef.get(ref)?.kind === 'decomposition')
      ) {
        warnings.push('明示的な分解線を根拠に含まない分解説明を除外しました。');
        continue;
      }
      if (
        (section.id === 'concretization' || section.id === 'realization') &&
        resolvedNodeRefs.length === 0
      ) {
        warnings.push('対象ノードを根拠に含まない説明文を除外しました。');
        continue;
      }
      if (
        section.id === 'realization' &&
        !resolvedEdgeRefs.some((ref) => context.edgesByRef.get(ref)?.kind === 'decomposition')
      ) {
        warnings.push('明示的な分解線を根拠に含まない実現案を除外しました。');
        continue;
      }
      statements.push({
        text: statement.text,
        nodeRefs: resolvedNodeRefs,
        edgeRefs: resolvedEdgeRefs,
      });
    }
    if (statements.length > 0) sections.push({ id: section.id, statements });
  }

  if (sections.length === 0) {
    return {
      valid: false,
      error: warnings.length > 0
        ? '有効な説明文がありません。根拠参照の検証ですべての記述が除外されました。'
        : '説明文が生成されませんでした。対象範囲の情報を確認して再試行してください。',
      warnings: Array.from(new Set(warnings)),
    };
  }

  return {
    valid: true,
    data: {
      sections,
    },
    warnings: Array.from(new Set(warnings)),
  };
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
