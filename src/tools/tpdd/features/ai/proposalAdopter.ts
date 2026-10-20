import { Project, TPDD_LIMITS, ThoughtEdge, ThoughtNode } from '../../domain/schema';
import { validateProject } from '../../domain/validation';
import { generateId } from '../../shared/id';
import { ProposalResponse } from '../../services/llm/aiSchemas';
import { PROMPT_VERSION } from '../../services/llm/prompts';

export interface ProposalRunContext {
  projectId: string;
  diagramId: string;
  focusNodeId: string;
  targetLevelId: string;
  task: 'expand' | 'alternatives';
  revision: number;
  modelId: string;
  requestId?: string;
}

export interface AdoptionSelection {
  selectedCandidateIds: Set<string>;
}

export interface AdoptionResult {
  project: Project;
  addedNodeCount: number;
  addedEdgeCount: number;
}

function buildDescription(candidate: ProposalResponse['nodes'][number]): string {
  const sections = [candidate.description.trim()];
  if (candidate.rationale) {
    sections.push(`【提案理由】\n${candidate.rationale}`);
  }
  if (candidate.assumptions.length > 0) {
    sections.push(`【前提・仮定】\n${candidate.assumptions.map((item) => `・${item}`).join('\n')}`);
  }
  if (candidate.checks.length > 0) {
    sections.push(`【要確認事項】\n${candidate.checks.map((item) => `・${item}`).join('\n')}`);
  }
  const description = sections.filter(Boolean).join('\n\n');
  if (description.length <= TPDD_LIMITS.DESCRIPTION_MAX_LENGTH) {
    return description;
  }
  return `${description.slice(0, TPDD_LIMITS.DESCRIPTION_MAX_LENGTH - 3)}...`;
}

/**
 * 選択候補を1回のUndo単位で追加する。
 * 配置列と接続元は推論開始時の文脈だけを使い、LLMには決めさせない。
 */
export function adoptProposals(
  currentProject: Project,
  context: ProposalRunContext,
  response: ProposalResponse,
  selection: AdoptionSelection
): AdoptionResult {
  if (currentProject.id !== context.projectId) {
    throw new Error('推論対象とは異なるプロジェクトです。再度推論を実行してください。');
  }

  const diagram = currentProject.diagrams.find((item) => item.id === context.diagramId);
  if (!diagram) {
    throw new Error('推論対象の図が見つかりません。');
  }
  if (!diagram.nodes.some((node) => node.id === context.focusNodeId)) {
    throw new Error('推論対象のフォーカスノードが見つかりません。');
  }
  if (!currentProject.levels.some((level) => level.id === context.targetLevelId)) {
    throw new Error('配置先の列が見つかりません。');
  }

  const selected = response.nodes.filter((candidate) =>
    selection.selectedCandidateIds.has(candidate.candidateId)
  );
  if (selected.length === 0) {
    throw new Error('採用する候補を1件以上選択してください。');
  }

  const knownKindIds = new Set(currentProject.nodeKinds.map((kind) => kind.id));
  const unresolved = selected.find(
    (candidate) => candidate.kindId === null || !knownKindIds.has(candidate.kindId)
  );
  if (unresolved) {
    throw new Error(`候補「${unresolved.label}」の内容の種別を選択してください。`);
  }

  const totalNodes = currentProject.diagrams.reduce((sum, item) => sum + item.nodes.length, 0);
  const totalEdges = currentProject.diagrams.reduce((sum, item) => sum + item.edges.length, 0);
  if (diagram.nodes.length + selected.length > TPDD_LIMITS.MAX_NODES_PER_DIAGRAM) {
    throw new Error(`1図あたりのノード上限は${TPDD_LIMITS.MAX_NODES_PER_DIAGRAM}件です。`);
  }
  if (totalNodes + selected.length > TPDD_LIMITS.MAX_TOTAL_NODES) {
    throw new Error(`Project全体のノード上限は${TPDD_LIMITS.MAX_TOTAL_NODES}件です。`);
  }
  if (diagram.edges.length + selected.length > TPDD_LIMITS.MAX_EDGES_PER_DIAGRAM) {
    throw new Error(`1図あたりのエッジ上限は${TPDD_LIMITS.MAX_EDGES_PER_DIAGRAM}件です。`);
  }
  if (totalEdges + selected.length > TPDD_LIMITS.MAX_TOTAL_EDGES) {
    throw new Error(`Project全体のエッジ上限は${TPDD_LIMITS.MAX_TOTAL_EDGES}件です。`);
  }

  const levelIndex = currentProject.levels.findIndex(
    (level) => level.id === context.targetLevelId
  );
  let maxY = diagram.nodes
    .filter((node) => node.levelId === context.targetLevelId)
    .reduce((max, node) => Math.max(max, node.y + node.height), 50);
  const now = new Date().toISOString();
  const newNodes: ThoughtNode[] = [];
  const newEdges: ThoughtEdge[] = [];

  for (const candidate of selected) {
    // unresolvedは上で排除済み。ここでの局所変数により型も明確にする。
    const kindId = candidate.kindId as string;
    const nodeId = generateId();
    const y = maxY + 30;
    maxY = y + 72;

    newNodes.push({
      id: nodeId,
      label: candidate.label,
      kindId,
      status: 'candidate',
      levelId: context.targetLevelId,
      x: levelIndex * 320 + 60,
      y,
      width: 180,
      height: 72,
      meta: {
        description: buildDescription(candidate),
        tags: candidate.tags,
        sourceLinks: [],
      },
      provenance: {
        origin: 'llm',
        createdAt: now,
        modelId: context.modelId,
        task: context.task,
        promptVersion: PROMPT_VERSION,
        requestId: context.requestId,
      },
    });

    newEdges.push({
      id: generateId(),
      sourceId: context.focusNodeId,
      targetId: nodeId,
      kind: context.task === 'expand' ? 'decomposition' : 'reference',
      label: context.task === 'expand' ? '分解' : '代替',
    });
  }

  const nextProject: Project = {
    ...currentProject,
    updatedAt: now,
    diagrams: currentProject.diagrams.map((item) =>
      item.id === context.diagramId
        ? {
            ...item,
            nodes: [...item.nodes, ...newNodes],
            edges: [...item.edges, ...newEdges],
          }
        : item
    ),
  };

  const validation = validateProject(nextProject);
  if (!validation.valid) {
    throw new Error(
      `候補を採用するとデータ整合性が崩れるため中止しました: ${validation.errors
        .slice(0, 3)
        .map((error) => error.message)
        .join(' / ')}`
    );
  }

  return {
    project: nextProject,
    addedNodeCount: newNodes.length,
    addedEdgeCount: newEdges.length,
  };
}
