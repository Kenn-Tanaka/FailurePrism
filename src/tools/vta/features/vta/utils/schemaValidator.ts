import { validatePresentation } from './presentation';
import { VTASchema, VTANodeData, VTAEdgeData, VTAProjectFile } from '../../../types/vta';
import { projectAnalysis, validateSavedAnalysis } from './eventAnalysis';

export interface ValidationResult<T> {
  isValid: boolean;
  data?: T;
  errors: string[];
}

function sanitizeVariationFactor(raw: any): import('../../../types/vta').VariationFactorDetail | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const categories = ['response', 'internal', 'departure', 'external'];
  const polarities = ['negative', 'resilient'];
  const levels = ['skill', 'rule', 'knowledge', 'other'];
  if (!categories.includes(raw.category) || !polarities.includes(raw.polarity)) return undefined;
  return {
    category: raw.category,
    polarity: raw.polarity,
    ...(levels.includes(raw.cognitiveLevel) ? { cognitiveLevel: raw.cognitiveLevel } : {}),
    ...(typeof raw.description === 'string' && raw.description.trim() ? { description: raw.description.trim() } : {}),
  };
}

/**
 * Validates and sanitizes a single VTANodeData object
 */
export function sanitizeNode(raw: any, index: number, restorePresentation = false): { node?: VTANodeData; error?: string; warning?: string } {
  if (!raw || typeof raw !== 'object') {
    return { error: `ノード #${index} がオブジェクトではありません。` };
  }

  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `node_${index + 1}_${Date.now()}`;
  const lane = typeof raw.lane === 'string' && raw.lane.trim() ? raw.lane.trim() : '主要部門';
  const time = typeof raw.time === 'string' ? raw.time : (raw.time != null ? String(raw.time) : '');
  const type = raw.type === 'variation' || raw.type === 'outcome' || raw.type === 'unclassified' || raw.type === 'undetermined' ? raw.type : 'normal';
  const outcome_kind = ['loss', 'near_miss', 'recovery'].includes(String(raw.outcome_kind))
    ? (raw.outcome_kind as import('../../../types/vta').VTAOutcomeKind)
    : undefined;
  const variation_factor = sanitizeVariationFactor(raw.variation_factor);
  const event_ids = Array.isArray(raw.event_ids) && raw.event_ids.every((id: unknown) => typeof id === 'string' && id.trim())
    ? [...new Set(raw.event_ids as string[])] : undefined;
  const title = typeof raw.title === 'string' ? raw.title : (raw.title != null ? String(raw.title) : `作業ステップ ${index + 1}`);
  const description = typeof raw.description === 'string' ? raw.description : (raw.description != null ? String(raw.description) : '');
  const measure_type = raw.measure_type === 'elimination' ? 'elimination' : null;
  const supplementary_note = typeof raw.supplementary_note === 'string' 
    ? raw.supplementary_note 
    : (raw.supplementary_note != null ? String(raw.supplementary_note) : '');

  const sequence_order = typeof raw.sequence_order === 'number' && Number.isFinite(raw.sequence_order)
    ? raw.sequence_order
    : (typeof raw.sequence_order === 'string' && !isNaN(Number(raw.sequence_order)) ? Number(raw.sequence_order) : undefined);

  let position: { x: number; y: number } | undefined = undefined;
  if (
    raw.position &&
    typeof raw.position === 'object' &&
    typeof raw.position.x === 'number' &&
    Number.isFinite(raw.position.x) &&
    typeof raw.position.y === 'number' &&
    Number.isFinite(raw.position.y)
  ) {
    position = { x: raw.position.x, y: raw.position.y };
  }
  const compactPosition = restorePresentation && raw.compact_position &&
    typeof raw.compact_position === 'object' &&
    typeof raw.compact_position.x === 'number' && Number.isFinite(raw.compact_position.x) &&
    typeof raw.compact_position.y === 'number' && Number.isFinite(raw.compact_position.y)
    ? { x: raw.compact_position.x, y: raw.compact_position.y } : undefined;
  const compactPositionWarning = restorePresentation && raw.compact_position !== undefined && !compactPosition
    ? `ノード「${id}」の見出しのみ表示座標が不正なため破棄しました。` : undefined;

  const node: VTANodeData = {
    id,
    event_ids,
    lane,
    time,
    type,
    title,
    description,
    measure_type,
    supplementary_note,
    sequence_order,
    position,
    compact_position: compactPosition,
    ...(outcome_kind ? { outcome_kind } : {}),
    ...(variation_factor ? { variation_factor } : {}),
    ...(raw.entity_role === 'subject' || raw.entity_role === 'object' ? { entity_role: raw.entity_role } : {}),
    ...(raw.object_display_style === 'dot' || raw.object_display_style === 'card' ? { object_display_style: raw.object_display_style } : {}),
    ...(restorePresentation && raw.is_hidden === true ? {
      is_hidden: true,
      ...(typeof raw.hidden_card_height === 'number' && Number.isFinite(raw.hidden_card_height) && raw.hidden_card_height >= 20 && raw.hidden_card_height <= 100000
        ? { hidden_card_height: raw.hidden_card_height } : {}),
    } : {}),
  };

  return { node, warning: compactPositionWarning };
}

