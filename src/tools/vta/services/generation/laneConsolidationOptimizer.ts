import type {
  GranularityWeights,
  LLMConfig,
  VTAAnalysisData,
  VTAAnalysisScope,
  VTACardRef,
  VTAEntity,
  VTAEvent,
  VTAEventRelation,
  VTAFineGrainedBase,
  VTALaneConsolidationState,
  VTALaneMergeCandidate,
  VTALaneMergeCandidateKind,
  VTAParticipation,
  VTASchema,
  VTASeparationConstraint,
  VTASubjectConsolidationStage,
  VTAUserAssumption,
} from '../../types/vta';
import { debugRecorder } from '../debugRecorder';
import {
  auditProjectionWiring,
  isIdentifiedOutcomeEvent,
  projectAnalysis,
} from '../../features/vta/utils/eventAnalysis';
import { visibleSchema } from '../../features/vta/utils/presentation';
import {
  clampSubjectLimit,
  DEFAULT_MAX_SUBJECTS,
  evaluateMergeGuard,
  isActiveOrInteractiveMachine,
  rankSubjects,
  revertConsolidation,
} from '../../features/vta/utils/subjectRanking';
import {
  OTHER_ACTORS_ENTITY_NAME,
  prioritizeOtherActorsLanes,
} from '../../features/vta/utils/laneOrder';
import {
  computeDirectUncoveredEventIds,
  discoverConservativeParent,
  measureCommonAncestorDistance,
  SubjectPoset,
} from '../../features/vta/utils/subjectPoset';
import {
  assertAtomicPartitionInvariant,
  assertProjectedEntitiesPartition,
  buildAtomicRootAssignment,
  checkStrictPosetInclusion,
  computeForestSignature,
  createInitialForestState,
  findRootOfAtomic,
  getForestRootIds,
  getNodeLeafIds,
  getTopologicalCompositesBottomUp,
  isForestRoot,
  isPeripheralAggregateId,
  LEGACY_SUBJECT_OTHERS_ID,
  mergeForestRoots,
  resolveSourceTokenToRoot,
  SubjectCompositeRegistry,
  unmergeForestRoot,
  type CompositeForestNode,
  type CompositeForestState,
} from '../../features/vta/utils/subjectCompositeForest';
import {
  activeEvents,
  computeEventRowMap,
  ensureEventTimeDAG,
} from '../../features/vta/utils/eventTimePoset';
import {
  computeMachineMetrics,
  DEFAULT_GRANULARITY_WEIGHTS,
  totalScore,
} from './granularityScore';
import { FACTUALITY_POLICY } from '../llm/factualityPolicy';
import { sliceRelevantSourceParagraphs } from './contextSlicer';

export type LaneConsolidationChatCaller = (
  config: LLMConfig,
  messages: Array<{ role: 'system' | 'user'; content: string }>,
  temperature?: number,
  signal?: AbortSignal
) => Promise<{ content: string; latencyMs: number }>;

export type LaneConsolidationLog = (
  type: 'info' | 'success' | 'warn' | 'error',
  message: string,
  stage?: string
) => void;

export interface OptimizeLaneConsolidationOptions {
  targetMaxSubjects?: number;
  weights?: GranularityWeights;
  oneTimeDirective?: string;
  assumptions?: VTAUserAssumption[];
  scope?: VTAAnalysisScope;
  /** 既にキャッシュ済みの候補がありLLM再提案を省略する場合 true */
  reuseCachedCandidatesOnly?: boolean;
  beamWidth?: number;
  maxSteps?: number;
}

export interface OptimizeLaneConsolidationResult {
  schema: VTASchema;
  analysis: VTAAnalysisData;
  consolidation: VTALaneConsolidationState;
  fineLaneCount: number;
  finalLaneCount: number;
  llmCalled: boolean;
  evaluatedStates: number;
}

const ROLE_PRIORITY: Record<VTAParticipation['role'], number> = {
  actor: 5,
  affected: 4,
  confirmed_recipient: 3,
  intended_recipient: 2,
  target: 1,
};

const SUBJECT_OTHERS_ID = LEGACY_SUBJECT_OTHERS_ID;

export const LANE_CONSOLIDATION_SYSTEM_PROMPT = `あなたはVTA（バリエーションツリー分析）のスイムレーン構造設計エキスパートです。
${FACTUALITY_POLICY}

入力として「完成済みの最細粒度VTAグラフ（全主体・多軸Poset包含階層・イベント関与・レーン間関係・変動/帰結分類）」と「シナリオ本文」および「目標レーン数の目安」が与えられます。
下位主体は半順序集合（Poset）として複数の上位主体（雇用・組織軸、現場編成・職能軸、活動場所・機体軸、帰結・状況軸など）を同時に持ち得ます。
あなたの役割は、**このシナリオの事象連鎖を最も自然かつ明快に読み解ける上位主体（束ねの軸）を選択して「[推奨統合]」を提案すること**、および列数上限をさらに絞る場合や代替探索のための「[予備候補]」と「[分離維持ペア]」を一括提案することです（VTAはIT・製造・業務・医療・安全など全分野の事象連鎖分析に用いられます）。

【自然な上位主体選択と反鎖（親子非共存）の原則】
1. シナリオの文脈に即した単一軸の選択:
   - 下位主体が複数の上位主体を持つ場合（例：派遣元会社と現場作業班、雇用法人と機体枠など）、当日の事象連鎖・指揮命令・相互作用が実際に展開している軸の上位主体を統合先に選ぶこと。
2. 反鎖（Antichain＝親子レーン非共存）の厳守と中間ハブ・複合枠の活用:
   - 直接関与0件の純粋上位枠（例：作業班全体、中継見張員、待避作業員、人間-機械複合枠「運転士Aが操作する列車X」など）を統合先として実体化できるのは、**その上位枠に属するアクティブな下位主体すべてをその上位枠へ一括統合する場合（全統合）に限られる**（一部の下位主体だけを入れて他の下位主体を別レーンに残す部分統合は不可）。
   - 現場の作業班・乗務員編成などで主要メンバー（指揮者・現場代理人・見張員・被災作業員等）を独立レーンとして残す場合は、残りの補助メンバー（例：C・D中継見張員や E・F作業員）を親全体の「作業班」へ部分統合してはならない（作業班レーンと個別班員レーンが重複並立するため）。そのメンバー群のみを過不足なく包摂する中間上位ハブ（中継見張員、待避作業員 等）への全統合、または同質メンバーの role_group を用いること。
3. 人間-機械系（操縦者＋車両/装置）の一体統合と分離判断:
   - 操縦者・運転士（person）と操作対象の列車・航空機・装置（machine）が共通の複合上位主体（例：「運転士Aが操作する列車X」）を持ち、両者の間に自律制御のモード混乱や機器故障の対立がない場合は、[推奨統合] で両者をその複合上位主体へ poset_rollup して1レーンに統合すること（モード混乱や故障対立がある事例では [分離維持ペア] に指定して2レーンを維持する）。

【提案する統合候補の4種別（kind）】
1. poset_rollup: 下位の個人・担当・機械・小チームを、Poset上の上位主体（既存の上位主体ID）へ統合する。
   - 純粋上位枠（直接関与=0）を指定する場合は、必ず配下の全アクティブ下位主体を元主体ID群に含めること（例：中間ハブ C,D -> 中継見張員 を [推奨統合] に出し、列数上限が極端に小さい場合の全体統合 全班員 -> 作業班 を [予備候補] に出す）。
2. role_group: 適切な既存Poset上位主体が存在しない場合に、既存のPoset親子関係を保持したまま新たに発見・命名できる共通上位枠として、同一場面で並列・同質の役割を担う複数主体（2主体以上、または現場外の委託元・派遣元組織同士など）をわかりやすい役割グループ名（統合先IDは - 、統合先名称にグループ名）の1レーンに束ねる。
   - 同じ上位枠（作業班・乗務員編成・法人組織等）の中で現場の主要当事者を独立レーンに残しつつ、複数の補助グループや地上支援・管理・通信拠点（例：[推奨統合] の中継見張員グループと待避作業員グループ、あるいは同一法人配下の本庁対策本部・基地・通信部門）を列数上限に合わせて1レーンへ圧縮する場合は、親全体の上位枠への部分統合ではなく、対象の下位主体IDすべてを列挙した role_group を [推奨統合] または [予備候補] に提案すること。
   - 最終的な被災結果（:affected）の共有のみを理由として、単独の指揮・指示・情報受領・判断イベントを多数持つ監督・指揮主体と、指示を受ける側の作業メンバーを1つのグループ名（例：「被災者群」等）に束ねてはならない（単独の指示・判断イベントの主語がグループ全体に歪むため）。
3. peripheral_others: 本筋の現場事象連鎖から離れた周辺主体（事前の作業委託・契約・派遣手配を担う外部/管理組織、受動連絡先、事後対応機関など、2主体以上のバンドルおよび個別候補）を、周辺共通上位枠「その他の関係者」（統合先IDは subject_others、既存のPoset親子関係は保持）へ集約する。
   - 報告焦点が high/reporter の主要主体、一次損失（:loss）の直接当事者（:actor / :affected）、およびアクティブな上位組織レーンや複数カードのアクティブ下位メンバーを持つ階層主体は絶対に peripheral_others に含めないこと。
4. object_absorb: 自律的な判断・モード遷移を持たない受動的な機器・設備・ツール主体を、Poset上でその機器の上位主体である組織（M ≺ T）へ統合する（機械Mを人物Pなどの非上位主体へ直接吸収してはならない。人物Pと機械Mを統合する場合は、既存の複合上位主体への poset_rollup または新規の人間・機械システム role_group を用いること）。

【意味コスト（semantic_cost: 0.00〜1.00）の基準】
- 0.00〜0.12: 因果解釈上の情報欠損がほぼない（変動0件の随伴者、受動targetのみの連絡先、1カードのみの周辺手配主体、自然な上位枠への同質ロール束ね）。
- 0.15〜0.35: 軽微〜中程度の抽象化（小規模な変動を持つ下位担当を自然な上位チームへ束ねるが、親レーン上で経緯が追える場合）。
- 0.40〜0.75: 情報圧縮が大きい（複数の変動や独自判断を持つ当事者の統合。列数制約が厳しい場合の [予備候補]）。

【分離維持ペア（[分離維持ペア]）の基準】
- hard: 同一レーンに統合すると因果対立や責任境界が崩壊するため絶対分離すべきペア
  （例：異常・損失発生側と検知・阻止・回復側の非対称ペア、伝達エラーの送信側と受信側、一次損失[:loss]の直接被災個人[:affected]と加害・外部主体など）。
- soft: 可能な限り別レーンが望ましいが、列数上限が極端に小さい場合のみ統合を許容するペア。

【出力形式（厳守）】
説明文やMarkdown装飾は一切出力せず、以下の3セクションTSVと終端の [完了] のみを出力すること（列間は実際のタブ1文字、空欄は - ）。
- [推奨統合]: 目標レーン数の目安に向けて、**このシナリオでそのまま同時適用すべき最も自然な統合セット**（元主体が互いに重複・矛盾しない一貫した組み合わせ）。
- [予備候補]: さらに列数を減らす場合や別軸で束ねる場合の追加・代替候補（優先度順、元主体の重複可）。

[推奨統合]
ID\t種別\t元主体ID群\t統合先ID\t統合先名称\t統合先種別\t意味コスト\t理由
M1\tposet_rollup\tA_sub1,A_sub2\tO_team\t-\torganization\t0.06\t固有変動がなく現場作業班の行動と一体であるため
M2\tperipheral_others\tO_client,O_vendor\tsubject_others\tその他の関係者\tother\t0.05\t事前発注・派遣契約のみの周辺組織であるため
[予備候補]
ID\t種別\t元主体ID群\t統合先ID\t統合先名称\t統合先種別\t意味コスト\t理由
M3\tposet_rollup\tA_mid\tO_team\t-\torganization\t0.28\t列数上限がさらに小さい場合に親作業班へ統合
[分離維持ペア]
主体A\t主体B\t強さ\t理由
A_op\tA_qa\thard\t異常発生側と水際検知・停止側で役割・帰結が非対称なため
[完了]`;

function cleanCell(s: string | undefined): string {
  return (s ?? '').trim();
}

function slugifyGroupId(label: string, fallbackIdx: number): string {
  const ascii = label
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 24);
  return ascii ? `group_${ascii}` : `group_role_${fallbackIdx}`;
}

function isEffectiveVariation(analysis: Pick<VTAAnalysisData, 'outcome'>, ev: VTAEvent | undefined): boolean {
  if (!ev || ev.ignored) return false;
  if (ev.classification === 'variation' || Boolean(ev.variationFactor)) return true;
  if (ev.classification === 'unclassified' && ev.preliminary?.value === 'variation') {
    return !isIdentifiedOutcomeEvent(analysis, ev) || ev.outcome_kind === 'recovery';
  }
  return false;
}

function isLossOutcomeEvent(analysis: Pick<VTAAnalysisData, 'outcome'>, ev: VTAEvent | undefined): boolean {
  if (!ev || ev.ignored || !isIdentifiedOutcomeEvent(analysis, ev)) return false;
  return (
    ev.outcome_kind === 'loss' ||
    (!ev.outcome_kind &&
      analysis.outcome?.kind !== 'recovery' &&
      analysis.outcome?.kind !== 'near_miss')
  );
}

/**
 * Extracts or reconstructs the canonical fine-grained VTA base from `analysis`.
 */
export function captureFineGrainedBase(analysis: VTAAnalysisData): VTAFineGrainedBase {
  const activeEventIdSet = new Set(analysis.events.map((e) => e.id));
  if (analysis.fineGrainedBase && analysis.fineGrainedBase.entities.length > 0) {
    const base = structuredClone(analysis.fineGrainedBase);
    base.participations = base.participations.filter((p) => activeEventIdSet.has(p.eventId));
    base.relations = base.relations.filter(
      (r) => activeEventIdSet.has(r.sourceEventId) && activeEventIdSet.has(r.targetEventId)
    );
    base.cards = ensureFineGrainedCards(base.entities, base.participations, base.cards, analysis.events);
    return base;
  }

  const reverted =
    analysis.subjectRanking && analysis.subjectRanking.originalEntities.length > 0
      ? revertConsolidation(analysis)
      : structuredClone(analysis);

  const entities = reverted.entities
    .filter((e) => !e.aggregate)
    .map((e) => {
      const copy = { ...e };
      delete copy.mergedFrom;
      return copy;
    });
  const entIdSet = new Set(entities.map((e) => e.id));
  const participations = reverted.participations
    .filter((p) => entIdSet.has(p.entityId) && activeEventIdSet.has(p.eventId))
    .map((p) => {
      const copy = { ...p };
      delete copy.mergedFrom;
      return copy;
    });
  const relations = reverted.relations
    .filter((r) => activeEventIdSet.has(r.sourceEventId) && activeEventIdSet.has(r.targetEventId))
    .map((r) => {
      const src = r.sourceEntityOrigin && entIdSet.has(r.sourceEntityOrigin) ? r.sourceEntityOrigin : r.sourceEntityId;
      const tgt = r.targetEntityOrigin && entIdSet.has(r.targetEntityOrigin) ? r.targetEntityOrigin : r.targetEntityId;
      const copy: VTAEventRelation = {
        ...r,
        ...(src && entIdSet.has(src) ? { sourceEntityId: src } : { sourceEntityId: undefined }),
        ...(tgt && entIdSet.has(tgt) ? { targetEntityId: tgt } : { targetEntityId: undefined }),
      };
      delete copy.sourceEntityOrigin;
      delete copy.targetEntityOrigin;
      return copy;
    });
  const cards = ensureFineGrainedCards(entities, participations, reverted.cards, analysis.events);
  const reconstructedPoset = reverted.subjectPoset
    ? SubjectPoset.fromData(reverted.subjectPoset)
    : SubjectPoset.fromEntities(entities);
  for (const nid of [...reconstructedPoset.getNodes()]) {
    if (!entIdSet.has(nid)) {
      reconstructedPoset.removeNode(nid);
    }
  }
  const subjectPoset = reconstructedPoset.toJSON();

  return {
    entities,
    participations,
    relations,
    cards,
    subjectPoset,
  };
}

/**
 * Identifies Poset ancestors H whose active participations carry 0 independent agency beyond their
 * participating descendants and are canonically treated as 0-event hubs (HG2c):
 * 1) Strictly passive (`target` / `intended_recipient`) hubs with E_dir(H) = E(H) \ (⋃_{d ≺ H} E(d)) = ∅.
 * 2) Multi-descendant (>=2) non-agency collective hubs (no `actor` / `confirmed_recipient`) whose uncovered
 *    events are already carried by another non-peripheral participant and whose outcome `:affected` kinds are
 *    already represented on their participating descendants (e.g. crew hub A5 in E35 alongside E41 crew casualties).
 */
function computePassivelyCoveredHubIds(
  entities: readonly VTAEntity[],
  participations: readonly VTAParticipation[],
  activeEvIdSet: ReadonlySet<string>,
  poset: SubjectPoset,
  analysis?: Pick<VTAAnalysisData, 'events' | 'outcome'>
): Set<string> {
  const participatingIds = new Set<string>();
  for (const p of participations) {
    if (activeEvIdSet.has(p.eventId)) participatingIds.add(p.entityId);
  }
  const entById = new Map(entities.map((e) => [e.id, e]));
  const activeEvById = analysis
    ? new Map(analysis.events.filter((e) => !e.ignored).map((e) => [e.id, e]))
    : undefined;
  const resolveOutcomeKind = (ev: VTAEvent | undefined): string | undefined => {
    if (!analysis || !ev || !isIdentifiedOutcomeEvent(analysis, ev)) return undefined;
    return ev.outcome_kind ?? analysis.outcome?.kind ?? 'loss';
  };

  const result = new Set<string>();
  for (const ent of entities) {
    const parts = participations.filter(
      (p) => p.entityId === ent.id && activeEvIdSet.has(p.eventId)
    );
    if (parts.length === 0) continue;
    const participatingDescs = Array.from(participatingIds).filter(
      (did) => did !== ent.id && !result.has(did) && poset.isAncestor(ent.id, did)
    );
    if (participatingDescs.length === 0) continue;
    const isPassiveOnly = parts.every(
      (p) => p.role === 'target' || p.role === 'intended_recipient'
    );
    const directUncovered = computeDirectUncoveredEventIds(
      ent.id,
      participations,
      poset,
      activeEvIdSet,
      { requireSubstantiveDescendantRole: true }
    );
    if (isPassiveOnly && directUncovered.size === 0) {
      result.add(ent.id);
      continue;
    }

    if (
      analysis &&
      activeEvById &&
      participatingDescs.length >= 2 &&
      parts.every((p) => p.role !== 'actor' && p.role !== 'confirmed_recipient')
    ) {
      const descAffectedOutcomeKinds = new Set<string>();
      for (const did of participatingDescs) {
        for (const dp of participations) {
          if (dp.entityId !== did || dp.role !== 'affected' || !activeEvIdSet.has(dp.eventId)) continue;
          const ok = resolveOutcomeKind(activeEvById.get(dp.eventId));
          if (ok) descAffectedOutcomeKinds.add(ok);
        }
      }
      const allUncoveredRedundant = Array.from(directUncovered).every((evId) => {
        const ev = activeEvById.get(evId);
        const outKind = resolveOutcomeKind(ev);
        if (!outKind) return false;
        const ownPart = parts.find((p) => p.eventId === evId);
        if (ownPart?.role === 'affected' && !descAffectedOutcomeKinds.has(outKind)) {
          return false;
        }
        // Ensure the outcome event still has a substantive / high-focus non-covered carrier so HG3b is preserved
        return participations.some((op) => {
          if (op.eventId !== evId || op.entityId === ent.id || result.has(op.entityId)) return false;
          const oEnt = entById.get(op.entityId);
          return (
            op.role === 'actor' ||
            op.role === 'affected' ||
            oEnt?.focus === 'high' ||
            oEnt?.focus === 'reporter'
          );
        });
      });
      if (allUncoveredRedundant) {
        result.add(ent.id);
      }
    }
  }
  return result;
}

function remapPassivelyCoveredRelations(
  relations: readonly VTAEventRelation[],
  participations: readonly VTAParticipation[],
  activeEvIdSet: ReadonlySet<string>,
  passivelyCoveredHubs: ReadonlySet<string>,
  poset: SubjectPoset,
  resolveBucket?: (fineId: string) => string | undefined
): VTAEventRelation[] {
  if (passivelyCoveredHubs.size === 0) {
    return [...relations];
  }
  const remapped: VTAEventRelation[] = [];
  for (const r of relations) {
    if (!activeEvIdSet.has(r.sourceEventId) || !activeEvIdSet.has(r.targetEventId)) continue;
    let src = r.sourceEntityOrigin ?? r.sourceEntityId;
    let tgt = r.targetEntityOrigin ?? r.targetEntityId;
    const srcWasHub = Boolean(src && passivelyCoveredHubs.has(src));
    const tgtWasHub = Boolean(tgt && passivelyCoveredHubs.has(tgt));
    if (!srcWasHub && !tgtWasHub) {
      remapped.push(r);
      continue;
    }

    const pickDescendant = (evId: string, hubId: string, avoidBucket?: string): string | undefined => {
      const cands = participations.filter(
        (p) =>
          p.eventId === evId &&
          !passivelyCoveredHubs.has(p.entityId) &&
          poset.isAncestor(hubId, p.entityId)
      );
      if (cands.length > 0) {
        if (avoidBucket) {
          const distinct = cands.find((p) => (resolveBucket ? resolveBucket(p.entityId) : p.entityId) !== avoidBucket);
          if (distinct) return distinct.entityId;
        }
        return cands[0].entityId;
      }
      // Fallback for collective hubs whose co-carrier in evId shares a Poset ancestor or co-participates in the outcome event
      const hubAncs = poset.getAncestors(hubId, false);
      if (hubAncs.size > 0) {
        const cohortPeers = participations.filter((p) => {
          if (p.eventId !== evId || passivelyCoveredHubs.has(p.entityId)) return false;
          if (avoidBucket && (resolveBucket ? resolveBucket(p.entityId) : p.entityId) === avoidBucket) {
            return false;
          }
          for (const anc of poset.getAncestors(p.entityId, true)) {
            if (hubAncs.has(anc)) return true;
          }
          return false;
        });
        if (cohortPeers.length > 0) return cohortPeers[0].entityId;
      }
      const remainingCarriers = participations.filter((p) => {
        if (p.eventId !== evId || passivelyCoveredHubs.has(p.entityId)) return false;
        return !avoidBucket || (resolveBucket ? resolveBucket(p.entityId) : p.entityId) !== avoidBucket;
      });
      if (remainingCarriers.length > 0) {
        const roleRank: Record<VTAParticipation['role'], number> = {
          affected: 4,
          target: 3,
          confirmed_recipient: 2,
          intended_recipient: 1,
          actor: 0,
        };
        remainingCarriers.sort((a, b) => roleRank[b.role] - roleRank[a.role]);
        return remainingCarriers[0].entityId;
      }
      return undefined;
    };

    if (srcWasHub && src) {
      const avoid = tgt && !tgtWasHub ? (resolveBucket ? resolveBucket(tgt) : tgt) : undefined;
      src = pickDescendant(r.sourceEventId, src, avoid);
    }
    if (tgtWasHub && tgt) {
      const avoid = src ? (resolveBucket ? resolveBucket(src) : src) : undefined;
      tgt = pickDescendant(r.targetEventId, tgt, avoid);
    }

    const effSrc = src ? (resolveBucket ? resolveBucket(src) : src) : undefined;
    const effTgt = tgt ? (resolveBucket ? resolveBucket(tgt) : tgt) : undefined;
    if (r.kind !== 'before') {
      if (!effSrc || !effTgt || effSrc === effTgt) {
        if (r.sourceEventId !== r.targetEventId) {
          remapped.push({
            ...r,
            kind: 'before',
            sourceEntityId: undefined,
            targetEntityId: undefined,
            sourceEntityOrigin: undefined,
            targetEntityOrigin: undefined,
            resource: undefined,
            status: undefined,
            receipt: 'na',
          });
        }
        continue;
      }
    }
    remapped.push({
      ...r,
      sourceEntityId: src,
      targetEntityId: tgt,
      sourceEntityOrigin: undefined,
      targetEntityOrigin: undefined,
    });
  }
  return remapped;
}

