import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  batchAdoptPreliminary,
  projectAnalysis,
  sourceFromText,
} from '../../src/tools/vta/features/vta/utils/eventAnalysis';
import { useVTAStore } from '../../src/tools/vta/features/vta/store/vtaStore';
import { EventReviewPanel } from '../../src/tools/vta/components/control-panel/EventReviewPanel';
import type { VTAAnalysisData, VTASchema } from '../../src/tools/vta/types/vta';

describe('Batch Adopt Preliminary Classifications (代案A + 代案B)', () => {
  const createMockAnalysis = (): VTAAnalysisData => {
    const source = sourceFromText('E1の説明文。\nE2の説明文。\nE3の説明文。\nE4の説明文。');
    return {
      version: 5,
      sources: [source],
      facts: [],
      events: [
        {
          id: 'E1',
          time: '09:00',
          title: '手順省略',
          description: '点検手順を省略した',
          sourceOrder: 0,
          factIds: [],
          sourceRefs: [{ sourceId: source.id, paragraphId: source.paragraphs[0].id }],
          classification: 'unclassified',
          preliminary: {
            value: 'variation',
            reason: '通常手順の省略が記録されている',
            sourceRefs: [{ sourceId: source.id, paragraphId: source.paragraphs[0].id }],
          },
        },
        {
          id: 'E2',
          time: '09:05',
          title: '日常巡回',
          description: '規定通りに巡回した',
          sourceOrder: 1,
          factIds: [],
          sourceRefs: [{ sourceId: source.id, paragraphId: source.paragraphs[1].id }],
          classification: 'unclassified',
          preliminary: {
            value: 'normal',
            reason: '標準通りの巡回作業',
            sourceRefs: [{ sourceId: source.id, paragraphId: source.paragraphs[1].id }],
          },
        },
        {
          id: 'E3',
          time: '09:10',
          title: '手動判定済み作業',
          description: '手動で通常作業と判定されたもの',
          sourceOrder: 2,
          factIds: [],
          sourceRefs: [{ sourceId: source.id, paragraphId: source.paragraphs[2].id }],
          classification: 'normal', // ユーザーが既に手動設定済み
          preliminary: {
            value: 'variation',
            reason: '仮判定は変動だがユーザーが上書き済み',
            sourceRefs: [{ sourceId: source.id, paragraphId: source.paragraphs[2].id }],
          },
        },
        {
          id: 'E4',
          time: '09:15',
          title: '判定保留事象',
          description: '情報不足の事象',
          sourceOrder: 3,
          factIds: [],
          sourceRefs: [{ sourceId: source.id, paragraphId: source.paragraphs[3].id }],
          classification: 'unclassified',
          preliminary: {
            value: 'undetermined',
            reason: '根拠不足',
            sourceRefs: [],
          },
        },
      ],
      entities: [{ id: 'ent_1', name: '作業員', kind: 'person' }],
      participations: [
        { eventId: 'E1', entityId: 'ent_1', role: 'actor', factIds: [] },
        { eventId: 'E2', entityId: 'ent_1', role: 'actor', factIds: [] },
        { eventId: 'E3', entityId: 'ent_1', role: 'actor', factIds: [] },
        { eventId: 'E4', entityId: 'ent_1', role: 'actor', factIds: [] },
      ],
      relations: [],
      cards: [
        { id: 'c1', laneEntityId: 'ent_1', eventIds: ['E1'] },
        { id: 'c2', laneEntityId: 'ent_1', eventIds: ['E2'] },
        { id: 'c3', laneEntityId: 'ent_1', eventIds: ['E3'] },
        { id: 'c4', laneEntityId: 'ent_1', eventIds: ['E4'] },
      ],
      unassignedEventIds: [],
    };
  };

  describe('batchAdoptPreliminary core function', () => {
    it('adopts only variation preliminary classifications when mode is variation_only', () => {
      const initial = createMockAnalysis();
      const result = batchAdoptPreliminary(initial, 'variation_only');

      expect(result.variationCount).toBe(1);
      expect(result.normalCount).toBe(0);
      expect(result.totalCount).toBe(1);

      const e1 = result.updatedAnalysis.events.find((e) => e.id === 'E1')!;
      const e2 = result.updatedAnalysis.events.find((e) => e.id === 'E2')!;
      const e3 = result.updatedAnalysis.events.find((e) => e.id === 'E3')!;
      const e4 = result.updatedAnalysis.events.find((e) => e.id === 'E4')!;

      // E1: unclassified -> variation に昇格し理由・参照を引き継ぐ
      expect(e1.classification).toBe('variation');
      expect(e1.classificationReason).toBe('通常手順の省略が記録されている');
      expect(e1.classificationSourceRefs).toEqual(e1.preliminary?.sourceRefs);

      // E2: normal仮判定は variation_only では昇格せず unclassified のまま
      expect(e2.classification).toBe('unclassified');

      // E3: 既に normal と手動判定されているため上書きされず保護される
      expect(e3.classification).toBe('normal');

      // E4: undetermined は昇格せず unclassified のまま
      expect(e4.classification).toBe('unclassified');
    });

    it('adopts both variation and normal preliminary classifications when mode is all', () => {
      const initial = createMockAnalysis();
      const result = batchAdoptPreliminary(initial, 'all');

      expect(result.variationCount).toBe(1);
      expect(result.normalCount).toBe(1);
      expect(result.totalCount).toBe(2);

      const e1 = result.updatedAnalysis.events.find((e) => e.id === 'E1')!;
      const e2 = result.updatedAnalysis.events.find((e) => e.id === 'E2')!;
      const e3 = result.updatedAnalysis.events.find((e) => e.id === 'E3')!;
      const e4 = result.updatedAnalysis.events.find((e) => e.id === 'E4')!;

      // E1 -> variation
      expect(e1.classification).toBe('variation');
      // E2 -> normal
      expect(e2.classification).toBe('normal');
      expect(e2.classificationReason).toBe('標準通りの巡回作業');
      // E3 -> 手動判定が維持される
      expect(e3.classification).toBe('normal');
      // E4 -> unclassified
      expect(e4.classification).toBe('unclassified');
    });
  });

  describe('Canvas commit and 1-step Undo via vtaStore', () => {
    it('commits batch adoption and completely reverts to unclassified state on undo()', () => {
      const initial = createMockAnalysis();
      const initialSchema = projectAnalysis(initial);

      // 初期状態を vtaStore にセット
      useVTAStore.setState({
        vtaData: initialSchema,
        past: [],
        future: [],
      });

      // 未判定状態を確認
      const beforeNode = useVTAStore.getState().vtaData.nodes.find((n) => n.id === 'c1')!;
      expect(beforeNode.type).toBe('unclassified');

      // 一括採用を実行
      const { updatedAnalysis } = batchAdoptPreliminary(initial, 'variation_only');
      const adoptedSchema = projectAnalysis(updatedAnalysis, initialSchema);
      useVTAStore.getState().commitVTAChange({ schema: adoptedSchema });

      // コミット後: c1 が variation に更新されている
      const adoptedNode = useVTAStore.getState().vtaData.nodes.find((n) => n.id === 'c1')!;
      expect(adoptedNode.type).toBe('variation');

      // 1ステップ Undo を実行
      useVTAStore.getState().undo();

      // Undo後: 一括採用前の unclassified 状態に完全復元されている
      const restoredNode = useVTAStore.getState().vtaData.nodes.find((n) => n.id === 'c1')!;
      expect(restoredNode.type).toBe('unclassified');
      const restoredEvent = useVTAStore.getState().vtaData.analysis?.events.find((e) => e.id === 'E1')!;
      expect(restoredEvent.classification).toBe('unclassified');
    });
  });

  describe('EventReviewPanel UI rendering', () => {
    it('renders batch adopt buttons with counts and handles in-panel undo', () => {
      const initial = createMockAnalysis();
      const schema = projectAnalysis(initial);

      let currentSchema = schema;
      const html = renderToStaticMarkup(
        <EventReviewPanel
          schema={currentSchema}
          onChange={(next) => { currentSchema = next; }}
          onConfirm={() => {}}
          onCancel={() => {}}
        />
      );

      // 一括操作バーと各ボタンが表示されている
      expect(html).toContain('⚡ 仮判定の一括操作:');
      expect(html).toContain('変動要因 1件');
      expect(html).toContain('変動要因を一括採用 (1件)');
      expect(html).toContain('全仮判定を一括採用 (2件)');
    });
  });
});
