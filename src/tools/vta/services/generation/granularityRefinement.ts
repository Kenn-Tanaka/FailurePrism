import type {
  GranularityWeights,
  LLMConfig,
  VTAAnalysisData,
  VTAAnalysisScope,
  VTAEventRelation,
  VTARefinementIteration,
  VTASchema,
  VTASource,
  VTASourceRef,
  VTAUserAssumption,
} from '../../types/vta';
import { consolidateSubjects, revertConsolidation } from '../../features/vta/utils/subjectRanking';
import { projectAnalysis, validateParticipants, buildAnalysis } from '../../features/vta/utils/eventAnalysis';
import { dependencyProblem } from '../../features/vta/utils/eventOrder';
import { relationAttributes, validateRelationEndpoints, RELATION_CONTRACT_PROMPT } from '../../features/vta/utils/relationContract';
import { FACTUALITY_POLICY } from '../llm/factualityPolicy';
import { computeMachineMetrics, extractCausalScenario, totalScore } from './granularityScore';
import { SubjectPoset } from '../../features/vta/utils/subjectPoset';
import { sliceRelevantSourceParagraphs } from './contextSlicer';

export { sliceRelevantSourceParagraphs };

export interface RefinementOp {
  id: string;
  op: 'split' | 'merge' | 'group' | 'suppress' | 'add_relation' | 'modify_relation' | 'remove_relation';
  targetId: string;
  content: string;
  sourceRefs: string[];
  reason: string;
}

export interface ParsedReviewResponse {
  c2?: number;
  c4?: number;
  scenarioScore?: number;
  scenarioReason?: string;
  ops: RefinementOp[];
  invalidLines: string[];
}

export type RefinementChatCaller = (
  config: LLMConfig,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  temperature?: number,
  signal?: AbortSignal
) => Promise<{ content: string; latencyMs: number }>;

export type RefinementLog = (type: 'info' | 'success' | 'warn' | 'error', message: string, stage?: string) => void;

export const GRANULARITY_REVIEW_SYSTEM_PROMPT = `あなたはVTA（バリエーションツリー分析）の主体粒度・接続構造・認知負荷を点検する専門レビュアです。
${FACTUALITY_POLICY}
${RELATION_CONTRACT_PROMPT}

提示された現在のVTA台帳（主体・イベント・仮判定・関係・共有カード）および【現在の因果シナリオ】と原文を照合し、以下の3つの観点スコアと、必要な構造修正指示をTSV形式で出力してください。
- C2（役割の一貫性）: 同一主体レーンに責任範囲や現場の異なる主体の作業が混在していないか（0.00〜1.00）。
  ※ADR-0008原則: 同一組織内であっても、「被災・異常発生側」と「救助・検知・水際阻止側」のように役割や帰結が非対称な主体（例: 風防脱落時の機長と副操縦士、品質トラブルの製造と品証、サイバー攻撃のIT運用とCSIRT）が同一レーンに不当に統合されている場合は減点し、split 操作で独立レーン化を指示すること。逆に同一の帰結（墜落・全社被害等）を共有している場合は統合（merge）を許容する。
- C4（システム境界の妥当性）: 自律動作のない受動的な客体・部品が不要に独立レーン化されていないか（0.00〜1.00）
- シナリオ（因果プロセスの網羅性）: 帰結から逆走抽出された主要シナリオが、事故・インシデントの発生プロセスを全体として適切に捉えているか（1〜5の整数、または0.00〜1.00）。シナリオから漏れている重要な出来事があれば add_relation で接続し、逆に事故と無関係な事象が混入していれば remove_relation で除外すること。

【使用可能な修正操作（op）】
- split: 統合された細粒度主体（対象IDに元の主体IDを指定）を独立レーンへ分割保持する
- merge: 細粒度主体（対象ID）を上位主体または別主体（内容列に統合先主体IDを指定）へ統合する
- group: 同一主体の時刻差・順序差がない複数イベント、または同一レーン内で直列に連なり他レーンとの関係がない近接微細アクション群（内容列にイベントIDをカンマ区切り）を共有カードにまとめる（対象IDは主体ID）。図の過度な縦長化を防ぎ、横方向・同一高さに集約する際に活用する
- suppress: 他レーンにも表示されている単独カードのイベントを非表示候補にする（対象IDはカードID）
- add_relation: 原文に明示された根拠があるレーン間関係を追加する（対象IDは - 、内容列に kind:sourceEventId:sourceEntityId:targetEventId:targetEntityId:resource:status:receipt を記す）
- modify_relation: 既存関係（対象IDに関係ID）の属性を修正する（内容列に kind:sourceEventId:sourceEntityId:targetEventId:targetEntityId:resource:status:receipt を記す）
- remove_relation: 根拠が不足する既存関係（対象IDに関係ID）を削除し要確認へ移す

※重要制約：
- イベントの削除は一切禁止です。
- 原文に書かれていない事実・主体・関係を推測で作らないでください。
- 修正が不要な場合は [修正] セクションをヘッダのみにしてください。
- 出力は以下のTSV形式のみとし、最後に必ず [完了] を出力してください。

[評価]
項目\t値\t理由
C2\t0.85\t各レーンの役割が一貫している
C4\t0.90\t受動機器の不要なレーン化はない
シナリオ\t4\t主要因果は網羅されているが、直前の確認不備が未接続
[修正]
ID\t操作\t対象ID\t内容\t原文参照\t理由
[完了]`;

