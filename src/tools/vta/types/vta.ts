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
export type VTANodeType = 'normal' | 'variation' | 'unclassified' | 'undetermined';

export interface VTASourceRef {
  sourceId: string;
  paragraphId: string;
}

export interface VTAEvidenceRef {
  sourceId: string;
  paragraphId: string;
  quote: string;
}

export interface VTASource {
  id: string;
  text: string;
  paragraphs: Array<{ id: string; text: string }>;
}

export interface VTAFact {
  id: string;
  text: string;
  kind: 'recorded' | 'claim' | 'assessment';
  evidence: VTAEvidenceRef[];
}

export type VTAAuditKind = 'alias_unification' | 'typo_fix';

/** A unification or obvious-typo correction made by the normalizer. Always tied to the original text. */
export interface VTATextCorrection {
  id: string;
  kind: VTAAuditKind;
  from: string;
  to: string;
  sourceRefs: VTASourceRef[];
  reason: string;
  detectedBy: 'llm';
}

export type VTASubjectiveTreatment = 'evaluative_word_removed' | 'kept_as_quoted_claim' | 'action_only';

/** A subjective or judgmental expression found in the source. Recorded, never blocks processing. */
export interface VTASubjectiveNotice {
  id: string;
  sourceRefs: VTASourceRef[];
  phrase: string;
  treatment?: VTASubjectiveTreatment;
  eventIds: string[];
  detectedBy: 'app' | 'llm' | 'both';
}

/** Provisional classification used only as a hint; never adopted automatically. */
export interface VTAPreliminaryClassification {
  value: 'normal' | 'variation' | 'undetermined';
  reason: string;
  sourceRefs: VTASourceRef[];
}

export interface VTARefinementIteration {
  index: number;
  score: number;
  metrics: { c1: number; c2?: number; c3: number; c4?: number; c5: number };
  gateViolations: string[];
  operations: string[];
  adopted: boolean;
}

export interface VTANormalizationAudit {
  version: 1;
  corrections: VTATextCorrection[];
  subjectiveNotices: VTASubjectiveNotice[];
  iterations?: VTARefinementIteration[];
}

export interface VTAEvent {
  sourceRefs?: VTASourceRef[];
  recordKind?: 'recorded' | 'claim' | 'assessment';
  classificationSourceRefs?: VTASourceRef[];
  preliminary?: VTAPreliminaryClassification;
  id: string;
  origin?: 'extraction' | 'manual';
  title: string;
  description: string;
  time: string;
  sourceOrder: number;
  factIds: string[];
  classification: VTANodeType;
  classificationReason?: string;
  classificationFactIds?: string[];
  measure_type?: MeasureType;
}

export type VTASubjectFocus = 'reporter' | 'high' | 'mid' | 'low';

export interface VTAEntity {
  resolution?: 'unresolved';
  id: string;
  name: string;
  kind: 'person' | 'organization' | 'machine' | 'other';
  focus?: VTASubjectFocus;
  parentEntityId?: string;
  focusSourceRefs?: VTASourceRef[];
  aggregate?: true;
}

export interface VTAParticipation {
  inferred?: boolean;
  evidenceBasis?: 'recorded'|'source-context'|'user';
  sourceRefs?: VTASourceRef[];
  reason?: string;
  generation?: GenerationProvenance;
  eventId: string;
  entityId: string;
  role: 'actor' | 'target' | 'affected' | 'intended_recipient' | 'confirmed_recipient';
  factIds: string[];
  origin?: 'extraction' | 'manual';
  mergedFrom?: Array<{ entityId: string; role: VTAParticipation['role'] }>;
}

export interface VTACardRef {
  id: string;
  laneEntityId: string;
  eventIds: string[];
}

export interface VTAEventRelation {
  explanation?: string;
  evidenceBasis?: 'recorded'|'source-assessment'|'source-context'|'user';
  generation?: GenerationProvenance;
  id?: string;
  resource?: string;
  status?: 'occurred' | 'omitted' | 'unknown';
  receipt?: 'confirmed' | 'unconfirmed' | 'na';
  sourceRefs?: VTASourceRef[];
  sourceEventId: string;
  targetEventId: string;
  sourceEntityId?: string;
  targetEntityId?: string;
  sourceEntityOrigin?: string;
  targetEntityOrigin?: string;
  kind: 'before' | 'transfer' | 'impact' | 'mutual' | 'common' | 'dependency';
  factIds: string[];
  proposalId?: string;
  proposalReason?: string;
  adoptionReason?: string;
  provenance?: 'llm-proposal' | 'user';
}

export interface VTASubjectRankEntry {
  entityId: string;
  rank: number;
  score: number;
  breakdown: Record<'A' | 'O' | 'F' | 'C' | 'T', number>;
  priority?: 'reporter' | 'outcome-actor';
  retained: boolean;
  mergedInto?: string;
  reason: string;
}

export interface VTASubjectRanking {
  version: 1;
  maxSubjects: number;
  weights: Record<'A' | 'O' | 'F' | 'C' | 'T', number>;
  originalEntities: VTAEntity[];
  ranks: VTASubjectRankEntry[];
  warning?: string;
}

