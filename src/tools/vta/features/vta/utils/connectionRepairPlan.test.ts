import { describe, expect, it } from 'vitest';
import type { VTASchema } from '../../../types/vta';
import { calculateVTALayout } from './layout';
import { createConnectionRepairPlan } from './connectionRepairPlan';

describe('connection repair plan view-specific ordering', () => {
  it('uses compact order and previews reflow of the detailed view when they disagree', () => {
    const schema: VTASchema = { lanes: ['A'], nodes: [
      { id: 'a', lane: 'A', time: '', title: 'A', description: '', type: 'normal', measure_type: null, position: { x: 100, y: 0 }, compact_position: { x: 100, y: 300 } },
      { id: 'b', lane: 'A', time: '', title: 'B', description: '', type: 'normal', measure_type: null, position: { x: 100, y: 300 }, compact_position: { x: 100, y: 0 } },
    ], edges: [] };
    const compactNodes = calculateVTALayout(schema, undefined, undefined, { compact: true, positionField: 'compact_position' }).nodes;
    const plan = createConnectionRepairPlan(schema, compactNodes, 'compact');
    expect(plan.schema.edges).toEqual([expect.objectContaining({ source: 'a', target: 'b', direction: 'sequential' })]);
    expect(plan.viewMode).toBe('compact');
    expect(plan.layoutChanges).toEqual([{ lane: 'A', nodeIds: ['a', 'b'] }]);
    expect(plan.schema.nodes.find((node) => node.id === 'a')?.position?.y).toBeGreaterThan(
      plan.schema.nodes.find((node) => node.id === 'b')?.position?.y ?? 0
    );
  });

  it('stores computed coordinates for an unsaved node when reflowing the other view', () => {
    const schema: VTASchema = { lanes: ['A'], nodes: [
      { id: 'a', lane: 'A', time: '10:00', title: 'A', description: '', type: 'normal', measure_type: null, position: { x: 100, y: 300 }, compact_position: { x: 100, y: 0 } },
      { id: 'b', lane: 'A', time: '11:00', title: 'B', description: '', type: 'normal', measure_type: null, position: { x: 100, y: 0 } },
    ], edges: [] };
    const detailNodes = calculateVTALayout(schema, undefined, undefined, { positionField: 'position' }).nodes;
    const plan = createConnectionRepairPlan(schema, detailNodes, 'detail');
    expect(plan.layoutChanges).toHaveLength(1);
    const compactA = plan.schema.nodes.find((node) => node.id === 'a')?.compact_position;
    const compactB = plan.schema.nodes.find((node) => node.id === 'b')?.compact_position;
    expect(compactB).toBeDefined();
    expect(compactA!.y).toBeGreaterThan(compactB!.y);
  });
});
