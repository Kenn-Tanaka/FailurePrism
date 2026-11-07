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
import { useVTAStore } from '../../src/tools/vta/features/vta/store/vtaStore';
import { LaneManagementPanel } from '../../src/tools/vta/components/control-panel/LaneManagementPanel';

const prepareScenario = () => {
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

describe('Lane Force Merge (強制的統合機能)', () => {
  beforeEach(() => {
    useVTAStore.setState({
      past: [],
      future: [],
    });
  });

  it('merges all nodes from source lane into existing target lane and removes source lane', () => {
    const schema = prepareScenario();
    useVTAStore.getState().setVTAData(schema);

    const storeBefore = useVTAStore.getState();
    expect(storeBefore.vtaData.lanes).toContain('機長');
    expect(storeBefore.vtaData.lanes).toContain('副操縦士');
    const copilotNodesBefore = storeBefore.vtaData.nodes.filter((n) => n.lane === '副操縦士');
    expect(copilotNodesBefore.length).toBeGreaterThan(0);

    // 副操縦士を機長レーンへ強制統合
    storeBefore.forceMergeLanes('副操縦士', '機長');

    const storeAfter = useVTAStore.getState();
    // 統合元レーンが消え、統合先レーンが残る
    expect(storeAfter.vtaData.lanes).not.toContain('副操縦士');
    expect(storeAfter.vtaData.lanes).toContain('機長');

    // 全ノードが「機長」レーンに帰属している
    expect(storeAfter.vtaData.nodes.every((n) => n.lane === '機長')).toBe(true);

    // 分析台帳のカードも機長エンティティに付け替えられている
    const captainEntity = storeAfter.vtaData.analysis?.entities.find((e) => e.name === '機長');
    expect(captainEntity).toBeDefined();
    for (const card of storeAfter.vtaData.analysis?.cards ?? []) {
      expect(card.laneEntityId).toBe(captainEntity!.id);
    }
  });

  it('merges all nodes into a newly created target lane', () => {
    const schema = prepareScenario();
    useVTAStore.getState().setVTAData(schema);

    // 「副操縦士」を新しい「運航乗務員」レーンへ統合
    useVTAStore.getState().forceMergeLanes('副操縦士', '運航乗務員');

    const store = useVTAStore.getState();
    expect(store.vtaData.lanes).not.toContain('副操縦士');
    expect(store.vtaData.lanes).toContain('運航乗務員');
    expect(store.vtaData.lanes).toContain('機長');

    // 副操縦士にあったノードが運航乗務員に移っている
    const newLaneNodes = store.vtaData.nodes.filter((n) => n.lane === '運航乗務員');
    expect(newLaneNodes.length).toBeGreaterThan(0);
  });

  it('ignores invalid inputs safely', () => {
    const schema = prepareScenario();
    useVTAStore.getState().setVTAData(schema);
    const lanesBefore = [...useVTAStore.getState().vtaData.lanes];

    // 同一レーン同士
    useVTAStore.getState().forceMergeLanes('機長', '機長');
    expect(useVTAStore.getState().vtaData.lanes).toEqual(lanesBefore);

    // 存在しないレーン
    useVTAStore.getState().forceMergeLanes('存在しないレーン', '機長');
    expect(useVTAStore.getState().vtaData.lanes).toEqual(lanesBefore);

    // 空文字
    useVTAStore.getState().forceMergeLanes('', '機長');
    expect(useVTAStore.getState().vtaData.lanes).toEqual(lanesBefore);
  });

  it('supports undo restoring the original multi-lane state', () => {
    const schema = prepareScenario();
    useVTAStore.getState().setVTAData(schema);

    const initialLanes = [...useVTAStore.getState().vtaData.lanes];
    useVTAStore.getState().forceMergeLanes('副操縦士', '機長');
    expect(useVTAStore.getState().vtaData.lanes).not.toContain('副操縦士');

    // Undo 実行
    useVTAStore.getState().undo();
    const restored = useVTAStore.getState().vtaData;
    expect(restored.lanes).toEqual(initialLanes);
    expect(restored.nodes.some((n) => n.lane === '副操縦士')).toBe(true);
  });

  it('renders forced merge UI controls in LaneManagementPanel', () => {
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

    // 強制統合セクションが存在すること
    expect(html).toContain('レーンの強制統合');
    expect(html).toContain('統合元レーン:');
    expect(html).toContain('統合先レーン:');
    expect(html).toContain('へ統合');
    expect(html).toContain('🔀 統合');
  });
});
