import { computeEventRanks } from './eventRanks';
import { parseTimeScore } from './eventTimePoset';
import { visibleSchema, VTA_LANE_WIDTH } from './presentation';
import { VTASchema, VTAReactFlowNode, VTAReactFlowEdge, type EdgeDirection } from '../../../types/vta';
import {
  avoidCards,
  EDGE_BADGE_EDGE_PAD,
  EDGE_BADGE_NODE_PAD,
  EDGE_HORIZONTAL_CLEARANCE_Y,
  EDGE_VERTICAL_CLEARANCE_X,
  horizontalBandBlocked,
  padRect,
  pathPoints,
  rectsOverlap,
  routingOffset,
  segmentBlocked,
  segmentsFromPoints,
  WIRE_NODE_CLEARANCE_Y,
  type AvoidCardsOptions,
  type HorizontalBand,
  type PathSegment,
  type RoutingRect,
  type VerticalBand,
} from './edgeRouting';
import { CROSS_LANE_SOURCE_HANDLE_Y } from './edgeHandles';
import {
  computeEdgeBadgeRects,
  findHostPathSegment,
  resolveEdgeArrowOrientation,
  resolveEdgeLabelContent,
  type EdgeArrowOrientation,
  type EdgeLabelContent,
} from './edgeLabels';
import { getDisplayRect, getEdgeAnchor, isDotProjectedNode, JUNCTION_SIZE, OBJECT_JUNCTION_SIZE, routingObstacles, shouldDisplayAsObjectJunction, type NodeRect } from './nodeGeometry';
import { annotateNodeTopologyRules } from './nodeTopologyRules';
import { pickDefaultPrimaryLane, prioritizeOtherActorsLanes } from './laneOrder';

export { annotateNodeTopologyRules };

export interface LayoutRowBound {
  row: number;
  y: number;
  height: number;
}

export interface LayoutCell {
  row: number;
  lane: string;
  laneIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  nodeIds: string[];
}

export interface LayoutResult {
  nodes: VTAReactFlowNode[];
  edges: VTAReactFlowEdge[];
  laneBounds: Array<{
    name: string;
    index: number;
    x: number;
    width: number;
    minY: number;
    maxY: number;
  }>;
  rowBounds?: LayoutRowBound[];
  cells?: LayoutCell[];
  width: number;
  height: number;
}

export const NODE_WIDTH = 260;
export const NODE_HEIGHT = 140;
export const LANE_WIDTH = VTA_LANE_WIDTH;
export const LANE_PADDING = 50;
export const VERTICAL_GAP = 90;
export const INTRA_RANK_GAP = 30;
export const VERTICAL_STEP = NODE_HEIGHT + VERTICAL_GAP; // 230px (fallback step)

// Shared title wrapping keeps compact canvas cards and SVG cards the same size.
export function compactTitleLines(title: string): string[] {
  return (title || '無題ノード').split('\n').flatMap((line) => {
    const chars = Array.from(line);
    return chars.length ? Array.from({ length: Math.ceil(chars.length / 14) }, (_, i) =>
      chars.slice(i * 14, (i + 1) * 14).join('')) : [''];
  });
}

export function compactNodeHeight(title: string): number {
  return 70 + compactTitleLines(title).length * 20;
}

/**
 * Estimates node height based on content (title, description, badges).
 * Provides a reliable fallback when DOM measurement is not yet available.
 */
export function estimateNodeHeight(node: {
  title?: string;
  description?: string;
  type?: string;
  measure_type?: string | null;
}): number {
  const HEADER_HEIGHT = 42; // Header bar with icons and time badge
  const FOOTER_HEIGHT = 40; // Action bar with elimination toggle button
  const CARD_PADDING = 24;  // p-3 (12px top + 12px bottom)

  // Title: card inner width is ~236px. text-sm (14px). Safe estimate: 14 chars per line.
  // Take newlines into account.
  const title = (node.title || '').trim();
  let titleLines = 1;
  if (title) {
    const rawLines = title.split('\n');
    titleLines = rawLines.reduce((acc, line) => {
      const chars = line.trim().length;
      return acc + Math.max(1, Math.ceil(chars / 14));
    }, 0);
  }
  const titleHeight = titleLines * 22 + 4; // 22px per line + mb-1 (4px)

  // Description: text-xs (12px), p-2 (16px), mt-2 (8px), border (2px) = 26px container
  // Inner width is ~218px. Safe estimate: 16 chars per line.
  let descHeight = 0;
  const desc = (node.description || '').trim();
  if (desc) {
    const rawLines = desc.split('\n');
    const descLines = rawLines.reduce((acc, line) => {
      const chars = line.trim().length;
      return acc + Math.max(1, Math.ceil(chars / 16));
    }, 0);
    descHeight = 26 + descLines * 20; // 26px container padding + 20px per line
  }

  const BASE_SAFETY_MARGIN = 16;
  const calculated = HEADER_HEIGHT + CARD_PADDING + titleHeight + descHeight + FOOTER_HEIGHT + BASE_SAFETY_MARGIN;
  return Math.max(calculated, NODE_HEIGHT);
}

/**
 * Returns effective node height: prioritizing React Flow DOM measured height if available,
 * otherwise falling back to content-based estimation.
 */
export function getNodeHeight(
  node: {
    id: string;
    title?: string;
    description?: string;
    type?: string;
    measure_type?: string | null;
    is_hidden?: boolean;
    hidden_card_height?: number;
  },
  existingNodes?: VTAReactFlowNode[]
): number {
  if (node.is_hidden && node.hidden_card_height) return node.hidden_card_height;
  if (existingNodes) {
    const existing = existingNodes.find((en) => en.id === node.id);
    if (existing?.measured?.height && existing.measured.height > 60) {
      return existing.measured.height;
    }
  }
  return estimateNodeHeight(node);
}


export { parseTimeScore };

/**
 * Computes time-aligned row indices across all lanes via EventTimeDAG (computeEventRanks).
 */
export function computeTimeRanks(schema: VTASchema): Map<string, number> {
  if (schema.nodes.length === 0) return new Map();
  return computeEventRanks(schema);
}

/**
 * Ensures minimal vertical gaps between vertically adjacent nodes within the same lane,
 * preventing cards from overlapping or edges from collapsing.
 * In Bottom-to-Top (BT) layout, nodes with higher ranks (later events) appear near the top (smaller Y),
 * while earlier nodes appear near the bottom (larger Y).
 */
export function enforceLaneVerticalSpacing(
  nodes: VTAReactFlowNode[],
  lanes: string[],
  rankMap?: Map<string, number>,
  defaultObjectDisplayStyle?: 'dot' | 'card'
): VTAReactFlowNode[] {
  // Clone nodes to avoid mutating input directly
  const resultNodes: VTAReactFlowNode[] = nodes.map((n) => ({
    ...n,
    position: { ...n.position },
    data: {
      ...n.data,
      position: { ...n.position },
    },
  }));

  const defaultLaneFallback = pickDefaultPrimaryLane(lanes) || lanes[0];
  for (const lane of lanes) {
    const laneNodes = resultNodes.filter((n) => (n.data?.lane || defaultLaneFallback) === lane);
    if (laneNodes.length <= 1) continue;

    // Sort vertically from top to bottom (ascending Y)
    laneNodes.sort((a, b) => getDisplayRect(a, defaultObjectDisplayStyle).y - getDisplayRect(b, defaultObjectDisplayStyle).y);

    for (let i = 0; i < laneNodes.length - 1; i++) {
      const topNode = laneNodes[i];
      const bottomNode = laneNodes[i + 1];

      const topRank = rankMap?.get(topNode.id);
      const bottomRank = rankMap?.get(bottomNode.id);
      const isSameRank =
        topRank !== undefined && bottomRank !== undefined && topRank === bottomRank;

      const requiredGap = isSameRank ? INTRA_RANK_GAP : VERTICAL_GAP;
      const topRect = getDisplayRect(topNode, defaultObjectDisplayStyle);
      const bottomRect = getDisplayRect(bottomNode, defaultObjectDisplayStyle);
      const minAllowedBottomY = topRect.y + topRect.height + requiredGap;

      if (bottomRect.y < minAllowedBottomY) {
        const delta = minAllowedBottomY - bottomRect.y;
        for (let j = i + 1; j < laneNodes.length; j++) {
          const n = laneNodes[j];
          n.position.y += delta;
          if (n.data) {
            n.data.position = { ...n.position };
          }
        }
      }
    }
  }

  return resultNodes;
}

/**
 * Computes Time-Aligned Bottom-to-Top (BT) layout partitioned by Swimlanes.
 * 
 * VTA Principles:
 * 1. Time progresses from bottom to top (BT).
 * 2. All nodes across all lanes are vertically aligned in chronological order.
 * 3. Nodes with identical or undetermined timing share the exact same vertical height.
 * 4. Horizontal axis is partitioned by actors/lanes.
 */
export interface LayoutOptions {
  compact?: boolean;
  positionField?: 'position' | 'compact_position';
  /** If true, ignores manual node.position and recomputes all positions via BT layout algorithm */
  forceRecompute?: boolean;
}

