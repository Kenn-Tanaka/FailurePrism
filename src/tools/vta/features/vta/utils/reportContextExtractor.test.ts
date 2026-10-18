import { describe, it, expect } from 'vitest';
import { VTASchema } from '../../../types/vta';
import {
  extractReportAnalysisContext,
  formatReportAnalysisContextText,
} from './reportContextExtractor';

describe('reportContextExtractor.ts', () => {
  const sampleVta: VTASchema = {
    lanes: ['製造課', '品証課'],
    supplementary_summary: '製造工程における異常品の流出事故概要',
    nodes: [
      {
        id: 'node_1',
        lane: '製造課',
        time: '09:00',
        title: '作業準備',
        description: '治具のセット',
        type: 'normal',
        measure_type: null,
      },
      {
        id: 'node_2',
        lane: '製造課',
        time: '09:30',
        title: '点検手順の省略',
        description: '開始前点検を行わずに稼働した',
        type: 'variation',
        measure_type: 'elimination',
        supplementary_note: 'チェックリストへの記入なし',
      },
      {
        id: 'node_3',
        lane: '品証課',
        time: '10:00',
        title: '次工程への搬送',
        description: '加工品を次工程へ搬送',
        type: 'normal',
        measure_type: null,
      },
      {
        id: 'node_4',
        lane: '品証課',
        time: '11:00',
        title: '異常発見・停止',
        description: '抜き取り検査で不適合を発見しライン停止',
        type: 'variation',
        measure_type: null,
      },
    ],
    edges: [
      {
        source: 'node_1',
        target: 'node_2',
        is_break: false,
      },
      {
        source: 'node_2',
        target: 'node_3',
        is_break: true,
      },
      {
        source: 'node_3',
        target: 'node_4',
        is_break: false,
      },
    ],
  };

  it('should extract elimination nodes, breaks, final event, and timeline correctly', () => {
    const ctx = extractReportAnalysisContext(sampleVta);

    // 1. Elimination nodes
    expect(ctx.eliminationNodes).toHaveLength(1);
    expect(ctx.eliminationNodes[0].id).toBe('node_2');
    expect(ctx.eliminationNodes[0].title).toBe('点検手順の省略');
    expect(ctx.eliminationNodes[0].supplementaryNote).toBe('チェックリストへの記入なし');

    // 2. Break points with connected nodes
    expect(ctx.breakPoints).toHaveLength(1);
    expect(ctx.breakPoints[0].sourceNode.id).toBe('node_2');
    expect(ctx.breakPoints[0].targetNode.id).toBe('node_3');

    // 3. Final event nodes (node_4 has no outgoing edges)
    expect(ctx.finalEventNodes).toHaveLength(1);
    expect(ctx.finalEventNodes[0].id).toBe('node_4');

    // 4. Timeline summary
    expect(ctx.timelineSummary).toHaveLength(4);
    expect(ctx.timelineSummary[1].measureType).toBe('elimination');
  });

  it('should format extracted context into clean Markdown without raw JSON or coordinates', () => {
    const ctx = extractReportAnalysisContext(sampleVta);
    const text = formatReportAnalysisContextText(ctx);

    // Verify key sections exist
    expect(text).toContain('### 1. 排除ノード一覧');
    expect(text).toContain('点検手順の省略');
    expect(text).toContain('チェックリストへの記入なし');

    expect(text).toContain('### 2. ブレーク一覧');
    expect(text).toContain('node_2');
    expect(text).toContain('node_3');
    expect(text).toContain('BREAK');

    expect(text).toContain('### 3. 最終事象');
    expect(text).toContain('異常発見・停止');

    expect(text).toContain('### 4. 時系列要約');
    expect(text).toContain('作業準備');

    // Ensure raw JSON syntax or canvas positions are absent
    expect(text).not.toContain('"nodes":');
    expect(text).not.toContain('"edges":');
    expect(text).not.toContain('"position":');
  });

  it('should handle multiple elimination nodes and multiple breaks with complex topologies', () => {
    const complexVta: VTASchema = {
      lanes: ['A', 'B', 'C'],
      nodes: [
        { id: 'n1', lane: 'A', time: '10:00', title: '発端事象', description: '発端', type: 'normal', measure_type: null },
        { id: 'n2', lane: 'A', time: '10:10', title: '第1変動要因', description: '手順未実施', type: 'variation', measure_type: 'elimination' },
        { id: 'n3', lane: 'B', time: '10:15', title: '情報伝達受領', description: '受領', type: 'normal', measure_type: null },
        { id: 'n4', lane: 'B', time: '10:20', title: '第2変動要因', description: '警報未確認', type: 'variation', measure_type: 'elimination' },
        { id: 'n5', lane: 'C', time: '10:30', title: '最終障害', description: 'ライン停止', type: 'variation', measure_type: null },
      ],
      edges: [
        { source: 'n1', target: 'n2', is_break: false },
        { source: 'n2', target: 'n3', is_break: true },
        { source: 'n3', target: 'n4', is_break: false },
        { source: 'n4', target: 'n5', is_break: true },
      ],
    };

    const ctx = extractReportAnalysisContext(complexVta);
    expect(ctx.eliminationNodes).toHaveLength(2);
    expect(ctx.eliminationNodes.map((n) => n.id)).toEqual(['n2', 'n4']);
    expect(ctx.breakPoints).toHaveLength(2);
    expect(ctx.breakPoints[0].sourceNode.id).toBe('n2');
    expect(ctx.breakPoints[0].targetNode.id).toBe('n3');
    expect(ctx.breakPoints[1].sourceNode.id).toBe('n4');
    expect(ctx.breakPoints[1].targetNode.id).toBe('n5');
    expect(ctx.finalEventNodes).toHaveLength(1);
    expect(ctx.finalEventNodes[0].id).toBe('n5');

    const formatted = formatReportAnalysisContextText(ctx);
    expect(formatted).toContain('計 2 件');
    expect(formatted).toContain('計 2 箇所');
    expect(formatted).toContain('第1変動要因');
    expect(formatted).toContain('第2変動要因');
    expect(formatted).not.toContain('"position":');
  });

  it('should fully extract node-bound custom notes and general notes into analysis context (FUNC-001)', () => {
    const vtaWithNotes: VTASchema = {
      lanes: ['製造課', '保全課'],
      supplementary_summary: '定期点検不備による設備停止',
      nodes: [
        {
          id: 'node_10',
          lane: '製造課',
          time: '14:00',
          title: '異音発生',
          description: 'モーター部より異音が発生したが稼働継続',
          type: 'variation',
          measure_type: 'elimination',
          supplementary_note: '保全担当への連絡が30分遅延',
        },
        {
          id: 'node_20',
          lane: '保全課',
          time: '14:40',
          title: '緊急停止',
          description: '軸受の焼き付きにより自動停止',
          type: 'normal',
          measure_type: null,
        },
      ],
      edges: [
        { source: 'node_10', target: 'node_20', is_break: true },
      ],
      custom_notes: [
        {
          id: 'cn_1',
          nodeId: 'node_10',
          title: '現場ヒアリング',
          content: '作業員Aは前日の点検表に「要監視」と記載していたと証言',
        },
        {
          id: 'cn_2',
          title: '環境前提',
          content: '当日工場内の騒音が大きく異音の識別が困難であった',
        },
      ],
    };

    const ctx = extractReportAnalysisContext(vtaWithNotes);
    expect(ctx.eliminationNodes[0].customNotes).toHaveLength(1);
    expect(ctx.eliminationNodes[0].customNotes![0].content).toContain('前日の点検表');
    expect(ctx.breakPoints[0].sourceNode.customNotes).toHaveLength(1);
    expect(ctx.generalCustomNotes).toHaveLength(1);
    expect(ctx.generalCustomNotes![0].title).toBe('環境前提');

    const formatted = formatReportAnalysisContextText(ctx);
    expect(formatted).toContain('前日の点検表');
    expect(formatted).toContain('保全担当への連絡が30分遅延');
    expect(formatted).toContain('現場ヒアリング・追加付箋メモ（全体事項）');
    expect(formatted).toContain('当日工場内の騒音が大きく異音の識別が困難であった');
    expect(formatted).toContain('モーター部より異音が発生したが稼働継続');
  });

  it('should extract edge labels, categories, and cross-lane connections properly', () => {
    const vtaWithEdges: VTASchema = {
      lanes: ['管制', '航空機A', '航空機B'],
      nodes: [
        { id: 'n1', lane: '管制', time: '17:40', title: '進入指示', description: 'C滑走路進入を指示', type: 'normal', measure_type: null },
        { id: 'n2', lane: '航空機A', time: '17:41', title: '復唱・進入', description: '指示を受託し進入', type: 'variation', measure_type: 'elimination' },
        { id: 'n3', lane: '航空機B', time: '17:42', title: '着陸進入', description: '滑走路への進入継続', type: 'normal', measure_type: null },
      ],
      edges: [
        {
          source: 'n1',
          target: 'n2',
          direction: 'bidirectional',
          label: '指示復唱',
          category: 'information',
          is_break: true,
        },
        {
          source: 'n2',
          target: 'n3',
          direction: 'unidirectional',
          label: '進入位置接近',
          category: 'impact',
          is_break: false,
        },
      ],
    };

    const ctx = extractReportAnalysisContext(vtaWithEdges);
    expect(ctx.breakPoints).toHaveLength(1);
    expect(ctx.breakPoints[0].edgeLabel).toBe('指示復唱');
    expect(ctx.breakPoints[0].category).toBe('information');
    expect(ctx.breakPoints[0].categoryLabel).toBe('情報');
    expect(ctx.breakPoints[0].direction).toBe('bidirectional');

    expect(ctx.keyConnections).toHaveLength(2);
    expect(ctx.keyConnections![0].label).toBe('指示復唱');
    expect(ctx.keyConnections![0].categoryLabel).toBe('情報');
    expect(ctx.keyConnections![0].isBreak).toBe(true);

    expect(ctx.keyConnections![1].label).toBe('進入位置接近');
    expect(ctx.keyConnections![1].categoryLabel).toBe('物理影響');
    expect(ctx.keyConnections![1].isBreak).toBe(false);

    const formatted = formatReportAnalysisContextText(ctx);
    // Break section should include edge label and category
    expect(formatted).toContain('ラベル: 「指示復唱」');
    expect(formatted).toContain('分類: 情報');

    // Cross-lane connections section should include metadata and neutral wording
    expect(formatted).toContain('### 5. レーン間接続・伝達一覧（関係者間のやり取り・影響関係）');
    expect(formatted).toContain('※接続・伝達は関係者間の連携・受渡しを示す客観的事実であり、因果関係を自動断定するものではありません。');
    expect(formatted).toContain('【管制】進入指示 (n1) ◀──(相互確認)──▶ 「指示復唱」 [分類: 情報] 【航空機A】復唱・進入 (n2) (※ブレーク適用箇所)');
    expect(formatted).toContain('【航空機A】復唱・進入 (n2) ──────▶ 「進入位置接近」 [分類: 物理影響] 【航空機B】着陸進入 (n3)');
  });
});
