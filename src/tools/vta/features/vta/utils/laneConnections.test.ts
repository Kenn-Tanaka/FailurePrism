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

  it('preserves generated and user-edited semantic relation edges (relationId) and edges in other-actors lanes', () => {
    const schema: VTASchema = {
      lanes: ['その他の関係者', 'B機客室乗務員'],
      nodes: [
        { id: 'c1', lane: 'B機客室乗務員', time: '17:48', sequence_order: 0, title: '出口不可判断', description: '', type: 'normal', measure_type: null },
        { id: 'c2', lane: 'B機客室乗務員', time: '17:49', sequence_order: 1, title: '乗客誘導', description: '', type: 'normal', measure_type: null },
        { id: 'c3', lane: 'B機客室乗務員', time: '17:51', sequence_order: 2, title: 'ドア開放', description: '', type: 'normal', measure_type: null },
        { id: 'o1', lane: 'その他の関係者', time: '17:46', sequence_order: 0, title: '消防準備', description: '', type: 'normal', measure_type: null },
        { id: 'o2', lane: 'その他の関係者', time: '17:47', sequence_order: 1, title: '現場到着', description: '', type: 'normal', measure_type: null },
      ],
      edges: [
        // Non-adjacent semantic dependency consolidated into the same parent lane (reproducing R21)
        { id: 'relation:R21', relationId: 'R21', generated: true, meaning: 'dependency', source: 'c1', target: 'c3', direction: 'unidirectional', label: '作業依存', is_break: false },
        // Adjacent semantic transfer manually edited by user (generated: false, relationId still set)
        { id: 'relation:R22', relationId: 'R22', generated: false, meaning: 'transfer', source: 'c1', target: 'c2', direction: 'unidirectional', label: '情報伝達', is_break: true },
        // Semantic edge inside subject_others lane must never be stripped as a shortcut
        { id: 'relation:R30', relationId: 'R30', generated: true, meaning: 'impact', source: 'o1', target: 'o2', direction: 'unidirectional', label: '影響', is_break: false },
        // Unrelated manual edge inside subject_others lane must also be preserved
        { id: 'manual_other', source: 'o1', target: 'o2', direction: 'unidirectional', label: '手動接続', is_break: false },
      ],
      analysis: {
        version: 5,
        sources: [],
        facts: [],
        events: [],
        entities: [
          { id: 'subject_others', name: 'その他の関係者', kind: 'other', aggregate: true },
          { id: 'ORG_B_CABIN', name: 'B機客室乗務員', kind: 'organization' },
        ],
        participations: [],
        relations: [],
        cards: [],
        unassignedEventIds: [],
      },
    };
    const orders = new Map<string, string[]>([
      ['その他の関係者', ['o1', 'o2']],
      ['B機客室乗務員', ['c1', 'c2', 'c3']],
    ]);

    const repaired = repairLaneConnections(schema, orders);
    // R21, R22 (with generated:false & is_break:true), R30, and manual_other are all preserved intact
    expect(repaired.schema.edges.find((e) => e.id === 'relation:R21')).toMatchObject({
      source: 'c1',
      target: 'c3',
      direction: 'unidirectional',
      meaning: 'dependency',
    });
    expect(repaired.schema.edges.find((e) => e.id === 'relation:R22')).toMatchObject({
      source: 'c1',
      target: 'c2',
      direction: 'unidirectional',
      is_break: true,
      generated: false,
    });
    expect(repaired.schema.edges.find((e) => e.id === 'relation:R30')).toBeDefined();
    expect(repaired.schema.edges.find((e) => e.id === 'manual_other')).toBeDefined();
    // Sequential edge c2 -> c3 is added, while c1 -> c2 is not duplicated because relation:R22 already covers it forward
    expect(repaired.addedEdges).toBe(1);
    expect(repaired.removedEdges).toBe(0);
    expect(repaired.schema.edges.some((e) => e.source === 'c2' && e.target === 'c3' && e.direction === 'sequential')).toBe(true);
    expect(repaired.schema.edges.filter((e) => e.source === 'c1' && e.target === 'c2')).toHaveLength(1);
  });

  it('prunes uncustomized sequential duplicates when an intra-lane semantic relation already covers the same adjacent pair', () => {
    const schema: VTASchema = {
      lanes: ['A機乗組員'],
      nodes: [
        { id: 'c29', lane: 'A機乗組員', time: '17:46', sequence_order: 0, title: '前', description: '', type: 'normal', measure_type: null },
        { id: 'c30', lane: 'A機乗組員', time: '17:47', sequence_order: 1, title: '後', description: '', type: 'normal', measure_type: null },
      ],
      edges: [
        { id: 'e-c29-c30', source: 'c29', target: 'c30', direction: 'sequential', is_break: false },
        { id: 'relation:R28', relationId: 'R28', generated: true, source: 'c29', target: 'c30', direction: 'unidirectional', label: '情報', is_break: false },
      ],
    };
    const repaired = repairLaneConnections(schema, new Map([['A機乗組員', ['c29', 'c30']]]));
    expect(repaired.removedEdges).toBe(1);
    expect(repaired.schema.edges).toHaveLength(1);
    expect(repaired.schema.edges[0].id).toBe('relation:R28');
  });
});