export function calculateVTALayout(
  schema: VTASchema,
  existingNodes?: VTAReactFlowNode[],
  _existingEdges?: VTAReactFlowEdge[],
  options?: LayoutOptions
): LayoutResult {
  schema = visibleSchema(schema);
  const rankMap = computeTimeRanks(schema);
  const maxRank = Math.max(...Array.from(rankMap.values()), 0);
  schema = annotateNodeTopologyRules(schema, rankMap);

  const cardHeightOf = (node: VTASchema['nodes'][number]) => options?.compact
    ? compactNodeHeight(node.title)
    : getNodeHeight(node, existingNodes);
  const isObjectDot = (node: VTASchema['nodes'][number]) =>
    shouldDisplayAsObjectJunction(node, schema.presentation?.defaultObjectDisplayStyle);
  const heightOf = (node: VTASchema['nodes'][number]) =>
    node.is_hidden ? JUNCTION_SIZE : isObjectDot(node) ? OBJECT_JUNCTION_SIZE : cardHeightOf(node);
  const lanes = schema.lanes.length > 0
    ? schema.lanes
    : prioritizeOtherActorsLanes(
        Array.from(new Set(schema.nodes.map((n) => n.lane || '主要部門'))),
        schema.analysis?.entities
      );
  const fallbackLane = pickDefaultPrimaryLane(lanes, schema.analysis?.entities) || '主要部門';

  // Map each lane to an index
  const laneIndexMap = new Map<string, number>();
  lanes.forEach((lane, idx) => laneIndexMap.set(lane, idx));
  const schemaOrderById = new Map(schema.nodes.map((node, idx) => [node.id, idx]));

  // Group nodes by (lane, rank) to prevent overlapping in the same lane at the same time
  const laneRankMap = new Map<string, VTASchema['nodes']>();
  schema.nodes.forEach((node) => {
    const lane = node.lane || fallbackLane;
    const rank = rankMap.get(node.id) ?? 0;
    const key = `${lane}__${rank}`;
    const list = laneRankMap.get(key) || [];
    list.push(node);
    laneRankMap.set(key, list);
  });
  for (const list of laneRankMap.values()) {
    if (list.length > 1) {
      // Chronological order (earliest first -> placed at bottom in BT layout)
      list.sort((a, b) => {
        const hasA = typeof a.sequence_order === 'number' && Number.isFinite(a.sequence_order);
        const hasB = typeof b.sequence_order === 'number' && Number.isFinite(b.sequence_order);
        if (hasA && hasB && a.sequence_order !== b.sequence_order) {
          return a.sequence_order! - b.sequence_order!;
        }
        return (schemaOrderById.get(a.id) ?? 0) - (schemaOrderById.get(b.id) ?? 0);
      });
    }
  }

  // Calculate required dynamic slice height per time rank (Variable Height Architecture)
  // The required slice height of rank r is the maximum required lane height across all lanes,
  // plus any top/bottom half-height overhang needed when a taller single-occupancy node aligns
  // center-to-center with a shorter top/bottom node of a stacked lane in the same rank.
  const rankHeightMap = new Map<number, number>();
  const rankTopPadMap = new Map<number, number>();
  const schemaNodeById = new Map(schema.nodes.map((n) => [n.id, n]));
  const rankOverhang = new Map<number, { topPad: number; bottomPad: number }>();
  if (schema.analysis) {
    for (const edge of schema.edges) {
      const dir = edge.direction || 'unidirectional';
      if (dir === 'bidirectional' || dir === 'undirected') continue;
      const srcRank = rankMap.get(edge.source);
      const tgtRank = rankMap.get(edge.target);
      if (srcRank === undefined || tgtRank === undefined || srcRank !== tgtRank) continue;
      const srcNode = schemaNodeById.get(edge.source);
      const tgtNode = schemaNodeById.get(edge.target);
      if (!srcNode || !tgtNode) continue;
      const srcLane = srcNode.lane || fallbackLane;
      const tgtLane = tgtNode.lane || fallbackLane;
      if (srcLane === tgtLane) continue;
      const srcSiblings = laneRankMap.get(`${srcLane}__${srcRank}`) || [];
      const tgtSiblings = laneRankMap.get(`${tgtLane}__${tgtRank}`) || [];
      let singleNode: VTASchema['nodes'][number] | undefined;
      let stackedPartner: VTASchema['nodes'][number] | undefined;
      let stackedList: VTASchema['nodes'] | undefined;
      if (srcSiblings.length === 1 && tgtSiblings.length > 1) {
        singleNode = srcNode;
        stackedPartner = tgtNode;
        stackedList = tgtSiblings;
      } else if (tgtSiblings.length === 1 && srcSiblings.length > 1) {
        singleNode = tgtNode;
        stackedPartner = srcNode;
        stackedList = srcSiblings;
      }
      if (!singleNode || !stackedPartner || !stackedList) continue;
      const pad = Math.max(0, (heightOf(singleNode) - heightOf(stackedPartner)) / 2);
      if (pad <= 0) continue;
      const entry = rankOverhang.get(srcRank) ?? { topPad: 0, bottomPad: 0 };
      const topNode = stackedList[stackedList.length - 1];
      const bottomNode = stackedList[0];
      if (stackedPartner.id === topNode.id) {
        entry.topPad = Math.max(entry.topPad, pad);
      }
      if (stackedPartner.id === bottomNode.id) {
        entry.bottomPad = Math.max(entry.bottomPad, pad);
      }
      rankOverhang.set(srcRank, entry);
    }
  }
  for (let r = 0; r <= maxRank; r++) {
    let maxLaneHeight = 0;
    for (const lane of lanes) {
      const list = laneRankMap.get(`${lane}__${r}`) || [];
      if (list.length > 0) {
        const heights = list.map(heightOf);
        const totalNodeHeight = heights.reduce((sum, h) => sum + h, 0);
        const laneH = totalNodeHeight + (heights.length - 1) * INTRA_RANK_GAP;
        if (laneH > maxLaneHeight) {
          maxLaneHeight = laneH;
        }
      }
    }
    const overhang = rankOverhang.get(r);
    const topPad = overhang?.topPad ?? 0;
    const bottomPad = overhang?.bottomPad ?? 0;
    if (topPad > 0) rankTopPadMap.set(r, topPad);
    const effectiveHeight = (maxLaneHeight > 0 ? maxLaneHeight : NODE_HEIGHT) + topPad + bottomPad;
    rankHeightMap.set(r, effectiveHeight);
  }

  // Cumulatively compute base Y coordinate from top (maxRank) down to bottom (0)
  // Guaranteed visual gap between rank r and rank r-1 is VERTICAL_GAP (90px)
  const rankBaseY = new Map<number, number>();
  let currentY = LANE_PADDING;
  for (let r = maxRank; r >= 0; r--) {
    rankBaseY.set(r, currentY);
    const h = rankHeightMap.get(r) ?? NODE_HEIGHT;
    currentY += h + VERTICAL_GAP;
  }

  let globalMinY = Infinity;
  let globalMaxY = -Infinity;

  // Build React Flow nodes with Time-Aligned Positions
  const computedOriginById = new Map<string, { x: number; y: number }>();
  const savedPosNodeIds = new Set<string>();
  const existingFallbackNodeIds = new Set<string>();
  const rawNodes: VTAReactFlowNode[] = schema.nodes.map((node) => {
    const lane = node.lane || fallbackLane;
    const laneIdx = laneIndexMap.get(lane) ?? 0;
    const rank = rankMap.get(node.id) ?? 0;

    // Check intra-lane same-rank index (if multiple nodes in same lane at same rank)
    const key = `${lane}__${rank}`;
    const siblings = laneRankMap.get(key) || [node];
    const siblingIdx = siblings.findIndex((n) => n.id === node.id);
    let intraOffset = siblings.length > 1 ? (rankTopPadMap.get(rank) ?? 0) : 0;
    // Bottom-to-Top: siblings are ordered earliest -> latest, so place later siblings above earlier ones
    for (let i = siblingIdx + 1; i < siblings.length; i++) {
      intraOffset += heightOf(siblings[i]) + INTRA_RANK_GAP;
    }

    // Center X within the corresponding lane
    const laneCenterX = laneIdx * LANE_WIDTH + LANE_WIDTH / 2 + LANE_PADDING;
    const computedX = laneCenterX - NODE_WIDTH / 2;

    // Bottom-to-Top: dynamically cumulative base Y ensures no overlap with lower ranks.
    // Both hidden junctions and passive object dots store rawNode.position as an unprojected card
    // origin around their visual dot center so getDisplayRect / projectDisplayNode lands on the rank center.
    const isDot = Boolean(node.is_hidden || isObjectDot(node));
    const dotSize = node.is_hidden ? JUNCTION_SIZE : OBJECT_JUNCTION_SIZE;
    const rankCenterOffset =
      (schema.analysis || isDot) && siblings.length === 1
        ? ((rankHeightMap.get(rank) ?? heightOf(node)) - heightOf(node)) / 2
        : 0;
    const dotOriginCompensation = isDot ? (cardHeightOf(node) - dotSize) / 2 : 0;
    const computedY =
      (rankBaseY.get(rank) ?? LANE_PADDING) + intraOffset + rankCenterOffset - dotOriginCompensation;
    computedOriginById.set(node.id, { x: computedX, y: computedY });

    let finalX = computedX;
    let finalY = computedY;

    if (!options?.forceRecompute) {
      const savedPosition = options?.positionField === 'compact_position' ? node.compact_position : node.position;
      if (savedPosition && typeof savedPosition.x === 'number' && typeof savedPosition.y === 'number') {
        finalX = savedPosition.x;
        finalY = savedPosition.y;
        savedPosNodeIds.add(node.id);
      } else if (existingNodes) {
        const existing = existingNodes.find((en) => en.id === node.id);
        if (existing && typeof existing.position?.x === 'number' && typeof existing.position?.y === 'number') {
          finalX = existing.position.x;
          finalY = existing.position.y;
          existingFallbackNodeIds.add(node.id);
        }
      }
    }

    const nodeH = cardHeightOf(node);

    return {
      id: node.id,
      type: 'vtaNode',
      position: { x: finalX, y: finalY },
      measured: {
        width: NODE_WIDTH,
        height: nodeH,
      },
      data: {
        id: node.id,
        lane: node.lane,
        time: node.time,
        type: node.type,
        outcome_kind: node.outcome_kind,
        variation_factor: node.variation_factor,
        entity_role: node.entity_role,
        object_display_style: node.object_display_style,
        is_cross_lane_source: node.is_cross_lane_source,
        is_lane_terminal: node.is_lane_terminal,
        title: node.title,
        description: node.description,
        measure_type: node.measure_type,
        is_hidden: node.is_hidden,
        hidden_card_height: node.hidden_card_height,
        compact_position: node.compact_position,
        sequence_order: node.sequence_order,
        supplementary_note: node.supplementary_note,
        position: { x: finalX, y: finalY },
        measuredHeight: nodeH,
      },
    };
  });

  // Guard against stale `existingNodes` Y coordinates inverting a lane after re-optimization or rank shifts:
  // when a lane has no persisted schema positions and mixed/out-of-order fallback Y values violate BT order,
  // reset that lane to freshly computed Bottom-to-Top positions.
  if (!options?.forceRecompute && existingFallbackNodeIds.size > 0) {
    const rawByLane = new Map<string, VTAReactFlowNode[]>();
    for (const rn of rawNodes) {
      const lane = String(rn.data?.lane || fallbackLane);
      const list = rawByLane.get(lane) ?? [];
      list.push(rn);
      rawByLane.set(lane, list);
    }
    for (const laneNodes of rawByLane.values()) {
      if (laneNodes.length <= 1) continue;
      const hasSaved = laneNodes.some((n) => savedPosNodeIds.has(n.id));
      const hasExistingFallback = laneNodes.some((n) => existingFallbackNodeIds.has(n.id));
      if (hasSaved || !hasExistingFallback) continue;

      const btOrdered = [...laneNodes].sort((a, b) => {
        const rankA = rankMap.get(a.id) ?? 0;
        const rankB = rankMap.get(b.id) ?? 0;
        if (rankA !== rankB) return rankA - rankB;
        const seqA = typeof a.data?.sequence_order === 'number' ? a.data.sequence_order : Number.MAX_SAFE_INTEGER;
        const seqB = typeof b.data?.sequence_order === 'number' ? b.data.sequence_order : Number.MAX_SAFE_INTEGER;
        if (seqA !== seqB) return seqA - seqB;
        return (schemaOrderById.get(a.id) ?? 0) - (schemaOrderById.get(b.id) ?? 0);
      });
      let inverted = false;
      for (let i = 1; i < btOrdered.length; i++) {
        // Bottom-to-Top: earlier node (i-1) must sit below later node (i), so earlier.y > later.y
        if (btOrdered[i - 1].position.y <= btOrdered[i].position.y) {
          inverted = true;
          break;
        }
      }
      if (inverted) {
        for (const n of laneNodes) {
          const fresh = computedOriginById.get(n.id);
          if (fresh) {
            n.position = { ...fresh };
            if (n.data) n.data.position = { ...fresh };
          }
        }
      }
    }
  }

  const defaultObjStyle = schema.presentation?.defaultObjectDisplayStyle;
  // Align single-occupancy same-rank nodes with their cross-lane partners so
  // same-rank unidirectional cross-lane arrows do not drop downward.
  if (schema.analysis) {
    const rawById = new Map(rawNodes.map((n) => [n.id, n]));
    const sameRankCrossEdges = schema.edges.filter((edge) => {
      const srcRank = rankMap.get(edge.source);
      const tgtRank = rankMap.get(edge.target);
      if (srcRank === undefined || tgtRank === undefined || srcRank !== tgtRank) return false;
      const srcNode = rawById.get(edge.source);
      const tgtNode = rawById.get(edge.target);
      if (!srcNode || !tgtNode) return false;
      const srcLane = String(srcNode.data?.lane || fallbackLane);
      const tgtLane = String(tgtNode.data?.lane || fallbackLane);
      if (srcLane === tgtLane) return false;
      const dir = edge.direction || 'unidirectional';
      return dir !== 'bidirectional' && dir !== 'undirected';
    });

    if (sameRankCrossEdges.length > 0) {
      const centerYOf = (n: VTAReactFlowNode): number => {
        const rect = getDisplayRect(n, defaultObjStyle);
        return rect.y + rect.height / 2;
      };
      for (let pass = 0; pass < 2; pass++) {
        let changed = false;
        for (const n of rawNodes) {
          if (savedPosNodeIds.has(n.id) || existingFallbackNodeIds.has(n.id)) continue;
          const rank = rankMap.get(n.id);
          if (rank === undefined) continue;
          const lane = String(n.data?.lane || fallbackLane);
          const siblings = laneRankMap.get(`${lane}__${rank}`) || [n];
          if (siblings.length !== 1) continue;

          const rect = getDisplayRect(n, defaultObjStyle);
          const minDisplayY = rankBaseY.get(rank) ?? LANE_PADDING;
          const rankHeight = rankHeightMap.get(rank) ?? rect.height;
          const maxDisplayY = Math.max(minDisplayY, minDisplayY + rankHeight - rect.height);
          const minCenterY = minDisplayY + rect.height / 2;
          const maxCenterY = maxDisplayY + rect.height / 2;

          let lowerBound = -Infinity;
          let upperBound = Infinity;
          for (const edge of sameRankCrossEdges) {
            if (edge.target === n.id) {
              const src = rawById.get(edge.source);
              if (src) upperBound = Math.min(upperBound, centerYOf(src));
            } else if (edge.source === n.id) {
              const tgt = rawById.get(edge.target);
              if (tgt) lowerBound = Math.max(lowerBound, centerYOf(tgt));
            }
          }
          if (!Number.isFinite(lowerBound) && !Number.isFinite(upperBound)) continue;

          const currentCenterY = rect.y + rect.height / 2;
          const clampedLower = Math.max(minCenterY, lowerBound);
          const clampedUpper = Math.min(maxCenterY, upperBound);
          const targetCenterY = clampedLower <= clampedUpper
            ? Math.min(Math.max(currentCenterY, clampedLower), clampedUpper)
            : Math.min(Math.max(clampedUpper, minCenterY), maxCenterY);

          const deltaY = targetCenterY - currentCenterY;
          if (Math.abs(deltaY) > 0.5) {
            n.position = { x: n.position.x, y: n.position.y + deltaY };
            if (n.data?.position) {
              n.data.position = { x: n.data.position.x, y: n.data.position.y + deltaY };
            }
            const origin = computedOriginById.get(n.id);
            if (origin) origin.y += deltaY;
            changed = true;
          }
        }
        // Also allow stacked lane cells (siblings.length > 1) with vertical slack inside their rank
        // to shift rigidly as a block to satisfy same-rank cross-lane unidirectional constraints.
        for (const cellSchemaNodes of laneRankMap.values()) {
          if (cellSchemaNodes.length <= 1) continue;
          const groupNodes = cellSchemaNodes
            .map((sn) => rawById.get(sn.id))
            .filter((rn): rn is VTAReactFlowNode => Boolean(rn));
          if (groupNodes.length <= 1) continue;
          if (groupNodes.some((gn) => savedPosNodeIds.has(gn.id) || existingFallbackNodeIds.has(gn.id))) continue;
          const rank = rankMap.get(groupNodes[0].id);
          if (rank === undefined) continue;
          const minRankY = rankBaseY.get(rank) ?? LANE_PADDING;
          const rankHeight = rankHeightMap.get(rank) ?? NODE_HEIGHT;
          let groupMinY = Infinity;
          let groupMaxBottom = -Infinity;
          for (const gn of groupNodes) {
            const r = getDisplayRect(gn, defaultObjStyle);
            if (r.y < groupMinY) groupMinY = r.y;
            if (r.y + r.height > groupMaxBottom) groupMaxBottom = r.y + r.height;
          }
          const minDelta = minRankY - groupMinY;
          const maxDelta = minRankY + rankHeight - groupMaxBottom;
          if (maxDelta - minDelta < 0.5) continue;

          const groupIdSet = new Set(groupNodes.map((gn) => gn.id));
          let lowerDelta = -Infinity;
          let upperDelta = Infinity;
          for (const edge of sameRankCrossEdges) {
            if (groupIdSet.has(edge.target)) {
              const src = rawById.get(edge.source);
              const tgt = rawById.get(edge.target);
              if (src && tgt) upperDelta = Math.min(upperDelta, centerYOf(src) - centerYOf(tgt));
            } else if (groupIdSet.has(edge.source)) {
              const src = rawById.get(edge.source);
              const tgt = rawById.get(edge.target);
              if (src && tgt) lowerDelta = Math.max(lowerDelta, centerYOf(tgt) - centerYOf(src));
            }
          }
          if (!Number.isFinite(lowerDelta) && !Number.isFinite(upperDelta)) continue;
          const clampedLower = Math.max(minDelta, lowerDelta);
          const clampedUpper = Math.min(maxDelta, upperDelta);
          if (clampedLower > clampedUpper) continue;
          const deltaY = Math.min(Math.max(0, clampedLower), clampedUpper);
          if (Math.abs(deltaY) > 0.5) {
            for (const gn of groupNodes) {
              gn.position = { x: gn.position.x, y: gn.position.y + deltaY };
              if (gn.data?.position) {
                gn.data.position = { x: gn.data.position.x, y: gn.data.position.y + deltaY };
              }
              const origin = computedOriginById.get(gn.id);
              if (origin) origin.y += deltaY;
            }
            changed = true;
          }
        }
        if (!changed) break;
      }
    }
  }

  // Post-process: Enforce minimum vertical spacing within each lane (Collision Push)
  // Guarantees that no cards overlap vertically and intra-lane edge lines are always visible
  const positionField = options?.positionField ?? 'position';
  const hasAnySavedPosition = schema.nodes.some((node) => {
    const saved = node[positionField];
    return saved && Number.isFinite(saved.x) && Number.isFinite(saved.y);
  });
  // Saved view coordinates are authoritative. Collision correction is performed
  // when an edit is committed, never as a side effect of rendering/exporting.
  const nodes = !options?.forceRecompute && hasAnySavedPosition
    ? rawNodes
    : enforceLaneVerticalSpacing(rawNodes, lanes, rankMap, defaultObjStyle);

  // Recalculate global vertical bounds after spacing adjustment
  for (const n of nodes) {
    const rect = getDisplayRect(n, defaultObjStyle);
    if (rect.y < globalMinY) globalMinY = rect.y;
    if (rect.y + rect.height > globalMaxY) globalMaxY = rect.y + rect.height;
  }

  // Safe fallback if graph was empty
  if (globalMinY === Infinity) globalMinY = 0;
  if (globalMaxY === -Infinity) globalMaxY = 600;

  // Calculate lane bounds for swimlane background
  const totalLanes = Math.max(lanes.length, 1);
  const laneBounds = lanes.map((name, index) => {
    return {
      name,
      index,
      x: index * LANE_WIDTH + LANE_PADDING,
      width: LANE_WIDTH,
      minY: globalMinY - 60,
      maxY: globalMaxY + 60,
    };
  });

  // Build React Flow edges with optimal handles for orthogonal step wiring
  const edges: VTAReactFlowEdge[] = schema.edges.map((edge, idx) => {
    const edgeId = edge.id ?? `e-${edge.source}-${edge.target}-${idx}`;
    const srcNode = schema.nodes.find((n) => n.id === edge.source);
    const tgtNode = schema.nodes.find((n) => n.id === edge.target);

    const srcLane = srcNode?.lane || fallbackLane;
    const tgtLane = tgtNode?.lane || fallbackLane;
    const isCrossLane = srcLane !== tgtLane;

    const srcLaneIdx = laneIndexMap.get(srcLane) ?? 0;
    const tgtLaneIdx = laneIndexMap.get(tgtLane) ?? 0;

    let sourceHandle = 'top';
    let targetHandle = 'bottom';

    // 1. Cross-lane Information Transmission (一方向・双方向情報伝達):
    // Connect side-to-side (Left/Right handles)
    if (isCrossLane) {
      if (srcLaneIdx < tgtLaneIdx) {
        // Source is in a left lane, Target is in a right lane -> Right to Left
        sourceHandle = 'right';
        targetHandle = 'left';
      } else {
        // Source is in a right lane, Target is in a left lane -> Left to Right
        sourceHandle = 'left';
        targetHandle = 'right';
      }
    } else {
      // 2. Intra-lane Sequential Flow (同一レーン内の隣接ノード):
      // Lower node top handle -> Upper node bottom handle
      sourceHandle = 'top';
      targetHandle = 'bottom';
    }

    const direction =
      edge.direction || (isCrossLane ? 'unidirectional' : 'sequential');

    return {
      id: edgeId,
      source: edge.source,
      target: edge.target,
      sourceHandle,
      targetHandle,
      type: 'vtaEdge',
      data: {
        ...edge,
        is_break: Boolean(edge.is_break),
        direction,
        is_cross_lane: isCrossLane,
        sourceLane: srcLane,
        targetLane: tgtLane,
        laneDistance: Math.abs(srcLaneIdx - tgtLaneIdx),
        label: edge.label,
        category: edge.category,
      },
    };
  });

  const totalWidth = totalLanes * LANE_WIDTH + LANE_PADDING * 2;
  const totalHeight = globalMaxY - globalMinY + 120;

  const rowBounds: LayoutRowBound[] = [];
  const cells: LayoutCell[] = [];
  if (schema.nodes.length > 0) {
    for (let r = 0; r <= maxRank; r++) {
      const rowY = rankBaseY.get(r) ?? LANE_PADDING;
      const rowH = rankHeightMap.get(r) ?? NODE_HEIGHT;
      rowBounds.push({ row: r, y: rowY, height: rowH });
      lanes.forEach((lane, laneIdx) => {
        const cellNodes = laneRankMap.get(`${lane}__${r}`) || [];
        cells.push({
          row: r,
          lane,
          laneIndex: laneIdx,
          x: laneIdx * LANE_WIDTH + LANE_PADDING,
          y: rowY,
          width: LANE_WIDTH,
          height: rowH,
          nodeIds: cellNodes.map((n) => n.id),
        });
      });
    }
  }

  return {
    nodes,
    edges,
    laneBounds,
    rowBounds,
    cells,
    width: totalWidth,
    height: totalHeight,
  };
}

