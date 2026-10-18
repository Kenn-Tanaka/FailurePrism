import { describe, expect, it } from 'vitest';
import {
  addNodeToDiagram,
  createNewProject,
  createSubDiagramForNode,
  removeDiagramCascade,
  removeLevelWithReassign,
  removeNodeWithDescendants,
} from '../../../src/tools/tpdd/domain/commands';
import { createHistoryState, pushHistory, undoHistory } from '../../../src/tools/tpdd/domain/history';
import { validateProject } from '../../../src/tools/tpdd/domain/validation';
import { computeAutoLayout } from '../../../src/tools/tpdd/rendering/autoLayout';

describe('Hierarchy & SubDiagrams (E05)', () => {
  it('E05: サブ図を作成でき、階層整合性検証をパスする', () => {
    const project = createNewProject('階層テスト');
    const rootId = project.rootDiagramId;

    const { project: p1, newNode } = addNodeToDiagram(project, rootId, {
      label: '親ノード',
      levelId: 'level-requirement',
      x: 100,
      y: 100,
    });

    const { project: p2, childDiagramId, created } = createSubDiagramForNode(
      p1,
      rootId,
      newNode.id,
      '親ノードの詳細'
    );

    expect(created).toBe(true);
    expect(p2.diagrams).toHaveLength(2);

    const childDiagram = p2.diagrams.find((d) => d.id === childDiagramId);
    expect(childDiagram).toBeDefined();
    expect(childDiagram?.title).toBe('親ノードの詳細');

    // 親ノードの childDiagramId が更新されていること
    const updatedParentNode = p2.diagrams[0].nodes.find((n) => n.id === newNode.id);
    expect(updatedParentNode?.childDiagramId).toBe(childDiagramId);

    // 整合性チェック
    const validation = validateProject(p2);
    expect(validation.valid).toBe(true);
  });

  it('E05: サブ図削除で子孫図も含めてカスケード削除され、親ノードのchildDiagramIdが解除される', () => {
    const project = createNewProject('カスケード削除テスト');
    const rootId = project.rootDiagramId;

    // ルート図に親ノード追加
    const { project: p1, newNode: parentNode } = addNodeToDiagram(project, rootId, {
      label: 'ルート親ノード',
      levelId: 'level-requirement',
      x: 50,
      y: 50,
    });

    // 子図作成
    const { project: p2, childDiagramId } = createSubDiagramForNode(p1, rootId, parentNode.id);

    // 子図内にさらにノードを追加し、孫図を作成
    const { project: p3, newNode: subNode } = addNodeToDiagram(p2, childDiagramId, {
      label: '子図内ノード',
      levelId: 'level-function',
      x: 100,
      y: 100,
    });
    const { project: p4, childDiagramId: grandChildId } = createSubDiagramForNode(
      p3,
      childDiagramId,
      subNode.id
    );

    expect(p4.diagrams).toHaveLength(3); // ルート、子図、孫図
    expect(validateProject(p4).valid).toBe(true);

    // 履歴スタックで管理
    let history = createHistoryState(p4);

    // 子図をカスケード削除 (子図と孫図が削除される)
    const { project: p5, removedDiagramIds } = removeDiagramCascade(p4, childDiagramId);
    expect(removedDiagramIds).toContain(childDiagramId);
    expect(removedDiagramIds).toContain(grandChildId);
    expect(p5.diagrams).toHaveLength(1); // ルート図のみ残る

    // 親ノードの childDiagramId が解除されていること
    const parentAfterDelete = p5.diagrams[0].nodes.find((n) => n.id === parentNode.id);
    expect(parentAfterDelete?.childDiagramId).toBeUndefined();

    // 孤立図や循環が存在しないこと
    expect(validateProject(p5).valid).toBe(true);

    // Undo で完全復元
    history = pushHistory(history, p5);
    history = undoHistory(history);
    expect(history.present.diagrams).toHaveLength(3);
    const restoredParent = history.present.diagrams[0].nodes.find((n) => n.id === parentNode.id);
    expect(restoredParent?.childDiagramId).toBe(childDiagramId);
    expect(validateProject(history.present).valid).toBe(true);
  });

  it('親ノード削除時にも子孫図がすべてカスケード削除される', () => {
    const project = createNewProject('親ノード削除テスト');
    const rootId = project.rootDiagramId;

    const { project: p1, newNode } = addNodeToDiagram(project, rootId, {
      label: '親ノード',
      levelId: 'level-requirement',
      x: 100,
      y: 100,
    });

    const { project: p2 } = createSubDiagramForNode(p1, rootId, newNode.id);
    expect(p2.diagrams).toHaveLength(2);

    const { project: p3, removedDiagramCount } = removeNodeWithDescendants(p2, rootId, newNode.id);
    expect(removedDiagramCount).toBe(1);
    expect(p3.diagrams).toHaveLength(1);
    expect(p3.diagrams[0].nodes).toHaveLength(0);
    expect(validateProject(p3).valid).toBe(true);
  });
});

