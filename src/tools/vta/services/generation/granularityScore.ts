import type { VTASchema } from '../../types/vta';
import { visibleSchema } from '../../features/vta/utils/presentation';
import { graphDiagnostics } from '../../features/vta/utils/graphDiagnostics';
import { isPrecedence } from '../../features/vta/utils/eventOrder';

export interface GranularityMetrics {
  c1: number;
  c2?: number;
  c3: number;
  c4?: number;
  c5: number;
  gateViolations: string[];
  details: {
    laneCount: number;
    nodeCount: number;
    maxDegree: number;
    crossingCount: number;
    longestPath: number;
    variationReachability: number;
    componentRatio: number;
  };
}

export interface GranularityWeights {
  w1: number;
  w2: number;
  w3: number;
  w4: number;
  w5: number;
}

export const DEFAULT_GRANULARITY_WEIGHTS: GranularityWeights = {
  w1: 0.25,
  w2: 0.20,
  w3: 0.25,
  w4: 0.15,
  w5: 0.15,
};

function clamp01(val: number): number {
  if (!Number.isFinite(val)) return 0;
  return Math.max(0, Math.min(1, val));
}

function round4(val: number): number {
  return Math.round(val * 10000) / 10000;
}

/**
 * Computes machine metrics C1, C3, C5 and checks hard gates G1-G4 on a VTASchema.
 * Uses provisional classifications (`event.preliminary`) when events are unclassified.
 */
