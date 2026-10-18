import { Project, ProjectSchema } from './schema';

export interface ValidationError {
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * Projectモデル全体の整合性規則を検証する純粋関数
 * 仕様書 4.2 整合性規則、12章 上限値に対応
 */
export function validateProject(project: Project): ValidationResult {
  const errors: ValidationError[] = [];

  // 1. Zod スキーマ検証
  const zodParsed = ProjectSchema.safeParse(project);
  if (!zodParsed.success) {
    for (const issue of zodParsed.error.issues) {
      errors.push({
        path: issue.path.join('.'),
        message: issue.message,
      });
    }
    return { valid: false, errors };
  }

  // 2. ID一意性チェック (Project全体)
  const diagramIds = new Set<string>();
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();

  const levelIds = new Set(project.levels.map((l) => l.id));

  // 列の重複orderチェック
  const orders = new Set<number>();
  for (const level of project.levels) {
    if (orders.has(level.order)) {
      errors.push({
        path: `levels.${level.id}`,
        message: `抽象度列のorder (${level.order}) が重複しています`,
      });
    }
    orders.add(level.order);
  }

  // rootDiagramIdの存在チェック
  let rootDiagramExists = false;

  let totalNodes = 0;
  let totalEdges = 0;

  // 各ノードが参照する childDiagramId のマップ (子図ID -> 親ノードID)
  const childToParentNode = new Map<string, string>();

  for (const diagram of project.diagrams) {
    // 図IDの一意性
    if (diagramIds.has(diagram.id)) {
      errors.push({
        path: `diagrams.${diagram.id}`,
        message: `図ID (${diagram.id}) が重複しています`,
      });
    }
    diagramIds.add(diagram.id);

    if (diagram.id === project.rootDiagramId) {
      rootDiagramExists = true;
    }

    const currentDiagramNodeIds = new Set<string>();

    for (const node of diagram.nodes) {
      totalNodes++;
      // ノードIDの一意性 (Project全体)
      if (nodeIds.has(node.id)) {
        errors.push({
          path: `diagrams.${diagram.id}.nodes.${node.id}`,
          message: `ノードID (${node.id}) がProject内で重複しています`,
        });
      }
      nodeIds.add(node.id);
      currentDiagramNodeIds.add(node.id);

      // levelIdの存在
      if (!levelIds.has(node.levelId)) {
        errors.push({
          path: `diagrams.${diagram.id}.nodes.${node.id}.levelId`,
          message: `存在しない抽象度列ID (${node.levelId}) を参照しています`,
        });
      }

      // childDiagramId の検証
      if (node.childDiagramId) {
        if (childToParentNode.has(node.childDiagramId)) {
          errors.push({
            path: `diagrams.${diagram.id}.nodes.${node.id}.childDiagramId`,
            message: `子図 (${node.childDiagramId}) が複数の親ノードから参照されています（共有子図の禁止）`,
          });
        }
        childToParentNode.set(node.childDiagramId, node.id);
      }
    }

    // エッジの重複・自己ループチェック (同じDiagram内)
    const edgeKeySet = new Set<string>();

    for (const edge of diagram.edges) {
      totalEdges++;
      // エッジIDの一意性 (Project全体)
      if (edgeIds.has(edge.id)) {
        errors.push({
          path: `diagrams.${diagram.id}.edges.${edge.id}`,
          message: `エッジID (${edge.id}) がProject内で重複しています`,
        });
      }
      edgeIds.add(edge.id);

      // 自己エッジ禁止
      if (edge.sourceId === edge.targetId) {
        errors.push({
          path: `diagrams.${diagram.id}.edges.${edge.id}`,
          message: `自己エッジは禁止されています (sourceId = targetId = ${edge.sourceId})`,
        });
      }

      // エッジの両端は同じDiagram内のノードを参照すること
      if (!currentDiagramNodeIds.has(edge.sourceId)) {
        errors.push({
          path: `diagrams.${diagram.id}.edges.${edge.id}.sourceId`,
          message: `始点ノード (${edge.sourceId}) が現在の図内に存在しません`,
        });
      }
      if (!currentDiagramNodeIds.has(edge.targetId)) {
        errors.push({
          path: `diagrams.${diagram.id}.edges.${edge.id}.targetId`,
          message: `終点ノード (${edge.targetId}) が現在の図内に存在しません`,
        });
      }

      // 重複エッジ禁止: 同じsourceId, targetId, kind
      const edgeKey = `${edge.sourceId}-->${edge.targetId}::${edge.kind}`;
      if (edgeKeySet.has(edgeKey)) {
        errors.push({
          path: `diagrams.${diagram.id}.edges.${edge.id}`,
          message: `同一方向・同一種別の重複エッジは禁止されています (${edgeKey})`,
        });
      }
      edgeKeySet.add(edgeKey);
    }
  }

  // rootDiagramIdの検証
  if (!rootDiagramExists) {
    errors.push({
      path: 'rootDiagramId',
      message: `ルート図ID (${project.rootDiagramId}) がdiagrams一覧に存在しません`,
    });
  }

  // ルート図は親ノードを持たないこと
  if (childToParentNode.has(project.rootDiagramId)) {
    errors.push({
      path: 'rootDiagramId',
      message: `ルート図 (${project.rootDiagramId}) が親ノードの子図として指定されています`,
    });
  }

  // 子図の存在・循環・孤立図チェック
  for (const [childId] of childToParentNode) {
    if (!diagramIds.has(childId)) {
      errors.push({
        path: `childDiagramId.${childId}`,
        message: `子図ID (${childId}) の図が存在しません`,
      });
    }
  }

  // 孤立した図 (ルート図でもなく、どの親ノードからも参照されていない図) の検出
  for (const diagId of diagramIds) {
    if (diagId !== project.rootDiagramId && !childToParentNode.has(diagId)) {
      errors.push({
        path: `diagrams.${diagId}`,
        message: `孤立した図 (${diagId}) が存在します（親ノードがありません）`,
      });
    }
  }

  // 図階層の循環検出 (有向グラフの閉路検出)
  // ノードから子図へのポインタ: diagram -> list of child diagrams
  const diagramChildren = new Map<string, string[]>();
  for (const diagram of project.diagrams) {
    const children: string[] = [];
    for (const node of diagram.nodes) {
      if (node.childDiagramId && diagramIds.has(node.childDiagramId)) {
        children.push(node.childDiagramId);
      }
    }
    diagramChildren.set(diagram.id, children);
  }

  const visited = new Set<string>();
  const recStack = new Set<string>();

  function hasCycle(dId: string, pathTrace: string[]): boolean {
    visited.add(dId);
    recStack.add(dId);

    const children = diagramChildren.get(dId) || [];
    for (const child of children) {
      if (!visited.has(child)) {
        if (hasCycle(child, [...pathTrace, child])) return true;
      } else if (recStack.has(child)) {
        errors.push({
          path: `hierarchy.${dId}`,
          message: `図階層に循環が検出されました: ${pathTrace.join(' -> ')} -> ${child}`,
        });
        return true;
      }
    }

    recStack.delete(dId);
    return false;
  }

  for (const diagId of diagramIds) {
    if (!visited.has(diagId)) {
      hasCycle(diagId, [diagId]);
    }
  }

  // 上限値チェック (仕様書第12章: 合計5,000ノード、10,000エッジ)
  if (totalNodes > 5000) {
    errors.push({
      path: 'totalNodes',
      message: `Project全体の合計ノード数 (${totalNodes}) が上限5000を超えています`,
    });
  }
  if (totalEdges > 10000) {
    errors.push({
      path: 'totalEdges',
      message: `Project全体の合計エッジ数 (${totalEdges}) が上限10000を超えています`,
    });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
