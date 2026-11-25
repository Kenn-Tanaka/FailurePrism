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

const SUBJECT_OTHERS_ID = 'subject_others';

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
   - 最終的な被災結果（:affected）の共有のみを理由として、単独の指揮・指示・情報受領・判断イベントを多数持つ監督・指揮主体と、指示を受ける側の作業メンバーを1つのグループ名（例：「被災者群」等）に束ねてはならない（単独の指示・判断イベントの主語がグループ全体に歪むため）。
3. peripheral_others: 本筋の現場事象連鎖から離れた周辺主体（事前の作業委託・契約・派遣手配を担う外部/管理組織、受動連絡先、事後対応機関など、2主体以上のバンドルおよび個別候補）を、周辺共通上位枠「その他の関係者」（統合先IDは subject_others、既存のPoset親子関係は保持）へ集約する。
   - 報告焦点が high/reporter の主要主体、一次損失（:loss）の直接当事者（:actor / :affected）、およびアクティブな上位組織レーンや複数カードのアクティブ下位メンバーを持つ階層主体は絶対に peripheral_others に含めないこと。
4. object_absorb: 自律的な判断・モード遷移を持たない受動的な機器・設備・ツール主体を、それを運用・管理する人間・組織レーンへ吸収する。

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
 * Identifies Poset ancestors H whose active participations are strictly passive (`target` / `intended_recipient`)
 * and whose direct uncovered event set is empty: E_dir(H) = E(H) \ (⋃_{d ≺ H} E(d)) = ∅.
 * Such ancestors carry 0 independent events beyond their participating descendants and are treated as 0-event hubs (HG2c).
 */