export function computeMachineMetrics(schema: VTASchema, maxSubjects: number): GranularityMetrics {
  const analysis = schema.analysis;
  const visible = visibleSchema(schema);
  const gateViolations: string[] = [];

  if (!analysis) {
    return {
      c1: 0,
      c3: 0,
      c5: 0,
      gateViolations: ['analysis missing'],
      details: {
        laneCount: visible.lanes.length,
        nodeCount: visible.nodes.length,
        maxDegree: 0,
        crossingCount: 0,
        longestPath: 0,
        variationReachability: 0,
        componentRatio: 0,
      },
    };
  }

  // Gate checks G1-G4
  // G1: Every event has valid sourceRefs (unless manual)
  for (const ev of analysis.events) {
    if (ev.origin !== 'manual' && (!ev.sourceRefs || ev.sourceRefs.length === 0)) {
      gateViolations.push(`G1: イベント ${ev.id} に原文参照がありません`);
    }
  }

  // G2: Precedence / dependency DAG check (no cycle)
  const precEdges = analysis.relations.filter(isPrecedence);
  const hasCycle = (): boolean => {
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const dfs = (u: string): boolean => {
      if (visiting.has(u)) return true;
      if (visited.has(u)) return false;
      visiting.add(u);
      for (const rel of precEdges) {
        if (rel.sourceEventId === u && dfs(rel.targetEventId)) return true;
      }
      visiting.delete(u);
      visited.add(u);
      return false;
    };
    for (const ev of analysis.events) {
      if (dfs(ev.id)) return true;
    }
    return false;
  };
  if (hasCycle()) {
    gateViolations.push('G2: 前後関係・作業依存に循環（サイクル）があります');
  }

  // G4: Outcome visibility check
  const diag = graphDiagnostics(schema);
  if (analysis.outcome?.status === 'identified' && diag.unshownOutcomes.length > 0) {
    gateViolations.push(`G4: 帰結イベントが表示されていません (${diag.unshownOutcomes.join(', ')})`);
  }

  // C1: Subject count & card balance
  const L = visible.lanes.length;
  const targetMin = 2;
  const targetMax = Math.max(targetMin, maxSubjects);
  let laneCountScore = 1.0;
  if (L < targetMin) {
    laneCountScore = L / targetMin;
  } else if (L > targetMax) {
    laneCountScore = Math.max(0, 1 - (L - targetMax) / Math.max(1, targetMax));
  }

  // Avoid extreme concentration where one lane holds almost all cards while others have 1
  const laneNodeCounts = visible.lanes.map((lane) => visible.nodes.filter((n) => n.lane === lane).length);
  const totalNodes = visible.nodes.length;
  const maxLaneNodes = laneNodeCounts.length ? Math.max(...laneNodeCounts) : 0;
  const balanceScore =
    L <= 1 || totalNodes <= 2
      ? 1.0
      : clamp01(1 - Math.max(0, maxLaneNodes / totalNodes - 0.75) * 2);
  const c1 = round4(clamp01(0.7 * laneCountScore + 0.3 * balanceScore));

  // C3: Chain connectivity & provisional variation -> outcome reachability
  const compCount = diag.display.length;
  const componentRatio = totalNodes === 0 ? 0 : compCount <= 1 ? 1.0 : clamp01(1 / compCount);

  // Directed reachability on visible graph toward outcome cards
  const outcomeEventIds = new Set(
    analysis.outcome?.status === 'identified' && analysis.outcome.eventIds.length
      ? analysis.outcome.eventIds
      : analysis.events.length
        ? [analysis.events[analysis.events.length - 1].id]
        : []
  );
  const outcomeNodeIds = new Set(
    visible.nodes
      .filter((n) => (n.event_ids ?? []).some((id) => outcomeEventIds.has(id)))
      .map((n) => n.id)
  );

  const reverseAdj = new Map<string, Set<string>>();
  for (const edge of visible.edges) {
    const addRev = (from: string, to: string) => {
      const set = reverseAdj.get(from) ?? new Set<string>();
      set.add(to);
      reverseAdj.set(from, set);
    };
    addRev(edge.target, edge.source);
    if (edge.direction === 'bidirectional' || edge.direction === 'undirected') {
      addRev(edge.source, edge.target);
    }
  }

  const reachesOutcome = new Set<string>();
  const queue = [...outcomeNodeIds];
  for (const id of queue) reachesOutcome.add(id);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const prev of reverseAdj.get(cur) ?? []) {
      if (!reachesOutcome.has(prev)) {
        reachesOutcome.add(prev);
        queue.push(prev);
      }
    }
  }

  const eventById = new Map(analysis.events.map((e) => [e.id, e]));
  const isVariationNode = (node: (typeof visible.nodes)[number]): boolean => {
    if (node.type === 'variation') return true;
    return (node.event_ids ?? []).some((id) => {
      const ev = eventById.get(id);
      return ev?.classification === 'variation' || (ev?.classification === 'unclassified' && ev?.preliminary?.value === 'variation');
    });
  };

  const variationNodes = visible.nodes.filter(isVariationNode);
  const variationReachability =
    variationNodes.length === 0
      ? componentRatio
      : variationNodes.filter((n) => reachesOutcome.has(n.id)).length / variationNodes.length;

  const unassignedPenalty =
    analysis.events.length > 0
      ? analysis.unassignedEventIds.length / analysis.events.length
      : 0;
  const c3 = round4(clamp01((0.5 * componentRatio + 0.5 * variationReachability) * (1 - 0.5 * unassignedPenalty)));

  // C5: Cognitive load / complexity
  const lanePenalty = Math.max(0, L - maxSubjects) / Math.max(1, maxSubjects);
  const cardPenalty = Math.max(0, totalNodes - 24) / 24;

  const degrees = new Map<string, number>();
  for (const n of visible.nodes) degrees.set(n.id, 0);
  for (const e of visible.edges) {
    if (e.source !== e.target) {
      degrees.set(e.source, (degrees.get(e.source) ?? 0) + 1);
      degrees.set(e.target, (degrees.get(e.target) ?? 0) + 1);
    }
  }
  const maxDegree = degrees.size ? Math.max(...degrees.values()) : 0;
  const hubPenalty = Math.max(0, maxDegree - 4) / 4;

  // Approximate inter-lane edge crossings based on lane index & sequence_order
  const nodeMeta = new Map(
    visible.nodes.map((n, idx) => [
      n.id,
      { laneIdx: visible.lanes.indexOf(n.lane), seq: n.sequence_order ?? idx },
    ])
  );
  const crossEdges = visible.edges.filter((e) => {
    const a = nodeMeta.get(e.source);
    const b = nodeMeta.get(e.target);
    return a && b && a.laneIdx !== b.laneIdx;
  });
  let crossingCount = 0;
  for (let i = 0; i < crossEdges.length; i++) {
    for (let j = i + 1; j < crossEdges.length; j++) {
      const e1 = crossEdges[i];
      const e2 = crossEdges[j];
      const a1 = nodeMeta.get(e1.source)!;
      const b1 = nodeMeta.get(e1.target)!;
      const a2 = nodeMeta.get(e2.source)!;
      const b2 = nodeMeta.get(e2.target)!;
      if ((a1.laneIdx - a2.laneIdx) * (b1.laneIdx - b2.laneIdx) < 0 && (a1.seq - a2.seq) * (b1.seq - b2.seq) < 0) {
        crossingCount++;
      }
    }
  }
  const crossPenalty = crossingCount / Math.max(1, visible.edges.length);

  // Longest directed path length on visible edges (bounded to avoid infinite loop if cycle exists)
  const memo = new Map<string, number>();
  const visitingPath = new Set<string>();
  const getDepth = (u: string): number => {
    if (memo.has(u)) return memo.get(u)!;
    if (visitingPath.has(u)) return 0;
    visitingPath.add(u);
    let best = 1;
    for (const e of visible.edges) {
      if (e.source === u && e.target !== u && e.direction !== 'undirected') {
        best = Math.max(best, 1 + getDepth(e.target));
      }
    }
    visitingPath.delete(u);
    memo.set(u, best);
    return best;
  };
  let longestPath = 0;
  for (const n of visible.nodes) {
    longestPath = Math.max(longestPath, getDepth(n.id));
  }
  const depthPenalty = Math.max(0, longestPath - 12) / 12;

  const rawComplexityPenalty =
    0.30 * lanePenalty +
    0.25 * cardPenalty +
    0.20 * hubPenalty +
    0.15 * crossPenalty +
    0.10 * depthPenalty;
  const c5 = round4(clamp01(1 - rawComplexityPenalty));

  return {
    c1,
    c3,
    c5,
    gateViolations,
    details: {
      laneCount: L,
      nodeCount: totalNodes,
      maxDegree,
      crossingCount,
      longestPath,
      variationReachability: round4(variationReachability),
      componentRatio: round4(componentRatio),
    },
  };
}

/**
 * Computes weighted total score S in [0, 1].
 * If C2 or C4 are omitted, redistributes their weights proportionally among C1, C3, C5.
 */
export function totalScore(
  metrics: { c1: number; c2?: number; c3: number; c4?: number; c5: number },
  weights: GranularityWeights = DEFAULT_GRANULARITY_WEIGHTS
): number {
  const hasC2 = typeof metrics.c2 === 'number' && Number.isFinite(metrics.c2);
  const hasC4 = typeof metrics.c4 === 'number' && Number.isFinite(metrics.c4);

  const w1 = weights.w1;
  const w2 = hasC2 ? weights.w2 : 0;
  const w3 = weights.w3;
  const w4 = hasC4 ? weights.w4 : 0;
  const w5 = weights.w5;
  const sum = w1 + w2 + w3 + w4 + w5;
  if (sum <= 0) return 0;

  const score =
    (w1 * clamp01(metrics.c1) +
      w2 * clamp01(metrics.c2 ?? 0) +
      w3 * clamp01(metrics.c3) +
      w4 * clamp01(metrics.c4 ?? 0) +
      w5 * clamp01(metrics.c5)) /
    sum;
  return round4(clamp01(score));
}
