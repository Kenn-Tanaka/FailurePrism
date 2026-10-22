import { generateId } from '../shared/id';
import {
  EdgeKind,
  LevelDefinition,
  LevelDefinitionSchema,
  NodeKindDefinition,
  NodeKindDefinitionSchema,
  NodePaletteKey,
  NodeStatus,
  Project,
  PROJECT_SCHEMA_VERSION,
  TPDD_LIMITS,
  ThoughtEdge,
  ThoughtEdgeSchema,
  ThoughtNode,
  ThoughtNodeSchema,
} from './schema';

export type ProjectPresetId = 'mechanical' | 'software' | 'electronics' | 'custom';

export interface ProjectPresetDefinition {
  id: string;
  label: string;
  description: string;
  nodeKinds: NodeKindDefinition[];
  levels: LevelDefinition[];
}

/**
 * 新規Projectの初期値。適用後は通常のユーザー定義として編集できる。
 */
export const PROJECT_PRESETS: Record<ProjectPresetId, ProjectPresetDefinition> = {
  mechanical: {
    id: 'mechanical',
    label: '機械設計',
    description: '要求・機能・機構・構造を中心とした設計体系',
    nodeKinds: [
      { id: 'requirement', label: '要求', description: '製品やシステムが満たすべき要求', paletteKey: 'blue' },
      { id: 'function', label: '機能', description: '要求を満たすために必要な働き', paletteKey: 'teal' },
      { id: 'mechanism', label: '機構', description: '機能を実現する物理的な原理や仕組み', paletteKey: 'orange' },
      { id: 'structure', label: '構造', description: '機構を構成する具体的な部品や配置', paletteKey: 'pink' },
      { id: 'constraint', label: '制約', description: '設計で守るべき条件や上限', paletteKey: 'yellow' },
      { id: 'note', label: 'メモ', description: '補足情報や検討中の注記', paletteKey: 'gray' },
    ],
    levels: [
      { id: 'level-requirement', label: '要求', description: '製品やシステムへの要求を配置する' },
      { id: 'level-function', label: '機能', description: '要求を満たす機能を配置する' },
      { id: 'level-mechanism', label: '機構', description: '機能を実現する機構や方式を配置する' },
      { id: 'level-structure', label: '構造', description: '具体的な構造、部品、配置を配置する' },
    ],
  },
  software: {
    id: 'software',
    label: 'ソフトウェア設計',
    description: '要求・責務・論理設計・コンポーネントを中心とした設計体系',
    nodeKinds: [
      { id: 'requirement', label: '要求', description: '利用者やステークホルダーが必要とする価値', paletteKey: 'blue' },
      { id: 'use-case', label: 'ユースケース', description: '利用者とシステムの相互作用', paletteKey: 'teal' },
      { id: 'responsibility', label: '責務', description: '機能やコンポーネントが担う役割', paletteKey: 'yellow' },
      { id: 'component', label: 'コンポーネント', description: 'サービス、モジュール、クラスなどの実装単位', paletteKey: 'pink' },
      { id: 'interface', label: 'インターフェース', description: 'コンポーネント間または外部との接続契約', paletteKey: 'cyan' },
      { id: 'quality', label: '非機能要件', description: '性能、可用性、セキュリティなどの品質特性', paletteKey: 'orange' },
      { id: 'note', label: 'メモ', description: '補足情報や検討中の注記', paletteKey: 'gray' },
    ],
    levels: [
      { id: 'level-requirements', label: '要求・ユースケース', description: '利用者要求、品質要求、ユースケースを配置する' },
      { id: 'level-architecture', label: 'アーキテクチャ', description: 'システムの分割、境界、主要な責務を配置する' },
      { id: 'level-logical-design', label: '論理設計', description: 'データフロー、状態遷移、アルゴリズム、協調方式を配置する' },
      { id: 'level-components', label: 'コンポーネント', description: 'サービス、モジュール、クラス、インターフェースを配置する' },
      { id: 'level-implementation', label: '実装', description: '実装上の具体的な要素や設定を配置する' },
    ],
  },
  electronics: {
    id: 'electronics',
    label: '電子回路設計',
    description: '仕様・電気的機能・回路方式・部品を中心とした設計体系',
    nodeKinds: [
      { id: 'specification', label: '仕様', description: '電気的、機能的に満たすべき要件', paletteKey: 'blue' },
      { id: 'electrical-function', label: '電気的機能', description: '回路が実現すべき信号処理や電力変換の働き', paletteKey: 'teal' },
      { id: 'circuit-method', label: '回路方式', description: '電気的機能を実現するトポロジや制御方式', paletteKey: 'yellow' },
      { id: 'component', label: '部品', description: 'IC、抵抗、コンデンサ、コネクタなどの具体的な回路要素', paletteKey: 'pink' },
      { id: 'signal', label: '信号', description: '回路内外で受け渡す電気信号', paletteKey: 'cyan' },
      { id: 'power', label: '電源', description: '電源レール、消費電力、接地に関する要素', paletteKey: 'orange' },
      { id: 'constraint', label: '制約', description: '定格、コスト、実装面積、熱、EMCなどの制約', paletteKey: 'olive' },
      { id: 'note', label: 'メモ', description: '補足情報や検討中の注記', paletteKey: 'gray' },
    ],
    levels: [
      { id: 'level-specifications', label: '仕様・制約', description: '電気仕様、入出力条件、環境条件、制約を配置する' },
      { id: 'level-functions', label: '電気的機能', description: '増幅、変換、フィルタ、制御など必要な働きを配置する' },
      { id: 'level-blocks', label: '機能ブロック', description: '回路を機能的なまとまりに分割して配置する' },
      { id: 'level-circuit-methods', label: '回路方式', description: '回路トポロジ、制御方式、主要な信号経路を配置する' },
      { id: 'level-components', label: '部品・定数', description: '具体的な部品、型番、回路定数を配置する' },
    ],
  },
  custom: {
    id: 'custom',
    label: 'カスタム',
    description: '最小構成から種別と配置列を自由に定義',
    nodeKinds: [
      { id: 'item', label: '項目', description: '', paletteKey: 'gray' },
    ],
    levels: [
      { id: 'level-1', label: '列1', description: '' },
    ],
  },
};

