import type { EdgeCategory, EdgeDirection } from '../../../types/vta';
import { pathPoints, segmentsFromPoints, type PathSegment } from './edgeRouting';

export type EdgeArrowOrientation =
  | 'right'
  | 'left'
  | 'horizontal-both'
  | 'up'
  | 'down'
  | 'vertical-both'
  | 'none';

export const EDGE_CATEGORY_NAMES: Record<EdgeCategory, string> = {
  dependency: '作業依存',
  information: '情報',
  material: '資機材',
  person: '人員',
  handover: '引継ぎ',
  impact: '物理影響',
  sequential: '時系列',
  other: '接続',
};

export interface EdgeLabelInput {
  label?: unknown;
  category?: EdgeCategory;
  direction?: EdgeDirection;
  isCrossLane: boolean;
  status?: string;
  receipt?: unknown;
}

export interface EdgeLabelContent {
  customLabel?: string;
  categoryLabel?: string;
  displayLabel?: string;
  fullText?: string;
}

export interface EdgeOrientationInput {
  direction?: EdgeDirection;
  isCrossLane: boolean;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition?: string;
  path?: string;
  labelX?: number;
  labelY?: number;
}

/**
 * Resolves the normalized text segments for a VTA connection label pill across Canvas and SVG.
 */
export function resolveEdgeLabelContent(input: EdgeLabelInput): EdgeLabelContent {
  const direction = input.direction ?? (input.isCrossLane ? 'unidirectional' : 'sequential');
  const trimmedLabel =
    typeof input.label === 'string'
      ? input.label.trim()
      : input.label != null && typeof input.label !== 'object'
        ? String(input.label).trim()
        : '';
  const customLabel =
    input.status === 'omitted'
      ? '未実施'
      : input.receipt === 'unconfirmed' && direction === 'unidirectional'
        ? '送信・受信未確認'
        : trimmedLabel || undefined;

  const rawCategoryLabel =
    input.category && input.category !== 'other'
      ? EDGE_CATEGORY_NAMES[input.category]
      : undefined;

  const isRedundantCategory = Boolean(
    customLabel && rawCategoryLabel && customLabel.includes(rawCategoryLabel)
  );
  const categoryLabel = isRedundantCategory ? undefined : rawCategoryLabel;

  const fallbackLabel = input.isCrossLane
    ? direction === 'undirected'
      ? '共通イベント'
      : direction === 'bidirectional'
        ? '相互確認'
        : '伝達'
    : undefined;

  const displayLabel = customLabel ?? rawCategoryLabel ?? fallbackLabel;
  const fullText =
    customLabel && categoryLabel
      ? `${customLabel} (${categoryLabel})`
      : displayLabel;

  return {
    customLabel,
    categoryLabel,
    displayLabel,
    fullText,
  };
}

/**
 * Finds the rendered orthogonal segment carrying the badge anchor `(labelX, labelY)`.
 */
export function findHostPathSegment(
  segments: readonly PathSegment[],
  labelX: number,
  labelY: number
): PathSegment | undefined {
  if (segments.length === 0) return undefined;
  let best: PathSegment | undefined;
  let bestScore = Infinity;

  for (const seg of segments) {
    const dx =
      labelX < seg.minX ? seg.minX - labelX : labelX > seg.maxX ? labelX - seg.maxX : 0;
    const dy =
      labelY < seg.minY ? seg.minY - labelY : labelY > seg.maxY ? labelY - seg.maxY : 0;
    const dist = Math.hypot(dx, dy);
    if (
      dist < bestScore - 0.5 ||
      (Math.abs(dist - bestScore) <= 0.5 && seg.length > (best?.length ?? -1))
    ) {
      best = seg;
      bestScore = dist;
    }
  }
  return bestScore <= 4 ? best : undefined;
}

/**
 * Determines the visual arrow orientation for an edge's connection label from its host segment
 * (when `path`, `labelX`, `labelY` are provided) or from semantics and coordinates.
 */
