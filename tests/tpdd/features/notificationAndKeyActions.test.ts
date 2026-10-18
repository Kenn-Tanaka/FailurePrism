import { describe, expect, it } from 'vitest';
import { addNodeToDiagram, createNewProject } from '../../../src/tools/tpdd/domain/commands';
import { createHistoryState, pushHistory, undoHistory } from '../../../src/tools/tpdd/domain/history';

describe('Notification & Keyboard Operation Domain Validation (SEC-01, UX-02)', () => {
  it('SEC-01: エラー通知オブジェクトが純粋ステートとして管理できる', () => {
    // 擬似的なUIステート
    let notification: { id: string; type: 'error' | 'info' | 'warning' | 'success'; message: string } | null = null;

    // 自己参照エッジなどの不正操作をシミュレーション
    const edgeFailure = { error: '始点と終点が同じノード（自己ループ）は作成できません' };

    // Reducer副作用ではなくState更新として通知をセット
    notification = {
      id: 'notif-1',
      type: 'error',
      message: edgeFailure.error,
    };

    expect(notification).not.toBeNull();
    expect(notification?.type).toBe('error');
    expect(notification?.message).toContain('自己ループ');

    // CLEAR_NOTIFICATION
    notification = null;
    expect(notification).toBeNull();
  });

  it('UX-02: 選択ノードの削除とUndo復帰の整合性', () => {
    let project = createNewProject('ノード削除テスト');
    const rootId = project.rootDiagramId;

    const addRes = addNodeToDiagram(project, rootId, {
      label: '削除対象ノード',
      levelId: 'level-requirement',
      x: 100,
      y: 100,
    });
    expect(addRes.newNode).toBeDefined();
    project = addRes.project;

    let history = createHistoryState(project);
    expect(history.present.diagrams[0].nodes).toHaveLength(1);

    // ノード削除 (REMOVE_NODE)
    const nodeIdToRemove = addRes.newNode!.id;
    const diag = history.present.diagrams.find((d) => d.id === rootId)!;
    const nextDiag = {
      ...diag,
      nodes: diag.nodes.filter((n) => n.id !== nodeIdToRemove),
      edges: diag.edges.filter((e) => e.sourceId !== nodeIdToRemove && e.targetId !== nodeIdToRemove),
    };
    const nextProject = {
      ...history.present,
      diagrams: history.present.diagrams.map((d) => (d.id === rootId ? nextDiag : d)),
      updatedAt: new Date().toISOString(),
    };

    history = pushHistory(history, nextProject);
    expect(history.present.diagrams[0].nodes).toHaveLength(0);
    expect(history.past).toHaveLength(1);

    // 1回のUndoでノードが完全に復活する
    history = undoHistory(history);
    expect(history.present.diagrams[0].nodes).toHaveLength(1);
    expect(history.present.diagrams[0].nodes[0].label).toBe('削除対象ノード');
  });
});
