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
});
