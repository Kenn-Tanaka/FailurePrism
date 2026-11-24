import { describe, expect, it } from 'vitest';
import { calculateVTALayout, getOrthogonalStepPath, resolveVTAEdgePaths } from '../../src/tools/vta/features/vta/utils/layout';
import { getDisplayRect, getEdgeAnchor, projectDisplayNode, routingObstacles, OBJECT_JUNCTION_SIZE } from '../../src/tools/vta/features/vta/utils/nodeGeometry';
import { pathPoints } from '../../src/tools/vta/features/vta/utils/edgeRouting';
import { generateVTASVG } from '../../src/tools/vta/features/vta/utils/svgExport';
import {
  buildAnalysis,
  projectAnalysis,
  sourceFromText,
  validateEvents,
  validateFacts,
  validateParticipants,
} from '../../src/tools/vta/features/vta/utils/eventAnalysis';
import type { VTAReactFlowNode, VTASchema } from '../../src/tools/vta/types/vta';

describe('ADR-0014: Junction Edge Routing & Smooth Arrival', () => {
  it('correctly sets isHidden and isObjectJunction in getDisplayRect for object junction nodes', () => {
    const rawObjectNode: VTAReactFlowNode = {
      id: 'node_dot',
      type: 'vtaNode',
      position: { x: 500, y: 300 },
      data: {
        id: 'node_dot',
        lane: '受動部門',
        time: '17:46',
        type: 'normal',
        title: '受信客体',
        description: '受動的客体',
        entity_role: 'object',
        object_display_style: 'dot',
        measure_type: null,
      },
    };

    const rect = getDisplayRect(rawObjectNode);
    expect(rect.isHidden).toBe(true);
    expect(rect.isObjectJunction).toBe(true);
    expect(rect.width).toBe(OBJECT_JUNCTION_SIZE);
    expect(rect.height).toBe(OBJECT_JUNCTION_SIZE);

    // ドットの中心座標がアンカーとして計算されること
    const anchor = getEdgeAnchor(rect, 'left', false);
    expect(anchor.x).toBe(rect.x + OBJECT_JUNCTION_SIZE / 2);
    expect(anchor.y).toBe(rect.y + OBJECT_JUNCTION_SIZE / 2);

    // すでに project 済みのノードを渡しても二重オフセットされないこと
    const projectedNode: VTAReactFlowNode = {
      ...rawObjectNode,
      type: 'vtaObjectJunction',
      position: { x: rect.x, y: rect.y },
      width: OBJECT_JUNCTION_SIZE,
      height: OBJECT_JUNCTION_SIZE,
    };
    const rect2 = getDisplayRect(projectedNode);
    expect(rect2.x).toBe(rect.x);
    expect(rect2.y).toBe(rect.y);
  });

  it('excludes source and target nodes from routingObstacles to avoid self-collision and unnatural stubs', () => {
    const rects = new Map([
      ['node_src', { x: 100, y: 300, width: 260, height: 140, isHidden: false }],
      ['node_tgt', { x: 500, y: 300, width: 24, height: 24, isHidden: true, isObjectJunction: true }],
      ['node_obstacle', { x: 300, y: 100, width: 260, height: 140, isHidden: false }],
    ]);

    const obstacles = routingObstacles(rects, 'node_src', 'node_tgt');
    // node_src と node_tgt は絶対に障害物リストに入らないこと
    expect(obstacles.length).toBe(1);
    expect(obstacles[0].x).toBe(300);
  });

  it('routes cleanly to junction without unnatural 30px crank before dot', () => {
    // ソースカード (x: 100, y: 200, width: 260, height: 140) -> 右端 x=360, y=253.2
    // ターゲットドット (中心 x=700, y=253.2)
    // 水平同じ高さの場合
    const [sameHeightPath] = getOrthogonalStepPath({
      sourceX: 360,
      sourceY: 253.2,
      targetX: 700,
      targetY: 253.2,
      sourcePosition: 'right',
      targetPosition: 'left',
      laneDistance: 1,
      targetIsJunction: true,
    });
    // 同一高さなら余計なクランクなく直進接続されること
    expect(sameHeightPath).toBe('M 360 253.2 L 700 253.2');

    // 高さの異なる多レーン接続（Case 2c: 2レーン跨ぎ）
    // ソース: x=100, y=400 (下側) -> ターゲットドット: x=860, y=200 (上側)
    const [multiLanePath] = getOrthogonalStepPath({
      sourceX: 360,
      sourceY: 400,
      targetX: 860,
      targetY: 200,
      sourcePosition: 'right',
      targetPosition: 'left',
      laneDistance: 2,
      targetIsJunction: true,
      verticalGap: 90,
      sourceNodeHeight: 140,
    });

    // 終端手前での垂直移動位置が targetX - 30 (830) ではなく、
    // レーン境界付近（targetX - 70〜120、約750〜790）で曲がり、
    // ドットの手前数十px以上がまっすぐ水平な進入直線になっていること
    expect(multiLanePath).toContain('L 860 200');
    // 手前30px (830) で曲がっていないこと
    expect(multiLanePath).not.toContain('L 830 200');
  });

  it('aligns passive object dots to same-rank card centers and draws straight lines across adjacent and skipped lanes', () => {
    const source = sourceFromText('09:00 主体Aが受動客体へ指示を送った。\n09:10 受動客体が次の作業を実施した。');
    const facts = validateFacts(
      {
        facts: [
          { id: 'f1', text: '主体Aが受動客体へ指示を送った', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p1', quote: '09:00 主体Aが受動客体へ指示を送った。' }] },
          { id: 'f2', text: '受動客体が次の作業を実施した', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p2', quote: '09:10 受動客体が次の作業を実施した。' }] },
        ],
      },
      [source]
    );
    const events = validateEvents(
      {
        events: [
          { id: 'e1', title: '指示発出', description: '主体Aから受動客体への詳細な伝達内容を記載し高さを確保', time: '09:00', factIds: ['f1'] },
          { id: 'e2', title: '次作業', description: '後続処理', time: '09:10', factIds: ['f2'] },
        ],
      },
      facts
    );
    const parsed = validateParticipants(
      {
        entities: [
          { id: 'ent_sub', name: '指示元', kind: 'person' },
          { id: 'ent_mid', name: '中間確認', kind: 'person' },
          { id: 'ent_obj', name: '受動先', kind: 'person' },
        ],
        participations: [
          { eventId: 'e1', entityId: 'ent_sub', role: 'actor', factIds: ['f1'] },
          { eventId: 'e1', entityId: 'ent_obj', role: 'target', factIds: ['f1'] },
          { eventId: 'e2', entityId: 'ent_obj', role: 'actor', factIds: ['f2'] },
          { eventId: 'e2', entityId: 'ent_mid', role: 'actor', factIds: ['f2'] },
        ],
        relations: [
          { id: 'r1', kind: 'transfer', sourceEventId: 'e1', sourceEntityId: 'ent_sub', targetEventId: 'e1', targetEntityId: 'ent_obj', factIds: ['f1'] },
        ],
        cardGroups: [],
      },
      events,
      facts
    );
    const baseSchema = projectAnalysis(buildAnalysis(source, facts, events, parsed));
    // Reorder lanes so ent_sub (left) -> ent_obj (right) spans across empty Rank 0 in ent_mid
    const schema: VTASchema = {
      ...baseSchema,
      lanes: ['指示元', '中間確認', '受動先'],
    };

    const layout = calculateVTALayout(schema);
    const rects = new Map(layout.nodes.map((node) => [node.id, getDisplayRect(node)]));
    const edge = layout.edges.find((e) => e.source !== e.target && e.data?.is_cross_lane)!;
    const srcRect = rects.get(edge.source)!;
    const tgtRect = rects.get(edge.target)!;

    expect(tgtRect.isObjectJunction).toBe(true);
    expect(srcRect.y + srcRect.height / 2).toBeCloseTo(tgtRect.y + tgtRect.height / 2, 5);

    const projectedDot = projectDisplayNode(layout.nodes.find((n) => n.id === edge.target)!);
    expect(projectedDot.type).toBe('vtaObjectJunction');
    expect(projectedDot.position.y + OBJECT_JUNCTION_SIZE / 2).toBeCloseTo(srcRect.y + srcRect.height / 2, 5);

    const resolved = resolveVTAEdgePaths(layout.edges, rects);
    const [canvasPath] = resolved.get(edge.id)!;
    expect(pathPoints(canvasPath)).toHaveLength(2);

    const svg = generateVTASVG(schema, layout.nodes, layout.edges, layout.laneBounds);
    const svgMatch = svg.match(new RegExp(`id="edge_${edge.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[\\s\\S]*?<path d="([^"]+)"`));
    expect(svgMatch?.[1]).toBeTruthy();
    expect(pathPoints(svgMatch![1])).toHaveLength(2);
  });

  it('aligns hidden junction dots to same-rank card centers even without analysis and draws straight lines', () => {
    const schema: VTASchema = {
      lanes: ['左', '右'],
      nodes: [
        { id: 'l', lane: '左', time: '09:00', title: '作業A', description: '', type: 'normal', measure_type: null },
        { id: 'r', lane: '右', time: '09:00', title: '接続点R', description: '', type: 'normal', measure_type: null, is_hidden: true },
      ],
      edges: [
        { id: 'e_lr', source: 'l', target: 'r', direction: 'bidirectional', label: '確認' },
      ],
    };

    const layout = calculateVTALayout(schema);
    const rects = new Map(layout.nodes.map((node) => [node.id, getDisplayRect(node)]));
    const srcRect = rects.get('l')!;
    const tgtRect = rects.get('r')!;
    expect(tgtRect.isHidden).toBe(true);
    expect(srcRect.y + srcRect.height / 2).toBeCloseTo(tgtRect.y + tgtRect.height / 2, 5);

    const resolved = resolveVTAEdgePaths(layout.edges, rects);
    expect(pathPoints(resolved.get('e_lr')![0])).toHaveLength(2);
  });

  it('preserves 110px horizontal junction approach on forced detours and avoidCards grid searches', () => {
    // 1. corridorY=155 is clear of top row cards (y=0..140); avoidHorizontalBand must not shrink
    // the 110px junction approach stub to margin=30+offset (18px).
    const [detourPath] = getOrthogonalStepPath({
      sourceX: 260,
      sourceY: 270,
      targetX: 890,
      targetY: 270,
      sourcePosition: 'right',
      targetPosition: 'left',
      sourceNodeHeight: 140,
      sourceNodeTop: 200,
      laneDistance: 2,
      routeOffset: -12,
      targetIsJunction: true,
      forceCorridorDetour: true,
      obstacles: [
        { x: 380, y: 0, width: 260, height: 140 },
        { x: 760, y: 0, width: 260, height: 140 },
      ],
    });
    const detourPts = pathPoints(detourPath);
    expect(detourPts.length).toBe(6);
    expect(890 - detourPts[detourPts.length - 2][0]).toBe(110);

    // 2. When an upper card actually blocks corridorY=155 and triggers avoidCards grid search,
    // the junction approach still stays 110px instead of 18px.
    const [gridPath] = getOrthogonalStepPath({
      sourceX: 260,
      sourceY: 270,
      targetX: 890,
      targetY: 270,
      sourcePosition: 'right',
      targetPosition: 'left',
      sourceNodeHeight: 140,
      sourceNodeTop: 200,
      laneDistance: 2,
      routeOffset: -12,
      targetIsJunction: true,
      forceCorridorDetour: true,
      obstacles: [
        { x: 380, y: 100, width: 260, height: 100 },
        { x: 380, y: 200, width: 260, height: 140 },
      ],
    });
    const gridPts = pathPoints(gridPath);
    expect(gridPts.length).toBeGreaterThanOrEqual(4);
    expect(gridPts[gridPts.length - 1]).toEqual([890, 270]);
    expect(gridPts[gridPts.length - 2][1]).toBe(270);
    expect(890 - gridPts[gridPts.length - 2][0]).toBeGreaterThanOrEqual(70);
  });
});
