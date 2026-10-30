import { visibleSchema } from './presentation';
import type { VTASchema, VTAEdgeData, VTAReactFlowNode } from '../../../types/vta';
import { getDisplayRect } from './nodeGeometry';

export interface LaneConnectionChange {
  kind: 'added' | 'removed' | 'corrected';
  edge: VTAEdgeData;
  previous?: VTAEdgeData;
  reason: string;
}

const pairKey = (source: string, target: string) => JSON.stringify([source, target]);

/** Shared by generated diagrams and the explicit repair action. Orders run bottom to top. */
export function repairLaneConnections(schema: VTASchema, orders: Map<string, string[]>) {
  const expected = new Map<string, { source: string; target: string }>();
  for (const ids of orders.values()) {
    for (let i = 1; i < ids.length; i++) {
      expected.set(pairKey(ids[i - 1], ids[i]), { source: ids[i - 1], target: ids[i] });
    }
  }
  const laneById = new Map(schema.nodes.map((node) => [node.id, node.lane]));
  // Prefer a correctly oriented existing edge, then reuse a reverse edge with its metadata.
  const chosen = new Map<string, number>();
  for (const [key, pair] of expected) {
    const forward = schema.edges.findIndex((edge) => edge.source === pair.source && edge.target === pair.target);
    const index = forward >= 0 ? forward : schema.edges.findIndex((edge) => edge.source === pair.target && edge.target === pair.source);
    if (index >= 0) chosen.set(key, index);
  }
  const changes: LaneConnectionChange[] = [];
  const edges: VTAEdgeData[] = [];
  schema.edges.forEach((edge, index) => {
    const sourceLane = laneById.get(edge.source);
    const targetLane = laneById.get(edge.target);
    if (sourceLane === undefined || targetLane === undefined || sourceLane !== targetLane || !orders.has(sourceLane)) {
      edges.push(edge);
      return;
    }
    const forwardKey = pairKey(edge.source, edge.target);
    const reverseKey = pairKey(edge.target, edge.source);
    const key = expected.has(forwardKey) ? forwardKey : reverseKey;
    const pair = expected.get(key);
    if (!pair || chosen.get(key) !== index) {
      changes.push({ kind: 'removed', edge, reason: pair ? '隣接ノード間の重複線' : '飛び越し線・自己接続' });
      return;
    }
    if (edge.source !== pair.source || edge.direction !== 'sequential') {
      const corrected: VTAEdgeData = { ...edge, ...pair, direction: 'sequential' };
      edges.push(corrected);
      changes.push({ kind: 'corrected', edge: corrected, previous: edge, reason: '下から上への時系列線に修正' });
    } else {
      edges.push(edge);
    }
  });
  for (const [key, pair] of expected) {
    if (chosen.has(key)) continue;
    const edge: VTAEdgeData = { ...pair, direction: 'sequential', is_break: false };
    edges.push(edge);
    changes.push({ kind: 'added', edge, reason: '隣接ノード間の不足線' });
  }
  return {
    schema: { ...schema, edges }, changes,
    addedEdges: changes.filter((change) => change.kind === 'added').length,
    removedEdges: changes.filter((change) => change.kind === 'removed').length,
    correctedDirections: changes.filter((change) => change.kind === 'corrected').length,
  };
}

/** Use unprojected React Flow nodes so hidden cards are converted to points exactly once. */
export function getVisualLaneOrders(schema: VTASchema, nodes: VTAReactFlowNode[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const groups = new Map<string, Array<{ id: string; title: string; y: number; bottom: number }>>();
  const issues: string[] = [];
  for (const node of visibleSchema(schema).nodes) {
    const display = byId.get(node.id);
    const rect = display ? getDisplayRect(display) : undefined;
    if (!rect || ![rect.x, rect.y, rect.height].every(Number.isFinite)) {
      issues.push(`「${node.title || node.id}」の表示位置を確認できません。`);
      continue;
    }
    const group = groups.get(node.lane) ?? [];
    group.push({ id: node.id, title: node.title || node.id, y: rect.y, bottom: rect.y + rect.height });
    groups.set(node.lane, group);
  }
  const orders = new Map<string, string[]>();
  for (const [lane, group] of groups) {
    group.sort((a, b) => a.y - b.y);
    for (let i = 1; i < group.length; i++) {
      if (group[i - 1].bottom > group[i].y) {
        issues.push(`「${lane}」の「${group[i - 1].title}」と「${group[i].title}」が上下に重なっています。位置を調整してください。`);
      }
    }
    orders.set(lane, group.map((node) => node.id).reverse());
  }
  return { orders, issues };
}