export function parseRefinementReviewTSV(text: string): ParsedReviewResponse {
  const cleaned = text
    .replace(/^\uFEFF/, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
  const lines = cleaned.split(/\r?\n/);
  let section: '評価' | '修正' | undefined;
  let c2: number | undefined;
  let c4: number | undefined;
  let scenarioScore: number | undefined;
  let scenarioReason: string | undefined;
  const ops: RefinementOp[] = [];
  const invalidLines: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('```')) continue;
    if (line === '[完了]') break;
    if (line === '[評価]') {
      section = '評価';
      continue;
    }
    if (line === '[修正]') {
      section = '修正';
      continue;
    }
    if (line.startsWith('項目\t') || line.startsWith('ID\t')) continue;

    const cells = line.split('\t').map((c) => c.trim());
    if (section === '評価') {
      const [key, valStr, reason] = cells;
      const num = Number(valStr);
      if ((key === 'C2' || key === 'c2') && Number.isFinite(num) && num >= 0 && num <= 1) {
        c2 = num;
      } else if ((key === 'C4' || key === 'c4') && Number.isFinite(num) && num >= 0 && num <= 1) {
        c4 = num;
      } else if ((key === 'シナリオ' || key === 'scenario' || key === 'C3') && Number.isFinite(num)) {
        scenarioScore = num > 1 ? Math.max(0, Math.min(1, (num - 1) / 4)) : Math.max(0, Math.min(1, num));
        scenarioReason = reason || undefined;
      } else {
        invalidLines.push(line);
      }
    } else if (section === '修正') {
      if (cells.length < 6) {
        invalidLines.push(line);
        continue;
      }
      const validOps = ['split', 'merge', 'group', 'suppress', 'add_relation', 'modify_relation', 'remove_relation'];
      const [id, op, targetId] = cells;
      if (!id || !validOps.includes(op)) {
        invalidLines.push(line);
        continue;
      }
      let content: string;
      let refsStr: string;
      let reason: string;
      if ((op === 'add_relation' || op === 'modify_relation') && cells.length >= 13) {
        // Support canonical tab-expanded relation columns:
        // ID | op | targetId | kind | srcEv | srcEnt | tgtEv | tgtEnt | resource | status | receipt | refs | reason
        content = cells.slice(3, 11).join(':');
        refsStr = cells[11];
        reason = cells.slice(12).join(' ');
      } else {
        [, , , content, refsStr, reason] = cells;
      }
      const sourceRefs = refsStr === '-' || !refsStr ? [] : refsStr.split(',').map((s) => s.trim()).filter(Boolean);
      ops.push({
        id,
        op: op as RefinementOp['op'],
        targetId,
        content,
        sourceRefs,
        reason,
      });
    }
  }

  return { c2, c4, scenarioScore, scenarioReason, ops, invalidLines };
}

