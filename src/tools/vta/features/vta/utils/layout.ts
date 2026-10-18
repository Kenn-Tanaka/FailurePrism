import { VTASchema, VTAReactFlowNode, VTAReactFlowEdge } from '../../../types/vta';
import { avoidCards, type RoutingRect } from './edgeRouting';

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
  width: number;
  height: number;
}

export const NODE_WIDTH = 260;
export const NODE_HEIGHT = 140;
export const LANE_WIDTH = 380;
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
  },
  existingNodes?: VTAReactFlowNode[]
): number {
  if (existingNodes) {
    const existing = existingNodes.find((en) => en.id === node.id);
    if (existing?.measured?.height && existing.measured.height > 60) {
      return existing.measured.height;
    }
  }
  return estimateNodeHeight(node);
}


/**
 * Parses time string and returns a numerical sort score or null if undetermined.
 */
function parseTimeScore(timeStr: string | undefined): number | null {
  if (!timeStr) return null;
  const s = timeStr.trim();
  if (!s) return null;

  // 1. Try standard ISO or full date (e.g. 2024-04-01 10:30, 2024/04/01 10:30)
  const fullDateMatch = s.match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (fullDateMatch) {
    const year = parseInt(fullDateMatch[1], 10);
    const month = parseInt(fullDateMatch[2], 10) - 1;
    const day = parseInt(fullDateMatch[3], 10);
    const hour = fullDateMatch[4] ? parseInt(fullDateMatch[4], 10) : 0;
    const min = fullDateMatch[5] ? parseInt(fullDateMatch[5], 10) : 0;
    const sec = fullDateMatch[6] ? parseInt(fullDateMatch[6], 10) : 0;
    const d = new Date(year, month, day, hour, min, sec);
    if (!isNaN(d.getTime())) return d.getTime();
  }

  // 2. Try clock time (HH:MM or HH:MM:SS)
  const timeMatch = s.match(/^(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?$/);
  if (timeMatch) {
    const h = parseInt(timeMatch[1], 10);
    const m = parseInt(timeMatch[2], 10);
    const sec = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;
    return h * 3600 + m * 60 + sec;
  }

  // 3. Relative offsets like "2ヶ月前", "30分後", "1時間前", "CDR後（2ヶ月）"
  const relMatch = s.match(/(\d+(?:\.\d+)?)\s*(年|ヶ月|か月|月|日|時間|分|秒)(前|後)/);
  if (relMatch) {
    const val = parseFloat(relMatch[1]);
    const unit = relMatch[2];
    const dir = relMatch[3] === '前' ? -1 : 1;
    let factor = 1;
    if (unit === '秒') factor = 1;
    else if (unit === '分') factor = 60;
    else if (unit === '時間') factor = 3600;
    else if (unit === '日') factor = 86400;
    else if (unit === 'ヶ月' || unit === 'か月' || unit === '月') factor = 86400 * 30;
    else if (unit === '年') factor = 86400 * 365;

    // Anchor around 0 (event day), so "X前" has negative seconds
    return dir * val * factor;
  }

  // 4. Common sequential temporal keywords (mapped to second-scale relative to event day)
  if (/発端|開始前|事前|初期/.test(s)) return -86400 * 7; // 1 week before
  if (/試験前|直前|前日/.test(s)) return -86400;        // 1 day before
  if (/当日\s*朝|午前/.test(s)) return 3600 * 9;         // 09:00
  if (/当日\s*昼|正午/.test(s)) return 3600 * 12;        // 12:00
  if (/当日\s*夕|午後|直後/.test(s)) return 3600 * 15;   // 15:00
  if (/試験中|通電時|作業中|実施中/.test(s)) return 3600 * 16;
  if (/発生時|不具合発生|事故発生|完了時/.test(s)) return 3600 * 18;

  return null;
}

/**
 * Computes time-aligned ranks across all lanes.
 * 
 * Rules:
 * 1. Nodes with explicit timestamps / sequence orders are ordered chronologically.
 * 2. Nodes with identical timestamps or undetermined relative timing share the same rank (horizontal alignment).
 * 3. Causal DAG constraints (edges u -> v) are strictly enforced: rank(v) >= rank(u) + 1.
 */
export function computeTimeRanks(schema: VTASchema): Map<string, number> {
  const nodes = schema.nodes;
  if (nodes.length === 0) return new Map();

  // 1. Group nodes into initial temporal buckets
  const parsedItems = nodes.map((node, index) => {
    const rawTime = (node.time || '').trim();
    const explicitSeq = typeof node.sequence_order === 'number' ? node.sequence_order : null;
    const score = parseTimeScore(rawTime);
    return {
      id: node.id,
      index,
      rawTime,
      explicitSeq,
      score,
    };
  });

  const timeGroupMap = new Map<string, string[]>();
  parsedItems.forEach((item) => {
    let key: string;
    if (item.explicitSeq !== null) {
      key = `seq_${item.explicitSeq}`;
    } else if (item.score !== null) {
      key = `score_${item.score}`;
    } else if (item.rawTime) {
      key = `raw_${item.rawTime}`;
    } else {
      key = `idx_${item.index}`;
    }

    const list = timeGroupMap.get(key) || [];
    list.push(item.id);
    timeGroupMap.set(key, list);
  });

  // Sort groups chronologically
  const groupKeys = Array.from(timeGroupMap.keys());
  groupKeys.sort((k1, k2) => {
    const item1 = parsedItems.find((p) => timeGroupMap.get(k1)?.includes(p.id))!;
    const item2 = parsedItems.find((p) => timeGroupMap.get(k2)?.includes(p.id))!;

    if (item1.explicitSeq !== null && item2.explicitSeq !== null) {
      return item1.explicitSeq - item2.explicitSeq;
    }
    if (item1.score !== null && item2.score !== null) {
      return item1.score - item2.score;
    }
    // Fallback to appearance index in schema.nodes
    return item1.index - item2.index;
  });

  const initialRankMap = new Map<string, number>();
  groupKeys.forEach((key, groupIdx) => {
    const nodeIds = timeGroupMap.get(key) || [];
    nodeIds.forEach((id) => {
      initialRankMap.set(id, groupIdx);
    });
  });

  // 2. Causal Edge Constraint Enforcement (Topological Relaxation)
  // For every causal edge (u -> v), target must occur strictly higher (rank(v) >= rank(u) + 1)
  const rankMap = new Map<string, number>(initialRankMap);
  const maxIterations = nodes.length * 2 + 10;
  let iterations = 0;
  let changed = true;

  while (changed && iterations < maxIterations) {
    changed = false;
    iterations++;

    for (const edge of schema.edges) {
      const srcRank = rankMap.get(edge.source);
      const tgtRank = rankMap.get(edge.target);
      if (srcRank !== undefined && tgtRank !== undefined) {
        if (tgtRank <= srcRank) {
          rankMap.set(edge.target, srcRank + 1);
          changed = true;
        }
      }
    }
  }

  // 3. Compact ranks to contiguous integers 0, 1, 2, ...
  const uniqueRanks = Array.from(new Set(rankMap.values())).sort((a, b) => a - b);
  const rankToCompactIndex = new Map<number, number>();
  uniqueRanks.forEach((r, idx) => rankToCompactIndex.set(r, idx));

  const finalRankMap = new Map<string, number>();
  nodes.forEach((node) => {
    const current = rankMap.get(node.id) ?? 0;
    finalRankMap.set(node.id, rankToCompactIndex.get(current) ?? 0);
  });

  return finalRankMap;
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
  rankMap?: Map<string, number>
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

  for (const lane of lanes) {
    const laneNodes = resultNodes.filter((n) => (n.data?.lane || lanes[0]) === lane);
    if (laneNodes.length <= 1) continue;

    // Sort vertically from top to bottom (ascending Y)
    laneNodes.sort((a, b) => a.position.y - b.position.y);

    for (let i = 0; i < laneNodes.length - 1; i++) {
      const topNode = laneNodes[i];
      const bottomNode = laneNodes[i + 1];

      const topRank = rankMap?.get(topNode.id);
      const bottomRank = rankMap?.get(bottomNode.id);
      const isSameRank =
        topRank !== undefined && bottomRank !== undefined && topRank === bottomRank;

      const requiredGap = isSameRank ? INTRA_RANK_GAP : VERTICAL_GAP;
      const topHeight: number =
        topNode.measured?.height ||
        (typeof topNode.data?.measuredHeight === 'number' ? topNode.data.measuredHeight : 0) ||
        estimateNodeHeight(topNode.data || {}) ||
        NODE_HEIGHT;

      const minAllowedBottomY = topNode.position.y + topHeight + requiredGap;

      if (bottomNode.position.y < minAllowedBottomY) {
        const delta = minAllowedBottomY - bottomNode.position.y;
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
  /** If true, ignores manual node.position and recomputes all positions via BT layout algorithm */
  forceRecompute?: boolean;
}

export function calculateVTALayout(
  schema: VTASchema,
  existingNodes?: VTAReactFlowNode[],
  _existingEdges?: VTAReactFlowEdge[],
  options?: LayoutOptions
): LayoutResult {
  const heightOf = (node: VTASchema['nodes'][number]) => options?.compact
    ? compactNodeHeight(node.title)
    : getNodeHeight(node, existingNodes);
  const lanes = schema.lanes.length > 0
    ? schema.lanes
    : Array.from(new Set(schema.nodes.map((n) => n.lane || '主要部門')));

  // Map each lane to an index
  const laneIndexMap = new Map<string, number>();
  lanes.forEach((lane, idx) => laneIndexMap.set(lane, idx));

  // Compute time ranks for each node (0 = earliest/bottom, maxRank = final event/top)
  const rankMap = computeTimeRanks(schema);
  const maxRank = Math.max(...Array.from(rankMap.values()), 0);

  // Group nodes by (lane, rank) to prevent overlapping in the same lane at the same time
  const laneRankMap = new Map<string, VTASchema['nodes']>();
  schema.nodes.forEach((node) => {
    const lane = node.lane || lanes[0] || '主要部門';
    const rank = rankMap.get(node.id) ?? 0;
    const key = `${lane}__${rank}`;
    const list = laneRankMap.get(key) || [];
    list.push(node);
    laneRankMap.set(key, list);
  });

  // Calculate required dynamic slice height per time rank (Variable Height Architecture)
  // The required slice height of rank r is the maximum required lane height across all lanes.
  // Each lane's height is the sum of its nodes' effective heights + intra-rank gaps.
  const rankHeightMap = new Map<number, number>();
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
    const effectiveHeight = maxLaneHeight > 0 ? maxLaneHeight : NODE_HEIGHT;
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
  const rawNodes: VTAReactFlowNode[] = schema.nodes.map((node) => {
    const lane = node.lane || lanes[0] || '主要部門';
    const laneIdx = laneIndexMap.get(lane) ?? 0;
    const rank = rankMap.get(node.id) ?? 0;

    // Check intra-lane same-rank index (if multiple nodes in same lane at same rank)
    const key = `${lane}__${rank}`;
    const siblings = laneRankMap.get(key) || [node];
    const siblingIdx = siblings.findIndex((n) => n.id === node.id);
    let intraOffset = 0;
    for (let i = 0; i < siblingIdx; i++) {
      intraOffset += heightOf(siblings[i]) + INTRA_RANK_GAP;
    }

    // Center X within the corresponding lane
    const laneCenterX = laneIdx * LANE_WIDTH + LANE_WIDTH / 2 + LANE_PADDING;
    const computedX = laneCenterX - NODE_WIDTH / 2;

    // Bottom-to-Top: dynamically cumulative base Y ensures no overlap with lower ranks
    const computedY = (rankBaseY.get(rank) ?? LANE_PADDING) + intraOffset;

    let finalX = computedX;
    let finalY = computedY;

    if (!options?.forceRecompute) {
      if (node.position && typeof node.position.x === 'number' && typeof node.position.y === 'number') {
        finalX = node.position.x;
        finalY = node.position.y;
      } else if (existingNodes) {
        const existing = existingNodes.find((en) => en.id === node.id);
        if (existing && typeof existing.position?.x === 'number' && typeof existing.position?.y === 'number') {
          finalX = existing.position.x;
          finalY = existing.position.y;
        }
      }
    }

    const nodeH = heightOf(node);

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
        title: node.title,
        description: node.description,
        measure_type: node.measure_type,
        sequence_order: node.sequence_order,
        supplementary_note: node.supplementary_note,
        position: { x: finalX, y: finalY },
        measuredHeight: nodeH,
      },
    };
  });

  // Post-process: Enforce minimum vertical spacing within each lane (Collision Push)
  // Guarantees that no cards overlap vertically and intra-lane edge lines are always visible
  const nodes = enforceLaneVerticalSpacing(rawNodes, lanes, rankMap);

  // Recalculate global vertical bounds after spacing adjustment
  for (const n of nodes) {
    const nH: number =
      n.measured?.height ||
      (typeof n.data?.measuredHeight === 'number' ? n.data.measuredHeight : 0) ||
      NODE_HEIGHT;
    if (n.position.y < globalMinY) globalMinY = n.position.y;
    if (n.position.y + nH > globalMaxY) globalMaxY = n.position.y + nH;
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
    const edgeId = `e-${edge.source}-${edge.target}-${idx}`;
    const srcNode = schema.nodes.find((n) => n.id === edge.source);
    const tgtNode = schema.nodes.find((n) => n.id === edge.target);

    const srcLane = srcNode?.lane || lanes[0] || '主要部門';
    const tgtLane = tgtNode?.lane || lanes[0] || '主要部門';
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
        sourceHandle = 'right-source';
        targetHandle = 'left-target';
      } else {
        // Source is in a right lane, Target is in a left lane -> Left to Right
        sourceHandle = 'left-source';
        targetHandle = 'right-target';
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
        is_break: Boolean(edge.is_break),
        direction,
        is_cross_lane: isCrossLane,
        sourceLane: srcLane,
        targetLane: tgtLane,
        label: edge.label,
        category: edge.category,
      },
    };
  });

  const totalWidth = totalLanes * LANE_WIDTH + LANE_PADDING * 2;
  const totalHeight = globalMaxY - globalMinY + 120;

  return {
    nodes,
    edges,
    laneBounds,
    width: totalWidth,
    height: totalHeight,
  };
}

