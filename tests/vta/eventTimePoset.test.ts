import { describe, expect, it } from 'vitest';
import {
  activeEvents,
  addEventToAnalysis,
  allocateNextEventId,
  buildEventTimeDAG,
  compareEventTime,
  compareEventTimeById,
  computeEventRowMap,
  ensureEventTimeDAG,
  EventTimeDAG,
  isEventBefore,
  setEventIgnored,
} from '../../src/tools/vta/features/vta/utils/eventTimePoset';
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
});