function buildReviewUserPrompt(
  schema: VTASchema,
  maxSubjects: number,
  oneTimeDirective?: string,
  assumptions?: VTAUserAssumption[],
  scope?: VTAAnalysisScope,
  ignoredEventIds?: Set<string>
): string {
  const analysis = schema.analysis!;
  const primarySource = analysis.sources[0];
  const entityLines = analysis.entities.map(
    (e) => `${e.id}\t${e.name}\t${e.kind}\t${e.focus ?? 'mid'}\t${e.parentEntityId ?? '-'}`
  );
  const rankLines = (analysis.subjectRanking?.ranks ?? []).map(
    (r) => `${r.entityId}\trank=${r.rank}\tscore=${r.score.toFixed(2)}\tretained=${r.retained}\tmergedInto=${r.mergedInto ?? '-'}`
  );
  const eventLines = analysis.events.map((e) => {
    const parts = analysis.participations
      .filter((p) => p.eventId === e.id)
      .map((p) => `${p.entityId}:${p.role}`)
      .join(',');
    const prelim = e.preliminary ? `${e.preliminary.value}(${e.preliminary.reason || '-'})` : e.classification;
    const refs = (e.sourceRefs ?? []).map((r) => r.paragraphId).join(',') || '-';
    return `${e.id}\t${e.time || '-'}\t${e.title}\t${parts || '-'}\t仮判定=${prelim}\t参照=${refs}`;
  });
  const relLines = analysis.relations.map(
    (r) =>
      `${r.id ?? '-'}\t${r.kind}\t${r.sourceEventId}\t${r.sourceEntityId ?? '-'}\t${r.targetEventId}\t${r.targetEntityId ?? '-'}\t${(r.sourceRefs ?? []).map((ref) => ref.paragraphId).join(',') || '-'}`
  );

  const sections = [
    `【設定上限】最大主体数=${maxSubjects}`,
    '[現在の採用主体]',
    'ID\t名称\t種類\t焦点\t上位主体',
    ...entityLines,
    '[主体ランキング・統合状態]',
    ...rankLines,
    '[イベントと仮判定]',
    'ID\t時刻\t見出し\t主体と役割\t仮判定\t原文参照',
    ...eventLines,
    '[関係]',
    'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照',
    ...relLines,
    '[原文]',
    primarySource ? sliceRelevantSourceParagraphs(primarySource, analysis) : '',
  ];

  const enabledAssumptions = (assumptions ?? []).filter((a) => a.enabled && a.text.trim());
  if (enabledAssumptions.length > 0) {
    sections.push(
      '【ユーザー設定の前提・仮定（仮説検証用）】',
      ...enabledAssumptions.map((a, idx) => `${idx + 1}. ${a.text.trim()}`),
      '※上記はユーザーにより仮説検証用に追加された条件・仮定です。事実と混同せず、この仮定が成り立つ場合に生じる影響や関係性を考慮してください。'
    );
  }

  const scopeNotes: string[] = [];
  if (scope?.pinnedEntityIds && scope.pinnedEntityIds.length > 0) {
    scopeNotes.push(`・固定主体（マージ禁止）: ${scope.pinnedEntityIds.join(', ')} は統合せず独立レーンを維持すること`);
  }
  if (scope?.excludedEntityIds && scope.excludedEntityIds.length > 0) {
    scopeNotes.push(`・除外主体: ${scope.excludedEntityIds.join(', ')} は分析対象外とすること`);
  }
  if (scope?.timeRange?.enabled && (scope.timeRange.start || scope.timeRange.end)) {
    scopeNotes.push(`・対象時間帯: ${scope.timeRange.start || '開始'} 〜 ${scope.timeRange.end || '終了'}`);
  }
  if (scopeNotes.length > 0) {
    sections.push(
      '【分析スコープ・制約条件】',
      ...scopeNotes,
      '※上記のスコープおよび制約条件を厳守してツリーを構成してください。'
    );
  }

  if (oneTimeDirective && oneTimeDirective.trim()) {
    sections.push(
      '【ユーザーからの特別着眼指示（局所最適脱出・重点適用）】',
      oneTimeDirective.trim(),
      '※上記のユーザー指示を強く意識して、局所最適を脱出し、必要な構造修正操作（op）を検討してください。'
    );
  }

  const scenarioResult = extractCausalScenario(schema);
  const filteredOmittedNodes = scenarioResult.omittedNodes.filter(
    (n) => !n.event_ids?.every((id) => ignoredEventIds?.has(id))
  );
  const omittedLines = filteredOmittedNodes.map(
    (n) => `・[${n.time || '時刻未指定'} / ${n.lane}] ${n.title} (ID: ${n.id}) - イベント: ${(n.event_ids ?? []).join(',')}`
  );

  sections.push(
    '【現在の因果シナリオ（帰結から逆走抽出された主要プロセス）】',
    scenarioResult.scenarioText || '（因果シナリオが形成されていません）',
    '【シナリオに含まれていないイベント一覧】',
    omittedLines.length ? omittedLines.join('\n') : '（未包含のイベントはありません）'
  );

  return sections.join('\n');
}

