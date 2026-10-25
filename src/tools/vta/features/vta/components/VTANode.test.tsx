import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { VTANode } from './VTANode';

vi.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Top: 'top', Bottom: 'bottom', Left: 'left', Right: 'right' },
  useUpdateNodeInternals: () => vi.fn(),
}));

vi.mock('../store/vtaStore', () => ({
  useVTAStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    compactView: false,
    toggleNodeElimination: vi.fn(),
    setNodeHidden: vi.fn(),
    deleteNode: vi.fn(),
    openNodeEditor: vi.fn(),
  }),
}));

describe('VTANode', () => {
  it('shows the hide-as-junction action directly on a visible card', () => {
    const html = renderToStaticMarkup(React.createElement(VTANode, {
      data: {
        id: 'n1', lane: 'A', time: '09:00', title: '確認作業',
        description: '内容', type: 'normal', measure_type: null,
      }, selected: false,
    } as any));

    expect(html).toContain('確認作業');
    expect(html).toContain('図上では接続点として表示');
    expect(html).toContain('説明欄から再表示できます');
  });
});