function ensureFineGrainedCards(
  entities: readonly VTAEntity[],
  participations: readonly VTAParticipation[],
  existingCards: readonly VTACardRef[],
  events: readonly VTAEvent[]
): VTACardRef[] {
  const entIdSet = new Set(entities.map((e) => e.id));
  const eventById = new Map(events.map((e) => [e.id, e]));
  const validPairs = new Set(
    participations
      .filter((p) => entIdSet.has(p.entityId) && eventById.has(p.eventId))
      .map((p) => `${p.eventId}\u0000${p.entityId}`)
  );
  const coveredPairs = new Set<string>();
  const cards: VTACardRef[] = [];
  const usedIds = new Set<string>();

  for (const c of existingCards) {
    if (!entIdSet.has(c.laneEntityId)) continue;
    const evIds = c.eventIds.filter((evId) => {
      const key = `${evId}\u0000${c.laneEntityId}`;
      return validPairs.has(key) && !coveredPairs.has(key);
    });
    if (evIds.length === 0) continue;
    for (const evId of evIds) coveredPairs.add(`${evId}\u0000${c.laneEntityId}`);
    const id = usedIds.has(c.id) ? `fg_${c.id}_${cards.length + 1}` : c.id;
    usedIds.add(id);
    cards.push({ id, laneEntityId: c.laneEntityId, eventIds: evIds });
  }

  const sortedParts = [...participations]
    .filter((p) => validPairs.has(`${p.eventId}\u0000${p.entityId}`))
    .sort(
      (a, b) =>
        (eventById.get(a.eventId)?.sourceOrder ?? 0) - (eventById.get(b.eventId)?.sourceOrder ?? 0)
    );
  for (const p of sortedParts) {
    const key = `${p.eventId}\u0000${p.entityId}`;
    if (coveredPairs.has(key)) continue;
    coveredPairs.add(key);
    let seq = cards.length + 1;
    while (usedIds.has(`card_fg_${seq}`)) seq++;
    const id = `card_fg_${seq}`;
    usedIds.add(id);
    cards.push({ id, laneEntityId: p.entityId, eventIds: [p.eventId] });
  }
  return cards;
}

/**
 * Materializes a valid fine-grained `VTAAnalysisData` (with 0-event Poset containers kept only in `subjectPoset` / `fineGrainedBase`
 * so Stage 2 connection discovery sees clean participating fine-grained lanes without empty columns).
 */
export function buildFineGrainedWorkingAnalysis(
  analysis: VTAAnalysisData,
  fineBase?: VTAFineGrainedBase
): VTAAnalysisData {
  const base = fineBase ?? captureFineGrainedBase(analysis);
  const activeEventIdSet = new Set(analysis.events.filter((e) => !e.ignored).map((e) => e.id));
  const poset = base.subjectPoset
    ? SubjectPoset.fromData(base.subjectPoset)
    : SubjectPoset.fromEntities(base.entities);
  const passivelyCoveredHubIds = computePassivelyCoveredHubIds(
    base.entities,
    base.participations,
    activeEventIdSet,
    poset,
    analysis
  );
  const participatingIds = new Set<string>();
  for (const p of base.participations) {
    if (activeEventIdSet.has(p.eventId) && !passivelyCoveredHubIds.has(p.entityId)) {
      participatingIds.add(p.entityId);
    }
  }
  const activeEntities = base.entities.filter((e) => participatingIds.has(e.id));
  const activeEntSet = new Set(activeEntities.map((e) => e.id));

  const normalizedEntities = activeEntities.map((e) => {
    const copy: VTAEntity = { ...e };
    const ancs = Array.from(poset.getAncestors(e.id)).filter((aid) => aid !== e.id && activeEntSet.has(aid));
    const nearest = ancs.filter((aid) => !ancs.some((other) => other !== aid && poset.isAncestor(aid, other)));
    if (nearest.length > 0) {
      copy.parentEntityId = nearest[0];
      copy.parentEntityIds = nearest;
    } else {
      delete copy.parentEntityId;
      delete copy.parentEntityIds;
    }
    return copy;
  });

  const activeParts = base.participations.filter((p) => activeEntSet.has(p.entityId));
  const activeCards = ensureFineGrainedCards(normalizedEntities, activeParts, base.cards, analysis.events);
  const remappedRels = remapPassivelyCoveredRelations(
    base.relations,
    base.participations,
    activeEventIdSet,
    passivelyCoveredHubIds,
    poset
  );
  const activeRels = remappedRels.filter(
    (r) =>
      (!r.sourceEntityId || activeEntSet.has(r.sourceEntityId)) &&
      (!r.targetEntityId || activeEntSet.has(r.targetEntityId))
  );

  const next: VTAAnalysisData = {
    ...analysis,
    entities: normalizedEntities,
    participations: activeParts,
    relations: activeRels,
    cards: activeCards,
    subjectPoset: base.subjectPoset ?? poset.toJSON(),
    fineGrainedBase: base,
    unassignedEventIds: analysis.events
      .filter((ev) => !ev.ignored && !activeCards.some((c) => c.eventIds.includes(ev.id)))
      .map((ev) => ev.id),
  };
  ensureEventTimeDAG(next);
  return next;
}

export function buildLaneConsolidationUserPrompt(
  fineBase: VTAFineGrainedBase,
  analysis: VTAAnalysisData,
  targetMaxSubjects: number,
  options?: {
    oneTimeDirective?: string;
    assumptions?: VTAUserAssumption[];
    scope?: VTAAnalysisScope;
  }
): string {
  const poset = fineBase.subjectPoset
    ? SubjectPoset.fromData(fineBase.subjectPoset)
    : SubjectPoset.fromEntities(fineBase.entities);
  const activeEvById = new Map(analysis.events.filter((e) => !e.ignored).map((e) => [e.id, e]));
  const activeEvIdSet = new Set(activeEvById.keys());
  const passivelyCoveredHubIds = computePassivelyCoveredHubIds(
    fineBase.entities,
    fineBase.participations,
    activeEvIdSet,
    poset,
    analysis
  );
  const outcomeIds = new Set(
    analysis.outcome?.status === 'identified' ? analysis.outcome.eventIds : []
  );

  const activeEntIdSet = new Set(
    fineBase.entities
      .filter(
        (e) =>
          !passivelyCoveredHubIds.has(e.id) &&
          fineBase.participations.some((p) => p.entityId === e.id && activeEvById.has(p.eventId))
      )
      .map((e) => e.id)
  );

  const entityLines = fineBase.entities.map((e) => {
    const parts = passivelyCoveredHubIds.has(e.id)
      ? []
      : fineBase.participations.filter(
          (p) => p.entityId === e.id && activeEvById.has(p.eventId)
        );
    const actorCount = parts.filter((p) => p.role === 'actor').length;
    const varCount = parts.filter((p) => isEffectiveVariation(analysis, activeEvById.get(p.eventId))).length;
    const outRoles = parts
      .filter((p) => outcomeIds.has(p.eventId))
      .map((p) => {
        const ev = activeEvById.get(p.eventId);
        const kind = ev?.outcome_kind ?? analysis.outcome?.kind ?? 'loss';
        return `${p.eventId}:${kind}:${p.role}`;
      });
    const parents = poset.getImmediateParents(e.id);
    const allAncs = Array.from(poset.getAncestors(e.id)).filter((aid) => aid !== e.id);
    const posetCell =
      allAncs.length > parents.length
        ? `${parents.join(',') || '-'}(全上位:${allAncs.join(',')})`
        : parents.length
          ? parents.join(',')
          : '-';
    const activeDescCount = Array.from(activeEntIdSet).filter(
      (did) => did !== e.id && poset.isAncestor(e.id, did)
    ).length;
    const hubNote =
      parts.length === 0 && activeDescCount >= 2
        ? `[純粋上位枠: 配下の全${activeDescCount}主体を一括統合時のみ使用可]`
        : '';
    return [
      e.id,
      e.name,
      e.kind,
      e.focus ?? 'mid',
      posetCell,
      `関与=${parts.length}(能動=${actorCount},変動=${varCount})`,
      outRoles.length ? outRoles.join(',') : '-',
      hubNote || '-',
    ].join('\t');
  });

  const upperHubLines = fineBase.entities
    .map((hub) => {
      const directCards = passivelyCoveredHubIds.has(hub.id)
        ? 0
        : fineBase.participations.filter(
            (p) => p.entityId === hub.id && activeEvById.has(p.eventId)
          ).length;
      const activeDescs = fineBase.entities.filter(
        (d) => d.id !== hub.id && activeEntIdSet.has(d.id) && poset.isAncestor(hub.id, d.id)
      );
      if (activeDescs.length === 0) return null;
      const descStr = activeDescs.map((d) => `${d.id}(${d.name})`).join(', ');
      const constraintNote =
        directCards === 0
          ? `[純粋上位枠: 配下の全${activeDescs.length}主体を一括統合する場合のみ使用可（一部のみの部分統合不可）]`
          : '[直接関与あり]';
      return `${hub.id}\t${hub.name}\t${hub.kind}\t直接関与=${directCards}\t${descStr}\t${constraintNote}`;
    })
    .filter((line): line is string => Boolean(line));

  const remappedRelsForPrompt = remapPassivelyCoveredRelations(
    fineBase.relations,
    fineBase.participations,
    activeEvIdSet,
    passivelyCoveredHubIds,
    poset
  );
  const pairCounts = new Map<string, { kinds: Set<string>; count: number }>();
  for (const r of remappedRelsForPrompt) {
    if (r.kind === 'before') continue;
    if (!activeEvById.has(r.sourceEventId) || !activeEvById.has(r.targetEventId)) continue;
    const s = r.sourceEntityOrigin ?? r.sourceEntityId;
    const t = r.targetEntityOrigin ?? r.targetEntityId;
    if (!s || !t || s === t) continue;
    const key = `${s}->${t}`;
    const entry = pairCounts.get(key) ?? { kinds: new Set<string>(), count: 0 };
    entry.kinds.add(r.kind);
    entry.count++;
    pairCounts.set(key, entry);
  }
  const interactionLines = Array.from(pairCounts.entries())
    .slice(0, 60)
    .map(([pair, info]) => `${pair}\t件数=${info.count}\t種別=${Array.from(info.kinds).join(',')}`);

  const eventSummaryLines = Array.from(activeEvById.values()).map((ev) => {
    const parts = fineBase.participations
      .filter((p) => p.eventId === ev.id && !passivelyCoveredHubIds.has(p.entityId))
      .map((p) => `${p.entityId}:${p.role}`)
      .join(',');
    const cls = isIdentifiedOutcomeEvent(analysis, ev)
      ? `outcome:${ev.outcome_kind ?? analysis.outcome?.kind ?? 'loss'}`
      : isEffectiveVariation(analysis, ev)
        ? ev.preliminary?.polarity === 'resilient' || ev.variationFactor?.polarity === 'resilient'
          ? 'variation:resilient'
          : 'variation'
        : 'normal';
    return `${ev.id}\t${ev.time || '-'}\t${cls}\t${ev.title}\t${parts || '-'}`;
  });

  const activeLaneCount = activeEntIdSet.size;

  const extraDirectives: string[] = [];
  if (options?.scope?.pinnedEntityIds?.length) {
    extraDirectives.push(
      `固定維持主体（統合元にしてはならないID）: ${options.scope.pinnedEntityIds.join(', ')}`
    );
  }
  const enabledAssumptions = (options?.assumptions ?? []).filter((a) => a.enabled && a.text.trim());
  if (enabledAssumptions.length > 0) {
    extraDirectives.push(
      `分析前提: ${enabledAssumptions.map((a) => a.text.trim()).join(' / ')}`
    );
  }
  if (options?.oneTimeDirective?.trim()) {
    extraDirectives.push(`利用者からの重点指示: ${options.oneTimeDirective.trim()}`);
  }

  const primarySource = analysis.sources[0];
  const sourceSnippet = primarySource
    ? sliceRelevantSourceParagraphs(primarySource, analysis, 12000)
    : '';

  return [
    `[最適化ヒント]`,
    `現在の最細粒度アクティブ主体数: ${activeLaneCount}列 / 目標レーン数の目安: ${targetMaxSubjects}列前後`,
    ...(extraDirectives.length > 0 ? extraDirectives : []),
    '',
    '[最細粒度主体一覧]',
    'ID\t名称\t種別\t報告焦点\t上位主体(Poset)\t関与内訳\t帰結関与\t備考',
    ...entityLines,
    ...(upperHubLines.length > 0
      ? [
          '',
          '[上位主体ハブと包摂可能な下位主体一覧]',
          'ID\t名称\t種別\t直接関与数\t包摂可能な下位主体(Poset)',
          ...upperHubLines,
        ]
      : []),
    '',
    '[主体間の主な相互作用]',
    ...(interactionLines.length > 0 ? interactionLines : ['(なし)']),
    '',
    '[イベント概要]',
    'ID\t時刻\t分類\t見出し\t関与主体',
    ...eventSummaryLines,
    ...(sourceSnippet ? ['', '[シナリオ抜粋]', sourceSnippet] : []),
  ].join('\n');
}

/**
 * Determines which fine-grained entities are structurally eligible to be folded into `subject_others`.
 * Enforces pure topological & outcome structural invariants without ad-hoc entity-kind or card-count cutoffs:
 * protects high/reporter focus protagonists, non-passive-machine :loss outcome :actor/:affected participants,
 * sole outcome participants, Poset subordinates with active ancestors, and multi-card Poset parent hubs with active descendants.
 */
export function buildSubjectOthersEligibilitySet(
  fineBase: VTAFineGrainedBase,
  analysis?: Pick<VTAAnalysisData, 'events' | 'outcome'>,
  existingPoset?: SubjectPoset
): Set<string> {
  const poset =
    existingPoset ??
    (fineBase.subjectPoset
      ? SubjectPoset.fromData(fineBase.subjectPoset)
      : SubjectPoset.fromEntities(fineBase.entities));
  const activeEvById = analysis
    ? new Map(analysis.events.filter((e) => !e.ignored).map((e) => [e.id, e]))
    : undefined;
  const activeEvIdSet = activeEvById
    ? new Set(activeEvById.keys())
    : new Set(fineBase.participations.map((p) => p.eventId));
  const passivelyCoveredHubIds = computePassivelyCoveredHubIds(
    fineBase.entities,
    fineBase.participations,
    activeEvIdSet,
    poset,
    analysis
  );
  const outcomeIds = new Set(
    analysis?.outcome?.status === 'identified' ? analysis.outcome.eventIds : []
  );
  const fullAnalysisForMachine: VTAAnalysisData | undefined = analysis
    ? ({
        version: 5,
        sources: [],
        facts: [],
        events: analysis.events,
        entities: fineBase.entities,
        participations: fineBase.participations,
        relations: fineBase.relations,
        cards: fineBase.cards,
        unassignedEventIds: [],
        outcome: analysis.outcome,
        subjectPoset: fineBase.subjectPoset,
      } as VTAAnalysisData)
    : undefined;

  const partsByEnt = new Map<string, VTAParticipation[]>();
  for (const p of fineBase.participations) {
    if (activeEvById && !activeEvById.has(p.eventId)) continue;
    if (passivelyCoveredHubIds.has(p.entityId)) continue;
    const list = partsByEnt.get(p.entityId) ?? [];
    list.push(p);
    partsByEnt.set(p.entityId, list);
  }
  const participatingIds = new Set(partsByEnt.keys());
  const entById = new Map(fineBase.entities.map((e) => [e.id, e]));
  const isProtagonistOrLossDirect = (id: string): boolean => {
    const e = entById.get(id);
    if (!e) return false;
    if (e.focus === 'high' || e.focus === 'reporter') return true;
    if (!analysis || !activeEvById) return false;
    const isPassiveMach =
      e.kind === 'machine' &&
      (fullAnalysisForMachine ? !isActiveOrInteractiveMachine(e, fullAnalysisForMachine) : true);
    if (isPassiveMach) return false;
    return (partsByEnt.get(id) ?? []).some(
      (p) =>
        (p.role === 'actor' || p.role === 'affected') &&
        isLossOutcomeEvent(analysis, activeEvById.get(p.eventId))
    );
  };

  const activeDescCountByZeroHub = new Map<string, number>();
  for (const candHub of fineBase.entities) {
    if (participatingIds.has(candHub.id) || candHub.kind === 'person') continue;
    const cnt = Array.from(participatingIds).filter(
      (did) => did !== candHub.id && poset.isAncestor(candHub.id, did)
    ).length;
    activeDescCountByZeroHub.set(candHub.id, cnt);
  }

  // Checks whether `wid` is a non-machine protagonist/loss-direct entity under 0-event hub `hid`
  // that is NOT separated into its own proper 0-event sub-cohort `mid` (`wid ≺ mid ≺ hid`, `uid ⊀ mid`).
  const isUnseparatedHumanProtagonistUnderHub = (
    hid: string,
    wid: string,
    uid: string
  ): boolean => {
    if (wid === uid || participatingIds.has(hid)) return false;
    const wEnt = entById.get(wid);
    if (!wEnt || wEnt.kind === 'machine' || !isProtagonistOrLossDirect(wid)) return false;
    if (!poset.isAncestor(hid, wid)) return false;
    const hCnt = activeDescCountByZeroHub.get(hid) ?? 0;
    const separatedIntoSubCohort = Array.from(poset.getAncestors(wid)).some(
      (mid) =>
        mid !== wid &&
        mid !== hid &&
        poset.isAncestor(hid, mid) &&
        !poset.isAncestor(mid, uid) &&
        !participatingIds.has(mid) &&
        (activeDescCountByZeroHub.get(mid) ?? 0) >= 2 &&
        (activeDescCountByZeroHub.get(mid) ?? 0) < hCnt
    );
    return !separatedIntoSubCohort;
  };

  // On-site 0-event sub-role hubs (e.g. relay lookouts inside an unseparated protagonist field team)
  // belong in cohort role_group / poset_rollup, whereas standalone peripheral 0-event hubs (e.g. DF+AFS) stay eligible.
  const protagonistTeamZeroSubHubs = new Set<string>();
  for (const [hubId, cnt] of activeDescCountByZeroHub) {
    if (cnt < 2) continue;
    const hubAncs = Array.from(poset.getAncestors(hubId)).filter((aid) => aid !== hubId);
    const insideProtagonistCohort = hubAncs.some((hid) =>
      Array.from(participatingIds).some((wid) =>
        isUnseparatedHumanProtagonistUnderHub(hid, wid, hubId)
      )
    );
    if (insideProtagonistCohort) {
      protagonistTeamZeroSubHubs.add(hubId);
    }
  }

  // Pass 1: Intrinsic peripheral eligibility per participating entity
  const intrinsicallyPeripheral = new Set<string>();
  for (const ent of fineBase.entities) {
    if (!participatingIds.has(ent.id)) continue;
    if (ent.focus === 'high' || ent.focus === 'reporter') continue;

    const parts = partsByEnt.get(ent.id) ?? [];
    const isPassiveMachine =
      ent.kind === 'machine' &&
      (fullAnalysisForMachine ? !isActiveOrInteractiveMachine(ent, fullAnalysisForMachine) : true);

    if (analysis && activeEvById) {
      // Non-passive-machine :loss outcome direct participants (:actor / :affected) must never be hidden in subject_others
      if (
        !isPassiveMachine &&
        parts.some(
          (p) =>
            (p.role === 'actor' || p.role === 'affected') &&
            isLossOutcomeEvent(analysis, activeEvById.get(p.eventId))
        )
      ) {
        continue;
      }
      // Sole participant of any outcome event must never leave the outcome stranded on subject_others
      const isSoleOutcomeParticipant = parts.some(
        (p) =>
          outcomeIds.has(p.eventId) &&
          !fineBase.participations.some(
            (op) =>
              op.eventId === p.eventId &&
              op.entityId !== ent.id &&
              participatingIds.has(op.entityId)
          )
      );
      if (isSoleOutcomeParticipant) continue;
    }

    const entAncestors = Array.from(poset.getAncestors(ent.id)).filter((aid) => aid !== ent.id);
    if (entAncestors.some((aid) => protagonistTeamZeroSubHubs.has(aid))) {
      continue;
    }

    // Intra-cohort subordinates that share an unseparated 0-event Poset ancestor H AND direct event/relation coupling
    // with a human protagonist w ≺ H belong in cohort role_group / poset_rollup under H, not external subject_others
    if (entAncestors.length > 0) {
      const myEvSet = new Set(parts.map((p) => p.eventId));
      const isCoupledToCohortProtagonist = Array.from(participatingIds).some((wid) => {
        if (wid === ent.id) return false;
        const sharesUnseparatedZeroHub = entAncestors.some((hid) =>
          isUnseparatedHumanProtagonistUnderHub(hid, wid, ent.id)
        );
        if (!sharesUnseparatedZeroHub) return false;
        const sharesEvent = (partsByEnt.get(wid) ?? []).some((wp) => myEvSet.has(wp.eventId));
        if (sharesEvent) return true;
        return fineBase.relations.some((r) => {
          if (r.kind === 'before' || !activeEvIdSet.has(r.sourceEventId) || !activeEvIdSet.has(r.targetEventId)) {
            return false;
          }
          const s = r.sourceEntityOrigin ?? r.sourceEntityId;
          const t = r.targetEntityOrigin ?? r.targetEntityId;
          return (s === ent.id && t === wid) || (s === wid && t === ent.id);
        });
      });
      if (isCoupledToCohortProtagonist) continue;
    }

    // Multi-card Poset parent hubs with active descendants must not drop into subject_others
    if (parts.length >= 2) {
      const hasActiveDescendant = Array.from(participatingIds).some(
        (oid) => oid !== ent.id && poset.isAncestor(ent.id, oid)
      );
      if (hasActiveDescendant) continue;
    }

    intrinsicallyPeripheral.add(ent.id);
  }

  // Pass 2: Upward Poset closure — a subordinate `ent` with an active Poset ancestor `aid` is eligible ONLY when
  // every active ancestor `aid` and its entire active subtree `D(aid)` are purely peripheral (`⊆ intrinsicallyPeripheral`).
  const eligible = new Set<string>();
  for (const eid of intrinsicallyPeripheral) {
    const activeAncs = Array.from(poset.getAncestors(eid)).filter(
      (aid) => aid !== eid && participatingIds.has(aid)
    );
    const blockedByActiveAncestor = activeAncs.some((aid) => {
      if (!intrinsicallyPeripheral.has(aid)) return true;
      return Array.from(participatingIds).some(
        (did) => did !== aid && poset.isAncestor(aid, did) && !intrinsicallyPeripheral.has(did)
      );
    });
    if (!blockedByActiveAncestor) {
      eligible.add(eid);
    }
  }

  return eligible;
}