function parseRelationSpec(
  id: string,
  spec: string,
  refs: string[],
  reason: string,
  sourceId: string
): VTAEventRelation | null {
  const delimiter = spec.includes(':') ? ':' : spec.includes('|') ? '|' : '/';
  const parts = spec.split(delimiter).map((s) => s.trim());
  if (parts.length < 5) return null;
  const [kind, sourceEventId, sourceEntityId, targetEventId, targetEntityId, resource = '-', status = '-', receipt = 'na'] = parts;
  const validKinds = ['before', 'transfer', 'impact', 'mutual', 'common', 'dependency'];
  if (!validKinds.includes(kind)) return null;
  if (!refs.length) return null;
  const sourceRefs: VTASourceRef[] = refs.map((p) => ({
    sourceId,
    paragraphId: p.includes('/') ? p.split('/')[1] : p,
  }));
  const attrs = relationAttributes(kind as VTAEventRelation['kind'], resource, status, receipt);
  return {
    id,
    kind: kind as VTAEventRelation['kind'],
    sourceEventId,
    sourceEntityId: sourceEntityId === '-' ? undefined : sourceEntityId,
    targetEventId,
    targetEntityId: targetEntityId === '-' ? undefined : targetEntityId,
    factIds: [],
    sourceRefs,
    evidenceBasis: 'recorded',
    explanation: reason,
    ...attrs,
  };
}

