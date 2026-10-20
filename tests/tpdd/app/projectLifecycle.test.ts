import { describe, expect, it } from 'vitest';
import {
  appReducer,
  AppState,
  shouldSkipAutoSave,
} from '../../../src/tools/tpdd/app/AppContext';
import { createNewProject } from '../../../src/tools/tpdd/domain/commands';
import { createHistoryState } from '../../../src/tools/tpdd/domain/history';

function createState(revision = 1): AppState {
  const project = createNewProject('履歴テスト');
  return {
    history: createHistoryState(project, revision),
    ui: {
      activeDiagramId: project.rootDiagramId,
      selectedNodeId: null,
      selectedNodeIds: [],
      selectedEdgeId: null,
      edgeDraftSourceId: null,
      viewports: {},
      dragState: null,
      activeRightTab: 'detail',
      gatewayToken: '',
      notification: null,
      editingNodeId: null,
    },
  };
}

describe('TPDD project lifecycle reducer', () => {
  it('ロードと新規作成でもrevisionを単調増加させる', () => {
    const initial = createState(7);
    const loadedProject = createNewProject('ロード対象', 'software');

    const loaded = appReducer(initial, { type: 'LOAD_PROJECT', project: loadedProject });
    expect(loaded.history.revision).toBe(8);
    expect(loaded.history.past).toEqual([]);
    expect(loaded.history.future).toEqual([]);

    const created = appReducer(loaded, { type: 'NEW_PROJECT', preset: 'electronics' });
    expect(created.history.revision).toBe(9);
    expect(created.history.present.nodeKinds[0].label).toBe('仕様');
  });

  it('起動直後だけ空Projectの自動保存を省略し、明示的新規作成は保存対象にする', () => {
    const initial = createState();
    expect(shouldSkipAutoSave(initial.history)).toBe(true);

    const created = appReducer(initial, { type: 'NEW_PROJECT', preset: 'software' });
    expect(created.history.present.diagrams[0].nodes).toHaveLength(0);
    expect(created.history.revision).toBe(2);
    expect(shouldSkipAutoSave(created.history)).toBe(false);
  });

  it('不正な全体更新を履歴へ積まず、エラー通知を返す', () => {
    const state = createState(3);
    const invalidProject = { ...state.history.present, nodeKinds: [] };

    const result = appReducer(state, { type: 'APPLY_PROJECT_UPDATE', project: invalidProject });

    expect(result.history).toBe(state.history);
    expect(result.ui.notification?.type).toBe('error');
    expect(result.ui.notification?.message).toContain('提案を適用できませんでした');
  });

  it('整合する全体更新はUndo可能な1操作として積む', () => {
    const state = createState(4);
    const updated = { ...state.history.present, description: 'AI提案を採用' };

    const result = appReducer(state, { type: 'APPLY_PROJECT_UPDATE', project: updated });

    expect(result.history.revision).toBe(5);
    expect(result.history.past).toHaveLength(1);
    expect(result.history.present.description).toBe('AI提案を採用');
  });
});
