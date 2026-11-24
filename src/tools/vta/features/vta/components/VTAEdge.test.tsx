import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { VTAEdge } from './VTAEdge';
import { EDGE_LABEL_CLIP_PATHS } from '../utils/edgeLabels';
import type { VTAReactFlowEdge, VTAReactFlowNode } from '../../../types/vta';

const mockNodes: VTAReactFlowNode[] = [
  {
    id: 'left_node',
    type: 'vtaNode',
    position: { x: 40, y: 200 },
    measured: { width: 260, height: 140 },
    data: { id: 'left_node', lane: '左', time: '09:00', title: '左事象', description: '', type: 'normal', measure_type: null },
  },
  {
    id: 'right_node',
    type: 'vtaNode',
    position: { x: 420, y: 200 },
    measured: { width: 260, height: 140 },
    data: { id: 'right_node', lane: '右', time: '09:00', title: '右事象', description: '', type: 'normal', measure_type: null },
  },
  {
    id: 'far_right_node',
    type: 'vtaNode',
    position: { x: 800, y: 200 },
    measured: { width: 260, height: 140 },
    data: { id: 'far_right_node', lane: '遠', time: '09:00', title: '遠右事象', description: '', type: 'normal', measure_type: null },
  },
  {
    id: 'left_upper_node',
    type: 'vtaNode',
    position: { x: 40, y: 20 },
    measured: { width: 260, height: 120 },
    data: { id: 'left_upper_node', lane: '左', time: '09:10', title: '左上事象', description: '', type: 'normal', measure_type: null },
  },
];

let activeMockNodes = mockNodes.filter((node) => node.id !== 'far_right_node');
let activeMockEdges: VTAReactFlowEdge[] = [];

vi.mock('@xyflow/react', () => ({
  BaseEdge: ({ path }: { path: string }) => React.createElement('div', { 'data-base-edge-path': path }),
  EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => React.createElement('div', { 'data-testid': 'edge-label-layer' }, children),
  useNodes: () => activeMockNodes,
  useEdges: () => activeMockEdges,
}));

vi.mock('../store/vtaStore', () => ({
  useVTAStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      vtaData: { presentation: {} },
      toggleEdgeBreak: vi.fn(),
      toggleEdgeDirection: vi.fn(),
      openEdgeEditor: vi.fn(),
      deleteEdge: vi.fn(),
    }),
}));

function renderEdge(props: Record<string, unknown>) {
  return renderToStaticMarkup(
    React.createElement(VTAEdge, {
      id: 'e1',
      sourceX: 0,
      sourceY: 0,
      targetX: 0,
      targetY: 0,
      selected: false,
      ...props,
    } as any)
  );
}

