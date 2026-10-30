import { describe, expect, it } from 'vitest';
import type { VTASchema } from '../../../types/vta';
import { calculateVTALayout } from './layout';
import { getVisualLaneOrders, repairLaneConnections } from './laneConnections';
import { createConnectionRepairPlan } from './connectionRepairPlan';

export function repairFixture(): VTASchema {
  return {
    lanes: ['担当A', '担当B', '空列'],
    nodes: [
      { id: 'c', lane: '担当A', time: '09:00', sequence_order: 0, title: '上の事象', description: '内容C', type: 'normal', measure_type: null, position: { x: 110, y: 100 } },
      { id: 'a', lane: '担当A', time: '11:00', sequence_order: 2, title: '下の事象', description: '内容A', type: 'variation', measure_type: 'elimination', position: { x: 137, y: 1000 } },
      { id: 'b', lane: '担当A', time: '10:00', sequence_order: 1, title: '接続点', description: '内容B', supplementary_note: '補足', type: 'normal', measure_type: null, is_hidden: true, hidden_card_height: 200, position: { x: 110, y: 500 } },
      { id: 'x', lane: '担当B', time: '', title: '別レーン', description: '', type: 'normal', measure_type: null, position: { x: 490, y: 200 } },
    ],
    edges: [
      { source: 'a', target: 'c', direction: 'sequential', label: '削除対象', category: 'impact', is_break: true },
      { source: 'b', target: 'a', direction: 'bidirectional', label: '維持するラベル', category: 'handover', is_break: true },
      { source: 'c', target: 'x', direction: 'unidirectional', label: '伝達', is_break: true },
      { source: 'x', target: 'a', direction: 'bidirectional' },
    ],
  };
}

describe('lane connection repair', () => {
  it('uses visible order including junctions, preserves reverse-edge metadata and cross-lane relations', () => {
    const schema = repairFixture();
    const original = JSON.stringify(schema);
    const nodes = calculateVTALayout(schema).nodes;
    const plan = createConnectionRepairPlan(schema, nodes);
    expect(plan.issues).toEqual([]);
    expect(plan.addedEdges).toBe(1);
    expect(plan.removedEdges).toBe(1);
    expect(plan.correctedDirections).toBe(1);
    expect(plan.schema.edges).toContainEqual({ source: 'a', target: 'b', direction: 'sequential', label: '維持するラベル', category: 'handover', is_break: true });
    expect(plan.schema.edges).toContainEqual({ source: 'b', target: 'c', direction: 'sequential', is_break: false });
    expect(plan.schema.edges.slice(1, 3)).toEqual(schema.edges.slice(2));
    expect(plan.changes.find((change) => change.kind === 'removed')?.edge).toEqual(schema.edges[0]);
    expect(plan.schema.nodes).toEqual(schema.nodes);
    expect(JSON.stringify(schema)).toBe(original);
  });

  it('keeps lane adjacency through reload and both layouts even when cross-lane edges form a cycle', () => {
    const schema = repairFixture();
    const plan = createConnectionRepairPlan(schema, calculateVTALayout(schema).nodes);
    for (const compact of [false, true]) {
      const layout = calculateVTALayout(plan.schema, undefined, undefined, { compact, forceRecompute: true });
      const result = getVisualLaneOrders(plan.schema, layout.nodes);
      expect(result.issues).toEqual([]);
      expect(result.orders.get('担当A')).toEqual(['a', 'b', 'c']);
      expect(repairLaneConnections(plan.schema, result.orders).changes).toEqual([]);
      expect(layout.edges).toHaveLength(plan.schema.edges.length);
    }
    const reloaded = calculateVTALayout(JSON.parse(JSON.stringify(plan.schema)));
    expect(createConnectionRepairPlan(plan.schema, reloaded.nodes).changes).toEqual([]);
  });

  it('prefers the forward edge and reports duplicate/reverse metadata that will be removed', () => {
    const schema = repairFixture();
    schema.edges = [
      { source: 'b', target: 'a', label: 'reverse', is_break: true },
      { source: 'a', target: 'b', direction: 'sequential', label: 'forward' },
      { source: 'a', target: 'b', direction: 'sequential', label: 'duplicate' },
      { source: 'b', target: 'c', direction: 'sequential' },
    ];
    const plan = createConnectionRepairPlan(schema, calculateVTALayout(schema).nodes);
    expect(plan.removedEdges).toBe(2);
    expect(plan.addedEdges).toBe(0);
    expect(plan.correctedDirections).toBe(0);
    expect(plan.schema.edges).toEqual([schema.edges[1], schema.edges[3]]);
  });

  it('blocks ambiguous overlaps and missing display positions', () => {
    const schema = repairFixture();
    const nodes = calculateVTALayout(schema).nodes;
    const b = nodes.find((node) => node.id === 'b')!;
    const a = nodes.find((node) => node.id === 'a')!;
    b.position = { ...a.position };
    expect(createConnectionRepairPlan(schema, nodes).issues.join('')).toContain('重なっています');
    expect(createConnectionRepairPlan(schema, nodes.filter((node) => node.id !== 'b')).issues.join('')).toContain('表示位置を確認できません');
  });

  it('is a no-op for empty and single-node lanes', () => {
    const schema: VTASchema = { lanes: ['空列', '担当B'], nodes: [repairFixture().nodes[3]], edges: [] };
    expect(createConnectionRepairPlan(schema, calculateVTALayout(schema).nodes).changes).toEqual([]);
    expect(createConnectionRepairPlan({ lanes: [], nodes: [], edges: [] }, []).changes).toEqual([]);
  });
});