/**
 * Validates and sanitizes a single VTAEdgeData object
 */
export function sanitizeEdge(raw: any, validNodeIds: Set<string>, index: number): { edge?: VTAEdgeData; error?: string } {
  if (!raw || typeof raw !== 'object') {
    return { error: `エッジ #${index} がオブジェクトではありません。` };
  }

  const source = typeof raw.source === 'string' ? raw.source.trim() : '';
  const target = typeof raw.target === 'string' ? raw.target.trim() : '';

  if (!source || !target) {
    return { error: `エッジ #${index} の source または target が空です。` };
  }

  if (source === target) {
    return { error: `エッジ #${index} が自己ループ (${source} -> ${target}) です。` };
  }

  if (!validNodeIds.has(source) || !validNodeIds.has(target)) {
    return { error: `エッジ #${index} が存在しないノードを参照しています (${source} -> ${target})。` };
  }

  const is_break = Boolean(raw.is_break);
  let direction: import('../../../types/vta').EdgeDirection = 'sequential';
  if (raw.direction === 'undirected' || raw.direction === 'unidirectional' || raw.direction === 'bidirectional' || raw.direction === 'sequential') {
    direction = raw.direction;
  }
  const label = typeof raw.label === 'string' && raw.label.trim().length > 0 ? raw.label.trim() : undefined;

  const validCategories: import('../../../types/vta').EdgeCategory[] = [
    'dependency',
    'information',
    'material',
    'person',
    'handover',
    'impact',
    'sequential',
    'other',
  ];
  const category = validCategories.includes(raw.category) ? raw.category : undefined;

  const edge: VTAEdgeData = {
    id: typeof raw.id === 'string' ? raw.id : undefined,
    meaning: raw.meaning, eventId: raw.eventId, relationId: raw.relationId, generated: raw.generated, status: raw.status, receipt: raw.receipt, resource: raw.resource,
    source,
    target,
    is_break,
    direction,
    label,
    category,
  };

  return { edge };
}

/**
 * Validates and sanitizes an entire VTASchema
 */
