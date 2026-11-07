import { describe, expect, it } from 'vitest';
import type { VTASchema } from '../../src/tools/vta/types/vta';
import { calculateVTALayout } from '../../src/tools/vta/features/vta/utils/layout';
import { generateAnimatedVTASVG } from '../../src/tools/vta/features/vta/utils/animatedSvgExport';

describe('animatedSvgExport', () => {
  const sampleSchema: VTASchema = {
    lanes: ['運転士', '車掌', '指令員'],
    nodes: [
      {
        id: 'node_1',
        title: '信号確認',
        description: '停止信号を現示していることを目視確認した。',
        time: '10:00:00',
        lane: '運転士',
        type: 'normal',
        measure_type: null,
      },
      {
        id: 'node_2',
        title: '通報',
        description: '指令員に対して信号現示の異常を通報した。',
        time: '10:01:00',
        lane: '車掌',
        type: 'variation',
        measure_type: null,
        variation_factor: {
          category: 'response',
          polarity: 'negative',
          description: '連絡系統の混線',
        },
      },
      {
        id: 'node_3',
        title: '非常停止手配',
        description: '指令員が全列車防護発報を実施した。',
        time: '10:02:00',
        lane: '指令員',
        type: 'outcome',
        measure_type: null,
      },
    ],
    edges: [
      { id: 'edge_1', source: 'node_1', target: 'node_2' },
      { id: 'edge_2', source: 'node_2', target: 'node_3' },
    ],
  };

  const layout = calculateVTALayout(sampleSchema);

  describe('Causal Flow Mode (事故因果リプレイ)', () => {
    it('generates animated SVG with embedded pure CSS @keyframes', () => {
      const svg = generateAnimatedVTASVG(
        sampleSchema,
        layout.nodes,
        layout.edges,
        layout.laneBounds,
        {
          animationMode: 'causal_flow',
          includeNotes: true,
          includeHeader: true,
        }
      );

      // Must be valid SVG vector format
      expect(svg).toContain('<svg');
      expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect(svg).toContain('</svg>');

      // Must NOT contain any external script tags (pure CSS keyframes)
      expect(svg).not.toContain('<script');

      // Embedded style block exists
      expect(svg).toContain('<style');
      expect(svg).toContain('</style>');

      // Check keyframes definitions
      expect(svg).toContain('@keyframes vtaPulseAmber');
      expect(svg).toContain('@keyframes vtaPulseRose');
      expect(svg).toContain('@keyframes vtaFadeInSwimlanes');

      // Check node elements with IDs
      expect(svg).toContain('id="node_1"');
      expect(svg).toContain('id="node_2"');
      expect(svg).toContain('id="node_3"');

      // Check edge groups with IDs
      expect(svg).toContain('class="vta-edge-group"');
      expect(svg).toContain('id="edge_edge_1"');
      expect(svg).toContain('id="edge_edge_2"');

      // Check line growth stroke animation styles
      expect(svg).toContain('stroke-dasharray:');
      expect(svg).toContain('stroke-dashoffset:');

      // Check replay mode label in header banner
      expect(svg).toContain('因果リプレイ');
    });

    it('respects includeNotes: false option', () => {
      const svg = generateAnimatedVTASVG(
        sampleSchema,
        layout.nodes,
        layout.edges,
        layout.laneBounds,
        {
          animationMode: 'causal_flow',
          includeNotes: false,
        }
      );

      expect(svg).toContain('<svg');
      // Should not contain the right notes panel
      expect(svg).not.toContain('補足説明・変動要因・メモ一覧');
    });
  });

  describe('Pipeline Evolution Mode (AIパイプライン進化リプレイ)', () => {
    it('generates animated SVG with pipeline stage transition keyframes', () => {
      const svg = generateAnimatedVTASVG(
        sampleSchema,
        layout.nodes,
        layout.edges,
        layout.laneBounds,
        {
          animationMode: 'pipeline_evolution',
          includeNotes: true,
          includeHeader: true,
        }
      );

      // Must be valid SVG
      expect(svg).toContain('<svg');
      expect(svg).not.toContain('<script');

      // Pipeline evolution specific style rules
      expect(svg).toContain('@keyframes vtaAnimPipelineEdges');
      expect(svg).toContain('@keyframes vtaAnimPipelineColoring');

      // Header indicates pipeline evolution
      expect(svg).toContain('AI推論進化リプレイ');
    });
  });
});
