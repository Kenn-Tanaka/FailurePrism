import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SupplementaryNotesPanel } from './SupplementaryNotesPanel';

vi.mock('@xyflow/react', () => ({
  useReactFlow: () => ({ setCenter: vi.fn(), getNode: vi.fn() }),
}));

vi.mock('../store/vtaStore', () => ({
  useVTAStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    compactView: true,
    isNotesPanelOpen: true,
    vtaData: {
      lanes: ['製造部'],
      nodes: [{
        id: 'node-1', lane: '製造部', time: '試験当日 午前09時00分から午前09時30分にかけて確認作業を実施', title: '作業開始',
        description: '旧手順書に従って着手', type: 'normal', measure_type: null,
        is_hidden: true,
      }, {
        id: 'node-2', lane: '製造部', time: '', title: '手順確認',
        description: '手順書を確認', type: 'normal', measure_type: null,
        is_hidden: false,
      }],
      edges: [],
    },
  }),
}));

describe('SupplementaryNotesPanel', () => {
  it('shows node content in the right panel when the diagram displays titles only', () => {
    const html = renderToStaticMarkup(React.createElement(SupplementaryNotesPanel));

    expect(html).toContain('ノード別内容・補足 (2)');
    expect(html).toContain('旧手順書に従って着手');
    expect(html).toContain('発生タイミング');
    expect(html).toContain('試験当日 午前09時00分から午前09時30分にかけて確認作業を実施');
    expect(html).toContain('未設定');
    expect(html).toContain('whitespace-pre-wrap break-words [overflow-wrap:anywhere]');
    expect(html).toContain('内容を編集');
    expect(html).toContain('図上は接続点');
    expect(html).toContain('カードを再表示');
    expect(html).toContain('図上では接続点として表示');
  });
});
