import { describe, it, expect } from 'vitest';
import { appReducer, AppState } from '../../../src/tools/tpdd/app/AppContext';
import { createHistoryState } from '../../../src/tools/tpdd/domain/history';
import { createNewProject } from '../../../src/tools/tpdd/domain/commands';

describe('TPDD Undo/Redo Sub-diagram activeDiagramId consistency (Issue 3)', () => {
  function createInitialState(): AppState {
    const project = createNewProject('Test Diagram Consistency');
    return {
      history: createHistoryState(project),
      ui: {
        activeDiagramId: project.rootDiagramId,
        selectedNodeId: null,
        selectedNodeIds: [],
        selectedEdgeId: null,
        edgeDraftSourceId: null,
        viewports: {
          [project.rootDiagramId]: { panX: 50, panY: 50, zoom: 1 },
        },
        dragState: null,
        activeRightTab: 'detail',
        gatewayToken: '',
        notification: null,
        editingNodeId: null,
      },
    };
  }

  it('restores activeDiagramId to rootDiagramId when detailed diagram creation is undone and allows node creation', () => {
    let state = createInitialState();
    const rootDiagId = state.history.present.rootDiagramId;

    // 1. Add node in root diagram
    state = appReducer(state, {
      type: 'ADD_NODE',
      params: { label: 'Parent Node', kindId: 'function', levelId: state.history.present.levels[0].id, x: 100, y: 100 },
    });
    const parentNodeId = state.ui.selectedNodeId!;
    expect(state.history.present.diagrams[0].nodes.length).toBe(1);

    // 2. Create sub-diagram
    state = appReducer(state, {
      type: 'CREATE_SUB_DIAGRAM',
      parentNodeId,
    });
    expect(state.history.present.diagrams.length).toBe(2);
    const subDiag = state.history.present.diagrams.find((d) => d.id !== rootDiagId)!;
    expect(subDiag).toBeDefined();

    // Navigate to sub diagram
    state = appReducer(state, {
      type: 'SET_ACTIVE_DIAGRAM',
      diagramId: subDiag.id,
    });
    expect(state.ui.activeDiagramId).toBe(subDiag.id);

    // 3. UNDO sub-diagram creation
    state = appReducer(state, { type: 'UNDO' });

    // The sub-diagram should no longer exist in present
    expect(state.history.present.diagrams.some((d) => d.id === subDiag.id)).toBe(false);

    // activeDiagramId MUST NOT point to the deleted sub-diagram, but fall back to rootDiagramId!
    expect(state.ui.activeDiagramId).toBe(rootDiagId);

    // 4. Now add another node to root diagram - must succeed and increment node count!
    state = appReducer(state, {
      type: 'ADD_NODE',
      params: { label: 'Second Node in Root', kindId: 'requirement', levelId: state.history.present.levels[0].id, x: 200, y: 200 },
    });
    const currentRootNodes = state.history.present.diagrams.find((d) => d.id === rootDiagId)!.nodes;
    expect(currentRootNodes.length).toBe(2);
  });
});
