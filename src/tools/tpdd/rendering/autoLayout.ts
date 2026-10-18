import { Diagram, LevelDefinition, ThoughtNode } from '../domain/schema';

export interface LayoutOptions {
  columnWidth?: number;
  verticalGap?: number;
  startY?: number;
  nodeHorizontalPadding?: number;
}

/**
 * 簡易自動レイアウト
 * 仕様書 6.4: 現在図のノードをlevelIdごとに分類し、列順に左から右へ配置。
 * 同じ列では既存のy順、同順位ならID順で安定して並べる。重なりを防ぐ。
 */
export function computeAutoLayout(
  diagram: Diagram,
  levels: LevelDefinition[],
  options: LayoutOptions = {}
): ThoughtNode[] {
  const columnWidth = options.columnWidth ?? 320;
  const verticalGap = options.verticalGap ?? 30;
  const startY = options.startY ?? 80;

  // levels を order 順にソート
  const sortedLevels = [...levels].sort((a, b) => a.order - b.order);
  const levelOrderMap = new Map(sortedLevels.map((lvl, index) => [lvl.id, index]));

  // levelId ごとにノードをグループ化
  const levelNodesMap = new Map<string, ThoughtNode[]>();
  for (const lvl of sortedLevels) {
    levelNodesMap.set(lvl.id, []);
  }

  // どのlevelにも属さない不正ノードがある場合は先頭列にフォールバック
  const fallbackLevelId = sortedLevels[0]?.id || '';

  for (const node of diagram.nodes) {
    const list = levelNodesMap.get(node.levelId) || levelNodesMap.get(fallbackLevelId);
    if (list) {
      list.push(node);
    }
  }

  const updatedNodes: ThoughtNode[] = [];

  // 各列ごとに既存y順、ID順で安定ソートして縦に並べる
  for (const [lvlId, nodes] of levelNodesMap) {
    const colIndex = levelOrderMap.get(lvlId) ?? 0;
    const colX = colIndex * columnWidth;

    // 安定ソート: 既存y順、同順位ならid順
    const sortedColNodes = [...nodes].sort((a, b) => {
      if (a.y !== b.y) {
        return a.y - b.y;
      }
      return a.id.localeCompare(b.id);
    });

    let currentY = startY;

    for (const node of sortedColNodes) {
      // 列内の横位置: 列の中央にセンタリング
      const nodeX = Math.round(colX + (columnWidth - node.width) / 2);
      const nodeY = Math.round(currentY);

      updatedNodes.push({
        ...node,
        x: Math.max(0, nodeX),
        y: nodeY,
      });

      // 次のノードのY座標 = 現在Y + ノード高さ + ギャップ
      currentY += node.height + verticalGap;
    }
  }

  return updatedNodes;
}
