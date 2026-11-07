import { describe, expect, it } from 'vitest';
import type { VTANodeData, VTAEdgeData, VTASchema } from '../../src/tools/vta/types/vta';
import {
  computeSVGPathLength,
  computeNodeRanks,
  buildCausalFlowSequence,
  buildPipelineEvolutionSequence,
} from '../../src/tools/vta/features/vta/utils/animationSequencer';

describe('animationSequencer', () => {
  describe('computeSVGPathLength', () => {
    it('calculates length for single horizontal segment', () => {
      const d = 'M 0 0 L 120 0';
      const len = computeSVGPathLength(d);
      expect(len).toBeCloseTo(120, 1);
    });

    it('calculates length for orthogonal multi-segment path', () => {
      // (10, 20) -> (50, 20) dx=40
      // (50, 20) -> (50, 100) dy=80
      // (50, 100) -> (150, 100) dx=100
      // total = 40 + 80 + 100 = 220
      const d = 'M 10 20 L 50 20 L 50 100 L 150 100';
      const len = computeSVGPathLength(d);
      expect(len).toBeCloseTo(220, 1);
    });

    it('returns 0 for empty or invalid path', () => {
      expect(computeSVGPathLength('')).toBe(0);
      expect(computeSVGPathLength('M 0 0')).toBe(0);
    });
  });

  describe('computeNodeRanks', () => {
    const nodes: VTANodeData[] = [
      { id: 'n1', title: 'Start', description: 'c1', lane: 'L1', time: '10:00', type: 'normal', measure_type: null, position: { x: 100, y: 100 } },
      { id: 'n2', title: 'Middle', description: 'c2', lane: 'L1', time: '10:01', type: 'normal', measure_type: null, position: { x: 100, y: 200 } },
      { id: 'n3', title: 'End', description: 'c3', lane: 'L1', time: '10:02', type: 'normal', measure_type: null, position: { x: 100, y: 300 } },
    ];

    it('ranks nodes topologically according to DAG edges', () => {
      const edges: VTAEdgeData[] = [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n3' },
      ];
      const ranks = computeNodeRanks(nodes, edges);
      expect(ranks.get('n1')).toBe(0);
      expect(ranks.get('n2')).toBe(1);
      expect(ranks.get('n3')).toBe(2);
    });

    it('handles branching DAG correctly', () => {
      const edges: VTAEdgeData[] = [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n1', target: 'n3' },
      ];
      const ranks = computeNodeRanks(nodes, edges);
      expect(ranks.get('n1')).toBe(0);
      expect(ranks.get('n2')).toBe(1);
      expect(ranks.get('n3')).toBe(1);
    });

    it('handles disconnected nodes by sorting by vertical position or step', () => {
      const edges: VTAEdgeData[] = [];
      const ranks = computeNodeRanks(nodes, edges);
      expect(ranks.get('n1')).toBe(0);
      expect(ranks.get('n2')).toBe(0);
      expect(ranks.get('n3')).toBe(0);
    });
  });

  describe('buildCausalFlowSequence', () => {
    const sampleSchema: VTASchema = {
      lanes: ['L1'],
      nodes: [
        { id: 'n1', title: 'Trigger', description: 'Fire alarm', lane: 'L1', time: '10:00', type: 'normal', measure_type: null, position: { x: 100, y: 100 } },
        { id: 'n2', title: 'Response', description: 'Evacuate', lane: 'L1', time: '10:01', type: 'variation', measure_type: null, position: { x: 100, y: 250 } },
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
      ],
    };

    it('builds causal sequence with correct total duration and steps', () => {
      const timeline = buildCausalFlowSequence(sampleSchema, undefined, {
        baseStepSeconds: 1.0,
        holdSeconds: 4.0,
      });

      expect(timeline.mode).toBe('causal_flow');
      expect(timeline.steps.length).toBeGreaterThanOrEqual(2);
      expect(timeline.holdDuration).toBe(4.0);
      expect(timeline.cycleDuration).toBe(timeline.totalDuration + 4.0);

      // Node and edge map entries exist
      expect(timeline.nodeTimings.has('n1')).toBe(true);
      expect(timeline.nodeTimings.has('n2')).toBe(true);
      expect(timeline.edgeTimings.has('e1')).toBe(true);

      const n1Timing = timeline.nodeTimings.get('n1')!;
      const n2Timing = timeline.nodeTimings.get('n2')!;
      const e1Timing = timeline.edgeTimings.get('e1')!;

      // n1 appears before e1 and n2
      expect(n1Timing.startTime).toBeLessThanOrEqual(e1Timing.startTime);
      expect(e1Timing.startTime).toBeLessThanOrEqual(n2Timing.startTime);
    });
  });

  describe('buildPipelineEvolutionSequence', () => {
    const sampleSchema: VTASchema = {
      lanes: ['L1', 'L2'],
      nodes: [
        { id: 'n1', title: 'Node 1', description: 'Detail 1', lane: 'L1', time: '10:00', type: 'normal', measure_type: null, position: { x: 50, y: 80 } },
        { id: 'n2', title: 'Node 2', description: 'Detail 2', lane: 'L2', time: '10:01', type: 'variation', measure_type: null, position: { x: 50, y: 180 } },
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
      ],
    };

    it('builds pipeline evolution sequence covering 4 AI stages', () => {
      const timeline = buildPipelineEvolutionSequence(sampleSchema, {
        stepSeconds: 2.0,
        holdSeconds: 4.0,
      });

      expect(timeline.mode).toBe('pipeline_evolution');
      expect(timeline.steps.length).toBe(4);
      expect(timeline.cycleDuration).toBe(4 * 2.0 + 4.0);

      // Stage descriptions should match the 4 steps of AI synthesis
      expect(timeline.steps[0].description).toContain('一次抽出');
      expect(timeline.steps[1].title).toContain('最適化');
      expect(timeline.steps[1].description).toContain('レーン統合');
      expect(timeline.steps[2].description).toContain('探索と補完');
      expect(timeline.steps[3].description).toContain('変動要因');

      // Check stage progression:
      // In stage 0: no edges active
      expect(timeline.steps[0].activeEdgeIds.length).toBe(0);
      // In stage 2: edges active
      expect(timeline.steps[2].activeEdgeIds.includes('e1')).toBe(true);
      // In stage 3: variation factor active
      expect(timeline.steps[3].highlightNodeIds.includes('n2')).toBe(true);
    });
  });
});
