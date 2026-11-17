import {
  EventTimeDAGData,
  MAX_TIME_NODES,
  VTAAnalysisData,
  VTAEvent,
  VTAEventIgnoreReason,
  VTAEventRelation,
  VTAParticipation,
} from '../../../types/vta';

export type TemporalOrderResult = 'simultaneous' | 'before' | 'after' | 'incomparable';

/**
 * 時刻文字列を解析し、数値ソートスコアまたは null を返す。
 */
export function parseTimeScore(timeStr: string | undefined): number | null {
  if (!timeStr) return null;
  const s = timeStr.trim();
  if (!s || s === '-') return null;

  // 1. ISO または完全な日付 (例: 2024-04-01 10:30, 2024/04/01 10:30)
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

  // 2. 時刻表記 (HH:MM または HH:MM:SS)
  const timeMatch = s.match(/^(\d{1,2})[:：](\d{2})(?:[:：](\d{2}))?$/);
  if (timeMatch) {
    const h = parseInt(timeMatch[1], 10);
    const m = parseInt(timeMatch[2], 10);
    const sec = timeMatch[3] ? parseInt(timeMatch[3], 10) : 0;
    return h * 3600 + m * 60 + sec;
  }

  // 3. 相対時間オフセット (例: "2ヶ月前", "30分後", "1時間前", "CDR後（2ヶ月）")
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
    return dir * val * factor;
  }

  // 4. 時系列フェーズキーワード
  if (/発端|開始前|事前|初期/.test(s)) return -86400 * 7;
  if (/試験前|直前|前日/.test(s)) return -86400;
  if (/当日\s*朝|午前/.test(s)) return 3600 * 9;
  if (/当日\s*昼|正午/.test(s)) return 3600 * 12;
  if (/当日\s*夕|午後|直後/.test(s)) return 3600 * 15;
  if (/試験中|通電時|作業中|実施中/.test(s)) return 3600 * 16;
  if (/発生時|不具合発生|事故発生|完了時/.test(s)) return 3600 * 18;

  return null;
}

export function isPrecedenceRelation(r: VTAEventRelation): boolean {
  return (
    r.sourceEventId !== r.targetEventId &&
    (r.kind === 'before' ||
      r.kind === 'dependency' ||
      ((r.kind === 'transfer' || r.kind === 'impact') && r.status !== 'omitted' && r.status !== 'unknown'))
  );
}

export function computeDAGSignatures(analysis: Pick<VTAAnalysisData, 'events' | 'relations'>): {
  eventSignature: string;
  relationSignature: string;
} {
  const eventSignature = analysis.events
    .map((e) => `${e.id}:${e.timeNodeId ?? ''}:${e.sourceOrder}:${e.time ?? ''}`)
    .join('|');
  const relationSignature = analysis.relations
    .filter(isPrecedenceRelation)
    .map((r) => `${r.kind}:${r.sourceEventId}->${r.targetEventId}:${r.status ?? ''}`)
    .join('|');
  return { eventSignature, relationSignature };
}

/**
 * 0以上の整数 timeNodeId (最大 MAX_TIME_NODES = 400) を頂点とし、
 * 反対称2次元配列 matrix[u][v] (+1/+2: u≺v, -1/-2: v≺u, 0: 順序なし) によって
 * イベント間の時間半順序関係（DAG）を管理するエンジン。
 */
export class EventTimeDAG {
  public nodeCount: number;
  public matrix: number[][];
  public manualEdges: Array<[number, number]>;
  public simultaneousPairs: Array<[string, string]>;
  public eventSignature?: string;
  public relationSignature?: string;

  constructor(
    nodeCount = 0,
    matrix?: number[][],
    manualEdges?: Array<[number, number]>,
    simultaneousPairs?: Array<[string, string]>,
    eventSignature?: string,
    relationSignature?: string
  ) {
    if (nodeCount < 0 || nodeCount > MAX_TIME_NODES) {
      throw new Error(`timeNodeId の個数 (${nodeCount}) が許容範囲 (0〜${MAX_TIME_NODES}) を超えています。`);
    }
    this.nodeCount = nodeCount;
    if (matrix && matrix.length === nodeCount && matrix.every((row) => row.length === nodeCount)) {
      this.matrix = matrix.map((row) => [...row]);
    } else {
      this.matrix = Array.from({ length: nodeCount }, () => Array(nodeCount).fill(0));
    }
    this.manualEdges = manualEdges ? manualEdges.map(([u, v]) => [u, v]) : [];
    this.simultaneousPairs = simultaneousPairs ? simultaneousPairs.map(([a, b]) => [a, b]) : [];
    this.eventSignature = eventSignature;
    this.relationSignature = relationSignature;
  }

