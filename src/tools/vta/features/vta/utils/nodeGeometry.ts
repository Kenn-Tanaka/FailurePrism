import type { VTAReactFlowNode } from '../../../types/vta';
import { CROSS_LANE_SOURCE_HANDLE_Y, CROSS_LANE_TARGET_HANDLE_Y } from './edgeHandles';

export const JUNCTION_SIZE = 20;
export const JUNCTION_RADIUS = 4;
export interface NodeRect { x: number; y: number; width: number; height: number; isHidden?: boolean }

/** Store/layout coordinates always describe the original card, never its projected point. */
export function getDisplayRect(node: VTAReactFlowNode): NodeRect {
  const width = node.measured?.width ?? 260;
  const height = node.measured?.height ?? node.data.measuredHeight ?? 140;
  return node.data.is_hidden ? {
    x: node.position.x + width / 2 - JUNCTION_SIZE / 2,
    y: node.position.y + height / 2 - JUNCTION_SIZE / 2,
    width: JUNCTION_SIZE, height: JUNCTION_SIZE, isHidden: true,
  } : { ...node.position, width, height, isHidden: false };
}

export function projectDisplayNode(node: VTAReactFlowNode): VTAReactFlowNode {
  if (!node.data.is_hidden) return node;
  const rect = getDisplayRect(node);
  return {
    ...node, type: 'vtaJunction', position: { x: rect.x, y: rect.y },
    width: rect.width, height: rect.height, measured: { width: rect.width, height: rect.height },
    draggable: false, connectable: false,
  };
}

/** Canvas and SVG use identical endpoints, including coincident point handles. */
export function getEdgeAnchor(rect: NodeRect, side: string, source: boolean) {
  if (rect.isHidden) return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  if (side === 'left' || side === 'right') return {
    x: rect.x + (side === 'right' ? rect.width : 0),
    y: rect.y + rect.height * (source ? CROSS_LANE_SOURCE_HANDLE_Y : CROSS_LANE_TARGET_HANDLE_Y),
  };
  return { x: rect.x + rect.width / 2, y: rect.y + (side === 'bottom' ? rect.height : 0) };
}

/** Endpoints may touch their own points; unrelated edges must go around other points. */
export function routingObstacles(rects: Map<string, NodeRect>, source: string, target: string) {
  return [...rects.entries()].flatMap(([id, rect]) => {
    if (!rect.isHidden) return [rect];
    if (id === source || id === target) return [];
    return [{ x: rect.x + 4, y: rect.y + 4, width: rect.width - 8, height: rect.height - 8 }];
  });
}
