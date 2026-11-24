import { describe, expect, it, beforeEach } from 'vitest';
import { useVTAStore } from './vtaStore';
import { detectGranularityProposals } from '../utils/subjectGranularityProposals';
import { canDrilldownEntity, visibleSchema } from '../utils/presentation';
import { projectAnalysis } from '../utils/eventAnalysis';
import { auditVTALayoutGeometry, calculateVTALayout } from '../utils/layout';
import { graphDiagnostics } from '../utils/graphDiagnostics';
import { getSharedEdgeLayout } from '../components/VTAEdge';
import { createDebugRecorder } from '../../../services/debugRecorder';
import type { VTAAnalysisData, VTASchema } from '../../../types/vta';

function buildMultiEntityConsolidatedFixture(): VTAAnalysisData {
  const originalEntities = [
    { id: 'JCG', name: '海上保安庁', kind: 'organization' as const, focus: 'mid' as const },
    { id: 'JCG_HQ', name: '海保本庁', kind: 'organization' as const, parentEntityId: 'JCG', focus: 'low' as const },
    { id: 'JCG_3RD', name: '第三管区', kind: 'organization' as const, parentEntityId: 'JCG', focus: 'low' as const },
    { id: 'CAPT_A', name: '機長A', kind: 'person' as const, parentEntityId: 'JCG', focus: 'high' as const },
    { id: 'CAB_AT', name: '東京空港事務所', kind: 'organization' as const, focus: 'mid' as const },
    { id: 'TWR_W', name: 'タワー西', kind: 'person' as const, parentEntityId: 'CAB_AT', focus: 'low' as const },
    { id: 'TWR_E', name: 'タワー東', kind: 'person' as const, parentEntityId: 'CAB_AT', focus: 'high' as const },
    { id: 'B_CREW', name: 'B機運航乗務員', kind: 'person' as const, focus: 'high' as const },
    { id: 'B_CABIN', name: 'B機客室乗務員', kind: 'person' as const, focus: 'high' as const },
    { id: 'B_PAX', name: 'B機乗客', kind: 'person' as const, focus: 'mid' as const },
  ];

  // Current state after ADR-0079/0080 hill-climbing:
  // JCG_HQ & JCG_3RD -> JCG, TWR_W -> CAB_AT; CAPT_A, TWR_E, B_CREW, B_CABIN, B_PAX remain distinct!
  return {
    version: 5,
    sources: [
      {
        id: 'source_1',
        text: 'p1 text\np2 text\np3 text\np4 text',
        paragraphs: [
          { id: 'p1', text: 'p1 text' },
          { id: 'p2', text: 'p2 text' },
          { id: 'p3', text: 'p3 text' },
          { id: 'p4', text: 'p4 text' },
        ],
      },
    ],
    facts: [
      { id: 'F1', text: 'fact 1', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p1', quote: 'p1 text' }] },
      { id: 'F2', text: 'fact 2', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p2', quote: 'p2 text' }] },
      { id: 'F3', text: 'fact 3', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p3', quote: 'p3 text' }] },
      { id: 'F4', text: 'fact 4', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p4', quote: 'p4 text' }] },
    ],
    events: [
      { id: 'E1', sourceOrder: 0, time: '17:43:00', title: '離陸許可発出', description: '着陸許可', factIds: ['F1'], classification: 'normal' },
      { id: 'E2', sourceOrder: 1, time: '17:45:10', title: '滑走路誤進入', description: '誤進入', factIds: ['F2'], classification: 'variation' },
      { id: 'E3', sourceOrder: 2, time: '17:47:27', title: '両機衝突', description: '衝突', factIds: ['F3'], classification: 'outcome', outcome_kind: 'loss' },
      { id: 'E4', sourceOrder: 3, time: '17:47:28', title: '両機火災発生', description: '火災', factIds: ['F3'], classification: 'outcome', outcome_kind: 'loss' },
      { id: 'E5', sourceOrder: 4, time: '17:48:00', title: 'インターホン連絡試行', description: '連絡試行', factIds: ['F4'], classification: 'normal' },
      { id: 'E6', sourceOrder: 5, time: '17:55:00', title: '対策本部設置', description: '設置', factIds: ['F4'], classification: 'normal' },
    ],
    entities: [
      { id: 'JCG', name: '海上保安庁', kind: 'organization', focus: 'mid', mergedFrom: ['JCG_HQ', 'JCG_3RD'] },
      { id: 'CAPT_A', name: '機長A', kind: 'person', parentEntityId: 'JCG', focus: 'high' },
      { id: 'CAB_AT', name: '東京空港事務所', kind: 'organization', focus: 'mid', mergedFrom: ['TWR_W'] },
      { id: 'TWR_E', name: 'タワー東', kind: 'person', parentEntityId: 'CAB_AT', focus: 'high' },
      { id: 'B_CREW', name: 'B機運航乗務員', kind: 'person', focus: 'high' },
      { id: 'B_CABIN', name: 'B機客室乗務員', kind: 'person', focus: 'high' },
      { id: 'B_PAX', name: 'B機乗客', kind: 'person', focus: 'mid' },
    ],
    participations: [
      { eventId: 'E1', entityId: 'TWR_E', role: 'actor', factIds: ['F1'] },
      { eventId: 'E1', entityId: 'B_CREW', role: 'confirmed_recipient', factIds: ['F1'] },
      { eventId: 'E1', entityId: 'CAB_AT', role: 'actor', factIds: ['F1'], mergedFrom: [{ entityId: 'TWR_W', role: 'actor' }] },
      { eventId: 'E2', entityId: 'CAPT_A', role: 'actor', factIds: ['F2'] },
      { eventId: 'E3', entityId: 'CAPT_A', role: 'affected', factIds: ['F3'] },
      { eventId: 'E3', entityId: 'B_CREW', role: 'target', factIds: ['F3'] },
      { eventId: 'E4', entityId: 'B_CABIN', role: 'affected', factIds: ['F3'] },
      { eventId: 'E4', entityId: 'B_PAX', role: 'target', factIds: ['F3'] },
      { eventId: 'E5', entityId: 'B_CREW', role: 'actor', factIds: ['F4'] },
      { eventId: 'E6', entityId: 'JCG', role: 'actor', factIds: ['F4'], mergedFrom: [{ entityId: 'JCG_HQ', role: 'actor' }, { entityId: 'JCG_3RD', role: 'actor' }] },
    ],
    relations: [
      {
        id: 'proposal:twr-to-b',
        kind: 'transfer',
        sourceEventId: 'E1',
        sourceEntityId: 'TWR_E',
        targetEventId: 'E1',
        targetEntityId: 'B_CREW',
        resource: 'information',
        status: 'occurred',
        receipt: 'confirmed',
        sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p1' }],
      },
      {
        id: 'R26',
        kind: 'impact',
        sourceEventId: 'E3',
        sourceEntityId: 'B_CREW',
        targetEventId: 'E3',
        targetEntityId: 'CAPT_A',
        resource: 'other',
        status: 'occurred',
        receipt: 'na',
        sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p3' }],
      },
      {
        id: 'R27',
        kind: 'impact',
        sourceEventId: 'E3',
        sourceEntityId: 'B_CREW',
        targetEventId: 'E5',
        targetEntityId: 'B_CREW',
        resource: 'other',
        status: 'occurred',
        receipt: 'na',
        sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p4' }],
      },
    ],
    cards: [
      { id: 'card_twr_e1', laneEntityId: 'TWR_E', eventIds: ['E1'] },
      { id: 'card_bcrew_e1', laneEntityId: 'B_CREW', eventIds: ['E1'] },
      { id: 'card_cab_e1', laneEntityId: 'CAB_AT', eventIds: ['E1'] },
      { id: 'card_capt_e2', laneEntityId: 'CAPT_A', eventIds: ['E2'] },
      { id: 'card_capt_e3', laneEntityId: 'CAPT_A', eventIds: ['E3'] },
      { id: 'card_bcrew_e3', laneEntityId: 'B_CREW', eventIds: ['E3'] },
      { id: 'card_bcabin_e4', laneEntityId: 'B_CABIN', eventIds: ['E4'] },
      { id: 'card_bpax_e4', laneEntityId: 'B_PAX', eventIds: ['E4'] },
      { id: 'card_bcrew_e5', laneEntityId: 'B_CREW', eventIds: ['E5'] },
      { id: 'card_jcg_e6', laneEntityId: 'JCG', eventIds: ['E6'] },
    ],
    unassignedEventIds: [],
    outcome: {
      status: 'identified',
      kind: 'loss',
      eventIds: ['E3', 'E4'],
      sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p3' }],
      reason: '衝突および火災',
    },
    subjectPoset: {
      nodes: originalEntities.map((e) => e.id),
      aliases: {},
      relations: [
        { childId: 'JCG_HQ', parentId: 'JCG' },
        { childId: 'JCG_3RD', parentId: 'JCG' },
        { childId: 'CAPT_A', parentId: 'JCG' },
        { childId: 'TWR_W', parentId: 'CAB_AT' },
        { childId: 'TWR_E', parentId: 'CAB_AT' },
      ],
    },
    subjectRanking: {
      version: 1,
      maxSubjects: 5,
      weights: { A: 0.3, O: 0.25, F: 0.2, C: 0.15, T: 0.1 },
      originalEntities,
      ranks: [
        { entityId: 'CAPT_A', rank: 1, score: 0.9, breakdown: { A: 0.9, O: 1, F: 1, C: 0.5, T: 0.5 }, retained: true, reason: '上位保持' },
        { entityId: 'B_CREW', rank: 2, score: 0.85, breakdown: { A: 0.8, O: 1, F: 1, C: 0.8, T: 0.5 }, retained: true, reason: '上位保持' },
        { entityId: 'TWR_E', rank: 3, score: 0.8, breakdown: { A: 0.8, O: 0, F: 1, C: 0.8, T: 0.5 }, retained: true, reason: '上位保持' },
        { entityId: 'B_CABIN', rank: 4, score: 0.7, breakdown: { A: 0.6, O: 1, F: 1, C: 0.3, T: 0.5 }, retained: true, reason: '上位保持' },
        { entityId: 'B_PAX', rank: 5, score: 0.5, breakdown: { A: 0.3, O: 1, F: 0.5, C: 0.2, T: 0.5 }, retained: true, reason: '上位保持' },
        { entityId: 'JCG', rank: 6, score: 0.3, breakdown: { A: 0.3, O: 0, F: 0.5, C: 0.2, T: 0.3 }, retained: true, reason: '上位保持' },
        { entityId: 'CAB_AT', rank: 7, score: 0.3, breakdown: { A: 0.3, O: 0, F: 0.5, C: 0.2, T: 0.3 }, retained: true, reason: '上位保持' },
        { entityId: 'JCG_HQ', rank: 8, score: 0.15, breakdown: { A: 0.2, O: 0, F: 0.1, C: 0.1, T: 0.1 }, retained: false, mergedInto: 'JCG', reason: 'JCGへ統合' },
        { entityId: 'JCG_3RD', rank: 9, score: 0.12, breakdown: { A: 0.2, O: 0, F: 0.1, C: 0.1, T: 0.1 }, retained: false, mergedInto: 'JCG', reason: 'JCGへ統合' },
        { entityId: 'TWR_W', rank: 10, score: 0.14, breakdown: { A: 0.2, O: 0, F: 0.1, C: 0.1, T: 0.1 }, retained: false, mergedInto: 'CAB_AT', reason: 'CAB_ATへ統合' },
      ],
    },
  };
}

describe('ADR-0081: Local manual lane merge/split, geometry cache, and interleaved spine absorption', () => {
  beforeEach(() => {
    const analysis = buildMultiEntityConsolidatedFixture();
    const schema = projectAnalysis(analysis);
    const layout = calculateVTALayout(schema, undefined, undefined, { forceRecompute: true });
    useVTAStore.setState({
      vtaData: schema,
      nodes: layout.nodes,
      edges: layout.edges,
      laneBounds: layout.laneBounds,
      subjectLimit: 5,
      past: [],
      future: [],
    });
  });

  it('merges B-aircraft crew locally without destroying unrelated protagonist lanes or shrinking crew cards into 24px machine dots', () => {
    const initialData = useVTAStore.getState().vtaData;
    const proposals = detectGranularityProposals(initialData.analysis!);
    const crewMerge = proposals.merges.find((p) => p.category === 'vehicle_crew' && p.suggestedTargetName === 'Ｂ機');
    expect(crewMerge).toBeDefined();
    expect(crewMerge!.suggestedKind).toBe('organization');

    const t0 = performance.now();
    useVTAStore.getState().applyLaneMergeProposal(crewMerge!, 'Ｂ機');
    const elapsedMs = performance.now() - t0;
    expect(elapsedMs).toBeLessThan(200);

    const state = useVTAStore.getState();
    const nextAnalysis = state.vtaData.analysis!;

    // Unrelated protagonists (CAPT_A, TWR_E) and existing consolidations (JCG, CAB_AT) stay completely untouched!
    expect(state.vtaData.lanes).toContain('機長A');
    expect(state.vtaData.lanes).toContain('タワー東');
    expect(state.vtaData.lanes).toContain('海上保安庁');
    expect(state.vtaData.lanes).toContain('東京空港事務所');
    expect(state.vtaData.lanes).toContain('Ｂ機');
    expect(state.vtaData.lanes).not.toContain('B機運航乗務員');
    expect(state.vtaData.lanes).not.toContain('B機客室乗務員');
    expect(state.vtaData.lanes).not.toContain('海保本庁');
    expect(state.vtaData.lanes).not.toContain('タワー西');

    // Merged B機 entity is 'organization', so E1 recipient card is NOT shrunk to a 24px machine dot
    // and cross-lane E1 transfer has zero downward backward drop!
    const mergedEnt = nextAnalysis.entities.find((e) => e.name === 'Ｂ機')!;
    expect(mergedEnt.kind).toBe('organization');
    expect(canDrilldownEntity(mergedEnt.id, nextAnalysis)).toBe(true);

    const audit = auditVTALayoutGeometry(state.vtaData, {
      nodes: state.nodes,
      edges: state.edges,
      laneBounds: state.laneBounds,
    });
    expect(audit.backwardCrossLaneEdges).toEqual([]);
    expect(audit.closeParallelVerticalEdges).toEqual([]);

    // Non-adjacent interleaved same-origin relation R27 (E3 -> E5 on Ｂ機 with E4 interleaved) is absorbed into the spine
    expect(state.vtaData.edges.some((e) => e.relationId === 'R27')).toBe(false);
    const gDiag = graphDiagnostics(state.vtaData);
    expect(gDiag.missingRelations).not.toContain('R27');

    // OLAP drill-down on manually merged Ｂ機 expands its sub-lanes properly
    useVTAStore.getState().setLaneDrilldown(mergedEnt.id, true);
    const drilledVis = visibleSchema(useVTAStore.getState().vtaData);
    expect(drilledVis.lanes.some((l) => l.includes('B機運航乗務員'))).toBe(true);
    expect(drilledVis.lanes.some((l) => l.includes('B機客室乗務員'))).toBe(true);
  });

  it('splits a consolidated lane locally without disturbing any other lane consolidation and preserves Stage 3 proposal relations', () => {
    // First merge B_CREW + B_CABIN into Ｂ機
    const initialProposals = detectGranularityProposals(useVTAStore.getState().vtaData.analysis!);
    const crewMerge = initialProposals.merges.find((p) => p.suggestedTargetName === 'Ｂ機')!;
    useVTAStore.getState().applyLaneMergeProposal(crewMerge, 'Ｂ機');

    // Now split Ｂ機 back out via split proposal
    const postMergeAnalysis = useVTAStore.getState().vtaData.analysis!;
    const mergedEnt = postMergeAnalysis.entities.find((e) => e.name === 'Ｂ機')!;
    useVTAStore.getState().applyLaneSplitProposal({
      id: 'split_b',
      type: 'split',
      parentEntityId: mergedEnt.id,
      parentEntityName: 'Ｂ機',
      splitEntityIds: ['B_CREW', 'B_CABIN'],
      splitEntityNames: ['B機運航乗務員', 'B機客室乗務員'],
      internalRelationsCount: 0,
      reason: '展開テスト',
      category: 'high_activity',
    });

    const afterSplit = useVTAStore.getState().vtaData;
    expect(afterSplit.lanes).toContain('B機運航乗務員');
    expect(afterSplit.lanes).toContain('B機客室乗務員');
    expect(afterSplit.lanes).not.toContain('Ｂ機');
    // Unrelated consolidations (JCG_HQ -> JCG, TWR_W -> CAB_AT) remain consolidated!
    expect(afterSplit.lanes).toContain('海上保安庁');
    expect(afterSplit.lanes).not.toContain('海保本庁');
    expect(afterSplit.lanes).not.toContain('タワー西');
    // Stage 3 proposal relation is preserved!
    expect(afterSplit.analysis!.relations.some((r) => r.id === 'proposal:twr-to-b')).toBe(true);
  });

  it('reuses cached edge paths across hover/selection node & edge array clones without re-running routing', () => {
    const { nodes, edges } = useVTAStore.getState();
    const first = getSharedEdgeLayout(nodes, edges, 'dot');

    // Simulate VTACanvas hover/selection creating brand-new nodes and edges arrays with identical geometry
    const hoveredNodes = nodes.map((n, idx) => ({
      ...n,
      selected: idx === 0,
      data: { ...n.data, isHoveredLinked: idx < 2 },
    }));
    const selectedEdges = edges.map((e, idx) => ({
      ...e,
      selected: idx === 0,
    }));

    const second = getSharedEdgeLayout(hoveredNodes, selectedEdges, 'dot');
    expect(second.paths).toBe(first.paths);
    expect(second.geometryKey).toBe(first.geometryKey);

    // Moving a node's Y position invalidates the geometry key and produces fresh paths
    const movedNodes = nodes.map((n, idx) =>
      idx === 0 ? { ...n, position: { x: n.position.x, y: n.position.y + 80 } } : n
    );
    const third = getSharedEdgeLayout(movedNodes, edges, 'dot');
    expect(third.geometryKey).not.toBe(first.geometryKey);
    expect(third.paths).not.toBe(first.paths);
  });

  it('formats sourceRefs cleanly in LAYOUT_BACKWARD_CROSS_LANE_EDGE diagnostics and deduplicates Flight Recorder snapshots', () => {
    const rec = createDebugRecorder();
    const schema: VTASchema = {
      ...useVTAStore.getState().vtaData,
      analysis: {
        ...useVTAStore.getState().vtaData.analysis!,
        fineGrainedBase: {
          entities: useVTAStore.getState().vtaData.analysis!.entities,
          participations: useVTAStore.getState().vtaData.analysis!.participations,
          relations: useVTAStore.getState().vtaData.analysis!.relations,
          cards: useVTAStore.getState().vtaData.analysis!.cards,
        },
      },
    };
    rec.record('project.snapshot', () => ({
      projectId: 'proj_1',
      scenarioText: 'scenario',
      schema,
    }));
    rec.record('layout.audit', () => ({
      backwardIntraLaneEdges: [],
      backwardCrossLaneEdges: [
        {
          id: 'relation:proposal:twr-to-b',
          relationId: 'proposal:twr-to-b',
          sourceLane: 'タワー東',
          targetLane: 'B機運航乗務員',
          source: 'card_twr_e1',
          target: 'card_bcrew_e1',
          sourceCenterY: 100,
          targetCenterY: 220,
          dropPx: 120,
        },
      ],
      detouredIntraLaneEdges: [],
      nonAdjacentIntraLaneEdges: [],
      overlappingIntraLanePairs: [],
      closeParallelHorizontalEdges: [],
      closeParallelVerticalEdges: [],
      overlappingEdgeBadges: [],
    }));

    const flight = rec.getFlightEntries();
    const snap = flight.find((e) => e.stage === 'project.snapshot')!.data as Record<string, unknown>;
    expect(snap.analysis).toBeUndefined();
    expect(((snap.schema as Record<string, unknown>).analysis as Record<string, unknown>).fineGrainedBase).toBeUndefined();

    const md = rec.exportAIDiagnostics('scenario', undefined, { scope: 'all' });
    expect(md).toContain('source_1/p1');
    expect(md).not.toContain('[object Object]');
  });
});
