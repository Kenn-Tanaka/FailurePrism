import type { VTASchema, VTANodeData } from '../../../types/vta';
import { visibleSchema } from './presentation';
import { repairLaneConnections } from './laneConnections';

export interface GeneratedLaneSequenceResult {
  schema: VTASchema;
  addedEdges: number;
  removedEdges: number;
  correctedDirections: number;
  fallbackLanes: string[];
}

/** Repair only AI-generated lane continuity; saved and manually edited graphs stay untouched. */
export function repairGeneratedLaneSequence(schema: VTASchema): GeneratedLaneSequenceResult {
  const nodesByLane = new Map<string, Array<{ node: VTANodeData; index: number }>>();
  visibleSchema(schema).nodes.forEach((node, index) => {
    const group = nodesByLane.get(node.lane) ?? [];
    group.push({ node, index });
    nodesByLane.set(node.lane, group);
  });

  const nodeUpdates = new Map<string, VTANodeData>();
  const laneOrders = new Map<string, string[]>();
  const fallbackLanes: string[] = [];

  for (const [lane, group] of nodesByLane) {
    const orders = group.map(({ node }) => node.sequence_order);
    const hasUnambiguousOrder = orders.every((order) => typeof order === 'number' && Number.isFinite(order))
      && new Set(orders).size === group.length;
    const sorted = hasUnambiguousOrder
      ? [...group].sort((a, b) => a.node.sequence_order! - b.node.sequence_order!)
      : group;

    if (!hasUnambiguousOrder && group.length > 1) {
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
        if (!generatedNode.position) return generatedNode;
        const withoutPosition = { ...generatedNode };
        delete withoutPosition.position;
        return withoutPosition;
      }),
      edges: repaired.schema.edges,
    },
    addedEdges: repaired.addedEdges,
    removedEdges: repaired.removedEdges,
    correctedDirections: repaired.correctedDirections,
    fallbackLanes,
  };
}
