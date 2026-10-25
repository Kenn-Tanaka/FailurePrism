import { describe, expect, it } from 'vitest';
import { getOrthogonalStepPath } from './layout';
import { pathPoints, routingOffset, segmentBlocked } from './edgeRouting';
import { CROSS_LANE_SOURCE_HANDLE_Y, CROSS_LANE_TARGET_HANDLE_Y } from './edgeHandles';

describe('shared canvas and SVG routing', () => {
  it('uses the swapped handle heights when routing a bottom-to-top cross-lane edge', () => {
    const nodeHeight = 200;
    const points = pathPoints(getOrthogonalStepPath({
      sourceX: 260,
      sourceY: 200 + nodeHeight * CROSS_LANE_SOURCE_HANDLE_Y,
      targetX: 760,
      targetY: 50 + nodeHeight * CROSS_LANE_TARGET_HANDLE_Y,
      sourcePosition: 'right',
      targetPosition: 'left',
      sourceNodeHeight: nodeHeight,
    })[0]);

    expect(points[0]).toEqual([260, 276]);
    expect(points.at(-1)).toEqual([760, 174]);
    expect(points[2][1]).toBe(155);
  });

  it('uses the swapped source height when routing a top-to-bottom cross-lane edge', () => {
    const nodeHeight = 200;
    const points = pathPoints(getOrthogonalStepPath({
      sourceX: 260,
      sourceY: 100 + nodeHeight * CROSS_LANE_SOURCE_HANDLE_Y,
      targetX: 760,
      targetY: 300 + nodeHeight * CROSS_LANE_TARGET_HANDLE_Y,
      sourcePosition: 'right',
      targetPosition: 'left',
      sourceNodeHeight: nodeHeight,
    })[0]);

    expect(points[0]).toEqual([260, 176]);
    expect(points.at(-1)).toEqual([760, 424]);
    expect(points[2][1]).toBe(345);
  });

  it('separates overlapping inter-lane trunks', () => {
    const edges = [{ id: 'one' }, { id: 'two' }, { id: 'three' }];
    const paths = edges.map((edge) => getOrthogonalStepPath({
      sourceX: 260, sourceY: 400, targetX: 380, targetY: 100,
      sourcePosition: 'right', targetPosition: 'left', routeOffset: routingOffset(edge.id, edges),
    })[0]);
    expect(new Set(paths).size).toBe(3);
  });

  it('routes around an intermediate card without changing the endpoint sides', () => {
    const obstacles = [
      { x: 0, y: 350, width: 260, height: 200 },
      { x: 380, y: 200, width: 260, height: 260 },
      { x: 760, y: 0, width: 260, height: 200 },
    ];
    const points = pathPoints(getOrthogonalStepPath({
      sourceX: 260, sourceY: 474, targetX: 760, targetY: 76,
      sourcePosition: 'right', targetPosition: 'left', sourceNodeHeight: 200, obstacles,
    })[0]);
    expect(points[0]).toEqual([260, 474]);
    expect(points.at(-1)).toEqual([760, 76]);
    expect(points[1][0]).toBeGreaterThan(260);
    expect(points.at(-2)![0]).toBeLessThan(760);
    points.slice(1).forEach((point, i) => {
      expect(point[0] === points[i][0] || point[1] === points[i][1]).toBe(true);
      expect(segmentBlocked(points[i], point, obstacles)).toBe(false);
    });
  });

  it('keeps top/bottom connections vertical at manually offset cards', () => {
    const points = pathPoints(getOrthogonalStepPath({ sourceX: 200, sourceY: 400,
      targetX: 290, targetY: 100, sourcePosition: 'top', targetPosition: 'bottom' })[0]);
    expect(points[1][0]).toBe(200);
    expect(points.at(-2)![0]).toBe(290);
  });
});
