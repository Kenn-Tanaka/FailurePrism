import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VTASchema } from '../../src/tools/vta/types/vta';

// autoConnectVTA is replaced so that the test can edit the store while the "LLM" call is in flight.
const autoConnectMock = vi.hoisted(() => ({ impl: null as null | ((schema: VTASchema) => Promise<unknown>) }));
vi.mock('../../src/tools/vta/services/generation/autoConnectionService', () => ({
  autoConnectVTA: (_config: unknown, schema: VTASchema) => autoConnectMock.impl!(schema),
}));

import { useVTAStore } from '../../src/tools/vta/features/vta/store/vtaStore';
import { createManualAnalysis, reconcileAnalysis } from '../../src/tools/vta/features/vta/utils/eventAnalysis';
import { resolveStaleResult, vtaContentFingerprint } from '../../src/tools/vta/features/vta/utils/staleResultGuard';

const baseSchema = (): VTASchema => ({
  lanes: ['機長Ａ', '副操縦員Ａ'],
  nodes: [
    { id: 'c1', lane: '機長Ａ', title: '滑走路進入指示受領', time: '17:45:00', type: 'normal', description: '', measure_type: null, position: { x: 0, y: 0 } },
    { id: 'c2', lane: '副操縦員Ａ', title: '進入復唱', time: '17:45:30', type: 'normal', description: '', measure_type: null, position: { x: 300, y: 100 } },
  ],
  edges: [],
});

afterEach(() => {
  autoConnectMock.impl = null;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('reconcileAnalysis does not mutate the store-held outcome (H1)', () => {
  it('keeps the previous outcome intact when the outcome card is deleted, so undo restores it', () => {
    const schema = baseSchema();
    const analysis = createManualAnalysis(schema);
    const outcomeEventId = analysis.cards.find((card) => card.id === 'c2')!.eventIds[0];
    analysis.outcome = { status: 'identified', eventIds: [outcomeEventId], sourceRefs: [], reason: '停止' };
    const previous: VTASchema = { ...schema, analysis };
    const changed: VTASchema = { ...previous, nodes: previous.nodes.filter((node) => node.id !== 'c2') };

    const reconciled = reconcileAnalysis(previous, changed);

    expect(reconciled.analysis?.outcome?.status).toBe('not_found');
    expect(previous.analysis?.outcome).toEqual({ status: 'identified', eventIds: [outcomeEventId], sourceRefs: [], reason: '停止' });
  });
});

describe('applyLaneMergeProposal does not rename the store-held entity in place (H2)', () => {
  it('restores the original entity name on undo and does not create a spurious manual entity', () => {
    useVTAStore.getState().setVTAData(baseSchema());
    const before = useVTAStore.getState().vtaData.analysis!.entities.map((e) => ({ id: e.id, name: e.name }));
    const captainId = before.find((e) => e.name === '機長Ａ')!.id;
    const copilotId = before.find((e) => e.name === '副操縦員Ａ')!.id;

    useVTAStore.getState().applyLaneMergeProposal({
      id: 'merge_rename', type: 'merge',
      sourceEntityIds: [copilotId], sourceEntityNames: ['副操縦員Ａ'],
      targetEntityId: captainId, suggestedTargetName: 'Ａ機クルー', suggestedKind: 'organization',
      totalEventsCount: 2, reducedLanesCount: 1, reason: 'rename merge', category: 'vehicle_crew',
    }, 'Ａ機クルー');
    const mergedEntities = useVTAStore.getState().vtaData.analysis!.entities;
    expect(mergedEntities).toHaveLength(1);
    expect(mergedEntities[0].name).toBe('Ａ機クルー');
    expect(mergedEntities[0].id).toMatch(/^cmp_/);

    useVTAStore.getState().undo();
    const restored = useVTAStore.getState().vtaData.analysis!.entities;
    expect(restored.find((e) => e.id === captainId)?.name).toBe('機長Ａ');
    expect(restored.map((e) => ({ id: e.id, name: e.name }))).toEqual(before);
  });
});

describe('stale AI results (H3 / M11)', () => {
  it('treats coordinate-only changes as unchanged content', () => {
    const schema = { ...baseSchema(), analysis: createManualAnalysis(baseSchema()) };
    const moved = { ...schema, nodes: schema.nodes.map((n) => ({ ...n, position: { x: n.position!.x + 40, y: n.position!.y + 15 } })) };
    const confirmFn = vi.fn(() => true);
    expect(resolveStaleResult(vtaContentFingerprint(schema), moved, 'テスト', confirmFn)).toBe('unchanged');
    expect(confirmFn).not.toHaveBeenCalled();
  });

  const runAutoConnectWithEdit = async (edit: () => void, confirmAnswer: boolean) => {
    useVTAStore.getState().setVTAData(baseSchema());
    useVTAStore.setState({ toasts: [] });
    const confirmSpy = vi.fn(() => confirmAnswer);
    vi.stubGlobal('confirm', confirmSpy);
    autoConnectMock.impl = async (schema) => {
      edit();
      return {
        schema: { ...schema, nodes: schema.nodes.map((n) => (n.id === 'c1' ? { ...n, title: 'AI結果タイトル' } : n)) },
        addedInterLaneConnections: 0, addedChainConnections: 0, addedEvents: 0, addedSubjects: 0, warnings: [],
      };
    };
    const applied = await useVTAStore.getState().autoConnectNodes();
    return { applied, confirmSpy, state: useVTAStore.getState() };
  };

  const userEditsNodeTitle = () => {
    const current = useVTAStore.getState().vtaData;
    useVTAStore.getState().commitVTAChange({
      schema: { ...current, nodes: current.nodes.map((n) => (n.id === 'c2' ? { ...n, title: '利用者が編集' } : n)) },
    });
  };

  it('discards the result and keeps the user edit when the user declines', async () => {
    const { applied, confirmSpy, state } = await runAutoConnectWithEdit(userEditsNodeTitle, false);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(applied).toBe(false);
    expect(state.vtaData.nodes.find((n) => n.id === 'c2')?.title).toBe('利用者が編集');
    expect(state.vtaData.nodes.find((n) => n.id === 'c1')?.title).not.toBe('AI結果タイトル');
    expect(state.toasts.some((t) => t.message.includes('自動接続の結果は破棄'))).toBe(true);
  });

  it('applies the result when the user accepts', async () => {
    const { applied, confirmSpy, state } = await runAutoConnectWithEdit(userEditsNodeTitle, true);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(applied).toBe(true);
    expect(state.vtaData.nodes.find((n) => n.id === 'c1')?.title).toBe('AI結果タイトル');
  });

  it('applies silently when only coordinates changed during the operation', async () => {
    const moveOnly = () => {
      const current = useVTAStore.getState().vtaData;
      useVTAStore.setState({ vtaData: { ...current, nodes: current.nodes.map((n) => ({ ...n, position: { x: (n.position?.x ?? 0) + 25, y: n.position?.y ?? 0 } })) } });
    };
    const { applied, confirmSpy, state } = await runAutoConnectWithEdit(moveOnly, false);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(applied).toBe(true);
    expect(state.vtaData.nodes.find((n) => n.id === 'c1')?.title).toBe('AI結果タイトル');
  });
});
