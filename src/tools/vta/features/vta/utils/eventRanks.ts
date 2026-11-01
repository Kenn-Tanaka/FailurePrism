import { eventOrder } from './eventOrder';
import type { VTASchema } from '../../../types/vta';
import { parseTimeScore } from './layout';

/**
 * Event identity is global; computes time-aligned ranks across lanes as a Poset (Partially Ordered Set).
 * Incomparable events without temporal/causal precedence share the same rank (horizontal alignment).
 */
export function computeEventRanks(schema: VTASchema): Map<string, number> {
  const analysis = schema.analysis!;
  const root = eventOrder(analysis).root;
  const groups = new Map<string, number>();
  const groupTimeScores = new Map<string, number | null>();

  analysis.events.forEach((event, index) => {
    const id = root(event.id);
    const order = Number.isFinite(event.sourceOrder) ? event.sourceOrder : index;
    groups.set(id, Math.min(groups.get(id) ?? Infinity, order));

    const score = parseTimeScore(event.time);
    if (score !== null) {
      const prev = groupTimeScores.get(id);
      groupTimeScores.set(id, prev !== undefined && prev !== null ? Math.min(prev, score) : score);
    } else if (!groupTimeScores.has(id)) {
      groupTimeScores.set(id, null);
    }
  });

  const successors = new Map<string, Set<string>>();
  const add = (from: string, to: string) => {
    if (!groups.has(from) || !groups.has(to) || from === to) return;
    const pending = [to];
    const seen = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      if (current === from) return; // Keep an impossible/cyclic line drawable without distorting all ranks.
      if (seen.has(current)) continue;
      seen.add(current);
      pending.push(...(successors.get(current) ?? []));
    }
    const next = successors.get(from) ?? new Set<string>();
    next.add(to);
    successors.set(from, next);
  };

  // 1. Semantic precedence wins over drawing order. Same-event lane-to-lane lines add no time step.
  for (const kind of ['before', 'dependency', 'impact', 'transfer']) {
    for (const relation of analysis.relations.filter(
      (item) =>
        item.kind === kind &&
        (kind === 'before' || kind === 'dependency' || (item.status !== 'omitted' && item.status !== 'unknown'))
    )) {
      add(root(relation.sourceEventId), root(relation.targetEventId));
    }
  }

  // 2. Explicit canvas edges (intra-lane sequence edges, cross-lane relations, etc.)
  const nodeGroup = new Map(
    schema.nodes.map((node) => [
      node.id,
      root(node.event_ids?.[0] ?? analysis.cards.find((card) => card.id === node.id)?.eventIds[0] ?? node.id),
    ])
  );
  for (const edge of schema.edges) {
    if (edge.direction === 'bidirectional' || edge.direction === 'undirected' || edge.eventId) continue;
    add(nodeGroup.get(edge.source) ?? '', nodeGroup.get(edge.target) ?? '');
  }

  // 3. Intra-lane chronological ordering based on event order
  // Events within the same lane naturally proceed chronologically from earlier to later
  const laneEventsMap = new Map<string, string[]>();
  for (const card of analysis.cards) {
    const list = laneEventsMap.get(card.laneEntityId) ?? [];
    for (const evId of card.eventIds) {
      const gid = root(evId);
      if (groups.has(gid) && !list.includes(gid)) list.push(gid);
    }
    laneEventsMap.set(card.laneEntityId, list);
  }
  for (const part of analysis.participations) {
    const list = laneEventsMap.get(part.entityId) ?? [];
    const gid = root(part.eventId);
    if (groups.has(gid) && !list.includes(gid)) list.push(gid);
    laneEventsMap.set(part.entityId, list);
  }
  for (const node of schema.nodes) {
    const lane = node.lane || '';
    const entity = analysis.entities.find((e) => e.name === lane);
    if (entity) {
      const list = laneEventsMap.get(entity.id) ?? [];
      const gid = nodeGroup.get(node.id);
      if (gid && groups.has(gid) && !list.includes(gid)) list.push(gid);
      laneEventsMap.set(entity.id, list);
    }
  }

  for (const eventIds of laneEventsMap.values()) {
    const sorted = [...eventIds].sort((a, b) => (groups.get(a) ?? 0) - (groups.get(b) ?? 0));
    for (let i = 0; i < sorted.length - 1; i++) {
      if ((groups.get(sorted[i]) ?? 0) < (groups.get(sorted[i + 1]) ?? 0)) {
        add(sorted[i], sorted[i + 1]);
      }
    }
  }

  // 4. Poset: Explicit timestamp chronological ordering (only when distinct clock timestamps exist and acyclic)
  const groupIds = [...groups.keys()];
  for (let i = 0; i < groupIds.length; i++) {
    for (let j = 0; j < groupIds.length; j++) {
      if (i === j) continue;
      const t1 = groupTimeScores.get(groupIds[i]);
      const t2 = groupTimeScores.get(groupIds[j]);
      if (t1 !== null && t1 !== undefined && t2 !== null && t2 !== undefined && t1 < t2) {
        add(groupIds[i], groupIds[j]);
      }
    }
  }

  // 5. Compute In-degree for topological traversal
  const indegree = new Map([...groups.keys()].map((id) => [id, 0]));
  for (const next of successors.values()) {
    for (const id of next) {
      indegree.set(id, (indegree.get(id) ?? 0) + 1);
    }
  }

  const compare = (a: string, b: string) => groups.get(a)! - groups.get(b)! || a.localeCompare(b);
  const ready = [...groups.keys()].filter((id) => !indegree.get(id)).sort(compare);

  // 6. Poset Longest-Path Leveling (Incomparable parallel events share the same rank)
  const ranks = new Map<string, number>();
  for (const id of groups.keys()) {
    ranks.set(id, 0);
  }

  while (ready.length) {
    const id = ready.shift()!;
    const currentRank = ranks.get(id) ?? 0;
    for (const next of successors.get(id) ?? []) {
      const candidateRank = currentRank + 1;
      if (candidateRank > (ranks.get(next) ?? 0)) {
        ranks.set(next, candidateRank);
      }
      indegree.set(next, indegree.get(next)! - 1);
      if (!indegree.get(next)) {
        ready.push(next);
        ready.sort(compare);
      }
    }
  }

  const visibleRanks = [
    ...new Set(
      [...nodeGroup.values()]
        .map((id) => ranks.get(id))
        .filter((rank): rank is number => rank !== undefined)
    ),
  ].sort((a, b) => a - b);

  return new Map(
    schema.nodes.map((node, index) => {
      const grp = nodeGroup.get(node.id)!;
      const r = ranks.get(grp);
      const idx = r !== undefined ? visibleRanks.indexOf(r) : -1;
      return [node.id, idx >= 0 ? idx : visibleRanks.length + index];
    })
  );
}
