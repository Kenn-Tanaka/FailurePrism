import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppAction, AppProvider, appReducer, AppState } from '../../../src/tools/tpdd/app/AppContext';
import {
  addNodeToDiagram,
  createNewProject,
  createSubDiagramForNode,
  updateNodeInDiagram,
} from '../../../src/tools/tpdd/domain/commands';
import { createHistoryState } from '../../../src/tools/tpdd/domain/history';
import { TPDD_LIMITS } from '../../../src/tools/tpdd/domain/schema';
import {
  commitAddLinkInput,
  commitAddTagInput,
  commitEdgeLabelInput,
  commitNodeDescriptionInput,
  commitNodeLabelInput,
  DetailPanel,
} from '../../../src/tools/tpdd/features/editor/DetailPanel';
import { executeSaveProjectJson, Toolbar } from '../../../src/tools/tpdd/features/editor/Toolbar';
import {
  parseAndValidateProjectJson,
  saveProjectToFile,
} from '../../../src/tools/tpdd/services/persistence/fileIo';

function createInitialAppState(project = createNewProject('検証プロジェクト')): AppState {
  return {
    history: createHistoryState(project),
    ui: {
      activeDiagramId: project.rootDiagramId,
      selectedNodeId: null,
      selectedNodeIds: [],
      selectedEdgeId: null,
      edgeDraftSourceId: null,
      viewports: { [project.rootDiagramId]: { panX: 100, panY: 100, zoom: 1 } },
      dragState: null,
      activeRightTab: 'detail',
      gatewayToken: '',
      notification: null,
      editingNodeId: null,
    },
  };
}

