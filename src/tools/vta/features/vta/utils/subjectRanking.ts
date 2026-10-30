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

function resolveParentTarget(
  entityId: string,
  retainedIds: Set<string>,
  entityById: Map<string, VTAEntity>
): string | undefined {
  const visited = new Set<string>([entityId]);
  let cur = entityById.get(entityId);
  while (cur?.parentEntityId) {
    const parentId = cur.parentEntityId;
    if (visited.has(parentId)) return undefined;
    visited.add(parentId);
    if (retainedIds.has(parentId)) return parentId;
    cur = entityById.get(parentId);
  }
  return undefined;
}

function roundScore(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function rankSubjects(
  analysis: VTAAnalysisData,
  maxSubjects: number = DEFAULT_MAX_SUBJECTS,
  weights: Record<'A' | 'O' | 'F' | 'C' | 'T', number> = DEFAULT_SUBJECT_RANKING_WEIGHTS
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

  candidates.sort((left, right) => {
    const pDiff = priorityRank(right.priority) - priorityRank(left.priority);
    if (pDiff !== 0) return pDiff;
    if (Math.abs(right.score - left.score) > 1e-9) return right.score - left.score;
    if (left.firstOrder !== right.firstOrder) return left.firstOrder - right.firstOrder;
    return left.originalIndex - right.originalIndex;
  });

  // Determine retention and merge targets
  const entityById = new Map(baseEntities.map((e) => [e.id, e]));
  const retainedIds = new Set<string>();
  const mergeTargetById = new Map<string, string>();

  if (candidates.length <= limit) {
    for (const c of candidates) retainedIds.add(c.entity.id);
  } else {
    const topNIds = new Set(candidates.slice(0, limit).map((c) => c.entity.id));
    const overflow = candidates.slice(limit);
    const allOverflowHaveRetainedParent = overflow.every(
      (c) => resolveParentTarget(c.entity.id, topNIds, entityById) !== undefined
    );

    if (allOverflowHaveRetainedParent) {
      for (const id of topNIds) retainedIds.add(id);
      for (const c of overflow) {
        const target = resolveParentTarget(c.entity.id, retainedIds, entityById)!;
        mergeTargetById.set(c.entity.id, target);
      }
    } else {
      const keepCount = Math.max(1, limit - 1);
      for (const c of candidates.slice(0, keepCount)) {
        retainedIds.add(c.entity.id);
      }
      const othersId = getAggregateEntityId(baseEntities);
      for (const c of candidates.slice(keepCount)) {
        const parentTarget = resolveParentTarget(c.entity.id, retainedIds, entityById);
        mergeTargetById.set(c.entity.id, parentTarget ?? othersId);
      }
    }
  }

  const ranks: VTASubjectRankEntry[] = candidates.map((c, index) => {
    const retained = retainedIds.has(c.entity.id);
    const mergedInto = retained ? undefined : mergeTargetById.get(c.entity.id);
    const reasonParts: string[] = [];
    if (c.priority === 'reporter') reasonParts.push('優先保持：報告者本人');
    else if (c.priority === 'outcome-actor') reasonParts.push('優先保持：帰結イベントの行為主体');
    if (c.penalizedMachine) reasonParts.push('自律動作1件以下の機器減点');
    if (retained) {
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
  onWarning?: (message: string) => void
): VTAAnalysisData {
  const base = analysis.subjectRanking ? revertConsolidation(analysis) : structuredClone(analysis);
  const limit = Math.max(1, Math.round(Number.isFinite(maxSubjects) ? maxSubjects : DEFAULT_MAX_SUBJECTS));
  const ranking = rankSubjects(base, limit, weights);

  if (base.entities.length <= limit) {
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
      return copy;
    });

  if (needsOthers) {
    consolidatedEntities.push({
      id: othersId,
      name: getAggregateEntityName(base.entities),
      kind: 'other',
      aggregate: true,
    });
  }

  // Reassign participations per event
  const consolidatedParticipations: VTAParticipation[] = [];
  for (const event of base.events) {
    const eventParts = base.participations.filter((p) => p.eventId === event.id);
    const byTarget = new Map<string, VTAParticipation[]>();
    for (const part of eventParts) {
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
  const consolidatedRelations: VTAEventRelation[] = base.relations.map((rel) => {
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

    // Invariant check: unassigned events must never increase compared to pre-consolidation
    if (built.unassignedEventIds.length > base.unassignedEventIds.length) {
      const warning = `主体の統合により未割当イベントが増加するため（${base.unassignedEventIds.length}件 → ${built.unassignedEventIds.length}件）、統合を中止し細粒度主体を保持しました。`;
      if (onWarning) onWarning(warning);
      return {
        ...base,
        subjectRanking: {
          ...ranking,
          warning,
        },
      };
    }

    return {
      ...base,
      entities: built.entities,
      participations: built.participations,
      relations: validRelations,
      cards: built.cards,
      unassignedEventIds: built.unassignedEventIds,
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

  // Restore relation endpoints from *EntityOrigin
  const restoredRelations: VTAEventRelation[] = [];
  for (const rel of analysis.relations) {
    const srcId = rel.sourceEntityOrigin ?? rel.sourceEntityId;
    const tgtId = rel.targetEntityOrigin ?? rel.targetEntityId;
    if (
      srcId &&
      (!restoredIds.has(srcId) ||
        !restoredParticipations.some((p) => p.eventId === rel.sourceEventId && p.entityId === srcId))
    ) {
      continue;
    }
    if (
      tgtId &&
      (!restoredIds.has(tgtId) ||
        !restoredParticipations.some((p) => p.eventId === rel.targetEventId && p.entityId === tgtId))
    ) {
      continue;
    }
    const copy: VTAEventRelation = {
      ...rel,
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
