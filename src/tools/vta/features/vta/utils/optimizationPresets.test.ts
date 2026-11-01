import { describe, expect, it } from 'vitest';
import {
  OPTIMIZATION_PRESETS,
  METRIC_DESCRIPTIONS,
  DEFAULT_REFINEMENT_SETTINGS,
} from './optimizationPresets';
import { totalScore } from '../../../services/generation/granularityScore';

describe('optimizationPresets', () => {
  it('defines all required preset profiles with valid weights summing to ~1.0', () => {
    const presetIds = ['balanced', 'presentation', 'causality', 'organization'] as const;
    for (const id of presetIds) {
      const p = OPTIMIZATION_PRESETS[id];
      expect(p).toBeDefined();
      expect(p.name).toBeTruthy();
      expect(p.description).toBeTruthy();
      expect(p.maxIterations).toBeGreaterThanOrEqual(1);
      expect(p.maxIterations).toBeLessThanOrEqual(5);

      const sum = p.weights.w1 + p.weights.w2 + p.weights.w3 + p.weights.w4 + p.weights.w5;
      expect(sum).toBeCloseTo(1.0, 4);
    }
  });

  it('defines metric descriptions with user-friendly text for all 5 criteria', () => {
    const keys = ['c1', 'c2', 'c3', 'c4', 'c5'] as const;
    for (const k of keys) {
      const desc = METRIC_DESCRIPTIONS[k];
      expect(desc.label).toBeTruthy();
      expect(desc.summary).toBeTruthy();
      expect(desc.detail).toBeTruthy();
    }
  });

  it('calculates score correctly using preset weights', () => {
    const metrics = { c1: 0.8, c2: 0.9, c3: 0.85, c4: 0.7, c5: 0.75 };
    const scoreBalanced = totalScore(metrics, OPTIMIZATION_PRESETS.balanced.weights);
    const scorePresentation = totalScore(metrics, OPTIMIZATION_PRESETS.presentation.weights);
    expect(scoreBalanced).toBeGreaterThan(0);
    expect(scorePresentation).toBeGreaterThan(0);
  });

  it('matches default settings', () => {
    expect(DEFAULT_REFINEMENT_SETTINGS.preset).toBe('balanced');
    expect(DEFAULT_REFINEMENT_SETTINGS.maxIterations).toBe(2);
  });
});
