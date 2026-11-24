import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/tools/vta/features/vta/store/vtaStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/tools/vta/features/vta/store/vtaStore')>();
  const mockedUseVTAStore = Object.assign(
    (selector?: (s: ReturnType<typeof actual.useVTAStore.getState>) => unknown) =>
      selector ? selector(actual.useVTAStore.getState()) : actual.useVTAStore.getState(),
    actual.useVTAStore
  );
  return {
    ...actual,
    useVTAStore: mockedUseVTAStore,
  };
});

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...actual,
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', { 'data-testid': 'rf-provider' }, children),
    useReactFlow: () => ({
      fitView: vi.fn(),
      setCenter: vi.fn(),
      getNode: vi.fn(),
    }),
    useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    ReactFlow: (props: Record<string, unknown>) =>
      React.createElement('div', { 'data-testid': 'react-flow' }, props.children as React.ReactNode),
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
  };
});

import { TEST_VTA_FIXTURES, seedVTAStoreWithFixture } from '../helpers/vtaTestFixtures';
import { useVTAStore } from '../../src/tools/vta/features/vta/store/vtaStore';
import { createManualAnalysis } from '../../src/tools/vta/features/vta/utils/eventAnalysis';
import { runDeterministicUiTask } from '../../src/tools/vta/features/vta/utils/uiProgressRunner';
import { DeterministicProgressIndicator } from '../../src/tools/vta/features/vta/components/DeterministicProgressIndicator';
import { Header } from '../../src/tools/vta/components/Header';
import { ControlPanel } from '../../src/tools/vta/components/ControlPanel';
import { VTACanvas } from '../../src/tools/vta/features/vta/components/VTACanvas';

