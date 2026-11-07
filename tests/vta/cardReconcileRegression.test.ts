import { describe, expect, it } from 'vitest';
import {
  buildAnalysis,
  projectAnalysis,
  reconcileAnalysis,
  sourceFromText,
  validateEvents,
  validateFacts,
  validateParticipants,
  validateSavedAnalysis,
} from '../../src/tools/vta/features/vta/utils/eventAnalysis';
import { validateAndSanitizeProjectFile } from '../../src/tools/vta/features/vta/utils/schemaValidator';
import { useVTAStore } from '../../src/tools/vta/features/vta/store/vtaStore';

const prepareScenario = () => {
  const source = sourceFromText('09:00 指示を出した。\n09:01 受領して復唱した。\n09:02 確認した。');
  const facts = validateFacts({
    facts: [
      { id: 'f1', text: '指示を出した', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p1', quote: '09:00 指示を出した。' }] },
      { id: 'f2', text: '受領して復唱した', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p2', quote: '09:01 受領して復唱した。' }] },
      { id: 'f3', text: '確認した', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p3', quote: '09:02 確認した。' }] },
    ],
  }, [source]);
  const events = validateEvents({
    events: [
      { id: 'e1', title: '指示発出', description: '指示を出した', time: '09:00', factIds: ['f1'] },
      { id: 'e2', title: '復唱', description: '受領して復唱した', time: '09:01', factIds: ['f2'] },
      { id: 'e3', title: '確認', description: '確認した', time: '09:02', factIds: ['f3'] },
    ],
  }, facts);

  const parsed = validateParticipants({
    entities: [
      { id: 'ent_tower', name: '管制塔', kind: 'person' },
      { id: 'ent_pilot', name: '機長', kind: 'person' },
      { id: 'ent_copilot', name: '副操縦士', kind: 'person' },
    ],
    participations: [
      { eventId: 'e1', entityId: 'ent_tower', role: 'actor', factIds: ['f1'] },
      { eventId: 'e2', entityId: 'ent_pilot', role: 'actor', factIds: ['f2'] },
      { eventId: 'e3', entityId: 'ent_copilot', role: 'actor', factIds: ['f3'] },
    ],
    relations: [
      { id: 'r1', kind: 'transfer', sourceEventId: 'e1', sourceEntityId: 'ent_tower', targetEventId: 'e2', targetEntityId: 'ent_pilot', factIds: ['f1'] },
      { id: 'r2', kind: 'before', sourceEventId: 'e2', sourceEntityId: 'ent_pilot', targetEventId: 'e3', targetEntityId: 'ent_copilot', factIds: ['f2'] },
    ],
    cardGroups: [],
  }, events, facts);

  const analysis = buildAnalysis(source, facts, events, parsed);
  const schema = projectAnalysis(analysis);
  return { source, facts, events, analysis, schema };
};

describe('Issue 1 Regression: Card lane change and deletion reloadability', () => {
  it('allows reloading saved project after moving a connected card to another lane', () => {
    const { schema } = prepareScenario();
    // カード c2 (e2: 復唱) のレーンを「機長」から「副操縦士」に変更する
    const card2 = schema.nodes.find((n) => n.title === '復唱')!;
    expect(card2.lane).toBe('機長');

    const changedNodes = schema.nodes.map((n) =>
      n.id === card2.id ? { ...n, lane: '副操縦士' } : n
    );
    const changed = reconcileAnalysis(schema, { ...schema, nodes: changedNodes });

    // 保存データの検証（再読込のシミュレーション）
    expect(() => validateSavedAnalysis(changed.analysis)).not.toThrow();
    const projectValid = validateAndSanitizeProjectFile({ version: '5.0', vtaData: changed });
    expect(projectValid.isValid).toBe(true);
  });

  it('allows reloading saved project after deleting a connected card', () => {
    const { schema } = prepareScenario();
    // カード c2 (e2: 復唱) を削除する
    const card2 = schema.nodes.find((n) => n.title === '復唱')!;
    const remainingNodes = schema.nodes.filter((n) => n.id !== card2.id);
    const remainingEdges = schema.edges.filter((e) => e.source !== card2.id && e.target !== card2.id);

    const changed = reconcileAnalysis(schema, {
      ...schema,
      nodes: remainingNodes,
      edges: remainingEdges,
    });

    // 削除後も再読込が正常に通ること
    expect(() => validateSavedAnalysis(changed.analysis)).not.toThrow();
    const projectValid = validateAndSanitizeProjectFile({ version: '5.0', vtaData: changed });
    expect(projectValid.isValid).toBe(true);
  });

  it('correctly updates endpoints and reloads cleanly when card has multiple relations', () => {
    const { schema } = prepareScenario();
    // card2 (復唱: 機長) は r1 の target かつ r2 の source
    const card2 = schema.nodes.find((n) => n.title === '復唱')!;
    const changedNodes = schema.nodes.map((n) =>
      n.id === card2.id ? { ...n, lane: '副操縦士' } : n
    );
    const changed = reconcileAnalysis(schema, { ...schema, nodes: changedNodes });

    expect(() => validateSavedAnalysis(changed.analysis)).not.toThrow();
    const r1 = changed.analysis?.relations.find((r) => r.id === 'r1');
    const r2 = changed.analysis?.relations.find((r) => r.id === 'r2');
    expect(r1?.targetEntityId).toBe('ent_copilot');
    expect(r2?.sourceEntityId).toBe('ent_copilot');
    const projectValid = validateAndSanitizeProjectFile({ version: '5.0', vtaData: changed });
    expect(projectValid.isValid).toBe(true);
  });

  it('preserves shared events and remaining participations when one shared card is deleted or moved', () => {
    const source = sourceFromText('09:00 合同ブリーフィング実施。\n09:05 出発。');
    const facts = validateFacts({
      facts: [
        { id: 'f1', text: '合同ブリーフィング実施', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p1', quote: '09:00 合同ブリーフィング実施。' }] },
        { id: 'f2', text: '出発', kind: 'recorded', evidence: [{ sourceId: 'source_1', paragraphId: 'p2', quote: '09:05 出発。' }] },
      ],
    }, [source]);
    const events = validateEvents({
      events: [
        { id: 'e1', title: 'ブリーフィング', description: '合同ブリーフィング実施', time: '09:00', factIds: ['f1'] },
        { id: 'e2', title: '出発', description: '出発', time: '09:05', factIds: ['f2'] },
      ],
    }, facts);
    const parsed = validateParticipants({
      entities: [
        { id: 'ent_pilot', name: '機長', kind: 'person' },
        { id: 'ent_copilot', name: '副操縦士', kind: 'person' },
      ],
      participations: [
        { eventId: 'e1', entityId: 'ent_pilot', role: 'actor', factIds: ['f1'] },
        { eventId: 'e1', entityId: 'ent_copilot', role: 'actor', factIds: ['f1'] },
        { eventId: 'e2', entityId: 'ent_pilot', role: 'actor', factIds: ['f2'] },
      ],
      relations: [
        { id: 'r1', kind: 'before', sourceEventId: 'e1', sourceEntityId: 'ent_copilot', targetEventId: 'e2', targetEntityId: 'ent_pilot', factIds: ['f1'] },
      ],
      cardGroups: [],
    }, events, facts);

    const analysis = buildAnalysis(source, facts, events, parsed);
    // e1 は 機長レーンと副操縦士レーンの両方にカードを持つ
    analysis.cards = [
      { id: 'c1_pilot', laneEntityId: 'ent_pilot', eventIds: ['e1'] },
      { id: 'c1_copilot', laneEntityId: 'ent_copilot', eventIds: ['e1'] },
      { id: 'c2_pilot', laneEntityId: 'ent_pilot', eventIds: ['e2'] },
    ];
    const schema = projectAnalysis(analysis);

    // 1. 副操縦士側のカードを削除
    const delChanged = reconcileAnalysis(schema, {
      ...schema,
      nodes: schema.nodes.filter((n) => n.id !== 'c1_copilot'),
      edges: schema.edges.filter((e) => e.source !== 'c1_copilot' && e.target !== 'c1_copilot'),
    });
    // 機長側のカード c1_pilot は残っており、e1 は削除されない
    expect(delChanged.analysis?.cards.some((c) => c.id === 'c1_pilot')).toBe(true);
    expect(delChanged.analysis?.events.some((e) => e.id === 'e1')).toBe(true);
    // 副操縦士側の参加は消えるため、r1（副操縦士発）は整合性維持のため削除され、保存検証に通る
    expect(() => validateSavedAnalysis(delChanged.analysis)).not.toThrow();
    expect(validateAndSanitizeProjectFile({ version: '5.0', vtaData: delChanged }).isValid).toBe(true);

    // 2. 機長側のカードを削除（副操縦士側は残す）
    const delPilotChanged = reconcileAnalysis(schema, {
      ...schema,
      nodes: schema.nodes.filter((n) => n.id !== 'c1_pilot'),
      edges: schema.edges.filter((e) => e.source !== 'c1_pilot' && e.target !== 'c1_pilot'),
    });
    // 副操縦士側のカード c1_copilot は残り、r1 も副操縦士発なので保持される
    expect(delPilotChanged.analysis?.cards.some((c) => c.id === 'c1_copilot')).toBe(true);
    expect(delPilotChanged.analysis?.relations.some((r) => r.id === 'r1')).toBe(true);
    expect(() => validateSavedAnalysis(delPilotChanged.analysis)).not.toThrow();
    expect(validateAndSanitizeProjectFile({ version: '5.0', vtaData: delPilotChanged }).isValid).toBe(true);
  });

  it('supports 1-step undo/redo via useVTAStore and retains valid project reload', () => {
    const { schema } = prepareScenario();
    useVTAStore.setState({ past: [], future: [], toasts: [], previousBackupSnapshot: null });
    const store = useVTAStore.getState();
    store.importProjectJSON(JSON.stringify({ version: '5.0', vtaData: schema }));
    useVTAStore.setState({ past: [], future: [] });

    const initialNodes = useVTAStore.getState().vtaData.nodes;
    const card2 = initialNodes.find((n) => n.title === '復唱')!;
    expect(card2.lane).toBe('機長');

    // 1. レーン変更
    store.updateNode(card2.id, { lane: '副操縦士' });
    expect(useVTAStore.getState().vtaData.nodes.find((n) => n.id === card2.id)?.lane).toBe('副操縦士');
    expect(() => validateSavedAnalysis(useVTAStore.getState().vtaData.analysis)).not.toThrow();

    // 2. Undo
    store.undo();
    expect(useVTAStore.getState().vtaData.nodes.find((n) => n.id === card2.id)?.lane).toBe('機長');
    expect(() => validateSavedAnalysis(useVTAStore.getState().vtaData.analysis)).not.toThrow();

    // 3. Redo
    store.redo();
    expect(useVTAStore.getState().vtaData.nodes.find((n) => n.id === card2.id)?.lane).toBe('副操縦士');
    expect(() => validateSavedAnalysis(useVTAStore.getState().vtaData.analysis)).not.toThrow();

    // 4. ノード削除
    store.deleteNode(card2.id);
    expect(useVTAStore.getState().vtaData.nodes.some((n) => n.id === card2.id)).toBe(false);
    expect(() => validateSavedAnalysis(useVTAStore.getState().vtaData.analysis)).not.toThrow();

    // 5. Undo で復元
    store.undo();
    expect(useVTAStore.getState().vtaData.nodes.some((n) => n.id === card2.id)).toBe(true);
    expect(() => validateSavedAnalysis(useVTAStore.getState().vtaData.analysis)).not.toThrow();
  });
});
