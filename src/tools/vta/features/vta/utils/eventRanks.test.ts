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
});