export const DEFAULT_MODEL_ID = 'openrouter/google/gemini-3.8-flash';

/**
 * 新規Project生成
 */
export function createNewProject(
  title = '新規思考展開図',
  preset: ProjectPresetId | ProjectPresetDefinition = 'mechanical'
): Project {
  const rootDiagramId = generateId();
  const now = new Date().toISOString();
  const trimmedTitle = title.trim() || '新規思考展開図';
  const safeTitle =
    trimmedTitle.length > TPDD_LIMITS.LABEL_MAX_LENGTH
      ? trimmedTitle.slice(0, TPDD_LIMITS.LABEL_MAX_LENGTH)
      : trimmedTitle;

  const presetDefinition = typeof preset === 'string' ? PROJECT_PRESETS[preset] : preset;
  if (!presetDefinition) throw new Error(`設計プリセット「${preset}」が見つかりません`);

  return {
    format: 'tpdd-project',
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: generateId(),
    title: safeTitle,
    description: '',
    createdAt: now,
    updatedAt: now,
    rootDiagramId,
    nodeKinds: presetDefinition.nodeKinds.map((kind) => ({ ...kind })),
    levels: presetDefinition.levels.map((level) => ({ ...level })),
    diagrams: [
      {
        id: rootDiagramId,
        title: 'ルート図',
        nodes: [],
        edges: [],
      },
    ],
    aiPreferences: {
      modelId: DEFAULT_MODEL_ID,
      timeoutSeconds: 600,
      temperature: 0.2,
      stream: false,
    },
  };
}

/**
 * ノード更新パッチの検証（救出編集時は対象フィールドのみ検証し、既存不正データの修正を妨げない）
 */
