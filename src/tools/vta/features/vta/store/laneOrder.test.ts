import { beforeEach, describe, expect, it } from 'vitest';
import { useVTAStore } from './vtaStore';
import { SAMPLE_SCENARIOS } from '../data/sampleData';
import { LANE_WIDTH, calculateVTALayout } from '../utils/layout';
import { computeVTADataHash } from '../utils/hash';
import { generateVTASVG } from '../utils/svgExport';

describe('VTA lane order', () => {
  beforeEach(() => {
    useVTAStore.getState().loadSample(SAMPLE_SCENARIOS[0].id);
    useVTAStore.setState({ past: [], future: [] });
  });

  it('moves adjacent lanes and their saved card positions, then recomputes edge handles', () => {
    const before = useVTAStore.getState();
    const lane = before.vtaData.lanes[1];
    const firstLane = before.vtaData.lanes[0];
    const laneNode = before.nodes.find((node) => node.data.lane === lane)!;
    const firstLaneNode = before.nodes.find((node) => node.data.lane === firstLane)!;
    const manualPosition = { x: laneNode.position.x + 37, y: laneNode.position.y + 23 };
    before.updateNodePosition(laneNode.id, manualPosition);
    useVTAStore.setState({ past: [], future: [] });
    const beforeHash = computeVTADataHash(useVTAStore.getState().vtaData);
    const beforeEdge = useVTAStore.getState().edges.find((edge) => edge.source === 'node_2' && edge.target === 'node_4')!;
    expect(beforeEdge.sourceHandle).toBe('left-source');

    useVTAStore.getState().moveLane(lane, -1);
    const after = useVTAStore.getState();
    expect(after.vtaData.lanes).toEqual([lane, firstLane, before.vtaData.lanes[2]]);
    expect(after.past).toHaveLength(1);
    expect(after.vtaData.edges).toEqual(before.vtaData.edges);
    expect(after.vtaData.nodes.map((node) => node.id)).toEqual(before.vtaData.nodes.map((node) => node.id));
    expect(after.vtaData.nodes.find((node) => node.id === laneNode.id)?.position).toEqual({
      x: manualPosition.x - LANE_WIDTH,
      y: manualPosition.y,
    });
    expect(after.nodes.find((node) => node.id === firstLaneNode.id)?.position).toEqual({
      x: firstLaneNode.position.x + LANE_WIDTH,
      y: firstLaneNode.position.y,
    });
    expect(after.laneBounds.map((bound) => bound.name)).toEqual(after.vtaData.lanes);
    expect(after.laneBounds.map((bound) => bound.x)).toEqual(before.laneBounds.map((bound) => bound.x));
    const afterEdge = after.edges.find((edge) => edge.id === beforeEdge.id)!;
    expect(afterEdge.sourceHandle).toBe('right-source');
    expect(afterEdge.targetHandle).toBe('left-target');
    expect(afterEdge.data?.laneDistance).toBe(1);
    expect(computeVTADataHash(after.vtaData)).toBe(beforeHash);

    const compact = calculateVTALayout(after.vtaData, undefined, undefined, { compact: true, forceRecompute: true });
    expect(compact.laneBounds.map((bound) => bound.name)).toEqual(after.vtaData.lanes);
    const svg = generateVTASVG(after.vtaData, after.nodes, after.edges, after.laneBounds, { includeNotes: false });
    expect(svg.indexOf(lane)).toBeLessThan(svg.indexOf(firstLane));

    after.undo();
    expect(useVTAStore.getState().vtaData.lanes).toEqual(before.vtaData.lanes);
    expect(useVTAStore.getState().nodes.find((node) => node.id === laneNode.id)?.position).toEqual(manualPosition);
    useVTAStore.getState().redo();
    expect(useVTAStore.getState().vtaData.lanes).toEqual(after.vtaData.lanes);
    expect(useVTAStore.getState().nodes.find((node) => node.id === laneNode.id)?.position).toEqual({
      x: manualPosition.x - LANE_WIDTH,
      y: manualPosition.y,
    });

    const saved = useVTAStore.getState().vtaData;
    useVTAStore.getState().setVTAData(saved);
    expect(useVTAStore.getState().vtaData.lanes).toEqual(after.vtaData.lanes);
    expect(useVTAStore.getState().nodes.find((node) => node.id === laneNode.id)?.position).toEqual({
      x: manualPosition.x - LANE_WIDTH,
      y: manualPosition.y,
    });
  });

  it('ignores invalid moves and can exchange an empty lane', () => {
    const initial = useVTAStore.getState().vtaData;
    useVTAStore.getState().moveLane(initial.lanes[0], -1);
    useVTAStore.getState().moveLane(initial.lanes.at(-1)!, 1);
    useVTAStore.getState().moveLane('存在しない列', 1);
    expect(useVTAStore.getState().past).toHaveLength(0);

    useVTAStore.getState().setVTAData({ ...initial, lanes: [...initial.lanes, '空の列'] });
    useVTAStore.getState().moveLane('空の列', -1);
    const after = useVTAStore.getState();
    expect(after.vtaData.lanes).toEqual([initial.lanes[0], initial.lanes[1], '空の列', initial.lanes[2]]);
    expect(after.vtaData.nodes).toHaveLength(initial.nodes.length);
    expect(after.laneBounds.map((bound) => bound.name)).toEqual(after.vtaData.lanes);
  });
});
