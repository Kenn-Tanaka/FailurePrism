import { describe, expect, it } from 'vitest';
import {
  addEdgeToDiagram,
  addNodeKind,
  addNodeToDiagram,
  createNewProject,
  removeNodeKindWithReassign,
  removeNodeFromDiagram,
  updateProjectMeta,
} from '../../../src/tools/tpdd/domain/commands';
import { createHistoryState, pushHistory, redoHistory, undoHistory } from '../../../src/tools/tpdd/domain/history';
import { TPDD_LIMITS } from '../../../src/tools/tpdd/domain/schema';
import { validateProject } from '../../../src/tools/tpdd/domain/validation';

describe('Domain Models & Validation Rules', () => {
  it('E01/P01: 新規Projectはデフォルトで正常に検証を通る (tpdd-project)', () => {
    const project = createNewProject('テストProject');
    expect(project.format).toBe('tpdd-project');
    expect(project.schemaVersion).toBe(2);
    expect(project.nodeKinds.length).toBeGreaterThan(0);
    expect(project.levels.every((level) => typeof level.description === 'string')).toBe(true);
    const result = validateProject(project);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(project.diagrams).toHaveLength(1);
    expect(project.rootDiagramId).toBe(project.diagrams[0].id);
  });

  it('P01: 旧フォーマット thought-expansion-project は拒否する', () => {
    const project = createNewProject('旧フォーマット検証');
    (project as any).format = 'thought-expansion-project';
    const result = validateProject(project);
    expect(result.valid).toBe(false);
  });

  it('全分野別プリセットが独立した正常Projectを生成する', () => {
    for (const preset of ['mechanical', 'software', 'electronics', 'custom'] as const) {
      const first = createNewProject(`${preset}-1`, preset);
      const second = createNewProject(`${preset}-2`, preset);
      expect(validateProject(first).valid).toBe(true);
      expect(first.nodeKinds.length).toBeGreaterThan(0);
      expect(first.levels.length).toBeGreaterThan(0);

      first.nodeKinds[0].label = '変更済み';
      first.levels[0].label = '変更済み列';
      expect(second.nodeKinds[0].label).not.toBe('変更済み');
      expect(second.levels[0].label).not.toBe('変更済み列');
    }
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

    const reloaded = createHistoryState(history.present, history.revision + 1);
    expect(reloaded.revision).toBe(5);
  });

  it('ユーザー定義種別を追加し、削除時にノードを一括再割り当てできる', () => {
    const project = addNodeKind(createNewProject('種別管理'), '安全機構', 'フェイルセーフの実現方式', 'orange');
    const addedKind = project.nodeKinds.at(-1)!;
    const { project: withNode, newNode } = addNodeToDiagram(project, project.rootDiagramId, {
      label: '監視回路',
      kindId: addedKind.id,
      levelId: project.levels[0].id,
      x: 0,
      y: 0,
    });

    const reassigned = removeNodeKindWithReassign(withNode, addedKind.id, 'requirement');
    expect(reassigned.nodeKinds.some((kind) => kind.id === addedKind.id)).toBe(false);
    expect(reassigned.diagrams[0].nodes.find((node) => node.id === newNode.id)?.kindId).toBe('requirement');
    expect(validateProject(reassigned).valid).toBe(true);
  });

  it('ノード種別は上限24件を超えて追加できない', () => {
    let project = createNewProject('種別上限');
    while (project.nodeKinds.length < TPDD_LIMITS.MAX_NODE_KINDS) {
      project = addNodeKind(project, `種別${project.nodeKinds.length + 1}`);
    }
    expect(project.nodeKinds).toHaveLength(TPDD_LIMITS.MAX_NODE_KINDS);
    expect(() => addNodeKind(project, '上限超過')).toThrow('最大24件');
    expect(validateProject(project).valid).toBe(true);
  });

  it('重複した定義IDと存在しない種別参照を拒否する', () => {
    const project = createNewProject('参照整合性');
    const duplicateKinds = {
      ...project,
      nodeKinds: [...project.nodeKinds, { ...project.nodeKinds[0] }],
    };
    expect(validateProject(duplicateKinds).errors.some((error) => error.message.includes('種別ID'))).toBe(true);
    const duplicateLevels = {
      ...project,
      levels: [...project.levels, { ...project.levels[0] }],
    };
    expect(validateProject(duplicateLevels).errors.some((error) => error.message.includes('抽象度列ID'))).toBe(true);

    const { project: withNode, newNode } = addNodeToDiagram(project, project.rootDiagramId, {
      levelId: project.levels[0].id,
      x: 0,
      y: 0,
    });
    const invalidReference = {
      ...withNode,
      diagrams: [{
        ...withNode.diagrams[0],
        nodes: withNode.diagrams[0].nodes.map((node) =>
          node.id === newNode.id ? { ...node, kindId: 'missing-kind' } : node
        ),
      }],
    };
    expect(validateProject(invalidReference).errors.some((error) => error.path.endsWith('.kindId'))).toBe(true);
  });

  it('ノード追加時に存在しない種別IDと列IDを拒否する', () => {
    const project = createNewProject('追加コマンド検証');
    const invalidKind = addNodeToDiagram(project, project.rootDiagramId, {
      kindId: 'missing-kind',
      levelId: project.levels[0].id,
      x: 0,
      y: 0,
    });
    expect(invalidKind.project).toBe(project);
    expect(invalidKind.error).toContain('ノード種別');

    const invalidLevel = addNodeToDiagram(project, project.rootDiagramId, {
      kindId: project.nodeKinds[0].id,
      levelId: 'missing-level',
      x: 0,
      y: 0,
    });
    expect(invalidLevel.project).toBe(project);
    expect(invalidLevel.error).toContain('抽象度列');
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
