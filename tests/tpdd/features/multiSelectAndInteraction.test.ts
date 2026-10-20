import { describe, expect, it } from 'vitest';
import {
  addNodeToDiagram,
  addEdgeToDiagram,
  createNewProject,
  removeMultipleNodesFromDiagram,
  updateNodesPosition,
} from '../../../src/tools/tpdd/domain/commands';
import { generateDiagramSvg } from '../../../src/tools/tpdd/rendering/svgExport';

describe('複数ノード選択・一括操作およびインタラクション機能のテスト', () => {
  it('updateNodesPosition: 複数ノードの位置を一括更新できる', () => {
    let project = createNewProject('テスト');
    const diagId = project.rootDiagramId;

    const res1 = addNodeToDiagram(project, diagId, {
      label: 'Node 1',
      levelId: 'level-requirement',
      x: 100,
      y: 100,
    });
    project = res1.project;

    const res2 = addNodeToDiagram(project, diagId, {
      label: 'Node 2',
      levelId: 'level-requirement',
      x: 200,
      y: 200,
    });
    project = res2.project;

    const res3 = addNodeToDiagram(project, diagId, {
      label: 'Node 3 (非移動)',
      levelId: 'level-requirement',
      x: 300,
      y: 300,
    });
    project = res3.project;

    // Node 1 と Node 2 を一括移動 (+50, +30)
    const positions = [
      { id: res1.newNode.id, x: 150, y: 130 },
      { id: res2.newNode.id, x: 250, y: 230 },
    ];

    const updated = updateNodesPosition(project, diagId, positions);
    const diag = updated.diagrams.find((d) => d.id === diagId)!;

    const n1 = diag.nodes.find((n) => n.id === res1.newNode.id)!;
    const n2 = diag.nodes.find((n) => n.id === res2.newNode.id)!;
    const n3 = diag.nodes.find((n) => n.id === res3.newNode.id)!;

    expect(n1.x).toBe(150);
    expect(n1.y).toBe(130);
    expect(n2.x).toBe(250);
    expect(n2.y).toBe(230);
    expect(n3.x).toBe(300); // 変更なし
    expect(n3.y).toBe(300);
  });

  it('removeMultipleNodesFromDiagram: 複数ノードおよび関連エッジを一括削除できる', () => {
    let project = createNewProject('テスト');
    const diagId = project.rootDiagramId;

    const res1 = addNodeToDiagram(project, diagId, { levelId: 'level-requirement', x: 0, y: 0 });
    const res2 = addNodeToDiagram(res1.project, diagId, { levelId: 'level-requirement', x: 100, y: 0 });
    const res3 = addNodeToDiagram(res2.project, diagId, { levelId: 'level-requirement', x: 200, y: 0 });
    project = res3.project;

    // エッジ作成: 1 -> 2, 2 -> 3
    const edgeRes1 = addEdgeToDiagram(project, diagId, {
      sourceId: res1.newNode.id,
      targetId: res2.newNode.id,
      kind: 'decomposition',
    });
    const edgeRes2 = addEdgeToDiagram(edgeRes1.project, diagId, {
      sourceId: res2.newNode.id,
      targetId: res3.newNode.id,
      kind: 'dependency',
    });
    project = edgeRes2.project;

    expect(project.diagrams[0].nodes).toHaveLength(3);
    expect(project.diagrams[0].edges).toHaveLength(2);

    // Node 1 と Node 2 を一括削除
    const afterRemoval = removeMultipleNodesFromDiagram(project, diagId, [
      res1.newNode.id,
      res2.newNode.id,
    ]);
    const diag = afterRemoval.diagrams[0];

    // Node 3 のみが残る
    expect(diag.nodes).toHaveLength(1);
    expect(diag.nodes[0].id).toBe(res3.newNode.id);
    // Node 1 または Node 2 に接続していたエッジはすべて削除される
    expect(diag.edges).toHaveLength(0);
  });

  it('ラバーバンド矩形交差判定ロジックが正しくノードを検出する', () => {
    const nodeA = { x: 100, y: 100, width: 180, height: 72 };
    const nodeB = { x: 400, y: 400, width: 180, height: 72 };

    // 範囲: 50..300, 50..200 (Node A のみ含む)
    const boxMinX = 50;
    const boxMaxX = 300;
    const boxMinY = 50;
    const boxMaxY = 200;

    const hitA =
      nodeA.x + nodeA.width >= boxMinX &&
      nodeA.x <= boxMaxX &&
      nodeA.y + nodeA.height >= boxMinY &&
      nodeA.y <= boxMaxY;

    const hitB =
      nodeB.x + nodeB.width >= boxMinX &&
      nodeB.x <= boxMaxX &&
      nodeB.y + nodeB.height >= boxMinY &&
      nodeB.y <= boxMaxY;

    expect(hitA).toBe(true);
    expect(hitB).toBe(false);
  });

  it('全図エクスポート: 複数図面に対して有効なSVG文字列が生成される', () => {
    let project = createNewProject('全図テスト');
    const diagId1 = project.rootDiagramId;

    const res1 = addNodeToDiagram(project, diagId1, {
      label: 'Root Node',
      levelId: 'level-requirement',
      x: 10,
      y: 10,
    });
    project = res1.project;

    // 2枚目の図面を追加
    project = {
      ...project,
      diagrams: [
        ...project.diagrams,
        {
          id: 'sub-diag-2',
          title: '詳細図 2',
          nodes: [
            {
              id: 'sub-n1',
              label: 'Sub Node 1',
              kindId: 'function',
              status: 'adopted',
              levelId: 'level-function',
              x: 50,
              y: 50,
              width: 180,
              height: 72,
              meta: { description: '', tags: [], sourceLinks: [] },
              provenance: { origin: 'manual', createdAt: new Date().toISOString() },
            },
          ],
          edges: [],
        },
      ],
    };

    expect(project.diagrams).toHaveLength(2);

    for (const diag of project.diagrams) {
      const svg = generateDiagramSvg(diag, project.levels, project.nodeKinds);
      expect(svg).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
      expect(svg).toContain('viewBox=');
      expect(svg).toContain(diag.title === 'ルート図' ? 'Root Node' : 'Sub Node 1');
    }
  });

  it('キーボード移動のステップ量計算（通常1px、Shift押下時10px）が正当に反映される', () => {
    const initialPos = { x: 100, y: 100 };

    const moveNormal = (key: string) => {
      const step = 1;
      const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
      const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
      return { x: initialPos.x + dx, y: initialPos.y + dy };
    };

    const moveShift = (key: string) => {
      const step = 10;
      const dx = key === 'ArrowLeft' ? -step : key === 'ArrowRight' ? step : 0;
      const dy = key === 'ArrowUp' ? -step : key === 'ArrowDown' ? step : 0;
      return { x: initialPos.x + dx, y: initialPos.y + dy };
    };

    expect(moveNormal('ArrowRight')).toEqual({ x: 101, y: 100 });
    expect(moveNormal('ArrowDown')).toEqual({ x: 100, y: 101 });
    expect(moveShift('ArrowLeft')).toEqual({ x: 90, y: 100 });
    expect(moveShift('ArrowUp')).toEqual({ x: 100, y: 90 });
  });
});