export function parseLaneConsolidationTSV(
  rawText: string,
  fineBase: VTAFineGrainedBase,
  analysis?: Pick<VTAAnalysisData, 'events' | 'outcome'>
): {
  candidates: VTALaneMergeCandidate[];
  separationConstraints: VTASeparationConstraint[];
  invalidLines: string[];
} {
  const cleaned = rawText
    .replace(/^\uFEFF/, '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .trim();
  const entById = new Map(fineBase.entities.map((e) => [e.id, e]));
  const entByName = new Map(fineBase.entities.map((e) => [e.name.trim(), e]));
  const poset = fineBase.subjectPoset
    ? SubjectPoset.fromData(fineBase.subjectPoset)
    : SubjectPoset.fromEntities(fineBase.entities);
  const eligibleOthersSet = buildSubjectOthersEligibilitySet(fineBase, analysis, poset);
  const activeEvIdSet = analysis
    ? new Set(analysis.events.filter((e) => !e.ignored).map((e) => e.id))
    : undefined;
  const participatingFineIds = Array.from(
    new Set(
      fineBase.participations
        .filter((p) => !activeEvIdSet || activeEvIdSet.has(p.eventId))
        .map((p) => p.entityId)
    )
  );

  const resolveEntId = (token: string): string | undefined => {
    const t = token.trim();
    if (!t || t === '-') return undefined;
    if (entById.has(t)) return t;
    return entByName.get(t)?.id;
  };

  const candidates: VTALaneMergeCandidate[] = [];
  const separationConstraints: VTASeparationConstraint[] = [];
  const invalidLines: string[] = [];
  const virtualGroupByToken = new Map<
    string,
    { candId: string; leafIds: string[] }
  >();
  const expandEntityLeaves = (entId: string): string[] => {
    if (participatingFineIds.includes(entId)) return [entId];
    return participatingFineIds.filter((pid) => pid !== entId && poset.isAncestor(entId, pid));
  };
  const validKinds = new Set<VTALaneMergeCandidateKind>([
    'poset_rollup',
    'role_group',
    'peripheral_others',
    'object_absorb',
  ]);
  const validTargetKinds = new Set<VTAEntity['kind']>(['person', 'organization', 'machine', 'other']);

  let section: 'recommended' | 'reserve' | 'candidates' | 'separations' | undefined;
  let seq = 1;

  for (const rawLine of cleaned.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('```')) continue;
    if (line === '[完了]') break;
    if (line === '[推奨統合]') {
      section = 'recommended';
      continue;
    }
    if (line === '[予備候補]') {
      section = 'reserve';
      continue;
    }
    if (line === '[統合候補]') {
      section = 'candidates';
      continue;
    }
    if (line === '[分離維持ペア]') {
      section = 'separations';
      continue;
    }
    if (line.startsWith('ID\t') || line.startsWith('主体A\t')) continue;

    const cells = rawLine.split('\t').map(cleanCell);
    if (section === 'recommended' || section === 'reserve' || section === 'candidates') {
      if (cells.length < 7) {
        invalidLines.push(line);
        continue;
      }
      // Support both 8-col (ID, kind, sources, targetId, targetLabel, targetKind, cost, reason)
      // and 7-col (ID, kind, sources, targetIdOrLabel, targetKind, cost, reason)
      let id: string;
      let kindRaw: string;
      let sourcesRaw: string;
      let targetIdRaw: string;
      let targetLabelRaw: string;
      let targetKindRaw: string;
      let costRaw: string;
      let reasonRaw: string;
      if (cells.length >= 8) {
        [id, kindRaw, sourcesRaw, targetIdRaw, targetLabelRaw, targetKindRaw, costRaw] = cells;
        reasonRaw = cells.slice(7).join(' ');
      } else {
        [id, kindRaw, sourcesRaw, targetIdRaw, targetKindRaw, costRaw] = cells;
        targetLabelRaw = targetIdRaw;
        reasonRaw = cells[6];
      }

      const kind = kindRaw as VTALaneMergeCandidateKind;
      if (!validKinds.has(kind)) {
        invalidLines.push(line);
        continue;
      }
      const rawTokens = sourcesRaw.split(/[,、]/);
      const resolvedSourceList: string[] = [];
      const sourceLeavesByToken = new Map<string, string[]>();
      for (const rawTok of rawTokens) {
        const directId = resolveEntId(rawTok);
        if (directId) {
          resolvedSourceList.push(directId);
          sourceLeavesByToken.set(directId, expandEntityLeaves(directId));
          continue;
        }
        const vg = virtualGroupByToken.get(rawTok.trim());
        if (vg) {
          // Keep sealed group reference intact (nested tree unit) instead of flattening to leaves!
          resolvedSourceList.push(vg.candId);
          sourceLeavesByToken.set(vg.candId, vg.leafIds);
        }
      }
      const sourceIds = Array.from(new Set(resolvedSourceList));
      if (sourceIds.length === 0) {
        invalidLines.push(line);
        continue;
      }

      let targetEntityId: string | undefined;
      let targetLabel: string | undefined;
      if (
        kind === 'peripheral_others' ||
        isPeripheralAggregateId(targetIdRaw) ||
        targetLabelRaw === OTHER_ACTORS_ENTITY_NAME
      ) {
        targetEntityId = SUBJECT_OTHERS_ID;
        targetLabel = OTHER_ACTORS_ENTITY_NAME;
      } else {
        targetEntityId = resolveEntId(targetIdRaw);
        if (!targetEntityId && targetLabelRaw && targetLabelRaw !== '-') {
          const matchedExisting = resolveEntId(targetLabelRaw);
          if (matchedExisting) {
            targetEntityId = matchedExisting;
          } else {
            targetLabel = targetLabelRaw;
          }
        } else if (targetLabelRaw && targetLabelRaw !== '-') {
          targetLabel = targetLabelRaw;
        }
      }

      // If a role_group mixes an existing non-person Poset ancestor Y with its descendants, normalize to poset_rollup -> Y
      // ONLY when it is a 2-entity disguised rollup (e.g. CAPT_A + A_CREW) or when ALL active descendants of Y are included
      let effectiveKind: VTALaneMergeCandidateKind = kind;
      if (!targetEntityId && sourceIds.length >= 2 && sourceIds.every((sid) => entById.has(sid))) {
        const sourceSet = new Set(sourceIds);
        const commonParent = sourceIds.find((candAnc) => {
          const ancEnt = entById.get(candAnc);
          if (!ancEnt || ancEnt.kind === 'person') return false;
          if (!sourceIds.every((sid) => sid === candAnc || poset.isAncestor(candAnc, sid))) {
            return false;
          }
          if (sourceIds.length === 2) return true;
          return !participatingFineIds.some(
            (pid) => pid !== candAnc && !sourceSet.has(pid) && poset.isAncestor(candAnc, pid)
          );
        });
        if (commonParent) {
          targetEntityId = commonParent;
          targetLabel = undefined;
          effectiveKind = 'poset_rollup';
        }
      }

      let filteredSources = sourceIds.filter((sid) => sid !== targetEntityId);
      let costScale = 1;
      if (targetEntityId === SUBJECT_OTHERS_ID) {
        const origLen = filteredSources.length;
        filteredSources = filteredSources.filter((sid) => {
          const leaves = sourceLeavesByToken.get(sid) ?? [];
          return leaves.length > 0 && leaves.every((lid) => eligibleOthersSet.has(lid));
        });
        if (filteredSources.length === 0) {
          invalidLines.push(line);
          continue;
        }
        if (origLen > 0 && filteredSources.length < origLen) {
          costScale = filteredSources.length / origLen;
        }
      }
      if (filteredSources.length === 0) continue;
      if (!targetEntityId && !targetLabel) {
        invalidLines.push(line);
        continue;
      }
      if (!targetEntityId && filteredSources.length < 2) {
        // Creating a brand-new group for a single source entity does not reduce lanes
        continue;
      }

      // Strict Poset inclusion invariant: absorbing into an existing entity T requires every source leaf u ≺ T
      // (rejects non-inclusion absorptions like machine -> person M8 as well as upward organization -> person inversions,
      //  while stripping out non-descendant siblings if mixed alongside valid Poset descendants)
      if (targetEntityId && targetEntityId !== SUBJECT_OTHERS_ID) {
        const tgtEnt = entById.get(targetEntityId);
        if (tgtEnt?.kind === 'person') {
          invalidLines.push(line);
          continue;
        }
        const origLen = filteredSources.length;
        filteredSources = filteredSources.filter((sid) => {
          if (entById.has(sid) && poset.isAncestor(sid, targetEntityId!)) {
            return false;
          }
          const leaves = sourceLeavesByToken.get(sid) ?? [];
          if (leaves.length === 0) {
            return entById.has(sid) && poset.isAncestor(targetEntityId!, sid);
          }
          return leaves.every((lid) => lid !== targetEntityId && poset.isAncestor(targetEntityId!, lid));
        });
        if (filteredSources.length === 0) {
          invalidLines.push(line);
          continue;
        }
        if (origLen > 0 && filteredSources.length < origLen) {
          costScale *= filteredSources.length / origLen;
        }
      }

      const parsedCost = Number(costRaw);
      const rawSemanticCost = Number.isFinite(parsedCost)
        ? Math.max(0, Math.min(1, parsedCost))
        : 0.2;
      const semanticCost = Number((rawSemanticCost * costScale).toFixed(3));
      const targetKind = validTargetKinds.has(targetKindRaw as VTAEntity['kind'])
        ? (targetKindRaw as VTAEntity['kind'])
        : targetEntityId === SUBJECT_OTHERS_ID
          ? 'other'
          : 'organization';

      const candId = id || `M_${seq++}`;
      const finalKind = targetEntityId === SUBJECT_OTHERS_ID ? 'peripheral_others' : effectiveKind;
      candidates.push({
        id: candId,
        kind: finalKind,
        sourceEntityIds: filteredSources,
        ...(targetEntityId ? { targetEntityId } : {}),
        ...(targetLabel ? { targetLabel } : {}),
        targetKind,
        semanticCost,
        reason: reasonRaw || 'AI提案によるレーン統合候補',
        origin: 'llm',
        ...(section === 'recommended'
          ? { recommended: true }
          : section === 'reserve'
            ? { recommended: false }
            : {}),
      });
      if (finalKind !== 'peripheral_others') {
        const allLeaves = Array.from(
          new Set([
            ...filteredSources.flatMap((sid) => sourceLeavesByToken.get(sid) ?? []),
            ...(targetEntityId ? expandEntityLeaves(targetEntityId) : []),
          ])
        );
        const vgEntry = { candId, leafIds: allLeaves };
        if (!entById.has(candId) && !entByName.has(candId)) {
          virtualGroupByToken.set(candId, vgEntry);
        }
        if (targetLabel) {
          const trimmedLabel = targetLabel.trim();
          if (trimmedLabel && !entById.has(trimmedLabel) && !entByName.has(trimmedLabel)) {
            virtualGroupByToken.set(trimmedLabel, vgEntry);
          }
        }
      }
    } else if (section === 'separations') {
      if (cells.length < 3) {
        invalidLines.push(line);
        continue;
      }
      const [rawA, rawB, rawSev] = cells;
      const reason = cells.slice(3).join(' ') || '役割・帰結の非対称性による分離維持';
      const idsA = resolveEntId(rawA)
        ? [resolveEntId(rawA)!]
        : (virtualGroupByToken.get(rawA.trim())?.leafIds ?? []);
      const idsB = resolveEntId(rawB)
        ? [resolveEntId(rawB)!]
        : (virtualGroupByToken.get(rawB.trim())?.leafIds ?? []);
      if (idsA.length === 0 || idsB.length === 0 || (idsA.length === 1 && idsB.length === 1 && idsA[0] === idsB[0])) {
        invalidLines.push(line);
        continue;
      }
      const sev = rawSev.toLowerCase() === 'soft' ? 'soft' : 'hard';
      for (const entityA of idsA) {
        for (const entityB of idsB) {
          if (entityA !== entityB) {
            separationConstraints.push({ entityA, entityB, severity: sev, reason });
          }
        }
      }
    }
  }

  return { candidates, separationConstraints, invalidLines };
}

/**
 * Generates deterministic structural fallback candidates & baseline separation guards
 * from the completed fine-grained VTA graph and SubjectPoset.
 */
export function generateStructuralFallbackCandidates(
  fineBase: VTAFineGrainedBase,
  analysis: VTAAnalysisData,
  pinnedEntityIds?: ReadonlySet<string>
): {
  candidates: VTALaneMergeCandidate[];
  separationConstraints: VTASeparationConstraint[];
} {
  const pinned = pinnedEntityIds ?? new Set<string>();
  const poset = fineBase.subjectPoset
    ? SubjectPoset.fromData(fineBase.subjectPoset)
    : SubjectPoset.fromEntities(fineBase.entities);
  const entById = new Map(fineBase.entities.map((e) => [e.id, e]));
  const activeEvById = new Map(analysis.events.filter((e) => !e.ignored).map((e) => [e.id, e]));
  const activeEvIdSet = new Set(activeEvById.keys());
  const passivelyCoveredHubIds = computePassivelyCoveredHubIds(
    fineBase.entities,
    fineBase.participations,
    activeEvIdSet,
    poset,
    analysis
  );
  const outcomeIds = new Set(
    analysis.outcome?.status === 'identified' ? analysis.outcome.eventIds : []
  );

  const remappedRelsForGuard = remapPassivelyCoveredRelations(
    fineBase.relations,
    fineBase.participations,
    activeEvIdSet,
    passivelyCoveredHubIds,
    poset
  );
  const activeFineParticipations = fineBase.participations.filter(
    (p) => !passivelyCoveredHubIds.has(p.entityId)
  );
  const fineAnalysisForGuard: VTAAnalysisData = {
    ...analysis,
    entities: fineBase.entities,
    participations: activeFineParticipations,
    relations: remappedRelsForGuard,
    cards: fineBase.cards,
    subjectPoset: fineBase.subjectPoset,
  };

  const partsByEnt = new Map<string, VTAParticipation[]>();
  for (const p of activeFineParticipations) {
    if (!activeEvById.has(p.eventId)) continue;
    const list = partsByEnt.get(p.entityId) ?? [];
    list.push(p);
    partsByEnt.set(p.entityId, list);
  }
  const participatingEntIds = new Set(partsByEnt.keys());

  const isLossAffectedNonMachine = (entId: string): boolean => {
    const ent = entById.get(entId);
    if (!ent || ent.kind === 'machine') return false;
    return (partsByEnt.get(entId) ?? []).some(
      (p) => p.role === 'affected' && isLossOutcomeEvent(analysis, activeEvById.get(p.eventId))
    );
  };

  const isRedundantCoEvacuator = (entId: string): boolean => {
    const ent = entById.get(entId);
    if (!ent || ent.focus === 'high' || ent.focus === 'reporter') return false;
    if (isLossAffectedNonMachine(entId)) return false;
    const mySpecialEvents = (partsByEnt.get(entId) ?? []).filter((p) => {
      const ev = activeEvById.get(p.eventId);
      return isIdentifiedOutcomeEvent(analysis, ev) || isEffectiveVariation(analysis, ev);
    });
    if (mySpecialEvents.length === 0) return true;
    return mySpecialEvents.every((sp) =>
      fineBase.participations.some(
        (op) =>
          op.eventId === sp.eventId &&
          op.entityId !== entId &&
          participatingEntIds.has(op.entityId) &&
          !poset.isAncestor(op.entityId, entId) &&
          (entById.get(op.entityId)?.focus === 'high' ||
            entById.get(op.entityId)?.focus === 'reporter')
      )
    );
  };

  const candidates: VTALaneMergeCandidate[] = [];
  const separationConstraints: VTASeparationConstraint[] = [];
  let fbSeq = 1;

  // 1. Pairwise structural separation constraints from evaluateMergeGuard
  const allActiveIds = Array.from(participatingEntIds);
  for (let i = 0; i < allActiveIds.length; i++) {
    for (let j = i + 1; j < allActiveIds.length; j++) {
      const a = allActiveIds[i];
      const b = allActiveIds[j];
      const g = evaluateMergeGuard(a, b, fineAnalysisForGuard);
      if (!g.allowed && g.strictAsymmetry) {
        const isRolePolarityOnly = Boolean(
          g.reason?.startsWith('異常発生側と回復・抑止側の役割が非対称')
        );
        if (isRedundantCoEvacuator(a) || isRedundantCoEvacuator(b)) {
          if (!isRolePolarityOnly) {
            separationConstraints.push({
              entityA: a,
              entityB: b,
              severity: 'soft',
              reason: g.reason ?? '役割差があるが他レーンで代表表示済み',
              origin: 'structural',
            });
          }
        } else {
          separationConstraints.push({
            entityA: a,
            entityB: b,
            severity: 'hard',
            reason: g.reason ?? '役割・帰結の厳格非対称性により分離維持',
            origin: 'structural',
          });
        }
      } else if (!g.allowed) {
        separationConstraints.push({
          entityA: a,
          entityB: b,
          severity: 'soft',
          reason: g.reason ?? '直接の伝達・依存関係が存在',
          origin: 'structural',
        });
      }
    }
  }

  // 2. Poset child -> nearest active ancestor (or >=2-child 0-event hub) roll-up candidates
  const participatingDescByHub = new Map<string, string[]>();
  const participatingDescCountById = new Map<string, number>();
  for (const ent of fineBase.entities) {
    const descs: string[] = [];
    for (const pid of participatingEntIds) {
      if (pid !== ent.id && poset.isAncestor(ent.id, pid)) {
        descs.push(pid);
      }
    }
    participatingDescByHub.set(ent.id, descs);
    participatingDescCountById.set(ent.id, descs.length);
  }

  const cleanManMachineZeroHubIds = new Set<string>();
  for (const ent of fineBase.entities) {
    if (participatingEntIds.has(ent.id)) continue;
    const descs = participatingDescByHub.get(ent.id) ?? [];
    if (descs.length !== 2) continue;
    const e0 = entById.get(descs[0]);
    const e1 = entById.get(descs[1]);
    if (!e0 || !e1) continue;
    const personEnt = e0.kind === 'person' ? e0 : e1.kind === 'person' ? e1 : undefined;
    const machEnt = e0.kind === 'machine' ? e0 : e1.kind === 'machine' ? e1 : undefined;
    if (!personEnt || !machEnt) continue;
    if (
      pinned.has(personEnt.id) ||
      pinned.has(machEnt.id) ||
      personEnt.focus === 'reporter' ||
      isLossAffectedNonMachine(personEnt.id)
    ) {
      continue;
    }
    if (evaluateMergeGuard(personEnt.id, machEnt.id, fineAnalysisForGuard).allowed) {
      cleanManMachineZeroHubIds.add(ent.id);
    }
  }

  const hasUnmergeablePersonDescById = new Map<string, boolean>();
  for (const ent of fineBase.entities) {
    let unmergeablePerson = false;
    const myDescCnt = participatingDescCountById.get(ent.id) ?? 0;
    for (const pid of participatingDescByHub.get(ent.id) ?? []) {
      const pEnt = entById.get(pid);
      if (
        pEnt?.kind === 'person' &&
        (pinned.has(pid) ||
          pEnt.focus === 'high' ||
          pEnt.focus === 'reporter' ||
          isLossAffectedNonMachine(pid))
      ) {
        const separatedBySubCohort = Array.from(poset.getAncestors(pid)).some(
          (mid) =>
            mid !== pid &&
            mid !== ent.id &&
            poset.isAncestor(ent.id, mid) &&
            !participatingEntIds.has(mid) &&
            (participatingDescCountById.get(mid) ?? 0) >= 2 &&
            (participatingDescCountById.get(mid) ?? 0) < myDescCnt
        );
        if (!separatedBySubCohort) {
          unmergeablePerson = true;
        }
      }
    }
    hasUnmergeablePersonDescById.set(ent.id, unmergeablePerson);
  }

  const mergeableChildrenByParent = new Map<string, string[]>();
  for (const ent of fineBase.entities) {
    if (!participatingEntIds.has(ent.id) || pinned.has(ent.id) || ent.focus === 'reporter') continue;
    const parts = partsByEnt.get(ent.id) ?? [];
    const varCount = parts.filter((p) => isEffectiveVariation(analysis, activeEvById.get(p.eventId))).length;
    const actorCountForEnt = parts.filter((p) => p.role === 'actor').length;
    const hasOutcomeRole = parts.some((p) => outcomeIds.has(p.eventId));
    const hasOutcomeActor =
      ent.focus !== 'low' &&
      parts.some(
        (p) => p.role === 'actor' && isLossOutcomeEvent(analysis, activeEvById.get(p.eventId))
      ) &&
      !isRedundantCoEvacuator(ent.id);
    const isPassiveMachine = ent.kind === 'machine' && !isActiveOrInteractiveMachine(ent, fineAnalysisForGuard);
    const baseCost = isPassiveMachine
      ? 0.02
      : hasOutcomeActor
        ? 0.68
        : ent.focus === 'low' && varCount === 0
          ? 0.04
          : varCount === 0 && ent.focus !== 'high'
            ? 0.08
            : ent.focus === 'high'
              ? Math.min(
                  0.9,
                  0.48 + varCount * 0.08 + Math.min(8, actorCountForEnt) * 0.025 + (hasOutcomeRole ? 0.06 : 0)
                )
              : 0.16 + Math.min(0.24, varCount * 0.06);

    const allAncs = Array.from(poset.getAncestors(ent.id)).filter((aid) => aid !== ent.id);
    const activeAncs = allAncs.filter((aid) => participatingEntIds.has(aid));
    // Also allow 0-event Poset hubs with >=2 participating descendants when not above an active intermediate parent
    const zeroHubAncs = allAncs.filter(
      (aid) =>
        !participatingEntIds.has(aid) &&
        (participatingDescCountById.get(aid) ?? 0) >= 2 &&
        !activeAncs.some((mid) => poset.isAncestor(aid, mid))
    );
    // Only target nearest active ancestors (do not leapfrog an active intermediate parent or a >=2-member 0-event sub-cohort hub)
    const nearestActiveAncs = activeAncs.filter(
      (aid) =>
        !activeAncs.some((mid) => mid !== aid && poset.isAncestor(aid, mid)) &&
        !zeroHubAncs.some((zid) => poset.isAncestor(aid, zid))
    );
    const targetAncestors = [...nearestActiveAncs, ...zeroHubAncs];

    const seenAnc = new Set<string>();
    for (const ancId of targetAncestors) {
      if (ancId === ent.id || seenAnc.has(ancId)) continue;
      seenAnc.add(ancId);
      const anc = entById.get(ancId);
      if (!anc || anc.kind === 'person') continue;
      const isTwoMemberZeroHub =
        !participatingEntIds.has(ancId) && (participatingDescCountById.get(ancId) ?? 0) === 2;
      const twoHubDescs = isTwoMemberZeroHub ? (participatingDescByHub.get(ancId) ?? []) : [];
      const isCompatibleTwoMemberHub =
        isTwoMemberZeroHub &&
        twoHubDescs.length === 2 &&
        twoHubDescs.every((did) => !pinned.has(did) && entById.get(did)?.focus !== 'reporter') &&
        isLossAffectedNonMachine(twoHubDescs[0]) === isLossAffectedNonMachine(twoHubDescs[1]) &&
        !evaluateMergeGuard(twoHubDescs[0], twoHubDescs[1], fineAnalysisForGuard).strictAsymmetry;
      const ancSharesLossAffected = participatingEntIds.has(ancId)
        ? isLossAffectedNonMachine(ancId)
        : isCompatibleTwoMemberHub;
      if (isLossAffectedNonMachine(ent.id) && (ent.focus === 'high' || !ancSharesLossAffected)) {
        continue;
      }
      const isCleanManMachineHub = cleanManMachineZeroHubIds.has(ancId);
      // Do not generate partial poset_fallback person->parent rollups when sibling protagonist persons remain under the same parent (Antichain preservation),
      // EXCEPT full 2-member compatible 0-event hubs (where HG2c guarantees both roll up together with 0 external siblings).
      if (
        ent.kind === 'person' &&
        hasUnmergeablePersonDescById.get(ancId) &&
        !isCleanManMachineHub &&
        !isCompatibleTwoMemberHub
      ) {
        continue;
      }
      const effectiveStepCost = isCleanManMachineHub ? 0.04 : baseCost;
      if (!isTwoMemberZeroHub || isCleanManMachineHub) {
        candidates.push({
          id: `FB_${fbSeq++}`,
          kind: isPassiveMachine ? 'object_absorb' : 'poset_rollup',
          sourceEntityIds: [ent.id],
          targetEntityId: ancId,
          targetKind: anc.kind,
          semanticCost: Number(effectiveStepCost.toFixed(3)),
          reason: `Poset上位主体「${anc.name}」への階層包摂`,
          origin: 'poset_fallback',
        });
      }
      if (
        (!isLossAffectedNonMachine(ent.id) || ancSharesLossAffected) &&
        (ent.focus !== 'high' || isCleanManMachineHub || isCompatibleTwoMemberHub) &&
        (varCount <= 1 || isTwoMemberZeroHub) &&
        (!hasOutcomeActor || isTwoMemberZeroHub)
      ) {
        const list = mergeableChildrenByParent.get(ancId) ?? [];
        list.push(ent.id);
        mergeableChildrenByParent.set(ancId, list);
      }
    }
  }

  // Bundle candidates for 0-event Poset hubs & multi-subordinate parents
  for (const [ancId, childIds] of mergeableChildrenByParent) {
    if (childIds.length < 2) continue;
    const anc = entById.get(ancId);
    if (!anc) continue;
    const isZeroHub = !participatingEntIds.has(ancId);
    // Pure 0-event hubs obey HG2c (all active descendants must roll up together; no partial slice)
    if (isZeroHub && childIds.length < (participatingDescCountById.get(ancId) ?? 0)) {
      continue;
    }
    const sortedBySimplicity = [...childIds].sort((a, b) => {
      const pa = partsByEnt.get(a)?.length ?? 0;
      const pb = partsByEnt.get(b)?.length ?? 0;
      return pa - pb;
    });
    if (!isZeroHub) {
      candidates.push({
        id: `FB_${fbSeq++}`,
        kind: 'poset_rollup',
        sourceEntityIds: sortedBySimplicity.slice(0, 2),
        targetEntityId: ancId,
        targetKind: anc.kind,
        semanticCost: 0.12,
        reason: `上位組織「${anc.name}」への複数下位主体バンドル統合`,
        origin: 'poset_fallback',
      });
    }
    if (isZeroHub || sortedBySimplicity.length >= 3) {
      candidates.push({
        id: `FB_${fbSeq++}`,
        kind: 'poset_rollup',
        sourceEntityIds: sortedBySimplicity,
        targetEntityId: ancId,
        targetKind: anc.kind,
        semanticCost: Number(Math.min(0.45, 0.07 * sortedBySimplicity.length).toFixed(3)),
        reason: `上位組織「${anc.name}」への下位主体一括統合`,
        origin: 'poset_fallback',
      });
    }
  }

  // 3. Discovered peripheral parent (`subject_others`) candidates priced by formal subject weight s(u),
  //    Poset common-ancestor distance δ_poset(S), and pairwise inter-subject relation weight W(u, v)
  const eligibleOthersSet = buildSubjectOthersEligibilitySet(fineBase, analysis, poset);
  const fineRankingsForFallback = rankSubjects(
    fineAnalysisForGuard,
    Math.max(fineBase.entities.length, DEFAULT_MAX_SUBJECTS)
  );
  const fallbackRankScoreById = new Map(
    fineRankingsForFallback.ranks.map((r) => [r.entityId, r.score])
  );
  const pairRelWeight = new Map<string, number>();
  const makePairRelKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  for (const r of remappedRelsForGuard) {
    if (r.kind === 'before') continue;
    const sEv = activeEvById.get(r.sourceEventId);
    const tEv = activeEvById.get(r.targetEventId);
    if (!sEv || !tEv) continue;
    const s = r.sourceEntityOrigin ?? r.sourceEntityId;
    const t = r.targetEntityOrigin ?? r.targetEntityId;
    if (!s || !t || s === t) continue;
    const touchesSpecial =
      isEffectiveVariation(analysis, sEv) ||
      isEffectiveVariation(analysis, tEv) ||
      outcomeIds.has(sEv.id) ||
      outcomeIds.has(tEv.id);
    const w = r.kind === 'mutual' || r.kind === 'impact' ? 2.0 : touchesSpecial ? 1.4 : 0.6;
    const key = makePairRelKey(s, t);
    pairRelWeight.set(key, (pairRelWeight.get(key) ?? 0) + w);
  }
  const computePosetBundleDelta = (memberIds: readonly string[]): number => {
    const info = measureCommonAncestorDistance(poset, memberIds, SUBJECT_OTHERS_ID);
    if (!Number.isFinite(info.averageCommonAncestorDepth)) return 0.04;
    return Math.min(0.03, Math.max(0, 0.015 * (info.averageCommonAncestorDepth - 1)));
  };

  const peripheralUnits: Array<{ ids: string[]; label: string; cost: number }> = [];
  const coveredInPeripheralBranch = new Set<string>();

  // 3a. Pure-peripheral 0-event Poset sub-hubs (e.g. DF+AFS under 東京進入管制所) as sealed root/branch units
  for (const hub of fineBase.entities) {
    if (participatingEntIds.has(hub.id) || hub.kind === 'person' || pinned.has(hub.id)) continue;
    const descs = Array.from(participatingEntIds).filter(
      (did) => did !== hub.id && poset.isAncestor(hub.id, did)
    );
    if (descs.length < 2 || descs.some((did) => !eligibleOthersSet.has(did) || pinned.has(did))) {
      continue;
    }
    const hasOutcomeActor = descs.some((did) =>
      (partsByEnt.get(did) ?? []).some((p) => p.role === 'actor' && outcomeIds.has(p.eventId))
    );
    if (hasOutcomeActor) continue;
    const meanS =
      descs.reduce((acc, did) => acc + (fallbackRankScoreById.get(did) ?? 0), 0) / descs.length;
    const unitCost = Number(Math.min(0.42, Math.max(0.05, 0.03 + 0.38 * meanS)).toFixed(3));
    for (const did of descs) coveredInPeripheralBranch.add(did);
    // Allow already-rolled-up composite root `cmp(hub)` to fold as 1 unit into `cmp_agg_*`
    candidates.push({
      id: `FB_${fbSeq++}`,
      kind: 'peripheral_others',
      sourceEntityIds: [hub.id],
      targetEntityId: SUBJECT_OTHERS_ID,
      targetLabel: OTHER_ACTORS_ENTITY_NAME,
      targetKind: 'other',
      semanticCost: unitCost,
      reason: `周辺上位枠「${hub.name}」を封緘複合主体のまま「${OTHER_ACTORS_ENTITY_NAME}」へ集約`,
      origin: 'poset_fallback',
    });
    peripheralUnits.push({
      ids: [...descs].sort(),
      label: hub.name,
      cost: Number(Math.min(0.48, unitCost * descs.length * 0.7).toFixed(3)),
    });
  }

  // 3b. Standalone peripheral entities & pure-peripheral active Poset subtrees (e.g. 羽田航空基地 + 羽田通信)
  for (const ent of fineBase.entities) {
    if (
      !eligibleOthersSet.has(ent.id) ||
      pinned.has(ent.id) ||
      coveredInPeripheralBranch.has(ent.id)
    ) {
      continue;
    }
    // Subordinate of an eligible active ancestor is bundled together with that ancestor root
    const hasEligibleActiveAncestor = Array.from(poset.getAncestors(ent.id)).some(
      (aid) => aid !== ent.id && participatingEntIds.has(aid) && eligibleOthersSet.has(aid)
    );
    if (hasEligibleActiveAncestor) continue;

    const parts = partsByEnt.get(ent.id) ?? [];
    const hasOutcomeActor = parts.some((p) => p.role === 'actor' && outcomeIds.has(p.eventId));
    if (hasOutcomeActor) continue;
    // Skip active multi-card organizational hubs that have mergeable children, or sole Poset parents of primary protagonists
    if ((mergeableChildrenByParent.get(ent.id)?.length ?? 0) >= 1 && parts.length >= 2) continue;
    const isSoleParentOfProtagonist = Array.from(participatingEntIds).some((did) => {
      if (did === ent.id || !poset.isAncestor(ent.id, did) || eligibleOthersSet.has(did)) {
        return false;
      }
      const dEnt = entById.get(did);
      if (!dEnt || (dEnt.focus !== 'high' && dEnt.focus !== 'reporter')) return false;
      const otherActiveOrZeroParents = Array.from(poset.getAncestors(did)).filter(
        (aid) => aid !== did && aid !== ent.id && !poset.isAncestor(ent.id, aid)
      );
      return otherActiveOrZeroParents.length === 0;
    });
    if (isSoleParentOfProtagonist) continue;

    const activeDescs = Array.from(participatingEntIds).filter(
      (did) => did !== ent.id && poset.isAncestor(ent.id, did)
    );
    const isPurePeripheralSubtree =
      activeDescs.length > 0 &&
      activeDescs.every((did) => eligibleOthersSet.has(did) && !pinned.has(did));

    const branchIds = isPurePeripheralSubtree ? [ent.id, ...activeDescs].sort() : [ent.id];
    for (const bid of branchIds) coveredInPeripheralBranch.add(bid);

    const isPassiveMachine =
      branchIds.length === 1 &&
      ent.kind === 'machine' &&
      !isActiveOrInteractiveMachine(ent, fineAnalysisForGuard);
    const meanS =
      branchIds.reduce((acc, bid) => acc + (fallbackRankScoreById.get(bid) ?? 0), 0) /
      branchIds.length;
    const cost = isPassiveMachine
      ? 0.02
      : Number(Math.min(0.42, Math.max(0.03, 0.02 + 0.38 * meanS)).toFixed(3));

    peripheralUnits.push({ ids: branchIds, label: ent.name, cost });
    // Single-root token (`ent.id`) allows both unmerged leaf and rolled-up `cmp(ent.id)` root to fold in 2-move steps
    candidates.push({
      id: `FB_${fbSeq++}`,
      kind: 'peripheral_others',
      sourceEntityIds: [ent.id],
      targetEntityId: SUBJECT_OTHERS_ID,
      targetLabel: OTHER_ACTORS_ENTITY_NAME,
      targetKind: 'other',
      semanticCost: cost,
      reason: `周辺主体「${ent.name}」(s=${meanS.toFixed(3)})を「${OTHER_ACTORS_ENTITY_NAME}」へ集約`,
      origin: 'poset_fallback',
    });
  }

  peripheralUnits.sort((a, b) => a.cost - b.cost);
  if (peripheralUnits.length >= 2) {
    const pairCap = Math.min(peripheralUnits.length, 6);
    const pairBundles: Array<{ ids: string[]; cost: number }> = [];
    for (let i = 0; i < pairCap; i++) {
      for (let j = i + 1; j < pairCap; j++) {
        const u = peripheralUnits[i];
        const v = peripheralUnits[j];
        const combinedIds = Array.from(new Set([...u.ids, ...v.ids])).sort();
        let relW = 0;
        for (const a of u.ids) {
          for (const b of v.ids) {
            relW += pairRelWeight.get(makePairRelKey(a, b)) ?? 0;
          }
        }
        const posetDelta = computePosetBundleDelta(combinedIds);
        const pairCost = 0.5 * (u.cost + v.cost) + posetDelta + 0.08 * relW;
        pairBundles.push({ ids: combinedIds, cost: pairCost });
      }
    }
    pairBundles.sort((a, b) => a.cost - b.cost);
    for (const pb of pairBundles.slice(0, 6)) {
      candidates.push({
        id: `FB_${fbSeq++}`,
        kind: 'peripheral_others',
        sourceEntityIds: pb.ids,
        targetEntityId: SUBJECT_OTHERS_ID,
        targetLabel: OTHER_ACTORS_ENTITY_NAME,
        targetKind: 'other',
        semanticCost: Number(Math.min(0.85, pb.cost).toFixed(3)),
        reason: `周辺主体群（${pb.ids.length}主体）を共通上位枠「${OTHER_ACTORS_ENTITY_NAME}」へ同時集約`,
        origin: 'poset_fallback',
      });
    }
  }

  return { candidates, separationConstraints };
}

