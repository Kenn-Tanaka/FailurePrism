import type { VTASchema, VTANodeData, VTAEdgeData, VTANodeType } from '../../../types/vta';

export type AnimationMode = 'causal_flow' | 'pipeline_evolution';

export interface NodeAnimationTiming {
  nodeId: string;
  stepIndex: number;
  startTime: number;     // in seconds within cycle
  duration: number;      // in seconds
  endTime: number;       // startTime + duration
  type: VTANodeType;
  isVariation: boolean;
  isOutcome: boolean;
  isObjectJunction: boolean;
  lane: string;
  title: string;
}

export interface EdgeAnimationTiming {
  edgeId: string;
  sourceId: string;
  targetId: string;
  stepIndex: number;
  startTime: number;     // in seconds within cycle
  duration: number;      // in seconds
  endTime: number;
  pathLength: number;    // approximate SVG length
}

export interface AnimationStep {
  index: number;
  title: string;
  description: string;
  activeNodeIds: string[];
  activeEdgeIds: string[];
  highlightNodeIds: string[];
  timePosition: number;  // in seconds
}

export interface AnimationSequence {
  mode: AnimationMode;
  totalDuration: number; // active animation phase duration
  holdDuration: number;  // static display duration at completion before loop
  cycleDuration: number; // totalDuration + holdDuration
  stepCount: number;
  nodeTimings: Map<string, NodeAnimationTiming>;
  edgeTimings: Map<string, EdgeAnimationTiming>;
  steps: AnimationStep[];
}

/**
 * Computes the geometric length of an SVG orthogonal path (M x y L x y ...)
 */
export function computeSVGPathLength(pathD: string): number {
  if (!pathD) return 0;
  const points: { x: number; y: number }[] = [];
  const regex = /([ML])\s*(-?[\d.]+)\s*(-?[\d.]+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(pathD)) !== null) {
    points.push({ x: parseFloat(match[2]), y: parseFloat(match[3]) });
  }
  if (points.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return Math.max(Math.round(total), 20);
}

/**
 * Computes topological ranks and sorting for nodes based on DAG edges and time.
 */
export function computeNodeRanks(nodes: VTANodeData[], edges: VTAEdgeData[]): Map<string, number> {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  nodes.forEach((n) => {
    inDegree.set(n.id, 0);
    adj.set(n.id, []);
  });

  edges.forEach((e) => {
    const source = e.source ?? (e as any).from;
    const target = e.target ?? (e as any).to;
    if (source && target && nodeMap.has(source) && nodeMap.has(target) && source !== target) {
      inDegree.set(target, (inDegree.get(target) ?? 0) + 1);
      adj.get(source)?.push(target);
    }
  });

  const rankMap = new Map<string, number>();
  const queue: string[] = [];

  // Start with nodes having in-degree 0
  nodes.forEach((n) => {
    if ((inDegree.get(n.id) ?? 0) === 0) {
      rankMap.set(n.id, 0);
      queue.push(n.id);
    }
  });

  // Topological traversal
  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentRank = rankMap.get(current) ?? 0;
    const neighbors = adj.get(current) ?? [];

    for (const neighbor of neighbors) {
      const existingRank = rankMap.get(neighbor) ?? 0;
      const nextRank = Math.max(existingRank, currentRank + 1);
      rankMap.set(neighbor, nextRank);

      const deg = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, deg);
      if (deg === 0) {
        queue.push(neighbor);
      }
    }
  }

  // Handle any disconnected or cyclic leftover nodes
  nodes.forEach((n) => {
    if (!rankMap.has(n.id)) {
      rankMap.set(n.id, (n.sequence_order ?? 0) + 1);
    }
  });

  return rankMap;
}

/**
 * Builds the Causal Scenario Time-Lapse sequence (Mode 1).
 * Sequences nodes and edges from initial action to outcomes.
 */
