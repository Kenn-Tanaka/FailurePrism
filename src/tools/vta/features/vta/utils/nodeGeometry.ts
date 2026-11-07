import type { VTAReactFlowNode, VTANodeType } from '../../../types/vta';
import { CROSS_LANE_SOURCE_HANDLE_Y, CROSS_LANE_TARGET_HANDLE_Y } from './edgeHandles';

export const JUNCTION_SIZE = 20;
export const JUNCTION_RADIUS = 4;
export const OBJECT_JUNCTION_SIZE = 24;
export const OBJECT_JUNCTION_RADIUS = 8;
export interface NodeRect { x: number; y: number; width: number; height: number; isHidden?: boolean; isObjectJunction?: boolean }

/** 客体ノードをドット表示すべきかを判定 */
export function shouldDisplayAsObjectJunction(
  data?: {
    entity_role?: 'subject' | 'object';
    object_display_style?: 'dot' | 'card';
    type?: VTANodeType;
  },
  defaultObjectDisplayStyle?: 'dot' | 'card'
): boolean {
  if (!data || data.entity_role !== 'object') return false;
  // ユーザーの明示的な個別指定（カード or ドット）を最優先
  if (data.object_display_style === 'card') return false;
  if (data.object_display_style === 'dot') return true;

  // 帰結ノード（outcome）は事故の終局を示す最重要ノードであるため、
  // ユーザーの明示的なドット指定がない限り、受動客体であっても通常カード表示を維持する
  if (data.type === 'outcome') return false;

  return defaultObjectDisplayStyle !== 'card';
}

/** Store/layout coordinates always describe the original card, never its projected point. */
export function getDisplayRect(node: VTAReactFlowNode, defaultObjectDisplayStyle?: 'dot' | 'card' | number): NodeRect {
  if (node.type === 'vtaJunction') {
    return {
      x: node.position.x,
      y: node.position.y,
      width: node.width ?? JUNCTION_SIZE,
      height: node.height ?? JUNCTION_SIZE,
      isHidden: true,
    };
  }
  if (node.type === 'vtaObjectJunction') {
    return {
      x: node.position.x,
      y: node.position.y,
      width: node.width ?? OBJECT_JUNCTION_SIZE,
      height: node.height ?? OBJECT_JUNCTION_SIZE,
      isHidden: true,
      isObjectJunction: true,
    };
  }
  const style = typeof defaultObjectDisplayStyle === 'string' ? defaultObjectDisplayStyle : undefined;
  const width = node.measured?.width ?? 260;
  const height = node.measured?.height ?? node.data.measuredHeight ?? 140;
  if (node.data.is_hidden) {
    return {
      x: node.position.x + width / 2 - JUNCTION_SIZE / 2,
      y: node.position.y + height / 2 - JUNCTION_SIZE / 2,
      width: JUNCTION_SIZE, height: JUNCTION_SIZE, isHidden: true,
    };
  }
  if (shouldDisplayAsObjectJunction(node.data, style)) {
    return {
      x: node.position.x + width / 2 - OBJECT_JUNCTION_SIZE / 2,
      y: node.position.y + height / 2 - OBJECT_JUNCTION_SIZE / 2,
      width: OBJECT_JUNCTION_SIZE, height: OBJECT_JUNCTION_SIZE, isHidden: true, isObjectJunction: true,
    };
  }
  return { ...node.position, width, height, isHidden: false };
}

export function projectDisplayNode(node: VTAReactFlowNode, defaultObjectDisplayStyle?: 'dot' | 'card' | number): VTAReactFlowNode {
  const style = typeof defaultObjectDisplayStyle === 'string' ? defaultObjectDisplayStyle : undefined;
  if (node.data.is_hidden) {
    const rect = getDisplayRect(node);
    return {
      ...node, type: 'vtaJunction', position: { x: rect.x, y: rect.y },
      width: rect.width, height: rect.height, measured: { width: rect.width, height: rect.height },
      draggable: undefined, connectable: false,
    };
  }
  if (shouldDisplayAsObjectJunction(node.data, style)) {
    const rect = getDisplayRect(node, style);
    return {
      ...node, type: 'vtaObjectJunction', position: { x: rect.x, y: rect.y },
      width: rect.width, height: rect.height, measured: { width: rect.width, height: rect.height },
      draggable: undefined, connectable: false,
    };
  }
  return node;
}

/** Apply a projected node's drag delta to the underlying card origin. */
export function unprojectDraggedPosition(
  rawNode: VTAReactFlowNode,
  projectedNode: VTAReactFlowNode,
  nextProjectedPosition: { x: number; y: number }
) {
  return {
    x: rawNode.position.x + nextProjectedPosition.x - projectedNode.position.x,
    y: rawNode.position.y + nextProjectedPosition.y - projectedNode.position.y,
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
    // 端点ノード自身（source / target）は障害物リストに絶対含めない（自己ノード衝突・誤迂回防止）
    if (id === source || id === target) return [];
    if (!rect.isHidden) return [rect];
    return [{ x: rect.x + 4, y: rect.y + 4, width: rect.width - 8, height: rect.height - 8 }];
  });
}