  static fromData(data?: EventTimeDAGData | null): EventTimeDAG | null {
    if (!data || typeof data.nodeCount !== 'number' || !Array.isArray(data.matrix)) return null;
    if (data.nodeCount < 0 || data.nodeCount > MAX_TIME_NODES) return null;
    if (data.matrix.length !== data.nodeCount) return null;
    for (let u = 0; u < data.nodeCount; u++) {
      const row = data.matrix[u];
      if (!Array.isArray(row) || row.length !== data.nodeCount) return null;
      if (row[u] !== 0) return null;
    }
    const dag = new EventTimeDAG(
      data.nodeCount,
      data.matrix,
      data.manualEdges,
      data.simultaneousPairs,
      data.eventSignature,
      data.relationSignature
    );
    dag.recomputeTransitiveClosure();
    return dag;
  }

  public toJSON(): EventTimeDAGData {
    return {
      nodeCount: this.nodeCount,
      matrix: this.matrix.map((row) => [...row]),
      ...(this.manualEdges.length ? { manualEdges: this.manualEdges.map(([u, v]) => [u, v] as [number, number]) } : {}),
      ...(this.simultaneousPairs.length ? { simultaneousPairs: this.simultaneousPairs.map(([a, b]) => [a, b] as [string, string]) } : {}),
      ...(this.eventSignature !== undefined ? { eventSignature: this.eventSignature } : {}),
      ...(this.relationSignature !== undefined ? { relationSignature: this.relationSignature } : {}),
    };
  }

  public clone(): EventTimeDAG {
    return new EventTimeDAG(
      this.nodeCount,
      this.matrix,
      this.manualEdges,
      this.simultaneousPairs,
      this.eventSignature,
      this.relationSignature
    );
  }

  /**
   * u ≺ v の先行関係を追加可能か（自己ループや逆方向順序 v ≺ u が存在しないか）を
   * matrix[u][v] の単一参照で判定する。
   */
  public canAddPrecedence(fromNodeId: number, toNodeId: number): boolean {
    if (
      !Number.isInteger(fromNodeId) ||
      !Number.isInteger(toNodeId) ||
      fromNodeId < 0 ||
      toNodeId < 0 ||
      fromNodeId >= this.nodeCount ||
      toNodeId >= this.nodeCount
    ) {
      return false;
    }
    if (fromNodeId === toNodeId) return false;
    // matrix[from][to] < 0 は「すでに to ≺ from（逆方向）」を意味するため追加不可
    return this.matrix[fromNodeId][toNodeId] >= 0;
  }

  /**
   * fromNodeId ≺ toNodeId の直接先行関係 (+1 / -1) を設定し、推移的閉包 (+2 / -2) を更新する。
   */
  public addPrecedenceEdge(fromNodeId: number, toNodeId: number): boolean {
    if (!this.canAddPrecedence(fromNodeId, toNodeId)) return false;

    const u = fromNodeId;
    const v = toNodeId;
    if (this.matrix[u][v] === 0) {
      this.matrix[u][v] = 1;
      this.matrix[v][u] = -1;
    }

    const ancestorsOfU: number[] = [u];
    const descendantsOfV: number[] = [v];
    for (let i = 0; i < this.nodeCount; i++) {
      if (this.matrix[i][u] > 0) ancestorsOfU.push(i);
      if (this.matrix[v][i] > 0) descendantsOfV.push(i);
    }

    for (const a of ancestorsOfU) {
      for (const d of descendantsOfV) {
        if (a === d) continue;
        if (a === u && d === v) continue;
        this.matrix[a][d] = 2;
        this.matrix[d][a] = -2;
      }
    }
    return true;
  }

