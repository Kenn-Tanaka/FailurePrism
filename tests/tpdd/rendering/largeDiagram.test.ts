import { describe, it, expect } from 'vitest';
import { createLargeDiagramProject } from '../fixtures/largeDiagram.fixture';
import { ProjectSchema } from '../../../src/tools/tpdd/domain/schema';
import { validateProject } from '../../../src/tools/tpdd/domain/validation';
import { computeAutoLayout } from '../../../src/tools/tpdd/rendering/autoLayout';
import { generateDiagramSvg } from '../../../src/tools/tpdd/rendering/svgExport';

describe('N01 Large Diagram Scale (200 nodes, 400 edges)', () => {
  const project = createLargeDiagramProject(200, 400);

  it('passes strict Zod and business domain validation', () => {
    // 1. Zod schema check
    const parsed = ProjectSchema.safeParse(project);
    expect(parsed.success).toBe(true);

    // 2. Domain integrity check (unique IDs, edge validity, levels)
    const result = validateProject(project);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(project.diagrams[0].nodes.length).toBe(200);
    expect(project.diagrams[0].edges.length).toBe(400);
  });

  it('applies auto layout efficiently without overlaps', () => {
    const rootDiag = project.diagrams[0];
    const startTime = performance.now();

    const laidOutNodes = computeAutoLayout(rootDiag, project.levels);
    const duration = performance.now() - startTime;

    expect(laidOutNodes.length).toBe(200);
    // 性能要件: 200ノードのレイアウト計算が100ms未満で完了すること
    expect(duration).toBeLessThan(100);

    // 同一列内のノードが重なっていない（Y座標が昇順で高さ+間隔分離れている）こと
    const byLevel = new Map<string, typeof laidOutNodes>();
    for (const node of laidOutNodes) {
      if (!byLevel.has(node.levelId)) byLevel.set(node.levelId, []);
      byLevel.get(node.levelId)!.push(node);
    }

    for (const [, nodesInLevel] of byLevel.entries()) {
      for (let i = 0; i < nodesInLevel.length - 1; i++) {
        const current = nodesInLevel[i];
        const next = nodesInLevel[i + 1];
        expect(next.y).toBeGreaterThanOrEqual(current.y + current.height);
      }
    }
  });

  it('exports standalone SVG without foreignObject', () => {
    const rootDiag = project.diagrams[0];
    const svg = generateDiagramSvg(rootDiag, project.levels);

    expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(svg).not.toContain('<foreignObject');
    expect(svg).not.toContain('undefined');
    expect(svg).not.toContain('NaN');
    expect(svg).toContain('大規模ノード 1 の詳細設計要素');
    expect(svg).toContain('大規模ノード 200 の詳細設計要素');
  });
});
