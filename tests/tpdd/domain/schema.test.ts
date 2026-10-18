import { describe, expect, it } from 'vitest';
import {
  addEdgeToDiagram,
  addNodeToDiagram,
  createNewProject,
  removeNodeFromDiagram,
  updateProjectMeta,
} from '../../../src/tools/tpdd/domain/commands';
import { createHistoryState, pushHistory, redoHistory, undoHistory } from '../../../src/tools/tpdd/domain/history';
import { validateProject } from '../../../src/tools/tpdd/domain/validation';

describe('Domain Models & Validation Rules', () => {
  it('E01/P01: 新規Projectはデフォルトで正常に検証を通る (tpdd-project)', () => {
    const project = createNewProject('テストProject');
    expect(project.format).toBe('tpdd-project');
    const result = validateProject(project);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(project.diagrams).toHaveLength(1);
    expect(project.rootDiagramId).toBe(project.diagrams[0].id);
  });

  it('P01: 旧フォーマット thought-expansion-project も後方互換で正常に検証を通る', () => {
    const project = createNewProject('旧フォーマット検証');
    (project as any).format = 'thought-expansion-project';
    const result = validateProject(project);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('E06: 自己エッジを拒否する', () => {
    const project = createNewProject('テスト');
    const diagId = project.rootDiagramId;
    const { project: p1, newNode } = addNodeToDiagram(project, diagId, {
      levelId: 'level-requirement',
      x: 100,
      y: 100,
    });

    const { error } = addEdgeToDiagram(p1, diagId, {
      sourceId: newNode.id,
      targetId: newNode.id,
      kind: 'decomposition',
    });
    expect(error).toContain('自己エッジ');
  });

  it('E06: 同一方向・同一種別の重複エッジを拒否する', () => {
    const project = createNewProject('テスト');
    const diagId = project.rootDiagramId;
    const { project: p1, newNode: n1 } = addNodeToDiagram(project, diagId, {
      levelId: 'level-requirement',
      x: 100,
      y: 100,
    });
    const { project: p2, newNode: n2 } = addNodeToDiagram(p1, diagId, {
      levelId: 'level-function',
      x: 300,
      y: 100,
    });

    const { project: p3, error: err1 } = addEdgeToDiagram(p2, diagId, {
      sourceId: n1.id,
      targetId: n2.id,
      kind: 'decomposition',
    });
    expect(err1).toBeUndefined();

    // 2回目: 同一方向・同一種別
    const { error: err2 } = addEdgeToDiagram(p3, diagId, {
      sourceId: n1.id,
      targetId: n2.id,
      kind: 'decomposition',
    });
    expect(err2).toContain('重複エッジ');
  });

  it('E04: ノード削除時に接続されているエッジも同時に削除される', () => {
    const project = createNewProject('テスト');
    const diagId = project.rootDiagramId;
    const { project: p1, newNode: n1 } = addNodeToDiagram(project, diagId, {
      levelId: 'level-requirement',
      x: 100,
      y: 100,
    });
    const { project: p2, newNode: n2 } = addNodeToDiagram(p1, diagId, {
      levelId: 'level-function',
      x: 300,
      y: 100,
    });
    const { project: p3 } = addEdgeToDiagram(p2, diagId, {
      sourceId: n1.id,
      targetId: n2.id,
      kind: 'decomposition',
    });

    expect(p3.diagrams[0].edges).toHaveLength(1);

    // n1を削除
    const p4 = removeNodeFromDiagram(p3, diagId, n1.id);
    expect(p4.diagrams[0].nodes).toHaveLength(1);
    expect(p4.diagrams[0].edges).toHaveLength(0); // エッジも消えている
    expect(validateProject(p4).valid).toBe(true);
  });

  it('Undo/Redo と単調増加 revision の動作検証', () => {
    const initialProject = createNewProject('初版');
    let history = createHistoryState(initialProject);
    expect(history.revision).toBe(1);

    const { project: p1 } = addNodeToDiagram(initialProject, initialProject.rootDiagramId, {
      levelId: 'level-requirement',
      x: 100,
      y: 100,
    });

    history = pushHistory(history, p1);
    expect(history.revision).toBe(2);
    expect(history.present.diagrams[0].nodes).toHaveLength(1);

    // Undo
    history = undoHistory(history);
    expect(history.revision).toBe(3); // 仕様書 4.3: Undoでもインクリメント
    expect(history.present.diagrams[0].nodes).toHaveLength(0);

    // Redo
    history = redoHistory(history);
    expect(history.revision).toBe(4); // 仕様書 4.3: Redoでもインクリメント
    expect(history.present.diagrams[0].nodes).toHaveLength(1);
  });

  it('FUNC-01: プロジェクトタイトルおよび説明文(description)の更新と10,000文字検証', () => {
    const project = createNewProject('初期プロジェクト');
    expect(project.description).toBe('');

    // updateProjectMeta でタイトルと説明文を更新
    const longDescription = 'A'.repeat(5000);
    const updated = updateProjectMeta(project, {
      title: '更新後プロジェクト',
      description: longDescription,
    });

    expect(updated.title).toBe('更新後プロジェクト');
    expect(updated.description).toHaveLength(5000);

    const vResult = validateProject(updated);
    expect(vResult.valid).toBe(true);
  });
});