export function validateNodePatch(
  project: Project,
  diagramId: string,
  nodeId: string,
  patch: Partial<Omit<ThoughtNode, 'id' | 'provenance'>>
): string | null {
  const diagram = project.diagrams.find((d) => d.id === diagramId);
  if (!diagram) return '図が見つかりません';
  const node = diagram.nodes.find((n) => n.id === nodeId);
  if (!node) return 'ノードが見つかりません';

  if (patch.label !== undefined) {
    const trimmed = patch.label.trim();
    if (trimmed.length === 0) return 'ラベルは空にできません';
    if (trimmed.length > TPDD_LIMITS.LABEL_MAX_LENGTH) return 'ラベルは200文字以内です';
  }

  if (patch.kindId !== undefined) {
    if (!patch.kindId || !project.nodeKinds.some((kind) => kind.id === patch.kindId)) {
      return '指定されたノード種別が存在しません';
    }
  }

  if (patch.status !== undefined) {
    const parsedStatus = ThoughtNodeSchema.shape.status.safeParse(patch.status);
    if (!parsedStatus.success) return 'ノード状態が不正です';
  }

  if (patch.levelId !== undefined) {
    if (!patch.levelId || !project.levels.some((l) => l.id === patch.levelId)) {
      return '指定された抽象度列が存在しません';
    }
  }

  if (patch.x !== undefined) {
    const parsedX = ThoughtNodeSchema.shape.x.safeParse(patch.x);
    if (!parsedX.success) return parsedX.error.issues[0]?.message || 'X座標が不正です';
  }

  if (patch.y !== undefined) {
    const parsedY = ThoughtNodeSchema.shape.y.safeParse(patch.y);
    if (!parsedY.success) return parsedY.error.issues[0]?.message || 'Y座標が不正です';
  }

  if (patch.width !== undefined) {
    const parsedW = ThoughtNodeSchema.shape.width.safeParse(patch.width);
    if (!parsedW.success) return parsedW.error.issues[0]?.message || '幅が不正です';
  }

  if (patch.height !== undefined) {
    const parsedH = ThoughtNodeSchema.shape.height.safeParse(patch.height);
    if (!parsedH.success) return parsedH.error.issues[0]?.message || '高さが不正です';
  }

  if (patch.meta !== undefined) {
    if (
      patch.meta.description !== undefined &&
      patch.meta.description !== node.meta.description
    ) {
      const parsedDesc = ThoughtNodeSchema.shape.meta.shape.description.safeParse(
        patch.meta.description
      );
      if (!parsedDesc.success) {
        return parsedDesc.error.issues[0]?.message || '説明は10,000文字以内です';
      }
    }

    if (patch.meta.tags !== undefined && patch.meta.tags !== node.meta.tags) {
      const isRemovingOnly = patch.meta.tags.length < node.meta.tags.length;
      if (!isRemovingOnly) {
        const parsedTags = ThoughtNodeSchema.shape.meta.shape.tags.safeParse(patch.meta.tags);
        if (!parsedTags.success) {
          return parsedTags.error.issues[0]?.message || 'タグが不正です';
        }
      }
    }

    if (
      patch.meta.sourceLinks !== undefined &&
      patch.meta.sourceLinks !== node.meta.sourceLinks
    ) {
      const isRemovingOnly = patch.meta.sourceLinks.length < node.meta.sourceLinks.length;
      if (!isRemovingOnly) {
        const parsedLinks = ThoughtNodeSchema.shape.meta.shape.sourceLinks.safeParse(
          patch.meta.sourceLinks
        );
        if (!parsedLinks.success) {
          return parsedLinks.error.issues[0]?.message || '参考リンクが不正です';
        }
      }
    }
  }

  return null;
}

/**
 * ノード追加
 */
export function addNodeToDiagram(
  project: Project,
  diagramId: string,
  params: {
    label?: string;
    kindId?: string;
    status?: NodeStatus;
    levelId: string;
    x: number;
    y: number;
    width?: number;
    height?: number;
    description?: string;
    origin?: 'manual' | 'llm';
    modelId?: string;
    task?: 'expand' | 'alternatives';
    promptVersion?: string;
    requestId?: string;
  }
): { project: Project; newNode: ThoughtNode; error?: string } {
  const rawLabel = params.label !== undefined ? params.label.trim() : '新規ノード';
  const kindId = params.kindId ?? project.nodeKinds[0]?.id ?? '';
  const newNode: ThoughtNode = {
    id: generateId(),
    label: rawLabel,
    kindId,
    status: params.status || 'draft',
    levelId: params.levelId,
    x: params.x,
    y: params.y,
    width: params.width ?? 180,
    height: params.height ?? 72,
    meta: {
      description: params.description || '',
      tags: [],
      sourceLinks: [],
    },
    provenance: {
      origin: params.origin || 'manual',
      createdAt: new Date().toISOString(),
      modelId: params.modelId,
      task: params.task,
      promptVersion: params.promptVersion,
      requestId: params.requestId,
    },
  };

  const diagram = project.diagrams.find((d) => d.id === diagramId);
  if (!diagram) {
    return { project, newNode, error: '図が見つかりません' };
  }

  if (!project.nodeKinds.some((kind) => kind.id === kindId)) {
    return { project, newNode, error: '指定されたノード種別が存在しません' };
  }
  if (!project.levels.some((level) => level.id === params.levelId)) {
    return { project, newNode, error: '指定された抽象度列が存在しません' };
  }

  if (diagram.nodes.length >= TPDD_LIMITS.MAX_NODES_PER_DIAGRAM) {
    return { project, newNode, error: '1図あたりのノード上限は500件です' };
  }

  const totalNodes = project.diagrams.reduce((sum, d) => sum + d.nodes.length, 0);
  if (totalNodes >= TPDD_LIMITS.MAX_TOTAL_NODES) {
    return {
      project,
      newNode,
      error: `Project全体の合計ノード数が上限${TPDD_LIMITS.MAX_TOTAL_NODES}件に達しています`,
    };
  }

  const parsedNode = ThoughtNodeSchema.safeParse(newNode);
  if (!parsedNode.success) {
    return {
      project,
      newNode,
      error: parsedNode.error.issues[0]?.message || 'ノードのデータが不正です',
    };
  }

  const diagrams = project.diagrams.map((d) => {
    if (d.id !== diagramId) return d;
    return {
      ...d,
      nodes: [...d.nodes, newNode],
    };
  });

  return {
    project: {
      ...project,
      updatedAt: new Date().toISOString(),
      diagrams,
    },
    newNode,
  };
}