export interface GenerationProvenance { runId: string; schemeId: string; schemeVersion: string; ruleVersion: string; model: string; promptFingerprint: string; inputFingerprint: string; }
export interface VTAAnalysisData {
  outcome?: { status: 'identified'|'not_found'|'uncertain'; eventIds:string[]; sourceRefs:VTASourceRef[]; reason:string };
  context?: { selectedTargetEventIds:string[]; objective?:string };
  subjectRanking?: VTASubjectRanking;
  normalizationAudit?: VTANormalizationAudit;
  generation?: GenerationProvenance;
  generationRuns?: GenerationProvenance[];
  version: 5;
  sources: VTASource[];
  facts: VTAFact[];
  events: VTAEvent[];
  entities: VTAEntity[];
  participations: VTAParticipation[];
  relations: VTAEventRelation[];
  cards: VTACardRef[];
  unassignedEventIds: string[];
  dispositions?: VTASourceDisposition[];
}

export interface VTASourceDisposition extends VTAEvidenceRef {
  /** LLM summary; quote is empty for direct-source records. */
  text?: string;
  sourceRefs?: VTASourceRef[];
  id: string;
  kind: 'background' | 'excluded' | 'review';
  reason: string;
}

export interface VTAPresentation {
  /** Keys are entity IDs, independent of lane names and visual order. */
  lanes: Record<string, 'auto' | 'show' | 'hide'>;
  suppressedCards: Record<string, string>;
  omittedEdges?: string[];
  omittedDependencies?: string[];
  eventNotes?: Record<string, string>;
}

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
  /** A card can display one event or an explicitly unordered event group. */
  event_ids?: string[];
  lane: string;
  time: string;
  type: VTANodeType;
  title: string;
  description: string;
  measure_type: MeasureType;
  /** User-controlled presentation only; retain this node and every connection. */
  is_hidden?: boolean;
  /** Card height captured when hidden, preserving its center across save/load. */
  hidden_card_height?: number;
  sequence_order?: number; // 時系列の前後順位（0, 1, 2...）
  supplementary_note?: string; // 補足説明（背景要因、ヒューマンファクタ、設備状況、心理的要因など）
  position?: { x: number; y: number }; // 手動配置座標 (ユーザーがドラッグ移動した座標を保持・保存)
  compact_position?: { x: number; y: number }; // 見出しのみ表示の手動配置
}

/**
 * Edge transmission direction type
 * sequential: 同レーン内の時系列・因果関係 (上方向)
 * unidirectional: レーン間の一方向情報伝達 (一方向矢印 ──▶)
 * bidirectional: レーン間の双方向情報伝達・相互確認 (双方向矢印 ◀──▶)
 */
export type EdgeDirection = 'sequential' | 'unidirectional' | 'bidirectional' | 'undirected';

/**
 * Edge category / classification type
 * 各接続の性質を分類（中立的に扱い、因果関係を自動断定しない）
 */
export type EdgeCategory = 'dependency'
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
  meaning?: 'transfer' | 'impact' | 'mutual' | 'common' | 'dependency' | 'association';
  id?: string;
  eventId?: string;
  relationId?: string;
  generated?: boolean;
  status?: 'occurred' | 'omitted' | 'unknown';
  receipt?: 'confirmed' | 'unconfirmed' | 'na';
  resource?: string;
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
  analysis?: VTAAnalysisData;
  presentation?: VTAPresentation;
  supplementary_summary?: string; // 全体的な背景要因・組織的コンテキストの補足総括
  custom_notes?: SupplementaryNoteItem[]; // ユーザーが追加した自由形式の補足メモ
}

/**
 * React Flow custom node data payload
 */
export interface VTAReactFlowNodeData extends Record<string, unknown> {
  id: string;
  event_ids?: string[];
  lane: string;
  time: string;
  type: VTANodeType;
  title: string;
  description: string;
  measure_type: MeasureType;
  is_hidden?: boolean;
  hidden_card_height?: number;
  supplementary_note?: string;
  position?: { x: number; y: number };
  compact_position?: { x: number; y: number };
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
  status?: string;
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
  normalization?: PromptItem;
  preprocessing?: PromptItem;
  events?: PromptItem;
  participants?: PromptItem;
  classification?: PromptItem;
  extraction: PromptItem;
  regeneration: PromptItem;
  proposal: PromptItem;
  flowGeneration?: PromptItem;
  reportGeneration?: PromptItem;
  connectionProposal?: PromptItem;
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

export type GenerationOperationMode =
  | 'extract'
  | 'classify'
  | 'restore_passage'
  | 'propose_connections'
  | 'repair_chains'
  | 'propose_measures'
  | 'regenerate';

export interface GenerationProgressStep {
  id: string;
  num: number;
  label: string;
  desc: string;
}

export interface GenerationProgress {
  isActive: boolean;
  mode: GenerationOperationMode | null;
  stage: GenerationStage;
  title: string;
  detail: string;
  stepCurrent: number;
  stepTotal: number;
  elapsedSeconds: number;
  headerTitle?: string;
  steps?: GenerationProgressStep[];
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
  version: '5.0';
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