function computePassivelyCoveredHubIds(
  entities: readonly VTAEntity[],
  participations: readonly VTAParticipation[],
  activeEvIdSet: ReadonlySet<string>,
  poset: SubjectPoset
): Set<string> {
  const participatingIds = new Set<string>();
  for (const p of participations) {
    if (activeEvIdSet.has(p.eventId)) participatingIds.add(p.entityId);
  }
  const result = new Set<string>();
  for (const ent of entities) {
    const parts = participations.filter(
      (p) => p.entityId === ent.id && activeEvIdSet.has(p.eventId)
    );
    if (parts.length === 0) continue;
    const hasParticipatingDescendant = Array.from(participatingIds).some(
      (did) => did !== ent.id && poset.isAncestor(ent.id, did)
    );
    if (!hasParticipatingDescendant) continue;
    const isPassiveOnly = parts.every(
      (p) => p.role === 'target' || p.role === 'intended_recipient'
    );
    if (!isPassiveOnly) continue;
    const directUncovered = computeDirectUncoveredEventIds(
      ent.id,
      participations,
      poset,
      activeEvIdSet,
      { requireSubstantiveDescendantRole: true }
    );
    if (directUncovered.size === 0) {
      result.add(ent.id);
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
      if (cands.length === 0) return undefined;
      if (avoidBucket) {
        const distinct = cands.find((p) => (resolveBucket ? resolveBucket(p.entityId) : p.entityId) !== avoidBucket);
        if (distinct) return distinct.entityId;
      }
      return cands[0].entityId;
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
    poset
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
    poset
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
    poset
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
  const cleanZeroEventRollupHubs = new Set<string>();
  for (const candHub of fineBase.entities) {
    if (participatingIds.has(candHub.id) || candHub.kind === 'person') continue;
    const activeDescs = Array.from(participatingIds).filter(
      (did) => did !== candHub.id && poset.isAncestor(candHub.id, did)
    );
    if (
      activeDescs.length >= 2 &&
      activeDescs.every((did) => !isProtagonistOrLossDirect(did))
    ) {
      cleanZeroEventRollupHubs.add(candHub.id);
    }
  }
  const eligible = new Set<string>();

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

    // Subordinates with an active Poset ancestor or a clean 0-event Poset rollup hub belong in poset_rollup, not subject_others
    const entAncestors = Array.from(poset.getAncestors(ent.id)).filter((aid) => aid !== ent.id);
    const hasKnownPosetRollupParent = entAncestors.some(
      (aid) => participatingIds.has(aid) || cleanZeroEventRollupHubs.has(aid)
    );
    if (hasKnownPosetRollupParent) continue;

    // Intra-cohort subordinates that share a 0-event Poset ancestor H AND direct event/relation coupling
    // with a core protagonist w ≺ H belong in cohort role_group / poset_rollup under H, not external subject_others
    if (entAncestors.length > 0) {
      const myEvSet = new Set(parts.map((p) => p.eventId));
      const isCoupledToCohortProtagonist = Array.from(participatingIds).some((wid) => {
        if (wid === ent.id || !isProtagonistOrLossDirect(wid)) return false;
        const sharesZeroHub = entAncestors.some((hid) => poset.isAncestor(hid, wid));
        if (!sharesZeroHub) return false;
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

    eligible.add(ent.id);
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

  const resolveEntId = (token: string): string | undefined => {
    const t = token.trim();
    if (!t || t === '-') return undefined;
    if (entById.has(t)) return t;
    return entByName.get(t)?.id;
  };

  const candidates: VTALaneMergeCandidate[] = [];
  const separationConstraints: VTASeparationConstraint[] = [];
  const invalidLines: string[] = [];
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
      const sourceIds = Array.from(
        new Set(
          sourcesRaw
            .split(/[,、]/)
            .map((s) => resolveEntId(s))
            .filter((s): s is string => Boolean(s))
        )
      );
      if (sourceIds.length === 0) {
        invalidLines.push(line);
        continue;
      }

      let targetEntityId: string | undefined;
      let targetLabel: string | undefined;
      if (
        kind === 'peripheral_others' ||
        targetIdRaw === SUBJECT_OTHERS_ID ||
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
      let effectiveKind: VTALaneMergeCandidateKind = kind;
      if (!targetEntityId && sourceIds.length >= 2) {
        const commonParent = sourceIds.find((candAnc) => {
          const ancEnt = entById.get(candAnc);
          if (!ancEnt || ancEnt.kind === 'person') return false;
          return sourceIds.every((sid) => sid === candAnc || poset.isAncestor(candAnc, sid));
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
        filteredSources = filteredSources.filter((sid) => eligibleOthersSet.has(sid));
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

      // Guard against upward organization -> descendant person inversion
      if (targetEntityId && targetEntityId !== SUBJECT_OTHERS_ID) {
        const tgtEnt = entById.get(targetEntityId);
        const hasUpwardPersonInversion = filteredSources.some(
          (sid) =>
            poset.isAncestor(sid, targetEntityId!) &&
            (tgtEnt?.kind === 'person' || entById.get(sid)?.kind === 'organization')
        );
        if (hasUpwardPersonInversion) {
          invalidLines.push(line);
          continue;
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

      candidates.push({
        id: id || `M_${seq++}`,
        kind: targetEntityId === SUBJECT_OTHERS_ID ? 'peripheral_others' : effectiveKind,
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
    } else if (section === 'separations') {
      if (cells.length < 3) {
        invalidLines.push(line);
        continue;
      }
      const [rawA, rawB, rawSev] = cells;
      const reason = cells.slice(3).join(' ') || '役割・帰結の非対称性による分離維持';
      const entityA = resolveEntId(rawA);
      const entityB = resolveEntId(rawB);
      if (!entityA || !entityB || entityA === entityB) {
        invalidLines.push(line);
        continue;
      }
      separationConstraints.push({
        entityA,
        entityB,
        severity: rawSev.toLowerCase() === 'soft' ? 'soft' : 'hard',
        reason,
      });
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
    poset
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
            });
          }
        } else {
          separationConstraints.push({
            entityA: a,
            entityB: b,
            severity: 'hard',
            reason: g.reason ?? '役割・帰結の厳格非対称性により分離維持',
          });
        }
      } else if (!g.allowed) {
        separationConstraints.push({
          entityA: a,
          entityB: b,
          severity: 'soft',
          reason: g.reason ?? '直接の伝達・依存関係が存在',
        });
      }
    }
  }

  // 2. Poset child -> nearest active ancestor (or >=2-child 0-event hub) roll-up candidates
  const participatingDescCountById = new Map<string, number>();
  const hasUnmergeablePersonDescById = new Map<string, boolean>();
  for (const ent of fineBase.entities) {
    let descCnt = 0;
    let unmergeablePerson = false;
    for (const pid of participatingEntIds) {
      if (pid !== ent.id && poset.isAncestor(ent.id, pid)) {
        descCnt++;
        const pEnt = entById.get(pid);
        if (
          pEnt?.kind === 'person' &&
          (pinned.has(pid) ||
            pEnt.focus === 'high' ||
            pEnt.focus === 'reporter' ||
            isLossAffectedNonMachine(pid))
        ) {
          unmergeablePerson = true;
        }
      }
    }
    participatingDescCountById.set(ent.id, descCnt);
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
    // Only target nearest active ancestors (do not leapfrog an active intermediate parent like B_FLT_CREW -> JAL)
    const nearestActiveAncs = activeAncs.filter(
      (aid) => !activeAncs.some((mid) => mid !== aid && poset.isAncestor(aid, mid))
    );
    // Also allow 0-event Poset hubs with >=2 participating descendants when not above an active intermediate parent
    const zeroHubAncs = allAncs.filter(
      (aid) =>
        !participatingEntIds.has(aid) &&
        (participatingDescCountById.get(aid) ?? 0) >= 2 &&
        !activeAncs.some((mid) => poset.isAncestor(aid, mid))
    );
    const targetAncestors = [...nearestActiveAncs, ...zeroHubAncs];

    const seenAnc = new Set<string>();
    for (const ancId of targetAncestors) {
      if (ancId === ent.id || seenAnc.has(ancId)) continue;
      seenAnc.add(ancId);
      const anc = entById.get(ancId);
      if (!anc || anc.kind === 'person') continue;
      if (isLossAffectedNonMachine(ent.id)) continue;
      // Do not generate partial poset_fallback person->parent rollups when sibling protagonist persons remain under the same parent (Antichain preservation)
      if (ent.kind === 'person' && hasUnmergeablePersonDescById.get(ancId)) continue;
      candidates.push({
        id: `FB_${fbSeq++}`,
        kind: isPassiveMachine ? 'object_absorb' : 'poset_rollup',
        sourceEntityIds: [ent.id],
        targetEntityId: ancId,
        targetKind: anc.kind,
        semanticCost: Number(baseCost.toFixed(3)),
        reason: `Poset上位主体「${anc.name}」への階層包摂`,
        origin: 'poset_fallback',
      });
      const isTwoMemberZeroHub =
        !participatingEntIds.has(ancId) && (participatingDescCountById.get(ancId) ?? 0) === 2;
      if (
        !isLossAffectedNonMachine(ent.id) &&
        ent.focus !== 'high' &&
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

  const peripheralPool: Array<{ id: string; cost: number }> = [];
  for (const ent of fineBase.entities) {
    if (!eligibleOthersSet.has(ent.id) || pinned.has(ent.id)) continue;
    const parts = partsByEnt.get(ent.id) ?? [];
    const hasOutcomeActor = parts.some((p) => p.role === 'actor' && outcomeIds.has(p.eventId));
    if (hasOutcomeActor) continue;
    // Skip active multi-card organizational hubs that have mergeable children
    if ((mergeableChildrenByParent.get(ent.id)?.length ?? 0) >= 1 && parts.length >= 2) continue;

    const isPassiveMachine =
      ent.kind === 'machine' && !isActiveOrInteractiveMachine(ent, fineAnalysisForGuard);
    const s = fallbackRankScoreById.get(ent.id) ?? 0;
    const cost = isPassiveMachine
      ? 0.02
      : Number(Math.min(0.42, Math.max(0.03, 0.02 + 0.38 * s)).toFixed(3));

    peripheralPool.push({ id: ent.id, cost });
    candidates.push({
      id: `FB_${fbSeq++}`,
      kind: 'peripheral_others',
      sourceEntityIds: [ent.id],
      targetEntityId: SUBJECT_OTHERS_ID,
      targetLabel: OTHER_ACTORS_ENTITY_NAME,
      targetKind: 'other',
      semanticCost: cost,
      reason: `周辺主体「${ent.name}」(s=${s.toFixed(3)})を「${OTHER_ACTORS_ENTITY_NAME}」へ集約`,
      origin: 'poset_fallback',
    });
  }

  peripheralPool.sort((a, b) => a.cost - b.cost);
  if (peripheralPool.length >= 2) {
    const pairCap = Math.min(peripheralPool.length, 6);
    const pairBundles: Array<{ pair: [string, string]; cost: number }> = [];
    for (let i = 0; i < pairCap; i++) {
      for (let j = i + 1; j < pairCap; j++) {
        const u = peripheralPool[i];
        const v = peripheralPool[j];
        const relW = pairRelWeight.get(makePairRelKey(u.id, v.id)) ?? 0;
        const posetDelta = computePosetBundleDelta([u.id, v.id]);
        const pairCost = 0.5 * (u.cost + v.cost) + posetDelta + 0.08 * relW;
        pairBundles.push({ pair: [u.id, v.id], cost: pairCost });
      }
    }
    pairBundles.sort((a, b) => a.cost - b.cost);
    for (const pb of pairBundles.slice(0, 6)) {
      candidates.push({
        id: `FB_${fbSeq++}`,
        kind: 'peripheral_others',
        sourceEntityIds: pb.pair,
        targetEntityId: SUBJECT_OTHERS_ID,
        targetLabel: OTHER_ACTORS_ENTITY_NAME,
        targetKind: 'other',
        semanticCost: Number(Math.min(0.85, pb.cost).toFixed(3)),
        reason: `周辺2主体を共通上位枠「${OTHER_ACTORS_ENTITY_NAME}」へ同時集約`,
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
    if (!prev || (prev.severity === 'soft' && s.severity === 'hard')) {
      sepByPair.set(k, s);
    }
  }

  return {
    candidates,
    separationConstraints: Array.from(sepByPair.values()),
  };
}

interface BucketMeta {
  id: string;
  name: string;
  kind: VTAEntity['kind'];
  aggregate?: true;
  isVirtualGroup?: boolean;
  isZeroEventHub?: boolean;
}

interface SearchState {
  assignment: Map<string, string>; // participating fineEntityId -> bucketId
  buckets: Map<string, BucketMeta>;
  appliedCandidateIds: string[];
  moveCostByEntity: Map<string, number>;
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

function computeStateSignature(assignment: ReadonlyMap<string, string>, sortedFineIds: readonly string[]): string {
  return sortedFineIds.map((id) => `${id}:${assignment.get(id) ?? id}`).join('|');
}

/**
 * Projects a partition state (`fineEntityId -> bucketId`) onto a complete, valid `VTASchema`
 * while preserving `fineGrainedBase` untouched on `schema.analysis`.
 */
export function projectPartitionToSchema(
  fineBase: VTAFineGrainedBase,
  baseAnalysis: VTAAnalysisData,
  assignment: ReadonlyMap<string, string>,
  buckets: ReadonlyMap<string, BucketMeta>,
  consolidationMeta?: VTALaneConsolidationState,
  previousSchema?: VTASchema
): VTASchema {
  const activeEvIdSet = new Set(baseAnalysis.events.filter((e) => !e.ignored).map((e) => e.id));
  const fineEntById = new Map(fineBase.entities.map((e) => [e.id, e]));
  const basePoset = fineBase.subjectPoset
    ? SubjectPoset.fromData(fineBase.subjectPoset)
    : SubjectPoset.fromEntities(fineBase.entities);
  const passivelyCoveredHubIds = computePassivelyCoveredHubIds(
    fineBase.entities,
    fineBase.participations,
    activeEvIdSet,
    basePoset
  );
  const projectedPoset = SubjectPoset.fromData(basePoset.toJSON());

  const membersByBucket = new Map<string, string[]>();
  for (const [fineId, bucketId] of assignment) {
    const list = membersByBucket.get(bucketId) ?? [];
    list.push(fineId);
    membersByBucket.set(bucketId, list);
  }

  const activeBucketIds = Array.from(membersByBucket.keys());
  const activeBucketSet = new Set(activeBucketIds);
  const usedEntityNames = new Set<string>();
  const resolvedNameByBucket = new Map<string, string>();

  for (const bucketId of activeBucketIds) {
    const members = membersByBucket.get(bucketId) ?? [];
    const meta = buckets.get(bucketId);
    const origEnt = fineEntById.get(bucketId);
    let baseName =
      bucketId === SUBJECT_OTHERS_ID
        ? OTHER_ACTORS_ENTITY_NAME
        : origEnt?.name ?? meta?.name ?? bucketId;
    if (usedEntityNames.has(baseName)) {
      let suffix = 2;
      while (usedEntityNames.has(`${baseName} (${suffix})`)) suffix++;
      baseName = `${baseName} (${suffix})`;
    }
    usedEntityNames.add(baseName);
    resolvedNameByBucket.set(bucketId, baseName);

    // Register adopted newly discovered parent (role_group or subject_others) via conservative Poset extension
    if (!origEnt && members.length >= 2) {
      discoverConservativeParent(projectedPoset, bucketId, baseName, members);
    }
  }

  const projectedEntities: VTAEntity[] = [];
  for (const bucketId of activeBucketIds) {
    const members = membersByBucket.get(bucketId) ?? [];
    const meta = buckets.get(bucketId);
    const origEnt = fineEntById.get(bucketId);
    const absorbed = members.filter((m) => m !== bucketId);
    const baseName = resolvedNameByBucket.get(bucketId) ?? bucketId;

    if (bucketId === SUBJECT_OTHERS_ID) {
      projectedEntities.push({
        id: SUBJECT_OTHERS_ID,
        name: baseName,
        kind: 'other',
        aggregate: true,
        ...(absorbed.length > 0 ? { mergedFrom: absorbed } : {}),
      });
      continue;
    }

    // Resolve kept Poset parents among active non-aggregate buckets using conservatively extended projectedPoset
    const rawAncestors = projectedPoset.hasNode(bucketId)
      ? Array.from(projectedPoset.getAncestors(bucketId))
      : members.length > 0
        ? Array.from(projectedPoset.getAncestors(members[0])).filter((ancId) =>
            members.every((mId) => projectedPoset.isAncestor(ancId, mId))
          )
        : [];
    const keptAncs = rawAncestors.filter(
      (aid) => aid !== bucketId && activeBucketSet.has(aid) && aid !== SUBJECT_OTHERS_ID
    );
    const nearestParents = keptAncs.filter(
      (aid) => !keptAncs.some((other) => other !== aid && projectedPoset.isAncestor(aid, other))
    );

    projectedEntities.push({
      id: bucketId,
      name: baseName,
      kind: origEnt?.kind ?? meta?.kind ?? 'organization',
      ...(origEnt?.focus ? { focus: origEnt.focus } : { focus: 'mid' }),
      ...(origEnt?.focusSourceRefs ? { focusSourceRefs: origEnt.focusSourceRefs } : {}),
      ...(nearestParents.length > 0
        ? { parentEntityId: nearestParents[0], parentEntityIds: nearestParents }
        : {}),
      ...(absorbed.length > 0 ? { mergedFrom: absorbed } : {}),
    });
  }

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

  // Remap relations (first resolving any unmerged passively covered Poset hub endpoints, then mapping to bucket IDs)
  const unmergedPassiveHubs = new Set(
    Array.from(passivelyCoveredHubIds).filter((hid) => !activeBucketSet.has(hid))
  );
  const sourceRelations = remapPassivelyCoveredRelations(
    fineBase.relations,
    fineBase.participations,
    activeEvIdSet,
    unmergedPassiveHubs,
    basePoset,
    (fid) => assignment.get(fid)
  );
  const nextRelations: VTAEventRelation[] = sourceRelations
    .filter((r) => activeEvIdSet.has(r.sourceEventId) && activeEvIdSet.has(r.targetEventId))
    .map((rel) => {
      const origSrc = rel.sourceEntityOrigin ?? rel.sourceEntityId;
      const origTgt = rel.targetEntityOrigin ?? rel.targetEntityId;
      const newSrc = origSrc ? (assignment.get(origSrc) ?? (activeBucketSet.has(origSrc) ? origSrc : undefined)) : undefined;
      const newTgt = origTgt ? (assignment.get(origTgt) ?? (activeBucketSet.has(origTgt) ? origTgt : undefined)) : undefined;
      return {
        ...rel,
        sourceEntityId: newSrc,
        targetEntityId: newTgt,
        ...(origSrc && newSrc && origSrc !== newSrc ? { sourceEntityOrigin: origSrc } : {}),
        ...(origTgt && newTgt && origTgt !== newTgt ? { targetEntityOrigin: origTgt } : {}),
      };
    });

  // Build consolidated cards (1 card per (eventId, bucketId), preserving non-conflicting multi-event groups when unmerged)
  const eventOrderById = new Map(baseAnalysis.events.map((e) => [e.id, e.sourceOrder]));
  const nextCards: VTACardRef[] = [];
  const coveredPairs = new Set<string>();
  const usedCardIds = new Set<string>();

  for (const fgCard of fineBase.cards) {
    if (fgCard.eventIds.length < 2) continue;
    const bId = assignment.get(fgCard.laneEntityId);
    if (!bId || bId === SUBJECT_OTHERS_ID) continue;
    if ((membersByBucket.get(bId)?.length ?? 0) > 1) continue;
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
      // 0-event or passively covered hub entity: retained iff it is an active bucket absorbing >=2 children
      if (activeBucketSet.has(r.entityId)) {
        return {
          ...r,
          retained: true,
          mergedInto: undefined,
          excluded: undefined,
          consolidationStage: undefined,
          mergeBlockedReason: undefined,
          reason: `上位統合ハブとして保持（子孫 ${membersByBucket.get(r.entityId)?.length ?? 0}件を集約）`,
        };
      }
      return {
        ...r,
        retained: false,
        mergedInto: undefined,
        excluded: true,
        consolidationStage: 'stage3_hc_prune' as VTASubjectConsolidationStage,
        mergeBlockedReason: undefined,
        reason: passivelyCoveredHubIds.has(r.entityId)
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
    const tgtEnt = projectedEntities.find((e) => e.id === mapped);
    const stage: VTASubjectConsolidationStage =
      mapped === SUBJECT_OTHERS_ID
        ? 'stage3_hc_others'
        : buckets.get(mapped)?.isVirtualGroup
          ? 'stage3_hc_group'
          : fineEntById.get(r.entityId)?.kind === 'machine'
            ? 'stage3_hc_object'
            : 'stage3_hc_poset';
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
  candidates: readonly VTALaneMergeCandidate[],
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
    poset
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
  const fineRankings = rankSubjects(
    {
      ...baseAnalysis,
      entities: fineBase.entities,
      participations: fineBase.participations.filter((p) => !passivelyCoveredHubIds.has(p.entityId)),
      relations: remappedFineRelations,
      cards: fineBase.cards,
      subjectPoset: fineBase.subjectPoset,
    },
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
    totalInteractionWeight += w;
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
  const softSepPairs: Array<[string, string]> = [];
  for (const sc of separationConstraints) {
    if (sc.severity === 'hard') hardSepPairs.push([sc.entityA, sc.entityB]);
    else softSepPairs.push([sc.entityA, sc.entityB]);
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
      const ev = activeEvById.get(p.eventId);
      return isEffectiveVariation(baseAnalysis, ev) && !resEvSet.has(p.eventId);
    });
    const hasRes = parts.some(
      (p) => resEvSet.has(p.eventId) && p.role !== 'target' && p.role !== 'intended_recipient'
    );
    if (hasAdv && !hasRes) pureAdverseIds.add(fid);
  }

  const moveConvexCost = (c: number): number => 0.35 * c + 0.95 * c * c;
  const invertMoveConvexCost = (y: number): number =>
    y <= 0 ? 0 : (-0.35 + Math.sqrt(0.35 * 0.35 + 4 * 0.95 * y)) / (2 * 0.95);

  // Explicit [推奨統合] Poset axis selections from the LLM
  const recommendedPosetPairs = new Set<string>();
  for (const cand of candidates) {
    if (!cand.recommended || !cand.targetEntityId || cand.targetEntityId === SUBJECT_OTHERS_ID) continue;
    for (const sid of cand.sourceEntityIds) {
      recommendedPosetPairs.add(`${sid}->${cand.targetEntityId}`);
    }
  }

  /**
   * Inclusion & virtual-group asymmetry penalty function P_sub(X -> B):
   * 1) Prevents high-salience protagonists X from being erroneously absorbed into an upper ancestor Y (X < Y)
   *    on blind/reserve rollups and prevents high-activity operational units from being swallowed into 0-actor corporate shells,
   *    while respecting the LLM's explicit [推奨統合] Poset upper-subject selection when structurally sound.
   * 2) Prevents high-salience / high-autonomy protagonists with substantial solo decision/action chains
   *    from being renamed into non-homogeneous virtual role_groups alongside subordinate followers,
   *    while keeping genuinely parallel peer role_groups penalty-free.
   */
  const computeInclusionPenalty = (
    childId: string,
    bucketId: string,
    bucketMembers: readonly string[],
    isVirtualGroup?: boolean
  ): number => {
    if (childId === bucketId || bucketId === SUBJECT_OTHERS_ID) return 0;
    let targetAncId: string | undefined;
    if (fineEntById.has(bucketId) && poset.isAncestor(bucketId, childId)) {
      targetAncId = bucketId;
    } else {
      targetAncId = bucketMembers.find((m) => m !== childId && poset.isAncestor(m, childId));
    }
    if (!targetAncId) {
      if (isVirtualGroup && bucketMembers.length >= 2) {
        const ent = fineEntById.get(childId);
        if (!ent || passiveEntityIds.has(childId)) return 0;
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
    const isZeroActorShellInversion = ent.focus !== 'low' && yEvs >= 1 && yAct === 0 && nAct >= 1;

    // Respect LLM's explicit [推奨統合] Poset axis choice when structurally valid (no active intermediate leapfrog or shell inversion;
    // pure 0-event composite hubs such as "運転士Aが操作する列車X" preserve the outcome-actor chain on their own dedicated lane)
    const allowsZeroHubOutcomeActor = yEvs === 0;
    if (
      recommendedPosetPairs.has(`${childId}->${targetAncId}`) &&
      ent.focus !== 'reporter' &&
      (!hasExclusiveOutcomeActor || allowsZeroHubOutcomeActor) &&
      !isZeroActorShellInversion
    ) {
      const leapfrogsActiveIntermediate = Array.from(poset.getAncestors(childId)).some(
        (mid) =>
          mid !== childId &&
          mid !== targetAncId &&
          finePartsByEnt.has(mid) &&
          poset.isAncestor(targetAncId!, mid)
      );
      if (!leapfrogsActiveIntermediate) return 0;
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
    if (hasExclusiveOutcomeActor) {
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

    return Math.min(0.92, pSalience + pDom);
  };

  // Unified internal ranking objective shared identically between beam search and finalist verification
  const computeConsolidationObjective = (
    m: { c1: number; c2: number; c3: number; c4: number; c5: number },
    laneCount: number,
    convexLoad: number,
    softPen: number
  ): number => {
    const base = totalScore(m, weights);
    const excess = Math.max(0, laneCount - targetK);
    return Number((base - 0.038 * excess - 0.095 * convexLoad - 0.1 * softPen).toFixed(4));
  };

  const activeDescendantsByZeroHub = new Map<string, string[]>();
  for (const ent of fineBase.entities) {
    if (finePartsByEnt.has(ent.id)) continue;
    const descs = sortedFineIds.filter((fid) => fid !== ent.id && poset.isAncestor(ent.id, fid));
    activeDescendantsByZeroHub.set(ent.id, descs);
  }

  // Fast in-memory partition evaluator (< 0.2ms per state)
  const evaluateState = (
    assignment: Map<string, string>,
    buckets: Map<string, BucketMeta>,
    appliedCandidateIds: string[],
    moveCostByEntity: Map<string, number>
  ): SearchState | null => {
    const membersByBucket = new Map<string, string[]>();
    for (const fid of sortedFineIds) {
      const bid = assignment.get(fid)!;
      const list = membersByBucket.get(bid) ?? [];
      list.push(fid);
      membersByBucket.set(bid, list);
    }
    const L = membersByBucket.size;

    // HG4: Minimum 2 lanes when fineLaneCount >= 2
    if (fineLaneCount >= 2 && L < 2) return null;

    // HG1: Pinned entities must stay alone in their own bucket
    for (const pid of pinned) {
      if (!finePartsByEnt.has(pid)) continue;
      if (assignment.get(pid) !== pid || (membersByBucket.get(pid)?.length ?? 0) !== 1) {
        return null;
      }
    }

    // HG1b: Hard separation pairs must not share a bucket
    for (const [a, b] of hardSepPairs) {
      const ba = assignment.get(a);
      const bb = assignment.get(b);
      if (ba && bb && ba === bb) return null;
    }

    // HG2, HG2b & HG2c: No 1-item subject_others, no ineligible entity in subject_others,
    // no <2-item 0-event/virtual hub, and Poset Antichain completeness on 0-event hubs (no partial parent rollup)
    const othersMembers = membersByBucket.get(SUBJECT_OTHERS_ID);
    if (othersMembers) {
      if (othersMembers.length < 2) return null;
      if (othersMembers.some((mid) => !eligibleOthersSet.has(mid))) return null;
    }
    for (const [bid, members] of membersByBucket) {
      const meta = buckets.get(bid);
      if (meta?.isZeroEventHub) {
        if (members.length < 2) return null;
        const reqDescs = activeDescendantsByZeroHub.get(bid);
        if (reqDescs && reqDescs.some((did) => assignment.get(did) !== bid)) {
          return null;
        }
      }
      if (meta?.isVirtualGroup && members.length < 2) return null;
    }

    // HG3 & HG3b: Outcome visibility & prevent outcome from being stranded solely on subject_others
    const bucketEvents = new Map<string, Set<string>>();
    for (const [bid, members] of membersByBucket) {
      const evSet = new Set<string>();
      for (const mid of members) {
        for (const p of finePartsByEnt.get(mid) ?? []) {
          evSet.add(p.eventId);
        }
      }
      bucketEvents.set(bid, evSet);
    }
    for (const outId of outcomeEventIds) {
      const outParts = fineBase.participations.filter(
        (p) => p.eventId === outId && finePartsByEnt.has(p.entityId)
      );
      if (outParts.length > 0) {
        let shown = false;
        let shownOutsideOthers = false;
        for (const [bid, evSet] of bucketEvents) {
          if (evSet.has(outId)) {
            shown = true;
            if (bid !== SUBJECT_OTHERS_ID) shownOutsideOthers = true;
          }
        }
        if (!shown) return null;
        const hadNonOtherParticipant = outParts.some(
          (p) => fineEntById.get(p.entityId)?.kind !== 'other'
        );
        if (hadNonOtherParticipant && !shownOutsideOthers) return null;
      }
    }

    // C1: Lane count fitness peaking at targetK (smooth strictly monotonic curve on L > targetK)
    let c1 = 1.0;
    if (L > targetK) {
      const excess = L - targetK;
      c1 = 1 / (1 + 0.28 * excess + 0.05 * excess * excess);
    } else if (L < targetK && L < fineLaneCount) {
      c1 = Math.max(0.2, 1 - 0.08 * (targetK - L));
    }

    // C2: Convex semantic load with inclusion penalty floor max(c_cand, P_sub) + soft separation penalties
    let softPenalty = 0;
    for (const [a, b] of softSepPairs) {
      const ba = assignment.get(a);
      const bb = assignment.get(b);
      if (ba && bb && ba === bb) softPenalty += 0.14;
    }
    // Partition-aware resilient defender check: ensure resilient/recovery events are not collapsed solely into pure-adverse buckets
    for (const resEvId of resilientEventIds) {
      const hostingBuckets: string[] = [];
      for (const [bid, evSet] of bucketEvents) {
        if (evSet.has(resEvId)) hostingBuckets.push(bid);
      }
      if (hostingBuckets.length > 0 && hostingBuckets.every((bid) => pureAdverseIds.has(bid))) {
        softPenalty += 0.35;
      }
    }

    let convexSemanticLoad = 0;
    for (const fid of sortedFineIds) {
      const bid = assignment.get(fid)!;
      if (bid === fid) continue;
      const candShare = moveCostByEntity.get(fid) ?? 0.1;
      const subPenalty = computeInclusionPenalty(
        fid,
        bid,
        membersByBucket.get(bid) ?? [],
        buckets.get(bid)?.isVirtualGroup
      );
      const effCost = Math.max(candShare, subPenalty);
      convexSemanticLoad += moveConvexCost(effCost);
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

    // C4: Boundary cleanliness (penalize unmerged passive machines / 0-actor shells when L > targetK)
    let unmergedPassiveCount = 0;
    for (const pid of passiveEntityIds) {
      if (assignment.get(pid) === pid && (membersByBucket.get(pid)?.length ?? 0) === 1) {
        unmergedPassiveCount++;
      }
    }
    const c4 = Math.max(0, 1 - (L > targetK ? 0.18 : 0.06) * unmergedPassiveCount);

    // C5: Card density & max lane height after shared-event deduplication per bucket
    let totalCards = 0;
    let maxLaneCards = 0;
    for (const [bid, evSet] of bucketEvents) {
      totalCards += evSet.size;
      if (bid !== SUBJECT_OTHERS_ID && evSet.size > maxLaneCards) {
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
      assignment,
      buckets,
      appliedCandidateIds,
      moveCostByEntity,
      convexSemanticLoad,
      softPenalty,
      signature: computeStateSignature(assignment, sortedFineIds),
      score: displayScore,
      objective,
      metrics: roundedMetrics,
      laneCount: L,
    };
  };

  // Build initial fine-grained state P_0
  const initAssignment = new Map<string, string>();
  const initBuckets = new Map<string, BucketMeta>();
  for (const ent of fineBase.entities) {
    const isPart = finePartsByEnt.has(ent.id);
    initBuckets.set(ent.id, {
      id: ent.id,
      name: ent.name,
      kind: ent.kind,
      isZeroEventHub: !isPart,
    });
    if (isPart) {
      initAssignment.set(ent.id, ent.id);
    }
  }
  initBuckets.set(SUBJECT_OTHERS_ID, {
    id: SUBJECT_OTHERS_ID,
    name: OTHER_ACTORS_ENTITY_NAME,
    kind: 'other',
    aggregate: true,
  });

  // Pre-register virtual group bucket IDs for role_group candidates
  const candidateBucketId = new Map<string, string>();
  let grpIdx = 1;
  for (const cand of candidates) {
    if (cand.targetEntityId) {
      candidateBucketId.set(cand.id, cand.targetEntityId);
    } else {
      const label = cand.targetLabel ?? `グループ${grpIdx}`;
      let bid = slugifyGroupId(label, grpIdx++);
      while (fineEntById.has(bid)) bid = `${bid}_${grpIdx++}`;
      candidateBucketId.set(cand.id, bid);
      if (!initBuckets.has(bid)) {
        initBuckets.set(bid, {
          id: bid,
          name: label,
          kind: cand.targetKind ?? 'organization',
          isVirtualGroup: true,
        });
      }
    }
  }

  const initialState = evaluateState(initAssignment, initBuckets, [], new Map())!;
  let evaluatedStates = 1;

  // Fast-path: already within target lane count and no passive clutter to absorb
  if (fineLaneCount <= targetK && passiveEntityIds.size === 0) {
    const laneAssignmentObj = Object.fromEntries(initialState.assignment);
    const consolidation: VTALaneConsolidationState = {
      version: 1,
      targetMaxSubjects: targetK,
      appliedCandidateIds: [],
      laneAssignment: laneAssignmentObj,
      score: initialState.score,
      metrics: initialState.metrics,
      candidates: [...candidates],
      separationConstraints: [...separationConstraints],
    };
    const bestSchema = projectPartitionToSchema(
      fineBase,
      baseAnalysis,
      initialState.assignment,
      initialState.buckets,
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

  // Helper to apply 1 or 2 candidates onto a state (without evaluating HG2 until after all moves in the step are applied!)
  const applyCandidatesRaw = (
    base: SearchState,
    moves: readonly VTALaneMergeCandidate[]
  ): {
    assignment: Map<string, string>;
    appliedIds: string[];
    moveCosts: Map<string, number>;
  } | null => {
    const nextAssign = new Map(base.assignment);
    const nextMoveCosts = new Map(base.moveCostByEntity);
    const addedIds: string[] = [];

    for (const m of moves) {
      const targetBid = candidateBucketId.get(m.id)!;
      // Resolve transitive target if targetBid itself was already rolled up into an ancestor bucket
      const effectiveTarget = nextAssign.get(targetBid) ?? targetBid;
      const hasMembersPointingTo = (hubId: string): boolean => {
        for (const v of nextAssign.values()) {
          if (v === hubId) return true;
        }
        return false;
      };
      const validSources = m.sourceEntityIds.filter(
        (sid) => finePartsByEnt.has(sid) || hasMembersPointingTo(sid)
      );
      if (validSources.length === 0) continue;

      const targetMeta = base.buckets.get(effectiveTarget);
      const isOpeningDiscoveredBucket =
        (targetMeta?.isVirtualGroup || effectiveTarget === SUBJECT_OTHERS_ID) &&
        !hasMembersPointingTo(effectiveTarget);
      const perSourceCost =
        isOpeningDiscoveredBucket && validSources.length >= 2
          ? (() => {
              const reducedLanes = Math.max(1, validSources.length - 1);
              const perReductionCost = m.semanticCost / reducedLanes;
              const targetGroupLoad = reducedLanes * moveConvexCost(perReductionCost);
              return invertMoveConvexCost(targetGroupLoad / validSources.length);
            })()
          : m.semanticCost / validSources.length;
      let newlyMovedCount = 0;
      let conflict = false;
      for (const sid of validSources) {
        if (pinned.has(sid) || sid === effectiveTarget) {
          conflict = true;
          break;
        }
        // 2-stage rollup of a 0-event intermediate Poset hub or virtual group that already holds active members
        if (!finePartsByEnt.has(sid)) {
          const hubMembers: string[] = [];
          for (const [k, v] of nextAssign) {
            if (v === sid) hubMembers.push(k);
          }
          if (hubMembers.length === 0) continue;
          if (
            effectiveTarget === SUBJECT_OTHERS_ID &&
            hubMembers.some((k) => !eligibleOthersSet.has(k))
          ) {
            conflict = true;
            break;
          }
          for (const k of hubMembers) {
            nextAssign.set(k, effectiveTarget);
            nextMoveCosts.set(k, Math.max(nextMoveCosts.get(k) ?? 0, perSourceCost));
          }
          newlyMovedCount++;
          continue;
        }
        if (effectiveTarget === SUBJECT_OTHERS_ID && !eligibleOthersSet.has(sid)) {
          conflict = true;
          break;
        }
        const curBucket = nextAssign.get(sid)!;
        if (curBucket === effectiveTarget) continue;
        // Do not steal an entity that was already moved into a different non-self bucket,
        // EXCEPT monotone upward Poset coarsening (curBucket < effectiveTarget, e.g. G_RELAY -> A6)
        const isMonotonePosetCoarsening =
          fineEntById.has(effectiveTarget) &&
          fineEntById.has(curBucket) &&
          poset.isAncestor(effectiveTarget, curBucket);
        if (curBucket !== sid && !isMonotonePosetCoarsening) {
          conflict = true;
          break;
        }
        // Redirect any entities currently pointing to `sid` (when `sid` was a parent bucket!) to `effectiveTarget`,
        // EXCEPT never transitively drag absorbed Poset children into `subject_others`!
        for (const [k, v] of nextAssign) {
          if (v === sid) {
            if (effectiveTarget === SUBJECT_OTHERS_ID && k !== sid) {
              conflict = true;
              break;
            }
            nextAssign.set(k, effectiveTarget);
          }
        }
        if (conflict) break;
        nextAssign.set(sid, effectiveTarget);
        nextMoveCosts.set(sid, Math.max(nextMoveCosts.get(sid) ?? 0, perSourceCost));
        newlyMovedCount++;
      }
      if (conflict || newlyMovedCount === 0) return null;
      addedIds.push(m.id);
    }

    if (addedIds.length === 0) return null;
    return {
      assignment: nextAssign,
      appliedIds: [...base.appliedCandidateIds, ...addedIds],
      moveCosts: nextMoveCosts,
    };
  };

  // Group single-source candidates by target bucket (sorted by cost asc) so 2-step plateau pairs are explored directly
  const singleByBucket = new Map<string, VTALaneMergeCandidate[]>();
  for (const c of candidates) {
    if (c.sourceEntityIds.length === 1) {
      const bid = candidateBucketId.get(c.id)!;
      const meta = initBuckets.get(bid);
      if (bid === SUBJECT_OTHERS_ID || meta?.isZeroEventHub || meta?.isVirtualGroup) {
        const list = singleByBucket.get(bid) ?? [];
        list.push(c);
        singleByBucket.set(bid, list);
      }
    }
  }
  for (const list of singleByBucket.values()) {
    list.sort((a, b) => a.semanticCost - b.semanticCost);
  }

  const visited = new Set<string>([initialState.signature]);
  const allValidStates: SearchState[] = [initialState];
  let currentBeam: SearchState[] = [initialState];

  // Seed progressive trajectory from LLM [推奨統合] candidates so natural multi-axis Poset cuts are evaluated directly
  const recommendedCands = candidates
    .filter((c) => c.recommended === true)
    .sort((a, b) => a.semanticCost - b.semanticCost);
  if (recommendedCands.length > 0) {
    const recSteps: VTALaneMergeCandidate[][] = [];
    const groupedByHub = new Map<string, VTALaneMergeCandidate[]>();
    for (const rc of recommendedCands) {
      const bid = candidateBucketId.get(rc.id)!;
      const meta = initBuckets.get(bid);
      if (
        rc.sourceEntityIds.length === 1 &&
        (bid === SUBJECT_OTHERS_ID || meta?.isZeroEventHub || meta?.isVirtualGroup)
      ) {
        const list = groupedByHub.get(bid);
        if (list) {
          list.push(rc);
        } else {
          const created = [rc];
          groupedByHub.set(bid, created);
          recSteps.push(created);
        }
      } else {
        recSteps.push([rc]);
      }
    }
    let recCursor = initialState;
    for (const stepMoves of recSteps) {
      const applied = applyCandidatesRaw(recCursor, stepMoves);
      if (!applied) continue;
      evaluatedStates++;
      const evaluated = evaluateState(
        applied.assignment,
        recCursor.buckets,
        applied.appliedIds,
        applied.moveCosts
      );
      if (!evaluated) continue;
      recCursor = evaluated;
      if (!visited.has(evaluated.signature)) {
        visited.add(evaluated.signature);
        allValidStates.push(evaluated);
      }
    }
    if (recCursor !== initialState) {
      currentBeam = [recCursor, initialState];
    }
  }

  for (let step = 0; step < maxSteps; step++) {
    const nextCandidatesPool: SearchState[] = [];

    for (const state of currentBeam) {
      // 1-move neighborhood
      for (const cand of candidates) {
        const applied = applyCandidatesRaw(state, [cand]);
        if (!applied) continue;
        const sig = computeStateSignature(applied.assignment, sortedFineIds);
        if (visited.has(sig)) continue;
        visited.add(sig);
        evaluatedStates++;
        const evaluated = evaluateState(
          applied.assignment,
          state.buckets,
          applied.appliedIds,
          applied.moveCosts
        );
        if (evaluated) {
          nextCandidatesPool.push(evaluated);
          allValidStates.push(evaluated);
        }
      }

      // 2-move (and all-member 0-event hub) plateau-crossing composite neighborhood
      for (const [bid, group] of singleByBucket) {
        if (initBuckets.get(bid)?.isZeroEventHub && group.length >= 3) {
          const appliedAll = applyCandidatesRaw(state, group);
          if (appliedAll) {
            const sigAll = computeStateSignature(appliedAll.assignment, sortedFineIds);
            if (!visited.has(sigAll)) {
              visited.add(sigAll);
              evaluatedStates++;
              const evalAll = evaluateState(
                appliedAll.assignment,
                state.buckets,
                appliedAll.appliedIds,
                appliedAll.moveCosts
              );
              if (evalAll) {
                nextCandidatesPool.push(evalAll);
                allValidStates.push(evalAll);
              }
            }
          }
        }
        const cap = Math.min(group.length, 8);
        for (let i = 0; i < cap; i++) {
          for (let j = i + 1; j < cap; j++) {
            const applied = applyCandidatesRaw(state, [group[i], group[j]]);
            if (!applied) continue;
            const sig = computeStateSignature(applied.assignment, sortedFineIds);
            if (visited.has(sig)) continue;
            visited.add(sig);
            evaluatedStates++;
            const evaluated = evaluateState(
              applied.assignment,
              state.buckets,
              applied.appliedIds,
              applied.moveCosts
            );
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

    // Early stop if top of beam cannot improve further and already reached targetK
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
    const tempMeta: VTALaneConsolidationState = {
      version: 1,
      targetMaxSubjects: targetK,
      appliedCandidateIds: finalist.appliedCandidateIds,
      laneAssignment: Object.fromEntries(finalist.assignment),
      score: finalist.score,
      metrics: finalist.metrics,
      candidates: [...candidates],
      separationConstraints: [...separationConstraints],
    };
    const projected = projectPartitionToSchema(
      fineBase,
      baseAnalysis,
      finalist.assignment,
      finalist.buckets,
      tempMeta,
      options?.previousSchema
    );
    const wiring = auditProjectionWiring(projected, eventRowMap);
    // HG3 full projection verification: zero backward intra-lane edges & zero DAG inversions
    if (wiring.backwardIntraLaneEdges.length > 0 || wiring.dagSequenceInversions.length > 0) {
      continue;
    }
    const machine = computeMachineMetrics(projected, targetK);
    if (machine.gateViolations.length > 0 && finalist !== initialState) {
      continue;
    }
    // Blend fast interaction-aware C1/C2/C3/C4 with exact projected C5 & C3 reachability
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

  const finalConsolidation: VTALaneConsolidationState = {
    version: 1,
    targetMaxSubjects: targetK,
    appliedCandidateIds: winningState.appliedCandidateIds,
    laneAssignment: Object.fromEntries(winningState.assignment),
    score: winningState.score,
    metrics: winningState.metrics,
    candidates: [...candidates],
    separationConstraints: [...separationConstraints],
  };

  if (!winningSchema) {
    winningSchema = projectPartitionToSchema(
      fineBase,
      baseAnalysis,
      initialState.assignment,
      initialState.buckets,
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
    posetForCount
  );
  const fineLaneCount = fineBase.entities.filter(
    (e) =>
      !passivelyCoveredForCount.has(e.id) &&
      fineBase.participations.some((p) => p.entityId === e.id && activeEvIdSet.has(p.eventId))
  ).length;

  const fallback = generateStructuralFallbackCandidates(fineBase, baseAnalysis, pinnedSet);
  let llmCandidates: VTALaneMergeCandidate[] = [];
  let llmSeparations: VTASeparationConstraint[] = [];
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

  const candById = new Map(mergedPool.candidates.map((c) => [c.id, c]));
  const appliedMovesSummary = searched.consolidation.appliedCandidateIds.map((cid) => {
    const c = candById.get(cid);
    if (!c) return cid;
    return `${cid}(${c.sourceEntityIds.join(',')}->${c.targetEntityId ?? c.targetLabel ?? '?'}:${c.semanticCost.toFixed(2)})`;
  });

  debugRecorder.record(
    'lane.consolidation',
    () => ({
      fineLaneCount: searched.fineLaneCount,
      targetMaxSubjects: targetK,
      finalLaneCount: searched.finalLaneCount,
      llmCalled,
      llmCandidateCount: llmCandidates.length,
      totalCandidateCount: mergedPool.candidates.length,
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