/**
 * ノード更新 (座標、サイズ、属性等)
 */
export function updateNodeInDiagram(
  project: Project,
  diagramId: string,
  nodeId: string,
  patch: Partial<Omit<ThoughtNode, 'id' | 'provenance'>>
): Project {
  const normalizedPatch: Partial<Omit<ThoughtNode, 'id' | 'provenance'>> =
    patch.label !== undefined ? { ...patch, label: patch.label.trim() } : patch;

  const validationError = validateNodePatch(project, diagramId, nodeId, normalizedPatch);
  if (validationError) {
    return project;
  }

  const diagrams = project.diagrams.map((d) => {
    if (d.id !== diagramId) return d;
    return {
      ...d,
      nodes: d.nodes.map((n) => {
        if (n.id !== nodeId) return n;
        return {
          ...n,
          ...normalizedPatch,
          meta: normalizedPatch.meta ? { ...n.meta, ...normalizedPatch.meta } : n.meta,
        };
      }),
    };
  });

  return {
    ...project,
    updatedAt: new Date().toISOString(),
    diagrams,
  };
}

/**
 * ノード削除 (関連エッジも同トランザクションで削除)
 */
export function removeNodeFromDiagram(
  project: Project,
  diagramId: string,
  nodeId: string
): Project {
  // 子図が存在する場合の処理は上位の階層処理コマンドでカスケード削除するが、
  // ここでは単一図内でのノード・エッジ削除を行う
  const diagrams = project.diagrams.map((d) => {
    if (d.id !== diagramId) return d;
    return {
      ...d,
      nodes: d.nodes.filter((n) => n.id !== nodeId),
      edges: d.edges.filter((e) => e.sourceId !== nodeId && e.targetId !== nodeId),
    };
  });

  return {
    ...project,
    updatedAt: new Date().toISOString(),
    diagrams,
  };
}

/**
 * 複数ノードの位置を一括更新 (複数選択ドラッグ移動・整列等)
 */
export function updateNodesPosition(
  project: Project,
  diagramId: string,
  positions: { id: string; x: number; y: number }[]
): Project {
  for (const pos of positions) {
    if (
      !ThoughtNodeSchema.shape.x.safeParse(pos.x).success ||
      !ThoughtNodeSchema.shape.y.safeParse(pos.y).success
    ) {
      return project;
    }
  }

  const posMap = new Map(positions.map((p) => [p.id, p]));
  const diagrams = project.diagrams.map((d) => {
    if (d.id !== diagramId) return d;
    return {
      ...d,
      nodes: d.nodes.map((n) => {
        const target = posMap.get(n.id);
        if (!target) return n;
        return {
          ...n,
          x: target.x,
          y: target.y,
        };
      }),
    };
  });

  return {
    ...project,
    updatedAt: new Date().toISOString(),
    diagrams,
  };
}

/**
 * 複数ノードの一括削除 (関連エッジも同トランザクションで削除、子孫図もカスケード削除)
 */
export function removeMultipleNodesFromDiagram(
  project: Project,
  diagramId: string,
  nodeIds: string[]
): Project {
  const idSet = new Set(nodeIds);
  const diag = project.diagrams.find((d) => d.id === diagramId);
  const targetNodes = diag ? diag.nodes.filter((n) => idSet.has(n.id)) : [];

  // 削除対象ノードが持っている子図をすべて収集
  const subDiagramIdsToRemove = new Set<string>();
  for (const n of targetNodes) {
    if (n.childDiagramId) {
      subDiagramIdsToRemove.add(n.childDiagramId);
      const descIds = findDescendantDiagramIds(project, n.childDiagramId);
      descIds.forEach((id) => subDiagramIdsToRemove.add(id));
    }
  }

  const diagrams = project.diagrams
    .filter((d) => !subDiagramIdsToRemove.has(d.id))
    .map((d) => {
      if (d.id !== diagramId) return d;
      return {
        ...d,
        nodes: d.nodes.filter((n) => !idSet.has(n.id)),
        edges: d.edges.filter((e) => !idSet.has(e.sourceId) && !idSet.has(e.targetId)),
      };
    });

  return {
    ...project,
    updatedAt: new Date().toISOString(),
    diagrams,
  };
}