  /**
   * 2つの timeNodeId 間の時間半順序を matrix[u][v] の1回の参照で返す。
   */
  public compareNodes(nodeA: number, nodeB: number): TemporalOrderResult {
    if (nodeA === nodeB) return 'simultaneous';
    const val = this.matrix[nodeA]?.[nodeB] ?? 0;
    if (val > 0) return 'before';
    if (val < 0) return 'after';
    return 'incomparable';
  }

  /**
   * 新しい timeNodeId を割り当てて2次元配列を拡張し、指定された先行・後続ノードの間に挿入する。
   */
  public insertTimeNode(options?: { afterNodeIds?: number[]; beforeNodeIds?: number[] }): number {
    if (this.nodeCount >= MAX_TIME_NODES) {
      throw new Error(`timeNodeId が上限 (${MAX_TIME_NODES}) に達しているため、新しい時間ノードを追加できません。`);
    }
    const newNodeId = this.nodeCount;
    this.nodeCount += 1;
    for (const row of this.matrix) {
      row.push(0);
    }
    this.matrix.push(Array(this.nodeCount).fill(0));

    const validAfter = (options?.afterNodeIds ?? []).filter(
      (id) => Number.isInteger(id) && id >= 0 && id < newNodeId
    );
    const validBefore = (options?.beforeNodeIds ?? []).filter(
      (id) => Number.isInteger(id) && id >= 0 && id < newNodeId
    );

    for (const p of validAfter) {
      if (this.addPrecedenceEdge(p, newNodeId)) {
        this.manualEdges.push([p, newNodeId]);
      }
    }
    for (const s of validBefore) {
      if (this.canAddPrecedence(newNodeId, s) && this.addPrecedenceEdge(newNodeId, s)) {
        this.manualEdges.push([newNodeId, s]);
      }
    }

    return newNodeId;
  }

  /**
   * 行列全体の反対称性と推移的閉包を再計算・整える。
   */
  public recomputeTransitiveClosure(): void {
    const n = this.nodeCount;
    for (let i = 0; i < n; i++) {
      this.matrix[i][i] = 0;
      for (let j = i + 1; j < n; j++) {
        if (this.matrix[i][j] > 0) {
          this.matrix[i][j] = this.matrix[i][j] === 1 ? 1 : 2;
          this.matrix[j][i] = -this.matrix[i][j];
        } else if (this.matrix[i][j] < 0 || this.matrix[j][i] > 0) {
          const v = this.matrix[j][i] === 1 || this.matrix[i][j] === -1 ? 1 : 2;
          this.matrix[j][i] = v;
          this.matrix[i][j] = -v;
        } else {
          this.matrix[i][j] = 0;
          this.matrix[j][i] = 0;
        }
      }
    }

    for (let k = 0; k < n; k++) {
      for (let i = 0; i < n; i++) {
        if (i === k || this.matrix[i][k] <= 0) continue;
        for (let j = 0; j < n; j++) {
          if (j === i || j === k || this.matrix[k][j] <= 0) continue;
          this.matrix[i][j] = 2;
          this.matrix[j][i] = -2;
        }
      }
    }
  }

  /**
   * 有効な timeNodeId 集合に対し、VTA図の下から上への「行番号（rowIndex: 0, 1, 2...）」を算出する。
   * 前後順序を示せない timeNodeId 同士は同じ行番号（rowIndex）を共有する。
   */
  public computeNodeRowRanks(
    activeNodeIds?: Set<number>,
    tieBreakScore?: Map<number, number>
  ): Map<number, number> {
    const targetIds: number[] = [];
    for (let u = 0; u < this.nodeCount; u++) {
      if (!activeNodeIds || activeNodeIds.has(u)) {
        targetIds.push(u);
      }
    }
    if (targetIds.length === 0) return new Map();

    const indegree = new Map<number, number>();
    const rawRank = new Map<number, number>();
    for (const u of targetIds) {
      let deg = 0;
      for (const p of targetIds) {
        if (p !== u && this.matrix[p][u] > 0) deg++;
      }
      indegree.set(u, deg);
      rawRank.set(u, 0);
    }

    const cmp = (a: number, b: number) =>
      (tieBreakScore?.get(a) ?? a) - (tieBreakScore?.get(b) ?? b) || a - b;
    const queue = targetIds.filter((u) => (indegree.get(u) ?? 0) === 0).sort(cmp);
    while (queue.length > 0) {
      const u = queue.shift()!;
      const rU = rawRank.get(u) ?? 0;
      for (const v of targetIds) {
        if (u !== v && this.matrix[u][v] > 0) {
          if (rU + 1 > (rawRank.get(v) ?? 0)) {
            rawRank.set(v, rU + 1);
          }
          const nextDeg = (indegree.get(v) ?? 1) - 1;
          indegree.set(v, nextDeg);
          if (nextDeg === 0) {
            queue.push(v);
            queue.sort(cmp);
          }
        }
      }
    }

    const uniqueRanks = Array.from(new Set(rawRank.values())).sort((a, b) => a - b);
    const compactMap = new Map<number, number>();
    uniqueRanks.forEach((r, idx) => compactMap.set(r, idx));

    const result = new Map<number, number>();
    for (const u of targetIds) {
      result.set(u, compactMap.get(rawRank.get(u) ?? 0) ?? 0);
    }
    return result;
  }
}

