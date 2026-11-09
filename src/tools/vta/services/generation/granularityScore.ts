import type { VTANodeData, VTASchema, VTASourceDisposition, VTASourceRef } from '../../types/vta';
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

  // C1: Subject count / lane width appropriateness (Cognitive limit: 2 to maxSubjects lanes)
  // Concentration of cards on the main actor lane is natural in incident causality and is not penalized.
  const L = visible.lanes.length;
  const totalNodes = visible.nodes.length;
  const targetMin = 2;
  const targetMax = Math.max(targetMin, maxSubjects);
  let laneCountScore = 1.0;
  if (L < targetMin) {
    laneCountScore = L / targetMin;
  } else if (L > targetMax) {
    laneCountScore = Math.max(0, 1 - (L - targetMax) / Math.max(1, targetMax));
  }
  const c1 = round4(clamp01(laneCountScore));

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
      .filter((n) => n.type === 'outcome' || (n.event_ids ?? []).some((id) => outcomeEventIds.has(id)))
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

export interface CausalScenarioResult {
  outcomeNodes: VTANodeData[];
  scenarioNodes: VTANodeData[];
  omittedNodes: VTANodeData[];
  scenarioText: string;
  omittedText: string;
}

/**
 * 帰結ノードから先行関係（因果）を逆走し、因果シナリオを決定論的に抽出する
 */
export function extractCausalScenario(schema: VTASchema): CausalScenarioResult {
  const visible = visibleSchema(schema);
  const analysis = schema.analysis;

  // 帰結の特定
  const outcomeEventIds = new Set(
    analysis?.outcome?.status === 'identified' && analysis.outcome.eventIds.length
      ? analysis.outcome.eventIds
      : visible.nodes.slice(-1).flatMap((n) => n.event_ids ?? [])
  );

  let outcomeNodes = visible.nodes.filter((n) => n.type === 'outcome' || (n.event_ids ?? []).some((id) => outcomeEventIds.has(id)));
  if (outcomeNodes.length === 0 && visible.nodes.length > 0) {
    outcomeNodes = [visible.nodes[visible.nodes.length - 1]];
  }

  // 逆方向隣接リストの構築
  const reverseAdj = new Map<string, Set<string>>();
  for (const edge of visible.edges) {
    if (edge.source === edge.target) continue;
    if (edge.meaning === 'association') continue;

    const set = reverseAdj.get(edge.target) ?? new Set<string>();
    set.add(edge.source);
    reverseAdj.set(edge.target, set);

    if (edge.direction === 'bidirectional' || edge.direction === 'undirected') {
      const rev = reverseAdj.get(edge.source) ?? new Set<string>();
      rev.add(edge.target);
      reverseAdj.set(edge.source, rev);
    }
  }

  // 帰結からの BFS 逆走探索
  const visited = new Set<string>();
  const queue = outcomeNodes.map((n) => n.id);
  queue.forEach((id) => visited.add(id));

  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const prev of reverseAdj.get(cur) ?? []) {
      if (!visited.has(prev)) {
        visited.add(prev);
        queue.push(prev);
      }
    }
  }

  // シナリオノードの時系列整列
  const scenarioNodes = visible.nodes
    .filter((n) => visited.has(n.id))
    .sort((a, b) => (a.sequence_order ?? 0) - (b.sequence_order ?? 0));
  const omittedNodes = visible.nodes
    .filter((n) => !visited.has(n.id))
    .sort((a, b) => (a.sequence_order ?? 0) - (b.sequence_order ?? 0));

  const outcomeKindLabel =
    analysis?.outcome?.kind === 'near_miss'
      ? ' (帰結: 直前停止・ニアミス)'
      : analysis?.outcome?.kind === 'recovery'
        ? ' (帰結: レジリエンス回復)'
        : ' (帰結: 損失発生)';

  const scenarioText = scenarioNodes
    .map((n, i) => {
      const isOutcome = outcomeNodes.some((on) => on.id === n.id);
      const tag = isOutcome ? outcomeKindLabel : '';
      const desc = n.description ? ` - ${n.description}` : '';
      return `${i + 1}. [${n.time || '時刻未指定'} / ${n.lane}] ${n.title} (ID: ${n.id})${tag}${desc}`;
    })
    .join('\n');

  const omittedText = omittedNodes
    .map((n) => `・[${n.time || '時刻未指定'} / ${n.lane}] ${n.title} (ID: ${n.id})`)
    .join('\n');

  return { outcomeNodes, scenarioNodes, omittedNodes, scenarioText, omittedText };
}

/**
 * 帰結（第1帰結・第2帰結）から因果DAGを逆走し、事後調査等の非因果ノードを除外したスキーマを生成する
 */