export function buildCausalFlowSequence(
  schema: VTASchema,
  edgePathLengths?: Map<string, number>,
  options: { baseStepSeconds?: number; holdSeconds?: number } = {}
): AnimationSequence {
  const nodes = schema.nodes;
  const edges = schema.edges;
  const baseStepSeconds = options.baseStepSeconds ?? 0.8;
  const holdDuration = options.holdSeconds ?? 4.0;

  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const rankMap = computeNodeRanks(nodes, edges);

  // Group nodes by rank
  const nodesByRank = new Map<number, VTANodeData[]>();
  nodes.forEach((node) => {
    const rank = rankMap.get(node.id) ?? 0;
    const list = nodesByRank.get(rank) ?? [];
    list.push(node);
    nodesByRank.set(rank, list);
  });

  // Sort nodes within each rank by time or sequence_order
  const sortedRanks = [...nodesByRank.keys()].sort((a, b) => a - b);
  sortedRanks.forEach((rank) => {
    const list = nodesByRank.get(rank)!;
    list.sort((a, b) => {
      if (a.time && b.time && a.time !== b.time) return a.time.localeCompare(b.time);
      return (a.sequence_order ?? 0) - (b.sequence_order ?? 0);
    });
  });

  const nodeTimings = new Map<string, NodeAnimationTiming>();
  const edgeTimings = new Map<string, EdgeAnimationTiming>();
  const steps: AnimationStep[] = [];

  let currentTime = 0.5; // Initial 0.5s pause to display swimlanes first
  let stepIdx = 0;

  const activeNodesSet = new Set<string>();
  const activeEdgesSet = new Set<string>();

  // Initial step 0: Swimlanes setup
  steps.push({
    index: 0,
    title: 'スイムレーン展開',
    description: `対象主体: ${schema.lanes.join('、')}`,
    activeNodeIds: [],
    activeEdgeIds: [],
    highlightNodeIds: [],
    timePosition: 0,
  });

  sortedRanks.forEach((rank) => {
    const rankNodes = nodesByRank.get(rank)!;
    stepIdx++;

    const currentRankNodeIds: string[] = [];
    const highlightIds: string[] = [];

    rankNodes.forEach((node, nodeIdx) => {
      const nodeStart = currentTime + nodeIdx * 0.15;
      const nodeDuration = 0.45;
      const isVariation = node.type === 'variation' || Boolean((node as any).has_variation);
      const isOutcome = node.type === 'outcome' || Boolean((node as any).is_outcome);
      const isObjectJunction = node.entity_role === 'object' && node.object_display_style !== 'card';

      nodeTimings.set(node.id, {
        nodeId: node.id,
        stepIndex: stepIdx,
        startTime: nodeStart,
        duration: nodeDuration,
        endTime: nodeStart + nodeDuration,
        type: node.type,
        isVariation,
        isOutcome,
        isObjectJunction,
        lane: node.lane,
        title: node.title,
      });

      currentRankNodeIds.push(node.id);
      activeNodesSet.add(node.id);
      if (isVariation || isOutcome) highlightIds.push(node.id);
    });

    const rankEndTime = currentTime + rankNodes.length * 0.15 + 0.45;

    // Incoming / outgoing edges associated with this step
    const outgoingEdges = edges.filter(
      (e) => currentRankNodeIds.includes(e.source) && nodeMap.has(e.target)
    );

    outgoingEdges.forEach((edge, edgeIdx) => {
      const edgeStart = rankEndTime - 0.15 + edgeIdx * 0.1;
      const edgeDuration = 0.45;
      const pathLength = edgePathLengths?.get(edge.id ?? '') ?? 150;

      edgeTimings.set(edge.id ?? `e_${edge.source}_${edge.target}`, {
        edgeId: edge.id ?? `e_${edge.source}_${edge.target}`,
        sourceId: edge.source,
        targetId: edge.target,
        stepIndex: stepIdx,
        startTime: edgeStart,
        duration: edgeDuration,
        endTime: edgeStart + edgeDuration,
        pathLength,
      });

      activeEdgesSet.add(edge.id ?? `e_${edge.source}_${edge.target}`);
    });

    const firstNode = rankNodes[0];
    const rankTitle = firstNode.time
      ? `[${firstNode.time}] ${firstNode.title}`
      : firstNode.title;

    steps.push({
      index: stepIdx,
      title: rankTitle,
      description: rankNodes.map((n) => `[${n.lane}] ${n.title}`).join(' | '),
      activeNodeIds: [...activeNodesSet],
      activeEdgeIds: [...activeEdgesSet],
      highlightNodeIds: highlightIds,
      timePosition: currentTime,
    });

    currentTime = rankEndTime + (outgoingEdges.length > 0 ? 0.35 : 0.2);
  });

  const totalDuration = Math.round(currentTime * 10) / 10;
  const cycleDuration = Math.round((totalDuration + holdDuration) * 10) / 10;

  return {
    mode: 'causal_flow',
    totalDuration,
    holdDuration,
    cycleDuration,
    stepCount: steps.length,
    nodeTimings,
    edgeTimings,
    steps,
  };
}

