import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StickyLaneHeaderBar } from './StickyLaneHeaderBar';

// Mock useViewport from @xyflow/react
vi.mock('@xyflow/react', () => ({
  useViewport: () => ({ x: 50, y: 0, zoom: 1 }),
  Panel: ({ children, className }: any) => <div className={className} data-testid="xyflow-panel">{children}</div>,
}));

describe('StickyLaneHeaderBar (レーン上部固定ヘッダーバー)', () => {
  const laneBounds = [
    { name: '海上保安庁機', index: 0, x: 0, width: 380, minY: 0, maxY: 600 },
    { name: '日本航空機', index: 1, x: 380, width: 380, minY: 0, maxY: 600 },
  ];

  it('レーン名と展開ボタンが表示される', () => {
    const drilldownMap = {
      '海上保安庁機': { entityId: 'A12', isExpanded: false, subCount: 2 },
    };

    const html = renderToStaticMarkup(
      <StickyLaneHeaderBar
        laneBounds={laneBounds}
        drilldownCapableMap={drilldownMap}
        onToggleDrilldown={() => {}}
      />
    );

    // レーン名の確認
    expect(html).toContain('海上保安庁機');
    expect(html).toContain('日本航空機');

    // 展開ボタンの確認
    expect(html).toContain('展開(2)');
  });

  it('展開状態の親レーンおよびサブレーンでは集約ボタンが表示される', () => {
    const subLaneBounds = [
      { name: '海上保安庁機', index: 0, x: 0, width: 380, minY: 0, maxY: 600 },
      { name: '海上保安庁機（機長Ａ）', index: 1, x: 380, width: 380, minY: 0, maxY: 600 },
    ];
    const drilldownMap = {
      '海上保安庁機': { entityId: 'A12', isExpanded: true, subCount: 2 },
    };

    const html = renderToStaticMarkup(
      <StickyLaneHeaderBar
        laneBounds={subLaneBounds}
        drilldownCapableMap={drilldownMap}
        onToggleDrilldown={() => {}}
      />
    );

    expect(html).toContain('集約');
  });
});

