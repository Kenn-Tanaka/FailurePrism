import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import type { VTASchema } from '../../../types/vta';
import { calculateVTALayout, computeTimeRanks } from './layout';
import { projectAnalysis } from './eventAnalysis';
import { getDisplayRect } from './nodeGeometry';
function fixture() {
  const schema = JSON.parse(fs.readFileSync('samples/sample-project.vta.json','utf8')).vtaData as VTASchema;
  const previous = structuredClone(schema);
  const analysis = schema.analysis!;
  analysis.events.forEach((event) => { event.time = ''; });
  const first = analysis.events[0];
  analysis.events.push({ ...first, id: 'earlier', sourceOrder: -1 });
  analysis.cards.push({ id: 'earlyCard', laneEntityId: analysis.entities[1].id, eventIds: ['earlier'] });
  analysis.participations.push({ eventId: 'earlier', entityId: analysis.entities[1].id, role: 'actor', factIds: [] });
  const result = projectAnalysis(analysis, previous);
  result.presentation = { lanes: Object.fromEntries(analysis.entities.map((entity) => [entity.id,'show'])), suppressedCards: {} };
  return result;
}
describe('global event timing without clock times', () => {
  it('aligns shared event IDs despite different local lane sequence numbers', () => {
    const schema = fixture(); const ranks = computeTimeRanks(schema);
    const shared = schema.nodes.filter((node) => node.event_ids?.includes('E1'));
    expect(new Set(shared.map((node) => node.sequence_order)).size).toBeGreaterThan(1);
    expect(ranks.get(shared[0].id)).toBe(ranks.get(shared[1].id));
    expect(ranks.get('earlyCard')).toBeLessThan(ranks.get(shared[0].id)!);
    expect(ranks.get(schema.nodes.find((node) => node.event_ids?.includes('E2'))!.id)).toBeGreaterThan(ranks.get(shared[0].id)!);
  });
  it('prioritizes a recorded causal order over source description order', () => {
    const schema = fixture(); schema.edges = [];
    schema.analysis!.relations = [{ sourceEventId: 'E2', targetEventId: 'E1', kind: 'impact', factIds: [] }];
    const ranks = computeTimeRanks(schema);
    expect(ranks.get(schema.nodes.find((node) => node.event_ids?.includes('E2'))!.id)).toBeLessThan(ranks.get(schema.nodes.find((node) => node.event_ids?.includes('E1'))!.id)!);
  });
  it.each([false,true])('aligns card and junction centers in compact=%s', (compact) => {
    const schema = fixture(); const shared = schema.nodes.filter((node) => node.event_ids?.includes('E1'));
    shared[1].is_hidden = true;
    const layout = calculateVTALayout(schema, undefined, undefined, { forceRecompute: true, compact });
    const centers = shared.map((node) => { const rect = getDisplayRect(layout.nodes.find((item) => item.id === node.id)!); return rect.y + rect.height / 2; });
    expect(centers[0]).toBeCloseTo(centers[1]);
  });

  it('assigns identical ranks to concurrent/independent events across different lanes (Poset leveling)', () => {
    // 2 lanes, Lane A has eA1 -> eA2, Lane B has eB1 -> eB2
    // No cross-lane dependencies between A and B
    const schema: VTASchema = {
      lanes: ['LaneA', 'LaneB'],
      nodes: [
        { id: 'nodeA1', title: 'A1', description: 'Desc A1', time: '', type: 'normal', measure_type: null, lane: 'LaneA', sequence_order: 1, event_ids: ['eA1'] },
        { id: 'nodeA2', title: 'A2', description: 'Desc A2', time: '', type: 'normal', measure_type: null, lane: 'LaneA', sequence_order: 2, event_ids: ['eA2'] },
        { id: 'nodeB1', title: 'B1', description: 'Desc B1', time: '', type: 'normal', measure_type: null, lane: 'LaneB', sequence_order: 1, event_ids: ['eB1'] },
        { id: 'nodeB2', title: 'B2', description: 'Desc B2', time: '', type: 'normal', measure_type: null, lane: 'LaneB', sequence_order: 2, event_ids: ['eB2'] },
      ],
      edges: [],
      analysis: {
        version: 5,
        sources: [],
        unassignedEventIds: [],
        entities: [
          { id: 'entA', name: 'LaneA', kind: 'person' },
          { id: 'entB', name: 'LaneB', kind: 'machine' },
        ],
        events: [
          { id: 'eA1', sourceOrder: 0, title: 'A1', description: 'Event A1', time: '', factIds: [], classification: 'normal' },
          { id: 'eA2', sourceOrder: 1, title: 'A2', description: 'Event A2', time: '', factIds: [], classification: 'normal' },
          { id: 'eB1', sourceOrder: 2, title: 'B1', description: 'Event B1', time: '', factIds: [], classification: 'normal' },
          { id: 'eB2', sourceOrder: 3, title: 'B2', description: 'Event B2', time: '', factIds: [], classification: 'normal' },
        ],
        relations: [],
        cards: [
          { id: 'nodeA1', laneEntityId: 'entA', eventIds: ['eA1'] },
          { id: 'nodeA2', laneEntityId: 'entA', eventIds: ['eA2'] },
          { id: 'nodeB1', laneEntityId: 'entB', eventIds: ['eB1'] },
          { id: 'nodeB2', laneEntityId: 'entB', eventIds: ['eB2'] },
        ],
        participations: [
          { eventId: 'eA1', entityId: 'entA', role: 'actor', factIds: [] },
          { eventId: 'eA2', entityId: 'entA', role: 'actor', factIds: [] },
          { eventId: 'eB1', entityId: 'entB', role: 'actor', factIds: [] },
          { eventId: 'eB2', entityId: 'entB', role: 'actor', factIds: [] },
        ],
        facts: [],
      },
    };

    const ranks = computeTimeRanks(schema);

    // eA1 and eB1 are both the first event in their respective lanes with no cross dependency -> same rank 0
    expect(ranks.get('nodeA1')).toBe(0);
    expect(ranks.get('nodeB1')).toBe(0);

    // eA2 and eB2 are the second event in their respective lanes -> same rank 1
    expect(ranks.get('nodeA2')).toBe(1);
    expect(ranks.get('nodeB2')).toBe(1);
  });
});