/**
 * 無視フラグ (ignored: true) が設定されていない有効イベント一覧を返す。
 */
export function activeEvents(analysis: Pick<VTAAnalysisData, 'events'>): VTAEvent[] {
  return analysis.events.filter((event) => !event.ignored);
}

/**
 * 2つのイベント間の時間半順序を EventTimeDAG の2次元配列から専用検索して返す。
 */
export function compareEventTime(
  dag: EventTimeDAG,
  eventA: Pick<VTAEvent, 'timeNodeId'>,
  eventB: Pick<VTAEvent, 'timeNodeId'>
): TemporalOrderResult {
  const u = eventA.timeNodeId ?? 0;
  const v = eventB.timeNodeId ?? 0;
  return dag.compareNodes(u, v);
}

/**
 * イベントID指定で2つのイベント間の時間半順序を検索する。
 */
export function compareEventTimeById(
  analysis: VTAAnalysisData,
  eventIdA: string,
  eventIdB: string,
  dagOverride?: EventTimeDAG
): TemporalOrderResult {
  if (eventIdA === eventIdB) return 'simultaneous';
  const dag = dagOverride ?? ensureEventTimeDAG(analysis);
  const evA = analysis.events.find((e) => e.id === eventIdA);
  const evB = analysis.events.find((e) => e.id === eventIdB);
  if (!evA || !evB) return 'incomparable';
  return compareEventTime(dag, evA, evB);
}

/**
 * eventA が eventB より時間的に前 (eventA ≺ eventB) であるかを返す。
 */
export function isEventBefore(
  dag: EventTimeDAG,
  eventA: Pick<VTAEvent, 'timeNodeId'>,
  eventB: Pick<VTAEvent, 'timeNodeId'>
): boolean {
  return compareEventTime(dag, eventA, eventB) === 'before';
}

/**
 * 追加順で決まるユニークなイベントID (E1, E2, ...) を採番する（時間順序とは独立）。
 */
export function allocateNextEventId(
  analysis: Pick<VTAAnalysisData, 'events' | 'nextEventSeq'>
): { id: string; nextEventSeq: number } {
  const existingIds = new Set(analysis.events.map((e) => e.id));
  let seq = analysis.nextEventSeq ?? 1;
  for (const ev of analysis.events) {
    const m = /^E(\d+)$/i.exec(ev.id.trim());
    if (m) {
      const n = parseInt(m[1], 10);
      if (n >= seq) seq = n + 1;
    }
  }
  while (existingIds.has(`E${seq}`)) {
    seq += 1;
  }
  return { id: `E${seq}`, nextEventSeq: seq + 1 };
}

/**
 * イベント群・関与・関係・同値グループから timeNodeId (0..N-1) と EventTimeDAG を構築する。
 */
