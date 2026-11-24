import { describe, expect, it } from 'vitest';
import {
  activeEvents,
  addEventToAnalysis,
  allocateNextEventId,
  buildEventTimeDAG,
  compareEventTime,
  compareEventTimeById,
  compareTimeIntervals,
  computeEventRowMap,
  ensureEventTimeDAG,
  EventTimeDAG,
  isEventBefore,
  parseTimeInterval,
  parseTimeScore,
  setEventIgnored,
} from '../../src/tools/vta/features/vta/utils/eventTimePoset';
import { inspectLedger, parseLedger } from '../../src/tools/vta/features/vta/utils/eventLedger';
import {
  createManualAnalysis,
  projectAnalysis,
  reconcileAnalysis,
  validateSavedAnalysis,
} from '../../src/tools/vta/features/vta/utils/eventAnalysis';
import { calculateVTALayout, computeTimeRanks, INTRA_RANK_GAP } from '../../src/tools/vta/features/vta/utils/layout';
import { MAX_TIME_NODES, type VTAAnalysisData, type VTASchema } from '../../src/tools/vta/types/vta';

describe('EventTimeDAG - Skew-Symmetric 2D Order Matrix & Row/Cell Layout', () => {
  it('maintains skew-symmetric matrix[u][v] (+1/+2, -1/-2, 0) and resolves u ≺ v and v ≺ u in a single lookup', () => {
    const dag = new EventTimeDAG(4);
    expect(dag.addPrecedenceEdge(0, 1)).toBe(true);
    expect(dag.addPrecedenceEdge(1, 2)).toBe(true);

    // Direct edges: +1 forward, -1 reverse
    expect(dag.matrix[0][1]).toBe(1);
    expect(dag.matrix[1][0]).toBe(-1);
    expect(dag.matrix[1][2]).toBe(1);
    expect(dag.matrix[2][1]).toBe(-1);

    // Transitive edges: +2 forward, -2 reverse
    expect(dag.matrix[0][2]).toBe(2);
    expect(dag.matrix[2][0]).toBe(-2);

    // Unordered node 3: 0 in both directions
    expect(dag.matrix[0][3]).toBe(0);
    expect(dag.matrix[3][0]).toBe(0);

    // Single lookup comparison via compareNodes(u, v) using only matrix[u][v]
    expect(dag.compareNodes(0, 2)).toBe('before');
    expect(dag.compareNodes(2, 0)).toBe('after');
    expect(dag.compareNodes(1, 1)).toBe('simultaneous');
    expect(dag.compareNodes(0, 3)).toBe('incomparable');

    // Cycle rejection: since 0 ≺ 2 (matrix[2][0] === -2 < 0), 2 -> 0 is rejected
    expect(dag.canAddPrecedence(2, 0)).toBe(false);
    expect(dag.addPrecedenceEdge(2, 0)).toBe(false);
  });

  it('allows multiple simultaneous events to share one integer timeNodeId and enforces MAX_TIME_NODES = 400', () => {
    const events: import('../../src/tools/vta/types/vta').VTAEvent[] = [
      { id: 'E1', title: '同時事象A', description: '', time: '10:00', sourceOrder: 0, classification: 'normal' },
      { id: 'E2', title: '同時事象B', description: '', time: '10:00', sourceOrder: 1, classification: 'normal' },
      { id: 'E3', title: '後続事象C', description: '', time: '10:05', sourceOrder: 2, classification: 'variation' },
    ];
    const dag = buildEventTimeDAG(events, [], []);
    expect(events[0].timeNodeId).toBe(0);
    expect(events[1].timeNodeId).toBe(0);
    expect(events[2].timeNodeId).toBe(1);
    expect(dag.nodeCount).toBe(2);

    expect(compareEventTime(dag, events[0], events[1])).toBe('simultaneous');
    expect(compareEventTime(dag, events[0], events[2])).toBe('before');
    expect(compareEventTime(dag, events[2], events[1])).toBe('after');
    expect(isEventBefore(dag, events[0], events[2])).toBe(true);

    // Enforces MAX_TIME_NODES = 400
    const fullDag = new EventTimeDAG(MAX_TIME_NODES);
    expect(() => fullDag.insertTimeNode()).toThrow(`${MAX_TIME_NODES}`);
    expect(() => new EventTimeDAG(MAX_TIME_NODES + 1)).toThrow(`${MAX_TIME_NODES}`);
  });

  it('allocates sequential unique event IDs in addition order independent of temporal order and updates DAG on insertion', () => {
    const baseSchema: VTASchema = {
      lanes: ['管制塔', 'A機'],
      nodes: [
        { id: 'card_1', lane: '管制塔', time: '10:00', title: '初期指示', description: '', type: 'normal', measure_type: null },
        { id: 'card_2', lane: 'A機', time: '10:10', title: '滑走路進入', description: '', type: 'variation', measure_type: null },
      ],
      edges: [{ source: 'card_1', target: 'card_2', direction: 'unidirectional' }],
    };
    const analysis = createManualAnalysis(baseSchema);
    expect(analysis.events.map((e) => e.id)).toEqual(['E1', 'E2']);
    expect(compareEventTimeById(analysis, 'E1', 'E2')).toBe('before');

    // Add a 3rd event (E3) that occurred temporally BETWEEN E1 and E2
    const { event: e3, dag } = addEventToAnalysis(analysis, {
      title: '中間復唱イベント',
      time: '10:05',
      laneEntityId: analysis.entities[1].id,
      afterEventIds: ['E1'],
      beforeEventIds: ['E2'],
    });

    // Event ID is E3 (addition order), while temporal order is E1 ≺ E3 ≺ E2
    expect(e3.id).toBe('E3');
    expect(e3.sourceOrder).toBe(2);
    expect(compareEventTimeById(analysis, 'E1', 'E3', dag)).toBe('before');
    expect(compareEventTimeById(analysis, 'E3', 'E2', dag)).toBe('before');
    expect(compareEventTimeById(analysis, 'E2', 'E3', dag)).toBe('after');
    expect(dag.matrix[analysis.events[0].timeNodeId!][analysis.events[1].timeNodeId!]).toBe(2); // transitive +2

    const rowMap = computeEventRowMap(analysis, dag);
    expect(rowMap.get('E1')).toBe(0);
    expect(rowMap.get('E3')).toBe(1);
    expect(rowMap.get('E2')).toBe(2);

    // Add a 4th event (E4) simultaneous with E3
    const { event: e4 } = addEventToAnalysis(analysis, {
      title: '同時監視イベント',
      laneEntityId: analysis.entities[0].id,
      simultaneousWithEventId: 'E3',
    });
    expect(e4.id).toBe('E4');
    expect(e4.timeNodeId).toBe(e3.timeNodeId);
    expect(compareEventTimeById(analysis, 'E3', 'E4')).toBe('simultaneous');
    expect(allocateNextEventId(analysis).id).toBe('E5');
  });

  it('places unordered events in the same Row & Cell and expands the Row height when multiple events share a Cell', () => {
    const schema: VTASchema = {
      lanes: ['部門A', '部門B'],
      nodes: [
        { id: 'n_early', lane: '部門A', time: '09:00', title: '事前作業', description: '', type: 'normal', measure_type: null },
        { id: 'n_cell_1', lane: '部門A', time: '10:00', title: '同時作業1', description: '', type: 'normal', measure_type: null },
        { id: 'n_cell_2', lane: '部門A', time: '10:00', title: '同時作業2', description: '', type: 'variation', measure_type: null },
        { id: 'n_other_lane', lane: '部門B', time: '10:00', title: '他部門同時作業', description: '', type: 'normal', measure_type: null },
      ],
      edges: [],
    };

    const ranks = computeTimeRanks(schema);
    expect(ranks.get('n_early')).toBe(0);
    expect(ranks.get('n_cell_1')).toBe(1);
    expect(ranks.get('n_cell_2')).toBe(1);
    expect(ranks.get('n_other_lane')).toBe(1);

    const layout = calculateVTALayout(schema);
    expect(layout.rowBounds).toBeDefined();
    expect(layout.cells).toBeDefined();

    const row0 = layout.rowBounds!.find((r) => r.row === 0)!;
    const row1 = layout.rowBounds!.find((r) => r.row === 1)!;

    // Row 1 contains a Cell (部門A, row 1) with 2 stacked events, so Row 1 height > Row 0 height + INTRA_RANK_GAP
    expect(row1.height).toBeGreaterThanOrEqual(row0.height * 2 + INTRA_RANK_GAP);

    const cellA1 = layout.cells!.find((c) => c.row === 1 && c.lane === '部門A')!;
    const cellB1 = layout.cells!.find((c) => c.row === 1 && c.lane === '部門B')!;
    expect(cellA1.nodeIds).toEqual(['n_cell_1', 'n_cell_2']);
    expect(cellB1.nodeIds).toEqual(['n_other_lane']);
    expect(cellA1.height).toBe(row1.height);
    expect(cellB1.height).toBe(row1.height);
  });

  it('retains ignored events without deleting them and preserves transitive temporal order across ignored events', () => {
    const analysis: VTAAnalysisData = {
      version: 5,
      sources: [
        {
          id: 'source_1',
          text: '09:00 事象1。\n09:05 事象2。\n09:10 事象3。',
          paragraphs: [
            { id: 'p1', text: '09:00 事象1。' },
            { id: 'p2', text: '09:05 事象2。' },
            { id: 'p3', text: '09:10 事象3。' },
          ],
        },
      ],
      events: [
        { id: 'E1', title: '事象1', description: '', time: '09:00', sourceOrder: 0, classification: 'normal', sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }] },
        { id: 'E2', title: '事象2', description: '', time: '09:05', sourceOrder: 1, classification: 'normal', sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p2' }] },
        { id: 'E3', title: '事象3', description: '', time: '09:10', sourceOrder: 2, classification: 'variation', sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p3' }] },
      ],
      entities: [{ id: 'ent_1', name: '担当者', kind: 'person' }],
      participations: [
        { eventId: 'E1', entityId: 'ent_1', role: 'actor', sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }] },
        { eventId: 'E2', entityId: 'ent_1', role: 'actor', sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p2' }] },
        { eventId: 'E3', entityId: 'ent_1', role: 'actor', sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p3' }] },
      ],
      relations: [
        { id: 'r1', sourceEventId: 'E1', targetEventId: 'E2', kind: 'before', sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }] },
        { id: 'r2', sourceEventId: 'E2', targetEventId: 'E3', kind: 'before', sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p2' }] },
      ],
      cards: [
        { id: 'c1', laneEntityId: 'ent_1', eventIds: ['E1'] },
        { id: 'c2', laneEntityId: 'ent_1', eventIds: ['E2'] },
        { id: 'c3', laneEntityId: 'ent_1', eventIds: ['E3'] },
      ],
      unassignedEventIds: [],
    };

    ensureEventTimeDAG(analysis);
    setEventIgnored(analysis, 'E2', true, 'user');

    // E2 is not deleted from analysis.events
    expect(analysis.events).toHaveLength(3);
    expect(analysis.events.find((e) => e.id === 'E2')?.ignored).toBe(true);
    expect(activeEvents(analysis).map((e) => e.id)).toEqual(['E1', 'E3']);

    // Transitive order E1 ≺ E3 is preserved even when E2 is ignored
    expect(compareEventTimeById(analysis, 'E1', 'E3')).toBe('before');
    const rowMap = computeEventRowMap(analysis);
    expect(rowMap.has('E2')).toBe(false);
    expect(rowMap.get('E1')).toBe(0);
    expect(rowMap.get('E3')).toBe(1);

    // Projecting analysis omits ignored E2 from canvas nodes while keeping E2 in analysis.events
    const projected = projectAnalysis(analysis);
    expect(projected.nodes.map((n) => n.id)).toEqual(['c1', 'c3']);
    expect(() => validateSavedAnalysis(projected.analysis)).not.toThrow();

    // Deleting a node on canvas via reconcileAnalysis marks its event ignored rather than deleting it
    setEventIgnored(analysis, 'E2', false);
    const fullSchema = projectAnalysis(analysis);
    const afterCanvasDelete = reconcileAnalysis(fullSchema, {
      ...fullSchema,
      nodes: fullSchema.nodes.filter((n) => n.id !== 'c2'),
      edges: fullSchema.edges.filter((e) => e.source !== 'c2' && e.target !== 'c2'),
    });
    expect(afterCanvasDelete.analysis?.events).toHaveLength(3);
    expect(afterCanvasDelete.analysis?.events.find((e) => e.id === 'E2')?.ignored).toBe(true);
    expect(afterCanvasDelete.analysis?.events.find((e) => e.id === 'E2')?.ignoreReason).toBe('user');
  });

  it('parses parenthetical seconds in JTSB-style timestamps cleanly in parseTimeScore', () => {
    const t44 = parseTimeScore('2024-01-02 17:44(56秒)')!;
    const t45a = parseTimeScore('2024-01-02 17:45(11〜18秒)')!;
    const t45b = parseTimeScore('2024-01-02 17:45(18〜25秒)')!;
    expect(t44).toBeLessThan(t45a);
    expect(t45a).toBeLessThan(t45b);

    const clockA = parseTimeScore('17:45(11〜18秒)')!;
    const clockB = parseTimeScore('17:45 (18〜25秒)以降')!;
    expect(clockA).toBeLessThan(clockB);
  });

  it('represents date-with-unknown-time ("2024-01-02 -") as a full-day interval without merging or fabricating midnight', () => {
    // parseTimeScore must return null for date-only / unknown-time strings so midnight 00:00:00 is never fabricated
    expect(parseTimeScore('2024-01-02 -')).toBeNull();
    expect(parseTimeScore('2024-01-02 時刻記録なし')).toBeNull();
    expect(parseTimeScore('2024-01-02')).toBeNull();

    // parseTimeInterval preserves day-level interval [00:00:00.000, 23:59:59.999] with exactPoint: false
    const day1 = parseTimeInterval('2024-01-01 16:11')!;
    const day2Unknown = parseTimeInterval('2024-01-02 -')!;
    const day2Clock = parseTimeInterval('2024-01-02 17:47(27秒)')!;
    expect(day2Unknown.exactPoint).toBe(false);
    expect(compareTimeIntervals(day1, day2Unknown)).toBe('before');
    expect(compareTimeIntervals(day2Unknown, day2Clock)).toBe('incomparable');

    // Adjacent JTSB intervals sharing a boundary second (11~18s and 18~25s) are incomparable by strict interval order
    // and fall back to intra-lane sourceOrder when on the same lane
    const adjA = parseTimeInterval('2024-01-02 17:45(11〜18秒)')!;
    const adjB = parseTimeInterval('2024-01-02 17:45(18〜25秒)')!;
    expect(compareTimeIntervals(adjA, adjB)).toBe('incomparable');

    // Cross-axis intervals (epoch vs clock) are never falsely ordered
    const clockOnly = parseTimeInterval('17:50')!;
    expect(compareTimeIntervals(day1, clockOnly)).toBe('incomparable');
  });

  it('prevents "2024-01-02 -" and "17:48以降" events from collapsing into a single timeNodeId and preserves chronological order', () => {
    const events: import('../../src/tools/vta/types/vta').VTAEvent[] = [
      { id: 'E6', title: 'APU再停止', description: '', time: '2024-01-02 16:43ごろ', sourceOrder: 0, classification: 'variation' },
      { id: 'E7', title: '電源車使用決定', description: '', time: '2024-01-02 -', sourceOrder: 1, classification: 'normal' },
      { id: 'E8', title: '機長への報告', description: '', time: '2024-01-02 -', sourceOrder: 2, classification: 'normal' },
      { id: 'E9', title: '管制承認要求', description: '', time: '2024-01-02 17:25:15', sourceOrder: 3, classification: 'normal' },
      { id: 'E33', title: '火災・大破', description: '', time: '2024-01-02 17:47(27秒)', sourceOrder: 4, classification: 'outcome' },
      { id: 'E38', title: '死亡確認', description: '', time: '2024-01-02 -', sourceOrder: 5, classification: 'outcome' },
      { id: 'E39', title: '消火活動A', description: '', time: '2024-01-02 17:48以降', sourceOrder: 6, classification: 'normal' },
      { id: 'E40', title: '消火活動B', description: '', time: '2024-01-02 17:48以降', sourceOrder: 7, classification: 'normal' },
    ];
    const participations: import('../../src/tools/vta/types/vta').VTAParticipation[] = events.map((e) => ({
      eventId: e.id,
      entityId: 'ACREW',
      role: 'actor',
      factIds: [],
    }));
    const relations: import('../../src/tools/vta/types/vta').VTAEventRelation[] = [
      { id: 'R4', sourceEventId: 'E6', targetEventId: 'E7', kind: 'before', factIds: [] },
      { id: 'R5', sourceEventId: 'E7', targetEventId: 'E8', kind: 'before', factIds: [] },
      { id: 'R6', sourceEventId: 'E8', targetEventId: 'E9', kind: 'before', factIds: [] },
      { id: 'R27', sourceEventId: 'E33', targetEventId: 'E38', kind: 'before', factIds: [] },
    ];

    const dag = buildEventTimeDAG(events, participations, relations);

    // Distinct timeNodeIds for E7, E8, E38 ("2024-01-02 -") and E39, E40 ("2024-01-02 17:48以降")
    const nodeIds = events.map((e) => e.timeNodeId);
    expect(new Set(nodeIds).size).toBe(events.length);

    // E6 (16:43) ≺ E7 ≺ E8 ≺ E9 (17:25:15) ≺ E33 (17:47) ≺ E38
    expect(compareEventTime(dag, events[0], events[1])).toBe('before');
    expect(compareEventTime(dag, events[1], events[2])).toBe('before');
    expect(compareEventTime(dag, events[2], events[3])).toBe('before');
    expect(compareEventTime(dag, events[3], events[4])).toBe('before');
    expect(compareEventTime(dag, events[4], events[5])).toBe('before');

    // Cached DAG with legacy v1 signature is automatically invalidated and rebuilt by ensureEventTimeDAG
    const staleAnalysis: VTAAnalysisData = {
      version: 5,
      sources: [],
      facts: [],
      events: events.map((e) => ({ ...e, timeNodeId: 0 })),
      entities: [{ id: 'ACREW', name: 'Ａ機運航乗務員班', kind: 'organization' }],
      participations,
      relations,
      cards: events.map((e, i) => ({ id: `card_${i + 1}`, laneEntityId: 'ACREW', eventIds: [e.id] })),
      unassignedEventIds: [],
      eventTimeDAG: {
        nodeCount: 1,
        matrix: [[0]],
        eventSignature: 'legacy_v1_sig',
        relationSignature: 'legacy_v1_rel_sig',
      },
    };
    const rebuilt = ensureEventTimeDAG(staleAnalysis);
    expect(rebuilt.nodeCount).toBe(events.length);
    expect(compareEventTimeById(staleAnalysis, 'E9', 'E33')).toBe('before');
    expect(compareEventTimeById(staleAnalysis, 'E33', 'E38')).toBe('before');
  });

  it('builds EventTimeDAG during normalization (inspectLedger) and reports soft temporal_inversion when a relation contradicts explicit timestamps', () => {
    const source: import('../../src/tools/vta/types/vta').VTASource = {
      id: 'source_1',
      text: '10:00 事象A。\n10:30 事象B。',
      paragraphs: [
        { id: 'p1', text: '10:00 事象A。' },
        { id: 'p2', text: '10:30 事象B。' },
      ],
    };
    const raw = [
      '[主体]',
      'ID\t名称\t種類\t報告焦点\t所属・上位主体\t焦点根拠',
      'A1\t作業班\torganization\tprimary\t-\tp1',
      '[イベント]',
      'ID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分',
      'E1\t2024-01-02 10:00\t事象A\t10時00分の作業\tA1:actor\tp1\trecorded',
      'E2\t2024-01-02 10:30\t事象B\t10時30分の作業\tA1:actor\tp2\trecorded',
      '[関係]',
      'ID\t種類\t元イベント\t元主体\t先イベント\t先主体\t原文参照\tリソース\t実施状態\t受領確認',
      'R1\tbefore\tE2\t-\tE1\t-\tp1,p2\t-\t-\tna',
      '[共有カード]',
      'ID\t主体\tイベント',
      '[整理]',
      'ID\t区分\t原文参照\t要旨\t理由',
      '[帰結]',
      'ID\t判定\tイベントID\t原文参照\t理由',
      'out1\tidentified\tE2:loss\tp2\t事象B',
      '[完了]',
    ].join('\n');

    const doc = parseLedger(raw);
    const result = inspectLedger(doc, source);

    // Evaluates as a softIssue (repairable without aborting if unfixed), while analysis.eventTimeDAG is already populated and orders E1 ≺ E2 by explicit interval
    expect(result.issues).toHaveLength(0);
    expect(result.softIssues?.some((i) => i.code === 'temporal_inversion' && i.row.id === 'R1')).toBe(true);
    expect(result.analysis?.eventTimeDAG).toBeDefined();
    expect(compareEventTimeById(result.analysis!, 'E1', 'E2')).toBe('before');
  });
});
