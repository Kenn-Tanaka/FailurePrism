import type {
  GranularityWeights,
  LLMConfig,
  OthersConsolidationMode,
  VTAAnalysisData,
  VTAAnalysisScope,
  VTAEventRelation,
  VTARefinementIteration,
  VTASchema,
  VTASource,
  VTASourceRef,
  VTAUserAssumption,
} from '../../types/vta';
import {
  consolidatePeripheralSubjectsToOthers,
  consolidateSubjects,
  derivePreConsolidationLimit,
  evaluateMergeGuard,
  revertConsolidation,
} from '../../features/vta/utils/subjectRanking';
import { isResilientReasonText } from '../../features/vta/utils/variationFactor';
import { debugRecorder } from '../debugRecorder';
import {
  projectAnalysis,
  recordGraphProjectionDebug,
  validateParticipants,
  buildAnalysis,
} from '../../features/vta/utils/eventAnalysis';
import { visibleSchema } from '../../features/vta/utils/presentation';
import { repairGeneratedLaneSequence } from '../../features/vta/utils/generatedLaneSequence';
import { annotateNodeTopologyRules } from '../../features/vta/utils/nodeTopologyRules';
import { dependencyProblem, isPrecedence } from '../../features/vta/utils/eventOrder';
import { compareEventTimeById, ensureEventTimeDAG } from '../../features/vta/utils/eventTimePoset';
import { relationAttributes, validateRelationEndpoints, RELATION_CONTRACT_PROMPT } from '../../features/vta/utils/relationContract';
import { FACTUALITY_POLICY } from '../llm/factualityPolicy';
import {
  collectPostOutcomeExcludedNodeIds,
  computeComplexityBudgets,
  computeMachineMetrics,
  extractCausalScenario,
  totalScore,
} from './granularityScore';
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

export interface GranularityRefinementOptions {
  excludePostOutcome?: boolean;
  /** ADR-0072: 統合前の最大主体数 K_pre（未指定時は min(12, max(maxSubjects, maxSubjects + 3))） */
  preMaxSubjects?: number;
  /** ADR-0072: Stage 3 を伴わない単体再最適化（reoptimizeVTA）終了時に周辺主体集約を実行するか */
  applyFinalOthersConsolidation?: boolean;
  /** ADR-0072: 最終フェーズの subject_others 集約方式 */
  othersConsolidationMode?: OthersConsolidationMode;
}