export function applyRefinementOps(
  currentSchema: VTASchema,
  ops: RefinementOp[],
  maxSubjects: number,
  forceRetained: Set<string>,
  logTrace: RefinementLog
): { schema: VTASchema; appliedOps: string[] } {
  const analysis = currentSchema.analysis;
  if (!analysis || !ops.length) return { schema: currentSchema, appliedOps: [] };

  let working = structuredClone(analysis);
  const appliedOps: string[] = [];
  const primarySource = working.sources[0];
  const validParagraphIds = new Set(primarySource?.paragraphs.map((p) => p.id) ?? []);

  const hasValidRefs = (refs: string[]): boolean => {
    if (!refs.length) return false;
    return refs.every((r) => {
      const pid = r.includes('/') ? r.split('/')[1] : r;
      return validParagraphIds.has(pid);
    });
  };

  // 1. Handle split / merge on subject granularity
  let needsReconsolidate = false;
  const revertedBase = working.subjectRanking ? revertConsolidation(working) : structuredClone(working);

  for (const op of ops) {
    if (op.op === 'split') {
      const existsInOrig = revertedBase.entities.some((e) => e.id === op.targetId);
      if (existsInOrig && hasValidRefs(op.sourceRefs)) {
        forceRetained.add(op.targetId);
        needsReconsolidate = true;
        appliedOps.push(`split:${op.targetId}`);
      }
    } else if (op.op === 'merge') {
      const targetEntity = revertedBase.entities.find((e) => e.id === op.targetId);
      const intoEntity = revertedBase.entities.find((e) => e.id === op.content);
      if (targetEntity && intoEntity && targetEntity.id !== intoEntity.id && hasValidRefs(op.sourceRefs)) {
        targetEntity.parentEntityId = intoEntity.id;
        const currentParents = targetEntity.parentEntityIds ?? (targetEntity.parentEntityId ? [targetEntity.parentEntityId] : []);
        targetEntity.parentEntityIds = Array.from(new Set([...currentParents, intoEntity.id]));
        revertedBase.subjectPoset = SubjectPoset.fromEntities(revertedBase.entities).toJSON();
        forceRetained.delete(targetEntity.id);
        needsReconsolidate = true;
        appliedOps.push(`merge:${op.targetId}->${op.content}`);
      }
    }
  }

  if (needsReconsolidate) {
    working = consolidateSubjects(
      revertedBase,
      maxSubjects,
      undefined,
      (msg) => logTrace('warn', `[粒度反復/統合] ${msg}`, '解析'),
      { forceRetain: forceRetained }
    );
  }

  // 2. Handle relation operations (add_relation, modify_relation, remove_relation)
  const poset = working.subjectPoset ? SubjectPoset.fromData(working.subjectPoset) : SubjectPoset.fromEntities(working.entities);
  const participates = (eventId: string, entityId?: string) => {
    if (!entityId) return false;
    return working.participations.some((p) =>
      p.eventId === eventId && (
        p.entityId === entityId ||
        p.mergedFrom?.some((m) => m.entityId === entityId) ||
        poset.isAncestor(p.entityId, entityId) ||
        poset.isDescendant(p.entityId, entityId)
      )
    );
  };

  for (const op of ops) {
    if (op.op === 'add_relation') {
      if (!hasValidRefs(op.sourceRefs) || !primarySource) continue;
      try {
        const relId = `rel_ref_${op.id}`;
        const candidate = parseRelationSpec(relId, op.content, op.sourceRefs, op.reason, primarySource.id);
        if (!candidate) continue;
        validateRelationEndpoints(candidate);
        if (candidate.kind === 'before') {
          if (candidate.sourceEntityId && !participates(candidate.sourceEventId, candidate.sourceEntityId)) {
            delete candidate.sourceEntityId;
          }
          if (candidate.targetEntityId && !participates(candidate.targetEventId, candidate.targetEntityId)) {
            delete candidate.targetEntityId;
          }
        } else if (
          !participates(candidate.sourceEventId, candidate.sourceEntityId) ||
          !participates(candidate.targetEventId, candidate.targetEntityId)
        ) {
          continue;
        }
        if (candidate.kind === 'dependency' && dependencyProblem(working, candidate, working.relations)) {
          continue;
        }
        working.relations.push(candidate);
        appliedOps.push(`add_relation:${relId}`);
      } catch {}
    } else if (op.op === 'modify_relation') {
      if (!hasValidRefs(op.sourceRefs) || !primarySource) continue;
      const idx = working.relations.findIndex((r) => r.id === op.targetId);
      if (idx === -1) continue;
      try {
        const candidate = parseRelationSpec(op.targetId, op.content, op.sourceRefs, op.reason, primarySource.id);
        if (!candidate) continue;
        validateRelationEndpoints(candidate);
        if (candidate.kind === 'before') {
          if (candidate.sourceEntityId && !participates(candidate.sourceEventId, candidate.sourceEntityId)) {
            delete candidate.sourceEntityId;
          }
          if (candidate.targetEntityId && !participates(candidate.targetEventId, candidate.targetEntityId)) {
            delete candidate.targetEntityId;
          }
        } else if (
          !participates(candidate.sourceEventId, candidate.sourceEntityId) ||
          !participates(candidate.targetEventId, candidate.targetEntityId)
        ) {
          continue;
        }
        const others = working.relations.filter((_, i) => i !== idx);
        if (candidate.kind === 'dependency' && dependencyProblem(working, candidate, others)) {
          continue;
        }
        working.relations[idx] = candidate;
        appliedOps.push(`modify_relation:${op.targetId}`);
      } catch {}
    } else if (op.op === 'remove_relation') {
      const existing = working.relations.find((r) => r.id === op.targetId);
      if (!existing) continue;
      working.relations = working.relations.filter((r) => r.id !== op.targetId);
      if (primarySource && existing.sourceRefs?.length) {
        const summaryText = `${existing.sourceEventId} -> ${existing.targetEventId} (${existing.kind})`;
        working.dispositions = [
          ...(working.dispositions ?? []),
          {
            id: `disp_ref_${op.id}`,
            kind: 'review',
            sourceId: existing.sourceRefs[0].sourceId,
            paragraphId: existing.sourceRefs[0].paragraphId,
            sourceRefs: existing.sourceRefs,
            quote: summaryText,
            text: summaryText,
            reason: op.reason || '粒度反復レビューにより要確認へ移行',
          },
        ];
      }
      appliedOps.push(`remove_relation:${op.targetId}`);
    }
  }

  // 3. Handle group operation
  for (const op of ops) {
    if (op.op === 'group') {
      const entityId = op.targetId;
      const eventIds = op.content.split(',').map((s) => s.trim()).filter(Boolean);
      if (eventIds.length < 2) continue;
      try {
        const candidateGroups = [
          ...working.cards
            .filter((c) => c.eventIds.length > 1)
            .map((c) => ({ entityId: c.laneEntityId, eventIds: c.eventIds })),
          { entityId, eventIds },
        ];
        const parsed = validateParticipants(
          {
            entities: working.entities,
            participations: working.participations,
            relations: working.relations,
            cardGroups: candidateGroups,
          },
          working.events,
          working.facts,
          true,
          undefined,
          working.sources
        );
        if (primarySource) {
          const built = buildAnalysis(primarySource, working.facts, working.events, parsed);
          working = { ...working, cards: built.cards, unassignedEventIds: built.unassignedEventIds };
          appliedOps.push(`group:${entityId}(${eventIds.join(',')})`);
        }
      } catch {}
    }
  }

  let nextSchema = projectAnalysis(working, currentSchema);

  // 4. Handle suppress operation
  for (const op of ops) {
    if (op.op === 'suppress') {
      const card = working.cards.find((c) => c.id === op.targetId);
      if (!card) continue;
      const canSuppress = card.eventIds.every((evId) =>
        working.cards.some((other) => other.id !== card.id && other.eventIds.includes(evId))
      );
      if (canSuppress && nextSchema.presentation) {
        nextSchema = {
          ...nextSchema,
          presentation: {
            ...nextSchema.presentation,
            suppressedCards: {
              ...nextSchema.presentation.suppressedCards,
              [card.id]: op.reason || '他レーンにも表示されているため非表示',
            },
          },
        };
        appliedOps.push(`suppress:${card.id}`);
      }
    }
  }

  return { schema: nextSchema, appliedOps };
}

