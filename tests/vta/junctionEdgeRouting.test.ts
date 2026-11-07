import { describe, expect, it } from 'vitest';
import { getOrthogonalStepPath } from '../../src/tools/vta/features/vta/utils/layout';
import { getDisplayRect, getEdgeAnchor, routingObstacles, OBJECT_JUNCTION_SIZE } from '../../src/tools/vta/features/vta/utils/nodeGeometry';
import type { VTAReactFlowNode } from '../../src/tools/vta/types/vta';

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
});