export function resolveEdgeArrowOrientation(input: EdgeOrientationInput): EdgeArrowOrientation {
  const direction = input.direction ?? (input.isCrossLane ? 'unidirectional' : 'sequential');
  if (direction === 'undirected') return 'none';

  if (input.path && input.labelX !== undefined && input.labelY !== undefined) {
    const hostSeg = findHostPathSegment(
      segmentsFromPoints(pathPoints(input.path)),
      input.labelX,
      input.labelY
    );
    if (hostSeg) {
      if (hostSeg.vertical) {
        if (direction === 'bidirectional') return 'vertical-both';
        return hostSeg.b[1] <= hostSeg.a[1] ? 'up' : 'down';
      }
      if (direction === 'bidirectional') return 'horizontal-both';
      const segDx = hostSeg.b[0] - hostSeg.a[0];
      if (Math.abs(segDx) >= 1) return segDx > 0 ? 'right' : 'left';
    }
  }

  const isSideAxis =
    input.isCrossLane ||
    input.sourcePosition === 'left' ||
    input.sourcePosition === 'right';

  if (isSideAxis) {
    if (direction === 'bidirectional') return 'horizontal-both';
    const dx = input.targetX - input.sourceX;
    if (Math.abs(dx) >= 2) {
      return dx > 0 ? 'right' : 'left';
    }
    if (input.sourcePosition === 'left') return 'left';
    if (input.sourcePosition === 'right') return 'right';
    return input.targetY <= input.sourceY ? 'up' : 'down';
  }

  if (direction === 'bidirectional') return 'vertical-both';
  return input.targetY <= input.sourceY ? 'up' : 'down';
}

export const EDGE_LABEL_VERTICAL_SPIKE_PX = 7;

export const EDGE_LABEL_CLIP_PATHS: Partial<
  Record<EdgeArrowOrientation, { outer: string; inner: string }>
> = {
  right: {
    outer: 'polygon(0% 0%, calc(100% - 9px) 0%, 100% 50%, calc(100% - 9px) 100%, 0% 100%)',
    inner: 'polygon(0% 0%, calc(100% - 8.5px) 0%, 100% 50%, calc(100% - 8.5px) 100%, 0% 100%)',
  },
  left: {
    outer: 'polygon(9px 0%, 100% 0%, 100% 100%, 9px 100%, 0% 50%)',
    inner: 'polygon(8.5px 0%, 100% 0%, 100% 100%, 8.5px 100%, 0% 50%)',
  },
  'horizontal-both': {
    outer:
      'polygon(9px 0%, calc(100% - 9px) 0%, 100% 50%, calc(100% - 9px) 100%, 9px 100%, 0% 50%)',
    inner:
      'polygon(8.5px 0%, calc(100% - 8.5px) 0%, 100% 50%, calc(100% - 8.5px) 100%, 8.5px 100%, 0% 50%)',
  },
  up: {
    outer:
      'polygon(4px 7px, calc(50% - 8px) 7px, 50% 0%, calc(50% + 8px) 7px, calc(100% - 4px) 7px, 100% 11px, 100% calc(100% - 4px), calc(100% - 4px) 100%, 4px 100%, 0% calc(100% - 4px), 0% 11px)',
    inner:
      'polygon(3.5px 7px, calc(50% - 7.5px) 7px, 50% 0.5px, calc(50% + 7.5px) 7px, calc(100% - 3.5px) 7px, 100% 10.5px, 100% calc(100% - 3.5px), calc(100% - 3.5px) 100%, 3.5px 100%, 0% calc(100% - 3.5px), 0% 10.5px)',
  },
  down: {
    outer:
      'polygon(4px 0%, calc(100% - 4px) 0%, 100% 4px, 100% calc(100% - 11px), calc(100% - 4px) calc(100% - 7px), calc(50% + 8px) calc(100% - 7px), 50% 100%, calc(50% - 8px) calc(100% - 7px), 4px calc(100% - 7px), 0% calc(100% - 11px), 0% 4px)',
    inner:
      'polygon(3.5px 0%, calc(100% - 3.5px) 0%, 100% 3.5px, 100% calc(100% - 10.5px), calc(100% - 3.5px) calc(100% - 7px), calc(50% + 7.5px) calc(100% - 7px), 50% calc(100% - 0.5px), calc(50% - 7.5px) calc(100% - 7px), 3.5px calc(100% - 7px), 0% calc(100% - 10.5px), 0% 3.5px)',
  },
  'vertical-both': {
    outer:
      'polygon(4px 7px, calc(50% - 8px) 7px, 50% 0%, calc(50% + 8px) 7px, calc(100% - 4px) 7px, 100% 11px, 100% calc(100% - 11px), calc(100% - 4px) calc(100% - 7px), calc(50% + 8px) calc(100% - 7px), 50% 100%, calc(50% - 8px) calc(100% - 7px), 4px calc(100% - 7px), 0% calc(100% - 11px), 0% 11px)',
    inner:
      'polygon(3.5px 7px, calc(50% - 7.5px) 7px, 50% 0.5px, calc(50% + 7.5px) 7px, calc(100% - 3.5px) 7px, 100% 10.5px, 100% calc(100% - 10.5px), calc(100% - 3.5px) calc(100% - 7px), calc(50% + 7.5px) calc(100% - 7px), 50% calc(100% - 0.5px), calc(50% - 7.5px) calc(100% - 7px), 3.5px calc(100% - 7px), 0% calc(100% - 10.5px), 0% 10.5px)',
  },
};

export function estimateEdgeLabelTextWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    width += /[\u0020-\u007e]/.test(ch) ? 6 : 9.6;
  }
  return width;
}

export interface EdgeLabelSvgBadge {
  width: number;
  pathD: string;
  textX: number;
  iconPathD?: string;
}

/**
 * Generates standard vector SVG path geometry (no <foreignObject>) for an edge label pill.
 */
export function buildEdgeLabelSvgBadge(
  labelText: string,
  orientation: EdgeArrowOrientation
): EdgeLabelSvgBadge {
  const textWidth = estimateEdgeLabelTextWidth(labelText);

  if (orientation === 'right') {
    const width = Math.max(54, Math.ceil(textWidth + 9 + 15));
    const halfW = width / 2;
    return {
      width,
      textX: -3,
      pathD: `M ${-halfW + 5} -11 L ${halfW - 9} -11 L ${halfW} 0 L ${halfW - 9} 11 L ${-halfW + 5} 11 Q ${-halfW} 11 ${-halfW} 6 L ${-halfW} -6 Q ${-halfW} -11 ${-halfW + 5} -11 Z`,
    };
  }

  if (orientation === 'left') {
    const width = Math.max(54, Math.ceil(textWidth + 15 + 9));
    const halfW = width / 2;
    return {
      width,
      textX: 3,
      pathD: `M ${-halfW} 0 L ${-halfW + 9} -11 L ${halfW - 5} -11 Q ${halfW} -11 ${halfW} -6 L ${halfW} 6 Q ${halfW} 11 ${halfW - 5} 11 L ${-halfW + 9} 11 Z`,
    };
  }

  if (orientation === 'horizontal-both') {
    const width = Math.max(60, Math.ceil(textWidth + 14 + 14));
    const halfW = width / 2;
    return {
      width,
      textX: 0,
      pathD: `M ${-halfW} 0 L ${-halfW + 9} -11 L ${halfW - 9} -11 L ${halfW} 0 L ${halfW - 9} 11 L ${-halfW + 9} 11 Z`,
    };
  }

  if (orientation === 'up' || orientation === 'down' || orientation === 'vertical-both') {
    const width = Math.max(54, Math.ceil(textWidth + 18));
    const halfW = width / 2;
    const topEdge =
      orientation === 'up' || orientation === 'vertical-both'
        ? `M ${-halfW + 5} -11 L -8 -11 L 0 -18 L 8 -11 L ${halfW - 5} -11`
        : `M ${-halfW + 5} -11 L ${halfW - 5} -11`;
    const bottomEdge =
      orientation === 'down' || orientation === 'vertical-both'
        ? `L 8 11 L 0 18 L -8 11 L ${-halfW + 5} 11`
        : `L ${-halfW + 5} 11`;
    return {
      width,
      textX: 0,
      pathD: `${topEdge} Q ${halfW} -11 ${halfW} -6 L ${halfW} 6 Q ${halfW} 11 ${halfW - 5} 11 ${bottomEdge} Q ${-halfW} 11 ${-halfW} 6 L ${-halfW} -6 Q ${-halfW} -11 ${-halfW + 5} -11 Z`,
    };
  }

  const width = Math.max(50, Math.ceil(textWidth + 18));
  const halfW = width / 2;
  return {
    width,
    textX: 0,
    pathD: `M ${-halfW + 10} -10 H ${halfW - 10} A 10 10 0 0 1 ${halfW - 10} 10 H ${-halfW + 10} A 10 10 0 0 1 ${-halfW + 10} -10 Z`,
  };
}

