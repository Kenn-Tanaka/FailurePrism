import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { EventReviewPanel } from './EventReviewPanel';
import type { VTASchema } from '../../types/vta';

vi.mock('../../features/vta/store/vtaStore', () => ({
  useVTAStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        llmConfig: {
          gatewayUrl: 'http://127.0.0.1:8765/v1',
          gatewayToken: '',
          selectedModel: 'openrouter/google/gemini-3.0-flash',
        },
        subjectLimit: 5,
        setSubjectLimit: vi.fn(),
        showToast: vi.fn(),
        addLog: vi.fn(),
      }),
    {
      getState: () => ({
        createAbortController: () => new AbortController(),
        resetGenerationProgress: vi.fn(),
        subjectLimit: 5,
        setSubjectLimit: vi.fn(),
        showToast: vi.fn(),
        addLog: vi.fn(),
      }),
    }
  ),
}));

describe('EventReviewPanel generation scheme support', () => {
  it('shows event-chain scheme label instead of unsupported message when schemeId is event-chain', () => {
    const schema: VTASchema = {
      lanes: ['作業員'],
      nodes: [
        {
          id: 'card_1',
          event_ids: ['e1'],
          lane: '作業員',
          time: '09:00',
          type: 'normal',
          title: '作業開始',
          description: '作業を開始した',
          measure_type: null,
        },
      ],
      edges: [],
      analysis: {
        version: 5,
        sources: [
          {
            id: 's1',
            text: '09:00 作業員が作業を開始した。なお現場は晴天であった。',
            paragraphs: [
              { id: 'p1', text: '09:00 作業員が作業を開始した。' },
              { id: 'p2', text: 'なお現場は晴天であった。' },
            ],
          },
        ],
        facts: [],
        events: [
          {
            id: 'e1',
            title: '作業開始',
            description: '作業を開始した',
            time: '09:00',
            sourceOrder: 0,
            factIds: [],
            sourceRefs: [{ sourceId: 's1', paragraphId: 'p1' }],
            classification: 'normal',
          },
        ],
        entities: [{ id: 'ent_1', name: '作業員', kind: 'person' }],
        participations: [{ eventId: 'e1', entityId: 'ent_1', role: 'actor', factIds: [] }],
        relations: [],
        cards: [{ id: 'card_1', laneEntityId: 'ent_1', eventIds: ['e1'] }],
        unassignedEventIds: [],
        dispositions: [
          {
            id: 'd1',
            kind: 'background',
            reason: '天候背景情報',
            sourceId: 's1',
            paragraphId: 'p2',
            quote: 'なお現場は晴天であった。',
          },
        ],
        generation: {
          runId: 'run-1',
          schemeId: 'event-chain',
          schemeVersion: '1.0.0',
          ruleVersion: 'vta-event-chain-2026-04-20',
          model: 'openrouter/google/gemini-3.0-flash',
          promptFingerprint: 'fp-prompt',
          inputFingerprint: 'fp-input',
        },
      },
    };

    const html = renderToStaticMarkup(
      <EventReviewPanel
        schema={schema}
        onChange={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(html).toContain('生成方式：事象連鎖方式（選択した記述のみ再解析可能）');
    expect(html).not.toContain('この生成方式の部分再抽出には対応していません。');
    expect(html).toContain('この記述からイベントを再抽出');
  });

  it('renders subject ranking breakdown and merged target when subjectRanking is present', () => {
    const schema: VTASchema = {
      lanes: ['私（報告者）', 'その他の関係者'],
      nodes: [],
      edges: [],
      analysis: {
        version: 5,
        sources: [{ id: 's1', text: 'p1 私が報告した。', paragraphs: [{ id: 'p1', text: '私が報告した。' }] }],
        facts: [],
        events: [
          {
            id: 'e1',
            title: '報告',
            description: '私が報告した',
            time: '09:00',
            sourceOrder: 0,
            factIds: [],
            sourceRefs: [{ sourceId: 's1', paragraphId: 'p1' }],
            classification: 'normal',
          },
        ],
        entities: [
          { id: 'A1', name: '私（報告者）', kind: 'person', focus: 'reporter' },
          { id: 'subject_others', name: 'その他の関係者', kind: 'other', aggregate: true },
        ],
        participations: [
          { eventId: 'e1', entityId: 'A1', role: 'actor', factIds: [] },
        ],
        relations: [],
        cards: [{ id: 'c1', laneEntityId: 'A1', eventIds: ['e1'] }],
        unassignedEventIds: [],
        subjectRanking: {
          version: 1,
          maxSubjects: 2,
          weights: { A: 0.3, O: 0.25, F: 0.2, C: 0.15, T: 0.1 },
          originalEntities: [
            { id: 'A1', name: '私（報告者）', kind: 'person', focus: 'reporter', focusSourceRefs: [{ sourceId: 's1', paragraphId: 'p1' }] },
            { id: 'A2', name: '倉庫担当', kind: 'person', focus: 'low' },
          ],
          ranks: [
            {
              entityId: 'A1',
              rank: 1,
              score: 0.92,
              breakdown: { A: 1, O: 1, F: 1, C: 0.5, T: 1 },
              priority: 'reporter',
              retained: true,
              reason: '優先保持：報告者本人',
            },
            {
              entityId: 'A2',
              rank: 2,
              score: 0.18,
              breakdown: { A: 0.2, O: 0.2, F: 0, C: 0.2, T: 0 },
              retained: false,
              mergedInto: 'subject_others',
              reason: '上限超過のため「その他の関係者」へ統合',
            },
          ],
        },
      },
    };

    const html = renderToStaticMarkup(
      <EventReviewPanel
        schema={schema}
        autoConnect={true}
        onChange={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(html).toContain('主体の重要度（上限 2件／抽出 2件・採用 2件）');
    expect(html).toContain('報告当事者・優先保持');
    expect(html).toContain('統合 → その他の関係者');
    expect(html).toContain('上限を再適用');

    const htmlConfirmed = renderToStaticMarkup(
      <EventReviewPanel
        schema={schema}
        autoConnect={false}
        onChange={vi.fn()}
        onConfirm={vi.fn()}
        onCancel={vi.fn()}
      />
    );

    expect(htmlConfirmed).toContain('図面へ反映済みの編集モードです');
    expect(htmlConfirmed).not.toContain('上限を再適用');
  });
});