export interface OrthogonalStepPathParams {
  obstacles?: RoutingRect[];
  routeOffset?: number;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition?: string;
  targetPosition?: string;
  verticalGap?: number;
  sourceNodeHeight?: number;
}

/**
 * Computes orthogonal step wiring path for VTA diagrams.
 * 
 * Rules:
 * 1. Intra-lane connections (same lane): Straight vertical line from lower node top to upper node bottom.
 * 2. Cross-lane information connections: From side handle (Left/Right) to destination side handle (Left/Right).
 *    - Same-rank: Direct horizontal line.
 *    - Different ranks: Orthogonal step routing through inter-lane space / corridor.
 * 3. Line crossings occur exclusively on the vertical lane center lines in open space between nodes,
 *    ensuring no connection line passes underneath or across node cards.
 * 4. Used identically across React Flow Canvas (VTAEdge.tsx) and SVG Export (svgExport.ts).
 */
export function getOrthogonalStepPath(params: OrthogonalStepPathParams): [string, number, number] {
  const candidate = corridorPath(params);
  return params.obstacles?.length
    ? avoidCards(candidate, params.obstacles, params.sourcePosition, params.targetPosition, params.routeOffset)
    : candidate;
}

function corridorPath({
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  verticalGap = VERTICAL_GAP,
  sourceNodeHeight = NODE_HEIGHT,
  routeOffset = 0,
}: OrthogonalStepPathParams): [string, number, number] {
  // Case 1: Intra-lane / pure vertical (connecting top to bottom handles along same lane axis)
  if (Math.abs(sourceX - targetX) < 2 && sourcePosition !== 'left' && sourcePosition !== 'right') {
    const path = `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`;
    const labelX = sourceX;
    const labelY = (sourceY + targetY) / 2;
    return [path, labelX, labelY];
  }

  // Determine if this is a side-to-side connection (cross-lane information transmission)
  const isSideToSide =
    sourcePosition === 'left' ||
    sourcePosition === 'right' ||
    targetPosition === 'left' ||
    targetPosition === 'right' ||
    (!sourcePosition && !targetPosition && Math.abs(sourceX - targetX) >= 40);

  if (isSideToSide) {
    const spanX = Math.abs(sourceX - targetX);
    const signX = sourceX < targetX ? 1 : -1;
    // Inter-lane gap between adjacent nodes is (LANE_WIDTH - NODE_WIDTH) = 120px.
    // When connecting adjacent lanes, distance between source side and target side is ~120px.
    const isAdjacentLanes = spanX <= (LANE_WIDTH - NODE_WIDTH) + 60; // <= 180px

    // Case 2a: Same rank horizontal connection between adjacent lanes
    if (Math.abs(sourceY - targetY) < 2 && isAdjacentLanes) {
      const path = `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`;
      const labelX = (sourceX + targetX) / 2;
      const labelY = sourceY;
      return [path, labelX, labelY];
    }

    // Case 2b: Adjacent lanes with different height
    if (isAdjacentLanes) {
      // The midpoint is strictly inside the 120px open inter-lane channel between the 2 adjacent lanes
      const midX = (sourceX + targetX) / 2 + routeOffset;
      const path = `M ${sourceX} ${sourceY} L ${midX} ${sourceY} L ${midX} ${targetY} L ${targetX} ${targetY}`;
      const labelX = midX;
      const labelY = (sourceY + targetY) / 2;
      return [path, labelX, labelY];
    }

    // Case 2c: Multi-lane spanning (2 or more lanes apart)
    // NEVER route through (sourceX + targetX) / 2 because that falls in the center of intermediate lane cards!
    // Instead, route via the horizontal corridor in the vertical gap between node ranks.
    const outOffset = (30 + routeOffset) * signX;
    const x1 = sourceX + outOffset; // Inter-lane channel next to source node
    const x2 = targetX - outOffset; // Inter-lane channel next to target node

    let corridorY: number;
    if (sourceY >= targetY) {
      // Bottom-to-Top (or same height multi-lane): route in corridor above source node top
      // Handle is at ~38% or 62% of card height. Top edge is roughly (sourceY - sourceNodeHeight * 0.65).
      const sourceTop = sourceY - sourceNodeHeight * 0.62;
      corridorY = sourceTop - verticalGap / 2 + routeOffset;
    } else {
      // Top-to-Bottom: route in corridor below source node bottom
      const sourceBottom = sourceY + sourceNodeHeight * 0.38;
      corridorY = sourceBottom + verticalGap / 2 + routeOffset;
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