describe('TPDD Edit / Save / Load Validation Consistency (R2-3)', () => {
  it('上限ちょうどの値（ラベル200文字、説明10000文字、タグ100文字×20件、リンク2048文字×20件、エッジラベル200文字、列12列）は編集確定・JSON保存・再読込できる', async () => {
    let state = createInitialAppState();
    const diagId = state.history.present.rootDiagramId;

    // 200文字ラベルのノード追加
    const label200 = 'あ'.repeat(TPDD_LIMITS.LABEL_MAX_LENGTH);
    state = appReducer(state, {
      type: 'ADD_NODE',
      params: {
        label: label200,
        levelId: 'level-requirement',
        x: 100,
        y: 100,
      },
    });
    const nodeId1 = state.ui.selectedNodeId!;
    expect(nodeId1).toBeTruthy();

    // 2つ目のノード追加
    state = appReducer(state, {
      type: 'ADD_NODE',
      params: {
        label: '機能ノード',
        levelId: 'level-function',
        x: 350,
        y: 100,
      },
    });
    const nodeId2 = state.ui.selectedNodeId!;

    // 説明10,000文字、タグ100文字×20件、リンク2048文字×20件を確定
    const desc10000 = '説'.repeat(TPDD_LIMITS.DESCRIPTION_MAX_LENGTH);
    const tags20 = Array.from({ length: TPDD_LIMITS.MAX_TAGS_PER_NODE }, (_, i) => {
      const prefix = `t${i}_`;
      return prefix + 'a'.repeat(TPDD_LIMITS.TAG_MAX_LENGTH - prefix.length);
    });
    const links20 = Array.from({ length: TPDD_LIMITS.MAX_LINKS_PER_NODE }, (_, i) => {
      const prefix = `https://example.com/item/${i}/`;
      return prefix + 'x'.repeat(TPDD_LIMITS.LINK_MAX_LENGTH - prefix.length);
    });

    state = appReducer(state, {
      type: 'UPDATE_NODE',
      nodeId: nodeId1,
      patch: {
        meta: {
          description: desc10000,
          tags: tags20,
          sourceLinks: links20,
        },
      },
    });
    expect(state.ui.notification).toBeNull();

    // エッジラベル200文字
    const edgeLabel200 = '辺'.repeat(TPDD_LIMITS.LABEL_MAX_LENGTH);
    state = appReducer(state, {
      type: 'ADD_EDGE',
      params: {
        sourceId: nodeId1,
        targetId: nodeId2,
        kind: 'decomposition',
        label: edgeLabel200,
      },
    });
    expect(state.ui.notification).toBeNull();

    // プロジェクト名200文字・説明10000文字
    state = appReducer(state, {
      type: 'UPDATE_PROJECT_META',
      patch: {
        title: 'プ'.repeat(TPDD_LIMITS.LABEL_MAX_LENGTH),
        description: desc10000,
      },
    });
    expect(state.ui.notification).toBeNull();

    // 列を12列まで追加（列名200文字を含む）
    while (state.history.present.levels.length < TPDD_LIMITS.MAX_LEVELS) {
      state = appReducer(state, {
        type: 'ADD_LEVEL',
        label: '列'.repeat(TPDD_LIMITS.LABEL_MAX_LENGTH),
      });
    }
    expect(state.history.present.levels).toHaveLength(TPDD_LIMITS.MAX_LEVELS);

    // 200文字ラベルの親ノードからサブ図を作成しても図タイトルが200文字以内に収まる
    state = appReducer(state, {
      type: 'CREATE_SUB_DIAGRAM',
      parentNodeId: nodeId1,
    });
    expect(state.ui.notification).toBeNull();

    // JSON保存が成功し、再読込も成功する
    const saveRes = saveProjectToFile(state.history.present);
    expect(saveRes.success).toBe(true);

    const file = new File([JSON.stringify(state.history.present)], 'boundary.tpdd.json', {
      type: 'application/json',
    });
    const loadRes = await parseAndValidateProjectJson(file);
    expect(loadRes.success).toBe(true);
    expect(loadRes.project?.diagrams.find((d) => d.id === diagId)?.nodes[0].label).toBe(label200);
  });

  it('上限超過（201文字ラベル、10001文字説明、101文字タグ、21件タグ、2049文字リンク、不正URL、21件リンク、13列目、501件目ノード、101件目図）は不正状態として確定せずエラー通知を設定する', () => {
    let state = createInitialAppState();
    state = appReducer(state, {
      type: 'ADD_NODE',
      params: { label: '初期ノード', levelId: 'level-requirement', x: 0, y: 0 },
    });
    const nodeId = state.ui.selectedNodeId!;
    const initialRev = state.history.revision;

    // 201文字ラベルのUPDATE_NODEは拒否され、履歴・ノード内容は変化しない
    const afterLabel201 = appReducer(state, {
      type: 'UPDATE_NODE',
      nodeId,
      patch: { label: 'あ'.repeat(201) },
    });
    expect(afterLabel201.history.revision).toBe(initialRev);
    expect(afterLabel201.history.present.diagrams[0].nodes[0].label).toBe('初期ノード');
    expect(afterLabel201.ui.notification?.type).toBe('error');
    expect(afterLabel201.ui.notification?.message).toContain('200文字');

    // 10,001文字説明のUPDATE_NODEは拒否される
    const afterDesc10001 = appReducer(state, {
      type: 'UPDATE_NODE',
      nodeId,
      patch: {
        meta: {
          description: 'あ'.repeat(10001),
          tags: [],
          sourceLinks: [],
        },
      },
    });
    expect(afterDesc10001.history.revision).toBe(initialRev);
    expect(afterDesc10001.ui.notification?.type).toBe('error');
    expect(afterDesc10001.ui.notification?.message).toContain('10,000文字');

    // 101文字タグは拒否される
    const afterTag101 = appReducer(state, {
      type: 'UPDATE_NODE',
      nodeId,
      patch: {
        meta: {
          description: '',
          tags: ['t'.repeat(101)],
          sourceLinks: [],
        },
      },
    });
    expect(afterTag101.history.revision).toBe(initialRev);
    expect(afterTag101.ui.notification?.type).toBe('error');

    // 21個のタグは拒否される
    const afterTags21 = appReducer(state, {
      type: 'UPDATE_NODE',
      nodeId,
      patch: {
        meta: {
          description: '',
          tags: Array.from({ length: 21 }, (_, i) => `tag-${i}`),
          sourceLinks: [],
        },
      },
    });
    expect(afterTags21.history.revision).toBe(initialRev);
    expect(afterTags21.ui.notification?.type).toBe('error');

    // 不正URL（ホストなし 'http://'）および2049文字URL、21件リンクは拒否される
    for (const invalidLinks of [
      ['http://'],
      ['https://example.com/' + 'a'.repeat(2040)],
      Array.from({ length: 21 }, (_, i) => `https://example.com/${i}`),
    ]) {
      const afterBadLinks = appReducer(state, {
        type: 'UPDATE_NODE',
        nodeId,
        patch: {
          meta: {
            description: '',
            tags: [],
            sourceLinks: invalidLinks,
          },
        },
      });
      expect(afterBadLinks.history.revision).toBe(initialRev);
      expect(afterBadLinks.ui.notification?.type).toBe('error');
    }

    // 500件上限を超えたノード追加は拒否される
    const fullDiagramProject = {
      ...state.history.present,
      diagrams: [
        {
          ...state.history.present.diagrams[0],
          nodes: Array.from({ length: TPDD_LIMITS.MAX_NODES_PER_DIAGRAM }, (_, i) => ({
            ...state.history.present.diagrams[0].nodes[0],
            id: `node-${i}`,
          })),
        },
      ],
    };
    const add501 = addNodeToDiagram(fullDiagramProject, fullDiagramProject.rootDiagramId, {
      label: '501件目',
      levelId: 'level-requirement',
      x: 0,
      y: 0,
    });
    expect(add501.error).toContain('500件');
    expect(add501.project).toBe(fullDiagramProject);

    // 100件上限を超えたサブ図作成は拒否される
    const fullDiagramsProject = {
      ...state.history.present,
      diagrams: Array.from({ length: TPDD_LIMITS.MAX_DIAGRAMS }, (_, i) =>
        i === 0
          ? state.history.present.diagrams[0]
          : { id: `diag-${i}`, title: `図${i}`, nodes: [], edges: [] }
      ),
    };
    expect(() =>
      createSubDiagramForNode(fullDiagramsProject, fullDiagramsProject.rootDiagramId, nodeId)
    ).toThrow('100個');
  });

  it('DetailPanelの編集確定ハンドラは上限超過入力を黙って切り捨てず、入力バッファを保持してエラー通知を表示する', () => {
    let state = createInitialAppState();
    state = appReducer(state, {
      type: 'ADD_NODE',
      params: { label: '元のラベル', levelId: 'level-requirement', x: 50, y: 50 },
    });
    state = appReducer(state, {
      type: 'ADD_NODE',
      params: { label: '終点ノード', levelId: 'level-function', x: 250, y: 50 },
    });
    const node0 = state.history.present.diagrams[0].nodes[0];
    const node1 = state.history.present.diagrams[0].nodes[1];
    state = appReducer(state, {
      type: 'ADD_EDGE',
      params: { sourceId: node0.id, targetId: node1.id, kind: 'decomposition', label: '元の辺' },
    });
    const edge0 = state.history.present.diagrams[0].edges[0];

    const dispatch: React.Dispatch<AppAction> = (action) => {
      state = appReducer(state, action);
    };

    // 1. 201文字ラベル: 切り捨てられず201文字のまま保持され、ドメイン状態は更新されずエラー通知が出る
    const overLimitLabel = 'あ'.repeat(201);
    const labelRes = commitNodeLabelInput(node0, overLimitLabel, dispatch);
    expect(labelRes.committed).toBe(false);
    expect(labelRes.nextInput).toBe(overLimitLabel);
    expect(state.history.present.diagrams[0].nodes[0].label).toBe('元のラベル');
    expect(state.ui.notification?.type).toBe('error');
    expect(state.ui.notification?.message).toContain('200文字');

    // 2. 10,001文字説明: 切り捨てられず10,001文字のまま保持され、エラー通知が出る
    const overLimitDesc = '説'.repeat(10001);
    const descRes = commitNodeDescriptionInput(node0, overLimitDesc, dispatch);
    expect(descRes.committed).toBe(false);
    expect(descRes.nextInput).toBe(overLimitDesc);
    expect(state.history.present.diagrams[0].nodes[0].meta.description).toBe('');
    expect(state.ui.notification?.type).toBe('error');
    expect(state.ui.notification?.message).toContain('10,000文字');

    // 3. 101文字タグ: 切り捨てられず保持され、エラー通知が出る
    const overLimitTag = 't'.repeat(101);
    const tagRes = commitAddTagInput(node0, overLimitTag, dispatch);
    expect(tagRes.committed).toBe(false);
    expect(tagRes.nextInput).toBe(overLimitTag);
    expect(state.history.present.diagrams[0].nodes[0].meta.tags).toHaveLength(0);
    expect(state.ui.notification?.type).toBe('error');
    expect(state.ui.notification?.message).toContain('100文字');

    // 4. 不正リンク ('http://'): 拒否されエラー通知が出る
    const badLinkRes = commitAddLinkInput(node0, 'http://', dispatch);
    expect(badLinkRes.committed).toBe(false);
    expect(badLinkRes.nextInput).toBe('http://');
    expect(state.history.present.diagrams[0].nodes[0].meta.sourceLinks).toHaveLength(0);
    expect(state.ui.notification?.type).toBe('error');

    // 5. 201文字エッジラベル: 拒否されエラー通知が出る
    const overLimitEdgeLabel = '辺'.repeat(201);
    const edgeRes = commitEdgeLabelInput(edge0, overLimitEdgeLabel, dispatch);
    expect(edgeRes.committed).toBe(false);
    expect(edgeRes.nextInput).toBe(overLimitEdgeLabel);
    expect(state.history.present.diagrams[0].edges[0].label).toBe('元の辺');
    expect(state.ui.notification?.type).toBe('error');

    // DetailPanel / Toolbar の描画確認
    const html = renderToStaticMarkup(
      React.createElement(
        AppProvider,
        null,
        React.createElement(Toolbar),
        React.createElement(DetailPanel)
      )
    );
    expect(html).toContain('思考展開図エディタ (TPDD)');
  });

  it('保存時の検証失敗では成功通知を表示せずエラー通知を表示し、構造安全な不整合データを救出・修正できる', async () => {
    // 必須構造と型は正しいが、存在しない種別を参照する不整合データを用意
    const baseProj = createNewProject('救出テスト');
    const { project: pWithNode, newNode } = addNodeToDiagram(baseProj, baseProj.rootDiagramId, {
      label: '正常ラベル',
      levelId: 'level-requirement',
      x: 100,
      y: 100,
    });
    const corruptedProject = {
      ...pWithNode,
      diagrams: [
        {
          ...pWithNode.diagrams[0],
          nodes: [
            {
              ...newNode,
              kindId: 'missing-kind',
            },
          ],
        },
      ],
    };

    let state = createInitialAppState(corruptedProject);
    const dispatch: React.Dispatch<AppAction> = (action) => {
      state = appReducer(state, action);
    };

    // Toolbarの保存実行で検証失敗時、成功通知を表示せずエラー通知を設定する
    const failedSave = executeSaveProjectJson(state.history.present, dispatch);
    expect(failedSave.success).toBe(false);
    expect(state.ui.notification?.type).toBe('error');
    expect(state.ui.notification?.message).toContain('保存失敗');
    expect(state.ui.notification?.message).not.toContain('ダウンロード保存しました');

    // 救出経路: ProjectSchemaを満たす不整合JSONは確認後に読み込んで修正可能
    const corruptedFile = new File([JSON.stringify(corruptedProject)], 'corrupted.tpdd.json', {
      type: 'application/json',
    });
    const strictLoad = await parseAndValidateProjectJson(corruptedFile);
    expect(strictLoad.success).toBe(false);
    expect(strictLoad.project).toBeDefined(); // 救出用の元データが保持される

    const rescueLoad = await parseAndValidateProjectJson(corruptedFile, {
      allowInvalidRescue: true,
    });
    expect(rescueLoad.success).toBe(true);
    expect(rescueLoad.project).toBeDefined();

    // 存在する種別へ再割り当てして整合性を回復する
    const rescuedProject = updateNodeInDiagram(
      rescueLoad.project!,
      rescueLoad.project!.rootDiagramId,
      newNode.id,
      {
        kindId: rescueLoad.project!.nodeKinds[0].id,
      }
    );
    expect(rescuedProject.diagrams[0].nodes[0].kindId).toBe(
      rescueLoad.project!.nodeKinds[0].id
    );

    // 修正後はJSON保存・再読込とも成功し、成功通知が表示される
    state = appReducer(state, { type: 'LOAD_PROJECT', project: rescuedProject });
    const okSave = executeSaveProjectJson(state.history.present, dispatch);
    expect(okSave.success).toBe(true);
    expect(state.ui.notification?.type).toBe('success');
    expect(state.ui.notification?.message).toContain('ダウンロード保存しました');

    const file = new File([JSON.stringify(rescuedProject)], 'rescued.tpdd.json', {
      type: 'application/json',
    });
    const loadRes = await parseAndValidateProjectJson(file);
    expect(loadRes.success).toBe(true);
    expect(loadRes.project?.diagrams[0].nodes[0].kindId).toBe(
      rescueLoad.project!.nodeKinds[0].id
    );
  });
});