export interface OrthogonalStepPathParams {
  obstacles?: RoutingRect[];
  routeOffset?: number;
  /** Optional explicit corridor vertical offset override (overrides routeOffset for Y corridor). */
  corridorOffsetY?: number;
  /** Optional explicit source-side / Case 2b channel horizontal offset override. */
  outChannelOffset?: number;
  /** Optional explicit target-side channel horizontal offset override. */
  inChannelOffset?: number;
  /** Optional corridor side override for Case 2c detours ('top' above source, 'bottom' below source). */
  corridorSide?: 'top' | 'bottom';
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition?: string;
  targetPosition?: string;
  verticalGap?: number;
  sourceNodeHeight?: number;
  sourceNodeTop?: number;
  laneDistance?: number;
  targetIsJunction?: boolean;
  sourceIsJunction?: boolean;
  /** Force corridor detouring even when nodes sit at the same vertical height. */
  forceCorridorDetour?: boolean;
  /** Optional occupied horizontal bands avoided when fallback card routing activates. */
  avoidHorizontalBands?: readonly HorizontalBand[];
  /** Optional occupied vertical stem bands avoided when fallback card routing activates. */
  avoidVerticalBands?: readonly VerticalBand[];
  /** Preferred bypass side around obstacle cards for intra-lane skip detours. */
  detourSide?: 'left' | 'right';
  /** Horizontal margin offset around obstacle cards (independent of vertical stub margin). */
  detourXMarginOffset?: number;
}

export type EdgePathTuple = [string, number, number];

function isSideToSideConnection(
  sourceX: number,
  targetX: number,
  sourcePosition?: string,
  targetPosition?: string
): boolean {
  return (
    sourcePosition === 'left' ||
    sourcePosition === 'right' ||
    targetPosition === 'left' ||
    targetPosition === 'right' ||
    (!sourcePosition && !targetPosition && Math.abs(sourceX - targetX) >= 40)
  );
}

/**
 * Computes orthogonal step wiring path for VTA diagrams.
 *
 * Rules:
 * 1. Intra-lane connections (same lane): Straight vertical line from lower node top to upper node bottom.
 * 2. Cross-lane information connections: From side handle (Left/Right) to destination side handle (Left/Right).
 *    - Same-height with no intermediate obstacle blocking the wire band: Direct horizontal line.
 *    - Blocked or different ranks: Orthogonal step routing through inter-lane space / corridor.
 * 3. Line crossings occur outside card footprints so no wire passes beneath node cards.
 * 4. Used identically across React Flow Canvas (VTAEdge.tsx) and SVG Export (svgExport.ts).
 */
const JUNCTION_APPROACH_MARGIN = Math.max(70, Math.min(120, (LANE_WIDTH - NODE_WIDTH) / 2 + 50));

export function getOrthogonalStepPath(params: OrthogonalStepPathParams): EdgePathTuple {
  const candidate = corridorPath(params);
  if (!params.obstacles?.length) return candidate;
  const avoidBand =
    params.forceCorridorDetour && Math.abs(params.sourceY - params.targetY) < 2
      ? {
          minY: Math.min(params.sourceY, params.targetY) - EDGE_HORIZONTAL_CLEARANCE_Y,
          maxY: Math.max(params.sourceY, params.targetY) + EDGE_HORIZONTAL_CLEARANCE_Y,
        }
      : undefined;
  const spanX = Math.abs(params.sourceX - params.targetX);
  const minSideStem = spanX >= 90 ? 18 : 10;
  const isSide = isSideToSideConnection(
    params.sourceX,
    params.targetX,
    params.sourcePosition,
    params.targetPosition
  );
  const sourceMargin =
    isSide && params.outChannelOffset !== undefined
      ? Math.max(minSideStem, 30 + params.outChannelOffset)
      : undefined;
  const targetMargin = params.targetIsJunction
    ? Math.max(minSideStem, JUNCTION_APPROACH_MARGIN + (params.inChannelOffset ?? 0))
    : isSide && params.inChannelOffset !== undefined
      ? Math.max(minSideStem, 30 + params.inChannelOffset)
      : undefined;
  const avoidOptions: AvoidCardsOptions | undefined =
    params.detourSide !== undefined ||
    params.detourXMarginOffset !== undefined ||
    sourceMargin !== undefined ||
    params.avoidVerticalBands?.length
      ? {
          ...(params.detourSide !== undefined ? { detourSide: params.detourSide } : {}),
          ...(params.detourXMarginOffset !== undefined ? { xMarginOffset: params.detourXMarginOffset } : {}),
          ...(sourceMargin !== undefined ? { sourceMargin } : {}),
          ...(params.avoidVerticalBands?.length ? { extraAvoidVerticalBands: params.avoidVerticalBands } : {}),
        }
      : undefined;
  return avoidCards(
    candidate,
    params.obstacles,
    params.sourcePosition,
    params.targetPosition,
    params.corridorOffsetY ?? params.routeOffset,
    avoidBand,
    targetMargin,
    params.avoidHorizontalBands,
    avoidOptions
  );
}

function corridorPath({
  obstacles = [],
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  verticalGap = VERTICAL_GAP,
  sourceNodeHeight = NODE_HEIGHT,
  sourceNodeTop,
  laneDistance,
  routeOffset = 0,
  corridorOffsetY,
  outChannelOffset,
  inChannelOffset,
  corridorSide,
  targetIsJunction = false,
  sourceIsJunction = false,
  forceCorridorDetour = false,
}: OrthogonalStepPathParams): EdgePathTuple {
  // Case 1: Intra-lane / pure vertical (connecting top to bottom handles along same lane axis)
  if (Math.abs(sourceX - targetX) < 2 && sourcePosition !== 'left' && sourcePosition !== 'right') {
    const path = `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`;
    const labelX = sourceX;
    const labelY = (sourceY + targetY) / 2;
    return [path, labelX, labelY];
  }

  // Determine if this is a side-to-side connection (cross-lane information transmission)
  if (isSideToSideConnection(sourceX, targetX, sourcePosition, targetPosition)) {
    const spanX = Math.abs(sourceX - targetX);
    const signX = sourceX < targetX ? 1 : -1;
    // Inter-lane gap between adjacent nodes is (LANE_WIDTH - NODE_WIDTH) = 120px.
    // When connecting adjacent lanes with junctions, distance to junction is wider (~250px).
    const isAdjacentLanes = laneDistance !== undefined
      ? laneDistance <= 1
      : spanX <= (LANE_WIDTH - (targetIsJunction || sourceIsJunction ? 0 : NODE_WIDTH)) + 80;
    const sameHeight = Math.abs(sourceY - targetY) < 2;
    const midY = sourceY === targetY ? sourceY : (sourceY + targetY) / 2;

    // Case 2a: Same-height cross-lane direct horizontal connection (adjacent or multi-lane when clear)
    if (
      sameHeight &&
      !forceCorridorDetour &&
      !horizontalBandBlocked(sourceX, targetX, midY, WIRE_NODE_CLEARANCE_Y, obstacles)
    ) {
      const path = `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`;
      const labelX = (sourceX + targetX) / 2;
      return [path, labelX, midY];
    }

    // Case 2b: Adjacent lanes with different height
    if (isAdjacentLanes && !sameHeight && !forceCorridorDetour) {
      // The midpoint is strictly inside the open inter-lane channel between the 2 adjacent lanes
      const midShift = outChannelOffset ?? routeOffset;
      const rawMidX = (sourceX + targetX) / 2 + midShift;
      const minSideMargin = Math.min(18, Math.floor(spanX * 0.25));
      const lowX = Math.min(sourceX, targetX) + minSideMargin;
      const highX = Math.max(sourceX, targetX) - minSideMargin;
      const midX = lowX <= highX ? Math.max(lowX, Math.min(highX, rawMidX)) : (sourceX + targetX) / 2;
      const path = `M ${sourceX} ${sourceY} L ${midX} ${sourceY} L ${midX} ${targetY} L ${targetX} ${targetY}`;
      const labelX = midX;
      const labelY = (sourceY + targetY) / 2;
      return [path, labelX, labelY];
    }

    // Case 2c: Corridor detour routing (multi-lane spanning, obstructed straight path, or duplicate bypass)
    // Route via the horizontal corridor in the vertical gap between node ranks.
    const outShift = outChannelOffset ?? routeOffset;
    const inShift = inChannelOffset ?? outShift;
    const corridorShift = corridorOffsetY ?? routeOffset;
    const minSideStem = spanX >= 90 ? 18 : 10;
    const rawOut = Math.max(minSideStem, 30 + outShift);
    // ドット表示ノード（Junction）の場合、ドット直前30pxでの急激なクランクを防ぎ、レーン境界付近で曲がる
    const rawIn = targetIsJunction
      ? Math.max(minSideStem, JUNCTION_APPROACH_MARGIN + (inChannelOffset ?? 0))
      : Math.max(minSideStem, 30 + inShift);
    const minBridge = Math.min(24, spanX * 0.4);
    const maxOffsetSum = Math.max(0, spanX - minBridge);
    let outMag = rawOut;
    let inMag = rawIn;
    if (outMag + inMag > maxOffsetSum && outMag + inMag > 0) {
      const scale = maxOffsetSum / (outMag + inMag);
      outMag = Math.max(8, Math.round(outMag * scale));
      inMag = Math.max(8, Math.round(inMag * scale));
    }
    const x1 = sourceX + outMag * signX; // Inter-lane channel next to source node
    const x2 = targetX - inMag * signX; // Inter-lane channel next to target node

    const useBottomCorridor = corridorSide ? corridorSide === 'bottom' : sourceY < targetY;
    let corridorY: number;
    if (!useBottomCorridor) {
      // Bottom-to-Top (or same height detour): route in corridor above source node top
      // Side source handle is positioned at CROSS_LANE_SOURCE_HANDLE_Y within the card.
      const sourceTop = sourceNodeTop ?? sourceY - sourceNodeHeight * CROSS_LANE_SOURCE_HANDLE_Y;
      corridorY = sourceTop - verticalGap / 2 + corridorShift;
    } else {
      // Top-to-Bottom: route in corridor below source node bottom
      const sourceBottom = (sourceNodeTop ?? sourceY - sourceNodeHeight * CROSS_LANE_SOURCE_HANDLE_Y) + sourceNodeHeight;
      corridorY = sourceBottom + verticalGap / 2 + corridorShift;
    }

    // 5-segment obstacle-free orthogonal path:
    // (sourceX, sourceY) -> (x1, sourceY) -> (x1, corridorY) -> (x2, corridorY) -> (x2, targetY) -> (targetX, targetY)
    const path = `M ${sourceX} ${sourceY} L ${x1} ${sourceY} L ${x1} ${corridorY} L ${x2} ${corridorY} L ${x2} ${targetY} L ${targetX} ${targetY}`;
    const labelX = (x1 + x2) / 2;
    const labelY = corridorY;
    return [path, labelX, labelY];
  }

  // Case 3: Pure horizontal connection fallback
  if (Math.abs(sourceY - targetY) < 2) {
    const path = `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`;
    const labelX = (sourceX + targetX) / 2;
    const labelY = sourceY;
    return [path, labelX, labelY];
  }

  // Case 4: Top/Bottom handle step routing fallback
  let corridorY: number;
  if (sourceY > targetY) {
    const deltaY = sourceY - targetY;
    if (deltaY <= verticalGap + 10) {
      corridorY = (sourceY + targetY) / 2;
    } else {
      corridorY = sourceY - verticalGap / 2;
    }
  } else {
    const deltaY = targetY - sourceY;
    if (deltaY <= verticalGap + 10) {
      corridorY = (sourceY + targetY) / 2;
    } else {
      corridorY = sourceY + verticalGap / 2;
    }
  }

  const path = `M ${sourceX} ${sourceY} L ${sourceX} ${corridorY} L ${targetX} ${corridorY} L ${targetX} ${targetY}`;
  const labelX = (sourceX + targetX) / 2;
  const labelY = corridorY;

  return [path, labelX, labelY];
}

