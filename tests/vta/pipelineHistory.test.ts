import { describe, it, expect } from 'vitest';
import {
  createPipelineSnapshot,
  upsertPipelineSnapshot,
  reconstructPipelineSnapshots,
  resolvePipelineSnapshots,
} from '../../src/tools/vta/features/vta/utils/pipelineHistory';
import type { VTASchema, VTAAnalysisData } from '../../src/tools/vta/types/vta';

describe('VTA Pipeline History and Snapshots', () => {
  const dummySchema: VTASchema = {
    lanes: ['機長A', '副操縦士A'],
    nodes: [
      {
        id: 'node_1',
        lane: '機長A',
        time: '17:45:00',
        type: 'normal',
        title: '進入準備',
        description: '着陸前のブリーフィングを実施',
        measure_type: null,
      },
      {
        id: 'node_2',
        lane: '副操縦士A',
        time: '17:46:00',
        type: 'variation',
        title: '滑走路誤進入',
        description: '停止位置を通過して滑走路へ進入',
        measure_type: null,
        variation_factor: {
          category: 'departure',
          polarity: 'negative',
        },
      },
    ],
    edges: [
      {
        id: 'e1',
        source: 'node_1',
        target: 'node_2',
        direction: 'unidirectional',
      },
    ],
  };

  it('createPipelineSnapshot generates clean snapshot without nested sources', () => {
    const snap = createPipelineSnapshot(
      'stage1_normalize',
      0,
      'Stage 1: 全文正規化',
      'イベント 2件、主体 2列',
      '初期抽出',
      dummySchema
    );

    expect(snap.id).toBe('stage1_normalize');
    expect(snap.stageIndex).toBe(0);
    expect(snap.lanes).toEqual(['機長A', '副操縦士A']);
    expect(snap.nodes).toHaveLength(2);
    expect(snap.edges).toHaveLength(1);
    expect(snap.stats.variationCount).toBe(1);
    expect(snap.stats.outcomeCount).toBe(0);
  });

  it('upsertPipelineSnapshot adds and updates snapshots keeping stageIndex sorted', () => {
    const s1 = createPipelineSnapshot('stage1_normalize', 0, 'S1', '', '', dummySchema);
    const s3 = createPipelineSnapshot('stage3_connect', 2, 'S3', '', '', dummySchema);
    const s2 = createPipelineSnapshot('stage2_refine', 1, 'S2', '', '', dummySchema);

    let history = upsertPipelineSnapshot([], s1);
    history = upsertPipelineSnapshot(history, s3);
    history = upsertPipelineSnapshot(history, s2);

    expect(history.map((h) => h.id)).toEqual(['stage1_normalize', 'stage2_refine', 'stage3_connect']);

    // Overwrite s2
    const s2Updated = createPipelineSnapshot('stage2_refine', 1, 'S2 Updated', '', '', dummySchema);
    history = upsertPipelineSnapshot(history, s2Updated);
    expect(history).toHaveLength(3);
    expect(history[1].title).toBe('S2 Updated');
  });

  it('reconstructPipelineSnapshots restores 4 stages from schema without existing pipelineHistory', () => {
    const snapshots = reconstructPipelineSnapshots(dummySchema);
    expect(snapshots).toHaveLength(4);
    expect(snapshots.map((s) => s.id)).toEqual([
      'stage1_normalize',
      'stage2_refine',
      'stage3_connect',
      'stage4_classify',
    ]);

    // Stage 1: nodes must be normalized to normal, edges empty in fallback
    expect(snapshots[0].nodes.every((n) => n.type === 'normal')).toBe(true);
    expect(snapshots[0].edges).toHaveLength(0);

    // Stage 3: edges must be restored, but nodes still normal
    expect(snapshots[2].edges).toHaveLength(1);
    expect(snapshots[2].nodes.every((n) => n.type === 'normal')).toBe(true);

    // Stage 4: full classification restored (one normal, one variation)
    expect(snapshots[3].nodes.find((n) => n.id === 'node_2')?.type).toBe('variation');
    expect(snapshots[3].edges).toHaveLength(1);
  });

  it('reconstructPipelineSnapshots restores original fine-grained entities when subjectRanking exists', () => {
    const analysisWithRanking: VTAAnalysisData = {
      version: 5,
      sources: [
        { id: 'source_1', text: 'テスト原文', paragraphs: [{ id: 'p1', text: 'テスト段落' }] },
      ],
      facts: [],
      events: [
        {
          id: 'E1',
          sourceOrder: 1,
          factIds: [],
          title: '進入許可受領',
          description: '',
          time: '17:45:00',
          classification: 'normal',
          sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
        },
        {
          id: 'E2',
          sourceOrder: 2,
          factIds: [],
          title: '停止位置超過',
          description: '',
          time: '17:46:00',
          classification: 'variation',
          sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
        },
      ],
      entities: [
        { id: 'CREW_A', name: 'A機乗務員', kind: 'person', aggregate: true },
      ],
      participations: [
        {
          eventId: 'E1',
          entityId: 'CREW_A',
          role: 'actor',
          factIds: [],
          mergedFrom: [{ entityId: 'CAPTAIN_A', role: 'actor' }],
        },
        {
          eventId: 'E2',
          entityId: 'CREW_A',
          role: 'actor',
          factIds: [],
          mergedFrom: [{ entityId: 'FOP_A', role: 'actor' }],
        },
      ],
      relations: [
        {
          id: 'rel_1',
          sourceEventId: 'E1',
          targetEventId: 'E2',
          sourceEntityId: 'CREW_A',
          targetEntityId: 'CREW_A',
          kind: 'before',
          factIds: [],
          sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
        },
      ],
      cards: [],
      unassignedEventIds: [],
      subjectRanking: {
        version: 1,
        maxSubjects: 1,
        weights: { A: 1, O: 1, F: 1, C: 1, T: 1 },
        originalEntities: [
          { id: 'CAPTAIN_A', name: '機長A', kind: 'person' },
          { id: 'FOP_A', name: '副操縦士A', kind: 'person' },
        ],
        ranks: [],
      },
    };

    const schemaWithAnalysis: VTASchema = {
      lanes: ['A機乗務員'],
      nodes: [
        { id: 'card_1', lane: 'A機乗務員', time: '17:45:00', type: 'normal', title: '進入許可受領', description: '', measure_type: null, event_ids: ['E1'] },
        { id: 'card_2', lane: 'A機乗務員', time: '17:46:00', type: 'variation', title: '停止位置超過', description: '', measure_type: null, event_ids: ['E2'] },
      ],
      edges: [
        { id: 'e1', source: 'card_1', target: 'card_2' },
      ],
      analysis: analysisWithRanking,
    };

    const snapshots = reconstructPipelineSnapshots(schemaWithAnalysis);
    expect(snapshots).toHaveLength(4);

    // Stage 1 must restore the 2 fine-grained lanes: 機長A and 副操縦士A
    expect(snapshots[0].lanes).toHaveLength(2);
    expect(snapshots[0].lanes).toContain('機長A');
    expect(snapshots[0].lanes).toContain('副操縦士A');

    // Stage 2 must have consolidated single lane: A機乗務員
    expect(snapshots[1].lanes).toEqual(['A機乗務員']);
  });

  it('resolvePipelineSnapshots returns existing pipelineHistory if present', () => {
    const existingSnap = createPipelineSnapshot('stage4_classify', 3, 'Completed', '', '', dummySchema);
    const schemaWithHistory: VTASchema = {
      ...dummySchema,
      pipelineHistory: [existingSnap],
    };

    const resolved = resolvePipelineSnapshots(schemaWithHistory);
    expect(resolved).toHaveLength(1);
    expect(resolved[0].title).toBe('Completed');
  });
});