describe('VTA UI Decluttering & Deterministic Progress Feedback (ADR-0073)', () => {
  beforeEach(() => {
    seedVTAStoreWithFixture(0);
    useVTAStore.setState({
      uiTaskProgress: null,
      isLeftPanelCollapsed: false,
      past: [],
      future: [],
      toasts: [],
      isExtracting: false,
      isRegenerating: false,
      isProposing: false,
    });
  });

  it('runDeterministicUiTask sets uiTaskProgress before workFn, supports multi-step updates, prevents re-entrancy, and clears in finally', async () => {
    const snapshots: Array<{ title: string; stepCurrent?: number; detail?: string }> = [];

    const result = await runDeterministicUiTask(
      {
        actionKey: 'test_task',
        level: 'overlay',
        title: 'テスト処理を実行中...',
        detail: 'Step 1',
        stepCurrent: 1,
        stepTotal: 2,
      },
      async (updateStep) => {
        const s1 = useVTAStore.getState().uiTaskProgress;
        expect(s1).not.toBeNull();
        expect(s1?.actionKey).toBe('test_task');
        snapshots.push({ title: s1!.title, stepCurrent: s1?.stepCurrent, detail: s1?.detail });

        // Re-entrant execution while busy must be blocked
        const blocked = await runDeterministicUiTask(
          { actionKey: 'duplicate', level: 'inline', title: '重複実行' },
          () => 'should_not_run'
        );
        expect(blocked).toBeUndefined();

        await updateStep({ stepCurrent: 2, detail: 'Step 2' });
        const s2 = useVTAStore.getState().uiTaskProgress;
        snapshots.push({ title: s2!.title, stepCurrent: s2?.stepCurrent, detail: s2?.detail });
        return 'ok';
      }
    );

    expect(result).toBe('ok');
    expect(useVTAStore.getState().uiTaskProgress).toBeNull();
    expect(snapshots).toEqual([
      { title: 'テスト処理を実行中...', stepCurrent: 1, detail: 'Step 1' },
      { title: 'テスト処理を実行中...', stepCurrent: 2, detail: 'Step 2' },
    ]);

    // Ensure finally clears state even when workFn throws
    await expect(
      runDeterministicUiTask(
        { actionKey: 'failing_task', level: 'inline', title: '失敗テスト' },
        () => {
          throw new Error('boom');
        }
      )
    ).rejects.toThrow('boom');
    expect(useVTAStore.getState().uiTaskProgress).toBeNull();
  });

  it('importProjectJSONWithProgress reports multi-step progress and restores state equivalently to importProjectJSON', async () => {
    const sample1 = TEST_VTA_FIXTURES[1];
    const jsonPayload = JSON.stringify({
      version: '5.0',
      savedAt: new Date().toISOString(),
      scenarioText: sample1.scenarioText,
      vtaData: { ...sample1.vtaData, analysis: createManualAnalysis(sample1.vtaData) },
    });

    const reportedSteps: number[] = [];
    const res = await useVTAStore.getState().importProjectJSONWithProgress(jsonPayload, async (step) => {
      reportedSteps.push(step.stepCurrent);
    });

    expect(res.success).toBe(true);
    expect(reportedSteps).toEqual([2, 3]);
    expect(useVTAStore.getState().scenarioText).toBe(sample1.scenarioText);
    expect(useVTAStore.getState().vtaData.lanes).toEqual(sample1.vtaData.lanes);
    expect(useVTAStore.getState().isDirty).toBe(false);
  });

  it('DeterministicProgressIndicator renders inline (with delayed fade-in) and overlay step cards safely in SSR', () => {
    useVTAStore.getState().setUiTaskProgress({
      id: 't1',
      level: 'inline',
      actionKey: 'auto_layout',
      title: 'スイムレーンの時系列配置を整列中...',
    });
    const inlineHtml = renderToStaticMarkup(<DeterministicProgressIndicator isActive />);
    expect(inlineHtml).toContain('data-vta-deterministic-progress="inline"');
    expect(inlineHtml).toContain('スイムレーンの時系列配置を整列中...');
    expect(inlineHtml).toContain('vtaDelayedFadeIn');

    useVTAStore.getState().setUiTaskProgress({
      id: 't2',
      level: 'overlay',
      actionKey: 'project_import',
      title: 'プロジェクトを読み込み中...',
      detail: 'スキーマ整合性と時間順序DAGを検証しています...',
      stepCurrent: 2,
      stepTotal: 3,
    });
    const overlayHtml = renderToStaticMarkup(<DeterministicProgressIndicator isActive />);
    expect(overlayHtml).toContain('data-vta-deterministic-progress="overlay"');
    expect(overlayHtml).toContain('Step 2/3');
    expect(overlayHtml).toContain('スキーマ整合性と時間順序DAGを検証しています...');
  });

  it('streamlines Header, ControlPanel (collapsible), and VTACanvas toolbar without duplicate clutter', () => {
    const headerHtml = renderToStaticMarkup(<Header />);
    expect(headerHtml).toContain('id="vta-project-file-input"');
    expect(headerHtml).toContain('出力・診断');
    expect(headerHtml).toContain('リプレイ');

    const expandedPanelHtml = renderToStaticMarkup(<ControlPanel />);
    expect(expandedPanelHtml).toContain('生成の詳細オプション');
    expect(expandedPanelHtml).toContain('実行・通信ログ');
    // LLM 詳細フォームが左パネル先頭からヘッダーポップオーバーへ移設されていること
    expect(expandedPanelHtml).not.toContain('ローカルプロキシ / エンドポイント URL');

    useVTAStore.getState().toggleLeftPanel();
    expect(useVTAStore.getState().isLeftPanelCollapsed).toBe(true);
    const collapsedPanelHtml = renderToStaticMarkup(<ControlPanel />);
    expect(collapsedPanelHtml).toContain('ワークフローパネル（折りたたみ中）');
    expect(collapsedPanelHtml).toContain('左ワークフローパネルを展開');

    const canvasHtml = renderToStaticMarkup(<VTACanvas isActive />);
    expect(canvasHtml).toContain('カード追加');
    expect(canvasHtml).toContain('自動整列');
    expect(canvasHtml).toContain('AI再調整');
    expect(canvasHtml).toContain('詳細カード');
    expect(canvasHtml).toContain('見出しのみ');
    // 重複していたボタン群がキャンバスツールバーから整理されていること
    expect(canvasHtml).not.toContain('BT自動整列');
    expect(canvasHtml).not.toContain('AI対策提案');
  });
});
