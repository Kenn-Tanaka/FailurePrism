import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { LaneManagementPanel } from './LaneManagementPanel';
import { EventReviewPanel } from './EventReviewPanel';
import { createManualAnalysis, projectAnalysis } from '../../features/vta/utils/eventAnalysis';
import type { VTASchema } from '../../types/vta';

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

  it('renders lane force merge controls and quick-merge buttons', () => {
    const original: VTASchema = {
      lanes: ['現場作業員', '管理職'],
      nodes: [
        { id: 'n1', lane: '現場作業員', time: '09:00', title: '作業開始', description: '作業を開始', sequence_order: 0, type: 'normal', measure_type: null },
        { id: 'n2', lane: '管理職', time: '09:05', title: '承認', description: '作業を承認', sequence_order: 0, type: 'normal', measure_type: null },
      ],
      edges: [],
    };
    const schema = projectAnalysis(createManualAnalysis(original), original);
    const html = renderToStaticMarkup(
      <LaneManagementPanel
        schema={schema}
        onAdd={() => true}
        onVisibility={vi.fn()}
        onSimplify={vi.fn()}
        onForceMergeLanes={vi.fn()}
      />
    );
    expect(html).toContain('レーンの強制統合');
    expect(html).toContain('統合元レーン:');
    expect(html).toContain('統合先レーン:');
    expect(html).toContain('🔀 統合');
    expect(html).toContain('へ統合');
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

  it('renders OLAP drill-down and roll-up toggle buttons for parent entities (ADR-0011)', () => {
    const original = {
      lanes: ['海上保安庁'],
      nodes: [],
      edges: [],
    };
    const analysis = createManualAnalysis(original);
    analysis.entities = [
      { id: 'A1', name: '機長Ａ', kind: 'person', parentEntityId: 'A12' },
      { id: 'A2', name: '副操縦員Ａ', kind: 'person', parentEntityId: 'A12' },
      { id: 'A12', name: '海上保安庁', kind: 'organization', mergedFrom: ['A1', 'A2'] },
    ];
    const schema = projectAnalysis(analysis, original);
    schema.presentation = {
      lanes: {},
      suppressedCards: {},
      drilldownLanes: {},
    };

    // 1. ロールアップ状態（デフォルト）
    const htmlCollapsed = renderToStaticMarkup(
      <LaneManagementPanel
        schema={schema}
        onAdd={() => true}
        onVisibility={vi.fn()}
        onSimplify={vi.fn()}
        onToggleDrilldown={vi.fn()}
      />
    );
    expect(htmlCollapsed).toContain('サブレーン（Poset子主体）');
    expect(htmlCollapsed).toContain('機長Ａ、副操縦員Ａ');
    expect(htmlCollapsed).toContain('📂 サブレーン展開');

    // 2. ドリルダウン展開状態
    const schemaExpanded: VTASchema = {
      ...schema,
      presentation: {
        ...schema.presentation,
        drilldownLanes: { A12: true },
      },
    };
    const htmlExpanded = renderToStaticMarkup(
      <LaneManagementPanel
        schema={schemaExpanded}
        onAdd={() => true}
        onVisibility={vi.fn()}
        onSimplify={vi.fn()}
        onToggleDrilldown={vi.fn()}
      />
    );
    expect(htmlExpanded).toContain('📁 親組織に集約');
  });
});