interface EdgePathContext {
  id: string;
  originalIndex: number;
  source: string;
  target: string;
  sourcePosition: string;
  targetPosition: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourceNodeHeight: number;
  sourceNodeTop: number;
  sourceIsJunction: boolean;
  targetIsJunction: boolean;
  laneDistance?: number;
  routeOffset: number;
  obstacles: RoutingRect[];
  isCrossLane: boolean;
  isBreak: boolean;
  direction: EdgeDirection;
  orientation: EdgeArrowOrientation;
  labelContent: EdgeLabelContent;
  isDirectCandidate: boolean;
}

interface PlacedEdgeGeometry {
  ctx: EdgePathContext;
  tuple: EdgePathTuple;
  segments: PathSegment[];
  hostSegment?: PathSegment;
  orientation: EdgeArrowOrientation;
  isVerticalLabel: boolean;
  badgeRects: RoutingRect[];
}

export interface ResolveEdgePathsOptions {
  verticalGap?: number;
}

function buildEdgePathContext(
  edge: VTAReactFlowEdge,
  originalIndex: number,
  rects: ReadonlyMap<string, NodeRect>,
  crossLaneEdges: readonly VTAReactFlowEdge[]
): EdgePathContext | null {
  const srcRect = rects.get(edge.source);
  const tgtRect = rects.get(edge.target);
  if (!srcRect || !tgtRect) return null;

  const sourcePosition = edge.sourceHandle?.split('-')[0] || 'top';
  const targetPosition = edge.targetHandle?.split('-')[0] || 'bottom';
  const sourceAnchor = getEdgeAnchor(srcRect, sourcePosition, true);
  const targetAnchor = getEdgeAnchor(tgtRect, targetPosition, false);
  const isCrossLane = Boolean(edge.data?.is_cross_lane);
  const direction = edge.data?.direction || (isCrossLane ? 'unidirectional' : 'sequential');

  const labelContent = resolveEdgeLabelContent({
    label: edge.data?.label ?? edge.label,
    category: edge.data?.category,
    direction,
    isCrossLane,
    status: edge.data?.status,
    receipt: edge.data?.receipt,
  });
  const orientation = resolveEdgeArrowOrientation({
    direction,
    isCrossLane,
    sourceX: sourceAnchor.x,
    sourceY: sourceAnchor.y,
    targetX: targetAnchor.x,
    targetY: targetAnchor.y,
    sourcePosition,
  });

  const isSideToSide = isSideToSideConnection(
    sourceAnchor.x,
    targetAnchor.x,
    sourcePosition,
    targetPosition
  );

  return {
    id: edge.id,
    originalIndex,
    source: edge.source,
    target: edge.target,
    sourcePosition,
    targetPosition,
    sourceX: sourceAnchor.x,
    sourceY: sourceAnchor.y,
    targetX: targetAnchor.x,
    targetY: targetAnchor.y,
    sourceNodeHeight: srcRect.height,
    sourceNodeTop: srcRect.y,
    sourceIsJunction: Boolean(srcRect.isHidden || srcRect.isObjectJunction),
    targetIsJunction: Boolean(tgtRect.isHidden || tgtRect.isObjectJunction),
    laneDistance: typeof edge.data?.laneDistance === 'number' ? edge.data.laneDistance : undefined,
    routeOffset: routingOffset(edge.id, [...crossLaneEdges]),
    obstacles: routingObstacles(rects as Map<string, NodeRect>, edge.source, edge.target),
    isCrossLane,
    isBreak: Boolean(edge.data?.is_break),
    direction,
    orientation,
    labelContent,
    isDirectCandidate:
      isSideToSide &&
      Math.abs(sourceAnchor.y - targetAnchor.y) < 2 &&
      edge.source !== edge.target,
  };
}

function badgesForPath(
  ctx: EdgePathContext,
  labelX: number,
  labelY: number,
  orientation: EdgeArrowOrientation = ctx.orientation
): RoutingRect[] {
  return computeEdgeBadgeRects({
    labelX,
    labelY,
    isBreak: ctx.isBreak,
    orientation,
    labelContent: ctx.labelContent,
  });
}

function buildPlacedEdge(ctx: EdgePathContext, tuple: EdgePathTuple): PlacedEdgeGeometry {
  const segments = segmentsFromPoints(pathPoints(tuple[0]));
  const hostSegment = findHostPathSegment(segments, tuple[1], tuple[2]);
  const orientation = resolveEdgeArrowOrientation({
    direction: ctx.direction,
    isCrossLane: ctx.isCrossLane,
    sourceX: ctx.sourceX,
    sourceY: ctx.sourceY,
    targetX: ctx.targetX,
    targetY: ctx.targetY,
    sourcePosition: ctx.sourcePosition,
    path: tuple[0],
    labelX: tuple[1],
    labelY: tuple[2],
  });
  return {
    ctx,
    tuple,
    segments,
    hostSegment,
    orientation,
    isVerticalLabel: Boolean(hostSegment?.vertical),
    badgeRects: badgesForPath(ctx, tuple[1], tuple[2], orientation),
  };
}

interface StepOffsetOverrides {
  corridorOffsetY?: number;
  outChannelOffset?: number;
  inChannelOffset?: number;
  corridorSide?: 'top' | 'bottom';
  avoidHorizontalBands?: readonly HorizontalBand[];
  avoidVerticalBands?: readonly VerticalBand[];
  detourSide?: 'left' | 'right';
  detourXMarginOffset?: number;
}

function contextStepParams(
  ctx: EdgePathContext,
  verticalGap: number,
  forceCorridorDetour: boolean,
  overrides?: StepOffsetOverrides
): OrthogonalStepPathParams {
  return {
    obstacles: ctx.obstacles,
    routeOffset: ctx.routeOffset,
    corridorOffsetY: overrides?.corridorOffsetY,
    outChannelOffset: overrides?.outChannelOffset,
    inChannelOffset: overrides?.inChannelOffset,
    corridorSide: overrides?.corridorSide,
    avoidHorizontalBands: overrides?.avoidHorizontalBands,
    avoidVerticalBands: overrides?.avoidVerticalBands,
    detourSide: overrides?.detourSide,
    detourXMarginOffset: overrides?.detourXMarginOffset,
    sourceX: ctx.sourceX,
    sourceY: ctx.sourceY,
    targetX: ctx.targetX,
    targetY: ctx.targetY,
    sourcePosition: ctx.sourcePosition,
    targetPosition: ctx.targetPosition,
    verticalGap,
    sourceNodeHeight: ctx.sourceNodeHeight,
    sourceNodeTop: ctx.sourceNodeTop,
    laneDistance: ctx.laneDistance,
    targetIsJunction: ctx.targetIsJunction,
    sourceIsJunction: ctx.sourceIsJunction,
    forceCorridorDetour,
  };
}

function isSharedPortSide(
  nodeId: string,
  side: string,
  otherCtx: EdgePathContext
): boolean {
  return (
    (otherCtx.source === nodeId && otherCtx.sourcePosition === side) ||
    (otherCtx.target === nodeId && otherCtx.targetPosition === side)
  );
}

/**
 * Exempts short departure/arrival horizontal stubs at a shared side handle when the edge
 * immediately bends onto a vertical trunk, avoiding false overlaps with multi-edge nodes.
 */
function isExemptSharedPortStub(
  placed: PlacedEdgeGeometry,
  seg: PathSegment,
  candCtx: EdgePathContext
): boolean {
  if (!seg.horizontal || placed.segments.length < 2) return false;
  const junctionMaxLen = Math.max(160, Math.round(LANE_WIDTH * 0.6));
  if (seg.index === 0) {
    const maxLen = placed.ctx.sourceIsJunction ? junctionMaxLen : 95;
    const nextSeg = placed.segments[1];
    return (
      seg.length <= maxLen &&
      isSharedPortSide(placed.ctx.source, placed.ctx.sourcePosition, candCtx) &&
      Math.abs(nextSeg.b[1] - nextSeg.a[1]) >= 2
    );
  }
  if (seg.index === placed.segments.length - 1) {
    const maxLen = placed.ctx.targetIsJunction ? junctionMaxLen : 95;
    const prevSeg = placed.segments[placed.segments.length - 2];
    return (
      seg.length <= maxLen &&
      isSharedPortSide(placed.ctx.target, placed.ctx.targetPosition, candCtx) &&
      Math.abs(prevSeg.b[1] - prevSeg.a[1]) >= 2
    );
  }
  return false;
}

/**
 * Exempts short departure/arrival vertical stubs at a shared top/bottom handle when
 * an intra-lane skip detour (>= 4 segments) immediately bends horizontally around an intermediate card.
 */
function isExemptSharedVerticalPortStub(
  placed: PlacedEdgeGeometry,
  seg: PathSegment,
  otherCtx: EdgePathContext
): boolean {
  if (!seg.vertical || placed.segments.length < 4) return false;
  const maxStubLen = Math.max(120, Math.round(VERTICAL_GAP * 1.5));
  if (seg.length > maxStubLen) return false;
  if (
    seg.index === 0 &&
    (placed.ctx.sourcePosition === 'top' || placed.ctx.sourcePosition === 'bottom')
  ) {
    const nextSeg = placed.segments[1];
    return (
      isSharedPortSide(placed.ctx.source, placed.ctx.sourcePosition, otherCtx) &&
      Math.abs(nextSeg.b[0] - nextSeg.a[0]) >= 2
    );
  }
  if (
    seg.index === placed.segments.length - 1 &&
    (placed.ctx.targetPosition === 'top' || placed.ctx.targetPosition === 'bottom')
  ) {
    const prevSeg = placed.segments[placed.segments.length - 2];
    return (
      isSharedPortSide(placed.ctx.target, placed.ctx.targetPosition, otherCtx) &&
      Math.abs(prevSeg.b[0] - prevSeg.a[0]) >= 2
    );
  }
  return false;
}

function isConnectedStubCornerAtY(
  placed: PlacedEdgeGeometry,
  vSeg: PathSegment,
  candCtx: EdgePathContext,
  y: number
): boolean {
  // Ignore T-corners where an exempted stub bends vertically without crossing through y.
  if (vSeg.minY < y - 2 && vSeg.maxY > y + 2) return false;
  const bendX = (vSeg.a[0] + vSeg.b[0]) / 2;
  const touchesStartStub =
    vSeg.index === 1 &&
    isExemptSharedPortStub(placed, placed.segments[0], candCtx) &&
    Math.abs(placed.segments[0].b[0] - bendX) <= 1 &&
    Math.abs(placed.segments[0].b[1] - y) <= 2;
  const lastIdx = placed.segments.length - 1;
  const touchesEndStub =
    vSeg.index === lastIdx - 1 &&
    lastIdx >= 1 &&
    isExemptSharedPortStub(placed, placed.segments[lastIdx], candCtx) &&
    Math.abs(placed.segments[lastIdx].a[0] - bendX) <= 1 &&
    Math.abs(placed.segments[lastIdx].a[1] - y) <= 2;
  return touchesStartStub || touchesEndStub;
}

function hasBadgeConflict(
  candBadges: readonly RoutingRect[],
  placedEdges: readonly PlacedEdgeGeometry[]
): boolean {
  const padded = candBadges.map((b) => padRect(b, EDGE_BADGE_EDGE_PAD));
  return placedEdges.some((placed) => {
    // Vertical-segment labels yield along their vertical stem in Pass 3 unless too cramped to move.
    if (placed.isVerticalLabel && (placed.hostSegment?.length ?? 0) >= 64) {
      return false;
    }
    return placed.badgeRects.some((pb) => padded.some((cb) => rectsOverlap(cb, pb)));
  });
}

