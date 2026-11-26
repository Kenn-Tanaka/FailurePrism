import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { autoConnectVTA } from './autoConnectionService';
import { debugRecorder } from '../debugRecorder';
import { parseConnectionProposalTSV } from '../../features/vta/utils/connectionProposals';
import { projectAnalysis } from '../../features/vta/utils/eventAnalysis';
import { graphDiagnostics } from '../../features/vta/utils/graphDiagnostics';
import type { VTASchema, LLMConfig } from '../../types/vta';

vi.mock('../llm/client', () => ({
  proposeVTAConnections: vi.fn(),
}));

vi.mock('./chainRepairService', () => ({
  proposeChainRepair: vi.fn(),
}));

import { proposeVTAConnections } from '../llm/client';
import { proposeChainRepair } from './chainRepairService';

describe('autoConnectionService (Auto Node Connection)', () => {
  const dummyConfig: LLMConfig = {
    selectedModel: 'test-model',
    baseUrl: 'http://localhost:8765/v1',
    gatewayToken: 'test-token',
  };

  const sampleSchema: VTASchema = {
    lanes: ['担当者', 'システム部'],
    nodes: [
      { id: 'n1', lane: '担当者', time: '10:00', title: '作業開始', description: '作業を開始した', type: 'normal', measure_type: null, event_ids: ['E1'], position: { x: 100, y: 200 } },
      { id: 'n2', lane: 'システム部', time: '10:10', title: '確認実施', description: '確認を実施した', type: 'normal', measure_type: null, event_ids: ['E2'], position: { x: 400, y: 150 } },
    ],
    edges: [],
    analysis: {
      version: 5,
      sources: [
        {
          id: 'source_1',
          text: '作業を開始した。\n確認を実施した。',
          paragraphs: [
            { id: 'p1', text: '作業を開始した。' },
            { id: 'p2', text: '確認を実施した。' },
          ],
        },
      ],
      facts: [],
      entities: [
        { id: 'A1', name: '担当者', kind: 'person' },
        { id: 'A2', name: 'システム部', kind: 'organization' },
      ],
      events: [
        { id: 'E1', time: '10:00', title: '作業開始', description: '作業を開始した', classification: 'normal', sourceOrder: 1, sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }], factIds: [] },
        { id: 'E2', time: '10:10', title: '確認実施', description: '確認を実施した', classification: 'normal', sourceOrder: 2, sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p2' }], factIds: [] },
      ],
      participations: [
        { eventId: 'E1', entityId: 'A1', role: 'actor', factIds: [] },
        { eventId: 'E2', entityId: 'A2', role: 'actor', factIds: [] },
      ],
      cards: [
        { id: 'n1', laneEntityId: 'A1', eventIds: ['E1'] },
        { id: 'n2', laneEntityId: 'A2', eventIds: ['E2'] },
      ],
      relations: [],
      dispositions: [],
      unassignedEventIds: [],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    debugRecorder.setEnabled(false);
    debugRecorder.clear();
  });

  afterEach(() => {
    debugRecorder.setEnabled(false);
    debugRecorder.clear();
  });

  it('throws an error if schema has no analysis data', async () => {
    const invalidSchema: VTASchema = { lanes: [], nodes: [], edges: [] };
    await expect(autoConnectVTA(dummyConfig, invalidSchema)).rejects.toThrow('イベント分析データがありません');
  });

  it('runs Stage 1 and Stage 2, automatically adopting all valid connections and preserving node positions', async () => {
    vi.mocked(proposeVTAConnections).mockResolvedValueOnce({
      proposals: [
        {
          id: 'P1',
          operation: 'add',
          targetLineId: '-',
          kind: 'transfer',
          sourceEventId: 'E1',
          sourceEntityId: 'A1',
          targetEventId: 'E2',
          targetEntityId: 'A2',
          sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
          resource: 'information',
          status: 'occurred',
          receipt: 'confirmed',
          evidenceBasis: 'recorded',
          reason: '作業開始の連絡を行った',
          proposalReason: '作業開始の連絡を行った',
          selected: true,
        },
      ],
      reviews: [],
      invalidRows: [],
    });

    vi.mocked(proposeChainRepair).mockResolvedValueOnce({
      requestId: 'test_repair_1',
      calls: 1,
      rows: [],
      issues: [],
      trace: [],
      complete: true,
    });

    const progressMessages: string[] = [];
    const result = await autoConnectVTA(dummyConfig, sampleSchema, undefined, (p) => {
      progressMessages.push(p.message);
    });

    expect(result.addedInterLaneConnections).toBe(1);
    expect(result.schema.analysis?.relations.some((r) => r.kind === 'transfer')).toBe(true);
    expect(result.schema.nodes.find((n) => n.id === 'n1')?.position).toEqual({ x: 100, y: 200 });
    expect(result.schema.nodes.find((n) => n.id === 'n2')?.position).toEqual({ x: 400, y: 150 });
    expect(progressMessages.length).toBeGreaterThanOrEqual(2);
  });

  it('excludes proposals matching presentation.omittedDependencies', async () => {
    const omittedKey = JSON.stringify(['E1', 'A1', 'E2', 'A2', 'dependency']);
    const schemaWithOmitted: VTASchema = {
      ...sampleSchema,
      presentation: {
        lanes: {},
        suppressedCards: {},
        omittedDependencies: [omittedKey],
      },
    };

    vi.mocked(proposeVTAConnections).mockResolvedValueOnce({
      proposals: [
        {
          id: 'P1',
          operation: 'add',
          targetLineId: '-',
          kind: 'dependency',
          sourceEventId: 'E1',
          sourceEntityId: 'A1',
          targetEventId: 'E2',
          targetEntityId: 'A2',
          sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
          resource: '-',
          status: '-',
          receipt: 'na',
          evidenceBasis: 'source-context',
          reason: '前提作業',
          proposalReason: '前提作業',
          selected: true,
        },
      ],
      reviews: [],
      invalidRows: [],
    });

    vi.mocked(proposeChainRepair).mockResolvedValueOnce({
      requestId: 'test_repair_2',
      calls: 1,
      rows: [],
      issues: [],
      trace: [],
      complete: true,
    });

    const result = await autoConnectVTA(dummyConfig, schemaWithOmitted);
    expect(result.addedInterLaneConnections).toBe(0);
    expect(result.schema.analysis?.relations.length).toBe(0);
  });

  it('falls back to keeping Stage 1 connections if Stage 2 fails with communication error (SR-03)', async () => {
    vi.mocked(proposeVTAConnections).mockResolvedValueOnce({
      proposals: [
        {
          id: 'P1',
          operation: 'add',
          targetLineId: '-',
          kind: 'impact',
          sourceEventId: 'E1',
          sourceEntityId: 'A1',
          targetEventId: 'E2',
          targetEntityId: 'A2',
          sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
          resource: '-',
          status: 'occurred',
          receipt: 'na',
          evidenceBasis: 'recorded',
          reason: '影響関係',
          proposalReason: '影響関係',
          selected: true,
        },
      ],
      reviews: [],
      invalidRows: [],
    });

    vi.mocked(proposeChainRepair).mockRejectedValueOnce(new Error('Network timeout during chain repair'));

    const result = await autoConnectVTA(dummyConfig, sampleSchema);
    expect(result.addedInterLaneConnections).toBe(1);
    expect(result.schema.analysis?.relations.some((r) => r.kind === 'impact')).toBe(true);
    expect(result.warnings.some((w) => w.includes('連鎖不足点検の通信に失敗しましたが、レーン間接続（1件）は採用されました'))).toBe(true);
  });

  it('records connection-proposal.adoption metrics when candidates are filtered by manualConflict without emitting noisy UI warnings', async () => {
    debugRecorder.setEnabled(true);
    const schemaWithExistingEdge: VTASchema = {
      ...sampleSchema,
      edges: [
        {
          id: 'relation:R_init',
          relationId: 'R_init',
          source: 'n1',
          target: 'n2',
          generated: true,
          meaning: 'transfer',
          direction: 'unidirectional',
        },
      ],
      analysis: {
        ...sampleSchema.analysis!,
        relations: [
          {
            id: 'R_init',
            kind: 'transfer',
            sourceEventId: 'E1',
            sourceEntityId: 'A1',
            targetEventId: 'E2',
            targetEntityId: 'A2',
            resource: 'information',
            status: 'occurred',
            receipt: 'confirmed',
            sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
            factIds: [],
          },
        ],
      },
    };

    vi.mocked(proposeVTAConnections).mockResolvedValueOnce({
      proposals: [
        {
          id: 'P1',
          operation: 'add',
          targetLineId: '-',
          kind: 'dependency',
          sourceEventId: 'E1',
          sourceEntityId: 'A1',
          targetEventId: 'E2',
          targetEntityId: 'A2',
          sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
          resource: '-',
          status: '-',
          receipt: 'na',
          evidenceBasis: 'source-context',
          reason: '既接続カード間への依存追加候補',
          proposalReason: '既接続カード間への依存追加候補',
          selected: true,
        },
      ],
      reviews: [],
      invalidRows: [],
    });

    vi.mocked(proposeChainRepair).mockResolvedValueOnce({
      requestId: 'test_repair_adoption',
      calls: 1,
      rows: [],
      issues: [],
      trace: [],
      complete: true,
    });

    const result = await autoConnectVTA(dummyConfig, schemaWithExistingEdge);
    expect(result.addedInterLaneConnections).toBe(0);
    expect(result.warnings).toEqual([]);

    const adoptionEntry = debugRecorder
      .getEntries()
      .find((entry) => entry.stage === 'connection-proposal.adoption');
    expect(adoptionEntry).toBeDefined();
    expect(adoptionEntry?.data).toMatchObject({
      totalProposals: 1,
      adoptedCount: 0,
      rejectedCount: 1,
    });
  });

  it('skips Stage 2 chain repair when intra-card relations collapsed by subject consolidation are intentionally unprojected (ADR-0069)', async () => {
    debugRecorder.setEnabled(true);
    const consolidatedSchema: VTASchema = {
      lanes: ['除草薬散布作業班', '第1020列車運転士'],
      nodes: [
        {
          id: 'c_team',
          lane: '除草薬散布作業班',
          time: '10:40',
          title: '軌道内散布作業',
          description: '作業班が散布作業を実施した',
          type: 'variation',
          measure_type: null,
          event_ids: ['E1'],
          position: { x: 100, y: 120 },
        },
        {
          id: 'c_drv',
          lane: '第1020列車運転士',
          time: '10:46',
          title: '列車触車',
          description: '列車と触車した',
          type: 'outcome',
          outcome_kind: 'loss',
          measure_type: null,
          event_ids: ['E2'],
          position: { x: 480, y: 260 },
        },
      ],
      edges: [
        {
          id: 'relation:R_cross',
          relationId: 'R_cross',
          source: 'c_team',
          target: 'c_drv',
          generated: true,
          meaning: 'impact',
          direction: 'unidirectional',
        },
      ],
      analysis: {
        version: 5,
        sources: sampleSchema.analysis!.sources,
        facts: [],
        entities: [
          { id: 'S_TEAM', name: '除草薬散布作業班', kind: 'organization', mergedFrom: ['A_LEAD', 'H_WORK'] },
          { id: 'TRAIN_DRV', name: '第1020列車運転士', kind: 'person' },
        ],
        events: [
          {
            id: 'E1',
            time: '10:40',
            title: '軌道内散布作業',
            description: '作業班が散布作業を実施した',
            classification: 'variation',
            sourceOrder: 1,
            sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
            factIds: [],
          },
          {
            id: 'E2',
            time: '10:46',
            title: '列車触車',
            description: '列車と触車した',
            classification: 'outcome',
            outcome_kind: 'loss',
            sourceOrder: 2,
            sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p2' }],
            factIds: [],
          },
        ],
        participations: [
          {
            eventId: 'E1',
            entityId: 'S_TEAM',
            role: 'actor',
            factIds: [],
            mergedFrom: [
              { entityId: 'A_LEAD', role: 'actor' },
              { entityId: 'H_WORK', role: 'target' },
            ],
          },
          { eventId: 'E2', entityId: 'TRAIN_DRV', role: 'actor', factIds: [] },
        ],
        cards: [
          { id: 'c_team', laneEntityId: 'S_TEAM', eventIds: ['E1'] },
          { id: 'c_drv', laneEntityId: 'TRAIN_DRV', eventIds: ['E2'] },
        ],
        relations: [
          {
            id: 'R_intra',
            kind: 'transfer',
            sourceEventId: 'E1',
            sourceEntityId: 'S_TEAM',
            sourceEntityOrigin: 'A_LEAD',
            targetEventId: 'E1',
            targetEntityId: 'S_TEAM',
            targetEntityOrigin: 'H_WORK',
            resource: 'information',
            status: 'occurred',
            receipt: 'confirmed',
            sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
            factIds: [],
          },
          {
            id: 'R_cross',
            kind: 'impact',
            sourceEventId: 'E1',
            sourceEntityId: 'S_TEAM',
            targetEventId: 'E2',
            targetEntityId: 'TRAIN_DRV',
            status: 'occurred',
            receipt: 'na',
            sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p2' }],
            factIds: [],
          },
        ],
        context: { selectedTargetEventIds: ['E2'] },
        outcome: {
          status: 'identified',
          kind: 'loss',
          eventIds: ['E2'],
          sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p2' }],
          reason: '触車による死傷',
        },
        dispositions: [],
        unassignedEventIds: [],
      },
    };

    vi.mocked(proposeVTAConnections).mockResolvedValueOnce({
      proposals: [],
      reviews: [],
      invalidRows: [],
    });

    const result = await autoConnectVTA(dummyConfig, consolidatedSchema);
    expect(proposeChainRepair).not.toHaveBeenCalled();

    const diag = graphDiagnostics(result.schema);
    expect(diag.missingRelations).toEqual([]);
    expect(diag.complete).toBe(true);

    const triageEntry = debugRecorder
      .getEntries()
      .find((entry) => entry.stage === 'chain-repair.triage');
    expect(triageEntry?.data).toMatchObject({
      skipped: true,
      outcomeIdentified: true,
      canonicalComponents: 1,
      unassignedCount: 0,
      missingRelationsCount: 0,
    });
  });

  it('persists connection proposal [要確認] reviews into analysis.dispositions without duplicating on re-run, even when proposals list is empty (ADR-0069)', async () => {
    const reviewItem = {
      id: 'Q1',
      sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
      reason: '口頭連絡の受領有無が原文から断定できない',
    };

    vi.mocked(proposeVTAConnections).mockResolvedValueOnce({
      proposals: [],
      reviews: [reviewItem],
      invalidRows: [],
    });
    vi.mocked(proposeChainRepair).mockResolvedValueOnce({
      requestId: 'test_repair_review_1',
      calls: 1,
      rows: [],
      issues: [],
      trace: [],
      complete: true,
    });

    const first = await autoConnectVTA(dummyConfig, sampleSchema);
    expect(first.schema.analysis?.dispositions).toHaveLength(1);
    expect(first.schema.analysis?.dispositions?.[0]).toMatchObject({
      kind: 'review',
      text: 'レーン間接続の要確認',
      reason: '口頭連絡の受領有無が原文から断定できない',
      sourceId: 'source_1',
      paragraphId: 'p1',
    });

    vi.mocked(proposeVTAConnections).mockResolvedValueOnce({
      proposals: [],
      reviews: [reviewItem],
      invalidRows: [],
    });
    vi.mocked(proposeChainRepair).mockResolvedValueOnce({
      requestId: 'test_repair_review_2',
      calls: 1,
      rows: [],
      issues: [],
      trace: [],
      complete: true,
    });

    const second = await autoConnectVTA(dummyConfig, first.schema);
    expect(second.schema.analysis?.dispositions).toHaveLength(1);
  });

  it('parses [周辺主体候補] and folds non-variation peripheral subjects into subject_others after Stage 1/2 connection exploration while preserving proposal relations (ADR-0072)', async () => {
    debugRecorder.setEnabled(true);
    const fiveSubjectAnalysis: NonNullable<VTASchema['analysis']> = {
      version: 5,
      sources: [
        {
          id: 'source_1',
          text: [
            '工務事務所が発注した。',
            '下請会社が受注した。',
            '作業班が準備した。',
            '見張員が見張りを怠った。',
            '運転士の列車と触車事故が発生した。',
          ].join('\n'),
          paragraphs: [
            { id: 'p1', text: '工務事務所が発注した。' },
            { id: 'p2', text: '下請会社が受注した。' },
            { id: 'p3', text: '作業班が準備した。' },
            { id: 'p4', text: '見張員が見張りを怠った。' },
            { id: 'p5', text: '運転士の列車と触車事故が発生した。' },
          ],
        },
      ],
      facts: [],
      entities: [
        { id: 'A_OF', name: '工務事務所', kind: 'organization', focus: 'low' },
        { id: 'A_SUB', name: '下請会社', kind: 'organization', focus: 'low' },
        { id: 'A_CREW', name: '作業班', kind: 'organization', focus: 'high' },
        { id: 'A_LOOK', name: '見張員', kind: 'person', focus: 'high' },
        { id: 'A_DRV', name: '運転士', kind: 'person', focus: 'high' },
      ],
      events: [
        { id: 'E1', time: '08:00', title: '発注', description: '発注した', classification: 'unclassified', preliminary: { value: 'normal', reason: '定常', sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }] }, sourceOrder: 1, sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }], factIds: [] },
        { id: 'E2', time: '08:30', title: '受注', description: '受注した', classification: 'unclassified', preliminary: { value: 'normal', reason: '定常', sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p2' }] }, sourceOrder: 2, sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p2' }], factIds: [] },
        { id: 'E3', time: '10:00', title: '準備', description: '準備した', classification: 'unclassified', preliminary: { value: 'normal', reason: '定常', sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p3' }] }, sourceOrder: 3, sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p3' }], factIds: [] },
        { id: 'E4', time: '10:40', title: '見張り不備', description: '怠った', classification: 'unclassified', preliminary: { value: 'variation', reason: '見張り不備', sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p4' }] }, sourceOrder: 4, sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p4' }], factIds: [] },
        { id: 'E5', time: '10:46', title: '触車事故', description: '事故発生', classification: 'unclassified', sourceOrder: 5, sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p5' }], factIds: [] },
      ],
      participations: [
        { eventId: 'E1', entityId: 'A_OF', role: 'actor', factIds: [] },
        { eventId: 'E2', entityId: 'A_SUB', role: 'actor', factIds: [] },
        { eventId: 'E3', entityId: 'A_CREW', role: 'actor', factIds: [] },
        { eventId: 'E4', entityId: 'A_LOOK', role: 'actor', factIds: [] },
        { eventId: 'E5', entityId: 'A_DRV', role: 'actor', factIds: [] },
      ],
      cards: [
        { id: 'c1', laneEntityId: 'A_OF', eventIds: ['E1'] },
        { id: 'c2', laneEntityId: 'A_SUB', eventIds: ['E2'] },
        { id: 'c3', laneEntityId: 'A_CREW', eventIds: ['E3'] },
        { id: 'c4', laneEntityId: 'A_LOOK', eventIds: ['E4'] },
        { id: 'c5', laneEntityId: 'A_DRV', eventIds: ['E5'] },
      ],
      relations: [
        {
          id: 'R_var',
          kind: 'impact',
          sourceEventId: 'E4',
          sourceEntityId: 'A_LOOK',
          targetEventId: 'E5',
          targetEntityId: 'A_DRV',
          status: 'occurred',
          receipt: 'na',
          sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p4' }],
          factIds: [],
        },
        {
          id: 'R_prep',
          kind: 'impact',
          sourceEventId: 'E3',
          sourceEntityId: 'A_CREW',
          targetEventId: 'E5',
          targetEntityId: 'A_DRV',
          status: 'occurred',
          receipt: 'na',
          sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p3' }],
          factIds: [],
        },
      ],
      outcome: { status: 'identified', kind: 'loss', eventIds: ['E5'], sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p5' }], reason: '触車事故' },
      dispositions: [],
      unassignedEventIds: [],
    };
    const namedSchema = projectAnalysis(fiveSubjectAnalysis);

    // 1. Verify TSV parser handles [周辺主体候補]
    const parsedTsv = parseConnectionProposalTSV(
      [
        '[接続提案]',
        'ID\toperation\ttargetLineId\tkind\tsourceEventId\tsourceEntityId\ttargetEventId\ttargetEntityId\trefs\tresource\tstatus\treceipt\tbasis\treason',
        'P1\tadd\t-\ttransfer\tE1\tA_OF\tE2\tA_SUB\tsource_1/p1,source_1/p2\tinformation\toccurred\tconfirmed\trecorded\t業務発注伝達',
        'P2\tadd\t-\ttransfer\tE2\tA_SUB\tE3\tA_CREW\tsource_1/p2,source_1/p3\tinformation\toccurred\tconfirmed\trecorded\t業務手配伝達',
        '[要確認]',
        'ID\trefs\treason',
        '[周辺主体候補]',
        'ID\t主体ID\t原文参照\t理由',
        'PS1\tA_OF\tp1\t上流の定常発注のみ',
        'PS2\tA_SUB\tsource_1/p2\t上流の定常受注手配のみ',
        '[完了]',
      ].join('\n'),
      namedSchema
    );
    expect(parsedTsv.invalidRows).toEqual([]);
    expect(parsedTsv.peripheralSectionPresent).toBe(true);
    expect(parsedTsv.peripheralSubjects?.map((s) => s.entityId)).toEqual(['A_OF', 'A_SUB']);

    // 2. Verify autoConnectVTA runs Stage 1 on named lanes, adopts P1 & P2, and folds A_OF + A_SUB into subject_others (5 -> 4 lanes)
    vi.mocked(proposeVTAConnections).mockResolvedValueOnce(parsedTsv);

    const res = await autoConnectVTA(dummyConfig, namedSchema, undefined, undefined, {
      finalMaxSubjects: 4,
      othersConsolidationMode: 'llm_assisted',
    });

    expect(vi.mocked(proposeVTAConnections)).toHaveBeenCalledWith(
      dummyConfig,
      expect.anything(),
      undefined,
      undefined,
      { includePeripheralSubjects: true, followedByChainRepair: true }
    );
    expect(res.addedInterLaneConnections).toBe(2);
    expect(res.foldedOthersSubjects).toEqual(['A_OF', 'A_SUB']);
    expect(res.schema.lanes).toHaveLength(4);
    expect(res.schema.lanes[0]).toBe('その他の関係者');
    // Newly proposed E2(A_SUB) -> E3(A_CREW) relation is preserved on subject_others with sourceEntityOrigin === 'A_SUB'
    const handoffRel = res.schema.analysis?.relations.find(
      (r) => r.sourceEventId === 'E2' && r.targetEventId === 'E3'
    );
    expect(handoffRel?.sourceEntityId).toMatch(/^cmp_agg_/);
    expect(handoffRel?.sourceEntityOrigin).toBe('A_SUB');
    expect(handoffRel?.targetEntityId).toBe('A_CREW');
  });

  it('prunes premature Stage 1 review_conn_* items once Stage 2 chain.repair assigns the cited unassigned event (ADR-0075)', async () => {
    const baseWithUnassigned: NonNullable<VTASchema['analysis']> = {
      ...sampleSchema.analysis!,
      events: [
        ...sampleSchema.analysis!.events,
        {
          id: 'E18',
          time: '10:42',
          title: '中継見張員配置未確認',
          description: '配置を確認しなかった',
          classification: 'variation',
          sourceOrder: 3,
          sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p2' }],
          factIds: [],
        },
      ],
      unassignedEventIds: ['E18'],
    };
    const schemaWithUnassigned = projectAnalysis(baseWithUnassigned);

    vi.mocked(proposeVTAConnections).mockResolvedValueOnce({
      proposals: [],
      reviews: [
        {
          id: 'R_UNASSIGNED',
          sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p2' }],
          reason: '中継見張員配置未確認（E18）は主体が未割当（unassigned）でありカードがないため接続提案不可。',
        },
      ],
      invalidRows: [],
    });

    vi.mocked(proposeChainRepair).mockResolvedValueOnce({
      requestId: 'req_assign_e18',
      calls: 1,
      rows: [
        {
          section: '割当追加',
          id: 'tmp_as18',
          cells: ['tmp_as18', 'E18', 'A1', 'actor', 'source_1/p2', 'inferred'],
        },
      ],
      issues: [],
      trace: [],
      complete: true,
    });

    const result = await autoConnectVTA(dummyConfig, schemaWithUnassigned);
    expect(result.schema.analysis?.unassignedEventIds).toEqual([]);
    expect(result.schema.analysis?.cards.some((c) => c.eventIds.includes('E18'))).toBe(true);
    expect(
      (result.schema.analysis?.dispositions ?? []).some((d) => d.id.startsWith('review_conn_'))
    ).toBe(false);
  });

  it('does not skip Stage 2 chain.repair in triage when substantive source paragraphs remain unreferenced even if existing cards are connected (ADR-0098)', async () => {
    debugRecorder.setEnabled(true);
    const schemaWithUnreferencedPara: VTASchema = {
      ...sampleSchema,
      edges: [
        {
          id: 'relation:R_12',
          relationId: 'R_12',
          source: 'n1',
          target: 'n2',
          generated: true,
          meaning: 'impact',
          direction: 'unidirectional',
        },
      ],
      analysis: {
        ...sampleSchema.analysis!,
        sources: [
          {
            id: 'source_1',
            text: '作業を開始した。\n確認を実施した。\n非常停止弁の閉止確認が行われなかった。',
            paragraphs: [
              { id: 'p1', text: '作業を開始した。' },
              { id: 'p2', text: '確認を実施した。' },
              { id: 'p3', text: '非常停止弁の閉止確認が行われなかった。' },
            ],
          },
        ],
        relations: [
          {
            id: 'R_12',
            kind: 'impact',
            sourceEventId: 'E1',
            sourceEntityId: 'A1',
            targetEventId: 'E2',
            targetEntityId: 'A2',
            status: 'occurred',
            receipt: 'na',
            sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
            factIds: [],
          },
        ],
        outcome: {
          status: 'identified',
          kind: 'loss',
          eventIds: ['E2'],
          sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p2' }],
          reason: '損失発生',
        },
      },
    };

    vi.mocked(proposeVTAConnections).mockResolvedValueOnce({
      proposals: [],
      reviews: [],
      invalidRows: [],
    });
    vi.mocked(proposeChainRepair).mockResolvedValueOnce({
      requestId: 'req_unref_p3',
      calls: 1,
      rows: [],
      issues: [],
      trace: [],
      complete: true,
    });

    await autoConnectVTA(dummyConfig, schemaWithUnreferencedPara);
    expect(proposeChainRepair).toHaveBeenCalledTimes(1);

    const triageEntry = debugRecorder
      .getEntries()
      .find((entry) => entry.stage === 'chain-repair.triage');
    expect(triageEntry?.data).toMatchObject({
      skipped: false,
      outcomeIdentified: true,
      canonicalComponents: 1,
      unassignedCount: 0,
      unreferencedParagraphCount: 1,
    });
  });
});
