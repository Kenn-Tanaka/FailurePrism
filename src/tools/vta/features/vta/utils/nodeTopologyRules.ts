import type { VTASchema, VTANodeData, VTAEdgeData } from '../../../types/vta';

/**
 * ADR-0026: ノードのトポロジー属性（クロスレーン矢印始点・レーン最上端ノード）を判定・付与する
 * 
 * ルール①: 他レーンへの矢印（クロスレーン接続線）の始点となっているノードは is_cross_lane_source = true
 * ルール②: 各レーンで最も上（時系列で最後）のノードは is_lane_terminal = true
 */
export function annotateNodeTopologyRules(
  schema: VTASchema,
  rankMap?: Map<string, number>
): VTASchema {
  if (!schema.nodes || schema.nodes.length === 0) return schema;

  const nodes = schema.nodes;
  const edges = schema.edges ?? [];
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  // 1. 他レーンへの矢印（クロスレーン接続線）の始点ノードを検出
  const crossLaneSources = new Set<string>();
  for (const edge of edges) {
    if (!edge.source || !edge.target || edge.source === edge.target) continue;
    const srcNode = nodeById.get(edge.source);
    const tgtNode = nodeById.get(edge.target);
    if (!srcNode || !tgtNode) continue;
    // 同一レーン内の時系列線は除外（他レーンへの接続線のみ）
    if (srcNode.lane === tgtNode.lane) continue;

    const dir = edge.direction;
    // 無向線（同一イベント共通線等）は矢印ではないため除外
    if (dir === 'undirected') continue;

    // 一方向または時系列クロスレーン矢印の始点
    crossLaneSources.add(edge.source);
    // 双方向矢印の場合は両端とも矢印の始点
    if (dir === 'bidirectional') {
      crossLaneSources.add(edge.target);
    }
  }

  // 2. 各レーン内で最上部（時系列で最後）のノードを検出
  const nodesByLane = new Map<string, Array<{ node: VTANodeData; index: number }>>();
  nodes.forEach((node, index) => {
    const lane = node.lane || '主要部門';
    const list = nodesByLane.get(lane) ?? [];
    list.push({ node, index });
    nodesByLane.set(lane, list);
  });

  const laneTerminals = new Set<string>();
  for (const [_lane, group] of nodesByLane) {
    if (!group.length) continue;
    let topNode = group[0].node;
    let topScore = -Infinity;

    for (const { node, index } of group) {
      const r = rankMap?.get(node.id);
      const seq = typeof node.sequence_order === 'number' && Number.isFinite(node.sequence_order)
        ? node.sequence_order
        : index;
      // 時間ランク（上位が時系列後方＝画面上部）を最優先、同ランク内はシーケンス順または出現順
      const score = (typeof r === 'number' && Number.isFinite(r) ? r * 10000 : 0) + seq;
      if (score > topScore) {
        topScore = score;
        topNode = node;
      }
    }
    if (topNode) {
      laneTerminals.add(topNode.id);
    }
  }

  return {
    ...schema,
    nodes: nodes.map((node) => {
      const is_cross_lane_source = crossLaneSources.has(node.id);
      const is_lane_terminal = laneTerminals.has(node.id);
      if (node.is_cross_lane_source === is_cross_lane_source && node.is_lane_terminal === is_lane_terminal) {
        return node;
      }
      return {
        ...node,
        is_cross_lane_source,
        is_lane_terminal,
      };
    }),
  };
}