/**
 * エッジ追加
 */
export function addEdgeToDiagram(
  project: Project,
  diagramId: string,
  params: {
    sourceId: string;
    targetId: string;
    kind: EdgeKind;
    label?: string;
  }
): { project: Project; newEdge?: ThoughtEdge; error?: string } {
  // 自己エッジチェック
  if (params.sourceId === params.targetId) {
    return { project, error: '自己エッジは作成できません' };
  }

  const diagram = project.diagrams.find((d) => d.id === diagramId);
  if (!diagram) {
    return { project, error: '図が見つかりません' };
  }

  if (diagram.edges.length >= TPDD_LIMITS.MAX_EDGES_PER_DIAGRAM) {
    return { project, error: '1図あたりのエッジ上限は1000件です' };
  }

  const totalEdges = project.diagrams.reduce((sum, d) => sum + d.edges.length, 0);
  if (totalEdges >= TPDD_LIMITS.MAX_TOTAL_EDGES) {
    return {
      project,
      error: `Project全体の合計エッジ数が上限${TPDD_LIMITS.MAX_TOTAL_EDGES}件に達しています`,
    };
  }

  // sourceNode, targetNode の存在チェック
  const sourceExists = diagram.nodes.some((n) => n.id === params.sourceId);
  const targetExists = diagram.nodes.some((n) => n.id === params.targetId);
  if (!sourceExists || !targetExists) {
    return { project, error: '始点または終点のノードが存在しません' };
  }

  // 重複チェック: 同じsourceId, targetId, kind
  const exists = diagram.edges.some(
    (e) =>
      e.sourceId === params.sourceId &&
      e.targetId === params.targetId &&
      e.kind === params.kind
  );
  if (exists) {
    return { project, error: '同一種別の重複エッジは作成できません' };
  }

  const newEdge: ThoughtEdge = {
    id: generateId(),
    sourceId: params.sourceId,
    targetId: params.targetId,
    kind: params.kind,
    label: params.label !== undefined ? params.label.trim() : '',
  };

  const parsedEdge = ThoughtEdgeSchema.safeParse(newEdge);
  if (!parsedEdge.success) {
    return {
      project,
      error: parsedEdge.error.issues[0]?.message || 'エッジのデータが不正です',
    };
  }

  const diagrams = project.diagrams.map((d) => {
    if (d.id !== diagramId) return d;
    return {
      ...d,
      edges: [...d.edges, newEdge],
    };
  });

  return {
    project: {
      ...project,
      updatedAt: new Date().toISOString(),
      diagrams,
    },
    newEdge,
  };
}

/**
 * エッジ削除
 */
export function removeEdgeFromDiagram(
  project: Project,
  diagramId: string,
  edgeId: string
): Project {
  const diagrams = project.diagrams.map((d) => {
    if (d.id !== diagramId) return d;
    return {
      ...d,
      edges: d.edges.filter((e) => e.id !== edgeId),
    };
  });

  return {
    ...project,
    updatedAt: new Date().toISOString(),
    diagrams,
  };
}

/**
 * エッジ更新パッチの検証
 */
export function validateEdgePatch(
  project: Project,
  diagramId: string,
  edgeId: string,
  patch: Partial<Pick<ThoughtEdge, 'kind' | 'label'>>
): string | null {
  const diagram = project.diagrams.find((d) => d.id === diagramId);
  if (!diagram) return '図が見つかりません';

  const targetEdge = diagram.edges.find((e) => e.id === edgeId);
  if (!targetEdge) return 'エッジが見つかりません';

  if (patch.kind !== undefined) {
    const parsedKind = ThoughtEdgeSchema.shape.kind.safeParse(patch.kind);
    if (!parsedKind.success) return 'エッジ種別が不正です';
  }

  if (patch.label !== undefined) {
    const trimmed = patch.label.trim();
    const parsedLabel = ThoughtEdgeSchema.shape.label.safeParse(trimmed);
    if (!parsedLabel.success) {
      return parsedLabel.error.issues[0]?.message || 'エッジラベルは200文字以内です';
    }
  }

  const nextKind = patch.kind ?? targetEdge.kind;
  const duplicateExists = diagram.edges.some(
    (e) =>
      e.id !== edgeId &&
      e.sourceId === targetEdge.sourceId &&
      e.targetId === targetEdge.targetId &&
      e.kind === nextKind
  );
  if (duplicateExists) {
    return '同一種別の重複エッジは作成できません';
  }

  return null;
}

/**
 * エッジ更新
 */
