import type {
  VTAAnalysisData,
  VTAEntity,
  VTAEventRelation,
  VTAParticipation,
  VTASubjectRankEntry,
  VTASubjectRanking,
} from '../../../types/vta';
import { buildAnalysis, validateParticipants } from './eventAnalysis';
import { dependencyProblem, isPrecedence } from './eventOrder';
import { SubjectPoset } from './subjectPoset';

export const DEFAULT_MAX_SUBJECTS = 5;
export const MIN_MAX_SUBJECTS = 2;
export const MAX_MAX_SUBJECTS = 12;
export const OTHER_ACTORS_ENTITY_NAME = 'その他の関係者';

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
}

/**
 * ADR-0008: 主体間の帰結非対称性・直接介入・役割対立を検証し、親組織への統合をブロックするか判定する
 */
export function evaluateMergeGuard(
  sourceEntityId: string,
  targetEntityId: string,
  analysis: VTAAnalysisData
): MergeGuardResult {
  // 1. 2者間の直接介入・救援・物理影響エッジ（impact, transfer, dependency, mutual）のチェック
  const hasVariationOrRecoveryPair = (ent1: string, ent2: string) => {
    const ev1 = analysis.participations.filter((p) => p.entityId === ent1);
    const ev2 = analysis.participations.filter((p) => p.entityId === ent2);
    const eventById = new Map(analysis.events.map((e) => [e.id, e]));
    const isSpecial = (pList: typeof ev1) =>
      pList.some((p) => {
        const ev = eventById.get(p.eventId);
        return (
          ev?.classification === 'variation' ||
          Boolean(ev?.variationFactor) ||
          ev?.outcome_kind === 'recovery' ||
          ev?.preliminary?.value === 'variation'
        );
      });
    return isSpecial(ev1) || isSpecial(ev2);
  };

  for (const rel of analysis.relations) {
    if (rel.kind === 'before') continue;
    const src = rel.sourceEntityOrigin ?? rel.sourceEntityId;
    const tgt = rel.targetEntityOrigin ?? rel.targetEntityId;
    const isDirectRel =
      (src === sourceEntityId && tgt === targetEntityId) ||
      (src === targetEntityId && tgt === sourceEntityId);
    if (isDirectRel) {
      if (rel.kind === 'impact') {
        return { allowed: false, reason: '主体間に直接の物理影響・被災関係が存在するため独立維持' };
      }
      if (rel.kind === 'transfer' && (rel.resource === 'person' || hasVariationOrRecoveryPair(sourceEntityId, targetEntityId))) {
        return { allowed: false, reason: '主体間に救援・人員移動または異常対応移動が存在するため独立維持' };
      }
      if (rel.kind === 'dependency' && hasVariationOrRecoveryPair(sourceEntityId, targetEntityId)) {
        return { allowed: false, reason: '異常発生または回復抑止に関する直接の介入指示が存在するため独立維持' };
      }
    }
  }

  // 2. 変動要因（異常・被災） vs 回復行動（レジリエンス）の非対称性チェック
  const eventById = new Map(analysis.events.map((e) => [e.id, e]));
  const getEvent = (id: string) => eventById.get(id);

  const hasVariation = (entId: string) =>
    analysis.participations.some((p) => {
      if (p.entityId !== entId) return false;
      const ev = getEvent(p.eventId);
      return (
        ev?.classification === 'variation' ||
        Boolean(ev?.variationFactor) ||
        ev?.preliminary?.value === 'variation'
      );
    });

  const hasRecovery = (entId: string) =>
    analysis.participations.some((p) => {
      if (p.entityId !== entId) return false;
      const ev = getEvent(p.eventId);
      return (
        ev?.outcome_kind === 'recovery' ||
        (analysis.outcome?.kind === 'recovery' && analysis.outcome.eventIds.includes(p.eventId))
      );
    });

  const srcVar = hasVariation(sourceEntityId);
  const tgtVar = hasVariation(targetEntityId);
  const srcRec = hasRecovery(sourceEntityId);
  const tgtRec = hasRecovery(targetEntityId);

  if ((srcVar && tgtRec) || (tgtVar && srcRec)) {
    return { allowed: false, reason: '異常発生側と回復・抑止側の役割が非対称であるため独立維持' };
  }

  // 3. 帰結到達の非対称性（異なる outcome_kind を持つか）
  const getOutcomeKinds = (entId: string): Set<string> => {
    const kinds = new Set<string>();
    for (const p of analysis.participations) {
      if (p.entityId !== entId) continue;
      const ev = getEvent(p.eventId);
      if (ev?.outcome_kind) kinds.add(ev.outcome_kind);
      if (analysis.outcome?.status === 'identified' && analysis.outcome.eventIds.includes(p.eventId)) {
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
      return { allowed: false, reason: '到達する帰結の種別（損失と回復等）が異なるため独立維持' };
    }
  }

  return { allowed: true };
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
  const hasVariation = parts.some((p) => {
    const ev = eventById.get(p.eventId);
    if (!ev) return false;
    return (
      ev.classification === 'variation' ||
      Boolean(ev.variationFactor) ||
      ev.preliminary?.value === 'variation'
    );
  });
  if (hasVariation) {
    return { influential: true, reason: '変動要因または変動候補を保有' };
  }

  // 4. 不作為・防壁機能不全（Omission: 見落とし・不実施・未検知・失念等）の保有
  // 注: machine 種別の場合は支援機能の未検知・不作動を理由に人間や組織より優先昇格させない
  if (entity.kind !== 'machine') {
    const omissionPattern = /(見落とし|見逃し|未検知|不実施|失念|怠り|確認せず|気付かず|対応せず|放置)/;
    const hasOmission = parts.some((p) => {
      const ev = eventById.get(p.eventId);
      if (!ev) return false;
      return omissionPattern.test(ev.title) || omissionPattern.test(ev.description);
    });
    if (hasOmission) {
      return { influential: true, reason: '不作為（見落とし・未検知等）の防壁機能不全を保有' };
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

function resolveParentTarget(
  entityId: string,
  retainedIds: Set<string>,
  entityById: Map<string, VTAEntity>,
  analysis?: VTAAnalysisData
): { targetId?: string; blockedReason?: string } {
  const poset = analysis?.subjectPoset
    ? SubjectPoset.fromData(analysis.subjectPoset)
    : SubjectPoset.fromEntities(Array.from(entityById.values()));

  const ancestors = poset.getAncestors(entityId);
  const immediateParents = poset.getImmediateParents(entityId);

  // 1. 直接の親で保持されているものを優先探索
  for (const parentId of immediateParents) {
    if (retainedIds.has(parentId)) {
      if (analysis) {
        const guard = evaluateMergeGuard(entityId, parentId, analysis);
        if (!guard.allowed) {
          return { blockedReason: guard.reason };
        }
      }
      return { targetId: parentId };
    }
  }

  // 2. より上位の祖先で保持されているものを探索
  for (const ancestorId of ancestors) {
    if (retainedIds.has(ancestorId)) {
      if (analysis) {
        const guard = evaluateMergeGuard(entityId, ancestorId, analysis);
        if (!guard.allowed) {
          return { blockedReason: guard.reason };
        }
      }
      return { targetId: ancestorId };
    }
  }

  // 3. ADR-0008: 親組織自体がレーン化されていない場合でも、同親を持つ兄弟主体がレーン保持されている場合は
  // 兄弟間の帰結非対称性・介入を検証し、非対称であれば独立レーンとして死守する
  if (analysis) {
    for (const parentId of immediateParents) {
      for (const retainedId of retainedIds) {
        const retainedEntity = entityById.get(retainedId);
        if (retainedEntity && poset.isAncestor(parentId, retainedId) && retainedId !== entityId) {
          const guard = evaluateMergeGuard(entityId, retainedId, analysis);
          if (!guard.allowed) {
            return { blockedReason: guard.reason };
          }
        }
      }
    }
  }

  return {};
}

function roundScore(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export interface SubjectRankingOptions {
  forceRetain?: ReadonlySet<string>;
  explicitMerges?: ReadonlyMap<string, string>;
  excludeNonInfluential?: boolean;
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

    const penalizedMachine = entity.kind === 'machine' && (actorCounts.get(entity.id) ?? 0) <= 1;
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

  // ADR-0008: 各主体のインシデント因果影響度（変動要因・帰結・防壁不作為・因果相互作用）を判定
  const influenceMap = new Map<string, { influential: boolean; reason?: string }>();
  for (const entity of baseEntities) {
    influenceMap.set(entity.id, isInfluentialSubject(entity, analysis));
  }

  candidates.sort((left, right) => {
    const fLeft = forceRetain?.has(left.entity.id) ? 1 : 0;
    const fRight = forceRetain?.has(right.entity.id) ? 1 : 0;
    if (fRight !== fLeft) return fRight - fLeft;

    // 影響主体を最優先（非影響・背景主体は下位へ）
    const infLeft = influenceMap.get(left.entity.id)?.influential ? 1 : 0;
    const infRight = influenceMap.get(right.entity.id)?.influential ? 1 : 0;
    if (infRight !== infLeft) return infRight - infLeft;

    const pDiff = priorityRank(right.priority) - priorityRank(left.priority);
    if (pDiff !== 0) return pDiff;

    // VTA種別優先度: 人間(person)・組織(organization)を機器(machine)より上位レーンに優先選出する
    // （VTAはヒューマンファクタ・組織分析を主眼とするため、支援機能等の機器が人間レーンを奪うことを防止）
    const kindWeight = (k: VTAEntity['kind']) =>
      k === 'organization' || k === 'person' ? 2 : k === 'other' ? 1 : 0;
    const kDiff = kindWeight(right.entity.kind) - kindWeight(left.entity.kind);
    if (kDiff !== 0) return kDiff;

    if (Math.abs(right.score - left.score) > 1e-9) return right.score - left.score;
    if (left.firstOrder !== right.firstOrder) return left.firstOrder - right.firstOrder;
    return left.originalIndex - right.originalIndex;
  });

  // Determine retention and merge targets
  const entityById = new Map(baseEntities.map((e) => [e.id, e]));
  const retainedIds = new Set<string>();
  const mergeTargetById = new Map<string, string>();
  const mergeBlockedReasonById = new Map<string, string>();
  const excludedIds = new Set<string>();
  const forcedCount = forceRetain ? candidates.filter((c) => forceRetain.has(c.entity.id)).length : 0;
  const effectiveLimit = Math.max(limit, forcedCount);

  if (candidates.length <= effectiveLimit) {
    for (const c of candidates) retainedIds.add(c.entity.id);
  } else {
    const topNIds = new Set(candidates.slice(0, effectiveLimit).map((c) => c.entity.id));
    const overflow = candidates.slice(effectiveLimit);

    // あふれた主体について、親組織への統合を検証（Merge Guard を適用）
    const mergeResolutions = overflow.map((c) => ({
      candidate: c,
      res: resolveParentTarget(c.entity.id, topNIds, entityById, analysis),
    }));

    const allOverflowHaveRetainedParent = mergeResolutions.every((item) => item.res.targetId !== undefined);

    if (allOverflowHaveRetainedParent) {
      for (const id of topNIds) retainedIds.add(id);
      for (const item of mergeResolutions) {
        mergeTargetById.set(item.candidate.entity.id, item.res.targetId!);
      }
    } else {
      const keepCount = Math.max(1, forcedCount, effectiveLimit - 1);
      for (const c of candidates.slice(0, keepCount)) {
        retainedIds.add(c.entity.id);
      }
      const othersId = getAggregateEntityId(baseEntities);
      for (const c of candidates.slice(keepCount)) {
        const parentRes = resolveParentTarget(c.entity.id, retainedIds, entityById, analysis);
        if (parentRes.targetId) {
          mergeTargetById.set(c.entity.id, parentRes.targetId);
        } else if (parentRes.blockedReason) {
          // ADR-0008: 帰結非対称性・介入により統合ブロックされた場合は独立レーンとして死守
          retainedIds.add(c.entity.id);
          mergeBlockedReasonById.set(c.entity.id, parentRes.blockedReason);
        } else {
          // 親組織がない場合
          const isInf = influenceMap.get(c.entity.id)?.influential ?? true;
          if (options?.excludeNonInfluential && !isInf) {
            // オプション指定時または明示的な非影響背景の場合はレーン除外
            excludedIds.add(c.entity.id);
          } else {
            mergeTargetById.set(c.entity.id, othersId);
          }
        }
      }
    }
  }

  if (options?.explicitMerges) {
    for (const [sourceId, targetId] of options.explicitMerges) {
      retainedIds.delete(sourceId);
      retainedIds.add(targetId);
      mergeTargetById.set(sourceId, targetId);
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
      reasonParts.push(`上位保持（スコア ${c.score.toFixed(2)}）`);
    } else {
      const targetName =
        mergedInto && entityById.has(mergedInto)
          ? entityById.get(mergedInto)!.name
          : 'その他の関係者';
      reasonParts.push(`上限超過のため「${targetName}」へ統合（スコア ${c.score.toFixed(2)}）`);
    }
    return {
      entityId: c.entity.id,
      rank: index + 1,
      score: c.score,
      breakdown: c.breakdown,
      ...(c.priority ? { priority: c.priority } : {}),
      retained,
      ...(mergedInto ? { mergedInto } : {}),
      ...(isExcluded ? { excluded: true } : {}),
      ...(blockedReason ? { mergeBlockedReason: blockedReason } : {}),
      isInfluential: isInf,
      reason: reasonParts.join('／'),
    };
  });

  return {
    version: 1,
    maxSubjects: limit,
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

export function consolidateSubjects(
  analysis: VTAAnalysisData,
  maxSubjects: number = DEFAULT_MAX_SUBJECTS,
  weights: Record<'A' | 'O' | 'F' | 'C' | 'T', number> = DEFAULT_SUBJECT_RANKING_WEIGHTS,
  onWarning?: (message: string) => void,
  options?: SubjectRankingOptions
): VTAAnalysisData {
  const base = analysis.subjectRanking ? revertConsolidation(analysis) : structuredClone(analysis);
  const limit = Math.max(1, Math.round(Number.isFinite(maxSubjects) ? maxSubjects : DEFAULT_MAX_SUBJECTS));
  const ranking = rankSubjects(base, limit, weights, options);

  const hasExplicitMerges = Boolean(options?.explicitMerges && options.explicitMerges.size > 0);
  const excludedSet = new Set(ranking.ranks.filter((r) => r.excluded).map((r) => r.entityId));
  const hasExclusions = excludedSet.size > 0;

  if (base.entities.length <= limit && !hasExplicitMerges && !hasExclusions) {
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

  const consolidatedEntities: VTAEntity[] = base.entities
    .filter((e) => retainedSet.has(e.id))
    .map((e) => {
      const copy: VTAEntity = { ...e };
      if (copy.parentEntityId && !retainedSet.has(copy.parentEntityId)) {
        const mappedParent = mergeMap.get(copy.parentEntityId);
        if (mappedParent && mappedParent !== copy.id && retainedSet.has(mappedParent)) {
          copy.parentEntityId = mappedParent;
        } else {
          delete copy.parentEntityId;
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
      const factIds = [...new Set(parts.flatMap((p) => p.factIds))];
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
      console.log('CASE 1 UNASSIGNED WARNING:', warning);
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
    console.log('CASE 1 CATCH ERROR:', warning);
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
