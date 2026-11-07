import { describe, it, expect } from 'vitest';
import { detectGranularityProposals } from './subjectGranularityProposals';
import type { VTAAnalysisData } from '../../../types/vta';

describe('detectGranularityProposals', () => {
  it('detects vehicle crew merge proposal for A-plane crew members', () => {
    const analysis: VTAAnalysisData = {
      version: 5,
      sources: [{ id: 's1', text: 'test', paragraphs: [{ id: 'p1', text: 'test' }] }],
      facts: [],
      events: [
        { id: 'E1', title: '滑走路手前で停止指示を受領', description: '', time: '17:45:00', sourceOrder: 0, factIds: [], classification: 'normal', origin: 'extraction' },
        { id: 'E2', title: '滑走路進入の復唱', description: '', time: '17:45:30', sourceOrder: 1, factIds: [], classification: 'variation', origin: 'extraction' },
      ],
      entities: [
        { id: 'A1', name: '機長Ａ', kind: 'person', parentEntityId: 'A12' },
        { id: 'A2', name: '副操縦員Ａ', kind: 'person', parentEntityId: 'A12' },
        { id: 'A12', name: '海上保安庁', kind: 'organization' },
        { id: 'C5', name: 'タワー東', kind: 'person', parentEntityId: 'C8' },
      ],
      participations: [
        { eventId: 'E1', entityId: 'A1', role: 'actor', factIds: [] },
        { eventId: 'E2', entityId: 'A2', role: 'actor', factIds: [] },
      ],
      relations: [],
      cards: [],
      unassignedEventIds: [],
    };

    const proposals = detectGranularityProposals(analysis);
    expect(proposals.merges.length).toBeGreaterThanOrEqual(1);

    const crewMerge = proposals.merges.find((m) => m.id === 'merge_crew_A');
    expect(crewMerge).toBeDefined();
    expect(crewMerge?.sourceEntityNames).toContain('機長Ａ');
    expect(crewMerge?.sourceEntityNames).toContain('副操縦員Ａ');
    expect(crewMerge?.suggestedTargetName).toBe('Ａ機');
    expect(crewMerge?.category).toBe('vehicle_crew');
  });

  it('detects common parent merge proposal when entities share parentEntityId', () => {
    const analysis: VTAAnalysisData = {
      version: 5,
      sources: [{ id: 's1', text: 'test', paragraphs: [{ id: 'p1', text: 'test' }] }],
      facts: [],
      events: [],
      entities: [
        { id: 'C1', name: 'グラウンド東', kind: 'person', parentEntityId: 'C8' },
        { id: 'C2', name: 'タワー東', kind: 'person', parentEntityId: 'C8' },
        { id: 'C8', name: '東京ターミナル管制所', kind: 'organization' },
      ],
      participations: [],
      relations: [],
      cards: [],
      unassignedEventIds: [],
    };

    const proposals = detectGranularityProposals(analysis);
    const parentMerge = proposals.merges.find((m) => m.category === 'common_parent');
    expect(parentMerge).toBeDefined();
    expect(parentMerge?.suggestedTargetName).toBe('東京ターミナル管制所');
    expect(parentMerge?.sourceEntityIds).toEqual(['C1', 'C2']);
  });

  it('detects common parent merge proposal with multi-parent parentEntityIds via SubjectPoset', () => {
    const analysis: VTAAnalysisData = {
      version: 5,
      sources: [{ id: 's1', text: 'test', paragraphs: [{ id: 'p1', text: 'test' }] }],
      facts: [],
      events: [],
      entities: [
        { id: 'M1', name: '保守員1', kind: 'person', parentEntityIds: ['ORG_A', 'TEAM_X'] },
        { id: 'M2', name: '保守員2', kind: 'person', parentEntityIds: ['ORG_A', 'TEAM_Y'] },
        { id: 'ORG_A', name: '保守技術部', kind: 'organization' },
        { id: 'TEAM_X', name: 'チームX', kind: 'organization' },
        { id: 'TEAM_Y', name: 'チームY', kind: 'organization' },
      ],
      participations: [],
      relations: [],
      cards: [],
      unassignedEventIds: [],
    };

    const proposals = detectGranularityProposals(analysis);
    const parentMerge = proposals.merges.find(
      (m) => m.category === 'common_parent' && m.targetEntityId === 'ORG_A'
    );
    expect(parentMerge).toBeDefined();
    expect(parentMerge?.sourceEntityNames).toContain('保守員1');
    expect(parentMerge?.sourceEntityNames).toContain('保守員2');
  });

  it('detects CRM split proposal when integrated parent entity has internal relations', () => {
    const analysis: VTAAnalysisData = {
      version: 5,
      sources: [{ id: 's1', text: 'test', paragraphs: [{ id: 'p1', text: 'test' }] }],
      facts: [],
      events: [
        { id: 'E1', title: '滑走路進入指示の認識', description: '', time: '17:45:00', sourceOrder: 0, factIds: [], classification: 'normal', origin: 'extraction' },
        { id: 'E2', title: '確認・復唱', description: '', time: '17:45:30', sourceOrder: 1, factIds: [], classification: 'normal', origin: 'extraction' },
      ],
      entities: [
        { id: 'A_plane', name: 'Ａ機', kind: 'machine', aggregate: true },
      ],
      participations: [
        {
          eventId: 'E1',
          entityId: 'A_plane',
          role: 'actor',
          factIds: [],
          mergedFrom: [{ entityId: 'A1', role: 'actor' }],
        },
        {
          eventId: 'E2',
          entityId: 'A_plane',
          role: 'actor',
          factIds: [],
          mergedFrom: [{ entityId: 'A2', role: 'actor' }],
        },
      ],
      relations: [
        {
          id: 'R1',
          kind: 'transfer',
          sourceEventId: 'E1',
          sourceEntityId: 'A_plane',
          sourceEntityOrigin: 'A1',
          targetEventId: 'E2',
          targetEntityId: 'A_plane',
          targetEntityOrigin: 'A2',
          factIds: [],
        },
      ],
      cards: [],
      unassignedEventIds: [],
      subjectRanking: {
        version: 1,
        maxSubjects: 5,
        weights: { A: 1, O: 1, F: 1, C: 1, T: 1 },
        originalEntities: [
          { id: 'A1', name: '機長Ａ', kind: 'person' },
          { id: 'A2', name: '副操縦員Ａ', kind: 'person' },
          { id: 'A_plane', name: 'Ａ機', kind: 'machine' },
        ],
        ranks: [
          { entityId: 'A1', rank: 1, score: 0.8, breakdown: { A: 1, O: 1, F: 1, C: 1, T: 1 }, retained: false, mergedInto: 'A_plane', reason: '統合' },
          { entityId: 'A2', rank: 2, score: 0.7, breakdown: { A: 1, O: 1, F: 1, C: 1, T: 1 }, retained: false, mergedInto: 'A_plane', reason: '統合' },
          { entityId: 'A_plane', rank: 0, score: 1.0, breakdown: { A: 1, O: 1, F: 1, C: 1, T: 1 }, retained: true, reason: '保持' },
        ],
      },
    };

    const proposals = detectGranularityProposals(analysis);
    expect(proposals.splits.length).toBeGreaterThanOrEqual(1);

    const crmSplit = proposals.splits.find((s) => s.category === 'crm_interaction');
    expect(crmSplit).toBeDefined();
    expect(crmSplit?.parentEntityName).toBe('Ａ機');
    expect(crmSplit?.splitEntityNames).toContain('機長Ａ');
    expect(crmSplit?.splitEntityNames).toContain('副操縦員Ａ');
    expect(crmSplit?.internalRelationsCount).toBe(1);
  });
});
