import { describe, it, expect, vi, beforeEach } from 'vitest';
import { autoConnectVTA } from './autoConnectionService';
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
});