export function buildEventTimeDAG(
  events: VTAEvent[],
  participations: VTAParticipation[],
  relations: VTAEventRelation[],
  simultaneousGroups: Array<{ eventIds: string[] }> = [],
  options?: {
    cards?: Array<{ laneEntityId: string; eventIds: string[] }>;
    manualEdges?: Array<[number, number]>;
    simultaneousPairs?: Array<[string, string]>;
  }
): EventTimeDAG {
  // 1. 同時グループ（同一行指定されたイベント群）のUnion-Find
  const parent = new Map<string, string>(events.map((e) => [e.id, e.id]));
  const findRoot = (id: string): string => {
    const p = parent.get(id);
    if (!p || p === id) return id;
    const r = findRoot(p);
    parent.set(id, r);
    return r;
  };
  for (const grp of simultaneousGroups) {
    const valid = grp.eventIds.filter((id) => parent.has(id));
    for (let i = 1; i < valid.length; i++) {
      parent.set(findRoot(valid[i]), findRoot(valid[0]));
    }
  }
  for (const [idA, idB] of options?.simultaneousPairs ?? []) {
    if (parent.has(idA) && parent.has(idB)) {
      parent.set(findRoot(idB), findRoot(idA));
    }
  }

  // 同一の明示的時刻（スコア算出可能）を持ち、直接・間接の先行関係が存在しないイベント同士も同一 timeNodeId を共有する
  const precRelations = relations.filter(isPrecedenceRelation);
  const hasRelationPath = (fromId: string, toId: string, visited = new Set<string>()): boolean => {
    if (fromId === toId) return true;
    if (visited.has(fromId)) return false;
    visited.add(fromId);
    for (const rel of precRelations) {
      if (rel.sourceEventId === fromId && hasRelationPath(rel.targetEventId, toId, visited)) {
        return true;
      }
    }
    return false;
  };
  for (let i = 0; i < events.length; i++) {
    const rawI = (events[i].time ?? '').trim();
    const scoreI = parseTimeScore(rawI);
    if (!rawI || scoreI === null) continue;
    for (let j = i + 1; j < events.length; j++) {
      const rawJ = (events[j].time ?? '').trim();
      const scoreJ = parseTimeScore(rawJ);
      if (rawI === rawJ && scoreI === scoreJ) {
        const rI = findRoot(events[i].id);
        const rJ = findRoot(events[j].id);
        if (
          rI !== rJ &&
          !hasRelationPath(events[i].id, events[j].id) &&
          !hasRelationPath(events[j].id, events[i].id)
        ) {
          parent.set(rJ, rI);
        }
      }
    }
  }

  // 2. 各イベントに 0 以上の連番整数 timeNodeId を割り当てる
  const rootToTimeNodeId = new Map<string, number>();
  let nextNodeId = 0;
  for (const ev of events) {
    const r = findRoot(ev.id);
    let nodeId = rootToTimeNodeId.get(r);
    if (nodeId === undefined) {
      if (nextNodeId >= MAX_TIME_NODES) {
        throw new Error(`timeNodeId が上限 (${MAX_TIME_NODES}) を超えました。`);
      }
      nodeId = nextNodeId++;
      rootToTimeNodeId.set(r, nodeId);
    }
    ev.timeNodeId = nodeId;
  }

  const dag = new EventTimeDAG(
    nextNodeId,
    undefined,
    options?.manualEdges,
    options?.simultaneousPairs
  );
  const eventById = new Map(events.map((e) => [e.id, e]));

  // 各 timeNodeId の最小 sourceOrder と時刻スコア・生時刻文字列を集計
  const nodeMinOrder = new Map<number, number>();
  const nodeTimeScore = new Map<number, number | null>();
  const nodeRawTimes = new Map<number, Set<string>>();

  events.forEach((ev, idx) => {
    const u = ev.timeNodeId!;
    const order = Number.isFinite(ev.sourceOrder) ? ev.sourceOrder : idx;
    nodeMinOrder.set(u, Math.min(nodeMinOrder.get(u) ?? Infinity, order));

    const score = parseTimeScore(ev.time);
    if (score !== null) {
      const prev = nodeTimeScore.get(u);
      nodeTimeScore.set(u, prev !== undefined && prev !== null ? Math.min(prev, score) : score);
    } else if (!nodeTimeScore.has(u)) {
      nodeTimeScore.set(u, null);
    }

    const raw = (ev.time ?? '').trim();
    const rawSet = nodeRawTimes.get(u) ?? new Set<string>();
    if (raw) rawSet.add(raw);
    nodeRawTimes.set(u, rawSet);
  });

  // 3. 優先度0: イベント追加時に明示指定された先行エッジ (manualEdges)
  for (const [u, v] of options?.manualEdges ?? []) {
    if (dag.canAddPrecedence(u, v)) {
      dag.addPrecedenceEdge(u, v);
    }
  }

  // 4. 優先度1: 明示的な先行関係 (before / dependency / transfer / impact)
  for (const kind of ['before', 'dependency', 'impact', 'transfer'] as const) {
    for (const rel of relations) {
      if (rel.kind !== kind || !isPrecedenceRelation(rel)) continue;
      const srcEv = eventById.get(rel.sourceEventId);
      const tgtEv = eventById.get(rel.targetEventId);
      if (!srcEv || !tgtEv || srcEv.timeNodeId === undefined || tgtEv.timeNodeId === undefined) continue;
      dag.addPrecedenceEdge(srcEv.timeNodeId, tgtEv.timeNodeId);
    }
  }

  // 5. 優先度2: 同一主体レーン内の記述順
  const laneNodesMap = new Map<string, number[]>();
  for (const card of options?.cards ?? []) {
    const list = laneNodesMap.get(card.laneEntityId) ?? [];
    for (const evId of card.eventIds) {
      const u = eventById.get(evId)?.timeNodeId;
      if (u !== undefined && !list.includes(u)) list.push(u);
    }
    laneNodesMap.set(card.laneEntityId, list);
  }
  for (const part of participations) {
    const u = eventById.get(part.eventId)?.timeNodeId;
    if (u === undefined) continue;
    const list = laneNodesMap.get(part.entityId) ?? [];
    if (!list.includes(u)) list.push(u);
    laneNodesMap.set(part.entityId, list);
  }

  for (const nodeList of laneNodesMap.values()) {
    const sorted = [...nodeList].sort(
      (a, b) => (nodeMinOrder.get(a) ?? 0) - (nodeMinOrder.get(b) ?? 0) || a - b
    );
    for (let i = 0; i < sorted.length - 1; i++) {
      const u = sorted[i];
      const v = sorted[i + 1];
      if ((nodeMinOrder.get(u) ?? 0) >= (nodeMinOrder.get(v) ?? 0)) continue;

      const tU = nodeTimeScore.get(u) ?? null;
      const tV = nodeTimeScore.get(v) ?? null;
      // 明示的な時刻スコアが逆順 (tU > tV) の場合は時刻スコア順を優先
      if (tU !== null && tV !== null && tU > tV) continue;

      // 同一の明示的な時刻文字列（かつスコア算出可能）を持つ場合は前後順序を示せないため同じセルに配置
      const rawU = nodeRawTimes.get(u);
      const rawV = nodeRawTimes.get(v);
      const sameExplicitRaw =
        tU !== null &&
        tV !== null &&
        tU === tV &&
        rawU &&
        rawV &&
        rawU.size === 1 &&
        rawV.size === 1 &&
        [...rawU][0] === [...rawV][0];
      if (sameExplicitRaw) continue;

      if (dag.canAddPrecedence(u, v)) {
        dag.addPrecedenceEdge(u, v);
      }
    }
  }

  // 6. 優先度3: 明示的な時刻スコア順
  for (let u = 0; u < nextNodeId; u++) {
    for (let v = 0; v < nextNodeId; v++) {
      if (u === v) continue;
      const tU = nodeTimeScore.get(u);
      const tV = nodeTimeScore.get(v);
      if (tU !== null && tU !== undefined && tV !== null && tV !== undefined && tU < tV) {
        if (dag.canAddPrecedence(u, v)) {
          dag.addPrecedenceEdge(u, v);
        }
      }
    }
  }

  const sigs = computeDAGSignatures({ events, relations });
  dag.eventSignature = sigs.eventSignature;
  dag.relationSignature = sigs.relationSignature;

  return dag;
}

