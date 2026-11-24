import { describe, it, expect, beforeEach } from 'vitest';
import { useVTAStore } from './vtaStore';
import { TEST_VTA_FIXTURES, seedVTAStoreWithFixture } from '../../../../../../tests/helpers/vtaTestFixtures';
import { calculateVTALayout, LANE_PADDING, LANE_WIDTH } from '../utils/layout';
import { getDisplayRect, projectDisplayNode } from '../utils/nodeGeometry';
import { createManualAnalysis } from '../utils/eventAnalysis';

describe('vtaStore.ts - High & Medium Fixes Verification', () => {

  it('preserves data, manual positions and history when switching presentation mode', () => {
    const before = useVTAStore.getState();
    const snapshot = JSON.stringify({ data: before.vtaData, nodes: before.nodes, past: before.past, dirty: before.isDirty });
    before.toggleCompactView();
    const compact = useVTAStore.getState();
    expect(compact.compactView).toBe(!before.compactView);
    expect(JSON.stringify({ data: compact.vtaData, nodes: compact.nodes, past: compact.past, dirty: compact.isDirty })).toBe(snapshot);
    compact.toggleCompactView();
    expect(useVTAStore.getState().compactView).toBe(before.compactView);
  });

  it('persists a compact drag in the compact coordinate set and groups it into one undo step', () => {
    const store = useVTAStore.getState();
    store.toggleCompactView();
    const initialLayout = calculateVTALayout(useVTAStore.getState().vtaData, undefined, undefined, { compact: true, positionField: 'compact_position' });
    const target = initialLayout.nodes[0];
    const detailPosition = useVTAStore.getState().nodes.find((node) => node.id === target.id)!.position;
    const nextPosition = { x: target.position.x + 35, y: target.position.y - 1000 };
    useVTAStore.getState().onNodesChange([{ id: target.id, type: 'position', position: nextPosition, dragging: true }], 'compact');
    useVTAStore.getState().onNodesChange([{ id: target.id, type: 'position', position: nextPosition, dragging: false }], 'compact');

    const moved = useVTAStore.getState().vtaData.nodes.find((node) => node.id === target.id)!;
    expect(moved.compact_position).toEqual(nextPosition);
    expect(moved.position ?? detailPosition).toEqual(detailPosition);
    expect(useVTAStore.getState().past).toHaveLength(1);

    useVTAStore.getState().undo();
    const restoredLayout = calculateVTALayout(useVTAStore.getState().vtaData, undefined, undefined, { compact: true, positionField: 'compact_position' });
    expect(restoredLayout.nodes.find((node) => node.id === target.id)?.position).toEqual(target.position);
    useVTAStore.getState().redo();
    expect(useVTAStore.getState().vtaData.nodes.find((node) => node.id === target.id)?.compact_position).toEqual(nextPosition);
    useVTAStore.getState().toggleCompactView();
  });

  it('ignores a stale drag-end event after cancelling a compact move', () => {
    const before = useVTAStore.getState();
    const original = JSON.stringify(before.vtaData);
    const node = calculateVTALayout(before.vtaData, undefined, undefined, { compact: true, positionField: 'compact_position' }).nodes[0];
    const next = { x: node.position.x + 20, y: node.position.y - 1000 };
    before.allowNewNodeDrag();
    before.onNodesChange([{ id: node.id, type: 'position', position: next, dragging: true }], 'compact');
    expect(useVTAStore.getState().cancelNodeDrag()).toBe(true);
    useVTAStore.getState().onNodesChange([{ id: node.id, type: 'position', position: next, dragging: false }], 'compact');
    expect(JSON.stringify(useVTAStore.getState().vtaData)).toBe(original);
    expect(useVTAStore.getState().past).toHaveLength(0);
  });

  const resetInMemoryStateWithoutClearingStorage = () => {
    const sample = TEST_VTA_FIXTURES[0];
    const sampleSchema = { ...structuredClone(sample.vtaData), analysis: createManualAnalysis(sample.vtaData) };
    const layout = calculateVTALayout(sampleSchema);
    useVTAStore.setState({
      selectedSampleId: sample.id,
      scenarioText: sample.scenarioText,
      vtaData: sampleSchema,
      nodes: layout.nodes,
      edges: layout.edges,
      laneBounds: layout.laneBounds,
      regenerationResult: null,
      isReportOutdated: false,
      isDirty: false,
      past: [],
      future: [],
    });
  };

  beforeEach(() => {
    // Reset store state with a clean fixture and clean history stacks
    seedVTAStoreWithFixture(0);
    useVTAStore.getState().setSnapToLaneCenter(false);
    useVTAStore.setState({ past: [], future: [], toasts: [], previousBackupSnapshot: null });
  });

  describe('optional lane-center snap after dragging', () => {
    const laneCenter = LANE_PADDING + LANE_WIDTH / 2;

    it('changes only the user preference without editing the project', () => {
      const before = useVTAStore.getState();
      const schema = before.vtaData;
      const past = before.past;
      const dirty = before.isDirty;
      before.setSnapToLaneCenter(true);
      const after = useVTAStore.getState();
      expect(after.snapToLaneCenter).toBe(true);
      expect(after.vtaData).toBe(schema);
      expect(after.past).toBe(past);
      expect(after.isDirty).toBe(dirty);
    });

    it('snaps only the dragged card in detail view and includes the snap in Undo/Redo', () => {
      useVTAStore.getState().setVTAData({
        lanes: ['担当'],
        nodes: [
          { id: 'moved', lane: '担当', time: '10:00', type: 'normal', title: '移動', description: '', measure_type: null, position: { x: 140, y: 500 } },
          { id: 'still', lane: '担当', time: '11:00', type: 'normal', title: '固定', description: '', measure_type: null, position: { x: 190, y: 100 } },
        ],
        edges: [],
      });
      useVTAStore.setState({ past: [], future: [] });
      useVTAStore.getState().setSnapToLaneCenter(true);
      const stillX = useVTAStore.getState().nodes.find((node) => node.id === 'still')!.position.x;
      const position = { x: 360, y: 600 };
      useVTAStore.getState().onNodesChange([{ id: 'moved', type: 'position', position, dragging: true }]);
      expect(useVTAStore.getState().nodes.find((node) => node.id === 'moved')!.position.x).toBe(position.x);
      useVTAStore.getState().onNodesChange([{ id: 'moved', type: 'position', position, dragging: false }]);
      const moved = useVTAStore.getState().nodes.find((node) => node.id === 'moved')!;
      expect(getDisplayRect(moved).x + getDisplayRect(moved).width / 2).toBeCloseTo(laneCenter);
      expect(moved.position.y).toBe(position.y);
      expect(useVTAStore.getState().nodes.find((node) => node.id === 'still')!.position.x).toBe(stillX);
      expect(useVTAStore.getState().past).toHaveLength(1);
      useVTAStore.getState().undo();
      expect(useVTAStore.getState().nodes.find((node) => node.id === 'moved')!.position.x).toBe(140);
      useVTAStore.getState().redo();
      const redoneRect = getDisplayRect(useVTAStore.getState().nodes.find((node) => node.id === 'moved')!);
      expect(redoneRect.x + redoneRect.width / 2).toBeCloseTo(laneCenter);
    });

    it('snaps each directly dragged card to its own lane during multi-selection', () => {
      useVTAStore.getState().setVTAData({
        lanes: ['左', '右'],
        nodes: [
          { id: 'left', lane: '左', time: '10:00', type: 'normal', title: '左', description: '', measure_type: null, position: { x: 130, y: 500 } },
          { id: 'right', lane: '右', time: '10:00', type: 'normal', title: '右', description: '', measure_type: null, position: { x: 550, y: 500 } },
        ],
        edges: [],
      });
      useVTAStore.setState({ past: [], future: [] });
      useVTAStore.getState().setSnapToLaneCenter(true);
      const changes = [
        { id: 'left', type: 'position' as const, position: { x: 280, y: 600 }, dragging: true },
        { id: 'right', type: 'position' as const, position: { x: 780, y: 600 }, dragging: true },
      ];
      useVTAStore.getState().onNodesChange(changes);
      useVTAStore.getState().onNodesChange(changes.map((change) => ({ ...change, dragging: false })));
      const nodes = useVTAStore.getState().nodes;
      for (const [id, expectedCenter] of [['left', laneCenter], ['right', laneCenter + LANE_WIDTH]] as const) {
        const rect = getDisplayRect(nodes.find((node) => node.id === id)!);
        expect(rect.x + rect.width / 2).toBeCloseTo(expectedCenter);
      }
      expect(useVTAStore.getState().past).toHaveLength(1);
    });

    for (const mode of ['detail', 'compact'] as const) {
      it(`snaps a dragged connection point in ${mode} view`, () => {
        useVTAStore.getState().setVTAData({
          lanes: ['担当'],
          nodes: [{ id: 'point', lane: '担当', time: '10:00', type: 'normal', title: '接続点', description: '', measure_type: null,
            is_hidden: true, hidden_card_height: 140, position: { x: 160, y: 500 }, compact_position: { x: 170, y: 500 } }],
          edges: [],
        });
        useVTAStore.setState({ past: [], future: [] });
        useVTAStore.getState().setSnapToLaneCenter(true);
        const before = mode === 'detail'
          ? useVTAStore.getState().nodes[0]
          : calculateVTALayout(useVTAStore.getState().vtaData, undefined, undefined, { compact: true, positionField: 'compact_position' }).nodes[0];
        const point = projectDisplayNode(before);
        const nextPosition = { x: point.position.x + 55, y: point.position.y + 250 };
        useVTAStore.getState().onNodesChange([{ id: 'point', type: 'position', position: nextPosition, dragging: true }], mode);
        useVTAStore.getState().onNodesChange([{ id: 'point', type: 'position', position: nextPosition, dragging: false }], mode);
        const after = mode === 'detail'
          ? useVTAStore.getState().nodes[0]
          : calculateVTALayout(useVTAStore.getState().vtaData, undefined, undefined, { compact: true, positionField: 'compact_position' }).nodes[0];
        const rect = getDisplayRect(after);
        expect(rect.x + rect.width / 2).toBeCloseTo(laneCenter);
        expect(rect.y + rect.height / 2).toBeCloseTo(nextPosition.y + rect.height / 2);
        expect(useVTAStore.getState().past).toHaveLength(1);
      });
    }
  });

  describe('Undo / Redo History Stack (M-04, M-06)', () => {
    it('should push snapshot to past history when mutations occur', () => {
      const store = useVTAStore.getState();
      expect(store.canUndo()).toBe(false);
      expect(store.canRedo()).toBe(false);

      const firstNode = store.vtaData.nodes[0];
      const initialMeasure = firstNode.measure_type;

      // Mutation: Toggle elimination
      store.toggleNodeElimination(firstNode.id);

      expect(useVTAStore.getState().canUndo()).toBe(true);
      expect(useVTAStore.getState().canRedo()).toBe(false);
      expect(useVTAStore.getState().vtaData.nodes[0].measure_type).not.toBe(initialMeasure);
    });

    it('should correctly restore previous state on undo', () => {
      const store = useVTAStore.getState();
      const initialCount = store.vtaData.nodes.length;

      store.addNode({
        lane: '現場作業員',
        time: '12:00',
        type: 'normal',
        title: 'テスト作業ノード',
        description: 'テスト説明',
        measure_type: null,
      });

      expect(useVTAStore.getState().vtaData.nodes.length).toBe(initialCount + 1);
      expect(useVTAStore.getState().canUndo()).toBe(true);

      useVTAStore.getState().undo();

      expect(useVTAStore.getState().vtaData.nodes.length).toBe(initialCount);
      expect(useVTAStore.getState().canRedo()).toBe(true);
    });

    it('should correctly re-apply state on redo', () => {
      const store = useVTAStore.getState();
      const initialCount = store.vtaData.nodes.length;

      store.addNode({
        lane: '現場作業員',
        time: '12:00',
        type: 'normal',
        title: 'テスト作業ノード2',
        description: 'テスト説明2',
        measure_type: null,
      });

      useVTAStore.getState().undo();
      expect(useVTAStore.getState().vtaData.nodes.length).toBe(initialCount);

      useVTAStore.getState().redo();
      expect(useVTAStore.getState().vtaData.nodes.length).toBe(initialCount + 1);
      expect(useVTAStore.getState().canRedo()).toBe(false);
    });

    it('should not push history when target edge does not exist (M-06 guard test)', () => {
      const store = useVTAStore.getState();
      expect(store.canUndo()).toBe(false);

      // Call edge mutations with non-existent edge id
      store.toggleEdgeBreak('non-existent-edge-id');
      expect(useVTAStore.getState().canUndo()).toBe(false);

      store.toggleEdgeDirection('non-existent-edge-id');
      expect(useVTAStore.getState().canUndo()).toBe(false);

      store.deleteEdge('non-existent-edge-id');
      expect(useVTAStore.getState().canUndo()).toBe(false);
    });
  });

  describe('Keyboard Node Deletion Sync (H-01)', () => {
    it('should synchronously remove node and connected edges from vtaData when onNodesDelete is invoked', () => {
      const store = useVTAStore.getState();
      const targetNode = store.nodes[0];
      const initialNodeCount = store.vtaData.nodes.length;

      // Find an edge connected to targetNode
      const connectedEdge = store.vtaData.edges.find(
        (e) => e.source === targetNode.id || e.target === targetNode.id
      );

      // Simulate keyboard delete via onNodesDelete
      store.onNodesDelete([targetNode]);

      const stateAfterDelete = useVTAStore.getState();
      // Node removed from vtaData.nodes
      expect(stateAfterDelete.vtaData.nodes.length).toBe(initialNodeCount - 1);
      expect(stateAfterDelete.vtaData.nodes.some((n) => n.id === targetNode.id)).toBe(false);
      // Node removed from React Flow nodes
      expect(stateAfterDelete.nodes.some((n) => n.id === targetNode.id)).toBe(false);

      // Connected edge removed from vtaData.edges
      if (connectedEdge) {
        expect(
          stateAfterDelete.vtaData.edges.some(
            (e) => e.source === targetNode.id || e.target === targetNode.id
          )
        ).toBe(false);
      }

      // History should be pushed
      expect(stateAfterDelete.canUndo()).toBe(true);

      // Undo should restore node
      stateAfterDelete.undo();
      expect(useVTAStore.getState().vtaData.nodes.length).toBe(initialNodeCount);
    });
  });

  describe('Supplementary Notes History Preservation (H-02)', () => {
    it('should not push history on every keystroke in supplementary notes', () => {
      const store = useVTAStore.getState();
      const targetNode = store.vtaData.nodes[0];
      expect(store.canUndo()).toBe(false);

      // Simulate typing 10 characters
      for (let i = 1; i <= 10; i++) {
        useVTAStore.getState().updateNodeSupplementaryNote(targetNode.id, `text_${i}`);
      }

      // Past history should NOT be flooded
      expect(useVTAStore.getState().past.length).toBe(0);

      // Focus snapshot then typing
      useVTAStore.getState().recordHistorySnapshot();
      useVTAStore.getState().updateNodeSupplementaryNote(targetNode.id, 'final typed text');

      // Only 1 history snapshot recorded
      expect(useVTAStore.getState().past.length).toBe(1);

      // Undo restores to text before typing
      useVTAStore.getState().undo();
      expect(useVTAStore.getState().vtaData.nodes[0].supplementary_note).toBe('text_10');
    });
  });

  describe('Manual Node Position Persistence & Restoration (H-03)', () => {
    it('should record dragged node position into vtaData and preserve it across addNode', () => {
      const store = useVTAStore.getState();
      const targetNode = store.nodes[0];
      const customX = 1234;
      const customY = 5678;

      // Update position via updateNodePosition (called onDragStop)
      store.updateNodePosition(targetNode.id, { x: customX, y: customY });

      // Check saved on vtaData.nodes
      const savedInSchema = useVTAStore.getState().vtaData.nodes.find((n) => n.id === targetNode.id);
      expect(savedInSchema?.position?.x).toBe(customX);
      expect(savedInSchema?.position?.y).toBe(customY);

      // Now add a completely new node
      useVTAStore.getState().addNode({
        lane: targetNode.data.lane,
        time: '99:99',
        type: 'normal',
        title: '新規追加ノード',
        description: '説明',
        measure_type: null,
      });

      // The dragged node must retain customX, customY!
      const nodeAfterAdd = useVTAStore.getState().nodes.find((n) => n.id === targetNode.id)!;
      expect(nodeAfterAdd.position.x).toBe(customX);
      expect(nodeAfterAdd.position.y).toBe(customY);
    });

    it('should recompute positions on recalculateLayout', () => {
      const store = useVTAStore.getState();
      const targetNode = store.nodes[0];
      const customX = 9999;
      const customY = 8888;

      store.updateNodePosition(targetNode.id, { x: customX, y: customY });
      expect(useVTAStore.getState().nodes.find((n) => n.id === targetNode.id)!.position.x).toBe(customX);

      // BT Auto Layout recompute
      useVTAStore.getState().recalculateLayout();

      const nodeAfterRecompute = useVTAStore.getState().nodes.find((n) => n.id === targetNode.id)!;
      expect(nodeAfterRecompute.position.x).not.toBe(customX);
    });
  });

  describe('Connection Guards (L-02)', () => {
    it('should ignore self-loop connections', () => {
      const store = useVTAStore.getState();
      const node = store.nodes[0];
      const initialEdgeCount = store.edges.length;
      const initialHistoryLength = store.past.length;

      store.onConnect({
        source: node.id,
        target: node.id,
        sourceHandle: null,
        targetHandle: null,
      });

      expect(useVTAStore.getState().edges.length).toBe(initialEdgeCount);
      expect(useVTAStore.getState().past.length).toBe(initialHistoryLength);
    });

    it('should ignore duplicate edge connections', () => {
      const store = useVTAStore.getState();
      const existingEdge = store.edges[0];
      const initialEdgeCount = store.edges.length;

      store.onConnect({
        source: existingEdge.source,
        target: existingEdge.target,
        sourceHandle: null,
        targetHandle: null,
      });

      expect(useVTAStore.getState().edges.length).toBe(initialEdgeCount);
    });

    it('normalizes dual-use 4-handle connections across lanes and within a lane', () => {
      const store = useVTAStore.getState();
      store.setVTAData({
        lanes: ['左レーン', '右レーン'],
        nodes: [
          { id: 'n_left_1', lane: '左レーン', time: '09:00', title: '事象1', description: '', type: 'normal', measure_type: null },
          { id: 'n_left_2', lane: '左レーン', time: '09:05', title: '事象2', description: '', type: 'normal', measure_type: null },
          { id: 'n_right_1', lane: '右レーン', time: '09:00', title: '事象3', description: '', type: 'normal', measure_type: null },
        ],
        edges: [],
      });

      // Even if user starts drag from 'bottom'/'top' across lanes, onConnect normalizes to side handles ('right' -> 'left')
      useVTAStore.getState().onConnect({
        source: 'n_left_1',
        target: 'n_right_1',
        sourceHandle: 'bottom',
        targetHandle: 'top',
      });
      // And intra-lane from any handle normalizes to 'top' -> 'bottom'
      useVTAStore.getState().onConnect({
        source: 'n_left_1',
        target: 'n_left_2',
        sourceHandle: 'left',
        targetHandle: 'right',
      });

      const edges = useVTAStore.getState().edges;
      const cross = edges.find((e) => e.source === 'n_left_1' && e.target === 'n_right_1');
      const intra = edges.find((e) => e.source === 'n_left_1' && e.target === 'n_left_2');
      expect(cross?.sourceHandle).toBe('right');
      expect(cross?.targetHandle).toBe('left');
      expect(intra?.sourceHandle).toBe('top');
      expect(intra?.targetHandle).toBe('bottom');
    });
  });

  describe('Node Edit Supplementary Note Preservation (DATA-001)', () => {
    it('should preserve supplementary_note and position when opening editor and updating node', () => {
      const store = useVTAStore.getState();
      const targetNode = store.vtaData.nodes[0];

      // Set supplementary note and custom position
      store.updateNodeSupplementaryNote(targetNode.id, '詳細な背景メモ（DATA-001検証）');
      store.updateNodePosition(targetNode.id, { x: 500, y: 800 });

      // Open node editor with partial node data (as VTANode might pass)
      store.openNodeEditor({
        id: targetNode.id,
        lane: targetNode.lane,
        time: targetNode.time,
        type: targetNode.type,
        title: '編集後タイトル',
        description: '編集後説明',
        measure_type: targetNode.measure_type,
      });

      const editingNode = useVTAStore.getState().editingNodeData;
      expect(editingNode).toBeDefined();
      expect(editingNode?.supplementary_note).toBe('詳細な背景メモ（DATA-001検証）');
      expect(editingNode?.position).toEqual({ x: 500, y: 800 });

      // Save edited node
      store.updateNode(targetNode.id, {
        lane: targetNode.lane,
        time: targetNode.time,
        type: targetNode.type,
        title: '編集後タイトル保存',
        description: '編集後説明保存',
        measure_type: targetNode.measure_type,
      });

      const updatedNode = useVTAStore.getState().vtaData.nodes.find((n) => n.id === targetNode.id);
      expect(updatedNode?.supplementary_note).toBe('詳細な背景メモ（DATA-001検証）');
      expect(updatedNode?.title).toBe('編集後タイトル保存');
    });
  });

  describe('Backup Snapshot Evacuation & Restoration (DATA-003)', () => {
    it('should automatically evacuate previous snapshot before setVTAData and allow restoration', () => {
      const store = useVTAStore.getState();
      const initialNodeCount = store.vtaData.nodes.length;
      expect(store.previousBackupSnapshot).toBeNull();

      // Set new VTA data
      store.setVTAData({
        lanes: ['新規レーン'],
        nodes: [{ id: 'new_1', lane: '新規レーン', title: '新規ノード', time: '09:00', type: 'normal', description: '', measure_type: null }],
        edges: [],
      });

      // Snapshot should be evacuated
      const stateAfterSet = useVTAStore.getState();
      expect(stateAfterSet.vtaData.nodes.length).toBe(1);
      expect(stateAfterSet.previousBackupSnapshot).not.toBeNull();
      expect(stateAfterSet.previousBackupSnapshot?.vtaData.nodes.length).toBe(initialNodeCount);

      // Restore previous snapshot
      stateAfterSet.restorePreviousBackupSnapshot();

      const stateAfterRestore = useVTAStore.getState();
      expect(stateAfterRestore.vtaData.nodes.length).toBe(initialNodeCount);
      expect(stateAfterRestore.previousBackupSnapshot).toBeNull();
    });
  });

  describe('Report Consistency & Outdated Status (DATA-004)', () => {
    it('should mark report outdated when tree mutations occur and clear it on setVTAData', () => {
      const store = useVTAStore.getState();

      // Set initial regeneration result
      store.setRegenerationResult({
        idealFlow: '改善された業務フロー',
        analysisReport: '分析レポート',
        generatedAt: '2026-10-10T12:00:00Z',
      });

      expect(useVTAStore.getState().regenerationResult).not.toBeNull();
      expect(useVTAStore.getState().isReportOutdated).toBe(false);

      // Mutate tree: toggle node elimination
      const firstNodeId = useVTAStore.getState().vtaData.nodes[0].id;
      useVTAStore.getState().toggleNodeElimination(firstNodeId);

      // Now report should be flagged as outdated
      expect(useVTAStore.getState().isReportOutdated).toBe(true);

      // New scenario extraction: setVTAData
      useVTAStore.getState().setVTAData({
        lanes: ['新レーン'],
        nodes: [{ id: 'new_n1', lane: '新レーン', title: '新ノード', time: '10:00', type: 'normal', description: '', measure_type: null }],
        edges: [],
      });

      // Old report must be cleared, outdated flag reset
      expect(useVTAStore.getState().regenerationResult).toBeNull();
      expect(useVTAStore.getState().isReportOutdated).toBe(false);
    });

    it('should mark report outdated when scenario text is updated', () => {
      const store = useVTAStore.getState();
      store.setRegenerationResult({
        idealFlow: 'フロー',
        analysisReport: 'レポート',
        generatedAt: '2026-10-10T12:00:00Z',
      });

      expect(useVTAStore.getState().isReportOutdated).toBe(false);

      store.setScenarioText('更新されたシナリオテキスト');
      expect(useVTAStore.getState().isReportOutdated).toBe(true);
    });
  });

  describe('LocalStorage Draft Backup & Recovery (FUNC-001)', () => {
    it('should save, verify, and restore draft backup', () => {
      const store = useVTAStore.getState();
      store.clearDraftBackup();
      expect(useVTAStore.getState().hasDraftBackup).toBe(false);

      // Mutate state and save draft
      useVTAStore.getState().setScenarioText('ドラフト保存シナリオ');
      useVTAStore.getState().saveDraftBackup();

      expect(useVTAStore.getState().hasDraftBackup).toBe(true);
      expect(useVTAStore.getState().checkDraftBackup()).toBe(true);

      // Reset in-memory state (simulating fresh reload without clearing localStorage draft)
      resetInMemoryStateWithoutClearingStorage();
      expect(useVTAStore.getState().scenarioText).not.toBe('ドラフト保存シナリオ');

      // Restore draft backup
      const restored = useVTAStore.getState().restoreDraftBackup();
      expect(restored).toBe(true);
      expect(useVTAStore.getState().scenarioText).toBe('ドラフト保存シナリオ');

      // Clear draft
      useVTAStore.getState().clearDraftBackup();
      expect(useVTAStore.getState().hasDraftBackup).toBe(false);
    });
  });

  describe('UI Toast Notifications (UI-002)', () => {
    it('should add and dismiss toast messages', () => {
      const store = useVTAStore.getState();
      expect(store.toasts.length).toBe(0);

      store.showToast('success', 'テスト成功トースト', 10000);
      const toastsAfterAdd = useVTAStore.getState().toasts;
      expect(toastsAfterAdd.length).toBe(1);
      expect(toastsAfterAdd[0].message).toBe('テスト成功トースト');
      expect(toastsAfterAdd[0].type).toBe('success');

      store.dismissToast(toastsAfterAdd[0].id);
      expect(useVTAStore.getState().toasts.length).toBe(0);
    });
  });

  describe('Immediate Draft Backup on First Mutation (DATA-002)', () => {
    it('should immediately capture first operation in draft without 1-step lag', () => {
      // Reset draft and clean store state
      useVTAStore.getState().clearDraftBackup();
      seedVTAStoreWithFixture(0);
      expect(useVTAStore.getState().isDirty).toBe(false);

      const targetNodeId = useVTAStore.getState().vtaData.nodes[0].id;
      const initialMeasure = useVTAStore.getState().vtaData.nodes[0].measure_type;

      // First mutation on a clean project
      useVTAStore.getState().toggleNodeElimination(targetNodeId);

      // Verify draft backup was written immediately with the latest mutation
      expect(useVTAStore.getState().hasDraftBackup).toBe(true);

      const storageRaw = (globalThis as any).localStorage?.getItem('vta_draft_autosave') ||
        (useVTAStore.getState().checkDraftBackup() ? 'exists' : null);
      expect(storageRaw).toBeTruthy();

      // Reset in-memory state (simulating fresh reload) and restore from draft
      resetInMemoryStateWithoutClearingStorage();
      const restored = useVTAStore.getState().restoreDraftBackup();
      expect(restored).toBe(true);

      // The restored state MUST reflect the first mutation (no 1-step lag)
      const restoredNode = useVTAStore.getState().vtaData.nodes.find((n) => n.id === targetNodeId);
      expect(restoredNode?.measure_type).not.toBe(initialMeasure);
      expect(restoredNode?.measure_type).toBe('elimination');
    });
  });

  describe('Deterministic Report Outdated Status & Version Hash (DATA-003)', () => {
    it('should accurately revert isReportOutdated to false when undoing back to report generation state', () => {
      seedVTAStoreWithFixture(0);

      // Generate report at current state
      useVTAStore.getState().setRegenerationResult({
        idealFlow: '改善フロー',
        analysisReport: '分析レポート',
        generatedAt: '12:00:00',
      });
      expect(useVTAStore.getState().isReportOutdated).toBe(false);

      const targetNodeId = useVTAStore.getState().vtaData.nodes[0].id;

      // Mutate tree: should become outdated
      useVTAStore.getState().toggleNodeElimination(targetNodeId);
      expect(useVTAStore.getState().isReportOutdated).toBe(true);

      // Undo mutation: should accurately detect exact match with sourceHash and clear outdated flag!
      useVTAStore.getState().undo();
      expect(useVTAStore.getState().isReportOutdated).toBe(false);

      // Redo mutation: should become outdated again
      useVTAStore.getState().redo();
      expect(useVTAStore.getState().isReportOutdated).toBe(true);
    });

    it('should NOT mark report outdated when only moving node positions on canvas', () => {
      seedVTAStoreWithFixture(0);
      useVTAStore.getState().setRegenerationResult({
        idealFlow: '改善フロー',
        analysisReport: '分析レポート',
        generatedAt: '12:00:00',
      });
      expect(useVTAStore.getState().isReportOutdated).toBe(false);

      const targetNodeId = useVTAStore.getState().vtaData.nodes[0].id;
      useVTAStore.getState().updateNodePosition(targetNodeId, { x: 8888, y: 9999 });

      // Visual position does not affect analysis semantics
      expect(useVTAStore.getState().isReportOutdated).toBe(false);
    });
  });

  describe('Project Switching & Request Isolation (REL-001)', () => {
    it('should allocate new currentProjectId and abort in-flight operations on project switch', () => {
      const initialProjId = useVTAStore.getState().currentProjectId;
      expect(initialProjId).toBeTruthy();

      const controller = useVTAStore.getState().createAbortController();
      expect(useVTAStore.getState().activeAbortController).toBe(controller);
      expect(controller.signal.aborted).toBe(false);

      // Switch project via loadSample
      seedVTAStoreWithFixture(0);

      const newProjId = useVTAStore.getState().currentProjectId;
      expect(newProjId).not.toBe(initialProjId);
      expect(controller.signal.aborted).toBe(true);
    });

    it('should preserve explicit empty scenarioText on project import', () => {
      useVTAStore.getState().setScenarioText('既存の非空シナリオ');

      const projectWithEmptyScenario = JSON.stringify({
        version: '5.0',
        scenarioText: '', // Explicit empty string
        vtaData: {
          lanes: ['品証'],
          nodes: [{ id: 'n1', lane: '品証', title: 'テスト' }],
          edges: [],
          analysis: createManualAnalysis({ lanes: ['品証'], nodes: [{ id: 'n1', lane: '品証', title: 'テスト', time: '', description: '', type: 'normal', measure_type: null }], edges: [] }),
        },
      });

      const res = useVTAStore.getState().importProjectJSON(projectWithEmptyScenario);
      expect(res.success).toBe(true);
      expect(useVTAStore.getState().scenarioText).toBe('');
    });
  });

  describe('Edge Management & Custom Metadata (updateEdge, EdgeEditorModal)', () => {
    it('should update edge label, category, direction, and is_break with undo/redo support', () => {
      const store = useVTAStore.getState();
      expect(store.edges.length).toBeGreaterThan(0);

      const targetReactEdge = store.edges[0];
      const edgeId = targetReactEdge.id;

      // Open editor
      store.openEdgeEditor(edgeId);
      expect(useVTAStore.getState().editingEdgeId).toBe(edgeId);

      // Update edge metadata
      store.updateEdge(edgeId, {
        label: '新規交信ラベル',
        category: 'information',
        direction: 'bidirectional',
        is_break: true,
      });

      const updatedEdge = useVTAStore.getState().vtaData.edges.find(
        (e) => e.source === targetReactEdge.source && e.target === targetReactEdge.target
      );
      expect(updatedEdge).toBeDefined();
      expect(updatedEdge?.label).toBe('新規交信ラベル');
      expect(updatedEdge?.category).toBe('information');
      expect(updatedEdge?.direction).toBe('bidirectional');
      expect(updatedEdge?.is_break).toBe(true);

      // Verify undo restores previous state
      expect(useVTAStore.getState().canUndo()).toBe(true);
      useVTAStore.getState().undo();

      const revertedEdge = useVTAStore.getState().vtaData.edges.find(
        (e) => e.source === targetReactEdge.source && e.target === targetReactEdge.target
      );
      expect(revertedEdge?.label).toBe(targetReactEdge.data?.label);
      expect(revertedEdge?.category).toBe(targetReactEdge.data?.category);
      expect(revertedEdge?.direction).toBe(targetReactEdge.data?.direction);
      expect(revertedEdge?.is_break).toBe(targetReactEdge.data?.is_break);

      // Close editor
      store.closeEdgeEditor();
      expect(useVTAStore.getState().editingEdgeId).toBeNull();
    });

    it('should delete edge when deleteEdge is called', () => {
      const store = useVTAStore.getState();
      const initialCount = store.vtaData.edges.length;
      expect(initialCount).toBeGreaterThan(0);

      const targetReactEdge = store.edges[0];

      store.deleteEdge(targetReactEdge.id);

      expect(useVTAStore.getState().vtaData.edges.length).toBe(initialCount - 1);
      const exists = useVTAStore.getState().vtaData.edges.some(
        (e) => e.source === targetReactEdge.source && e.target === targetReactEdge.target
      );
      expect(exists).toBe(false);

      // Undo restores the deleted edge
      useVTAStore.getState().undo();
      expect(useVTAStore.getState().vtaData.edges.length).toBe(initialCount);
    });

    it('marks report as outdated if scenario or graph is edited during generation (Issue 5)', async () => {
      const store = useVTAStore.getState();
      const { computeVTADataHash } = await import('../utils/hash');
      const startHash = computeVTADataHash(store.vtaData, store.scenarioText);

      // Simulate user editing scenario while generation is in flight
      store.setScenarioText(store.scenarioText + '\n追加編集行');

      // Generation completes with original startHash
      const mockResult: import('../../../types/vta').RegenerationResult = {
        idealFlow: '業務フローテキスト',
        analysisReport: 'レポート本文',
        generatedAt: new Date().toISOString(),
        sourceHash: startHash,
      };

      store.setRegenerationResult(mockResult, startHash);

      const stateAfter = useVTAStore.getState();
      expect(stateAfter.regenerationResult?.sourceHash).toBe(startHash);
      // Because current data differs from startHash, report MUST be outdated!
      expect(stateAfter.isReportOutdated).toBe(true);

      // If we set result with matching hash, it should NOT be outdated
      const currentHash = computeVTADataHash(stateAfter.vtaData, stateAfter.scenarioText);
      store.setRegenerationResult(mockResult, currentHash);
      expect(useVTAStore.getState().isReportOutdated).toBe(false);
    });
  });

  describe('Drag Completion Backup, Multi-Node Move, Collision Adjustment & Undo/Redo (R2-6)', () => {
    it('saves final coordinates to draft backup after normal single-node drag without saving on every pointer move', () => {
      const store = useVTAStore.getState();
      store.clearDraftBackup();
      store.setVTAData({
        lanes: ['製造'],
        nodes: [
          {
            id: 'n1',
            lane: '製造',
            time: '10:00',
            type: 'normal',
            title: '作業A',
            description: '説明A',
            measure_type: null,
            position: { x: 200, y: 200 },
          },
        ],
        edges: [],
      });
      useVTAStore.setState({ past: [], future: [], isDirty: false });

      // Generate AI report before drag to verify coordinate-only drag does not mark it outdated
      useVTAStore.getState().setRegenerationResult({
        idealFlow: '理想フロー',
        analysisReport: '分析レポート',
        generatedAt: '2026-10-18T10:00:00Z',
      });
      expect(useVTAStore.getState().isReportOutdated).toBe(false);

      // Simulate pointer move steps (dragging = true)
      useVTAStore.getState().onNodesChange([
        { id: 'n1', type: 'position', position: { x: 205, y: 200 }, dragging: true } as any,
      ]);
      useVTAStore.getState().onNodesChange([
        { id: 'n1', type: 'position', position: { x: 210, y: 200 }, dragging: true } as any,
      ]);

      // During dragging=true, history should not be flooded and vtaData schema not yet committed
      expect(useVTAStore.getState().past.length).toBe(0);

      // Drag end (dragging = false)
      useVTAStore.getState().onNodesChange([
        { id: 'n1', type: 'position', position: { x: 210, y: 200 }, dragging: false } as any,
      ]);

      const afterDrag = useVTAStore.getState();
      expect(afterDrag.vtaData.nodes[0].position).toEqual({ x: 210, y: 200 });
      expect(afterDrag.past.length).toBe(1);
      expect(afterDrag.isReportOutdated).toBe(false);

      // Reset in-memory store (simulating fresh reload) and restore from draft backup -> final coordinates {x: 210, y: 200} must be restored
      resetInMemoryStateWithoutClearingStorage();
      const restored = useVTAStore.getState().restoreDraftBackup();
      expect(restored).toBe(true);
      expect(useVTAStore.getState().vtaData.nodes[0].position).toEqual({ x: 210, y: 200 });
      expect(useVTAStore.getState().nodes[0].position).toEqual({ x: 210, y: 200 });
    });

    it('also persists backup and avoids duplicate history when recordHistorySnapshot + updateNodePosition is called before dragging=false', () => {
      useVTAStore.getState().clearDraftBackup();
      useVTAStore.getState().setVTAData({
        lanes: ['製造'],
        nodes: [
          {
            id: 'n1',
            lane: '製造',
            time: '10:00',
            type: 'normal',
            title: '作業A',
            description: '説明A',
            measure_type: null,
            position: { x: 200, y: 200 },
          },
        ],
        edges: [],
      });
      useVTAStore.setState({ past: [], future: [] });

      useVTAStore.getState().onNodesChange([
        { id: 'n1', type: 'position', position: { x: 210, y: 200 }, dragging: true } as any,
      ]);
      useVTAStore.getState().recordHistorySnapshot();
      useVTAStore.getState().updateNodePosition('n1', { x: 210, y: 200 });
      useVTAStore.getState().onNodesChange([
        { id: 'n1', type: 'position', position: { x: 210, y: 200 }, dragging: false } as any,
      ]);

      expect(useVTAStore.getState().past.length).toBe(1);

      // Undo once restores {x: 200, y: 200}
      useVTAStore.getState().undo();
      expect(useVTAStore.getState().vtaData.nodes[0].position).toEqual({ x: 200, y: 200 });

      // Redo once restores {x: 210, y: 200}
      useVTAStore.getState().redo();
      expect(useVTAStore.getState().vtaData.nodes[0].position).toEqual({ x: 210, y: 200 });

      // Backup restoration restores {x: 210, y: 200}
      resetInMemoryStateWithoutClearingStorage();
      expect(useVTAStore.getState().restoreDraftBackup()).toBe(true);
      expect(useVTAStore.getState().vtaData.nodes[0].position).toEqual({ x: 210, y: 200 });
    });

    it('saves final positions of all nodes on multi-selection drag and collision adjustment, with 1-step Undo/Redo', () => {
      useVTAStore.getState().clearDraftBackup();
      useVTAStore.getState().setVTAData({
        lanes: ['製造', '品証'],
        nodes: [
          {
            id: 'n1',
            lane: '製造',
            time: '10:00',
            type: 'normal',
            title: '作業1',
            description: '説明1',
            measure_type: null,
            position: { x: 110, y: 500 },
          },
          {
            id: 'n2',
            lane: '製造',
            time: '11:00',
            type: 'normal',
            title: '作業2',
            description: '説明2',
            measure_type: null,
            position: { x: 110, y: 100 },
          },
          {
            id: 'n3',
            lane: '品証',
            time: '10:30',
            type: 'normal',
            title: '検査3',
            description: '説明3',
            measure_type: null,
            position: { x: 490, y: 300 },
          },
        ],
        edges: [],
      });
      useVTAStore.setState({ past: [], future: [] });

      const initialPositions = useVTAStore.getState().nodes.map((n) => ({
        id: n.id,
        position: { ...n.position },
      }));

      // Drag n1 and n3 together, moving n1 close to n2 in the same lane ('製造') to trigger collision push on n2
      useVTAStore.getState().onNodesChange([
        { id: 'n1', type: 'position', position: { x: 120, y: 150 }, dragging: true } as any,
        { id: 'n3', type: 'position', position: { x: 520, y: 340 }, dragging: true } as any,
      ]);
      useVTAStore.getState().onNodesChange([
        { id: 'n1', type: 'position', position: { x: 120, y: 150 }, dragging: false } as any,
        { id: 'n3', type: 'position', position: { x: 520, y: 340 }, dragging: false } as any,
      ]);

      const afterMove = useVTAStore.getState();
      // Only 1 history entry recorded for the multi-node drag
      expect(afterMove.past.length).toBe(1);

      const finalN1 = afterMove.nodes.find((n) => n.id === 'n1')!.position;
      const finalN2 = afterMove.nodes.find((n) => n.id === 'n2')!.position;
      const finalN3 = afterMove.nodes.find((n) => n.id === 'n3')!.position;

      expect(finalN1.x).toBe(120);
      // n1 (dragged to y=150 below n2 at y=100) was pushed downward (> 150) by collision resolution
      expect(finalN1.y).toBeGreaterThan(150);
      expect(finalN2).toEqual({ x: 110, y: 100 });
      expect(finalN3).toEqual({ x: 520, y: 340 });

      // Restore from backup and verify all 3 nodes match their post-collision final positions
      resetInMemoryStateWithoutClearingStorage();
      expect(useVTAStore.getState().restoreDraftBackup()).toBe(true);
      const restoredState = useVTAStore.getState();
      expect(restoredState.vtaData.nodes.find((n) => n.id === 'n1')?.position).toEqual(finalN1);
      expect(restoredState.vtaData.nodes.find((n) => n.id === 'n2')?.position).toEqual(finalN2);
      expect(restoredState.vtaData.nodes.find((n) => n.id === 'n3')?.position).toEqual(finalN3);

      // Verify 1 Undo / 1 Redo on the dragged state
      useVTAStore.setState({ past: afterMove.past, future: afterMove.future });
      useVTAStore.getState().undo();
      for (const init of initialPositions) {
        expect(useVTAStore.getState().vtaData.nodes.find((n) => n.id === init.id)?.position).toEqual(
          init.position
        );
      }

      useVTAStore.getState().redo();
      expect(useVTAStore.getState().vtaData.nodes.find((n) => n.id === 'n1')?.position).toEqual(finalN1);
      expect(useVTAStore.getState().vtaData.nodes.find((n) => n.id === 'n2')?.position).toEqual(finalN2);
      expect(useVTAStore.getState().vtaData.nodes.find((n) => n.id === 'n3')?.position).toEqual(finalN3);
    });
  });

  describe('Phase P8 - autoConnectNodes and reoptimizeVTA on-demand actions', () => {
    it('autoConnectNodes aborts cleanly if diagram has no nodes', async () => {
      useVTAStore.getState().setVTAData({ lanes: [], nodes: [], edges: [] });
      const result = await useVTAStore.getState().autoConnectNodes();
      expect(result).toBe(false);
      expect(useVTAStore.getState().toasts.some((t) => t.message.includes('接続するノードが存在しません'))).toBe(true);
    });

    it('reoptimizeVTA aborts cleanly if diagram has no nodes', async () => {
      useVTAStore.getState().setVTAData({ lanes: [], nodes: [], edges: [] });
      const result = await useVTAStore.getState().reoptimizeVTA();
      expect(result).toBe(false);
      expect(useVTAStore.getState().toasts.some((t) => t.message.includes('最適化するノードが存在しません'))).toBe(true);
    });
  });

  describe('Lane Granularity Proposals (applyLaneMergeProposal & applyLaneSplitProposal)', () => {
    it('applies lane merge proposal and pins the new target entity', () => {
      useVTAStore.getState().setVTAData({
        lanes: ['機長Ａ', '副操縦員Ａ'],
        nodes: [
          { id: 'c1', lane: '機長Ａ', title: '滑走路進入指示受領', time: '17:45:00', type: 'normal', description: '', measure_type: null, position: { x: 0, y: 0 } },
          { id: 'c2', lane: '副操縦員Ａ', title: '進入復唱', time: '17:45:30', type: 'normal', description: '', measure_type: null, position: { x: 300, y: 100 } },
        ],
        edges: [],
      });

      const proposal: import('../../../types/vta').LaneMergeProposal = {
        id: 'merge_crew_A',
        type: 'merge',
        sourceEntityIds: ['manual_entity_1', 'manual_entity_2'],
        sourceEntityNames: ['機長Ａ', '副操縦員Ａ'],
        suggestedTargetName: 'Ａ機',
        suggestedKind: 'machine',
        totalEventsCount: 2,
        reducedLanesCount: 1,
        reason: 'A機クルー統合',
        category: 'vehicle_crew',
      };

      useVTAStore.getState().applyLaneMergeProposal(proposal, 'Ａ機');

      const state = useVTAStore.getState();
      expect(state.vtaData.lanes).toContain('Ａ機');
      expect(state.vtaData.nodes.every((n) => n.lane === 'Ａ機')).toBe(true);
      expect(state.refinementSettings.scope?.pinnedEntityIds?.length).toBeGreaterThan(0);
      expect(state.toasts.some((t) => t.message.includes('「Ａ機」への統合を適用しました'))).toBe(true);

      // 分割案の適用テスト
      const splitProposal: import('../../../types/vta').LaneSplitProposal = {
        id: 'split_crew_A',
        type: 'split',
        parentEntityId: 'manual_entity_1',
        parentEntityName: 'Ａ機',
        splitEntityIds: ['manual_entity_1', 'manual_entity_2'],
        splitEntityNames: ['機長Ａ', '副操縦員Ａ'],
        internalRelationsCount: 1,
        reason: 'CRM分析用分割',
        category: 'crm_interaction',
      };

      useVTAStore.getState().applyLaneSplitProposal(splitProposal);
      const splitState = useVTAStore.getState();
      expect(splitState.vtaData.lanes).toContain('機長Ａ');
      expect(splitState.vtaData.lanes).toContain('副操縦員Ａ');
      expect(splitState.toasts.some((t) => t.message.includes('独立レーンとして展開しました'))).toBe(true);
    });
  });

  describe('Dot-Displayed Node Dimensions Guard, Auto-Realign & Drag Unprojection', () => {
    async function setupObjectDotSchema(): Promise<{
      schema: import('../../../types/vta').VTASchema;
      subId: string;
      objDotId: string;
    }> {
      const ea = await import('../utils/eventAnalysis');
      const source = ea.sourceFromText('09:00 主体Aが客体へ指示を送った。\n09:10 客体が次作業を実施した。');
      const facts = ea.validateFacts(
        {
          facts: [
            { id: 'f1', text: '主体Aが客体へ指示を送った', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p1', quote: '09:00 主体Aが客体へ指示を送った。' }] },
            { id: 'f2', text: '客体が次作業を実施した', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p2', quote: '09:10 客体が次作業を実施した。' }] },
          ],
        },
        [source]
      );
      const events = ea.validateEvents(
        {
          events: [
            { id: 'e1', title: '指示伝達', description: '客体への指示伝達内容（高さ計測テスト用）', time: '09:00', factIds: ['f1'] },
            { id: 'e2', title: '次作業', description: '後続作業', time: '09:10', factIds: ['f2'] },
          ],
        },
        facts
      );
      const parsed = ea.validateParticipants(
        {
          entities: [
            { id: 'ent_sub', name: '主体レーン', kind: 'person' },
            { id: 'ent_obj', name: '客体レーン', kind: 'person' },
          ],
          participations: [
            { eventId: 'e1', entityId: 'ent_sub', role: 'actor', factIds: ['f1'] },
            { eventId: 'e1', entityId: 'ent_obj', role: 'target', factIds: ['f1'] },
            { eventId: 'e2', entityId: 'ent_obj', role: 'actor', factIds: ['f2'] },
          ],
          relations: [
            { id: 'r1', kind: 'transfer', sourceEventId: 'e1', sourceEntityId: 'ent_sub', targetEventId: 'e1', targetEntityId: 'ent_obj', factIds: ['f1'] },
          ],
          cardGroups: [],
        },
        events,
        facts
      );
      const schema = ea.projectAnalysis(ea.buildAnalysis(source, facts, events, parsed));
      const subNode = schema.nodes.find((n) => n.lane === '主体レーン' && n.event_ids?.includes('e1'))!;
      const dotNode = schema.nodes.find((n) => n.lane === '客体レーン' && n.event_ids?.includes('e1'))!;
      return { schema, subId: subNode.id, objDotId: dotNode.id };
    }

    it('ignores 24x24 DOM dimensions for object dots and realigns same-rank dots when sibling card DOM height grows without marking dirty', async () => {
      const { schema, subId, objDotId } = await setupObjectDotSchema();
      useVTAStore.getState().setVTAData(schema);
      useVTAStore.setState({ isDirty: false });

      const initialDotNode = useVTAStore.getState().nodes.find((n) => n.id === objDotId)!;
      const initialDotStoredHeight = initialDotNode.measured?.height ?? 0;
      expect(initialDotStoredHeight).toBeGreaterThanOrEqual(140);

      // Simulate React Flow firing 24x24 DOM dimensions on VTAObjectJunctionNode + actual 220px height on sibling card
      useVTAStore.getState().onNodesChange([
        { id: objDotId, type: 'dimensions', dimensions: { width: 24, height: 24 } },
        { id: subId, type: 'dimensions', dimensions: { width: 260, height: 220 } },
      ]);

      const after = useVTAStore.getState();
      expect(after.isDirty).toBe(false);

      const dotAfter = after.nodes.find((n) => n.id === objDotId)!;
      const subAfter = after.nodes.find((n) => n.id === subId)!;
      expect(dotAfter.measured?.height).toBe(initialDotStoredHeight);
      expect(subAfter.measured?.height).toBe(220);

      const subRect = getDisplayRect(subAfter);
      const dotRect = getDisplayRect(dotAfter);
      expect(dotRect.isObjectJunction).toBe(true);
      expect(subRect.y + subRect.height / 2).toBeCloseTo(dotRect.y + dotRect.height / 2, 5);
    });

    it('unprojects dragged object dot positions in both detail and compact views', async () => {
      const { schema, objDotId } = await setupObjectDotSchema();
      useVTAStore.getState().setVTAData(schema);

      const rawDot = useVTAStore.getState().nodes.find((n) => n.id === objDotId)!;
      const projected = projectDisplayNode(rawDot);
      expect(projected.type).toBe('vtaObjectJunction');

      const draggedPos = { x: projected.position.x + 25, y: projected.position.y + 40 };
      useVTAStore.getState().onNodesChange(
        [{ id: objDotId, type: 'position', position: draggedPos, dragging: false }],
        'detail'
      );

      const afterDetail = useVTAStore.getState().nodes.find((n) => n.id === objDotId)!;
      const detailRect = getDisplayRect(afterDetail);
      expect(detailRect.x).toBeCloseTo(draggedPos.x, 5);
      expect(detailRect.y).toBeCloseTo(draggedPos.y, 5);

      const compactBefore = calculateVTALayout(useVTAStore.getState().vtaData, undefined, undefined, {
        compact: true,
        positionField: 'compact_position',
      });
      const compactRaw = compactBefore.nodes.find((n) => n.id === objDotId)!;
      const compactProj = projectDisplayNode(compactRaw);
      const compactDragged = { x: compactProj.position.x + 15, y: compactProj.position.y + 30 };

      useVTAStore.getState().onNodesChange(
        [{ id: objDotId, type: 'position', position: compactDragged, dragging: false }],
        'compact'
      );

      const compactAfter = calculateVTALayout(useVTAStore.getState().vtaData, undefined, undefined, {
        compact: true,
        positionField: 'compact_position',
      });
      const compactRectAfter = getDisplayRect(compactAfter.nodes.find((n) => n.id === objDotId)!);
      expect(compactRectAfter.x).toBeCloseTo(compactDragged.x, 5);
      expect(compactRectAfter.y).toBeCloseTo(compactDragged.y, 5);
    });

    it('preserves visual center across save/reload when a measured card is converted to an object dot', () => {
      useVTAStore.getState().setVTAData({
        lanes: ['主体レーン'],
        nodes: [
          {
            id: 'card_to_dot',
            lane: '主体レーン',
            time: '09:00',
            title: '切替対象カード',
            description: '長い説明文で実測高さが推定と異なる場合',
            type: 'normal',
            entity_role: 'subject',
            measure_type: null,
            position: { x: 110, y: 120 },
          },
        ],
        edges: [],
      });

      // Measure card DOM height as 240px before toggling it to an object dot
      useVTAStore.getState().onNodesChange([
        { id: 'card_to_dot', type: 'dimensions', dimensions: { width: 260, height: 240 } },
      ]);
      const cardRect = getDisplayRect(useVTAStore.getState().nodes.find((n) => n.id === 'card_to_dot')!);
      const expectedCenterY = cardRect.y + cardRect.height / 2;

      useVTAStore.getState().updateNode('card_to_dot', {
        entity_role: 'object',
        object_display_style: 'dot',
      });

      const dotInStore = useVTAStore.getState().nodes.find((n) => n.id === 'card_to_dot')!;
      const dotRectNow = getDisplayRect(dotInStore);
      expect(dotRectNow.y + dotRectNow.height / 2).toBeCloseTo(expectedCenterY, 5);

      // Recompute from saved schema alone (simulating JSON save/reload without DOM measured cache)
      const reloadedLayout = calculateVTALayout(useVTAStore.getState().vtaData);
      const reloadedRect = getDisplayRect(reloadedLayout.nodes.find((n) => n.id === 'card_to_dot')!);
      expect(reloadedRect.y + reloadedRect.height / 2).toBeCloseTo(expectedCenterY, 5);
    });

    it('replaces generated project cleanly with replaceProject: true without reconciling old diagram state or wiping pipelineHistory', () => {
      const store = useVTAStore.getState();
      // Previous diagram has a colliding node ID and omitted edge settings
      store.setVTAData({
        lanes: ['旧レーン'],
        nodes: [
          {
            id: 'card_1',
            lane: '旧レーン',
            time: '08:00',
            type: 'outcome',
            title: '旧図のカード',
            description: '旧図説明',
            measure_type: null,
          },
        ],
        edges: [],
        presentation: {
          lanes: {},
          suppressedCards: {},
          omittedEdges: ['relation:R1'],
          omittedDependencies: ['old-dep'],
        },
      });

      const newGeneratedSchema: import('../../../types/vta').VTASchema = {
        lanes: ['新レーン'],
        nodes: [
          {
            id: 'card_1',
            event_ids: ['E1'],
            lane: '新レーン',
            time: '09:00',
            type: 'normal',
            title: '新図の正常作業',
            description: '新しいシナリオの作業',
            measure_type: null,
          },
        ],
        edges: [],
        pipelineHistory: [
          {
            id: 'stage1_normalize',
            stageIndex: 0,
            title: 'Stage 1',
            subtitle: '',
            description: '',
            timestamp: '2026-11-18T00:00:00.000Z',
            lanes: ['新レーン'],
            nodes: [],
            edges: [],
            stats: { eventCount: 1, nodeCount: 1, laneCount: 1, edgeCount: 0, variationCount: 0, outcomeCount: 0 },
          },
        ],
        analysis: {
          version: 5,
          sources: [{ id: 's1', text: '09:00 新しい作業', paragraphs: [{ id: 'p1', text: '09:00 新しい作業' }] }],
          facts: [],
          entities: [{ id: 'A1', name: '新レーン', kind: 'person' }],
          events: [
            {
              id: 'E1',
              origin: 'extraction',
              title: '新図の正常作業',
              description: '新しいシナリオの作業',
              time: '09:00',
              sourceOrder: 0,
              factIds: [],
              classification: 'unclassified',
              sourceRefs: [{ sourceId: 's1', paragraphId: 'p1' }],
            },
          ],
          participations: [{ eventId: 'E1', entityId: 'A1', role: 'actor', factIds: [] }],
          relations: [],
          cards: [{ id: 'card_1', laneEntityId: 'A1', eventIds: ['E1'] }],
          unassignedEventIds: [],
          outcome: {
            status: 'identified',
            eventIds: ['E1'],
            sourceRefs: [{ sourceId: 's1', paragraphId: 'p1' }],
            reason: 'テスト帰結',
          },
        },
      };

      const layout = calculateVTALayout(newGeneratedSchema);
      useVTAStore.getState().commitVTAChange({
        schema: newGeneratedSchema,
        nodes: layout.nodes,
        edges: layout.edges,
        laneBounds: layout.laneBounds,
        preserveDerivedRemovals: true,
        replaceProject: true,
      });

      const after = useVTAStore.getState();
      expect(after.vtaData.lanes).toEqual(['新レーン']);
      expect(after.vtaData.analysis?.events[0].origin).toBe('extraction');
      expect(after.vtaData.analysis?.outcome?.status).toBe('identified');
      expect(after.vtaData.presentation?.omittedEdges).toBeUndefined();
      expect(after.vtaData.pipelineHistory).toHaveLength(1);
      expect(after.previousBackupSnapshot?.vtaData.lanes).toEqual(['旧レーン']);
      expect(after.past).toEqual([]);
    });
  });
});




