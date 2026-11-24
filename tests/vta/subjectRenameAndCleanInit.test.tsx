import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>();
  return {
    ...actual,
    ReactFlowProvider: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', { 'data-testid': 'rf-provider' }, children),
    useReactFlow: () => ({
      fitView: vi.fn(),
      setCenter: vi.fn(),
      getNode: vi.fn(),
    }),
    useViewport: () => ({ x: 0, y: 0, zoom: 1 }),
    Panel: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', { 'data-testid': 'rf-panel' }, children),
    ReactFlow: (props: Record<string, unknown>) =>
      React.createElement('div', { 'data-testid': 'react-flow' }, props.children as React.ReactNode),
    Background: () => null,
    Controls: () => null,
    MiniMap: () => null,
  };
});

import { SAMPLE_SCENARIOS } from '../../src/tools/vta/features/vta/data/sampleData';
import { useVTAStore } from '../../src/tools/vta/features/vta/store/vtaStore';
import { ScenarioInputSection } from '../../src/tools/vta/components/control-panel/ScenarioInputSection';
import { LaneManagementPanel } from '../../src/tools/vta/components/control-panel/LaneManagementPanel';
import { StickyLaneHeaderBar } from '../../src/tools/vta/features/vta/components/StickyLaneHeaderBar';
import { VTACanvas } from '../../src/tools/vta/features/vta/components/VTACanvas';
import { applyLaneRenameTransition } from '../../src/tools/vta/features/vta/utils/subjectRanking';
import {
  captureFineGrainedBase,
  searchOptimalLaneConsolidation,
} from '../../src/tools/vta/services/generation/laneConsolidationOptimizer';
import { projectAnalysis } from '../../src/tools/vta/features/vta/utils/eventAnalysis';
import type { VTAAnalysisData, VTALaneMergeCandidate, VTASchema } from '../../src/tools/vta/types/vta';

