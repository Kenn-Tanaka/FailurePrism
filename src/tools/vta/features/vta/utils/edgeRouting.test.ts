import { describe, expect, it } from 'vitest';
import { auditVTALayoutGeometry, calculateVTALayout, getOrthogonalStepPath, resolveVTAEdgePaths } from './layout';
import {
  avoidCards,
  EDGE_HORIZONTAL_CLEARANCE_Y,
  EDGE_VERTICAL_CLEARANCE_X,
  pathPoints,
  rectsOverlap,
  routingOffset,
  segmentBlocked,
  segmentsFromPoints,
} from './edgeRouting';
import { computeEdgeBadgeRects } from './edgeLabels';
import { CROSS_LANE_HANDLE_Y } from './edgeHandles';
import { getDisplayRect, type NodeRect } from './nodeGeometry';
import type { VTAReactFlowEdge, VTASchema } from '../../../types/vta';

describe('shared canvas and SVG routing', () => {
  it('uses unified 50% side handle heights when routing a bottom-to-top cross-lane edge', () => {
    const nodeHeight = 200;
    const points = pathPoints(getOrthogonalStepPath({
      sourceX: 260,
      sourceY: 200 + nodeHeight * CROSS_LANE_HANDLE_Y,
      targetX: 760,
      targetY: 50 + nodeHeight * CROSS_LANE_HANDLE_Y,
      sourcePosition: 'right',
      targetPosition: 'left',
      sourceNodeHeight: nodeHeight,
    })[0]);

    expect(points[0]).toEqual([260, 300]);
    expect(points.at(-1)).toEqual([760, 150]);
    expect(points[2][1]).toBe(155);
  });

  it('uses unified 50% side handle heights when routing a top-to-bottom cross-lane edge', () => {
    const nodeHeight = 200;
    const points = pathPoints(getOrthogonalStepPath({
      sourceX: 260,
      sourceY: 100 + nodeHeight * CROSS_LANE_HANDLE_Y,
      targetX: 760,
      targetY: 300 + nodeHeight * CROSS_LANE_HANDLE_Y,
      sourcePosition: 'right',
      targetPosition: 'left',
      sourceNodeHeight: nodeHeight,
    })[0]);

    expect(points[0]).toEqual([260, 200]);
    expect(points.at(-1)).toEqual([760, 400]);
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

  it('connects same-height multi-lane nodes directly when clear of intermediate nodes', () => {
    const [path, labelX, labelY] = getOrthogonalStepPath({
      sourceX: 260,
      sourceY: 200,
      targetX: 1020,
      targetY: 200,
      sourcePosition: 'right',
      targetPosition: 'left',
      laneDistance: 3,
      obstacles: [{ x: 380, y: 0, width: 260, height: 120 }],
    });
    expect(path).toBe('M 260 200 L 1020 200');
    expect(labelX).toBe(640);
    expect(labelY).toBe(200);
  });
});

function makeRect(x: number, y: number, width = 260, height = 140, isHidden = false): NodeRect {
  return { x, y, width, height, isHidden };
}

function makeEdge(
  id: string,
  source: string,
  target: string,
  opts: Partial<VTAReactFlowEdge> & { data?: Record<string, unknown> } = {}
): VTAReactFlowEdge {
  const isCross = opts.data?.is_cross_lane ?? true;
  return {
    id,
    source,
    target,
    sourceHandle: opts.sourceHandle ?? (isCross ? 'right' : 'top'),
    targetHandle: opts.targetHandle ?? (isCross ? 'left' : 'bottom'),
    type: 'vtaEdge',
    data: {
      is_break: false,
      direction: isCross ? 'unidirectional' : 'sequential',
      is_cross_lane: isCross,
      laneDistance: isCross ? 2 : 0,
      ...opts.data,
    },
  };
}

describe('resolveVTAEdgePaths same-height cross-lane direct routing', () => {
  it('draws multi-lane same-height connections straight when clear, and detours when an intermediate card blocks them', () => {
    const rects = new Map<string, NodeRect>([
      ['a', makeRect(0, 200)],
      ['c', makeRect(760, 200)],
    ]);
    const clearEdges = [makeEdge('e_ac', 'a', 'c', { data: { laneDistance: 2, label: '連絡' } })];
    const clearPaths = resolveVTAEdgePaths(clearEdges, rects);
    expect(clearPaths.get('e_ac')).toEqual(['M 260 270 L 760 270', 510, 270]);

    const blockedRects = new Map<string, NodeRect>([
      ...rects,
      ['b_mid', makeRect(380, 200)],
    ]);
    const blockedPaths = resolveVTAEdgePaths(clearEdges, blockedRects);
    const pts = pathPoints(blockedPaths.get('e_ac')![0]);
    expect(pts.length).toBe(6);
    expect(pts.slice(1).every((pt, i) => !segmentBlocked(pts[i], pt, [blockedRects.get('b_mid')!]))).toBe(true);
  });

  it('considers label/BREAK height clearance against intermediate lane nodes in narrow gaps', () => {
    // Intermediate lane has two stacked cards leaving a 30px vertical gap centered at y = 270 (255..285)
    const rects = new Map<string, NodeRect>([
      ['a', makeRect(0, 200)],
      ['b_top', makeRect(380, 115, 260, 140)],
      ['b_bot', makeRect(380, 285, 260, 140)],
      ['c', makeRect(760, 200)],
    ]);

    // Standard single pill (24px tall) fits inside the 30px gap (255..285)
    const normalResolved = resolveVTAEdgePaths(
      [makeEdge('e_norm', 'a', 'c', { data: { laneDistance: 2, label: '確認' } })],
      rects
    );
    expect(normalResolved.get('e_norm')?.[0]).toBe('M 260 270 L 760 270');

    // BREAK + secondary label extends to midY + 33 (270 + 33 = 303 > b_bot.y = 285) -> must detour
    const breakResolved = resolveVTAEdgePaths(
      [makeEdge('e_brk', 'a', 'c', { data: { laneDistance: 2, label: '遮断', is_break: true } })],
      rects
    );
    expect(pathPoints(breakResolved.get('e_brk')![0]).length).toBeGreaterThan(2);
  });

  it('detours the second edge when opposite-direction edges occupy the same height in multi-lane or adjacent Case 2a', () => {
    const multiRects = new Map<string, NodeRect>([
      ['a', makeRect(0, 200)],
      ['c', makeRect(760, 200)],
    ]);
    const multiEdges = [
      makeEdge('e_1', 'a', 'c', { data: { laneDistance: 2, label: '往信' } }),
      makeEdge('e_2', 'c', 'a', {
        sourceHandle: 'left',
        targetHandle: 'right',
        data: { laneDistance: 2, label: '返信' },
      }),
    ];
    const multiResolved = resolveVTAEdgePaths(multiEdges, multiRects);
    expect(multiResolved.get('e_1')?.[0]).toBe('M 260 270 L 760 270');
    expect(pathPoints(multiResolved.get('e_2')![0]).length).toBeGreaterThan(2);
    expect(multiResolved.get('e_2')![2]).toBeLessThan(200);

    // Adjacent Case 2a opposite-direction pair: shorter-ID straight, reverse bypasses overhead without degenerate flat line
    const adjRects = new Map<string, NodeRect>([
      ['a', makeRect(0, 200)],
      ['b', makeRect(380, 200)],
    ]);
    const adjEdges = [
      makeEdge('e_a', 'a', 'b', { data: { laneDistance: 1, label: '指示' } }),
      makeEdge('e_b', 'b', 'a', {
        sourceHandle: 'left',
        targetHandle: 'right',
        data: { laneDistance: 1, label: '報告' },
      }),
    ];
    const adjResolved = resolveVTAEdgePaths(adjEdges, adjRects);
    expect(adjResolved.get('e_a')?.[0]).toBe('M 260 270 L 380 270');
    const adjDetourPts = pathPoints(adjResolved.get('e_b')![0]);
    expect(adjDetourPts.length).toBe(6);
    expect(adjResolved.get('e_b')![2]).toBeLessThan(200);
  });

  it('does not block a direct line due to another edge sharing the same side handle stub', () => {
    const rects = new Map<string, NodeRect>([
      ['a', makeRect(0, 200)],
      ['b_up', makeRect(380, 0)],
      ['c', makeRect(760, 200)],
    ]);
    const edges = [
      makeEdge('e_ab', 'a', 'b_up', { data: { laneDistance: 1, label: '上昇' } }),
      makeEdge('e_ac', 'a', 'c', { data: { laneDistance: 2, label: '水平' } }),
    ];
    const resolved = resolveVTAEdgePaths(edges, rects);
    expect(resolved.get('e_ac')?.[0]).toBe('M 260 270 L 760 270');
  });

  it('applies policy alpha for vertical crossings: keeps straight over unavoidable continuous lines, detours when avoidable', () => {
    // Full-height vertical timeline V spans y = 140..440 (crosses both y=270 straight and y=155 corridor)
    const continuousRects = new Map<string, NodeRect>([
      ['a', makeRect(0, 200)],
      ['b_low', makeRect(380, 440)],
      ['b_high', makeRect(380, 0)],
      ['c', makeRect(760, 200)],
    ]);
    const continuousEdges = [
      makeEdge('v_full', 'b_low', 'b_high', {
        sourceHandle: 'top',
        targetHandle: 'bottom',
        data: { is_cross_lane: false, laneDistance: 0 },
      }),
      makeEdge('e_ac', 'a', 'c', { data: { laneDistance: 2, label: '横断' } }),
    ];
    const continuousResolved = resolveVTAEdgePaths(continuousEdges, continuousRects);
    expect(continuousResolved.get('e_ac')?.[0]).toBe('M 260 270 L 760 270');

    // Avoidable vertical trunk stopping at y = 260 (Wait: goes DOWN from small lower-corridor node at y = 300..440 to y = 550)
    // Wait: trunk at x=700 connects Lane 1 lower (0..140? no below 270) to Lane 2 lower, stopping at y=285 while corridorY=155.
    const avoidableRects = new Map<string, NodeRect>([
      ['a', makeRect(0, 200)],
      ['b_low', makeRect(380, 460)],
      ['c_low', makeRect(760, 285, 260, 140)],
      ['d', makeRect(1140, 200)],
    ]);
    // b_low (y=530) -> c_low (y=355): Case 2b vertical stem at midX = 700 spans y = 355..530; wait let's put trunk across y=270..530 ending ABOVE/BELOW corridorY=155
    // Specifically: trunk in channel x=700 spanning y=240..530 crosses S at y=270 (under S's label at midX=700!) while stopping below corridorY=155!
    avoidableRects.set('c_low', makeRect(760, 170, 260, 140)); // center y = 240, crosses y=270? No, Card c_low overlaps straight wire if in x=760..1020 at y=240!
    // Instead put a hidden junction node off-axis or span crossing x=700 cleanly without hitting a card at y=270:
    // Lower card in Lane 1 at y=480 (center 550) -> card in Lane 2 at y=290? That only spans 360..550 (below 270).
    // Card in Lane 1 at y=460 -> Card in Lane 2 at y=250..260 (bottom=390) with height=40 -> center=270 would touch; height=30 at y=240 -> center=255!
    // Put c_trunk as an already-placed cross-lane corridor or small Case 2b ending at y=240 (16px above straight y=270? bottom=260, clear of y=270):
    avoidableRects.set('c_low', { x: 760, y: 230, width: 260, height: 32, isHidden: false }); // center = 246 (vertical stem x=700 runs y = 246..530, crossing y=270 right at S's label midX=700!)
    avoidableRects.set('d', makeRect(1140, 200)); // straight a->d runs 260..1140 at y=270; c_low bottom is 262 -> 8px clear of 270 (and outside label X=700±40 vs 760)!
    const avoidableEdges = [
      makeEdge('e_trunk', 'b_low', 'c_low', { data: { laneDistance: 1 } }),
      makeEdge('e_ad', 'a', 'd', { data: { laneDistance: 3, label: '横断' } }),
    ];
    const avoidableResolved = resolveVTAEdgePaths(avoidableEdges, avoidableRects);
    // e_ad crosses e_trunk vertical stem at (700, 270) AND its label hits it, whereas corridorY=155 completely avoids y=246..530!
    expect(pathPoints(avoidableResolved.get('e_ad')![0]).length).toBeGreaterThan(2);
    expect(avoidableResolved.get('e_ad')![2]).toBeLessThan(200);
  });

  it('keeps straight line when a vertical sequential edge joins the same junction endpoint', () => {
    const rects = new Map<string, NodeRect>([
      ['a', makeRect(0, 200)],
      ['j', { x: 878, y: 258, width: 24, height: 24, isHidden: true, isObjectJunction: true }],
      ['j_below', makeRect(760, 440)],
    ]);
    const edges = [
      makeEdge('v_j', 'j_below', 'j', {
        sourceHandle: 'top',
        targetHandle: 'bottom',
        data: { is_cross_lane: false, laneDistance: 0 },
      }),
      makeEdge('e_aj', 'a', 'j', { data: { laneDistance: 2, label: '到達' } }),
    ];
    const resolved = resolveVTAEdgePaths(edges, rects);
    expect(resolved.get('e_aj')?.[0]).toBe('M 260 270 L 890 270');
  });

  it('shifts only vertical-line labels off intersecting horizontal wires and badges while keeping horizontal lines straight', () => {
    // Vertical Case 2b dependency edge at x=320 spans y=70..470; horizontal e_ac crosses at y=270.
    // Both straight horizontal line stays crisp AND vertical label shifts off y=270!
    const rectsCross = new Map<string, NodeRect>([
      ['a_top', makeRect(0, 0)],
      ['a', makeRect(0, 200)],
      ['b_low', makeRect(380, 400)],
      ['c_dot', { x: 878, y: 258, width: 24, height: 24, isHidden: true, isObjectJunction: true }],
    ]);
    const crossEdges = [
      makeEdge('e_dep', 'a_top', 'b_low', { data: { laneDistance: 1, label: '作業依存' } }),
      makeEdge('e_ac', 'a', 'c_dot', { data: { laneDistance: 2, label: '情報' } }),
    ];
    const resolved = resolveVTAEdgePaths(crossEdges, rectsCross);
    expect(resolved.get('e_ac')?.[0]).toBe('M 260 270 L 890 270');
    const depTuple = resolved.get('e_dep')!;
    const depVertX = pathPoints(depTuple[0])[1][0];
    expect(depTuple[1]).toBe(depVertX);
    expect(Math.abs(depTuple[2] - 270)).toBeGreaterThanOrEqual(20);

    // Same-midpoint vertical Case 2b badge + adjacent horizontal badge:
    // horizontal line stays straight and vertical badge shifts away from (320, 270) so badges do not collide.
    const rectsShortCross = new Map<string, NodeRect>([
      ['a_top', makeRect(0, 0)],
      ['a', makeRect(0, 200)],
      ['b', makeRect(380, 200)],
      ['b_low', makeRect(380, 400)],
    ]);
    const resolvedShortCross = resolveVTAEdgePaths(
      [
        makeEdge('e_dep', 'a_top', 'b_low', { data: { laneDistance: 1, label: '作業依存' } }),
        makeEdge('e_ab', 'a', 'b', { data: { laneDistance: 1, label: '連絡' } }),
      ],
      rectsShortCross
    );
    expect(resolvedShortCross.get('e_ab')?.[0]).toBe('M 260 270 L 380 270');
    expect(Math.abs(resolvedShortCross.get('e_dep')![2] - 270)).toBeGreaterThanOrEqual(24);

    // Horizontal-vs-horizontal badge collision at same midpoint STILL detours the second horizontal edge.
    const horizRects = new Map<string, NodeRect>([
      ['a', makeRect(0, 200)],
      ['b', makeRect(380, 200)],
    ]);
    const resolvedHorizPair = resolveVTAEdgePaths(
      [
        makeEdge('e_1', 'a', 'b', { data: { laneDistance: 1, label: '指示' } }),
        makeEdge('e_2', 'a', 'b', { data: { laneDistance: 1, label: '連絡' } }),
      ],
      horizRects
    );
    expect(resolvedHorizPair.get('e_1')?.[0]).toBe('M 260 270 L 380 270');
    expect(pathPoints(resolvedHorizPair.get('e_2')![0]).length).toBeGreaterThan(2);

    // Unobstructed vertical edge with no horizontal crossings keeps centered 50% Y.
    const resolvedCleanVert = resolveVTAEdgePaths(
      [makeEdge('e_dep_only', 'a_top', 'b_low', { data: { laneDistance: 1, label: '作業依存' } })],
      rectsCross
    );
    expect(resolvedCleanVert.get('e_dep_only')?.[2]).toBe(270);
  });

  it('matches SVG export paths via calculateVTALayout + generateVTASVG', async () => {
    const { generateVTASVG } = await import('./svgExport');
    const schema: VTASchema = {
      lanes: ['L0', 'L1', 'L2'],
      nodes: [
        {
          id: 'n0',
          lane: 'L0',
          time: '09:00',
          title: '開始',
          description: '',
          type: 'normal',
          measure_type: null,
          position: { x: 110, y: 200 },
          compact_position: { x: 110, y: 200 },
        },
        {
          id: 'n2',
          lane: 'L2',
          time: '09:00',
          title: '対向',
          description: '',
          type: 'normal',
          measure_type: null,
          position: { x: 870, y: 200 },
          compact_position: { x: 870, y: 200 },
        },
      ],
      edges: [
        { id: 'e_1', source: 'n0', target: 'n2', direction: 'unidirectional', label: '往路' },
        { id: 'e_2', source: 'n2', target: 'n0', direction: 'unidirectional', label: '復路' },
      ],
    };
    const layout = calculateVTALayout(schema);
    const rects = new Map(layout.nodes.map((n) => [n.id, getDisplayRect(n)]));
    const canvasPaths = resolveVTAEdgePaths(layout.edges, rects);
    const svg = generateVTASVG(schema, layout.nodes, layout.edges, layout.laneBounds);

    const e1SvgMatch = svg.match(/id="edge_e_1"[\s\S]*?<path d="([^"]+)"/);
    const e2SvgMatch = svg.match(/id="edge_e_2"[\s\S]*?<path d="([^"]+)"/);
    expect(e1SvgMatch).toBeTruthy();
    expect(e2SvgMatch).toBeTruthy();
    expect(pathPoints(canvasPaths.get('e_1')![0])).toHaveLength(2);
    expect(pathPoints(e1SvgMatch![1])).toHaveLength(2);
    expect(pathPoints(canvasPaths.get('e_2')![0]).length).toBeGreaterThan(2);
    expect(pathPoints(e2SvgMatch![1]).length).toBe(pathPoints(canvasPaths.get('e_2')![0]).length);
  });

  it('separates Pass 1 multi-lane corridor wires, vertical stems, card margins, and horizontal badges', () => {
    const rects = new Map<string, NodeRect>([
      ['a_top', makeRect(0, 40)],
      ['a_mid', makeRect(0, 270)],
      ['c_bot', makeRect(760, 500)],
      ['c_top', makeRect(760, 40)],
    ]);
    const edges = [
      makeEdge('e1', 'a_top', 'c_bot', { data: { laneDistance: 2, label: '情報' } }),
      makeEdge('e2', 'a_mid', 'c_bot', { data: { laneDistance: 2, label: '情報' } }),
      makeEdge('e3', 'a_mid', 'c_top', { data: { laneDistance: 2, label: '情報' } }),
    ];
    const resolved = resolveVTAEdgePaths(edges, rects);

    const allHoriz: Array<{ id: string; y: number; minX: number; maxX: number }> = [];
    const allVert: Array<{ id: string; x: number; minY: number; maxY: number }> = [];
    const allBadges: Array<{ id: string; rect: { x: number; y: number; width: number; height: number } }> = [];

    for (const edge of edges) {
      const tuple = resolved.get(edge.id)!;
      const pts = pathPoints(tuple[0]);
      expect(pts[1][0] - 260).toBeGreaterThanOrEqual(18);
      expect(760 - pts.at(-2)![0]).toBeGreaterThanOrEqual(18);
      for (const seg of segmentsFromPoints(pts)) {
        if (seg.horizontal && seg.index > 0 && seg.index < pts.length - 2) {
          allHoriz.push({ id: edge.id, y: seg.a[1], minX: seg.minX, maxX: seg.maxX });
        }
        if (seg.vertical) {
          allVert.push({ id: edge.id, x: seg.a[0], minY: seg.minY, maxY: seg.maxY });
        }
      }
      const bRects = computeEdgeBadgeRects({
        labelX: tuple[1],
        labelY: tuple[2],
        isBreak: false,
        orientation: 'right',
        labelContent: { displayLabel: '情報', fullText: '情報' },
      });
      bRects.forEach((rect) => allBadges.push({ id: edge.id, rect }));
    }

    for (let i = 0; i < allHoriz.length; i++) {
      for (let j = i + 1; j < allHoriz.length; j++) {
        const overlapX = Math.min(allHoriz[i].maxX, allHoriz[j].maxX) - Math.max(allHoriz[i].minX, allHoriz[j].minX);
        if (overlapX > 1) {
          expect(Math.abs(allHoriz[i].y - allHoriz[j].y)).toBeGreaterThanOrEqual(EDGE_HORIZONTAL_CLEARANCE_Y);
        }
      }
    }

    for (let i = 0; i < allVert.length; i++) {
      for (let j = i + 1; j < allVert.length; j++) {
        const overlapY = Math.min(allVert[i].maxY, allVert[j].maxY) - Math.max(allVert[i].minY, allVert[j].minY);
        if (overlapY > 1) {
          expect(Math.abs(allVert[i].x - allVert[j].x)).toBeGreaterThanOrEqual(EDGE_VERTICAL_CLEARANCE_X);
        }
      }
    }

    for (let i = 0; i < allBadges.length; i++) {
      for (let j = i + 1; j < allBadges.length; j++) {
        expect(rectsOverlap(allBadges[i].rect, allBadges[j].rect)).toBe(false);
      }
    }
  });

  it('separates adjacent Case 2b vertical channels by >= EDGE_VERTICAL_CLEARANCE_X', () => {
    const rects = new Map<string, NodeRect>([
      ['a_top', makeRect(0, 40)],
      ['a_bot', makeRect(0, 440)],
      ['b_top', makeRect(380, 40)],
      ['b_bot', makeRect(380, 440)],
    ]);
    const edges = [
      makeEdge('e1', 'a_top', 'b_bot', { data: { laneDistance: 1, label: '指示' } }),
      makeEdge('e2', 'a_bot', 'b_top', { data: { laneDistance: 1, label: '報告' } }),
    ];
    const resolved = resolveVTAEdgePaths(edges, rects);
    const x1 = pathPoints(resolved.get('e1')![0])[1][0];
    const x2 = pathPoints(resolved.get('e2')![0])[1][0];
    expect(Math.abs(x1 - x2)).toBeGreaterThanOrEqual(EDGE_VERTICAL_CLEARANCE_X);
  });

  it('keeps >= EDGE_HORIZONTAL_CLEARANCE_Y separation when multiple edges trigger avoidCards around the same tall card', () => {
    const rects = new Map<string, NodeRect>([
      ['a1', makeRect(0, 200)],
      ['a2', makeRect(0, 420)],
      // Tall obstacle blocking direct and default corridor paths between Lane 0 and Lane 2
      ['mid_tall', makeRect(380, 120, 260, 480)],
      ['c1', makeRect(760, 200)],
      ['c2', makeRect(760, 420)],
    ]);
    const edges = [
      makeEdge('relation:R12', 'a1', 'c1', { data: { laneDistance: 2, label: '情報' } }),
      makeEdge('relation:proposal:p1', 'a2', 'c2', { data: { laneDistance: 2, label: '情報' } }),
    ];
    const resolved = resolveVTAEdgePaths(edges, rects);
    const h1 = segmentsFromPoints(pathPoints(resolved.get('relation:R12')![0])).filter(
      (s) => s.horizontal && s.length > 40
    );
    const h2 = segmentsFromPoints(pathPoints(resolved.get('relation:proposal:p1')![0])).filter(
      (s) => s.horizontal && s.length > 40
    );
    expect(h1.length).toBeGreaterThan(0);
    expect(h2.length).toBeGreaterThan(0);
    for (const s1 of h1) {
      for (const s2 of h2) {
        const overlapX = Math.min(s1.maxX, s2.maxX) - Math.max(s1.minX, s2.minX);
        if (overlapX > 1) {
          expect(Math.abs(s1.a[1] - s2.a[1])).toBeGreaterThanOrEqual(EDGE_HORIZONTAL_CLEARANCE_Y);
        }
      }
    }
  });

  it('separates multiple overlapping non-adjacent intra-lane semantic edges across left/right/outer bypass tracks (ADR-0062)', () => {
    const schema: VTASchema = {
      lanes: ['A機乗組員'],
      nodes: [
        { id: 'c1', lane: 'A機乗組員', title: '出発準備', description: '', time: '17:30', type: 'normal', measure_type: null, sequence_order: 0 },
        { id: 'c2', lane: 'A機乗組員', title: 'C1進入報告', description: '', time: '17:43', type: 'normal', measure_type: null, sequence_order: 1 },
        { id: 'c3', lane: 'A機乗組員', title: 'C5停止指示復唱', description: '', time: '17:45', type: 'variation', measure_type: null, sequence_order: 2 },
        { id: 'c4', lane: 'A機乗組員', title: '滑走路進入', description: '', time: '17:46', type: 'variation', measure_type: null, sequence_order: 3 },
        { id: 'c5', lane: 'A機乗組員', title: '衝突', description: '', time: '17:47', type: 'outcome', measure_type: null, sequence_order: 4 },
      ],
      edges: [
        { id: 'seq_1_2', source: 'c1', target: 'c2', direction: 'sequential', is_break: false },
        { id: 'seq_2_3', source: 'c2', target: 'c3', direction: 'sequential', is_break: false },
        { id: 'seq_3_4', source: 'c3', target: 'c4', direction: 'sequential', is_break: false },
        { id: 'seq_4_5', source: 'c4', target: 'c5', direction: 'sequential', is_break: false },
        // Overlapping non-adjacent intra-lane semantic edges (reproducing R20 & rel_ref_M2 + 3rd enclosing span)
        { id: 'relation:R20', relationId: 'R20', source: 'c2', target: 'c4', direction: 'unidirectional', label: '作業依存', category: 'dependency', is_break: false },
        { id: 'relation:rel_ref_M2', relationId: 'rel_ref_M2', source: 'c1', target: 'c3', direction: 'unidirectional', label: '情報', category: 'information', is_break: false },
        { id: 'relation:rel_ref_M3', relationId: 'rel_ref_M3', source: 'c1', target: 'c5', direction: 'unidirectional', label: '影響', category: 'impact', is_break: false },
      ],
    };

    const layout = calculateVTALayout(schema);
    const audit = auditVTALayoutGeometry(schema, layout);

    expect(audit.closeParallelVerticalEdges).toEqual([]);
    expect(audit.closeParallelHorizontalEdges).toEqual([]);
    expect(audit.overlappingEdgeBadges).toEqual([]);

    const rects = new Map<string, NodeRect>(layout.nodes.map((n) => [n.id, getDisplayRect(n)]));
    const paths = resolveVTAEdgePaths(layout.edges, rects);
    const cardX = rects.get('c1')!.x;
    const cardRight = cardX + rects.get('c1')!.width;

    // 1st shortest span (R20) keeps baseline left 30px track; 2nd (rel_ref_M2) takes right 30px track; 3rd takes outer left 46px track
    const r20Pts = pathPoints(paths.get('relation:R20')![0]);
    const m2Pts = pathPoints(paths.get('relation:rel_ref_M2')![0]);
    const m3Pts = pathPoints(paths.get('relation:rel_ref_M3')![0]);
    expect(r20Pts[2][0]).toBe(cardX - 30);
    expect(m2Pts[2][0]).toBe(cardRight + 30);
    expect(m3Pts[2][0]).toBe(cardX - 46);
  });

  it('separates vertical stems in avoidCards via extraAvoidVerticalBands and falls back without card collisions when over-constrained', () => {
    const obstacles = [{ x: 380, y: 120, width: 260, height: 300 }];
    const base = avoidCards(
      ['M 260 270 L 760 270', 510, 270],
      obstacles,
      'right',
      'left',
      0,
      undefined,
      undefined,
      undefined,
      { sourceMargin: 30 }
    );
    const baseVertX = segmentsFromPoints(pathPoints(base[0])).find((s) => s.vertical)!.a[0];

    const avoided = avoidCards(
      ['M 260 270 L 760 270', 510, 270],
      obstacles,
      'right',
      'left',
      0,
      undefined,
      undefined,
      undefined,
      {
        sourceMargin: 30,
        extraAvoidVerticalBands: [{ minX: baseVertX - EDGE_VERTICAL_CLEARANCE_X, maxX: baseVertX + EDGE_VERTICAL_CLEARANCE_X, minY: 60, maxY: 460 }],
      }
    );
    const avoidedVerts = segmentsFromPoints(pathPoints(avoided[0])).filter((s) => s.vertical);
    expect(avoidedVerts.length).toBeGreaterThan(0);
    for (const seg of avoidedVerts) {
      expect(Math.abs(seg.a[0] - baseVertX)).toBeGreaterThanOrEqual(EDGE_VERTICAL_CLEARANCE_X);
    }

    // Over-constraining vertical bands must still fall back to a card-free route instead of returning the blocked straight line.
    const fallback = avoidCards(
      ['M 260 270 L 760 270', 510, 270],
      obstacles,
      'right',
      'left',
      0,
      undefined,
      undefined,
      undefined,
      {
        extraAvoidVerticalBands: [{ minX: -1000, maxX: 2000, minY: -1000, maxY: 2000 }],
      }
    );
    const fallbackPts = pathPoints(fallback[0]);
    expect(fallbackPts.length).toBeGreaterThan(2);
    expect(fallbackPts.slice(1).every((pt, i) => !segmentBlocked(fallbackPts[i], pt, obstacles))).toBe(true);
  });

  it('keeps >= EDGE_VERTICAL_CLEARANCE_X separation between vertical stems when multiple avoidCards detours bypass a tall intermediate card', () => {
    const rects = new Map<string, NodeRect>([
      ['card_a_top', makeRect(0, 60)],
      ['card_21', makeRect(0, 280)],
      ['mid_tall', makeRect(380, 60, 260, 420)],
      ['card_84', { x: 878, y: 338, width: 24, height: 24, isHidden: true, isObjectJunction: true }],
    ]);
    const edges = [
      makeEdge('relation:R11', 'card_a_top', 'card_84', { data: { laneDistance: 2, label: '指示' } }),
      makeEdge('shared:E29:card_21:card_84', 'card_21', 'card_84', {
        data: { laneDistance: 2, direction: 'undirected', meaning: 'association' },
      }),
    ];
    const resolved = resolveVTAEdgePaths(edges, rects);
    const v1 = segmentsFromPoints(pathPoints(resolved.get('relation:R11')![0])).filter((s) => s.vertical);
    const v2 = segmentsFromPoints(pathPoints(resolved.get('shared:E29:card_21:card_84')![0])).filter((s) => s.vertical);
    expect(v1.length).toBeGreaterThan(0);
    expect(v2.length).toBeGreaterThan(0);
    for (const s1 of v1) {
      for (const s2 of v2) {
        const yOverlap = Math.min(s1.maxY, s2.maxY) - Math.max(s1.minY, s2.minY);
        if (yOverlap > 1) {
          expect(Math.abs(s1.a[0] - s2.a[0])).toBeGreaterThanOrEqual(EDGE_VERTICAL_CLEARANCE_X);
        }
      }
    }

    const dummyNodes: VTASchema['nodes'] = [
      { id: 'card_a_top', lane: 'L0', title: '上段', description: '', time: '17:43', type: 'normal', measure_type: null, position: { x: 0, y: 60 }, compact_position: { x: 0, y: 60 } },
      { id: 'card_21', lane: 'L0', title: '下段', description: '', time: '17:45', type: 'normal', measure_type: null, position: { x: 0, y: 280 }, compact_position: { x: 0, y: 280 } },
      { id: 'mid_tall', lane: 'L1', title: '中間障害', description: '', time: '17:44', type: 'normal', measure_type: null, position: { x: 380, y: 60 }, compact_position: { x: 380, y: 60 } },
      { id: 'card_84', lane: 'L2', title: '客体', description: '', time: '17:45', type: 'normal', measure_type: null, entity_role: 'object', object_display_style: 'dot', position: { x: 878, y: 338 }, compact_position: { x: 878, y: 338 } },
    ];
    const layoutNodes = dummyNodes.map((n) => ({
      id: n.id,
      type: n.id === 'card_84' ? 'vtaObjectJunction' : 'vtaNode',
      position: n.position!,
      width: n.id === 'card_84' ? 24 : 260,
      height: n.id === 'card_84' ? 24 : n.id === 'mid_tall' ? 420 : 140,
      measured: n.id === 'mid_tall' ? { width: 260, height: 420 } : undefined,
      data: n,
    }));
    const audit = auditVTALayoutGeometry(
      { lanes: ['L0', 'L1', 'L2'], nodes: dummyNodes, edges: [] },
      { nodes: layoutNodes as never, edges, laneBounds: [], width: 1140, height: 600 }
    );
    expect(audit.closeParallelVerticalEdges).toEqual([]);
  });

  it('maintains >= EDGE_VERTICAL_CLEARANCE_X and >= 18px card margin when multiple shared-source edges exit leftward across mixed-height and same-height targets (ADR-0070)', () => {
    // Reproduces anomaly_1 (card_34 on Lane 5 at x=2010 -> card_32 on Lane 3 same-height outcome & card_22 on Lane 4 taller variation)
    const rects = new Map<string, NodeRect>([
      ['card_22', makeRect(1630, 520, 260, 190)], // Lane 4 (right edge 1890, center 615 != 602.5 -> Pass 1)
      ['card_32', makeRect(1250, 532.5, 260, 140)], // Lane 3 (center 602.5 == 602.5 -> Pass 2, blocked by card_22)
      ['card_10', makeRect(870, 532.5, 260, 140)], // Lane 2 (3rd shared-source edge)
      ['card_34', makeRect(2010, 532.5, 260, 140)], // Lane 5 (left edge 2010, center 602.5)
    ]);
    const edges = [
      makeEdge('relation:proposal:569ec21e', 'card_34', 'card_32', {
        sourceHandle: 'left',
        targetHandle: 'right',
        data: { laneDistance: 2, label: '影響', sourceLane: '当該列車運転士', targetLane: 'H・I・J作業員' },
      }),
      makeEdge('relation:added_6dba8df1', 'card_34', 'card_22', {
        sourceHandle: 'left',
        targetHandle: 'right',
        data: { laneDistance: 1, label: '影響', sourceLane: '当該列車運転士', targetLane: 'G現場代理人' },
      }),
      makeEdge('relation:extra_impact', 'card_34', 'card_10', {
        sourceHandle: 'left',
        targetHandle: 'right',
        data: { laneDistance: 3, label: '影響', sourceLane: '当該列車運転士', targetLane: '除草薬散布作業班' },
      }),
    ];

    const dummyNodes: VTASchema['nodes'] = [
      { id: 'card_10', lane: '除草薬散布作業班', title: '被災1', description: '', time: '10:46', type: 'outcome', measure_type: null, position: { x: 870, y: 532.5 } },
      { id: 'card_32', lane: 'H・I・J作業員', title: '被災2', description: '', time: '10:46', type: 'outcome', measure_type: null, position: { x: 1250, y: 532.5 } },
      { id: 'card_22', lane: 'G現場代理人', title: '現場対応', description: '', time: '10:46', type: 'variation', measure_type: null, position: { x: 1630, y: 520 } },
      { id: 'card_34', lane: '当該列車運転士', title: '列車触車', description: '', time: '10:46', type: 'outcome', measure_type: null, position: { x: 2010, y: 532.5 } },
    ];
    const layoutNodes = dummyNodes.map((n) => {
      const r = rects.get(n.id)!;
      return {
        id: n.id,
        type: 'vtaNode',
        position: { x: r.x, y: r.y },
        width: r.width,
        height: r.height,
        measured: { width: r.width, height: r.height },
        data: { ...n, measuredHeight: r.height },
      };
    });

    const audit = auditVTALayoutGeometry(
      {
        lanes: ['除草薬散布作業班', 'H・I・J作業員', 'G現場代理人', '当該列車運転士'],
        nodes: dummyNodes,
        edges: [],
      },
      { nodes: layoutNodes as never, edges, laneBounds: [], width: 2400, height: 900 }
    );
    expect(audit.closeParallelVerticalEdges).toEqual([]);
    expect(audit.closeParallelHorizontalEdges).toEqual([]);
    expect(audit.overlappingEdgeBadges).toEqual([]);

    const resolved = resolveVTAEdgePaths(edges, rects);
    for (const edge of edges) {
      const pts = pathPoints(resolved.get(edge.id)![0]);
      // Departure stub from card_34 left border (x=2010) must preserve >= 18px clearance
      expect(2010 - pts[1][0]).toBeGreaterThanOrEqual(18);
    }

    // Direct avoidCards check: same-height avoidHorizontalBand + start trapped inside extraAvoidVerticalBands escapes without falling back onto the forbidden X band
    const trapped = avoidCards(
      ['M 2010 602.5 L 1980 602.5 L 1980 477 L 1540 477 L 1540 602.5 L 1510 602.5', 1760, 477],
      [{ x: 1630, y: 520, width: 260, height: 190 }],
      'left',
      'right',
      0,
      { minY: 602.5 - EDGE_HORIZONTAL_CLEARANCE_Y, maxY: 602.5 + EDGE_HORIZONTAL_CLEARANCE_Y },
      30,
      undefined,
      {
        sourceMargin: 30,
        extraAvoidVerticalBands: [{ minX: 1992 - EDGE_VERTICAL_CLEARANCE_X, maxX: 1992 + EDGE_VERTICAL_CLEARANCE_X, minY: 477, maxY: 615 }],
      }
    );
    const trappedVerts = segmentsFromPoints(pathPoints(trapped[0])).filter((s) => s.vertical);
    expect(trappedVerts.length).toBeGreaterThan(0);
    for (const seg of trappedVerts) {
      if (Math.min(seg.maxY, 615) - Math.max(seg.minY, 477) > 1) {
        expect(Math.abs(seg.a[0] - 1992)).toBeGreaterThanOrEqual(EDGE_VERTICAL_CLEARANCE_X);
      }
    }
  });
});