export async function refineGranularity(
  config: LLMConfig,
  rawAnalysis: VTAAnalysisData,
  maxSubjects: number,
  signal: AbortSignal | undefined,
  callChat: RefinementChatCaller,
  logTrace: RefinementLog,
  maxIterations: number = 2,
  targetScore: number = 0.82,
  epsilon: number = 0.02,
  weights?: GranularityWeights,
  oneTimeDirective?: string,
  assumptions?: VTAUserAssumption[],
  scope?: VTAAnalysisScope,
  currentSchema?: VTASchema
): Promise<VTASchema> {
  const forceRetained = new Set<string>();
  for (const entity of rawAnalysis.entities) {
    if (entity.id.startsWith('manual_entity_')) {
      forceRetained.add(entity.id);
    }
  }
  if (scope?.pinnedEntityIds) {
    for (const pinnedId of scope.pinnedEntityIds) {
      forceRetained.add(pinnedId);
    }
  }
  const initialConsolidated = consolidateSubjects(
    rawAnalysis,
    maxSubjects,
    undefined,
    (msg) => logTrace('warn', `[主体統合] ${msg}`, '解析'),
    { forceRetain: forceRetained }
  );
  let bestSchema = projectAnalysis(initialConsolidated, currentSchema);
  const m0 = computeMachineMetrics(bestSchema, maxSubjects);
  let bestScore = totalScore(m0, weights);

  const iterations: VTARefinementIteration[] = [
    {
      index: 0,
      score: bestScore,
      metrics: { c1: m0.c1, c3: m0.c3, c5: m0.c5 },
      gateViolations: m0.gateViolations,
      operations: ['initial_consolidation'],
      adopted: true,
    },
  ];

  logTrace(
    'info',
    `[粒度反復 #0] 初期スコア S=${bestScore.toFixed(3)} (C1=${m0.c1.toFixed(2)}, C3=${m0.c3.toFixed(2)}, C5=${m0.c5.toFixed(2)})`,
    '解析'
  );

  const ignoredEventIds = new Set<string>();

  for (let t = 1; t <= maxIterations; t++) {
    if (signal?.aborted) throw new Error('USER_CANCELLED');

    const userPrompt = buildReviewUserPrompt(
      bestSchema,
      maxSubjects,
      t === 1 ? oneTimeDirective : undefined,
      assumptions,
      scope,
      ignoredEventIds
    );
    let replyContent = '';
    try {
      const res = await callChat(
        config,
        [
          { role: 'system', content: GRANULARITY_REVIEW_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        0.1,
        signal
      );
      replyContent = res.content;
    } catch (err) {
      if (signal?.aborted) throw err;
      logTrace('warn', `[粒度反復 #${t}] レビュー通信に失敗したため、最良スナップショットを保持して終了します。`, '解析');
      break;
    }

    const parsed = parseRefinementReviewTSV(replyContent);

    // Update iteration 0 or current with LLM C2/C4/Scenario if no ops were proposed
    if (parsed.ops.length === 0) {
      const mCurrent = computeMachineMetrics(bestSchema, maxSubjects);
      if (parsed.scenarioScore !== undefined) {
        mCurrent.c3 = Math.round((0.4 * mCurrent.c3 + 0.6 * parsed.scenarioScore) * 10000) / 10000;
      }
      const updatedScore = totalScore({
        c1: mCurrent.c1,
        c2: parsed.c2,
        c3: mCurrent.c3,
        c4: parsed.c4,
        c5: mCurrent.c5,
      }, weights);
      iterations.push({
        index: t,
        score: updatedScore,
        metrics: { c1: mCurrent.c1, c2: parsed.c2, c3: mCurrent.c3, c4: parsed.c4, c5: mCurrent.c5 },
        gateViolations: mCurrent.gateViolations,
        operations: ['no_ops'],
        adopted: true,
      });
      bestScore = Math.max(bestScore, updatedScore);
      logTrace('info', `[粒度反復 #${t}] 修正提案なし（S=${updatedScore.toFixed(3)}${parsed.scenarioScore !== undefined ? `、シナリオ=${parsed.scenarioScore.toFixed(2)}` : ''}）。反復を終了します。`, '解析');
      break;
    }

    // キャッシュ更新: remove_relation の対象イベントを無関係候補として追跡
    for (const op of parsed.ops) {
      if (op.op === 'remove_relation') {
        const rel = bestSchema.analysis?.relations.find((r) => r.id === op.targetId);
        if (rel) {
          ignoredEventIds.add(rel.sourceEventId);
          ignoredEventIds.add(rel.targetEventId);
        }
      }
    }

    const { schema: candidateSchema, appliedOps } = applyRefinementOps(
      bestSchema,
      parsed.ops,
      maxSubjects,
      forceRetained,
      logTrace
    );

    const mNext = computeMachineMetrics(candidateSchema, maxSubjects);
    if (parsed.scenarioScore !== undefined) {
      mNext.c3 = Math.round((0.4 * mNext.c3 + 0.6 * parsed.scenarioScore) * 10000) / 10000;
    }
    const nextScore = totalScore({
      c1: mNext.c1,
      c2: parsed.c2,
      c3: mNext.c3,
      c4: parsed.c4,
      c5: mNext.c5,
    }, weights);

    // Gate check G3: event set must match rawAnalysis
    const origEventIds = new Set(rawAnalysis.events.map((e) => e.id));
    const candEventIds = new Set(candidateSchema.analysis?.events.map((e) => e.id) ?? []);
    if (origEventIds.size !== candEventIds.size || [...origEventIds].some((id) => !candEventIds.has(id))) {
      mNext.gateViolations.push('G3: イベント集合が変化しました');
    }

    const gatesPassed = mNext.gateViolations.length === 0;
    const improved = appliedOps.length > 0 && gatesPassed && nextScore >= bestScore;

    iterations.push({
      index: t,
      score: nextScore,
      metrics: { c1: mNext.c1, c2: parsed.c2, c3: mNext.c3, c4: parsed.c4, c5: mNext.c5 },
      gateViolations: mNext.gateViolations,
      operations: appliedOps.length ? appliedOps : ['none_applicable'],
      adopted: improved,
    });

    logTrace(
      improved ? 'info' : 'warn',
      `[粒度反復 #${t}] スコア S=${nextScore.toFixed(3)} (前回最良=${bestScore.toFixed(3)}) 適用操作=${appliedOps.length}件 採用=${improved ? 'はい' : 'いいえ'}`,
      '解析'
    );

    const prevBestScore = bestScore;
    if (improved) {
      bestSchema = candidateSchema;
      bestScore = nextScore;
    }

    if (!improved || (bestScore >= targetScore && bestScore - prevBestScore < epsilon)) {
      break;
    }
  }

  if (bestSchema.analysis) {
    const existingAudit = bestSchema.analysis.normalizationAudit ?? {
      version: 1 as const,
      corrections: [],
      subjectiveNotices: [],
    };
    bestSchema = {
      ...bestSchema,
      analysis: {
        ...bestSchema.analysis,
        normalizationAudit: {
          ...existingAudit,
          iterations,
        },
      },
    };
  }

  return bestSchema;
}