export function updateEdgeInDiagram(
  project: Project,
  diagramId: string,
  edgeId: string,
  patch: Partial<Pick<ThoughtEdge, 'kind' | 'label'>>
): Project {
  const normalizedPatch: Partial<Pick<ThoughtEdge, 'kind' | 'label'>> =
    patch.label !== undefined ? { ...patch, label: patch.label.trim() } : patch;

  const validationError = validateEdgePatch(project, diagramId, edgeId, normalizedPatch);
  if (validationError) {
    return project;
  }

  const diagrams = project.diagrams.map((d) => {
    if (d.id !== diagramId) return d;
    return {
      ...d,
      edges: d.edges.map((e) => (e.id === edgeId ? { ...e, ...normalizedPatch } : e)),
    };
  });

  return {
    ...project,
    updatedAt: new Date().toISOString(),
    diagrams,
  };
}

/**
 * 子孫図IDのリストを再帰的に取得
 */
export function findDescendantDiagramIds(project: Project, startDiagramId: string): string[] {
  const result: string[] = [];
  const startDiag = project.diagrams.find((d) => d.id === startDiagramId);
  if (!startDiag) return result;

  const visited = new Set<string>([startDiagramId]);
  const stack = [startDiag];
  while (stack.length > 0) {
    const current = stack.pop()!;
    for (const node of current.nodes) {
      if (node.childDiagramId && !visited.has(node.childDiagramId)) {
        visited.add(node.childDiagramId);
        result.push(node.childDiagramId);
        const childDiag = project.diagrams.find((d) => d.id === node.childDiagramId);
        if (childDiag) {
          stack.push(childDiag);
        }
      }
    }
  }

  return result;
}

/**
 * ノードに対するサブ図（詳細図）を作成または取得
 * 仕様書 6.2: 既存子図がある場合はその図へ移動、なければ空の子Diagramを作る
 */
export function createSubDiagramForNode(
  project: Project,
  parentDiagramId: string,
  parentNodeId: string,
  title?: string
): { project: Project; childDiagramId: string; created: boolean } {
  const parentDiag = project.diagrams.find((d) => d.id === parentDiagramId);
  if (!parentDiag) {
    throw new Error('親図が見つかりません');
  }

  const parentNode = parentDiag.nodes.find((n) => n.id === parentNodeId);
  if (!parentNode) {
    throw new Error('親ノードが見つかりません');
  }

  if (parentNode.childDiagramId) {
    // 既に存在する場合は既存子図を返す
    return {
      project,
      childDiagramId: parentNode.childDiagramId,
      created: false,
    };
  }

  if (project.diagrams.length >= TPDD_LIMITS.MAX_DIAGRAMS) {
    throw new Error('図は最大100個までです');
  }

  let diagramTitle: string;
  if (title !== undefined) {
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error('図タイトルは空にできません');
    }
    if (trimmed.length > TPDD_LIMITS.LABEL_MAX_LENGTH) {
      throw new Error('図タイトルは200文字以内です');
    }
    diagramTitle = trimmed;
  } else {
    const suffix = ' の詳細';
    const maxPrefixLen = TPDD_LIMITS.LABEL_MAX_LENGTH - suffix.length;
    const baseLabel =
      parentNode.label.length > maxPrefixLen
        ? parentNode.label.slice(0, maxPrefixLen)
        : parentNode.label;
    diagramTitle = `${baseLabel}${suffix}`;
  }

  const newDiagramId = generateId();

  const newDiagram = {
    id: newDiagramId,
    title: diagramTitle,
    nodes: [],
    edges: [],
  };

  const updatedDiagrams = project.diagrams.map((d) => {
    if (d.id !== parentDiagramId) return d;
    return {
      ...d,
      nodes: d.nodes.map((n) => {
        if (n.id !== parentNodeId) return n;
        return {
          ...n,
          childDiagramId: newDiagramId,
        };
      }),
    };
  });

  return {
    project: {
      ...project,
      updatedAt: new Date().toISOString(),
      diagrams: [...updatedDiagrams, newDiagram],
    },
    childDiagramId: newDiagramId,
    created: true,
  };
}

/**
 * サブ図の削除 (子孫図も含めてカスケード削除)
 * 仕様書 6.2: 子孫図を含めて削除し、親ノードのchildDiagramIdも解除
 */