function mergeCandidatePools(
  llmCandidates: readonly VTALaneMergeCandidate[],
  fallbackCandidates: readonly VTALaneMergeCandidate[],
  llmSeparations: readonly VTASeparationConstraint[],
  fallbackSeparations: readonly VTASeparationConstraint[]
): {
  candidates: VTALaneMergeCandidate[];
  separationConstraints: VTASeparationConstraint[];
} {
  const seenCandKeys = new Set<string>();
  const candidates: VTALaneMergeCandidate[] = [];
  const makeKey = (c: VTALaneMergeCandidate) =>
    `${[...c.sourceEntityIds].sort().join(',')}->${c.targetEntityId ?? c.targetLabel ?? ''}`;

  for (const c of [...llmCandidates, ...fallbackCandidates]) {
    const key = makeKey(c);
    if (seenCandKeys.has(key)) continue;
    seenCandKeys.add(key);
    candidates.push(c);
  }

  const sepByPair = new Map<string, VTASeparationConstraint>();
  const makePairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  // Structural hard guards take precedence, supplemented by LLM separations
  for (const s of [...fallbackSeparations, ...llmSeparations]) {
    const k = makePairKey(s.entityA, s.entityB);
    const prev = sepByPair.get(k);
    if (
      !prev ||
      (prev.severity === 'soft' && s.severity === 'hard') ||
      (prev.severity === 'soft' && s.severity === 'soft' && s.origin !== 'structural')
    ) {
      sepByPair.set(k, s);
    }
  }

  return {
    candidates,
    separationConstraints: Array.from(sepByPair.values()),
  };
}

interface SearchState {
  forest: CompositeForestState;
  assignment: Map<string, string>; // participating fineEntityId -> rootId
  appliedCandidateIds: string[];
  convexSemanticLoad: number;
  softPenalty: number;
  signature: string;
  score: number; // [0, 1] display score (totalScore)
  objective: number; // internal ranking objective
  metrics: {
    c1: number;
    c2: number;
    c3: number;
    c4: number;
    c5: number;
    interactionRetention: number;
  };
  laneCount: number;
}

function serializeForestComposites(
  forest: CompositeForestState
): NonNullable<VTALaneConsolidationState['composites']> | undefined {
  if (forest.composites.size === 0) return undefined;
  const out: NonNullable<VTALaneConsolidationState['composites']> = {};
  for (const comp of forest.composites.values()) {
    out[comp.id] = {
      id: comp.id,
      compositeOf: [...comp.compositeOf],
      leafIds: [...comp.leafIds],
      ...(comp.coreEntityId ? { coreEntityId: comp.coreEntityId } : {}),
      ...(comp.aggregate ? { aggregate: true as const } : {}),
      displayName: comp.displayName,
      kind: comp.kind,
      ...(comp.focus ? { focus: comp.focus } : {}),
      stepSemanticCost: comp.stepSemanticCost,
    };
  }
  return out;
}

/**
 * Projects a content-addressed laminar `CompositeForestState` onto a complete, valid `VTASchema`
 * while preserving `fineGrainedBase` untouched and double-checking atomic partition invariants.
 */
export function projectForestToSchema(
  fineBase: VTAFineGrainedBase,
  baseAnalysis: VTAAnalysisData,
  forest: CompositeForestState,
  consolidationMeta?: VTALaneConsolidationState,
  previousSchema?: VTASchema
): VTASchema {
  // Check #1: Pre-projection forest atomic partition invariant
  assertAtomicPartitionInvariant(forest);

  const assignment = buildAtomicRootAssignment(forest);
  const activeEvIdSet = new Set(baseAnalysis.events.filter((e) => !e.ignored).map((e) => e.id));
  const fineEntById = new Map(fineBase.entities.map((e) => [e.id, e]));
  const basePoset = fineBase.subjectPoset
    ? SubjectPoset.fromData(fineBase.subjectPoset)
    : SubjectPoset.fromEntities(fineBase.entities);
  const passivelyCoveredHubIds = computePassivelyCoveredHubIds(
    fineBase.entities,
    fineBase.participations,
    activeEvIdSet,
    basePoset,
    baseAnalysis
  );
  const projectedPoset = SubjectPoset.fromData(basePoset.toJSON());

  const fineEntIndexById = new Map(fineBase.entities.map((e, idx) => [e.id, idx]));
  const rootCanonicalOrderKey = (rid: string): number => {
    if (forest.atomicSet.has(rid)) {
      return fineEntIndexById.get(rid) ?? Number.MAX_SAFE_INTEGER;
    }
    const comp = forest.composites.get(rid);
    if (!comp) return Number.MAX_SAFE_INTEGER;
    if (comp.aggregate) return -1;
    let minIdx = comp.coreEntityId
      ? (fineEntIndexById.get(comp.coreEntityId) ?? Number.MAX_SAFE_INTEGER)
      : Number.MAX_SAFE_INTEGER;
    for (const lid of comp.leafIds) {
      const idx = fineEntIndexById.get(lid);
      if (idx !== undefined && idx < minIdx) minIdx = idx;
    }
    return minIdx;
  };
  const activeRootIds = getForestRootIds(forest).sort(
    (a, b) => rootCanonicalOrderKey(a) - rootCanonicalOrderKey(b) || a.localeCompare(b)
  );
  const activeRootSet = new Set(activeRootIds);
  const assignedFineIds = forest.atomicIds;
  const usedEntityNames = new Set<string>();
  const resolvedNameByNode = new Map<string, string>();
  const subsumedZeroHubBucket = new Map<string, string>();
  const attachedProperZeroHubs = new Set<string>();

  // Reserve names of unmerged atomic roots first so composites never collide with retained atomic lanes
  for (const rootId of activeRootIds) {
    if (!forest.atomicSet.has(rootId)) continue;
    const origEnt = fineEntById.get(rootId);
    let baseName = origEnt?.name ?? rootId;
    if (usedEntityNames.has(baseName)) {
      let suffix = 2;
      while (usedEntityNames.has(`${baseName} (${suffix})`)) suffix++;
      baseName = `${baseName} (${suffix})`;
    }
    usedEntityNames.add(baseName);
    resolvedNameByNode.set(rootId, baseName);
  }

  // Register composite nodes in bottom-up topological order (children before parents)
  // so nested hierarchies (e.g. M3, M4 ≺ M5 ≺ MCA) and proper 0-event sub-hubs are conservatively connected.
  for (const comp of getTopologicalCompositesBottomUp(forest)) {
    const isActiveRoot = activeRootSet.has(comp.id);
    let baseName = comp.aggregate
      ? OTHER_ACTORS_ENTITY_NAME
      : comp.coreEntityId
        ? fineEntById.get(comp.coreEntityId)?.name ?? comp.displayName
        : comp.displayName;
    if (isActiveRoot) {
      if (usedEntityNames.has(baseName)) {
        let suffix = 2;
        while (usedEntityNames.has(`${baseName} (${suffix})`)) suffix++;
        baseName = `${baseName} (${suffix})`;
      }
      usedEntityNames.add(baseName);
    }
    resolvedNameByNode.set(comp.id, baseName);

    const leafSet = new Set(comp.leafIds);
    // Only attach unmaterialized 0-event Poset hubs whose active descendants are a STRICT PROPER SUBSET
    // of comp.leafIds (0 < |D(h)| < |comp.leafIds|). Full-cover common ancestors (like A_JAL in bp8u)
    // sit ABOVE comp via minimalCommonAncestors (comp ≺ A_JAL), preventing parent-child inversion!
    const properSubZeroHubs = fineBase.entities
      .filter((e) => {
        if (
          forest.atomicSet.has(e.id) ||
          attachedProperZeroHubs.has(e.id) ||
          e.id === comp.id ||
          e.id === comp.coreEntityId
        ) {
          return false;
        }
        const activeDescs = assignedFineIds.filter(
          (fid) => fid !== e.id && basePoset.isAncestor(e.id, fid)
        );
        return (
          activeDescs.length > 0 &&
          activeDescs.length < comp.leafIds.length &&
          activeDescs.every((fid) => leafSet.has(fid))
        );
      })
      .map((e) => e.id);

    const maximalProperHubs = properSubZeroHubs.filter(
      (hid) => !properSubZeroHubs.some((other) => other !== hid && basePoset.isAncestor(other, hid))
    );
    const directChildren = comp.compositeOf.filter(
      (cid) => !maximalProperHubs.some((hid) => projectedPoset.isAncestor(hid, cid))
    );
    const allDirectMembers = [...maximalProperHubs, ...directChildren];
    const safeIncomingChildren = comp.coreEntityId
      ? allDirectMembers
      : [
          ...maximalProperHubs,
          ...directChildren.filter((cid) => {
            const childLeaves = getNodeLeafIds(forest, cid);
            return !childLeaves.some((lid) =>
              assignedFineIds.some(
                (extId) => extId !== lid && !leafSet.has(extId) && basePoset.isAncestor(lid, extId)
              )
            );
          }),
        ];

    discoverConservativeParent(
      projectedPoset,
      comp.id,
      baseName,
      allDirectMembers,
      safeIncomingChildren
    );
    for (const hid of properSubZeroHubs) {
      attachedProperZeroHubs.add(hid);
      subsumedZeroHubBucket.set(hid, comp.id);
    }
    if (comp.coreEntityId && !forest.atomicSet.has(comp.coreEntityId)) {
      subsumedZeroHubBucket.set(comp.coreEntityId, comp.id);
    }
  }

  const projectedEntities: VTAEntity[] = [];
  for (const rootId of activeRootIds) {
    const baseName = resolvedNameByNode.get(rootId) ?? rootId;
    if (forest.atomicSet.has(rootId)) {
      const origEnt = fineEntById.get(rootId)!;
      const rawAncestors = projectedPoset.hasNode(rootId)
        ? Array.from(projectedPoset.getAncestors(rootId))
        : [];
      const keptAncs = rawAncestors.filter((aid) => {
        if (aid === rootId || !activeRootSet.has(aid)) return false;
        const ancComp = forest.composites.get(aid);
        if (ancComp?.aggregate) return false;
        if (ancComp && !ancComp.coreEntityId) return false;
        return true;
      });
      const nearestParents = keptAncs.filter(
        (aid) => !keptAncs.some((other) => other !== aid && projectedPoset.isAncestor(aid, other))
      );
      projectedEntities.push({
        id: rootId,
        name: baseName,
        kind: origEnt.kind,
        ...(origEnt.focus ? { focus: origEnt.focus } : { focus: 'mid' }),
        ...(origEnt.focusSourceRefs ? { focusSourceRefs: origEnt.focusSourceRefs } : {}),
        ...(nearestParents.length > 0
          ? { parentEntityId: nearestParents[0], parentEntityIds: nearestParents }
          : {}),
      });
      continue;
    }

    const comp = forest.composites.get(rootId)!;
    if (comp.aggregate) {
      projectedEntities.push({
        id: comp.id,
        name: baseName,
        kind: 'other',
        aggregate: true,
        compositeOf: [...comp.compositeOf],
        mergedFrom: [...comp.leafIds],
      });
      continue;
    }

    const coreEnt = comp.coreEntityId ? fineEntById.get(comp.coreEntityId) : undefined;
    const rawAncestors = projectedPoset.hasNode(comp.id)
      ? Array.from(projectedPoset.getAncestors(comp.id))
      : [];
    const keptAncs = rawAncestors.filter((aid) => {
      if (aid === comp.id || !activeRootSet.has(aid)) return false;
      const ancComp = forest.composites.get(aid);
      if (ancComp?.aggregate) return false;
      if (ancComp && !ancComp.coreEntityId) return false;
      return true;
    });
    const nearestParents = keptAncs.filter(
      (aid) => !keptAncs.some((other) => other !== aid && projectedPoset.isAncestor(aid, other))
    );

    projectedEntities.push({
      id: comp.id,
      name: baseName,
      kind: coreEnt?.kind ?? comp.kind ?? 'organization',
      ...(coreEnt?.focus ? { focus: coreEnt.focus } : { focus: comp.focus ?? 'mid' }),
      ...(coreEnt?.focusSourceRefs ? { focusSourceRefs: coreEnt.focusSourceRefs } : {}),
      ...(nearestParents.length > 0
        ? { parentEntityId: nearestParents[0], parentEntityIds: nearestParents }
        : {}),
      compositeOf: [...comp.compositeOf],
      ...(comp.coreEntityId ? { coreEntityId: comp.coreEntityId } : {}),
      mergedFrom: [...comp.leafIds],
    });
  }

  // Check #2: Post-projection atomic partition completeness invariant
  assertProjectedEntitiesPartition(forest.atomicIds, projectedEntities);

  // Build consolidated participations per event
  const nextParticipations: VTAParticipation[] = [];
  for (const ev of baseAnalysis.events) {
    const evParts = fineBase.participations.filter(
      (p) => p.eventId === ev.id && assignment.has(p.entityId)
    );
    const byBucket = new Map<string, VTAParticipation[]>();
    for (const part of evParts) {
      const bId = assignment.get(part.entityId)!;
      const list = byBucket.get(bId) ?? [];
      list.push(part);
      byBucket.set(bId, list);
    }
    for (const [bId, parts] of byBucket) {
      if (parts.length === 1 && parts[0].entityId === bId) {
        nextParticipations.push({ ...parts[0] });
        continue;
      }
      const sorted = [...parts].sort((a, b) => ROLE_PRIORITY[b.role] - ROLE_PRIORITY[a.role]);
      const primary = sorted[0];
      const factIds = [...new Set(parts.flatMap((p) => p.factIds ?? []))];
      const sourceRefs = parts.some((p) => p.sourceRefs?.length)
        ? [
            ...new Map(
              parts
                .flatMap((p) => p.sourceRefs ?? [])
                .map((r) => [`${r.sourceId}/${r.paragraphId}`, r])
            ).values(),
          ]
        : undefined;
      nextParticipations.push({
        ...primary,
        entityId: bId,
        role: primary.role,
        factIds,
        ...(sourceRefs?.length ? { sourceRefs } : {}),
        ...(parts.every((p) => Boolean(p.inferred)) ? { inferred: true } : { inferred: undefined }),
        origin: parts.every((p) => p.origin === 'manual') ? 'manual' : 'extraction',
        mergedFrom: parts.map((p) => ({ entityId: p.entityId, role: p.role })),
      });
    }
  }

  // Remap relations (first resolving any unmerged passively covered Poset hub endpoints, then mapping to root IDs)
  const sourceRelations = remapPassivelyCoveredRelations(
    fineBase.relations,
    fineBase.participations,
    activeEvIdSet,
    passivelyCoveredHubIds,
    basePoset,
    (fid) => assignment.get(fid)
  );
  const nextRelations: VTAEventRelation[] = sourceRelations
    .filter((r) => activeEvIdSet.has(r.sourceEventId) && activeEvIdSet.has(r.targetEventId))
    .map((rel) => {
      const origSrc = rel.sourceEntityOrigin ?? rel.sourceEntityId;
      const origTgt = rel.targetEntityOrigin ?? rel.targetEntityId;
      const newSrc = origSrc
        ? (assignment.get(origSrc) ?? (activeRootSet.has(origSrc) ? origSrc : undefined))
        : undefined;
      const newTgt = origTgt
        ? (assignment.get(origTgt) ?? (activeRootSet.has(origTgt) ? origTgt : undefined))
        : undefined;
      return {
        ...rel,
        sourceEntityId: newSrc,
        targetEntityId: newTgt,
        ...(origSrc && newSrc && origSrc !== newSrc ? { sourceEntityOrigin: origSrc } : {}),
        ...(origTgt && newTgt && origTgt !== newTgt ? { targetEntityOrigin: origTgt } : {}),
      };
    });

  // Build consolidated cards (1 card per (eventId, rootId), preserving non-conflicting multi-event groups when unmerged)
  const eventOrderById = new Map(baseAnalysis.events.map((e) => [e.id, e.sourceOrder]));
  const nextCards: VTACardRef[] = [];
  const coveredPairs = new Set<string>();
  const usedCardIds = new Set<string>();

  for (const fgCard of fineBase.cards) {
    if (fgCard.eventIds.length < 2) continue;
    const bId = assignment.get(fgCard.laneEntityId);
    if (!bId || !forest.atomicSet.has(bId)) continue;
    const validEvs = fgCard.eventIds.filter((eid) =>
      nextParticipations.some((p) => p.eventId === eid && p.entityId === bId)
    );
    if (validEvs.length < 2) continue;
    if (validEvs.some((eid) => coveredPairs.has(`${eid}\u0000${bId}`))) continue;
    for (const eid of validEvs) coveredPairs.add(`${eid}\u0000${bId}`);
    usedCardIds.add(fgCard.id);
    nextCards.push({ id: fgCard.id, laneEntityId: bId, eventIds: validEvs });
  }

  const sortedNextParts = [...nextParticipations].sort(
    (a, b) => (eventOrderById.get(a.eventId) ?? 0) - (eventOrderById.get(b.eventId) ?? 0)
  );
  for (const part of sortedNextParts) {
    const key = `${part.eventId}\u0000${part.entityId}`;
    if (coveredPairs.has(key)) continue;
    coveredPairs.add(key);
    const matchingFgCard = fineBase.cards.find(
      (c) =>
        c.eventIds.length === 1 &&
        c.eventIds[0] === part.eventId &&
        (c.laneEntityId === part.entityId || assignment.get(c.laneEntityId) === part.entityId) &&
        !usedCardIds.has(c.id)
    );
    let cardId = matchingFgCard?.id;
    if (!cardId) {
      let seq = nextCards.length + 1;
      while (usedCardIds.has(`card_${seq}`)) seq++;
      cardId = `card_${seq}`;
    }
    usedCardIds.add(cardId);
    nextCards.push({ id: cardId, laneEntityId: part.entityId, eventIds: [part.eventId] });
  }

  // Synchronize subjectRanking for UI LaneManagementPanel, OLAP drill-down, and diagnostics
  const fineRankingBase = rankSubjects(
    {
      ...baseAnalysis,
      entities: fineBase.entities,
      participations: fineBase.participations.filter((p) => !passivelyCoveredHubIds.has(p.entityId)),
      relations: remapPassivelyCoveredRelations(
        fineBase.relations,
        fineBase.participations,
        activeEvIdSet,
        passivelyCoveredHubIds,
        basePoset
      ),
      cards: fineBase.cards,
      subjectPoset: fineBase.subjectPoset,
    },
    Math.max(fineBase.entities.length, consolidationMeta?.targetMaxSubjects ?? DEFAULT_MAX_SUBJECTS)
  );
  const targetLimit = consolidationMeta?.targetMaxSubjects ?? DEFAULT_MAX_SUBJECTS;
  const ranks = fineRankingBase.ranks.map((r) => {
    const mapped = assignment.get(r.entityId);
    if (!mapped) {
      // Unmaterialized 0-event or passively covered Poset hub: keep excluded:true so splitEntitiesLocally never resurrects 0-card lanes
      const subsumedInto = subsumedZeroHubBucket.get(r.entityId);
      const subsumedName = subsumedInto ? (resolvedNameByNode.get(subsumedInto) ?? subsumedInto) : undefined;
      return {
        ...r,
        retained: false,
        mergedInto: undefined,
        excluded: true,
        consolidationStage: 'stage3_hc_prune' as VTASubjectConsolidationStage,
        mergeBlockedReason: undefined,
        reason: subsumedName
          ? `上位複合主体「${subsumedName}」のPoset階層へ包摂（直接関与イベント0件のため非表示）`
          : passivelyCoveredHubIds.has(r.entityId)
            ? '下位主体の関与で全イベントがカバーされる純粋上位ハブのため非表示'
            : '直接関与イベント0件のため非表示',
      };
    }
    if (mapped === r.entityId) {
      return {
        ...r,
        retained: true,
        mergedInto: undefined,
        excluded: undefined,
        consolidationStage: undefined,
        mergeBlockedReason: undefined,
      };
    }
    const comp = forest.composites.get(mapped);
    const tgtEnt = projectedEntities.find((e) => e.id === mapped);
    const stage: VTASubjectConsolidationStage = comp?.aggregate
      ? 'stage3_hc_others'
      : comp?.coreEntityId
        ? fineEntById.get(r.entityId)?.kind === 'machine'
          ? 'stage3_hc_object'
          : 'stage3_hc_poset'
        : 'stage3_hc_group';
    return {
      ...r,
      retained: false,
      mergedInto: mapped,
      excluded: undefined,
      consolidationStage: stage,
      mergeBlockedReason: undefined,
      reason: `山登り最適化により「${tgtEnt?.name ?? mapped}」へ統合`,
    };
  });

  const projectedAnalysis: VTAAnalysisData = {
    ...baseAnalysis,
    entities: projectedEntities,
    participations: nextParticipations,
    relations: nextRelations,
    cards: nextCards,
    subjectPoset: projectedPoset.toJSON(),
    subjectRanking: {
      ...fineRankingBase,
      maxSubjects: targetLimit,
      originalEntities: fineBase.entities.map((e) => ({ ...e })),
      ranks,
    },
    fineGrainedBase: fineBase,
    ...(consolidationMeta ? { laneConsolidation: consolidationMeta } : {}),
    unassignedEventIds: baseAnalysis.events
      .filter((ev) => !ev.ignored && !nextCards.some((c) => c.eventIds.includes(ev.id)))
      .map((ev) => ev.id),
  };

  const preferredLanes = prioritizeOtherActorsLanes(
    projectedEntities.map((e) => e.name),
    projectedEntities
  );

  return projectAnalysis(projectedAnalysis, previousSchema, {
    preferredLanes,
    silentDebug: true,
  });
}