function hasStraightHorizontalConflict(
  candCtx: EdgePathContext,
  candSeg: PathSegment,
  candBadges: readonly RoutingRect[],
  placedEdges: readonly PlacedEdgeGeometry[]
): boolean {
  if (hasBadgeConflict(candBadges, placedEdges)) return true;
  const candY = (candSeg.a[1] + candSeg.b[1]) / 2;

  for (const placed of placedEdges) {
    for (const seg of placed.segments) {
      if (!seg.horizontal || isExemptSharedPortStub(placed, seg, candCtx)) continue;
      const segY = (seg.a[1] + seg.b[1]) / 2;
      const xOverlap = Math.min(candSeg.maxX, seg.maxX) - Math.max(candSeg.minX, seg.minX);
      if (xOverlap > 1 && Math.abs(segY - candY) <= EDGE_HORIZONTAL_CLEARANCE_Y) {
        return true;
      }
    }
  }
  return false;
}

function hasDetourHorizontalConflict(
  candCtx: EdgePathContext,
  detourSegments: readonly PathSegment[],
  detourBadges: readonly RoutingRect[],
  placedEdges: readonly PlacedEdgeGeometry[]
): boolean {
  if (hasBadgeConflict(detourBadges, placedEdges)) return true;
  const candGeom: PlacedEdgeGeometry = {
    ctx: candCtx,
    tuple: ['', 0, 0],
    segments: [...detourSegments],
    orientation: candCtx.orientation,
    isVerticalLabel: false,
    badgeRects: [...detourBadges],
  };

  for (const placed of placedEdges) {
    for (const dSeg of detourSegments) {
      if (!dSeg.horizontal) continue;
      const dExempt = isExemptSharedPortStub(candGeom, dSeg, placed.ctx);
      const dY = (dSeg.a[1] + dSeg.b[1]) / 2;
      for (const pSeg of placed.segments) {
        if (!pSeg.horizontal) continue;
        if (dExempt && isExemptSharedPortStub(placed, pSeg, candCtx)) continue;
        const pY = (pSeg.a[1] + pSeg.b[1]) / 2;
        const xOverlap = Math.min(dSeg.maxX, pSeg.maxX) - Math.max(dSeg.minX, pSeg.minX);
        if (xOverlap > 1 && Math.abs(dY - pY) <= EDGE_HORIZONTAL_CLEARANCE_Y) return true;
      }
    }
  }
  return false;
}

function countVerticalStemConflicts(
  candGeom: PlacedEdgeGeometry,
  placedEdges: readonly PlacedEdgeGeometry[]
): number {
  let conflicts = 0;
  for (const cSeg of candGeom.segments) {
    if (!cSeg.vertical) continue;
    const cX = (cSeg.a[0] + cSeg.b[0]) / 2;
    for (const placed of placedEdges) {
      const cExempt = isExemptSharedVerticalPortStub(candGeom, cSeg, placed.ctx);
      for (const pSeg of placed.segments) {
        if (!pSeg.vertical) continue;
        if (cExempt || isExemptSharedVerticalPortStub(placed, pSeg, candGeom.ctx)) continue;
        const yOverlap = Math.min(cSeg.maxY, pSeg.maxY) - Math.max(cSeg.minY, pSeg.minY);
        if (yOverlap <= 1) continue;
        const pX = (pSeg.a[0] + pSeg.b[0]) / 2;
        if (Math.abs(cX - pX) < EDGE_VERTICAL_CLEARANCE_X) {
          conflicts++;
        }
      }
    }
  }
  return conflicts;
}

interface EdgeConflictMetrics {
  nodeHits: number;
  horizConflicts: number;
  vertConflicts: number;
  badgeConflicts: number;
  penalty: number;
}

function inspectEdgePlacementConflict(
  candGeom: PlacedEdgeGeometry,
  placedEdges: readonly PlacedEdgeGeometry[],
  offsets: StepOffsetOverrides
): EdgeConflictMetrics {
  let nodeHits = 0;
  for (const seg of candGeom.segments) {
    if (segmentBlocked(seg.a, seg.b, candGeom.ctx.obstacles)) {
      nodeHits++;
    }
  }
  const badgesToCheck =
    candGeom.isVerticalLabel &&
    candGeom.badgeRects.some((b) =>
      candGeom.ctx.obstacles.some((obs) => rectsOverlap(padRect(b, EDGE_BADGE_NODE_PAD), obs))
    )
      ? badgesForPath(
          candGeom.ctx,
          candGeom.tuple[1],
          resolveVerticalLabelY(candGeom, placedEdges, []),
          candGeom.orientation
        )
      : candGeom.badgeRects;
  for (const badge of badgesToCheck) {
    const padded = padRect(badge, EDGE_BADGE_NODE_PAD);
    if (candGeom.ctx.obstacles.some((obs) => rectsOverlap(padded, obs))) {
      nodeHits++;
    }
  }

  let horizConflicts = 0;
  for (const placed of placedEdges) {
    for (const cSeg of candGeom.segments) {
      if (!cSeg.horizontal) continue;
      const cExempt = isExemptSharedPortStub(candGeom, cSeg, placed.ctx);
      const cY = (cSeg.a[1] + cSeg.b[1]) / 2;
      for (const pSeg of placed.segments) {
        if (!pSeg.horizontal) continue;
        if (cExempt && isExemptSharedPortStub(placed, pSeg, candGeom.ctx)) continue;
        const pY = (pSeg.a[1] + pSeg.b[1]) / 2;
        const xOverlap = Math.min(cSeg.maxX, pSeg.maxX) - Math.max(cSeg.minX, pSeg.minX);
        if (xOverlap > 1 && Math.abs(cY - pY) <= EDGE_HORIZONTAL_CLEARANCE_Y) {
          horizConflicts++;
        }
      }
    }
  }

  const vertConflicts = countVerticalStemConflicts(candGeom, placedEdges);
  const badgeConflicts =
    !candGeom.isVerticalLabel && hasBadgeConflict(candGeom.badgeRects, placedEdges) ? 1 : 0;

  const xMarginOffset = offsets.detourXMarginOffset ?? 0;
  const offsetCost =
    Math.abs(offsets.corridorOffsetY ?? 0) * 1.5 +
    Math.abs(offsets.outChannelOffset ?? 0) +
    Math.abs(offsets.inChannelOffset ?? 0) +
    (xMarginOffset < 0 ? Math.abs(xMarginOffset) * 1.5 : xMarginOffset) +
    (offsets.detourSide === 'right' ? 0.5 : 0) +
    (offsets.corridorSide === 'bottom' ? 20 : 0);

  const penalty =
    nodeHits * 100_000 +
    horizConflicts * 10_000 +
    vertConflicts * 5_000 +
    badgeConflicts * 2_000 +
    offsetCost;

  return { nodeHits, horizConflicts, vertConflicts, badgeConflicts, penalty };
}

/**
 * Candidate detour tracks for non-adjacent intra-lane edges (Pass 0).
 * Keeps horizontal clearance inside the 60px swimlane side margin (xMargin in {30, 46, 15}px -> >= 14px from
 * both card border and swimlane divider) and prioritizes inward stub offsets (0 / -14px) that remain valid
 * even inside INTRA_RANK_GAP (30px).
 */
const INTRA_LANE_DETOUR_TRACKS: ReadonlyArray<StepOffsetOverrides> = [
  { detourSide: 'right', detourXMarginOffset: 0, corridorOffsetY: 0 },
  { detourSide: 'left', detourXMarginOffset: 16, corridorOffsetY: 0 },
  { detourSide: 'right', detourXMarginOffset: 16, corridorOffsetY: 0 },
  { detourSide: 'left', detourXMarginOffset: 16, corridorOffsetY: -14 },
  { detourSide: 'right', detourXMarginOffset: 16, corridorOffsetY: -14 },
  { detourSide: 'left', detourXMarginOffset: -15, corridorOffsetY: 0 },
  { detourSide: 'right', detourXMarginOffset: -15, corridorOffsetY: 0 },
  { detourSide: 'left', detourXMarginOffset: -15, corridorOffsetY: -14 },
  { detourSide: 'right', detourXMarginOffset: -15, corridorOffsetY: -14 },
  { detourSide: 'left', detourXMarginOffset: 16, corridorOffsetY: 14 },
  { detourSide: 'right', detourXMarginOffset: 16, corridorOffsetY: 14 },
  { detourSide: 'left', detourXMarginOffset: -15, corridorOffsetY: 14 },
  { detourSide: 'right', detourXMarginOffset: -15, corridorOffsetY: 14 },
];

function pickConflictAwareIntraLanePath(
  ctx: EdgePathContext,
  verticalGap: number,
  placedEdges: readonly PlacedEdgeGeometry[]
): { tuple: EdgePathTuple; placed: PlacedEdgeGeometry } {
  const isConflictFree = (m: EdgeConflictMetrics) =>
    m.nodeHits === 0 && m.horizConflicts === 0 && m.vertConflicts === 0 && m.badgeConflicts === 0;

  const evaluate = (overrides?: StepOffsetOverrides) => {
    const tuple = getOrthogonalStepPath(contextStepParams(ctx, verticalGap, false, overrides));
    const placed = buildPlacedEdge(ctx, tuple);
    const metrics = inspectEdgePlacementConflict(placed, placedEdges, overrides ?? {});
    return { tuple, placed, metrics };
  };

  let best = evaluate();
  // Adjacent straight trunks (1 segment) and non-colliding first detours keep their exact baseline geometry.
  if (best.placed.segments.length <= 1 || isConflictFree(best.metrics)) {
    return { tuple: best.tuple, placed: best.placed };
  }

  for (const track of INTRA_LANE_DETOUR_TRACKS) {
    const cand = evaluate(track);
    if (cand.metrics.penalty < best.metrics.penalty) {
      best = cand;
      if (isConflictFree(best.metrics)) {
        break;
      }
    }
  }

  return { tuple: best.tuple, placed: best.placed };
}

