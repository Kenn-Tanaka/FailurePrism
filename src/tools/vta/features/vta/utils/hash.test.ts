import { describe, it, expect } from 'vitest';
import { computeVTADataHash, fnv1a } from './hash';
import { VTASchema } from '../../../types/vta';

describe('hash.ts - Deterministic Semantic Hashing for Report Version Tracking (DATA-003)', () => {
  const baseSchema: VTASchema = {
    lanes: ['製造課', '品証課'],
    nodes: [
      {
        id: 'n1',
        lane: '製造課',
        time: '10:00',
        title: '作業開始',
        description: '点検手順の実行',
        type: 'normal',
        measure_type: null,
        position: { x: 100, y: 200 },
      },
      {
        id: 'n2',
        lane: '品証課',
        time: '10:15',
        title: '検査省略',
        description: '測定器のゼロ点合わせを行わず',
        type: 'variation',
        measure_type: 'elimination',
        position: { x: 400, y: 200 },
      },
    ],
    edges: [
      {
        source: 'n1',
        target: 'n2',
        is_break: true,
        direction: 'unidirectional',
        label: '連絡票',
      },
    ],
  };

  it('should return identical hash for identical data irrespective of object property order', () => {
    const hash1 = computeVTADataHash(baseSchema, '事故シナリオ本文');
    const hash2 = computeVTADataHash(JSON.parse(JSON.stringify(baseSchema)), '事故シナリオ本文');
    expect(hash1).toBe(hash2);
    expect(typeof hash1).toBe('string');
    expect(hash1.length).toBe(8);
  });

  it('should return identical hash when node coordinates change (ignoring visual position)', () => {
    const movedSchema: VTASchema = JSON.parse(JSON.stringify(baseSchema));
    movedSchema.nodes[0].position = { x: 999, y: 888 };
    movedSchema.nodes[1].position = { x: 777, y: 666 };

    const hash1 = computeVTADataHash(baseSchema, '事故シナリオ');
    const hash2 = computeVTADataHash(movedSchema, '事故シナリオ');
    expect(hash1).toBe(hash2);
  });

  it('should detect node measure_type changes (e.g. elimination added/removed)', () => {
    const modifiedSchema: VTASchema = JSON.parse(JSON.stringify(baseSchema));
    modifiedSchema.nodes[1].measure_type = null;

    const hash1 = computeVTADataHash(baseSchema, '事故シナリオ');
    const hash2 = computeVTADataHash(modifiedSchema, '事故シナリオ');
    expect(hash1).not.toBe(hash2);
  });

  it('should detect edge break toggle changes', () => {
    const modifiedSchema: VTASchema = JSON.parse(JSON.stringify(baseSchema));
    modifiedSchema.edges[0].is_break = false;

    const hash1 = computeVTADataHash(baseSchema, '事故シナリオ');
    const hash2 = computeVTADataHash(modifiedSchema, '事故シナリオ');
    expect(hash1).not.toBe(hash2);
  });

  it('should detect scenario text edits', () => {
    const hash1 = computeVTADataHash(baseSchema, '元のシナリオ');
    const hash2 = computeVTADataHash(baseSchema, '編集されたシナリオ');
    expect(hash1).not.toBe(hash2);
  });

  it('fnv1a should produce consistent non-empty strings', () => {
    expect(fnv1a('hello')).toBe(fnv1a('hello'));
    expect(fnv1a('hello')).not.toBe(fnv1a('world'));
  });

  it('should ignore normalizationAudit and event.preliminary metadata so audit records do not invalidate reports', () => {
    const withAnalysis: VTASchema = {
      ...baseSchema,
      analysis: {
        version: 5,
        sources: [{ id: 's1', text: 'テスト', paragraphs: [{ id: 'p1', text: 'テスト' }] }],
        facts: [],
        events: [
          {
            id: 'e1',
            origin: 'extraction',
            title: '作業開始',
            description: '点検手順の実行',
            time: '10:00',
            sourceOrder: 0,
            factIds: [],
            sourceRefs: [{ sourceId: 's1', paragraphId: 'p1' }],
            classification: 'normal',
            measure_type: null,
          },
        ],
        entities: [{ id: 'ent1', name: '製造課', kind: 'organization' }],
        participations: [{ eventId: 'e1', entityId: 'ent1', role: 'actor', factIds: [] }],
        relations: [],
        cards: [{ id: 'n1', laneEntityId: 'ent1', eventIds: ['e1'] }],
        unassignedEventIds: [],
      },
    };
    const withAudit: VTASchema = JSON.parse(JSON.stringify(withAnalysis));
    withAudit.analysis!.events[0].preliminary = {
      value: 'normal',
      reason: '仮判定理由',
      sourceRefs: [{ sourceId: 's1', paragraphId: 'p1' }],
    };
    withAudit.analysis!.normalizationAudit = {
      version: 1,
      corrections: [
        {
          id: 'C1',
          kind: 'alias_unification',
          from: '旧称',
          to: '新称',
          sourceRefs: [{ sourceId: 's1', paragraphId: 'p1' }],
          reason: '統一',
          detectedBy: 'llm',
        },
      ],
      subjectiveNotices: [],
    };
    expect(computeVTADataHash(withAnalysis, 'テスト')).toBe(computeVTADataHash(withAudit, 'テスト'));
  });
});
