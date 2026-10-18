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

/**
 * 矩形の境界線と、中心から指定点へ向かう半直線との交点を求める
 */
export function getRectIntersectionPoint(rect: Rect, targetPoint: Point): Point {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const dx = targetPoint.x - cx;
  const dy = targetPoint.y - cy;

  if (dx === 0 && dy === 0) {
    return { x: cx, y: cy };
  }

  const halfW = rect.width / 2;
  const halfH = rect.height / 2;

  // 4辺との交差を判定
  // dx > 0: 右辺 (x = cx + halfW)
  // dx < 0: 左辺 (x = cx - halfW)
  // dy > 0: 下辺 (y = cy + halfH)
  // dy < 0: 上辺 (y = cy - halfH)
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  let scale = 1;
  if (absDx * halfH > absDy * halfW) {
    // 左右の辺と交差
    scale = halfW / absDx;
  } else {
    // 上下の辺と交差
    scale = halfH / absDy;
  }

  return {
    x: cx + dx * scale,
    y: cy + dy * scale,
  };
}

/**
 * 2つの矩形ノード間の接続線パス（d属性文字列）を生成
 * isReversePairがある場合は、反対向きの線と重ならないようにオフセット曲線（ベジェ）を生成
 */
export function calculateEdgePath(
  sourceRect: Rect,
  targetRect: Rect,
  isReversePair = false
): { pathData: string; midPoint: Point } {
  const sourceCenter = {
    x: sourceRect.x + sourceRect.width / 2,
    y: sourceRect.y + sourceRect.height / 2,
  };
  const targetCenter = {
    x: targetRect.x + targetRect.width / 2,
    y: targetRect.y + targetRect.height / 2,
  };

  const startPoint = getRectIntersectionPoint(sourceRect, targetCenter);
  const endPoint = getRectIntersectionPoint(targetRect, sourceCenter);

  if (!isReversePair) {
    // 直線
    const midPoint = {
      x: (startPoint.x + endPoint.x) / 2,
      y: (startPoint.y + endPoint.y) / 2,
    };
    return {
      pathData: `M ${startPoint.x} ${startPoint.y} L ${endPoint.x} ${endPoint.y}`,
      midPoint,
    };
  }

  // 逆方向のペアがある場合は、進行方向右側にわずかに膨らむ2次ベジェ曲線を生成
  const dx = endPoint.x - startPoint.x;
  const dy = endPoint.y - startPoint.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const offset = Math.min(24, Math.max(12, dist * 0.1));

  // 垂直ベクトル (法線)
  const nx = -dy / (dist || 1);
  const ny = dx / (dist || 1);

  const midX = (startPoint.x + endPoint.x) / 2;
  const midY = (startPoint.y + endPoint.y) / 2;

  // 制御点
  const ctrlX = midX + nx * offset;
  const ctrlY = midY + ny * offset;

  // 曲線の中心点 (t=0.5)
  const curveMid = {
    x: 0.25 * startPoint.x + 0.5 * ctrlX + 0.25 * endPoint.x,
    y: 0.25 * startPoint.y + 0.5 * ctrlY + 0.25 * endPoint.y,
  };

  return {
    pathData: `M ${startPoint.x} ${startPoint.y} Q ${ctrlX} ${ctrlY} ${endPoint.x} ${endPoint.y}`,
    midPoint: curveMid,
  };
}
