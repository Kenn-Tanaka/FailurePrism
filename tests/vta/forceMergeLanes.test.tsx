import { describe, expect, it, beforeEach, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  buildAnalysis,
  projectAnalysis,
  sourceFromText,
  validateEvents,
  validateFacts,
  validateParticipants,
} from '../../src/tools/vta/features/vta/utils/eventAnalysis';
import {
  applyForceMergeTransition,
  OTHER_ACTORS_ENTITY_NAME,
  resolveForceMergePlan,
  revertConsolidation,
  splitEntitiesLocally,
} from '../../src/tools/vta/features/vta/utils/subjectRanking';
import { SubjectPoset } from '../../src/tools/vta/features/vta/utils/subjectPoset';
import { canDrilldownEntity, getDrilldownSubEntities } from '../../src/tools/vta/features/vta/utils/presentation';
import { useVTAStore } from '../../src/tools/vta/features/vta/store/vtaStore';
import { LaneManagementPanel } from '../../src/tools/vta/components/control-panel/LaneManagementPanel';
import type { LaneMergeProposal, VTAEntity } from '../../src/tools/vta/types/vta';

const prepareScenario = (extraEntities: VTAEntity[] = []) => {
  const source = sourceFromText('09:00 機長が確認した。\n09:05 副操縦士がチェックした。\n09:10 機長が操作した。');
  const facts = validateFacts(
    {
      facts: [
        { id: 'f1', text: '機長が確認した', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p1', quote: '09:00 機長が確認した。' }] },
        { id: 'f2', text: '副操縦士がチェックした', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p2', quote: '09:05 副操縦士がチェックした。' }] },
        { id: 'f3', text: '機長が操作した', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p3', quote: '09:10 機長が操作した。' }] },
      ],
    },
    [source]
  );
  const events = validateEvents(
    {
      events: [
        { id: 'e1', title: '確認', description: '機長が確認した', time: '09:00', factIds: ['f1'] },
        { id: 'e2', title: 'チェック', description: '副操縦士がチェックした', time: '09:05', factIds: ['f2'] },
        { id: 'e3', title: '操作', description: '機長が操作した', time: '09:10', factIds: ['f3'] },
      ],
    },
    facts
  );
  const parsed = validateParticipants(
    {
      entities: [
        { id: 'ent_captain', name: '機長', kind: 'person' },
        { id: 'ent_copilot', name: '副操縦士', kind: 'person' },
        ...extraEntities,
      ],
      participations: [
        { eventId: 'e1', entityId: 'ent_captain', role: 'actor', factIds: ['f1'] },
        { eventId: 'e2', entityId: 'ent_copilot', role: 'actor', factIds: ['f2'] },
        { eventId: 'e3', entityId: 'ent_copilot', role: 'actor', factIds: ['f3'] },
      ],
      relations: [
        { id: 'r1', kind: 'before', sourceEventId: 'e1', sourceEntityId: 'ent_captain', targetEventId: 'e2', targetEntityId: 'ent_copilot', factIds: ['f1'] },
      ],
      cardGroups: [],
    },
    events,
    facts
  );
  const analysis = buildAnalysis(source, facts, events, parsed);
  return projectAnalysis(analysis);
};

function assertConservativePosetExtension(beforePoset: SubjectPoset, afterPoset: SubjectPoset, originalIds: string[]) {
  expect(afterPoset.verifyInvariants().valid).toBe(true);
  for (const x of originalIds) {
    for (const y of originalIds) {
      expect(afterPoset.compare(x, y)).toBe(beforePoset.compare(x, y));
    }
  }
}

describe('Lane Force Merge (半順序保存型レーン強制統合: ADR-0092)', () => {
  beforeEach(() => {
    useVTAStore.setState({
      past: [],
      future: [],
    });
  });

  it('discovers a new 0-event parent subject when merging two incomparable lanes and preserves peer incomparability', () => {
    const schema = prepareScenario();
    const beforePoset = SubjectPoset.fromEntities(schema.analysis!.entities);
    useVTAStore.getState().setVTAData(schema);

    const storeBefore = useVTAStore.getState();
    expect(storeBefore.vtaData.lanes).toEqual(['機長', '副操縦士']);

    // 非比較（独立）な「副操縦士」と「機長」を強制統合 → 共通親主体「機長・副操縦士」を生成して両者を子主体として集約
    storeBefore.forceMergeLanes('副操縦士', '機長');

    const storeAfter = useVTAStore.getState();
    expect(storeAfter.vtaData.lanes).toEqual(['機長・副操縦士']);
    expect(storeAfter.vtaData.nodes.every((n) => n.lane === '機長・副操縦士')).toBe(true);

    const afterAnalysis = storeAfter.vtaData.analysis!;
    const parentEntity = afterAnalysis.entities.find((e) => e.name === '機長・副操縦士');
    expect(parentEntity).toBeDefined();
    expect(parentEntity!.kind).toBe('organization');
    expect(afterAnalysis.cards.every((c) => c.laneEntityId === parentEntity!.id)).toBe(true);

    const afterPoset = SubjectPoset.fromData(afterAnalysis.subjectPoset);
    assertConservativePosetExtension(beforePoset, afterPoset, ['ent_captain', 'ent_copilot']);
    expect(afterPoset.isAncestor(parentEntity!.id, 'ent_captain')).toBe(true);
    expect(afterPoset.isAncestor(parentEntity!.id, 'ent_copilot')).toBe(true);
    expect(afterPoset.compare('ent_captain', 'ent_copilot')).toBe('nc');

    // カスタム親主体名の指定も可能
    useVTAStore.getState().undo();
    useVTAStore.getState().forceMergeLanes('副操縦士', '機長', '運航乗務員チーム');
    expect(useVTAStore.getState().vtaData.lanes).toEqual(['運航乗務員チーム']);
  });

  it('preserves cross-organization Poset boundaries without false transitive pollution (∀x,y ∈ V: x ≼ y ⇔ x ≼′ y)', () => {
    const source = sourceFromText('09:00 監督員Yが指示した。\n09:05 作業員Xが作業した。');
    const facts = validateFacts(
      {
        facts: [
          { id: 'f1', text: '監督員Yが指示した', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p1', quote: '09:00 監督員Yが指示した。' }] },
          { id: 'f2', text: '作業員Xが作業した', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p2', quote: '09:05 作業員Xが作業した。' }] },
        ],
      },
      [source]
    );
    const events = validateEvents(
      {
        events: [
          { id: 'e1', title: '指示', description: '監督員Yが指示した', time: '09:00', factIds: ['f1'] },
          { id: 'e2', title: '作業', description: '作業員Xが作業した', time: '09:05', factIds: ['f2'] },
        ],
      },
      facts
    );
    const entities: VTAEntity[] = [
      { id: 'org_prime', name: '元請会社', kind: 'organization' },
      { id: 'org_sub', name: '下請会社', kind: 'organization' },
      { id: 'sup_prime', name: '監督員Y', kind: 'person', parentEntityId: 'org_prime' },
      { id: 'worker_sub', name: '作業員X', kind: 'person', parentEntityId: 'org_sub' },
    ];
    const parsed = validateParticipants(
      {
        entities,
        participations: [
          { eventId: 'e1', entityId: 'sup_prime', role: 'actor', factIds: ['f1'] },
          { eventId: 'e2', entityId: 'worker_sub', role: 'actor', factIds: ['f2'] },
        ],
        relations: [],
        cardGroups: [],
      },
      events,
      facts
    );
    const analysis = buildAnalysis(source, facts, events, parsed);
    analysis.subjectPoset = SubjectPoset.fromEntities(entities).toJSON();
    const schema = projectAnalysis(analysis);
    const beforePoset = SubjectPoset.fromData(analysis.subjectPoset);

    const res = applyForceMergeTransition(schema, '作業員X', '監督員Y', 12, undefined, '現場作業グループ');
    expect(res).not.toBeNull();
    expect(res!.mode).toBe('new_parent');

    const afterPoset = SubjectPoset.fromData(res!.nextSchema.analysis!.subjectPoset);
    assertConservativePosetExtension(beforePoset, afterPoset, ['org_prime', 'org_sub', 'sup_prime', 'worker_sub']);
    expect(afterPoset.isAncestor('org_prime', 'worker_sub')).toBe(false);
    expect(afterPoset.isAncestor('org_sub', 'sup_prime')).toBe(false);
    expect(afterPoset.isAncestor(res!.targetEntityId, 'sup_prime')).toBe(true);
    expect(afterPoset.isAncestor(res!.targetEntityId, 'worker_sub')).toBe(true);
  });

  it('inserts an intermediate parent beneath a split Poset parent (HG2c) and reuses an exact-cover 0-event Poset hub when unsplit', () => {
    const source = sourceFromText('09:00 指揮者が指示。\n09:05 代理人が伝達。\n09:10 見張員が監視。');
    const facts = validateFacts(
      {
        facts: [
          { id: 'f1', text: '指揮者が指示', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p1', quote: '09:00 指揮者が指示。' }] },
          { id: 'f2', text: '代理人が伝達', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p2', quote: '09:05 代理人が伝達。' }] },
          { id: 'f3', text: '見張員が監視', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p3', quote: '09:10 見張員が監視。' }] },
        ],
      },
      [source]
    );
    const events = validateEvents(
      {
        events: [
          { id: 'e1', title: '指示', description: '指示', time: '09:00', factIds: ['f1'] },
          { id: 'e2', title: '伝達', description: '伝達', time: '09:05', factIds: ['f2'] },
          { id: 'e3', title: '監視', description: '監視', time: '09:10', factIds: ['f3'] },
        ],
      },
      facts
    );
    const origEntities: VTAEntity[] = [
      { id: 'A3', name: '除草薬散布作業班', kind: 'organization' },
      { id: 'A4', name: '作業指揮者A', kind: 'person', parentEntityId: 'A3' },
      { id: 'A5', name: '現場代理人G', kind: 'person', parentEntityId: 'A3' },
      { id: 'A6', name: '列車見張員B', kind: 'person', parentEntityId: 'A3' },
    ];
    const activeEntities = origEntities.filter((e) => e.id !== 'A3');
    const parsed = validateParticipants(
      {
        entities: activeEntities,
        participations: [
          { eventId: 'e1', entityId: 'A4', role: 'actor', factIds: ['f1'] },
          { eventId: 'e2', entityId: 'A5', role: 'actor', factIds: ['f2'] },
          { eventId: 'e3', entityId: 'A6', role: 'actor', factIds: ['f3'] },
        ],
        relations: [],
        cardGroups: [],
      },
      events,
      facts
    );
    const analysis = buildAnalysis(source, facts, events, parsed);
    analysis.subjectPoset = SubjectPoset.fromEntities(origEntities).toJSON();
    analysis.subjectRanking = {
      version: 1,
      maxSubjects: 5,
      weights: { A: 0.3, O: 0.25, F: 0.2, C: 0.15, T: 0.1 },
      originalEntities: origEntities,
      ranks: [
        { entityId: 'A4', rank: 1, score: 0.8, breakdown: { A: 1, O: 0, F: 0, C: 0, T: 0 }, retained: true, reason: '保持' },
        { entityId: 'A5', rank: 2, score: 0.7, breakdown: { A: 1, O: 0, F: 0, C: 0, T: 0 }, retained: true, reason: '保持' },
        { entityId: 'A6', rank: 3, score: 0.6, breakdown: { A: 1, O: 0, F: 0, C: 0, T: 0 }, retained: true, reason: '保持' },
        { entityId: 'A3', rank: 4, score: 0.2, breakdown: { A: 0, O: 0, F: 0, C: 0, T: 0 }, retained: false, excluded: true, reason: '0件ハブ除外' },
      ],
    };
    const schema = projectAnalysis(analysis);
    const beforePoset = SubjectPoset.fromData(analysis.subjectPoset);

    // 1. A6 が残存する状態で A4 と A5 を統合 → 分裂親 A3 をそのまま使わず中間親 P (A4,A5 ≺ P ≺ A3, P ∥ A6) を生成
    const splitRes = applyForceMergeTransition(schema, '現場代理人G', '作業指揮者A');
    expect(splitRes).not.toBeNull();
    expect(splitRes!.targetEntityId).not.toBe('A3');
    expect(splitRes!.nextSchema.lanes).toEqual(['作業指揮者A・現場代理人G', '列車見張員B']);

    const midPoset = SubjectPoset.fromData(splitRes!.nextSchema.analysis!.subjectPoset);
    assertConservativePosetExtension(beforePoset, midPoset, ['A3', 'A4', 'A5', 'A6']);
    expect(midPoset.isAncestor(splitRes!.targetEntityId, 'A4')).toBe(true);
    expect(midPoset.isAncestor(splitRes!.targetEntityId, 'A5')).toBe(true);
    expect(midPoset.isAncestor('A3', splitRes!.targetEntityId)).toBe(true);
    expect(midPoset.compare(splitRes!.targetEntityId, 'A6')).toBe('nc');

    // 2. 残る A6 も中間親レーンと統合すると、A3 配下の全子孫を完全包摂するため既存の 0イベント親 A3 (除草薬散布作業班) を自動採用
    const fullPlan = resolveForceMergePlan(splitRes!.nextSchema, '列車見張員B', '作業指揮者A・現場代理人G');
    expect(fullPlan?.defaultTargetName).toBe('除草薬散布作業班');
    expect(fullPlan?.reusedOriginalHubId).toBe('A3');

    const fullRes = applyForceMergeTransition(splitRes!.nextSchema, '列車見張員B', '作業指揮者A・現場代理人G');
    expect(fullRes!.targetEntityId).toMatch(/^cmp_/);
    expect(fullRes!.targetEntityId).not.toBe('A3');
    const fullTargetEnt = fullRes!.nextSchema.analysis!.entities.find(
      (e) => e.id === fullRes!.targetEntityId
    )!;
    expect(fullTargetEnt.coreEntityId).toBe('A3');
    expect(fullTargetEnt.compositeOf).toEqual([splitRes!.targetEntityId, 'A6'].sort());
    expect(fullRes!.nextSchema.lanes).toEqual(['除草薬散布作業班']);
    const finalPoset = SubjectPoset.fromData(fullRes!.nextSchema.analysis!.subjectPoset);
    assertConservativePosetExtension(beforePoset, finalPoset, ['A3', 'A4', 'A5', 'A6']);
    // 封印複合主体 splitRes.targetEntityId (P1) は解体されず入れ子木構造 (A4,A5 ≺ P1 ≺ P2 ≺ A3) を保持
    expect(finalPoset.isAncestor(splitRes!.targetEntityId, 'A4')).toBe(true);
    expect(finalPoset.isAncestor(fullRes!.targetEntityId, splitRes!.targetEntityId)).toBe(true);
    expect(finalPoset.isAncestor(fullRes!.targetEntityId, 'A6')).toBe(true);
    // revertConsolidation 時は P1・P2 ともに完全解消されゴーストとして残らない
    const revertedPoset = SubjectPoset.fromData(
      revertConsolidation(fullRes!.nextSchema.analysis!).subjectPoset
    );
    expect(revertedPoset.hasNode(splitRes!.targetEntityId)).toBe(false);
    expect(revertedPoset.hasNode(fullRes!.targetEntityId)).toBe(false);
  });

  it('rolls lower subject up into a distinct composite anchored on the upper subject without inversion when an ancestor-descendant relation already exists', () => {
    const source = sourceFromText('09:00 本社が通達した。\n09:05 機長が確認した。');
    const facts = validateFacts(
      {
        facts: [
          { id: 'f1', text: '本社が通達した', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p1', quote: '09:00 本社が通達した。' }] },
          { id: 'f2', text: '機長が確認した', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p2', quote: '09:05 機長が確認した。' }] },
        ],
      },
      [source]
    );
    const events = validateEvents(
      {
        events: [
          { id: 'e1', title: '通達', description: '本社が通達した', time: '09:00', factIds: ['f1'] },
          { id: 'e2', title: '確認', description: '機長が確認した', time: '09:05', factIds: ['f2'] },
        ],
      },
      facts
    );
    const entities: VTAEntity[] = [
      { id: 'ent_hq', name: '運航本部', kind: 'organization' },
      { id: 'ent_captain', name: '機長', kind: 'person', parentEntityId: 'ent_hq' },
    ];
    const parsed = validateParticipants(
      {
        entities,
        participations: [
          { eventId: 'e1', entityId: 'ent_hq', role: 'actor', factIds: ['f1'] },
          { eventId: 'e2', entityId: 'ent_captain', role: 'actor', factIds: ['f2'] },
        ],
        relations: [],
        cardGroups: [],
      },
      events,
      facts
    );
    const analysis = buildAnalysis(source, facts, events, parsed);
    analysis.subjectPoset = SubjectPoset.fromEntities(entities).toJSON();
    const schema = projectAnalysis(analysis);

    // 子→親の順でも、逆（親→子）の順で選択しても、同一の内容アドレス複合ID (cmp_*, coreEntityId='ent_hq', 表示名='運航本部') へ決定論的に統合される
    const forward = applyForceMergeTransition(schema, '機長', '運航本部');
    expect(forward!.mode).toBe('poset_rollup');
    expect(forward!.targetEntityId).toMatch(/^cmp_/);
    expect(forward!.targetEntityId).not.toBe('ent_hq');
    expect(forward!.nextSchema.analysis!.entities[0].coreEntityId).toBe('ent_hq');
    expect(forward!.nextSchema.lanes).toEqual(['運航本部']);

    const reverse = applyForceMergeTransition(schema, '運航本部', '機長');
    expect(reverse!.mode).toBe('poset_rollup');
    expect(reverse!.targetEntityId).toBe(forward!.targetEntityId);
    expect(reverse!.nextSchema.lanes).toEqual(['運航本部']);
  });

  it('merges all nodes into a newly created target lane and cleans up synthetic parents on split and revert', () => {
    const schema = prepareScenario();
    useVTAStore.getState().setVTAData(schema);

    // 1. 「副操縦士」を新しい「運航乗務員」レーンへ統合（機長は独立維持）
    useVTAStore.getState().forceMergeLanes('副操縦士', '運航乗務員');
    const afterSingle = useVTAStore.getState().vtaData;
    expect(afterSingle.lanes).not.toContain('副操縦士');
    expect(afterSingle.lanes).toContain('運航乗務員');
    expect(afterSingle.lanes).toContain('機長');

    // 2. さらに「機長」と「運航乗務員」を統合し、OLAPドリルダウン・局所分割・revertConsolidation の整合を検証
    useVTAStore.getState().forceMergeLanes('機長', '運航乗務員', '乗員全体');
    const mergedSchema = useVTAStore.getState().vtaData;
    expect(mergedSchema.lanes).toEqual(['乗員全体']);
    const mergedParent = mergedSchema.analysis!.entities.find((e) => e.name === '乗員全体')!;
    expect(canDrilldownEntity(mergedParent.id, mergedSchema.analysis!)).toBe(true);
    const subNames = getDrilldownSubEntities(mergedParent.id, mergedSchema.analysis!).map((s) => s.name);
    expect(subNames).toContain('機長');
    expect(subNames).toContain('副操縦士');
    expect(subNames.some((n) => n.startsWith('merged_entity_'))).toBe(false);

    const splitAnalysis = splitEntitiesLocally(
      mergedSchema.analysis!,
      mergedParent.id,
      ['ent_captain', 'ent_copilot'],
      5
    );
    expect(splitAnalysis.entities.map((e) => e.name).sort()).toEqual(['副操縦士', '機長']);
    expect(SubjectPoset.fromData(splitAnalysis.subjectPoset).hasNode(mergedParent.id)).toBe(false);

    const reverted = revertConsolidation(mergedSchema.analysis!);
    expect(reverted.entities.map((e) => e.name).sort()).toEqual(['副操縦士', '機長']);
    expect(SubjectPoset.fromData(reverted.subjectPoset).hasNode(mergedParent.id)).toBe(false);
  });

  it('prevents person ≺ machine Poset violation in applyLaneMergeProposal when a machine shares the suggested vehicle name', () => {
    const source = sourceFromText('09:00 機長Ａが操作。\n09:05 副操縦員Ａが確認。\n09:10 Ａ機が滑走。');
    const facts = validateFacts(
      {
        facts: [
          { id: 'f1', text: '機長Ａが操作', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p1', quote: '09:00 機長Ａが操作。' }] },
          { id: 'f2', text: '副操縦員Ａが確認', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p2', quote: '09:05 副操縦員Ａが確認。' }] },
          { id: 'f3', text: 'Ａ機が滑走', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p3', quote: '09:10 Ａ機が滑走。' }] },
        ],
      },
      [source]
    );
    const events = validateEvents(
      {
        events: [
          { id: 'e1', title: '操作', description: '操作', time: '09:00', factIds: ['f1'] },
          { id: 'e2', title: '確認', description: '確認', time: '09:05', factIds: ['f2'] },
          { id: 'e3', title: '滑走', description: '滑走', time: '09:10', factIds: ['f3'] },
        ],
      },
      facts
    );
    const entities: VTAEntity[] = [
      { id: 'CAPT_A', name: '機長Ａ', kind: 'person' },
      { id: 'FO_A', name: '副操縦員Ａ', kind: 'person' },
      { id: 'PLANE_A', name: 'Ａ機', kind: 'machine' },
    ];
    const parsed = validateParticipants(
      {
        entities,
        participations: [
          { eventId: 'e1', entityId: 'CAPT_A', role: 'actor', factIds: ['f1'] },
          { eventId: 'e2', entityId: 'FO_A', role: 'actor', factIds: ['f2'] },
          { eventId: 'e3', entityId: 'PLANE_A', role: 'actor', factIds: ['f3'] },
        ],
        relations: [],
        cardGroups: [],
      },
      events,
      facts
    );
    const analysis = buildAnalysis(source, facts, events, parsed);
    analysis.subjectPoset = SubjectPoset.fromEntities(entities).toJSON();
    useVTAStore.getState().setVTAData(projectAnalysis(analysis));

    const proposal: LaneMergeProposal = {
      id: 'merge_crew_A',
      type: 'merge',
      sourceEntityIds: ['CAPT_A', 'FO_A'],
      sourceEntityNames: ['機長Ａ', '副操縦員Ａ'],
      suggestedTargetName: 'Ａ機',
      suggestedKind: 'organization',
      totalEventsCount: 2,
      reducedLanesCount: 1,
      reason: 'A機クルー統合',
      category: 'vehicle_crew',
    };
    useVTAStore.getState().applyLaneMergeProposal(proposal, 'Ａ機');

    const after = useVTAStore.getState().vtaData;
    expect(after.lanes).toEqual(['Ａ機']);
    const composite = after.analysis!.entities.find((e) => e.name === 'Ａ機')!;
    expect(composite.kind).toBe('organization');
    expect(composite.id).not.toBe('PLANE_A');

    const afterPoset = SubjectPoset.fromData(after.analysis!.subjectPoset);
    expect(afterPoset.isAncestor('PLANE_A', 'CAPT_A')).toBe(false);
    expect(afterPoset.isAncestor(composite.id, 'CAPT_A')).toBe(true);
    expect(afterPoset.isAncestor(composite.id, 'FO_A')).toBe(true);
    expect(afterPoset.isAncestor(composite.id, 'PLANE_A')).toBe(true);
  });

  it('recomputes minimal common ancestors conservatively across incremental merges into subject_others', () => {
    const source = sourceFromText('09:00 事務所が連絡。\n09:05 下請が搬入。\n09:10 作業員が実施。');
    const facts = validateFacts(
      {
        facts: [
          { id: 'f1', text: '事務所が連絡', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p1', quote: '09:00 事務所が連絡。' }] },
          { id: 'f2', text: '下請が搬入', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p2', quote: '09:05 下請が搬入。' }] },
          { id: 'f3', text: '作業員が実施', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p3', quote: '09:10 作業員が実施。' }] },
        ],
      },
      [source]
    );
    const events = validateEvents(
      {
        events: [
          { id: 'e1', title: '連絡', description: '連絡', time: '09:00', factIds: ['f1'] },
          { id: 'e2', title: '搬入', description: '搬入', time: '09:05', factIds: ['f2'] },
          { id: 'e3', title: '実施', description: '実施', time: '09:10', factIds: ['f3'] },
        ],
      },
      facts
    );
    const entities: VTAEntity[] = [
      { id: 'A1', name: '鉄道会社', kind: 'organization' },
      { id: 'A2', name: '工務事務所', kind: 'organization', parentEntityId: 'A1' },
      { id: 'A12', name: '下請会社', kind: 'organization' },
      { id: 'W1', name: '現場作業員', kind: 'person' },
    ];
    const parsed = validateParticipants(
      {
        entities,
        participations: [
          { eventId: 'e1', entityId: 'A2', role: 'actor', factIds: ['f1'] },
          { eventId: 'e2', entityId: 'A12', role: 'actor', factIds: ['f2'] },
          { eventId: 'e3', entityId: 'W1', role: 'actor', factIds: ['f3'] },
        ],
        relations: [],
        cardGroups: [],
      },
      events,
      facts
    );
    const analysis = buildAnalysis(source, facts, events, parsed);
    analysis.subjectPoset = SubjectPoset.fromEntities(entities).toJSON();
    const beforePoset = SubjectPoset.fromData(analysis.subjectPoset);

    const step1 = applyForceMergeTransition(projectAnalysis(analysis), '工務事務所', OTHER_ACTORS_ENTITY_NAME);
    const step2 = applyForceMergeTransition(step1!.nextSchema, '下請会社', OTHER_ACTORS_ENTITY_NAME);
    const afterPoset = SubjectPoset.fromData(step2!.nextSchema.analysis!.subjectPoset);

    // A2 ≺ A1 であった後に無関係な A12 をその他の関係者 (cmp_agg_*) に追加統合しても A12 ≺ A1 に汚染されず、各段階で別IDが採番される
    assertConservativePosetExtension(beforePoset, afterPoset, ['A1', 'A2', 'A12', 'W1']);
    expect(step1!.targetEntityId).toMatch(/^cmp_agg_/);
    expect(step2!.targetEntityId).toMatch(/^cmp_agg_/);
    expect(step2!.targetEntityId).not.toBe(step1!.targetEntityId);
    expect(afterPoset.hasNode(step1!.targetEntityId)).toBe(false);
    expect(afterPoset.isAncestor('A1', 'A12')).toBe(false);
    expect(afterPoset.isAncestor(step2!.targetEntityId, 'A2')).toBe(true);
    expect(afterPoset.isAncestor(step2!.targetEntityId, 'A12')).toBe(true);
  });

  it('rebuilds remaining members as a new content-addressed composite P_prime when partially splitting C2, C3 out of P = {C1, C2, C3, C4} (ADR-0095)', () => {
    const source = sourceFromText('09:00 C1作業。\n09:05 C2作業。\n09:10 C3作業。\n09:15 C4作業。');
    const facts = validateFacts(
      {
        facts: [
          { id: 'f1', text: 'C1作業', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p1', quote: '09:00 C1作業。' }] },
          { id: 'f2', text: 'C2作業', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p2', quote: '09:05 C2作業。' }] },
          { id: 'f3', text: 'C3作業', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p3', quote: '09:10 C3作業。' }] },
          { id: 'f4', text: 'C4作業', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p4', quote: '09:15 C4作業。' }] },
        ],
      },
      [source]
    );
    const events = validateEvents(
      {
        events: [
          { id: 'e1', title: 'C1作業', description: 'C1作業', time: '09:00', factIds: ['f1'] },
          { id: 'e2', title: 'C2作業', description: 'C2作業', time: '09:05', factIds: ['f2'] },
          { id: 'e3', title: 'C3作業', description: 'C3作業', time: '09:10', factIds: ['f3'] },
          { id: 'e4', title: 'C4作業', description: 'C4作業', time: '09:15', factIds: ['f4'] },
        ],
      },
      facts
    );
    const entities: VTAEntity[] = [
      { id: 'C1', name: '担当者1', kind: 'person' },
      { id: 'C2', name: '担当者2', kind: 'person' },
      { id: 'C3', name: '担当者3', kind: 'person' },
      { id: 'C4', name: '担当者4', kind: 'person' },
    ];
    const parsed = validateParticipants(
      {
        entities,
        participations: [
          { eventId: 'e1', entityId: 'C1', role: 'actor', factIds: ['f1'] },
          { eventId: 'e2', entityId: 'C2', role: 'actor', factIds: ['f2'] },
          { eventId: 'e3', entityId: 'C3', role: 'actor', factIds: ['f3'] },
          { eventId: 'e4', entityId: 'C4', role: 'actor', factIds: ['f4'] },
        ],
        relations: [],
        cardGroups: [],
      },
      events,
      facts
    );
    const analysis = buildAnalysis(source, facts, events, parsed);
    analysis.subjectPoset = SubjectPoset.fromEntities(entities).toJSON();
    let curSchema = projectAnalysis(analysis);

    curSchema = applyForceMergeTransition(curSchema, '担当者2', '担当者1', 12, undefined, '作業チームP')!.nextSchema;
    curSchema = applyForceMergeTransition(curSchema, '担当者3', '作業チームP', 12, undefined, '作業チームP')!.nextSchema;
    const mergedP = applyForceMergeTransition(curSchema, '担当者4', '作業チームP', 12, undefined, '作業チームP')!;
    const pId = mergedP.targetEntityId;
    expect(pId).toMatch(/^cmp_/);

    // P = {C1, C2, C3, C4} から C2, C3 を部分分離 → P は解体され、残る {C1, C4} から別ID・別表示名の P' が生成される
    const afterSplit = splitEntitiesLocally(mergedP.nextSchema.analysis!, pId, ['C2', 'C3'], 6);
    expect(afterSplit.entities.some((e) => e.id === pId)).toBe(false);
    expect(afterSplit.entities.some((e) => e.id === 'C2')).toBe(true);
    expect(afterSplit.entities.some((e) => e.id === 'C3')).toBe(true);
    const pPrime = afterSplit.entities.find((e) => e.id.startsWith('cmp_'))!;
    expect(pPrime).toBeDefined();
    expect(pPrime.id).not.toBe(pId);
    expect(pPrime.name).toBe('作業チームP（担当者2・担当者3を除く）');
    expect(pPrime.mergedFrom?.sort()).toEqual(['C1', 'C4']);
  });

  it('ignores invalid inputs safely and supports undo restoring the original multi-lane state', () => {
    const schema = prepareScenario();
    useVTAStore.getState().setVTAData(schema);
    const lanesBefore = [...useVTAStore.getState().vtaData.lanes];

    useVTAStore.getState().forceMergeLanes('機長', '機長');
    expect(useVTAStore.getState().vtaData.lanes).toEqual(lanesBefore);

    useVTAStore.getState().forceMergeLanes('存在しないレーン', '機長');
    expect(useVTAStore.getState().vtaData.lanes).toEqual(lanesBefore);

    useVTAStore.getState().forceMergeLanes('', '機長');
    expect(useVTAStore.getState().vtaData.lanes).toEqual(lanesBefore);

    useVTAStore.getState().forceMergeLanes('副操縦士', '機長');
    expect(useVTAStore.getState().vtaData.lanes).toEqual(['機長・副操縦士']);

    useVTAStore.getState().undo();
    const restored = useVTAStore.getState().vtaData;
    expect(restored.lanes).toEqual(lanesBefore);
    expect(restored.nodes.some((n) => n.lane === '副操縦士')).toBe(true);
  });

  it('renders forced merge UI controls including parent subject name input for incomparable lanes', () => {
    const schema = prepareScenario();
    const onForceMerge = vi.fn();

    const html = renderToStaticMarkup(
      <LaneManagementPanel
        schema={schema}
        onAdd={() => true}
        onVisibility={vi.fn()}
        onSimplify={vi.fn()}
        onForceMergeLanes={onForceMerge}
      />
    );

    expect(html).toContain('レーンの強制統合');
    expect(html).toContain('統合元レーン:');
    expect(html).toContain('統合先レーン:');
    expect(html).toContain('生成する親主体名:');
    expect(html).toContain('機長・副操縦士');
    expect(html).toContain('へ統合');
    expect(html).toContain('🔀 統合');
  });
});
