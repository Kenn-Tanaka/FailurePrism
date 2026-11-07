import { describe, it, expect } from 'vitest';
import { applyChainDelta, parseChainDelta, validateChainRows } from '../../src/tools/vta/features/vta/utils/chainRepair';
import { filterPostOutcomeScope } from '../../src/tools/vta/services/generation/granularityScore';
import type { VTASchema, VTAAnalysisData } from '../../src/tools/vta/types/vta';

describe('AI診断ログの根本原因再現テスト: 既存関係不整合によるchain-repair巻き添えリジェクト', () => {
  it('既存関係の主体が関与を満たさない場合、関係のない差分行（before等）が巻き添えでリジェクトされる現象を再現', () => {
    // 最小限のスキーマを用意
    const initialSchema: VTASchema = {
      lanes: ['主体A', '主体B'],
      nodes: [
        { id: 'card_1', lane: '主体A', event_ids: ['E1'], title: 'イベント1', description: '', time: '10:00', type: 'normal', sequence_order: 0, entity_role: 'subject', measure_type: null },
        { id: 'card_2', lane: '主体B', event_ids: ['E2'], title: 'イベント2', description: '', time: '10:05', type: 'normal', sequence_order: 0, entity_role: 'subject', measure_type: null },
      ],
      edges: [],
      analysis: {
        version: 5,
        sources: [{ id: 'source_1', text: '段落1の内容', paragraphs: [{ id: 'p1', text: '段落1の内容' }] }],
        facts: [{ id: 'f1', text: '事実1', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p1', quote: '段落1の内容' }] }],
        events: [
          { id: 'E1', title: 'イベント1', description: '', time: '10:00', sourceOrder: 0, factIds: ['f1'], sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }], classification: 'normal', origin: 'extraction' },
          { id: 'E2', title: 'イベント2', description: '', time: '10:05', sourceOrder: 1, factIds: ['f1'], sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }], classification: 'normal', origin: 'extraction' },
        ],
        entities: [
          { id: 'A1', name: '主体A', kind: 'person' },
          { id: 'B1', name: '主体B', kind: 'person' },
        ],
        participations: [
          { eventId: 'E1', entityId: 'A1', role: 'actor', factIds: ['f1'] },
          { eventId: 'E2', entityId: 'B1', role: 'actor', factIds: ['f1'] },
        ],
        // ここに、かつて存在したが participations から消えた主体 A2 を参照する関係が存在していたとする
        relations: [
          {
            id: 'R_invalid',
            kind: 'impact',
            sourceEventId: 'E1',
            targetEventId: 'E2',
            sourceEntityId: 'A1',
            targetEntityId: 'A1', // E2 には A1 の関与がない！
            sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
            factIds: ['f1'],
            resource: 'information',
            status: 'occurred',
            receipt: 'confirmed',
          },
        ],
        cards: [
          { id: 'card_1', laneEntityId: 'A1', eventIds: ['E1'] },
          { id: 'card_2', laneEntityId: 'B1', eventIds: ['E2'] },
        ],
        unassignedEventIds: [],
      },
    };

    // LLM から提案された正常な差分（割当追加と before 関係）
    const repairDelta = `[追加主体]
[追加イベント]
[割当追加]
tmp_as1\tE1\tB1\tactor\tsource_1/p1\t-
[関係追加]
tmp_R1\tbefore\tE1\t-\tE2\t-\tsource_1/p1\t-\t-\tna\trecorded\tE1からE2への時系列推移
[要確認]
[完了]`;

    const rows = parseChainDelta(repairDelta);
    expect(rows).toHaveLength(2);

    // 修正後の実装では、既存関係の不整合がクリーンアップされ、正常な提案行 (tmp_as1, tmp_R1) が受理される！
    const checked = validateChainRows(initialSchema, rows);
    console.log('Checked issues:', checked.issues);
    console.log('Accepted rows:', checked.rows);
    expect(checked.issues).toHaveLength(0);
    expect(checked.rows).toHaveLength(2);
    expect(checked.rows[0].id).toBe('tmp_as1');
    expect(checked.rows[1].id).toBe('tmp_R1');
  });

  it('filterPostOutcomeScope において、カード除外で主体関与が消えた既存関係の端点主体が安全にクリーンアップされる', () => {
    const initialSchema: VTASchema = {
      lanes: ['主体A', '主体B'],
      nodes: [
        { id: 'card_1', lane: '主体A', event_ids: ['E1'], title: 'イベント1', description: '', time: '10:00', type: 'normal', sequence_order: 0, entity_role: 'subject', measure_type: null },
        { id: 'card_outcome', lane: '主体A', event_ids: ['E_out'], title: '事故発生', description: '', time: '10:10', type: 'outcome', sequence_order: 1, entity_role: 'subject', measure_type: null },
        { id: 'card_post', lane: '主体B', event_ids: ['E_post'], title: '事後調査', description: '', time: '10:30', type: 'normal', sequence_order: 0, entity_role: 'subject', measure_type: null },
      ],
      edges: [
        { source: 'card_1', target: 'card_outcome' },
      ],
      analysis: {
        version: 5,
        sources: [{ id: 'source_1', text: '段落1の内容', paragraphs: [{ id: 'p1', text: '段落1の内容' }] }],
        facts: [{ id: 'f1', text: '事実1', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p1', quote: '段落1の内容' }] }],
        events: [
          { id: 'E1', title: 'イベント1', description: '', time: '10:00', sourceOrder: 0, factIds: ['f1'], sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }], classification: 'normal', origin: 'extraction' },
          { id: 'E_out', title: '事故発生', description: '', time: '10:10', sourceOrder: 1, factIds: ['f1'], sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }], classification: 'outcome', origin: 'extraction' },
          { id: 'E_post', title: '事後調査', description: '', time: '10:30', sourceOrder: 2, factIds: ['f1'], sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }], classification: 'normal', origin: 'extraction' },
        ],
        entities: [
          { id: 'A1', name: '主体A', kind: 'person' },
          { id: 'B1', name: '主体B', kind: 'person' },
        ],
        participations: [
          { eventId: 'E1', entityId: 'A1', role: 'actor', factIds: ['f1'] },
          { eventId: 'E_out', entityId: 'A1', role: 'actor', factIds: ['f1'] },
          { eventId: 'E_post', entityId: 'B1', role: 'actor', factIds: ['f1'] },
        ],
        relations: [
          {
            id: 'R_before_with_subject',
            kind: 'before',
            sourceEventId: 'E1',
            targetEventId: 'E_out',
            sourceEntityId: 'A1',
            targetEntityId: 'B1', // B1 は E_out に関与していない！
            sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
            factIds: ['f1'],
            resource: undefined,
            status: undefined,
            receipt: 'na',
          },
        ],
        cards: [
          { id: 'card_1', laneEntityId: 'A1', eventIds: ['E1'] },
          { id: 'card_outcome', laneEntityId: 'A1', eventIds: ['E_out'] },
          { id: 'card_post', laneEntityId: 'B1', eventIds: ['E_post'] },
        ],
        outcome: {
          status: 'identified',
          eventIds: ['E_out'],
          reason: '事故発生',
          sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
        },
        unassignedEventIds: [],
      },
    };

    const filtered = filterPostOutcomeScope(initialSchema);
    expect(filtered.analysis).toBeDefined();

    // R_before_with_subject の targetEntityId は関与がないため自動で削除され、before関係自体は保護される
    const rel = filtered.analysis?.relations.find((r) => r.id === 'R_before_with_subject');
    expect(rel).toBeDefined();
    expect(rel?.targetEntityId).toBeUndefined();
  });
});