/**
 * Runs Beam-Assisted Steepest-Ascent Hill-Climbing over the candidate pool in memory (0 LLM tokens).
 */
export function searchOptimalLaneConsolidation(
  fineBase: VTAFineGrainedBase,
  baseAnalysis: VTAAnalysisData,
  inputCandidates: readonly VTALaneMergeCandidate[],
  separationConstraints: readonly VTASeparationConstraint[],
  options?: {
    targetMaxSubjects?: number;
    weights?: GranularityWeights;
    pinnedEntityIds?: ReadonlySet<string>;
    beamWidth?: number;
    maxSteps?: number;
    previousSchema?: VTASchema;
  }
): {
  bestSchema: VTASchema;
  consolidation: VTALaneConsolidationState;
  fineLaneCount: number;
  finalLaneCount: number;
  evaluatedStates: number;
} {
  const targetK = clampSubjectLimit(options?.targetMaxSubjects ?? DEFAULT_MAX_SUBJECTS);
  const weights = options?.weights ?? DEFAULT_GRANULARITY_WEIGHTS;
  const pinned = options?.pinnedEntityIds ?? new Set<string>();
  const beamWidth = Math.max(4, options?.beamWidth ?? 12);

  const activeEvs = activeEvents(baseAnalysis);
  const activeEvById = new Map(activeEvs.map((e) => [e.id, e]));
  const activeEvIdSet = new Set(activeEvById.keys());
  const outcomeEventIds = new Set(
    baseAnalysis.outcome?.status === 'identified' ? baseAnalysis.outcome.eventIds : []
  );

  // Precompute EventTimeDAG & eventRowMap ONCE (invariant across all lane partitions!)
  const fineWorking = buildFineGrainedWorkingAnalysis(baseAnalysis, fineBase);
  const dag = ensureEventTimeDAG(fineWorking);
  const eventRowMap = computeEventRowMap(fineWorking, dag);
  const poset = fineBase.subjectPoset
    ? SubjectPoset.fromData(fineBase.subjectPoset)
    : SubjectPoset.fromEntities(fineBase.entities);
  const passivelyCoveredHubIds = computePassivelyCoveredHubIds(
    fineBase.entities,
    fineBase.participations,
    activeEvIdSet,
    poset,
    baseAnalysis
  );
  const eligibleOthersSet = buildSubjectOthersEligibilitySet(fineBase, baseAnalysis, poset);

  const fineEntById = new Map(fineBase.entities.map((e) => [e.id, e]));
  const finePartsByEnt = new Map<string, VTAParticipation[]>();
  for (const p of fineBase.participations) {
    if (!activeEvById.has(p.eventId)) continue;
    if (passivelyCoveredHubIds.has(p.entityId)) continue;
    const list = finePartsByEnt.get(p.entityId) ?? [];
    list.push(p);
    finePartsByEnt.set(p.entityId, list);
  }
  const sortedFineIds = Array.from(finePartsByEnt.keys()).sort();
  const fineLaneCount = sortedFineIds.length;
  const defaultMaxSteps = Math.max(16, fineLaneCount - targetK + 4);
  const maxSteps = Math.max(1, options?.maxSteps ?? defaultMaxSteps);

  const remappedFineRelations = remapPassivelyCoveredRelations(
    fineBase.relations,
    fineBase.participations,
    activeEvIdSet,
    passivelyCoveredHubIds,
    poset
  );

  // Precompute 5-axis protagonist salience scores & activity counts ONCE for inclusion penalty P_sub(X -> Y)
  const fineGuardAnalysis: VTAAnalysisData = {
    ...baseAnalysis,
    entities: fineBase.entities,
    participations: fineBase.participations.filter((p) => !passivelyCoveredHubIds.has(p.entityId)),
    relations: remappedFineRelations,
    cards: fineBase.cards,
    subjectPoset: fineBase.subjectPoset,
  };
  const fineRankings = rankSubjects(
    fineGuardAnalysis,
    Math.max(fineBase.entities.length, targetK)
  );
  const rankScoreById = new Map(fineRankings.ranks.map((r) => [r.entityId, r.score]));
  const actorCountById = new Map<string, number>();
  const varActCountById = new Map<string, number>();
  const totalEventsById = new Map<string, number>();
  for (const ent of fineBase.entities) {
    const parts = finePartsByEnt.get(ent.id) ?? [];
    const evIds = new Set(parts.map((p) => p.eventId));
    totalEventsById.set(ent.id, evIds.size);
    actorCountById.set(ent.id, parts.filter((p) => p.role === 'actor').length);
    varActCountById.set(
      ent.id,
      parts.filter(
        (p) =>
          (p.role === 'actor' || p.role === 'affected') &&
          isEffectiveVariation(baseAnalysis, activeEvById.get(p.eventId))
      ).length
    );
  }

  // Precompute weighted cross-entity semantic interactions for C3 preservation
  interface WeightedCrossRel {
    srcEnt: string;
    tgtEnt: string;
    weight: number;
  }
  const crossInteractions: WeightedCrossRel[] = [];
  const pairInteractionWeight = new Map<string, number>();
  const makeEntPairKey = (a: string, b: string): string => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  let totalInteractionWeight = 0;
  for (const r of remappedFineRelations) {
    if (r.kind === 'before') continue;
    const sEv = activeEvById.get(r.sourceEventId);
    const tEv = activeEvById.get(r.targetEventId);
    if (!sEv || !tEv) continue;
    const s = r.sourceEntityOrigin ?? r.sourceEntityId;
    const t = r.targetEntityOrigin ?? r.targetEntityId;
    if (!s || !t || s === t || !finePartsByEnt.has(s) || !finePartsByEnt.has(t)) continue;
    const touchesSpecial =
      isEffectiveVariation(baseAnalysis, sEv) ||
      isEffectiveVariation(baseAnalysis, tEv) ||
      outcomeEventIds.has(sEv.id) ||
      outcomeEventIds.has(tEv.id);
    const w =
      r.kind === 'mutual' || r.kind === 'impact'
        ? 2.0
        : touchesSpecial
          ? 1.4
          : 0.6;
    crossInteractions.push({ srcEnt: s, tgtEnt: t, weight: w });
    const pKey = makeEntPairKey(s, t);
    pairInteractionWeight.set(pKey, (pairInteractionWeight.get(pKey) ?? 0) + w);
    totalInteractionWeight += w;
  }

  const fineEventSetByEnt = new Map<string, Set<string>>();
  for (const fid of sortedFineIds) {
    fineEventSetByEnt.set(fid, new Set((finePartsByEnt.get(fid) ?? []).map((p) => p.eventId)));
  }

  // Precompute backward causal reachability to identified outcomes for variation visibility (Stage 3 Item C)
  const causalPredsByEvent = new Map<string, Set<string>>();
  const addCausalEdge = (u: string, v: string) => {
    if (u === v || !activeEvById.has(u) || !activeEvById.has(v)) return;
    let set = causalPredsByEvent.get(v);
    if (!set) {
      set = new Set<string>();
      causalPredsByEvent.set(v, set);
    }
    set.add(u);
  };
  for (const r of remappedFineRelations) {
    if (r.kind === 'before') continue;
    addCausalEdge(r.sourceEventId, r.targetEventId);
  }
  for (const fid of sortedFineIds) {
    const parts = finePartsByEnt.get(fid) ?? [];
    const roleByEv = new Map<string, VTAParticipation['role']>();
    for (const p of parts) {
      const prev = roleByEv.get(p.eventId);
      if (!prev || ROLE_PRIORITY[p.role] > ROLE_PRIORITY[prev]) {
        roleByEv.set(p.eventId, p.role);
      }
    }
    const orderedEvs = Array.from(roleByEv.keys()).sort(
      (a, b) => (eventRowMap.get(a) ?? 0) - (eventRowMap.get(b) ?? 0)
    );
    for (let i = 1; i < orderedEvs.length; i++) {
      const nextRole = roleByEv.get(orderedEvs[i]);
      if (nextRole === 'actor' || nextRole === 'affected') {
        addCausalEdge(orderedEvs[i - 1], orderedEvs[i]);
      }
    }
  }
  const causallyReachesOutcome = new Set<string>(outcomeEventIds);
  const bfsQueue = Array.from(outcomeEventIds);
  while (bfsQueue.length > 0) {
    const cur = bfsQueue.shift()!;
    for (const pred of causalPredsByEvent.get(cur) ?? []) {
      if (!causallyReachesOutcome.has(pred)) {
        causallyReachesOutcome.add(pred);
        bfsQueue.push(pred);
      }
    }
  }
  const causalAdverseVariationIds: string[] = [];
  const actorsByCausalVariation = new Map<string, string[]>();
  for (const ev of activeEvs) {
    if (outcomeEventIds.has(ev.id) || !causallyReachesOutcome.has(ev.id)) continue;
    if (!isEffectiveVariation(baseAnalysis, ev)) continue;
    const isRes =
      ev.preliminary?.polarity === 'resilient' || ev.variationFactor?.polarity === 'resilient';
    if (isRes) continue;
    causalAdverseVariationIds.push(ev.id);
    const actors = fineBase.participations
      .filter((p) => p.eventId === ev.id && p.role === 'actor' && finePartsByEnt.has(p.entityId))
      .map((p) => p.entityId);
    actorsByCausalVariation.set(ev.id, Array.from(new Set(actors)));
  }

  // Precompute passive/shell entities for C4
  const passiveEntityIds = new Set<string>();
  for (const fid of sortedFineIds) {
    const ent = fineEntById.get(fid);
    const parts = finePartsByEnt.get(fid) ?? [];
    if (!ent) continue;
    if (ent.kind === 'machine' && !isActiveOrInteractiveMachine(ent, fineWorking)) {
      passiveEntityIds.add(fid);
    } else if (
      parts.length <= 1 &&
      ent.focus !== 'high' &&
      ent.focus !== 'reporter' &&
      parts.every((p) => p.role !== 'actor' && p.role !== 'affected')
    ) {
      passiveEntityIds.add(fid);
    }
  }

  const hardSepPairs: Array<[string, string]> = [];
  const llmSoftSepPairs: Array<[string, string]> = [];
  const structuralSoftSepPairs: Array<[string, string]> = [];
  for (const sc of separationConstraints) {
    if (sc.severity === 'hard') hardSepPairs.push([sc.entityA, sc.entityB]);
    else if (sc.origin === 'structural') structuralSoftSepPairs.push([sc.entityA, sc.entityB]);
    else llmSoftSepPairs.push([sc.entityA, sc.entityB]);
  }

  // Precompute pure-adverse entities & resilient/recovery events for partition-aware defender preservation
  const pureAdverseIds = new Set<string>();
  const resilientEventIds: string[] = [];
  for (const ev of activeEvs) {
    const isResEv =
      ev.outcome_kind === 'recovery' ||
      (isEffectiveVariation(baseAnalysis, ev) &&
        (ev.preliminary?.polarity === 'resilient' || ev.variationFactor?.polarity === 'resilient'));
    if (isResEv && fineBase.participations.some((p) => p.eventId === ev.id && finePartsByEnt.has(p.entityId))) {
      resilientEventIds.push(ev.id);
    }
  }
  const resEvSet = new Set(resilientEventIds);
  for (const fid of sortedFineIds) {
    const parts = finePartsByEnt.get(fid) ?? [];
    const hasAdv = parts.some((p) => {
      if (p.role === 'target' || p.role === 'intended_recipient') return false;
      const ev = activeEvById.get(p.eventId);
      return isEffectiveVariation(baseAnalysis, ev) && !resEvSet.has(p.eventId);
    });
    const hasRes = parts.some(
      (p) => resEvSet.has(p.eventId) && p.role !== 'target' && p.role !== 'intended_recipient'
    );
    if (hasAdv && !hasRes) pureAdverseIds.add(fid);
  }

  const moveConvexCost = (c: number): number => 0.35 * c + 0.95 * c * c;

  const activeDescendantsByZeroHub = new Map<string, string[]>();
  for (const ent of fineBase.entities) {
    if (finePartsByEnt.has(ent.id)) continue;
    const descs = sortedFineIds.filter((fid) => fid !== ent.id && poset.isAncestor(ent.id, fid));
    activeDescendantsByZeroHub.set(ent.id, descs);
  }

  // Resolve recursive atomic leaves of any candidate (handling nested candidate references)
  const inputCandById = new Map(inputCandidates.map((c) => [c.id, c]));
  const expandCandidateFineLeaves = (
    c: VTALaneMergeCandidate,
    seenCands = new Set<string>()
  ): string[] => {
    if (seenCands.has(c.id)) return [];
    seenCands.add(c.id);
    const out = new Set<string>();
    for (const sid of c.sourceEntityIds) {
      if (finePartsByEnt.has(sid)) {
        out.add(sid);
      } else if (activeDescendantsByZeroHub.has(sid)) {
        for (const d of activeDescendantsByZeroHub.get(sid) ?? []) {
          out.add(d);
        }
      } else {
        const refCand = inputCandById.get(sid);
        if (refCand) {
          for (const d of expandCandidateFineLeaves(refCand, seenCands)) {
            out.add(d);
          }
          if (refCand.targetEntityId && finePartsByEnt.has(refCand.targetEntityId)) {
            out.add(refCand.targetEntityId);
          }
        }
      }
    }
    return Array.from(out).sort();
  };

  // Explicit [推奨統合] Poset axis selections from the LLM (including Poset pairs inside recommended role_groups)
  const recommendedPosetPairs = new Set<string>();
  for (const cand of inputCandidates) {
    if (!cand.recommended || isPeripheralAggregateId(cand.targetEntityId)) continue;
    const leaves = expandCandidateFineLeaves(cand);
    if (cand.targetEntityId) {
      for (const lid of leaves) {
        recommendedPosetPairs.add(`${lid}->${cand.targetEntityId}`);
      }
    } else if (cand.kind === 'role_group' && leaves.length >= 2) {
      for (const lid of leaves) {
        for (const ancInGroup of leaves) {
          if (lid !== ancInGroup && poset.isAncestor(ancInGroup, lid)) {
            recommendedPosetPairs.add(`${lid}->${ancInGroup}`);
          }
        }
      }
    }
  }

  const cleanManMachineZeroHubIds = new Set<string>();
  for (const [hubId, descs] of activeDescendantsByZeroHub) {
    if (descs.length !== 2) continue;
    const e0 = fineEntById.get(descs[0]);
    const e1 = fineEntById.get(descs[1]);
    if (!e0 || !e1) continue;
    const personEnt = e0.kind === 'person' ? e0 : e1.kind === 'person' ? e1 : undefined;
    const machEnt = e0.kind === 'machine' ? e0 : e1.kind === 'machine' ? e1 : undefined;
    if (!personEnt || !machEnt) continue;
    if (pinned.has(personEnt.id) || pinned.has(machEnt.id) || personEnt.focus === 'reporter') {
      continue;
    }
    const personLossAffected = (finePartsByEnt.get(personEnt.id) ?? []).some(
      (p) => p.role === 'affected' && isLossOutcomeEvent(baseAnalysis, activeEvById.get(p.eventId))
    );
    if (personLossAffected) continue;
    if (evaluateMergeGuard(personEnt.id, machEnt.id, fineGuardAnalysis).allowed) {
      cleanManMachineZeroHubIds.add(hubId);
    }
  }

  /**
   * Inclusion & virtual-group asymmetry penalty function P_sub(X -> rootComp):
   * 1) Prevents high-salience protagonists X from being erroneously absorbed into an upper ancestor Y (X < Y)
   *    on blind/reserve rollups and prevents high-activity operational units from being swallowed into 0-actor corporate shells,
   *    while respecting the LLM's explicit [推奨統合] Poset upper-subject selection when structurally sound.
   * 2) Prevents high-salience / high-autonomy protagonists with substantial solo decision/action chains
   *    from being renamed into non-homogeneous virtual role_groups alongside subordinate followers,
   *    while keeping genuinely parallel peer role_groups penalty-free.
   */
  const computeInclusionPenalty = (
    childId: string,
    rootComp: CompositeForestNode
  ): number => {
    if (rootComp.aggregate || childId === rootComp.coreEntityId) return 0;
    const bucketMembers = rootComp.leafIds;
    let targetAncId: string | undefined;
    if (
      rootComp.coreEntityId &&
      fineEntById.has(rootComp.coreEntityId) &&
      poset.isAncestor(rootComp.coreEntityId, childId)
    ) {
      targetAncId = rootComp.coreEntityId;
    } else {
      targetAncId = bucketMembers.find((m) => m !== childId && poset.isAncestor(m, childId));
    }
    const isVirtualGroup = !rootComp.coreEntityId;
    if (!targetAncId) {
      if (isVirtualGroup && bucketMembers.length >= 2) {
        const ent = fineEntById.get(childId);
        if (!ent || ent.kind === 'machine' || passiveEntityIds.has(childId)) return 0;
        if (ent.focus === 'reporter') return 0.88;

        const childParts = finePartsByEnt.get(childId) ?? [];
        const myEventSet = new Set(childParts.map((p) => p.eventId));
        if (myEventSet.size === 0) return 0;

        const otherEvents = new Set<string>();
        let minOtherEvents = Infinity;
        for (const m of bucketMembers) {
          if (m === childId) continue;
          const mEvs = totalEventsById.get(m) ?? 0;
          if (mEvs < minOtherEvents) minOtherEvents = mEvs;
          for (const p of finePartsByEnt.get(m) ?? []) {
            otherEvents.add(p.eventId);
          }
        }

        const soloEvents = new Set<string>();
        const soloActVarEvents = new Set<string>();
        for (const p of childParts) {
          if (otherEvents.has(p.eventId)) continue;
          soloEvents.add(p.eventId);
          if (p.role === 'actor' || isEffectiveVariation(baseAnalysis, activeEvById.get(p.eventId))) {
            soloActVarEvents.add(p.eventId);
          }
        }

        const soloCount = soloEvents.size;
        const soloActVarCount = soloActVarEvents.size;
        const isHighProtagonistChain = ent.focus === 'high' && soloCount >= 4 && soloActVarCount >= 3;
        const isSevereAsymmetricChain =
          soloCount >= 5 &&
          soloActVarCount >= 3 &&
          minOtherEvents < Infinity &&
          myEventSet.size >= 2.5 * Math.max(1, minOtherEvents);

        if (isHighProtagonistChain || isSevereAsymmetricChain) {
          const rScore = rankScoreById.get(childId) ?? 0;
          const soloRatio = soloCount / myEventSet.size;
          const sizeAsym =
            minOtherEvents < Infinity && myEventSet.size >= 2 * Math.max(1, minOtherEvents) ? 0.15 : 0;
          const focusBoost = ent.focus === 'high' ? 0.22 * rScore : 0.08;
          return Math.min(0.9, 0.3 + 0.35 * soloRatio + focusBoost + sizeAsym);
        }
      }
      return 0;
    }

    const ent = fineEntById.get(childId);
    if (!ent || passiveEntityIds.has(childId)) return 0;

    const rScore = rankScoreById.get(childId) ?? 0;
    const nAct = actorCountById.get(childId) ?? 0;
    const nVarAct = varActCountById.get(childId) ?? 0;
    const xEvs = totalEventsById.get(childId) ?? 0;
    const yEvs = totalEventsById.get(targetAncId) ?? 0;
    const yAct = actorCountById.get(targetAncId) ?? 0;
    const childParts = finePartsByEnt.get(childId) ?? [];
    const ancParts = finePartsByEnt.get(targetAncId) ?? [];
    const hasExclusiveOutcomeActor =
      ent.focus !== 'low' &&
      childParts.some(
        (p) =>
          p.role === 'actor' &&
          isLossOutcomeEvent(baseAnalysis, activeEvById.get(p.eventId)) &&
          !ancParts.some((ap) => ap.eventId === p.eventId)
      );
    const otherBucketActorCount = isVirtualGroup
      ? bucketMembers
          .filter((m) => m !== childId)
          .reduce((sum, m) => sum + (actorCountById.get(m) ?? 0), 0)
      : yAct;
    const isZeroActorShellInversion =
      ent.focus !== 'low' &&
      yEvs >= 1 &&
      nAct >= 1 &&
      (rootComp.coreEntityId === targetAncId ? yAct === 0 : otherBucketActorCount === 0);

    const isCleanManMachineHub =
      rootComp.coreEntityId === targetAncId && cleanManMachineZeroHubIds.has(targetAncId);
    const allowsZeroHubOutcomeActor = yEvs === 0;
    const leapfrogsActiveIntermediate = Array.from(poset.getAncestors(childId)).some(
      (mid) =>
        mid !== childId &&
        mid !== targetAncId &&
        finePartsByEnt.has(mid) &&
        poset.isAncestor(targetAncId!, mid)
    );

    if (
      isCleanManMachineHub &&
      ent.focus !== 'reporter' &&
      (!hasExclusiveOutcomeActor || allowsZeroHubOutcomeActor) &&
      !isZeroActorShellInversion &&
      !leapfrogsActiveIntermediate
    ) {
      return 0;
    }

    let pSalience = 0;
    if (ent.focus === 'reporter') {
      pSalience = 0.88;
    } else if (ent.focus === 'high') {
      const actFactor = Math.min(
        1,
        0.45 * rScore + 0.04 * Math.min(8, nAct) + 0.07 * Math.min(4, nVarAct)
      );
      pSalience = 0.25 + 0.6 * actFactor;
    } else if (ent.focus === 'mid' && nVarAct >= 2) {
      pSalience = 0.18 + 0.06 * Math.min(4, nVarAct);
    }

    let pDom = 0;
    if (yEvs >= 1 && xEvs >= Math.max(5, 2.5 * yEvs)) {
      pDom = 0.35 * ((xEvs - 2 * yEvs) / xEvs);
    }
    if (isZeroActorShellInversion) {
      pDom = Math.max(pDom, 0.35);
    }
    const isRecommendedPosetRollup =
      recommendedPosetPairs.has(`${childId}->${targetAncId}`) &&
      ent.focus !== 'reporter' &&
      (!hasExclusiveOutcomeActor || allowsZeroHubOutcomeActor) &&
      !isZeroActorShellInversion &&
      !leapfrogsActiveIntermediate;

    if (hasExclusiveOutcomeActor && (!allowsZeroHubOutcomeActor || !isRecommendedPosetRollup)) {
      pSalience = Math.max(pSalience, 0.65);
    }
    const hasHighFocusLossAffected =
      ent.kind !== 'machine' &&
      ent.focus === 'high' &&
      childParts.some(
        (p) => p.role === 'affected' && isLossOutcomeEvent(baseAnalysis, activeEvById.get(p.eventId))
      );
    if (hasHighFocusLossAffected) {
      pSalience = Math.max(pSalience, 0.68);
    }

    // Continuous relative intra-bucket dominance discount d(X, B) ∈ [0, 1] for [推奨統合] Poset rollups:
    // Uses unified activity-salience weight a(u) = s(u) + 0.12|E(u)| + 0.08|E_act(u)| and solo-event ratio σ_solo(X, B'):
    // - Balanced peer cohorts & co-pilots (a(X) ≤ 1.35 * mean a(B')) yield d(X, B) = 0 -> P_sub^eff = P_dom.
    // - Over-broad bundles mixing a high-activity solo protagonist X (e.g. タワー東) with minor seats smoothly restore P_sal(X).
    if (isRecommendedPosetRollup) {
      const peers = bucketMembers.filter((m) => m !== childId);
      if (peers.length === 0) return Math.min(0.92, pDom);
      const activityWeight = (uid: string): number =>
        (rankScoreById.get(uid) ?? 0) +
        0.12 * (totalEventsById.get(uid) ?? 0) +
        0.08 * (actorCountById.get(uid) ?? 0);
      const myA = activityWeight(childId);
      let sumPeerA = 0;
      const peerEvents = new Set<string>();
      for (const pid of peers) {
        sumPeerA += activityWeight(pid);
        for (const p of finePartsByEnt.get(pid) ?? []) {
          peerEvents.add(p.eventId);
        }
      }
      const meanPeerA = sumPeerA / peers.length;
      const myEvents = new Set(childParts.map((p) => p.eventId));
      let soloCount = 0;
      for (const eid of myEvents) {
        if (!peerEvents.has(eid)) soloCount++;
      }
      const soloRatio = myEvents.size > 0 ? soloCount / myEvents.size : 0;
      const parityCeiling = 1.35 * meanPeerA;
      const weightDominance =
        myA > parityCeiling ? (myA - parityCeiling) / Math.max(1e-6, myA) : 0;
      const dIntra = Math.min(1, Math.max(0, 2.2 * soloRatio * weightDominance));
      return Math.min(0.92, dIntra * pSalience + pDom);
    }

    return Math.min(0.92, pSalience + pDom);
  };

  const compositeRegistry = new SubjectCompositeRegistry();
  const initForest = createInitialForestState(sortedFineIds);

  const isLossDirectEntity = (entId: string): boolean =>
    (finePartsByEnt.get(entId) ?? []).some(
      (p) =>
        (p.role === 'actor' || p.role === 'affected') &&
        isLossOutcomeEvent(baseAnalysis, activeEvById.get(p.eventId))
    );

  // Enrich candidate pool with 2 orthogonal structural primitives:
  // (1) High-dispersion bundle P' construction (creating a distinct composite P' over non-protagonists while leaving protagonists independent)
  // (2) Single-pass Poset parent auxiliary cohort grouping (unifying compatible non-protagonist siblings under partial 0-event hubs)
  const activePoolCandidates: VTALaneMergeCandidate[] = [...inputCandidates];
  const usedCandIds = new Set(activePoolCandidates.map((c) => c.id));
  const existingLeafTargetKeys = new Set(
    activePoolCandidates.map(
      (c) => `${expandCandidateFineLeaves(c).join(',')}->${c.targetEntityId ?? c.targetLabel ?? ''}`
    )
  );
  const existingCohortLeafSets = new Set<string>();
  for (const c of activePoolCandidates) {
    if (!c.targetEntityId || activeDescendantsByZeroHub.has(c.targetEntityId)) {
      const leaves = expandCandidateFineLeaves(c);
      if (leaves.length >= 2) existingCohortLeafSets.add(leaves.join(','));
    }
  }

  const peeledAuxByCandId = new Map<
    string,
    { auxCand: VTALaneMergeCandidate; peeledOutIds: string[] }
  >();
  for (const c of inputCandidates) {
    const isZeroTarget = Boolean(
      c.targetEntityId && activeDescendantsByZeroHub.has(c.targetEntityId)
    );
    if (
      c.sourceEntityIds.length < 3 ||
      isPeripheralAggregateId(c.targetEntityId) ||
      (isZeroTarget && !c.recommended)
    ) {
      continue;
    }
    const fineSrcs = c.sourceEntityIds.filter((sid) => finePartsByEnt.has(sid));
    if (fineSrcs.length < 3) continue;
    const peelActivityWeight = (uid: string): number =>
      (rankScoreById.get(uid) ?? 0) +
      0.12 * (totalEventsById.get(uid) ?? 0) +
      0.08 * (actorCountById.get(uid) ?? 0);
    const sortedScores = fineSrcs
      .map((sid) => rankScoreById.get(sid) ?? 0)
      .sort((a, b) => a - b);
    const sortedActivities = fineSrcs.map((sid) => peelActivityWeight(sid)).sort((a, b) => a - b);
    const medianScore = sortedScores[Math.floor(sortedScores.length / 2)];
    const medianActivity = sortedActivities[Math.floor(sortedActivities.length / 2)];
    const peeledOut: string[] = [];
    const peeled: string[] = [];
    for (const sid of c.sourceEntityIds) {
      const s = rankScoreById.get(sid) ?? 0;
      const actW = peelActivityWeight(sid);
      if (s >= 0.48 && (s - medianScore >= 0.2 || actW - medianActivity >= 0.55)) {
        peeledOut.push(sid);
      } else {
        peeled.push(sid);
      }
    }
    const convertZeroHubToNewComposite = isZeroTarget;
    if (
      peeledOut.length === 0 ||
      (!convertZeroHubToNewComposite && c.targetEntityId ? peeled.length < 1 : peeled.length < 2)
    ) {
      continue;
    }
    const peeledOutNames = peeledOut
      .map((sid) => fineEntById.get(sid)?.name ?? sid)
      .slice(0, 2)
      .join('・');
    const baseTargetName =
      c.targetLabel ??
      (c.targetEntityId ? fineEntById.get(c.targetEntityId)?.name : undefined) ??
      'グループ';
    const auxId = `${c.id}_aux`;
    const peeledCand: VTALaneMergeCandidate = {
      ...c,
      id: usedCandIds.has(auxId) ? `${auxId}_${usedCandIds.size + 1}` : auxId,
      ...(convertZeroHubToNewComposite
        ? {
            kind: 'role_group',
            targetEntityId: undefined,
            targetLabel: `${baseTargetName}（${peeledOutNames}を除く）`,
          }
        : !c.targetEntityId
          ? { targetLabel: `${baseTargetName}（${peeledOutNames}を除く）` }
          : {}),
      sourceEntityIds: peeled,
      recommended: false,
      semanticCost: Number(
        Math.max(0.03, c.semanticCost * (peeled.length / c.sourceEntityIds.length) * 0.75).toFixed(3)
      ),
      reason: `${c.reason}（主要当事者を独立維持した別構成主体 P'）`,
    };
    const key = `${expandCandidateFineLeaves(peeledCand).join(',')}->${peeledCand.targetEntityId ?? peeledCand.targetLabel ?? ''}`;
    if (!existingLeafTargetKeys.has(key)) {
      existingLeafTargetKeys.add(key);
      usedCandIds.add(peeledCand.id);
      activePoolCandidates.push(peeledCand);
      peeledAuxByCandId.set(c.id, { auxCand: peeledCand, peeledOutIds: peeledOut });
    }
  }

  const activeDescCountByHub = new Map<string, number>();
  for (const ent of fineBase.entities) {
    const cnt = sortedFineIds.filter((fid) => fid !== ent.id && poset.isAncestor(ent.id, fid)).length;
    activeDescCountByHub.set(ent.id, cnt);
  }
  const isCoreCohortProtagonist = (fid: string): boolean => {
    if (pinned.has(fid)) return true;
    const ent = fineEntById.get(fid);
    if (!ent || ent.kind === 'machine') return false;
    return ent.focus === 'reporter' || ent.focus === 'high';
  };
  const hasUnseparatedCoreDescendant = (fid: string): boolean => {
    const myCnt = activeDescCountByHub.get(fid) ?? 0;
    return sortedFineIds.some((pid) => {
      if (pid === fid || !poset.isAncestor(fid, pid) || !isCoreCohortProtagonist(pid)) return false;
      const separated = Array.from(poset.getAncestors(pid)).some(
        (mid) =>
          mid !== pid &&
          mid !== fid &&
          poset.isAncestor(fid, mid) &&
          !finePartsByEnt.has(mid) &&
          (activeDescCountByHub.get(mid) ?? 0) >= 2 &&
          (activeDescCountByHub.get(mid) ?? 0) < myCnt
      );
      return !separated;
    });
  };

  let synCohortSeq = 1;
  for (const hub of fineBase.entities) {
    if (hub.kind === 'person' || finePartsByEnt.has(hub.id)) continue;
    const descs = sortedFineIds.filter((fid) => fid !== hub.id && poset.isAncestor(hub.id, fid));
    if (descs.length < 3) continue;
    const auxAll = descs.filter(
      (fid) => !isCoreCohortProtagonist(fid) && !hasUnseparatedCoreDescendant(fid)
    );
    if (auxAll.length < 2 || auxAll.length >= descs.length) continue;

    const lossPool = auxAll.filter((fid) => isLossDirectEntity(fid));
    const nonLossPool = auxAll.filter((fid) => !isLossDirectEntity(fid));
    for (const [poolIdx, rawPool] of [lossPool, nonLossPool].entries()) {
      if (rawPool.length < 2 || rawPool.length > 6) continue;
      const sortedByWeight = [...rawPool].sort(
        (a, b) => (rankScoreById.get(a) ?? 0) - (rankScoreById.get(b) ?? 0)
      );
      const compat: string[] = [];
      for (const candFid of sortedByWeight) {
        const hasHardConflict = compat.some((existing) =>
          hardSepPairs.some(
            ([a, b]) => (a === candFid && b === existing) || (a === existing && b === candFid)
          )
        );
        if (!hasHardConflict) compat.push(candFid);
      }
      if (compat.length < 2) continue;
      const leafKey = [...compat].sort().join(',');
      if (existingCohortLeafSets.has(leafKey)) continue;

      const meanScore =
        compat.reduce((acc, u) => acc + (rankScoreById.get(u) ?? 0), 0) / compat.length;
      const compatSet = new Set(compat);
      let interRelWeight = 0;
      for (const inter of crossInteractions) {
        if (compatSet.has(inter.srcEnt) && compatSet.has(inter.tgtEnt)) {
          interRelWeight += inter.weight;
        }
      }
      const posetInfo = measureCommonAncestorDistance(poset, compat, SUBJECT_OTHERS_ID);
      const posetDelta = Number.isFinite(posetInfo.averageCommonAncestorDepth)
        ? Math.min(0.04, Math.max(0, 0.015 * (posetInfo.averageCommonAncestorDepth - 1)))
        : 0.04;
      const unitCost = Math.min(
        0.45,
        Math.max(0.26, 0.24 + 0.22 * meanScore + posetDelta + 0.03 * interRelWeight)
      );
      const reduced = Math.max(1, compat.length - 1);
      const semanticCost = Number(Math.min(0.92, unitCost * reduced).toFixed(3));

      let synId = `SYN_COHORT_${synCohortSeq++}`;
      while (usedCandIds.has(synId)) synId = `SYN_COHORT_${synCohortSeq++}`;
      usedCandIds.add(synId);
      existingCohortLeafSets.add(leafKey);

      const synLabel =
        compat.length === 2
          ? `${fineEntById.get(compat[0])?.name ?? compat[0]}・${fineEntById.get(compat[1])?.name ?? compat[1]}`
          : `${hub.name}（${poolIdx === 0 ? '同乗・被災担当' : '補助・関係部門'}）`;

      activePoolCandidates.push({
        id: synId,
        kind: 'role_group',
        sourceEntityIds: [...compat].sort(),
        targetLabel: synLabel,
        targetKind: 'organization',
        semanticCost,
        reason: `上位枠「${hub.name}」配下の非主要メンバー群（${compat.length}主体）の補助グループ統合`,
        origin: 'poset_fallback',
        recommended: false,
      });
    }

    // Synthesize nested 2nd-stage merge over disjoint [推奨統合] subgroups sharing `hub` (e.g. M3 + M4 -> SYN_2ND_*)
    // when LLM omitted [予備候補], preserving M3 and M4 as sealed child nodes in the forest!
    const recSubgroupsUnderHub = inputCandidates.filter((c) => {
      if (!c.recommended || c.origin !== 'llm' || Boolean(c.targetEntityId)) {
        return false;
      }
      const leaves = expandCandidateFineLeaves(c);
      return (
        leaves.length >= 2 &&
        leaves.length < descs.length &&
        leaves.every(
          (lid) =>
            poset.isAncestor(hub.id, lid) &&
            !isCoreCohortProtagonist(lid) &&
            !hasUnseparatedCoreDescendant(lid)
        )
      );
    });
    for (let i = 0; i < recSubgroupsUnderHub.length; i++) {
      for (let j = i + 1; j < recSubgroupsUnderHub.length; j++) {
        const g1 = recSubgroupsUnderHub[i];
        const g2 = recSubgroupsUnderHub[j];
        const l1 = expandCandidateFineLeaves(g1);
        const l2 = expandCandidateFineLeaves(g2);
        if (l1.some((x) => l2.includes(x))) continue;
        if (isLossDirectEntity(l1[0]) !== isLossDirectEntity(l2[0])) continue;
        const unionLeaves = [...l1, ...l2].sort();
        const hasHard = l1.some((a) =>
          l2.some((b) =>
            hardSepPairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a))
          )
        );
        if (hasHard) continue;
        const pairCandKey = `${[g1.id, g2.id].sort().join(',')}->`;
        if (existingLeafTargetKeys.has(pairCandKey)) continue;
        existingLeafTargetKeys.add(pairCandKey);

        let syn2Id = `SYN_2ND_${synCohortSeq++}`;
        while (usedCandIds.has(syn2Id)) syn2Id = `SYN_2ND_${synCohortSeq++}`;
        usedCandIds.add(syn2Id);
        const label1 = g1.targetLabel ?? (g1.targetEntityId ? fineEntById.get(g1.targetEntityId)?.name : undefined) ?? g1.id;
        const label2 = g2.targetLabel ?? (g2.targetEntityId ? fineEntById.get(g2.targetEntityId)?.name : undefined) ?? g2.id;
        activePoolCandidates.push({
          id: syn2Id,
          kind: 'role_group',
          sourceEntityIds: [g1.id, g2.id],
          targetLabel: `${label1}・${label2}`,
          targetKind: 'organization',
          semanticCost: 0.38,
          reason: `同一上位枠「${hub.name}」配下の推奨サブグループ対（${label1}・${label2}）の2段階入れ子統合`,
          origin: 'poset_fallback',
          recommended: false,
        });
      }
    }
  }

  // (3) Root-level new-parent discovery over Poset-incomparable interacting auxiliary units (`SYN_COUPLED_*`, Stage 3 B-1 ③):
  //     Allows non-protagonist operational roots with no common Poset ancestor (e.g. 東京飛行場管制所 auxiliary seats
  //     and 東京進入管制所) to form a discovered parent when directly coupled by semantic handoff/dependency relations.
  interface CoupledRootUnit {
    token: string;
    name: string;
    leaves: string[];
  }
  const coupledRootUnits: CoupledRootUnit[] = [];
  const seenUnitLeafKeys = new Set<string>();
  const pushCoupledUnit = (token: string, name: string, leaves: readonly string[]) => {
    const sorted = [...new Set(leaves)].sort();
    if (sorted.length === 0) return;
    if (
      sorted.some(
        (lid) => pinned.has(lid) || isCoreCohortProtagonist(lid) || isLossDirectEntity(lid)
      )
    ) {
      return;
    }
    const key = sorted.join(',');
    if (seenUnitLeafKeys.has(key)) return;
    seenUnitLeafKeys.add(key);
    coupledRootUnits.push({ token, name, leaves: sorted });
  };

  for (const [hid, descs] of activeDescendantsByZeroHub) {
    const hEnt = fineEntById.get(hid);
    if (!hEnt || hEnt.kind === 'person' || descs.length < 2) continue;
    pushCoupledUnit(hid, hEnt.name, descs);
  }
  for (const cand of activePoolCandidates) {
    if (isPeripheralAggregateId(cand.targetEntityId) || cand.kind === 'peripheral_others') continue;
    const leaves = expandCandidateFineLeaves(cand);
    const fullLeaves =
      cand.targetEntityId && finePartsByEnt.has(cand.targetEntityId)
        ? [...new Set([...leaves, cand.targetEntityId])]
        : leaves;
    if (fullLeaves.length < 2) continue;
    const tok = cand.targetEntityId ?? cand.id;
    const label =
      cand.targetLabel ??
      (cand.targetEntityId ? fineEntById.get(cand.targetEntityId)?.name : undefined) ??
      cand.id;
    pushCoupledUnit(tok, label, fullLeaves);
  }
  for (const fid of sortedFineIds) {
    const ent = fineEntById.get(fid);
    if (!ent) continue;
    const hasPosetAnc = Array.from(poset.getAncestors(fid)).some(
      (aid) => aid !== fid && (finePartsByEnt.has(aid) || (activeDescendantsByZeroHub.get(aid)?.length ?? 0) >= 2)
    );
    if (!hasPosetAnc) {
      pushCoupledUnit(fid, ent.name, [fid]);
    }
  }

  const synCoupledDrafts: Array<{
    u1: CoupledRootUnit;
    u2: CoupledRootUnit;
    cost: number;
    relW: number;
  }> = [];
  for (let i = 0; i < coupledRootUnits.length; i++) {
    for (let j = i + 1; j < coupledRootUnits.length; j++) {
      const u1 = coupledRootUnits[i];
      const u2 = coupledRootUnits[j];
      if (u1.leaves.some((x) => u2.leaves.includes(x))) continue;
      const unionLeaves = [...u1.leaves, ...u2.leaves].sort();
      if (existingCohortLeafSets.has(unionLeaves.join(','))) continue;
      // Must be Poset-incomparable with NO common Poset ancestor (shared-ancestor cohorts are handled by poset_rollup / SYN_COHORT)
      const ancInfo = measureCommonAncestorDistance(poset, unionLeaves, SUBJECT_OTHERS_ID);
      if (ancInfo.minimalCommonAncestors.length > 0) continue;
      const hasComparablePair = u1.leaves.some((a) =>
        u2.leaves.some((b) => poset.isAncestor(a, b) || poset.isAncestor(b, a))
      );
      if (hasComparablePair) continue;

      let relW = 0;
      for (const a of u1.leaves) {
        for (const b of u2.leaves) {
          relW += pairInteractionWeight.get(makeEntPairKey(a, b)) ?? 0;
        }
      }
      if (relW <= 0) continue;

      const hasHard = u1.leaves.some((a) =>
        u2.leaves.some((b) =>
          hardSepPairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a))
        )
      );
      if (hasHard) continue;
      if (!evaluateMergeGuard(u1.leaves[0], u2.leaves[0], fineGuardAnalysis).allowed) continue;

      const meanS =
        unionLeaves.reduce((acc, lid) => acc + (rankScoreById.get(lid) ?? 0), 0) /
        unionLeaves.length;
      const cost = Number(
        Math.min(0.46, Math.max(0.28, 0.34 + 0.2 * meanS - 0.04 * Math.min(3, relW))).toFixed(3)
      );
      synCoupledDrafts.push({ u1, u2, cost, relW });
    }
  }
  synCoupledDrafts.sort((a, b) => a.cost - b.cost || b.relW - a.relW);
  for (const item of synCoupledDrafts.slice(0, 4)) {
    const pairKey = `${[item.u1.token, item.u2.token].sort().join(',')}->`;
    if (existingLeafTargetKeys.has(pairKey)) continue;
    existingLeafTargetKeys.add(pairKey);
    let synId = `SYN_COUPLED_${synCohortSeq++}`;
    while (usedCandIds.has(synId)) synId = `SYN_COUPLED_${synCohortSeq++}`;
    usedCandIds.add(synId);
    activePoolCandidates.push({
      id: synId,
      kind: 'role_group',
      sourceEntityIds: [item.u1.token, item.u2.token],
      targetLabel: `${item.u1.name}・${item.u2.name}`,
      targetKind: 'organization',
      semanticCost: item.cost,
      reason: `直接相互作用（W=${item.relW.toFixed(1)}）を持つ非包含補助単位対の新規上位親統合`,
      origin: 'poset_fallback',
      recommended: false,
    });
  }

  /**
   * Root-level cohesion-weighted salience information loss c_info(R) (Stage 3 Item B-2):
   * Penalizes under-priced crushing of multiple non-cohesive high-salience cohorts (e.g. 11 B-aircraft entities
   * spanning flight deck + cabin evacuation + passengers) into a single lane, while keeping cohesive pairs
   * (high event overlap / relation density) and already fairly-priced merges penalty-free via C2's lower-bound envelope.
   */
  const computeRootCohesionInfoPenalty = (rootComp: CompositeForestNode): number => {
    if (rootComp.aggregate || rootComp.leafIds.length < 2) return 0;
    if (rootComp.coreEntityId && cleanManMachineZeroHubIds.has(rootComp.coreEntityId)) {
      return 0;
    }
    const salientLeaves = rootComp.leafIds.filter((lid) => !passiveEntityIds.has(lid));
    if (salientLeaves.length < 2) return 0;

    const leaves = rootComp.leafIds;
    const n = leaves.length;
    let overlapSum = 0;
    let pairCount = 0;
    let internalRelW = 0;
    for (let i = 0; i < n; i++) {
      const evA = fineEventSetByEnt.get(leaves[i]);
      for (let j = i + 1; j < n; j++) {
        pairCount++;
        const evB = fineEventSetByEnt.get(leaves[j]);
        if (evA && evB && evA.size > 0 && evB.size > 0) {
          const smaller = evA.size <= evB.size ? evA : evB;
          const larger = evA.size <= evB.size ? evB : evA;
          let inter = 0;
          for (const eid of smaller) {
            if (larger.has(eid)) inter++;
          }
          overlapSum += inter / smaller.size;
        }
        internalRelW += pairInteractionWeight.get(makeEntPairKey(leaves[i], leaves[j])) ?? 0;
      }
    }
    const meanOverlap = pairCount > 0 ? overlapSum / pairCount : 0;
    const relCohesion = 1 - Math.exp((-0.5 * internalRelW) / Math.max(1, n - 1));
    const kappa = Math.min(1, 0.75 * meanOverlap + 0.45 * relCohesion);

    let sumSq = 0;
    let maxSq = 0;
    for (const lid of salientLeaves) {
      const s = rankScoreById.get(lid) ?? 0;
      const q = s * s;
      sumSq += q;
      if (q > maxSq) maxSq = q;
    }
    const lostSalienceEnergy = Math.max(0, sumSq - maxSq);
    return Math.min(0.88, 0.62 * (1 - kappa) * lostSalienceEnergy);
  };

  // Static per-entity peripheral others unit cost table for order-invariant symmetric `agg` load
  const othersUnitCostByEntity = new Map<string, number>();
  for (const cand of activePoolCandidates) {
    if (!isPeripheralAggregateId(cand.targetEntityId) && cand.kind !== 'peripheral_others') continue;
    const leaves = expandCandidateFineLeaves(cand);
    if (leaves.length === 0) continue;
    const reduced = Math.max(1, leaves.length > 1 ? leaves.length - 1 : 1);
    const unit = cand.semanticCost / reduced;
    for (const lid of leaves) {
      const prev = othersUnitCostByEntity.get(lid);
      if (prev === undefined || unit < prev) {
        othersUnitCostByEntity.set(lid, unit);
      }
    }
  }

  // Precompute pure-peripheral Poset subtrees & 0-event peripheral hubs for HG2d antichain closure
  const purePeripheralActiveDescendantsByRoot = new Map<string, string[]>();
  for (const uid of sortedFineIds) {
    if (!eligibleOthersSet.has(uid)) continue;
    const descs = sortedFineIds.filter((did) => did !== uid && poset.isAncestor(uid, did));
    if (descs.length > 0 && descs.every((did) => eligibleOthersSet.has(did))) {
      purePeripheralActiveDescendantsByRoot.set(uid, descs);
    }
  }
  const purePeripheralZeroHubDescs: string[][] = [];
  for (const [hid, descs] of activeDescendantsByZeroHub) {
    const hEnt = fineEntById.get(hid);
    if (!hEnt || hEnt.kind === 'person' || descs.length < 2) continue;
    if (descs.every((did) => eligibleOthersSet.has(did))) {
      purePeripheralZeroHubDescs.push(descs);
    }
  }

  const computeConsolidationObjective = (
    m: { c1: number; c2: number; c3: number; c4: number; c5: number },
    laneCount: number,
    convexLoad: number,
    softPen: number
  ): number => {
    const base = totalScore(m, weights);
    const excess = Math.max(0, laneCount - targetK);
    const convexExcessPenalty =
      0.032 * excess + (0.035 * excess * excess) / Math.max(4, targetK);
    return Number((base - convexExcessPenalty - 0.095 * convexLoad - 0.1 * softPen).toFixed(4));
  };

  // Pure Merkle-forest evaluator (100% path-independent, double-checking atomic partition invariant)
  const evaluateState = (
    forest: CompositeForestState,
    appliedCandidateIds: string[]
  ): SearchState | null => {
    assertAtomicPartitionInvariant(forest);

    const rootIds = getForestRootIds(forest);
    const L = rootIds.length;
    if (fineLaneCount >= 2 && L < 2) return null;

    const assignment = buildAtomicRootAssignment(forest);

    // HG1: Pinned entities must stay alone as unmerged atomic roots
    for (const pid of pinned) {
      if (!finePartsByEnt.has(pid)) continue;
      if (!isForestRoot(forest, pid) || assignment.get(pid) !== pid) {
        return null;
      }
    }

    // HG1b: Hard separation pairs must not share a root lane
    for (const [a, b] of hardSepPairs) {
      const ba = assignment.get(a);
      const bb = assignment.get(b);
      if (ba && bb && ba === bb) return null;
    }

    // HG2, HG2b, HG2c & HG2d: Validate all composites (aggregate >=2, eligible, & Poset branch closure; 0-event hub completeness)
    for (const comp of forest.composites.values()) {
      if (comp.compositeOf.length < 2 || comp.leafIds.length < 2) return null;
      if (comp.aggregate) {
        if (comp.leafIds.some((lid) => !eligibleOthersSet.has(lid))) return null;
        const aggLeafSet = new Set(comp.leafIds);
        for (const lid of comp.leafIds) {
          // HG2d-1: Never place a child in `cmp_agg_*` while its active Poset ancestor stays as a named lane outside `cmp_agg_*`
          for (const ancId of poset.getAncestors(lid)) {
            if (ancId !== lid && forest.atomicSet.has(ancId) && !aggLeafSet.has(ancId)) {
              return null;
            }
          }
          // HG2d-2: Pure-peripheral active subtree head cannot enter `cmp_agg_*` leaving its peripheral children stranded outside
          const reqSubtree = purePeripheralActiveDescendantsByRoot.get(lid);
          if (reqSubtree && reqSubtree.some((did) => !aggLeafSet.has(did))) {
            return null;
          }
        }
        // HG2d-3: Pure-peripheral 0-event hub descendants move into `cmp_agg_*` all-or-nothing
        for (const zDescs of purePeripheralZeroHubDescs) {
          const anyInAgg = zDescs.some((did) => aggLeafSet.has(did));
          if (anyInAgg && zDescs.some((did) => !aggLeafSet.has(did))) {
            return null;
          }
        }
        // HG2e: `cmp_agg_*` ("その他の関係者") must span >= 2 unrelated peripheral Poset branches;
        // if a single existing non-person Poset entity H covers 100% of `comp.leafIds`, that group IS H, not "その他の関係者"!
        const coveredBySingleRealHub = fineBase.entities.some(
          (h) =>
            h.kind !== 'person' &&
            comp.leafIds.every((lid) => lid === h.id || poset.isAncestor(h.id, lid))
        );
        if (coveredBySingleRealHub) return null;
      }
      if (comp.coreEntityId && activeDescendantsByZeroHub.has(comp.coreEntityId)) {
        const reqDescs = activeDescendantsByZeroHub.get(comp.coreEntityId)!;
        const leafSet = new Set(comp.leafIds);
        if (reqDescs.length !== comp.leafIds.length || reqDescs.some((did) => !leafSet.has(did))) {
          return null;
        }
      }
    }

    // HG3 & HG3b: Outcome visibility & prevent outcome from being stranded solely on peripheral aggregate
    const bucketEvents = new Map<string, Set<string>>();
    for (const rid of rootIds) {
      const evSet = new Set<string>();
      for (const lid of getNodeLeafIds(forest, rid)) {
        for (const p of finePartsByEnt.get(lid) ?? []) {
          evSet.add(p.eventId);
        }
      }
      bucketEvents.set(rid, evSet);
    }
    for (const outId of outcomeEventIds) {
      const outParts = fineBase.participations.filter(
        (p) => p.eventId === outId && finePartsByEnt.has(p.entityId)
      );
      if (outParts.length > 0) {
        let shown = false;
        let shownOutsideOthers = false;
        for (const [rid, evSet] of bucketEvents) {
          if (evSet.has(outId)) {
            shown = true;
            if (!forest.composites.get(rid)?.aggregate) shownOutsideOthers = true;
          }
        }
        if (!shown) return null;
        const hadNonOtherParticipant = outParts.some(
          (p) => fineEntById.get(p.entityId)?.kind !== 'other'
        );
        if (hadNonOtherParticipant && !shownOutsideOthers) return null;
      }
    }

    // C1: Lane count fitness peaking at targetK
    let c1 = 1.0;
    if (L > targetK) {
      const excess = L - targetK;
      c1 = 1 / (1 + 0.28 * excess + 0.05 * excess * excess);
    } else if (L < targetK && L < fineLaneCount) {
      c1 = Math.max(0.2, 1 - 0.08 * (targetK - L));
    }

    // Soft separation & resilient-defender penalties
    let softPenalty = 0;
    for (const [a, b] of llmSoftSepPairs) {
      const ba = assignment.get(a);
      const bb = assignment.get(b);
      if (ba && bb && ba === bb) softPenalty += 0.14;
    }
    if (structuralSoftSepPairs.length > 0) {
      const structSoftByBucket = new Map<string, number>();
      for (const [a, b] of structuralSoftSepPairs) {
        const ba = assignment.get(a);
        const bb = assignment.get(b);
        if (ba && bb && ba === bb) {
          structSoftByBucket.set(ba, (structSoftByBucket.get(ba) ?? 0) + 1);
        }
      }
      for (const cnt of structSoftByBucket.values()) {
        softPenalty += Math.min(0.28, cnt * 0.14);
      }
    }
    for (const resEvId of resilientEventIds) {
      const hostingBuckets: string[] = [];
      for (const [rid, evSet] of bucketEvents) {
        if (evSet.has(resEvId)) hostingBuckets.push(rid);
      }
      if (hostingBuckets.length > 0 && hostingBuckets.every((rid) => pureAdverseIds.has(rid))) {
        softPenalty += 0.35;
      }
    }

    // Stage 3 Item C: Causal adverse variation visibility penalty (extending HG3b to causal variations)
    if (forest.aggregateRootId && causalAdverseVariationIds.length > 0) {
      let actorDilutionPen = 0;
      for (const varEvId of causalAdverseVariationIds) {
        let shownOnAgg = false;
        let shownOutsideAgg = false;
        for (const [rid, evSet] of bucketEvents) {
          if (!evSet.has(varEvId)) continue;
          if (rid === forest.aggregateRootId) shownOnAgg = true;
          else shownOutsideAgg = true;
        }
        if (shownOnAgg && !shownOutsideAgg) {
          // Entire causal adverse variation card stranded solely on "その他の関係者" (loses sequential causal spine)
          softPenalty += 0.24;
        } else if (shownOnAgg) {
          const actors = actorsByCausalVariation.get(varEvId) ?? [];
          if (actors.length > 0 && actors.every((aid) => assignment.get(aid) === forest.aggregateRootId)) {
            actorDilutionPen += 0.04;
          }
        }
      }
      softPenalty += Math.min(0.08, actorDilutionPen);
    }

    // C2: Pure tree-based convex semantic load over internal composite nodes + root protagonist & cohesion envelopes
    let convexSemanticLoad = 0;
    const paidLeafLoad = new Map<string, number>();
    const paidRootSubtreeLoad = new Map<string, number>();
    for (const comp of forest.composites.values()) {
      convexSemanticLoad += comp.intrinsicConvexLoad;
      const rootOfComp = findRootOfAtomic(forest, comp.leafIds[0]);
      paidRootSubtreeLoad.set(
        rootOfComp,
        (paidRootSubtreeLoad.get(rootOfComp) ?? 0) + comp.intrinsicConvexLoad
      );
      const nonCoreLeaves = comp.leafIds.filter((lid) => lid !== comp.coreEntityId);
      const perLeafShare =
        nonCoreLeaves.length > 0 ? comp.intrinsicConvexLoad / nonCoreLeaves.length : 0;
      for (const lid of nonCoreLeaves) {
        paidLeafLoad.set(lid, (paidLeafLoad.get(lid) ?? 0) + perLeafShare);
      }
    }
    for (const rid of rootIds) {
      const rootComp = forest.composites.get(rid);
      if (!rootComp || rootComp.aggregate) continue;
      let rootTopUp = 0;
      for (const lid of rootComp.leafIds) {
        if (lid === rootComp.coreEntityId) continue;
        const subPen = computeInclusionPenalty(lid, rootComp);
        if (subPen > 0) {
          const minRequiredLoad = moveConvexCost(subPen);
          const alreadyPaid = paidLeafLoad.get(lid) ?? 0;
          if (minRequiredLoad > alreadyPaid) {
            rootTopUp += minRequiredLoad - alreadyPaid;
          }
        }
      }
      convexSemanticLoad += rootTopUp;

      const infoPen = computeRootCohesionInfoPenalty(rootComp);
      if (infoPen > 0) {
        const minInfoLoad = moveConvexCost(infoPen);
        const effectiveRootLoad = (paidRootSubtreeLoad.get(rid) ?? 0) + rootTopUp;
        if (minInfoLoad > effectiveRootLoad) {
          convexSemanticLoad += minInfoLoad - effectiveRootLoad;
        }
      }
    }
    const c2 = 1 / (1 + 0.55 * convexSemanticLoad + softPenalty);

    // C3: Cross-lane interaction preservation
    let preservedWeight = 0;
    for (const inter of crossInteractions) {
      if (assignment.get(inter.srcEnt) !== assignment.get(inter.tgtEnt)) {
        preservedWeight += inter.weight;
      }
    }
    const interactionRetention =
      totalInteractionWeight > 0 ? preservedWeight / totalInteractionWeight : 1.0;
    const c3 = Math.max(0, Math.min(1, 0.35 + 0.65 * interactionRetention));

    // C4: Boundary cleanliness
    let unmergedPassiveCount = 0;
    for (const pid of passiveEntityIds) {
      if (isForestRoot(forest, pid)) {
        unmergedPassiveCount++;
      }
    }
    const c4 = Math.max(0, 1 - (L > targetK ? 0.18 : 0.06) * unmergedPassiveCount);

    // C5: Card density & max lane height after shared-event deduplication per root
    let totalCards = 0;
    let maxLaneCards = 0;
    for (const [rid, evSet] of bucketEvents) {
      totalCards += evSet.size;
      if (!forest.composites.get(rid)?.aggregate && evSet.size > maxLaneCards) {
        maxLaneCards = evSet.size;
      }
    }
    const targetMaxCards = Math.max(24, Math.ceil(activeEvs.length * 1.15));
    const targetMaxLaneNodes = Math.max(12, Math.ceil((activeEvs.length / Math.max(2, targetK)) * 2.2));
    const cardExcess = Math.max(0, totalCards - targetMaxCards) / targetMaxCards;
    const laneHeightExcess = Math.max(0, maxLaneCards - targetMaxLaneNodes) / targetMaxLaneNodes;
    const c5 = Math.max(0, Math.min(1, 1 - 0.5 * cardExcess - 0.5 * laneHeightExcess));

    const roundedMetrics = {
      c1: Number(c1.toFixed(4)),
      c2: Number(c2.toFixed(4)),
      c3: Number(c3.toFixed(4)),
      c4: Number(c4.toFixed(4)),
      c5: Number(c5.toFixed(4)),
      interactionRetention: Number(interactionRetention.toFixed(4)),
    };
    const displayScore = totalScore(roundedMetrics, weights);
    const objective = computeConsolidationObjective(
      roundedMetrics,
      L,
      convexSemanticLoad,
      softPenalty
    );
    return {
      forest,
      assignment,
      appliedCandidateIds,
      convexSemanticLoad,
      softPenalty,
      signature: computeForestSignature(forest),
      score: displayScore,
      objective,
      metrics: roundedMetrics,
      laneCount: L,
    };
  };

  const initialState = evaluateState(initForest, [])!;
  let evaluatedStates = 1;

  if (fineLaneCount <= targetK && passiveEntityIds.size === 0) {
    const consolidation: VTALaneConsolidationState = {
      version: 1,
      targetMaxSubjects: targetK,
      appliedCandidateIds: [],
      laneAssignment: Object.fromEntries(initialState.assignment),
      score: initialState.score,
      metrics: initialState.metrics,
      candidates: [...activePoolCandidates],
      separationConstraints: [...separationConstraints],
    };
    const bestSchema = projectForestToSchema(
      fineBase,
      baseAnalysis,
      initialState.forest,
      consolidation,
      options?.previousSchema
    );
    return {
      bestSchema,
      consolidation,
      fineLaneCount,
      finalLaneCount: visibleSchema(bestSchema).lanes.length,
      evaluatedStates,
    };
  }

  const expandTokenFineLeaves = (tok: string, seenCands = new Set<string>()): string[] => {
    if (finePartsByEnt.has(tok)) return [tok];
    if (activeDescendantsByZeroHub.has(tok)) {
      return [...(activeDescendantsByZeroHub.get(tok) ?? [])];
    }
    const refCand = inputCandById.get(tok);
    if (refCand && !seenCands.has(refCand.id)) {
      const nextSeen = new Set(seenCands);
      nextSeen.add(refCand.id);
      const out = new Set<string>();
      for (const d of expandCandidateFineLeaves(refCand, nextSeen)) out.add(d);
      if (refCand.targetEntityId && finePartsByEnt.has(refCand.targetEntityId)) {
        out.add(refCand.targetEntityId);
      }
      return Array.from(out);
    }
    return [];
  };

  /**
   * Resolves `sourceTokens` to current roots in `workingForest` under the Exact Root Cover invariant:
   * Every touched root R must be a current root AND 100% of R's leaves must lie within the union of requested leaves.
   * Never splits a sealed composite and never silently drags external leaves!
   */
  const resolveExactCoverRoots = (
    workingForest: CompositeForestState,
    sourceTokens: readonly string[],
    alreadyIncludedRoots?: ReadonlySet<string>,
    allowSealedRootExactCover: boolean = false
  ): string[] | null => {
    const directRoots: string[] = [];
    const seenRoots = new Set<string>(alreadyIncludedRoots);
    const fallbackLeaves = new Set<string>();

    for (const tok of sourceTokens) {
      const direct = resolveSourceTokenToRoot(workingForest, tok);
      if (direct) {
        if (!seenRoots.has(direct)) {
          seenRoots.add(direct);
          directRoots.push(direct);
        }
        for (const lid of getNodeLeafIds(workingForest, direct)) {
          fallbackLeaves.add(lid);
        }
        continue;
      }
      if (!allowSealedRootExactCover || !finePartsByEnt.has(tok)) {
        return null;
      }
      fallbackLeaves.add(tok);
    }

    const coveredViaFallback: string[] = [];
    for (const lid of fallbackLeaves) {
      const r = findRootOfAtomic(workingForest, lid);
      if (!isForestRoot(workingForest, r)) return null;
      if (seenRoots.has(r)) continue;
      // Exact Root Cover check: 100% of r's leaves must be in fallbackLeaves!
      const rLeaves = getNodeLeafIds(workingForest, r);
      if (rLeaves.length === 0 || rLeaves.some((rl) => !fallbackLeaves.has(rl))) {
        return null;
      }
      seenRoots.add(r);
      coveredViaFallback.push(r);
    }

    const allResolved = [...directRoots, ...coveredViaFallback];
    return allResolved.length > 0 ? allResolved : null;
  };

  // Root-only forest transition operator (strictly via Merge and Unmerge; never mutates existing nodes!)
  const applyCandidatesToForest = (
    base: SearchState,
    moves: readonly VTALaneMergeCandidate[]
  ): {
    forest: CompositeForestState;
    appliedIds: string[];
  } | null => {
    if (moves.length === 0) return null;

    // Batch Case A: Multiple 1-entity peripheral_others moves -> single symmetric Merge/Rebuild on aggregate root
    if (
      moves.length >= 2 &&
      moves.every(
        (m) => m.kind === 'peripheral_others' || isPeripheralAggregateId(m.targetEntityId)
      )
    ) {
      let curForest = base.forest;
      let existingChildren: string[] = [];
      if (curForest.aggregateRootId) {
        const unmerged = unmergeForestRoot(curForest, curForest.aggregateRootId);
        if (!unmerged) return null;
        curForest = unmerged.state;
        existingChildren = [...unmerged.restoredChildIds];
      }
      const newRoots: string[] = [];
      const seenNew = new Set<string>(existingChildren);
      const batchIds: string[] = [];
      for (const m of moves) {
        const resolved = resolveExactCoverRoots(curForest, m.sourceEntityIds, seenNew, true);
        if (!resolved || resolved.length === 0) continue;
        for (const r of resolved) {
          const leaves = getNodeLeafIds(curForest, r);
          if (leaves.some((lid) => pinned.has(lid) || !eligibleOthersSet.has(lid))) {
            return null;
          }
          seenNew.add(r);
          newRoots.push(r);
        }
        batchIds.push(m.id);
      }
      if (newRoots.length === 0) return null;
      const allAggChildren = [...existingChildren, ...newRoots];
      if (allAggChildren.length < 2) return null;
      const k = allAggChildren.length;
      let rawSum = 0;
      let nominalSum = 0;
      for (const cid of allAggChildren) {
        const cLeaves = getNodeLeafIds(curForest, cid);
        const uCost =
          cLeaves.length > 0
            ? cLeaves.reduce((acc, lid) => acc + (othersUnitCostByEntity.get(lid) ?? 0.06), 0) /
              cLeaves.length
            : 0.06;
        nominalSum += uCost;
        rawSum += ((k - 1) / k) * moveConvexCost(uCost);
      }
      const merged = mergeForestRoots(curForest, compositeRegistry, allAggChildren, {
        mode: 'agg',
        displayName: OTHER_ACTORS_ENTITY_NAME,
        kind: 'other',
        stepSemanticCost: Number(nominalSum.toFixed(3)),
        intrinsicConvexLoad: rawSum,
      });
      if (!merged) return null;
      return {
        forest: merged.state,
        appliedIds: [...base.appliedCandidateIds, ...batchIds],
      };
    }

    // Batch Case B: Multiple 1-entity poset_rollup moves targeting the same Poset ancestor T
    if (
      moves.length >= 2 &&
      moves[0].targetEntityId &&
      !isPeripheralAggregateId(moves[0].targetEntityId) &&
      moves.every((m) => m.targetEntityId === moves[0].targetEntityId)
    ) {
      const combinedSources: string[] = [];
      let combinedCost = 0;
      const batchIds: string[] = [];
      for (const m of moves) {
        combinedSources.push(...m.sourceEntityIds);
        combinedCost += m.semanticCost;
        batchIds.push(m.id);
      }
      const syntheticBundle: VTALaneMergeCandidate = {
        ...moves[0],
        id: batchIds[batchIds.length - 1],
        sourceEntityIds: Array.from(new Set(combinedSources)),
        semanticCost: Number(combinedCost.toFixed(3)),
      };
      const singleRes = applyCandidatesToForest(base, [syntheticBundle]);
      if (!singleRes) return null;
      return {
        forest: singleRes.forest,
        appliedIds: [...base.appliedCandidateIds, ...batchIds],
      };
    }

    let curForest = base.forest;
    const addedIds: string[] = [];

    for (const m of moves) {
      const isAggTarget =
        m.kind === 'peripheral_others' || isPeripheralAggregateId(m.targetEntityId);

      // 1) Peripheral aggregate ("その他の関係者") via Merge / Unmerge+Merge
      if (isAggTarget) {
        let workingForest = curForest;
        let existingChildren: string[] = [];
        if (workingForest.aggregateRootId) {
          const unmerged = unmergeForestRoot(workingForest, workingForest.aggregateRootId);
          if (!unmerged) return null;
          workingForest = unmerged.state;
          existingChildren = [...unmerged.restoredChildIds];
        }
        const incomingRoots = resolveExactCoverRoots(
          workingForest,
          m.sourceEntityIds,
          new Set(existingChildren),
          true
        );
        if (!incomingRoots || incomingRoots.length === 0) return null;
        for (const r of incomingRoots) {
          const leaves = getNodeLeafIds(workingForest, r);
          if (leaves.some((lid) => pinned.has(lid) || !eligibleOthersSet.has(lid))) {
            return null;
          }
        }
        const allChildren = [...existingChildren, ...incomingRoots];
        if (allChildren.length < 2) return null;
        const k = allChildren.length;
        let aggLoad = 0;
        if (existingChildren.length === 0) {
          const reduced = Math.max(1, k - 1);
          aggLoad = reduced * moveConvexCost(m.semanticCost / reduced);
        } else {
          for (const cid of allChildren) {
            const cLeaves = getNodeLeafIds(workingForest, cid);
            const uCost =
              cLeaves.length > 0
                ? cLeaves.reduce(
                    (acc, lid) => acc + (othersUnitCostByEntity.get(lid) ?? m.semanticCost),
                    0
                  ) / cLeaves.length
                : m.semanticCost;
            aggLoad += ((k - 1) / k) * moveConvexCost(uCost);
          }
        }
        const merged = mergeForestRoots(workingForest, compositeRegistry, allChildren, {
          mode: 'agg',
          displayName: OTHER_ACTORS_ENTITY_NAME,
          kind: 'other',
          stepSemanticCost: m.semanticCost,
          intrinsicConvexLoad: aggLoad,
          candidateId: m.id,
        });
        if (!merged) return null;
        curForest = merged.state;
        addedIds.push(m.id);
        continue;
      }

      // 2) Existing real entity target T (strict Poset inclusion u ≺ T required!)
      if (m.targetEntityId) {
        const targetId = m.targetEntityId;
        const targetEnt = fineEntById.get(targetId);
        if (!targetEnt || pinned.has(targetId) || targetEnt.kind === 'person') {
          return null;
        }

        const isActiveCore = curForest.atomicSet.has(targetId);
        let workingForest = curForest;
        let baseCoreChildren: string[] = [];
        let baseCoreLoad = 0;
        let baseNominalCost = 0;

        if (isActiveCore) {
          if (isForestRoot(workingForest, targetId)) {
            baseCoreChildren = [targetId];
          } else {
            const existingCoreRootId = workingForest.rootByCoreId.get(targetId);
            if (!existingCoreRootId || !isForestRoot(workingForest, existingCoreRootId)) {
              // T was already sealed inside a higher non-T composite -> reject!
              return null;
            }
            const unmerged = unmergeForestRoot(workingForest, existingCoreRootId);
            if (!unmerged) return null;
            workingForest = unmerged.state;
            baseCoreChildren = [...unmerged.restoredChildIds];
            baseCoreLoad = unmerged.dissolvedNode.intrinsicConvexLoad;
            baseNominalCost = unmerged.dissolvedNode.stepSemanticCost;
          }
        } else {
          // 0-event Poset hub H: cannot be rebuilt once materialized; must absorb 100% of active descendants atomically
          if (workingForest.rootByCoreId.has(targetId)) {
            return null;
          }
        }

        const nonTargetTokens = m.sourceEntityIds.filter((tok) => tok !== targetId);
        const incomingRoots = resolveExactCoverRoots(
          workingForest,
          nonTargetTokens,
          new Set(baseCoreChildren),
          m.origin === 'llm'
        );
        if (!incomingRoots || incomingRoots.length === 0) return null;
        for (const r of incomingRoots) {
          if (getNodeLeafIds(workingForest, r).some((lid) => pinned.has(lid))) {
            return null;
          }
        }

        // Hard Poset Inclusion Check: every leaf of incomingRoots must satisfy leaf ≺ targetId
        if (!checkStrictPosetInclusion(workingForest, incomingRoots, targetId, poset)) {
          return null;
        }

        const allChildren = [...baseCoreChildren, ...incomingRoots];
        if (allChildren.length < 2) return null;

        if (!isActiveCore) {
          const reqDescs = activeDescendantsByZeroHub.get(targetId) ?? [];
          const unionLeaves = new Set(allChildren.flatMap((rid) => getNodeLeafIds(workingForest, rid)));
          if (reqDescs.length !== unionLeaves.size || reqDescs.some((did) => !unionLeaves.has(did))) {
            return null;
          }
        }

        const actualDof = isActiveCore
          ? Math.max(1, incomingRoots.length)
          : Math.max(1, allChildren.length - 1);
        const stepAddLoad = actualDof * moveConvexCost(m.semanticCost / actualDof);

        const merged = mergeForestRoots(workingForest, compositeRegistry, allChildren, {
          mode: 'cmp',
          coreEntityId: targetId,
          displayName: targetEnt.name,
          kind: targetEnt.kind,
          focus: targetEnt.focus,
          stepSemanticCost: Number((baseNominalCost + m.semanticCost).toFixed(3)),
          intrinsicConvexLoad: baseCoreLoad + stepAddLoad,
          candidateId: m.id,
        });
        if (!merged) return null;
        curForest = merged.state;
        addedIds.push(m.id);
        continue;
      }

      // 3) Newly discovered composite subject S (`role_group` / man-machine system / P'):
      // Strictly sealed Merge over k >= 2 current roots (no post-creation addition or partial split)
      const incomingRoots = resolveExactCoverRoots(
        curForest,
        m.sourceEntityIds,
        undefined,
        m.origin === 'llm'
      );
      if (!incomingRoots || incomingRoots.length < 2) return null;
      for (const r of incomingRoots) {
        if (getNodeLeafIds(curForest, r).some((lid) => pinned.has(lid))) {
          return null;
        }
      }

      const actualDof = Math.max(1, incomingRoots.length - 1);
      const stepLoad = actualDof * moveConvexCost(m.semanticCost / actualDof);
      const label = m.targetLabel ?? `グループ_${m.id}`;
      const merged = mergeForestRoots(curForest, compositeRegistry, incomingRoots, {
        mode: 'cmp',
        displayName: label,
        kind: m.targetKind ?? 'organization',
        focus: 'mid',
        stepSemanticCost: m.semanticCost,
        intrinsicConvexLoad: stepLoad,
        candidateId: m.id,
      });
      if (!merged) return null;
      curForest = merged.state;
      addedIds.push(m.id);
    }

    if (addedIds.length === 0) return null;
    return {
      forest: curForest,
      appliedIds: [...base.appliedCandidateIds, ...addedIds],
    };
  };

  // Group single-source candidates by target (aggregate or 0-event hub / active parent) for 2-step plateau crossing
  const singleByTarget = new Map<string, VTALaneMergeCandidate[]>();
  for (const c of activePoolCandidates) {
    if (c.sourceEntityIds.length === 1) {
      const targetKey =
        c.kind === 'peripheral_others' || isPeripheralAggregateId(c.targetEntityId)
          ? SUBJECT_OTHERS_ID
          : c.targetEntityId;
      if (!targetKey) continue;
      if (targetKey === SUBJECT_OTHERS_ID || activeDescendantsByZeroHub.has(targetKey)) {
        const list = singleByTarget.get(targetKey) ?? [];
        list.push(c);
        singleByTarget.set(targetKey, list);
      }
    }
  }
  for (const list of singleByTarget.values()) {
    list.sort((a, b) => a.semanticCost - b.semanticCost);
  }

  const visited = new Set<string>([initialState.signature]);
  const allValidStates: SearchState[] = [initialState];
  let currentBeam: SearchState[] = [initialState];

  // Seed progressive trajectory from LLM [推奨統合] candidates
  const recommendedCands = activePoolCandidates
    .filter((c) => c.recommended === true)
    .sort((a, b) => a.semanticCost - b.semanticCost);
  if (recommendedCands.length > 0) {
    const recSteps: VTALaneMergeCandidate[][] = [];
    const groupedByTarget = new Map<string, VTALaneMergeCandidate[]>();
    for (const rc of recommendedCands) {
      const targetKey =
        rc.kind === 'peripheral_others' || isPeripheralAggregateId(rc.targetEntityId)
          ? SUBJECT_OTHERS_ID
          : rc.targetEntityId;
      if (
        rc.sourceEntityIds.length === 1 &&
        targetKey &&
        (targetKey === SUBJECT_OTHERS_ID || activeDescendantsByZeroHub.has(targetKey))
      ) {
        const list = groupedByTarget.get(targetKey);
        if (list) {
          list.push(rc);
        } else {
          const created = [rc];
          groupedByTarget.set(targetKey, created);
          recSteps.push(created);
        }
      } else {
        recSteps.push([rc]);
      }
    }
    let recCursor = initialState;
    for (const stepMoves of recSteps) {
      let chosenEval: SearchState | null = null;
      if (stepMoves.length === 1) {
        const peeledInfo = peeledAuxByCandId.get(stepMoves[0].id);
        if (peeledInfo) {
          const fullApplied = applyCandidatesToForest(recCursor, stepMoves);
          const fullEval = fullApplied
            ? evaluateState(fullApplied.forest, fullApplied.appliedIds)
            : null;
          if (fullApplied) evaluatedStates++;
          const triggersProtagonistPenalty =
            fullEval !== null &&
            peeledInfo.peeledOutIds.some((pid) => {
              const rId = fullEval.assignment.get(pid);
              const rComp = rId ? fullEval.forest.composites.get(rId) : undefined;
              return rComp ? computeInclusionPenalty(pid, rComp) >= 0.25 : false;
            });
          if (!fullEval || triggersProtagonistPenalty) {
            const auxApplied = applyCandidatesToForest(recCursor, [peeledInfo.auxCand]);
            if (auxApplied) {
              evaluatedStates++;
              const auxEval = evaluateState(auxApplied.forest, auxApplied.appliedIds);
              if (auxEval) chosenEval = auxEval;
            }
          }
          if (!chosenEval && fullEval) {
            chosenEval = fullEval;
          }
          if (fullEval && !visited.has(fullEval.signature)) {
            visited.add(fullEval.signature);
            allValidStates.push(fullEval);
          }
        }
      }
      if (!chosenEval) {
        const applied = applyCandidatesToForest(recCursor, stepMoves);
        if (!applied) continue;
        evaluatedStates++;
        chosenEval = evaluateState(applied.forest, applied.appliedIds);
      }
      if (!chosenEval) continue;
      recCursor = chosenEval;
      if (!visited.has(chosenEval.signature)) {
        visited.add(chosenEval.signature);
        allValidStates.push(chosenEval);
      }
    }
    if (recCursor !== initialState) {
      currentBeam = [recCursor, initialState];
    }
  }

  for (let step = 0; step < maxSteps; step++) {
    const nextCandidatesPool: SearchState[] = [];

    for (const state of currentBeam) {
      // 1-move neighborhood over unified candidate pool
      for (const cand of activePoolCandidates) {
        const applied = applyCandidatesToForest(state, [cand]);
        if (!applied) continue;
        const sig = computeForestSignature(applied.forest);
        if (visited.has(sig)) continue;
        visited.add(sig);
        evaluatedStates++;
        const evaluated = evaluateState(applied.forest, applied.appliedIds);
        if (evaluated) {
          nextCandidatesPool.push(evaluated);
          allValidStates.push(evaluated);
        }
      }

      // 2-move (and atomic all-member 0-event hub) plateau-crossing composite neighborhood
      for (const [targetKey, group] of singleByTarget) {
        if (activeDescendantsByZeroHub.has(targetKey)) {
          if (group.length >= 2) {
            const appliedAll = applyCandidatesToForest(state, group);
            if (appliedAll) {
              const sigAll = computeForestSignature(appliedAll.forest);
              if (!visited.has(sigAll)) {
                visited.add(sigAll);
                evaluatedStates++;
                const evalAll = evaluateState(appliedAll.forest, appliedAll.appliedIds);
                if (evalAll) {
                  nextCandidatesPool.push(evalAll);
                  allValidStates.push(evalAll);
                }
              }
            }
          }
          continue;
        }
        const cap = Math.min(group.length, 8);
        for (let i = 0; i < cap; i++) {
          for (let j = i + 1; j < cap; j++) {
            const applied = applyCandidatesToForest(state, [group[i], group[j]]);
            if (!applied) continue;
            const sig = computeForestSignature(applied.forest);
            if (visited.has(sig)) continue;
            visited.add(sig);
            evaluatedStates++;
            const evaluated = evaluateState(applied.forest, applied.appliedIds);
            if (evaluated) {
              nextCandidatesPool.push(evaluated);
              allValidStates.push(evaluated);
            }
          }
        }
      }
    }

    if (nextCandidatesPool.length === 0) break;
    nextCandidatesPool.sort((a, b) => b.objective - a.objective || a.laneCount - b.laneCount);
    currentBeam = nextCandidatesPool.slice(0, beamWidth);

    const bestSoFar = allValidStates.reduce(
      (best, s) => (s.objective > best.objective ? s : best),
      initialState
    );
    if (
      currentBeam[0].objective < bestSoFar.objective - 0.05 &&
      bestSoFar.laneCount <= targetK
    ) {
      break;
    }
  }

  // Sort all discovered valid states by unified objective descending and verify top finalists with full projection + wiring audit
  allValidStates.sort(
    (a, b) => b.objective - a.objective || Math.abs(a.laneCount - targetK) - Math.abs(b.laneCount - targetK)
  );

  let winningState = initialState;
  let winningSchema: VTASchema | undefined;
  let winningObjective = -Infinity;

  for (const finalist of allValidStates.slice(0, 12)) {
    const serializedComposites = serializeForestComposites(finalist.forest);
    const tempMeta: VTALaneConsolidationState = {
      version: 1,
      targetMaxSubjects: targetK,
      appliedCandidateIds: finalist.appliedCandidateIds,
      laneAssignment: Object.fromEntries(finalist.assignment),
      ...(serializedComposites ? { composites: serializedComposites } : {}),
      score: finalist.score,
      metrics: finalist.metrics,
      candidates: [...activePoolCandidates],
      separationConstraints: [...separationConstraints],
    };
    const projected = projectForestToSchema(
      fineBase,
      baseAnalysis,
      finalist.forest,
      tempMeta,
      options?.previousSchema
    );
    const wiring = auditProjectionWiring(projected, eventRowMap);
    if (wiring.backwardIntraLaneEdges.length > 0 || wiring.dagSequenceInversions.length > 0) {
      continue;
    }
    const machine = computeMachineMetrics(projected, targetK);
    if (machine.gateViolations.length > 0 && finalist !== initialState) {
      continue;
    }
    const blendedC3 = Number(
      (0.5 * machine.c3 + 0.5 * finalist.metrics.interactionRetention).toFixed(4)
    );
    const exactMetrics = {
      c1: finalist.metrics.c1,
      c2: finalist.metrics.c2,
      c3: blendedC3,
      c4: finalist.metrics.c4,
      c5: machine.c5,
      interactionRetention: finalist.metrics.interactionRetention,
    };
    const exactDisplayScore = totalScore(exactMetrics, weights);
    const exactObjective = computeConsolidationObjective(
      exactMetrics,
      finalist.laneCount,
      finalist.convexSemanticLoad,
      finalist.softPenalty
    );
    if (exactObjective > winningObjective || !winningSchema) {
      winningObjective = exactObjective;
      winningState = {
        ...finalist,
        score: exactDisplayScore,
        objective: exactObjective,
        metrics: exactMetrics,
      };
      winningSchema = projected;
    }
  }

  const winningComposites = serializeForestComposites(winningState.forest);
  const finalConsolidation: VTALaneConsolidationState = {
    version: 1,
    targetMaxSubjects: targetK,
    appliedCandidateIds: winningState.appliedCandidateIds,
    laneAssignment: Object.fromEntries(winningState.assignment),
    ...(winningComposites ? { composites: winningComposites } : {}),
    score: winningState.score,
    metrics: winningState.metrics,
    candidates: [...activePoolCandidates],
    separationConstraints: [...separationConstraints],
  };

  if (!winningSchema) {
    winningSchema = projectForestToSchema(
      fineBase,
      baseAnalysis,
      initialState.forest,
      finalConsolidation,
      options?.previousSchema
    );
  } else if (winningSchema.analysis) {
    winningSchema = {
      ...winningSchema,
      analysis: {
        ...winningSchema.analysis,
        laneConsolidation: finalConsolidation,
      },
    };
  }

  return {
    bestSchema: winningSchema,
    consolidation: finalConsolidation,
    fineLaneCount,
    finalLaneCount: visibleSchema(winningSchema).lanes.length,
    evaluatedStates,
  };
}

