import { beforeEach, describe, expect, it } from 'vitest';
import { useVTAStore } from './vtaStore';
import type { VTASchema } from '../../../types/vta';
import { computeVTADataHash } from '../utils/hash';
import { calculateVTALayout } from '../utils/layout';
import { createConnectionRepairPlan } from '../utils/connectionRepairPlan';
import { generateVTASVG } from '../utils/svgExport';
import { createManualAnalysis } from '../utils/eventAnalysis';

const fixture = (): VTASchema => ({
  lanes: ['A'],
  nodes: ['a', 'b', 'c'].map((id, index) => ({
    id, lane: 'A', title: id, time: '', description: '本文', type: 'normal', measure_type: null,
    position: { x: 123, y: 1000 - index * 400 },
    ...(id === 'b' ? { is_hidden: true, hidden_card_height: 200 } : {}),
  })),
  edges: [{ source: 'a', target: 'c', direction: 'sequential', label: '飛び越し', is_break: true }],
});
const project = (vtaData: VTASchema) => JSON.stringify({ version: '5.0', savedAt: new Date().toISOString(), scenarioText: '',
  vtaData: { ...vtaData, analysis: createManualAnalysis(vtaData) } });

describe('connection repair store action', () => {
  beforeEach(() => {
    expect(useVTAStore.getState().importProjectJSON(project(fixture())).success).toBe(true);
    useVTAStore.setState({ toasts: [], compactView: false });
  });

  it('previews without editing and commits one reversible change with unchanged nodes and positions', () => {
    const before = useVTAStore.getState();
    const hash = computeVTADataHash(before.vtaData, before.scenarioText);
    before.setRegenerationResult({ idealFlow: '', analysisReport: '', generatedAt: '', sourceHash: hash }, hash);
    useVTAStore.setState({ isDirty: false });
    const plan = before.getConnectionRepairPlan();
    expect(plan.issues).toEqual([]);
    expect(useVTAStore.getState().vtaData).toBe(before.vtaData);
    expect(useVTAStore.getState().past).toHaveLength(0);
    expect(useVTAStore.getState().isDirty).toBe(false);

    expect(before.applyConnectionRepair(plan.sourceSignature)).toBe(true);
    const after = useVTAStore.getState();
    expect(after.vtaData.nodes).toEqual(before.vtaData.nodes);
    expect(after.nodes).toBe(before.nodes);
    expect(after.vtaData.edges.map((edge) => [edge.source, edge.target])).toEqual([['a', 'b'], ['b', 'c']]);
    expect(after.past).toHaveLength(1);
    expect(after.isDirty).toBe(true);
    expect(after.isReportOutdated).toBe(true);
    expect(after.getConnectionRepairPlan().changes).toEqual([]);
    expect(after.applyConnectionRepair(after.getConnectionRepairPlan().sourceSignature)).toBe(true);
    expect(useVTAStore.getState().past).toHaveLength(1);

    after.undo();
    expect(useVTAStore.getState().vtaData).toEqual(before.vtaData);
    expect(useVTAStore.getState().isReportOutdated).toBe(false);
    useVTAStore.getState().redo();
    expect(useVTAStore.getState().vtaData).toEqual(after.vtaData);
  });

  it('preserves repaired junction connections through draft restore, project reload, auto-layout and SVG', () => {
    const store = useVTAStore.getState();
    store.applyConnectionRepair(store.getConnectionRepairPlan().sourceSignature);
    const saved = useVTAStore.getState().vtaData;
    expect(useVTAStore.getState().restoreDraftBackup()).toBe(true);
    expect(useVTAStore.getState().vtaData.edges).toEqual(saved.edges);
    expect(useVTAStore.getState().importProjectJSON(project(saved)).success).toBe(true);
    expect(useVTAStore.getState().vtaData.nodes.find((node) => node.id === 'b')?.is_hidden).toBe(true);
    expect(useVTAStore.getState().getConnectionRepairPlan().changes).toEqual([]);
    useVTAStore.getState().recalculateLayout();
    const state = useVTAStore.getState();
    expect(state.getConnectionRepairPlan().changes).toEqual([]);
    const compact = calculateVTALayout(state.vtaData, undefined, undefined, { compact: true, forceRecompute: true });
    expect(createConnectionRepairPlan(state.vtaData, compact.nodes).changes).toEqual([]);
    const svg = generateVTASVG(state.vtaData, state.nodes, state.edges, state.laneBounds, { includeNotes: false });
    expect(svg).toContain('<!-- Edge a -> b -->');
    expect(svg).toContain('<!-- Edge b -> c -->');
    expect(svg).not.toContain('<!-- Edge a -> c -->');
    expect(svg).toContain('data-node-kind="junction"');
  });

  it('rejects a stale preview after the graph changes', () => {
    const before = useVTAStore.getState();
    const plan = before.getConnectionRepairPlan();
    before.updateNode('a', { title: '更新後' });
    const current = useVTAStore.getState();
    expect(current.applyConnectionRepair(plan.sourceSignature)).toBe(false);
    expect(useVTAStore.getState().vtaData).toBe(current.vtaData);
    expect(useVTAStore.getState().past).toHaveLength(current.past.length);
  });

  it('blocks ambiguous geometry without modifying connections or history', () => {
    const before = useVTAStore.getState();
    useVTAStore.setState({ nodes: before.nodes.map((node) => ({ ...node, position: { x: 123, y: 100 } })) });
    const plan = useVTAStore.getState().getConnectionRepairPlan();
    expect(plan.issues.length).toBeGreaterThan(0);
    expect(useVTAStore.getState().applyConnectionRepair(plan.sourceSignature)).toBe(false);
    expect(useVTAStore.getState().vtaData).toBe(before.vtaData);
    expect(useVTAStore.getState().past).toHaveLength(0);
  });
});