export function filterPostOutcomeScope(schema: VTASchema): VTASchema {
  const hasIdentifiedOutcome =
    schema.nodes.some((n) => n.type === 'outcome') ||
    Boolean(schema.analysis?.outcome?.status === 'identified' && schema.analysis?.outcome?.eventIds?.length);

  if (!hasIdentifiedOutcome) {
    return schema;
  }

  const result = extractCausalScenario(schema);
  // 帰結が全く検出されない、または除外対象がない場合はそのまま返す
  if (result.outcomeNodes.length === 0 || result.omittedNodes.length === 0) {
    return schema;
  }

  // 帰結イベントの最大出現順（最終帰結）を取得し、帰結以前の事象が非接続というだけで誤除外されるのを防ぐ
  const eventById = new Map((schema.analysis?.events ?? []).map((e) => [e.id, e]));
  const outcomeEventIds = new Set(
    schema.analysis?.outcome?.status === 'identified' && schema.analysis.outcome.eventIds.length
      ? schema.analysis.outcome.eventIds
      : result.outcomeNodes.flatMap((n) => n.event_ids ?? [])
  );
  const outcomeOrders = (schema.analysis?.events ?? [])
    .filter((e) => outcomeEventIds.has(e.id))
    .map((e) => e.sourceOrder ?? 0)
    .filter((order) => order > 0);
  const maxOutcomeOrder = outcomeOrders.length > 0 ? Math.max(...outcomeOrders) : Infinity;

  const keptNodeIds = new Set<string>();
  for (const n of schema.nodes) {
    if (result.scenarioNodes.some((sn) => sn.id === n.id)) {
      keptNodeIds.add(n.id);
      continue;
    }
    const orders = (n.event_ids ?? [])
      .map((id) => eventById.get(id)?.sourceOrder)
      .filter((o): o is number => typeof o === 'number' && o > 0);
    // 帰結以前に発生したイベントからなるノードは無条件に保護
    if (orders.length > 0 && maxOutcomeOrder !== Infinity && orders.every((o) => o <= maxOutcomeOrder)) {
      keptNodeIds.add(n.id);
    }
  }

  // 除外対象が実質的に存在しない場合はそのまま返す
  if (keptNodeIds.size === schema.nodes.length) {
    return schema;
  }

  // 保持するノードとエッジ
  const nextNodes = schema.nodes.filter((n) => keptNodeIds.has(n.id));
  const nextEdges = schema.edges.filter((e) => keptNodeIds.has(e.source) && keptNodeIds.has(e.target));

  // レーンの絞り込み（ノードが存在するレーンを維持）
  const activeLanes = new Set(nextNodes.map((n) => n.lane || '主要部門'));
  const nextLanes = schema.lanes.filter((l) => activeLanes.has(l));

  // 除外されたイベントIDを analysis.dispositions に記録（監査可能性の維持）
  let nextAnalysis = schema.analysis;
  let nextPresentation = schema.presentation;

  if (nextAnalysis) {
    // 1. 保持対象ノードが参照している全イベントIDを収集
    const initialKeptEventIds = new Set<string>();
    for (const n of nextNodes) {
      for (const evId of n.event_ids ?? []) {
        initialKeptEventIds.add(evId);
      }
    }

    // 2. 保持対象カードの選定
    //   - visible な残存ノードに対応するカード (keptNodeIds.has(c.id))
    //   - または、suppressedCards で非表示化されていたが、因果イベントを保持している正当なカード
    const suppressedCardIds = new Set(Object.keys(nextPresentation?.suppressedCards ?? {}));
    const candidateCards = nextAnalysis.cards.filter((c) =>
      keptNodeIds.has(c.id) || (suppressedCardIds.has(c.id) && c.eventIds.some((id) => initialKeptEventIds.has(id)))
    );

    // 3. 実際に残すイベントID集合の確定
    const keptEventIds = new Set<string>(initialKeptEventIds);
    for (const c of candidateCards) {
      for (const evId of c.eventIds) {
        if (initialKeptEventIds.has(evId)) {
          keptEventIds.add(evId);
        }
      }
    }

    // 保持するイベント一覧（残存ノード・カードが参照しているイベントは必ず保持）
    const nextEvents = nextAnalysis.events.filter((e) => keptEventIds.has(e.id));
    const nextEventIdSet = new Set(nextEvents.map((e) => e.id));

    // 各カードの eventIds も実際に存在するイベントIDのみに整流（万が一の参照切れ防止）
    const filteredCandidateCards = candidateCards
      .map((c) => ({
        ...c,
        eventIds: c.eventIds.filter((evId) => nextEventIdSet.has(evId)),
      }))
      .filter((c) => c.eventIds.length > 0);

    // 4. 双方向整合化 (Bi-directional Reconciliation)
    // カード実在ペア
    const cardPairSet = new Set(
      filteredCandidateCards.flatMap((c) => c.eventIds.map((evId) => `${evId}\u0000${c.laneEntityId}`))
    );

    // 関与 (participations) をカード実在ペアに厳密同期
    const nextParticipations = (nextAnalysis.participations ?? []).filter(
      (p) => nextEventIdSet.has(p.eventId) && cardPairSet.has(`${p.eventId}\u0000${p.entityId}`)
    );

    // 逆方向同期: 関与に残ったペアのみをカード側に確定 (pairs.length === expectedPairs.length を保証)
    const participationPairSet = new Set(
      nextParticipations.map((p) => `${p.eventId}\u0000${p.entityId}`)
    );

    const sanitizedCards = filteredCandidateCards
      .map((c) => ({
        ...c,
        eventIds: c.eventIds.filter((evId) => participationPairSet.has(`${evId}\u0000${c.laneEntityId}`)),
      }))
      .filter((c) => c.eventIds.length > 0);

    // 5. presentation.suppressedCards のパージ（削除カードの参照切れによる "表示設定が不正です" を防止）
    const remainingCardIdSet = new Set(sanitizedCards.map((c) => c.id));
    if (nextPresentation?.suppressedCards) {
      const cleanedSuppressed = Object.fromEntries(
        Object.entries(nextPresentation.suppressedCards).filter(([id]) => remainingCardIdSet.has(id))
      );
      nextPresentation = {
        ...nextPresentation,
        suppressedCards: cleanedSuppressed,
      };
    }

    // 本当に除外されたイベント（保持対象のどのカード・ノードからも参照されなくなったイベント）
    const omittedEvents = nextAnalysis.events.filter((e) => !nextEventIdSet.has(e.id));
    const existingDispositions = nextAnalysis.dispositions ?? [];
    const addedDispositions: VTASourceDisposition[] = [];

    for (const ev of omittedEvents) {
      if (!existingDispositions.some((d) => d.id === `disp_post_${ev.id}`)) {
        const refs: VTASourceRef[] = ev.sourceRefs && ev.sourceRefs.length > 0
          ? ev.sourceRefs
          : ev.factIds && ev.factIds.length > 0
            ? ev.factIds.map((fid) => ({ sourceId: 'source_1', paragraphId: fid, quote: ev.title || '' }))
            : [{ sourceId: 'source_1', paragraphId: 'p1', quote: ev.title || '' }];
        addedDispositions.push({
          id: `disp_post_${ev.id}`,
          sourceId: refs[0].sourceId,
          paragraphId: refs[0].paragraphId,
          quote: ev.title || '',
          kind: 'excluded',
          reason: '帰結以後の事後活動・調査活動として除外 (post-outcome-scope)',
          text: ev.description || ev.title,
          sourceRefs: refs,
        });
      }
    }

    // 関係線・関与の整合化（除外されたイベントを参照する関係線・関与を除去し、端点主体を整合化）
    const partPairSet = new Set(
      nextParticipations.map((p) => `${p.eventId}\u0000${p.entityId}`)
    );
    const nextRelations = (nextAnalysis.relations ?? [])
      .filter((r) => nextEventIdSet.has(r.sourceEventId) && nextEventIdSet.has(r.targetEventId))
      .map((r) => {
        const copy = { ...r };
        if (copy.kind === 'before') {
          if (copy.sourceEntityId && !partPairSet.has(`${copy.sourceEventId}\u0000${copy.sourceEntityId}`)) {
            delete copy.sourceEntityId;
          }
          if (copy.targetEntityId && !partPairSet.has(`${copy.targetEventId}\u0000${copy.targetEntityId}`)) {
            delete copy.targetEntityId;
          }
        }
        return copy;
      })
      .filter((r) => {
        if (r.kind === 'before') return true;
        const srcValid = !r.sourceEntityId || partPairSet.has(`${r.sourceEventId}\u0000${r.sourceEntityId}`);
        const tgtValid = !r.targetEntityId || partPairSet.has(`${r.targetEventId}\u0000${r.targetEntityId}`);
        return srcValid && tgtValid;
      });
    const nextUnassigned = (nextAnalysis.unassignedEventIds ?? []).filter((id) =>
      nextEventIdSet.has(id)
    );

    let nextOutcome = nextAnalysis.outcome;
    if (nextOutcome && nextOutcome.eventIds) {
      const remainingOutcomeIds = nextOutcome.eventIds.filter((id) => nextEventIdSet.has(id));
      nextOutcome = {
        ...nextOutcome,
        eventIds: remainingOutcomeIds,
        status: remainingOutcomeIds.length > 0 ? nextOutcome.status : 'not_found',
      };
    }

    nextAnalysis = {
      ...nextAnalysis,
      events: nextEvents,
      cards: sanitizedCards,
      relations: nextRelations,
      participations: nextParticipations,
      unassignedEventIds: nextUnassigned,
      outcome: nextOutcome,
      dispositions: [...existingDispositions, ...addedDispositions],
    };
  }

  return {
    ...schema,
    lanes: nextLanes.length > 0 ? nextLanes : schema.lanes,
    nodes: nextNodes,
    edges: nextEdges,
    presentation: nextPresentation,
    analysis: nextAnalysis,
  };
}