describe('Clean Initial State, Sample Removal, and User-Editable Subject Display Names (ADR-0085)', () => {
  it('starts in a completely clean blank initial state and removes built-in sample scenarios', () => {
    expect(SAMPLE_SCENARIOS).toEqual([]);

    // Fresh initial store state before any user input or fixture load
    const initial = useVTAStore.getState();
    expect(initial.scenarioText).toBe('');
    expect(initial.selectedSampleId).toBe('');
    expect(initial.vtaData.lanes).toEqual([]);
    expect(initial.vtaData.nodes).toEqual([]);
    expect(initial.vtaData.edges).toEqual([]);
    expect(initial.nodes).toEqual([]);
    expect(initial.edges).toEqual([]);
    expect(initial.laneBounds).toEqual([]);
    expect(initial.isDirty).toBe(false);

    const inputHtml = renderToStaticMarkup(<ScenarioInputSection />);
    expect(inputHtml).not.toContain('【事例1】');
    expect(inputHtml).not.toContain('【IT/Web事例】');

    const emptyCanvasHtml = renderToStaticMarkup(<VTACanvas isActive />);
    expect(emptyCanvasHtml).toContain('data-testid="vta-empty-canvas-guide"');
    expect(emptyCanvasHtml).toContain('VTA図はまだ作成されていません');
  });

  it('resetProject clears scenarioText, graph data, proposals, draft backup, and aborts active tasks', () => {
    const store = useVTAStore.getState();
    store.setScenarioText('一時入力シナリオ');
    store.setVTAData({
      lanes: ['作業指揮者'],
      nodes: [
        {
          id: 'n1',
          lane: '作業指揮者',
          time: '10:00',
          type: 'normal',
          title: '作業開始指示',
          description: '',
          measure_type: null,
        },
      ],
      edges: [],
    });
    const controller = useVTAStore.getState().createAbortController();
    const prevProjectId = useVTAStore.getState().currentProjectId;
    expect(useVTAStore.getState().hasDraftBackup).toBe(true);

    useVTAStore.getState().resetProject();

    const after = useVTAStore.getState();
    expect(after.currentProjectId).not.toBe(prevProjectId);
    expect(controller.signal.aborted).toBe(true);
    expect(after.scenarioText).toBe('');
    expect(after.vtaData.lanes).toEqual([]);
    expect(after.vtaData.nodes).toEqual([]);
    expect(after.nodes).toEqual([]);
    expect(after.laneBounds).toEqual([]);
    expect(after.isDirty).toBe(false);
    expect(after.hasDraftBackup).toBe(false);
  });

  it('renames a subject / consolidated lane in-place with Undo/Redo, preserving coordinates, entity IDs, cached consolidation labels, and fineGrainedBase immutability', () => {
    const baseAnalysis: VTAAnalysisData = {
      version: 5,
      sources: [{ id: 's1', text: '10:40 待避行動', paragraphs: [{ id: 'p1', text: '10:40 待避行動' }] }],
      facts: [],
      entities: [
        { id: 'A4', name: 'A作業指揮者', kind: 'person', focus: 'high' },
        { id: 'A5', name: 'G現場代理人', kind: 'person', focus: 'high' },
        { id: 'A8', name: 'E作業員', kind: 'person', focus: 'mid' },
        { id: 'A9', name: 'F作業員', kind: 'person', focus: 'mid' },
      ],
      events: [
        {
          id: 'E1',
          origin: 'extraction',
          title: '作業指示',
          description: '散布作業を指示',
          time: '10:30',
          sourceOrder: 0,
          factIds: [],
          sourceRefs: [{ sourceId: 's1', paragraphId: 'p1' }],
          classification: 'variation',
        },
        {
          id: 'E2',
          origin: 'extraction',
          title: 'Eの法面待避',
          description: 'Eが法面へ待避',
          time: '10:45',
          sourceOrder: 1,
          factIds: [],
          sourceRefs: [{ sourceId: 's1', paragraphId: 'p1' }],
          classification: 'normal',
        },
        {
          id: 'E2_f',
          origin: 'extraction',
          title: 'Fの法面待避',
          description: 'Fが法面へ待避',
          time: '10:45',
          sourceOrder: 2,
          factIds: [],
          sourceRefs: [{ sourceId: 's1', paragraphId: 'p1' }],
          classification: 'normal',
        },
        {
          id: 'E3',
          origin: 'extraction',
          title: '待避遅れによる触車',
          description: '軌道内で触車発生',
          time: '10:46',
          sourceOrder: 3,
          factIds: [],
          sourceRefs: [{ sourceId: 's1', paragraphId: 'p1' }],
          classification: 'outcome',
          outcome_kind: 'loss',
        },
      ],
      participations: [
        { eventId: 'E1', entityId: 'A4', role: 'actor', factIds: [] },
        { eventId: 'E1', entityId: 'A5', role: 'confirmed_recipient', factIds: [] },
        { eventId: 'E2', entityId: 'A8', role: 'actor', factIds: [] },
        { eventId: 'E2_f', entityId: 'A9', role: 'actor', factIds: [] },
        { eventId: 'E3', entityId: 'A5', role: 'affected', factIds: [] },
      ],
      relations: [
        {
          id: 'R1',
          kind: 'transfer',
          sourceEventId: 'E1',
          sourceEntityId: 'A4',
          targetEventId: 'E1',
          targetEntityId: 'A5',
          factIds: [],
          resource: '指示',
          status: 'occurred',
          receipt: 'confirmed',
        },
        {
          id: 'R1_e',
          kind: 'transfer',
          sourceEventId: 'E1',
          sourceEntityId: 'A4',
          targetEventId: 'E2',
          targetEntityId: 'A8',
          factIds: [],
          resource: '合図',
          status: 'occurred',
          receipt: 'confirmed',
        },
        {
          id: 'R1_f',
          kind: 'transfer',
          sourceEventId: 'E1',
          sourceEntityId: 'A4',
          targetEventId: 'E2_f',
          targetEntityId: 'A9',
          factIds: [],
          resource: '合図',
          status: 'occurred',
          receipt: 'confirmed',
        },
        {
          id: 'R2',
          kind: 'before',
          sourceEventId: 'E1',
          sourceEntityId: 'A5',
          targetEventId: 'E3',
          targetEntityId: 'A5',
          factIds: [],
          receipt: 'na',
        },
      ],
      cards: [
        { id: 'c0', laneEntityId: 'A4', eventIds: ['E1'] },
        { id: 'c1', laneEntityId: 'A5', eventIds: ['E1'] },
        { id: 'c2', laneEntityId: 'A8', eventIds: ['E2'] },
        { id: 'c3', laneEntityId: 'A9', eventIds: ['E2_f'] },
        { id: 'c4', laneEntityId: 'A5', eventIds: ['E3'] },
      ],
      unassignedEventIds: [],
      outcome: {
        status: 'identified',
        kind: 'loss',
        eventIds: ['E3'],
        sourceRefs: [{ sourceId: 's1', paragraphId: 'p1' }],
        reason: 'テスト帰結',
      },
    };

    const fineSchema = projectAnalysis(baseAnalysis);
    const fineBase = captureFineGrainedBase(fineSchema.analysis!);
    const candidates: VTALaneMergeCandidate[] = [
      {
        id: 'C1',
        kind: 'role_group',
        sourceEntityIds: ['A8', 'A9'],
        targetLabel: '待避作業員',
        targetKind: 'organization',
        semanticCost: 0.04,
        reason: 'E・F作業員の同質待避グループ',
        origin: 'llm',
        recommended: true,
      },
    ];

    const optimized = searchOptimalLaneConsolidation(
      fineBase,
      fineSchema.analysis!,
      candidates,
      [],
      { targetMaxSubjects: 2 }
    );
    expect(optimized.bestSchema.lanes).toContain('待避作業員');

    useVTAStore.getState().setVTAData(optimized.bestSchema);
    const targetCard = useVTAStore.getState().nodes.find((n) => n.data.lane === '待避作業員')!;
    const manualPos = { x: targetCard.position.x + 18, y: targetCard.position.y - 24 };
    useVTAStore.getState().updateNodePosition(targetCard.id, manualPos);
    useVTAStore.getState().setMeasuresProposal({
      summary: '対策案',
      eliminationProposals: [
        {
          nodeId: targetCard.id,
          nodeTitle: targetCard.data.title,
          lane: '待避作業員',
          reason: '待避遅れ防止',
          recommendedAction: '早期合図',
        },
      ],
      breakProposals: [],
      generatedAt: '2026-11-24T10:00:00Z',
    });
    useVTAStore.setState({ past: [], future: [], toasts: [] });

    const beforeGroupEnt = useVTAStore
      .getState()
      .vtaData.analysis!.entities.find((e) => e.name === '待避作業員')!;

    // 1. Rename consolidated group "待避作業員" -> "法面待避作業員（E・F）"
    const ok = useVTAStore.getState().renameLane('待避作業員', '  法面待避作業員（E・F）  ');
    expect(ok).toBe(true);

    const after = useVTAStore.getState();
    expect(after.vtaData.lanes).toEqual(['A作業指揮者', 'G現場代理人', '法面待避作業員（E・F）']);
    expect(after.laneBounds.map((lb) => lb.name)).toEqual(['A作業指揮者', 'G現場代理人', '法面待避作業員（E・F）']);
    expect(after.nodes.find((n) => n.id === targetCard.id)?.position).toEqual(manualPos);
    expect(after.nodes.find((n) => n.id === targetCard.id)?.data.lane).toBe('法面待避作業員（E・F）');
    expect(after.vtaData.analysis?.entities.find((e) => e.id === beforeGroupEnt.id)?.name).toBe(
      '法面待避作業員（E・F）'
    );
    expect(after.vtaData.analysis?.laneConsolidation?.candidates[0].targetLabel).toBe(
      '法面待避作業員（E・F）'
    );
    expect(after.measuresProposal?.eliminationProposals[0].lane).toBe('法面待避作業員（E・F）');
    expect(after.past).toHaveLength(1);

    // Cached re-optimization also preserves the user-edited label
    const reopt = searchOptimalLaneConsolidation(
      after.vtaData.analysis!.fineGrainedBase!,
      after.vtaData.analysis!,
      after.vtaData.analysis!.laneConsolidation!.candidates,
      [],
      { targetMaxSubjects: 2 }
    );
    expect(reopt.bestSchema.lanes).toContain('法面待避作業員（E・F）');

    // 2. Rename fine-grained retained protagonist "G現場代理人" -> "G現場代理人（下請責任者）"
    expect(useVTAStore.getState().renameLane('G現場代理人', 'G現場代理人（下請責任者）')).toBe(true);
    expect(
      useVTAStore.getState().vtaData.analysis?.fineGrainedBase?.entities.find((e) => e.id === 'A5')?.name
    ).toBe('G現場代理人（下請責任者）');

    // 3. Undo restores previous fineGrainedBase without mutating the snapshot!
    useVTAStore.getState().undo();
    expect(useVTAStore.getState().vtaData.lanes).toEqual(['A作業指揮者', 'G現場代理人', '法面待避作業員（E・F）']);
    expect(
      useVTAStore.getState().vtaData.analysis?.fineGrainedBase?.entities.find((e) => e.id === 'A5')?.name
    ).toBe('G現場代理人');

    useVTAStore.getState().undo();
    expect(useVTAStore.getState().vtaData.lanes).toEqual(['A作業指揮者', 'G現場代理人', '待避作業員']);
    expect(
      useVTAStore.getState().vtaData.analysis?.laneConsolidation?.candidates[0].targetLabel
    ).toBe('待避作業員');

    // 4. Redo re-applies cleanly
    useVTAStore.getState().redo();
    expect(useVTAStore.getState().vtaData.lanes).toEqual(['A作業指揮者', 'G現場代理人', '法面待避作業員（E・F）']);
  });

  it('rejects empty, colliding, or reserved subject names and treats identical names as no-op', () => {
    const schema: VTASchema = {
      lanes: ['A作業指揮者', 'B列車見張員'],
      nodes: [
        {
          id: 'n1',
          lane: 'A作業指揮者',
          time: '10:00',
          type: 'normal',
          title: '点呼',
          description: '',
          measure_type: null,
        },
      ],
      edges: [],
    };
    useVTAStore.getState().setVTAData(schema);
    useVTAStore.setState({ past: [], future: [], toasts: [] });

    // No-op when unchanged (even with surrounding whitespace)
    expect(useVTAStore.getState().renameLane('A作業指揮者', '  A作業指揮者  ')).toBe(true);
    expect(useVTAStore.getState().past).toHaveLength(0);

    // Empty name rejected
    expect(useVTAStore.getState().renameLane('A作業指揮者', '   ')).toBe(false);
    // Duplicate existing lane name rejected
    expect(useVTAStore.getState().renameLane('A作業指揮者', 'B列車見張員')).toBe(false);
    // Reserved aggregate name rejected for regular subjects
    expect(applyLaneRenameTransition(useVTAStore.getState().vtaData, 'A作業指揮者', 'その他の関係者').status).toBe(
      'duplicate'
    );
    expect(useVTAStore.getState().past).toHaveLength(0);
  });

  it('renders subject display-name edit buttons in StickyLaneHeaderBar and LaneManagementPanel', () => {
    useVTAStore.getState().setVTAData({
      lanes: ['待避作業員'],
      nodes: [
        {
          id: 'n1',
          lane: '待避作業員',
          time: '10:45',
          type: 'normal',
          title: '待避',
          description: '',
          measure_type: null,
        },
      ],
      edges: [],
    });
    const state = useVTAStore.getState();

    const headerHtml = renderToStaticMarkup(
      <StickyLaneHeaderBar
        laneBounds={state.laneBounds}
        onRenameLane={() => true}
      />
    );
    expect(headerHtml).toContain('aria-label="待避作業員の表示名を編集"');

    const panelHtml = renderToStaticMarkup(
      <LaneManagementPanel
        schema={state.vtaData}
        onVisibility={() => {}}
        onAdd={() => true}
        onRename={() => true}
        onSimplify={() => {}}
      />
    );
    expect(panelHtml).toContain('aria-label="待避作業員の名称を変更"');
  });
});
