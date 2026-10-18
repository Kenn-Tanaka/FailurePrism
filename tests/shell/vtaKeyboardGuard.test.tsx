import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

let capturedReactFlowProps: Record<string, any> | null = null;

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...actual,
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', { 'data-testid': 'rf-provider' }, children),
    useReactFlow: () => ({
      fitView: vi.fn(),
    }),
    useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    ReactFlow: (props: Record<string, any>) => {
      capturedReactFlowProps = props;
      return React.createElement('div', { 'data-testid': 'react-flow' }, props.children);
    },
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
  };
});

import { App as VTAApp } from '../../src/tools/vta/App';
import { useVTAStore } from '../../src/tools/vta/features/vta/store/vtaStore';
import { SAMPLE_SCENARIOS } from '../../src/tools/vta/features/vta/data/sampleData';
import { appReducer, AppState } from '../../src/tools/tpdd/app/AppContext';
import { createNewProject, addNodeToDiagram } from '../../src/tools/tpdd/domain/commands';
import { createHistoryState } from '../../src/tools/tpdd/domain/history';

describe('Inactive VTA & TPDD Keyboard Deletion Guard (R2-2)', () => {
  beforeEach(() => {
    capturedReactFlowProps = null;
    useVTAStore.getState().loadSample(SAMPLE_SCENARIOS[0].id);
    useVTAStore.setState({ past: [], future: [], toasts: [] });
  });

  it('disables ReactFlow deleteKeyCode and blocks node/edge removal when VTA is inactive (switched to TPDD or Menu), preserving selection, history, and running AI tasks', () => {
    const store = useVTAStore.getState();
    const initialNodeCount = store.vtaData.nodes.length;
    const initialEdgeCount = store.vtaData.edges.length;
    const selectedNodeId = store.nodes[0].id;
    const selectedEdgeId = store.edges[0].id;

    // 1. Select a node and edge in VTA, record 1 history entry, and start an in-flight AI task
    store.onNodesChange([{ id: selectedNodeId, type: 'select', selected: true } as any]);
    store.onEdgesChange([{ id: selectedEdgeId, type: 'select', selected: true } as any]);
    store.toggleNodeElimination(store.nodes[1].id);
    const historyLengthBeforeSwitch = useVTAStore.getState().past.length;
    expect(historyLengthBeforeSwitch).toBe(1);

    const abortController = useVTAStore.getState().createAbortController();
    useVTAStore.getState().setIsExtracting(true);

    // 2. Render VTAApp with isActive={false} (user switched to #tpdd or #menu)
    renderToStaticMarkup(React.createElement(VTAApp, { isActive: false }));
    expect(capturedReactFlowProps).not.toBeNull();

    // ReactFlow deleteKeyCode and global activation keys must be null while inactive
    expect(capturedReactFlowProps!.deleteKeyCode).toBeNull();
    expect(capturedReactFlowProps!.selectionKeyCode).toBeNull();
    expect(capturedReactFlowProps!.multiSelectionKeyCode).toBeNull();
    expect(capturedReactFlowProps!.panActivationKeyCode).toBeNull();
    expect(capturedReactFlowProps!.zoomActivationKeyCode).toBeNull();
    expect(capturedReactFlowProps!.nodesFocusable).toBe(false);
    expect(capturedReactFlowProps!.edgesFocusable).toBe(false);
    expect(capturedReactFlowProps!.onNodesDelete).toBeUndefined();

    // Even if a remove change is dispatched to ReactFlow callbacks while inactive, VTA state must not change
    capturedReactFlowProps!.onNodesChange([{ id: selectedNodeId, type: 'remove' }]);
    capturedReactFlowProps!.onEdgesChange([{ id: selectedEdgeId, type: 'remove' }]);

    const stateWhileInactive = useVTAStore.getState();
    expect(stateWhileInactive.vtaData.nodes.length).toBe(initialNodeCount);
    expect(stateWhileInactive.vtaData.edges.length).toBe(initialEdgeCount);
    expect(stateWhileInactive.nodes.find((n) => n.id === selectedNodeId)?.selected).toBe(true);
    expect(stateWhileInactive.edges.find((e) => e.id === selectedEdgeId)?.selected).toBe(true);
    expect(stateWhileInactive.past.length).toBe(historyLengthBeforeSwitch);
    expect(stateWhileInactive.isExtracting).toBe(true);
    expect(abortController.signal.aborted).toBe(false);
  });

  it('allows normal keyboard deletion and Undo when VTA is active (isActive=true)', () => {
    const store = useVTAStore.getState();
    const initialNodeCount = store.vtaData.nodes.length;
    const targetNode = store.nodes[0];

    renderToStaticMarkup(React.createElement(VTAApp, { isActive: true }));
    expect(capturedReactFlowProps).not.toBeNull();
    expect(capturedReactFlowProps!.deleteKeyCode).toEqual(['Backspace', 'Delete']);
    expect(typeof capturedReactFlowProps!.onNodesDelete).toBe('function');

    // Trigger ReactFlow keyboard deletion handler while active
    capturedReactFlowProps!.onNodesDelete([targetNode]);

    const afterDelete = useVTAStore.getState();
    expect(afterDelete.vtaData.nodes.length).toBe(initialNodeCount - 1);
    expect(afterDelete.vtaData.nodes.some((n) => n.id === targetNode.id)).toBe(false);
    expect(afterDelete.canUndo()).toBe(true);

    // Undo restores the deleted node
    afterDelete.undo();
    expect(useVTAStore.getState().vtaData.nodes.length).toBe(initialNodeCount);
    expect(useVTAStore.getState().vtaData.nodes.some((n) => n.id === targetNode.id)).toBe(true);
  });

  it('preserves TPDD selection state until explicitly deleted when active', () => {
    const baseProj = createNewProject('TPDD Test');
    const { project: projWithNode, newNode } = addNodeToDiagram(baseProj, baseProj.rootDiagramId, {
      label: 'テストノード',
      levelId: baseProj.levels[0].id,
      x: 100,
      y: 100,
    });
    let tpddState: AppState = {
      history: createHistoryState(projWithNode),
      ui: {
        activeDiagramId: projWithNode.rootDiagramId,
        selectedNodeId: null,
        selectedNodeIds: [],
        selectedEdgeId: null,
        edgeDraftSourceId: null,
        viewports: { [projWithNode.rootDiagramId]: { panX: 50, panY: 50, zoom: 1 } },
        dragState: null,
        activeRightTab: 'detail',
        gatewayToken: '',
        notification: null,
        editingNodeId: null,
      },
    };
    const initialTpddNodeCount = tpddState.history.present.diagrams[0].nodes.length;

    tpddState = appReducer(tpddState, { type: 'SELECT_NODE', nodeId: newNode.id });
    expect(tpddState.ui.selectedNodeIds).toEqual([newNode.id]);
    expect(tpddState.history.present.diagrams[0].nodes.length).toBe(initialTpddNodeCount);

    // When active TPDD dispatches REMOVE_SELECTED_ELEMENTS, it deletes and supports UNDO
    tpddState = appReducer(tpddState, { type: 'REMOVE_SELECTED_ELEMENTS' });
    expect(tpddState.history.present.diagrams[0].nodes.length).toBe(initialTpddNodeCount - 1);
    tpddState = appReducer(tpddState, { type: 'UNDO' });
    expect(tpddState.history.present.diagrams[0].nodes.length).toBe(initialTpddNodeCount);
  });
});
