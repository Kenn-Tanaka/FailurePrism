import { describe, expect, it } from 'vitest';
import type { VTAAnalysisData, VTASchema } from '../../../types/vta';
import { projectAnalysis, reconcileAnalysis } from './eventAnalysis';
import { maintainPresentation, planCardSimplification, visibleSchema } from './presentation';
import { computeVTADataHash } from './hash';
import { validateAndSanitizeProjectFile } from './schemaValidator';
import fs from 'node:fs';

export function sharedFixture(): VTASchema {
  const analysis: VTAAnalysisData = {
    version: 5, sources: [{ id: 's', text: '09:00 共同行動', paragraphs: [{ id: 'p1', text: '09:00 共同行動' }] }],
    facts: [{ id: 'f', text: '共同行動', kind: 'recorded', evidence: [{ sourceId: 's', paragraphId: 'p1', quote: '09:00 共同行動' }] }],
    events: [{ id: 'e', title: '共同行動', description: '本文', time: '09:00', factIds: ['f'], sourceOrder: 0, classification: 'unclassified' }],
    entities: ['A', 'B', 'C'].map((name) => ({ id: name, name, kind: 'person' })),
    participations: ['A', 'B', 'C'].map((entityId) => ({ eventId: 'e', entityId, role: 'actor', factIds: ['f'] })),
    relations: [], cards: ['A', 'B', 'C'].map((laneEntityId) => ({ id: laneEntityId, laneEntityId, eventIds: ['e'] })), unassignedEventIds: [],
  };
  return projectAnalysis(analysis);
}

describe('card simplification and visibility', () => {
  it('loads the distributed example in the new format', () => {
    const project = JSON.parse(fs.readFileSync('samples/sample-project.vta.json', 'utf8'));
    const loaded = validateAndSanitizeProjectFile(project);
    expect(loaded.isValid).toBe(true);
    expect(visibleSchema(loaded.data!.vtaData).nodes).toHaveLength(2);
  });
  it('rejects a saved presentation that removes every copy of an event', () => {
    const schema = sharedFixture();
    schema.presentation!.suppressedCards.A = '誤った除外';
    expect(validateAndSanitizeProjectFile({ version: '5.0', vtaData: schema }).isValid).toBe(false);
  });
  it('keeps one stable representative without deleting canonical participation', () => {
    const schema = sharedFixture();
    expect(visibleSchema(schema).nodes.map((node) => node.id)).toEqual(['A']);
    expect(schema.analysis?.cards).toHaveLength(3);
    expect(schema.analysis?.participations).toHaveLength(3);
    expect(planCardSimplification({ ...schema, lanes: ['C', 'B', 'A'] })).toEqual(schema.presentation);
    expect(planCardSimplification(schema)).toEqual(schema.presentation);
    expect(maintainPresentation(schema)).toEqual(schema);
  });
  it('does not remove a grouped card if even one event has no other representation', () => {
    const schema = sharedFixture(); const analysis = structuredClone(schema.analysis!);
    analysis.events.push({ ...analysis.events[0], id: 'unique' });
    analysis.cards[2].eventIds.push('unique');
    analysis.participations.push({ ...analysis.participations[2], eventId: 'unique' });
    const result = planCardSimplification({ ...schema, analysis });
    expect(result.suppressedCards.C).toBeUndefined();
  });
  it('protects all candidates of an ambiguous semantic endpoint before pruning', () => {
    const schema = sharedFixture();
    schema.analysis!.relations = [{ sourceEventId: 'e', targetEventId: 'e', kind: 'transfer', factIds: ['f'], targetEntityId: 'C' }];
    expect(planCardSimplification(schema).suppressedCards).toEqual({});
  });
  it.each(['junction', 'note', 'measure', 'manual', 'break'] as const)('protects %s edits', (kind) => {
    const schema = sharedFixture();
    if (kind === 'junction') schema.nodes[2].is_hidden = true;
    if (kind === 'note') schema.nodes[2].supplementary_note = '保存するメモ';
    if (kind === 'measure') schema.nodes[2].measure_type = 'elimination';
    if (kind === 'manual') schema.analysis!.events[0].origin = 'manual';
    if (kind === 'break') schema.edges = [{ source: 'A', target: 'C', is_break: true }];
    expect(planCardSimplification(schema).suppressedCards.C).toBeUndefined();
  });
  it('restores a manually shown lane and does not reopen others when the last shown lane is hidden', () => {
    const schema = sharedFixture();
    const hidden = maintainPresentation({ ...schema, presentation: { ...schema.presentation!, lanes: { A: 'hide' } } });
    expect(visibleSchema(hidden).nodes).toHaveLength(0);
    const shown = maintainPresentation({ ...hidden, presentation: { ...hidden.presentation!, lanes: { A: 'hide', C: 'show' } } });
    expect(visibleSchema(shown).nodes.map((node) => node.id)).toEqual(['C']);
    expect(shown.presentation?.suppressedCards.C).toBeUndefined();
  });
  it('never relies on a manually hidden lane to suppress the remaining visible event', () => {
    const schema = sharedFixture();
    schema.presentation!.lanes = { A: 'hide', B: 'hide' };
    expect(planCardSimplification(schema).suppressedCards.C).toBeUndefined();
  });
  it('retains hidden records on an ordinary edit, and restores another copy after a real deletion', () => {
    const schema = sharedFixture();
    const moved = reconcileAnalysis(schema, { ...schema, nodes: schema.nodes.map((node) => node.id === 'A' ? { ...node, position: { x: 77, y: 100 } } : node) });
    expect(moved.analysis?.cards).toHaveLength(3);
    const deleted = reconcileAnalysis(moved, { ...moved, nodes: moved.nodes.filter((node) => node.id !== 'A') });
    expect(deleted.analysis?.cards).toHaveLength(2);
    expect(visibleSchema(deleted).nodes.length).toBeGreaterThan(0);
  });
  it('saves exclusions and keeps analysis hash unchanged by display settings', () => {
    const schema = sharedFixture();
    const allShown = { ...schema, presentation: { lanes: { A: 'show', B: 'show', C: 'show' } as const, suppressedCards: {} } };
    expect(computeVTADataHash(schema)).toBe(computeVTADataHash(allShown));
    const saved = validateAndSanitizeProjectFile(JSON.parse(JSON.stringify({ version: '5.0', vtaData: schema })));
    expect(saved.isValid).toBe(true);
    expect(saved.data?.vtaData.presentation).toEqual(schema.presentation);
    expect(visibleSchema(saved.data!.vtaData).nodes).toHaveLength(1);
  });
});
