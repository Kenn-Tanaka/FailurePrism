export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

interface ConnectionNode extends Rect {
  id: string;
  levelId: string;
}

const center = (rect: Rect): Point => ({
  x: rect.x + rect.width / 2,
  y: rect.y + rect.height / 2,
});

function sideCenter(rect: Rect, vertical: boolean, direction: number): Point {
  const point = center(rect);
  if (vertical) point.y += direction * rect.height / 2;
  else point.x += direction * rect.width / 2;
  return point;
}

/** 列が異なる場合は左右、同じ場合は上下の辺の中央を使う。ポートは保存しない。 */
export function calculateEdgePath(
  source: ConnectionNode,
  target: ConnectionNode,
  isReversePair = false
): { pathData: string; midPoint: Point } {
  const vertical = source.levelId === target.levelId;
  const axis = vertical ? 'y' : 'x';
  const cross = vertical ? 'x' : 'y';
  // 同一座標でも、逆向きの線は逆の接続方向にする。
  const direction = Math.sign(center(target)[axis] - center(source)[axis]) ||
    (source.id < target.id ? 1 : -1);
  const start = sideCenter(source, vertical, direction);
  const end = sideCenter(target, vertical, -direction);
  const midPoint = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
  if (!isReversePair) {
    return { pathData: `M ${start.x} ${start.y} L ${end.x} ${end.y}`, midPoint };
  }

  // 主軸の制御点を間隔内に置き、急傾斜の線も端点でノード内側へ向けない。
  // 重なったノードには短い外向き制御点を使うが、障害物回避は行わない。
  const gap = (end[axis] - start[axis]) * direction;
  const reach = gap > 0 ? gap / 3 : 24;
  const offset = 24 * direction * (vertical ? -1 : 1);
  const control1 = { ...start };
  const control2 = { ...end };
  control1[axis] += direction * reach;
  control2[axis] -= direction * reach;
  control1[cross] += offset;
  control2[cross] += offset;
  return {
    pathData: `M ${start.x} ${start.y} C ${control1.x} ${control1.y} ${control2.x} ${control2.y} ${end.x} ${end.y}`,
    midPoint: {
      x: (start.x + 3 * control1.x + 3 * control2.x + end.x) / 8,
      y: (start.y + 3 * control1.y + 3 * control2.y + end.y) / 8,
    },
  };
}

/** 描画順で手前のノードを優先。プレビューとドロップ判定で共用する。 */
export function findConnectionTarget<T extends ConnectionNode>(
  nodes: readonly T[], point: Point, sourceId: string
): T | undefined {
  return [...nodes].reverse().find((node) => node.id !== sourceId &&
    point.x >= node.x && point.x <= node.x + node.width &&
    point.y >= node.y && point.y <= node.y + node.height);
}

/** 未接続時はカーソル方向の辺中央、接続先に重なったら確定時と同じパス。 */
export function calculateDraftEdgePath(
  source: ConnectionNode, cursor: Point, target?: ConnectionNode, isReversePair = false
): string {
  if (target) return calculateEdgePath(source, target, isReversePair).pathData;
  const origin = center(source);
  const dx = cursor.x - origin.x;
  const dy = cursor.y - origin.y;
  const vertical = Math.abs(dy) * source.width > Math.abs(dx) * source.height;
  const start = sideCenter(source, vertical, Math.sign(vertical ? dy : dx) || 1);
  return `M ${start.x} ${start.y} L ${cursor.x} ${cursor.y}`;
}
