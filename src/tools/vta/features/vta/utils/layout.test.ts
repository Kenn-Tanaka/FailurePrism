import { describe, it, expect } from 'vitest';
import {
  computeTimeRanks,
  calculateVTALayout,
  getOrthogonalStepPath,
  estimateNodeHeight,
  enforceLaneVerticalSpacing,
  LANE_WIDTH,
  NODE_WIDTH,
  VERTICAL_STEP,
  VERTICAL_GAP,
  INTRA_RANK_GAP,
} from './layout';
import { VTASchema, VTAReactFlowNode } from '../../../types/vta';

describe('layout.ts - VTA Layout Engine', () => {
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
      expect(edge.sourceHandle).toBe('right-source');
      expect(edge.targetHandle).toBe('left-target');
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
});