/**
 * Builds the Pipeline Evolution sequence (Mode 2).
 * Shows the progression of AI stages: Normalization -> Refinement -> AutoConnect -> Classification.
 */
export function buildPipelineEvolutionSequence(
  schema: VTASchema,
  options: { stepSeconds?: number; holdSeconds?: number } = {}
): AnimationSequence {
  const stepSeconds = options.stepSeconds ?? 2.5;
  const holdDuration = options.holdSeconds ?? 4.0;
  const allNodeIds = schema.nodes.map((n) => n.id);
  const allEdgeIds = schema.edges.map((e) => e.id ?? `e_${e.source}_${e.target}`);

  const steps: AnimationStep[] = [
    {
      index: 0,
      title: 'Stage 1: 全文正規化 (初期抽出)',
      description: `資料からイベント ${schema.nodes.length}件、主体 ${schema.lanes.length}列 を一次抽出`,
      activeNodeIds: allNodeIds,
      activeEdgeIds: [],
      highlightNodeIds: [],
      timePosition: 0,
    },
    {
      index: 1,
      title: 'Stage 2: 粒度反復最適化 (refined-chain)',
      description: '主体重要度ランキングと認知負荷評価に基づくレーン統合・整列',
      activeNodeIds: allNodeIds,
      activeEdgeIds: [],
      highlightNodeIds: schema.nodes.filter((n) => n.entity_role === 'object').map((n) => n.id),
      timePosition: stepSeconds,
    },
    {
      index: 2,
      title: 'Stage 3: ノード自動接続 (autoConnect)',
      description: `レーン間伝達・前後連鎖エッジ ${schema.edges.length}本 の探索と補完`,
      activeNodeIds: allNodeIds,
      activeEdgeIds: allEdgeIds,
      highlightNodeIds: [],
      timePosition: stepSeconds * 2,
    },
    {
      index: 3,
      title: 'Stage 4: 変動要因判定・帰結確定',
      description: '通常作業（白）・変動要因（黄/橙）・帰結（赤）の判定と着色',
      activeNodeIds: allNodeIds,
      activeEdgeIds: allEdgeIds,
      highlightNodeIds: schema.nodes
        .filter((n) => n.type === 'variation' || Boolean((n as any).has_variation) || n.type === 'outcome' || Boolean((n as any).is_outcome))
        .map((n) => n.id),
      timePosition: stepSeconds * 3,
    },
  ];

  const totalDuration = stepSeconds * 4;
  const cycleDuration = totalDuration + holdDuration;

  const nodeTimings = new Map<string, NodeAnimationTiming>();
  schema.nodes.forEach((node) => {
    nodeTimings.set(node.id, {
      nodeId: node.id,
      stepIndex: 1,
      startTime: 0.2,
      duration: 0.5,
      endTime: 0.7,
      type: node.type,
      isVariation: node.type === 'variation' || Boolean((node as any).has_variation),
      isOutcome: node.type === 'outcome' || Boolean((node as any).is_outcome),
      isObjectJunction: node.entity_role === 'object' && node.object_display_style !== 'card',
      lane: node.lane,
      title: node.title,
    });
  });

  const edgeTimings = new Map<string, EdgeAnimationTiming>();
  schema.edges.forEach((edge) => {
    const id = edge.id ?? `e_${edge.source}_${edge.target}`;
    edgeTimings.set(id, {
      edgeId: id,
      sourceId: edge.source,
      targetId: edge.target,
      stepIndex: 2,
      startTime: stepSeconds * 2,
      duration: 0.6,
      endTime: stepSeconds * 2 + 0.6,
      pathLength: 150,
    });
  });

  return {
    mode: 'pipeline_evolution',
    totalDuration,
    holdDuration,
    cycleDuration,
    stepCount: steps.length,
    nodeTimings,
    edgeTimings,
    steps,
  };
}
