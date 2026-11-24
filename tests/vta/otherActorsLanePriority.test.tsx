import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LaneManagementPanel } from '../../src/tools/vta/components/control-panel/LaneManagementPanel';
import { useVTAStore } from '../../src/tools/vta/features/vta/store/vtaStore';
import {
  buildAnalysis,
  createManualAnalysis,
  projectAnalysis,
  sourceFromText,
  validateEvents,
  validateFacts,
  validateParticipants,
} from '../../src/tools/vta/features/vta/utils/eventAnalysis';
import { repairLaneConnections } from '../../src/tools/vta/features/vta/utils/laneConnections';
import {
  expandSplitLanesWithPriority,
  isOtherActorsLaneName,
  mergeLaneOrderWithPriority,
  mergeLanesAfterConsolidation,
  OTHER_ACTORS_ENTITY_NAME,
  pickDefaultPrimaryLane,
  prioritizeOtherActorsLanes,
} from '../../src/tools/vta/features/vta/utils/laneOrder';
import { calculateVTALayout, LANE_WIDTH } from '../../src/tools/vta/features/vta/utils/layout';
import { visibleSchema } from '../../src/tools/vta/features/vta/utils/presentation';
import { validateAndSanitizeVTASchema } from '../../src/tools/vta/features/vta/utils/schemaValidator';
import { applyForceMergeTransition, consolidateSubjects } from '../../src/tools/vta/features/vta/utils/subjectRanking';
import type { LaneSplitProposal, VTAEntity, VTASchema } from '../../src/tools/vta/types/vta';

