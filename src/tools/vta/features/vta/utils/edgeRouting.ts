export interface RoutingRect { x: number; y: number; width: number; height: number }
export type Point = [number, number];

export interface PathSegment {
  a: Point;
  b: Point;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  horizontal: boolean;
  vertical: boolean;
  index: number;
  length: number;
}

/** Vertical clearance between a straight horizontal wire and non-endpoint node rects. */
export const WIRE_NODE_CLEARANCE_Y = 4;
/** Minimum vertical separation between parallel horizontal wires in overlapping X spans. */
export const EDGE_HORIZONTAL_CLEARANCE_Y = 12;
/** Minimum horizontal separation between parallel vertical stems in overlapping Y spans. */
export const EDGE_VERTICAL_CLEARANCE_X = 14;
/** Margin around an edge badge when testing against non-endpoint nodes. */
export const EDGE_BADGE_NODE_PAD = 1;
/** Margin between two separate edges' label badges. */
export const EDGE_BADGE_EDGE_PAD = 2;

export function routingOffset(id: string, edges: { id: string }[]): number {
  const ids = edges.map((edge) => edge.id).sort();
  const index = ids.indexOf(id);
  return ids.length < 2 || index < 0 ? 0 : -20 + 40 * index / (ids.length - 1);
}

export function segmentBlocked(a: Point, b: Point, obstacles: RoutingRect[]): boolean {
  return obstacles.some((r) => a[0] === b[0]
    ? a[0] > r.x + 0.5 && a[0] < r.x + r.width - 0.5 &&
      Math.max(a[1], b[1]) > r.y + 0.5 && Math.min(a[1], b[1]) < r.y + r.height - 0.5
    : a[1] > r.y + 0.5 && a[1] < r.y + r.height - 0.5 &&
      Math.max(a[0], b[0]) > r.x + 0.5 && Math.min(a[0], b[0]) < r.x + r.width - 0.5);
}

/**
 * Checks whether a horizontal band [minX..maxX] x [y - halfClearanceY .. y + halfClearanceY]
 * intersects any obstacle rectangle (keeping a small inward margin on horizontal endpoints).
 */
export function horizontalBandBlocked(
  x1: number,
  x2: number,
  y: number,
  halfClearanceY: number,
  obstacles: RoutingRect[]
): boolean {
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  return obstacles.some(
    (r) =>
      maxX > r.x + 0.5 &&
      minX < r.x + r.width - 0.5 &&
      y + halfClearanceY > r.y + 0.5 &&
      y - halfClearanceY < r.y + r.height - 0.5
  );
}

export function rectsOverlap(a: RoutingRect, b: RoutingRect): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

export function padRect(rect: RoutingRect, padX: number, padY = padX): RoutingRect {
  return {
    x: rect.x - padX,
    y: rect.y - padY,
    width: rect.width + padX * 2,
    height: rect.height + padY * 2,
  };
}

export function segmentsFromPoints(points: Point[]): PathSegment[] {
  const segments: PathSegment[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const minX = Math.min(a[0], b[0]);
    const maxX = Math.max(a[0], b[0]);
    const minY = Math.min(a[1], b[1]);
    const maxY = Math.max(a[1], b[1]);
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const dx = Math.abs(b[0] - a[0]);
    const dy = Math.abs(b[1] - a[1]);
    const horizontal = length > 0.5 && dy <= dx;
    const vertical = length > 0.5 && dx < dy;
    segments.push({
      a,
      b,
      minX,
      maxX,
      minY,
      maxY,
      horizontal,
      vertical,
      index: i - 1,
      length,
    });
  }
  return segments;
}

/** Tests whether an orthogonal segment intersects an axis-aligned rectangle. */
export function segmentIntersectsRect(seg: PathSegment, rect: RoutingRect): boolean {
  if (seg.horizontal) {
    const y = (seg.a[1] + seg.b[1]) / 2;
    return (
      seg.maxX > rect.x &&
      seg.minX < rect.x + rect.width &&
      y > rect.y &&
      y < rect.y + rect.height
    );
  }
  const x = (seg.a[0] + seg.b[0]) / 2;
  return (
    x > rect.x &&
    x < rect.x + rect.width &&
    seg.maxY > rect.y &&
    seg.minY < rect.y + rect.height
  );
}