describe('VTAEdge connection label direction shapes', () => {
  it('renders right-pointing and left-pointing arrow badges matching flow direction even with custom labels', () => {
    const rightHtml = renderEdge({
      source: 'left_node',
      target: 'right_node',
      sourcePosition: 'right',
      targetPosition: 'left',
      data: { is_cross_lane: true, direction: 'unidirectional', label: '指示送信', category: 'information' },
    });
    expect(rightHtml).toContain('data-arrow-orientation="right"');
    expect(rightHtml).toContain(EDGE_LABEL_CLIP_PATHS.right!.outer);
    expect(rightHtml).toContain('指示送信');
    expect(rightHtml).toContain('(情報)');
    expect(rightHtml).not.toContain('lucide-arrow-right');

    const redundantCategoryHtml = renderEdge({
      source: 'left_node',
      target: 'right_node',
      sourcePosition: 'right',
      targetPosition: 'left',
      data: { is_cross_lane: true, direction: 'unidirectional', label: '情報', category: 'information' },
    });
    expect(redundantCategoryHtml).toContain('情報');
    expect(redundantCategoryHtml).not.toContain('(情報)');
    expect(redundantCategoryHtml).not.toContain('lucide-arrow-right');

    const leftHtml = renderEdge({
      source: 'right_node',
      target: 'left_node',
      sourcePosition: 'left',
      targetPosition: 'right',
      data: { is_cross_lane: true, direction: 'unidirectional' },
    });
    expect(leftHtml).toContain('data-arrow-orientation="left"');
    expect(leftHtml).toContain(EDGE_LABEL_CLIP_PATHS.left!.outer);
    expect(leftHtml).toContain('伝達');
    expect(leftHtml).not.toContain('伝達 ➔');
    expect(leftHtml).not.toContain('lucide-arrow-left');
  });

  it('renders double-pointed badge for bidirectional and capsule without arrow for undirected', () => {
    const bidirHtml = renderEdge({
      source: 'left_node',
      target: 'right_node',
      sourcePosition: 'right',
      targetPosition: 'left',
      data: { is_cross_lane: true, direction: 'bidirectional' },
    });
    expect(bidirHtml).toContain('data-arrow-orientation="horizontal-both"');
    expect(bidirHtml).toContain(EDGE_LABEL_CLIP_PATHS['horizontal-both']!.outer);
    expect(bidirHtml).toContain('相互確認');

    const undirHtml = renderEdge({
      source: 'left_node',
      target: 'right_node',
      sourcePosition: 'right',
      targetPosition: 'left',
      data: { is_cross_lane: true, direction: 'undirected' },
    });
    expect(undirHtml).toContain('data-arrow-orientation="none"');
    expect(undirHtml).toContain('共通イベント');
    expect(undirHtml).not.toContain('clip-path');
  });

  it('renders vertical spike orientation for vertical segments (including Case 2b) without redundant inner icons', () => {
    const intraUpHtml = renderEdge({
      source: 'left_node',
      target: 'left_upper_node',
      sourcePosition: 'top',
      targetPosition: 'bottom',
      data: { is_cross_lane: false, direction: 'sequential', label: '工程進行' },
    });
    expect(intraUpHtml).toContain('data-arrow-orientation="up"');
    expect(intraUpHtml).toContain(EDGE_LABEL_CLIP_PATHS.up!.outer);
    expect(intraUpHtml).not.toContain('lucide-arrow-up');
    expect(intraUpHtml).toContain('工程進行');

    // Case 2b cross-lane downward vertical segment uses vertical 'down' spike badge
    const crossDownHtml = renderEdge({
      source: 'left_upper_node',
      target: 'right_node',
      sourcePosition: 'right',
      targetPosition: 'left',
      data: { is_cross_lane: true, direction: 'unidirectional', label: '作業依存' },
    });
    expect(crossDownHtml).toContain('data-arrow-orientation="down"');
    expect(crossDownHtml).toContain(EDGE_LABEL_CLIP_PATHS.down!.outer);
    expect(crossDownHtml).toContain('作業依存');

    const breakHtml = renderEdge({
      source: 'right_node',
      target: 'left_node',
      sourcePosition: 'left',
      targetPosition: 'right',
      data: { is_cross_lane: true, direction: 'unidirectional', label: '誤指示', is_break: true },
    });
    expect(breakHtml).toContain('BREAK');
    expect(breakHtml).toContain('data-arrow-orientation="left"');
    expect(breakHtml).toContain('誤指示');
  });

  it('uses direct horizontal path across skipped lanes when clear, and detours around intermediate cards or reverse edges', () => {
    const prevNodes = activeMockNodes;
    const prevEdges = activeMockEdges;
    try {
      activeMockNodes = mockNodes.filter((n) => n.id !== 'right_node');
      activeMockEdges = [
        {
          id: 'e_span_1',
          source: 'left_node',
          target: 'far_right_node',
          sourceHandle: 'right',
          targetHandle: 'left',
          type: 'vtaEdge',
          data: { is_cross_lane: true, direction: 'unidirectional', laneDistance: 2, label: '連絡' },
        },
        {
          id: 'e_span_2',
          source: 'far_right_node',
          target: 'left_node',
          sourceHandle: 'left',
          targetHandle: 'right',
          type: 'vtaEdge',
          data: { is_cross_lane: true, direction: 'unidirectional', laneDistance: 2, label: '返答' },
        },
      ];

      const html1 = renderEdge({
        id: 'e_span_1',
        source: 'left_node',
        target: 'far_right_node',
        sourcePosition: 'right',
        targetPosition: 'left',
        data: activeMockEdges[0].data,
      });
      const html2 = renderEdge({
        id: 'e_span_2',
        source: 'far_right_node',
        target: 'left_node',
        sourcePosition: 'left',
        targetPosition: 'right',
        data: activeMockEdges[1].data,
      });
      expect(html1).toContain('data-base-edge-path="M 300 270 L 800 270"');
      const detourMatch = html2.match(/data-base-edge-path="([^"]+)"/);
      expect(detourMatch?.[1]).toBeTruthy();
      expect((detourMatch?.[1].match(/L /g) ?? []).length).toBeGreaterThan(1);

      // Reintroduce intermediate node right_node -> e_span_1 now detours
      activeMockNodes = mockNodes;
      const blockedHtml = renderEdge({
        id: 'e_span_1',
        source: 'left_node',
        target: 'far_right_node',
        sourcePosition: 'right',
        targetPosition: 'left',
        data: activeMockEdges[0].data,
      });
      const blockedMatch = blockedHtml.match(/data-base-edge-path="([^"]+)"/);
      expect((blockedMatch?.[1].match(/L /g) ?? []).length).toBeGreaterThan(1);
    } finally {
      activeMockNodes = prevNodes;
      activeMockEdges = prevEdges;
    }
  });
});
