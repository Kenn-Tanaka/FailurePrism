import type { VTASchema, VTANodeData } from '../../../types/vta';
import { visibleSchema } from './presentation';
import { repairLaneConnections } from './laneConnections';
import { computeEventRowMap } from './eventTimePoset';

export interface GeneratedLaneSequenceResult {
  schema: VTASchema;
  addedEdges: number;
  removedEdges: number;
  correctedDirections: number;
  fallbackLanes: string[];
}

/** Repair only AI-generated lane continuity; saved and manually edited graphs stay untouched. */
export function repairGeneratedLaneSequence(
  schema: VTASchema,
  options?: { preservePositions?: boolean }
): GeneratedLaneSequenceResult {
  const hasAnalysis = Boolean(schema.analysis?.events.length);
  const eventRowMap = hasAnalysis ? computeEventRowMap(schema.analysis!) : undefined;
  const eventById = hasAnalysis
    ? new Map(schema.analysis!.events.map((event) => [event.id, event]))
    : undefined;
  const cardEventsById = hasAnalysis
    ? new Map(schema.analysis!.cards.map((card) => [card.id, card.eventIds]))
    : undefined;

  const nodeRow = (node: VTANodeData): number | undefined => {
    if (!eventRowMap) return undefined;
    const evIds = node.event_ids?.length ? node.event_ids : (cardEventsById?.get(node.id) ?? []);
    const rows = evIds
      .map((id) => eventRowMap.get(id))
      .filter((row): row is number => row !== undefined);
    return rows.length ? Math.min(...rows) : undefined;
  };
  const nodeSourceOrder = (node: VTANodeData): number | undefined => {
    if (!eventById) return undefined;
    const evIds = node.event_ids?.length ? node.event_ids : (cardEventsById?.get(node.id) ?? []);
    const orders = evIds
      .map((id) => eventById.get(id)?.sourceOrder)
      .filter((order): order is number => typeof order === 'number' && Number.isFinite(order));
    return orders.length ? Math.min(...orders) : undefined;
  };

  const nodesByLane = new Map<string, Array<{ node: VTANodeData; index: number }>>();
  visibleSchema(schema).nodes.forEach((node, index) => {
    const group = nodesByLane.get(node.lane) ?? [];
    group.push({ node, index });
    nodesByLane.set(node.lane, group);
  });

  const nodeUpdates = new Map<string, VTANodeData>();
  const reorderedNodeIds = new Set<string>();
  const laneOrders = new Map<string, string[]>();
  const fallbackLanes: string[] = [];

  for (const [lane, group] of nodesByLane) {
    const orders = group.map(({ node }) => node.sequence_order);
    const hasUnambiguousOrder =
      orders.every((order) => typeof order === 'number' && Number.isFinite(order)) &&
      new Set(orders).size === group.length;
    const sortedBySeq = hasUnambiguousOrder
      ? [...group].sort((a, b) => a.node.sequence_order! - b.node.sequence_order!)
      : group;

    let sorted = sortedBySeq;
    let reorderedByDag = false;

    if (eventRowMap) {
      const sortedByDag = [...group].sort((a, b) => {
        const rA = nodeRow(a.node);
        const rB = nodeRow(b.node);
        if (rA !== undefined && rB !== undefined && rA !== rB) {
          return rA < rB ? -1 : 1;
        }
        if (rA !== undefined && rB === undefined) return -1;
        if (rA === undefined && rB !== undefined) return 1;
        if (hasUnambiguousOrder && a.node.sequence_order !== b.node.sequence_order) {
          return a.node.sequence_order! - b.node.sequence_order!;
        }
        const sA = nodeSourceOrder(a.node);
        const sB = nodeSourceOrder(b.node);
        if (sA !== undefined && sB !== undefined && sA !== sB) {
          return sA < sB ? -1 : 1;
        }
        return a.index - b.index;
      });

      reorderedByDag = sortedByDag.some((item, idx) => item.node.id !== sortedBySeq[idx]?.node.id);
      if (reorderedByDag) {
        sorted = sortedByDag;
        sorted.forEach(({ node }, seqIdx) => {
          nodeUpdates.set(node.id, { ...node, sequence_order: seqIdx });
          reorderedNodeIds.add(node.id);
        });
      }
    }

    if (!hasUnambiguousOrder && group.length > 1 && !reorderedByDag) {
      fallbackLanes.push(lane);
      for (const { node, index } of group) {
        nodeUpdates.set(node.id, { ...node, sequence_order: index });
      }
    }

    laneOrders.set(lane, sorted.map(({ node }) => node.id));
  }

  const repaired = repairLaneConnections(schema, laneOrders);

  return {
    schema: {
      ...schema,
      nodes: schema.nodes.map((node) => {
        const generatedNode = nodeUpdates.get(node.id) ?? node;
        const isReordered = reorderedNodeIds.has(node.id);
        if (options?.preservePositions && !isReordered) {
          return generatedNode;
        }
        if (!generatedNode.position && !(isReordered && generatedNode.compact_position)) {
          return generatedNode;
        }
        const nextNode = { ...generatedNode };
        delete nextNode.position;
        if (isReordered) {
          delete nextNode.compact_position;
        }
        return nextNode;
      }),
      edges: repaired.schema.edges,
    },
    addedEdges: repaired.addedEdges,
    removedEdges: repaired.removedEdges,
    correctedDirections: repaired.correctedDirections,
    fallbackLanes,
  };
}
