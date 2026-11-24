import type {
  OthersConsolidationMode,
  VTAAnalysisData,
  VTAEntity,
  VTAEventRelation,
  VTAParticipation,
  VTASchema,
  VTASubjectConsolidationStage,
  VTASubjectRankEntry,
  VTASubjectRanking,
} from '../../../types/vta';
import { buildAnalysis, createManualAnalysis, isIdentifiedOutcomeEvent, projectAnalysis, validateParticipants } from './eventAnalysis';
import { dependencyProblem, isPrecedence } from './eventOrder';
import { isOtherActorsLaneName, mergeLanesAfterConsolidation, OTHER_ACTORS_ENTITY_NAME } from './laneOrder';
import { shiftSchemaPositionsForLaneChange } from './lanePositionShift';
import { visibleSchema } from './presentation';
import { connectSharedEvents } from './sharedEvents';
import { SubjectPoset } from './subjectPoset';
import { isResilientReasonText } from './variationFactor';

export { OTHER_ACTORS_ENTITY_NAME };
export const DEFAULT_MAX_SUBJECTS = 5;
export const MIN_MAX_SUBJECTS = 2;
export const MAX_MAX_SUBJECTS = 12;

export const DEFAULT_SUBJECT_RANKING_WEIGHTS: Record<'A' | 'O' | 'F' | 'C' | 'T', number> = {
  A: 0.30,
  O: 0.25,
  F: 0.20,
  C: 0.15,
  T: 0.10,
};

const ROLE_PRIORITY: Record<VTAParticipation['role'], number> = {
  actor: 5,
  confirmed_recipient: 4,
  intended_recipient: 3,
  target: 2,
  affected: 1,
};

export function clampSubjectLimit(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_SUBJECTS;
  return Math.max(MIN_MAX_SUBJECTS, Math.min(MAX_MAX_SUBJECTS, Math.round(value)));
}

/**
 * ADR-0072: 2段階主体上限における「その他の関係者」統合前の最大主体数 K_pre を導出する。
 * 明示指定がない場合は K_pre = min(12, max(K_post, K_post + 3)) を既定とする。
 */
export function derivePreConsolidationLimit(
  postMaxSubjects: number = DEFAULT_MAX_SUBJECTS,
  explicitPreMax?: number
): number {
  const post = Math.max(
    1,
    Math.min(MAX_MAX_SUBJECTS, Math.round(Number.isFinite(postMaxSubjects) ? postMaxSubjects : DEFAULT_MAX_SUBJECTS))
  );
  if (typeof explicitPreMax === 'number' && Number.isFinite(explicitPreMax)) {
    return Math.max(post, clampSubjectLimit(explicitPreMax));
  }
  return Math.min(MAX_MAX_SUBJECTS, Math.max(post, post + 3));
}

