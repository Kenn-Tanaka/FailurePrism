import { create } from 'zustand';
import {
  applyNodeChanges,
  applyEdgeChanges,
  type NodeChange,
  type EdgeChange,
  type Connection,
  addEdge,
} from '@xyflow/react';
import {
  VTASchema,
  VTAReactFlowNode,
  VTAReactFlowEdge,
  LLMConfig,
  RegenerationResult,
  PromptConfig,
} from '../../../types/vta';
import { calculateVTALayout, LayoutResult, enforceLaneVerticalSpacing } from '../utils/layout';
import { SAMPLE_SCENARIOS } from '../data/sampleData';
import { exportVTAToSVGFile } from '../utils/svgExport';
import { DEFAULT_PROMPT_CONFIG } from '../../../services/llm/prompts';
import {
  validateAndSanitizeVTASchema,
  validateAndSanitizeProjectFile,
} from '../utils/schemaValidator';
import { computeVTADataHash } from '../utils/hash';

// In-memory storage fallback for Node.js / test environments
const memoryStorageMap = new Map<string, string>();
const safeStorageFallback = {
  getItem: (key: string) => (memoryStorageMap.has(key) ? memoryStorageMap.get(key)! : null),
  setItem: (key: string, value: string) => { memoryStorageMap.set(key, String(value)); },
  removeItem: (key: string) => { memoryStorageMap.delete(key); },
  clear: () => { memoryStorageMap.clear(); },
};

function getSafeStorage() {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
    if (typeof globalThis !== 'undefined' && (globalThis as any).localStorage) return (globalThis as any).localStorage;
  } catch {}
  return safeStorageFallback;
}