export function removeDiagramCascade(
  project: Project,
  diagramIdToRemove: string
): { project: Project; removedDiagramIds: string[] } {
  if (diagramIdToRemove === project.rootDiagramId) {
    throw new Error('ルート図は削除できません');
  }

  const descendants = findDescendantDiagramIds(project, diagramIdToRemove);
  const idsToRemove = new Set([diagramIdToRemove, ...descendants]);

  // 親ノードの childDiagramId を解除
  const updatedDiagrams = project.diagrams
    .filter((d) => !idsToRemove.has(d.id))
    .map((d) => ({
      ...d,
      nodes: d.nodes.map((n) => {
        if (n.childDiagramId && idsToRemove.has(n.childDiagramId)) {
          const { childDiagramId, ...rest } = n;
          return rest as ThoughtNode;
        }
        return n;
      }),
    }));

  return {
    project: {
      ...project,
      updatedAt: new Date().toISOString(),
      diagrams: updatedDiagrams,
    },
    removedDiagramIds: Array.from(idsToRemove),
  };
}

/**
 * ノード削除（もし子図を持っていれば子孫図もカスケード削除）
 * 仕様書 6.2: 親ノード削除時は子孫図を含めて削除
 */
export function removeNodeWithDescendants(
  project: Project,
  diagramId: string,
  nodeId: string
): { project: Project; removedDiagramCount: number } {
  const diag = project.diagrams.find((d) => d.id === diagramId);
  const node = diag?.nodes.find((n) => n.id === nodeId);

  let updatedProj = project;
  let removedDiagramCount = 0;

  if (node?.childDiagramId) {
    const cascadeResult = removeDiagramCascade(updatedProj, node.childDiagramId);
    updatedProj = cascadeResult.project;
    removedDiagramCount = cascadeResult.removedDiagramIds.length;
  }

  updatedProj = removeNodeFromDiagram(updatedProj, diagramId, nodeId);

  return {
    project: updatedProj,
    removedDiagramCount,
  };
}

/**
 * 図タイトルの変更
 */
export function updateDiagramTitle(
  project: Project,
  diagramId: string,
  newTitle: string
): Project {
  const trimmed = newTitle.trim();
  if (!trimmed || trimmed.length > TPDD_LIMITS.LABEL_MAX_LENGTH) {
    return project;
  }
  if (!project.diagrams.some((d) => d.id === diagramId)) {
    return project;
  }
  return {
    ...project,
    updatedAt: new Date().toISOString(),
    diagrams: project.diagrams.map((d) =>
      d.id === diagramId ? { ...d, title: trimmed } : d
    ),
  };
}

/**
 * プロジェクト名の変更
 */
