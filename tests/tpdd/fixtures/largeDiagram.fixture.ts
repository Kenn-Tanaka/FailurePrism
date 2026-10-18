import { Project, ThoughtNode, ThoughtEdge } from '../../../src/tools/tpdd/domain/schema';

/**
 * 仕様書 N01 (通常規模: 200ノード、400エッジ) のテスト用フィクスチャ生成
 */
export function createLargeDiagramProject(nodeCount = 200, edgeCount = 400): Project {
  const levelIds = ['level-req', 'level-func', 'level-mech', 'level-struct'];
  const nodes: ThoughtNode[] = [];
  const edges: ThoughtEdge[] = [];

  for (let i = 1; i <= nodeCount; i++) {
    const levelIndex = (i - 1) % levelIds.length;
    const levelId = levelIds[levelIndex];
    const kind = (['requirement', 'function', 'mechanism', 'structure'] as const)[levelIndex];

    nodes.push({
      id: `node-${i}`,
      label: `大規模ノード ${i} の詳細設計要素`,
      kind,
      status: 'draft',
      levelId,
      x: 50 + levelIndex * 250,
      y: 100 + Math.floor((i - 1) / levelIds.length) * 120,
      width: 180,
      height: 72,
      meta: {
        description: `ノード ${i} の詳細説明文です。`,
        tags: [`tag-${i % 10}`],
        sourceLinks: [],
      },
      provenance: {
        origin: 'manual',
        createdAt: '2026-09-30T10:00:00.000Z',
      },
    });
  }

  // 400エッジの生成 (隣接列または同一列、自己ループなし、重複なし)
  let edgeIdCounter = 1;
  const edgeSet = new Set<string>();

  for (let i = 1; i <= nodeCount && edgeIdCounter <= edgeCount; i++) {
    // 1ノードあたり2本程度のエッジを生成
    for (let offset = 1; offset <= 3 && edgeIdCounter <= edgeCount; offset++) {
      const targetIndex = ((i - 1 + offset) % nodeCount) + 1;
      if (i === targetIndex) continue;

      const edgeKey = `node-${i}->node-${targetIndex}`;
      if (!edgeSet.has(edgeKey)) {
        edgeSet.add(edgeKey);
        edges.push({
          id: `edge-${edgeIdCounter++}`,
          sourceId: `node-${i}`,
          targetId: `node-${targetIndex}`,
          kind: offset === 1 ? 'decomposition' : 'dependency',
          label: `接続 ${edgeIdCounter - 1}`,
        });
      }
    }
  }

  return {
    format: 'thought-expansion-project',
    schemaVersion: 1,
    id: 'large-project-1',
    title: '大規模思考展開図 (200ノード・400エッジ)',
    description: 'N01規模の負荷および整合性検証用プロジェクト',
    createdAt: '2026-09-30T10:00:00.000Z',
    updatedAt: '2026-09-30T10:00:00.000Z',
    rootDiagramId: 'diagram-root',
    levels: [
      { id: 'level-req', label: '要求', order: 0 },
      { id: 'level-func', label: '機能', order: 1 },
      { id: 'level-mech', label: '機構', order: 2 },
      { id: 'level-struct', label: '構造', order: 3 },
    ],
    diagrams: [
      {
        id: 'diagram-root',
        title: 'ルート展開図',
        nodes,
        edges,
      },
    ],
    aiPreferences: {
      modelId: 'lmstudio/default',
      timeoutSeconds: 600,
      temperature: null,
      stream: true,
    },
  };
}
