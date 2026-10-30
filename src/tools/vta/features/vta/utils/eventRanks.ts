import { eventOrder } from './eventOrder';
import type { VTASchema } from '../../../types/vta';

/** Event identity is global; a lane-local sequence number is not a timestamp. */
export function computeEventRanks(schema: VTASchema): Map<string, number> {
  const analysis = schema.analysis!;
  const root = eventOrder(analysis).root;
  const groups = new Map<string, number>();
  analysis.events.forEach((event, index) => {
    const id = root(event.id);
    const order = Number.isFinite(event.sourceOrder) ? event.sourceOrder : index;
    groups.set(id, Math.min(groups.get(id) ?? Infinity, order));
  });
  const successors = new Map<string, Set<string>>();
  const add = (from: string, to: string) => {
    if (!groups.has(from) || !groups.has(to) || from === to) return;
    const pending = [to]; const seen = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      if (current === from) return; // Keep an impossible/cyclic line drawable without distorting all ranks.
      if (seen.has(current)) continue;
      seen.add(current); pending.push(...(successors.get(current) ?? []));
    }
    const next = successors.get(from) ?? new Set<string>(); next.add(to); successors.set(from, next);
  };
  // Semantic precedence wins over drawing order. Same-event lane-to-lane lines add no time step.
  for (const kind of ['before', 'dependency', 'impact', 'transfer']) for (const relation of analysis.relations.filter((item) => item.kind === kind && (kind === 'before' || kind === 'dependency' || (item.status !== 'omitted' && item.status !== 'unknown')))) {
    add(root(relation.sourceEventId), root(relation.targetEventId));
  }
  const nodeGroup = new Map(schema.nodes.map((node) => [node.id, root(node.event_ids?.[0] ?? analysis.cards.find((card) => card.id === node.id)?.eventIds[0] ?? node.id)]));
  for (const edge of schema.edges) {
    if (edge.direction === 'bidirectional' || edge.direction === 'undirected' || edge.eventId) continue;
    add(nodeGroup.get(edge.source) ?? '', nodeGroup.get(edge.target) ?? '');
  }
  const indegree = new Map([...groups.keys()].map((id) => [id, 0]));
  for (const next of successors.values()) for (const id of next) indegree.set(id, indegree.get(id)! + 1);
  const compare = (a: string, b: string) => groups.get(a)! - groups.get(b)! || a.localeCompare(b);
  const ready = [...groups.keys()].filter((id) => !indegree.get(id)).sort(compare);
  const ranks = new Map<string, number>();
  while (ready.length) {
    const id = ready.shift()!; ranks.set(id, ranks.size);
    for (const next of successors.get(id) ?? []) {
      indegree.set(next, indegree.get(next)! - 1);
      if (!indegree.get(next)) { ready.push(next); ready.sort(compare); }
    }
  }
  const visibleRanks = [...new Set([...nodeGroup.values()].map((id) => ranks.get(id)).filter((rank): rank is number => rank !== undefined))].sort((a, b) => a - b);
  return new Map(schema.nodes.map((node, index) => [node.id, visibleRanks.indexOf(ranks.get(nodeGroup.get(node.id)!) ?? -1) >= 0
    ? visibleRanks.indexOf(ranks.get(nodeGroup.get(node.id)!)!) : visibleRanks.length + index]));
}
