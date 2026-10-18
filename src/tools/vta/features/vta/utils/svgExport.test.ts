import { describe, it, expect } from 'vitest';
import { generateVTASVG } from './svgExport';
import { VTASchema } from '../../../types/vta';
import { calculateVTALayout } from './layout';

describe('svgExport.ts - Vector SVG Export', () => {
  it('compacts hidden descriptions and ignores saved manual gaps without changing the schema', () => {
    const schema: VTASchema = {
      lanes: ['A'], nodes: [
        { id: 'a', lane: 'A', time: '10:00', title: '作業開始', description: '長い本文'.repeat(200), type: 'normal', measure_type: null, position: { x: 100, y: 9000 } },
        { id: 'b', lane: 'A', time: '11:00', title: '作業完了', description: '長い本文'.repeat(200), type: 'normal', measure_type: null, position: { x: 100, y: 1000 } },
      ], edges: [{ source: 'a', target: 'b' }],
    };
    const original = JSON.stringify(schema);
    const detailed = calculateVTALayout(schema);
    const compact = calculateVTALayout(schema, detailed.nodes, undefined, { compact: true, forceRecompute: true });
    expect(compact.height).toBeLessThan(600);
    const svg = generateVTASVG(schema, detailed.nodes, detailed.edges, detailed.laneBounds, { includeNotes: false });
    expect(svg).not.toContain('長い本文');
    expect(svg).toContain('height="90" rx="6"');
    expect(svg).toContain('font-size="14"');
    expect(JSON.stringify(schema)).toBe(original);
  });
  const sampleSchema: VTASchema = {
    lanes: ['設計部', '製造部', '空レーン部'],
    nodes: [
      {
        id: 'node_1',
        lane: '設計部',
        time: '2ヶ月前',
        title: '設計変更 <特記> & "重要"',
        description: '詳細な変更内容',
        type: 'variation',
        measure_type: 'elimination',
        supplementary_note: '【背景】設計変更通知が漏れていた事実',
      },
      {
        id: 'node_2',
        lane: '製造部',
        time: '当日朝',
        title: '作業開始',
        description: '旧手順書に従って着手',
        type: 'normal',
        measure_type: null,
      },
    ],
    edges: [
      {
        source: 'node_1',
        target: 'node_2',
        direction: 'unidirectional',
        is_break: true,
      },
    ],
    supplementary_summary: '設計変更伝達漏れによる不具合',
  };

  it('should generate valid SVG without <foreignObject> elements for Word/PowerPoint compatibility', () => {
    const layout = calculateVTALayout(sampleSchema);
    const svg = generateVTASVG(
      sampleSchema,
      layout.nodes,
      layout.edges,
      layout.laneBounds,
      { includeEmptyLanes: false, includeNotes: true }
    );

    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
    // Word/PowerPoint will fail to render foreignObject, must strictly use standard <text>/<tspan>
    expect(svg).not.toContain('<foreignObject');
    expect(svg).toContain('<text');
    expect(svg).toContain('<tspan');
  });

  it('should escape XML entities in titles, descriptions, and notes', () => {
    const layout = calculateVTALayout(sampleSchema);
    const svg = generateVTASVG(
      sampleSchema,
      layout.nodes,
      layout.edges,
      layout.laneBounds
    );

    expect(svg).toContain('&lt;特記&gt;');
    expect(svg).toContain('&amp;');
    expect(svg).toContain('&quot;重要&quot;');
  });

  it('should exclude empty lanes when includeEmptyLanes is false', () => {
    const layout = calculateVTALayout(sampleSchema);
    const svgWithoutEmpty = generateVTASVG(
      sampleSchema,
      layout.nodes,
      layout.edges,
      layout.laneBounds,
      { includeEmptyLanes: false }
    );

    // '空レーン部' has no nodes, so it must not appear in the compact lane headers
    expect(svgWithoutEmpty).not.toContain('空レーン部');
    expect(svgWithoutEmpty).toContain('設計部');
    expect(svgWithoutEmpty).toContain('製造部');
  });

  it('should include empty lanes when includeEmptyLanes is true', () => {
    const layout = calculateVTALayout(sampleSchema);
    const svgWithEmpty = generateVTASVG(
      sampleSchema,
      layout.nodes,
      layout.edges,
      layout.laneBounds,
      { includeEmptyLanes: true }
    );

    expect(svgWithEmpty).toContain('空レーン部');
    expect(svgWithEmpty).toContain('設計部');
    expect(svgWithEmpty).toContain('製造部');
  });

  it('should render neutral legend text and custom edge labels / category badges', () => {
    const schemaWithLabels: VTASchema = {
      lanes: ['管制', '航空機'],
      nodes: [
        { id: 'n1', lane: '管制', time: '10:00', title: '指示発出', description: '発出', type: 'normal', measure_type: null },
        { id: 'n2', lane: '航空機', time: '10:01', title: '指示受託', description: '受託', type: 'variation', measure_type: null },
      ],
      edges: [
        {
          source: 'n1',
          target: 'n2',
          direction: 'unidirectional',
          label: '無線交信',
          category: 'information',
          is_break: true,
        },
      ],
    };

    const layout = calculateVTALayout(schemaWithLabels);
    const svg = generateVTASVG(
      schemaWithLabels,
      layout.nodes,
      layout.edges,
      layout.laneBounds
    );

    // Verify neutral legend
    expect(svg).toContain('接続・伝達');
    expect(svg).not.toContain('>情報伝達<');

    // Verify edge label and category badge
    expect(svg).toContain('無線交信');
    expect(svg).toContain('(情報)');
    expect(svg).toContain('BREAK');
  });
});

