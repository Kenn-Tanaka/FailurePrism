import { beforeEach, describe, expect, it } from 'vitest';
import { useVTAStore } from './vtaStore';
import { projectAnalysis, sourceFromText } from '../utils/eventAnalysis';
import { parseLedger, inspectLedger } from '../utils/eventLedger';
import { calculateVTALayout, LANE_WIDTH } from '../utils/layout';
import { visibleSchema } from '../utils/presentation';
import { generateVTASVG } from '../utils/svgExport';
import { computeVTADataHash } from '../utils/hash';

function fixture() {
  const source = sourceFromText('09:00 共同行動');
  const text = '[主体]\nID\t名称\t種類\nA\tA\tperson\nB\tB\tperson\nC\tC\tperson\n[イベント]\nID\t時刻\t見出し\t内容\t主体と役割\t原文参照\t区分\nE\t09:00\t共同行動\t内容\tA:actor,B:actor,C:actor\tp1\trecorded\n[関係]\n[共有カード]\n[整理]\n[完了]';
  return projectAnalysis(inspectLedger(parseLedger(text), source).analysis!);
}
beforeEach(() => {
  useVTAStore.getState().setVTAData(fixture());
  useVTAStore.setState({ compactView: false, past: [], future: [], toasts: [] });
});

describe('lane display operations', () => {
  it('restores hidden cards with one undo step and keeps all participation on edits', () => {
    const before = useVTAStore.getState().vtaData;
    useVTAStore.getState().setLaneVisibility('C', 'show');
    let state = useVTAStore.getState();
    expect(state.laneBounds.map((lane) => lane.name)).toEqual(['A', 'C']);
    expect(state.nodes).toHaveLength(2);
    expect(state.past).toHaveLength(1);
    state.undo(); expect(useVTAStore.getState().nodes).toHaveLength(1);
    useVTAStore.getState().redo();
    state = useVTAStore.getState();
    state.updateNodeSupplementaryNote(state.nodes[1].id, '残す補足');
    expect(useVTAStore.getState().vtaData.analysis?.participations).toEqual(before.analysis?.participations);
    expect(useVTAStore.getState().vtaData.nodes).toHaveLength(3);
  });

  it.each(['detail', 'compact'] as const)('drags and snaps a card across hidden columns in %s mode', (mode) => {
    useVTAStore.getState().setLaneVisibility('A', 'hide');
    useVTAStore.getState().setLaneVisibility('C', 'show');
    useVTAStore.getState().setSnapToLaneCenter(true);
    const schema = useVTAStore.getState().vtaData;
    const view = calculateVTALayout(schema, undefined, undefined, { compact: mode === 'compact', positionField: mode === 'compact' ? 'compact_position' : 'position' });
    const node = view.nodes[0];
    const position = { x: node.position.x + 51, y: node.position.y + 31 };
    useVTAStore.getState().onNodesChange([{ type: 'position', id: node.id, position, dragging: true }], mode);
    useVTAStore.getState().onNodesChange([{ type: 'position', id: node.id, position, dragging: false }], mode);
    const after = useVTAStore.getState();
    const stored = after.vtaData.nodes.find((item) => item.id === node.id)!;
    const savedPosition = mode === 'compact' ? stored.compact_position! : stored.position!;
    expect(savedPosition.x).toBe(node.position.x + 2 * LANE_WIDTH);
    expect(savedPosition.y).toBe(position.y);
    const projected = calculateVTALayout(after.vtaData, undefined, undefined, { compact: mode === 'compact', positionField: mode === 'compact' ? 'compact_position' : 'position' });
    expect(projected.nodes[0].position.x).toBe(node.position.x);
    expect(after.vtaData.analysis?.cards).toHaveLength(3);
    after.setSnapToLaneCenter(false);
  });

  it('persists lane visibility through project and draft restore without changing the analysis hash', () => {
    const hash = computeVTADataHash(useVTAStore.getState().vtaData);
    useVTAStore.getState().setLaneVisibility('C', 'show');
    useVTAStore.getState().setLaneVisibility('A', 'hide');
    const state = useVTAStore.getState();
    expect(computeVTADataHash(state.vtaData)).toBe(hash);
    state.saveDraftBackup(); expect(state.checkDraftBackup()).toBe(true); expect(state.restoreDraftBackup()).toBe(true);
    expect(useVTAStore.getState().laneBounds.map((lane) => lane.name)).toEqual(['C']);
    expect(state.importProjectJSON(JSON.stringify({ version: '5.0', vtaData: state.vtaData })).success).toBe(true);
    expect(useVTAStore.getState().laneBounds.map((lane) => lane.name)).toEqual(['C']);
    const loaded = useVTAStore.getState();
    const svg = generateVTASVG(loaded.vtaData, loaded.nodes, loaded.edges, loaded.laneBounds, { includeEmptyLanes: true });
    expect(svg).toContain('ノード: 1件');
    expect(visibleSchema(loaded.vtaData).lanes).toEqual(['C']);
  });

  it('retains a newly added empty lane, and rejects empty or duplicate names', () => {
    const state = useVTAStore.getState();
    expect(state.addLane('追加主体')).toBe(true);
    expect(useVTAStore.getState().laneBounds.map((lane) => lane.name)).toContain('追加主体');
    expect(state.addLane('追加主体')).toBe(false);
    expect(state.addLane(' ')).toBe(false);
    useVTAStore.getState().simplifyCards();
    expect(useVTAStore.getState().laneBounds.map((lane) => lane.name)).toContain('追加主体');
    expect(useVTAStore.getState().vtaData.analysis?.entities).toHaveLength(4);
  });

  it('closes a preceding column without leaving a gap or losing the saved offset', () => {
    useVTAStore.getState().setLaneVisibility('C', 'show');
    const before = useVTAStore.getState();
    const node = before.nodes.find((item) => item.data.lane === 'C')!;
    before.setLaneVisibility('A', 'hide');
    const after = useVTAStore.getState();
    expect(after.nodes.find((item) => item.id === node.id)?.position.x).toBe(node.position.x - LANE_WIDTH);
    after.setLaneVisibility('A', 'show');
    expect(useVTAStore.getState().nodes.find((item) => item.id === node.id)?.position.x).toBe(node.position.x);
  });

  it('preserves relative position after moving a visible lane past a hidden one', () => {
    useVTAStore.getState().setLaneVisibility('C', 'show');
    const before = useVTAStore.getState();
    const node = before.nodes.find((item) => item.data.lane === 'C')!;
    before.updateNodePosition(node.id, { x: node.position.x + 17, y: node.position.y + 23 });
    useVTAStore.getState().moveLane('C', -1);
    expect(useVTAStore.getState().nodes.find((item) => item.id === node.id)?.position).toEqual({ x: node.position.x + 17, y: node.position.y + 23 });
    useVTAStore.getState().setLaneVisibility('B', 'show');
    expect(useVTAStore.getState().nodes.find((item) => item.id === node.id)?.position).toEqual({ x: node.position.x + 17, y: node.position.y + 23 });
  });
});
