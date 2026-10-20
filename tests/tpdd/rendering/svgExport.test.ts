import { describe, expect, it } from 'vitest';
import { addEdgeToDiagram, addNodeToDiagram, createNewProject } from '../../../src/tools/tpdd/domain/commands';
import { getNodePalette } from '../../../src/tools/tpdd/rendering/nodeStyles';
import { generateDiagramSvg } from '../../../src/tools/tpdd/rendering/svgExport';

describe('SVG Export Validation (P03)', () => {
  it('P03: 負座標、日本語、改行、特殊文字 (&, <, >) を含むノードとエッジを正しくSVG化できる', () => {
    const project = createNewProject('テスト');
    const diagId = project.rootDiagramId;

    // 負座標・特殊文字ノード
    const { project: p1, newNode: n1 } = addNodeToDiagram(project, diagId, {
      label: '安全要求 <1> & "A"\n改行テスト',
      description: '説明: A > B && C < D',
      levelId: 'level-requirement',
      x: -200,
      y: -150,
      width: 200,
      height: 80,
    });

    const { project: p2, newNode: n2 } = addNodeToDiagram(p1, diagId, {
      label: '機能ノード B',
      levelId: 'level-function',
      x: 100,
      y: 50,
      width: 180,
      height: 72,
    });

    const { project: p3 } = addEdgeToDiagram(p2, diagId, {
      sourceId: n1.id,
      targetId: n2.id,
      kind: 'decomposition',
      label: '具体化 & 分解',
    });

    const svg = generateDiagramSvg(p3.diagrams[0], p3.levels, p3.nodeKinds);

    // 検証
    expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(svg).toContain('viewBox="-240 -190'); // -200 - 40 margin
    expect(svg).toContain('&lt;1&gt; &amp; &quot;A&quot;');
    expect(svg).toContain('改行テスト');
    expect(svg).toContain('具体化 &amp; 分解');
    // foreignObject や script を含んでいないこと
    expect(svg).not.toContain('<foreignObject');
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('javascript:');
  });

  it('空図でもデフォルト800x600のSVGが生成される', () => {
    const project = createNewProject('空図');
    const svg = generateDiagramSvg(project.diagrams[0], project.levels, project.nodeKinds);
    expect(svg).toContain('viewBox="0 0 800 600"');
    expect(svg).toContain('空の図');
  });

  it('ユーザー定義の種別名をエスケープし、長い表示名だけを省略して固定パレットで描画する', () => {
    const base = createNewProject('ユーザー定義種別');
    const customLabel = '非常に長い<&>"内容の種別名サンプル';
    const project = {
      ...base,
      nodeKinds: base.nodeKinds.map((kind) =>
        kind.id === 'requirement'
          ? { ...kind, label: customLabel, paletteKey: 'rose' as const }
          : kind
      ),
    };
    const { project: withNode } = addNodeToDiagram(project, project.rootDiagramId, {
      label: '表示確認',
      levelId: project.levels[0].id,
      x: 0,
      y: 0,
      width: 180,
      height: 72,
    });

    const svg = generateDiagramSvg(withNode.diagrams[0], withNode.levels, withNode.nodeKinds);

    expect(svg).toContain('[非常に長い&lt;&amp;&gt;&quot;…]');
    expect(svg).toContain('[非常に長い&lt;&amp;&gt;&quot;内容の種別名サンプル] 表示確認');
    expect(svg).toContain('fill="#fee2e2" stroke="#dc2626"');
    expect(svg).not.toContain(customLabel);
  });

  it('Rescue表示で不正なpaletteKeyがあってもslateへフォールバックする', () => {
    const base = createNewProject('不正パレット救済');
    const project = {
      ...base,
      nodeKinds: base.nodeKinds.map((kind, index) =>
        index === 0
          ? { ...kind, paletteKey: 'invalid-palette' as typeof kind.paletteKey }
          : kind
      ),
    };
    const { project: withNode } = addNodeToDiagram(project, project.rootDiagramId, {
      label: '救済表示',
      levelId: project.levels[0].id,
      x: 0,
      y: 0,
    });

    expect(getNodePalette('invalid-palette')).toEqual(getNodePalette('slate'));
    expect(() => generateDiagramSvg(
      withNode.diagrams[0],
      withNode.levels,
      withNode.nodeKinds
    )).not.toThrow();
  });
});