function isReporterEntity(entity: VTAEntity): boolean {
  if (entity.focus === 'reporter') return true;
  if (entity.focus === 'high' && /^(私|筆者|報告者|当方|自分)($|[（(・\s])/.test(entity.name.trim())) {
    return true;
  }
  return false;
}

function computeOutcomeDistances(analysis: VTAAnalysisData): Map<string, number> | null {
  const outcome = analysis.outcome;
  if (!outcome || outcome.status !== 'identified' || !outcome.eventIds.length) {
    return null;
  }
  const eventIds = new Set(analysis.events.map((e) => e.id));
  const validSeeds = outcome.eventIds.filter((id) => eventIds.has(id));
  if (!validSeeds.length) return null;

  const reverseAdj = new Map<string, Set<string>>();
  const addEdge = (from: string, to: string) => {
    if (!eventIds.has(from) || !eventIds.has(to) || from === to) return;
    const set = reverseAdj.get(from) ?? new Set<string>();
    set.add(to);
    reverseAdj.set(from, set);
  };

  for (const rel of analysis.relations) {
    if (rel.kind === 'mutual' || rel.kind === 'common') {
      addEdge(rel.targetEventId, rel.sourceEventId);
      addEdge(rel.sourceEventId, rel.targetEventId);
    } else {
      // Backward from target to source along before / transfer / impact / dependency
      addEdge(rel.targetEventId, rel.sourceEventId);
    }
  }

  const dist = new Map<string, number>();
  const queue: string[] = [];
  for (const seed of validSeeds) {
    dist.set(seed, 0);
    queue.push(seed);
  }
  while (queue.length > 0) {
    const cur = queue.shift()!;
    const d = dist.get(cur)!;
    for (const prev of reverseAdj.get(cur) ?? []) {
      if (!dist.has(prev)) {
        dist.set(prev, d + 1);
        queue.push(prev);
      }
    }
  }
  return dist;
}

export interface MergeGuardResult {
  allowed: boolean;
  reason?: string;
  /** True when divergence reflects outcome asymmetry, physical impact, mutual coordination, or person rescue rather than same-outcome informational transfer. */
  strictAsymmetry?: boolean;
}

function isEffectiveVariationEvent(
  analysis: VTAAnalysisData,
  ev: VTAAnalysisData['events'][number] | undefined
): boolean {
  if (!ev) return false;
  if (ev.classification === 'variation' || Boolean(ev.variationFactor)) return true;
  if (ev.classification !== 'unclassified' || ev.preliminary?.value !== 'variation') return false;
  const isRecoveryOutcome =
    ev.outcome_kind === 'recovery' ||
    (analysis.outcome?.kind === 'recovery' && analysis.outcome.eventIds.includes(ev.id));
  return isRecoveryOutcome || !isIdentifiedOutcomeEvent(analysis, ev);
}

function isEffectiveRecoveryEvent(
  analysis: VTAAnalysisData,
  ev: VTAAnalysisData['events'][number] | undefined
): boolean {
  if (!ev) return false;
  return (
    ev.outcome_kind === 'recovery' ||
    (analysis.outcome?.kind === 'recovery' && analysis.outcome.eventIds.includes(ev.id))
  );
}

/**
 * ADR-0008: 主体間の帰結非対称性・直接介入・役割対立を検証し、親組織への統合をブロックするか判定する
 */
export function evaluateMergeGuard(
  sourceEntityId: string,
  targetEntityId: string,
  analysis: VTAAnalysisData
): MergeGuardResult {
  const eventById = new Map(analysis.events.map((e) => [e.id, e]));
  const getEvent = (id: string) => eventById.get(id);

  // 0. 共通の純粋上位ハブ（0イベント複合主体：例「運転士Aが操作する列車X」）を持つ操作者(person/organization)と機械(machine)のペアは、
  // 自律制御異常・モード不整合(ACTIVE_MACHINE_PATTERN)がない限り自動ハード分離せず統合候補として許容する
  const entA = analysis.entities.find((e) => e.id === sourceEntityId);
  const entB = analysis.entities.find((e) => e.id === targetEntityId);
  const machEnt = entA?.kind === 'machine' ? entA : entB?.kind === 'machine' ? entB : undefined;
  const nonMachEnt =
    machEnt && entA && entB ? (machEnt.id === entA.id ? entB : entA) : undefined;
  if (machEnt && nonMachEnt && nonMachEnt.kind !== 'machine') {
    const poset = analysis.subjectPoset
      ? SubjectPoset.fromData(analysis.subjectPoset)
      : SubjectPoset.fromEntities(analysis.entities);
    const machAncs = new Set(
      Array.from(poset.getAncestors(machEnt.id)).filter((id) => id !== machEnt.id)
    );
    const nonMachAncs = Array.from(poset.getAncestors(nonMachEnt.id)).filter(
      (id) => id !== nonMachEnt.id
    );
    const sharedZeroEventHub = nonMachAncs.some(
      (pid) =>
        machAncs.has(pid) &&
        !analysis.participations.some((p) => {
          if (p.entityId !== pid) return false;
          const ev = getEvent(p.eventId);
          return Boolean(ev && !ev.ignored);
        })
    );
    if (sharedZeroEventHub) {
      const machEvents = analysis.participations
        .filter((p) => p.entityId === machEnt.id)
        .map((p) => getEvent(p.eventId))
        .filter((e): e is NonNullable<typeof e> => Boolean(e));
      const hasAutonomousConflict = machEvents.some(
        (ev) =>
          ACTIVE_MACHINE_PATTERN.test(ev.title) ||
          ACTIVE_MACHINE_PATTERN.test(ev.description) ||
          Boolean(
            ev.variationFactor?.description &&
              ACTIVE_MACHINE_PATTERN.test(ev.variationFactor.description)
          )
      );
      if (!hasAutonomousConflict) {
        return { allowed: true };
      }
    }
  }

  // 1. 2者間の直接介入・救援・物理影響エッジ（impact, transfer, dependency, mutual）のチェック
  const isSpecialEventId = (eventId: string): boolean => {
    const ev = getEvent(eventId);
    return isEffectiveVariationEvent(analysis, ev) || isEffectiveRecoveryEvent(analysis, ev);
  };

  let softBlockReason: string | undefined;
  for (const rel of analysis.relations) {
    if (rel.kind === 'before') continue;
    const src = rel.sourceEntityOrigin ?? rel.sourceEntityId;
    const tgt = rel.targetEntityOrigin ?? rel.targetEntityId;
    const isDirectRel =
      (src === sourceEntityId && tgt === targetEntityId) ||
      (src === targetEntityId && tgt === sourceEntityId);
    if (isDirectRel) {
      if (rel.kind === 'mutual') {
        return { allowed: false, strictAsymmetry: true, reason: '主体間に直接の相互確認・相互調整が存在するため独立維持' };
      }
      if (rel.kind === 'impact') {
        return { allowed: false, strictAsymmetry: true, reason: '主体間に直接の物理影響・被災関係が存在するため独立維持' };
      }
      const touchesSpecialEvent = isSpecialEventId(rel.sourceEventId) || isSpecialEventId(rel.targetEventId);
      const touchesRecoveryEvent =
        isEffectiveRecoveryEvent(analysis, getEvent(rel.sourceEventId)) ||
        isEffectiveRecoveryEvent(analysis, getEvent(rel.targetEventId));
      if (rel.kind === 'transfer' && (rel.resource === 'person' || touchesSpecialEvent)) {
        if (rel.resource === 'person' || touchesRecoveryEvent) {
          return {
            allowed: false,
            strictAsymmetry: true,
            reason: '主体間に救援・人員移動または異常対応移動が存在するため独立維持',
          };
        }
        softBlockReason ??= '主体間に救援・人員移動または異常対応移動が存在するため独立維持';
      }
      if (rel.kind === 'dependency' && touchesSpecialEvent) {
        if (touchesRecoveryEvent) {
          return {
            allowed: false,
            strictAsymmetry: true,
            reason: '異常発生または回復抑止に関する直接の介入指示が存在するため独立維持',
          };
        }
        softBlockReason ??= '異常発生または回復抑止に関する直接の介入指示が存在するため独立維持';
      }
    }
  }

  // 2. 変動要因（異常・被災） vs 回復行動（レジリエンス）の非対称性チェック
  const isResilientVariation = (ev: VTAAnalysisData['events'][number] | undefined): boolean => {
    if (!ev) return false;
    if (ev.preliminary?.polarity === 'resilient' || ev.variationFactor?.polarity === 'resilient') {
      return true;
    }
    const reasonText = ev.classificationReason || ev.preliminary?.reason || '';
    return isEffectiveVariationEvent(analysis, ev) && isResilientReasonText(reasonText);
  };

  const hasAdverseVariation = (entId: string) =>
    analysis.participations.some((p) => {
      if (p.entityId !== entId) return false;
      const ev = getEvent(p.eventId);
      return (
        isEffectiveVariationEvent(analysis, ev) &&
        !isResilientVariation(ev) &&
        !isEffectiveRecoveryEvent(analysis, ev)
      );
    });

  const hasResilienceOrRecovery = (entId: string) =>
    analysis.participations.some((p) => {
      if (p.entityId !== entId) return false;
      if (p.role === 'target' || p.role === 'intended_recipient') return false;
      const ev = getEvent(p.eventId);
      return isEffectiveRecoveryEvent(analysis, ev) || isResilientVariation(ev);
    });

  const srcAdv = hasAdverseVariation(sourceEntityId);
  const tgtAdv = hasAdverseVariation(targetEntityId);
  const srcRes = hasResilienceOrRecovery(sourceEntityId);
  const tgtRes = hasResilienceOrRecovery(targetEntityId);

  const srcPureAdv = srcAdv && !srcRes;
  const tgtPureAdv = tgtAdv && !tgtRes;
  if ((srcPureAdv && tgtRes) || (tgtPureAdv && srcRes)) {
    return { allowed: false, strictAsymmetry: true, reason: '異常発生側と回復・抑止側の役割が非対称であるため独立維持' };
  }

  // 3. 帰結到達の非対称性（異なる outcome_kind を持つか）
  const getOutcomeKinds = (entId: string): Set<string> => {
    const kinds = new Set<string>();
    for (const p of analysis.participations) {
      if (p.entityId !== entId) continue;
      const ev = getEvent(p.eventId);
      if (ev?.outcome_kind) {
        kinds.add(ev.outcome_kind);
      } else if (analysis.outcome?.status === 'identified' && analysis.outcome.eventIds.includes(p.eventId)) {
        kinds.add(analysis.outcome.kind ?? 'loss');
      }
    }
    return kinds;
  };

  const srcKinds = getOutcomeKinds(sourceEntityId);
  const tgtKinds = getOutcomeKinds(targetEntityId);
  if (srcKinds.size > 0 && tgtKinds.size > 0) {
    const common = Array.from(srcKinds).filter((k) => tgtKinds.has(k));
    if (common.length === 0) {
      return { allowed: false, strictAsymmetry: true, reason: '到達する帰結の種別（損失と回復等）が異なるため独立維持' };
    }
  }

  if (softBlockReason) {
    return { allowed: false, strictAsymmetry: false, reason: softBlockReason };
  }

  return { allowed: true };
}

export const ACTIVE_MACHINE_PATTERN =
  /(?:モード(?:遷移|移行|切替|不整合|誤認)|自律(?:制御|動作|介入)|自動(?:制御|操縦|ブレーキ|介入)|オートパイロット|インターロック|オーバーライド|フェイルセーフ|フェイルソフト|フォールバック|機能縮退|縮退(?:運転)?|Graceful\s*degradation|メンタルモデル|異常動作|暴走|誤作動|機器故障|システム障害)/i;

/**
 * ADR-0033: 人間-機械メンタルモデル不整合（Mode Confusion）や自律制御・機能縮退（Graceful degradation）
 * において、機械・装置が独立した主要アクターとして振る舞っているかを判定する。
 * 受動的な一方向警報ツール（ADR-0013）と区別し、双方向因果・変動要因・レジリエンス防護動作を持つ装置を昇格させる。
 */
export function isActiveOrInteractiveMachine(
  entity: VTAEntity,
  analysis: VTAAnalysisData
): boolean {
  if (entity.kind !== 'machine') return false;

  const parts = analysis.participations.filter((p) => p.entityId === entity.id);
  const eventById = new Map(analysis.events.map((e) => [e.id, e]));
  const machineEvents = parts
    .map((p) => eventById.get(p.eventId))
    .filter((e): e is NonNullable<typeof e> => Boolean(e));

  // 1. 変動要因（自律異常・故障）またはレジリエンス回復の保有
  const hasVariationOrResilience = machineEvents.some(
    (ev) => isEffectiveVariationEvent(analysis, ev) || isEffectiveRecoveryEvent(analysis, ev)
  );
  if (hasVariationOrResilience) return true;

  // 2. モード遷移・自律介入・機能縮退・不整合等のドメイン意味論シグナル
  const hasSemanticSignal = machineEvents.some(
    (ev) =>
      ACTIVE_MACHINE_PATTERN.test(ev.title) ||
      ACTIVE_MACHINE_PATTERN.test(ev.description) ||
      Boolean(ev.variationFactor?.description && ACTIVE_MACHINE_PATTERN.test(ev.variationFactor.description))
  );
  if (hasSemanticSignal) return true;

  // 3. 他主体（人間・組織等）との双方向因果ループ（HMI相互作用・Mental Model Mismatch）
  let hasIncomingCausal = false;
  let hasOutgoingCausal = false;
  for (const rel of analysis.relations) {
    if (rel.kind === 'before') continue;
    const src = rel.sourceEntityOrigin ?? rel.sourceEntityId;
    const tgt = rel.targetEntityOrigin ?? rel.targetEntityId;
    if (!src || !tgt || src === tgt) continue;
    if (rel.kind === 'mutual' && (src === entity.id || tgt === entity.id)) {
      return true;
    }
    if (src === entity.id && tgt !== entity.id) {
      hasOutgoingCausal = true;
    }
    if (tgt === entity.id && src !== entity.id) {
      hasIncomingCausal = true;
    }
  }
  if (hasIncomingCausal && hasOutgoingCausal) return true;

  // 4. 変動要因または回復イベントとの直接的な因果接続（他者のエラーが装置動作を誘発、または装置動作が他者のエラーを誘発）
  const machineEventIds = new Set(machineEvents.map((e) => e.id));
  for (const rel of analysis.relations) {
    if (rel.kind === 'before') continue;
    if (machineEventIds.has(rel.sourceEventId) || machineEventIds.has(rel.targetEventId)) {
      const otherEvId = machineEventIds.has(rel.sourceEventId) ? rel.targetEventId : rel.sourceEventId;
      const otherEv = eventById.get(otherEvId);
      if (isEffectiveVariationEvent(analysis, otherEv) || isEffectiveRecoveryEvent(analysis, otherEv)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * ADR-0008: インシデントの発生・進行・抑止・回復に影響を及ぼした主体か否かを判定する
 */
export function isInfluentialSubject(
  entity: VTAEntity,
  analysis: VTAAnalysisData
): { influential: boolean; reason?: string } {
  // 1. 優先保持主体
  if (entity.focus === 'reporter' || isReporterEntity(entity)) {
    return { influential: true, reason: '優先保持：報告者本人' };
  }
  const hasDirectParticipation = analysis.participations.some((p) => p.entityId === entity.id);
  const hasDirectRelationEndpoint = analysis.relations.some(
    (rel) =>
      rel.sourceEntityId === entity.id ||
      rel.targetEntityId === entity.id ||
      rel.sourceEntityOrigin === entity.id ||
      rel.targetEntityOrigin === entity.id
  );
  // 直接のイベント関与も関係端点参照も持たない純粋な包含定義用上位組織は、ハブ昇格時以外は優先枠を消費しない
  if (!hasDirectParticipation && !hasDirectRelationEndpoint && !entity.parentEntityId) {
    return { influential: false, reason: '変動要因や因果影響を持たない定常背景主体（レーン除外）' };
  }
  if (entity.focus === 'high') {
    return { influential: true, reason: '優先保持：高重要度指定' };
  }
  // 親組織が明示されている主体は組織的統合対象
  if (entity.parentEntityId) {
    return { influential: true, reason: '上位親組織を持つ関連主体' };
  }

  // 2. 帰結イベントへの直接関与
  const outcomeEventIds = new Set(analysis.outcome?.eventIds ?? []);
  const parts = analysis.participations.filter((p) => p.entityId === entity.id);
  if (parts.some((p) => outcomeEventIds.has(p.eventId))) {
    return { influential: true, reason: '帰結イベントに直接関与' };
  }

  // 3. 変動要因（variation）または変動候補の保有
  const eventById = new Map(analysis.events.map((e) => [e.id, e]));
  const hasVariation = parts.some((p) => isEffectiveVariationEvent(analysis, eventById.get(p.eventId)));
  if (hasVariation) {
    return { influential: true, reason: '変動要因または変動候補を保有' };
  }

  // ADR-0033: 能動的自律制御・対話的因果またはレジリエンス機能縮退を持つ装置は影響主体として優先保持
  if (isActiveOrInteractiveMachine(entity, analysis)) {
    return { influential: true, reason: '能動的自律制御・対話的因果またはレジリエンス機能縮退に関与' };
  }

  // 4. 不作為・防壁機能不全（関係属性 status === 'omitted' または未実施記述）の保有
  // 注: machine 種別の場合は支援機能の未検知・不作動を理由に人間や組織より優先昇格させない
  if (entity.kind !== 'machine') {
    const hasOmittedRelation = analysis.relations.some((rel) => {
      if (rel.status !== 'omitted') return false;
      const src = rel.sourceEntityOrigin ?? rel.sourceEntityId;
      const tgt = rel.targetEntityOrigin ?? rel.targetEntityId;
      return src === entity.id || tgt === entity.id;
    });
    const omissionPattern = /(見落とし|見逃し|未検知|不実施|未実施|失念|怠り|確認せず|気付かず|対応せず|放置)/;
    const hasOmission =
      hasOmittedRelation ||
      parts.some((p) => {
        const ev = eventById.get(p.eventId);
        if (!ev) return false;
        return omissionPattern.test(ev.title) || omissionPattern.test(ev.description);
      });
    if (hasOmission) {
      return { influential: true, reason: '不作為・未実施の防壁機能不全を保有' };
    }
  }

  // 5. 因果連鎖（他者との依存・物理影響・資源移動）への関与
  const hasCausalInteraction = analysis.relations.some((rel) => {
    if (rel.kind === 'before') return false;
    const src = rel.sourceEntityOrigin ?? rel.sourceEntityId;
    const tgt = rel.targetEntityOrigin ?? rel.targetEntityId;
    return (src === entity.id && tgt !== entity.id) || (tgt === entity.id && src !== entity.id);
  });
  if (hasCausalInteraction) {
    return { influential: true, reason: '他主体との因果的相互作用（依存・影響・移動）に関与' };
  }

  // 6. focusが明示的にlowの場合、または行動・関係が一切ない孤立主体は非影響・背景主体
  if (entity.focus === 'low' || parts.length === 0) {
    return { influential: false, reason: '変動要因や因果影響を持たない定常背景主体（レーン除外）' };
  }

  return { influential: true, reason: '通常関与主体' };
}

/**
 * ADR-0071 / ADR-0072: `subject_others` 衝突評価および統合判定において、
 * `focus: 'low'` であっても能動行為 (:actor)・変動要因・帰結・因果関係を持つ実質的アクターを識別する。
 */
export function isSubstantiveActorForConsolidation(
  entity: VTAEntity,
  analysis: VTAAnalysisData,
  opts?: { assumeParticipating?: boolean }
): boolean {
  if (entity.kind === 'machine' && !isActiveOrInteractiveMachine(entity, analysis)) {
    return false;
  }
  if (entity.focus !== 'low') {
    return opts?.assumeParticipating ? true : isInfluentialSubject(entity, analysis).influential;
  }
  const eventById = new Map(analysis.events.map((e) => [e.id, e]));
  const outcomeIds = new Set(analysis.outcome?.eventIds ?? []);
  for (const p of analysis.participations) {
    const matchedRole =
      p.entityId === entity.id
        ? p.role
        : p.mergedFrom?.find((m) => m.entityId === entity.id)?.role;
    if (!matchedRole) continue;
    if (matchedRole === 'actor') return true;
    if (outcomeIds.has(p.eventId)) return true;
    const ev = eventById.get(p.eventId);
    if (isEffectiveVariationEvent(analysis, ev) || isEffectiveRecoveryEvent(analysis, ev)) {
      return true;
    }
  }
  return analysis.relations.some((rel) => {
    if (rel.kind === 'before') return false;
    const src = rel.sourceEntityOrigin ?? rel.sourceEntityId;
    const tgt = rel.targetEntityOrigin ?? rel.targetEntityId;
    return (
      (src === entity.id && Boolean(tgt) && tgt !== entity.id) ||
      (tgt === entity.id && Boolean(src) && src !== entity.id)
    );
  });
}

/**
 * Penalty-based soft-constrained lane retention optimizer (ADR-0071).
 *
 * Models competing consolidation requirements as explicit penalty terms rather than
 * order-dependent procedural swaps:
 *   - Gentle convex lane-overflow penalty: 0.48 * ΔL + 0.22 * ΔL^2  (ΔL = max(0, L - limit))
 *   - Cluster Merge Guard violations: strictAsymmetry = 1.20, soft guard = 0.22
 *   - Multi-entity `subject_others` bucket penalty: 0.35 (>=2 substantive actors) / 0.12 (base)
 *     plus 0.55 * v(u) per unparented entity vs 0.22 * v(u) when rolled up into a retained ancestor
 *   - Passive / non-interactive machine dedicated lane penalty: 0.30
 */
interface OptimalRetentionInput<
  T extends {
    entity: VTAEntity;
    score: number;
    priority?: 'reporter' | 'outcome-actor';
  }
> {
  activePool: T[];
  effectiveLimit: number;
  effectiveForceRetain: Set<string>;
  poset: SubjectPoset;
  entityById: Map<string, VTAEntity>;
  analysis: VTAAnalysisData;
  influenceMap: Map<string, { influential: boolean; reason?: string }>;
  options?: SubjectRankingOptions;
  /** ADR-0075: 最終フェーズのグラフ接続監査で subject_others 集約を許可された周辺主体ID集合 */
  canFoldToOthersById?: ReadonlySet<string>;
  /** ADR-0075: 接続次数・LLM周辺提案に基づく subject_others 集約の個別コスト上書き */
  othersCostById?: ReadonlyMap<string, number>;
  /** 既存の subject_others 主体ID（存在する場合） */
  existingOthersId?: string;
  /** 既存の subject_others が既にアクティブ列として存在するか */
  existingOthersActive?: boolean;
  /** 直接イベント0件だが2件以上の関与子孫を持つ候補親組織ハブID集合（2件以上の子孫を吸収する場合のみ保持、それ以外は excluded） */
  zeroEventHubIds?: ReadonlySet<string>;
}

interface OptimalRetentionResult {
  retainedIds: Set<string>;
  mergeTargetById: Map<string, string>;
  excludedIds: Set<string>;
  mergeBlockedReasonById: Map<string, string>;
  othersId: string;
  excessLanes: number;
}

export function computeLaneOverflowPenalty(excessLanes: number, effectiveLimit: number = DEFAULT_MAX_SUBJECTS): number {
  if (excessLanes <= 0) return 0;
  const scale = Math.min(1.45, 4.5 / Math.max(3, effectiveLimit));
  return (0.42 * excessLanes + 0.28 * excessLanes * excessLanes) * scale;
}

function solveOptimalSubjectRetention<
  T extends {
    entity: VTAEntity;
    score: number;
    priority?: 'reporter' | 'outcome-actor';
  }
>(input: OptimalRetentionInput<T>): OptimalRetentionResult {
  const {
    activePool,
    effectiveLimit,
    effectiveForceRetain,
    poset,
    entityById,
    analysis,
    influenceMap,
    options,
    canFoldToOthersById,
    othersCostById,
    existingOthersId,
    existingOthersActive = false,
    zeroEventHubIds,
  } = input;
  const n = activePool.length;
  const othersId = existingOthersId ?? getAggregateEntityId(Array.from(entityById.values()));
  const indexById = new Map(activePool.map((c, idx) => [c.entity.id, idx]));

  const chaseExplicit = (startId: string): string | undefined => {
    if (!options?.explicitMerges?.size) return undefined;
    let cur = options.explicitMerges.get(startId);
    const seen = new Set<string>([startId]);
    while (cur && options.explicitMerges.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = options.explicitMerges.get(cur);
    }
    return cur && cur !== startId ? cur : undefined;
  };

  const isForced = activePool.map((c) => effectiveForceRetain.has(c.entity.id));
  const isZeroEventHub = activePool.map((c) => Boolean(zeroEventHubIds?.has(c.entity.id)));
  const isInfluential = activePool.map((c) => influenceMap.get(c.entity.id)?.influential ?? true);
  const isExcludedWhenUnparented = activePool.map(
    (_, i) => isZeroEventHub[i] || Boolean(options?.excludeNonInfluential && !isInfluential[i] && !isForced[i])
  );
  const isSuppressedMachine = activePool.map(
    (c) => c.entity.kind === 'machine' && !isActiveOrInteractiveMachine(c.entity, analysis)
  );
  const isSubstantiveForOthers = activePool.map(
    (c, i) => !isSuppressedMachine[i] && isSubstantiveActorForConsolidation(c.entity, analysis)
  );
  const allowOthers = options?.allowSubjectOthers !== false;
  const canFoldToOthers = activePool.map((c) =>
    canFoldToOthersById ? canFoldToOthersById.has(c.entity.id) : true
  );

  // Intrinsic retention value v(u) with priority and rank-order tie-breaker (-i * 1e-4)
  const val = activePool.map((c, i) => {
    const baseVal = isSuppressedMachine[i]
      ? 0.06 * c.score
      : c.priority === 'reporter'
        ? 0.98
        : c.priority === 'outcome-actor'
          ? 0.92
          : c.entity.focus === 'low'
            ? 0.18 + 0.2 * c.score
            : 0.45 + 0.4 * c.score;
    return Math.max(0.02, baseVal - i * 1e-4);
  });
  const othersItemCost = activePool.map(
    (c, i) => othersCostById?.get(c.entity.id) ?? 0.26 * val[i]
  );

  // Precompute ordered candidate parents in activePool matching resolveParentTarget priority
  const orderedCandidateParents: number[][] = activePool.map((c) => {
    const id = c.entity.id;
    const seen = new Set<number>();
    const pushIfInPool = (targetId: string | undefined) => {
      if (!targetId || targetId === id) return;
      const idx = indexById.get(targetId);
      if (idx !== undefined && !seen.has(idx)) {
        seen.add(idx);
      }
    };
    pushIfInPool(chaseExplicit(id));
    for (const pid of poset.getImmediateParents(id)) pushIfInPool(pid);
    const ancestors = poset.getAncestors(id);
    for (const ancId of ancestors) pushIfInPool(ancId);
    if (options?.explicitMerges?.size) {
      for (const ancId of ancestors) pushIfInPool(chaseExplicit(ancId));
    }
    return Array.from(seen);
  });

  // Precompute symmetric pairwise Merge Guard table across entities & any already-merged members (0 = allowed, 1 = soft, 2 = strict)
  const guardLevel = new Uint8Array(n * n);
  const guardReason = new Map<number, string>();
  const guardRowHasAnyBlock = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    const idsI = [activePool[i].entity.id, ...(activePool[i].entity.mergedFrom ?? [])];
    for (let j = i + 1; j < n; j++) {
      const idsJ = [activePool[j].entity.id, ...(activePool[j].entity.mergedFrom ?? [])];
      let worstLvl = 0;
      let worstReason: string | undefined;
      for (const aId of idsI) {
        for (const bId of idsJ) {
          if (aId === bId) continue;
          const g = evaluateMergeGuard(aId, bId, analysis);
          if (!g.allowed) {
            const lvl = g.strictAsymmetry ? 2 : 1;
            if (lvl > worstLvl) {
              worstLvl = lvl;
              worstReason = g.reason;
            }
          }
        }
      }
      if (worstLvl > 0) {
        guardLevel[i * n + j] = worstLvl;
        guardLevel[j * n + i] = worstLvl;
        guardRowHasAnyBlock[i] = true;
        guardRowHasAnyBlock[j] = true;
        if (worstReason) {
          guardReason.set(i * n + j, worstReason);
          guardReason.set(j * n + i, worstReason);
        }
      }
    }
  }

  // Precompute sibling pairs sharing an immediate Poset parent (for ADR-0008 sibling guard when parent is unretained)
  const immediateParentsByIdx = activePool.map((c) => poset.getImmediateParents(c.entity.id));
  const sharedParentSiblings: number[][] = activePool.map((_, i) => {
    const pSet = immediateParentsByIdx[i];
    if (pSet.length === 0) return [];
    const sibs: number[] = [];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      if (pSet.some((pid) => poset.isAncestor(pid, activePool[j].entity.id))) {
        sibs.push(j);
      }
    }
    return sibs;
  });

  const descendantsInPool: number[][] = activePool.map((c, i) => {
    const descs: number[] = [];
    for (let j = 0; j < n; j++) {
      if (j !== i && poset.isAncestor(c.entity.id, activePool[j].entity.id)) {
        descs.push(j);
      }
    }
    return descs;
  });
  const hasDescendantsInPool = descendantsInPool.map((d) => d.length > 0);
  const revEventById = new Map(analysis.events.map((e) => [e.id, e]));
  const hasDirectVariation = activePool.map((c) =>
    analysis.participations.some(
      (p) => p.entityId === c.entity.id && isEffectiveVariationEvent(analysis, revEventById.get(p.eventId))
    )
  );
  const isHighVariationActor = activePool.map(
    (c, i) =>
      !isForced[i] &&
      !isSuppressedMachine[i] &&
      c.entity.kind === 'person' &&
      c.entity.focus === 'high' &&
      hasDirectVariation[i]
  );
  const isLowSubordinate = activePool.map(
    (c, i) => !isForced[i] && !c.priority && !isSuppressedMachine[i] && c.entity.focus === 'low'
  );
  const isCleanLeaf = activePool.map(
    (c, i) =>
      !isForced[i] &&
      !isZeroEventHub[i] &&
      !isHighVariationActor[i] &&
      !c.priority &&
      !isSuppressedMachine[i] &&
      !hasDescendantsInPool[i] &&
      !guardRowHasAnyBlock[i]
  );

  const forcedCount = isForced.filter(Boolean).length;
  const maxAllowedLanes = allowOthers
    ? Math.max(forcedCount + 1, effectiveLimit, Math.min(12, effectiveLimit + 3))
    : Math.max(n, effectiveLimit);

  const subroleLoss = (i: number): number =>
    isLowSubordinate[i]
      ? 0.03 * val[i]
      : isHighVariationActor[i]
        ? 0.28 * val[i]
        : 0.12 * val[i];
  const guardCost = (lvl: number): number => (lvl === 2 ? 1.5 : lvl === 1 ? 0.2 : 0);

  const evaluateFullCost = (inR: boolean[]): number => {
    let retainedCount = 0;
    let cost = 0;
    const clusters = new Map<number, number[]>();
    const othersList: number[] = [];

    for (let i = 0; i < n; i++) {
      if (inR[i]) {
        retainedCount++;
        clusters.set(i, [i]);
        if (
          isLowSubordinate[i] &&
          !guardRowHasAnyBlock[i] &&
          orderedCandidateParents[i].some((pIdx) => inR[pIdx])
        ) {
          cost += 0.06;
        }
      }
    }

    if (retainedCount === 0 && !existingOthersActive) return Infinity;

    for (let i = 0; i < n; i++) {
      if (inR[i]) continue;
      if (isZeroEventHub[i]) continue;
      let parentIdx = -1;
      for (const pIdx of orderedCandidateParents[i]) {
        if (inR[pIdx]) {
          parentIdx = pIdx;
          break;
        }
      }
      if (parentIdx !== -1) {
        const cluster = clusters.get(parentIdx)!;
        let worstLvl = 0;
        for (const memberIdx of cluster) {
          const lvl = guardLevel[i * n + memberIdx];
          if (lvl > worstLvl) worstLvl = lvl;
        }
        // ADR-0008: Do not hide one half of a strict-asymmetric sibling pair inside their shared parent
        if (worstLvl < 2) {
          for (const descIdx of descendantsInPool[parentIdx]) {
            if (inR[descIdx] && guardLevel[i * n + descIdx] === 2) {
              worstLvl = 2;
              break;
            }
          }
        }
        cluster.push(i);
        cost += subroleLoss(i) + guardCost(worstLvl);
      } else if (!isExcludedWhenUnparented[i]) {
        if (!canFoldToOthers[i]) return Infinity;
        othersList.push(i);
      }
    }

    // 0件候補親組織ハブは、実際に2件以上の関与子孫を吸収して列数を削減する場合にのみ保持を許可する
    for (let i = 0; i < n; i++) {
      if (inR[i] && isZeroEventHub[i] && (clusters.get(i)?.length ?? 0) < 3) {
        return Infinity;
      }
    }

    // ADR-0072: Intermediate Poset consolidation strictly forbids subject_others
    if (!allowOthers && othersList.length > 0) return Infinity;
    // Single-entity subject_others uses the same lane count as retaining that entity directly (ADR-0068)
    if (!existingOthersActive && othersList.length === 1) return Infinity;

    const needsOthers = existingOthersActive || othersList.length >= 2;
    const totalLanes = retainedCount + (needsOthers ? 1 : 0);
    if (totalLanes > maxAllowedLanes) return Infinity;

    const excessLanes = Math.max(0, totalLanes - effectiveLimit);
    cost += computeLaneOverflowPenalty(excessLanes, effectiveLimit);

    if (othersList.length > 0) {
      let substantiveCount = 0;
      for (const w of othersList) {
        if (isSubstantiveForOthers[w]) substantiveCount++;
        let worstSibLvl = 0;
        for (const sibIdx of sharedParentSiblings[w]) {
          if (inR[sibIdx]) {
            const lvl = guardLevel[w * n + sibIdx];
            if (lvl > worstSibLvl) worstSibLvl = lvl;
          }
        }
        cost += othersItemCost[w] + guardCost(worstSibLvl);
      }
      if (!existingOthersActive) {
        cost += substantiveCount >= 2 ? 0.24 : 0.1;
      }
    }

    return cost;
  };

  // Topological decision order (ancestors before descendants; ties broken by rank index)
  const decisionIndices: number[] = [];
  const placedInOrder = new Array<boolean>(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (isForced[i]) placedInOrder[i] = true;
  }
  while (decisionIndices.length < n - placedInOrder.filter(Boolean).length + decisionIndices.length) {
    let nextIdx = -1;
    for (let i = 0; i < n; i++) {
      if (placedInOrder[i]) continue;
      const hasUnplacedAncestor = activePool.some(
        (anc, j) => j !== i && !placedInOrder[j] && poset.isAncestor(anc.entity.id, activePool[i].entity.id)
      );
      if (!hasUnplacedAncestor) {
        nextIdx = i;
        break;
      }
    }
    if (nextIdx === -1) {
      nextIdx = placedInOrder.findIndex((p) => !p);
      if (nextIdx === -1) break;
    }
    placedInOrder[nextIdx] = true;
    decisionIndices.push(nextIdx);
  }

  let bestInR = activePool.map((_, i) => isForced[i]);
  let bestCost = Infinity;

  const trySeed = (seedInR: boolean[]) => {
    const normalizeChildrenAndLone = (arr: boolean[]) => {
      for (let i = 0; i < n; i++) {
        if (arr[i] || isZeroEventHub[i]) continue;
        if (orderedCandidateParents[i].some((p) => arr[p])) continue;
        if (isExcludedWhenUnparented[i]) continue;
        if (!canFoldToOthers[i]) {
          arr[i] = true;
        }
      }
      const o: number[] = [];
      for (let i = 0; i < n; i++) {
        if (arr[i] || isZeroEventHub[i]) continue;
        if (orderedCandidateParents[i].some((p) => arr[p])) continue;
        if (isExcludedWhenUnparented[i]) continue;
        o.push(i);
      }
      if (!allowOthers) {
        for (const idx of o) arr[idx] = true;
      } else if (!existingOthersActive && o.length === 1) {
        arr[o[0]] = true;
      }
    };

    const normalized = [...seedInR];
    normalizeChildrenAndLone(normalized);

    // Demote any 0-event hub in the seed that absorbed fewer than 2 non-retained descendants
    let demotedHub = false;
    for (let h = 0; h < n; h++) {
      if (!normalized[h] || !isZeroEventHub[h]) continue;
      let mergedCount = 0;
      for (let i = 0; i < n; i++) {
        if (normalized[i] || isZeroEventHub[i]) continue;
        const firstP = orderedCandidateParents[i].find((p) => normalized[p]);
        if (firstP === h) mergedCount++;
      }
      if (mergedCount < 2) {
        normalized[h] = false;
        demotedHub = true;
      }
    }
    if (demotedHub) {
      normalizeChildrenAndLone(normalized);
    }

    const c = evaluateFullCost(normalized);
    if (c < bestCost) {
      bestCost = c;
      bestInR = normalized;
    }
  };

  // Seed 1: Top effectiveLimit candidates
  trySeed(activePool.map((_, i) => isForced[i] || i < effectiveLimit));
  // Seed 2: Top (effectiveLimit - 1) candidates + subject_others
  if (allowOthers && effectiveLimit >= 2) {
    trySeed(activePool.map((_, i) => isForced[i] || i < effectiveLimit - 1));
  }
  // Seed 3: Retain all ancestor hubs + top remaining up to effectiveLimit
  {
    const seed3 = activePool.map((_, i) => isForced[i]);
    let cnt = seed3.filter(Boolean).length;
    for (let i = 0; i < n && cnt < effectiveLimit; i++) {
      if (!seed3[i] && hasDescendantsInPool[i]) {
        seed3[i] = true;
        cnt++;
      }
    }
    for (let i = 0; i < n && cnt < effectiveLimit; i++) {
      if (!seed3[i]) {
        seed3[i] = true;
        cnt++;
      }
    }
    trySeed(seed3);
  }
  // Seed 4 (Poset-only mode): Retain unparented roots + top non-low children up to effectiveLimit
  if (!allowOthers) {
    const seed4 = activePool.map(
      (_, i) => isForced[i] || (orderedCandidateParents[i].length === 0 && !isExcludedWhenUnparented[i])
    );
    let cnt = seed4.filter(Boolean).length;
    for (let i = 0; i < n && cnt < effectiveLimit; i++) {
      if (!seed4[i] && !isLowSubordinate[i]) {
        seed4[i] = true;
        cnt++;
      }
    }
    trySeed(seed4);
  }

  // Exact Branch-and-Bound with clean-leaf prefix symmetry breaking
  const workingInR = activePool.map((_, i) => isForced[i]);
  const resolvedParentAt = new Int16Array(n).fill(-1);
  const liveClusters = new Map<number, number[]>();
  let initialRetained = 0;
  let initialCost = 0;
  for (let i = 0; i < n; i++) {
    if (workingInR[i]) {
      initialRetained++;
      liveClusters.set(i, [i]);
    }
  }

  let visitedStates = 0;
  const MAX_SEARCH_STATES = 60000;

  const dfs = (step: number, retainedCount: number, othersCount: number, accLowerBound: number) => {
    if (visitedStates >= MAX_SEARCH_STATES) return;
    visitedStates++;

    const minFinalLanes = retainedCount + (existingOthersActive || othersCount > 0 ? 1 : 0);
    if (minFinalLanes > maxAllowedLanes) return;
    if (
      accLowerBound + computeLaneOverflowPenalty(Math.max(0, minFinalLanes - effectiveLimit), effectiveLimit) >=
      bestCost - 1e-11
    ) {
      return;
    }

    if (step === decisionIndices.length) {
      if (!existingOthersActive && othersCount === 1) return;
      const fullCost = evaluateFullCost(workingInR);
      if (fullCost < bestCost - 1e-11) {
        bestCost = fullCost;
        bestInR = [...workingInR];
      }
      return;
    }

    const u = decisionIndices[step];
    let parentIdx = -1;
    for (const pIdx of orderedCandidateParents[u]) {
      if (workingInR[pIdx]) {
        parentIdx = pIdx;
        break;
      }
    }

    // Symmetry break: if u is a clean leaf with a retained parent, and a higher-valued clean leaf
    // already merged into the exact same parent, retaining u is strictly dominated.
    let skipRetain = false;
    if (isCleanLeaf[u] && parentIdx !== -1) {
      for (let prevStep = 0; prevStep < step; prevStep++) {
        const prev = decisionIndices[prevStep];
        if (isCleanLeaf[prev] && !workingInR[prev] && resolvedParentAt[prev] === parentIdx && val[prev] >= val[u]) {
          skipRetain = true;
          break;
        }
      }
    }

    // Branch 1: retain u in R (explore retention first when within budget to tighten bestCost quickly)
    const tryRetainFirst = retainedCount < effectiveLimit;
    const runRetain = () => {
      if (skipRetain) return;
      if (retainedCount + 1 + (existingOthersActive || othersCount > 0 ? 1 : 0) > maxAllowedLanes) return;
      workingInR[u] = true;
      resolvedParentAt[u] = -1;
      liveClusters.set(u, [u]);
      let addCost = 0;
      if (isLowSubordinate[u] && !guardRowHasAnyBlock[u] && parentIdx !== -1) {
        addCost += 0.06;
      }
      dfs(step + 1, retainedCount + 1, othersCount, accLowerBound + addCost);
      liveClusters.delete(u);
      workingInR[u] = false;
    };

    const runNotRetain = () => {
      workingInR[u] = false;
      resolvedParentAt[u] = isZeroEventHub[u] ? -1 : parentIdx;
      if (isZeroEventHub[u]) {
        dfs(step + 1, retainedCount, othersCount, accLowerBound);
      } else if (parentIdx !== -1) {
        const cluster = liveClusters.get(parentIdx)!;
        let worstLvl = 0;
        for (const mIdx of cluster) {
          const lvl = guardLevel[u * n + mIdx];
          if (lvl > worstLvl) worstLvl = lvl;
        }
        if (worstLvl < 2) {
          for (const descIdx of descendantsInPool[parentIdx]) {
            if (workingInR[descIdx] && guardLevel[u * n + descIdx] === 2) {
              worstLvl = 2;
              break;
            }
          }
        }
        cluster.push(u);
        const addCost = subroleLoss(u) + guardCost(worstLvl);
        dfs(step + 1, retainedCount, othersCount, accLowerBound + addCost);
        cluster.pop();
      } else if (isExcludedWhenUnparented[u]) {
        dfs(step + 1, retainedCount, othersCount, accLowerBound);
      } else if (allowOthers && canFoldToOthers[u]) {
        const nextOthers = othersCount + 1;
        const bucketInc = !existingOthersActive && nextOthers === 2 ? 0.1 : 0;
        const addCost = othersItemCost[u] + bucketInc;
        dfs(step + 1, retainedCount, nextOthers, accLowerBound + addCost);
      }
      resolvedParentAt[u] = -1;
    };

    if (tryRetainFirst) {
      runRetain();
      runNotRetain();
    } else {
      runNotRetain();
      runRetain();
    }
  };

  dfs(0, initialRetained, 0, initialCost);

  // Materialize winning partition
  const retainedIds = new Set<string>();
  const mergeTargetById = new Map<string, string>();
  const excludedIds = new Set<string>();
  const mergeBlockedReasonById = new Map<string, string>();

  for (let i = 0; i < n; i++) {
    if (bestInR[i]) {
      retainedIds.add(activePool[i].entity.id);
    }
  }
  // Safety fallback if no feasible subset matched (e.g. pathological forced state)
  if (retainedIds.size === 0 && n > 0) {
    retainedIds.add(activePool[0].entity.id);
    bestInR[0] = true;
  }

  const finalOthers: number[] = [];
  for (let i = 0; i < n; i++) {
    if (bestInR[i]) continue;
    if (isZeroEventHub[i]) {
      excludedIds.add(activePool[i].entity.id);
      continue;
    }
    let parentIdx = -1;
    for (const pIdx of orderedCandidateParents[i]) {
      if (bestInR[pIdx]) {
        parentIdx = pIdx;
        break;
      }
    }
    if (parentIdx !== -1) {
      mergeTargetById.set(activePool[i].entity.id, activePool[parentIdx].entity.id);
    } else if (isExcludedWhenUnparented[i]) {
      excludedIds.add(activePool[i].entity.id);
    } else {
      finalOthers.push(i);
    }
  }

  if (!existingOthersActive && finalOthers.length === 1) {
    retainedIds.add(activePool[finalOthers[0]].entity.id);
    bestInR[finalOthers[0]] = true;
  } else {
    for (const w of finalOthers) {
      mergeTargetById.set(activePool[w].entity.id, othersId);
    }
  }

  // Record Merge Guard explanation on retained descendants/siblings that stayed independent of a retained parent/sibling
  for (let i = 0; i < n; i++) {
    if (!bestInR[i]) continue;
    for (const pIdx of orderedCandidateParents[i]) {
      if (!bestInR[pIdx]) continue;
      const reason = guardReason.get(i * n + pIdx);
      if (reason) {
        mergeBlockedReasonById.set(activePool[i].entity.id, reason);
        break;
      }
    }
    if (!mergeBlockedReasonById.has(activePool[i].entity.id)) {
      for (const sibIdx of sharedParentSiblings[i]) {
        if (!bestInR[sibIdx]) continue;
        const reason = guardReason.get(i * n + sibIdx);
        if (reason) {
          mergeBlockedReasonById.set(activePool[i].entity.id, reason);
          break;
        }
      }
    }
  }

  const hasOthers = Array.from(mergeTargetById.values()).includes(othersId);
  const totalLanes = retainedIds.size + (hasOthers ? 1 : 0);

  return {
    retainedIds,
    mergeTargetById,
    excludedIds,
    mergeBlockedReasonById,
    othersId,
    excessLanes: Math.max(0, totalLanes - effectiveLimit),
  };
}

function roundScore(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export interface SubjectRankingOptions {
  forceRetain?: ReadonlySet<string>;
  explicitMerges?: ReadonlyMap<string, string>;
  excludeNonInfluential?: boolean;
  /** ADR-0072: false の場合、中間フェーズとして Poset 包摂ロールアップのみを行い subject_others を生成しない */
  allowSubjectOthers?: boolean;
  /** ADR-0072: 統合前の最大主体数 K_pre（subjectRanking 記録用） */
  preConsolidationMaxSubjects?: number;
  /** ADR-0072: 最終フェーズの subject_others 集約方式 */
  othersConsolidationMode?: OthersConsolidationMode;
  /** ADR-0072: Stage 3 接続提案で LLM が提案した周辺主体ID集合 */
  llmPeripheralEntityIds?: ReadonlySet<string>;
  /** ADR-0072: Stage 3 接続提案の出力に [周辺主体候補] セクションが存在したか */
  llmPeripheralSectionPresent?: boolean;
}

export function rankSubjects(
  analysis: VTAAnalysisData,
  maxSubjects: number = DEFAULT_MAX_SUBJECTS,
  weights: Record<'A' | 'O' | 'F' | 'C' | 'T', number> = DEFAULT_SUBJECT_RANKING_WEIGHTS,
  options?: SubjectRankingOptions
): VTASubjectRanking {
  const baseEntities = analysis.entities.filter((e) => !e.aggregate);
  const limit = Math.max(1, Math.round(Number.isFinite(maxSubjects) ? maxSubjects : DEFAULT_MAX_SUBJECTS));
  const eventById = new Map(analysis.events.map((e) => [e.id, e]));
  const totalEvents = analysis.events.length;

  const outcomeDistances = computeOutcomeDistances(analysis);
  const hasOutcome = outcomeDistances !== null;
  const outcomeEventIds = new Set(
    hasOutcome ? (analysis.outcome?.eventIds ?? []) : []
  );

  // Effective weights (redistribute O proportionally when outcome is not identified)
  let effectiveWeights = { ...weights };
  if (!hasOutcome) {
    const restSum = weights.A + weights.F + weights.C + weights.T;
    if (restSum > 0) {
      effectiveWeights = {
        A: weights.A / restSum,
        O: 0,
        F: weights.F / restSum,
        C: weights.C / restSum,
        T: weights.T / restSum,
      };
    } else {
      effectiveWeights = { A: 0.25, O: 0, F: 0.25, C: 0.25, T: 0.25 };
    }
  }

  // Raw metrics per entity
  const rawA = new Map<string, number>();
  const actorCounts = new Map<string, number>();
  const rawO = new Map<string, number>();
  const rawF = new Map<string, number>();
  const partnerSets = new Map<string, Set<string>>();
  const rawT = new Map<string, number>();
  const firstAppearance = new Map<string, number>();

  for (const [idx, entity] of baseEntities.entries()) {
    const parts = analysis.participations.filter((p) => p.entityId === entity.id);
    let aVal = 0;
    let actors = 0;
    const orders: number[] = [];
    let minHop = Infinity;

    for (const part of parts) {
      if (part.role === 'actor') {
        aVal += 1.0;
        actors += 1;
      } else {
        aVal += 0.3;
      }
      const ev = eventById.get(part.eventId);
      if (ev) {
        orders.push(ev.sourceOrder);
      }
      if (outcomeDistances && outcomeDistances.has(part.eventId)) {
        const d = outcomeDistances.get(part.eventId)!;
        if (d < minHop) minHop = d;
      }
    }

    rawA.set(entity.id, aVal);
    actorCounts.set(entity.id, actors);
    rawO.set(entity.id, Number.isFinite(minHop) ? 1 / (1 + minHop) : 0);

    const fVal =
      entity.focus === 'reporter' || entity.focus === 'high'
        ? 1.0
        : entity.focus === 'low'
          ? 0.0
          : 0.5;
    rawF.set(entity.id, fVal);

    const partners = new Set<string>();
    for (const rel of analysis.relations) {
      if (rel.kind === 'before') continue;
      const src = rel.sourceEntityOrigin ?? rel.sourceEntityId;
      const tgt = rel.targetEntityOrigin ?? rel.targetEntityId;
      if (src === entity.id && tgt && tgt !== entity.id) partners.add(tgt);
      if (tgt === entity.id && src && src !== entity.id) partners.add(src);
    }
    partnerSets.set(entity.id, partners);

    if (orders.length === 0) {
      rawT.set(entity.id, 0);
      firstAppearance.set(entity.id, totalEvents + idx);
    } else {
      const minOrd = Math.min(...orders);
      const maxOrd = Math.max(...orders);
      firstAppearance.set(entity.id, minOrd);
      if (totalEvents <= 1) {
        rawT.set(entity.id, 1.0);
      } else {
        rawT.set(entity.id, (maxOrd - minOrd) / Math.max(1, totalEvents - 1));
      }
    }
  }

  const maxA = Math.max(0, ...rawA.values());
  const maxPartners = Math.max(0, ...Array.from(partnerSets.values(), (s) => s.size));

  interface ScoredCandidate {
    entity: VTAEntity;
    breakdown: Record<'A' | 'O' | 'F' | 'C' | 'T', number>;
    score: number;
    priority?: 'reporter' | 'outcome-actor';
    penalizedMachine: boolean;
    firstOrder: number;
    originalIndex: number;
  }

  const candidates: ScoredCandidate[] = baseEntities.map((entity, originalIndex) => {
    const normA = maxA > 0 ? (rawA.get(entity.id) ?? 0) / maxA : 0;
    const normO = hasOutcome ? (rawO.get(entity.id) ?? 0) : 0;
    const normF = rawF.get(entity.id) ?? 0.5;
    const normC = maxPartners > 0 ? (partnerSets.get(entity.id)?.size ?? 0) / maxPartners : 0;
    const normT = rawT.get(entity.id) ?? 0;

    let score =
      effectiveWeights.A * normA +
      effectiveWeights.O * normO +
      effectiveWeights.F * normF +
      effectiveWeights.C * normC +
      effectiveWeights.T * normT;

    const isInteractiveMachine = isActiveOrInteractiveMachine(entity, analysis);
    const penalizedMachine =
      entity.kind === 'machine' && !isInteractiveMachine && (actorCounts.get(entity.id) ?? 0) <= 1;
    if (penalizedMachine) {
      score *= 0.5;
    }

    let priority: 'reporter' | 'outcome-actor' | undefined;
    if (isReporterEntity(entity)) {
      priority = 'reporter';
    } else if (
      hasOutcome &&
      analysis.participations.some(
        (p) => p.entityId === entity.id && p.role === 'actor' && outcomeEventIds.has(p.eventId)
      )
    ) {
      priority = 'outcome-actor';
    }

    return {
      entity,
      breakdown: {
        A: roundScore(normA),
        O: roundScore(normO),
        F: roundScore(normF),
        C: roundScore(normC),
        T: roundScore(normT),
      },
      score: roundScore(score),
      priority,
      penalizedMachine,
      firstOrder: firstAppearance.get(entity.id) ?? originalIndex,
      originalIndex,
    };
  });

  const priorityRank = (p: ScoredCandidate['priority']): number =>
    p === 'reporter' ? 2 : p === 'outcome-actor' ? 1 : 0;
  const forceRetain = options?.forceRetain;
  const entityById = new Map(baseEntities.map((e) => [e.id, e]));

  const chaseExplicitTarget = (startId: string): string | undefined => {
    if (!options?.explicitMerges?.size) return undefined;
    let cur = options.explicitMerges.get(startId);
    const seen = new Set<string>([startId]);
    while (cur && options.explicitMerges.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = options.explicitMerges.get(cur);
    }
    return cur && cur !== startId && entityById.has(cur) ? cur : undefined;
  };

  const explicitSourceIds = new Set<string>();
  const explicitTargetIds = new Set<string>();
  if (options?.explicitMerges) {
    for (const sourceId of options.explicitMerges.keys()) {
      const targetId = chaseExplicitTarget(sourceId);
      if (targetId) {
        explicitSourceIds.add(sourceId);
        explicitTargetIds.add(targetId);
      }
    }
  }
  const effectiveForceRetain = new Set<string>([
    ...(forceRetain ?? []),
    ...Array.from(explicitTargetIds).filter((id) => !explicitSourceIds.has(id)),
  ]);

  // ADR-0008: 各主体のインシデント因果影響度（変動要因・帰結・防壁不作為・因果相互作用）を判定
  const influenceMap = new Map<string, { influential: boolean; reason?: string }>();
  for (const entity of baseEntities) {
    influenceMap.set(entity.id, isInfluentialSubject(entity, analysis));
  }

  candidates.sort((left, right) => {
    const fLeft = effectiveForceRetain.has(left.entity.id) ? 1 : 0;
    const fRight = effectiveForceRetain.has(right.entity.id) ? 1 : 0;
    if (fRight !== fLeft) return fRight - fLeft;

    // 影響主体を最優先（非影響・背景主体は下位へ）
    const infLeft = influenceMap.get(left.entity.id)?.influential ? 1 : 0;
    const infRight = influenceMap.get(right.entity.id)?.influential ? 1 : 0;
    if (infRight !== infLeft) return infRight - infLeft;

    const pDiff = priorityRank(right.priority) - priorityRank(left.priority);
    if (pDiff !== 0) return pDiff;

    // VTA種別優先度: 人間(person)・組織(organization)を機器(machine)より上位レーンに優先選出する
    // （VTAはヒューマンファクタ・組織分析を主眼とするため、支援機能等の機器が人間レーンを奪うことを防止）
    // ADR-0033: ただし、メンタルモデル不整合・自律介入・機能縮退等に関与する能動的装置は人間・組織と同等(weight=2)として扱う
    const kindWeight = (candidateEntity: VTAEntity) => {
      if (candidateEntity.kind === 'organization' || candidateEntity.kind === 'person') return 2;
      if (candidateEntity.kind === 'machine') {
        return isActiveOrInteractiveMachine(candidateEntity, analysis) ? 2 : 0;
      }
      return candidateEntity.kind === 'other' ? 1 : 0;
    };
    const kDiff = kindWeight(right.entity) - kindWeight(left.entity);
    if (kDiff !== 0) return kDiff;

    if (Math.abs(right.score - left.score) > 1e-9) return right.score - left.score;
    if (left.firstOrder !== right.firstOrder) return left.firstOrder - right.firstOrder;
    return left.originalIndex - right.originalIndex;
  });

  // Determine retention and merge targets
  const retainedIds = new Set<string>();
  const mergeTargetById = new Map<string, string>();
  const mergeBlockedReasonById = new Map<string, string>();
  const excludedIds = new Set<string>();
  const poset = analysis.subjectPoset
    ? SubjectPoset.fromData(analysis.subjectPoset)
    : SubjectPoset.fromEntities(baseEntities);
  const participatingEntityIds = new Set(analysis.participations.map((p) => p.entityId));
  for (const rel of analysis.relations) {
    if (rel.sourceEntityId) participatingEntityIds.add(rel.sourceEntityId);
    if (rel.targetEntityId) participatingEntityIds.add(rel.targetEntityId);
    if (rel.sourceEntityOrigin) participatingEntityIds.add(rel.sourceEntityOrigin);
    if (rel.targetEntityOrigin) participatingEntityIds.add(rel.targetEntityOrigin);
  }

  // 明示 merge (sourceId -> targetId) が指定された際、明示統合前のベースラインで既に統合されていた
  // 同親(targetId)配下の統合可能な兄弟（evaluateMergeGuard.allowed）がモグラ叩き式に繰り上がるのを防ぐ
  // （ただし有効候補数が limit を下回るまで過剰に畳み込まないよう下位ランクから順に適用する）
  const cascadedSiblingMergeById = new Map<string, string>();
  if (options?.explicitMerges && options.explicitMerges.size > 0 && baseEntities.length > limit) {
    const baselineRanking = rankSubjects(analysis, limit, weights, {
      ...options,
      explicitMerges: undefined,
    });
    const baselineRetainedIds = new Set(
      baselineRanking.ranks.filter((r) => r.retained).map((r) => r.entityId)
    );
    let remainingActiveCount = candidates.filter(
      (c) =>
        !explicitSourceIds.has(c.entity.id) &&
        (effectiveForceRetain.has(c.entity.id) || participatingEntityIds.has(c.entity.id))
    ).length;
    for (const sourceId of explicitSourceIds) {
      const targetId = chaseExplicitTarget(sourceId);
      if (!targetId) continue;
      for (let idx = candidates.length - 1; idx >= 0; idx--) {
        if (remainingActiveCount <= limit) break;
        const sib = candidates[idx];
        const sibId = sib.entity.id;
        if (
          sibId === targetId ||
          cascadedSiblingMergeById.has(sibId) ||
          baselineRetainedIds.has(sibId) ||
          explicitSourceIds.has(sibId) ||
          effectiveForceRetain.has(sibId) ||
          sib.priority ||
          !participatingEntityIds.has(sibId)
        ) {
          continue;
        }
        if (poset.isAncestor(targetId, sibId) && evaluateMergeGuard(sibId, targetId, analysis).allowed) {
          cascadedSiblingMergeById.set(sibId, targetId);
          remainingActiveCount--;
        }
      }
    }
  }

  // ADR-0077: 同親・同職種ベース名・同一関与/関係シグネチャを持つ完全対称なクローン兄弟（例: H作業員・I作業員・J作業員）が
  // 上限超過時に複数枠を重複占有して他の中核当事者（例: D中継見張員）を押し出すのを防ぐため、2人目以降を代表主体へ束ねる
  // （代表主体自身も親組織へ統合された場合は後段の推移閉包により全員が親組織へ解決される）
  const homogeneousCloneMergeById = new Map<string, string>();
  if (baseEntities.length > limit) {
    const extractRoleBaseName = (rawName: string): string => {
      const trimmed = rawName.trim();
      const stripped = trimmed
        .replace(/^[A-Za-zＡ-Ｚａ-ｚ0-9０-９]+(?:[・_\-\s]+)?/u, '')
        .replace(/(?:[\s（(・_\-]*[A-Za-zＡ-Ｚａ-ｚ0-9０-９]+[号名番]?[）)]*)$/u, '')
        .trim();
      return stripped.length >= 2 && stripped !== trimmed ? stripped : '';
    };

    const cloneRepBySig = new Map<string, string>();
    for (const c of candidates) {
      const ent = c.entity;
      if (
        ent.kind !== 'person' ||
        isReporterEntity(ent) ||
        ent.id.startsWith('manual_entity_') ||
        ent.id.startsWith('user_entity_') ||
        effectiveForceRetain.has(ent.id) ||
        explicitSourceIds.has(ent.id) ||
        cascadedSiblingMergeById.has(ent.id)
      ) {
        continue;
      }
      const roleBase = extractRoleBaseName(ent.name);
      if (!roleBase) continue;
      const parents = [...poset.getImmediateParents(ent.id)].sort();
      if (parents.length === 0 || poset.getImmediateChildren(ent.id).length > 0) continue;
      const partSig = analysis.participations
        .filter((p) => p.entityId === ent.id)
        .map((p) => `${p.eventId}:${p.role}`)
        .sort();
      if (partSig.length === 0) continue;
      const relSig = analysis.relations
        .flatMap((r) => {
          const s = r.sourceEntityOrigin ?? r.sourceEntityId;
          const t = r.targetEntityOrigin ?? r.targetEntityId;
          if (s === ent.id) return [`out:${r.kind}:${r.sourceEventId}->${r.targetEventId}:${t ?? '-'}`];
          if (t === ent.id) return [`in:${r.kind}:${r.sourceEventId}->${r.targetEventId}:${s ?? '-'}`];
          return [];
        })
        .sort();
      const fullSig = `${parents.join(',')}|${roleBase}|${partSig.join(',')}|${relSig.join(',')}`;
      const existingRep = cloneRepBySig.get(fullSig);
      if (!existingRep) {
        cloneRepBySig.set(fullSig, ent.id);
      } else if (evaluateMergeGuard(ent.id, existingRep, analysis).allowed) {
        homogeneousCloneMergeById.set(ent.id, existingRep);
      }
    }
  }

  const retainableCandidates = candidates.filter(
    (c) =>
      !explicitSourceIds.has(c.entity.id) &&
      !cascadedSiblingMergeById.has(c.entity.id) &&
      !homogeneousCloneMergeById.has(c.entity.id)
  );
  const forcedCount = retainableCandidates.filter((c) => effectiveForceRetain.has(c.entity.id)).length;
  const effectiveLimit = Math.max(limit, forcedCount);
  const isConsolidating = baseEntities.length > limit || Boolean(options?.explicitMerges?.size);
  let solvedExcessLanes = 0;

  if (!isConsolidating) {
    for (const c of retainableCandidates) {
      retainedIds.add(c.entity.id);
    }
  } else {
    const participatingRetainableCount = retainableCandidates.filter(
      (c) => effectiveForceRetain.has(c.entity.id) || participatingEntityIds.has(c.entity.id)
    ).length;
    const zeroEventHubIds = new Set<string>();
    const activePool: ScoredCandidate[] = [];
    for (const c of retainableCandidates) {
      if (effectiveForceRetain.has(c.entity.id) || participatingEntityIds.has(c.entity.id)) {
        activePool.push(c);
      } else if (
        participatingRetainableCount > effectiveLimit &&
        c.entity.kind === 'organization' &&
        retainableCandidates.filter(
          (desc) =>
            desc.entity.id !== c.entity.id &&
            participatingEntityIds.has(desc.entity.id) &&
            !effectiveForceRetain.has(desc.entity.id) &&
            desc.priority !== 'reporter' &&
            desc.priority !== 'outcome-actor' &&
            poset.isAncestor(c.entity.id, desc.entity.id) &&
            evaluateMergeGuard(desc.entity.id, c.entity.id, analysis).allowed
        ).length >= 2
      ) {
        // 関与主体数が上限を超過しており、かつ2件以上の統合可能な関与子孫を束ね得る0件親組織は候補ハブとしてソルバーへ渡す
        zeroEventHubIds.add(c.entity.id);
        activePool.push(c);
      } else {
        // 子孫のPoset構造定義のためだけに抽出された直接イベント・関係0件の組織は空サブレーン化・others混入を防ぐため除外
        excludedIds.add(c.entity.id);
      }
    }

    const hasRedundantLowSubordinate = activePool.some((c) => {
      if (effectiveForceRetain.has(c.entity.id) || c.priority || c.entity.focus !== 'low') return false;
      if (c.entity.kind === 'machine' && !isActiveOrInteractiveMachine(c.entity, analysis)) return false;
      return activePool.some(
        (anc) =>
          anc.entity.id !== c.entity.id &&
          !zeroEventHubIds.has(anc.entity.id) &&
          poset.isAncestor(anc.entity.id, c.entity.id) &&
          evaluateMergeGuard(c.entity.id, anc.entity.id, analysis).allowed
      );
    });

    if (participatingRetainableCount <= effectiveLimit && !hasRedundantLowSubordinate) {
      for (const c of activePool) {
        if (zeroEventHubIds.has(c.entity.id)) {
          excludedIds.add(c.entity.id);
        } else {
          retainedIds.add(c.entity.id);
        }
      }
    } else {
      const solved = solveOptimalSubjectRetention({
        activePool,
        effectiveLimit,
        effectiveForceRetain,
        poset,
        entityById,
        analysis,
        influenceMap,
        options,
        zeroEventHubIds,
      });
      for (const id of solved.retainedIds) retainedIds.add(id);
      for (const [k, v] of solved.mergeTargetById) mergeTargetById.set(k, v);
      for (const id of solved.excludedIds) excludedIds.add(id);
      for (const [k, v] of solved.mergeBlockedReasonById) mergeBlockedReasonById.set(k, v);
      solvedExcessLanes = solved.excessLanes;
    }
  }

  for (const [sibId, targetId] of cascadedSiblingMergeById) {
    if (retainedIds.has(targetId)) {
      mergeTargetById.set(sibId, targetId);
    } else {
      retainedIds.add(sibId);
    }
  }

  for (const [cloneId, repId] of homogeneousCloneMergeById) {
    if (excludedIds.has(repId) && !retainedIds.has(repId) && !mergeTargetById.has(repId)) {
      excludedIds.add(cloneId);
    } else {
      mergeTargetById.set(cloneId, repId);
    }
  }

  if (options?.explicitMerges) {
    for (const [sourceId, targetId] of options.explicitMerges) {
      if (sourceId === targetId) continue;
      retainedIds.delete(sourceId);
      excludedIds.delete(sourceId);
      if (!explicitSourceIds.has(targetId)) {
        retainedIds.add(targetId);
      }
      mergeTargetById.set(sourceId, targetId);
    }
  }

  // 常時推移閉包化（例: A_W_F -> A_W_EFHIJ かつ A_W_EFHIJ -> S_WORK のとき A_W_F -> S_WORK へ解決）
  for (const [entId, firstTarget] of Array.from(mergeTargetById.entries())) {
    let cur = firstTarget;
    const visited = new Set<string>([entId]);
    while (!retainedIds.has(cur) && mergeTargetById.has(cur) && !visited.has(cur)) {
      visited.add(cur);
      cur = mergeTargetById.get(cur)!;
    }
    if (cur !== entId && (retainedIds.has(cur) || cur.startsWith('subject_others'))) {
      mergeTargetById.set(entId, cur);
    }
  }

  const ranks: VTASubjectRankEntry[] = candidates.map((c, index) => {
    const isExcluded = excludedIds.has(c.entity.id);
    const retained = retainedIds.has(c.entity.id);
    const mergedInto = retained || isExcluded ? undefined : mergeTargetById.get(c.entity.id);
    const blockedReason = mergeBlockedReasonById.get(c.entity.id);
    const isInf = influenceMap.get(c.entity.id)?.influential ?? true;

    const reasonParts: string[] = [];
    if (c.priority === 'reporter') reasonParts.push('優先保持：報告者本人');
    else if (c.priority === 'outcome-actor') reasonParts.push('優先保持：帰結イベントの行為主体');
    if (c.penalizedMachine) reasonParts.push('自律動作1件以下の機器減点');
    if (blockedReason) reasonParts.push(`統合ブロック（${blockedReason}）`);

    if (isExcluded) {
      reasonParts.push(`変動要因・因果影響のない定常背景のためレーン除外（スコア ${c.score.toFixed(2)}）`);
    } else if (retained) {
      const overflowNote =
        solvedExcessLanes > 0 ? `・ペナルティ最適化により上限+${solvedExcessLanes}列を許容` : '';
      reasonParts.push(`上位保持（スコア ${c.score.toFixed(2)}${overflowNote}）`);
    } else {
      const targetName =
        mergedInto && entityById.has(mergedInto)
          ? entityById.get(mergedInto)!.name
          : 'その他の関係者';
      reasonParts.push(`上限超過のため「${targetName}」へ統合（スコア ${c.score.toFixed(2)}）`);
    }
    const consolidationStage: VTASubjectConsolidationStage | undefined = isExcluded
      ? 'stage2_bnb'
      : !retained && mergedInto
        ? (explicitSourceIds.has(c.entity.id) ? 'stage2_llm_merge' : 'stage2_bnb')
        : undefined;
    return {
      entityId: c.entity.id,
      rank: index + 1,
      score: c.score,
      breakdown: c.breakdown,
      ...(c.priority ? { priority: c.priority } : {}),
      retained,
      ...(mergedInto ? { mergedInto } : {}),
      ...(isExcluded ? { excluded: true } : {}),
      ...(consolidationStage ? { consolidationStage } : {}),
      ...(blockedReason ? { mergeBlockedReason: blockedReason } : {}),
      isInfluential: isInf,
      reason: reasonParts.join('／'),
    };
  });

  return {
    version: 1,
    maxSubjects: limit,
    ...(typeof options?.preConsolidationMaxSubjects === 'number'
      ? { preConsolidationMaxSubjects: options.preConsolidationMaxSubjects }
      : {}),
    weights: { ...weights },
    originalEntities: baseEntities.map((e) => structuredClone(e)),
    ranks,
  };
}

function getAggregateEntityId(entities: VTAEntity[]): string {
  const existingIds = new Set(entities.map((e) => e.id));
  if (!existingIds.has('subject_others')) return 'subject_others';
  let i = 2;
  while (existingIds.has(`subject_others_${i}`)) i++;
  return `subject_others_${i}`;
}

function getAggregateEntityName(entities: VTAEntity[]): string {
  const existingNames = new Set(entities.map((e) => e.name));
  if (!existingNames.has('その他の関係者')) return 'その他の関係者';
  let i = 2;
  while (existingNames.has(`その他の関係者 (${i})`)) i++;
  return `その他の関係者 (${i})`;
}

function consolidateSubjectsBaseStep(
  base: VTAAnalysisData,
  limit: number,
  weights: Record<'A' | 'O' | 'F' | 'C' | 'T', number>,
  onWarning?: (message: string) => void,
  options?: SubjectRankingOptions
): VTAAnalysisData {
  const ranking = rankSubjects(base, limit, weights, options);

  const hasExplicitMerges = Boolean(options?.explicitMerges && options.explicitMerges.size > 0);
  const excludedSet = new Set(ranking.ranks.filter((r) => r.excluded).map((r) => r.entityId));
  const hasExclusions = excludedSet.size > 0;
  const hasMerges = ranking.ranks.some((r) => !r.retained && !r.excluded && Boolean(r.mergedInto));

  if (base.entities.length <= limit && !hasExplicitMerges && !hasExclusions && !hasMerges) {
    return {
      ...base,
      subjectRanking: ranking,
    };
  }

  const retainedSet = new Set(ranking.ranks.filter((r) => r.retained).map((r) => r.entityId));
  const mergeMap = new Map<string, string>();
  for (const r of ranking.ranks) {
    if (r.retained) {
      mergeMap.set(r.entityId, r.entityId);
    } else if (r.mergedInto) {
      mergeMap.set(r.entityId, r.mergedInto);
    }
  }

  const othersId = getAggregateEntityId(base.entities);
  const needsOthers = Array.from(mergeMap.values()).includes(othersId);
  const basePoset = base.subjectPoset
    ? SubjectPoset.fromData(base.subjectPoset)
    : SubjectPoset.fromEntities(base.entities);

  const resolveRetainedParentIds = (selfId: string, rawParentIds: string[]): string[] => {
    const resolved: string[] = [];
    for (const pid of rawParentIds) {
      if (pid === selfId) continue;
      if (retainedSet.has(pid) && !basePoset.isAncestor(selfId, pid)) {
        resolved.push(pid);
        continue;
      }
      const mapped = mergeMap.get(pid);
      if (mapped && mapped !== selfId && retainedSet.has(mapped) && !basePoset.isAncestor(selfId, mapped)) {
        resolved.push(mapped);
        continue;
      }
      // 中間親が excluded 等で未保持の場合は Poset 上の極小保持祖先へ推移解決する
      const ancCandidates = Array.from(basePoset.getAncestors(pid)).filter(
        (anc) => anc !== selfId && retainedSet.has(anc) && !basePoset.isAncestor(selfId, anc)
      );
      const minimalAncs = ancCandidates.filter(
        (anc) => !ancCandidates.some((other) => other !== anc && basePoset.isAncestor(anc, other))
      );
      resolved.push(...minimalAncs);
    }
    return Array.from(new Set(resolved));
  };

  const consolidatedEntities: VTAEntity[] = base.entities
    .filter((e) => retainedSet.has(e.id))
    .map((e) => {
      const copy: VTAEntity = { ...e };
      if (copy.parentEntityId && !retainedSet.has(copy.parentEntityId)) {
        const nextPrimary = resolveRetainedParentIds(copy.id, [copy.parentEntityId]);
        if (nextPrimary.length > 0) {
          copy.parentEntityId = nextPrimary[0];
        } else {
          delete copy.parentEntityId;
        }
      }
      if (copy.parentEntityIds?.length) {
        const nextParents = resolveRetainedParentIds(copy.id, copy.parentEntityIds);
        if (nextParents.length > 0) {
          copy.parentEntityIds = nextParents;
          if (!copy.parentEntityId) copy.parentEntityId = nextParents[0];
        } else {
          delete copy.parentEntityIds;
        }
      }
      const mergedFrom = ranking.ranks
        .filter((r) => r.mergedInto === e.id && r.entityId !== e.id)
        .map((r) => r.entityId);
      if (mergedFrom.length > 0) {
        copy.mergedFrom = mergedFrom;
      }
      return copy;
    });

  if (needsOthers) {
    const othersMerged = ranking.ranks
      .filter((r) => r.mergedInto === othersId && r.entityId !== othersId)
      .map((r) => r.entityId);
    consolidatedEntities.push({
      id: othersId,
      name: getAggregateEntityName(base.entities),
      kind: 'other',
      aggregate: true,
      ...(othersMerged.length > 0 ? { mergedFrom: othersMerged } : {}),
    });
  }

  // Reassign participations per event
  const consolidatedParticipations: VTAParticipation[] = [];
  for (const event of base.events) {
    const eventParts = base.participations.filter((p) => p.eventId === event.id);
    const byTarget = new Map<string, VTAParticipation[]>();
    for (const part of eventParts) {
      // ADR-0008: レーン除外された非影響主体への関与は含めない
      if (excludedSet.has(part.entityId)) {
        continue;
      }
      const targetId = mergeMap.get(part.entityId) ?? part.entityId;
      const list = byTarget.get(targetId) ?? [];
      list.push(part);
      byTarget.set(targetId, list);
    }

    for (const [targetId, parts] of byTarget) {
      if (parts.length === 1 && parts[0].entityId === targetId) {
        consolidatedParticipations.push({ ...parts[0] });
        continue;
      }
      const sortedByRole = [...parts].sort(
        (a, b) => ROLE_PRIORITY[b.role] - ROLE_PRIORITY[a.role]
      );
      const primary = sortedByRole[0];
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
      const allInferred = parts.every((p) => Boolean(p.inferred));
      const allManual = parts.every((p) => p.origin === 'manual');
      const mergedFrom = parts.flatMap((p) =>
        p.mergedFrom?.length
          ? p.mergedFrom
          : [{ entityId: p.entityId, role: p.role }]
      );

      consolidatedParticipations.push({
        ...primary,
        entityId: targetId,
        role: primary.role,
        factIds,
        ...(sourceRefs?.length ? { sourceRefs } : {}),
        ...(allInferred ? { inferred: true } : { inferred: undefined }),
        origin: allManual ? 'manual' : 'extraction',
        mergedFrom,
      });
    }
  }

  // Reassign relations
  const consolidatedRelations: VTAEventRelation[] = base.relations
    .filter((rel) => {
      const src = rel.sourceEntityId ? (mergeMap.get(rel.sourceEntityId) ?? rel.sourceEntityId) : undefined;
      const tgt = rel.targetEntityId ? (mergeMap.get(rel.targetEntityId) ?? rel.targetEntityId) : undefined;
      if (src && excludedSet.has(src)) return false;
      if (tgt && excludedSet.has(tgt)) return false;
      return true;
    })
    .map((rel) => {
      const newSource = rel.sourceEntityId ? (mergeMap.get(rel.sourceEntityId) ?? rel.sourceEntityId) : undefined;
      const newTarget = rel.targetEntityId ? (mergeMap.get(rel.targetEntityId) ?? rel.targetEntityId) : undefined;
      const sourceEntityOrigin =
        rel.sourceEntityOrigin ??
        (rel.sourceEntityId && newSource !== rel.sourceEntityId ? rel.sourceEntityId : undefined);
      const targetEntityOrigin =
        rel.targetEntityOrigin ??
        (rel.targetEntityId && newTarget !== rel.targetEntityId ? rel.targetEntityId : undefined);
      return {
        ...rel,
        sourceEntityId: newSource,
        targetEntityId: newTarget,
        ...(sourceEntityOrigin ? { sourceEntityOrigin } : {}),
        ...(targetEntityOrigin ? { targetEntityOrigin } : {}),
      };
    });

  // Preserve shared card groups where valid and non-conflicting
  const candidateGroups: Array<{ entityId: string; eventIds: string[] }> = [];
  const occupiedPairs = new Set<string>();
  const precedenceArcs = consolidatedRelations.filter(isPrecedence);
  const reachesPrecedence = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return precedenceArcs.some(
      (r) => r.sourceEventId === from && reachesPrecedence(r.targetEventId, to, seen)
    );
  };

  for (const card of base.cards) {
    if (card.eventIds.length < 2) continue;
    const targetEntityId = mergeMap.get(card.laneEntityId) ?? card.laneEntityId;
    const validEvents = card.eventIds.every((evId) =>
      consolidatedParticipations.some((p) => p.eventId === evId && p.entityId === targetEntityId)
    );
    if (!validEvents) continue;
    const hasInternalOrder = card.eventIds.some((a) =>
      card.eventIds.some((b) => a !== b && reachesPrecedence(a, b))
    );
    if (hasInternalOrder) continue;
    const pairs = card.eventIds.map((evId) => `${evId}\u0000${targetEntityId}`);
    if (pairs.some((k) => occupiedPairs.has(k))) continue;
    pairs.forEach((k) => occupiedPairs.add(k));
    candidateGroups.push({ entityId: targetEntityId, eventIds: [...card.eventIds] });
  }

  try {
    const primarySource = base.sources[0] ?? { id: 'source_1', text: '', paragraphs: [] };
    const parsed = validateParticipants(
      {
        entities: consolidatedEntities,
        participations: consolidatedParticipations,
        relations: consolidatedRelations,
        cardGroups: candidateGroups,
        subjectRanking: ranking,
        subjectPoset: base.subjectPoset,
      },
      base.events,
      base.facts,
      true,
      undefined,
      base.sources
    );
    const built = buildAnalysis(primarySource, base.facts, base.events, parsed);

    // Filter out any dependency that would violate card group ordering after consolidation
    const validRelations = built.relations.filter((r) => !dependencyProblem(built, r, built.relations));

    // ADR-0008: 非影響主体として除外されたイベントは背景退避されるため、この不変条件検査から除外
    const excludedEventIds = new Set<string>();
    for (const exId of excludedSet) {
      for (const p of base.participations) {
        if (p.entityId === exId) excludedEventIds.add(p.eventId);
      }
    }
    const realUnassigned = built.unassignedEventIds.filter((id) => !excludedEventIds.has(id));

    // Invariant check: unassigned events must never increase compared to pre-consolidation
    if (realUnassigned.length > base.unassignedEventIds.length) {
      const warning = `主体の統合により未割当イベントが増加するため（${base.unassignedEventIds.length}件 → ${realUnassigned.length}件）、統合を中止し細粒度主体を保持しました。`;
      if (onWarning) onWarning(warning);
      return {
        ...base,
        subjectRanking: {
          ...ranking,
          warning,
        },
      };
    }

    // ADR-0008: 除外された非影響主体を dispositions に背景退避（監査性の維持）
    const nextDispositions = [...(base.dispositions ?? [])];
    for (const exId of excludedSet) {
      const entity = base.entities.find((e) => e.id === exId);
      if (!entity) continue;
      const exParts = base.participations.filter((p) => p.entityId === exId);
      for (const p of exParts) {
        const ev = base.events.find((e) => e.id === p.eventId);
        if (!ev) continue;
        const dispId = `disp_bg_${exId}_${p.eventId}`;
        if (!nextDispositions.some((d) => d.id === dispId)) {
          nextDispositions.push({
            id: dispId,
            sourceId: ev.sourceRefs?.[0]?.sourceId ?? (base.sources[0]?.id ?? 'source_1'),
            paragraphId: ev.sourceRefs?.[0]?.paragraphId ?? 'p1',
            quote: ev.title,
            text: ev.description,
            kind: 'background',
            reason: `主体「${entity.name}」がインシデント進行に影響を及ぼさなかった背景のためVTAレーンから除外`,
            sourceRefs: ev.sourceRefs,
          });
        }
      }
    }

    return {
      ...base,
      entities: built.entities,
      participations: built.participations,
      relations: validRelations,
      cards: built.cards,
      unassignedEventIds: realUnassigned,
      dispositions: nextDispositions.length ? nextDispositions : base.dispositions,
      subjectRanking: ranking,
    };
  } catch (error) {
    const warning = `主体の統合処理で整合性検証に失敗したため、細粒度主体を保持しました: ${error instanceof Error ? error.message : String(error)}`;
    if (onWarning) onWarning(warning);
    return {
      ...base,
      subjectRanking: {
        ...ranking,
        warning,
      },
    };
  }
}

/**
 * ADR-0072: 既存の分析データ（Stage 2 の共有カードや Stage 3 の接続提案を含む）を壊さずに、
 * 指定された現存主体集合をターゲット主体（Poset 上位組織または `subject_others`）へ増分統合する。
 * `mergedFrom` と `*EntityOrigin`、`subjectRanking` を一貫更新し、`revertConsolidation` とドリルダウンの可逆性を保つ。
 */
function foldEntitiesIntoTargets(
  analysis: VTAAnalysisData,
  rawMergeTargetById: ReadonlyMap<string, string>,
  finalLimit: number,
  reasonSuffixByEntityId?: ReadonlyMap<string, string>,
  onWarning?: (message: string) => void,
  consolidationStage?: VTASubjectConsolidationStage,
  stageByEntityId?: ReadonlyMap<string, VTASubjectConsolidationStage>
): { analysis: VTAAnalysisData; applied: boolean } {
  const mergeTargetById = new Map<string, string>();
  for (const [srcId, firstTgt] of rawMergeTargetById) {
    if (!srcId || !firstTgt || srcId === firstTgt) continue;
    let cur = firstTgt;
    const seen = new Set<string>([srcId]);
    while (rawMergeTargetById.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = rawMergeTargetById.get(cur)!;
    }
    if (cur !== srcId) {
      mergeTargetById.set(srcId, cur);
    }
  }
  if (mergeTargetById.size === 0) {
    return { analysis, applied: false };
  }

  const foldedSourceIds = new Set(mergeTargetById.keys());
  const allKnownEntities = [
    ...(analysis.subjectRanking?.originalEntities ?? []),
    ...analysis.entities,
  ];
  const poset = analysis.subjectPoset
    ? SubjectPoset.fromData(analysis.subjectPoset)
    : SubjectPoset.fromEntities(allKnownEntities);

  const retainedNonAggSet = new Set(
    analysis.entities.filter((e) => !foldedSourceIds.has(e.id) && !e.aggregate).map((e) => e.id)
  );
  const absorbedByTarget = new Map<string, string[]>();
  for (const [srcId, tgtId] of mergeTargetById) {
    const srcEnt = analysis.entities.find((e) => e.id === srcId);
    const origIds = srcEnt?.aggregate ? (srcEnt.mergedFrom ?? []) : [srcId, ...(srcEnt?.mergedFrom ?? [])];
    const list = absorbedByTarget.get(tgtId) ?? [];
    list.push(...origIds);
    absorbedByTarget.set(tgtId, list);
  }

  const resolveParentIdsAfterFold = (selfId: string, rawParentIds: string[]): string[] => {
    const resolved: string[] = [];
    for (const pid of rawParentIds) {
      if (pid === selfId) continue;
      if (retainedNonAggSet.has(pid) && !poset.isAncestor(selfId, pid)) {
        resolved.push(pid);
        continue;
      }
      const mapped = mergeTargetById.get(pid);
      if (mapped && mapped !== selfId && retainedNonAggSet.has(mapped) && !poset.isAncestor(selfId, mapped)) {
        resolved.push(mapped);
        continue;
      }
      const ancCandidates = Array.from(poset.getAncestors(pid)).filter(
        (anc) => anc !== selfId && retainedNonAggSet.has(anc) && !poset.isAncestor(selfId, anc)
      );
      const minimalAncs = ancCandidates.filter(
        (anc) => !ancCandidates.some((other) => other !== anc && poset.isAncestor(anc, other))
      );
      resolved.push(...minimalAncs);
    }
    return Array.from(new Set(resolved));
  };

  const nextEntities: VTAEntity[] = analysis.entities
    .filter((e) => !foldedSourceIds.has(e.id))
    .map((e) => {
      const copy: VTAEntity = { ...e };
      if (!copy.aggregate) {
        if (copy.parentEntityId && !retainedNonAggSet.has(copy.parentEntityId)) {
          const nextPrimary = resolveParentIdsAfterFold(copy.id, [copy.parentEntityId]);
          if (nextPrimary.length > 0) copy.parentEntityId = nextPrimary[0];
          else delete copy.parentEntityId;
        }
        if (copy.parentEntityIds?.length) {
          const nextParents = resolveParentIdsAfterFold(copy.id, copy.parentEntityIds);
          if (nextParents.length > 0) {
            copy.parentEntityIds = nextParents;
            if (!copy.parentEntityId) copy.parentEntityId = nextParents[0];
          } else {
            delete copy.parentEntityIds;
          }
        }
      }
      const absorbed = absorbedByTarget.get(copy.id) ?? [];
      if (absorbed.length > 0 || copy.mergedFrom?.length) {
        const combined = Array.from(new Set([...(copy.mergedFrom ?? []), ...absorbed])).filter(
          (id) => id !== copy.id
        );
        if (combined.length > 0) copy.mergedFrom = combined;
      }
      return copy;
    });

  for (const tgtId of new Set(mergeTargetById.values())) {
    if (nextEntities.some((e) => e.id === tgtId)) continue;
    const othersMerged = Array.from(new Set(absorbedByTarget.get(tgtId) ?? [])).filter((id) => id !== tgtId);
    nextEntities.push({
      id: tgtId,
      name: getAggregateEntityName(allKnownEntities),
      kind: 'other',
      aggregate: true,
      ...(othersMerged.length > 0 ? { mergedFrom: othersMerged } : {}),
    });
  }

  const nextParticipations: VTAParticipation[] = [];
  for (const event of analysis.events) {
    const eventParts = analysis.participations.filter((p) => p.eventId === event.id);
    const byTarget = new Map<string, VTAParticipation[]>();
    for (const part of eventParts) {
      const targetId = mergeTargetById.get(part.entityId) ?? part.entityId;
      const list = byTarget.get(targetId) ?? [];
      list.push(part);
      byTarget.set(targetId, list);
    }

    for (const [targetId, parts] of byTarget) {
      if (parts.length === 1 && parts[0].entityId === targetId) {
        nextParticipations.push({ ...parts[0] });
        continue;
      }
      const sortedByRole = [...parts].sort((a, b) => ROLE_PRIORITY[b.role] - ROLE_PRIORITY[a.role]);
      const primary = sortedByRole[0];
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
      const allInferred = parts.every((p) => Boolean(p.inferred));
      const allManual = parts.every((p) => p.origin === 'manual');
      const rawMerged = parts.flatMap((p) =>
        p.mergedFrom?.length ? p.mergedFrom : [{ entityId: p.entityId, role: p.role }]
      );
      const bestRoleByEntity = new Map<string, VTAParticipation['role']>();
      for (const m of rawMerged) {
        const prev = bestRoleByEntity.get(m.entityId);
        if (!prev || ROLE_PRIORITY[m.role] > ROLE_PRIORITY[prev]) {
          bestRoleByEntity.set(m.entityId, m.role);
        }
      }
      const mergedFrom = Array.from(bestRoleByEntity.entries()).map(([entityId, role]) => ({
        entityId,
        role,
      }));

      nextParticipations.push({
        ...primary,
        entityId: targetId,
        role: primary.role,
        factIds,
        ...(sourceRefs?.length ? { sourceRefs } : {}),
        ...(allInferred ? { inferred: true } : { inferred: undefined }),
        origin: allManual ? 'manual' : 'extraction',
        mergedFrom,
      });
    }
  }

  const nextRelations: VTAEventRelation[] = analysis.relations.map((rel) => {
    const newSource = rel.sourceEntityId
      ? (mergeTargetById.get(rel.sourceEntityId) ?? rel.sourceEntityId)
      : undefined;
    const newTarget = rel.targetEntityId
      ? (mergeTargetById.get(rel.targetEntityId) ?? rel.targetEntityId)
      : undefined;
    const sourceEntityOrigin =
      rel.sourceEntityOrigin ??
      (rel.sourceEntityId && newSource !== rel.sourceEntityId ? rel.sourceEntityId : undefined);
    const targetEntityOrigin =
      rel.targetEntityOrigin ??
      (rel.targetEntityId && newTarget !== rel.targetEntityId ? rel.targetEntityId : undefined);
    return {
      ...rel,
      sourceEntityId: newSource,
      targetEntityId: newTarget,
      ...(sourceEntityOrigin ? { sourceEntityOrigin } : {}),
      ...(targetEntityOrigin ? { targetEntityOrigin } : {}),
    };
  });

  const candidateGroups: Array<{ entityId: string; eventIds: string[] }> = [];
  const occupiedPairs = new Set<string>();
  const precedenceArcs = nextRelations.filter(isPrecedence);
  const reachesPrecedence = (from: string, to: string, seen = new Set<string>()): boolean => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return precedenceArcs.some(
      (r) => r.sourceEventId === from && reachesPrecedence(r.targetEventId, to, seen)
    );
  };
  for (const card of analysis.cards) {
    if (card.eventIds.length < 2) continue;
    const targetEntityId = mergeTargetById.get(card.laneEntityId) ?? card.laneEntityId;
    const validEvents = card.eventIds.every((evId) =>
      nextParticipations.some((p) => p.eventId === evId && p.entityId === targetEntityId)
    );
    if (!validEvents) continue;
    const hasInternalOrder = card.eventIds.some((a) =>
      card.eventIds.some((b) => a !== b && reachesPrecedence(a, b))
    );
    if (hasInternalOrder) continue;
    const pairs = card.eventIds.map((evId) => `${evId}\u0000${targetEntityId}`);
    if (pairs.some((k) => occupiedPairs.has(k))) continue;
    pairs.forEach((k) => occupiedPairs.add(k));
    candidateGroups.push({ entityId: targetEntityId, eventIds: [...card.eventIds] });
  }

  const baseRanking = analysis.subjectRanking ?? rankSubjects(analysis, finalLimit);
  const nextNameById = new Map(nextEntities.map((e) => [e.id, e.name]));
  const explicitTargetSet = new Set(mergeTargetById.values());
  const updatedRanks: VTASubjectRankEntry[] = baseRanking.ranks.map((entry) => {
    if (explicitTargetSet.has(entry.entityId)) {
      const tgtEnt = nextEntities.find((e) => e.id === entry.entityId);
      if (tgtEnt && !tgtEnt.aggregate) {
        const { mergedInto: _m, excluded: _ex, mergeBlockedReason: _mb, ...restTarget } = entry;
        return {
          ...restTarget,
          retained: true,
        };
      }
    }
    if (entry.excluded) return { ...entry };
    const currentHolder = entry.retained ? entry.entityId : entry.mergedInto;
    if (!currentHolder || !mergeTargetById.has(currentHolder)) {
      return { ...entry };
    }
    const finalTarget = mergeTargetById.get(currentHolder)!;
    const targetName = nextNameById.get(finalTarget) ?? 'その他の関係者';
    const prefixParts = (entry.reason ? entry.reason.split('／') : []).filter(
      (part) =>
        !part.startsWith('上位保持') &&
        !part.startsWith('上限超過') &&
        !part.startsWith('最終フェーズ')
    );
    const tailReason =
      reasonSuffixByEntityId?.get(currentHolder) ??
      `上限超過のため「${targetName}」へ統合（スコア ${entry.score.toFixed(2)}）`;
    const resolvedStage = stageByEntityId?.get(currentHolder) ?? consolidationStage;
    const { mergeBlockedReason: _clearedMergeBlockedReason, ...restEntry } = entry;
    return {
      ...restEntry,
      retained: false,
      mergedInto: finalTarget,
      ...(resolvedStage && entry.retained ? { consolidationStage: resolvedStage } : {}),
      reason: [...prefixParts, tailReason].join('／'),
    };
  });

  for (const tgtId of explicitTargetSet) {
    const tgtEnt = nextEntities.find((e) => e.id === tgtId);
    if (!tgtEnt || tgtEnt.aggregate) continue;
    if (!updatedRanks.some((r) => r.entityId === tgtId)) {
      updatedRanks.push({
        entityId: tgtId,
        rank: updatedRanks.length + 1,
        score: 1,
        breakdown: { A: 1, O: 0, F: 0, C: 0, T: 0 },
        retained: true,
        reason: `統合先レーン「${tgtEnt.name}」として保持`,
      });
    }
  }

  const nextRanking: VTASubjectRanking = {
    ...baseRanking,
    maxSubjects: finalLimit,
    ranks: updatedRanks,
  };

  try {
    const primarySource = analysis.sources[0] ?? { id: 'source_1', text: '', paragraphs: [] };
    const parsed = validateParticipants(
      {
        entities: nextEntities,
        participations: nextParticipations,
        relations: nextRelations,
        cardGroups: candidateGroups,
        subjectRanking: nextRanking,
        subjectPoset: analysis.subjectPoset,
      },
      analysis.events,
      analysis.facts,
      true,
      undefined,
      analysis.sources
    );
    const built = buildAnalysis(primarySource, analysis.facts, analysis.events, parsed);
    const validRelations = built.relations.filter((r) => !dependencyProblem(built, r, built.relations));

    if (built.unassignedEventIds.length > analysis.unassignedEventIds.length) {
      const warning = `主体の最終集約により未割当イベントが増加するため（${analysis.unassignedEventIds.length}件 → ${built.unassignedEventIds.length}件）、集約をスキップしました。`;
      if (onWarning) onWarning(warning);
      return { analysis, applied: false };
    }

    const nextLaneConsolidation = analysis.laneConsolidation
      ? {
          ...analysis.laneConsolidation,
          laneAssignment: Object.fromEntries(
            Object.entries(analysis.laneConsolidation.laneAssignment).map(([origId, assignedId]) => [
              origId,
              mergeTargetById.get(assignedId) ?? assignedId,
            ])
          ),
        }
      : undefined;

    return {
      analysis: {
        ...analysis,
        entities: built.entities,
        participations: built.participations,
        relations: validRelations,
        cards: built.cards,
        unassignedEventIds: built.unassignedEventIds,
        subjectRanking: nextRanking,
        ...(nextLaneConsolidation ? { laneConsolidation: nextLaneConsolidation } : {}),
      },
      applied: true,
    };
  } catch (error) {
    const warning = `主体の最終集約で整合性検証に失敗したため細粒度主体を保持しました: ${error instanceof Error ? error.message : String(error)}`;
    if (onWarning) onWarning(warning);
    return { analysis, applied: false };
  }
}

export interface FinalPeripheralConsolidationResult {
  schema: VTASchema;
  analysis: VTAAnalysisData;
  foldedEntityIds: string[];
  rolledUpPosetEntityIds: string[];
  targetEntityId?: string;
  modeUsed: OthersConsolidationMode;
  skippedReason?: string;
}

/**
 * ADR-0072: 最適化の最終フェーズ（Stage 3 レーン間接続・連鎖補完完了後）において、
 * 1) 残余 Poset 葉主体の親組織ロールアップ（K_pre > K_post 時）
 * 2) 他レーンとの意味的接続が少なく、接続先が非変動要因である周辺主体の `subject_others` 集約
 * を決定論（または AI 周辺提案＋決定論ハードガード併用）で実行する。
 */
export function consolidatePeripheralSubjectsToOthers(
  schema: VTASchema,
  finalMaxSubjects: number = DEFAULT_MAX_SUBJECTS,
  options?: SubjectRankingOptions,
  onWarning?: (message: string) => void
): FinalPeripheralConsolidationResult {
  const modeUsed: OthersConsolidationMode = options?.othersConsolidationMode ?? 'deterministic';
  if (!schema.analysis) {
    return {
      schema,
      analysis: createManualAnalysis(schema),
      foldedEntityIds: [],
      rolledUpPosetEntityIds: [],
      modeUsed,
      skippedReason: 'no_analysis',
    };
  }

  const limit = Math.max(
    1,
    Math.round(Number.isFinite(finalMaxSubjects) ? finalMaxSubjects : DEFAULT_MAX_SUBJECTS)
  );
  let workingSchema: VTASchema = schema;
  let workingAnalysis: VTAAnalysisData = schema.analysis;
  const rolledUpPosetEntityIds: string[] = [];
  const foldedEntityIds: string[] = [];

  const pinnedSet = new Set<string>(options?.forceRetain ?? []);
  const explicitTargetSet = new Set<string>(
    options?.explicitMerges ? Array.from(options.explicitMerges.values()) : []
  );

  const syncRankingLimit = (a: VTAAnalysisData): VTAAnalysisData => {
    if (!a.subjectRanking || a.subjectRanking.maxSubjects === limit) return a;
    return {
      ...a,
      subjectRanking: {
        ...a.subjectRanking,
        maxSubjects: limit,
      },
    };
  };

  const pruneZeroEventContainers = (idsToPrune: ReadonlySet<string>) => {
    if (idsToPrune.size === 0) return;
    const allKnownForPrune = [
      ...(workingAnalysis.subjectRanking?.originalEntities ?? []),
      ...workingAnalysis.entities,
    ];
    const prunePoset = workingAnalysis.subjectPoset
      ? SubjectPoset.fromData(workingAnalysis.subjectPoset)
      : SubjectPoset.fromEntities(allKnownForPrune);
    const keptNonAggSet = new Set(
      workingAnalysis.entities
        .filter((e) => !e.aggregate && !idsToPrune.has(e.id))
        .map((e) => e.id)
    );
    const resolveKeptParents = (selfId: string, rawPids: string[]): string[] => {
      const out: string[] = [];
      for (const pid of rawPids) {
        if (pid === selfId) continue;
        if (keptNonAggSet.has(pid) && !prunePoset.isAncestor(selfId, pid)) {
          out.push(pid);
          continue;
        }
        const ancCands = Array.from(prunePoset.getAncestors(pid)).filter(
          (anc) => anc !== selfId && keptNonAggSet.has(anc) && !prunePoset.isAncestor(selfId, anc)
        );
        const minAncs = ancCands.filter(
          (anc) => !ancCands.some((other) => other !== anc && prunePoset.isAncestor(anc, other))
        );
        out.push(...minAncs);
      }
      return Array.from(new Set(out));
    };
    const prunedEntities = workingAnalysis.entities
      .filter((e) => !idsToPrune.has(e.id))
      .map((e) => {
        const copy: VTAEntity = { ...e };
        if (!copy.aggregate) {
          if (copy.parentEntityId && !keptNonAggSet.has(copy.parentEntityId)) {
            const np = resolveKeptParents(copy.id, [copy.parentEntityId]);
            if (np.length > 0) copy.parentEntityId = np[0];
            else delete copy.parentEntityId;
          }
          if (copy.parentEntityIds?.length) {
            const nps = resolveKeptParents(copy.id, copy.parentEntityIds);
            if (nps.length > 0) {
              copy.parentEntityIds = nps;
              if (!copy.parentEntityId) copy.parentEntityId = nps[0];
            } else {
              delete copy.parentEntityIds;
            }
          }
        }
        return copy;
      });
    const baseRanking = workingAnalysis.subjectRanking ?? rankSubjects(workingAnalysis, limit);
    const prunedRanks = baseRanking.ranks.map((r) =>
      idsToPrune.has(r.entityId)
        ? {
            ...r,
            retained: false,
            mergedInto: undefined,
            excluded: true,
            consolidationStage: 'stage2.5_b0_prune' as const,
            reason: `変動要因・因果影響のない定常背景のためレーン除外（スコア ${r.score.toFixed(2)}）`,
          }
        : r
    );
    workingAnalysis = {
      ...workingAnalysis,
      entities: prunedEntities,
      subjectRanking: {
        ...baseRanking,
        maxSubjects: limit,
        ranks: prunedRanks,
      },
    };
    workingSchema = projectAnalysis(workingAnalysis, workingSchema, { silentDebug: true });
    workingAnalysis = workingSchema.analysis ?? workingAnalysis;
  };

  // Sub-step B0: When K_pre >= rawEntityCount > K_post, prune 0-participation Poset container orgs
  // that have < 2 active descendants; keep >= 2-descendant orgs as candidate hubs for the solver.
  const stage3ZeroEventHubIds = new Set<string>();
  if (workingAnalysis.entities.length > limit) {
    const participatingIds = new Set(workingAnalysis.participations.map((p) => p.entityId));
    for (const rel of workingAnalysis.relations) {
      if (rel.sourceEntityId) participatingIds.add(rel.sourceEntityId);
      if (rel.targetEntityId) participatingIds.add(rel.targetEntityId);
      if (rel.sourceEntityOrigin) participatingIds.add(rel.sourceEntityOrigin);
      if (rel.targetEntityOrigin) participatingIds.add(rel.targetEntityOrigin);
    }
    const allKnownForHub = [
      ...(workingAnalysis.subjectRanking?.originalEntities ?? []),
      ...workingAnalysis.entities,
    ];
    const hubPoset = workingAnalysis.subjectPoset
      ? SubjectPoset.fromData(workingAnalysis.subjectPoset)
      : SubjectPoset.fromEntities(allKnownForHub);
    const b0EventById = new Map(workingAnalysis.events.map((ev) => [ev.id, ev]));
    const b0OutcomeEventIds = new Set(
      workingAnalysis.outcome?.status === 'identified' ? workingAnalysis.outcome.eventIds : []
    );
    const isStage3ForcedDescendant = (desc: VTAEntity): boolean => {
      if (
        pinnedSet.has(desc.id) ||
        explicitTargetSet.has(desc.id) ||
        desc.id.startsWith('manual_entity_') ||
        desc.id.startsWith('user_entity_') ||
        workingSchema.presentation?.lanes?.[desc.id] === 'show' ||
        isReporterEntity(desc)
      ) {
        return true;
      }
      const isProtectedOut =
        b0OutcomeEventIds.size > 0 &&
        workingAnalysis.participations.some((p) => {
          if (p.entityId !== desc.id || !b0OutcomeEventIds.has(p.eventId)) return false;
          if (p.role === 'actor') return true;
          if (desc.kind !== 'machine') {
            const ev = b0EventById.get(p.eventId);
            const isLossOut =
              ev?.outcome_kind === 'loss' ||
              (!ev?.outcome_kind &&
                workingAnalysis.outcome?.kind !== 'recovery' &&
                workingAnalysis.outcome?.kind !== 'near_miss');
            return p.role === 'affected' ? isLossOut : false;
          }
          return false;
        });
      if (isProtectedOut) return true;
      const hasOwnVariation = workingAnalysis.participations.some(
        (p) =>
          p.entityId === desc.id &&
          !b0EventById.get(p.eventId)?.ignored &&
          isEffectiveVariationEvent(workingAnalysis, b0EventById.get(p.eventId))
      );
      if (hasOwnVariation && desc.focus !== 'low') return true;
      return false;
    };
    const immediatePruneIds = new Set<string>();
    for (const e of workingAnalysis.entities) {
      if (
        e.aggregate ||
        participatingIds.has(e.id) ||
        pinnedSet.has(e.id) ||
        explicitTargetSet.has(e.id) ||
        e.id.startsWith('manual_entity_') ||
        e.id.startsWith('user_entity_') ||
        workingSchema.presentation?.lanes?.[e.id] === 'show'
      ) {
        continue;
      }
      const mergeableDescCount = workingAnalysis.entities.filter(
        (desc) =>
          desc.id !== e.id &&
          !desc.aggregate &&
          participatingIds.has(desc.id) &&
          !isStage3ForcedDescendant(desc) &&
          hubPoset.isAncestor(e.id, desc.id) &&
          evaluateMergeGuard(desc.id, e.id, workingAnalysis).allowed
      ).length;
      if (e.kind === 'organization' && mergeableDescCount >= 2) {
        stage3ZeroEventHubIds.add(e.id);
      } else {
        immediatePruneIds.add(e.id);
      }
    }
    pruneZeroEventContainers(immediatePruneIds);
  }

  const getActiveEntities = (s: VTASchema, a: VTAAnalysisData): VTAEntity[] => {
    const vis = visibleSchema(s);
    const visLaneNames = new Set(vis.lanes);
    const visNodeLanes = new Set(vis.nodes.map((n) => n.lane));
    return a.entities.filter(
      (e) =>
        s.presentation?.lanes?.[e.id] !== 'hide' &&
        (visLaneNames.has(e.name) ||
          visNodeLanes.has(e.name) ||
          stage3ZeroEventHubIds.has(e.id) ||
          s.presentation?.lanes?.[e.id] === 'show' ||
          pinnedSet.has(e.id))
    );
  };

  // Unified Declarative Final Consolidation via solveOptimalSubjectRetention (ADR-0075)
  // Evaluate canonical non-hidden lanes without transient 1-card `suppressedCards` hiding
  // (planCardSimplification / legacy suppressedCards), while preserving explicit lane='hide'.
  const evalSchema = workingSchema.presentation
    ? connectSharedEvents({
        ...workingSchema,
        presentation: {
          ...workingSchema.presentation,
          suppressedCards: {},
        },
      })
    : workingSchema;
  const visBefore = visibleSchema(evalSchema);
  const activeEntities = getActiveEntities(evalSchema, workingAnalysis);
  const currentLaneCount = activeEntities.filter((e) => !stage3ZeroEventHubIds.has(e.id)).length;
  if (currentLaneCount <= limit) {
    if (stage3ZeroEventHubIds.size > 0) {
      pruneZeroEventContainers(stage3ZeroEventHubIds);
    }
    const syncedAnalysis = syncRankingLimit(workingAnalysis);
    const syncedSchema =
      syncedAnalysis === workingAnalysis ? workingSchema : { ...workingSchema, analysis: syncedAnalysis };
    return {
      schema: syncedSchema,
      analysis: syncedAnalysis,
      foldedEntityIds,
      rolledUpPosetEntityIds,
      modeUsed,
      skippedReason: 'within_limit',
    };
  }

  if (
    modeUsed === 'llm_assisted' &&
    options?.llmPeripheralSectionPresent &&
    (options.llmPeripheralEntityIds?.size ?? 0) === 0 &&
    currentLaneCount <= limit + 2
  ) {
    const syncedAnalysis = syncRankingLimit(workingAnalysis);
    const syncedSchema =
      syncedAnalysis === workingAnalysis ? workingSchema : { ...workingSchema, analysis: syncedAnalysis };
    return {
      schema: syncedSchema,
      analysis: syncedAnalysis,
      foldedEntityIds: [],
      rolledUpPosetEntityIds: [],
      modeUsed,
      skippedReason: 'llm_no_peripheral_candidates',
    };
  }

  const allKnownEntities = [
    ...(workingAnalysis.subjectRanking?.originalEntities ?? []),
    ...workingAnalysis.entities,
  ];
  const existingOthers = workingAnalysis.entities.find(
    (e) => e.aggregate && (e.id === 'subject_others' || e.id.startsWith('subject_others_'))
  );
  const othersId = existingOthers ? existingOthers.id : getAggregateEntityId(allKnownEntities);
  const alreadyHasActiveOthers = Boolean(
    existingOthers && activeEntities.some((e) => e.id === existingOthers.id)
  );

  const poset = workingAnalysis.subjectPoset
    ? SubjectPoset.fromData(workingAnalysis.subjectPoset)
    : SubjectPoset.fromEntities(allKnownEntities);
  const rankById = new Map((workingAnalysis.subjectRanking?.ranks ?? []).map((r) => [r.entityId, r]));
  const eventById = new Map(workingAnalysis.events.map((e) => [e.id, e]));
  const outcomeEventIds = new Set(
    workingAnalysis.outcome?.status === 'identified' ? workingAnalysis.outcome.eventIds : []
  );

  const isSpecialEvent = (evId: string): boolean => {
    const ev = eventById.get(evId);
    return (
      outcomeEventIds.has(evId) ||
      isEffectiveVariationEvent(workingAnalysis, ev) ||
      isEffectiveRecoveryEvent(workingAnalysis, ev)
    );
  };
  const isSpecialNode = (node: VTASchema['nodes'][number]): boolean =>
    node.type === 'variation' ||
    node.type === 'outcome' ||
    (node.event_ids ?? []).some(isSpecialEvent);

  const activeNonAgg = activeEntities.filter((e) => !e.aggregate);
  const activeNonAggIdSet = new Set(activeNonAgg.map((e) => e.id));
  const activeLaneNameSet = new Set(activeEntities.map((e) => e.name));
  const activeNodes = visBefore.nodes.filter((n) => activeLaneNameSet.has(n.lane));
  const nodeById = new Map(activeNodes.map((n) => [n.id, n]));

  interface PeripheralMetrics {
    entity: VTAEntity;
    isPassiveMachine: boolean;
    llmSuggested: boolean;
    focusTier: number;
    semanticCrossDegree: number;
    actorEventCount: number;
    associationCrossDegree: number;
    rankScore: number;
    rankOrder: number;
  }

  const forcedRetainIds = new Set<string>();
  const othersEligibleMetrics: PeripheralMetrics[] = [];

  for (const ent of activeNonAgg) {
    if (stage3ZeroEventHubIds.has(ent.id)) {
      continue;
    }
    if (
      pinnedSet.has(ent.id) ||
      explicitTargetSet.has(ent.id) ||
      ent.id.startsWith('manual_entity_') ||
      ent.id.startsWith('user_entity_') ||
      workingSchema.presentation?.lanes?.[ent.id] === 'show' ||
      isReporterEntity(ent)
    ) {
      forcedRetainIds.add(ent.id);
      continue;
    }

    const hasVisiblePosetDescendant = activeNonAgg.some(
      (other) => other.id !== ent.id && !stage3ZeroEventHubIds.has(other.id) && poset.isAncestor(ent.id, other.id)
    );
    if (hasVisiblePosetDescendant) {
      forcedRetainIds.add(ent.id);
      continue;
    }

    const isProtectedOutcomeParticipant =
      outcomeEventIds.size > 0 &&
      workingAnalysis.participations.some((p) => {
        if (p.entityId !== ent.id || !outcomeEventIds.has(p.eventId)) return false;
        if (p.role === 'actor') return true;
        if (ent.kind !== 'machine') {
          const ev = eventById.get(p.eventId);
          const isLossOutcome =
            ev?.outcome_kind === 'loss' ||
            (!ev?.outcome_kind &&
              workingAnalysis.outcome?.kind !== 'recovery' &&
              workingAnalysis.outcome?.kind !== 'near_miss');
          return p.role === 'affected' ? isLossOutcome : false;
        }
        return false;
      });
    if (isProtectedOutcomeParticipant) {
      forcedRetainIds.add(ent.id);
      continue;
    }

    const laneCards = activeNodes.filter((n) => n.lane === ent.name);
    const entParts = workingAnalysis.participations.filter(
      (p) => p.entityId === ent.id && !eventById.get(p.eventId)?.ignored
    );
    const specialParts = entParts.filter((p) => isSpecialEvent(p.eventId));
    const variationParts = entParts.filter((p) =>
      isEffectiveVariationEvent(workingAnalysis, eventById.get(p.eventId))
    );
    const hasVariationCard = laneCards.some(
      (n) =>
        n.type === 'variation' ||
        (n.event_ids ?? []).some((id) => isEffectiveVariationEvent(workingAnalysis, eventById.get(id)))
    );
    // Low-focus 1-card entities whose sole shared variation event is already represented on another active named lane remain peripheral-eligible
    const onlyRedundantSharedLowFocusVariation =
      specialParts.length > 0 &&
      ent.focus === 'low' &&
      laneCards.length <= 1 &&
      specialParts.every((sp) =>
        workingAnalysis.participations.some(
          (op) => op.eventId === sp.eventId && op.entityId !== ent.id && activeNonAggIdSet.has(op.entityId)
        )
      );

    const visibleAncs = activeNonAgg.filter(
      (other) => other.id !== ent.id && poset.isAncestor(other.id, ent.id)
    );
    if (visibleAncs.length > 0) {
      if ((variationParts.length > 0 || hasVariationCard) && !onlyRedundantSharedLowFocusVariation) {
        forcedRetainIds.add(ent.id);
        continue;
      }
      // Poset leaf: check full Merge Guard against nearest ancestor cluster & strict asymmetry against active siblings
      const nearestAnc =
        visibleAncs.find(
          (anc) =>
            !visibleAncs.some(
              (mid) => mid.id !== anc.id && poset.isAncestor(anc.id, mid.id) && poset.isAncestor(mid.id, ent.id)
            )
        ) ?? visibleAncs[0];
      const clusterIds = [nearestAnc.id, ...(nearestAnc.mergedFrom ?? [])];
      const blockedAgainstParent = clusterIds.some(
        (cid) => cid !== ent.id && !evaluateMergeGuard(ent.id, cid, workingAnalysis).allowed
      );
      const strictBlockedAgainstSibling = activeNonAgg.some(
        (sib) =>
          sib.id !== ent.id &&
          sib.id !== nearestAnc.id &&
          poset.isAncestor(nearestAnc.id, sib.id) &&
          evaluateMergeGuard(ent.id, sib.id, workingAnalysis).strictAsymmetry
      );
      if (blockedAgainstParent || strictBlockedAgainstSibling) {
        forcedRetainIds.add(ent.id);
      }
      continue;
    }

    if (specialParts.length > 0 && !onlyRedundantSharedLowFocusVariation) {
      forcedRetainIds.add(ent.id);
      continue;
    }
    if (laneCards.some(isSpecialNode) && !onlyRedundantSharedLowFocusVariation) {
      forcedRetainIds.add(ent.id);
      continue;
    }

    // Unparented entity: inspect cross-lane connectivity for subject_others eligibility
    const semanticNeighbors = new Set<string>();
    const associationNeighbors = new Set<string>();
    const incomingSemanticOwnCards = new Set<string>();
    const outgoingSemanticOwnCards = new Set<string>();
    let variationNeighborSemanticCount = 0;

    for (const edge of visBefore.edges) {
      const sNode = nodeById.get(edge.source);
      const tNode = nodeById.get(edge.target);
      if (!sNode || !tNode || sNode.lane === tNode.lane) continue;
      if (sNode.lane !== ent.name && tNode.lane !== ent.name) continue;
      const ownNode = sNode.lane === ent.name ? sNode : tNode;
      const otherNode = sNode.lane === ent.name ? tNode : sNode;

      if (edge.meaning === 'association') {
        associationNeighbors.add(otherNode.id);
        continue;
      }
      semanticNeighbors.add(otherNode.id);
      if (isSpecialNode(otherNode)) {
        variationNeighborSemanticCount++;
      }
      const isBidirectional =
        edge.direction === 'bidirectional' || edge.direction === 'undirected';
      if (sNode.lane === ent.name || isBidirectional) {
        outgoingSemanticOwnCards.add(ownNode.id);
      }
      if (tNode.lane === ent.name || isBidirectional) {
        incomingSemanticOwnCards.add(ownNode.id);
      }
    }

    const isCausalBridge =
      laneCards.length >= 2 &&
      incomingSemanticOwnCards.size > 0 &&
      outgoingSemanticOwnCards.size > 0;
    const semanticCrossDegree = semanticNeighbors.size;

    if (variationNeighborSemanticCount > 0 || isCausalBridge || semanticCrossDegree > 2) {
      forcedRetainIds.add(ent.id);
      continue;
    }

    const rankEntry = rankById.get(ent.id);
    othersEligibleMetrics.push({
      entity: ent,
      isPassiveMachine: ent.kind === 'machine' && !isActiveOrInteractiveMachine(ent, workingAnalysis),
      llmSuggested: modeUsed === 'llm_assisted' && Boolean(options?.llmPeripheralEntityIds?.has(ent.id)),
      focusTier: ent.focus === 'low' ? 0 : ent.focus === 'high' ? 2 : 1,
      semanticCrossDegree,
      actorEventCount: entParts.filter((p) => p.role === 'actor').length,
      associationCrossDegree: associationNeighbors.size,
      rankScore: rankEntry?.score ?? 0,
      rankOrder: rankEntry?.rank ?? 999,
    });
  }

  // Deterministic peripheral priority ordering -> mapped monotonically into othersCostById
  othersEligibleMetrics.sort((a, b) => {
    if (a.isPassiveMachine !== b.isPassiveMachine) return a.isPassiveMachine ? -1 : 1;
    if (a.llmSuggested !== b.llmSuggested) return a.llmSuggested ? -1 : 1;
    if (a.focusTier !== b.focusTier) return a.focusTier - b.focusTier;
    if (a.semanticCrossDegree !== b.semanticCrossDegree) return a.semanticCrossDegree - b.semanticCrossDegree;
    if (a.actorEventCount !== b.actorEventCount) return a.actorEventCount - b.actorEventCount;
    if (a.associationCrossDegree !== b.associationCrossDegree) {
      return a.associationCrossDegree - b.associationCrossDegree;
    }
    if (Math.abs(a.rankScore - b.rankScore) > 1e-9) return a.rankScore - b.rankScore;
    return b.rankOrder - a.rankOrder;
  });

  const canFoldToOthersById = new Set(othersEligibleMetrics.map((m) => m.entity.id));
  const othersCostById = new Map<string, number>();
  const peripheralOrderIndex = new Map<string, number>();
  const peripheralMetricsById = new Map<string, PeripheralMetrics>();
  othersEligibleMetrics.forEach((m, idx) => {
    othersCostById.set(m.entity.id, 0.02 + idx * 0.006);
    peripheralOrderIndex.set(m.entity.id, idx);
    peripheralMetricsById.set(m.entity.id, m);
  });

  const activePool = [...activeNonAgg]
    .map((entity) => {
      const r = rankById.get(entity.id);
      return {
        entity,
        score: r?.score ?? 0,
        priority: r?.priority,
        rankOrder: r?.rank ?? 999,
      };
    })
    .sort((a, b) => a.rankOrder - b.rankOrder);

  const entityMap = new Map<string, VTAEntity>();
  for (const e of allKnownEntities) entityMap.set(e.id, e);
  const influenceMap = new Map(
    activePool.map((c) => [c.entity.id, isInfluentialSubject(c.entity, workingAnalysis)])
  );

  const solved = solveOptimalSubjectRetention({
    activePool,
    effectiveLimit: limit,
    effectiveForceRetain: forcedRetainIds,
    poset,
    entityById: entityMap,
    analysis: workingAnalysis,
    influenceMap,
    options: {
      ...options,
      allowSubjectOthers: true,
    },
    canFoldToOthersById,
    othersCostById,
    existingOthersId: othersId,
    existingOthersActive: alreadyHasActiveOthers,
    zeroEventHubIds: stage3ZeroEventHubIds,
  });

  if (solved.excludedIds.size > 0) {
    pruneZeroEventContainers(solved.excludedIds);
  }

  if (solved.mergeTargetById.size === 0) {
    const syncedAnalysis = syncRankingLimit(workingAnalysis);
    const syncedSchema =
      syncedAnalysis === workingAnalysis ? workingSchema : { ...workingSchema, analysis: syncedAnalysis };
    return {
      schema: syncedSchema,
      analysis: syncedAnalysis,
      foldedEntityIds: [],
      rolledUpPosetEntityIds: [],
      modeUsed,
      skippedReason:
        othersEligibleMetrics.length === 1 && !alreadyHasActiveOthers
          ? 'single_candidate_guard'
          : 'no_eligible_peripheral_subjects',
    };
  }

  const targetOthersName = existingOthers?.name ?? getAggregateEntityName(allKnownEntities);
  const reasonMap = new Map<string, string>();
  const stageMap = new Map<string, VTASubjectConsolidationStage>();
  const posetMergedLaneNames = new Set<string>();
  const othersMergedLaneNames = new Set<string>();

  for (const [srcId, tgtId] of solved.mergeTargetById) {
    const srcEnt = entityMap.get(srcId);
    const rScore = rankById.get(srcId)?.score ?? 0;
    if (tgtId === solved.othersId) {
      const m = peripheralMetricsById.get(srcId);
      const modeTag = m?.llmSuggested ? 'AI周辺提案・' : '';
      const deg = m?.semanticCrossDegree ?? 0;
      reasonMap.set(
        srcId,
        `最終フェーズ周辺主体集約（${modeTag}接続数=${deg}・非変動接続）により「${targetOthersName}」へ統合（スコア ${rScore.toFixed(2)}）`
      );
      stageMap.set(srcId, 'stage2.5_b2_others');
      if (srcEnt) othersMergedLaneNames.add(srcEnt.name);
      foldedEntityIds.push(srcId);
    } else {
      const tgtName = entityMap.get(tgtId)?.name ?? tgtId;
      reasonMap.set(
        srcId,
        `最終フェーズPoset包摂により「${tgtName}」へ統合（スコア ${rScore.toFixed(2)}）`
      );
      stageMap.set(srcId, 'stage2.5_b1_poset');
      if (srcEnt) posetMergedLaneNames.add(srcEnt.name);
      rolledUpPosetEntityIds.push(srcId);
    }
  }

  foldedEntityIds.sort(
    (a, b) => (peripheralOrderIndex.get(a) ?? 999) - (peripheralOrderIndex.get(b) ?? 999)
  );

  const folded = foldEntitiesIntoTargets(
    workingAnalysis,
    solved.mergeTargetById,
    limit,
    reasonMap,
    onWarning,
    undefined,
    stageMap
  );
  if (!folded.applied) {
    const syncedAnalysis = syncRankingLimit(workingAnalysis);
    const syncedSchema =
      syncedAnalysis === workingAnalysis ? workingSchema : { ...workingSchema, analysis: syncedAnalysis };
    return {
      schema: syncedSchema,
      analysis: syncedAnalysis,
      foldedEntityIds: [],
      rolledUpPosetEntityIds: [],
      modeUsed,
      skippedReason: 'validation_aborted',
    };
  }

  let baseLanes = [...workingSchema.lanes];
  for (const [srcId, tgtId] of solved.mergeTargetById) {
    if (!stage3ZeroEventHubIds.has(tgtId)) continue;
    const tgtName = entityMap.get(tgtId)?.name;
    const srcName = entityMap.get(srcId)?.name;
    if (tgtName && !baseLanes.includes(tgtName)) {
      const idx = srcName ? baseLanes.indexOf(srcName) : -1;
      if (idx >= 0) baseLanes.splice(idx, 0, tgtName);
      else baseLanes.push(tgtName);
    }
  }
  let preferredLanes = baseLanes.filter((l) => !posetMergedLaneNames.has(l));
  if (othersMergedLaneNames.size > 0) {
    const actualOthersName =
      folded.analysis.entities.find((e) => e.id === solved.othersId)?.name ?? targetOthersName;
    preferredLanes = mergeLanesAfterConsolidation(
      preferredLanes,
      othersMergedLaneNames,
      actualOthersName,
      folded.analysis.entities
    );
  }

  const projected = projectAnalysis(folded.analysis, workingSchema, {
    preferredLanes,
    silentDebug: true,
  });
  workingSchema = shiftSchemaPositionsForLaneChange(workingSchema, projected);
  workingAnalysis = workingSchema.analysis ?? folded.analysis;

  return {
    schema: workingSchema,
    analysis: workingAnalysis,
    foldedEntityIds,
    rolledUpPosetEntityIds,
    ...(foldedEntityIds.length > 0 ? { targetEntityId: solved.othersId } : {}),
    modeUsed,
  };
}

export function consolidateSubjects(
  analysis: VTAAnalysisData,
  maxSubjects: number = DEFAULT_MAX_SUBJECTS,
  weights: Record<'A' | 'O' | 'F' | 'C' | 'T', number> = DEFAULT_SUBJECT_RANKING_WEIGHTS,
  onWarning?: (message: string) => void,
  options?: SubjectRankingOptions
): VTAAnalysisData {
  const base = analysis.subjectRanking ? revertConsolidation(analysis) : structuredClone(analysis);
  const limit = Math.max(
    1,
    Math.round(Number.isFinite(maxSubjects) ? maxSubjects : DEFAULT_MAX_SUBJECTS)
  );

  // Step 1: Poset-only hierarchical consolidation (strictly without subject_others)
  const posetConsolidated = consolidateSubjectsBaseStep(base, limit, weights, onWarning, {
    ...options,
    allowSubjectOthers: false,
  });

  if (
    options?.allowSubjectOthers === false ||
    posetConsolidated.subjectRanking?.warning ||
    posetConsolidated.entities.length <= limit
  ) {
    return posetConsolidated;
  }

  // Step 2: Final-phase peripheral subject consolidation into subject_others
  const projected = projectAnalysis(posetConsolidated);
  const finalResult = consolidatePeripheralSubjectsToOthers(
    projected,
    limit,
    options,
    onWarning
  );
  return finalResult.analysis;
}

export function revertConsolidation(analysis: VTAAnalysisData): VTAAnalysisData {
  const ranking = analysis.subjectRanking;
  if (!ranking || !ranking.originalEntities.length) {
    return structuredClone(analysis);
  }

  const restoredEntities: VTAEntity[] = ranking.originalEntities.map((e) => structuredClone(e));
  const restoredIds = new Set(restoredEntities.map((e) => e.id));
  const restoredNames = new Set(restoredEntities.map((e) => e.name));

  // Preserve any manually added non-aggregate entities
  for (const ent of analysis.entities) {
    if (!ent.aggregate && !restoredIds.has(ent.id) && !restoredNames.has(ent.name)) {
      restoredEntities.push(structuredClone(ent));
      restoredIds.add(ent.id);
      restoredNames.add(ent.name);
    }
  }

  // Expand participations back to their fine-grained entities
  const restoredParticipations: VTAParticipation[] = [];
  const seenPartKey = new Set<string>();
  const pushPart = (part: VTAParticipation) => {
    if (!restoredIds.has(part.entityId)) return;
    const key = `${part.eventId}\u0000${part.entityId}`;
    if (seenPartKey.has(key)) return;
    seenPartKey.add(key);
    const copy: VTAParticipation = { ...part };
    delete copy.mergedFrom;
    restoredParticipations.push(copy);
  };

  for (const part of analysis.participations) {
    if (part.mergedFrom?.length) {
      for (const m of part.mergedFrom) {
        pushPart({
          ...part,
          entityId: m.entityId,
          role: part.origin === 'manual' ? part.role : m.role,
          mergedFrom: undefined,
        });
      }
    } else if (restoredIds.has(part.entityId)) {
      pushPart(part);
    }
  }

  // Restore relation endpoints from *EntityOrigin (with fallback resolution for post-consolidation relations)
  const poset = analysis.subjectPoset
    ? SubjectPoset.fromData(analysis.subjectPoset)
    : SubjectPoset.fromEntities(restoredEntities);

  const resolveRestoredEndpoint = (
    eventId: string,
    originId: string | undefined,
    currentId: string | undefined
  ): string | undefined => {
    const candidate = originId ?? currentId;
    if (!candidate) return undefined;
    if (
      restoredIds.has(candidate) &&
      restoredParticipations.some((p) => p.eventId === eventId && p.entityId === candidate)
    ) {
      return candidate;
    }
    // 統合後レーン（親主体や subject_others）に対して追加された関係から、元の細粒度関与主体を逆解決
    if (currentId) {
      const consolidatedPart = analysis.participations.find(
        (p) => p.eventId === eventId && p.entityId === currentId
      );
      if (consolidatedPart?.mergedFrom) {
        const matchedOrigin = consolidatedPart.mergedFrom.find(
          (m) =>
            restoredIds.has(m.entityId) &&
            restoredParticipations.some((p) => p.eventId === eventId && p.entityId === m.entityId)
        );
        if (matchedOrigin) return matchedOrigin.entityId;
      }
      const viaPoset = restoredParticipations.find(
        (p) =>
          p.eventId === eventId &&
          restoredIds.has(p.entityId) &&
          (poset.isAncestor(currentId, p.entityId) || poset.isDescendant(currentId, p.entityId))
      );
      if (viaPoset) return viaPoset.entityId;
    }
    return undefined;
  };

  const restoredRelations: VTAEventRelation[] = [];
  const seenRelIds = new Set<string>();
  const seenRelSignatures = new Set<string>();

  for (const rel of analysis.relations) {
    const hasSrc = Boolean(rel.sourceEntityOrigin ?? rel.sourceEntityId);
    const hasTgt = Boolean(rel.targetEntityOrigin ?? rel.targetEntityId);
    const srcId = resolveRestoredEndpoint(rel.sourceEventId, rel.sourceEntityOrigin, rel.sourceEntityId);
    const tgtId = resolveRestoredEndpoint(rel.targetEventId, rel.targetEntityOrigin, rel.targetEntityId);

    if (rel.kind === 'before') {
      if (hasSrc && !srcId) continue;
      if (hasTgt && !tgtId) continue;
    } else {
      if (!srcId || !tgtId) continue;
    }
    if (rel.kind === 'dependency' && (rel.sourceEventId === rel.targetEventId || srcId === tgtId)) {
      continue;
    }

    const sig = `${rel.kind}|${rel.sourceEventId}|${srcId ?? ''}|${rel.targetEventId}|${tgtId ?? ''}|${rel.resource ?? ''}|${rel.status ?? ''}`;
    if (seenRelSignatures.has(sig)) {
      continue;
    }
    seenRelSignatures.add(sig);

    let relId = rel.id;
    if (relId) {
      if (seenRelIds.has(relId)) {
        let suffix = 2;
        while (seenRelIds.has(`${relId}_${suffix}`)) suffix++;
        relId = `${relId}_${suffix}`;
      }
      seenRelIds.add(relId);
    }

    const copy: VTAEventRelation = {
      ...rel,
      ...(relId ? { id: relId } : {}),
      sourceEntityId: srcId,
      targetEntityId: tgtId,
    };
    delete copy.sourceEntityOrigin;
    delete copy.targetEntityOrigin;
    restoredRelations.push(copy);
  }

  // Preserve valid multi-event cards where possible
  const candidateGroups: Array<{ entityId: string; eventIds: string[] }> = [];
  const occupied = new Set<string>();
  for (const card of analysis.cards) {
    if (card.eventIds.length < 2 || !restoredIds.has(card.laneEntityId)) continue;
    if (
      card.eventIds.every((evId) =>
        restoredParticipations.some((p) => p.eventId === evId && p.entityId === card.laneEntityId)
      )
    ) {
      const keys = card.eventIds.map((evId) => `${evId}\u0000${card.laneEntityId}`);
      if (keys.some((k) => occupied.has(k))) continue;
      keys.forEach((k) => occupied.add(k));
      candidateGroups.push({ entityId: card.laneEntityId, eventIds: [...card.eventIds] });
    }
  }

  const primarySource = analysis.sources[0] ?? { id: 'source_1', text: '', paragraphs: [] };
  const parsed = validateParticipants(
    {
      entities: restoredEntities,
      participations: restoredParticipations,
      relations: restoredRelations,
      cardGroups: candidateGroups,
    },
    analysis.events,
    analysis.facts,
    true,
    undefined,
    analysis.sources
  );
  const built = buildAnalysis(primarySource, analysis.facts, analysis.events, parsed);
  const next: VTAAnalysisData = {
    ...analysis,
    entities: built.entities,
    participations: built.participations,
    relations: built.relations,
    cards: built.cards,
    unassignedEventIds: built.unassignedEventIds,
  };
  delete next.subjectRanking;
  return next;
}

/**
 * ADR-0081: 他の無関係なレーンの統合パーティションを一切破壊せず、O(V+E) で指定された主体群のみを
 * ターゲット主体へ局所増分統合する。12万状態探索 (consolidateSubjects) を呼ばずに UI 即時応答と
 * OLAP ドリルダウン・再分割の可逆性を両立する。
 */
export function mergeEntitiesLocally(
  analysis: VTAAnalysisData,
  sourceEntityIds: readonly string[],
  targetEntity: VTAEntity,
  subjectLimit: number = DEFAULT_MAX_SUBJECTS,
  onWarning?: (message: string) => void
): VTAAnalysisData {
  const validSources = Array.from(
    new Set(
      sourceEntityIds.filter(
        (id) => Boolean(id) && id !== targetEntity.id && analysis.entities.some((e) => e.id === id)
      )
    )
  );
  if (validSources.length === 0) {
    return analysis;
  }

  const initialRanking = analysis.subjectRanking ?? rankSubjects(analysis, subjectLimit);
  const baseEntities = analysis.entities.map((e) => ({ ...e }));
  const existingTargetIdx = baseEntities.findIndex((e) => e.id === targetEntity.id);
  if (existingTargetIdx >= 0) {
    const prev = baseEntities[existingTargetIdx];
    baseEntities[existingTargetIdx] = {
      ...prev,
      ...targetEntity,
      ...(prev.mergedFrom?.length ? { mergedFrom: [...prev.mergedFrom] } : {}),
    };
  } else {
    baseEntities.push({ ...targetEntity });
  }

  const allKnownEntities = [...(initialRanking.originalEntities ?? []), ...baseEntities];
  const workingPoset = analysis.subjectPoset
    ? SubjectPoset.fromData(analysis.subjectPoset)
    : SubjectPoset.fromEntities(allKnownEntities);
  workingPoset.addNode(targetEntity.id);
  if (targetEntity.name) {
    workingPoset.addAlias(targetEntity.name, targetEntity.id);
    workingPoset.addAlias(targetEntity.name.normalize('NFKC'), targetEntity.id);
  }

  const validSourceSet = new Set(validSources);
  const updatedEntities = baseEntities.map((e) => {
    if (!targetEntity.aggregate && validSourceSet.has(e.id) && !workingPoset.isAncestor(e.id, targetEntity.id)) {
      const currentParents = e.parentEntityIds ?? (e.parentEntityId ? [e.parentEntityId] : []);
      const newParents = Array.from(new Set([...currentParents, targetEntity.id]));
      workingPoset.addRawEdge(e.id, targetEntity.id);
      return { ...e, parentEntityId: targetEntity.id, parentEntityIds: newParents };
    }
    return e;
  });
  workingPoset.removeCycles();
  workingPoset.ensureClosure();

  const workingAnalysis: VTAAnalysisData = {
    ...analysis,
    entities: updatedEntities,
    subjectPoset: workingPoset.toJSON(),
    subjectRanking: initialRanking,
  };

  const mergeMap = new Map<string, string>();
  const reasonMap = new Map<string, string>();
  for (const srcId of validSources) {
    mergeMap.set(srcId, targetEntity.id);
    reasonMap.set(srcId, `手動統合により「${targetEntity.name}」へ集約`);
  }

  const folded = foldEntitiesIntoTargets(
    workingAnalysis,
    mergeMap,
    subjectLimit,
    reasonMap,
    onWarning,
    'stage2_bnb'
  );
  return folded.analysis;
}

/**
 * ADR-0081: 他のレーンの統合状態を一切変更せず、指定された親レーン (parentEntityId) から
 * splitEntityIds のみを O(V+E) で独立レーンへ局所展開する。
 */
export function splitEntitiesLocally(
  analysis: VTAAnalysisData,
  parentEntityId: string,
  splitEntityIds: readonly string[],
  subjectLimit: number = DEFAULT_MAX_SUBJECTS,
  onWarning?: (message: string) => void
): VTAAnalysisData {
  const splitSet = new Set(splitEntityIds.filter((id) => Boolean(id)));
  if (splitSet.size === 0) {
    return analysis;
  }

  const currentMergeMap = new Map<string, string>();
  const excludedIds = new Set<string>();
  for (const r of analysis.subjectRanking?.ranks ?? []) {
    if (r.excluded) {
      excludedIds.add(r.entityId);
    } else if (!r.retained && r.mergedInto && r.mergedInto !== r.entityId) {
      currentMergeMap.set(r.entityId, r.mergedInto);
    }
  }
  for (const ent of analysis.entities) {
    for (const mId of ent.mergedFrom ?? []) {
      if (mId !== ent.id && !currentMergeMap.has(mId)) {
        currentMergeMap.set(mId, ent.id);
      }
    }
  }
  for (const part of analysis.participations) {
    for (const m of part.mergedFrom ?? []) {
      if (m.entityId !== part.entityId && !currentMergeMap.has(m.entityId)) {
        currentMergeMap.set(m.entityId, part.entityId);
      }
    }
  }

  for (const sId of splitSet) {
    currentMergeMap.delete(sId);
    excludedIds.delete(sId);
  }

  const reverted = revertConsolidation(analysis);
  const remainingTargets = new Set(currentMergeMap.values());
  const hasOwnFineParticipations = new Set(reverted.participations.map((p) => p.entityId));

  const cleanedEntities: VTAEntity[] = [];
  const seenEntityIds = new Set<string>();
  for (const ent of reverted.entities) {
    const isEmptyParentOrSynthetic =
      (ent.id === parentEntityId || ent.id.startsWith('merged_entity_')) &&
      !splitSet.has(ent.id) &&
      !remainingTargets.has(ent.id) &&
      !hasOwnFineParticipations.has(ent.id);
    if (isEmptyParentOrSynthetic) {
      if (analysis.subjectRanking?.originalEntities.some((o) => o.id === ent.id)) {
        excludedIds.add(ent.id);
      }
      continue;
    }
    if (excludedIds.has(ent.id) && !remainingTargets.has(ent.id) && !hasOwnFineParticipations.has(ent.id)) {
      continue;
    }
    const copy: VTAEntity = { ...ent };
    delete copy.mergedFrom;
    cleanedEntities.push(copy);
    seenEntityIds.add(copy.id);
  }

  for (const tgtId of remainingTargets) {
    if (seenEntityIds.has(tgtId)) continue;
    const existingTgt = analysis.entities.find((e) => e.id === tgtId);
    if (existingTgt) {
      const copy: VTAEntity = { ...existingTgt };
      delete copy.mergedFrom;
      cleanedEntities.push(copy);
      seenEntityIds.add(copy.id);
    }
  }

  const freshRanking = rankSubjects({ ...reverted, entities: cleanedEntities }, subjectLimit);
  const originalEntities = analysis.subjectRanking?.originalEntities?.length
    ? analysis.subjectRanking.originalEntities
    : freshRanking.originalEntities;
  const freshRankById = new Map(freshRanking.ranks.map((r) => [r.entityId, r]));
  const emptyBreakdown = { A: 0, O: 0, F: 0, C: 0, T: 0 };
  const baseRanks: VTASubjectRankEntry[] = originalEntities.map((orig, idx) => {
    const fresh = freshRankById.get(orig.id);
    const prev = analysis.subjectRanking?.ranks.find((r) => r.entityId === orig.id);
    const score = fresh?.score ?? prev?.score ?? 0;
    const rank = fresh?.rank ?? prev?.rank ?? idx + 1;
    const breakdown = fresh?.breakdown ?? prev?.breakdown ?? emptyBreakdown;
    const priority = fresh?.priority ?? prev?.priority;
    if (excludedIds.has(orig.id) && !seenEntityIds.has(orig.id)) {
      return {
        entityId: orig.id,
        rank,
        score,
        breakdown,
        ...(priority ? { priority } : {}),
        retained: false,
        excluded: true,
        consolidationStage: 'stage2.5_b0_prune',
        reason: prev?.reason ?? `定常背景のためレーン除外（スコア ${score.toFixed(2)}）`,
      };
    }
    return {
      entityId: orig.id,
      rank,
      score,
      breakdown,
      ...(priority ? { priority } : {}),
      retained: true,
      reason: splitSet.has(orig.id)
        ? `手動分割により独立レーンとして展開（スコア ${score.toFixed(2)}）`
        : `上位保持（スコア ${score.toFixed(2)}）`,
    };
  });

  const baseRevertedAnalysis: VTAAnalysisData = {
    ...reverted,
    entities: cleanedEntities,
    subjectRanking: {
      version: 1,
      maxSubjects: subjectLimit,
      weights: analysis.subjectRanking?.weights ?? freshRanking.weights,
      originalEntities,
      ranks: baseRanks,
    },
    ...(analysis.laneConsolidation
      ? {
          laneConsolidation: {
            ...analysis.laneConsolidation,
            laneAssignment: Object.fromEntries(
              Object.entries(analysis.laneConsolidation.laneAssignment).map(([origId, assignedId]) => [
                origId,
                splitSet.has(origId) ? origId : assignedId,
              ])
            ),
          },
        }
      : {}),
  };

  if (currentMergeMap.size === 0) {
    const primarySource = baseRevertedAnalysis.sources[0] ?? { id: 'source_1', text: '', paragraphs: [] };
    const candidateGroups = baseRevertedAnalysis.cards
      .filter((c) => c.eventIds.length >= 2 && seenEntityIds.has(c.laneEntityId))
      .map((c) => ({ entityId: c.laneEntityId, eventIds: [...c.eventIds] }));
    const parsed = validateParticipants(
      {
        entities: cleanedEntities,
        participations: baseRevertedAnalysis.participations.filter((p) => seenEntityIds.has(p.entityId)),
        relations: baseRevertedAnalysis.relations,
        cardGroups: candidateGroups,
        subjectRanking: baseRevertedAnalysis.subjectRanking,
        subjectPoset: baseRevertedAnalysis.subjectPoset,
      },
      baseRevertedAnalysis.events,
      baseRevertedAnalysis.facts,
      true,
      undefined,
      baseRevertedAnalysis.sources
    );
    const built = buildAnalysis(primarySource, baseRevertedAnalysis.facts, baseRevertedAnalysis.events, parsed);
    return {
      ...baseRevertedAnalysis,
      entities: built.entities,
      participations: built.participations,
      relations: built.relations,
      cards: built.cards,
      unassignedEventIds: built.unassignedEventIds,
    };
  }

  const refolded = foldEntitiesIntoTargets(
    baseRevertedAnalysis,
    currentMergeMap,
    subjectLimit,
    undefined,
    onWarning
  );
  return refolded.analysis;
}

/**
 * Merges `sourceLane` into `targetLane` (existing or newly introduced) while preserving
 * lane priority rules (new "その他の関係者" lane at index 0) and shifting node X positions.
 */
export function applyForceMergeTransition(
  schema: VTASchema,
  sourceLane: string,
  targetLane: string,
  subjectLimit: number = 12,
  onWarn?: (message: string) => void
): { nextSchema: VTASchema; targetEntityId: string } | null {
  const sLane = sourceLane?.trim();
  const tLane = targetLane?.trim();
  if (!sLane || !tLane || sLane === tLane) return null;
  if (!schema.lanes.includes(sLane)) return null;

  const baseSchema = schema.analysis
    ? schema
    : projectAnalysis(createManualAnalysis(schema), schema);
  const analysis = baseSchema.analysis!;
  const baseEntities = [...analysis.entities];
  const sourceEntity = baseEntities.find((e) => e.name === sLane);

  let targetEntity = baseEntities.find((e) => e.name === tLane);
  if (!targetEntity) {
    const origMatch = analysis.subjectRanking?.originalEntities?.find((e) => e.name === tLane);
    if (origMatch) {
      targetEntity = { ...origMatch };
    } else if (isOtherActorsLaneName(tLane, baseEntities)) {
      const existingAgg = baseEntities.find((e) => e.aggregate || e.id === 'subject_others');
      targetEntity = existingAgg ?? {
        id: 'subject_others',
        name: tLane,
        kind: 'other',
        aggregate: true,
      };
    } else {
      const newId = `manual_entity_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      targetEntity = {
        id: newId,
        name: tLane,
        kind: sourceEntity?.kind ?? 'organization',
      };
    }
  }

  const sourceEntityIds: string[] = sourceEntity ? [sourceEntity.id] : [];
  const consolidated = mergeEntitiesLocally(
    analysis,
    sourceEntityIds,
    targetEntity,
    subjectLimit,
    onWarn
  );

  const preferredLanes = mergeLanesAfterConsolidation(
    schema.lanes,
    new Set([sLane]),
    tLane,
    consolidated.entities
  );

  let nextSchema = projectAnalysis(consolidated, baseSchema, { preferredLanes });
  if (nextSchema.nodes.some((n) => n.lane === sLane)) {
    const reassigned: VTASchema = {
      ...nextSchema,
      lanes: nextSchema.lanes.filter((l) => l !== sLane),
      nodes: nextSchema.nodes.map((n) => (n.lane === sLane ? { ...n, lane: tLane } : n)),
    };
    nextSchema = shiftSchemaPositionsForLaneChange(nextSchema, reassigned);
  }

  return { nextSchema, targetEntityId: targetEntity.id };
}

export type LaneRenameResult =
  | { status: 'ok'; nextSchema: VTASchema; entityId?: string; oldName: string; newName: string }
  | { status: 'noop'; nextSchema: VTASchema; oldName: string; newName: string }
  | { status: 'invalid' | 'duplicate'; message: string };

/**
 * Renames a subject / swimlane display name across `lanes`, `nodes`, `analysis.entities`,
 * `subjectRanking.originalEntities`, `fineGrainedBase.entities` (immutable copy), and cached
 * `laneConsolidation.candidates` (`targetLabel`), preserving entity IDs, Poset links,
 * participations, relations, and manual card coordinates.
 */
export function applyLaneRenameTransition(
  schema: VTASchema,
  oldLaneName: string,
  newLaneName: string
): LaneRenameResult {
  const rawOld = oldLaneName ?? '';
  const oldName = schema.lanes.includes(rawOld)
    ? rawOld
    : schema.analysis?.entities.some((e) => e.name === rawOld)
      ? rawOld
      : rawOld.trim();
  const newName = (newLaneName ?? '').trim();

  if (!oldName) {
    return { status: 'invalid', message: '変更元の主体名が指定されていません。' };
  }
  if (!newName) {
    return { status: 'invalid', message: '主体名を入力してください。' };
  }

  const existsInLanes = schema.lanes.includes(oldName);
  const existsInEntities = Boolean(schema.analysis?.entities.some((e) => e.name === oldName));
  if (!existsInLanes && !existsInEntities) {
    return { status: 'invalid', message: `対象の主体「${oldName}」が見つかりません。` };
  }

  if (newName === oldName) {
    return { status: 'noop', nextSchema: schema, oldName, newName };
  }

  const baseEntities = schema.analysis?.entities ?? [];
  if (
    !isOtherActorsLaneName(oldName, baseEntities) &&
    (newName === OTHER_ACTORS_ENTITY_NAME || /^その他の関係者\s*\(\d+\)$/.test(newName))
  ) {
    return {
      status: 'duplicate',
      message: '「その他の関係者」は周辺主体集約用の予約名称です。統合する場合は「統合」操作を使用してください。',
    };
  }

  const laneCollision = schema.lanes.some((l) => l !== oldName && l.trim() === newName);
  const entityCollision = baseEntities.some((e) => e.name !== oldName && e.name.trim() === newName);
  if (laneCollision || entityCollision) {
    return {
      status: 'duplicate',
      message: `主体名「${newName}」は既に存在します（統合する場合は「統合」操作を使用してください）。`,
    };
  }

  const baseAnalysis = schema.analysis ?? createManualAnalysis(schema);
  const targetEntity = baseAnalysis.entities.find((e) => e.name === oldName);
  const targetEntityId = targetEntity?.id;

  const nextEntities = baseAnalysis.entities.map((e) =>
    e.name === oldName ? { ...e, name: newName } : e
  );

  let nextSubjectRanking = baseAnalysis.subjectRanking;
  if (nextSubjectRanking && targetEntityId) {
    const origCollision = nextSubjectRanking.originalEntities.some(
      (oe) => oe.id !== targetEntityId && oe.name.trim() === newName
    );
    if (
      !origCollision &&
      nextSubjectRanking.originalEntities.some((oe) => oe.id === targetEntityId)
    ) {
      nextSubjectRanking = {
        ...nextSubjectRanking,
        originalEntities: nextSubjectRanking.originalEntities.map((oe) =>
          oe.id === targetEntityId ? { ...oe, name: newName } : oe
        ),
      };
    }
  }

  let nextFineGrainedBase = baseAnalysis.fineGrainedBase;
  if (nextFineGrainedBase && targetEntityId) {
    const fgCollision = nextFineGrainedBase.entities.some(
      (fe) => fe.id !== targetEntityId && fe.name.trim() === newName
    );
    if (
      !fgCollision &&
      nextFineGrainedBase.entities.some((fe) => fe.id === targetEntityId)
    ) {
      nextFineGrainedBase = {
        ...nextFineGrainedBase,
        entities: nextFineGrainedBase.entities.map((fe) =>
          fe.id === targetEntityId ? { ...fe, name: newName } : fe
        ),
      };
    }
  }

  let nextLaneConsolidation = baseAnalysis.laneConsolidation;
  if (nextLaneConsolidation) {
    let candidatesChanged = false;
    const updatedCandidates = nextLaneConsolidation.candidates.map((cand) => {
      const matchesVirtualLabel = !cand.targetEntityId && cand.targetLabel === oldName;
      const matchesTargetEntity =
        Boolean(targetEntityId) &&
        cand.targetEntityId === targetEntityId &&
        Boolean(cand.targetLabel);
      if (matchesVirtualLabel || matchesTargetEntity) {
        candidatesChanged = true;
        return { ...cand, targetLabel: newName };
      }
      return cand;
    });
    if (candidatesChanged) {
      nextLaneConsolidation = {
        ...nextLaneConsolidation,
        candidates: updatedCandidates,
      };
    }
  }

  const nextAnalysis: VTAAnalysisData = {
    ...baseAnalysis,
    entities: nextEntities,
    ...(nextSubjectRanking ? { subjectRanking: nextSubjectRanking } : {}),
    ...(nextFineGrainedBase ? { fineGrainedBase: nextFineGrainedBase } : {}),
    ...(nextLaneConsolidation ? { laneConsolidation: nextLaneConsolidation } : {}),
  };

  const nextSchema: VTASchema = {
    ...schema,
    lanes: schema.lanes.map((l) => (l === oldName ? newName : l)),
    nodes: schema.nodes.map((n) => (n.lane === oldName ? { ...n, lane: newName } : n)),
    analysis: nextAnalysis,
  };

  return {
    status: 'ok',
    nextSchema,
    entityId: targetEntityId,
    oldName,
    newName,
  };
}