function buildOverflowAnalysis() {
  const source = sourceFromText(
    '09:00 報告者が異常を発見した。\n09:05 現場リーダーが作業を停止した。\n09:10 保守係が点検した。\n09:15 外部業者が資材を納入した。'
  );
  const facts = validateFacts(
    {
      facts: [
        { id: 'f1', text: '報告者が異常を発見した', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p1', quote: '09:00 報告者が異常を発見した。' }] },
        { id: 'f2', text: '現場リーダーが作業を停止した', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p2', quote: '09:05 現場リーダーが作業を停止した。' }] },
        { id: 'f3', text: '保守係が点検した', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p3', quote: '09:10 保守係が点検した。' }] },
        { id: 'f4', text: '外部業者が資材を納入した', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p4', quote: '09:15 外部業者が資材を納入した。' }] },
      ],
    },
    [source]
  );
  const events = validateEvents(
    {
      events: [
        { id: 'e1', title: '発見', description: '異常発見', time: '09:00', factIds: ['f1'], classification: 'normal' },
        { id: 'e2', title: '停止', description: '作業停止', time: '09:05', factIds: ['f2'], classification: 'variation' },
        { id: 'e3', title: '点検', description: '点検実施', time: '09:10', factIds: ['f3'], classification: 'normal' },
        { id: 'e4', title: '納入', description: '資材納入', time: '09:15', factIds: ['f4'], classification: 'normal' },
      ],
    },
    facts
  );
  const parsed = validateParticipants(
    {
      entities: [
        { id: 'A1', name: '報告者（私）', kind: 'person', focus: 'reporter' },
        { id: 'A2', name: '現場リーダー', kind: 'person', focus: 'high' },
        { id: 'A3', name: '保守係', kind: 'person', focus: 'low' },
        { id: 'A4', name: '外部業者', kind: 'organization', focus: 'low' },
      ],
      participations: [
        { eventId: 'e1', entityId: 'A1', role: 'actor', factIds: ['f1'] },
        { eventId: 'e2', entityId: 'A2', role: 'actor', factIds: ['f2'] },
        { eventId: 'e3', entityId: 'A3', role: 'actor', factIds: ['f3'] },
        { eventId: 'e4', entityId: 'A4', role: 'actor', factIds: ['f4'] },
      ],
      relations: [
        { id: 'r1', kind: 'impact', sourceEventId: 'e1', sourceEntityId: 'A1', targetEventId: 'e2', targetEntityId: 'A2', factIds: ['f1'] },
      ],
      cardGroups: [],
    },
    events,
    facts
  );
  const analysis = buildAnalysis(source, facts, events, parsed);
  analysis.outcome = {
    status: 'identified',
    kind: 'loss',
    eventIds: ['e2'],
    reason: '停止事象',
    sourceRefs: [{ sourceId: 'source_1', paragraphId: 'p2' }],
  };
  return analysis;
}

describe('その他の関係者レーン左端優先配置', () => {
  beforeEach(() => {
    useVTAStore.setState({ compactView: false, past: [], future: [], toasts: [] });
  });

  it('「その他の関係者」識別ロジックは名称・専用ID・種別other集約に反応し、一般のaggregate主体を誤認しない', () => {
    const entities: VTAEntity[] = [
      { id: 'A_plane', name: 'Ａ機', kind: 'machine', aggregate: true },
      { id: 'org_branch', name: 'A社の関係者窓口', kind: 'organization' },
      { id: 'subject_others_2', name: '未整理グループ', kind: 'other', aggregate: true },
    ];

    expect(isOtherActorsLaneName(OTHER_ACTORS_ENTITY_NAME)).toBe(true);
    expect(isOtherActorsLaneName('その他の関係者 (2)')).toBe(true);
    expect(isOtherActorsLaneName('未整理グループ', entities)).toBe(true);
    expect(isOtherActorsLaneName('Ａ機', entities)).toBe(false);
    expect(isOtherActorsLaneName('A社の関係者窓口', entities)).toBe(false);

    expect(prioritizeOtherActorsLanes(['報告者', 'Ａ機', 'その他の関係者'], entities)).toEqual([
      'その他の関係者',
      '報告者',
      'Ａ機',
    ]);
    expect(pickDefaultPrimaryLane(['その他の関係者', '現場作業員', '管制塔'], entities)).toBe('現場作業員');
  });

  it('初回統合(consolidateSubjects)ではランキング末尾契約を保ちつつ、projectAnalysisで「その他の関係者」を左端(index 0)に配置する', () => {
    const consolidated = consolidateSubjects(buildOverflowAnalysis(), 3);
    expect(consolidated.entities.at(-1)?.name).toBe(OTHER_ACTORS_ENTITY_NAME);

    const schema = projectAnalysis(consolidated);
    expect(schema.lanes[0]).toBe(OTHER_ACTORS_ENTITY_NAME);
    expect(schema.lanes).toEqual([OTHER_ACTORS_ENTITY_NAME, '報告者（私）', '現場リーダー']);

    const layout = calculateVTALayout(schema);
    expect(layout.laneBounds.map((b) => b.name)).toEqual(schema.lanes);
    expect(layout.laneBounds[0].x).toBeLessThan(layout.laneBounds[1].x);

    // OLAPドリルダウン展開時もindex 0直後にサブレーンが展開され破綻しない
    const othersId = consolidated.entities.find((e) => e.name === OTHER_ACTORS_ENTITY_NAME)!.id;
    const expanded = visibleSchema({
      ...schema,
      presentation: {
        lanes: { [othersId]: 'show' },
        suppressedCards: {},
        drilldownLanes: { [othersId]: true },
      },
    });
    expect(expanded.lanes[0]).toBe(OTHER_ACTORS_ENTITY_NAME);
    expect(expanded.lanes.slice(1, 3)).toEqual(['その他の関係者（保守係）', 'その他の関係者（外部業者）']);

    // 「その他の関係者」レーンには同一レーン内時系列線を生成しない(ADR-0008)
    const repaired = repairLaneConnections(
      schema,
      new Map([[OTHER_ACTORS_ENTITY_NAME, schema.nodes.filter((n) => n.lane === OTHER_ACTORS_ENTITY_NAME).map((n) => n.id)]])
    );
    expect(repaired.schema.edges.filter((e) => e.direction === 'sequential')).toHaveLength(0);
  });

  it('手動移動(moveLane)および保存データ再読込(validateAndSanitizeVTASchema)では既存配置を尊重する', () => {
    const consolidated = consolidateSubjects(buildOverflowAnalysis(), 3);
    const schema = projectAnalysis(consolidated);
    useVTAStore.getState().setVTAData(schema);
    expect(useVTAStore.getState().vtaData.lanes[0]).toBe(OTHER_ACTORS_ENTITY_NAME);

    // 右へ1列移動
    useVTAStore.getState().moveLane(OTHER_ACTORS_ENTITY_NAME, 1);
    const movedLanes = [...useVTAStore.getState().vtaData.lanes];
    expect(movedLanes[1]).toBe(OTHER_ACTORS_ENTITY_NAME);

    // 再投影・バリデーション再読込しても移動済み順序を維持
    const reprojected = projectAnalysis(
      useVTAStore.getState().vtaData.analysis!,
      useVTAStore.getState().vtaData
    );
    expect(reprojected.lanes).toEqual(movedLanes);

    const validated = validateAndSanitizeVTASchema(
      JSON.parse(JSON.stringify(useVTAStore.getState().vtaData))
    );
    expect(validated.isValid).toBe(true);
    expect(validated.data?.lanes).toEqual(movedLanes);

    // 一方でdeclaredLanesが空でnodeのみに「その他の関係者」がある場合は左端へ配置
    const withoutDeclared = validateAndSanitizeVTASchema({
      lanes: [],
      nodes: [
        { id: 'n1', lane: '現場作業員', title: '確認', time: '09:00', type: 'normal', description: '', measure_type: null },
        { id: 'n2', lane: 'その他の関係者', title: '連絡', time: '09:05', type: 'normal', description: '', measure_type: null },
      ],
      edges: [],
    });
    expect(withoutDeclared.isValid).toBe(true);
    expect(withoutDeclared.data?.lanes).toEqual(['その他の関係者', '現場作業員']);
  });

  it('addLane / addNode / updateNode で「その他の関係者」が新規挿入されたとき、既存ノードのdetail・compact X座標を+LANE_WIDTHシフトする', () => {
    const base: VTASchema = {
      lanes: ['現場作業員'],
      nodes: [
        {
          id: 'n_worker',
          lane: '現場作業員',
          time: '09:00',
          title: '点検開始',
          description: '',
          type: 'normal',
          measure_type: null,
          position: { x: 115, y: 120 },
          compact_position: { x: 125, y: 90 },
        },
        {
          id: 'n_move',
          lane: '現場作業員',
          time: '09:10',
          title: '記録確認',
          description: '',
          type: 'normal',
          measure_type: null,
          position: { x: 115, y: 240 },
          compact_position: { x: 125, y: 180 },
        },
      ],
      edges: [],
    };

    const loadWithCompactPositions = (raw: VTASchema) => {
      const prepared = projectAnalysis(createManualAnalysis(raw), raw);
      const imported = useVTAStore.getState().importProjectJSON(
        JSON.stringify({ version: '5.0', vtaData: prepared })
      );
      expect(imported.success).toBe(true);
    };

    // 1) addLane('その他の関係者')
    loadWithCompactPositions(structuredClone(base));
    expect(useVTAStore.getState().addLane(OTHER_ACTORS_ENTITY_NAME)).toBe(true);
    let state = useVTAStore.getState();
    expect(state.vtaData.lanes).toEqual([OTHER_ACTORS_ENTITY_NAME, '現場作業員']);
    expect(state.vtaData.nodes.find((n) => n.id === 'n_worker')?.position?.x).toBe(115 + LANE_WIDTH);
    expect(state.vtaData.nodes.find((n) => n.id === 'n_worker')?.compact_position?.x).toBe(125 + LANE_WIDTH);
    expect(state.nodes.find((n) => n.id === 'n_worker')?.position.x).toBe(115 + LANE_WIDTH);

    // 2) addNode で新規レーン「その他の関係者」にノード追加
    loadWithCompactPositions(structuredClone(base));
    useVTAStore.getState().addNode({
      lane: OTHER_ACTORS_ENTITY_NAME,
      time: '09:05',
      title: '外部連絡',
      description: '',
      type: 'normal',
      measure_type: null,
    });
    state = useVTAStore.getState();
    expect(state.vtaData.lanes).toEqual([OTHER_ACTORS_ENTITY_NAME, '現場作業員']);
    expect(state.vtaData.nodes.find((n) => n.id === 'n_worker')?.position?.x).toBe(115 + LANE_WIDTH);
    expect(state.vtaData.nodes.find((n) => n.id === 'n_worker')?.compact_position?.x).toBe(125 + LANE_WIDTH);
    const addedNode = state.nodes.find((n) => n.data.lane === OTHER_ACTORS_ENTITY_NAME)!;
    expect(addedNode.position.x).toBeLessThan(state.nodes.find((n) => n.id === 'n_worker')!.position.x);

    // 3) updateNode で1件を新規「その他の関係者」へ移すと、残存ノードも+LANE_WIDTHシフト
    loadWithCompactPositions(structuredClone(base));
    useVTAStore.getState().updateNode('n_move', { lane: OTHER_ACTORS_ENTITY_NAME });
    state = useVTAStore.getState();
    expect(state.vtaData.lanes).toEqual([OTHER_ACTORS_ENTITY_NAME, '現場作業員']);
    expect(state.vtaData.nodes.find((n) => n.id === 'n_worker')?.position?.x).toBe(115 + LANE_WIDTH);
    expect(state.vtaData.nodes.find((n) => n.id === 'n_worker')?.compact_position?.x).toBe(125 + LANE_WIDTH);
    expect(state.vtaData.nodes.find((n) => n.id === 'n_move')?.position?.x).toBe(115);
  });

  it('forceMergeLanes / applyForceMergeTransition / applyLaneSplitProposal / layoutフォールバックの整合を保つ', () => {
    const schema: VTASchema = {
      lanes: ['機長', '外部支援', '管制官'],
      nodes: [
        { id: 'c1', lane: '機長', time: '09:00', title: '操縦', description: '', type: 'normal', measure_type: null, position: { x: 120, y: 100 } },
        { id: 'c2', lane: '外部支援', time: '09:05', title: '支援', description: '', type: 'normal', measure_type: null, position: { x: 500, y: 100 } },
        { id: 'c3', lane: '管制官', time: '09:10', title: '指示', description: '', type: 'normal', measure_type: null, position: { x: 880, y: 100 } },
      ],
      edges: [],
    };
    useVTAStore.getState().setVTAData(schema);
    useVTAStore.getState().forceMergeLanes('外部支援', OTHER_ACTORS_ENTITY_NAME);

    const state = useVTAStore.getState();
    expect(state.vtaData.lanes).toEqual([OTHER_ACTORS_ENTITY_NAME, '機長', '管制官']);
    expect(state.vtaData.nodes.find((n) => n.lane === '機長')?.position?.x).toBe(120 + LANE_WIDTH);
    expect(state.vtaData.nodes.find((n) => n.lane === OTHER_ACTORS_ENTITY_NAME)?.position?.x).toBe(500 - LANE_WIDTH);
    expect(state.vtaData.nodes.find((n) => n.lane === '管制官')?.position?.x).toBe(880);

    const transition = applyForceMergeTransition(schema, '外部支援', OTHER_ACTORS_ENTITY_NAME, 12);
    expect(transition?.nextSchema.lanes).toEqual([OTHER_ACTORS_ENTITY_NAME, '機長', '管制官']);
    expect(transition?.nextSchema.nodes.find((n) => n.lane === '機長')?.position?.x).toBe(120 + LANE_WIDTH);

    expect(
      mergeLanesAfterConsolidation(['機長', '副操縦士', '管制官'], new Set(['機長', '副操縦士']), '運航乗務員')
    ).toEqual(['運航乗務員', '管制官']);

    // 分割提案(applyLaneSplitProposal)時に上限超過で新たに「その他の関係者」が生じた場合も左端配置＋座標シフト（ADR-0072: 報告者保護＋周辺主体2件以上の集約）
    const overflow = buildOverflowAnalysis();
    overflow.sources = [
      sourceFromText(
        '09:00 報告者が異常を発見した。\n09:05 現場リーダーが作業を停止した。\n09:10 保守係が点検した。\n09:15 外部業者が資材を納入した。\n09:20 警備員が巡回した。'
      ),
    ];
    overflow.facts = [
      ...(overflow.facts ?? []),
      {
        id: 'f5',
        text: '警備員が巡回した',
        kind: 'recorded',
        evidence: [{ sourceId: 'source_1', paragraphId: 'p5', quote: '09:20 警備員が巡回した。' }],
      },
    ];
    overflow.events = [
      ...overflow.events,
      {
        id: 'e5',
        title: '巡回',
        description: '定期巡回',
        time: '09:20',
        factIds: ['f5'],
        classification: 'normal',
        sourceOrder: 4,
      },
    ];
    overflow.entities = [
      { id: 'A1', name: '報告者（私）', kind: 'person', focus: 'reporter' },
      { id: 'A2', name: '機長Ａ', kind: 'person', focus: 'high', parentEntityId: 'A_plane' },
      { id: 'A3', name: '副操縦員Ａ', kind: 'person', focus: 'mid', parentEntityId: 'A_plane' },
      { id: 'A4', name: '外部業者', kind: 'organization', focus: 'low' },
      { id: 'A5', name: '警備員', kind: 'person', focus: 'low' },
      { id: 'A_plane', name: 'Ａ機', kind: 'machine' },
    ];
    overflow.participations = [
      { eventId: 'e1', entityId: 'A1', role: 'actor', factIds: ['f1'] },
      { eventId: 'e2', entityId: 'A2', role: 'actor', factIds: ['f2'] },
      { eventId: 'e3', entityId: 'A3', role: 'actor', factIds: ['f3'] },
      { eventId: 'e4', entityId: 'A4', role: 'actor', factIds: ['f4'] },
      { eventId: 'e5', entityId: 'A5', role: 'actor', factIds: ['f5'] },
    ];
    overflow.subjectPoset = undefined;
    const initialSplitSchema = projectAnalysis(consolidateSubjects(overflow, 4));
    useVTAStore.setState({ subjectLimit: 4 });
    useVTAStore.getState().setVTAData(initialSplitSchema);
    const split: LaneSplitProposal = {
      id: 'split_1',
      type: 'split',
      parentEntityId: 'A_plane',
      parentEntityName: 'Ａ機',
      splitEntityIds: ['A2', 'A3'],
      splitEntityNames: ['機長Ａ', '副操縦員Ａ'],
      internalRelationsCount: 1,
      reason: 'CRM分割',
      category: 'crm_interaction',
    };
    useVTAStore.getState().applyLaneSplitProposal(split);
    const splitState = useVTAStore.getState();
    expect(splitState.vtaData.lanes[0]).toBe(OTHER_ACTORS_ENTITY_NAME);
    expect(splitState.vtaData.lanes).toContain('報告者（私）');
    expect(splitState.vtaData.lanes).toContain('機長Ａ');
    expect(splitState.vtaData.lanes).toContain('副操縦員Ａ');

    expect(
      expandSplitLanesWithPriority(
        ['管制塔', 'Ａ機'],
        ['管制塔', '機長Ａ', '副操縦員Ａ', OTHER_ACTORS_ENTITY_NAME],
        split.parentEntityName,
        split.splitEntityNames
      )
    ).toEqual([OTHER_ACTORS_ENTITY_NAME, '管制塔', '機長Ａ', '副操縦員Ａ']);

    expect(mergeLaneOrderWithPriority(['現場', '管理'], ['その他2', OTHER_ACTORS_ENTITY_NAME])).toEqual([
      OTHER_ACTORS_ENTITY_NAME,
      '現場',
      '管理',
      'その他2',
    ]);

    // layout.ts の空レーン名フォールバックは左端「その他の関係者」ではなく主レーンへ落とす
    const emptyLaneLayout = calculateVTALayout({
      lanes: [OTHER_ACTORS_ENTITY_NAME, '現場作業員'],
      nodes: [
        { id: 'n_empty', lane: '', time: '09:00', title: '未割当', description: '', type: 'normal', measure_type: null },
      ],
      edges: [],
    });
    expect(emptyLaneLayout.nodes[0].position.x).toBeGreaterThanOrEqual(LANE_WIDTH);
  });

  it('LaneManagementPanel の強制統合元初期値は左端「その他の関係者」ではなく主要レーンを選ぶ', () => {
    const rawSchema: VTASchema = {
      lanes: [OTHER_ACTORS_ENTITY_NAME, '現場作業員', '管制官'],
      nodes: [
        { id: 'n1', lane: OTHER_ACTORS_ENTITY_NAME, time: '09:00', title: '外部', description: '', type: 'normal', measure_type: null },
        { id: 'n2', lane: '現場作業員', time: '09:05', title: '作業', description: '', type: 'normal', measure_type: null },
      ],
      edges: [],
    };
    const schema = projectAnalysis(createManualAnalysis(rawSchema), rawSchema);
    const html = renderToStaticMarkup(
      <LaneManagementPanel
        schema={schema}
        onAdd={() => true}
        onVisibility={vi.fn()}
        onSimplify={vi.fn()}
        onForceMergeLanes={vi.fn()}
      />
    );
    const selectMatch = html.match(/aria-label="統合元レーン"[\s\S]*?<\/select>/);
    expect(selectMatch).not.toBeNull();
    expect(selectMatch![0]).toMatch(/<option[^>]*value="現場作業員"[^>]*selected=""/);
  });
});