function pickConflictAwareCorridorPath(
  ctx: EdgePathContext,
  verticalGap: number,
  placedEdges: readonly PlacedEdgeGeometry[],
  forceCorridorDetour: boolean
): { tuple: EdgePathTuple; placed: PlacedEdgeGeometry; metrics: EdgeConflictMetrics } {
  const evaluate = (offsets: StepOffsetOverrides, overrideDetour = forceCorridorDetour) => {
    const tuple = getOrthogonalStepPath(
      contextStepParams(ctx, verticalGap, overrideDetour, offsets)
    );
    const placed = buildPlacedEdge(ctx, tuple);
    const metrics = inspectEdgePlacementConflict(placed, placedEdges, offsets);
    return { offsets, tuple, placed, metrics };
  };

  const isConflictFree = (m: EdgeConflictMetrics) =>
    m.nodeHits === 0 && m.horizConflicts === 0 && m.vertConflicts === 0 && m.badgeConflicts === 0;

  let best = evaluate({ corridorOffsetY: 0, outChannelOffset: 0, inChannelOffset: 0 });
  if (isConflictFree(best.metrics)) {
    return { tuple: best.tuple, placed: best.placed, metrics: best.metrics };
  }

  const avoidHorizontalBands: HorizontalBand[] = [];
  const avoidVerticalBands: VerticalBand[] = [];
  for (const placed of placedEdges) {
    for (const seg of placed.segments) {
      if (seg.horizontal && !isExemptSharedPortStub(placed, seg, ctx)) {
        const y = (seg.a[1] + seg.b[1]) / 2;
        avoidHorizontalBands.push({
          minX: seg.minX,
          maxX: seg.maxX,
          minY: y - EDGE_HORIZONTAL_CLEARANCE_Y,
          maxY: y + EDGE_HORIZONTAL_CLEARANCE_Y,
        });
      }
      if (seg.vertical && !isExemptSharedVerticalPortStub(placed, seg, ctx)) {
        const x = (seg.a[0] + seg.b[0]) / 2;
        avoidVerticalBands.push({
          minX: x - EDGE_VERTICAL_CLEARANCE_X,
          maxX: x + EDGE_VERTICAL_CLEARANCE_X,
          minY: seg.minY,
          maxY: seg.maxY,
        });
      }
    }
  }
  const evaluateWithBands = (offsets: StepOffsetOverrides, overrideDetour = forceCorridorDetour) =>
    evaluate({ ...offsets, avoidHorizontalBands, avoidVerticalBands }, overrideDetour);

  const spanX = Math.abs(ctx.targetX - ctx.sourceX);
  const isAdjacent =
    ctx.laneDistance !== undefined
      ? ctx.laneDistance <= 1
      : spanX <= (LANE_WIDTH - (ctx.targetIsJunction || ctx.sourceIsJunction ? 0 : NODE_WIDTH)) + 80;
  const sameHeight = Math.abs(ctx.sourceY - ctx.targetY) < 2;
  const isCase2b =
    isSideToSideConnection(ctx.sourceX, ctx.targetX, ctx.sourcePosition, ctx.targetPosition) &&
    isAdjacent &&
    !sameHeight &&
    !forceCorridorDetour;

  let useDetourFallback = forceCorridorDetour;
  if (isCase2b) {
    for (const outOffset of [-16, 16, -30, 30, -44, 44]) {
      const cand = evaluateWithBands({ corridorOffsetY: 0, outChannelOffset: outOffset, inChannelOffset: 0 });
      if (cand.metrics.penalty < best.metrics.penalty) {
        best = cand;
        if (isConflictFree(cand.metrics)) {
          return { tuple: best.tuple, placed: best.placed, metrics: best.metrics };
        }
      }
    }
    // If every Case 2b channel still collides (e.g. diagonal X crossings), evaluate Case 2c corridor detours.
    useDetourFallback = true;
    const neutralDetour = evaluateWithBands({ corridorOffsetY: 0, outChannelOffset: 0, inChannelOffset: 0 }, true);
    if (neutralDetour.metrics.penalty < best.metrics.penalty) {
      best = neutralDetour;
      if (isConflictFree(best.metrics)) {
        return { tuple: best.tuple, placed: best.placed, metrics: best.metrics };
      }
    }
  }

  const maxCorridorShift = Math.max(0, Math.floor(verticalGap / 2 - 11));
  const corridorOffsets = [0, -14, 14, -28, 28, -36, 36].filter(
    (off) => off === 0 || Math.abs(off) <= maxCorridorShift
  );
  const corridorSides: Array<'top' | 'bottom' | undefined> =
    useDetourFallback && sameHeight ? ['top', 'bottom'] : [undefined];

  // Phase A: resolve horizontal corridor, badge, and node clearance across corridor Y & side.
  for (const corridorSide of corridorSides) {
    for (const corridorOffsetY of corridorOffsets) {
      const cand = evaluateWithBands(
        {
          corridorOffsetY,
          outChannelOffset: 0,
          inChannelOffset: 0,
          corridorSide,
        },
        useDetourFallback
      );
      if (cand.metrics.penalty < best.metrics.penalty) {
        best = cand;
        if (isConflictFree(cand.metrics)) {
          return { tuple: best.tuple, placed: best.placed, metrics: best.metrics };
        }
      }
    }
  }

  // Phase B: separate vertical stems along inter-lane channels (source side then target side).
  const baseCorridorY = best.offsets.corridorOffsetY ?? 0;
  const baseSide = best.offsets.corridorSide;
  const outOffsets = [0, 14, -14, 28, -28, 42, -42, 56, -56, 70];
  for (const outChannelOffset of outOffsets) {
    if (outChannelOffset === (best.offsets.outChannelOffset ?? 0)) continue;
    const cand = evaluateWithBands(
      {
        corridorOffsetY: baseCorridorY,
        outChannelOffset,
        inChannelOffset: best.offsets.inChannelOffset ?? 0,
        corridorSide: baseSide,
      },
      useDetourFallback
    );
    if (cand.metrics.penalty < best.metrics.penalty) {
      best = cand;
      if (isConflictFree(cand.metrics)) {
        return { tuple: best.tuple, placed: best.placed, metrics: best.metrics };
      }
    }
  }

  const baseOut = best.offsets.outChannelOffset ?? 0;
  const inOffsets = ctx.targetIsJunction
    ? [0, -14, 14, -28, 28, -42, 42]
    : [0, 14, -14, 28, -28, 42, -42, 56, -56, 70];
  for (const inChannelOffset of inOffsets) {
    if (inChannelOffset === (best.offsets.inChannelOffset ?? 0)) continue;
    const cand = evaluateWithBands(
      {
        corridorOffsetY: baseCorridorY,
        outChannelOffset: baseOut,
        inChannelOffset,
        corridorSide: baseSide,
      },
      useDetourFallback
    );
    if (cand.metrics.penalty < best.metrics.penalty) {
      best = cand;
      if (isConflictFree(cand.metrics)) {
        return { tuple: best.tuple, placed: best.placed, metrics: best.metrics };
      }
    }
  }

  // Phase C: joint (corridorOffsetY, outChannelOffset) + target-stem refinement when single-axis passes still collide.
  if (!isConflictFree(best.metrics)) {
    const cOffsets = corridorOffsets.slice(0, 5);
    const oOffsets = outOffsets.slice(0, 5);
    outer: for (const corridorSide of corridorSides) {
      for (const outChannelOffset of oOffsets) {
        for (const corridorOffsetY of cOffsets) {
          const cand = evaluateWithBands(
            {
              corridorOffsetY,
              outChannelOffset,
              inChannelOffset: best.offsets.inChannelOffset ?? 0,
              corridorSide,
            },
            useDetourFallback
          );
          if (cand.metrics.penalty < best.metrics.penalty) {
            best = cand;
            if (isConflictFree(best.metrics)) break outer;
          }
        }
      }
    }
    if (!isConflictFree(best.metrics)) {
      const jointCorridorY = best.offsets.corridorOffsetY ?? 0;
      const jointOut = best.offsets.outChannelOffset ?? 0;
      const jointSide = best.offsets.corridorSide;
      for (const inChannelOffset of inOffsets) {
        if (inChannelOffset === (best.offsets.inChannelOffset ?? 0)) continue;
        const cand = evaluateWithBands(
          {
            corridorOffsetY: jointCorridorY,
            outChannelOffset: jointOut,
            inChannelOffset,
            corridorSide: jointSide,
          },
          useDetourFallback
        );
        if (cand.metrics.penalty < best.metrics.penalty) {
          best = cand;
          if (isConflictFree(best.metrics)) break;
        }
      }
    }
  }

  return { tuple: best.tuple, placed: best.placed, metrics: best.metrics };
}

function countVerticalCrossings(
  candCtx: EdgePathContext,
  segments: readonly PathSegment[],
  placedEdges: readonly PlacedEdgeGeometry[]
): number {
  let verticalCrossings = 0;

  for (const placed of placedEdges) {
    for (const vSeg of placed.segments) {
      if (!vSeg.vertical) continue;
      const vx = (vSeg.a[0] + vSeg.b[0]) / 2;

      for (const hSeg of segments) {
        if (!hSeg.horizontal) continue;
        const hy = (hSeg.a[1] + hSeg.b[1]) / 2;
        if (
          vx > hSeg.minX + 1 &&
          vx < hSeg.maxX - 1 &&
          vSeg.minY <= hy + 1 &&
          vSeg.maxY >= hy - 1 &&
          !isConnectedStubCornerAtY(placed, vSeg, candCtx, hy)
        ) {
          verticalCrossings++;
        }
      }
    }
  }
  return verticalCrossings;
}

function pickSameHeightPath(
  candCtx: EdgePathContext,
  verticalGap: number,
  placedEdges: readonly PlacedEdgeGeometry[]
): { tuple: EdgePathTuple; placed: PlacedEdgeGeometry } {
  const straightY =
    candCtx.sourceY === candCtx.targetY ? candCtx.sourceY : (candCtx.sourceY + candCtx.targetY) / 2;
  const straightX = (candCtx.sourceX + candCtx.targetX) / 2;
  const straightTuple: EdgePathTuple = [
    `M ${candCtx.sourceX} ${candCtx.sourceY} L ${candCtx.targetX} ${candCtx.targetY}`,
    straightX,
    straightY,
  ];
  const straightSegs = segmentsFromPoints(pathPoints(straightTuple[0]));
  const straightBadges = badgesForPath(candCtx, straightX, straightY);

  const wireBlocked = horizontalBandBlocked(
    candCtx.sourceX,
    candCtx.targetX,
    straightY,
    WIRE_NODE_CLEARANCE_Y,
    candCtx.obstacles
  );
  const badgeBlockedByNode = straightBadges.some((badge) => {
    const padded = padRect(badge, EDGE_BADGE_NODE_PAD);
    return candCtx.obstacles.some((obs) => rectsOverlap(padded, obs));
  });

  if (
    wireBlocked ||
    badgeBlockedByNode ||
    hasStraightHorizontalConflict(candCtx, straightSegs[0], straightBadges, placedEdges)
  ) {
    const resolved = pickConflictAwareCorridorPath(candCtx, verticalGap, placedEdges, true);
    return { tuple: resolved.tuple, placed: resolved.placed };
  }

  // Policy alpha for orthogonal (+) intersections with vertical segments:
  // detour only when the detour stays free of horizontal/vertical/badge conflicts and
  // strictly reduces wire-to-vertical-wire crossings (label-on-line overlaps are allowed).
  const straightCrossings = countVerticalCrossings(candCtx, straightSegs, placedEdges);
  if (straightCrossings > 0) {
    const detour = pickConflictAwareCorridorPath(candCtx, verticalGap, placedEdges, true);
    if (
      detour.metrics.vertConflicts === 0 &&
      !hasDetourHorizontalConflict(
        candCtx,
        detour.placed.segments,
        detour.placed.badgeRects,
        placedEdges
      )
    ) {
      const detourCrossings = countVerticalCrossings(
        candCtx,
        detour.placed.segments,
        placedEdges
      );
      if (detourCrossings < straightCrossings) {
        return { tuple: detour.tuple, placed: detour.placed };
      }
    }
  }

  return {
    tuple: straightTuple,
    placed: buildPlacedEdge(candCtx, straightTuple),
  };
}

const HORIZONTAL_LABEL_CORNER_MARGIN = 8;
const HORIZONTAL_LABEL_WIRE_CLEARANCE_X = 6;

function resolveHorizontalLabelX(
  item: PlacedEdgeGeometry,
  allEdges: readonly PlacedEdgeGeometry[],
  occupiedBadges: readonly RoutingRect[]
): number {
  const hSeg = item.hostSegment;
  const origX = item.tuple[1];
  const hY = item.tuple[2];
  if (!hSeg || !hSeg.horizontal || item.badgeRects.length === 0) return origX;

  const zeroBadges = badgesForPath(item.ctx, 0, hY, item.orientation);
  const leftSpan = -Math.min(...zeroBadges.map((b) => b.x));
  const rightSpan = Math.max(...zeroBadges.map((b) => b.x + b.width));
  const minAllowedX = hSeg.minX + leftSpan + HORIZONTAL_LABEL_CORNER_MARGIN;
  const maxAllowedX = hSeg.maxX - rightSpan - HORIZONTAL_LABEL_CORNER_MARGIN;
  if (minAllowedX >= maxAllowedX) return origX;

  const clampedOrigX = Math.max(minAllowedX, Math.min(maxAllowedX, origX));
  const origBadges = badgesForPath(item.ctx, clampedOrigX, hY, item.orientation);
  const origNodeHit = origBadges.some((badge) => {
    const padded = padRect(badge, EDGE_BADGE_NODE_PAD);
    return item.ctx.obstacles.some((obs) => rectsOverlap(padded, obs));
  });
  const origBadgeHit = origBadges.some((badge) => {
    const padded = padRect(badge, EDGE_BADGE_EDGE_PAD);
    return occupiedBadges.some((ob) => rectsOverlap(padded, ob));
  });

  // Preserve exact midpoint for unobstructed horizontal badges.
  if (!origNodeHit && !origBadgeHit && clampedOrigX === origX) {
    return origX;
  }

  const badgeMinY = Math.min(...origBadges.map((b) => b.y)) - 2;
  const badgeMaxY = Math.max(...origBadges.map((b) => b.y + b.height)) + 2;
  const relevantVertX: number[] = [];
  for (const other of allEdges) {
    if (other.ctx.id === item.ctx.id) continue;
    for (const vSeg of other.segments) {
      if (!vSeg.vertical) continue;
      if (vSeg.maxY >= badgeMinY && vSeg.minY <= badgeMaxY) {
        const vx = (vSeg.a[0] + vSeg.b[0]) / 2;
        if (vx >= hSeg.minX && vx <= hSeg.maxX) {
          relevantVertX.push(vx);
        }
      }
    }
  }

  const candidateSet = new Set<number>([clampedOrigX, minAllowedX, maxAllowedX]);
  for (const ob of occupiedBadges) {
    if (ob.y + ob.height < badgeMinY || ob.y > badgeMaxY) continue;
    candidateSet.add(ob.x - rightSpan - EDGE_BADGE_EDGE_PAD - 1);
    candidateSet.add(ob.x + ob.width + leftSpan + EDGE_BADGE_EDGE_PAD + 1);
  }
  for (const vx of relevantVertX) {
    candidateSet.add(vx - rightSpan - HORIZONTAL_LABEL_WIRE_CLEARANCE_X);
    candidateSet.add(vx + leftSpan + HORIZONTAL_LABEL_WIRE_CLEARANCE_X);
  }
  for (let x = minAllowedX; x <= maxAllowedX; x += 16) {
    candidateSet.add(x);
  }

  let bestX = clampedOrigX;
  let bestPenalty = Infinity;
  let bestDist = Infinity;

  for (const rawX of candidateSet) {
    const candX = Math.round(Math.max(minAllowedX, Math.min(maxAllowedX, rawX)) * 10) / 10;
    const candBadges = badgesForPath(item.ctx, candX, hY, item.orientation);

    let nodeHits = 0;
    for (const badge of candBadges) {
      const padded = padRect(badge, EDGE_BADGE_NODE_PAD);
      if (item.ctx.obstacles.some((obs) => rectsOverlap(padded, obs))) nodeHits++;
    }

    let badgeHits = 0;
    for (const badge of candBadges) {
      const padded = padRect(badge, EDGE_BADGE_EDGE_PAD);
      if (occupiedBadges.some((ob) => rectsOverlap(padded, ob))) badgeHits++;
    }

    let vertWireHits = 0;
    for (const vx of relevantVertX) {
      if (vx >= candX - leftSpan - 2 && vx <= candX + rightSpan + 2) {
        vertWireHits++;
      }
    }

    const penalty = nodeHits * 10_000 + badgeHits * 1_000 + vertWireHits * 20;
    const dist = Math.abs(candX - origX);
    if (
      penalty < bestPenalty ||
      (penalty === bestPenalty && dist < bestDist - 0.5) ||
      (penalty === bestPenalty && Math.abs(dist - bestDist) <= 0.5 && candX < bestX)
    ) {
      bestX = candX;
      bestPenalty = penalty;
      bestDist = dist;
    }
  }

  return bestX;
}

const VERTICAL_LABEL_WIRE_CLEARANCE_Y = 8;
const VERTICAL_LABEL_CORNER_MARGIN = 6;

