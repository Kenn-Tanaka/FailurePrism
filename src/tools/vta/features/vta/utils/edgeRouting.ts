export interface RoutingRect { x: number; y: number; width: number; height: number }
type Point = [number, number];

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

export function pathPoints(path: string): Point[] {
  const values = path.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)?.map(Number) ?? [];
  return Array.from({ length: values.length / 2 }, (_, i) => [values[i * 2], values[i * 2 + 1]]);
}

/** Search an orthogonal visibility grid only when the normal corridor hits a card. */
export function avoidCards(
  candidate: [string, number, number], obstacles: RoutingRect[],
  sourceSide = 'top', targetSide = 'bottom', offset = 0,
): [string, number, number] {
  const original = pathPoints(candidate[0]);
  if (!original.some((p, i) => i > 0 && segmentBlocked(original[i - 1], p, obstacles))) return candidate;
  const source = original[0], target = original[original.length - 1];
  const margin = 30 + offset;
  const stub = (p: Point, side: string): Point => [
    p[0] + (side === 'left' ? -margin : side === 'right' ? margin : 0),
    p[1] + (side === 'top' ? -margin : side === 'bottom' ? margin : 0),
  ];
  const start = stub(source, sourceSide), end = stub(target, targetSide);
  const xs = [...new Set([start[0], end[0], ...obstacles.flatMap((r) => [r.x - margin, r.x + r.width + margin])])].sort((a, b) => a - b);
  const ys = [...new Set([start[1], end[1], ...obstacles.flatMap((r) => [r.y - margin, r.y + r.height + margin])])].sort((a, b) => a - b);
  const width = xs.length;
  const index = (p: Point) => ys.indexOf(p[1]) * width + xs.indexOf(p[0]);
  const point = (i: number): Point => [xs[i % width], ys[Math.floor(i / width)]];
  // State includes arrival direction so bend penalties do not discard better routes.
  const startKey = index(start) * 3;
  const costs = new Map<number, number>([[startKey, 0]]);
  const previous = new Map<number, number>();
  const pending = new Set([startKey]);
  let final: number | undefined;
  while (pending.size) {
    let current = -1, best = Infinity;
    for (const key of pending) {
      const p = point(Math.floor(key / 3));
      const score = costs.get(key)! + Math.abs(p[0] - end[0]) + Math.abs(p[1] - end[1]);
      if (score < best) { best = score; current = key; }
    }
    pending.delete(current);
    const i = Math.floor(current / 3), direction = current % 3;
    if (i === index(end)) { final = current; break; }
    const x = i % width, y = Math.floor(i / width);
    for (const [nx, ny, nextDirection] of [[x - 1, y, 1], [x + 1, y, 1], [x, y - 1, 2], [x, y + 1, 2]]) {
      if (nx < 0 || nx >= width || ny < 0 || ny >= ys.length) continue;
      const nextIndex = ny * width + nx, a = point(i), b = point(nextIndex);
      if (segmentBlocked(a, b, obstacles)) continue;
      const key = nextIndex * 3 + nextDirection;
      const cost = costs.get(current)! + Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + (direction && direction !== nextDirection ? 24 : 0);
      if (cost >= (costs.get(key) ?? Infinity)) continue;
      costs.set(key, cost); previous.set(key, current); pending.add(key);
    }
  }
  if (final === undefined) return candidate; // Overlapping manually placed cards may have no valid exit.
  const points: Point[] = [];
  for (let key: number | undefined = final; key !== undefined; key = previous.get(key)) points.unshift(point(Math.floor(key / 3)));
  points.unshift(source); points.push(target);
  if (points.some((p, i) => i > 0 && segmentBlocked(points[i - 1], p, obstacles))) return candidate;
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