/**
 * End-to-end Phase 3 + Phase 4 optimizer:
 * 1. Captures/reuses the completed `fineGrainedBase`.
 * 2. Calls LLM once to propose merge candidates & separation constraints (unless skipped or cached).
 * 3. Runs Beam-Assisted Hill-Climbing to select and project the highest-scoring consolidated VTA view.
 */
export async function optimizeLaneConsolidation(
  config: LLMConfig,
  currentSchema: VTASchema,
  callChat: LaneConsolidationChatCaller,
  log?: LaneConsolidationLog,
  signal?: AbortSignal,
  options?: OptimizeLaneConsolidationOptions
): Promise<OptimizeLaneConsolidationResult> {
  if (!currentSchema.analysis) {
    throw new Error('分析データが存在しないためレーン統合最適化を実行できません。');
  }

  const baseAnalysis = currentSchema.analysis;
  const fineBase = captureFineGrainedBase(baseAnalysis);
  const targetK = clampSubjectLimit(options?.targetMaxSubjects ?? DEFAULT_MAX_SUBJECTS);
  const pinnedSet = new Set<string>(options?.scope?.pinnedEntityIds ?? []);

  const activeEvIdSet = new Set(baseAnalysis.events.filter((e) => !e.ignored).map((e) => e.id));
  const posetForCount = fineBase.subjectPoset
    ? SubjectPoset.fromData(fineBase.subjectPoset)
    : SubjectPoset.fromEntities(fineBase.entities);
  const passivelyCoveredForCount = computePassivelyCoveredHubIds(
    fineBase.entities,
    fineBase.participations,
    activeEvIdSet,
    posetForCount,
    baseAnalysis
  );
  const fineLaneCount = fineBase.entities.filter(
    (e) =>
      !passivelyCoveredForCount.has(e.id) &&
      fineBase.participations.some((p) => p.entityId === e.id && activeEvIdSet.has(p.eventId))
  ).length;

  const fallback = generateStructuralFallbackCandidates(fineBase, baseAnalysis, pinnedSet);
  let llmCandidates: VTALaneMergeCandidate[] = [];
  let llmSeparations: VTASeparationConstraint[] = [];
  let invalidCandidateLines: string[] = [];
  let llmCalled = false;

  const cached = baseAnalysis.laneConsolidation;
  const canReuseCached =
    Boolean(options?.reuseCachedCandidatesOnly) &&
    Boolean(cached && cached.candidates.length > 0);

  if (canReuseCached && cached) {
    llmCandidates = cached.candidates.filter((c) => c.origin === 'llm');
    llmSeparations = cached.separationConstraints;
  } else if (fineLaneCount > targetK || Boolean(options?.oneTimeDirective?.trim())) {
    try {
      const userPrompt = buildLaneConsolidationUserPrompt(fineBase, baseAnalysis, targetK, {
        oneTimeDirective: options?.oneTimeDirective,
        assumptions: options?.assumptions,
        scope: options?.scope,
      });
      log?.(
        'info',
        `[レーン統合提案] 最細粒度 ${fineLaneCount}列 → 目標 ${targetK}列に向け、統合候補と分離制約を一括推論しています...`,
        '最適化'
      );
      const reply = await callChat(
        config,
        [
          { role: 'system', content: LANE_CONSOLIDATION_SYSTEM_PROMPT },
          { role: 'user', content: userPrompt },
        ],
        0.2,
        signal
      );
      llmCalled = true;
      const parsed = parseLaneConsolidationTSV(reply.content, fineBase, baseAnalysis);
      llmCandidates = parsed.candidates;
      llmSeparations = parsed.separationConstraints;
      invalidCandidateLines = parsed.invalidLines;
      log?.(
        'info',
        `[レーン統合提案完了] AI候補 ${llmCandidates.length}件・分離制約 ${llmSeparations.length}件を受信しました（${reply.latencyMs}ms）。山登り探索を実行します。`,
        '最適化'
      );
    } catch (err) {
      if (
        signal?.aborted ||
        (err instanceof Error && (err.name === 'UserCancelledError' || err.message === 'USER_CANCELLED'))
      ) {
        throw err;
      }
      log?.(
        'warn',
        `[レーン統合フォールバック] AI統合候補の取得に失敗したため、Poset構造候補のみで山登り最適化を実行します: ${
          err instanceof Error ? err.message : String(err)
        }`,
        '最適化'
      );
    }
  }

  const mergedPool = mergeCandidatePools(
    llmCandidates,
    fallback.candidates,
    llmSeparations,
    fallback.separationConstraints
  );

  const searched = searchOptimalLaneConsolidation(
    fineBase,
    baseAnalysis,
    mergedPool.candidates,
    mergedPool.separationConstraints,
    {
      targetMaxSubjects: targetK,
      weights: options?.weights,
      pinnedEntityIds: pinnedSet,
      beamWidth: options?.beamWidth,
      maxSteps: options?.maxSteps,
      previousSchema: currentSchema,
    }
  );

  const auditIteration = {
    index: (baseAnalysis.normalizationAudit?.iterations?.length ?? 0) + 1,
    score: searched.consolidation.score,
    adopted: true,
    metrics: {
      c1: searched.consolidation.metrics.c1,
      c2: searched.consolidation.metrics.c2,
      c3: searched.consolidation.metrics.c3,
      c4: searched.consolidation.metrics.c4,
      c5: searched.consolidation.metrics.c5,
    },
    gateViolations: [],
    operations: searched.consolidation.appliedCandidateIds,
  };

  const prevAudit = searched.bestSchema.analysis?.normalizationAudit;
  const finalAnalysis: VTAAnalysisData = {
    ...searched.bestSchema.analysis!,
    normalizationAudit: {
      version: 1,
      corrections: prevAudit?.corrections ?? [],
      subjectiveNotices: prevAudit?.subjectiveNotices ?? [],
      iterations: [...(prevAudit?.iterations ?? []), auditIteration],
    },
  };
  const finalSchema: VTASchema = {
    ...searched.bestSchema,
    analysis: finalAnalysis,
  };

  const candById = new Map(searched.consolidation.candidates.map((c) => [c.id, c]));
  const appliedMovesSummary = searched.consolidation.appliedCandidateIds.map((cid) => {
    const c = candById.get(cid);
    if (!c) return cid;
    return `${cid}(${c.sourceEntityIds.join(',')}->${c.targetEntityId ?? c.targetLabel ?? '?'}:${c.semanticCost.toFixed(2)})`;
  });
  const llmCandidatesSummary = llmCandidates.map(
    (c) =>
      `${c.id}[${c.recommended ? 'rec' : 'res'}](${c.sourceEntityIds.join(',')}->${c.targetEntityId ?? c.targetLabel ?? '?'}:${c.semanticCost.toFixed(2)})`
  );

  debugRecorder.record(
    'lane.consolidation',
    () => ({
      fineLaneCount: searched.fineLaneCount,
      targetMaxSubjects: targetK,
      finalLaneCount: searched.finalLaneCount,
      llmCalled,
      llmCandidateCount: llmCandidates.length,
      invalidCandidateCount: invalidCandidateLines.length,
      ...(invalidCandidateLines.length > 0
        ? { invalidCandidateLines: invalidCandidateLines.slice(0, 5) }
        : {}),
      llmCandidatesSummary,
      totalCandidateCount: searched.consolidation.candidates.length,
      separationCount: mergedPool.separationConstraints.length,
      evaluatedStates: searched.evaluatedStates,
      appliedCandidateIds: searched.consolidation.appliedCandidateIds,
      appliedMovesSummary,
      score: searched.consolidation.score,
      metrics: searched.consolidation.metrics,
    }),
    undefined,
    [config.gatewayToken ?? '']
  );

  log?.(
    'success',
    `[レーン統合最適化完了] 最細粒度 ${searched.fineLaneCount}列 → ${searched.finalLaneCount}列（目標=${targetK}、探索状態=${searched.evaluatedStates}件、スコア S=${searched.consolidation.score.toFixed(3)} [C1=${searched.consolidation.metrics.c1.toFixed(2)}, C2=${searched.consolidation.metrics.c2.toFixed(2)}, C3=${searched.consolidation.metrics.c3.toFixed(2)}, C4=${searched.consolidation.metrics.c4.toFixed(2)}, C5=${searched.consolidation.metrics.c5.toFixed(2)}]）`,
    '最適化'
  );

  return {
    schema: finalSchema,
    analysis: finalAnalysis,
    consolidation: searched.consolidation,
    fineLaneCount: searched.fineLaneCount,
    finalLaneCount: searched.finalLaneCount,
    llmCalled,
    evaluatedStates: searched.evaluatedStates,
  };
}
