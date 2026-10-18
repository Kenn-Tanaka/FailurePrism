import { describe, it, expect } from 'vitest';
import React from 'react';
import { GitBranch } from 'lucide-react';
import { createToolRegistry, installedTools, RawManifestModule } from '../../src/shell/toolLoader';
import {
  resolveViewFromLocation,
  getHashForView,
  getTitleForView,
} from '../../src/shell/gatewayBridge';
import type { ToolManifest } from '../../src/shell/types';

const createMockManifest = (overrides: Partial<ToolManifest> = {}): ToolManifest => ({
  id: 'fta',
  order: 30,
  title: 'FTA-Editor (フォルトツリー解析)',
  shortTitle: 'FTA-Editor',
  subtitle: 'Fault Tree Analysis',
  description: 'トップ事象から論理ゲートで要因を展開するFTA解析ツール。',
  features: ['AND/ORゲート展開', '最小カットセット算出'],
  theme: { color: 'emerald' },
  icon: GitBranch,
  component: () => React.createElement('div', null, 'FTA Mock View'),
  ...overrides,
});

describe('Auto-Plugin Architecture - toolLoader & Dynamic Routing', () => {
  it('auto-discovers built-in tools (tpdd and vta) sorted by order', () => {
    const ids = installedTools.map((t) => t.id);
    expect(ids).toContain('tpdd');
    expect(ids).toContain('vta');
    expect(installedTools[0].id).toBe('tpdd');
    expect(installedTools[1].id).toBe('vta');
  });

  it('registers a 3rd tool via createToolRegistry and integrates routing automatically', () => {
    const mockModules: Record<string, RawManifestModule> = {
      '../tools/vta/manifest.tsx': {
        default: createMockManifest({ id: 'vta', order: 20, title: 'VTA-Editor', shortTitle: 'VTA-Editor' }),
      },
      '../tools/fta/manifest.tsx': {
        default: createMockManifest({
          id: 'fta',
          order: 30,
          title: 'FTA-Editor (フォルトツリー解析)',
          shortTitle: 'FTA-Editor',
        }),
      },
      '../tools/tpdd/manifest.tsx': {
        default: createMockManifest({ id: 'tpdd', order: 10, title: 'TPDD-Editor', shortTitle: 'TPDD-Editor' }),
      },
    };

    const { tools, errors } = createToolRegistry(mockModules);
    expect(errors).toHaveLength(0);
    expect(tools.map((t) => t.id)).toEqual(['tpdd', 'vta', 'fta']);

    // Verify zero-config routing for the newly discovered 'fta' plugin
    expect(resolveViewFromLocation('#fta', '', tools)).toBe('fta');
    expect(resolveViewFromLocation('#/FTA', '', tools)).toBe('fta');
    expect(resolveViewFromLocation('', '?app=fta', tools)).toBe('fta');
    expect(getHashForView('fta', tools)).toBe('#fta');
    expect(getTitleForView('fta', tools)).toContain('FTA-Editor');
  });

  it('rejects reserved tool IDs ("menu" and "home") with validation errors', () => {
    const mockModules: Record<string, RawManifestModule> = {
      '../tools/menu/manifest.tsx': {
        default: createMockManifest({ id: 'menu', order: 1 }),
      },
      '../tools/home/manifest.tsx': {
        default: createMockManifest({ id: 'home', order: 2 }),
      },
      '../tools/fta/manifest.tsx': {
        default: createMockManifest({ id: 'fta', order: 3 }),
      },
    };

    const { tools, errors } = createToolRegistry(mockModules);
    expect(tools.map((t) => t.id)).toEqual(['fta']);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain('reserved');
    expect(errors[1]).toContain('reserved');
  });

  it('rejects invalid tool IDs (special characters) and duplicate IDs', () => {
    const mockModules: Record<string, RawManifestModule> = {
      '../tools/bad1/manifest.tsx': {
        default: createMockManifest({ id: 'invalid id!', order: 1 }),
      },
      '../tools/fta-a/manifest.tsx': {
        default: createMockManifest({ id: 'fta', order: 10, title: 'FTA Primary' }),
      },
      '../tools/fta-b/manifest.tsx': {
        default: createMockManifest({ id: 'fta', order: 20, title: 'FTA Duplicate' }),
      },
    };

    const { tools, errors } = createToolRegistry(mockModules);
    expect(tools).toHaveLength(1);
    expect(tools[0].title).toBe('FTA Primary');
    expect(errors).toHaveLength(2);
  });
});