/**
 * analysis 内の timeNodeId と eventTimeDAG が有効であることを保証し、EventTimeDAG インスタンスを返す。
 */
export function ensureEventTimeDAG(analysis: VTAAnalysisData): EventTimeDAG {
  const sigs = computeDAGSignatures(analysis);
  const allAssigned =
    analysis.events.every(
      (e) => typeof e.timeNodeId === 'number' && e.timeNodeId >= 0 && e.timeNodeId < MAX_TIME_NODES
    ) && analysis.eventTimeDAG != null;

  if (allAssigned && analysis.eventTimeDAG) {
    const maxAssigned = analysis.events.reduce((m, e) => Math.max(m, e.timeNodeId ?? -1), -1);
    const sigMatched =
      analysis.eventTimeDAG.eventSignature === sigs.eventSignature &&
      analysis.eventTimeDAG.relationSignature === sigs.relationSignature;
    if (sigMatched) {
      const restored = EventTimeDAG.fromData(analysis.eventTimeDAG);
      if (restored && restored.nodeCount > maxAssigned) {
        return restored;
      }
    }
  }

  const simultaneousGroups = analysis.cards
    .filter((c) => c.eventIds.length > 1)
    .map((c) => ({ eventIds: c.eventIds }));
  const dag = buildEventTimeDAG(
    analysis.events,
    analysis.participations,
    analysis.relations,
    simultaneousGroups,
    {
      cards: analysis.cards,
      manualEdges: analysis.eventTimeDAG?.manualEdges,
      simultaneousPairs: analysis.eventTimeDAG?.simultaneousPairs,
    }
  );
  analysis.eventTimeDAG = dag.toJSON();
  return dag;
}

