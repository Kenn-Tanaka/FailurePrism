import { connectSharedEvents } from './sharedEvents';
import { canonicalPosition } from './presentation';
import type { VTASchema, VTAReactFlowNode } from '../../../types/vta';
import { calculateVTALayout } from './layout';
import { getDisplayRect } from './nodeGeometry';
import { getVisualLaneOrders, repairLaneConnections } from './laneConnections';
import { VERTICAL_GAP } from './layout';

export function createConnectionRepairPlan(schema: VTASchema, nodes: VTAReactFlowNode[], viewMode: 'detail' | 'compact' = 'detail', projectId = '') {
  const sourceSignature = JSON.stringify({ schema, viewMode, projectId, geometry: nodes.map((node) => [node.id, node.position, getDisplayRect(node)]) });
  const { orders, issues } = getVisualLaneOrders(schema, nodes);
  const validIds = new Set(schema.nodes.map((node) => node.id));
  if (schema.edges.some((edge) => !validIds.has(edge.source) || !validIds.has(edge.target))) {
    issues.push('存在しないノードを参照する線があります。接続先を確認してください。');
  }
  const laneResult = repairLaneConnections(schema, orders);
  const connected = connectSharedEvents(laneResult.schema);
  const added = connected.edges.filter((edge) => edge.id && !laneResult.schema.edges.some((old) => old.id === edge.id));
  const result = { ...laneResult, schema: connected, addedEdges: laneResult.addedEdges + added.length, changes: [...laneResult.changes, ...added.map((edge) => ({ kind: 'added' as const, edge, previous: undefined, reason: '共通イベントのレーン間接続' }))] };
  const positionField = viewMode === 'compact' ? 'compact_position' : 'position';
  const positionById = new Map(nodes.map((node) => [node.id, node.position]));
  let repairedSchema: VTASchema = {
    ...result.schema,
    nodes: schema.nodes.map((node) => {
      const position = positionById.get(node.id);
      return position ? { ...node, [positionField]: canonicalPosition(schema, node.lane, position) } : node;
    }),
  };
  const otherMode = viewMode === 'compact' ? 'detail' : 'compact';
  const otherField = otherMode === 'compact' ? 'compact_position' : 'position';
  const otherLayout = calculateVTALayout(repairedSchema, undefined, undefined, {
    compact: otherMode === 'compact', positionField: otherField,
  });
  const otherOrders = getVisualLaneOrders(repairedSchema, otherLayout.nodes);
  const layoutChanges: Array<{ lane: string; nodeIds: string[] }> = [];
  if (!issues.length) {
    const targets = new Set<string>();
    for (const [lane, ids] of orders) {
      if (JSON.stringify(ids) !== JSON.stringify(otherOrders.orders.get(lane))) {
        ids.forEach((id) => targets.add(id));
        layoutChanges.push({ lane, nodeIds: ids });
      }
    }
    if (otherOrders.issues.length && !layoutChanges.length) issues.push(...otherOrders.issues);
    if (targets.size) {
      const topToBottom = new Map<string, string[]>();
      for (const item of layoutChanges) topToBottom.set(item.lane, [...item.nodeIds].reverse());
      const yById = new Map<string, number>();
      for (const item of layoutChanges) {
        const laneNodes = otherLayout.nodes.filter((node) => node.data.lane === item.lane);
        const startY = Math.min(...laneNodes.map((node) => getDisplayRect(node).y));
        let y = startY;
        for (const id of topToBottom.get(item.lane) ?? []) {
          const node = otherLayout.nodes.find((candidate) => candidate.id === id);
          if (!node) continue;
          yById.set(id, y);
          y += getDisplayRect(node).height + VERTICAL_GAP;
        }
      }
      repairedSchema = {
        ...repairedSchema,
        nodes: repairedSchema.nodes.map((node) => {
          if (!targets.has(node.id)) return node;
          const displayNode = otherLayout.nodes.find((candidate) => candidate.id === node.id);
          const targetY = yById.get(node.id);
          if (!displayNode || targetY === undefined) return node;
          const rect = getDisplayRect(displayNode);
          const rawPosition = (otherField === 'compact_position' ? node.compact_position : node.position)
            ?? canonicalPosition(schema, node.lane, displayNode.position);
          const next = { ...rawPosition, y: rawPosition.y + targetY - rect.y };
          return { ...node, [otherField]: next };
        }),
      };
    }
  }
  return { ...result, schema: repairedSchema, sourceSignature, issues, viewMode, layoutChanges };
}

export type ConnectionRepairPlan = ReturnType<typeof createConnectionRepairPlan>;