export function pathPoints(path: string): Point[] {
  const values = path.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)?.map(Number) ?? [];
  return Array.from({ length: values.length / 2 }, (_, i) => [values[i * 2], values[i * 2 + 1]]);
}

export interface HorizontalBand {
  minY: number;
  maxY: number;
  minX?: number;
  maxX?: number;
}

export interface VerticalBand {
  minX: number;
  maxX: number;
  minY?: number;
  maxY?: number;
}

export interface AvoidCardsOptions {
  /** Preferred bypass side around obstacle cards when left/right detours have equal length. */
  detourSide?: 'left' | 'right';
  /** Horizontal margin offset around obstacle cards (independent of vertical stub margin). */
  xMarginOffset?: number;
  /** Explicit departure stub length along sourceSide (preserves outChannelOffset in fallback routing). */
  sourceMargin?: number;
  /** Occupied vertical stem bands to avoid when fallback card routing activates. */
  extraAvoidVerticalBands?: readonly VerticalBand[];
}

/** Search an orthogonal visibility grid only when the normal corridor hits a card. */
export function avoidCards(
  candidate: [string, number, number], obstacles: RoutingRect[],
  sourceSide = 'top', targetSide = 'bottom', offset = 0,
  avoidHorizontalBand?: HorizontalBand,
  targetMargin?: number,
  extraAvoidBands?: readonly HorizontalBand[],
  options?: AvoidCardsOptions,
): [string, number, number] {
  const original = pathPoints(candidate[0]);
  const source = original[0], target = original[original.length - 1];
  const margin = 30 + offset;
  const xMargin =
    options?.xMarginOffset !== undefined ? Math.max(14, 30 + options.xMarginOffset) : margin;
  const stub = (p: Point, side: string, m = margin): Point => [
    p[0] + (side === 'left' ? -m : side === 'right' ? m : 0),
    p[1] + (side === 'top' ? -m : side === 'bottom' ? m : 0),
  ];
  const preferredStart =
    options?.sourceMargin !== undefined ? stub(source, sourceSide, options.sourceMargin) : undefined;
  const start =
    preferredStart && !segmentBlocked(source, preferredStart, obstacles)
      ? preferredStart
      : stub(source, sourceSide);
  const preferredEnd = targetMargin !== undefined ? stub(target, targetSide, targetMargin) : undefined;
  const end =
    preferredEnd && !segmentBlocked(target, preferredEnd, obstacles)
      ? preferredEnd
      : stub(target, targetSide);
  const bandMinX = Math.min(start[0], end[0]);
  const bandMaxX = Math.max(start[0], end[0]);
  const bandMinY = Math.min(start[1], end[1]);
  const bandMaxY = Math.max(start[1], end[1]);
  const hitsBand = (a: Point, b: Point, band: HorizontalBand, fallbackMinX: number, fallbackMaxX: number) => {
    const bxMin = band.minX ?? fallbackMinX;
    const bxMax = band.maxX ?? fallbackMaxX;
    return (
      Math.abs(a[1] - b[1]) < 1 &&
      a[1] >= band.minY &&
      a[1] <= band.maxY &&
      Math.max(a[0], b[0]) > bxMin + 0.5 &&
      Math.min(a[0], b[0]) < bxMax - 0.5
    );
  };
  const hitsVerticalBand = (a: Point, b: Point, band: VerticalBand, fallbackMinY: number, fallbackMaxY: number) => {
    const byMin = band.minY ?? fallbackMinY;
    const byMax = band.maxY ?? fallbackMaxY;
    return (
      Math.abs(a[0] - b[0]) < 1 &&
      a[0] > band.minX + 0.01 &&
      a[0] < band.maxX - 0.01 &&
      Math.max(a[1], b[1]) > byMin + 0.5 &&
      Math.min(a[1], b[1]) < byMax - 0.5
    );
  };
  const hitsAvoidBand = (a: Point, b: Point) =>
    Boolean(
      (avoidHorizontalBand && hitsBand(a, b, avoidHorizontalBand, bandMinX, bandMaxX)) ||
      (extraAvoidBands?.length && extraAvoidBands.some((band) => hitsBand(a, b, band, bandMinX, bandMaxX)))
    );
  const hitsAvoidVerticalBand = (a: Point, b: Point) =>
    Boolean(
      options?.extraAvoidVerticalBands?.length &&
      options.extraAvoidVerticalBands.some((band) => hitsVerticalBand(a, b, band, bandMinY, bandMaxY))
    );
  // Prevent horizontal search steps along endpoint rows from folding back across the source/target body.
  const crossesEndpointBody = (a: Point, b: Point) => {
    if (Math.abs(a[1] - b[1]) >= 1) return false;
    const segMinX = Math.min(a[0], b[0]);
    const segMaxX = Math.max(a[0], b[0]);
    if (Math.abs(a[1] - source[1]) < 1) {
      if (sourceSide === 'right' && segMaxX >= source[0] && segMinX < source[0] + 6) return true;
      if (sourceSide === 'left' && segMinX <= source[0] && segMaxX > source[0] - 6) return true;
    }
    if (Math.abs(a[1] - target[1]) < 1) {
      if (targetSide === 'left' && segMinX <= target[0] && segMaxX > target[0] - 6) return true;
      if (targetSide === 'right' && segMaxX >= target[0] && segMinX < target[0] + 6) return true;
    }
    return false;
  };
  const hasBlockedPathSegment = (pts: Point[], checkVerticalBands = true) =>
    pts.some((p, i) => {
      if (i === 0) return false;
      const a = pts[i - 1];
      if (segmentBlocked(a, p, obstacles)) return true;
      // Terminal departure/arrival stubs naturally sit at sourceY/targetY (or shared handle X) on multi-segment detours.
      const isTerminalStub = pts.length >= 4 && (i === 1 || i === pts.length - 1);
      return !isTerminalStub && (hitsAvoidBand(a, p) || (checkVerticalBands && hitsAvoidVerticalBand(a, p)));
    });

  if (!hasBlockedPathSegment(original, true)) return candidate;

  const extraBandYs = extraAvoidBands?.length
    ? extraAvoidBands.flatMap((b) => [b.minY - 1, b.maxY + 1])
    : [];
  const originalInteriorPts = original.slice(1, -1);
  const maxStubDist = Math.min(100, Math.floor(Math.abs(target[0] - source[0]) * 0.45));
  const shiftStubOutOfVerticalBands = (anchor: Point, side: string, initialStub: Point): Point => {
    if (
      (side !== 'left' && side !== 'right') ||
      !options?.extraAvoidVerticalBands?.length ||
      maxStubDist <= 18
    ) {
      return initialStub;
    }
    const y = initialStub[1];
    const activeBands = options.extraAvoidVerticalBands.filter((b) => {
      const byMin = b.minY ?? bandMinY;
      const byMax = b.maxY ?? bandMaxY;
      return byMax > y - 0.5 && byMin < y + 0.5;
    });
    const inBand = (x: number) => activeBands.some((b) => x > b.minX + 0.01 && x < b.maxX - 0.01);
    if (!inBand(initialStub[0])) return initialStub;

    const dir = side === 'left' ? -1 : 1;
    const candidates = activeBands
      .flatMap((b) => [b.minX, b.maxX])
      .filter((x) => {
        const dist = (x - anchor[0]) * dir;
        return dist >= 18 && dist <= maxStubDist && !inBand(x);
      })
      .sort((a, b) => Math.abs(a - initialStub[0]) - Math.abs(b - initialStub[0]));

    for (const candX of candidates) {
      const candPt: Point = [candX, y];
      if (!segmentBlocked(anchor, candPt, obstacles)) {
        return candPt;
      }
    }
    return initialStub;
  };
  const runSearch = (useVerticalBands: boolean): Point[] | undefined => {
    const searchStart = useVerticalBands ? shiftStubOutOfVerticalBands(source, sourceSide, start) : start;
    const searchEnd = useVerticalBands ? shiftStubOutOfVerticalBands(target, targetSide, end) : end;
    const extraBandXs =
      useVerticalBands && options?.extraAvoidVerticalBands?.length
        ? options.extraAvoidVerticalBands.flatMap((b) => [b.minX, b.maxX])
        : [];
    const xs = [
      ...new Set([
        searchStart[0],
        searchEnd[0],
        ...originalInteriorPts.map((p) => p[0]),
        ...obstacles.flatMap((r) => [
          r.x - xMargin,
          r.x - xMargin - 14,
          r.x + r.width + xMargin,
          r.x + r.width + xMargin + 14,
        ]),
        ...extraBandXs,
      ]),
    ].sort((a, b) => a - b);
    const ys = [
      ...new Set([
        searchStart[1],
        searchEnd[1],
        ...originalInteriorPts.map((p) => p[1]),
        ...obstacles.flatMap((r) => [
          r.y - margin,
          r.y - margin - 14,
          r.y + r.height + margin,
          r.y + r.height + margin + 14,
        ]),
        ...extraBandYs,
      ]),
    ].sort((a, b) => a - b);
    const width = xs.length;
    const index = (p: Point) => ys.indexOf(p[1]) * width + xs.indexOf(p[0]);
    const point = (i: number): Point => [xs[i % width], ys[Math.floor(i / width)]];
    const isBlocked = (a: Point, b: Point) =>
      segmentBlocked(a, b, obstacles) ||
      hitsAvoidBand(a, b) ||
      (useVerticalBands && hitsAvoidVerticalBand(a, b)) ||
      crossesEndpointBody(a, b);
    // State includes arrival direction so bend penalties do not discard better routes.
    const startKey = index(searchStart) * 3;
    const costs = new Map<number, number>([[startKey, 0]]);
    const previous = new Map<number, number>();
    const pending = new Set([startKey]);
    const horizDirs: ReadonlyArray<[number, number, number]> =
      options?.detourSide === 'right'
        ? [[1, 0, 1], [-1, 0, 1]]
        : [[-1, 0, 1], [1, 0, 1]];
    let final: number | undefined;
    while (pending.size) {
      let current = -1, best = Infinity;
      for (const key of pending) {
        const p = point(Math.floor(key / 3));
        const score = costs.get(key)! + Math.abs(p[0] - searchEnd[0]) + Math.abs(p[1] - searchEnd[1]);
        if (score < best) { best = score; current = key; }
      }
      pending.delete(current);
      const i = Math.floor(current / 3), direction = current % 3;
      if (i === index(searchEnd)) { final = current; break; }
      const x = i % width, y = Math.floor(i / width);
      for (const [dx, dy, nextDirection] of [...horizDirs, [0, -1, 2], [0, 1, 2]]) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= ys.length) continue;
        const nextIndex = ny * width + nx, a = point(i), b = point(nextIndex);
        if (isBlocked(a, b)) continue;
        const key = nextIndex * 3 + nextDirection;
        const sideBias =
          options?.detourSide === 'right' && b[0] < searchStart[0] && a[0] >= searchStart[0]
            ? 0.5
            : options?.detourSide === 'left' && b[0] > searchStart[0] && a[0] <= searchStart[0]
              ? 0.5
              : 0;
        const cost =
          costs.get(current)! +
          Math.abs(a[0] - b[0]) +
          Math.abs(a[1] - b[1]) +
          (direction && direction !== nextDirection ? 24 : 0) +
          sideBias;
        if (cost >= (costs.get(key) ?? Infinity)) continue;
        costs.set(key, cost); previous.set(key, current); pending.add(key);
      }
    }
    if (final === undefined) return undefined;
    const points: Point[] = [];
    for (let key: number | undefined = final; key !== undefined; key = previous.get(key)) points.unshift(point(Math.floor(key / 3)));
    points.unshift(source); points.push(target);
    if (hasBlockedPathSegment(points, useVerticalBands)) return undefined;
    return points;
  };

  let points = runSearch(true);
  if (!points && options?.extraAvoidVerticalBands?.length) {
    points = runSearch(false);
  }
  if (!points) return candidate; // Overlapping manually placed cards may have no valid exit.
  // Remove collinear grid vertices and place the label on the longest segment.
  const simplified = points.filter((p, i) => i === 0 || i === points.length - 1 ||
    !((points[i - 1][0] === p[0] && p[0] === points[i + 1][0]) || (points[i - 1][1] === p[1] && p[1] === points[i + 1][1])));
  let label: Point = source, longest = -1;
  simplified.slice(1).forEach((p, i) => {
    const a = simplified[i], length = Math.abs(p[0] - a[0]) + Math.abs(p[1] - a[1]);
    if (length > longest) { longest = length; label = [(a[0] + p[0]) / 2, (a[1] + p[1]) / 2]; }
  });
  return [simplified.map((p, i) => `${i ? 'L' : 'M'} ${p[0]} ${p[1]}`).join(' '), ...label];
}
