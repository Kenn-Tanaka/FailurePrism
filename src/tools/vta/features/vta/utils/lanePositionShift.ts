import type { VTASchema, VTAReactFlowNode } from '../../../types/vta';
import { visibleSchema, VTA_LANE_WIDTH } from './presentation';

function resolvePreviousNode(
  node: VTASchema['nodes'][number],
  previousById: ReadonlyMap<string, VTASchema['nodes'][number]>,
  previousNodes: readonly VTASchema['nodes'][number][]
) {
  const byId = previousById.get(node.id);
  if (byId) return byId;
  if (!node.event_ids?.length) return undefined;
  return (
    previousNodes.find(
      (prev) =>
        prev.lane === node.lane &&
        prev.event_ids?.some((id) => node.event_ids!.includes(id))
    ) ??
    previousNodes.find((prev) =>
      prev.event_ids?.some((id) => node.event_ids!.includes(id))
    )
  );
}

/**
 * Shifts canonical `position.x` and `compact_position.x` on nodes carried over from
 * `previousSchema` whenever lane reordering or lane reassignment changes their lane column index.
 */
export function shiftSchemaPositionsForLaneChange(
  previousSchema: VTASchema,
  nextSchema: VTASchema
): VTASchema {
  if (!previousSchema.lanes.length || !nextSchema.nodes.length) return nextSchema;
  const oldIndexByLane = new Map(previousSchema.lanes.map((lane, index) => [lane, index]));
  const newIndexByLane = new Map(nextSchema.lanes.map((lane, index) => [lane, index]));
  const previousById = new Map(previousSchema.nodes.map((node) => [node.id, node]));

  let changed = false;
  const shiftedNodes = nextSchema.nodes.map((node) => {
    if (!node.position && !node.compact_position) return node;
    const prevNode = resolvePreviousNode(node, previousById, previousSchema.nodes);
    if (!prevNode) return node;
    const oldIdx = oldIndexByLane.get(prevNode.lane);
    const newIdx = newIndexByLane.get(node.lane);
    if (oldIdx === undefined || newIdx === undefined || oldIdx === newIdx) return node;
    const dx = (newIdx - oldIdx) * VTA_LANE_WIDTH;
    changed = true;
    return {
      ...node,
      ...(node.position ? { position: { x: node.position.x + dx, y: node.position.y } } : {}),
      ...(node.compact_position
        ? { compact_position: { x: node.compact_position.x + dx, y: node.compact_position.y } }
        : {}),
    };
  });

  return changed ? { ...nextSchema, nodes: shiftedNodes } : nextSchema;
}

function sharesAnyEvent(a?: readonly string[], b?: readonly string[]): boolean {
  if (!a?.length || !b?.length) return true;
  return a.some((id) => b.includes(id));
}

function detectReorderedLanes(
  previousSchema: VTASchema,
  nextSchema: VTASchema
): Set<string> {
  const reordered = new Set<string>();
  const prevRankByEventLane = new Map<string, number>();
  const prevSeqByLane = new Map<string, number>();
  for (const prev of previousSchema.nodes) {
    const lane = prev.lane;
    const seq = typeof prev.sequence_order === 'number' && Number.isFinite(prev.sequence_order)
      ? prev.sequence_order
      : (prevSeqByLane.get(lane) ?? 0);
    prevSeqByLane.set(lane, seq + 1);
    for (const evId of prev.event_ids ?? []) {
      prevRankByEventLane.set(`${lane}\u0000${evId}`, seq);
    }
  }
  const currSeqByLane = new Map<string, number[]>();
  const nextByLane = new Map<string, typeof nextSchema.nodes>();
  for (const node of nextSchema.nodes) {
    const list = nextByLane.get(node.lane) ?? [];
    list.push(node);
    nextByLane.set(node.lane, list);
  }
  for (const [lane, list] of nextByLane) {
    const ordered = [...list].sort((a, b) => {
      const sa = typeof a.sequence_order === 'number' && Number.isFinite(a.sequence_order) ? a.sequence_order : Number.MAX_SAFE_INTEGER;
      const sb = typeof b.sequence_order === 'number' && Number.isFinite(b.sequence_order) ? b.sequence_order : Number.MAX_SAFE_INTEGER;
      return sa - sb;
    });
    for (const node of ordered) {
      const prevRanks = (node.event_ids ?? [])
        .map((evId) => prevRankByEventLane.get(`${lane}\u0000${evId}`))
        .filter((r): r is number => r !== undefined);
      if (prevRanks.length > 0) {
        const ranks = currSeqByLane.get(lane) ?? [];
        ranks.push(Math.min(...prevRanks));
        currSeqByLane.set(lane, ranks);
      }
    }
  }
  for (const [lane, ranks] of currSeqByLane) {
    for (let i = 1; i < ranks.length; i++) {
      if (ranks[i] < ranks[i - 1]) {
        reordered.add(lane);
        break;
      }
    }
  }
  return reordered;
}

/**
 * Shifts display-space ReactFlow node X coordinates from `visibleSchema(previousSchema)` to
 * `visibleSchema(nextSchema)` so passing `existingNodes` to `calculateVTALayout` never preserves
 * stale column or outdated Y coordinates after card renumbering or lane reordering.
 */
export function shiftReactNodesForLaneChange(
  previousSchema: VTASchema,
  nextSchema: VTASchema,
  reactNodes?: VTAReactFlowNode[]
): VTAReactFlowNode[] | undefined {
  if (!reactNodes?.length) return reactNodes;
  const oldVisibleLanes = visibleSchema(previousSchema).lanes;
  const newVisibleLanes = visibleSchema(nextSchema).lanes;
  const oldVisIndexByLane = new Map(oldVisibleLanes.map((lane, index) => [lane, index]));
  const newVisIndexByLane = new Map(newVisibleLanes.map((lane, index) => [lane, index]));
  const previousById = new Map(previousSchema.nodes.map((node) => [node.id, node]));
  const nextById = new Map(nextSchema.nodes.map((node) => [node.id, node]));
  const reorderedLanes = detectReorderedLanes(previousSchema, nextSchema);

  const shifted: VTAReactFlowNode[] = [];
  for (const rn of reactNodes) {
    const nextNode = nextById.get(rn.id);
    if (!nextNode) {
      shifted.push(rn);
      continue;
    }
    const prevNode = previousById.get(rn.id);
    // Drop stale coordinates when a card ID was reassigned to unrelated events,
    // when its persisted position was intentionally cleared, or when its lane reordered.
    if (!sharesAnyEvent(prevNode?.event_ids, nextNode.event_ids)) {
      continue;
    }
    if (prevNode?.position && !nextNode.position) {
      continue;
    }
    const oldLane = prevNode?.lane ?? String(rn.data?.lane ?? nextNode.lane);
    const newLane = nextNode.lane;
    if (reorderedLanes.has(newLane)) {
      continue;
    }
    const oldIdx = oldVisIndexByLane.get(oldLane);
    const newIdx = newVisIndexByLane.get(newLane);
    if (oldIdx === undefined || newIdx === undefined) {
      // Drop hidden/unmapped fallback so calculateVTALayout computes fresh column X.
      continue;
    }
    const dx = (newIdx - oldIdx) * VTA_LANE_WIDTH;
    if (dx === 0 && oldLane === newLane) {
      shifted.push(rn);
      continue;
    }
    const shiftedPos = { x: rn.position.x + dx, y: rn.position.y };
    shifted.push({
      ...rn,
      position: shiftedPos,
      data: {
        ...rn.data,
        lane: newLane,
        position: shiftedPos,
      },
    });
  }
  return shifted;
}
