import { VTASchema, VTANodeData, VTAEdgeData, VTAProjectFile } from '../../../types/vta';

export interface ValidationResult<T> {
  isValid: boolean;
  data?: T;
  errors: string[];
}

/**
 * Validates and sanitizes a single VTANodeData object
 */
export function sanitizeNode(raw: any, index: number): { node?: VTANodeData; error?: string } {
  if (!raw || typeof raw !== 'object') {
    return { error: `ノード #${index} がオブジェクトではありません。` };
  }

  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `node_${index + 1}_${Date.now()}`;
  const lane = typeof raw.lane === 'string' && raw.lane.trim() ? raw.lane.trim() : '主要部門';
  const time = typeof raw.time === 'string' ? raw.time : (raw.time != null ? String(raw.time) : '');
  const type = raw.type === 'variation' ? 'variation' : 'normal';
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

  const node: VTANodeData = {
    id,
    lane,
    time,
    type,
    title,
    description,
    measure_type,
    supplementary_note,
    sequence_order,
    position,
  };

  return { node };
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
  if (raw.direction === 'unidirectional' || raw.direction === 'bidirectional' || raw.direction === 'sequential') {
    direction = raw.direction;
  }
  const label = typeof raw.label === 'string' && raw.label.trim().length > 0 ? raw.label.trim() : undefined;

  const validCategories: import('../../../types/vta').EdgeCategory[] = [
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
export function validateAndSanitizeVTASchema(raw: any): ValidationResult<VTASchema> {
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
    const { node, error } = sanitizeNode(rawNode, idx);
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
      const key = `${edge.source}__${edge.target}`;
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

  const vtaDataValidation = validateAndSanitizeVTASchema(raw.vtaData || raw);
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
    version: typeof raw.version === 'string' ? raw.version : '1.0',
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
