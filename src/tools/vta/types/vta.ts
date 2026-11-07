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
 * outcome: 帰結ノード（事故・インシデントの終局）
 */
export type VTANodeType = 'normal' | 'variation' | 'outcome' | 'unclassified' | 'undetermined';

/**
 * 変動要因の詳細分類カテゴリ
 * response: 先行する変動要因で生じた状態変化に対する応答
 * internal: 内部要因（装置・部品故障、ソフト異常、人員の負傷・病気発作など）
 * departure: 人為的行為（故意、過失）による通常作業からの逸脱
 * external: 外部要因（天候・外乱・外部インフラ等）
 */
export type VariationCategory = 'response' | 'internal' | 'departure' | 'external';

/**
 * 行動レベル（Rasmussen SRKモデル）
 * skill: Skillベース（無意識・熟練的動作でのエラー・スリップ）
 * rule: Ruleベース（手順・ルールの誤適用・見落とし）
 * knowledge: Knowledgeベース（未知状況での試行錯誤・判断誤り）
 * other: その他・未特定
 */
export type CognitiveBehaviorLevel = 'skill' | 'rule' | 'knowledge' | 'other';

/**
 * 変動要因の極性（Safety-II観点）
 * negative: 負の変動（不具合・エラー・事故進展要因）
 * resilient: 正の変動（レジリエンスの発揮によるリカバリー・破滅回避・好転要因）
 */
export type VariationPolarity = 'negative' | 'resilient';

export interface VariationFactorDetail {
  category: VariationCategory;
  polarity: VariationPolarity;
  cognitiveLevel?: CognitiveBehaviorLevel;
  description?: string;
}

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

export interface GranularityWeights {
  w1: number;
  w2: number;
  w3: number;
  w4: number;
  w5: number;
}

export type OptimizationPresetId = 'balanced' | 'presentation' | 'causality' | 'organization' | 'custom';

export interface VTAUserAssumption {
  id: string;
  text: string;
  enabled: boolean;
  createdAt?: string;
}

export interface VTAAnalysisScope {
  timeRange?: {
    start?: string;
    end?: string;
    enabled: boolean;
  };
  includedEntityIds?: string[];
  excludedEntityIds?: string[];
  pinnedEntityIds?: string[]; // マージ禁止・独立レーン死守
}

export interface VTARefinementSettings {
  maxIterations: number; // 1〜5 (default: 2)
  targetScore: number;   // 0.60〜0.95 (default: 0.82)
  epsilon: number;       // 0.01〜0.05 (default: 0.02)
  weights: GranularityWeights;
  preset: OptimizationPresetId;
  oneTimeDirective?: string;
  useOneTimeDirective?: boolean;
  assumptions?: VTAUserAssumption[];
  scope?: VTAAnalysisScope;
}

export interface VTANormalizationAudit {
  version: 1;
  corrections: VTATextCorrection[];
  subjectiveNotices: VTASubjectiveNotice[];
  iterations?: VTARefinementIteration[];
}

export interface VTAEvent {
  sourceRefs?: VTASourceRef[];
  recordKind?: 'recorded' | 'claim' | 'assessment' | 'assumption';
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
  outcome_kind?: VTAOutcomeKind;
  variationFactor?: VariationFactorDetail;
}

export type VTASubjectFocus = 'reporter' | 'high' | 'mid' | 'low';