/**
 * 各有効イベント (ignored !== true) の「行番号 (rowIndex: 0, 1, 2...)」を計算して返す。
 */
export function computeEventRowMap(analysis: VTAAnalysisData, dagOverride?: EventTimeDAG): Map<string, number> {
  const dag = dagOverride ?? ensureEventTimeDAG(analysis);
  const active = activeEvents(analysis);
  const activeNodeIds = new Set<number>();
  const tieBreakScore = new Map<number, number>();
  active.forEach((ev, idx) => {
    if (typeof ev.timeNodeId === 'number') {
      activeNodeIds.add(ev.timeNodeId);
      const order = Number.isFinite(ev.sourceOrder) ? ev.sourceOrder : idx;
      tieBreakScore.set(ev.timeNodeId, Math.min(tieBreakScore.get(ev.timeNodeId) ?? Infinity, order));
    }
  });
  const nodeRanks = dag.computeNodeRowRanks(activeNodeIds, tieBreakScore);
  const eventRowMap = new Map<string, number>();
  for (const ev of active) {
    if (typeof ev.timeNodeId === 'number' && nodeRanks.has(ev.timeNodeId)) {
      eventRowMap.set(ev.id, nodeRanks.get(ev.timeNodeId)!);
    }
  }
  return eventRowMap;
}

/**
 * イベントを削除せず、無視フラグ (ignored) を設定・解除する。
 */
export function setEventIgnored(
  analysis: VTAAnalysisData,
  eventId: string,
  ignored: boolean,
  reason: VTAEventIgnoreReason = 'user'
): VTAAnalysisData {
  analysis.events = analysis.events.map((ev) => {
    if (ev.id !== eventId) return ev;
    if (ignored) {
      return { ...ev, ignored: true, ignoreReason: reason };
    }
    const next = { ...ev };
    delete next.ignored;
    delete next.ignoreReason;
    return next;
  });
  analysis.unassignedEventIds = analysis.events
    .filter((event) => !event.ignored && !analysis.cards.some((card) => card.eventIds.includes(event.id)))
    .map((event) => event.id);
  return analysis;
}

export interface AddEventParams {
  id?: string;
  title: string;
  description?: string;
  time?: string;
  laneEntityId?: string;
  role?: VTAParticipation['role'];
  cardId?: string;
  classification?: VTAEvent['classification'];
  origin?: VTAEvent['origin'];
  recordKind?: VTAEvent['recordKind'];
  sourceRefs?: VTAEvent['sourceRefs'];
  measure_type?: VTAEvent['measure_type'];
  outcome_kind?: VTAEvent['outcome_kind'];
  variationFactor?: VTAEvent['variationFactor'];
  /** 同時（同一timeNodeId共有）とする対象イベントID */
  simultaneousWithEventId?: string;
  /** この新規イベントより時間的に先行するイベントID群 */
  afterEventIds?: string[];
  /** この新規イベントより時間的に後続するイベントID群 */
  beforeEventIds?: string[];
}

/**
 * 新規イベントを追加順のユニークIDで登録し、EventTimeDAG のツリー構造（2次元配列）を更新する。
 */
