import { describe, expect, it } from 'vitest';
import {
  addEdgeToDiagram,
  addNodeToDiagram,
  createNewProject,
  createSubDiagramForNode,
} from '../../../src/tools/tpdd/domain/commands';
import {
  collectAncestry,
  collectRequirementScope,
  getDetailDiagramNodeRefs,
} from '../../../src/tools/tpdd/domain/requirementScope';

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

  it('excludes rejected descendant nodes, their adopted subtrees, and rejected detail-diagram nodes while keeping a selected rejected root', () => {
    let project = createNewProject();
    const rootDiagramId = project.rootDiagramId;
    const levelId = project.levels[0].id;

    const root = addNodeToDiagram(project, rootDiagramId, {
      label: '起点要求', levelId, x: 0, y: 0,
    });
    project = root.project;

    const rejectedChild = addNodeToDiagram(project, rootDiagramId, {
      label: '却下した機能案', levelId, x: 200, y: 0, status: 'rejected',
    });
    project = rejectedChild.project;

    const grandchildBehindRejected = addNodeToDiagram(project, rootDiagramId, {
      label: '却下案の先にあるノード', levelId, x: 400, y: 0, status: 'adopted',
    });
    project = grandchildBehindRejected.project;

    const adoptedChild = addNodeToDiagram(project, rootDiagramId, {
      label: '採用した機能案', levelId, x: 200, y: 120, status: 'adopted',
    });
    project = adoptedChild.project;

    project = addEdgeToDiagram(project, rootDiagramId, {
      sourceId: root.newNode.id,
      targetId: rejectedChild.newNode.id,
      kind: 'decomposition',
    }).project;
    project = addEdgeToDiagram(project, rootDiagramId, {
      sourceId: rejectedChild.newNode.id,
      targetId: grandchildBehindRejected.newNode.id,
      kind: 'decomposition',
    }).project;
    project = addEdgeToDiagram(project, rootDiagramId, {
      sourceId: root.newNode.id,
      targetId: adoptedChild.newNode.id,
      kind: 'decomposition',
    }).project;

    const detail = createSubDiagramForNode(project, rootDiagramId, adoptedChild.newNode.id);
    project = detail.project;
    const detailAdopted = addNodeToDiagram(project, detail.childDiagramId, {
      label: '詳細図の採用ノード', levelId, x: 0, y: 0, status: 'adopted',
    });
    project = detailAdopted.project;
    const detailRejected = addNodeToDiagram(project, detail.childDiagramId, {
      label: '詳細図の却下ノード', levelId, x: 200, y: 0, status: 'rejected',
    });
    project = detailRejected.project;

    const scope = collectRequirementScope(project, root.newNode.id)!;
    expect(scope.nodes.map((node) => node.label)).toEqual([
      '起点要求',
      '採用した機能案',
      '詳細図の採用ノード',
    ]);
    expect(scope.excludedRejectedCount).toBe(2);
    expect(Array.from(getDetailDiagramNodeRefs(scope))).toEqual(['N3']);

    // Explicitly selecting a rejected root node still returns its scope
    const rejectedRootScope = collectRequirementScope(project, rejectedChild.newNode.id);
    expect(rejectedRootScope).not.toBeNull();
    expect(rejectedRootScope?.nodes[0].label).toBe('却下した機能案');
  });

  it('collects upward ancestry across decomposition edges and detail-diagram owners with depth limit and no internal IDs', () => {
    let project = createNewProject();
    const rootDiagramId = project.rootDiagramId;
    const level0 = project.levels[0].id;
    const level1 = project.levels[1].id;

    const topReq = addNodeToDiagram(project, rootDiagramId, {
      label: '最上位要求',
      levelId: level0,
      x: 0,
      y: 0,
      description: 'あ'.repeat(400),
    });
    project = topReq.project;

    const rejectedParent = addNodeToDiagram(project, rootDiagramId, {
      label: '却下された親',
      levelId: level0,
      x: 0,
      y: 120,
      status: 'rejected',
    });
    project = rejectedParent.project;

    const subFunc = addNodeToDiagram(project, rootDiagramId, {
      label: '中間機能',
      levelId: level1,
      x: 240,
      y: 0,
    });
    project = subFunc.project;

    project = addEdgeToDiagram(project, rootDiagramId, {
      sourceId: rejectedParent.newNode.id,
      targetId: subFunc.newNode.id,
      kind: 'decomposition',
    }).project;
    project = addEdgeToDiagram(project, rootDiagramId, {
      sourceId: topReq.newNode.id,
      targetId: subFunc.newNode.id,
      kind: 'decomposition',
    }).project;

    const subDiagram = createSubDiagramForNode(project, rootDiagramId, subFunc.newNode.id);
    project = subDiagram.project;

    const detailParent = addNodeToDiagram(project, subDiagram.childDiagramId, {
      label: '詳細図の親機構',
      levelId: level1,
      x: 0,
      y: 0,
    });
    project = detailParent.project;

    const detailFocus = addNodeToDiagram(project, subDiagram.childDiagramId, {
      label: '詳細図のフォーカス構造',
      levelId: level1,
      x: 240,
      y: 0,
    });
    project = detailFocus.project;

    project = addEdgeToDiagram(project, subDiagram.childDiagramId, {
      sourceId: detailParent.newNode.id,
      targetId: detailFocus.newNode.id,
      kind: 'decomposition',
    }).project;

    const ancestry = collectAncestry(project, subDiagram.childDiagramId, detailFocus.newNode.id, 5);
    expect(ancestry.map((item) => ({ ref: item.ref, label: item.label }))).toEqual([
      { ref: 'A1', label: '最上位要求' },
      { ref: 'A2', label: '中間機能' },
      { ref: 'A3', label: '詳細図の親機構' },
    ]);
    expect(ancestry[0].description).toHaveLength(300);
    const serialized = JSON.stringify(ancestry);
    expect(serialized).not.toContain(topReq.newNode.id);
    expect(serialized).not.toContain(subFunc.newNode.id);
    expect(serialized).not.toContain(detailParent.newNode.id);

    const depthLimited = collectAncestry(project, subDiagram.childDiagramId, detailFocus.newNode.id, 2);
    expect(depthLimited.map((item) => item.label)).toEqual(['中間機能', '詳細図の親機構']);
  });
});