export interface EdgeBadgeBoundsInput {
  labelX: number;
  labelY: number;
  isBreak: boolean;
  orientation: EdgeArrowOrientation;
  labelContent: EdgeLabelContent;
}

export interface EdgeBadgeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function badgeVerticalExtents(
  orientation: EdgeArrowOrientation
): { top: number; bottom: number } {
  switch (orientation) {
    case 'up':
      return { top: 12 + EDGE_LABEL_VERTICAL_SPIKE_PX, bottom: 12 };
    case 'down':
      return { top: 12, bottom: 12 + EDGE_LABEL_VERTICAL_SPIKE_PX };
    case 'vertical-both':
      return {
        top: 12 + EDGE_LABEL_VERTICAL_SPIKE_PX,
        bottom: 12 + EDGE_LABEL_VERTICAL_SPIKE_PX,
      };
    default:
      return { top: 12, bottom: 12 };
  }
}

/**
 * Computes axis-aligned bounding boxes of rendered edge badges (Canvas and SVG union)
 * for clearance and non-overlap routing checks.
 */
export function computeEdgeBadgeRects(input: EdgeBadgeBoundsInput): EdgeBadgeRect[] {
  const { labelX, labelY, isBreak, orientation, labelContent } = input;
  const { customLabel, displayLabel, fullText } = labelContent;
  const ext = badgeVerticalExtents(orientation);

  if (!isBreak) {
    if (!displayLabel) return [];
    const text = fullText ?? displayLabel;
    const width = buildEdgeLabelSvgBadge(text, orientation).width;
    return [
      {
        x: labelX - width / 2,
        y: labelY - ext.top,
        width,
        height: ext.top + ext.bottom,
      },
    ];
  }

  const rects: EdgeBadgeRect[] = [];
  const customWidth = customLabel
    ? buildEdgeLabelSvgBadge(fullText ?? customLabel, orientation).width
    : 0;
  const primaryWidth = customLabel ? 68 + 4 + customWidth : 68;
  const primaryTop = customLabel ? ext.top : 12;
  const primaryBottom = customLabel ? ext.bottom : 12;
  rects.push({
    x: labelX - primaryWidth / 2,
    y: labelY - primaryTop,
    width: primaryWidth,
    height: primaryTop + primaryBottom,
  });

  if (fullText) {
    const secondaryWidth = buildEdgeLabelSvgBadge(fullText, orientation).width;
    const secTop = Math.max(11, ext.top - 1);
    const secBottom = Math.max(11, ext.bottom - 1);
    const secCenterOffsetY =
      orientation === 'up' || orientation === 'vertical-both'
        ? 22 + EDGE_LABEL_VERTICAL_SPIKE_PX
        : 22;
    rects.push({
      x: labelX - secondaryWidth / 2,
      y: labelY + secCenterOffsetY - secTop,
      width: secondaryWidth,
      height: secTop + secBottom,
    });
  }

  return rects;
}
