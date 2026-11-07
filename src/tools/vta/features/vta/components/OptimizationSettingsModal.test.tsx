import React from 'react';
import { describe, expect, it, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { OptimizationSettingsModal } from './OptimizationSettingsModal';
import { useVTAStore } from '../store/vtaStore';
import { DEFAULT_REFINEMENT_SETTINGS, OPTIMIZATION_PRESETS } from '../utils/optimizationPresets';

describe('OptimizationSettingsModal', () => {
  beforeEach(() => {
    useVTAStore.setState({
      isOptimizationSettingsOpen: true,
      refinementSettings: { ...DEFAULT_REFINEMENT_SETTINGS },
    });
  });

  it('renders presets and metric explanations when open', () => {
    const html = renderToStaticMarkup(<OptimizationSettingsModal isOpen={true} />);

    // Modal title & headers
    expect(html).toContain('VTA最適化・対話的分析設定');
    expect(html).toContain('標準バランス');
    expect(html).toContain('見やすさ重視');
    expect(html).toContain('因果・厳密性重視');
    expect(html).toContain('組織・役割重視');

    // Descriptions for all 5 criteria
    expect(html).toContain('主体の数（レーン幅）');
    expect(html).toContain('役割・立場の一貫性');
    expect(html).toContain('因果シナリオと結果へのつながり');
    expect(html).toContain('装置・システムの境界');
    expect(html).toContain('図の見やすさ・簡潔さ');
    expect(html).toContain('反復改善の回数');
  });

  it('renders nothing when closed', () => {
    const html = renderToStaticMarkup(<OptimizationSettingsModal isOpen={false} />);
    expect(html).toBe('');
  });

  it('allows store refinementSettings updates and preset application', () => {
    // Switch to presentation preset
    useVTAStore.getState().setRefinementSettings({
      preset: 'presentation',
      maxIterations: OPTIMIZATION_PRESETS.presentation.maxIterations,
      weights: { ...OPTIMIZATION_PRESETS.presentation.weights },
    });

    let state = useVTAStore.getState();
    expect(state.refinementSettings.preset).toBe('presentation');
    expect(state.refinementSettings.weights.w1).toBe(0.35);

    // Apply one-time directive
    useVTAStore.getState().setRefinementSettings({
      oneTimeDirective: '連絡・確認に着目',
      useOneTimeDirective: true,
    });

    state = useVTAStore.getState();
    expect(state.refinementSettings.useOneTimeDirective).toBe(true);
    expect(state.refinementSettings.oneTimeDirective).toBe('連絡・確認に着目');

    // Reset settings
    useVTAStore.getState().resetRefinementSettings();
    state = useVTAStore.getState();
    expect(state.refinementSettings.preset).toBe('balanced');
    expect(state.refinementSettings.maxIterations).toBe(2);
  });

  it('supports user assumptions and analysis scope in refinementSettings', () => {
    // Add user assumption
    useVTAStore.getState().setRefinementSettings({
      assumptions: [
        { id: 'asm_1', text: '当日は雨天で視界不良と仮定', enabled: true },
        { id: 'asm_2', text: 'マニュアル未参照と仮定', enabled: false },
      ],
      scope: {
        timeRange: { enabled: true, start: '08:00', end: '10:00' },
        pinnedEntityIds: ['ent_worker_a'],
        excludedEntityIds: ['ent_vendor'],
      },
    });

    const state = useVTAStore.getState();
    expect(state.refinementSettings.assumptions).toHaveLength(2);
    expect(state.refinementSettings.assumptions?.[0].enabled).toBe(true);
    expect(state.refinementSettings.scope?.pinnedEntityIds).toContain('ent_worker_a');
    expect(state.refinementSettings.scope?.excludedEntityIds).toContain('ent_vendor');
    expect(state.refinementSettings.scope?.timeRange?.start).toBe('08:00');
  });
});
