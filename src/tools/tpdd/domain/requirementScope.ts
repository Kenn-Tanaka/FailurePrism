import { Project } from './schema';

export interface RequirementScopeDiagram {
  ref: string;
  sourceId: string;
  title: string;
  ownerNodeRef?: string;
}

export interface RequirementScopeKind {
  ref: string;
  label: string;
  description: string;
}

export interface RequirementScopeLevel {
  ref: string;
  label: string;
  description: string;
}

export interface RequirementScopeNode {
  ref: string;
  sourceId: string;
  diagramRef: string;
  kindRef: string;
  levelRef: string;
  label: string;
  status: string;
  description: string;
  tags: string[];
  isRoot: boolean;
}

export interface RequirementScopeEdge {
  ref: string;
  sourceId: string;
  diagramRef: string;
  sourceNodeRef: string;
  targetNodeRef: string;
  kind: string;
  label: string;
}

/** A deterministic, root-bounded evidence set for experimental requirement explanations. */
export interface RequirementScope {
  rootNodeRef: string;
  diagrams: RequirementScopeDiagram[];
  nodeKinds: RequirementScopeKind[];
  levels: RequirementScopeLevel[];
  nodes: RequirementScopeNode[];
  edges: RequirementScopeEdge[];
}

/**
 * Collects only decomposition descendants of the selected node plus diagrams explicitly
 * attached to those nodes. All nodes inside an attached detail diagram are included as
 * detail-diagram evidence, but the parent/detail link is not represented as a decomposition edge.
 */
export function collectRequirementScope(project: Project, rootNodeId: string): RequirementScope | null {
  const nodeLocations = new Map<string, { node: Project['diagrams'][number]['nodes'][number]; diagram: Project['diagrams'][number] }>();
  const diagramsById = new Map(project.diagrams.map((diagram) => [diagram.id, diagram]));
  for (const diagram of project.diagrams) {
    for (const node of diagram.nodes) nodeLocations.set(node.id, { node, diagram });
  }

  const rootLocation = nodeLocations.get(rootNodeId);
  if (!rootLocation) return null;

  const includedNodeIds = new Set<string>();
  const nodeOrder: string[] = [];
  const queue: string[] = [];
  const diagramOrder: string[] = [rootLocation.diagram.id];
  const includedDiagramIds = new Set(diagramOrder);
  const detailOwnerByDiagramId = new Map<string, string>();

  const includeNode = (nodeId: string) => {
    if (!nodeLocations.has(nodeId) || includedNodeIds.has(nodeId)) return;
    includedNodeIds.add(nodeId);
    nodeOrder.push(nodeId);
    queue.push(nodeId);
  };

  includeNode(rootNodeId);
  for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
    const currentLocation = nodeLocations.get(queue[queueIndex]);
    if (!currentLocation) continue;
    const { node, diagram } = currentLocation;

    if (node.childDiagramId) {
      const childDiagram = diagramsById.get(node.childDiagramId);
      if (childDiagram && !includedDiagramIds.has(childDiagram.id)) {
        includedDiagramIds.add(childDiagram.id);
        diagramOrder.push(childDiagram.id);
        detailOwnerByDiagramId.set(childDiagram.id, node.id);
        childDiagram.nodes.forEach((childNode) => includeNode(childNode.id));
      }
    }

    for (const edge of diagram.edges) {
      if (edge.kind === 'decomposition' && edge.sourceId === node.id) {
        const targetLocation = nodeLocations.get(edge.targetId);
        if (targetLocation?.diagram.id === diagram.id) includeNode(edge.targetId);
      }
    }
  }

  const nodeRefById = new Map(nodeOrder.map((nodeId, index) => [nodeId, `N${index + 1}`]));
  const diagramRefById = new Map(diagramOrder.map((diagramId, index) => [diagramId, `D${index + 1}`]));
  const usedKindIds = new Set(nodeOrder.map((nodeId) => nodeLocations.get(nodeId)!.node.kindId));
  const usedLevelIds = new Set(nodeOrder.map((nodeId) => nodeLocations.get(nodeId)!.node.levelId));
  const usedKinds = project.nodeKinds.filter((kind) => usedKindIds.has(kind.id));
  const usedLevels = project.levels.filter((level) => usedLevelIds.has(level.id));
  const kindRefById = new Map(usedKinds.map((kind, index) => [kind.id, `K${index + 1}`]));
  const levelRefById = new Map(usedLevels.map((level, index) => [level.id, `L${index + 1}`]));

  const nodes: RequirementScopeNode[] = nodeOrder.flatMap((nodeId) => {
    const location = nodeLocations.get(nodeId);
    const ref = nodeRefById.get(nodeId);
    const diagramRef = location && diagramRefById.get(location.diagram.id);
    const kindRef = location && kindRefById.get(location.node.kindId);
    const levelRef = location && levelRefById.get(location.node.levelId);
    if (!location || !ref || !diagramRef || !kindRef || !levelRef) return [];
    return [{
      ref,
      sourceId: nodeId,
      diagramRef,
      kindRef,
      levelRef,
      label: location.node.label,
      status: location.node.status,
      description: location.node.meta.description,
      tags: location.node.meta.tags,
      isRoot: nodeId === rootNodeId,
    }];
  });

  const edges: RequirementScopeEdge[] = [];
  for (const diagramId of diagramOrder) {
    const diagram = diagramsById.get(diagramId);
    const diagramRef = diagramRefById.get(diagramId);
    if (!diagram || !diagramRef) continue;
    for (const edge of diagram.edges) {
      const sourceNodeRef = nodeRefById.get(edge.sourceId);
      const targetNodeRef = nodeRefById.get(edge.targetId);
      if (!sourceNodeRef || !targetNodeRef) continue;
      edges.push({
        ref: `E${edges.length + 1}`,
        sourceId: edge.id,
        diagramRef,
        sourceNodeRef,
        targetNodeRef,
        kind: edge.kind,
        label: edge.label,
      });
    }
  }

  const diagrams: RequirementScopeDiagram[] = diagramOrder.flatMap((diagramId) => {
    const diagram = diagramsById.get(diagramId);
    const ref = diagramRefById.get(diagramId);
    if (!diagram || !ref) return [];
    const ownerNodeId = detailOwnerByDiagramId.get(diagramId);
    return [{
      ref,
      sourceId: diagramId,
      title: diagram.title,
      ownerNodeRef: ownerNodeId ? nodeRefById.get(ownerNodeId) : undefined,
    }];
  });

  return {
    rootNodeRef: nodeRefById.get(rootNodeId)!,
    diagrams,
    nodeKinds: usedKinds.map((kind, index) => ({
      ref: `K${index + 1}`,
      label: kind.label,
      description: kind.description,
    })),
    levels: usedLevels.map((level, index) => ({
      ref: `L${index + 1}`,
      label: level.label,
      description: level.description,
    })),
    nodes,
    edges,
  };
}