describe('Auto Layout & Level Management (E07)', () => {
  it('E07: 自動レイアウトで同列ノードが重ならず整列し、1回のUndoで元の位置に戻る', () => {
    const project = createNewProject('自動配置テスト');
    const rootId = project.rootDiagramId;

    // 同じ列に重なる座標で2つのノードを追加
    const { project: p1, newNode: n1 } = addNodeToDiagram(project, rootId, {
      label: 'ノード1',
      levelId: 'level-requirement',
      x: 100,
      y: 100,
      width: 180,
      height: 70,
    });
    const { project: p2, newNode: n2 } = addNodeToDiagram(p1, rootId, {
      label: 'ノード2',
      levelId: 'level-requirement',
      x: 100,
      y: 100, // 重なっている
      width: 180,
      height: 70,
    });

    let history = createHistoryState(p2);

    // 自動レイアウト実行
    const laidOutNodes = computeAutoLayout(p2.diagrams[0], p2.levels, {
      columnWidth: 320,
      verticalGap: 30,
      startY: 80,
    });

    const updatedProject = {
      ...p2,
      diagrams: [{ ...p2.diagrams[0], nodes: laidOutNodes }],
    };

    history = pushHistory(history, updatedProject);

    const outNode1 = laidOutNodes.find((n) => n.id === n1.id)!;
    const outNode2 = laidOutNodes.find((n) => n.id === n2.id)!;

    // 重なっていないこと (Y座標が高さ+ギャップ以上離れている)
    const yDistance = Math.abs(outNode1.y - outNode2.y);
    expect(yDistance).toBeGreaterThanOrEqual(70 + 30);

    // 1回のUndoで元の重なった座標に戻る
    history = undoHistory(history);
    const restoredNode1 = history.present.diagrams[0].nodes.find((n) => n.id === n1.id)!;
    const restoredNode2 = history.present.diagrams[0].nodes.find((n) => n.id === n2.id)!;
    expect(restoredNode1.y).toBe(100);
    expect(restoredNode2.y).toBe(100);
  });

  it('列削除時に所属ノードが指定の移動先列へ一括再割り当てされる', () => {
    const project = createNewProject('列削除テスト');
    const rootId = project.rootDiagramId;

    // 削除予定の「機構」列にノードを配置
    const { project: p1, newNode } = addNodeToDiagram(project, rootId, {
      label: '機構ノード',
      levelId: 'level-mechanism',
      x: 100,
      y: 100,
    });

    // 「機構」列を削除し、ノードを「構造」列へ再割り当て
    const p2 = removeLevelWithReassign(p1, 'level-mechanism', 'level-structure');

    expect(p2.levels.some((l) => l.id === 'level-mechanism')).toBe(false);

    const reassignedNode = p2.diagrams[0].nodes.find((n) => n.id === newNode.id)!;
    expect(reassignedNode.levelId).toBe('level-structure');
    expect(validateProject(p2).valid).toBe(true);
  });
});
