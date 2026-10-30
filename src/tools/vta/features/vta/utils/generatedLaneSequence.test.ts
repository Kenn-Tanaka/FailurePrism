import { describe, expect, it } from 'vitest';
import type { VTASchema } from '../../../types/vta';
import { repairGeneratedLaneSequence } from './generatedLaneSequence';
import { calculateVTALayout } from './layout';

const node = (id: string, lane: string, sequence_order?: number): VTASchema['nodes'][number] => ({
  id, lane, sequence_order, time: '', title: id, description: id, type: 'normal', measure_type: null,
});

describe('repairGeneratedLaneSequence', () => {
  it('connects consecutive nodes in source order and removes same-lane shortcuts', () => {
    const schema: VTASchema = {
      lanes: ['A', 'B'],
      nodes: [node('c', 'A', 2), node('x', 'B', 3), { ...node('a', 'A', 0), position: { x: 0, y: 0 } }, node('b', 'A', 1)],
      edges: [
        { source: 'a', target: 'c', direction: 'sequential' },
        { source: 'b', target: 'a', direction: 'sequential' },
        { source: 'a', target: 'x', direction: 'unidirectional', label: '伝達' },
      ],
    };

    const result = repairGeneratedLaneSequence(schema);
    expect(result.schema.edges).toEqual([
      { source: 'a', target: 'b', direction: 'sequential' },
      { source: 'a', target: 'x', direction: 'unidirectional', label: '伝達' },
      { source: 'b', target: 'c', direction: 'sequential', is_break: false },
    ]);
    expect(result.addedEdges).toBe(1);
    expect(result.removedEdges).toBe(1);
    expect(result.correctedDirections).toBe(1);
    expect(result.schema.nodes[2].position).toBeUndefined();
    expect(schema.nodes[2].position).toEqual({ x: 0, y: 0 });
    expect(schema.edges).toHaveLength(3);

    const positions = new Map(calculateVTALayout(result.schema).nodes.map((item) => [item.id, item.position.y]));
    expect(positions.get('a')!).toBeGreaterThan(positions.get('b')!);
    expect(positions.get('b')!).toBeGreaterThan(positions.get('c')!);
  });

  it('uses node array order when sequence_order is incomplete and makes layout order explicit', () => {
    const schema: VTASchema = {
      lanes: ['A'],
      nodes: [node('a', 'A'), node('b', 'A', 0), node('c', 'A')],
      edges: [],
    };

    const result = repairGeneratedLaneSequence(schema);
    expect(result.fallbackLanes).toEqual(['A']);
    expect(result.schema.nodes.map((item) => item.sequence_order)).toEqual([0, 1, 2]);
    expect(result.schema.edges.map((edge) => [edge.source, edge.target])).toEqual([['a', 'b'], ['b', 'c']]);
    expect(schema.nodes[0].sequence_order).toBeUndefined();
  });

  it('keeps adjacent edge metadata while correcting its direction', () => {
    const schema: VTASchema = {
      lanes: ['A'],
      nodes: [node('a', 'A', 0), node('b', 'A', 1)],
      edges: [{ source: 'a', target: 'b', direction: 'unidirectional', label: '手順', is_break: true }],
    };

    const result = repairGeneratedLaneSequence(schema);
    expect(result.schema.edges).toEqual([
      { source: 'a', target: 'b', direction: 'sequential', label: '手順', is_break: true },
    ]);
    expect(result.correctedDirections).toBe(1);
    expect(result.addedEdges).toBe(0);
  });
});
