import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LaneManagementPanel } from './LaneManagementPanel';
import { EventReviewPanel } from './EventReviewPanel';
import { createManualAnalysis, projectAnalysis } from '../../features/vta/utils/eventAnalysis';

describe('lane and extraction review controls', () => {
  it('exposes all lanes including a manually hidden empty lane and creation controls', () => {
    const original = { lanes: ['表示列', '隠した列'], nodes: [], edges: [] };
    const schema = projectAnalysis(createManualAnalysis(original), original);
    schema.presentation = { lanes: { manual_entity_1: 'show', manual_entity_2: 'hide' }, suppressedCards: {} };
    const html = renderToStaticMarkup(<LaneManagementPanel schema={schema} onAdd={() => true} onVisibility={vi.fn()} onSimplify={vi.fn()} onMove={vi.fn()} />);
    expect(html).toContain('表示列の表示');
    expect(html).toContain('隠した列の表示');
    expect(html).toContain('ユーザー指定で非表示');
    expect(html).toContain('追加レーン名');
    expect(html).toContain('カード整理の候補を確認');
  });

  it('renders merge proposals and split proposals when detected in analysis', () => {
    const original = {
      lanes: ['機長Ａ', '副操縦員Ａ'],
      nodes: [],
      edges: [],
    };
    const analysis = createManualAnalysis(original);
    analysis.entities = [
      { id: 'A1', name: '機長Ａ', kind: 'person', parentEntityId: 'A12' },
      { id: 'A2', name: '副操縦員Ａ', kind: 'person', parentEntityId: 'A12' },
      { id: 'A12', name: '海上保安庁', kind: 'organization' },
    ];
    const schema = projectAnalysis(analysis, original);
    const html = renderToStaticMarkup(
      <LaneManagementPanel
        schema={schema}
        onAdd={() => true}
        onVisibility={vi.fn()}
        onSimplify={vi.fn()}
        onApplyMergeProposal={vi.fn()}
        onApplySplitProposal={vi.fn()}
      />
    );
    expect(html).toContain('レーン粒度の提案');
    expect(html).toContain('【統合案】機長Ａ・副操縦員Ａ');
    expect(html).toContain('統合を適用');
    expect(html).toContain('統合先名:');
  });
  it('shows an explicit empty result and a passage-level retry instead of silently displaying nothing', () => {
    const original = { lanes: [], nodes: [], edges: [] };
    const analysis = createManualAnalysis(original);
    analysis.dispositions = [{ id: 'd', sourceId: 's', paragraphId: 'p1', quote: '調査中', kind: 'review', reason: '関与不明' }];
    const schema = projectAnalysis(analysis);
    const html = renderToStaticMarkup(<EventReviewPanel schema={schema} onChange={vi.fn()} onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(html).toContain('イベントは抽出されませんでした');
    expect(html).toContain('この記述からイベントを再抽出');
    expect(html).toContain('関与不明');
  });
});