function resolveVerticalLabelY(
  item: PlacedEdgeGeometry,
  allEdges: readonly PlacedEdgeGeometry[],
  occupiedBadges: readonly RoutingRect[]
): number {
  const vSeg = item.hostSegment;
  const origY = item.tuple[2];
  if (!vSeg || !vSeg.vertical || item.badgeRects.length === 0) return origY;

  const vx = (vSeg.a[0] + vSeg.b[0]) / 2;
  const zeroBadges = badgesForPath(item.ctx, vx, 0, item.orientation);
  const topSpan = -Math.min(...zeroBadges.map((b) => b.y));
  const bottomSpan = Math.max(...zeroBadges.map((b) => b.y + b.height));
  const badgeHalfW = Math.max(...zeroBadges.map((b) => b.width / 2));

  const minAllowedY = vSeg.minY + topSpan + VERTICAL_LABEL_CORNER_MARGIN;
  const maxAllowedY = vSeg.maxY - bottomSpan - VERTICAL_LABEL_CORNER_MARGIN;
  const clampedOrigY =
    minAllowedY < maxAllowedY
      ? Math.max(minAllowedY, Math.min(maxAllowedY, origY))
      : (vSeg.minY + vSeg.maxY) / 2;

  if (minAllowedY >= maxAllowedY) return clampedOrigY;

  const relevantHorizY: number[] = [];
  for (const other of allEdges) {
    if (other.ctx.id === item.ctx.id) continue;
    for (const hSeg of other.segments) {
      if (!hSeg.horizontal) continue;
      if (hSeg.maxX >= vx - badgeHalfW - 4 && hSeg.minX <= vx + badgeHalfW + 4) {
        relevantHorizY.push((hSeg.a[1] + hSeg.b[1]) / 2);
      }
    }
  }
  relevantHorizY.sort((a, b) => a - b);

  const candidateSet = new Set<number>([clampedOrigY, minAllowedY, maxAllowedY]);
  for (const hY of relevantHorizY) {
    candidateSet.add(hY - bottomSpan - VERTICAL_LABEL_WIRE_CLEARANCE_Y - 2);
    candidateSet.add(hY + topSpan + VERTICAL_LABEL_WIRE_CLEARANCE_Y + 2);
  }
  const anchors = [minAllowedY, ...relevantHorizY, maxAllowedY];
  for (let i = 0; i < anchors.length - 1; i++) {
    candidateSet.add((anchors[i] + anchors[i + 1]) / 2);
  }
  for (let y = minAllowedY; y <= maxAllowedY; y += 12) {
    candidateSet.add(y);
  }

  let bestY = clampedOrigY;
  let bestPenalty = Infinity;
  let bestMinWireClearance = -Infinity;
  let bestWireCenterDist = -Infinity;
  let bestDist = Infinity;

  for (const rawY of candidateSet) {
    const candY = Math.round(Math.max(minAllowedY, Math.min(maxAllowedY, rawY)) * 10) / 10;
    const candBadges = badgesForPath(item.ctx, vx, candY, item.orientation);

    let nodeHits = 0;
    for (const badge of candBadges) {
      const padded = padRect(badge, EDGE_BADGE_NODE_PAD);
      if (item.ctx.obstacles.some((obs) => rectsOverlap(padded, obs))) nodeHits++;
    }

    let badgeHits = 0;
    for (const badge of candBadges) {
      const padded = padRect(badge, EDGE_BADGE_EDGE_PAD);
      if (occupiedBadges.some((ob) => rectsOverlap(padded, ob))) badgeHits++;
    }

    let horizWireHits = 0;
    let minWireClearance = Infinity;
    let minCenterDist = Infinity;
    for (const hY of relevantHorizY) {
      const clearance =
        hY < candY - topSpan
          ? candY - topSpan - hY
          : hY > candY + bottomSpan
            ? hY - (candY + bottomSpan)
            : 0;
      if (clearance < minWireClearance) minWireClearance = clearance;
      const centerDist = Math.abs(candY - hY);
      if (centerDist < minCenterDist) minCenterDist = centerDist;
      if (clearance < VERTICAL_LABEL_WIRE_CLEARANCE_Y) horizWireHits++;
    }

    const penalty = nodeHits * 1000 + badgeHits * 100 + horizWireHits * 10;
    const dist = Math.abs(candY - origY);

    const isBetter =
      penalty < bestPenalty ||
      (penalty === bestPenalty &&
        (penalty > 0
          ? minWireClearance > bestMinWireClearance ||
            (minWireClearance === bestMinWireClearance &&
              (minCenterDist > bestWireCenterDist ||
                (minCenterDist === bestWireCenterDist && dist < bestDist)))
          : dist < bestDist - 0.5 || (Math.abs(dist - bestDist) <= 0.5 && candY < bestY)));

    if (isBetter) {
      bestY = candY;
      bestPenalty = penalty;
      bestMinWireClearance = minWireClearance;
      bestWireCenterDist = minCenterDist;
      bestDist = dist;
    }
  }

  return bestY;
}

/**
 * Deterministically resolves orthogonal paths and label positions across four passes:
 * Pass 0 fixes intra-lane vertical trunks, Pass 1 resolves non-same-height cross-lane paths
 * with conflict-aware channel/corridor tracks, Pass 2 resolves same-height cross-lane horizontal
 * candidates, Pass 3a staggers overlapping horizontal badges horizontally, and Pass 3b shifts
 * vertical-segment labels along their stem away from crossings and other badges.
 */
let lastResolvedPathsEntry: { key: string; paths: Map<string, EdgePathTuple> } | null = null;

function buildResolvePathsCacheKey(
  edges: readonly VTAReactFlowEdge[],
  rects: ReadonlyMap<string, NodeRect>,
  verticalGap: number
): string {
  const parts: string[] = [String(verticalGap)];
  for (const [id, r] of rects) {
    parts.push(
      `${id}:${Math.round(r.x * 2)},${Math.round(r.y * 2)},${Math.round(r.width * 2)},${Math.round(r.height * 2)},${r.isHidden ? 1 : 0},${r.isObjectJunction ? 1 : 0}`
    );
  }
  parts.push('|');
  for (const e of edges) {
    const d = e.data;
    const rawLabel = typeof (d?.label ?? e.label) === 'string' ? String(d?.label ?? e.label) : '';
    parts.push(
      `${e.id}:${e.source}>${e.target}:${e.sourceHandle ?? ''}:${e.targetHandle ?? ''}:${d?.is_cross_lane ? 1 : 0}:${d?.direction ?? ''}:${d?.laneDistance ?? ''}:${d?.is_break ? 1 : 0}:${d?.category ?? ''}:${d?.status ?? ''}:${d?.receipt ?? ''}:${rawLabel}`
    );
  }
  return parts.join(';');
}

export function resolveVTAEdgePaths(
  edges: readonly VTAReactFlowEdge[],
  rects: ReadonlyMap<string, NodeRect>,
  options?: ResolveEdgePathsOptions
): Map<string, EdgePathTuple> {
  const verticalGap = options?.verticalGap ?? VERTICAL_GAP;
  const cacheKey = buildResolvePathsCacheKey(edges, rects, verticalGap);
  if (lastResolvedPathsEntry && lastResolvedPathsEntry.key === cacheKey) {
    return new Map(lastResolvedPathsEntry.paths);
  }
  const crossLaneEdges = edges.filter((edge) => edge.data?.is_cross_lane);
  const contexts: EdgePathContext[] = [];

  edges.forEach((edge, idx) => {
    const ctx = buildEdgePathContext(edge, idx, rects, crossLaneEdges);
    if (ctx) contexts.push(ctx);
  });

  const result = new Map<string, EdgePathTuple>();
  const placedEdges: PlacedEdgeGeometry[] = [];
  const intraPass0Candidates: EdgePathContext[] = [];
  const crossPass1Candidates: EdgePathContext[] = [];
  const directCandidates: EdgePathContext[] = [];

  for (const ctx of contexts) {
    if (ctx.isDirectCandidate) {
      directCandidates.push(ctx);
      continue;
    }
    const isSide = isSideToSideConnection(
      ctx.sourceX,
      ctx.targetX,
      ctx.sourcePosition,
      ctx.targetPosition
    );
    if (!isSide) {
      intraPass0Candidates.push(ctx);
    } else {
      crossPass1Candidates.push(ctx);
    }
  }

  intraPass0Candidates.sort(
    (a, b) =>
      Math.abs(a.sourceY - a.targetY) - Math.abs(b.sourceY - b.targetY) ||
      Math.min(a.sourceY, a.targetY) - Math.min(b.sourceY, b.targetY) ||
      a.id.localeCompare(b.id) ||
      a.originalIndex - b.originalIndex
  );

  for (const ctx of intraPass0Candidates) {
    const resolved = pickConflictAwareIntraLanePath(ctx, verticalGap, placedEdges);
    result.set(ctx.id, resolved.tuple);
    placedEdges.push(resolved.placed);
  }

  crossPass1Candidates.sort(
    (a, b) =>
      Math.abs(a.targetX - a.sourceX) - Math.abs(b.targetX - b.sourceX) ||
      Math.min(a.sourceY, a.targetY) - Math.min(b.sourceY, b.targetY) ||
      a.id.localeCompare(b.id) ||
      a.originalIndex - b.originalIndex
  );

  for (const ctx of crossPass1Candidates) {
    const resolved = pickConflictAwareCorridorPath(ctx, verticalGap, placedEdges, false);
    result.set(ctx.id, resolved.tuple);
    placedEdges.push(resolved.placed);
  }

  directCandidates.sort(
    (a, b) =>
      Math.abs(a.targetX - a.sourceX) - Math.abs(b.targetX - b.sourceX) ||
      a.id.localeCompare(b.id) ||
      a.originalIndex - b.originalIndex
  );

  for (const cand of directCandidates) {
    const resolved = pickSameHeightPath(cand, verticalGap, placedEdges);
    result.set(cand.id, resolved.tuple);
    placedEdges.push(resolved.placed);
  }

  // Pass 3a: Stagger colliding horizontal-line badges along their host segment before vertical labels move.
  const horizItems = placedEdges
    .filter((item) => !item.isVerticalLabel && item.hostSegment?.horizontal && item.badgeRects.length > 0)
    .sort(
      (a, b) =>
        (a.hostSegment?.length ?? Infinity) - (b.hostSegment?.length ?? Infinity) ||
        a.tuple[2] - b.tuple[2] ||
        a.ctx.id.localeCompare(b.ctx.id)
    );
  const occupiedHorizBadges: RoutingRect[] = [];
  for (const item of horizItems) {
    const resolvedX = resolveHorizontalLabelX(item, placedEdges, occupiedHorizBadges);
    if (resolvedX !== item.tuple[1]) {
      const updatedTuple: EdgePathTuple = [item.tuple[0], resolvedX, item.tuple[2]];
      item.tuple = updatedTuple;
      item.badgeRects = badgesForPath(item.ctx, resolvedX, item.tuple[2], item.orientation);
      result.set(item.ctx.id, updatedTuple);
    }
    occupiedHorizBadges.push(...item.badgeRects);
  }

  // Pass 3b: Shift vertical-line labels along their vertical segment away from horizontal crossings.
  const occupiedBadges: RoutingRect[] = placedEdges
    .filter((item) => !item.isVerticalLabel)
    .flatMap((item) => item.badgeRects);

  const verticalItems = placedEdges
    .filter((item) => item.isVerticalLabel && item.badgeRects.length > 0)
    .sort(
      (a, b) =>
        (a.hostSegment?.length ?? Infinity) - (b.hostSegment?.length ?? Infinity) ||
        a.tuple[1] - b.tuple[1] ||
        a.ctx.id.localeCompare(b.ctx.id)
    );

  for (const item of verticalItems) {
    const resolvedY = resolveVerticalLabelY(item, placedEdges, occupiedBadges);
    if (resolvedY !== item.tuple[2]) {
      const updatedTuple: EdgePathTuple = [item.tuple[0], item.tuple[1], resolvedY];
      item.tuple = updatedTuple;
      item.badgeRects = badgesForPath(item.ctx, item.tuple[1], resolvedY, item.orientation);
      result.set(item.ctx.id, updatedTuple);
    }
    occupiedBadges.push(...item.badgeRects);
  }

  lastResolvedPathsEntry = { key: cacheKey, paths: result };
  return new Map(result);
}

export interface LayoutGeometryAudit {
  backwardIntraLaneEdges: Array<{ id: string; lane: string; source: string; target: string; sourceY: number; targetY: number }>;
  backwardCrossLaneEdges: Array<{
    id: string;
    relationId?: string;
    sourceLane: string;
    targetLane: string;
    source: string;
    target: string;
    sourceCenterY: number;
    targetCenterY: number;
    dropPx: number;
    sourceTitle?: string;
    targetTitle?: string;
    sourceTime?: string;
    targetTime?: string;
    sourceHeight?: number;
    targetHeight?: number;
    sourceMeasuredHeight?: number;
    targetMeasuredHeight?: number;
    sourceEstimatedHeight?: number;
    targetEstimatedHeight?: number;
    sourceIsDot?: boolean;
    targetIsDot?: boolean;
    sourceEventId?: string;
    targetEventId?: string;
  }>;
  detouredIntraLaneEdges: Array<{ id: string; lane: string; source: string; target: string; pointsCount: number; isSemantic: boolean }>;
  nonAdjacentIntraLaneEdges: Array<{ id: string; lane: string; source: string; target: string; visualSpan: number; isSemantic: boolean }>;
  overlappingIntraLanePairs: Array<{ lane: string; topNode: string; bottomNode: string; overlapPx: number }>;
  closeParallelHorizontalEdges: Array<{
    edgeA: string;
    edgeB: string;
    relationA?: string;
    relationB?: string;
    sourceA: string;
    targetA?: string;
    sourceB: string;
    targetB?: string;
    sourceLaneA?: string;
    targetLaneA?: string;
    sourceLaneB?: string;
    targetLaneB?: string;
    gapPx: number;
    coordA?: number;
    coordB?: number;
    overlapMin?: number;
    overlapMax?: number;
  }>;
  closeParallelVerticalEdges: Array<{
    edgeA: string;
    edgeB: string;
    relationA?: string;
    relationB?: string;
    sourceA: string;
    targetA?: string;
    sourceB: string;
    targetB?: string;
    sourceLaneA?: string;
    targetLaneA?: string;
    sourceLaneB?: string;
    targetLaneB?: string;
    sourceIsDotA?: boolean;
    targetIsDotA?: boolean;
    sourceIsDotB?: boolean;
    targetIsDotB?: boolean;
    gapPx: number;
    coordA?: number;
    coordB?: number;
    overlapMin?: number;
    overlapMax?: number;
  }>;
  overlappingEdgeBadges: Array<{ edgeA: string; edgeB: string; relationA?: string; relationB?: string; sourceA: string; sourceB: string; overlapAreaPx: number }>;
}

