import type { VTASchema } from '../../../types/vta';
import { createManualAnalysis } from './eventAnalysis';
import { ensureEventTimeDAG, EventTimeDAG } from './eventTimePoset';

/**
 * Event identity is global; computes time-aligned row indices across lanes
 * from the skew-symmetric EventTimeDAG (0 <= timeNodeId < 400).
 * Events whose relative temporal order cannot be determined share the same row.
 */
export function computeEventRanks(schema: VTASchema): Map<string, number> {
  if (schema.nodes.length === 0) return new Map();
  const analysis = schema.analysis?.events.length
    ? schema.analysis
    : createManualAnalysis(schema);

  const baseDag = ensureEventTimeDAG(analysis);
  const dag = baseDag.clone();
  const eventById = new Map(analysis.events.map((e) => [e.id, e]));

  const nodeTimeNodeIds = new Map<string, number[]>();
  for (const node of schema.nodes) {
    const evIds =
      node.event_ids?.length
        ? node.event_ids
        : (analysis.cards.find((card) => card.id === node.id)?.eventIds ?? []);
    const tIds = evIds
      .map((id) => eventById.get(id)?.timeNodeId)
      .filter((u): u is number => typeof u === 'number' && u >= 0 && u < dag.nodeCount);
    nodeTimeNodeIds.set(node.id, tIds);
  }

  // Incorporate explicit directed canvas edges that may not yet be in analysis.relations
  for (const edge of schema.edges) {
    if (edge.direction === 'bidirectional' || edge.direction === 'undirected' || edge.eventId) {
      continue;
    }
    const srcTIds = nodeTimeNodeIds.get(edge.source) ?? [];
    const tgtTIds = nodeTimeNodeIds.get(edge.target) ?? [];
    for (const u of srcTIds) {
      for (const v of tgtTIds) {
        if (u !== v && dag.canAddPrecedence(u, v)) {
          dag.addPrecedenceEdge(u, v);
        }
      }
    }
  }

  const nodeRowRanks = dag.computeNodeRowRanks();
  const rawNodeRank = new Map<string, number>();
  for (const node of schema.nodes) {
    const tIds = nodeTimeNodeIds.get(node.id) ?? [];
    if (tIds.length > 0) {
      rawNodeRank.set(
        node.id,
        Math.min(...tIds.map((u) => nodeRowRanks.get(u) ?? 0))
      );
    }
  }

  const visibleRanks = [...new Set([...rawNodeRank.values()])].sort((a, b) => a - b);

  return new Map(
    schema.nodes.map((node, index) => {
      const r = rawNodeRank.get(node.id);
      const idx = r !== undefined ? visibleRanks.indexOf(r) : -1;
      return [node.id, idx >= 0 ? idx : visibleRanks.length + index];
    })
  );
}
