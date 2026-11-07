import { dependencyKey } from '../utils/eventOrder';
import { capturePreProgressFocus } from '../utils/progressFocus';
import { clampSubjectLimit, DEFAULT_MAX_SUBJECTS, consolidateSubjects, revertConsolidation } from '../utils/subjectRanking';
import { SubjectPoset } from '../utils/subjectPoset';
import { visibleSchema, canonicalPosition, planCardSimplification, maintainPresentation } from '../utils/presentation';
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
  VTARefinementSettings,
  VTAAnalysisData,
  LaneMergeProposal,
  LaneSplitProposal,
} from '../../../types/vta';
import { DEFAULT_REFINEMENT_SETTINGS } from '../utils/optimizationPresets';
import { calculateVTALayout, LayoutResult, enforceLaneVerticalSpacing, LANE_WIDTH, LANE_PADDING, NODE_WIDTH, compactNodeHeight, estimateNodeHeight } from '../utils/layout';
import { SAMPLE_SCENARIOS } from '../data/sampleData';
import { exportVTAToSVGFile } from '../utils/svgExport';
import { exportAnimatedVTAToSVGFile } from '../utils/animatedSvgExport';
import { debugRecorder } from '../../../services/debugRecorder';
import { DEFAULT_PROMPT_CONFIG } from '../../../services/llm/prompts';
import {
  validateAndSanitizeVTASchema,
  validateAndSanitizeProjectFile,
} from '../utils/schemaValidator';
import { computeVTADataHash } from '../utils/hash';
import { createConnectionRepairPlan, type ConnectionRepairPlan } from '../utils/connectionRepairPlan';
import { connectionProposalSignature, proposalRelation, validateSelectedConnectionProposals, type ConnectionProposal } from '../utils/connectionProposals';
import { getDisplayRect, projectDisplayNode, unprojectDraggedPosition } from '../utils/nodeGeometry';
import { createManualAnalysis, projectAnalysis, reconcileAnalysis } from '../utils/eventAnalysis';
import { autoConnectVTA } from '../../../services/generation/autoConnectionService';
import { refineGranularity } from '../../../services/generation/granularityRefinement';
import { callLLMGateway } from '../../../services/llm/client';
import { createPipelineSnapshot, upsertPipelineSnapshot } from '../utils/pipelineHistory';

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

const SNAP_TO_LANE_CENTER_KEY = 'vta_snap_to_lane_center';
const SUBJECT_LIMIT_KEY = 'vta_subject_limit';
const EXCLUDE_POST_OUTCOME_KEY = 'vta_exclude_post_outcome_activities';
const OUTCOME_FIRST_KEY = 'vta_outcome_first_normalization';

function readOutcomeFirstPreference(): boolean {
  try {
    return getSafeStorage().getItem(OUTCOME_FIRST_KEY) === 'true';
  } catch {
    return false;
  }
}

function readExcludePostOutcomePreference(): boolean {
  try {
    const raw = getSafeStorage().getItem(EXCLUDE_POST_OUTCOME_KEY);
    if (raw === null) return true; // default true
    return raw !== 'false';
  } catch {
    return true;
  }
}

function readSubjectLimitPreference(): number {
  try {
    const raw = getSafeStorage().getItem(SUBJECT_LIMIT_KEY);
    if (!raw) return DEFAULT_MAX_SUBJECTS;
    return clampSubjectLimit(Number(raw));
  } catch {
    return DEFAULT_MAX_SUBJECTS;
  }
}

function readSnapToLaneCenterPreference(): boolean {
  try { return getSafeStorage().getItem(SNAP_TO_LANE_CENTER_KEY) === 'true'; }
  catch { return false; }
}

function snapMovedNodesToLaneCenter(
  nodes: VTAReactFlowNode[],
  lanes: string[],
  before: VTASchema | null,
  positionField: 'position' | 'compact_position',
  movedIds: Set<string>
): VTAReactFlowNode[] {
  if (!before || !movedIds.size) return nodes;
  const beforeById = new Map(before.nodes.map((node) => [node.id, node[positionField]]));
  return nodes.map((node) => {
    if (!movedIds.has(node.id)) return node;
    const original = beforeById.get(node.id);
    if (!original || (Math.abs(node.position.x - original.x) <= 0.001 && Math.abs(node.position.y - original.y) <= 0.001)) return node;
    const laneIndex = lanes.indexOf(String(node.data.lane));
    if (laneIndex < 0) return node;
    const rect = getDisplayRect(node);
    const laneCenterX = laneIndex * LANE_WIDTH + LANE_PADDING + LANE_WIDTH / 2;
    const position = { x: node.position.x + laneCenterX - (rect.x + rect.width / 2), y: node.position.y };
    return { ...node, position, data: { ...node.data, position } };
  });
}

function storedPositions(schema: VTASchema, nodes: VTAReactFlowNode[]) {
  return new Map(nodes.map((node) => [node.id, canonicalPosition(schema, String(node.data.lane), node.position)]));
}

function capturePresentationPositions(schema: VTASchema, nodes: VTAReactFlowNode[]): VTASchema {
  const detail = storedPositions(schema, nodes);
  const compact = storedPositions(schema, calculateVTALayout(schema, undefined, undefined, { compact: true, positionField: 'compact_position' }).nodes);
  return { ...schema, nodes: schema.nodes.map((node) => ({ ...node,
    ...(node.position ?? detail.get(node.id) ? { position: node.position ?? detail.get(node.id) } : {}),
    ...(node.compact_position ?? compact.get(node.id) ? { compact_position: node.compact_position ?? compact.get(node.id) } : {}),
  })) };
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
  snapToLaneCenter: boolean;
  setSnapToLaneCenter: (enabled: boolean) => void;
  subjectLimit: number;
  setSubjectLimit: (limit: number) => void;
  excludePostOutcomeActivities: boolean;
  setExcludePostOutcomeActivities: (enabled: boolean) => void;
  outcomeFirstNormalization: boolean;
  setOutcomeFirstNormalization: (enabled: boolean) => void;
  // Refinement Optimization Settings (VT-F17, VT-F18)
  refinementSettings: VTARefinementSettings;
  setRefinementSettings: (settings: Partial<VTARefinementSettings>) => void;
  resetRefinementSettings: () => void;
  isOptimizationSettingsOpen: boolean;
  setIsOptimizationSettingsOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
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
  cancelNodeDrag: () => boolean;
  allowNewNodeDrag: () => void;
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
    skipLayout?: boolean;
    preserveDerivedRemovals?: boolean;
  }) => void;

  // React Flow Handlers
  onNodesChange: (changes: NodeChange<VTAReactFlowNode>[], viewMode?: 'detail' | 'compact') => void;
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
      status?: 'occurred' | 'omitted' | 'unknown';
      receipt?: 'confirmed' | 'unconfirmed' | 'na';
      resource?: string;
      meaning?: import('../../../types/vta').VTAEdgeData['meaning'];
    }
  ) => void;
  editingEdgeId: string | null;
  openEdgeEditor: (edgeId: string) => void;
  closeEdgeEditor: () => void;
  recalculateLayout: () => void;
  moveLane: (laneName: string, direction: -1 | 1) => void;
  setLaneVisibility: (entityId: string, mode: 'auto' | 'show' | 'hide') => void;
  toggleLaneDrilldown: (entityId: string) => void;
  setLaneDrilldown: (entityId: string, enabled: boolean) => void;
  setObjectDisplayStyle: (style: 'dot' | 'card') => void;
  addLane: (name: string) => boolean;
  simplifyCards: () => void;
  applyLaneMergeProposal: (proposal: LaneMergeProposal, customTargetName?: string) => void;
  applyLaneSplitProposal: (proposal: LaneSplitProposal) => void;
  forceMergeLanes: (sourceLane: string, targetLane: string) => void;
  getConnectionRepairPlan: () => ConnectionRepairPlan;
  applyConnectionRepair: (sourceSignature: string) => boolean;
  applyConnectionProposals: (projectId: string, signature: string, proposals: ConnectionProposal[]) => boolean;
  autoConnectNodes: (configOverride?: LLMConfig) => Promise<boolean>;
  reoptimizeVTA: (configOverride?: LLMConfig) => Promise<boolean>;
  addNode: (nodeData: Omit<import('../../../types/vta').VTANodeData, 'id'>, connectFromNodeId?: string) => void;
  updateNode: (nodeId: string, updates: Partial<import('../../../types/vta').VTANodeData>) => void;
  setNodeHidden: (nodeId: string, hidden: boolean) => void;
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
  isAnimationPlayerOpen: boolean;
  openAnimationPlayer: () => void;
  closeAnimationPlayer: () => void;
  exportAnimatedVTASVG: (options?: import('../utils/animatedSvgExport').AnimatedSVGOptions) => { success: boolean; filename: string };
  isNormalizationAuditExportModalOpen: boolean;
  normalizationAuditTargetAnalysis: import('../../../types/vta').VTAAnalysisData | null;
  openNormalizationAuditExportModal: (analysis?: import('../../../types/vta').VTAAnalysisData | null) => void;
  closeNormalizationAuditExportModal: () => void;

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
const defaultSampleSchema = { ...defaultSample.vtaData, analysis: createManualAnalysis(defaultSample.vtaData) };
const initialLayout = calculateVTALayout(defaultSampleSchema);

