/**
 * SVGの getScreenCTM().inverse() を用いたスクリーン座標からSVG図座標への正確な変換
 * 仕様書 6.1: clientX/clientYは図描画グループのgetScreenCTMの逆行列で図座標へ変換する
 */
export function screenToDiagramCoords(
  svgGroupElement: SVGGElement,
  clientX: number,
  clientY: number
): { x: number; y: number } {
  const ctm = svgGroupElement.getScreenCTM();
  if (!ctm) {
    return { x: clientX, y: clientY };
  }
  const inverse = ctm.inverse();
  if (!Number.isFinite(inverse.a) || !Number.isFinite(inverse.d)) {
    return { x: clientX, y: clientY };
  }

  if (svgGroupElement.ownerSVGElement) {
    const svgPoint = svgGroupElement.ownerSVGElement.createSVGPoint();
    svgPoint.x = clientX;
    svgPoint.y = clientY;
    const transformed = svgPoint.matrixTransform(inverse);
    if (Number.isFinite(transformed.x) && Number.isFinite(transformed.y)) {
      return { x: transformed.x, y: transformed.y };
    }
  }

  // フォールバック計算
  const x = inverse.a * clientX + inverse.c * clientY + inverse.e;
  const y = inverse.b * clientX + inverse.d * clientY + inverse.f;
  return {
    x: Number.isFinite(x) ? x : clientX,
    y: Number.isFinite(y) ? y : clientY,
  };
}
