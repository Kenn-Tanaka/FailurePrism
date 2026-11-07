import { describe, it, expect } from 'vitest';
import type { VTASchema, VTAAnalysisData } from '../../src/tools/vta/types/vta';
import {
  canDrilldownEntity,
  getDrilldownSubEntities,
  visibleSchema,
} from '../../src/tools/vta/features/vta/utils/presentation';
import { SubjectPoset } from '../../src/tools/vta/features/vta/utils/subjectPoset';

describe('VTA OLAP Drill-down & Roll-up (ADR-0011)', () => {
  const sampleAnalysis = {
    generation: {
      runId: 'r1',
      schemeId: 'event-chain',
      schemeVersion: '1.0',
      ruleVersion: '1.0',
      model: 'test',
      timestamp: '2026-11-06T00:00:00Z',
    },
    entities: [
      { id: 'A1', name: '機長', kind: 'person', parentEntityIds: ['A2'], mergedFrom: [] },
      { id: 'A3', name: '副操縦士', kind: 'person', parentEntityIds: ['A2'], mergedFrom: [] },
      { id: 'A2', name: '海上保安庁機', kind: 'organization', parentEntityIds: [], mergedFrom: ['A1', 'A3'] },
      { id: 'A4', name: '羽田管制所', kind: 'organization', parentEntityIds: [], mergedFrom: [] },
    ],
    subjectPoset: {
      nodes: ['A1', 'A3', 'A2', 'A4'],
      relations: [
        { childId: 'A1', parentId: 'A2' },
        { childId: 'A3', parentId: 'A2' },
      ],
      aliases: {},
    },
    events: [
      { id: 'E1', title: '滑走路進入許可と誤認', description: 'desc', time: '17:45', sourceOrder: 0, classification: 'normal' as const, origin: 'manual' as const, factIds: [] },
      { id: 'E2', title: '離陸順序チェック', description: 'desc', time: '17:46', sourceOrder: 1, classification: 'normal' as const, origin: 'manual' as const, factIds: [] },
      { id: 'E3', title: 'C滑走路進入', description: 'desc', time: '17:47', sourceOrder: 2, classification: 'normal' as const, origin: 'manual' as const, factIds: [] },
      { id: 'E4', title: 'タキシング指示', description: 'desc', time: '17:45', sourceOrder: 3, classification: 'normal' as const, origin: 'manual' as const, factIds: [] },
    ],
    participations: [
      { eventId: 'E1', entityId: 'A1', role: 'actor' as const, origin: 'manual' as const, factIds: [] }, // 機長
      { eventId: 'E2', entityId: 'A3', role: 'actor' as const, origin: 'manual' as const, factIds: [] }, // 副操縦士
      { eventId: 'E3', entityId: 'A2', role: 'actor' as const, origin: 'manual' as const, factIds: [] }, // 機体/海保全体
      { eventId: 'E4', entityId: 'A4', role: 'actor' as const, origin: 'manual' as const, factIds: [] }, // 管制所
    ],
    cards: [
      { id: 'card_1', laneEntityId: 'A2', eventIds: ['E1'] },
      { id: 'card_2', laneEntityId: 'A2', eventIds: ['E2'] },
      { id: 'card_3', laneEntityId: 'A2', eventIds: ['E3'] },
      { id: 'card_4', laneEntityId: 'A4', eventIds: ['E4'] },
    ],
    relations: [],
  } as unknown as VTAAnalysisData;

  const baseSchema: VTASchema = {
    lanes: ['海上保安庁機', '羽田管制所'],
    nodes: [
      { id: 'card_1', title: '機長誤認', lane: '海上保安庁機', time: '17:45', type: 'normal', description: '', measure_type: null },
      { id: 'card_2', title: '副操縦士確認', lane: '海上保安庁機', time: '17:46', type: 'normal', description: '', measure_type: null },
      { id: 'card_3', title: '滑走路進入', lane: '海上保安庁機', time: '17:47', type: 'normal', description: '', measure_type: null },
      { id: 'card_4', title: '管制指示', lane: '羽田管制所', time: '17:45', type: 'normal', description: '', measure_type: null },
    ],
    edges: [],
    analysis: sampleAnalysis,
    presentation: {
      lanes: {},
      suppressedCards: {},
    },
  };

  it('detects drill-down capability based on Poset DAG children and mergedFrom', () => {
    // 海上保安庁機 (A2) は A1 (機長) と A3 (副操縦士) を子主体に持つため展開可能
    expect(canDrilldownEntity('A2', sampleAnalysis)).toBe(true);

    // 羽田管制所 (A4) は子主体を持たないため展開不可
    expect(canDrilldownEntity('A4', sampleAnalysis)).toBe(false);

    // 機長 (A1) は葉ノードのため展開不可
    expect(canDrilldownEntity('A1', sampleAnalysis)).toBe(false);

    const subEntities = getDrilldownSubEntities('A2', sampleAnalysis);
    expect(subEntities.length).toBe(2);
    expect(subEntities.map((s) => s.name)).toContain('機長');
    expect(subEntities.map((s) => s.name)).toContain('副操縦士');
    expect(subEntities.map((s) => s.laneName)).toContain('海上保安庁機（機長）');
    expect(subEntities.map((s) => s.laneName)).toContain('海上保安庁機（副操縦士）');
  });

  it('keeps cards aggregated under parent lane when roll-up is active (default)', () => {
    const visible = visibleSchema(baseSchema);

    expect(visible.lanes).toEqual(['海上保安庁機', '羽田管制所']);
    expect(visible.nodes.find((n) => n.id === 'card_1')?.lane).toBe('海上保安庁機');
    expect(visible.nodes.find((n) => n.id === 'card_2')?.lane).toBe('海上保安庁機');
    expect(visible.nodes.find((n) => n.id === 'card_3')?.lane).toBe('海上保安庁機');
    expect(visible.nodes.find((n) => n.id === 'card_4')?.lane).toBe('羽田管制所');
  });

  it('unpacks sub-lanes and reallocates cards when drill-down is enabled', () => {
    const drilldownSchema: VTASchema = {
      ...baseSchema,
      presentation: {
        ...baseSchema.presentation!,
        drilldownLanes: {
          A2: true, // 海上保安庁機を展開
        },
      },
    };

    const visible = visibleSchema(drilldownSchema);

    // 親レーンの直後にサブレーンが挿入される
    expect(visible.lanes).toContain('海上保安庁機');
    expect(visible.lanes).toContain('海上保安庁機（機長）');
    expect(visible.lanes).toContain('海上保安庁機（副操縦士）');
    expect(visible.lanes).toContain('羽田管制所');

    // レーンの順序検証: 海上保安庁機の直後に子主体サブレーンが並ぶ
    const kaihoIdx = visible.lanes.indexOf('海上保安庁機');
    const kichoIdx = visible.lanes.indexOf('海上保安庁機（機長）');
    const fukusoIdx = visible.lanes.indexOf('海上保安庁機（副操縦士）');
    const kanseiIdx = visible.lanes.indexOf('羽田管制所');

    expect(kichoIdx).toBeGreaterThan(kaihoIdx);
    expect(fukusoIdx).toBeGreaterThan(kaihoIdx);
    expect(kanseiIdx).toBeGreaterThan(kichoIdx);
    expect(kanseiIdx).toBeGreaterThan(fukusoIdx);

    // カードのレーン再配分検証
    const c1 = visible.nodes.find((n) => n.id === 'card_1');
    const c2 = visible.nodes.find((n) => n.id === 'card_2');
    const c3 = visible.nodes.find((n) => n.id === 'card_3');
    const c4 = visible.nodes.find((n) => n.id === 'card_4');

    expect(c1?.lane).toBe('海上保安庁機（機長）');
    expect(c2?.lane).toBe('海上保安庁機（副操縦士）');
    expect(c3?.lane).toBe('海上保安庁機'); // 親組織全体のイベントは親レーンに留まる
    expect(c4?.lane).toBe('羽田管制所');
  });

  it('re-consolidates cleanly back to parent lane when collapsed (non-destructive roll-up)', () => {
    const collapsedSchema: VTASchema = {
      ...baseSchema,
      presentation: {
        ...baseSchema.presentation!,
        drilldownLanes: {
          A2: false, // 再度折りたたみ
        },
      },
    };

    const visible = visibleSchema(collapsedSchema);

    expect(visible.lanes).toEqual(['海上保安庁機', '羽田管制所']);
    expect(visible.nodes.every((n) => n.lane === '海上保安庁機' || n.lane === '羽田管制所')).toBe(true);
    expect(visible.nodes.find((n) => n.id === 'card_1')?.lane).toBe('海上保安庁機');
    expect(visible.nodes.find((n) => n.id === 'card_2')?.lane).toBe('海上保安庁機');
  });
});
