import { describe, expect, it } from 'vitest';
import type { VTASchema } from '../../src/tools/vta/types/vta';
import { filterPostOutcomeScope } from '../../src/tools/vta/services/generation/granularityScore';
import { useVTAStore } from '../../src/tools/vta/features/vta/store/vtaStore';
import { projectAnalysis, validateSavedAnalysis } from '../../src/tools/vta/features/vta/utils/eventAnalysis';
import { applyChainDelta, type ChainRow } from '../../src/tools/vta/features/vta/utils/chainRepair';

describe('Post-Outcome Activity Exclusion & Secondary Outcome Preservation (ADR-0007)', () => {
  describe('vtaStore preference state', () => {
    it('defaults excludePostOutcomeActivities to true and allows toggling', () => {
      const store = useVTAStore.getState();
      expect(store.excludePostOutcomeActivities).toBe(true);

      store.setExcludePostOutcomeActivities(false);
      expect(useVTAStore.getState().excludePostOutcomeActivities).toBe(false);

      store.setExcludePostOutcomeActivities(true);
      expect(useVTAStore.getState().excludePostOutcomeActivities).toBe(true);
    });
  });

  describe('filterPostOutcomeScope', () => {
    const createTestSchema = (): VTASchema => ({
      lanes: ['管制塔', '海保機', '客室乗務員', '事故調査委員会'],
      nodes: [
        // Chain 1: Leading to Primary Outcome (Collision / Loss)
        {
          id: 'n_e1',
          title: '待機指示',
          description: '滑走路手前で待機を指示した。',
          lane: '管制塔',
          time: '17:45:00',
          type: 'normal',
          measure_type: null,
          event_ids: ['E1'],
        },
        {
          id: 'n_e2',
          title: '誤認進入',
          description: '進入許可と誤認して滑走路へ進入した。',
          lane: '海保機',
          time: '17:46:00',
          type: 'variation',
          measure_type: null,
          event_ids: ['E2'],
        },
        {
          id: 'n_e3',
          title: '衝突発生 (第1の帰結)',
          description: '滑走路上で衝突し火災が発生した。',
          lane: '海保機',
          time: '17:47:00',
          type: 'outcome',
          outcome_kind: 'loss',
          measure_type: null,
          event_ids: ['E3'],
        },

        // Chain 2: Secondary Outcome (Resilience / Emergency Evacuation)
        {
          id: 'n_e4',
          title: '緊急脱出指示',
          description: '機内アナウンスと脱出誘導を実施した。',
          lane: '客室乗務員',
          time: '17:48:00',
          type: 'normal',
          measure_type: null,
          event_ids: ['E4'],
        },
        {
          id: 'n_e5',
          title: '全員脱出完了 (第2の帰結)',
          description: '搭乗者全員が無事に脱出退避を完了した。',
          lane: '客室乗務員',
          time: '17:55:00',
          type: 'outcome',
          outcome_kind: 'recovery',
          measure_type: null,
          event_ids: ['E5'],
        },

        // Post-Outcome Non-Causal Activities (Investigation Committee)
        {
          id: 'n_e6',
          title: '事故調査委員会発足',
          description: '運輸安全委員会が事故調査官を派遣し部会を設置した。',
          lane: '事故調査委員会',
          time: '翌日 10:00',
          type: 'normal',
          measure_type: null,
          event_ids: ['E6'],
        },
        {
          id: 'n_e7',
          title: '関係者事情聴取',
          description: '関係者への事情聴取および交信記録の精査を開始した。',
          lane: '事故調査委員会',
          time: '翌々日 14:00',
          type: 'normal',
          measure_type: null,
          event_ids: ['E7'],
        },
      ],
      edges: [
        { id: 'edge_1', source: 'n_e1', target: 'n_e2' },
        { id: 'edge_2', source: 'n_e2', target: 'n_e3' },
        { id: 'edge_3', source: 'n_e3', target: 'n_e4' },
        { id: 'edge_4', source: 'n_e4', target: 'n_e5' },
        { id: 'edge_5', source: 'n_e6', target: 'n_e7' }, // Isolated post-outcome investigation edge
      ],
      analysis: {
        version: 5,
        sources: [{ id: 'source_1', text: 'sample', paragraphs: [{ id: 'p1', text: 'sample' }] }],
        facts: [],
        entities: [
          { id: '管制塔', name: '管制塔', kind: 'organization' },
          { id: '海保機', name: '海保機', kind: 'organization' },
          { id: '客室乗務員', name: '客室乗務員', kind: 'person' },
          { id: '事故調査委員会', name: '事故調査委員会', kind: 'organization' },
        ],
        participations: [
          { eventId: 'E1', entityId: '管制塔', role: 'actor', factIds: [], origin: 'manual' },
          { eventId: 'E2', entityId: '海保機', role: 'actor', factIds: [], origin: 'manual' },
          { eventId: 'E3', entityId: '海保機', role: 'actor', factIds: [], origin: 'manual' },
          { eventId: 'E4', entityId: '客室乗務員', role: 'actor', factIds: [], origin: 'manual' },
          { eventId: 'E5', entityId: '客室乗務員', role: 'actor', factIds: [], origin: 'manual' },
          { eventId: 'E6', entityId: '事故調査委員会', role: 'actor', factIds: [], origin: 'manual' },
          { eventId: 'E7', entityId: '事故調査委員会', role: 'actor', factIds: [], origin: 'manual' },
        ],
        events: [
          { id: 'E1', title: '待機指示', description: '待機を指示', time: '17:45:00', classification: 'normal', sourceOrder: 1, factIds: [], origin: 'manual' },
          { id: 'E2', title: '誤認進入', description: '誤認進入', time: '17:46:00', classification: 'variation', sourceOrder: 2, factIds: [], origin: 'manual' },
          { id: 'E3', title: '衝突発生', description: '衝突火災', time: '17:47:00', classification: 'normal', sourceOrder: 3, factIds: [], origin: 'manual' },
          { id: 'E4', title: '緊急脱出指示', description: '脱出指示', time: '17:48:00', classification: 'normal', sourceOrder: 4, factIds: [], origin: 'manual' },
          { id: 'E5', title: '全員脱出完了', description: '脱出完了', time: '17:55:00', classification: 'normal', sourceOrder: 5, factIds: [], origin: 'manual' },
          { id: 'E6', title: '事故調査委員会発足', description: '調査官派遣', time: '翌日', classification: 'normal', sourceOrder: 6, factIds: [], origin: 'manual' },
          { id: 'E7', title: '関係者事情聴取', description: '事情聴取', time: '翌々日', classification: 'normal', sourceOrder: 7, factIds: [], origin: 'manual' },
        ],
        relations: [],
        cards: [
          { id: 'n_e1', laneEntityId: '管制塔', eventIds: ['E1'] },
          { id: 'n_e2', laneEntityId: '海保機', eventIds: ['E2'] },
          { id: 'n_e3', laneEntityId: '海保機', eventIds: ['E3'] },
          { id: 'n_e4', laneEntityId: '客室乗務員', eventIds: ['E4'] },
          { id: 'n_e5', laneEntityId: '客室乗務員', eventIds: ['E5'] },
          { id: 'n_e6', laneEntityId: '事故調査委員会', eventIds: ['E6'] },
          { id: 'n_e7', laneEntityId: '事故調査委員会', eventIds: ['E7'] },
        ],
        unassignedEventIds: [],
        outcome: {
          status: 'identified',
          eventIds: ['E3', 'E5'], // Primary Collision & Secondary Evacuation
          reason: '衝突事故および全員脱出退避',
          sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
        },
      },
    });

    it('preserves both primary outcome (collision) and secondary outcome (evacuation) while removing post-outcome investigation', () => {
      const schema = createTestSchema();
      const filtered = filterPostOutcomeScope(schema);

      const keptNodeIds = filtered.nodes.map((n) => n.id);

      // Primary Outcome chain must be kept
      expect(keptNodeIds).toContain('n_e1');
      expect(keptNodeIds).toContain('n_e2');
      expect(keptNodeIds).toContain('n_e3');

      // Secondary Outcome (Resilience / Recovery) chain must be kept
      expect(keptNodeIds).toContain('n_e4');
      expect(keptNodeIds).toContain('n_e5');

      // Post-outcome investigation nodes must be excluded from nodes
      expect(keptNodeIds).not.toContain('n_e6');
      expect(keptNodeIds).not.toContain('n_e7');

      // Edges leading to outcomes kept; post-outcome edges removed
      const keptEdgeIds = filtered.edges.map((e) => e.id);
      expect(keptEdgeIds).toContain('edge_1');
      expect(keptEdgeIds).toContain('edge_2');
      expect(keptEdgeIds).toContain('edge_3');
      expect(keptEdgeIds).toContain('edge_4');
      expect(keptEdgeIds).not.toContain('edge_5');

      // Investigation committee lane should be cleaned up (no remaining nodes)
      expect(filtered.lanes).toContain('管制塔');
      expect(filtered.lanes).toContain('海保機');
      expect(filtered.lanes).toContain('客室乗務員');
      expect(filtered.lanes).not.toContain('事故調査委員会');

      // Excluded events should be recorded in dispositions for auditability
      expect(filtered.analysis?.dispositions).toBeDefined();
      const excludedIds = filtered.analysis?.dispositions?.map((d) => d.id) ?? [];
      expect(excludedIds).toContain('disp_post_E6');
      expect(excludedIds).toContain('disp_post_E7');

      const disp6 = filtered.analysis?.dispositions?.find((d) => d.id === 'disp_post_E6');
      expect(disp6?.kind).toBe('excluded');
      expect(disp6?.reason).toContain('post-outcome-scope');
    });

    it('returns original schema unchanged if no outcome nodes exist', () => {
      const schema = createTestSchema();
      // Remove outcome markers
      schema.nodes.forEach((n) => { n.type = 'normal'; });
      if (schema.analysis?.outcome) {
        schema.analysis.outcome.eventIds = [];
        schema.analysis.outcome.status = 'not_found';
      }

      const filtered = filterPostOutcomeScope(schema);
      expect(filtered.nodes.length).toBe(schema.nodes.length);
      expect(filtered.lanes).toEqual(schema.lanes);
    });

    it('handles shared events between kept and omitted nodes without deleting events required by kept cards', () => {
      const schema = createTestSchema();
      // Suppose E1 is shared between a kept node on another lane (card_61 on 海保機) and an omitted post-outcome node (n_e6)
      schema.analysis!.cards.push({
        id: 'card_61',
        laneEntityId: '海保機',
        eventIds: ['E1'],
      });
      schema.analysis!.participations.push({
        eventId: 'E1',
        entityId: '海保機',
        role: 'actor',
        factIds: [],
        origin: 'manual',
      });
      schema.nodes.push({
        id: 'card_61',
        title: '待機指示復唱確認',
        description: '待機指示の受領を確認した。',
        lane: '海保機',
        time: '17:45:10',
        type: 'normal',
        measure_type: null,
        event_ids: ['E1'],
      });
      // Also connect card_61 into the causal chain so it is kept
      schema.edges.push({ id: 'edge_shared', source: 'n_e1', target: 'card_61' });
      schema.edges.push({ id: 'edge_shared2', source: 'card_61', target: 'n_e2' });

      // n_e6 also shares E1
      const card6 = schema.analysis!.cards.find((c) => c.id === 'n_e6');
      if (card6) {
        card6.eventIds.push('E1');
      }
      const node6 = schema.nodes.find((n) => n.id === 'n_e6');
      if (node6) {
        node6.event_ids = ['E6', 'E1'];
      }

      const filtered = filterPostOutcomeScope(schema);

      // card_61 must be kept
      expect(filtered.nodes.some((n) => n.id === 'card_61')).toBe(true);
      // E1 must NOT be deleted from events because card_61 and n_e1 need it
      expect(filtered.analysis?.events.some((e) => e.id === 'E1')).toBe(true);
      // E6 should be deleted because it only belonged to omitted nodes
      expect(filtered.analysis?.events.some((e) => e.id === 'E6')).toBe(false);

      // projectAnalysis and validateSavedAnalysis MUST NOT throw
      expect(() => {
        projectAnalysis(filtered.analysis!, filtered);
      }).not.toThrow();
      expect(() => {
        validateSavedAnalysis(filtered.analysis!);
      }).not.toThrow();
    });

    it('preserves causal suppressed cards and purges deleted cards from presentation.suppressedCards', () => {
      const schema = createTestSchema();
      // Setup presentation.suppressedCards
      schema.presentation = {
        lanes: { 管制塔: 'show', 海保機: 'show', 客室乗務員: 'show', 事故調査委員会: 'show' },
        suppressedCards: {
          n_e1: '重複表示の抑制', // causal card (E1) - should be kept or maintained safely
          n_e6: '事後調査ノードの抑制', // post-outcome omitted card (E6) - should be purged!
        },
      };

      const filtered = filterPostOutcomeScope(schema);

      // n_e6 was omitted, so its ID must be purged from suppressedCards (preventing "表示設定が不正です")
      expect(filtered.presentation?.suppressedCards?.n_e6).toBeUndefined();

      // validateSavedAnalysis must succeed without "関与している主体に対応するカードが不足しています。"
      expect(() => {
        validateSavedAnalysis(filtered.analysis!);
      }).not.toThrow();
    });

    it('ensures chain repair delta validation succeeds on the post-outcome filtered schema', () => {
      const schema = createTestSchema();
      const filtered = filterPostOutcomeScope(schema);

      // Verify strict 1-to-1 bijection between cards and participations
      const cardPairs = (filtered.analysis?.cards ?? []).flatMap((c) =>
        c.eventIds.map((evId) => `${evId}\u0000${c.laneEntityId}`)
      );
      const partPairs = (filtered.analysis?.participations ?? []).map(
        (p) => `${p.eventId}\u0000${p.entityId}`
      );

      expect(cardPairs.length).toBe(partPairs.length);
      for (const p of partPairs) {
        expect(cardPairs).toContain(p);
      }

      // Simulate a chain repair proposal (adding a temporal relation between causal events E1 and E2)
      const repairRows: ChainRow[] = [
        {
          section: '関係追加',
          id: 'tmp_rel_1',
          cells: [
            'tmp_rel_1',
            'before',
            'E1',
            '-',
            'E2',
            '-',
            'source_1/p1',
            '-',
            '-',
            'na',
            'recorded',
            '待機指示に続いて誤認進入が発生した時系列推移',
          ],
        },
      ];

      // applyChainDelta must succeed without throwing "関与している主体に対応するカードが不足しています。"
      expect(() => {
        applyChainDelta(filtered, repairRows);
      }).not.toThrow();
    });

    it('preserves pre-outcome nodes even if they are not yet connected to the outcome node in the causal graph', () => {
      const schema = createTestSchema();
      // Add an unlinked pre-outcome event (sourceOrder: 2) on an independent lane
      schema.lanes.push('地上支援');
      schema.analysis!.entities.push({ id: '地上支援', name: '地上支援', kind: 'organization' });
      schema.analysis!.events.push({
        id: 'E2_sub',
        title: '地上待機監視',
        description: '地上支援員がスポット周辺を監視した。',
        time: '17:46:30',
        classification: 'normal',
        sourceOrder: 2,
        factIds: [],
        origin: 'manual',
      });
      schema.analysis!.participations.push({
        eventId: 'E2_sub',
        entityId: '地上支援',
        role: 'actor',
        factIds: [],
        origin: 'manual',
      });
      schema.analysis!.cards.push({
        id: 'n_e2_sub',
        laneEntityId: '地上支援',
        eventIds: ['E2_sub'],
      });
      schema.nodes.push({
        id: 'n_e2_sub',
        title: '地上待機監視',
        description: '地上支援員がスポット周辺を監視した。',
        lane: '地上支援',
        time: '17:46:30',
        type: 'normal',
        measure_type: null,
        event_ids: ['E2_sub'],
      });
      // Notice: NO edges connect n_e2_sub to n_e3 or n_e5!
      const filtered = filterPostOutcomeScope(schema);
      const keptNodeIds = filtered.nodes.map((n) => n.id);

      // Even without graph connectivity to outcome, pre-outcome node must NOT be pruned
      expect(keptNodeIds).toContain('n_e2_sub');
      // Post-outcome investigation activities must still be pruned
      expect(keptNodeIds).not.toContain('n_e6');
      expect(keptNodeIds).not.toContain('n_e7');
    });
  });
});
