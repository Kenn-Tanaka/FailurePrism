import { describe, it, expect } from 'vitest';
import {
  auditVTALayoutGeometry,
  computeTimeRanks,
  calculateVTALayout,
  getOrthogonalStepPath,
  resolveVTAEdgePaths,
  estimateNodeHeight,
  enforceLaneVerticalSpacing,
  LANE_WIDTH,
  NODE_WIDTH,
  VERTICAL_STEP,
  VERTICAL_GAP,
  INTRA_RANK_GAP,
} from './layout';
import { getDisplayRect } from './nodeGeometry';
import { pathPoints } from './edgeRouting';
import { VTASchema, VTAReactFlowNode } from '../../../types/vta';

describe('layout.ts - VTA Layout Engine', () => {
  it('uses compact saved coordinates without reflowing them during rendering', () => {
    const schema: VTASchema = {
      lanes: ['A'],
      nodes: [
        { id: 'a', lane: 'A', time: '10:00', title: 'A', description: '', type: 'normal', measure_type: null, position: { x: 10, y: 20 }, compact_position: { x: 310, y: 120 } },
        { id: 'b', lane: 'A', time: '11:00', title: 'B', description: '', type: 'normal', measure_type: null, position: { x: 10, y: 500 }, compact_position: { x: 310, y: 420 } },
      ], edges: [],
    };
    const layout = calculateVTALayout(schema, undefined, undefined, { compact: true, positionField: 'compact_position' });
    expect(layout.nodes.map((node) => node.position)).toEqual([{ x: 310, y: 120 }, { x: 310, y: 420 }]);
  });

  it('keeps an existing compact coordinate when other nodes have none yet', () => {
    const schema: VTASchema = { lanes: ['A'], nodes: [
      { id: 'a', lane: 'A', time: '10:00', title: 'A', description: '', type: 'normal', measure_type: null, compact_position: { x: 310, y: 100 } },
      { id: 'b', lane: 'A', time: '11:00', title: 'B', description: '', type: 'normal', measure_type: null },
    ], edges: [] };
    const layout = calculateVTALayout(schema, undefined, undefined, { compact: true, positionField: 'compact_position' });
    expect(layout.nodes.find((node) => node.id === 'a')?.position).toEqual({ x: 310, y: 100 });
  });

  it('does not move a saved detailed coordinate while loading other nodes', () => {
    const schema: VTASchema = { lanes: ['A'], nodes: [
      { id: 'a', lane: 'A', time: '10:00', title: 'A', description: '', type: 'normal', measure_type: null, position: { x: 300, y: 100 } },
      { id: 'b', lane: 'A', time: '11:00', title: 'B', description: '', type: 'normal', measure_type: null },
    ], edges: [] };
    expect(calculateVTALayout(schema).nodes.find((node) => node.id === 'a')?.position).toEqual({ x: 300, y: 100 });
  });

  describe('computeTimeRanks', () => {
    it('should chronologically order nodes with explicit timestamps and relative times', () => {
      const schema: VTASchema = {
        lanes: ['設計部', '製造部'],
        nodes: [
          { id: 'n3', lane: '製造部', time: '当日朝', title: '作業開始', description: '', type: 'normal', measure_type: null },
          { id: 'n1', lane: '設計部', time: '2ヶ月前', title: '設計変更', description: '', type: 'variation', measure_type: null },
          { id: 'n2', lane: '設計部', time: '前日', title: '指示書発行', description: '', type: 'normal', measure_type: null },
        ],
        edges: [],
      };

      const rankMap = computeTimeRanks(schema);

      // n1 (2ヶ月前) < n2 (前日) < n3 (当日朝)
      expect(rankMap.get('n1')).toBe(0);
      expect(rankMap.get('n2')).toBe(1);
      expect(rankMap.get('n3')).toBe(2);
    });

    it('should assign identical ranks to nodes with identical timestamps', () => {
      const schema: VTASchema = {
        lanes: ['A部門', 'B部門'],
        nodes: [
          { id: 'n1', lane: 'A部門', time: '10:00', title: '点呼', description: '', type: 'normal', measure_type: null },
          { id: 'n2', lane: 'B部門', time: '10:00', title: '確認', description: '', type: 'normal', measure_type: null },
        ],
        edges: [],
      };

      const rankMap = computeTimeRanks(schema);
      expect(rankMap.get('n1')).toBe(rankMap.get('n2'));
    });

    it('should enforce causal DAG constraint (target rank >= source rank + 1)', () => {
      // n1 and n2 have the same or reversed natural time, but an edge n1 -> n2 exists
      const schema: VTASchema = {
        lanes: ['A部門'],
        nodes: [
          { id: 'n1', lane: 'A部門', time: '10:00', title: '原因作業', description: '', type: 'variation', measure_type: null },
          { id: 'n2', lane: 'A部門', time: '10:00', title: '結果事象', description: '', type: 'variation', measure_type: null },
        ],
        edges: [
          { source: 'n1', target: 'n2', is_break: false, direction: 'sequential' },
        ],
      };

      const rankMap = computeTimeRanks(schema);
      const r1 = rankMap.get('n1')!;
      const r2 = rankMap.get('n2')!;
      expect(r2).toBeGreaterThanOrEqual(r1 + 1);
    });
  });

  describe('calculateVTALayout', () => {
    it('should arrange nodes from Bottom to Top (earlier rank has larger Y, later rank has smaller Y)', () => {
      const schema: VTASchema = {
        lanes: ['開発部'],
        nodes: [
          { id: 'n1', lane: '開発部', time: '発端', title: '原因作業', description: '', type: 'normal', measure_type: null },
          { id: 'n2', lane: '開発部', time: '発生時', title: '最終不具合', description: '', type: 'variation', measure_type: null },
        ],
        edges: [{ source: 'n1', target: 'n2', is_break: false }],
      };

      const layout = calculateVTALayout(schema);
      const node1 = layout.nodes.find((n) => n.id === 'n1')!;
      const node2 = layout.nodes.find((n) => n.id === 'n2')!;

      // Bottom-to-Top: n1 (earlier) must be below n2 (later), meaning node1.y > node2.y
      expect(node1.position.y).toBeGreaterThan(node2.position.y);
      expect(layout.laneBounds.length).toBe(1);
      expect(layout.laneBounds[0].name).toBe('開発部');
    });

    it('should correctly configure cross-lane edge handles and directions', () => {
      const schema: VTASchema = {
        lanes: ['左部門', '右部門'],
        nodes: [
          { id: 'n1', lane: '左部門', time: '09:00', title: '連絡発信', description: '', type: 'normal', measure_type: null },
          { id: 'n2', lane: '右部門', time: '09:00', title: '連絡受信', description: '', type: 'normal', measure_type: null },
        ],
        edges: [{ source: 'n1', target: 'n2', is_break: false }],
      };

      const layout = calculateVTALayout(schema);
      const edge = layout.edges[0];

      expect(edge.data?.is_cross_lane).toBe(true);
      // Left lane to Right lane
      expect(edge.sourceHandle).toBe('right');
      expect(edge.targetHandle).toBe('left');
      expect(edge.data?.direction).toBe('unidirectional');
    });

    it('should configure intra-lane edge handles as top and bottom', () => {
      const schema: VTASchema = {
        lanes: ['製造部'],
        nodes: [
          { id: 'n1', lane: '製造部', time: '09:00', title: '前工程', description: '', type: 'normal', measure_type: null },
          { id: 'n2', lane: '製造部', time: '10:00', title: '後工程', description: '', type: 'normal', measure_type: null },
        ],
        edges: [{ source: 'n1', target: 'n2', is_break: false }],
      };

      const layout = calculateVTALayout(schema);
      const edge = layout.edges[0];

      expect(edge.data?.is_cross_lane).toBe(false);
      expect(edge.sourceHandle).toBe('top');
      expect(edge.targetHandle).toBe('bottom');
    });
  });

  describe('getOrthogonalStepPath', () => {
    it('should return straight vertical line for intra-lane nodes', () => {
      const [path, labelX, labelY] = getOrthogonalStepPath({
        sourceX: 200,
        sourceY: 400,
        targetX: 200,
        targetY: 200,
      });

      expect(path).toBe('M 200 400 L 200 200');
      expect(labelX).toBe(200);
      expect(labelY).toBe(300);
    });

    it('should return 3-segment orthogonal path for adjacent lanes', () => {
      // Adjacent lanes: distance between side handles is around 120px (LANE_WIDTH - NODE_WIDTH)
      const sourceX = 300;
      const sourceY = 400;
      const targetX = 420;
      const targetY = 200;

      const [path, labelX, labelY] = getOrthogonalStepPath({
        sourceX,
        sourceY,
        targetX,
        targetY,
        sourcePosition: 'right',
        targetPosition: 'left',
      });

      const midX = (sourceX + targetX) / 2;
      expect(path).toBe(`M 300 400 L ${midX} 400 L ${midX} 200 L 420 200`);
      expect(labelX).toBe(midX);
      expect(labelY).toBe(300);
    });

    it('should return 5-segment obstacle-free path for multi-lane spanning', () => {
      // 2 lanes apart: spanX >= 400px
      const sourceX = 200;
      const sourceY = 500;
      const targetX = 700;
      const targetY = 200;

      const [path] = getOrthogonalStepPath({
        sourceX,
        sourceY,
        targetX,
        targetY,
        sourcePosition: 'right',
        targetPosition: 'left',
      });

      // Must be a 5-segment path with corridor routing: M ... L ... L ... L ... L ... L ...
      const lCommands = path.match(/L/g) || [];
      expect(lCommands.length).toBe(5);
    });

    it('should guarantee at least VERTICAL_GAP (90px) between adjacent ranks with long text cards (UI-001)', () => {
      // Recreating the exact user scenario from the reported issue:
      // Upper card (17:45:25, long title + long description)
      // Lower card (17:45:14, long title + long description)
      const schema: VTASchema = {
        lanes: ['A機（JA722A）'],
        nodes: [
          {
            id: 'n_upper',
            lane: 'A機（JA722A）',
            time: '17:45:25',
            title: 'チェックリストの実施と誘導路C5への進入',
            description: '機長Aが副操縦員AにBefore Takeoff Checklistの実施を指示した。A機は誘導路C5に入り、副操縦員Aはチェックリストに従い衝突防止灯を白灯にした。',
            type: 'normal',
            measure_type: 'elimination',
          },
          {
            id: 'n_lower',
            lane: 'A機（JA722A）',
            time: '17:45:14',
            title: '指示復唱および進入許可との誤認',
            description: 'A機は指示を復唱したが、機長Aはタワー東からの「No.1, taxi to holding point C5」という指示を滑走路への進入許可と認識したと口述している。',
            type: 'variation',
            measure_type: 'elimination',
          },
        ],
        edges: [
          {
            source: 'n_lower',
            target: 'n_upper',
            direction: 'sequential',
          },
        ],
      };

      const layout = calculateVTALayout(schema);
      const upper = layout.nodes.find((n) => n.id === 'n_upper')!;
      const lower = layout.nodes.find((n) => n.id === 'n_lower')!;

      // In BT (Bottom-to-Top) layout:
      // Upper card (17:45:25) is top (smaller Y).
      // Lower card (17:45:14) is bottom (larger Y).
      const upperHeight = upper.measured?.height || 140;
      const upperBottomY = upper.position.y + upperHeight;
      const lowerTopY = lower.position.y;

      // The vertical gap between the bottom of upper card and the top of lower card
      // must be AT LEAST VERTICAL_GAP (90px) to guarantee connection line visibility.
      const actualGap = lowerTopY - upperBottomY;
      expect(actualGap).toBeGreaterThanOrEqual(90);
    });

    it('should respect measured DOM heights when provided in existingNodes', () => {
      const schema: VTASchema = {
        lanes: ['管制塔'],
        nodes: [
          { id: 'n_top', lane: '管制塔', time: '12:00', title: 'Top Node', description: '', type: 'normal', measure_type: null },
          { id: 'n_bot', lane: '管制塔', time: '11:00', title: 'Bottom Node', description: '', type: 'normal', measure_type: null },
        ],
        edges: [],
      };

      // Simulate React Flow DOM measured height of 280px for top node
      const existingNodes: VTAReactFlowNode[] = [
        {
          id: 'n_top',
          type: 'vtaNode',
          position: { x: 0, y: 0 },
          measured: { width: 260, height: 280 },
          data: {
            id: 'n_top',
            lane: '管制塔',
            time: '12:00',
            description: '',
            type: 'normal',
            title: 'Top Node',
            measure_type: null,
            position: { x: 0, y: 0 },
          },
        },
      ];

      const layout = calculateVTALayout(schema, existingNodes, undefined, { forceRecompute: true });
      const topNode = layout.nodes.find((n) => n.id === 'n_top')!;
      const botNode = layout.nodes.find((n) => n.id === 'n_bot')!;

      const topBottomY = topNode.position.y + 280;
      const botTopY = botNode.position.y;

      // botTopY - topBottomY must be at least 90px
      expect(botTopY - topBottomY).toBeGreaterThanOrEqual(90);
    });

    it('should prevent vertical card overlap between adjacent ranks when multiple nodes exist in same rank (UI-001)', () => {
      // 09:00 (rank 0: 1 card), 10:00 (rank 1: 2 cards in same lane)
      const schema: VTASchema = {
        lanes: ['製造部'],
        nodes: [
          { id: 'n_0900', lane: '製造部', time: '09:00', title: '朝の作業', description: '', type: 'normal', measure_type: null },
          { id: 'n_1000_a', lane: '製造部', time: '10:00', title: '10時作業A', description: '', type: 'normal', measure_type: null },
          { id: 'n_1000_b', lane: '製造部', time: '10:00', title: '10時作業B', description: '', type: 'variation', measure_type: null },
        ],
        edges: [],
      };

      const layout = calculateVTALayout(schema);
      const n0900 = layout.nodes.find((n) => n.id === 'n_0900')!;
      const n1000A = layout.nodes.find((n) => n.id === 'n_1000_a')!;
      const n1000B = layout.nodes.find((n) => n.id === 'n_1000_b')!;

      // In BT layout, 10:00 is above 09:00, so n1000 cards have smaller Y than n0900
      const n1000AHeight = n1000A.measured?.height || 140;
      const n1000BHeight = n1000B.measured?.height || 140;
      const bottom1000Y = Math.max(n1000A.position.y + n1000AHeight, n1000B.position.y + n1000BHeight);
      const top0900Y = n0900.position.y;

      // Must guarantee at least 90px vertical gap between rank 1 and rank 0
      expect(top0900Y - bottom1000Y).toBeGreaterThanOrEqual(90);

      // Sibling cards within 10:00 must also have at least 30px gap
      const siblingGap = Math.abs(n1000B.position.y - n1000A.position.y) - Math.min(n1000AHeight, n1000BHeight);
      expect(siblingGap).toBeGreaterThanOrEqual(30);
    });

    it('should resolve manual position overlap in existingNodes via Collision Push', () => {
      const schema: VTASchema = {
        lanes: ['レーンA'],
        nodes: [
          { id: 'node_top', lane: 'レーンA', time: '10:00', title: '上のカード', description: '', type: 'normal', measure_type: null },
          { id: 'node_bottom', lane: 'レーンA', time: '09:00', title: '下のカード', description: '', type: 'normal', measure_type: null },
        ],
        edges: [],
      };

      // Manually set overlapping positions (Y=100, Y=140 with height=140 means 100px overlap!)
      const overlappingNodes: VTAReactFlowNode[] = [
        {
          id: 'node_top',
          type: 'vtaNode',
          position: { x: 100, y: 100 },
          measured: { width: 260, height: 140 },
          data: { id: 'node_top', lane: 'レーンA', title: '上のカード', position: { x: 100, y: 100 } } as any,
        },
        {
          id: 'node_bottom',
          type: 'vtaNode',
          position: { x: 100, y: 140 }, // Severe overlap
          measured: { width: 260, height: 140 },
          data: { id: 'node_bottom', lane: 'レーンA', title: '下のカード', position: { x: 100, y: 140 } } as any,
        },
      ];

      const layout = calculateVTALayout(schema, overlappingNodes);
      const top = layout.nodes.find((n) => n.id === 'node_top')!;
      const bottom = layout.nodes.find((n) => n.id === 'node_bottom')!;

      // Top bottom edge is 100 + 140 = 240
      // Bottom top edge must be >= 240 + 90 = 330
      const topHeight = top.measured?.height || 140;
      expect(bottom.position.y).toBeGreaterThanOrEqual(top.position.y + topHeight + 90);
    });
  });

  describe('estimateNodeHeight', () => {
    it('should return at least NODE_HEIGHT for short content', () => {
      const height = estimateNodeHeight({ title: '短い作業', description: '' });
      expect(height).toBeGreaterThanOrEqual(140);
    });

    it('should increase height proportionally for long multiline titles and descriptions', () => {
      const longTitle = '東京国際空港C滑走路における海上保安庁機と日本航空機の衝突事案および詳細な状況確認手順';
      const longDesc = '機長Aが副操縦員AにBefore Takeoff Checklistの実施を指示した。A機は誘導路C5に入り、副操縦員Aはチェックリストに従い衝突防止灯を白灯にした。タワー東からの指示を滑走路進入許可と誤認した。';

      const height = estimateNodeHeight({ title: longTitle, description: longDesc });
      // Should be substantially larger than 200px due to multi-line wrapping and padding
      expect(height).toBeGreaterThan(220);
    });

    it('should properly handle explicit newline characters', () => {
      const multiLineTitle = '1行目\n2行目\n3行目\n4行目';
      const height = estimateNodeHeight({ title: multiLineTitle, description: '' });
      // 4 lines of title should result in higher estimate than 1 short line
      const singleLineHeight = estimateNodeHeight({ title: '1行目のみ', description: '' });
      expect(height).toBeGreaterThan(singleLineHeight);
    });
  });

  describe('enforceLaneVerticalSpacing', () => {
    it('should push down overlapping cards to maintain VERTICAL_GAP (90px)', () => {
      const testNodes: VTAReactFlowNode[] = [
        {
          id: 'n1',
          type: 'vtaNode',
          position: { x: 0, y: 100 },
          measured: { width: 260, height: 150 },
          data: { id: 'n1', lane: 'レーン1', measuredHeight: 150, position: { x: 0, y: 100 } } as any,
        },
        {
          id: 'n2',
          type: 'vtaNode',
          position: { x: 0, y: 180 }, // Only 80px gap from top edge, so 100+150=250 > 180 (70px overlap!)
          measured: { width: 260, height: 140 },
          data: { id: 'n2', lane: 'レーン1', measuredHeight: 140, position: { x: 0, y: 180 } } as any,
        },
      ];

      const adjusted = enforceLaneVerticalSpacing(testNodes, ['レーン1']);
      const adj1 = adjusted.find((n) => n.id === 'n1')!;
      const adj2 = adjusted.find((n) => n.id === 'n2')!;

      // Top card ends at 100 + 150 = 250
      // Lower card must be pushed down to at least 250 + 90 = 340
      expect(adj2.position.y).toBeGreaterThanOrEqual(adj1.position.y + 150 + VERTICAL_GAP);
      expect(adj2.position.y).toBe(340);
    });

    it('should push down multiple chained nodes in cascade', () => {
      const testNodes: VTAReactFlowNode[] = [
        {
          id: 'n1',
          type: 'vtaNode',
          position: { x: 0, y: 50 },
          measured: { width: 260, height: 100 },
          data: { id: 'n1', lane: 'レーン1', measuredHeight: 100, position: { x: 0, y: 50 } } as any,
        },
        {
          id: 'n2',
          type: 'vtaNode',
          position: { x: 0, y: 60 }, // Overlaps n1
          measured: { width: 260, height: 100 },
          data: { id: 'n2', lane: 'レーン1', measuredHeight: 100, position: { x: 0, y: 60 } } as any,
        },
        {
          id: 'n3',
          type: 'vtaNode',
          position: { x: 0, y: 70 }, // Overlaps n2
          measured: { width: 260, height: 100 },
          data: { id: 'n3', lane: 'レーン1', measuredHeight: 100, position: { x: 0, y: 70 } } as any,
        },
      ];

      const adjusted = enforceLaneVerticalSpacing(testNodes, ['レーン1']);
      const adj1 = adjusted.find((n) => n.id === 'n1')!;
      const adj2 = adjusted.find((n) => n.id === 'n2')!;
      const adj3 = adjusted.find((n) => n.id === 'n3')!;

      // n1: 50 .. 150
      // n2: 150 + 90 = 240 .. 340
      // n3: 340 + 90 = 430 .. 530
      expect(adj2.position.y).toBe(240);
      expect(adj3.position.y).toBe(430);
    });
  });

  describe('intra-rank Bottom-to-Top sibling ordering & auditVTALayoutGeometry', () => {
    it('stacks same-(lane, rank) siblings including passive object dots Bottom-to-Top so sequential edges draw straight up without detours', () => {
      const schema: VTASchema = {
        lanes: ['A機乗組員', 'タワー東'],
        nodes: [
          { id: 'c0', lane: 'A機乗組員', time: '17:45', sequence_order: 0, entity_role: 'subject', title: 'A機呼込み', description: '', type: 'normal', measure_type: null },
          { id: 'c1_dot', lane: 'A機乗組員', time: '17:45', sequence_order: 1, entity_role: 'object', title: '管制指示受領', description: '', type: 'normal', measure_type: null },
          { id: 'c2', lane: 'A機乗組員', time: '17:45', sequence_order: 2, entity_role: 'subject', title: '指示復唱および確認', description: '', type: 'normal', measure_type: null },
          { id: 't1', lane: 'タワー東', time: '17:45', sequence_order: 0, entity_role: 'subject', title: '待機指示発出', description: '', type: 'normal', measure_type: null },
        ],
        edges: [
          { source: 'c0', target: 'c1_dot', direction: 'sequential' },
          { source: 'c1_dot', target: 'c2', direction: 'sequential' },
          { id: 'rel_t', source: 't1', target: 'c1_dot', direction: 'unidirectional', label: '情報' },
        ],
      };

      const layout = calculateVTALayout(schema);
      const r0 = getDisplayRect(layout.nodes.find((n) => n.id === 'c0')!);
      const r1 = getDisplayRect(layout.nodes.find((n) => n.id === 'c1_dot')!);
      const r2 = getDisplayRect(layout.nodes.find((n) => n.id === 'c2')!);

      // Bottom-to-Top: c0 (bottom, largest Y) < c1_dot (middle) < c2 (top, smallest Y)
      expect(r0.y).toBeGreaterThan(r1.y + r1.height);
      expect(r1.y).toBeGreaterThan(r2.y + r2.height);

      const rects = new Map(layout.nodes.map((n) => [n.id, getDisplayRect(n)]));
      const paths = resolveVTAEdgePaths(layout.edges, rects);
      expect(pathPoints(paths.get(layout.edges[0].id)![0])).toHaveLength(2);
      expect(pathPoints(paths.get(layout.edges[1].id)![0])).toHaveLength(2);

      const audit = auditVTALayoutGeometry(schema, layout);
      expect(audit.backwardIntraLaneEdges).toEqual([]);
      expect(audit.detouredIntraLaneEdges).toEqual([]);
      expect(audit.nonAdjacentIntraLaneEdges).toEqual([]);
      expect(audit.overlappingIntraLanePairs).toEqual([]);
      expect(audit.closeParallelHorizontalEdges).toEqual([]);
      expect(audit.closeParallelVerticalEdges).toEqual([]);
      expect(audit.overlappingEdgeBadges).toEqual([]);
    });

    it('keeps cross-lane corridors and badges conflict-free across multi-lane fan-outs in auditVTALayoutGeometry', () => {
      const schema: VTASchema = {
        lanes: ['L0', 'L1', 'L2'],
        nodes: [
          { id: 'n0_0', lane: 'L0', time: '09:00', sequence_order: 0, title: 'N0', description: '', type: 'normal', measure_type: null },
          { id: 'n0_1', lane: 'L0', time: '09:01', sequence_order: 1, title: 'N1', description: '', type: 'normal', measure_type: null },
          { id: 'n2_0', lane: 'L2', time: '09:00', sequence_order: 0, title: 'M0', description: '', type: 'normal', measure_type: null },
          { id: 'n2_1', lane: 'L2', time: '09:01', sequence_order: 1, title: 'M1', description: '', type: 'normal', measure_type: null },
        ],
        edges: [
          { source: 'n0_0', target: 'n0_1', direction: 'sequential' },
          { source: 'n2_0', target: 'n2_1', direction: 'sequential' },
          { id: 'r1', source: 'n0_1', target: 'n2_0', direction: 'unidirectional', label: '情報' },
          { id: 'r2', source: 'n0_0', target: 'n2_0', direction: 'unidirectional', label: '情報' },
          { id: 'r3', source: 'n0_0', target: 'n2_1', direction: 'unidirectional', label: '情報' },
        ],
      };

      const layout = calculateVTALayout(schema);
      const audit = auditVTALayoutGeometry(schema, layout);
      expect(audit.closeParallelHorizontalEdges).toEqual([]);
      expect(audit.closeParallelVerticalEdges).toEqual([]);
      expect(audit.overlappingEdgeBadges).toEqual([]);
    });

    it('drops stale existingNodes Y coordinates that invert BT order after re-optimization while keeping shared skip stubs clean', () => {
      const schema: VTASchema = {
        lanes: ['飛行場管制席東（タワー東）'],
        nodes: [
          { id: 'card_36', lane: '飛行場管制席東（タワー東）', time: '17:45', sequence_order: 0, event_ids: ['E10'], title: '先行指示', description: '', type: 'normal', measure_type: null },
          { id: 'card_37', lane: '飛行場管制席東（タワー東）', time: '17:46', sequence_order: 1, event_ids: ['E11'], title: '中間処理', description: '', type: 'normal', measure_type: null },
          { id: 'card_38', lane: '飛行場管制席東（タワー東）', time: '17:47', sequence_order: 2, event_ids: ['E12'], title: '後続応答', description: '', type: 'normal', measure_type: null },
        ],
        edges: [
          { id: 'seq_1', source: 'card_36', target: 'card_37', direction: 'sequential' },
          { id: 'seq_2', source: 'card_37', target: 'card_38', direction: 'sequential' },
          { id: 'relation:R23', relationId: 'R23', generated: true, source: 'card_36', target: 'card_38', direction: 'unidirectional', label: '情報' },
        ],
      };

      // Simulate stale existingNodes giving card_37 y=8611 while card_36 was omitted (computed top y=50)
      const staleExisting: VTAReactFlowNode[] = [
        {
          id: 'card_37',
          type: 'vtaNode',
          position: { x: 110, y: 8611 },
          data: { id: 'card_37', lane: '飛行場管制席東（タワー東）', time: '17:46', title: '中間処理', description: '', type: 'normal', measure_type: null },
        },
      ];

      const layout = calculateVTALayout(schema, staleExisting);
      const y36 = layout.nodes.find((n) => n.id === 'card_36')!.position.y;
      const y37 = layout.nodes.find((n) => n.id === 'card_37')!.position.y;
      const y38 = layout.nodes.find((n) => n.id === 'card_38')!.position.y;
      expect(y36).toBeGreaterThan(y37);
      expect(y37).toBeGreaterThan(y38);

      const audit = auditVTALayoutGeometry(schema, layout);
      expect(audit.backwardIntraLaneEdges).toEqual([]);
      expect(audit.detouredIntraLaneEdges.filter((d) => !d.isSemantic)).toEqual([]);
      expect(audit.detouredIntraLaneEdges).toHaveLength(1);
      expect(audit.detouredIntraLaneEdges[0]).toMatchObject({ id: 'relation:R23', isSemantic: true, pointsCount: 6 });
      expect(audit.closeParallelVerticalEdges).toEqual([]);
    });

    it('aligns single-occupancy same-rank nodes with stacked cross-lane partners to prevent downward cross-lane arrows', () => {
      const schema: VTASchema = {
        lanes: ['L_STACKED', 'L_SINGLE'],
        nodes: [
          {
            id: 'card_early',
            event_ids: ['e1'],
            lane: 'L_STACKED',
            time: '10:42',
            type: 'normal',
            title: 'Stacked Early',
            description: '',
            measure_type: null,
            sequence_order: 1,
          },
          {
            id: 'card_late',
            event_ids: ['e2'],
            lane: 'L_STACKED',
            time: '10:42',
            type: 'normal',
            title: 'Stacked Late',
            description: '',
            measure_type: null,
            sequence_order: 2,
          },
          {
            id: 'card_single',
            event_ids: ['e3'],
            lane: 'L_SINGLE',
            time: '10:42',
            type: 'normal',
            title: 'Single Partner',
            description: '',
            measure_type: null,
            sequence_order: 1,
          },
        ],
        edges: [
          { id: 'seq_1', source: 'card_early', target: 'card_late', direction: 'sequential' },
          { id: 'rel_up_align', source: 'card_late', target: 'card_single', direction: 'unidirectional', relationId: 'R_UP' },
        ],
        analysis: {
          version: 5,
          sources: [{ id: 's1', text: 'test', paragraphs: [{ id: 'p1', text: 'test' }] }],
          facts: [],
          events: [
            { id: 'e1', title: 'Stacked Early', description: '', time: '10:42', sourceOrder: 0, factIds: [], sourceRefs: [], classification: 'normal' },
            { id: 'e2', title: 'Stacked Late', description: '', time: '10:42', sourceOrder: 1, factIds: [], sourceRefs: [], classification: 'normal' },
            { id: 'e3', title: 'Single Partner', description: '', time: '10:42', sourceOrder: 2, factIds: [], sourceRefs: [], classification: 'normal' },
          ],
          entities: [
            { id: 'L_STACKED', name: 'L_STACKED', kind: 'person' },
            { id: 'L_SINGLE', name: 'L_SINGLE', kind: 'person' },
          ],
          participations: [
            { eventId: 'e1', entityId: 'L_STACKED', role: 'actor', factIds: [] },
            { eventId: 'e2', entityId: 'L_STACKED', role: 'actor', factIds: [] },
            { eventId: 'e3', entityId: 'L_SINGLE', role: 'actor', factIds: [] },
          ],
          relations: [
            {
              id: 'R_UP',
              kind: 'transfer',
              sourceEventId: 'e2',
              sourceEntityId: 'L_STACKED',
              targetEventId: 'e3',
              targetEntityId: 'L_SINGLE',
              sourceRefs: [],
            },
          ],
          cards: [
            { id: 'card_early', laneEntityId: 'L_STACKED', eventIds: ['e1'] },
            { id: 'card_late', laneEntityId: 'L_STACKED', eventIds: ['e2'] },
            { id: 'card_single', laneEntityId: 'L_SINGLE', eventIds: ['e3'] },
          ],
          unassignedEventIds: [],
        },
      };

      const layout = calculateVTALayout(schema);
      const audit = auditVTALayoutGeometry(schema, layout);
      expect(audit.backwardCrossLaneEdges).toEqual([]);
      const lateNode = layout.nodes.find((n) => n.id === 'card_late')!;
      const singleNode = layout.nodes.find((n) => n.id === 'card_single')!;
      expect(singleNode.position.y).toBeLessThanOrEqual(lateNode.position.y + 1);
    });

    it('auditVTALayoutGeometry detects backwardCrossLaneEdges when a unidirectional cross-lane edge drops downward', () => {
      const schema: VTASchema = {
        lanes: ['L1', 'L2'],
        nodes: [
          {
            id: 'c_src',
            event_ids: ['e1'],
            lane: 'L1',
            time: '10:42',
            type: 'normal',
            title: 'Source Higher (Smaller Y)',
            description: '',
            measure_type: null,
            position: { x: 100, y: 100 },
          },
          {
            id: 'c_tgt',
            event_ids: ['e2'],
            lane: 'L2',
            time: '10:40',
            type: 'normal',
            title: 'Target Lower (Larger Y)',
            description: '',
            measure_type: null,
            position: { x: 400, y: 300 },
          },
        ],
        edges: [
          { id: 'rel_bw', source: 'c_src', target: 'c_tgt', direction: 'unidirectional', relationId: 'R_BW' },
        ],
      };

      const layout = calculateVTALayout(schema);
      const audit = auditVTALayoutGeometry(schema, layout);
      expect(audit.backwardCrossLaneEdges).toHaveLength(1);
      expect(audit.backwardCrossLaneEdges[0]).toMatchObject({
        id: 'rel_bw',
        relationId: 'R_BW',
        source: 'c_src',
        target: 'c_tgt',
        dropPx: 200,
      });
    });

    it('absorbs half-height overhang when a taller single-occupancy card aligns with a shorter top/bottom stacked card in the same rank', () => {
      const schema: VTASchema = {
        lanes: ['L_SINGLE_TALL', 'L_STACKED_SHORT'],
        nodes: [
          {
            id: 'card_tall',
            event_ids: ['e_tall'],
            lane: 'L_SINGLE_TALL',
            time: '10:46',
            type: 'normal',
            title: '背の高い単一セルカード（長文説明で高さが20px以上大きくなるケース）',
            description: '非常に長い説明文を含めることで推定カード高さをスタック側下端カードより明確に高くし、オーバーハング余白が確保されることを検証するテストケースです。',
            measure_type: null,
            sequence_order: 1,
          },
          {
            id: 'card_stack_bottom',
            event_ids: ['e_bot'],
            lane: 'L_STACKED_SHORT',
            time: '10:46',
            type: 'normal',
            title: '下端短カード',
            description: '',
            measure_type: null,
            sequence_order: 1,
          },
          {
            id: 'card_stack_top',
            event_ids: ['e_top'],
            lane: 'L_STACKED_SHORT',
            time: '10:46',
            type: 'normal',
            title: '上端短カード',
            description: '',
            measure_type: null,
            sequence_order: 2,
          },
        ],
        edges: [
          { id: 'seq_s', source: 'card_stack_bottom', target: 'card_stack_top', direction: 'sequential' },
          { id: 'rel_overhang', source: 'card_tall', target: 'card_stack_bottom', direction: 'unidirectional', relationId: 'R_OH' },
        ],
        analysis: {
          version: 5,
          sources: [{ id: 's1', text: 'test', paragraphs: [{ id: 'p1', text: 'test' }] }],
          facts: [],
          events: [
            { id: 'e_tall', title: 'Tall', description: '', time: '10:46', sourceOrder: 0, factIds: [], sourceRefs: [], classification: 'normal' },
            { id: 'e_bot', title: 'Bot', description: '', time: '10:46', sourceOrder: 1, factIds: [], sourceRefs: [], classification: 'normal' },
            { id: 'e_top', title: 'Top', description: '', time: '10:46', sourceOrder: 2, factIds: [], sourceRefs: [], classification: 'normal' },
          ],
          entities: [
            { id: 'L_SINGLE_TALL', name: 'L_SINGLE_TALL', kind: 'person' },
            { id: 'L_STACKED_SHORT', name: 'L_STACKED_SHORT', kind: 'person' },
          ],
          participations: [
            { eventId: 'e_tall', entityId: 'L_SINGLE_TALL', role: 'actor', factIds: [] },
            { eventId: 'e_bot', entityId: 'L_STACKED_SHORT', role: 'actor', factIds: [] },
            { eventId: 'e_top', entityId: 'L_STACKED_SHORT', role: 'actor', factIds: [] },
          ],
          relations: [
            {
              id: 'R_OH',
              kind: 'transfer',
              sourceEventId: 'e_tall',
              sourceEntityId: 'L_SINGLE_TALL',
              targetEventId: 'e_bot',
              targetEntityId: 'L_STACKED_SHORT',
              sourceRefs: [],
            },
          ],
          cards: [
            { id: 'card_tall', laneEntityId: 'L_SINGLE_TALL', eventIds: ['e_tall'] },
            { id: 'card_stack_bottom', laneEntityId: 'L_STACKED_SHORT', eventIds: ['e_bot'] },
            { id: 'card_stack_top', laneEntityId: 'L_STACKED_SHORT', eventIds: ['e_top'] },
          ],
          unassignedEventIds: [],
        },
      };

      const layout = calculateVTALayout(schema);
      const audit = auditVTALayoutGeometry(schema, layout);
      expect(audit.backwardCrossLaneEdges).toEqual([]);
      expect(audit.overlappingIntraLanePairs).toEqual([]);
    });

    it('audits geometry correctly when shared card edge and cross-lane relation edge coexist between same card pair (ADR-0054 regression test)', () => {
      const schema: VTASchema = {
        lanes: ['ATC', 'JCG'],
        nodes: [
          { id: 'card_53', lane: 'ATC', time: '17:45', sequence_order: 0, event_ids: ['E11', 'E13'], title: 'C5指示', description: '', type: 'normal', measure_type: null },
          { id: 'card_9', lane: 'JCG', time: '17:45', sequence_order: 0, event_ids: ['E13'], title: 'C5受領', description: '', type: 'normal', measure_type: null },
        ],
        edges: [
          { id: 'shared:E13:card_53:card_9', source: 'card_53', target: 'card_9', direction: 'undirected', label: '同一イベント' },
          { id: 'relation:R2', source: 'card_53', target: 'card_9', direction: 'unidirectional', label: '情報', relationId: 'R2' },
        ],
      };

      const layout = calculateVTALayout(schema);
      const audit = auditVTALayoutGeometry(schema, layout);
      expect(audit.backwardCrossLaneEdges).toEqual([]);
      expect(audit.overlappingIntraLanePairs).toEqual([]);
    });
  });
});
