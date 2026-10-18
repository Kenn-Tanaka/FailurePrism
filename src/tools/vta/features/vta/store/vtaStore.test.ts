import { describe, it, expect, beforeEach } from 'vitest';
import { useVTAStore } from './vtaStore';
import { SAMPLE_SCENARIOS } from '../data/sampleData';

describe('vtaStore.ts - High & Medium Fixes Verification', () => {
  const defaultSampleId = SAMPLE_SCENARIOS[0].id;

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

  beforeEach(() => {
    // Reset store state with a valid sample ID and clean history stacks
    useVTAStore.getState().loadSample(defaultSampleId);
    useVTAStore.setState({ past: [], future: [], toasts: [] });
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

      // Load sample to change state
      useVTAStore.getState().loadSample(defaultSampleId);
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
      useVTAStore.getState().loadSample(defaultSampleId);
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

      // Reset state and restore from draft
      useVTAStore.getState().loadSample(defaultSampleId);
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
      useVTAStore.getState().loadSample(defaultSampleId);

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
      useVTAStore.getState().loadSample(defaultSampleId);
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
      useVTAStore.getState().loadSample(defaultSampleId);

      const newProjId = useVTAStore.getState().currentProjectId;
      expect(newProjId).not.toBe(initialProjId);
      expect(controller.signal.aborted).toBe(true);
    });

    it('should preserve explicit empty scenarioText on project import', () => {
      useVTAStore.getState().setScenarioText('既存の非空シナリオ');

      const projectWithEmptyScenario = JSON.stringify({
        version: '1.0',
        scenarioText: '', // Explicit empty string
        vtaData: {
          lanes: ['品証'],
          nodes: [{ id: 'n1', lane: '品証', title: 'テスト' }],
          edges: [],
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
});