export function addEventToAnalysis(
  analysis: VTAAnalysisData,
  params: AddEventParams
): { analysis: VTAAnalysisData; event: VTAEvent; dag: EventTimeDAG } {
  const dag = ensureEventTimeDAG(analysis).clone();
  const allocated = params.id && !analysis.events.some((e) => e.id === params.id)
    ? { id: params.id, nextEventSeq: analysis.nextEventSeq ?? analysis.events.length + 1 }
    : allocateNextEventId(analysis);

  const eventById = new Map(analysis.events.map((e) => [e.id, e]));
  let timeNodeId: number;

  if (params.simultaneousWithEventId && eventById.get(params.simultaneousWithEventId)?.timeNodeId !== undefined) {
    timeNodeId = eventById.get(params.simultaneousWithEventId)!.timeNodeId!;
    dag.simultaneousPairs.push([params.simultaneousWithEventId, allocated.id]);
  } else {
    let afterNodeIds = (params.afterEventIds ?? [])
      .map((id) => eventById.get(id)?.timeNodeId)
      .filter((n): n is number => typeof n === 'number');
    let beforeNodeIds = (params.beforeEventIds ?? [])
      .map((id) => eventById.get(id)?.timeNodeId)
      .filter((n): n is number => typeof n === 'number');

    const newScore = parseTimeScore(params.time);
    if (afterNodeIds.length === 0 && beforeNodeIds.length === 0 && newScore !== null) {
      for (const ev of analysis.events) {
        if (ev.ignored || typeof ev.timeNodeId !== 'number') continue;
        const s = parseTimeScore(ev.time);
        if (s === null) continue;
        if (s < newScore) afterNodeIds.push(ev.timeNodeId);
        else if (s > newScore) beforeNodeIds.push(ev.timeNodeId);
      }
    }

    timeNodeId = dag.insertTimeNode({ afterNodeIds, beforeNodeIds });
  }

  for (const predId of params.afterEventIds ?? []) {
    if (eventById.has(predId)) {
      analysis.relations.push({
        id: `rel_${predId}_${allocated.id}`,
        sourceEventId: predId,
        targetEventId: allocated.id,
        kind: 'before',
        factIds: [],
        evidenceBasis: 'user',
        provenance: 'user',
      });
    }
  }
  for (const succId of params.beforeEventIds ?? []) {
    if (eventById.has(succId)) {
      analysis.relations.push({
        id: `rel_${allocated.id}_${succId}`,
        sourceEventId: allocated.id,
        targetEventId: succId,
        kind: 'before',
        factIds: [],
        evidenceBasis: 'user',
        provenance: 'user',
      });
    }
  }

  const newEvent: VTAEvent = {
    id: allocated.id,
    timeNodeId,
    origin: params.origin ?? 'manual',
    title: params.title,
    description: params.description ?? '',
    time: params.time ?? '',
    sourceOrder: analysis.events.length,
    factIds: [],
    classification: params.classification ?? 'normal',
    ...(params.recordKind ? { recordKind: params.recordKind } : {}),
    ...(params.sourceRefs ? { sourceRefs: params.sourceRefs } : {}),
    ...(params.measure_type !== undefined ? { measure_type: params.measure_type } : {}),
    ...(params.outcome_kind ? { outcome_kind: params.outcome_kind } : {}),
    ...(params.variationFactor ? { variationFactor: params.variationFactor } : {}),
  };

  analysis.events.push(newEvent);
  analysis.nextEventSeq = allocated.nextEventSeq;

  if (params.laneEntityId && analysis.entities.some((e) => e.id === params.laneEntityId)) {
    const cardId = params.cardId ?? `card_${allocated.id}`;
    analysis.cards.push({
      id: cardId,
      laneEntityId: params.laneEntityId,
      eventIds: [allocated.id],
    });
    analysis.participations.push({
      eventId: allocated.id,
      entityId: params.laneEntityId,
      role: params.role ?? 'actor',
      factIds: [],
      origin: 'manual',
    });
  } else {
    analysis.unassignedEventIds.push(allocated.id);
  }

  const sigs = computeDAGSignatures({ events: analysis.events, relations: analysis.relations });
  dag.eventSignature = sigs.eventSignature;
  dag.relationSignature = sigs.relationSignature;
  analysis.eventTimeDAG = dag.toJSON();

  return { analysis, event: newEvent, dag };
}