export interface VTAEntity {
  resolution?: 'unresolved';
  id: string;
  name: string;
  kind: 'person' | 'organization' | 'machine' | 'other';
  focus?: VTASubjectFocus;
  parentEntityId?: string;
  parentEntityIds?: string[];
  focusSourceRefs?: VTASourceRef[];
  aggregate?: true;
  mergedFrom?: string[];
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
  excluded?: boolean;
  mergeBlockedReason?: string;
  isInfluential?: boolean;
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

/** レーン統合案の定義 */
export interface LaneMergeProposal {
  id: string;                      // 提案の一意ID (例: "merge_A_crew")
  type: 'merge';
  sourceEntityIds: string[];       // 統合対象の主体ID群 (例: ['A1', 'A2', 'A3'])
  sourceEntityNames: string[];     // 統合対象の主体名群 (例: ['機長A', '副操縦員A', '機上整備員A'])
  targetEntityId?: string;         // 既存の統合先主体ID (あれば)
  suggestedTargetName: string;     // 推奨統合先名称 (例: 'A機' または '海上保安庁')
  suggestedKind: VTAEntity['kind'];
  totalEventsCount: number;        // 集約されるイベント総数
  reducedLanesCount: number;       // 削減されるレーン数 (sourceEntityIds.length - 1)
  reason: string;                  // 統合を推奨する根拠・メリット
  category: 'common_parent' | 'vehicle_crew' | 'dependent_accessory';
}

/** レーン分割案の定義 */
export interface LaneSplitProposal {
  id: string;                      // 提案の一意ID (例: "split_A_crew")
  type: 'split';
  parentEntityId: string;          // 現在の集約主体ID (例: 'A12' または 'A機')
  parentEntityName: string;        // 集約主体名称 (例: 'A機')
  splitEntityIds: string[];        // 独立レーンとして展開する主体ID群 (例: ['A1', 'A2'])
  splitEntityNames: string[];      // 展開する主体名群 (例: ['機長A', '副操縦員A'])
  internalRelationsCount: number;  // クルー間の内部相互関係数 (CRM分析の指標)
  reason: string;                  // 分割を推奨する根拠・メリット
  category: 'crm_interaction' | 'high_activity' | 'multi_actor';
}

export type VTAOutcomeKind = 'loss' | 'near_miss' | 'recovery';

export interface VTAOutcomeData {
  status: 'identified' | 'not_found' | 'uncertain';
  kind?: VTAOutcomeKind;
  eventIds: string[];
  sourceRefs: VTASourceRef[];
  reason: string;
}

export type VTAEventRelevance = 'core_scenario' | 'relevant_omitted' | 'irrelevant';

export interface VTANarrativeAudit {
  score: number;
  scenarioEventIds: string[];
  omittedRelevantEventIds: string[];
  includedIrrelevantEventIds: string[];
  reason: string;
}

export interface GranularityProposals {
  merges: LaneMergeProposal[];
  splits: LaneSplitProposal[];
}

export interface PosetRelation {
  childId: string;
  parentId: string;
  axis?: 'organizational' | 'functional' | 'team';
}

export interface SubjectPosetData {
  nodes: string[];
  aliases: Record<string, string>;
  relations: PosetRelation[];
}

export interface GenerationProvenance { runId: string; schemeId: string; schemeVersion: string; ruleVersion: string; model: string; promptFingerprint: string; inputFingerprint: string; }
export interface VTAAnalysisData {
  outcome?: VTAOutcomeData;
  context?: { selectedTargetEventIds:string[]; objective?:string };
  subjectRanking?: VTASubjectRanking;
  normalizationAudit?: VTANormalizationAudit;
  subjectPoset?: SubjectPosetData;
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
  /** 客体ノードのグローバル表示形式（'dot': ドット表示 [標準], 'card': 通常カード表示） */
  defaultObjectDisplayStyle?: VTAObjectDisplayStyle;
  /** 主体Posetに基づく包含サブレーンのドリルダウン展開状態（キーは親エンティティID） (ADR-0011) */
  drilldownLanes?: Record<string, boolean>;
}

/** ノードの作用役割種別（subject: 作用を担う側/主体, object: 作用を及ぼされる側/客体） */
export type VTANodeEntityRole = 'subject' | 'object';

/** 客体ノードの表示スタイル */
export type VTAObjectDisplayStyle = 'dot' | 'card';

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
  /** True if this node is derived from or represents a user-defined assumption. */
  is_assumption?: boolean;
  /** User-controlled presentation only; retain this node and every connection. */
  is_hidden?: boolean;
  /** Card height captured when hidden, preserving its center across save/load. */
  hidden_card_height?: number;
  outcome_kind?: VTAOutcomeKind; // 帰結種別 (loss | near_miss | recovery)
  variation_factor?: VariationFactorDetail; // 変動要因の分類・行動レベル・極性
  /** 複数レーン展開時における作用役割種別（subject: 作用を担う能動主体, object: 作用を受ける受動客体） */
  entity_role?: VTANodeEntityRole;
  /** 客体ノードの個別表示形式（省略時は全体設定に従う） */
  object_display_style?: VTAObjectDisplayStyle;
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

export type VTAPipelineStageId =
  | 'stage1_normalize'
  | 'stage2_refine'
  | 'stage3_connect'
  | 'stage4_classify';

/**
 * AI生成パイプラインの各ステージにおける軽量スナップショット（入れ子・原文重複なし）
 */
export interface VTAPipelineSnapshot {
  id: VTAPipelineStageId | string;
  stageIndex: number; // 0: 正規化抽出, 1: 粒度最適化, 2: 自動接続, 3: 変動判定
  title: string; // e.g. 'Stage 1: 全文正規化 (初期抽出)'
  subtitle: string; // e.g. 'イベント 42件、主体 19列'
  description: string; // ステージの詳細な解説（スコア推移や接続本数など）
  timestamp: string; // ISO 8601
  lanes: string[]; // そのステージ時点のレーン一覧
  nodes: VTANodeData[]; // そのステージ時点のノード一覧
  edges: VTAEdgeData[]; // そのステージ時点のエッジ一覧
  presentation?: VTAPresentation;
  stats: {
    eventCount: number;
    nodeCount: number;
    laneCount: number;
    edgeCount: number;
    variationCount: number;
    outcomeCount: number;
  };
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
  pipelineHistory?: VTAPipelineSnapshot[]; // AI生成パイプラインのステージ別変遷スナップショット履歴
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
  /** True if this node is derived from or represents a user-defined assumption. */
  is_assumption?: boolean;
  is_hidden?: boolean;
  hidden_card_height?: number;
  outcome_kind?: VTAOutcomeKind;
  variation_factor?: VariationFactorDetail;
  entity_role?: VTANodeEntityRole;
  object_display_style?: VTAObjectDisplayStyle;
  isHoveredLinked?: boolean;
  linkedSubjectNodeId?: string;
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
  stream?: boolean;        // SSEストリーミング有効化 (デフォルト: true)
  maxRetries?: number;     // 一時的ゲートウェイエラー時の最大リトライ回数 (デフォルト: 3)
  retryBaseDelayMs?: number; // 指数バックオフの初回待機ミリ秒 (デフォルト: 1200ms)
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
  | 'regenerate'
  | 'auto_connect'
  | 'reoptimize';

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