export function updateProjectTitle(project: Project, newTitle: string): Project {
  const trimmed = newTitle.trim();
  if (!trimmed || trimmed.length > TPDD_LIMITS.LABEL_MAX_LENGTH) {
    return project;
  }
  return {
    ...project,
    title: trimmed,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * プロジェクトメタ情報パッチの検証
 */
export function validateProjectMetaPatch(patch: {
  title?: string;
  description?: string;
}): string | null {
  if (patch.title !== undefined) {
    const trimmed = patch.title.trim();
    if (!trimmed) return 'プロジェクト名は空にできません';
    if (trimmed.length > TPDD_LIMITS.LABEL_MAX_LENGTH) return 'プロジェクト名は200文字以内です';
  }
  if (patch.description !== undefined) {
    if (patch.description.length > TPDD_LIMITS.DESCRIPTION_MAX_LENGTH) {
      return '説明は10,000文字以内です';
    }
  }
  return null;
}

/**
 * プロジェクトメタ情報（タイトル・説明）の更新
 */
export function updateProjectMeta(
  project: Project,
  patch: { title?: string; description?: string }
): Project {
  if (validateProjectMetaPatch(patch)) {
    return project;
  }
  return {
    ...project,
    title: patch.title !== undefined ? patch.title.trim() : project.title,
    description: patch.description !== undefined ? patch.description : project.description,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * ノード種別の追加
 */
export function addNodeKind(
  project: Project,
  label: string,
  description = '',
  paletteKey: NodePaletteKey = 'gray'
): Project {
  if (project.nodeKinds.length >= TPDD_LIMITS.MAX_NODE_KINDS) {
    throw new Error(`ノード種別は最大${TPDD_LIMITS.MAX_NODE_KINDS}件までです`);
  }

  const candidate: NodeKindDefinition = {
    id: `kind-${generateId().slice(0, 8)}`,
    label: label.trim() || '新規種別',
    description,
    paletteKey,
  };
  const parsed = NodeKindDefinitionSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message || 'ノード種別のデータが不正です');
  }

  return {
    ...project,
    updatedAt: new Date().toISOString(),
    nodeKinds: [...project.nodeKinds, parsed.data],
  };
}

/**
 * ノード種別の更新
 */
export function updateNodeKind(
  project: Project,
  kindId: string,
  patch: Partial<Pick<NodeKindDefinition, 'label' | 'description' | 'paletteKey'>>
): Project {
  const target = project.nodeKinds.find((kind) => kind.id === kindId);
  if (!target) return project;

  const candidate: NodeKindDefinition = {
    ...target,
    ...patch,
    label: patch.label !== undefined ? patch.label.trim() : target.label,
  };
  const parsed = NodeKindDefinitionSchema.safeParse(candidate);
  if (!parsed.success) return project;

  return {
    ...project,
    updatedAt: new Date().toISOString(),
    nodeKinds: project.nodeKinds.map((kind) => (kind.id === kindId ? parsed.data : kind)),
  };
}

/**
 * ノード種別の削除（全図の参照ノードを別種別へ一括再割り当て）
 */
export function removeNodeKindWithReassign(
  project: Project,
  kindIdToRemove: string,
  targetKindId: string
): Project {
  if (project.nodeKinds.length <= 1) {
    throw new Error('最低1つのノード種別が必要です');
  }
  if (!project.nodeKinds.some((kind) => kind.id === kindIdToRemove)) {
    throw new Error('削除対象のノード種別が存在しません');
  }
  if (kindIdToRemove === targetKindId) {
    throw new Error('移動先は別のノード種別を指定してください');
  }
  if (!project.nodeKinds.some((kind) => kind.id === targetKindId)) {
    throw new Error('移動先のノード種別が存在しません');
  }

  return {
    ...project,
    updatedAt: new Date().toISOString(),
    nodeKinds: project.nodeKinds.filter((kind) => kind.id !== kindIdToRemove),
    diagrams: project.diagrams.map((diagram) => ({
      ...diagram,
      nodes: diagram.nodes.map((node) =>
        node.kindId === kindIdToRemove ? { ...node, kindId: targetKindId } : node
      ),
    })),
  };
}

/**
 * 抽象度列の追加 (1〜12列)
 */
export function addLevel(project: Project, label: string, description = ''): Project {
  if (project.levels.length >= TPDD_LIMITS.MAX_LEVELS) {
    throw new Error('抽象度列は最大12列までです');
  }

  const candidate: LevelDefinition = {
    id: `level-${generateId().slice(0, 8)}`,
    label: label.trim() || '新規列',
    description,
  };
  const parsed = LevelDefinitionSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(parsed.error.issues[0]?.message || '抽象度列のデータが不正です');
  }

  return {
    ...project,
    updatedAt: new Date().toISOString(),
    levels: [...project.levels, parsed.data],
  };
}

/**
 * 抽象度列の更新
 */
export function updateLevel(
  project: Project,
  levelId: string,
  patch: Partial<Pick<LevelDefinition, 'label' | 'description'>>
): Project {
  const target = project.levels.find((l) => l.id === levelId);
  if (!target) return project;

  const normalizedPatch: Partial<Pick<LevelDefinition, 'label' | 'description'>> =
    patch.label !== undefined ? { ...patch, label: patch.label.trim() } : patch;

  const candidate: LevelDefinition = {
    ...target,
    ...normalizedPatch,
  };
  if (!LevelDefinitionSchema.safeParse(candidate).success) {
    return project;
  }

  return {
    ...project,
    updatedAt: new Date().toISOString(),
    levels: project.levels.map((l) => (l.id === levelId ? candidate : l)),
  };
}

/**
 * 抽象度列の削除 (所属ノードを指定の別列へ一括再割り当て)
 * 仕様書 4.1: 列を削除する場合、その列のノードの移動先を選択してから一括更新する
 */
export function removeLevelWithReassign(
  project: Project,
  levelIdToRemove: string,
  targetLevelId: string
): Project {
  if (project.levels.length <= 1) {
    throw new Error('最低1つの抽象度列が必要です');
  }
  if (!project.levels.some((l) => l.id === levelIdToRemove)) {
    throw new Error('削除対象の抽象度列が存在しません');
  }
  if (levelIdToRemove === targetLevelId) {
    throw new Error('移動先は別の列を指定してください');
  }
  const targetExists = project.levels.some((l) => l.id === targetLevelId);
  if (!targetExists) {
    throw new Error('移動先の抽象度列が存在しません');
  }

  // 全図のノードで levelIdToRemove を参照しているものを targetLevelId へ変更
  const diagrams = project.diagrams.map((d) => ({
    ...d,
    nodes: d.nodes.map((n) =>
      n.levelId === levelIdToRemove ? { ...n, levelId: targetLevelId } : n
    ),
  }));

  const levels = project.levels.filter((l) => l.id !== levelIdToRemove);

  return {
    ...project,
    updatedAt: new Date().toISOString(),
    levels,
    diagrams,
  };
}