export const GRANULARITY_REVIEW_SYSTEM_PROMPT = `あなたはVTA（バリエーションツリー分析）の主体粒度・接続構造・認知負荷を点検する専門レビュアです。
${FACTUALITY_POLICY}
${RELATION_CONTRACT_PROMPT}

提示された現在のVTA台帳（主体・イベント・仮判定・関係・共有カード）および【現在の因果シナリオ】と原文を照合し、以下の3つの観点スコアと、必要な構造修正指示をTSV形式で出力してください。
- C2（役割の一貫性）: 同一主体レーンに責任範囲や現場の異なる主体の作業が混在していないか（0.00〜1.00）。
  ※ADR-0008原則: 同一組織内であっても、「被災・異常発生側」と「救助・検知・水際阻止側」のように役割や帰結が非対称な主体（例: 風防脱落時の機長と副操縦士、品質トラブルの製造と品証、サイバー攻撃のIT運用とCSIRT）が同一レーンに不当に統合されている場合は減点し、split 操作で独立レーン化を指示すること。逆に同一の帰結（墜落・全社被害等）を共有している場合は統合（merge）を許容する。
- C4（システム境界の妥当性）: 自律動作のない受動的な客体・部品が不要に独立レーン化されていないか（0.00〜1.00）
- シナリオ（因果プロセスの網羅性）: 帰結から逆走抽出された主要シナリオが、事故・インシデントの発生プロセスを全体として適切に捉えているか（1〜5の整数、または0.00〜1.00）。なお同一主体レーン内の前後推移は直列矢印で自動接続されるため、主にレーン間の因果・伝達接続の欠落有無を評価し、漏れている重要なレーン間接続があれば add_relation で補い、無関係な事象が混入していれば remove_relation で除外すること。

【使用可能な修正操作（op）】
- split: 統合された細粒度主体（対象IDに元の主体IDを指定）を独立レーンへ分割保持する
- merge: 細粒度主体（対象ID）をPoset上の上位組織・親主体（内容列に統合先の上位主体IDを指定）へ統合する（※上位組織を下位の個人へ逆統合すること、および loss 帰結の直接被影響個人（:affected）や異常発生側・回復抑止側の厳格非対称ペアを統合することは不可）
- group: 同一主体の同時刻かつ前後関係（before）のない複数イベント（内容列にイベントIDをカンマ区切り）を共有カードにまとめる（対象IDは主体ID）。異なる時刻や前後関係が明示されたイベントは統合不可
- add_relation: 原文に明示された根拠があるレーン間関係を追加する（対象IDは - 、内容列に kind:sourceEventId:sourceEntityId:targetEventId:targetEntityId:resource:status:receipt を記す。順序のみの before は図上の接続線・シナリオ補完として描画されないため指定せず、根拠に応じた transfer / impact / mutual / dependency を指定すること。また、既に意味関係エッジが存在するカードペア間への別関係の重複追加は不採用となるため提案しないこと）
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
  ignoredEventIds?: Set<string>,
  excludePostOutcome?: boolean,
  preMaxSubjects?: number
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
    const prelimLabel = e.preliminary
      ? e.preliminary.polarity === 'resilient'
        ? 'variation:resilient'
        : e.preliminary.scope === 'post_outcome'
          ? 'post_outcome'
          : e.preliminary.value
      : undefined;
    const prelim = e.preliminary ? `${prelimLabel}(${e.preliminary.reason || '-'})` : e.classification;
    const refs = (e.sourceRefs ?? []).map((r) => r.paragraphId).join(',') || '-';
    return `${e.id}\t${e.time || '-'}\t${e.title}\t${parts || '-'}\t仮判定=${prelim}\t参照=${refs}`;
  });
  const relLines = analysis.relations.map(
    (r) =>
      `${r.id ?? '-'}\t${r.kind}\t${r.sourceEventId}\t${r.sourceEntityId ?? '-'}\t${r.targetEventId}\t${r.targetEntityId ?? '-'}\t${(r.sourceRefs ?? []).map((ref) => ref.paragraphId).join(',') || '-'}`
  );

  const stageMaxSubjects =
    typeof preMaxSubjects === 'number' && preMaxSubjects > maxSubjects
      ? preMaxSubjects
      : maxSubjects;
  const currentMetrics = computeMachineMetrics(schema, stageMaxSubjects, {
    cardBudgetMaxSubjects: maxSubjects,
  });
  const activeEventCount = analysis.events.filter((e) => !e.ignored).length;
  const { targetMaxCards } = computeComplexityBudgets(activeEventCount, maxSubjects);
  const bottleneckHints: string[] = [];
  if (currentMetrics.details.laneCount > stageMaxSubjects) {
    bottleneckHints.push(
      `・現在レーン数(${currentMetrics.details.laneCount})が中間保持上限(${stageMaxSubjects})を超過しています（C1=${currentMetrics.c1.toFixed(2)}）。厳密な役割非対称や独立組織の維持に不要な同族細粒度主体がある場合は merge で親組織等への統合を検討してください（※無関係な独立周辺主体を別組織へ無理に merge する必要はありません。非変動接続の周辺主体は最終フェーズで「その他の関係者」へ自動集約されます）。`
    );
  } else if (currentMetrics.details.laneCount > maxSubjects) {
    bottleneckHints.push(
      `・現在レーン数(${currentMetrics.details.laneCount})は中間Poset保持上限(${stageMaxSubjects})以内です（最終目標主体数=${maxSubjects}、C1=${currentMetrics.c1.toFixed(2)}）。最終フェーズで下位葉主体および非変動接続の周辺主体は自動集約されるため、上位組織を下位個人へ逆転統合するような無理な merge は行わず、同一帰結・同一役割の冗長な細粒度主体がある場合のみ上位親組織への merge を検討してください。`
    );
  }
  const aggEntitiesWithMultiple = analysis.entities.filter((e) => e.aggregate && (e.mergedFrom?.length ?? 0) >= 2);
  if (aggEntitiesWithMultiple.length > 0) {
    const mergedList = aggEntitiesWithMultiple.flatMap((e) => e.mergedFrom ?? []).join(', ');
    bottleneckHints.push(
      `・現在「その他の関係者」レーンに複数主体(${mergedList})が集約されており、レーン内の時系列線が省略されています。同一組織内で帰結を共有する細粒度主体が複数レーンを占めている場合は merge で上位組織へ統合し、主要な独立組織の実名レーン化を検討してください。`
    );
  }
  if (currentMetrics.details.nodeCount > targetMaxCards) {
    bottleneckHints.push(
      `・可視カード数(${currentMetrics.details.nodeCount}枚)が目安上限(${targetMaxCards}枚)を超過し過密です（C5=${currentMetrics.c5.toFixed(2)}）。同一レーン内で時刻差や前後関係のない近接イベントは group で共有カード化し、同一帰結・同一組織に属する細粒度主体が残っている場合は merge による集約も検討してください（※1枚カードしか持たない周辺主体は最終フェーズで自動集約されるため非表示化は不要です）。`
    );
  }

  const preLimitSuffix =
    typeof preMaxSubjects === 'number' && preMaxSubjects > maxSubjects
      ? `（中間Poset保持上限=${preMaxSubjects}）`
      : '';
  const sections = [
    `【設定上限】最大主体数=${maxSubjects}${preLimitSuffix}`,
    `【現在の構造スコア】レーン数=${currentMetrics.details.laneCount}, 可視カード数=${currentMetrics.details.nodeCount}, C1=${currentMetrics.c1.toFixed(2)}, C3=${currentMetrics.c3.toFixed(2)}, C5=${currentMetrics.c5.toFixed(2)}`,
    ...(bottleneckHints.length > 0 ? ['【現在の構造ボトルネックと優先改善指針】', ...bottleneckHints] : []),
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
  const postOutcomeExcludedIds = excludePostOutcome ? collectPostOutcomeExcludedNodeIds(schema) : new Set<string>();
  const filteredOmittedNodes = scenarioResult.omittedNodes.filter(
    (n) => !postOutcomeExcludedIds.has(n.id) && !n.event_ids?.every((id) => ignoredEventIds?.has(id))
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
  logTrace: RefinementLog,
  explicitMerges: Map<string, string> = new Map<string, string>(),
  preMaxSubjects?: number
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
        explicitMerges.delete(op.targetId);
        needsReconsolidate = true;
        appliedOps.push(`split:${op.targetId}`);
      }
    } else if (op.op === 'merge') {
      const targetEntity = revertedBase.entities.find((e) => e.id === op.targetId);
      const intoEntity = revertedBase.entities.find((e) => e.id === op.content);
      if (targetEntity && intoEntity && targetEntity.id !== intoEntity.id && hasValidRefs(op.sourceRefs)) {
        // Check if intoEntity already transitively merges into targetEntity to avoid contradictory cycles
        let createsExplicitCycle = false;
        let cur: string | undefined = intoEntity.id;
        const visited = new Set<string>();
        while (cur && explicitMerges.has(cur) && !visited.has(cur)) {
          visited.add(cur);
          cur = explicitMerges.get(cur);
          if (cur === targetEntity.id) {
            createsExplicitCycle = true;
            break;
          }
        }
        if (createsExplicitCycle) continue;

        const currentPoset = revertedBase.subjectPoset
          ? SubjectPoset.fromData(revertedBase.subjectPoset)
          : SubjectPoset.fromEntities(revertedBase.entities);
        // RM-VTA-01: 上位組織・主体を下位の個人・機器主体へ統合する逆方向 merge は Poset 正準包含原則に反するため棄却する
        // （ADR-0064 の上位事務組織 -> 下位現場組織ハブ `organization -> organization` は非循環のまま許容）
        if (
          currentPoset.isAncestor(targetEntity.id, intoEntity.id) &&
          (intoEntity.kind !== 'organization' || targetEntity.kind === 'person')
        ) {
          logTrace(
            'warn',
            `[粒度反復/統合スキップ] 上位主体 ${targetEntity.id} を下位主体 ${intoEntity.id} へ逆転統合する操作を棄却しました（Poset逆方向統合不可）。`,
            '解析'
          );
          continue;
        }

        // ADR-0077: Stage 2 の明示 merge でもソルバーと同一の厳格非対称ガード・死傷被災者保護・レジリエンス主体保護を強制する
        const targetClusterIds = [
          intoEntity.id,
          ...Array.from(explicitMerges.entries())
            .filter(([, tgt]) => tgt === intoEntity.id)
            .map(([src]) => src),
        ];
        const strictBlock = targetClusterIds
          .map((cid) => evaluateMergeGuard(targetEntity.id, cid, revertedBase))
          .find((g) => !g.allowed && g.strictAsymmetry);
        if (strictBlock) {
          logTrace(
            'warn',
            `[粒度反復/統合スキップ] ${targetEntity.id} -> ${intoEntity.id} は厳格非対称ガード（${strictBlock.reason}）に抵触するため棄却しました。`,
            '解析'
          );
          continue;
        }

        if (targetEntity.kind === 'person' && intoEntity.kind === 'organization') {
          const revEventById = new Map(revertedBase.events.map((e) => [e.id, e]));
          const revOutcomeIds = new Set(
            revertedBase.outcome?.status === 'identified' ? revertedBase.outcome.eventIds : []
          );
          const isLossOutcomeEvent = (evId: string): boolean => {
            if (!revOutcomeIds.has(evId)) return false;
            const ev = revEventById.get(evId);
            return (
              ev?.outcome_kind === 'loss' ||
              (!ev?.outcome_kind &&
                revertedBase.outcome?.kind !== 'recovery' &&
                revertedBase.outcome?.kind !== 'near_miss')
            );
          };
          const isLossAffectedPerson = revertedBase.participations.some(
            (p) =>
              p.entityId === targetEntity.id &&
              p.role === 'affected' &&
              isLossOutcomeEvent(p.eventId)
          );
          const hasResilientAction = revertedBase.participations.some((p) => {
            if (p.entityId !== targetEntity.id) return false;
            const ev = revEventById.get(p.eventId);
            if (!ev) return false;
            if (ev.preliminary?.polarity === 'resilient' || ev.variationFactor?.polarity === 'resilient') {
              return true;
            }
            const reasonText = ev.classificationReason || ev.preliminary?.reason || '';
            return (
              (ev.classification === 'variation' || ev.preliminary?.value === 'variation') &&
              isResilientReasonText(reasonText)
            );
          });
          const orgHasLossOutcome = revertedBase.participations.some(
            (p) => p.entityId === intoEntity.id && isLossOutcomeEvent(p.eventId)
          );
          if (isLossAffectedPerson || (hasResilientAction && orgHasLossOutcome)) {
            logTrace(
              'warn',
              `[粒度反復/統合スキップ] ${targetEntity.id} -> ${intoEntity.id} は損失被災当事者またはレジリエンス対応主体の法人統合禁止により棄却しました。`,
              '解析'
            );
            continue;
          }
        }
        // 上位親組織を下位組織ハブへ統合する場合は本来の包含向きを逆転・循環させない
        if (!currentPoset.isAncestor(targetEntity.id, intoEntity.id)) {
          const prevParents = targetEntity.parentEntityIds?.length
            ? targetEntity.parentEntityIds
            : targetEntity.parentEntityId
              ? [targetEntity.parentEntityId]
              : [];
          // ADR-0072: intoEntity の上位祖先が prevParents に既にある場合は推移冗長辺を除去し Hasse 極小に保つ
          const prunedPrevParents = prevParents.filter(
            (pid) => pid !== intoEntity.id && !currentPoset.isAncestor(pid, intoEntity.id)
          );
          targetEntity.parentEntityId = intoEntity.id;
          targetEntity.parentEntityIds = Array.from(new Set([intoEntity.id, ...prunedPrevParents]));
          revertedBase.subjectPoset = SubjectPoset.fromEntities(revertedBase.entities).toJSON();
        }
        forceRetained.delete(targetEntity.id);
        explicitMerges.set(targetEntity.id, intoEntity.id);
        needsReconsolidate = true;
        appliedOps.push(`merge:${op.targetId}->${op.content}`);
      }
    }
  }

  if (needsReconsolidate) {
    const effectivePreLimit =
      typeof preMaxSubjects === 'number' && Number.isFinite(preMaxSubjects)
        ? Math.max(maxSubjects, preMaxSubjects)
        : maxSubjects;
    working = consolidateSubjects(
      revertedBase,
      effectivePreLimit,
      undefined,
      (msg) => logTrace('warn', `[粒度反復/統合] ${msg}`, '解析'),
      {
        forceRetain: forceRetained,
        allowSubjectOthers: false,
        preConsolidationMaxSubjects: effectivePreLimit,
        ...(explicitMerges.size > 0 ? { explicitMerges } : {}),
      }
    );
  }

  // 2. Handle relation operations (add_relation, modify_relation, remove_relation)
  const poset = working.subjectPoset ? SubjectPoset.fromData(working.subjectPoset) : SubjectPoset.fromEntities(working.entities);
  const validEventIds = new Set(working.events.map((e) => e.id));

  // 指定された主体IDを現在の統合済み関与（working.participations）に解決し、必要に応じて細粒度Originを記録する
  const resolveEndpoint = (eventId: string, rawEntityId?: string): { entityId: string; originId?: string } | null => {
    if (!rawEntityId) return null;
    const direct = working.participations.find((p) => p.eventId === eventId && p.entityId === rawEntityId);
    if (direct) {
      const originId = direct.mergedFrom?.length === 1 ? direct.mergedFrom[0].entityId : undefined;
      return { entityId: direct.entityId, ...(originId && originId !== direct.entityId ? { originId } : {}) };
    }
    const viaMerged = working.participations.find(
      (p) => p.eventId === eventId && p.mergedFrom?.some((m) => m.entityId === rawEntityId)
    );
    if (viaMerged) {
      return { entityId: viaMerged.entityId, originId: rawEntityId };
    }
    const viaPoset = working.participations.find(
      (p) =>
        p.eventId === eventId &&
        (poset.isAncestor(p.entityId, rawEntityId) || poset.isDescendant(p.entityId, rawEntityId))
    );
    if (viaPoset) {
      return {
        entityId: viaPoset.entityId,
        ...(rawEntityId !== viaPoset.entityId ? { originId: rawEntityId } : {}),
      };
    }
    return null;
  };

  const createsBeforeCycle = (fromEventId: string, toEventId: string, relations: VTAEventRelation[]): boolean => {
    if (fromEventId === toEventId) return true;
    const stack = [toEventId];
    const visited = new Set<string>();
    while (stack.length > 0) {
      const curr = stack.pop()!;
      if (curr === fromEventId) return true;
      if (visited.has(curr)) continue;
      visited.add(curr);
      for (const r of relations) {
        if (r.kind === 'before' && r.sourceEventId === curr) {
          stack.push(r.targetEventId);
        }
      }
    }
    return false;
  };

  const normalizeCandidateRelation = (
    candidate: VTAEventRelation,
    existingRelations: VTAEventRelation[]
  ): VTAEventRelation | null => {
    if (!validEventIds.has(candidate.sourceEventId) || !validEventIds.has(candidate.targetEventId)) {
      return null;
    }
    const srcResolved = resolveEndpoint(candidate.sourceEventId, candidate.sourceEntityId);
    const tgtResolved = resolveEndpoint(candidate.targetEventId, candidate.targetEntityId);

    if (candidate.kind === 'before') {
      if (srcResolved) {
        candidate.sourceEntityId = srcResolved.entityId;
        if (srcResolved.originId) candidate.sourceEntityOrigin = srcResolved.originId;
      } else {
        delete candidate.sourceEntityId;
      }
      if (tgtResolved) {
        candidate.targetEntityId = tgtResolved.entityId;
        if (tgtResolved.originId) candidate.targetEntityOrigin = tgtResolved.originId;
      } else {
        delete candidate.targetEntityId;
      }
      if (createsBeforeCycle(candidate.sourceEventId, candidate.targetEventId, existingRelations)) {
        return null;
      }
    } else {
      if (!srcResolved || !tgtResolved) return null;
      candidate.sourceEntityId = srcResolved.entityId;
      if (srcResolved.originId) candidate.sourceEntityOrigin = srcResolved.originId;
      candidate.targetEntityId = tgtResolved.entityId;
      if (tgtResolved.originId) candidate.targetEntityOrigin = tgtResolved.originId;
    }

    validateRelationEndpoints(candidate);
    if (
      candidate.kind !== 'before' &&
      candidate.sourceEventId === candidate.targetEventId &&
      candidate.sourceEntityId &&
      candidate.sourceEntityId === candidate.targetEntityId
    ) {
      return null;
    }
    if (isPrecedence(candidate) && candidate.sourceEventId !== candidate.targetEventId) {
      const timeDag = ensureEventTimeDAG({ ...working, relations: existingRelations, eventTimeDAG: undefined });
      if (compareEventTimeById(working, candidate.targetEventId, candidate.sourceEventId, timeDag) === 'before') {
        return null;
      }
    }
    if (candidate.kind === 'dependency') {
      if (candidate.sourceEntityId && candidate.sourceEntityId === candidate.targetEntityId) {
        return null;
      }
      if (dependencyProblem(working, candidate, existingRelations)) {
        return null;
      }
    }
    return candidate;
  };

  const orderedRelationOps = [
    ...ops.filter((op) => op.op === 'remove_relation'),
    ...ops.filter((op) => op.op === 'modify_relation'),
    ...ops.filter((op) => op.op === 'add_relation'),
  ];

  for (const op of orderedRelationOps) {
    if (op.op === 'add_relation') {
      if (!hasValidRefs(op.sourceRefs) || !primarySource) continue;
      try {
        let relId = `rel_ref_${op.id}`;
        let suffix = 2;
        while (working.relations.some((r) => r.id === relId)) {
          relId = `rel_ref_${op.id}_${suffix++}`;
        }
        const rawCandidate = parseRelationSpec(relId, op.content, op.sourceRefs, op.reason, primarySource.id);
        if (!rawCandidate) continue;
        const candidate = normalizeCandidateRelation(rawCandidate, working.relations);
        if (!candidate) continue;

        // 同一内容の関係が既に存在する場合は二重追加をスキップ
        const isDuplicateRelation = working.relations.some(
          (r) =>
            r.kind === candidate.kind &&
            r.sourceEventId === candidate.sourceEventId &&
            r.targetEventId === candidate.targetEventId &&
            r.sourceEntityId === candidate.sourceEntityId &&
            r.targetEntityId === candidate.targetEntityId
        );
        if (isDuplicateRelation) continue;

        working.relations.push(candidate);
        appliedOps.push(`add_relation:${relId}`);
      } catch {}
    } else if (op.op === 'modify_relation') {
      if (!hasValidRefs(op.sourceRefs) || !primarySource) continue;
      const idx = working.relations.findIndex((r) => r.id === op.targetId);
      if (idx === -1) continue;
      try {
        const rawCandidate = parseRelationSpec(op.targetId, op.content, op.sourceRefs, op.reason, primarySource.id);
        if (!rawCandidate) continue;
        const others = working.relations.filter((_, i) => i !== idx);
        const candidate = normalizeCandidateRelation(rawCandidate, others);
        if (!candidate) continue;
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
      const eventIds = Array.from(new Set(op.content.split(',').map((s) => s.trim()).filter(Boolean)));
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
            subjectRanking: working.subjectRanking,
            subjectPoset: working.subjectPoset,
          },
          working.events,
          working.facts,
          true,
          undefined,
          working.sources
        );
        if (primarySource) {
          const built = buildAnalysis(primarySource, working.facts, working.events, parsed);
          const groupCreated = built.cards.some(
            (c) => c.laneEntityId === entityId && eventIds.every((id) => c.eventIds.includes(id))
          );
          if (groupCreated) {
            working = { ...working, cards: built.cards, unassignedEventIds: built.unassignedEventIds };
            appliedOps.push(`group:${entityId}(${eventIds.join(',')})`);
          }
        }
      } catch {}
    }
  }

  let preferredLanes: string[] | undefined;
  if (needsReconsolidate && currentSchema.lanes.length > 0) {
    const retainedNames = new Set(working.entities.map((e) => e.name));
    const origByName = new Map(revertedBase.entities.map((e) => [e.name, e]));
    const entityNameById = new Map(working.entities.map((e) => [e.id, e.name]));
    const rankByOrigId = new Map((working.subjectRanking?.ranks ?? []).map((r) => [r.entityId, r]));
    const mapped: string[] = [];
    for (const lane of currentSchema.lanes) {
      if (retainedNames.has(lane)) {
        if (!mapped.includes(lane)) mapped.push(lane);
        continue;
      }
      const orig = origByName.get(lane);
      if (!orig) {
        if (!mapped.includes(lane)) mapped.push(lane);
        continue;
      }
      const mergedTargetId = rankByOrigId.get(orig.id)?.mergedInto;
      const mergedTargetName = mergedTargetId ? entityNameById.get(mergedTargetId) : undefined;
      if (
        mergedTargetName &&
        !currentSchema.lanes.includes(mergedTargetName) &&
        !mapped.includes(mergedTargetName)
      ) {
        mapped.push(mergedTargetName);
      }
    }
    preferredLanes = mapped;
  }

  let nextSchema = projectAnalysis(working, currentSchema, {
    silentDebug: true,
    ...(preferredLanes ? { preferredLanes } : {}),
  });

  // ADR-0075: Stage 2 no longer generates new suppressedCards (peripheral 1-card lanes are consolidated cleanly in Final Phase).
  if (appliedOps.length > 0 || needsReconsolidate) {
    nextSchema = annotateNodeTopologyRules({
      ...repairGeneratedLaneSequence(nextSchema, { preservePositions: true }).schema,
      analysis: nextSchema.analysis,
    });
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
  currentSchema?: VTASchema,
  options?: GranularityRefinementOptions
): Promise<VTASchema> {
  let forceRetained = new Set<string>();
  let explicitMerges = new Map<string, string>();
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
  const preLimit = derivePreConsolidationLimit(maxSubjects, options?.preMaxSubjects);
  const initialConsolidated = consolidateSubjects(
    rawAnalysis,
    preLimit,
    undefined,
    (msg) => logTrace('warn', `[主体統合] ${msg}`, '解析'),
    {
      forceRetain: forceRetained,
      allowSubjectOthers: false,
      preConsolidationMaxSubjects: preLimit,
    }
  );
  let bestSchema = projectAnalysis(initialConsolidated, currentSchema);
  const m0 = computeMachineMetrics(bestSchema, preLimit, {
    cardBudgetMaxSubjects: maxSubjects,
  });
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

  debugRecorder.record('granularity.iteration', () => ({
    index: 0,
    score: bestScore,
    c1: m0.c1,
    c3: m0.c3,
    c5: m0.c5,
    preMaxSubjects: preLimit,
    postMaxSubjects: maxSubjects,
    adopted: true,
    appliedOps: ['initial_consolidation'],
    note: `[粒度反復 #0] 初期スコア S=${bestScore.toFixed(3)} (C1=${m0.c1.toFixed(2)}, C3=${m0.c3.toFixed(2)}, C5=${m0.c5.toFixed(2)})`,
  }));

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
      ignoredEventIds,
      options?.excludePostOutcome,
      preLimit
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
      const mCurrent = computeMachineMetrics(bestSchema, preLimit, {
        cardBudgetMaxSubjects: maxSubjects,
      });
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
      const noOpsMsg = `[粒度反復 #${t}] 修正提案なし（S=${updatedScore.toFixed(3)}${parsed.scenarioScore !== undefined ? `、シナリオ=${parsed.scenarioScore.toFixed(2)}` : ''}）。反復を終了します。`;
      debugRecorder.record('granularity.iteration', () => ({
        index: t,
        score: updatedScore,
        c1: mCurrent.c1,
        c2: parsed.c2,
        c3: mCurrent.c3,
        c4: parsed.c4,
        c5: mCurrent.c5,
        scenarioScore: parsed.scenarioScore,
        preMaxSubjects: preLimit,
        postMaxSubjects: maxSubjects,
        adopted: true,
        appliedOps: ['no_ops'],
        note: noOpsMsg,
      }));
      logTrace('info', noOpsMsg, '解析');
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

    const candidateForceRetained = new Set(forceRetained);
    const candidateExplicitMerges = new Map(explicitMerges);
    const { schema: candidateSchema, appliedOps } = applyRefinementOps(
      bestSchema,
      parsed.ops,
      maxSubjects,
      candidateForceRetained,
      logTrace,
      candidateExplicitMerges,
      preLimit
    );

    const mNext = computeMachineMetrics(candidateSchema, preLimit, {
      cardBudgetMaxSubjects: maxSubjects,
    });
    const mNextRawC3 = mNext.c3;
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
    const mBest = computeMachineMetrics(bestSchema, preLimit, {
      cardBudgetMaxSubjects: maxSubjects,
    });
    const comparableMachineBaseline = totalScore({ c1: mBest.c1, c3: mBest.c3, c5: mBest.c5 }, weights);
    // ADR-0059: the LLM scores (C2 / C4 / scenarioScore) returned in this iteration evaluate the schema the LLM
    // just reviewed (bestSchema), not the candidate. Apply the SAME scores to both sides of the comparison in
    // every iteration so that they cancel out and adoption is decided by machine metrics / topology only.
    // (Comparing against a previous iteration's LLM scores would let LLM scoring drift decide adoption.)
    const mBestComparableC3 =
      parsed.scenarioScore !== undefined
        ? Math.round((0.4 * mBest.c3 + 0.6 * parsed.scenarioScore) * 10000) / 10000
        : mBest.c3;
    const comparableBestScore = totalScore(
      { c1: mBest.c1, c2: parsed.c2, c3: mBestComparableC3, c4: parsed.c4, c5: mBest.c5 },
      weights
    );
    const nextMachineScore = totalScore({ c1: mNext.c1, c3: mNextRawC3, c5: mNext.c5 }, weights);
    const machineNotDegraded = nextMachineScore >= comparableMachineBaseline - epsilon;
    const machineStrictlyImproved = nextMachineScore > comparableMachineBaseline + 1e-9;
    const machineNotBelowBaseline = nextMachineScore >= comparableMachineBaseline - 1e-9;
    const bestVis = visibleSchema(bestSchema);
    const candVis = visibleSchema(candidateSchema);
    const edgePairKey = (e: { source: string; target: string }): string =>
      e.source < e.target ? `${e.source}\u0000${e.target}` : `${e.target}\u0000${e.source}`;
    const countConnectedCardPairs = (vis: VTASchema): number =>
      new Set(vis.edges.map(edgePairKey)).size;
    const countSemanticCardPairs = (vis: VTASchema): number =>
      new Set(
        vis.edges
          .filter((e) => Boolean(e.relationId) && e.meaning !== 'association')
          .map(edgePairKey)
      ).size;
    const countAggregatedSubjects = (s: VTASchema): number =>
      (s.analysis?.entities ?? [])
        .filter((e) => e.aggregate)
        .reduce((sum, e) => sum + (e.mergedFrom?.length ?? 0), 0);
    const countActiveEntities = (s: VTASchema): number =>
      (s.analysis?.entities ?? []).filter((e) => s.presentation?.lanes?.[e.id] !== 'hide').length;
    const topologyImproved =
      (bestVis.lanes.length > maxSubjects && candVis.lanes.length < bestVis.lanes.length) ||
      (countActiveEntities(bestSchema) > maxSubjects &&
        countActiveEntities(candidateSchema) < countActiveEntities(bestSchema)) ||
      countAggregatedSubjects(candidateSchema) < countAggregatedSubjects(bestSchema) ||
      candVis.nodes.length < bestVis.nodes.length ||
      countConnectedCardPairs(candVis) > countConnectedCardPairs(bestVis) ||
      countSemanticCardPairs(candVis) > countSemanticCardPairs(bestVis);
    // Decide adoption on uncorrupted machine metrics + topology so scenarioScore mixing (0.4*C3 + 0.6*scenario)
    // does not compress C3's weight below C5 and reject real causal-chain improvements.
    const improved =
      appliedOps.length > 0 &&
      gatesPassed &&
      machineNotDegraded &&
      machineNotBelowBaseline &&
      (machineStrictlyImproved || topologyImproved);

    iterations.push({
      index: t,
      score: nextScore,
      metrics: { c1: mNext.c1, c2: parsed.c2, c3: mNext.c3, c4: parsed.c4, c5: mNext.c5 },
      gateViolations: mNext.gateViolations,
      operations: appliedOps.length ? appliedOps : ['none_applicable'],
      adopted: improved,
    });

    const c2Text = parsed.c2 !== undefined ? `, C2=${parsed.c2.toFixed(2)}` : '';
    const c4Text = parsed.c4 !== undefined ? `, C4=${parsed.c4.toFixed(2)}` : '';
    const rawC3Note =
      parsed.scenarioScore !== undefined
        ? ` [機械C3=${mNextRawC3.toFixed(2)}, シナリオ=${parsed.scenarioScore.toFixed(2)}]`
        : '';
    const opsSummary = appliedOps.length ? ` [${appliedOps.slice(0, 6).join(', ')}${appliedOps.length > 6 ? ', ...' : ''}]` : '';
    const rejectReason = !improved
      ? (appliedOps.length === 0
          ? ' (理由: 適用可能操作0件)'
          : !gatesPassed
            ? ` (理由: ${mNext.gateViolations.join('; ')})`
            : !machineNotDegraded
              ? ` (理由: 機械指標退行 ${nextMachineScore.toFixed(3)}<${comparableMachineBaseline.toFixed(3)}-${epsilon})`
              : !machineNotBelowBaseline
                ? ` (理由: 機械スコア未改善 ${nextMachineScore.toFixed(3)}<${comparableMachineBaseline.toFixed(3)})`
                : ' (理由: スコア・図構造に実質的改善なし)')
      : '';
    const iterMsg = `[粒度反復 #${t}] スコア S=${nextScore.toFixed(3)} (C1=${mNext.c1.toFixed(2)}${c2Text}, C3=${mNext.c3.toFixed(2)}${rawC3Note}${c4Text}, C5=${mNext.c5.toFixed(2)} | 前回基準=${comparableBestScore.toFixed(3)}, 機械S=${comparableMachineBaseline.toFixed(3)}→${nextMachineScore.toFixed(3)}) 適用操作=${appliedOps.length}件${opsSummary} 採用=${improved ? 'はい' : 'いいえ'}${rejectReason}`;
    debugRecorder.record('granularity.iteration', () => ({
      index: t,
      score: nextScore,
      c1: mNext.c1,
      c2: parsed.c2,
      c3: mNext.c3,
      rawC3: mNextRawC3,
      c4: parsed.c4,
      c5: mNext.c5,
      scenarioScore: parsed.scenarioScore,
      preMaxSubjects: preLimit,
      postMaxSubjects: maxSubjects,
      adopted: improved,
      appliedOps,
      gateViolations: mNext.gateViolations,
      note: iterMsg,
    }));
    logTrace(improved ? 'info' : 'warn', iterMsg, '解析');

    const machineDelta = nextMachineScore - comparableMachineBaseline;
    if (improved) {
      forceRetained = candidateForceRetained;
      explicitMerges = candidateExplicitMerges;
      bestSchema = candidateSchema;
      bestScore = nextScore;
      recordGraphProjectionDebug(bestSchema);
    }

    // 収束幅判定は scenarioScore の 0.4 倍圧縮を受けない純機械スコア改善幅で行い、
    // C1/C5 の高スコアだけで C3 未収束のまま早期終了しないよう機械C3目標到達も確認する
    const causalTargetMet = mNextRawC3 >= targetScore;
    if (!improved || (!topologyImproved && bestScore >= targetScore && causalTargetMet && machineDelta < epsilon)) {
      break;
    }
  }

  if (options?.applyFinalOthersConsolidation) {
    const finalResult = consolidatePeripheralSubjectsToOthers(
      bestSchema,
      maxSubjects,
      {
        forceRetain: forceRetained,
        explicitMerges,
        preConsolidationMaxSubjects: preLimit,
        othersConsolidationMode: options.othersConsolidationMode ?? 'deterministic',
      },
      (msg) => logTrace('warn', `[周辺主体集約] ${msg}`, '解析')
    );
    const changed =
      finalResult.foldedEntityIds.length > 0 || finalResult.rolledUpPosetEntityIds.length > 0;
    if (changed) {
      bestSchema = annotateNodeTopologyRules({
        ...repairGeneratedLaneSequence(finalResult.schema, { preservePositions: true }).schema,
        analysis: finalResult.schema.analysis,
      });
      recordGraphProjectionDebug(bestSchema);
      logTrace(
        'info',
        `[最終周辺主体集約] 目標上限=${maxSubjects} に対し Poset包摂=${finalResult.rolledUpPosetEntityIds.length}件, その他の関係者集約=${finalResult.foldedEntityIds.length}件 [${finalResult.foldedEntityIds.join(', ')}] を反映しました。`,
        '解析'
      );
    } else {
      bestSchema = finalResult.schema;
    }
    debugRecorder.record('subject.others_consolidation', () => ({
      mode: finalResult.modeUsed,
      preMaxSubjects: preLimit,
      postMaxSubjects: maxSubjects,
      rolledUpPosetEntityIds: finalResult.rolledUpPosetEntityIds,
      foldedEntityIds: finalResult.foldedEntityIds,
      skippedReason: finalResult.skippedReason,
      visibleLanes: visibleSchema(bestSchema).lanes.length,
    }));
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