/**
 * Inspects rendered geometry and resolved orthogonal edge paths for intra-lane anomalies
 * such as upside-down backward wires, detoured vertical wires, skips, and overlapping nodes.
 */
export function auditVTALayoutGeometry(
  schema: VTASchema,
  layout: Pick<LayoutResult, 'nodes' | 'edges'> & Partial<LayoutResult>
): LayoutGeometryAudit {
  const defaultObjStyle = schema.presentation?.defaultObjectDisplayStyle;
  const rects = new Map<string, NodeRect>();
  const nodesByLane = new Map<string, Array<{ id: string; y: number; height: number }>>();

  for (const node of layout.nodes) {
    const rect = getDisplayRect(node, defaultObjStyle);
    rects.set(node.id, rect);
    const lane = node.data?.lane || '主要部門';
    const list = nodesByLane.get(lane) ?? [];
    list.push({ id: node.id, y: rect.y, height: rect.height });
    nodesByLane.set(lane, list);
  }

  const overlappingIntraLanePairs: LayoutGeometryAudit['overlappingIntraLanePairs'] = [];
  const bottomToTopIdxByLane = new Map<string, Map<string, number>>();
  for (const [lane, list] of nodesByLane) {
    const topToBottom = [...list].sort((a, b) => a.y - b.y);
    for (let i = 1; i < topToBottom.length; i++) {
      const topNode = topToBottom[i - 1];
      const bottomNode = topToBottom[i];
      const overlapPx = Math.round((topNode.y + topNode.height - bottomNode.y) * 10) / 10;
      if (overlapPx > 0.5) {
        overlappingIntraLanePairs.push({
          lane,
          topNode: topNode.id,
          bottomNode: bottomNode.id,
          overlapPx,
        });
      }
    }
    const bottomToTop = [...topToBottom].reverse();
    const idxMap = new Map<string, number>();
    bottomToTop.forEach((item, idx) => idxMap.set(item.id, idx));
    bottomToTopIdxByLane.set(lane, idxMap);
  }

  const paths = resolveVTAEdgePaths(layout.edges, rects);
  const nodeById = new Map(layout.nodes.map((n) => [n.id, n]));
  const backwardIntraLaneEdges: LayoutGeometryAudit['backwardIntraLaneEdges'] = [];
  const backwardCrossLaneEdges: LayoutGeometryAudit['backwardCrossLaneEdges'] = [];
  const detouredIntraLaneEdges: LayoutGeometryAudit['detouredIntraLaneEdges'] = [];
  const nonAdjacentIntraLaneEdges: LayoutGeometryAudit['nonAdjacentIntraLaneEdges'] = [];

  for (const edge of layout.edges) {
    const srcRect = rects.get(edge.source);
    const tgtRect = rects.get(edge.target);
    if (!srcRect || !tgtRect) continue;
    const lane = edge.data?.sourceLane || '主要部門';
    const dir = edge.data?.direction || 'sequential';
    const isSemantic = Boolean(edge.data?.relationId);

    if (edge.data?.is_cross_lane) {
      if (dir !== 'bidirectional' && dir !== 'undirected') {
        const srcCenterY = srcRect.y + srcRect.height / 2;
        const tgtCenterY = tgtRect.y + tgtRect.height / 2;
        const dropPx = tgtCenterY - srcCenterY;
        if (dropPx > 2) {
          const srcNode = nodeById.get(edge.source);
          const tgtNode = nodeById.get(edge.target);
          const srcData = srcNode?.data;
          const tgtData = tgtNode?.data;
          const srcIsDot = isDotProjectedNode(srcNode, defaultObjStyle);
          const tgtIsDot = isDotProjectedNode(tgtNode, defaultObjStyle);
          backwardCrossLaneEdges.push({
            id: edge.id,
            ...(typeof edge.data?.relationId === 'string' ? { relationId: edge.data.relationId } : {}),
            sourceLane: lane,
            targetLane: edge.data?.targetLane || '主要部門',
            source: edge.source,
            target: edge.target,
            sourceCenterY: Math.round(srcCenterY * 10) / 10,
            targetCenterY: Math.round(tgtCenterY * 10) / 10,
            dropPx: Math.round(dropPx * 10) / 10,
            ...(srcData?.title ? { sourceTitle: srcData.title } : {}),
            ...(tgtData?.title ? { targetTitle: tgtData.title } : {}),
            ...(srcData?.time ? { sourceTime: srcData.time } : {}),
            ...(tgtData?.time ? { targetTime: tgtData.time } : {}),
            sourceHeight: Math.round(srcRect.height * 10) / 10,
            targetHeight: Math.round(tgtRect.height * 10) / 10,
            ...(typeof srcData?.measuredHeight === 'number' ? { sourceMeasuredHeight: srcData.measuredHeight } : {}),
            ...(typeof tgtData?.measuredHeight === 'number' ? { targetMeasuredHeight: tgtData.measuredHeight } : {}),
            ...(typeof srcData?.estimatedHeight === 'number' ? { sourceEstimatedHeight: srcData.estimatedHeight } : {}),
            ...(typeof tgtData?.estimatedHeight === 'number' ? { targetEstimatedHeight: tgtData.estimatedHeight } : {}),
            sourceIsDot: srcIsDot,
            targetIsDot: tgtIsDot,
            ...(Array.isArray(srcData?.event_ids) && srcData.event_ids.length > 0 ? { sourceEventId: srcData.event_ids.join(',') } : {}),
            ...(Array.isArray(tgtData?.event_ids) && tgtData.event_ids.length > 0 ? { targetEventId: tgtData.event_ids.join(',') } : {}),
          });
        }
      }
      continue;
    }

    if (dir !== 'bidirectional' && dir !== 'undirected' && srcRect.y <= tgtRect.y) {
      backwardIntraLaneEdges.push({
        id: edge.id,
        lane,
        source: edge.source,
        target: edge.target,
        sourceY: Math.round(srcRect.y * 10) / 10,
        targetY: Math.round(tgtRect.y * 10) / 10,
      });
    }

    const tuple = paths.get(edge.id);
    if (tuple) {
      const pts = pathPoints(tuple[0]);
      if (pts.length > 2) {
        detouredIntraLaneEdges.push({
          id: edge.id,
          lane,
          source: edge.source,
          target: edge.target,
          pointsCount: pts.length,
          isSemantic,
        });
      }
    }

    const idxMap = bottomToTopIdxByLane.get(lane);
    const srcIdx = idxMap?.get(edge.source);
    const tgtIdx = idxMap?.get(edge.target);
    if (srcIdx !== undefined && tgtIdx !== undefined) {
      const span = Math.abs(tgtIdx - srcIdx);
      if (span > 1) {
        nonAdjacentIntraLaneEdges.push({
          id: edge.id,
          lane,
          source: edge.source,
          target: edge.target,
          visualSpan: span,
          isSemantic,
        });
      }
    }
  }

  const closeParallelHorizontalEdges: LayoutGeometryAudit['closeParallelHorizontalEdges'] = [];
  const closeParallelVerticalEdges: LayoutGeometryAudit['closeParallelVerticalEdges'] = [];
  const overlappingEdgeBadges: LayoutGeometryAudit['overlappingEdgeBadges'] = [];
  const crossLaneEdges = layout.edges.filter((edge) => edge.data?.is_cross_lane);
  const resolvedGeometries: Array<{ edge: VTAReactFlowEdge; geom: PlacedEdgeGeometry }> = [];
  layout.edges.forEach((edge, idx) => {
    const ctx = buildEdgePathContext(edge, idx, rects, crossLaneEdges);
    const tuple = paths.get(edge.id);
    if (ctx && tuple) {
      resolvedGeometries.push({ edge, geom: buildPlacedEdge(ctx, tuple) });
    }
  });

  for (let i = 0; i < resolvedGeometries.length; i++) {
    const { edge: edgeA, geom: geomA } = resolvedGeometries[i];
    for (let j = i + 1; j < resolvedGeometries.length; j++) {
      const { edge: edgeB, geom: geomB } = resolvedGeometries[j];
      const relA = typeof edgeA.data?.relationId === 'string' ? edgeA.data.relationId : undefined;
      const relB = typeof edgeB.data?.relationId === 'string' ? edgeB.data.relationId : undefined;

      let minHorizGap = Infinity;
      let horizBest: { yA: number; yB: number; minX: number; maxX: number } | undefined;
      for (const sA of geomA.segments) {
        if (!sA.horizontal || isExemptSharedPortStub(geomA, sA, geomB.ctx)) continue;
        const yA = (sA.a[1] + sA.b[1]) / 2;
        for (const sB of geomB.segments) {
          if (!sB.horizontal || isExemptSharedPortStub(geomB, sB, geomA.ctx)) continue;
          const overlapMinX = Math.max(sA.minX, sB.minX);
          const overlapMaxX = Math.min(sA.maxX, sB.maxX);
          const xOverlap = overlapMaxX - overlapMinX;
          if (xOverlap <= 1) continue;
          const yB = (sB.a[1] + sB.b[1]) / 2;
          const gap = Math.abs(yA - yB);
          if (gap < minHorizGap) {
            minHorizGap = gap;
            horizBest = { yA, yB, minX: overlapMinX, maxX: overlapMaxX };
          }
        }
      }
      if (minHorizGap < EDGE_HORIZONTAL_CLEARANCE_Y) {
        closeParallelHorizontalEdges.push({
          edgeA: edgeA.id,
          edgeB: edgeB.id,
          ...(relA ? { relationA: relA } : {}),
          ...(relB ? { relationB: relB } : {}),
          sourceA: edgeA.source,
          targetA: edgeA.target,
          sourceB: edgeB.source,
          targetB: edgeB.target,
          ...(edgeA.data?.sourceLane ? { sourceLaneA: edgeA.data.sourceLane } : {}),
          ...(edgeA.data?.targetLane ? { targetLaneA: edgeA.data.targetLane } : {}),
          ...(edgeB.data?.sourceLane ? { sourceLaneB: edgeB.data.sourceLane } : {}),
          ...(edgeB.data?.targetLane ? { targetLaneB: edgeB.data.targetLane } : {}),
          gapPx: Math.round(minHorizGap * 10) / 10,
          ...(horizBest
            ? {
                coordA: Math.round(horizBest.yA * 10) / 10,
                coordB: Math.round(horizBest.yB * 10) / 10,
                overlapMin: Math.round(horizBest.minX * 10) / 10,
                overlapMax: Math.round(horizBest.maxX * 10) / 10,
              }
            : {}),
        });
      }

      let minVertGap = Infinity;
      let vertBest: { xA: number; xB: number; minY: number; maxY: number } | undefined;
      for (const sA of geomA.segments) {
        if (!sA.vertical || isExemptSharedVerticalPortStub(geomA, sA, geomB.ctx)) continue;
        const xA = (sA.a[0] + sA.b[0]) / 2;
        for (const sB of geomB.segments) {
          if (!sB.vertical || isExemptSharedVerticalPortStub(geomB, sB, geomA.ctx)) continue;
          const overlapMinY = Math.max(sA.minY, sB.minY);
          const overlapMaxY = Math.min(sA.maxY, sB.maxY);
          const yOverlap = overlapMaxY - overlapMinY;
          if (yOverlap <= 1) continue;
          const xB = (sB.a[0] + sB.b[0]) / 2;
          const gap = Math.abs(xA - xB);
          if (gap < minVertGap) {
            minVertGap = gap;
            vertBest = { xA, xB, minY: overlapMinY, maxY: overlapMaxY };
          }
        }
      }
      if (minVertGap < EDGE_VERTICAL_CLEARANCE_X) {
        closeParallelVerticalEdges.push({
          edgeA: edgeA.id,
          edgeB: edgeB.id,
          ...(relA ? { relationA: relA } : {}),
          ...(relB ? { relationB: relB } : {}),
          sourceA: edgeA.source,
          targetA: edgeA.target,
          sourceB: edgeB.source,
          targetB: edgeB.target,
          ...(edgeA.data?.sourceLane ? { sourceLaneA: edgeA.data.sourceLane } : {}),
          ...(edgeA.data?.targetLane ? { targetLaneA: edgeA.data.targetLane } : {}),
          ...(edgeB.data?.sourceLane ? { sourceLaneB: edgeB.data.sourceLane } : {}),
          ...(edgeB.data?.targetLane ? { targetLaneB: edgeB.data.targetLane } : {}),
          sourceIsDotA: geomA.ctx.sourceIsJunction,
          targetIsDotA: geomA.ctx.targetIsJunction,
          sourceIsDotB: geomB.ctx.sourceIsJunction,
          targetIsDotB: geomB.ctx.targetIsJunction,
          gapPx: Math.round(minVertGap * 10) / 10,
          ...(vertBest
            ? {
                coordA: Math.round(vertBest.xA * 10) / 10,
                coordB: Math.round(vertBest.xB * 10) / 10,
                overlapMin: Math.round(vertBest.minY * 10) / 10,
                overlapMax: Math.round(vertBest.maxY * 10) / 10,
              }
            : {}),
        });
      }

      let maxOverlapArea = 0;
      for (const bA of geomA.badgeRects) {
        for (const bB of geomB.badgeRects) {
          const ix = Math.min(bA.x + bA.width, bB.x + bB.width) - Math.max(bA.x, bB.x);
          const iy = Math.min(bA.y + bA.height, bB.y + bB.height) - Math.max(bA.y, bB.y);
          if (ix > 0.5 && iy > 0.5) {
            maxOverlapArea = Math.max(maxOverlapArea, ix * iy);
          }
        }
      }
      if (maxOverlapArea > 0.5) {
        overlappingEdgeBadges.push({
          edgeA: edgeA.id,
          edgeB: edgeB.id,
          ...(relA ? { relationA: relA } : {}),
          ...(relB ? { relationB: relB } : {}),
          sourceA: edgeA.source,
          sourceB: edgeB.source,
          overlapAreaPx: Math.round(maxOverlapArea * 10) / 10,
        });
      }
    }
  }

  return {
    backwardIntraLaneEdges,
    backwardCrossLaneEdges,
    detouredIntraLaneEdges,
    nonAdjacentIntraLaneEdges,
    overlappingIntraLanePairs,
    closeParallelHorizontalEdges,
    closeParallelVerticalEdges,
    overlappingEdgeBadges,
  };
}
