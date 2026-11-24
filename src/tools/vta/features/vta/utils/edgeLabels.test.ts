import { describe, expect, it } from 'vitest';
import {
  buildEdgeLabelSvgBadge,
  resolveEdgeArrowOrientation,
  resolveEdgeLabelContent,
} from './edgeLabels';

describe('edgeLabels', () => {
  it('resolves clean label content without hardcoding fixed directional glyphs', () => {
    expect(resolveEdgeLabelContent({ isCrossLane: true, direction: 'unidirectional' })).toEqual({
      customLabel: undefined,
      categoryLabel: undefined,
      displayLabel: '伝達',
      fullText: '伝達',
    });
    expect(resolveEdgeLabelContent({ isCrossLane: true, direction: 'bidirectional' })).toEqual({
      customLabel: undefined,
      categoryLabel: undefined,
      displayLabel: '相互確認',
      fullText: '相互確認',
    });
    expect(resolveEdgeLabelContent({ isCrossLane: true, direction: 'undirected' })).toEqual({
      customLabel: undefined,
      categoryLabel: undefined,
      displayLabel: '共通イベント',
      fullText: '共通イベント',
    });
    expect(resolveEdgeLabelContent({ isCrossLane: false, direction: 'sequential' })).toEqual({
      customLabel: undefined,
      categoryLabel: undefined,
      displayLabel: undefined,
      fullText: undefined,
    });
    expect(
      resolveEdgeLabelContent({
        isCrossLane: true,
        direction: 'unidirectional',
        label: '着陸許可',
        category: 'information',
      })
    ).toEqual({
      customLabel: '着陸許可',
      categoryLabel: '情報',
      displayLabel: '着陸許可',
      fullText: '着陸許可 (情報)',
    });
    expect(
      resolveEdgeLabelContent({
        isCrossLane: true,
        direction: 'unidirectional',
        category: 'dependency',
      })
    ).toEqual({
      customLabel: undefined,
      categoryLabel: '作業依存',
      displayLabel: '作業依存',
      fullText: '作業依存',
    });
    expect(
      resolveEdgeLabelContent({
        isCrossLane: true,
        direction: 'unidirectional',
        label: '情報',
        category: 'information',
      })
    ).toEqual({
      customLabel: '情報',
      categoryLabel: undefined,
      displayLabel: '情報',
      fullText: '情報',
    });
    expect(
      resolveEdgeLabelContent({
        isCrossLane: true,
        direction: 'unidirectional',
        label: '物・資機材',
        category: 'material',
      })
    ).toEqual({
      customLabel: '物・資機材',
      categoryLabel: undefined,
      displayLabel: '物・資機材',
      fullText: '物・資機材',
    });
    expect(
      resolveEdgeLabelContent({
        isCrossLane: true,
        direction: 'unidirectional',
        label: '作業依存',
        category: 'dependency',
      })
    ).toEqual({
      customLabel: '作業依存',
      categoryLabel: undefined,
      displayLabel: '作業依存',
      fullText: '作業依存',
    });
    expect(
      resolveEdgeLabelContent({
        isCrossLane: true,
        direction: 'unidirectional',
        status: 'omitted',
      }).customLabel
    ).toBe('未実施');
  });

  it('determines visual arrow orientation from semantics and endpoint geometry', () => {
    expect(
      resolveEdgeArrowOrientation({
        direction: 'unidirectional',
        isCrossLane: true,
        sourceX: 260,
        sourceY: 200,
        targetX: 380,
        targetY: 200,
        sourcePosition: 'right',
      })
    ).toBe('right');

    expect(
      resolveEdgeArrowOrientation({
        direction: 'unidirectional',
        isCrossLane: true,
        sourceX: 380,
        sourceY: 200,
        targetX: 260,
        targetY: 120,
        sourcePosition: 'left',
      })
    ).toBe('left');

    expect(
      resolveEdgeArrowOrientation({
        direction: 'bidirectional',
        isCrossLane: true,
        sourceX: 260,
        sourceY: 200,
        targetX: 380,
        targetY: 200,
      })
    ).toBe('horizontal-both');

    expect(
      resolveEdgeArrowOrientation({
        direction: 'undirected',
        isCrossLane: true,
        sourceX: 260,
        sourceY: 200,
        targetX: 380,
        targetY: 200,
      })
    ).toBe('none');

    expect(
      resolveEdgeArrowOrientation({
        direction: 'sequential',
        isCrossLane: false,
        sourceX: 100,
        sourceY: 300,
        targetX: 100,
        targetY: 120,
        sourcePosition: 'top',
      })
    ).toBe('up');

    expect(
      resolveEdgeArrowOrientation({
        direction: 'unidirectional',
        isCrossLane: false,
        sourceX: 100,
        sourceY: 120,
        targetX: 100,
        targetY: 300,
        sourcePosition: 'top',
      })
    ).toBe('down');

    expect(
      resolveEdgeArrowOrientation({
        direction: 'bidirectional',
        isCrossLane: false,
        sourceX: 100,
        sourceY: 300,
        targetX: 100,
        targetY: 120,
      })
    ).toBe('vertical-both');

    expect(
      resolveEdgeArrowOrientation({
        direction: 'unidirectional',
        isCrossLane: true,
        sourceX: 200,
        sourceY: 300,
        targetX: 200,
        targetY: 120,
        sourcePosition: 'left',
      })
    ).toBe('left');

    // Host-segment-driven orientation: Case 2b cross-lane crank whose label sits on the vertical trunk
    expect(
      resolveEdgeArrowOrientation({
        direction: 'unidirectional',
        isCrossLane: true,
        sourceX: 260,
        sourceY: 400,
        targetX: 380,
        targetY: 200,
        sourcePosition: 'right',
        path: 'M 260 400 L 320 400 L 320 200 L 380 200',
        labelX: 320,
        labelY: 300,
      })
    ).toBe('up');

    expect(
      resolveEdgeArrowOrientation({
        direction: 'unidirectional',
        isCrossLane: true,
        sourceX: 380,
        sourceY: 100,
        targetX: 260,
        targetY: 300,
        sourcePosition: 'left',
        path: 'M 380 100 L 320 100 L 320 300 L 260 300',
        labelX: 320,
        labelY: 200,
      })
    ).toBe('down');

    expect(
      resolveEdgeArrowOrientation({
        direction: 'bidirectional',
        isCrossLane: false,
        sourceX: 100,
        sourceY: 300,
        targetX: 100,
        targetY: 100,
        path: 'M 100 300 L 100 100',
        labelX: 100,
        labelY: 200,
      })
    ).toBe('vertical-both');
  });

  it('builds distinct SVG badge paths with vertical spikes for vertical orientations', () => {
    const rightBadge = buildEdgeLabelSvgBadge('指示', 'right');
    const leftBadge = buildEdgeLabelSvgBadge('指示', 'left');
    const bothBadge = buildEdgeLabelSvgBadge('相互確認', 'horizontal-both');
    const upBadge = buildEdgeLabelSvgBadge('作業依存', 'up');
    const downBadge = buildEdgeLabelSvgBadge('作業依存', 'down');
    const verticalBothBadge = buildEdgeLabelSvgBadge('相互依存', 'vertical-both');
    const noneBadge = buildEdgeLabelSvgBadge('共通イベント', 'none');

    expect(rightBadge.textX).toBeLessThan(0);
    expect(leftBadge.textX).toBeGreaterThan(0);
    expect(bothBadge.textX).toBe(0);
    expect(rightBadge.pathD).not.toBe(leftBadge.pathD);
    expect(upBadge.textX).toBe(0);
    expect(upBadge.iconPathD).toBeUndefined();
    expect(upBadge.pathD).toContain('0 -18');
    expect(downBadge.pathD).toContain('0 18');
    expect(verticalBothBadge.pathD).toContain('0 -18');
    expect(verticalBothBadge.pathD).toContain('0 18');
    expect(upBadge.pathD).not.toBe(downBadge.pathD);
    expect(noneBadge.iconPathD).toBeUndefined();
    expect(noneBadge.pathD).toContain('A 10 10');
  });
});
