import { Project, ThoughtEdge, ThoughtNode } from '../../domain/schema';
import { generateId } from '../../shared/id';
import { ProposalResponse } from '../../services/llm/aiSchemas';
import { PROMPT_VERSION } from '../../services/llm/prompts';

export interface AdoptionSelection {
  selectedCandidateIds: Set<string>; // ユーザーが選択した候補ID
}

export interface AdoptionResult {
  project: Project;
  addedNodeCount: number;
  addedEdgeCount: number;
  omittedEdgeCount: number; // 未選択ノードに繋がっていたため除外されたエッジ数
}

/**
 * 候補採用トランザクション
 * 仕様書 9.5: 選択した候補ノード・解決可能エッジのみを一括追加し、Undoで一括取消可能にする
 */
export function adoptProposals(
  currentProject: Project,
  diagramId: string,
  response: ProposalResponse,
  selection: AdoptionSelection,
  metadata: { modelId: string; requestId?: string }
): AdoptionResult {
  const diagram = currentProject.diagrams.find((d) => d.id === diagramId);
  if (!diagram) {
    throw new Error('対象の図が見つかりません');
  }

  const existingNodeIdSet = new Set(diagram.nodes.map((n) => n.id));
  const candidateToNewIdMap = new Map<string, string>(); // candidateId (例: c1) -> 新規UUID

  const newNodes: ThoughtNode[] = [];
  const now = new Date().toISOString();

  // 列ごとの最大Y座標マップ (重なりを避けて下方に配置するため)
  const levelMaxYMap = new Map<string, number>();
  for (const node of diagram.nodes) {
    const currentMax = levelMaxYMap.get(node.levelId) ?? 50;
    levelMaxYMap.set(node.levelId, Math.max(currentMax, node.y + node.height));
  }

  // 列のX座標マップ (order順)
  const sortedLevels = [...currentProject.levels].sort((a, b) => a.order - b.order);
  const levelXMap = new Map<string, number>();
  sortedLevels.forEach((lvl, idx) => {
    levelXMap.set(lvl.id, idx * 320 + 60);
  });

  // 1. 選択された候補ノードの生成
  for (const candidate of response.nodes) {
    if (!selection.selectedCandidateIds.has(candidate.candidateId)) {
      continue;
    }

    const newNodeId = generateId();
    candidateToNewIdMap.set(candidate.candidateId, newNodeId);

    // 説明文の統合 (説明 + 提案理由 + 前提 + 確認事項)
    let fullDescription = candidate.description;
    if (candidate.rationale) {
      fullDescription += `\n\n【提案理由】\n${candidate.rationale}`;
    }
    if (candidate.assumptions && candidate.assumptions.length > 0) {
      fullDescription += `\n\n【前提・仮定】\n${candidate.assumptions.map((a) => `・${a}`).join('\n')}`;
    }
    if (candidate.checks && candidate.checks.length > 0) {
      fullDescription += `\n\n【要確認事項】\n${candidate.checks.map((c) => `・${c}`).join('\n')}`;
    }
    if (fullDescription.length > 10000) {
      fullDescription = fullDescription.slice(0, 9997) + '...';
    }

    // 配置座標の決定
    const colX = levelXMap.get(candidate.levelId) ?? 100;
    const currentMaxY = levelMaxYMap.get(candidate.levelId) ?? 80;
    const nodeY = currentMaxY + 30; // 30pxの垂直ギャップ
    levelMaxYMap.set(candidate.levelId, nodeY + 72);

    const newNode: ThoughtNode = {
      id: newNodeId,
      label: candidate.label,
      kind: candidate.kind,
      status: 'candidate', // 仕様書 9.5: 追加内容は candidate 状態で図へ入れる
      levelId: candidate.levelId,
      x: colX,
      y: nodeY,
      width: 180,
      height: 72,
      meta: {
        description: fullDescription.trim(),
        tags: candidate.tags || [],
        sourceLinks: [],
      },
      provenance: {
        origin: 'llm',
        createdAt: now,
        modelId: metadata.modelId,
        task: response.task,
        promptVersion: PROMPT_VERSION,
        requestId: metadata.requestId,
      },
    };

    newNodes.push(newNode);
  }

  // 2. エッジの解決とフィルタリング
  const resolveRefToId = (ref: string): string | null => {
    if (ref.startsWith('candidate:')) {
      const cId = ref.slice('candidate:'.length);
      return candidateToNewIdMap.get(cId) ?? null;
    }
    if (ref.startsWith('existing:')) {
      const eId = ref.slice('existing:'.length);
      return existingNodeIdSet.has(eId) ? eId : null;
    }
    return null;
  };

  const newEdges: ThoughtEdge[] = [];
  let omittedEdgeCount = 0;

  for (const edgeProp of response.edges) {
    const sourceId = resolveRefToId(edgeProp.sourceRef);
    const targetId = resolveRefToId(edgeProp.targetRef);

    // 両端が解決でき、自己ループでなければ採用
    if (sourceId && targetId && sourceId !== targetId) {
      const isDuplicateInExisting = diagram.edges.some(
        (e: ThoughtEdge) => e.sourceId === sourceId && e.targetId === targetId && e.kind === edgeProp.kind
      );
      const isDuplicateInNew = newEdges.some(
        (e: ThoughtEdge) => e.sourceId === sourceId && e.targetId === targetId && e.kind === edgeProp.kind
      );

      if (isDuplicateInExisting || isDuplicateInNew) {
        omittedEdgeCount++;
        continue;
      }

      newEdges.push({
        id: generateId(),
        sourceId,
        targetId,
        kind: edgeProp.kind,
        label: edgeProp.label || '',
      });
    } else {
      // 未選択ノードに繋がっていたなどの理由で除外
      omittedEdgeCount++;
    }
  }

  // 3. Projectへ不変合成
  const updatedDiagrams = currentProject.diagrams.map((d) => {
    if (d.id !== diagramId) return d;
    return {
      ...d,
      nodes: [...d.nodes, ...newNodes],
      edges: [...d.edges, ...newEdges],
    };
  });

  return {
    project: {
      ...currentProject,
      updatedAt: now,
      diagrams: updatedDiagrams,
    },
    addedNodeCount: newNodes.length,
    addedEdgeCount: newEdges.length,
    omittedEdgeCount,
  };
}
