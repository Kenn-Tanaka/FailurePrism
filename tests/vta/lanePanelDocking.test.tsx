import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

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

vi.mock('../../src/tools/vta/features/vta/store/vtaStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/tools/vta/features/vta/store/vtaStore')>();
  const boundUseVTAStore = ((selector?: (state: unknown) => unknown) => {
    const state = actual.useVTAStore.getState();
    return selector ? selector(state) : state;
  }) as typeof actual.useVTAStore;
  Object.assign(boundUseVTAStore, actual.useVTAStore);
  return {
    ...actual,
    useVTAStore: boundUseVTAStore,
  };
});

import { VTACanvas } from '../../src/tools/vta/features/vta/components/VTACanvas';
import { useVTAStore } from '../../src/tools/vta/features/vta/store/vtaStore';
import { SAMPLE_SCENARIOS } from '../../src/tools/vta/features/vta/data/sampleData';

describe('VTACanvas レーン管理パネルの非重複ドッキング配置', () => {
  beforeEach(() => {
    useVTAStore.getState().loadSample(SAMPLE_SCENARIOS[0].id);
    useVTAStore.setState({
      isLanePanelOpen: false,
      isNotesPanelOpen: true,
    });
  });

  it('レーン管理を開いたとき、キャンバス上に重なるフローティングダイアログではなく右側のドッキング<aside>として配置される', () => {
    useVTAStore.setState({ isLanePanelOpen: true, isNotesPanelOpen: true });

    const html = renderToStaticMarkup(<VTACanvas isActive={true} />);

    // フローティングの role="dialog" としては描画されないこと
    expect(html).not.toContain('role="dialog"');
    expect(html).toContain('<aside id="vta-lane-order-panel"');
    expect(html).toContain('レーン管理・列の順序');
    expect(html).toContain('補足欄へ');

    // ReactFlow キャンバス領域より外側（後続兄弟要素）に配置され、VTA図と重ならないこと
    const canvasIndex = html.indexOf('data-testid="react-flow"');
    const lanePanelIndex = html.indexOf('id="vta-lane-order-panel"');
    expect(canvasIndex).toBeGreaterThan(-1);
    expect(lanePanelIndex).toBeGreaterThan(canvasIndex);

    // 補足説明欄とは排他的に右ドックを切り替えるため、同時に二重表示されないこと
    expect(html).not.toContain('<span>ノード補足説明欄</span>');
    expect(html).not.toContain('ノードの内容・補足と図上の表示設定');
  });

  it('レーン管理を閉じたときは右ドックに補足説明欄が表示され、toggleLanePanelで開閉できる', () => {
    const store = useVTAStore.getState();
    expect(store.isLanePanelOpen).toBe(false);

    const htmlClosed = renderToStaticMarkup(<VTACanvas isActive={true} />);
    expect(htmlClosed).not.toContain('id="vta-lane-order-panel"');
    expect(htmlClosed).toContain('<span>ノード補足説明欄</span>');

    store.toggleLanePanel();
    expect(useVTAStore.getState().isLanePanelOpen).toBe(true);
  });
});
