import { describe, expect, it } from 'vitest';
import {
  addEdgeToDiagram,
  addNodeToDiagram,
  createNewProject,
  createSubDiagramForNode,
} from '../../../src/tools/tpdd/domain/commands';
import { collectRequirementScope } from '../../../src/tools/tpdd/domain/requirementScope';

describe('collectRequirementScope', () => {
  it('follows outgoing decomposition edges and attached detail diagrams, excluding unrelated root nodes', () => {
    let project = createNewProject();
    const rootDiagramId = project.rootDiagramId;
    const levelId = project.levels[0].id;

    const root = addNodeToDiagram(project, rootDiagramId, {
      label: '利用者の要求', levelId, x: 0, y: 0,
    });
    project = root.project;
    const functionNode = addNodeToDiagram(project, rootDiagramId, {
      label: '機能要素', levelId, x: 200, y: 0,
    });
    project = functionNode.project;
    const unrelated = addNodeToDiagram(project, rootDiagramId, {
      label: '別の要求', levelId, x: 400, y: 0,
    });
    project = unrelated.project;

    const edge = addEdgeToDiagram(project, rootDiagramId, {
      sourceId: root.newNode.id,
      targetId: functionNode.newNode.id,
      kind: 'decomposition',
    });
    project = edge.project;

    const detail = createSubDiagramForNode(project, rootDiagramId, functionNode.newNode.id);
    project = detail.project;
    const detailNode = addNodeToDiagram(project, detail.childDiagramId, {
      label: '詳細な実現要素', levelId, x: 0, y: 0,
    });
    project = detailNode.project;
    const unconnectedDetailNode = addNodeToDiagram(project, detail.childDiagramId, {
      label: '同じ詳細図の未接続要素', levelId, x: 200, y: 0,
    });
    project = unconnectedDetailNode.project;

    const scope = collectRequirementScope(project, root.newNode.id);

    expect(scope).not.toBeNull();
    expect(scope?.rootNodeRef).toBe('N1');
    expect(scope?.nodes.map((node) => node.label)).toEqual([
      '利用者の要求',
      '機能要素',
      '詳細な実現要素',
      '同じ詳細図の未接続要素',
    ]);
    expect(scope?.nodes.some((node) => node.label === '別の要求')).toBe(false);
    expect(scope?.edges).toEqual([
      expect.objectContaining({
        ref: 'E1',
        kind: 'decomposition',
        sourceNodeRef: 'N1',
        targetNodeRef: 'N2',
      }),
    ]);
    expect(scope?.diagrams[1]).toEqual(expect.objectContaining({
      ownerNodeRef: 'N2',
      title: '機能要素 の詳細',
    }));
  });

  it('returns null when the selected node does not exist', () => {
    expect(collectRequirementScope(createNewProject(), 'missing-node')).toBeNull();
  });
});