let activeDragPreSnapshot: VTASchema | null = null;
let activeDragOriginalSchema: VTASchema | null = null;
let activeDragHistoryRecorded = false;
let ignoreCancelledDragEvents = false;
const activeDragNodeIds = new Set<string>();

export const useVTAStore = create<VTAState>((set, get) => ({
  compactView: false,
  snapToLaneCenter: readSnapToLaneCenterPreference(),
  subjectLimit: readSubjectLimitPreference(),
  setSubjectLimit: (limit) => {
    const clamped = clampSubjectLimit(limit);
    set({ subjectLimit: clamped });
    try { getSafeStorage().setItem(SUBJECT_LIMIT_KEY, String(clamped)); } catch { /* Storage may be unavailable. */ }
  },
  excludePostOutcomeActivities: readExcludePostOutcomePreference(),
  setExcludePostOutcomeActivities: (enabled) => {
    set({ excludePostOutcomeActivities: enabled });
    try { getSafeStorage().setItem(EXCLUDE_POST_OUTCOME_KEY, String(enabled)); } catch { /* Storage may be unavailable. */ }
  },
  outcomeFirstNormalization: readOutcomeFirstPreference(),
  setOutcomeFirstNormalization: (enabled) => {
    set({ outcomeFirstNormalization: enabled });
    try { getSafeStorage().setItem(OUTCOME_FIRST_KEY, String(enabled)); } catch { /* Storage may be unavailable. */ }
  },
  refinementSettings: DEFAULT_REFINEMENT_SETTINGS,
  setRefinementSettings: (settings) => {
    set((state) => ({
      refinementSettings: {
        ...state.refinementSettings,
        ...settings,
        weights: {
          ...state.refinementSettings.weights,
          ...(settings.weights ?? {}),
        },
      },
    }));
  },
  resetRefinementSettings: () => {
    set({ refinementSettings: DEFAULT_REFINEMENT_SETTINGS });
  },
  isOptimizationSettingsOpen: false,
  setIsOptimizationSettingsOpen: (open) => {
    set((state) => ({
      isOptimizationSettingsOpen: typeof open === 'function' ? open(state.isOptimizationSettingsOpen) : open,
    }));
  },

  setSnapToLaneCenter: (enabled) => {
    set({ snapToLaneCenter: enabled });
    try { getSafeStorage().setItem(SNAP_TO_LANE_CENTER_KEY, String(enabled)); } catch { /* Storage may be unavailable. */ }
  },
  toggleCompactView: () => {
    get().cancelNodeDrag();
    set((state) => ({ compactView: !state.compactView }));
  },
  // Accidental overwrite recovery snapshot (DATA-003)
  previousBackupSnapshot: null,
  restorePreviousBackupSnapshot: () => {
    const backup = get().previousBackupSnapshot;
    if (!backup) return false;
    ignoreCancelledDragEvents = Boolean(activeDragPreSnapshot);
    activeDragPreSnapshot = null;
    activeDragHistoryRecorded = false;
    activeDragNodeIds.clear();
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
    selectedModel: 'openrouter/google/gemini-3.8-flash',
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
        set({ promptConfig: { ...DEFAULT_PROMPT_CONFIG, ...loaded, connectionProposal: loaded.connectionProposal ?? DEFAULT_PROMPT_CONFIG.connectionProposal } });
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
    ignoreCancelledDragEvents = Boolean(activeDragPreSnapshot);
    activeDragPreSnapshot = null;
    activeDragOriginalSchema = null;
    activeDragHistoryRecorded = false;
    activeDragNodeIds.clear();
    get().cancelCurrentOperation();
    const sampleSchema = { ...sample.vtaData, analysis: createManualAnalysis(sample.vtaData) };
    const layout = calculateVTALayout(sampleSchema);
    const newProjectId = get().createNewProjectId();
    set({
      currentProjectId: newProjectId,
      activeRequestId: null,
      measuresProposal: null,
      isProposalModalOpen: false,
      selectedSampleId: sample.id,
      scenarioText: sample.scenarioText,
      vtaData: sampleSchema,
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
  vtaData: defaultSampleSchema,
  nodes: initialLayout.nodes,
  edges: initialLayout.edges,
  laneBounds: initialLayout.laneBounds,

  // History & Undo / Redo
  past: [],
  future: [],
  canUndo: () => get().past.length > 0,
  canRedo: () => get().future.length > 0,
  cancelNodeDrag: () => {
    if (!activeDragPreSnapshot) return false;
    const snapshot = activeDragOriginalSchema ?? activeDragPreSnapshot;
    activeDragPreSnapshot = null;
    activeDragOriginalSchema = null;
    activeDragHistoryRecorded = false;
    activeDragNodeIds.clear();
    ignoreCancelledDragEvents = true;
    const layout = calculateVTALayout(snapshot);
    set({ vtaData: snapshot, nodes: layout.nodes, edges: layout.edges, laneBounds: layout.laneBounds });
    return true;
  },
  allowNewNodeDrag: () => { ignoreCancelledDragEvents = false; },
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
    if (activeDragPreSnapshot) {
      if (!activeDragHistoryRecorded) {
        const { past } = get();
        const snapshot: VTASchema = JSON.parse(JSON.stringify(activeDragPreSnapshot));
        const newPast = [...past, snapshot];
        if (newPast.length > 30) {
          newPast.shift();
        }
        set({
          past: newPast,
          future: [],
        });
        activeDragHistoryRecorded = true;
      }
      return;
    }
    get().pushHistory();
  },

  // Change Commit & Persistence Helper (DATA-002, DATA-003)
  commitVTAChange: ({ schema, nodes, edges, laneBounds, extraState, skipHistory, skipLayout, preserveDerivedRemovals }) => {
    const { vtaData, past, regenerationResult, scenarioText } = get();
    const removedGenerated = preserveDerivedRemovals ? [] : vtaData.edges.filter((edge) => (edge.generated || edge.eventId || edge.relationId) && edge.id && !schema.edges.some((next) => next.id === edge.id)).map((edge) => edge.id!);
    if (removedGenerated.length || vtaData.presentation?.omittedEdges?.length) schema = { ...schema, presentation: {
      ...schema.presentation, lanes: { ...schema.presentation?.lanes }, suppressedCards: { ...schema.presentation?.suppressedCards },
      omittedDependencies: [...new Set([...(vtaData.presentation?.omittedDependencies??[]),...(schema.presentation?.omittedDependencies??[]),...vtaData.edges.filter(e=>e.meaning==='dependency'&&!schema.edges.some(n=>n.id===e.id)).flatMap(e=>vtaData.analysis?.relations.filter(r=>r.id===e.relationId).map(dependencyKey)??[])])],
      omittedEdges: [...new Set([...(vtaData.presentation?.omittedEdges ?? []), ...(schema.presentation?.omittedEdges ?? []), ...removedGenerated])],
      eventNotes: { ...vtaData.presentation?.eventNotes, ...schema.presentation?.eventNotes },
    } };
    const committedSchema = reconcileAnalysis(vtaData, schema);
    let committedNodes = nodes?.map((node) => {
      const card = committedSchema.nodes.find((candidate) => candidate.id === node.id);
      return card ? { ...node, data: { ...node.data, ...card } } : node;
    });
    if (!skipLayout && (committedSchema.presentation || (!nodes && !edges))) {
      const layout = calculateVTALayout(committedSchema, nodes ?? get().nodes);
      committedNodes = layout.nodes.map((node) => ({ ...node, selected: (nodes ?? get().nodes).find((item) => item.id === node.id)?.selected }));
      edges = layout.edges;
      laneBounds = layout.laneBounds;
    }
    if (activeDragPreSnapshot) ignoreCancelledDragEvents = true;
    activeDragPreSnapshot = null;
    activeDragOriginalSchema = null;
    activeDragHistoryRecorded = false;
    activeDragNodeIds.clear();

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
    const currentHash = computeVTADataHash(committedSchema, scenarioText);
    const isOutdated = regenerationResult
      ? (regenerationResult.sourceHash ? regenerationResult.sourceHash !== currentHash : true)
      : false;

    // 3. 状態更新
    set({
      vtaData: committedSchema,
      ...(committedNodes ? { nodes: committedNodes } : {}),
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
    if (activeDragPreSnapshot) get().cancelNodeDrag();
    const { past, future, vtaData, addLog, regenerationResult, scenarioText } = get();
    if (past.length === 0) return;
    activeDragPreSnapshot = null;
    activeDragOriginalSchema = null;
    activeDragHistoryRecorded = false;
    activeDragNodeIds.clear();
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
    if (activeDragPreSnapshot) get().cancelNodeDrag();
    const { past, future, vtaData, addLog, regenerationResult, scenarioText } = get();
    if (future.length === 0) return;
    activeDragPreSnapshot = null;
    activeDragOriginalSchema = null;
    activeDragHistoryRecorded = false;
    activeDragNodeIds.clear();
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
  onNodesChange: (changes, viewMode = 'detail') => {
    if (ignoreCancelledDragEvents && changes.some((change) => change.type === 'position')) {
      if (changes.some((change) => change.type === 'position' && change.dragging === false)) {
        ignoreCancelledDragEvents = false;
      }
      return;
    }
    if (viewMode === 'compact') {
      const { vtaData, past } = get();
      const uiChanges = changes.filter((change) => change.type !== 'position' && change.type !== 'dimensions');
      if (uiChanges.length) set({ nodes: applyNodeChanges(uiChanges, get().nodes) });
      const layout = calculateVTALayout(vtaData, undefined, undefined, { compact: true, positionField: 'compact_position' });
      const rawNodes = layout.nodes;
      const displayNodes = rawNodes.map((node) => projectDisplayNode(node));
      const positionChanges = changes.filter((change) => change.type === 'position');
      if (!positionChanges.length) return;
      const isDragging = positionChanges.some((change) => change.type === 'position' && change.dragging === true);
      const dragEnded = positionChanges.some((change) => change.type === 'position' && change.dragging === false);
      if ((isDragging || dragEnded) && !activeDragPreSnapshot) {
        activeDragNodeIds.clear();
        activeDragOriginalSchema = JSON.parse(JSON.stringify(vtaData));
        activeDragPreSnapshot = {
          ...JSON.parse(JSON.stringify(vtaData)),
          nodes: vtaData.nodes.map((node) => ({
            ...node,
            compact_position: node.compact_position ?? storedPositions(vtaData, rawNodes).get(node.id),
          })),
        };
        activeDragHistoryRecorded = false;
      }
      positionChanges.forEach((change) => activeDragNodeIds.add(change.id));
      const transformed = positionChanges.map((change) => {
        if (change.type !== 'position' || !change.position) return change;
        const source = displayNodes.find((node) => node.id === change.id);
        const raw = rawNodes.find((node) => node.id === change.id);
        if (!source || !raw || !raw.data.is_hidden) return change;
        return { ...change, position: unprojectDraggedPosition(raw, source, change.position) };
      });
      let updatedNodes = applyNodeChanges(transformed, rawNodes);
      if (dragEnded) {
        if (get().snapToLaneCenter) {
          updatedNodes = snapMovedNodesToLaneCenter(updatedNodes, visibleSchema(vtaData).lanes, activeDragPreSnapshot ? visibleSchema(activeDragPreSnapshot) : null, 'compact_position', activeDragNodeIds);
        }
        updatedNodes = enforceLaneVerticalSpacing(updatedNodes, visibleSchema(vtaData).lanes);
      }
      const updatedSchemaNodes = vtaData.nodes.map((node) => {
        const updated = updatedNodes.find((item) => item.id === node.id);
        return updated ? { ...node, compact_position: canonicalPosition(vtaData, node.lane, updated.position) } : node;
      });
      const nextSchema = { ...vtaData, nodes: updatedSchemaNodes };
      if (dragEnded) {
        const before = activeDragPreSnapshot?.nodes ?? vtaData.nodes;
        const moved = updatedSchemaNodes.some((node) => {
          const old = before.find((item) => item.id === node.id)?.compact_position;
          return old && (Math.abs(old.x - (node.compact_position?.x ?? old.x)) > 0.001 || Math.abs(old.y - (node.compact_position?.y ?? old.y)) > 0.001);
        });
        const newPast = moved && activeDragPreSnapshot ? [...past, activeDragPreSnapshot].slice(-30) : past;
        activeDragPreSnapshot = null;
        activeDragHistoryRecorded = false;
        activeDragNodeIds.clear();
        set({ vtaData: moved ? nextSchema : (activeDragOriginalSchema ?? vtaData), past: newPast, future: moved ? [] : get().future, isDirty: moved || get().isDirty });
        activeDragOriginalSchema = null;
        if (moved) get().saveDraftBackup();
      } else {
        set({ vtaData: nextSchema });
      }
      return;
    }
    const detailDisplayNodes = get().nodes.map(projectDisplayNode);
    changes = changes.flatMap((change) => {
      if (change.type !== 'position' || !change.position) return [change];
      const raw = get().nodes.find((node) => node.id === change.id);
      const display = detailDisplayNodes.find((node) => node.id === change.id);
      if (!raw?.data.is_hidden || !display) return [change];
      return [{ ...change, position: unprojectDraggedPosition(raw, display, change.position) }];
    });
    const currentNodes = get().nodes;
    changes = changes.filter((change) =>
      (change.type !== 'dimensions' && change.type !== 'position') ||
      (change.type === 'position' || !currentNodes.find((node) => node.id === change.id)?.data.is_hidden));
    if (!changes.length) return;

    // Check if position drag is starting or ending
    const isDragging = changes.some(
      (c) => c.type === 'position' && (c as any).dragging === true
    );
    const dragEnded = changes.some(
      (c) => c.type === 'position' && (c as any).dragging === false
    );

    if ((isDragging || dragEnded) && !activeDragPreSnapshot) {
      activeDragNodeIds.clear();
      const { vtaData } = get();
      const snapshot: VTASchema = JSON.parse(JSON.stringify(vtaData));
      snapshot.nodes = snapshot.nodes.map((vn) => {
        if (vn.position) return vn;
        const existing = currentNodes.find((cn) => cn.id === vn.id);
        return existing ? { ...vn, position: canonicalPosition(vtaData, vn.lane, existing.position) } : vn;
      });
      activeDragPreSnapshot = snapshot;
      activeDragOriginalSchema = JSON.parse(JSON.stringify(vtaData));
      activeDragHistoryRecorded = false;
    }

    changes.forEach((change) => { if (change.type === 'position') activeDragNodeIds.add(change.id); });

    let updatedNodes = applyNodeChanges(changes, currentNodes);

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

    if (dragEnded) {
      const { vtaData, past } = get();
      const lanes = visibleSchema(vtaData).lanes;

      if (get().snapToLaneCenter) {
        updatedNodes = snapMovedNodesToLaneCenter(updatedNodes, lanes, activeDragPreSnapshot ? visibleSchema(activeDragPreSnapshot) : null, 'position', activeDragNodeIds);
      }

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

      const adjustedNodes = enforceLaneVerticalSpacing(updatedNodes, lanes).map((n) => ({
        ...n,
        data: { ...n.data, position: { ...n.position } },
      }));

      const syncedVtaNodes = vtaData.nodes.map((vn) => {
        const adj = adjustedNodes.find((an) => an.id === vn.id);
        return adj ? { ...vn, position: canonicalPosition(vtaData, vn.lane, adj.position) } : vn;
      });

      const preNodes = visibleSchema(activeDragPreSnapshot ?? vtaData).nodes;
      const anyNodeMoved = adjustedNodes.some((adj) => {
        const pre =
          preNodes.find((pn) => pn.id === adj.id)?.position ??
          currentNodes.find((cn) => cn.id === adj.id)?.position;
        if (!pre) return true;
        return (
          Math.abs(pre.x - adj.position.x) > 0.001 ||
          Math.abs(pre.y - adj.position.y) > 0.001
        );
      });

      let newPast = past;
      let newFuture = get().future;
      if (anyNodeMoved && !activeDragHistoryRecorded && activeDragPreSnapshot) {
        const snapshot: VTASchema = JSON.parse(JSON.stringify(activeDragPreSnapshot));
        newPast = [...past, snapshot];
        if (newPast.length > 30) {
          newPast.shift();
        }
        newFuture = [];
      }

      activeDragPreSnapshot = null;
      activeDragOriginalSchema = null;
      activeDragHistoryRecorded = false;
      activeDragNodeIds.clear();

      set({
        nodes: adjustedNodes,
        ...(anyNodeMoved ? { vtaData: { ...vtaData, nodes: syncedVtaNodes } } : {}),
        past: newPast,
        future: newFuture,
        ...(anyNodeMoved ? { isDirty: true } : {}),
      });
      if (anyNodeMoved) get().saveDraftBackup();
      return;
    }

    if (dimChanges.length > 0) {
      const { vtaData } = get();
      const lanes = visibleSchema(vtaData).lanes;

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
          return adj ? { ...vn, position: canonicalPosition(vtaData, vn.lane, adj.position) } : vn;
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
    const nextPos = { x: position.x, y: position.y };
    const updatedNodes = vtaData.nodes.map((n) =>
      n.id === nodeId ? { ...n, position: canonicalPosition(vtaData, n.lane, nextPos) } : n
    );
    const updatedReactNodes = nodes.map((n) =>
      n.id === nodeId
        ? { ...n, position: nextPos, data: { ...n.data, position: nextPos } }
        : n
    );
    set({
      vtaData: { ...vtaData, nodes: updatedNodes },
      nodes: updatedReactNodes,
      isDirty: true,
    });
    get().saveDraftBackup();
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
        (se) => !removedEdges.some((re) => (se.id ? re.id === se.id : re.source === se.source && re.target === se.target))
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
        laneDistance: Math.abs(vtaData.lanes.indexOf(srcLane) - vtaData.lanes.indexOf(tgtLane)),
      },
    };

    const newSchemaEdge: import('../../../types/vta').VTAEdgeData = {
      id: edgeId,
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
    ignoreCancelledDragEvents = Boolean(activeDragPreSnapshot);
    activeDragPreSnapshot = null;
    activeDragOriginalSchema = null;
    activeDragHistoryRecorded = false;
    activeDragNodeIds.clear();
    // 既存作業をバックアップスナップショットとして退避 (DATA-003)
    const currentSnapshot = {
      scenarioText: get().scenarioText,
      vtaData: get().vtaData,
      regenerationResult: get().regenerationResult,
    };

    const valRes = validateAndSanitizeVTASchema(schema);
    let sanitizedSchema = valRes.data || schema;
    if (!sanitizedSchema.analysis) sanitizedSchema = projectAnalysis(createManualAnalysis(sanitizedSchema), sanitizedSchema);
    const layout = calculateVTALayout(sanitizedSchema);

    set({
      measuresProposal: null,
      isProposalModalOpen: false,
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
      if ((e.id ? e.id === targetEdge.id : e.source === targetEdge.source && e.target === targetEdge.target)) {
        return { ...e, generated: false, is_break: newBreakState };
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
      if ((e.id ? e.id === targetEdge.id : e.source === targetEdge.source && e.target === targetEdge.target)) {
        return { ...e, generated: false, direction: nextDir };
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
            ...updates, generated: false,
          },
        };
      }
      return e;
    });

    const updatedSchemaEdges = vtaData.edges.map((e) => {
      if ((e.id ? e.id === targetEdge.id : e.source === targetEdge.source && e.target === targetEdge.target)) {
        return {
          ...e,
          ...updates, generated: false,
        };
      }
      return e;
    });

    get().commitVTAChange({
      schema: {
        ...vtaData,
        edges: updatedSchemaEdges,
        presentation: { ...vtaData.presentation, lanes: { ...vtaData.presentation?.lanes }, suppressedCards: { ...vtaData.presentation?.suppressedCards },
          eventNotes: { ...vtaData.presentation?.eventNotes, ...(targetEdge.data?.generated && !targetEdge.data?.relationId && typeof targetEdge.data?.eventId === 'string' && updates.label !== undefined ? { [targetEdge.data.eventId]: updates.label } : {}) } },
      },
      edges: updatedEdges,
    });

    get().addLog('info', `[接続情報更新] 接続 (${targetEdge.source} ➔ ${targetEdge.target}) の情報を更新しました。`, '図面');
  },

  editingEdgeId: null,
  openEdgeEditor: (edgeId) => set({ editingEdgeId: edgeId }),
  closeEdgeEditor: () => set({ editingEdgeId: null }),

  recalculateLayout: () => {
    get().cancelNodeDrag();
    const { vtaData, nodes, compactView } = get();
    const field = compactView ? 'compact_position' : 'position';
    const layout = calculateVTALayout(vtaData, compactView ? undefined : nodes, undefined, { forceRecompute: true, compact: compactView });
    const updatedSchemaNodes = vtaData.nodes.map((n) => {
      const layoutNode = layout.nodes.find((ln) => ln.id === n.id);
      return layoutNode ? { ...n, [field]: canonicalPosition(vtaData, n.lane, layoutNode.position) } : n;
    });
    if (compactView) {
      get().commitVTAChange({ schema: { ...vtaData, nodes: updatedSchemaNodes } });
    } else {
      get().commitVTAChange({ schema: { ...vtaData, nodes: updatedSchemaNodes }, nodes: layout.nodes, edges: layout.edges, laneBounds: layout.laneBounds });
    }
    get().addLog('info', '[レイアウト] 時間軸・時系列順 (BT) に自動整列しました。', '配置');
  },

  getConnectionRepairPlan: () => {
    get().cancelNodeDrag();
    const state = get();
    const mode = state.compactView ? 'compact' : 'detail';
    const viewNodes = mode === 'compact'
      ? calculateVTALayout(state.vtaData, undefined, undefined, { compact: true, positionField: 'compact_position' }).nodes
      : state.nodes;
    return createConnectionRepairPlan(state.vtaData, viewNodes, mode, state.currentProjectId);
  },

  applyConnectionRepair: (sourceSignature) => {
    const plan = get().getConnectionRepairPlan();
    if (plan.sourceSignature !== sourceSignature) {
      get().showToast('warn', '図が変更されました。更新された修正内容を確認してから適用してください。');
      return false;
    }
    if (plan.issues.length) {
      get().showToast('warn', plan.issues[0]);
      return false;
    }
    if (!plan.changes.length && !plan.layoutChanges.length) return true;
    const layout = calculateVTALayout(plan.schema, get().nodes);
    get().commitVTAChange({
      schema: plan.schema,
      edges: layout.edges,
      ...(plan.viewMode === 'compact' && plan.layoutChanges.length ? { nodes: layout.nodes, laneBounds: layout.laneBounds } : {}),
      // Retain the visible manual card positions and selection; only connections change.
      extraState: { editingEdgeId: null },
    });
    const message = `接続を修正しました：追加 ${plan.addedEdges}本、削除 ${plan.removedEdges}本、方向修正 ${plan.correctedDirections}本、他表示の再配置 ${plan.layoutChanges.length}レーン。`;
    get().addLog('success', `[接続自動修正] ${message}`, '図面');
    get().showToast('success', message);
    return true;
  },

  applyConnectionProposals: (projectId, signature, proposals) => {
    const state = get();
    if (state.currentProjectId !== projectId || !state.vtaData.analysis || connectionProposalSignature(state.vtaData) !== signature) {
      get().showToast('warn', '図の意味情報が変更されました。提案を作り直してください。'); return false;
    }
    const errors = validateSelectedConnectionProposals(state.vtaData, proposals);
    if (errors.length) { get().showToast('warn', errors[0]); return false; }
    if (!proposals.length) return false;
    let relations = [...state.vtaData.analysis.relations];
    for (const proposal of proposals) {
      if (proposal.operation === 'refine') {
        relations = relations.filter((relation) => !(relation.sourceEventId === proposal.sourceEventId && relation.targetEventId === proposal.sourceEventId
          && relation.sourceEntityId === proposal.sourceEntityId && relation.targetEntityId === proposal.targetEntityId
          && relation.kind === 'common' && (relation.status === 'unknown' || !relation.status)));
      }
      relations.push({...proposalRelation(proposal),id:'proposal:'+crypto.randomUUID()});
    }
    const analysis = { ...state.vtaData.analysis, relations };
    const schema = projectAnalysis(analysis, state.vtaData);
    get().commitVTAChange({ schema, extraState: { editingEdgeId: null }, preserveDerivedRemovals: true });
    get().addLog('success', `[接続提案] ${proposals.length}件を利用者確認済みの関係として適用しました。`, '図面');
    get().showToast('success', `${proposals.length}件の接続関係を適用しました。`);
    return true;
  },

  autoConnectNodes: async (configOverride) => {
    const state = get();
    if (!state.vtaData.nodes.length) {
      state.showToast('warn', '接続するノードが存在しません。');
      return false;
    }
    const currentProjectId = state.currentProjectId;
    const reqId = `auto_connect_${Date.now()}`;
    state.setActiveRequestId(reqId);
    const controller = state.createAbortController();
    state.setIsExtracting(true);
    state.setGenerationProgress({
      isActive: true,
      mode: 'auto_connect',
      stage: 'preparing',
      stepCurrent: 1,
      stepTotal: 3,
      title: '【1/3】レーン間接続の自動探索',
      detail: '作業依存・資源移動・影響関係の探索と全採択を行っています。',
    });

    try {
      const result = await autoConnectVTA(
        configOverride ?? state.llmConfig,
        state.vtaData,
        controller.signal,
        (prog) => {
          const step = prog.stage === 'inter_lane' ? 1 : prog.stage === 'chain_repair' ? 2 : 3;
          const title =
            step === 1
              ? '【1/3】レーン間接続の自動探索'
              : step === 2
              ? '【2/3】連鎖不足・孤立ノードの補完'
              : '【3/3】同一レーン整流と確定';
          get().setGenerationProgress({
            stepCurrent: step,
            stepTotal: 3,
            title,
            detail: prog.message,
          });
        }
      );

      const latest = get();
      if (
        controller.signal.aborted ||
        latest.currentProjectId !== currentProjectId ||
        latest.activeRequestId !== reqId
      ) {
        return false;
      }

      // Stage 3 スナップショットを更新
      const stage3Nodes = result.schema.nodes.map((n) => ({
        ...n,
        type: (n.type === 'outcome' ? 'outcome' : 'normal') as import('../../../types/vta').VTANodeType,
        variation_factor: undefined,
        measure_type: null,
      }));
      const stage3Snapshot = createPipelineSnapshot(
        'stage3_connect',
        2,
        'Stage 3: ノード自動接続 (autoConnect)',
        `レーン間伝達・前後連鎖エッジ ${result.schema.edges.length}本の探索と補完`,
        '作業依存・資源移動・情報伝達および時系列連鎖をAIで自動探索し、完全な因果ネットワークを結線',
        {
          ...result.schema,
          nodes: stage3Nodes,
        }
      );
      const updatedSchema = {
        ...result.schema,
        pipelineHistory: upsertPipelineSnapshot(latest.vtaData.pipelineHistory, stage3Snapshot),
      };

      // 1コミットで適用
      latest.commitVTAChange({
        schema: updatedSchema,
        preserveDerivedRemovals: true,
      });

      const summaryParts: string[] = [];
      if (result.addedInterLaneConnections > 0) summaryParts.push(`レーン間接続 ${result.addedInterLaneConnections}件`);
      if (result.addedChainConnections > 0) summaryParts.push(`連鎖補完 ${result.addedChainConnections}件`);
      if (result.addedEvents > 0) summaryParts.push(`追加イベント ${result.addedEvents}件`);
      if (result.addedSubjects > 0) summaryParts.push(`追加主体 ${result.addedSubjects}件`);

      const summaryText =
        summaryParts.length > 0
          ? summaryParts.join('、') + 'を自動接続・補完しました。'
          : '新しい接続候補はありませんでした。';
      latest.addLog('success', `[ノード自動接続] ${summaryText}`, '解析');
      latest.showToast('success', summaryText);

      if (result.warnings.length > 0) {
        latest.showToast('warn', result.warnings.join('\n'));
      }
      return true;
    } catch (err: unknown) {
      if (
        controller.signal.aborted ||
        (err instanceof Error && (err.name === 'UserCancelledError' || err.message === 'USER_CANCELLED'))
      ) {
        return false;
      }
      const message = err instanceof Error ? err.message : 'ノード自動接続中にエラーが発生しました。';
      state.setError(message);
      state.showToast('error', `自動接続に失敗しました: ${message}`);
      state.addLog('error', `[ノード自動接続失敗] ${message}`, '解析');
      return false;
    } finally {
      const latest = get();
      if (latest.currentProjectId === currentProjectId && latest.activeRequestId === reqId) {
        latest.setIsExtracting(false);
        latest.resetGenerationProgress();
      }
    }
  },

  reoptimizeVTA: async (configOverride) => {
    const state = get();
    if (!state.vtaData.nodes.length) {
      state.showToast('warn', '最適化するノードが存在しません。');
      return false;
    }
    const currentProjectId = state.currentProjectId;
    const reqId = `reoptimize_${Date.now()}`;
    state.setActiveRequestId(reqId);
    const controller = state.createAbortController();
    state.setIsExtracting(true);
    state.setGenerationProgress({
      isActive: true,
      mode: 'reoptimize',
      stage: 'preparing',
      stepCurrent: 1,
      stepTotal: 2,
      title: '【1/2】VTA最適化の準備',
      detail: '現在のキャンバス状態から粒度・認知負荷の反復レビューを準備しています。',
    });

    try {
      const analysis = state.vtaData.analysis ?? createManualAnalysis(state.vtaData);
      const maxSubjects = state.subjectLimit;

      state.setGenerationProgress({
        stepCurrent: 1,
        stepTotal: 2,
        title: '【1/2】主体粒度・認知負荷の反復レビュー',
        detail: '多目的スコア（C1〜C5）の最適化を実行しています。',
      });

      const refSettings = state.refinementSettings;
      const optimizedSchema = await refineGranularity(
        configOverride ?? state.llmConfig,
        analysis,
        maxSubjects,
        controller.signal,
        callLLMGateway,
        (type, message, stage) => get().addLog(type, message, stage ?? '最適化'),
        refSettings.maxIterations,
        refSettings.targetScore,
        refSettings.epsilon,
        refSettings.weights,
        refSettings.useOneTimeDirective ? refSettings.oneTimeDirective : undefined,
        refSettings.assumptions,
        refSettings.scope,
        state.vtaData
      );
      if (refSettings.useOneTimeDirective) {
        set((s) => ({
          refinementSettings: {
            ...s.refinementSettings,
            useOneTimeDirective: false,
          },
        }));
      }

      const latest = get();
      if (
        controller.signal.aborted ||
        latest.currentProjectId !== currentProjectId ||
        latest.activeRequestId !== reqId
      ) {
        return false;
      }

      // Stage 2 スナップショットを更新
      const stage2Nodes = optimizedSchema.nodes.map((n) => ({
        ...n,
        type: (n.type === 'outcome' ? 'outcome' : 'normal') as import('../../../types/vta').VTANodeType,
        variation_factor: undefined,
        measure_type: null,
      }));
      const stage2Edges = optimizedSchema.edges.filter((e) => !e.generated && !e.id?.startsWith('proposal:'));
      let stage2Desc = '主体重要度ランキングと認知負荷評価に基づくレーン統合・客体化';
      const iterationsList = optimizedSchema.analysis?.normalizationAudit?.iterations;
      if (iterationsList && iterationsList.length > 1) {
        stage2Desc += ` (最適化反復スコア: S=${iterationsList[0].score.toFixed(3)} → S=${iterationsList[iterationsList.length - 1].score.toFixed(3)})`;
      }
      const stage2Snapshot = createPipelineSnapshot(
        'stage2_refine',
        1,
        'Stage 2: 粒度反復最適化 (refined-chain)',
        `主体集約 ${optimizedSchema.lanes.length}列（受動機器の客体分離完了）`,
        stage2Desc,
        {
          ...optimizedSchema,
          nodes: stage2Nodes,
          edges: stage2Edges,
        }
      );
      const schemaWithHistory = {
        ...optimizedSchema,
        pipelineHistory: upsertPipelineSnapshot(latest.vtaData.pipelineHistory, stage2Snapshot),
      };

      // 既存のノード座標（手動ドラッグされた位置）を可能な限り保持
      const layout = calculateVTALayout(schemaWithHistory, latest.nodes);
      latest.commitVTAChange({
        schema: schemaWithHistory,
        nodes: layout.nodes,
        edges: layout.edges,
        laneBounds: layout.laneBounds,
        preserveDerivedRemovals: true,
      });

      const iterations = optimizedSchema.analysis?.normalizationAudit?.iterations ?? [];
      const optScore = iterations.length > 0 ? iterations[iterations.length - 1].score : 0;
      const itCount = iterations.length;
      latest.addLog(
        'success',
        `[VTA最適化] 粒度反復最適化が完了しました（スコア S=${optScore.toFixed(3)}、反復 ${itCount}回）。`,
        '解析'
      );
      latest.showToast('success', `VTA最適化が完了しました（スコア: ${optScore.toFixed(2)}）。`);
      return true;
    } catch (err: unknown) {
      if (
        controller.signal.aborted ||
        (err instanceof Error && (err.name === 'UserCancelledError' || err.message === 'USER_CANCELLED'))
      ) {
        return false;
      }
      const message = err instanceof Error ? err.message : 'VTA最適化中にエラーが発生しました。';
      state.setError(message);
      state.showToast('error', `VTA最適化に失敗しました: ${message}`);
      state.addLog('error', `[VTA最適化失敗] ${message}`, '解析');
      return false;
    } finally {
      const latest = get();
      if (latest.currentProjectId === currentProjectId && latest.activeRequestId === reqId) {
        latest.setIsExtracting(false);
        latest.resetGenerationProgress();
      }
    }
  },

  setLaneVisibility: (entityId, mode) => {
    get().cancelNodeDrag();
    const schema = capturePresentationPositions(get().vtaData, get().nodes);
    if (!schema.analysis?.entities.some((entity) => entity.id === entityId)) return;
    const next = maintainPresentation({ ...schema, presentation: {
      ...schema.presentation, lanes: { ...schema.presentation?.lanes, [entityId]: mode },
      suppressedCards: { ...schema.presentation?.suppressedCards },
    } });
    get().commitVTAChange({ schema: next, extraState: { editingEdgeId: null } });
  },
  setObjectDisplayStyle: (style) => {
    get().cancelNodeDrag();
    const { vtaData } = get();
    const presentation = {
      ...vtaData.presentation,
      lanes: { ...vtaData.presentation?.lanes },
      suppressedCards: { ...vtaData.presentation?.suppressedCards },
      defaultObjectDisplayStyle: style,
    };
    get().commitVTAChange({
      schema: { ...vtaData, presentation },
    });
    get().addLog('info', `[表示設定] 受動客体ノードの表示形式を「${style === 'dot' ? 'ドット表示' : '通常カード表示'}」に変更しました。`);
  },
  toggleLaneDrilldown: (entityId) => {
    get().cancelNodeDrag();
    const { vtaData } = get();
    const currentDrilldown = vtaData.presentation?.drilldownLanes?.[entityId] ?? false;
    get().setLaneDrilldown(entityId, !currentDrilldown);
  },
  setLaneDrilldown: (entityId, enabled) => {
    get().cancelNodeDrag();
    const { vtaData } = get();
    const entity = vtaData.analysis?.entities.find((e) => e.id === entityId);
    const presentation = {
      ...vtaData.presentation,
      lanes: { ...vtaData.presentation?.lanes },
      suppressedCards: { ...vtaData.presentation?.suppressedCards },
      drilldownLanes: {
        ...vtaData.presentation?.drilldownLanes,
        [entityId]: enabled,
      },
    };
    get().commitVTAChange({
      schema: { ...vtaData, presentation },
    });
    const entName = entity?.name ?? entityId;
    get().addLog(
      'info',
      `[ドリルダウン] 主体「${entName}」のサブレーンを${enabled ? '展開' : '集約'}しました。 (ADR-0011)`
    );
  },
  addLane: (name) => {
    name = name.trim();
    const schema = get().vtaData;
    if (!name || schema.lanes.includes(name)) return false;
    const analysis = schema.analysis ?? createManualAnalysis(schema);
    const id = 'manual_entity_' + generateProjectId();
    const next = projectAnalysis({ ...analysis, entities: [...analysis.entities, { id, name, kind: 'other' }] }, {
      ...schema, lanes: [...schema.lanes, name], presentation: { lanes: { ...schema.presentation?.lanes, [id]: 'show' }, suppressedCards: { ...schema.presentation?.suppressedCards } },
    });
    get().commitVTAChange({ schema: next });
    return true;
  },
  simplifyCards: () => {
    get().cancelNodeDrag();
    const schema = capturePresentationPositions(get().vtaData, get().nodes);
    const presentation = planCardSimplification(schema);
    get().commitVTAChange({ schema: { ...schema, presentation } });
    get().addLog('info', '[カード整理] ' + Object.keys(presentation.suppressedCards).length + '枚を表示対象から除外しました。元のイベント・主体は保持しています。');
  },
  applyLaneMergeProposal: (proposal, customTargetName) => {
    get().cancelNodeDrag();
    const { vtaData, subjectLimit, refinementSettings } = get();
    const analysis = vtaData.analysis ?? createManualAnalysis(vtaData);
    const targetName = (customTargetName?.trim() || proposal.suggestedTargetName).trim();
    if (!targetName) return;

    const baseEntities = [...analysis.entities];
    let targetEntity = baseEntities.find((e) => e.name === targetName);
    if (!targetEntity) {
      if (proposal.targetEntityId && baseEntities.some((e) => e.id === proposal.targetEntityId)) {
        targetEntity = baseEntities.find((e) => e.id === proposal.targetEntityId)!;
        targetEntity.name = targetName;
      } else {
        const newId = proposal.targetEntityId ?? `merged_entity_${Date.now()}`;
        targetEntity = {
          id: newId,
          name: targetName,
          kind: proposal.suggestedKind,
        };
        baseEntities.push(targetEntity);
      }
    }

    const updatedEntities = baseEntities.map((e) => {
      if (proposal.sourceEntityIds.includes(e.id)) {
        const currentParents = e.parentEntityIds ?? (e.parentEntityId ? [e.parentEntityId] : []);
        const newParents = Array.from(new Set([...currentParents, targetEntity!.id]));
        return { ...e, parentEntityId: targetEntity!.id, parentEntityIds: newParents };
      }
      return e;
    });

    const workingPoset = SubjectPoset.fromEntities(updatedEntities);
    const workingAnalysis: VTAAnalysisData = {
      ...analysis,
      entities: updatedEntities,
      subjectPoset: workingPoset.toJSON(),
    };

    const explicitMerges = new Map<string, string>();
    for (const srcId of proposal.sourceEntityIds) {
      explicitMerges.set(srcId, targetEntity!.id);
    }

    const consolidated = consolidateSubjects(
      workingAnalysis,
      subjectLimit,
      undefined,
      (msg) => get().addLog('warn', `[レーン統合] ${msg}`, '解析'),
      { explicitMerges }
    );

    const existingPinned = refinementSettings.scope?.pinnedEntityIds ?? [];
    const newPinned = Array.from(new Set([...existingPinned, targetEntity.id]));

    const mergedOutNames = new Set(proposal.sourceEntityNames);
    const targetLanes = Array.from(
      new Set([
        ...vtaData.lanes.map((l) => (mergedOutNames.has(l) ? targetName : l)),
        targetName,
      ])
    ).filter((l) => !mergedOutNames.has(l) || l === targetName);

    const nextSchema = projectAnalysis(consolidated, {
      ...vtaData,
      lanes: targetLanes.length > 0 ? targetLanes : vtaData.lanes,
    });

    const layout = calculateVTALayout(nextSchema, get().nodes);

    get().commitVTAChange({
      schema: nextSchema,
      nodes: layout.nodes,
      edges: layout.edges,
      laneBounds: layout.laneBounds,
      extraState: {
        refinementSettings: {
          ...refinementSettings,
          scope: {
            ...refinementSettings.scope,
            pinnedEntityIds: newPinned,
          },
        },
      },
    });

    get().addLog(
      'info',
      `[レーン統合] ${proposal.sourceEntityNames.join('、')} を「${targetName}」に統合しました。`,
      '解析'
    );
    get().showToast('success', `「${targetName}」への統合を適用しました。`);
  },
  forceMergeLanes: (sourceLane, targetLane) => {
    get().cancelNodeDrag();
    const { vtaData, subjectLimit, refinementSettings } = get();
    const sLane = sourceLane?.trim();
    const tLane = targetLane?.trim();
    if (!sLane || !tLane || sLane === tLane) return;
    if (!vtaData.lanes.includes(sLane)) return;

    const analysis = vtaData.analysis ?? createManualAnalysis(vtaData);
    const baseEntities = [...analysis.entities];

    let targetEntity = baseEntities.find((e) => e.name === tLane);
    if (!targetEntity) {
      const newId = `manual_entity_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      targetEntity = {
        id: newId,
        name: tLane,
        kind: 'other',
      };
      baseEntities.push(targetEntity);
    }

    const sourceEntity = baseEntities.find((e) => e.name === sLane);
    const sourceEntityIds: string[] = sourceEntity ? [sourceEntity.id] : [];

    const updatedEntities = baseEntities.map((e) => {
      if (sourceEntityIds.includes(e.id)) {
        const currentParents = e.parentEntityIds ?? (e.parentEntityId ? [e.parentEntityId] : []);
        const newParents = Array.from(new Set([...currentParents, targetEntity!.id]));
        return { ...e, parentEntityId: targetEntity!.id, parentEntityIds: newParents };
      }
      return e;
    });

    const workingPoset = SubjectPoset.fromEntities(updatedEntities);
    const workingAnalysis: VTAAnalysisData = {
      ...analysis,
      entities: updatedEntities,
      subjectPoset: workingPoset.toJSON(),
    };

    const explicitMerges = new Map<string, string>();
    for (const srcId of sourceEntityIds) {
      explicitMerges.set(srcId, targetEntity!.id);
    }

    const consolidated = consolidateSubjects(
      workingAnalysis,
      subjectLimit,
      undefined,
      (msg) => get().addLog('warn', `[レーン強制統合] ${msg}`, '解析'),
      { explicitMerges }
    );

    const existingPinned = refinementSettings.scope?.pinnedEntityIds ?? [];
    const newPinned = Array.from(new Set([...existingPinned, targetEntity.id]));

    const mergedOutNames = new Set([sLane]);
    const targetLanes = Array.from(
      new Set([
        ...vtaData.lanes.map((l) => (mergedOutNames.has(l) ? tLane : l)),
        tLane,
      ])
    ).filter((l) => !mergedOutNames.has(l) || l === tLane);

    const updatedNodes = vtaData.nodes.map((n) =>
      n.lane === sLane ? { ...n, lane: tLane } : n
    );

    const nextSchema = projectAnalysis(consolidated, {
      ...vtaData,
      lanes: targetLanes.length > 0 ? targetLanes : vtaData.lanes,
      nodes: updatedNodes,
    });

    const layout = calculateVTALayout(nextSchema, get().nodes);

    get().commitVTAChange({
      schema: nextSchema,
      nodes: layout.nodes,
      edges: layout.edges,
      laneBounds: layout.laneBounds,
      extraState: {
        refinementSettings: {
          ...refinementSettings,
          scope: {
            ...refinementSettings.scope,
            pinnedEntityIds: newPinned,
          },
        },
      },
    });

    get().addLog(
      'info',
      `[レーン強制統合] 「${sLane}」の全ノードを「${tLane}」に統合しました。`,
      '解析'
    );
    get().showToast('success', `「${sLane}」を「${tLane}」へ統合しました。`);
  },
  applyLaneSplitProposal: (proposal) => {
    get().cancelNodeDrag();
    const { vtaData, subjectLimit, refinementSettings } = get();
    const analysis = vtaData.analysis ?? createManualAnalysis(vtaData);

    const reverted = revertConsolidation(analysis);
    const existingPinned = refinementSettings.scope?.pinnedEntityIds ?? [];
    const forceRetain = new Set<string>([...existingPinned, ...proposal.splitEntityIds]);

    const reconsolidated = consolidateSubjects(
      reverted,
      subjectLimit,
      undefined,
      (msg) => get().addLog('warn', `[レーン分割] ${msg}`, '解析'),
      { forceRetain }
    );

    const newPinned = Array.from(forceRetain);

    const targetLanes = Array.from(
      new Set(
        reconsolidated.entities
          .filter((e) => !reconsolidated.subjectRanking?.ranks.find((r) => r.entityId === e.id && !r.retained))
          .map((e) => e.name)
      )
    );
    const nextSchema = projectAnalysis(reconsolidated, {
      ...vtaData,
      lanes: targetLanes.length > 0 ? targetLanes : vtaData.lanes,
    });

    const layout = calculateVTALayout(nextSchema, get().nodes);

    get().commitVTAChange({
      schema: nextSchema,
      nodes: layout.nodes,
      edges: layout.edges,
      laneBounds: layout.laneBounds,
      extraState: {
        refinementSettings: {
          ...refinementSettings,
          scope: {
            ...refinementSettings.scope,
            pinnedEntityIds: newPinned,
          },
        },
      },
    });

    get().addLog(
      'info',
      `[レーン分割] 「${proposal.parentEntityName}」から ${proposal.splitEntityNames.join('、')} を独立レーンとして展開しました。`,
      '解析'
    );
    get().showToast('success', `${proposal.splitEntityNames.join('、')} を独立レーンとして展開しました。`);
  },
  moveLane: (laneName, direction) => {
    const { vtaData, nodes } = get();
    const fromIndex = vtaData.lanes.indexOf(laneName);
    const toIndex = fromIndex + direction;
    if ((direction !== -1 && direction !== 1) || fromIndex < 0 || toIndex < 0 || toIndex >= vtaData.lanes.length) return;

    const lanes = [...vtaData.lanes];
    [lanes[fromIndex], lanes[toIndex]] = [lanes[toIndex], lanes[fromIndex]];
    const oldIndexByLane = new Map(vtaData.lanes.map((name, index) => [name, index]));
    const newIndexByLane = new Map(lanes.map((name, index) => [name, index]));
    const compactLayout = calculateVTALayout(vtaData, undefined, undefined, { compact: true, positionField: 'compact_position' });
    const displayedPositionById = storedPositions(vtaData, nodes);
    const compactPositionById = storedPositions(vtaData, compactLayout.nodes);
    const shiftedNodes = vtaData.nodes.map((node) => {
      const oldIndex = oldIndexByLane.get(node.lane);
      const newIndex = newIndexByLane.get(node.lane);
      const position = node.position ?? displayedPositionById.get(node.id);
      const compactPosition = node.compact_position ?? compactPositionById.get(node.id);
      if (oldIndex === undefined || newIndex === undefined) return node;
      return {
        ...node,
        ...(position ? { position: { x: position.x + (newIndex - oldIndex) * LANE_WIDTH, y: position.y } } : {}),
        ...(compactPosition ? { compact_position: { x: compactPosition.x + (newIndex - oldIndex) * LANE_WIDTH, y: compactPosition.y } } : {}),
      };
    });
    const schema = { ...vtaData, lanes, nodes: shiftedNodes };
    const layout = calculateVTALayout(schema);
    const compactShifted = calculateVTALayout(schema, undefined, undefined, { compact: true, positionField: 'compact_position' });
    const layoutPositionById = storedPositions(schema, layout.nodes);
    const compactLayoutPositionById = storedPositions(schema, compactShifted.nodes);
    get().commitVTAChange({
      schema: {
        ...schema,
        nodes: shiftedNodes.map((node) => {
          const position = layoutPositionById.get(node.id);
          const compactPosition = compactLayoutPositionById.get(node.id);
          return { ...node, ...(position ? { position: { ...position } } : {}), ...(compactPosition ? { compact_position: { ...compactPosition } } : {}) };
        }),
      },
      nodes: layout.nodes,
      edges: layout.edges,
      laneBounds: layout.laneBounds,
    });
    get().addLog('info', `[列順序] 「${laneName}」を${direction < 0 ? '左' : '右'}へ移動しました。`, '配置');
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
    const initialLayout = calculateVTALayout(updatedSchema, nodes);
    const spacedNodes = enforceLaneVerticalSpacing(initialLayout.nodes, lanes);
    const spacedPositionById = storedPositions(updatedSchema, spacedNodes);
    const detailedSchema = {
      ...updatedSchema,
      nodes: updatedSchema.nodes.map((node) => ({ ...node, position: spacedPositionById.get(node.id) ?? node.position })),
    };
    const layout = calculateVTALayout(detailedSchema, undefined, undefined, { positionField: 'position' });
    const compactInitial = calculateVTALayout(updatedSchema, undefined, undefined, { compact: true, forceRecompute: true });
    const compactSeed = {
      ...updatedSchema,
      nodes: updatedSchema.nodes.map((node) => ({
        ...node,
        compact_position: node.compact_position ?? storedPositions(updatedSchema, compactInitial.nodes).get(node.id),
      })),
    };
    const compactLayout = calculateVTALayout(compactSeed, undefined, undefined, { compact: true, positionField: 'compact_position' });
    const compactAdjusted = enforceLaneVerticalSpacing(compactLayout.nodes, lanes);
    const compactById = storedPositions(updatedSchema, compactAdjusted);
    const nodesWithPos = updatedSchema.nodes.map((n) => {
      const ln = layout.nodes.find((item) => item.id === n.id);
      const compactPosition = compactById.get(n.id);
      return { ...n, ...(ln ? { position: canonicalPosition(updatedSchema, n.lane, ln.position) } : {}), ...(compactPosition ? { compact_position: { ...compactPosition } } : {}) };
    });

    get().commitVTAChange({
      schema: { ...updatedSchema, nodes: nodesWithPos },
      nodes: layout.nodes,
      edges: layout.edges,
      laneBounds: layout.laneBounds,
    });
    get().addLog('success', `[ノード追加] 「${newNode.title}」(${newNode.lane}) を追加しました。`);
  },

  setNodeHidden: (nodeId, hidden) => {
    const node = get().vtaData.nodes.find((item) => item.id === nodeId);
    if (node && Boolean(node.is_hidden) !== hidden) get().updateNode(nodeId, { is_hidden: hidden });
  },

  updateNode: (nodeId, updates) => {
    const { vtaData, nodes } = get();
    const targetNode = vtaData.nodes.find((n) => n.id === nodeId);
    if (!targetNode) return;

    const visibilityChanged = updates.is_hidden !== undefined && Boolean(updates.is_hidden) !== Boolean(targetNode.is_hidden);
    const compactBefore = calculateVTALayout(vtaData, undefined, undefined, { compact: true, positionField: 'compact_position' });
    const detailPositionById = storedPositions(vtaData, nodes);
    const compactPositionById = storedPositions(vtaData, compactBefore.nodes);
    if (visibilityChanged) {
      const current = nodes.find((node) => node.id === nodeId);
      const pointOrCard = current;
      updates = { ...updates, hidden_card_height: updates.is_hidden
        ? current?.measured?.height ?? current?.data.measuredHeight : undefined };
      if (updates.is_hidden === false && pointOrCard) {
        const rect = getDisplayRect(pointOrCard);
        const nextData = { ...targetNode, ...updates, is_hidden: false };
        const height = estimateNodeHeight(nextData);
        updates = { ...updates, position: canonicalPosition(vtaData, targetNode.lane, { x: rect.x + rect.width / 2 - NODE_WIDTH / 2, y: rect.y + rect.height / 2 - height / 2 }) };
        const compactPoint = compactBefore.nodes.find((node) => node.id === nodeId);
        if (compactPoint) {
          const compactRect = getDisplayRect(compactPoint);
          updates = { ...updates, compact_position: canonicalPosition(vtaData, targetNode.lane, {
            x: compactRect.x + compactRect.width / 2 - NODE_WIDTH / 2,
            y: compactRect.y + compactRect.height / 2 - compactNodeHeight(nextData.title) / 2,
          }) };
        }
      }
    }

    const updatedNodes = vtaData.nodes.map((n) => {
      let next = { ...n };
      if (visibilityChanged) {
        next.position ??= detailPositionById.get(n.id);
        next.compact_position ??= compactPositionById.get(n.id);
      }
      if (n.id === nodeId) next = { ...next, ...updates };
      if (n.id === nodeId && n.is_hidden && !visibilityChanged && updates.title !== undefined && updates.title !== n.title) {
        const oldHeight = compactNodeHeight(n.title);
        const newHeight = compactNodeHeight(updates.title);
        const oldPosition = next.compact_position ?? compactPositionById.get(n.id);
        if (oldPosition) next.compact_position = { ...oldPosition, y: oldPosition.y + (oldHeight - newHeight) / 2 };
      }
      return next;
    });
    const allLanes = Array.from(
      new Set([...vtaData.lanes, ...updatedNodes.map((n) => n.lane)])
    );
    let updatedSchema: VTASchema = {
      ...vtaData,
      lanes: allLanes,
      nodes: updatedNodes,
    };

    if (updates.title !== undefined && updates.title !== targetNode.title) {
      const compactLayout = calculateVTALayout(updatedSchema, undefined, undefined, { compact: true, positionField: 'compact_position' });
      const compactAdjusted = enforceLaneVerticalSpacing(compactLayout.nodes, allLanes);
      const compactById = storedPositions(updatedSchema, compactAdjusted);
      updatedSchema = {
        ...updatedSchema,
        nodes: updatedSchema.nodes.map((node) => {
          const position = compactById.get(node.id);
          return position ? { ...node, compact_position: { ...position } } : node;
        }),
      };
    }

    const laneChanged = updates.lane && updates.lane !== targetNode.lane;
    const laneCountChanged = allLanes.length !== vtaData.lanes.length;

    if (laneChanged || laneCountChanged) {
      const oldLaneIndex = vtaData.lanes.indexOf(targetNode.lane);
      const newLaneIndex = allLanes.indexOf(updatedSchema.nodes.find((node) => node.id === nodeId)?.lane ?? targetNode.lane);
      const laneDelta = (newLaneIndex - Math.max(0, oldLaneIndex)) * LANE_WIDTH;
      const shifted = updatedSchema.nodes.map((node) => node.id === nodeId ? {
        ...node,
        ...(node.position ? { position: { ...node.position, x: node.position.x + laneDelta } } : {}),
        ...(node.compact_position ? { compact_position: { ...node.compact_position, x: node.compact_position.x + laneDelta } } : {}),
      } : node);
      const shiftedSchema = { ...updatedSchema, nodes: shifted };
      const initialLayout = calculateVTALayout(shiftedSchema, nodes.filter((n) => n.id !== nodeId));
      const spacedNodes = enforceLaneVerticalSpacing(initialLayout.nodes, allLanes);
      const spacedPositionById = storedPositions(shiftedSchema, spacedNodes);
      const detailedSchema = {
        ...shiftedSchema,
        nodes: shiftedSchema.nodes.map((node) => ({ ...node, position: spacedPositionById.get(node.id) ?? node.position })),
      };
      const layout = calculateVTALayout(detailedSchema, undefined, undefined, { positionField: 'position' });
      const compactLayout = calculateVTALayout(shiftedSchema, undefined, undefined, { compact: true, positionField: 'compact_position' });
      const compactById = storedPositions(shiftedSchema, compactLayout.nodes);
      const nodesWithPos = shiftedSchema.nodes.map((n) => {
        const ln = layout.nodes.find((item) => item.id === n.id);
        const compactPosition = n.compact_position ?? compactById.get(n.id);
        return { ...n, ...(ln ? { position: canonicalPosition(shiftedSchema, n.lane, ln.position) } : {}), ...(compactPosition ? { compact_position: { ...compactPosition } } : {}) };
      });

      get().commitVTAChange({
        schema: { ...shiftedSchema, nodes: nodesWithPos },
        nodes: layout.nodes,
        edges: layout.edges,
        laneBounds: layout.laneBounds,
      });
    } else {
      // 時刻・本文の編集では、ユーザーが手動で調整した座標を維持する。
      const updatedReactNodes = nodes.map((node) => {
        if (node.id === nodeId) {
          const savedNode = updatedSchema.nodes.find((item) => item.id === nodeId)!;
          const position = savedNode.position ?? node.position;
          const restoredHeight = visibilityChanged && !savedNode.is_hidden
            ? estimateNodeHeight(savedNode) : undefined;
          return {
            ...node,
            position: { ...position },
            ...(restoredHeight ? { measured: { width: NODE_WIDTH, height: restoredHeight } } : {}),
            data: {
              ...node.data,
              ...updates,
              position: { ...position },
              compact_position: savedNode.compact_position,
              ...(restoredHeight ? { measuredHeight: restoredHeight } : {}),
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
      (e) => !((e.id ? e.id === targetEdge.id : e.source === targetEdge.source && e.target === targetEdge.target))
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
      skipLayout: !vtaData.presentation?.suppressedCards?.[nodeId],
    });
  },

  updateSupplementarySummary: (summary) => {
    const { vtaData } = get();
    get().commitVTAChange({
      schema: { ...vtaData, supplementary_summary: summary },
      skipHistory: true,
      skipLayout: true,
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
      skipLayout: true,
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
      skipLayout: !('nodeId' in updates),
    });
  },

  deleteCustomNote: (id) => {
    const { vtaData } = get();
    const hasLinkedNode = Boolean((vtaData.custom_notes || []).find((n) => n.id === id)?.nodeId);
    const custom_notes = (vtaData.custom_notes || []).filter((n) => n.id !== id);
    get().commitVTAChange({
      schema: { ...vtaData, custom_notes },
      skipLayout: !hasLinkedNode,
    });
    get().addLog('warn', `[補足メモ削除] 補足メモを削除しました。`);
  },

  // Project File Save (Export)
  exportProjectJSON: (filename) => {
    const { scenarioText, vtaData, regenerationResult, llmConfig } = get();
    const projectData: import('../../../types/vta').VTAProjectFile = {
      version: '5.0',
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

  isAnimationPlayerOpen: false,
  openAnimationPlayer: () => set({ isAnimationPlayerOpen: true }),
  closeAnimationPlayer: () => set({ isAnimationPlayerOpen: false }),

  isNormalizationAuditExportModalOpen: false,
  normalizationAuditTargetAnalysis: null,
  openNormalizationAuditExportModal: (analysis) =>
    set({
      isNormalizationAuditExportModalOpen: true,
      normalizationAuditTargetAnalysis: analysis ?? null,
    }),
  closeNormalizationAuditExportModal: () =>
    set({
      isNormalizationAuditExportModalOpen: false,
      normalizationAuditTargetAnalysis: null,
    }),

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

  exportAnimatedVTASVG: (options) => {
    const { vtaData, nodes, edges, laneBounds, scenarioText, addLog, showToast } = get();
    try {
      const res = exportAnimatedVTAToSVGFile(vtaData, nodes, edges, laneBounds, {
        scenarioText,
        ...options,
      });
      addLog('success', `[Animated SVG出力] 動的ベクターSVGを出力しました (${res.filename})`, 'エクスポート');
      showToast('success', `Animated SVG「${res.filename}」を出力しました。`);
      return res;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog('error', `[Animated SVG出力失敗] ${msg}`, 'エクスポート');
      showToast('error', `Animated SVG出力に失敗しました: ${msg}`);
      throw err;
    }
  },

  // Project File Load (Import)
  importProjectJSON: (jsonString: string) => {
    try {
      get().cancelNodeDrag();
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
          measuresProposal: null,
          isProposalModalOpen: false,
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
          llmConfig: typeof project.selectedModel === 'string' && project.selectedModel.trim() !== ''
            ? { ...get().llmConfig, selectedModel: project.selectedModel.trim() }
            : get().llmConfig,
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
        throw new Error('この図データ形式には対応していません。新形式（2.0）のプロジェクトを指定してください。');
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
  setGenerationProgress: (progress) => {
    if (progress.isActive) capturePreProgressFocus();
    set((state) => ({
      generationProgress: { ...state.generationProgress, ...progress },
    }));
  },
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
  setIsProposing: (val) => {
    if (val) capturePreProgressFocus();
    set({ isProposing: val });
  },
  setIsProposalModalOpen: (val) => set({ isProposalModalOpen: val }),
  setMeasuresProposal: (res) => set({ measuresProposal: res }),

  applyMeasuresProposal: (selectedEliminationNodeIds, selectedBreakPairs) => {
    const { vtaData, nodes, edges, addLog } = get();
    const safePairs = selectedBreakPairs.filter((pair) => vtaData.edges.filter((edge) => edge.source === pair.source && edge.target === pair.target).length === 1);
    if (safePairs.length !== selectedBreakPairs.length) get().showToast('warn', '同じ端点に複数の関係があります。対象の線を個別に編集してください。');
    selectedBreakPairs = safePairs;

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
    debugRecorder.record('operation',()=>({type,message,stageTag}),undefined,[get().llmConfig.gatewayToken??'']);
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

  setIsExtracting: (val) => {
    if (val) capturePreProgressFocus();
    set({ isExtracting: val });
  },
  setIsRegenerating: (val) => {
    if (val) capturePreProgressFocus();
    set({ isRegenerating: val });
  },
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
        version: '5.0',
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
      if (parsed?.version === '5.0' && parsed.vtaData?.analysis && Array.isArray(parsed.vtaData.nodes)) {
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
      if (!parsed || parsed.version !== '5.0' || !parsed.vtaData?.analysis) return false;
      const validation = validateAndSanitizeVTASchema(parsed.vtaData, true);
      if (!validation.isValid || !validation.data) return false;
      parsed.vtaData = validation.data;
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
    capturePreProgressFocus();
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

// Capture committed graph changes (including import, adoption, deletion and undo).
useVTAStore.subscribe((state,previous)=>{
  if(!activeDragPreSnapshot&&(state.vtaData!==previous.vtaData||state.currentProjectId!==previous.currentProjectId)) {
    debugRecorder.record('project.snapshot',()=>({projectId:state.currentProjectId,scenarioText:state.scenarioText,schema:state.vtaData}),undefined,[state.llmConfig.gatewayToken??'']);
  }
});