export function validateAndSanitizeVTASchema(raw: any, restorePresentation = false): ValidationResult<VTASchema> {
  const errors: string[] = [];

  if (!raw || typeof raw !== 'object') {
    return { isValid: false, errors: ['VTAスキーマがオブジェクトではありません。'] };
  }

  if (!Array.isArray(raw.nodes)) {
    return { isValid: false, errors: ['ノード一覧 (nodes) 配列が含まれていません。'] };
  }

  if (!Array.isArray(raw.edges)) {
    return { isValid: false, errors: ['エッジ一覧 (edges) 配列が含まれていません。'] };
  }

  const nodes: VTANodeData[] = [];
  const nodeIds = new Set<string>();

  raw.nodes.forEach((rawNode: any, idx: number) => {
    const { node, error, warning } = sanitizeNode(rawNode, idx, restorePresentation);
    if (warning) errors.push(warning);
    if (error) {
      errors.push(error);
      return;
    }
    if (node) {
      if (nodeIds.has(node.id)) {
        // Robust collision-free ID resolution
        let counter = 1;
        let candidateId = `${node.id}_dup_${counter}`;
        while (nodeIds.has(candidateId)) {
          counter++;
          candidateId = `${node.id}_dup_${counter}`;
        }
        errors.push(`重複ノードID "${node.id}" を検出したため、"${candidateId}" に自動補正しました。`);
        node.id = candidateId;
      }
      nodeIds.add(node.id);
      nodes.push(node);
    }
  });

  const edges: VTAEdgeData[] = [];
  const edgeKeys = new Set<string>();

  raw.edges.forEach((rawEdge: any, idx: number) => {
    const { edge, error } = sanitizeEdge(rawEdge, nodeIds, idx);
    if (error) {
      errors.push(error);
      return;
    }
    if (edge) {
      const key = edge.id ?? `${edge.source}__${edge.target}`;
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key);
        edges.push(edge);
      }
    }
  });

  // Extract lanes and ensure all node lanes are included
  const declaredLanes = Array.isArray(raw.lanes)
    ? raw.lanes.filter((l: any) => typeof l === 'string' && l.trim().length > 0).map((l: string) => l.trim())
    : [];

  const nodeLanes = Array.from(new Set(nodes.map((n) => n.lane)));
  const allLanes = Array.from(new Set([...declaredLanes, ...nodeLanes]));
  if (allLanes.length === 0) {
    allLanes.push('主要部門');
  }

  const supplementary_summary = typeof raw.supplementary_summary === 'string'
    ? raw.supplementary_summary
    : (raw.supplementary_summary != null ? String(raw.supplementary_summary) : undefined);

  const custom_notes = Array.isArray(raw.custom_notes)
    ? raw.custom_notes.filter((cn: any) => cn && typeof cn === 'object').map((cn: any, idx: number) => ({
        id: typeof cn.id === 'string' ? cn.id : `cn_${idx}`,
        nodeId: typeof cn.nodeId === 'string' && cn.nodeId.trim() ? cn.nodeId.trim() : undefined,
        title: typeof cn.title === 'string' ? cn.title : 'メモ',
        content: typeof cn.content === 'string' ? cn.content : '',
      }))
    : undefined;

  const sanitizedSchema: VTASchema = {
    lanes: allLanes,
    nodes,
    edges,
    supplementary_summary,
    custom_notes,
  };

  if (raw.analysis !== undefined) {
    try {
      const analysis = validateSavedAnalysis(raw.analysis);
      const projected = projectAnalysis(analysis, { ...sanitizedSchema, analysis });
      if (projected.nodes.length !== nodes.length || projected.nodes.some((node) => !nodes.some((saved) => saved.id === node.id))) {
        return { isValid: false, errors: ['イベントとカードの参照が一致しません。'] };
      }
      sanitizedSchema.analysis = analysis;
      sanitizedSchema.presentation = validatePresentation(raw.presentation, sanitizedSchema);
      sanitizedSchema.nodes = projected.nodes;
      sanitizedSchema.edges = projected.edges;
    } catch (error) {
      return { isValid: false, errors: [error instanceof Error ? error.message : 'イベント分析データが不正です。'] };
    }
  }

  return {
    isValid: true,
    data: sanitizedSchema,
    errors,
  };
}

/**
 * Validates a full VTAProjectFile
 */
export function validateAndSanitizeProjectFile(raw: any): ValidationResult<VTAProjectFile> {
  if (!raw || typeof raw !== 'object') {
    return { isValid: false, errors: ['プロジェクトファイルがJSONオブジェクトではありません。'] };
  }

  if (raw.version !== '5.0' || !raw.vtaData?.analysis) {
    return { isValid: false, errors: ['このプロジェクト形式には対応していません。新形式（5.0）のファイルを指定してください。'] };
  }

  const vtaDataValidation = validateAndSanitizeVTASchema(raw.vtaData || raw, true);
  if (!vtaDataValidation.isValid || !vtaDataValidation.data) {
    return {
      isValid: false,
      errors: ['プロジェクト内のVTA図データが無効です:\n' + vtaDataValidation.errors.join('\n')],
    };
  }

  let regenerationResult: import('../../../types/vta').RegenerationResult | null = null;
  if (raw.regenerationResult && typeof raw.regenerationResult === 'object') {
    const rr = raw.regenerationResult;
    if (typeof rr.idealFlow === 'string' || typeof rr.analysisReport === 'string') {
      regenerationResult = {
        idealFlow: typeof rr.idealFlow === 'string' ? rr.idealFlow : '',
        analysisReport: typeof rr.analysisReport === 'string' ? rr.analysisReport : '',
        generatedAt: typeof rr.generatedAt === 'string' ? rr.generatedAt : new Date().toLocaleTimeString(),
        sourceHash: typeof rr.sourceHash === 'string' ? rr.sourceHash : undefined,
      };
    } else {
      vtaDataValidation.errors.push('保存された再生成結果 (regenerationResult) の形式が不正なため除外しました。');
    }
  }

  const project: VTAProjectFile = {
    version: '5.0',
    savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : new Date().toISOString(),
    scenarioText: typeof raw.scenarioText === 'string' ? raw.scenarioText : '',
    vtaData: vtaDataValidation.data,
    regenerationResult,
    selectedModel: typeof raw.selectedModel === 'string' ? raw.selectedModel : undefined,
  };

  return {
    isValid: true,
    data: project,
    errors: vtaDataValidation.errors,
  };
}
