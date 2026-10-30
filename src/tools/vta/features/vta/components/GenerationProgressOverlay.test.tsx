import React from 'react';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { GenerationProgressOverlay } from './GenerationProgressOverlay';
import { useVTAStore } from '../store/vtaStore';
import type { GenerationOperationMode } from '../../../types/vta';

vi.mock('../store/vtaStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/vtaStore')>();
  return {
    ...actual,
    useVTAStore: Object.assign(
      (selector?: (s: ReturnType<typeof actual.useVTAStore.getState>) => unknown) => {
        const state = actual.useVTAStore.getState();
        return selector ? selector(state) : state;
      },
      actual.useVTAStore
    ),
  };
});

describe('GenerationProgressOverlay unified LLM progress dialog', () => {
  beforeEach(() => {
    useVTAStore.getState().resetGenerationProgress();
  });

  it('renders nothing when inactive or when VTA tool isActive is false', () => {
    expect(renderToStaticMarkup(<GenerationProgressOverlay />)).toBe('');

    useVTAStore.getState().setGenerationProgress({
      isActive: true,
      mode: 'extract',
      stage: 'calling_llm',
      title: '【1/3】全文の正規化',
      detail: '個別イベント・主体・根拠を一括で整理しています。',
      stepCurrent: 1,
      stepTotal: 3,
    });

    expect(renderToStaticMarkup(<GenerationProgressOverlay isActive={false} />)).toBe('');
  });

  it('renders mode-specific header titles, step cards, and cancel button for all 7 LLM operations', () => {
    const cases: Array<{
      mode: GenerationOperationMode;
      stepTotal: number;
      expectedHeader: string;
      expectedStepSub: string;
    }> = [
      { mode: 'extract', stepTotal: 3, expectedHeader: 'VTAイベント・主体 抽出中', expectedStepSub: '全文イベント整理' },
      { mode: 'extract', stepTotal: 4, expectedHeader: 'VTAツリー図 生成中', expectedStepSub: 'BT階層整列' },
      { mode: 'classify', stepTotal: 3, expectedHeader: '変動要因（VTA） 判定中', expectedStepSub: '変動要因の判定' },
      { mode: 'restore_passage', stepTotal: 3, expectedHeader: '未反映記述 部分再抽出中', expectedStepSub: 'イベント再解析' },
      { mode: 'propose_connections', stepTotal: 3, expectedHeader: 'レーン間接続 AI提案中', expectedStepSub: '因果接続の探索' },
      { mode: 'repair_chains', stepTotal: 3, expectedHeader: 'レーン内連鎖 AI点検中', expectedStepSub: '連鎖補完の推論' },
      { mode: 'propose_measures', stepTotal: 3, expectedHeader: 'AI対策（排除・ブレイク） 提案中', expectedStepSub: '排除・遮断の立案' },
      { mode: 'regenerate', stepTotal: 3, expectedHeader: '改善された業務フロー &amp; レポート再生成中', expectedStepSub: 'レポート構築' },
    ];

    for (const c of cases) {
      useVTAStore.getState().setGenerationProgress({
        isActive: true,
        mode: c.mode,
        stage: 'calling_llm',
        title: `テスト進行タイトル (${c.mode})`,
        detail: `テスト詳細メッセージ (${c.mode})`,
        stepCurrent: 2,
        stepTotal: c.stepTotal,
      });

      const html = renderToStaticMarkup(<GenerationProgressOverlay isActive={true} />);
      expect(html).toContain(c.expectedHeader);
      expect(html).toContain(c.expectedStepSub);
      expect(html).toContain(`テスト進行タイトル (${c.mode})`);
      expect(html).toContain(`テスト詳細メッセージ (${c.mode})`);
      expect(html).toContain('中断');
      expect(html).toContain('AI推論実行中');
    }
  });
});
