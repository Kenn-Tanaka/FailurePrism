import type { Node, Edge } from '@xyflow/react';

/**
 * Node measure types
 * elimination: 排除ノード (○印)
 */
export type MeasureType = 'elimination' | null;

/**
 * Node action classification
 * normal: 通常作業（細枠線）
 * variation: 変動要因（太枠線）
 */
export type VTANodeType = 'normal' | 'variation';

/**
 * Supplementary note item for custom / specific observations
 */
export interface SupplementaryNoteItem {
  id: string;
  nodeId?: string;
  title: string;
  content: string;
}

/**
 * Single Node representation in the VTA Data Schema
 */
export interface VTANodeData {
  id: string;
  lane: string;
  time: string;
  type: VTANodeType;
  title: string;
  description: string;
  measure_type: MeasureType;
  sequence_order?: number; // 時系列の前後順位（0, 1, 2...）
  supplementary_note?: string; // 補足説明（背景要因、ヒューマンファクタ、設備状況、心理的要因など）
  position?: { x: number; y: number }; // 手動配置座標 (ユーザーがドラッグ移動した座標を保持・保存)
}

/**
 * Edge transmission direction type
 * sequential: 同レーン内の時系列・因果関係 (上方向)
 * unidirectional: レーン間の一方向情報伝達 (一方向矢印 ──▶)
 * bidirectional: レーン間の双方向情報伝達・相互確認 (双方向矢印 ◀──▶)
 */
export type EdgeDirection = 'sequential' | 'unidirectional' | 'bidirectional';

/**
 * Edge category / classification type
 * 各接続の性質を分類（中立的に扱い、因果関係を自動断定しない）
 */
export type EdgeCategory =
  | 'information' // 情報・指示・連絡
  | 'material'    // 物・機材・現品
  | 'person'      // 人・移動
  | 'handover'    // 作業引継ぎ・交代
  | 'impact'      // 物理的影響・波及
  | 'sequential'  // 時系列・手順順序
  | 'other';      // その他・未分類

/**
 * Single Edge representation in the VTA Data Schema
 */
export interface VTAEdgeData {
  source: string;
  target: string;
  is_break?: boolean;
  direction?: EdgeDirection;
  label?: string;
  category?: EdgeCategory;
}

/**
 * Core JSON Schema exchanged between LLM and React Flow
 */
export interface VTASchema {
  lanes: string[];
  nodes: VTANodeData[];
  edges: VTAEdgeData[];
  supplementary_summary?: string; // 全体的な背景要因・組織的コンテキストの補足総括
  custom_notes?: SupplementaryNoteItem[]; // ユーザーが追加した自由形式の補足メモ
}

/**
 * React Flow custom node data payload
 */
export interface VTAReactFlowNodeData extends Record<string, unknown> {
  id: string;
  lane: string;
  time: string;
  type: VTANodeType;
  title: string;
  description: string;
  measure_type: MeasureType;
  supplementary_note?: string;
  position?: { x: number; y: number };
  measuredHeight?: number;
  onToggleElimination?: (id: string) => void;
  onEditNode?: (node: VTANodeData) => void;
  onDeleteNode?: (id: string) => void;
}

export type VTAReactFlowNode = Node<VTAReactFlowNodeData>;

/**
 * React Flow custom edge data payload
 */
export interface VTAReactFlowEdgeData extends Record<string, unknown> {
  is_break?: boolean;
  direction?: EdgeDirection;
  is_cross_lane?: boolean;
  sourceLane?: string;
  targetLane?: string;
  label?: string;
  category?: EdgeCategory;
  onToggleBreak?: (edgeId: string) => void;
  onToggleDirection?: (edgeId: string) => void;
}

export type VTAReactFlowEdge = Edge<VTAReactFlowEdgeData>;

/**
 * LLM Gateway Configuration
 */
export interface LLMConfig {
  baseUrl: string;
  gatewayToken: string;
  selectedModel: string;
  timeoutSeconds?: number; // タイムアウト秒数 (デフォルト: 180秒)
}

/**
 * Customizable Prompt Item Definition
 */
export interface PromptItem {
  systemPrompt: string;
  userPromptTemplate: string;
}

/**
 * Global LLM Prompt Configuration schema (loaded from prompts.json)
 */
export interface PromptConfig {
  version?: string;
  extraction: PromptItem;
  regeneration: PromptItem;
  proposal: PromptItem;
  flowGeneration?: PromptItem;
  reportGeneration?: PromptItem;
}

/**
 * Result of Scenario Re-generation
 */
export interface RegenerationResult {
  idealFlow: string;      // フェーズ1: 対策が施された改善された業務フロー
  analysisReport: string; // フェーズ2: 分析・対策レポート
  generatedAt: string;
  sourceHash?: string;    // レポート生成元のVTAデータ構造ハッシュ（最新性判定用）
}

/**
 * Layout calculation configuration
 */
export interface LayoutOptions {
  nodeWidth: number;
  nodeHeight: number;
  laneWidth: number;
  rankSep: number;
  nodeSep: number;
}

/**
 * Real-time Execution & Debug Log Entry
 */
export interface LogEntry {
  id: string;
  timestamp: string;
  type: 'info' | 'success' | 'warn' | 'error';
  message: string;
  stageTag?: string; // e.g. '準備', '通信', '解析', '描画', '再生成'
}

/**
 * Generation Progress State for visual indicators
 */
export type GenerationStage =
  | 'idle'
  | 'preparing'      // リクエスト準備中
  | 'calling_llm'    // Gateway送信・推論待機中
  | 'parsing'        // JSON構文解析・スキーマ検証
  | 'layouting'      // BT自動レイアウト計算中
  | 'completed'      // 完了
  | 'error';         // エラー発生

export interface GenerationProgress {
  isActive: boolean;
  mode: 'extract' | 'regenerate' | null;
  stage: GenerationStage;
  title: string;
  detail: string;
  stepCurrent: number;
  stepTotal: number;
  elapsedSeconds: number;
}

export interface EliminationProposal {
  nodeId: string;
  nodeTitle: string;
  lane: string;
  reason: string;
  recommendedAction: string;
}

export interface BreakProposal {
  sourceNodeId: string;
  targetNodeId: string;
  sourceTitle: string;
  targetTitle: string;
  reason: string;
  recommendedBarrier: string;
}

export interface MeasuresProposalResult {
  summary: string;
  eliminationProposals: EliminationProposal[];
  breakProposals: BreakProposal[];
  generatedAt: string;
}

/**
 * Unified Project File Schema (.json) for saving & restoring work sessions
 */
export interface VTAProjectFile {
  version: '1.0';
  projectName?: string;
  savedAt: string;
  scenarioText: string;
  vtaData: VTASchema;
  regenerationResult?: RegenerationResult | null;
  measuresProposal?: MeasuresProposalResult | null;
  selectedModel?: string;
}

/**
 * UI Toast Notification Item (UI-002)
 */
export interface ToastItem {
  id: string;
  type: 'success' | 'error' | 'info' | 'warn';
  message: string;
}