export function generateProjectId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `proj_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export interface VTAState {
  compactView: boolean;
  toggleCompactView: () => void;
  // Backup snapshot for accidental overwrite recovery (DATA-003)
  previousBackupSnapshot: {
    scenarioText: string;
    vtaData: VTASchema;
    regenerationResult: RegenerationResult | null;
  } | null;
  restorePreviousBackupSnapshot: () => boolean;
  // LLM Config
  llmConfig: LLMConfig;
  setLLMConfig: (config: Partial<LLMConfig>) => void;
  promptConfig: PromptConfig;
  setPromptConfig: (config: PromptConfig) => void;
  loadPromptConfig: () => Promise<void>;

  // Scenario Input
  scenarioText: string;
  setScenarioText: (text: string) => void;
  selectedSampleId: string;
  loadSample: (sampleId: string) => void;
  isDirty: boolean;
  setIsDirty: (val: boolean) => void;

  // VTA Data & Graph
  vtaData: VTASchema;
  nodes: VTAReactFlowNode[];
  edges: VTAReactFlowEdge[];
  laneBounds: LayoutResult['laneBounds'];

  // Project Identity & Async Request Guard (REL-001)
  currentProjectId: string;
  activeRequestId: string | null;
  createNewProjectId: () => string;
  setActiveRequestId: (reqId: string | null) => void;

  // History & Undo / Redo
  past: VTASchema[];
  future: VTASchema[];
  pushHistory: () => void;
  recordHistorySnapshot: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  // Change Commit & Persistence Helper (DATA-002, DATA-003)
  commitVTAChange: (params: {
    schema: VTASchema;
    nodes?: VTAReactFlowNode[];
    edges?: VTAReactFlowEdge[];
    laneBounds?: LayoutResult['laneBounds'];
    extraState?: Partial<VTAState>;
    skipHistory?: boolean;
  }) => void;

  // React Flow Handlers
  onNodesChange: (changes: NodeChange<VTAReactFlowNode>[]) => void;
  onNodesDelete: (deletedNodes: VTAReactFlowNode[]) => void;
  onEdgesChange: (changes: EdgeChange<VTAReactFlowEdge>[]) => void;
  onConnect: (connection: Connection) => void;
  updateNodePosition: (nodeId: string, position: { x: number; y: number }) => void;

  // VTA Domain Mutations
  setVTAData: (schema: VTASchema) => void;
  toggleNodeElimination: (nodeId: string) => void;
  toggleEdgeBreak: (edgeId: string) => void;
  toggleEdgeDirection: (edgeId: string) => void;
  updateEdge: (
    edgeId: string,
    updates: {
      label?: string;
      category?: import('../../../types/vta').EdgeCategory;
      direction?: import('../../../types/vta').EdgeDirection;
      is_break?: boolean;
    }
  ) => void;
  editingEdgeId: string | null;
  openEdgeEditor: (edgeId: string) => void;
  closeEdgeEditor: () => void;
  recalculateLayout: () => void;
  addNode: (nodeData: Omit<import('../../../types/vta').VTANodeData, 'id'>, connectFromNodeId?: string) => void;
  updateNode: (nodeId: string, updates: Partial<import('../../../types/vta').VTANodeData>) => void;
  deleteNode: (nodeId: string) => void;
  deleteEdge: (edgeId: string) => void;

  // Supplementary Notes State & Mutations
  isNotesPanelOpen: boolean;
  setIsNotesPanelOpen: (open: boolean) => void;
  toggleNotesPanel: () => void;
  updateNodeSupplementaryNote: (nodeId: string, note: string) => void;
  updateSupplementarySummary: (summary: string) => void;
  addCustomNote: (title: string, content: string) => void;
  updateCustomNote: (id: string, updates: { title?: string; content?: string }) => void;
  deleteCustomNote: (id: string) => void;

  // Project File Import / Export (Save & Load)
  exportProjectJSON: (filename?: string) => void;
  importProjectJSON: (jsonString: string) => { success: boolean; message: string };
  exportVTASVG: (options?: import('../utils/svgExport').SVGExportOptions) => { success: boolean; filename: string };
  isSVGExportModalOpen: boolean;
  openSVGExportModal: () => void;
  closeSVGExportModal: () => void;

  // Node Editor Modal
  isNodeEditorOpen: boolean;
  editingNodeData: import('../../../types/vta').VTANodeData | null;
  openNodeEditor: (nodeData?: import('../../../types/vta').VTANodeData | null) => void;
  closeNodeEditor: () => void;

  // LLM Status & Output
  isExtracting: boolean;
  setIsExtracting: (val: boolean) => void;
  isRegenerating: boolean;
  setIsRegenerating: (val: boolean) => void;
  generationProgress: import('../../../types/vta').GenerationProgress;
  setGenerationProgress: (progress: Partial<import('../../../types/vta').GenerationProgress>) => void;
  resetGenerationProgress: () => void;
  regenerationResult: RegenerationResult | null;
  setRegenerationResult: (res: RegenerationResult | null, requestSourceHash?: string) => void;
  isReportOutdated: boolean;
  setIsReportOutdated: (val: boolean) => void;
  error: string | null;
  setError: (err: string | null) => void;
  // AI Countermeasure Proposals (Elimination & Break recommendations)
  isProposing: boolean;
  setIsProposing: (val: boolean) => void;
  isProposalModalOpen: boolean;
  setIsProposalModalOpen: (val: boolean) => void;
  measuresProposal: import('../../../types/vta').MeasuresProposalResult | null;
  setMeasuresProposal: (res: import('../../../types/vta').MeasuresProposalResult | null) => void;
  applyMeasuresProposal: (
    selectedEliminationNodeIds: string[],
    selectedBreakPairs: { source: string; target: string }[]
  ) => void;
  activeTab: 'scenario' | 'idealFlow' | 'analysisReport';
  setActiveTab: (tab: 'scenario' | 'idealFlow' | 'analysisReport') => void;

  // LocalStorage Auto-Draft Backup (FUNC-001)
  hasDraftBackup: boolean;
  draftBackupTimestamp: string | null;
  saveDraftBackup: () => void;
  checkDraftBackup: () => boolean;
  restoreDraftBackup: () => boolean;
  clearDraftBackup: () => void;

  // UI Toast Notifications (UI-002)
  toasts: import('../../../types/vta').ToastItem[];
  showToast: (type: 'success' | 'error' | 'info' | 'warn', message: string, durationMs?: number) => void;
  dismissToast: (id: string) => void;

  // Execution & Debug Logs
  logs: import('../../../types/vta').LogEntry[];
  addLog: (type: 'info' | 'success' | 'warn' | 'error', message: string, stageTag?: string) => void;
  clearLogs: () => void;

  // Abort / Cancellation Handler
  activeAbortController: AbortController | null;
  createAbortController: () => AbortController;
  cancelCurrentOperation: () => void;
}

const defaultSample = SAMPLE_SCENARIOS[0];
const initialLayout = calculateVTALayout(defaultSample.vtaData);

export const useVTAStore = create<VTAState>((set, get) => ({
  compactView: false,
  toggleCompactView: () => set((state) => ({ compactView: !state.compactView })),
  // Accidental overwrite recovery snapshot (DATA-003)
  previousBackupSnapshot: null,
  restorePreviousBackupSnapshot: () => {
    const backup = get().previousBackupSnapshot;
    if (!backup) return false;
    get().pushHistory();
    const layout = calculateVTALayout(backup.vtaData);
    set({
      scenarioText: backup.scenarioText,
      vtaData: backup.vtaData,
      nodes: layout.nodes,
      edges: layout.edges,
      laneBounds: layout.laneBounds,
      regenerationResult: backup.regenerationResult,
      isDirty: true,
      previousBackupSnapshot: null,
    });
    get().addLog('info', '[復元] 直前の置換前スナップショットから作業内容を復旧しました。', '復旧');
    return true;
  },

  // LLM Configuration
  llmConfig: {
    baseUrl: '/v1',
    gatewayToken: '',
    selectedModel: 'openrouter/anthropic/claude-3.7-sonnet',
    timeoutSeconds: 180,
  },
  setLLMConfig: (config) =>
    set((state) => ({
      llmConfig: { ...state.llmConfig, ...config },
    })),
  promptConfig: DEFAULT_PROMPT_CONFIG,
  setPromptConfig: (config) => set({ promptConfig: config }),
  loadPromptConfig: async () => {
    try {
      const res = await fetch('/prompts.json');
      if (!res.ok) {
        console.warn(`Failed to fetch /prompts.json: HTTP ${res.status}. Using default prompt configuration.`);
        return;
      }
      const loaded = await res.json();
      if (loaded && loaded.extraction && loaded.regeneration && loaded.proposal) {
        set({ promptConfig: loaded });
        get().addLog('info', '外部プロンプト定義 (prompts.json) を読み込みました。', '設定');
      }
    } catch (err) {
      console.warn('Error loading /prompts.json, using default prompt configuration.', err);
    }
  },

  // Project Identity & Async Request Guard (REL-001)
  currentProjectId: generateProjectId(),
  activeRequestId: null,
  createNewProjectId: () => {
    const newId = generateProjectId();
    set({ currentProjectId: newId });
    return newId;
  },
  setActiveRequestId: (reqId) => set({ activeRequestId: reqId }),

  // Scenario Input
  scenarioText: defaultSample.scenarioText,
  setScenarioText: (text) => {
    const { vtaData, regenerationResult } = get();
    const currentHash = computeVTADataHash(vtaData, text);
    const isOutdated = regenerationResult
      ? (regenerationResult.sourceHash ? regenerationResult.sourceHash !== currentHash : true)
      : false;
    set({
      scenarioText: text,
      isDirty: true,
      isReportOutdated: isOutdated,
    });
    get().saveDraftBackup();
  },
  selectedSampleId: defaultSample.id,
  isDirty: false,
  setIsDirty: (val) => set({ isDirty: val }),
  loadSample: (sampleId) => {
    const sample = SAMPLE_SCENARIOS.find((s) => s.id === sampleId);
    if (!sample) return;
    get().cancelCurrentOperation();
    const layout = calculateVTALayout(sample.vtaData);
    const newProjectId = get().createNewProjectId();
    set({
      currentProjectId: newProjectId,
      activeRequestId: null,
      selectedSampleId: sample.id,
      scenarioText: sample.scenarioText,
      vtaData: sample.vtaData,
      nodes: layout.nodes,
      edges: layout.edges,
      laneBounds: layout.laneBounds,
      regenerationResult: null,
      isReportOutdated: false,
      error: null,
      activeTab: 'scenario',
      isDirty: false,
      past: [],
      future: [],
    });
  },

  // VTA Data & Graph
  vtaData: defaultSample.vtaData,
  nodes: initialLayout.nodes,
  edges: initialLayout.edges,
  laneBounds: initialLayout.laneBounds,

  // History & Undo / Redo
  past: [],
  future: [],
  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,
  pushHistory: () => {
    const { vtaData, past } = get();
    const snapshot: VTASchema = JSON.parse(JSON.stringify(vtaData));
    const newPast = [...past, snapshot];
    if (newPast.length > 30) {
      newPast.shift();
    }
    set({
      past: newPast,
      future: [],
    });
  },
  recordHistorySnapshot: () => {
    get().pushHistory();
  },

  // Change Commit & Persistence Helper (DATA-002, DATA-003)
  commitVTAChange: ({ schema, nodes, edges, laneBounds, extraState, skipHistory }) => {
    const { vtaData, past, regenerationResult, scenarioText } = get();

    let newPast = past;
    let newFuture = get().future;
    if (!skipHistory) {
      // 1. 変更前のスナップショットを past に記録（最大30件）
      const snapshot: VTASchema = JSON.parse(JSON.stringify(vtaData));
      newPast = [...past, snapshot];
      if (newPast.length > 30) {
        newPast.shift();
      }
      newFuture = [];
    }

    // 2. レポート最新性判定（DATA-003: ハッシュ比較）
    const currentHash = computeVTADataHash(schema, scenarioText);
    const isOutdated = regenerationResult
      ? (regenerationResult.sourceHash ? regenerationResult.sourceHash !== currentHash : true)
      : false;

    // 3. 状態更新
    set({
      vtaData: schema,
      ...(nodes ? { nodes } : {}),
      ...(edges ? { edges } : {}),
      ...(laneBounds ? { laneBounds } : {}),
      past: newPast,
      future: newFuture,
      isDirty: true,
      isReportOutdated: isOutdated,
      ...(extraState || {}),
    });

    // 4. 最新データを即座に LocalStorage 下書きへ保存（DATA-002: 初回編集でも確実に保存）
    get().saveDraftBackup();
  },

  undo: () => {
    const { past, future, vtaData, addLog, regenerationResult, scenarioText } = get();
    if (past.length === 0) return;
    const prevSchema = past[past.length - 1];
    const newPast = past.slice(0, past.length - 1);
    const currentSnapshot: VTASchema = JSON.parse(JSON.stringify(vtaData));
    const newFuture = [currentSnapshot, ...future];
    if (newFuture.length > 30) {
      newFuture.pop();
    }
    const layout = calculateVTALayout(prevSchema);
    const currentHash = computeVTADataHash(prevSchema, scenarioText);
    const isOutdated = regenerationResult
      ? (regenerationResult.sourceHash ? regenerationResult.sourceHash !== currentHash : true)
      : false;

    set({
      vtaData: prevSchema,
      nodes: layout.nodes,
      edges: layout.edges,
      laneBounds: layout.laneBounds,
      past: newPast,
      future: newFuture,
      isDirty: true,
      isReportOutdated: isOutdated,
    });
    get().saveDraftBackup();
    addLog('info', '[元に戻す] 直前の操作を取り消しました。', '履歴');
  },
  redo: () => {
    const { past, future, vtaData, addLog, regenerationResult, scenarioText } = get();
    if (future.length === 0) return;
    const nextSchema = future[0];
    const newFuture = future.slice(1);
    const currentSnapshot: VTASchema = JSON.parse(JSON.stringify(vtaData));
    const newPast = [...past, currentSnapshot];
    if (newPast.length > 30) {
      newPast.shift();
    }
    const layout = calculateVTALayout(nextSchema);
    const currentHash = computeVTADataHash(nextSchema, scenarioText);
    const isOutdated = regenerationResult
      ? (regenerationResult.sourceHash ? regenerationResult.sourceHash !== currentHash : true)
      : false;

    set({
      vtaData: nextSchema,
      nodes: layout.nodes,
      edges: layout.edges,
      laneBounds: layout.laneBounds,
      past: newPast,
      future: newFuture,
      isDirty: true,
      isReportOutdated: isOutdated,
    });
    get().saveDraftBackup();
    addLog('info', '[やり直し] 操作をやり直しました。', '履歴');
  },

  // React Flow Handlers
  onNodesChange: (changes) => {
    const currentNodes = get().nodes;
    const updatedNodes = applyNodeChanges(changes, currentNodes);

    // Sync node removal with vtaData if removed via keyboard or programmatic event
    const removedChanges = changes.filter((c) => c.type === 'remove');
    if (removedChanges.length > 0) {
      const removedIds = new Set(removedChanges.map((c) => c.id));
      const { vtaData, edges } = get();
      const nodesToRemove = vtaData.nodes.filter((n) => removedIds.has(n.id));

      if (nodesToRemove.length > 0) {
        const updatedSchemaNodes = vtaData.nodes.filter((n) => !removedIds.has(n.id));
        const updatedSchemaEdges = vtaData.edges.filter(
          (e) => !removedIds.has(e.source) && !removedIds.has(e.target)
        );
        const updatedReactEdges = edges.filter(
          (e) => !removedIds.has(e.source) && !removedIds.has(e.target)
        );

        get().commitVTAChange({
          schema: {
            ...vtaData,
            nodes: updatedSchemaNodes,
            edges: updatedSchemaEdges,
          },
          nodes: updatedNodes,
          edges: updatedReactEdges,
        });

        const titles = nodesToRemove.map((n) => n.title || n.id).join('、');
        get().addLog('warn', `[ノード削除] カード「${titles}」を削除しました。`);
        return;
      }
    }

    // Dynamic height feedback from DOM measurement (type: 'dimensions')
    const dimChanges = changes.filter(
      (c) => c.type === 'dimensions' && (c as any).dimensions?.height
    );

    // Check if drag ended (type: 'position' with dragging === false)
    const dragEnded = changes.some(
      (c) => c.type === 'position' && (c as any).dragging === false
    );

    if (dimChanges.length > 0 || dragEnded) {
      const { vtaData } = get();
      const lanes = vtaData.lanes.length > 0 ? vtaData.lanes : ['主要部門'];

      // Update data.measuredHeight and measured.height on updatedNodes
      dimChanges.forEach((dim: any) => {
        const target = updatedNodes.find((n) => n.id === dim.id);
        if (target && dim.dimensions?.height) {
          target.measured = {
            width: dim.dimensions.width || 260,
            height: dim.dimensions.height,
          };
          if (target.data) {
            target.data.measuredHeight = dim.dimensions.height;
          }
        }
      });

      // Enforce lane vertical spacing (Collision Push)
      const adjustedNodes = enforceLaneVerticalSpacing(updatedNodes, lanes);

      let positionChanged = false;
      for (let i = 0; i < updatedNodes.length; i++) {
        if (
          Math.abs(updatedNodes[i].position.y - adjustedNodes[i].position.y) > 0.5 ||
          Math.abs(updatedNodes[i].position.x - adjustedNodes[i].position.x) > 0.5
        ) {
          positionChanged = true;
          break;
        }
      }

      if (positionChanged) {
        const syncedVtaNodes = vtaData.nodes.map((vn) => {
          const adj = adjustedNodes.find((an) => an.id === vn.id);
          return adj ? { ...vn, position: { ...adj.position } } : vn;
        });

        set({
          nodes: adjustedNodes,
          vtaData: { ...vtaData, nodes: syncedVtaNodes },
          isDirty: true,
        });
        get().saveDraftBackup();
        return;
      }
    }

    set({
      nodes: updatedNodes,
    });
  },

  onNodesDelete: (deletedNodes) => {
    if (!deletedNodes || deletedNodes.length === 0) return;
    const deletedIds = new Set(deletedNodes.map((n) => n.id));
    const { vtaData, nodes, edges } = get();

    const nodesToRemove = vtaData.nodes.filter((n) => deletedIds.has(n.id));
    if (nodesToRemove.length === 0) return;

    const updatedSchemaNodes = vtaData.nodes.filter((n) => !deletedIds.has(n.id));
    const updatedSchemaEdges = vtaData.edges.filter(
      (e) => !deletedIds.has(e.source) && !deletedIds.has(e.target)
    );
    const updatedReactEdges = edges.filter(
      (e) => !deletedIds.has(e.source) && !deletedIds.has(e.target)
    );
    const remainingReactNodes = nodes.filter((n) => !deletedIds.has(n.id));

    const updatedSchema: VTASchema = {
      ...vtaData,
      nodes: updatedSchemaNodes,
      edges: updatedSchemaEdges,
    };
    const layout = calculateVTALayout(updatedSchema, remainingReactNodes);

    get().commitVTAChange({
      schema: updatedSchema,
      nodes: layout.nodes,
      edges: updatedReactEdges,
      laneBounds: layout.laneBounds,
    });

    const titles = nodesToRemove.map((n) => n.title || n.id).join('、');
    get().addLog('warn', `[ノード削除] キーボード操作でカード「${titles}」を削除しました。`);
  },

  updateNodePosition: (nodeId, position) => {
    const { vtaData, nodes } = get();
    const updatedNodes = vtaData.nodes.map((n) =>
      n.id === nodeId ? { ...n, position } : n
    );
    const updatedReactNodes = nodes.map((n) =>
      n.id === nodeId
        ? { ...n, position, data: { ...n.data, position } }
        : n
    );
    set({
      vtaData: { ...vtaData, nodes: updatedNodes },
      nodes: updatedReactNodes,
      isDirty: true,
    });
  },
  onEdgesChange: (changes) => {
    const currentEdges = get().edges;
    const removedEdgeIds = new Set(
      changes.filter((c) => c.type === 'remove').map((c) => c.id)
    );

    const updatedEdges = applyEdgeChanges(changes, currentEdges);

    if (removedEdgeIds.size > 0) {
      const removedEdges = currentEdges.filter((e) => removedEdgeIds.has(e.id));
      const { vtaData } = get();
      const updatedSchemaEdges = vtaData.edges.filter(
        (se) => !removedEdges.some((re) => re.source === se.source && re.target === se.target)
      );
      get().commitVTAChange({
        schema: {
          ...vtaData,
          edges: updatedSchemaEdges,
        },
        edges: updatedEdges,
      });
    } else {
      set({
        edges: updatedEdges,
      });
    }
  },
  onConnect: (connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) {
      return;
    }
    const { edges, nodes, vtaData } = get();
    const alreadyExists = edges.some(
      (e) => e.source === connection.source && e.target === connection.target
    );
    if (alreadyExists) {
      return;
    }

    const srcNode = nodes.find((n) => n.id === connection.source);
    const tgtNode = nodes.find((n) => n.id === connection.target);

    const srcLane = srcNode?.data?.lane || '主要部門';
    const tgtLane = tgtNode?.data?.lane || '主要部門';
    const isCrossLane = srcLane !== tgtLane;

    let sourceHandle = connection.sourceHandle || 'top';
    let targetHandle = connection.targetHandle || 'bottom';

    if (isCrossLane) {
      const laneIdx = (laneName: string) => vtaData.lanes.indexOf(laneName);
      const srcIdx = srcNode ? laneIdx(srcLane) : 0;
      const tgtIdx = tgtNode ? laneIdx(tgtLane) : 0;
      const isSrcLeft =
        srcIdx !== -1 && tgtIdx !== -1
          ? srcIdx < tgtIdx
          : srcNode && tgtNode
          ? srcNode.position.x < tgtNode.position.x
          : true;

      if (isSrcLeft) {
        sourceHandle = 'right-source';
        targetHandle = 'left-target';
      } else {
        sourceHandle = 'left-source';
        targetHandle = 'right-target';
      }
    } else {
      sourceHandle = 'top';
      targetHandle = 'bottom';
    }

    const direction: import('../../../types/vta').EdgeDirection = isCrossLane ? 'unidirectional' : 'sequential';
    const edgeId = `e-${connection.source}-${connection.target}-${Date.now()}`;

    const newEdge: VTAReactFlowEdge = {
      id: edgeId,
      source: connection.source,
      target: connection.target,
      sourceHandle,
      targetHandle,
      type: 'vtaEdge',
      data: {
        is_break: false,
        direction,
        is_cross_lane: isCrossLane,
        sourceLane: srcLane,
        targetLane: tgtLane,
      },
    };

    const newSchemaEdge: import('../../../types/vta').VTAEdgeData = {
      source: connection.source,
      target: connection.target,
      is_break: false,
      direction,
    };

    get().commitVTAChange({
      schema: {
        ...vtaData,
        edges: [...vtaData.edges, newSchemaEdge],
      },
      edges: addEdge(newEdge, get().edges),
    });

    get().addLog(
      'info',
      `[エッジ接続] ${srcNode?.data?.title || connection.source} ➔ ${tgtNode?.data?.title || connection.target} を接続しました。`,
      '図面'
    );
  },

  // VTA Domain Mutations
  setVTAData: (schema) => {
    // 既存作業をバックアップスナップショットとして退避 (DATA-003)
    const currentSnapshot = {
      scenarioText: get().scenarioText,
      vtaData: get().vtaData,
      regenerationResult: get().regenerationResult,
    };

    const valRes = validateAndSanitizeVTASchema(schema);
    const sanitizedSchema = valRes.data || schema;
    const layout = calculateVTALayout(sanitizedSchema);

    set({
      previousBackupSnapshot: currentSnapshot,
      vtaData: sanitizedSchema,
      nodes: layout.nodes,
      edges: layout.edges,
      laneBounds: layout.laneBounds,
      regenerationResult: null,
      isReportOutdated: false,
      error: null,
      isDirty: true,
      past: [],
      future: [],
    });
    get().saveDraftBackup();
  },

  toggleNodeElimination: (nodeId) => {
    const { vtaData, nodes } = get();
    const updatedNodesInSchema = vtaData.nodes.map((node) => {
      if (node.id === nodeId) {
        const nextMeasure: 'elimination' | null =
          node.measure_type === 'elimination' ? null : 'elimination';
        return { ...node, measure_type: nextMeasure };
      }
      return node;
    });

    const updatedSchema = { ...vtaData, nodes: updatedNodesInSchema };

    const updatedReactNodes = nodes.map((node) => {
      if (node.id === nodeId) {
        const currentMeasure = node.data.measure_type;
        const nextMeasure: 'elimination' | null =
          currentMeasure === 'elimination' ? null : 'elimination';
        return {
          ...node,
          data: {
            ...node.data,
            measure_type: nextMeasure,
          },
        };
      }
      return node;
    });

    get().commitVTAChange({
      schema: updatedSchema,
      nodes: updatedReactNodes,
    });
  },

  toggleEdgeBreak: (edgeId) => {
    const { edges, vtaData } = get();
    const targetEdge = edges.find((e) => e.id === edgeId);
    if (!targetEdge) return;

    const newBreakState = !targetEdge.data?.is_break;

    const updatedEdges = edges.map((e) => {
      if (e.id === edgeId) {
        return {
          ...e,
          data: {
            ...e.data,
            is_break: newBreakState,
          },
        };
      }
      return e;
    });

    // Update VTA schema edges as well
    const updatedSchemaEdges = vtaData.edges.map((e) => {
      if (e.source === targetEdge.source && e.target === targetEdge.target) {
        return { ...e, is_break: newBreakState };
      }
      return e;
    });

    get().commitVTAChange({
      schema: {
        ...vtaData,
        edges: updatedSchemaEdges,
      },
      edges: updatedEdges,
    });
  },

  toggleEdgeDirection: (edgeId) => {
    const { edges, vtaData, addLog } = get();
    const targetEdge = edges.find((e) => e.id === edgeId);
    if (!targetEdge) return;

    const currentDir = targetEdge.data?.direction || 'sequential';
    const nextDir: import('../../../types/vta').EdgeDirection =
      currentDir === 'sequential'
        ? 'unidirectional'
        : currentDir === 'unidirectional'
        ? 'bidirectional'
        : 'unidirectional';

    const updatedEdges = edges.map((e) => {
      if (e.id === edgeId) {
        return {
          ...e,
          data: {
            ...e.data,
            direction: nextDir,
          },
        };
      }
      return e;
    });

    const updatedSchemaEdges = vtaData.edges.map((e) => {
      if (e.source === targetEdge.source && e.target === targetEdge.target) {
        return { ...e, direction: nextDir };
      }
      return e;
    });

    get().commitVTAChange({
      schema: {
        ...vtaData,
        edges: updatedSchemaEdges,
      },
      edges: updatedEdges,
    });

    addLog(
      'info',
      `[エッジ方向切替] ${targetEdge.source} ➔ ${targetEdge.target}: ${
        nextDir === 'bidirectional'
          ? '双方向通信 (◀──▶)'
          : nextDir === 'unidirectional'
          ? '一方向通信 (──▶)'
          : '時系列順方向 (──▶)'
      }`,
      '図面'
    );
  },

  updateEdge: (edgeId, updates) => {
    const { edges, vtaData } = get();
    const targetEdge = edges.find((e) => e.id === edgeId);
    if (!targetEdge) return;

    const updatedEdges = edges.map((e) => {
      if (e.id === edgeId) {
        return {
          ...e,
          data: {
            ...e.data,
            ...updates,
          },
        };
      }
      return e;
    });

    const updatedSchemaEdges = vtaData.edges.map((e) => {
      if (e.source === targetEdge.source && e.target === targetEdge.target) {
        return {
          ...e,
          ...updates,
        };
      }
      return e;
    });

    get().commitVTAChange({
      schema: {
        ...vtaData,
        edges: updatedSchemaEdges,
      },
      edges: updatedEdges,
    });

    get().addLog('info', `[接続情報更新] 接続 (${targetEdge.source} ➔ ${targetEdge.target}) の情報を更新しました。`, '図面');
  },

  editingEdgeId: null,
  openEdgeEditor: (edgeId) => set({ editingEdgeId: edgeId }),
  closeEdgeEditor: () => set({ editingEdgeId: null }),

  recalculateLayout: () => {
    const { vtaData, nodes } = get();
    const layout = calculateVTALayout(vtaData, nodes, undefined, { forceRecompute: true });
    const updatedSchemaNodes = vtaData.nodes.map((n) => {
      const layoutNode = layout.nodes.find((ln) => ln.id === n.id);
      return layoutNode ? { ...n, position: layoutNode.position } : n;
    });
    get().commitVTAChange({
      schema: { ...vtaData, nodes: updatedSchemaNodes },
      nodes: layout.nodes,
      edges: layout.edges,
      laneBounds: layout.laneBounds,
    });
    get().addLog('info', '[レイアウト] 時間軸・時系列順 (BT) に自動整列しました。', '配置');
  },

  addNode: (nodeData, connectFromNodeId) => {
    const { vtaData, nodes } = get();
    const newId = `node_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const newNode: import('../../../types/vta').VTANodeData = {
      ...nodeData,
      id: newId,
    };

    const lanes = vtaData.lanes.includes(newNode.lane)
      ? vtaData.lanes
      : [...vtaData.lanes, newNode.lane];

    const newEdges = [...vtaData.edges];
    if (connectFromNodeId) {
      newEdges.push({
        source: connectFromNodeId,
        target: newId,
        is_break: false,
      });
    }

    const updatedSchema: VTASchema = {
      ...vtaData,
      lanes,
      nodes: [...vtaData.nodes, newNode],
      edges: newEdges,
    };

    // 既存ノードの手動座標を保持しつつ配置計算
    const layout = calculateVTALayout(updatedSchema, nodes);
    const nodesWithPos = updatedSchema.nodes.map((n) => {
      const ln = layout.nodes.find((item) => item.id === n.id);
      return ln ? { ...n, position: ln.position } : n;
    });

    get().commitVTAChange({
      schema: { ...updatedSchema, nodes: nodesWithPos },
      nodes: layout.nodes,
      edges: layout.edges,
      laneBounds: layout.laneBounds,
    });
    get().addLog('success', `[ノード追加] 「${newNode.title}」(${newNode.lane}) を追加しました。`);
  },

  updateNode: (nodeId, updates) => {
    const { vtaData, nodes } = get();
    const targetNode = vtaData.nodes.find((n) => n.id === nodeId);
    if (!targetNode) return;

    const updatedNodes = vtaData.nodes.map((n) =>
      n.id === nodeId ? { ...n, ...updates } : n
    );
    const allLanes = Array.from(
      new Set([...vtaData.lanes, ...updatedNodes.map((n) => n.lane)])
    );
    const updatedSchema: VTASchema = {
      ...vtaData,
      lanes: allLanes,
      nodes: updatedNodes,
    };

    const laneChanged = updates.lane && updates.lane !== targetNode.lane;
    const timeChanged = updates.time !== undefined && updates.time !== targetNode.time;
    const laneCountChanged = allLanes.length !== vtaData.lanes.length;

    if (laneChanged || timeChanged || laneCountChanged) {
      const remainingNodes = nodes.filter((n) => n.id !== nodeId);
      const layout = calculateVTALayout(updatedSchema, remainingNodes);
      const nodesWithPos = updatedSchema.nodes.map((n) => {
        const ln = layout.nodes.find((item) => item.id === n.id);
        return ln ? { ...n, position: ln.position } : n;
      });

      get().commitVTAChange({
        schema: { ...updatedSchema, nodes: nodesWithPos },
        nodes: layout.nodes,
        edges: layout.edges,
        laneBounds: layout.laneBounds,
      });
    } else {
      // ユーザーが手動で調整した座標（nodes の position）を維持する
      const updatedReactNodes = nodes.map((node) => {
        if (node.id === nodeId) {
          return {
            ...node,
            data: {
              ...node.data,
              ...updates,
            },
          };
        }
        return node;
      });

      get().commitVTAChange({
        schema: updatedSchema,
        nodes: updatedReactNodes,
      });
    }
    get().addLog('info', `[ノード更新] カード (ID: ${nodeId}) の内容を更新しました。`);
  },

  deleteNode: (nodeId) => {
    const { vtaData, nodes } = get();
    const targetNode = vtaData.nodes.find((n) => n.id === nodeId);
    if (!targetNode) return;

    const updatedNodes = vtaData.nodes.filter((n) => n.id !== nodeId);
    const updatedEdges = vtaData.edges.filter(
      (e) => e.source !== nodeId && e.target !== nodeId
    );
    const updatedSchema: VTASchema = {
      ...vtaData,
      nodes: updatedNodes,
      edges: updatedEdges,
    };
    const remainingReactNodes = nodes.filter((n) => n.id !== nodeId);
    const layout = calculateVTALayout(updatedSchema, remainingReactNodes);

    get().commitVTAChange({
      schema: updatedSchema,
      nodes: layout.nodes,
      edges: layout.edges,
      laneBounds: layout.laneBounds,
    });
    get().addLog('warn', `[ノード削除] カード「${targetNode.title || nodeId}」を削除しました。`);
  },

  deleteEdge: (edgeId) => {
    const { edges, vtaData } = get();
    const targetEdge = edges.find((e) => e.id === edgeId);
    if (!targetEdge) return;

    const updatedEdges = edges.filter((e) => e.id !== edgeId);
    const updatedSchemaEdges = vtaData.edges.filter(
      (e) => !(e.source === targetEdge.source && e.target === targetEdge.target)
    );

    get().commitVTAChange({
      schema: {
        ...vtaData,
        edges: updatedSchemaEdges,
      },
      edges: updatedEdges,
    });

    get().addLog(
      'warn',
      `[エッジ削除] 接続線 (${targetEdge.source} ➔ ${targetEdge.target}) を削除しました。`,
      '図面'
    );
  },

  // Supplementary Notes State & Mutations
  isNotesPanelOpen: true, // Open by default or toggleable
  setIsNotesPanelOpen: (open) => set({ isNotesPanelOpen: open }),
  toggleNotesPanel: () => set((state) => ({ isNotesPanelOpen: !state.isNotesPanelOpen })),

  updateNodeSupplementaryNote: (nodeId, note) => {
    const { vtaData, nodes } = get();
    const updatedNodes = vtaData.nodes.map((n) =>
      n.id === nodeId ? { ...n, supplementary_note: note } : n
    );
    const updatedReactNodes = nodes.map((n) =>
      n.id === nodeId
        ? { ...n, data: { ...n.data, supplementary_note: note } }
        : n
    );
    get().commitVTAChange({
      schema: { ...vtaData, nodes: updatedNodes },
      nodes: updatedReactNodes,
      skipHistory: true,
    });
  },

  updateSupplementarySummary: (summary) => {
    const { vtaData } = get();
    get().commitVTAChange({
      schema: { ...vtaData, supplementary_summary: summary },
      skipHistory: true,
    });
  },

  addCustomNote: (title, content) => {
    const { vtaData } = get();
    const newNote = {
      id: `note_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      title,
      content,
    };
    const custom_notes = [...(vtaData.custom_notes || []), newNote];
    get().commitVTAChange({
      schema: { ...vtaData, custom_notes },
    });
    get().addLog('info', `[補足メモ追加] 「${title}」を追加しました。`);
  },

  updateCustomNote: (id, updates) => {
    const { vtaData } = get();
    const custom_notes = (vtaData.custom_notes || []).map((note) =>
      note.id === id ? { ...note, ...updates } : note
    );
    get().commitVTAChange({
      schema: { ...vtaData, custom_notes },
      skipHistory: true,
    });
  },

  deleteCustomNote: (id) => {
    const { vtaData } = get();
    const custom_notes = (vtaData.custom_notes || []).filter((n) => n.id !== id);
    get().commitVTAChange({
      schema: { ...vtaData, custom_notes },
    });
    get().addLog('warn', `[補足メモ削除] 補足メモを削除しました。`);
  },

  // Project File Save (Export)
  exportProjectJSON: (filename) => {
    const { scenarioText, vtaData, regenerationResult, llmConfig } = get();
    const projectData: import('../../../types/vta').VTAProjectFile = {
      version: '1.0',
      savedAt: new Date().toISOString(),
      scenarioText,
      vtaData,
      regenerationResult,
      selectedModel: llmConfig.selectedModel,
    };

    const jsonStr = JSON.stringify(projectData, null, 2);
    const defaultName = `vta-project-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`;
    const downloadAnchor = document.createElement('a');

    if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function' && typeof Blob !== 'undefined') {
      const blob = new Blob([jsonStr], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      downloadAnchor.setAttribute('href', url);
      downloadAnchor.setAttribute('download', filename || defaultName);
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
      URL.revokeObjectURL(url);
    } else {
      const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(jsonStr);
      downloadAnchor.setAttribute('href', dataStr);
      downloadAnchor.setAttribute('download', filename || defaultName);
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
    }

    set({ isDirty: false });
    get().showToast('success', `プロジェクトを「${filename || defaultName}」として保存しました。`);
    get().addLog('success', `[プロジェクト保存] プロジェクトファイルをダウンロードしました (${defaultName})`);
  },

  isSVGExportModalOpen: false,
  openSVGExportModal: () => set({ isSVGExportModalOpen: true }),
  closeSVGExportModal: () => set({ isSVGExportModalOpen: false }),

  exportVTASVG: (options) => {
    const { vtaData, nodes, edges, laneBounds, scenarioText, addLog, showToast } = get();
    try {
      const res = exportVTAToSVGFile(vtaData, nodes, edges, laneBounds, {
        scenarioText,
        ...options,
      });
      addLog('success', `[SVG出力] VTA図＆補足説明を単一SVGファイルとして出力しました (${res.filename})`, 'エクスポート');
      showToast('success', `SVG図「${res.filename}」を出力しました。`);
      return res;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog('error', `[SVG出力失敗] ${msg}`, 'エクスポート');
      showToast('error', `SVG出力に失敗しました: ${msg}`);
      throw err;
    }
  },

  // Project File Load (Import)
  importProjectJSON: (jsonString: string) => {
    try {
      get().cancelCurrentOperation(); // Abort ongoing generation to prevent cross-project pollution (REL-001)
      const parsed = JSON.parse(jsonString);

      // Check if full VTAProjectFile format
      if (parsed && typeof parsed === 'object' && (parsed.vtaData || parsed.version)) {
        const valRes = validateAndSanitizeProjectFile(parsed);
        if (!valRes.isValid || !valRes.data) {
          throw new Error('プロジェクトファイル検証エラー:\n' + valRes.errors.join('\n'));
        }

        const project = valRes.data;
        const schema = project.vtaData;
        const layout = calculateVTALayout(schema);

        // 退避スナップショット (DATA-003)
        const currentSnapshot = {
          scenarioText: get().scenarioText,
          vtaData: get().vtaData,
          regenerationResult: get().regenerationResult,
        };

        const targetScenarioText = project.scenarioText !== undefined ? project.scenarioText : get().scenarioText;
        const currentHash = computeVTADataHash(schema, targetScenarioText);
        const report = project.regenerationResult || null;
        const isOutdated = report
          ? (report.sourceHash ? report.sourceHash !== currentHash : false)
          : false;

        const newProjectId = get().createNewProjectId();

        set({
          currentProjectId: newProjectId,
          activeRequestId: null,
          previousBackupSnapshot: currentSnapshot,
          scenarioText: targetScenarioText,
          vtaData: schema,
          nodes: layout.nodes,
          edges: layout.edges,
          laneBounds: layout.laneBounds,
          regenerationResult: report,
          isReportOutdated: isOutdated,
          error: null,
          activeTab: project.regenerationResult ? 'idealFlow' : 'scenario',
          isDirty: false,
          past: [],
          future: [],
        });

        if (valRes.errors.length > 0) {
          valRes.errors.forEach((err) => get().addLog('warn', `[読込補正] ${err}`, '読込'));
          get().showToast('warn', `プロジェクト読込時に ${valRes.errors.length} 件の軽微な不整合を自動補正しました。詳細はログを確認してください。`);
        } else {
          get().showToast('success', `プロジェクトを正常に読み込みました（ノード: ${schema.nodes.length}件）。`);
        }

        get().addLog('success', `[プロジェクト読込] 作業セッション（ノード: ${schema.nodes.length}件, エッジ: ${schema.edges.length}件）を復元しました。`);
        return { success: true, message: 'プロジェクトを正常に復元しました。' };
      }

      // Check if standalone VTASchema format
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.nodes)) {
        const valRes = validateAndSanitizeVTASchema(parsed);
        if (!valRes.isValid || !valRes.data) {
          throw new Error('VTAスキーマ検証エラー:\n' + valRes.errors.join('\n'));
        }

        const schema = valRes.data;
        const layout = calculateVTALayout(schema);

        // 退避スナップショット (DATA-003)
        const currentSnapshot = {
          scenarioText: get().scenarioText,
          vtaData: get().vtaData,
          regenerationResult: get().regenerationResult,
        };

        const newProjectId = get().createNewProjectId();

        set({
          currentProjectId: newProjectId,
          activeRequestId: null,
          previousBackupSnapshot: currentSnapshot,
          vtaData: schema,
          nodes: layout.nodes,
          edges: layout.edges,
          laneBounds: layout.laneBounds,
          regenerationResult: null,
          isReportOutdated: false,
          error: null,
          isDirty: false,
          past: [],
          future: [],
        });

        if (valRes.errors.length > 0) {
          valRes.errors.forEach((err) => get().addLog('warn', `[読込補正] ${err}`, '読込'));
          get().showToast('warn', `VTAスキーマ読込時に ${valRes.errors.length} 件の軽微な不整合を自動補正しました。`);
        } else {
          get().showToast('success', `VTAスキーマを読み込みました（ノード: ${schema.nodes.length}件）。`);
        }

        get().addLog('success', `[データ読込] VTAスキーマ（ノード: ${schema.nodes.length}件, エッジ: ${schema.edges.length}件）を読み込みました。`);
        return { success: true, message: 'VTAスキーマを正常に読み込みました。' };
      }

      throw new Error('有効なVTAプロジェクトまたはスキーマJSON形式ではありません。');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      get().showToast('error', `読込失敗: ${msg}`);
      get().addLog('error', `[読込失敗] ${msg}`);
      return { success: false, message: `ファイルの読み込みに失敗しました: ${msg}` };
    }
  },

  // Node Editor Modal State
  isNodeEditorOpen: false,
  editingNodeData: null,
  openNodeEditor: (nodeData = null) => {
    let fullNodeData = nodeData;
    if (nodeData && nodeData.id) {
      const existing = get().vtaData.nodes.find((n) => n.id === nodeData.id);
      if (existing) {
        fullNodeData = {
          ...existing,
          ...nodeData,
          supplementary_note: nodeData.supplementary_note ?? existing.supplementary_note ?? '',
        };
      }
    }
    set({
      isNodeEditorOpen: true,
      editingNodeData: fullNodeData,
    });
  },
  closeNodeEditor: () => {
    set({
      isNodeEditorOpen: false,
      editingNodeData: null,
    });
  },

  // LLM Status & Output
  isExtracting: false,
  isRegenerating: false,
  generationProgress: {
    isActive: false,
    mode: null,
    stage: 'idle',
    title: '',
    detail: '',
    stepCurrent: 0,
    stepTotal: 4,
    elapsedSeconds: 0,
  },
  setGenerationProgress: (progress) =>
    set((state) => ({
      generationProgress: { ...state.generationProgress, ...progress },
    })),
  resetGenerationProgress: () =>
    set({
      generationProgress: {
        isActive: false,
        mode: null,
        stage: 'idle',
        title: '',
        detail: '',
        stepCurrent: 0,
        stepTotal: 4,
        elapsedSeconds: 0,
      },
    }),
  regenerationResult: null,
  error: null,
  activeTab: 'scenario',

  // AI Countermeasure Proposals State
  isProposing: false,
  isProposalModalOpen: false,
  measuresProposal: null,
  setIsProposing: (val) => set({ isProposing: val }),
  setIsProposalModalOpen: (val) => set({ isProposalModalOpen: val }),
  setMeasuresProposal: (res) => set({ measuresProposal: res }),

  applyMeasuresProposal: (selectedEliminationNodeIds, selectedBreakPairs) => {
    const { vtaData, nodes, edges, addLog } = get();

    // 1. Update nodes in schema
    const updatedSchemaNodes = vtaData.nodes.map((node) => {
      if (selectedEliminationNodeIds.includes(node.id)) {
        return { ...node, measure_type: 'elimination' as const };
      }
      return node;
    });

    // 2. Update edges in schema
    const updatedSchemaEdges = vtaData.edges.map((edge) => {
      const isSelectedBreak = selectedBreakPairs.some(
        (p) => p.source === edge.source && p.target === edge.target
      );
      if (isSelectedBreak) {
        return { ...edge, is_break: true };
      }
      return edge;
    });

    const updatedSchema = {
      ...vtaData,
      nodes: updatedSchemaNodes,
      edges: updatedSchemaEdges,
    };

    // 3. Update React Flow nodes & edges
    const updatedReactNodes = nodes.map((node) => {
      if (selectedEliminationNodeIds.includes(node.id)) {
        return {
          ...node,
          data: {
            ...node.data,
            measure_type: 'elimination' as const,
          },
        };
      }
      return node;
    });

    const updatedReactEdges = edges.map((edge) => {
      const isSelectedBreak = selectedBreakPairs.some(
        (p) => p.source === edge.source && p.target === edge.target
      );
      if (isSelectedBreak) {
        return {
          ...edge,
          data: {
            ...edge.data,
            is_break: true,
          },
        };
      }
      return edge;
    });

    get().commitVTAChange({
      schema: updatedSchema,
      nodes: updatedReactNodes,
      edges: updatedReactEdges,
    });

    addLog(
      'success',
      `[対策一括適用] 排除ノード ${selectedEliminationNodeIds.length}件、ブレイク ${selectedBreakPairs.length}件をVTA図に反映しました。`,
      '対策'
    );
  },

  // Execution Logs
  logs: [
    {
      id: 'init-1',
      timestamp: new Date().toLocaleTimeString(),
      type: 'info',
      message: 'システム起動完了。Viteプロキシ (/v1) 準備完了。',
      stageTag: '起動',
    },
  ],
  addLog: (type, message, stageTag) => {
    const newLog: import('../../../types/vta').LogEntry = {
      id: `log-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp: new Date().toLocaleTimeString(),
      type,
      message,
      stageTag,
    };
    set((state) => ({
      logs: [...state.logs.slice(-149), newLog], // Keep last 150 logs
    }));
  },
  clearLogs: () => set({ logs: [] }),

  setIsExtracting: (val) => set({ isExtracting: val }),
  setIsRegenerating: (val) => set({ isRegenerating: val }),
  setRegenerationResult: (res, requestSourceHash) => {
    const { vtaData, scenarioText } = get();
    const currentHash = computeVTADataHash(vtaData, scenarioText);
    const effectiveSourceHash = requestSourceHash ?? res?.sourceHash ?? currentHash;
    const updatedResult = res ? { ...res, sourceHash: effectiveSourceHash } : null;
    const isOutdated = updatedResult ? updatedResult.sourceHash !== currentHash : false;
    set({
      regenerationResult: updatedResult,
      isReportOutdated: isOutdated,
      isDirty: true,
    });
    get().saveDraftBackup();
  },
  isReportOutdated: false,
  setIsReportOutdated: (val) => set({ isReportOutdated: val }),
  setError: (err) => set({ error: err }),
  setActiveTab: (tab) => set({ activeTab: tab }),

  // LocalStorage Auto-Draft Backup (FUNC-001)
  hasDraftBackup: false,
  draftBackupTimestamp: null,
  saveDraftBackup: () => {
    try {
      const storage = getSafeStorage();
      const { scenarioText, vtaData, regenerationResult } = get();
      const draft = {
        savedAt: new Date().toISOString(),
        scenarioText,
        vtaData,
        regenerationResult,
      };
      storage.setItem('vta_draft_autosave', JSON.stringify(draft));
      set({ hasDraftBackup: true, draftBackupTimestamp: draft.savedAt });
    } catch (e) {
      console.warn('Failed to save draft to storage', e);
    }
  },
  checkDraftBackup: () => {
    try {
      const storage = getSafeStorage();
      const raw = storage.getItem('vta_draft_autosave');
      if (!raw) {
        set({ hasDraftBackup: false, draftBackupTimestamp: null });
        return false;
      }
      const parsed = JSON.parse(raw);
      if (parsed && parsed.vtaData && Array.isArray(parsed.vtaData.nodes) && parsed.vtaData.nodes.length > 0) {
        set({ hasDraftBackup: true, draftBackupTimestamp: parsed.savedAt || null });
        return true;
      }
    } catch {}
    set({ hasDraftBackup: false, draftBackupTimestamp: null });
    return false;
  },
  restoreDraftBackup: () => {
    try {
      const storage = getSafeStorage();
      const raw = storage.getItem('vta_draft_autosave');
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      if (!parsed || !parsed.vtaData) return false;
      const layout = calculateVTALayout(parsed.vtaData);
      const targetScenario = parsed.scenarioText || '';
      const report = parsed.regenerationResult || null;
      const currentHash = computeVTADataHash(parsed.vtaData, targetScenario);
      const isOutdated = report
        ? (report.sourceHash ? report.sourceHash !== currentHash : false)
        : false;
      const newProjectId = get().createNewProjectId();
      set({
        currentProjectId: newProjectId,
        activeRequestId: null,
        scenarioText: targetScenario,
        vtaData: parsed.vtaData,
        nodes: layout.nodes,
        edges: layout.edges,
        laneBounds: layout.laneBounds,
        regenerationResult: report,
        isReportOutdated: isOutdated,
        isDirty: true,
        past: [],
        future: [],
      });
      get().showToast('success', '未保存の下書きバックアップを復元しました。');
      get().addLog('info', 'LocalStorageから下書きバックアップを復元しました。', '復元');
      return true;
    } catch (e) {
      get().showToast('error', '下書きバックアップの復元に失敗しました。');
      return false;
    }
  },
  clearDraftBackup: () => {
    try {
      const storage = getSafeStorage();
      storage.removeItem('vta_draft_autosave');
    } catch {}
    set({ hasDraftBackup: false, draftBackupTimestamp: null });
  },

  // UI Toast Notifications (UI-002)
  toasts: [],
  showToast: (type, message, durationMs = 4000) => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const newToast: import('../../../types/vta').ToastItem = { id, type, message };
    set((state) => ({ toasts: [...state.toasts, newToast] }));
    setTimeout(() => {
      get().dismissToast(id);
    }, durationMs);
  },
  dismissToast: (id) => {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },

  // Abort / Cancellation Implementation
  activeAbortController: null,
  createAbortController: () => {
    const prev = get().activeAbortController;
    if (prev) {
      try {
        prev.abort('superseded');
      } catch {}
    }
    const controller = new AbortController();
    set({ activeAbortController: controller });
    return controller;
  },
  cancelCurrentOperation: () => {
    const controller = get().activeAbortController;
    if (controller) {
      try {
        controller.abort('user_cancelled');
      } catch {}
    }
    set({
      activeAbortController: null,
      isExtracting: false,
      isRegenerating: false,
      isProposing: false,
    });
    get().addLog('warn', 'ユーザー操作により処理が中断（キャンセル）されました。', '中断');
    get().setGenerationProgress({
      isActive: false,
      stage: 'idle',
      title: '処理が中断されました',
      detail: 'ユーザー操作によりLLMリクエストを取り消しました。',
    });
  },
}));
