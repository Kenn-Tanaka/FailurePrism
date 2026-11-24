import type { VTAEvent, VTAEventRelation, VTASchema } from '../../../types/vta';
import { isOtherActorsLaneName } from './laneOrder';
import { visibleSchema } from './presentation';
import {
  createAnalysisPoset,
  resolveCardsForRelationEndpoint,
  type SubjectPoset,
} from './subjectPoset';

/**
 * Determines whether a relation in `analysis.relations` is intentionally unprojected
 * onto `schema.edges` (e.g., `before` ordering relations, manually omitted edges,
 * relations referencing ignored/missing events, or intra-card relations collapsed
 * by subject consolidation or card grouping).
 */
export function isIntentionallyUnprojectedRelation(
  schema: VTASchema,
  r: VTAEventRelation,
  options?: {
    eventById?: ReadonlyMap<string, VTAEvent>;
    omittedEdges?: ReadonlySet<string>;
    poset?: SubjectPoset;
  }
): boolean {
  if (r.kind === 'before') return true;
  const analysis = schema.analysis;
  if (!analysis) return false;
  const omittedEdges = options?.omittedEdges ?? new Set(schema.presentation?.omittedEdges ?? []);
  if (r.id && omittedEdges.has(`relation:${r.id}`)) return true;

  const eventById = options?.eventById ?? new Map(analysis.events.map((e) => [e.id, e]));
  const sourceEv = eventById.get(r.sourceEventId);
  const targetEv = eventById.get(r.targetEventId);
  if (!sourceEv || !targetEv || sourceEv.ignored || targetEv.ignored) return true;

  if (r.sourceEventId === r.targetEventId && r.sourceEntityId && r.sourceEntityId === r.targetEntityId) {
    return true;
  }

  const poset = options?.poset ?? createAnalysisPoset(analysis.entities, analysis.subjectPoset);
  const sourceCandidates = resolveCardsForRelationEndpoint(
    analysis.cards,
    analysis.participations,
    poset,
    r.sourceEventId,
    r.sourceEntityId,
    r.sourceEntityOrigin,
    'source'
  );
  const targetCandidates = resolveCardsForRelationEndpoint(
    analysis.cards,
    analysis.participations,
    poset,
    r.targetEventId,
    r.targetEntityId,
    r.targetEntityOrigin,
    'target'
  );
  const source = r.sourceEntityId
    ? sourceCandidates[0]
    : sourceCandidates.length === 1
      ? sourceCandidates[0]
      : undefined;
  const target = r.targetEntityId
    ? targetCandidates[0]
    : targetCandidates.length === 1
      ? targetCandidates[0]
      : undefined;
  if (!source || !target) return false;
  if (source.id === target.id) return true;
  // ADR-0079 / ADR-0081: Cross-entity relations folded into the same sequential lane,
  // plus same-origin non-dependency relations made non-adjacent on a consolidated lane,
  // are visually represented by that lane's vertical sequential spine rather than a redundant bowing arc.
  if (source.laneEntityId === target.laneEntityId && r.status !== 'omitted') {
    const laneEnt = analysis.entities.find((e) => e.id === source.laneEntityId);
    if (laneEnt && !isOtherActorsLaneName(laneEnt.name, analysis.entities)) {
      const origSrc = r.sourceEntityOrigin ?? r.sourceEntityId;
      const origTgt = r.targetEntityOrigin ?? r.targetEntityId;
      if (origSrc && origTgt && origSrc !== origTgt) {
        return true;
      }
      const isConsolidatedLane = Boolean(
        laneEnt.mergedFrom?.length || r.sourceEntityOrigin || r.targetEntityOrigin
      );
      if (isConsolidatedLane && r.kind !== 'dependency') {
        const srcNode = schema.nodes.find((n) => n.id === source.id);
        const tgtNode = schema.nodes.find((n) => n.id === target.id);
        if (
          srcNode &&
          tgtNode &&
          typeof srcNode.sequence_order === 'number' &&
          typeof tgtNode.sequence_order === 'number' &&
          Math.abs(tgtNode.sequence_order - srcNode.sequence_order) > 1
        ) {
          return true;
        }
      }
    }
  }
  return false;
}

export function graphDiagnostics(schema: VTASchema) {
  const components = (s: VTASchema) => {
    const adj = new Map(s.nodes.map((n) => [n.id, new Set<string>()]));
    for (const e of s.edges) {
      if (adj.has(e.source) && adj.has(e.target)) {
        adj.get(e.source)!.add(e.target);
        adj.get(e.target)!.add(e.source);
      }
    }
    const seen = new Set<string>(),
      groups: string[][] = [];
    for (const id of adj.keys()) {
      if (!seen.has(id)) {
        const group: string[] = [],
          q = [id];
        while (q.length) {
          const n = q.pop()!;
          if (seen.has(n)) continue;
          seen.add(n);
          group.push(n);
          q.push(...adj.get(n)!);
        }
        groups.push(group);
      }
    }
    return groups;
  };
  const effective = (s: VTASchema): VTASchema =>
    !schema.analysis
      ? s
      : {
          ...s,
          edges: s.edges.filter((e) => {
            const from = s.nodes.find((n) => n.id === e.source),
              to = s.nodes.find((n) => n.id === e.target);
            if (!from || !to) return false;
            if (from.lane === to.lane) return true;
            if (e.meaning === 'association') {
              return !!e.eventId && !!from.event_ids?.includes(e.eventId) && !!to.event_ids?.includes(e.eventId);
            }
            return !!e.meaning && ['transfer', 'impact', 'dependency', 'mutual', 'common'].includes(e.meaning);
          }),
        };
  const vis = visibleSchema(schema);
  const canonical = components(effective(schema)),
    display = components(effective(vis));
  const analysis = schema.analysis;
  const target = analysis?.context?.selectedTargetEventIds ?? [];
  const eventById = analysis ? new Map(analysis.events.map((e) => [e.id, e])) : undefined;
  const omittedEdges = new Set(schema.presentation?.omittedEdges ?? []);
  const poset = analysis ? createAnalysisPoset(analysis.entities, analysis.subjectPoset) : undefined;
  const projectedRelationIds = new Set(
    schema.edges.flatMap((e) => [
      ...(e.relationId ? [e.relationId] : []),
      ...(e.bundledRelationIds ?? []),
    ])
  );
  const missingRelations =
    analysis?.relations
      .filter(
        (r) =>
          !isIntentionallyUnprojectedRelation(schema, r, { eventById, omittedEdges, poset }) &&
          !(r.id && projectedRelationIds.has(r.id))
      )
      .map((r) => r.id) ?? [];
  const outcome = analysis?.outcome;
  const outcomeUnchecked = outcome?.status !== 'identified';
  const unassigned = (analysis?.unassignedEventIds ?? []).filter(
    (id) => !eventById?.get(id)?.ignored
  );
  const provisional = analysis?.entities.filter((e) => e.resolution === 'unresolved').map((e) => e.id) ?? [];
  const unshownOutcomes =
    outcome?.eventIds.filter((id) => !vis.nodes.some((n) => n.event_ids?.includes(id))) ?? [];
  return {
    canonical,
    display,
    outcomeUnchecked,
    targetUnset: !target.length,
    missingRelations,
    unassigned,
    provisional,
    unshownOutcomes,
    complete:
      !outcomeUnchecked &&
      !!schema.nodes.length &&
      canonical.length === 1 &&
      display.length === 1 &&
      !!target.length &&
      !missingRelations.length &&
      !unassigned.length &&
      !provisional.length &&
      !unshownOutcomes.length,
  };
}
