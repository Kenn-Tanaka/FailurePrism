import { describe, expect, it, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ControlPanel } from '../../src/tools/vta/components/ControlPanel';
import { LLMConfigSection } from '../../src/tools/vta/components/control-panel/LLMConfigSection';
import { ResultsSection } from '../../src/tools/vta/components/control-panel/ResultsSection';
import { Header } from '../../src/tools/vta/components/Header';
import { useVTAStore } from '../../src/tools/vta/features/vta/store/vtaStore';
import { TEST_VTA_FIXTURES } from '../helpers/vtaTestFixtures';
import { debugRecorder } from '../../src/tools/vta/services/debugRecorder';

describe('Workflow-Aligned UI Layout & Step Navigation (ADR-0029)', () => {
  beforeEach(() => {
    const sampleData = structuredClone(TEST_VTA_FIXTURES[0].vtaData);
    useVTAStore.setState({
      workflowStep: 'input',
      vtaData: sampleData,
      logs: [],
      isExtracting: false,
      isRegenerating: false,
      isProposing: false,
    });
  });

  it('renders ControlPanel with 3 workflow step tabs and always-visible DebugLogsSection', () => {
    const html = renderToStaticMarkup(<ControlPanel />);

    expect(html).toContain('aria-label="VTA分析ワークフローステップ"');
    expect(html).toContain('シナリオ・抽出');
    expect(html).toContain('検証・要因判定');
    expect(html).toContain('対策・改善生成');
    expect(html).toContain('実行・通信ログ');
  });

  it('switches workflowStep via setWorkflowStep and auto-transitions to measures on applyMeasuresProposal', () => {
    expect(useVTAStore.getState().workflowStep).toBe('input');

    useVTAStore.getState().setWorkflowStep('review');
    expect(useVTAStore.getState().workflowStep).toBe('review');

    const firstVariationNode = useVTAStore
      .getState()
      .vtaData.nodes.find((n) => n.type === 'variation');
    expect(firstVariationNode).toBeDefined();

    useVTAStore.getState().applyMeasuresProposal([firstVariationNode!.id], []);
    expect(useVTAStore.getState().workflowStep).toBe('measures');
  });

  it('renders LLMConfigSection in compact collapsed state by default with model badge and connection test button', () => {
    const html = renderToStaticMarkup(<LLMConfigSection />);

    expect(html).toContain('LLM設定');
    expect(html).toContain('接続テスト');
    expect(html).toContain('aria-expanded="false"');
    // Expanded details like Base URL input label should not be rendered when collapsed
    expect(html).not.toContain('エンドポイント URL (Base URL)');
  });

  it('renders ResultsSection with wide report viewer (拡大) button', () => {
    const html = renderToStaticMarkup(<ResultsSection />);

    expect(html).toContain('改善業務フロー');
    expect(html).toContain('分析・対策レポート');
    expect(html).toContain('拡大');
    expect(html).toContain('レポートを広いモーダル画面で拡大表示');
  });

  it('places Brand & Title before DebugRecordingControls in Header', () => {
    debugRecorder.setEnabled(true);
    try {
      const html = renderToStaticMarkup(<Header />);

      const titleIndex = html.indexOf('Variation Tree Analysis Editor');
      const recordingIndex = html.indexOf('デバッグ記録中・停止');
      expect(titleIndex).toBeGreaterThan(-1);
      expect(recordingIndex).toBeGreaterThan(-1);
      expect(titleIndex).toBeLessThan(recordingIndex);
    } finally {
      debugRecorder.setEnabled(false);
    }
  });
});
