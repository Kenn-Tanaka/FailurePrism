import { beforeEach, describe, expect, it } from 'vitest';
import type { VTASchema } from '../../../types/vta';
import { calculateVTALayout, getOrthogonalStepPath } from './layout';
import { getDisplayRect, getEdgeAnchor, projectDisplayNode, routingObstacles, JUNCTION_SIZE } from './nodeGeometry';
import { pathPoints, segmentBlocked } from './edgeRouting';
import { validateAndSanitizeVTASchema, validateAndSanitizeProjectFile } from './schemaValidator';
import { computeVTADataHash } from './hash';
import { generateVTASVG } from './svgExport';
import { useVTAStore } from '../store/vtaStore';
import { buildFlowGenerationUserPrompt, buildProposalUserPrompt, buildRegenerationUserPrompt } from '../../../services/llm/prompts';

function fixture(): VTASchema {
  return {
    lanes: ['A', 'B', 'C'],
    nodes: [
      { id: 'a', lane: 'A', time: '09:00', title: '開始', description: '開始内容', type: 'normal', measure_type: null },
      { id: 'b', lane: 'A', time: '10:00', title: '中間', description: '非表示でも分析対象', type: 'variation', measure_type: 'elimination' },
      { id: 'c', lane: 'A', time: '11:00', title: '完了', description: '', type: 'normal', measure_type: null },
      { id: 'd', lane: 'B', time: '09:30', title: '連絡', description: '', type: 'normal', measure_type: null },
      { id: 'e', lane: 'C', time: '11:30', title: '確認', description: '', type: 'normal', measure_type: null },
    ],
    edges: [
      { source: 'a', target: 'b', direction: 'sequential' },
      { source: 'b', target: 'c', direction: 'sequential' },
      { source: 'd', target: 'b', direction: 'bidirectional', label: '連絡内容', category: 'information', is_break: true },
      { source: 'b', target: 'e', direction: 'unidirectional' },
    ],
  };
}

describe('user-controlled VTA junctions', () => {
  beforeEach(() => {
    useVTAStore.getState().setVTAData(fixture());
    useVTAStore.setState({ past: [], future: [], regenerationResult: null, isReportOutdated: false });
  });

  it('keeps all content, edges, positions and analysis hash; supports undo/redo and restoring the card', () => {
    const before = useVTAStore.getState();
    const positions = before.nodes.map((node) => node.position);
    const hash = computeVTADataHash(before.vtaData);
    before.setNodeHidden('b', true);
    const hidden = useVTAStore.getState();
    expect(hidden.vtaData.nodes.find((node) => node.id === 'b')).toMatchObject({ is_hidden: true, description: '非表示でも分析対象', measure_type: 'elimination' });
    expect(hidden.vtaData.edges).toEqual(before.vtaData.edges);
    expect(hidden.edges).toEqual(before.edges);
    expect(hidden.nodes.map((node) => node.position)).toEqual(positions);
    expect(computeVTADataHash(hidden.vtaData)).toBe(hash);
    expect(hidden.isDirty).toBe(true);
    hidden.undo();
    expect(useVTAStore.getState().vtaData.nodes.find((node) => node.id === 'b')?.is_hidden).toBeFalsy();
    useVTAStore.getState().redo();
    expect(useVTAStore.getState().vtaData.nodes.find((node) => node.id === 'b')?.is_hidden).toBe(true);
    useVTAStore.getState().setNodeHidden('b', false);
    expect(useVTAStore.getState().nodes.map((node) => node.position)).toEqual(positions);
  });

  it('preserves the measured card center through project, raw JSON and draft restoration', () => {
    const store = useVTAStore.getState();
    store.onNodesChange([{ id: 'b', type: 'dimensions', dimensions: { width: 260, height: 360 } }]);
    useVTAStore.getState().setNodeHidden('b', true);
    const hidden = useVTAStore.getState();
    const rect = getDisplayRect(hidden.nodes.find((node) => node.id === 'b')!);
    const schema = JSON.parse(JSON.stringify(hidden.vtaData));
    const project = { version: '5.0', vtaData: schema, scenarioText: '' };
    expect(validateAndSanitizeProjectFile(project).data?.vtaData.nodes[1].is_hidden).toBe(true);
    expect(useVTAStore.getState().importProjectJSON(JSON.stringify(schema)).success).toBe(false);
    expect(useVTAStore.getState().importProjectJSON(JSON.stringify(project)).success).toBe(true);
    expect(getDisplayRect(useVTAStore.getState().nodes.find((node) => node.id === 'b')!)).toEqual(rect);
    useVTAStore.getState().saveDraftBackup();
    useVTAStore.setState({ vtaData: fixture(), nodes: calculateVTALayout(fixture()).nodes });
    expect(useVTAStore.getState().restoreDraftBackup()).toBe(true);
    expect(getDisplayRect(useVTAStore.getState().nodes.find((node) => node.id === 'b')!)).toEqual(rect);
    expect(useVTAStore.getState().vtaData.edges).toEqual(schema.edges);
  });

  it('never accepts visibility instructions from AI, or coerces nonboolean saved values', () => {
    const schema = fixture();
    schema.nodes[1].is_hidden = true;
    schema.nodes[1].hidden_card_height = 360;
    expect(validateAndSanitizeVTASchema(schema).data?.nodes[1].is_hidden).toBeUndefined();
    useVTAStore.getState().setVTAData(schema);
    expect(useVTAStore.getState().vtaData.nodes[1].is_hidden).toBeUndefined();
    for (const value of [undefined, false, 'true', 1]) {
      const raw = { ...schema, nodes: [{ ...schema.nodes[1], is_hidden: value }], edges: [] };
      expect(validateAndSanitizeVTASchema(raw, true).data?.nodes[0].is_hidden).toBeFalsy();
    }
  });

  it('retains hidden nodes in AI prompts without exporting presentation preferences', () => {
    const schema = fixture();
    schema.nodes[1].is_hidden = true;
    schema.nodes[1].hidden_card_height = 360;
    for (const build of [buildRegenerationUserPrompt, buildFlowGenerationUserPrompt, buildProposalUserPrompt]) {
      const prompt = build('シナリオ', schema);
      expect(prompt).toContain('非表示でも分析対象');
      expect(prompt).toContain('連絡内容');
      expect(prompt).not.toContain('is_hidden');
      expect(prompt).not.toContain('hidden_card_height');
    }
  });

  it('projects a draggable point while ignoring point measurements', () => {
    useVTAStore.getState().setNodeHidden('b', true);
    const before = useVTAStore.getState();
    const node = before.nodes.find((item) => item.id === 'b')!;
    const projected = projectDisplayNode(node);
    expect(projected.type).toBe('vtaJunction');
    expect(projected.measured).toEqual({ width: JUNCTION_SIZE, height: JUNCTION_SIZE });
    expect(projected.draggable).toBeUndefined();
    before.onNodesChange([
      { id: 'b', type: 'dimensions', dimensions: { width: 20, height: 20 } },
      { id: 'b', type: 'position', position: { x: projected.position.x + 10, y: projected.position.y + 15 } },
    ]);
    expect(useVTAStore.getState().nodes.find((item) => item.id === 'b')?.position).toEqual({ x: node.position.x + 10, y: node.position.y + 15 });
    expect(useVTAStore.getState().nodes.find((item) => item.id === 'b')?.measured).toEqual(node.measured);
    expect(useVTAStore.getState().vtaData).toEqual(before.vtaData);
  });

  it('renders a restored card at the former point center immediately', () => {
    useVTAStore.getState().setNodeHidden('b', true);
    const before = useVTAStore.getState().nodes.find((node) => node.id === 'b')!;
    const point = getDisplayRect(before);
    useVTAStore.getState().setNodeHidden('b', false);
    const restored = useVTAStore.getState().nodes.find((node) => node.id === 'b')!;
    const card = getDisplayRect(restored);
    expect(restored.data.is_hidden).toBe(false);
    expect(card.x + card.width / 2).toBeCloseTo(point.x + point.width / 2);
    expect(card.y + card.height / 2).toBeCloseTo(point.y + point.height / 2);
    expect(restored.position).toEqual(useVTAStore.getState().vtaData.nodes.find((node) => node.id === 'b')?.position);
  });

  it.each([false, true])('joins every incident edge at one point in compact=%s, preserving branching and lanes', (compact) => {
    const schema = fixture();
    schema.nodes[1].is_hidden = true;
    schema.nodes[2].is_hidden = true;
    const visible = calculateVTALayout(fixture(), undefined, undefined, { compact, forceRecompute: true });
    const layout = calculateVTALayout(schema, undefined, undefined, { compact, forceRecompute: true });
    expect(layout.height).toBeLessThan(visible.height);
    expect(layout.edges.map(({ source, target }) => ({ source, target }))).toEqual(schema.edges.map(({ source, target }) => ({ source, target })));
    const rects = new Map(layout.nodes.map((node) => [node.id, getDisplayRect(node)]));
    const center = getEdgeAnchor(rects.get('b')!, 'top', true);
    for (const edge of layout.edges) {
      const src = rects.get(edge.source)!;
      const tgt = rects.get(edge.target)!;
      const sourcePosition = edge.sourceHandle!.split('-')[0];
      const targetPosition = edge.targetHandle!.split('-')[0];
      const start = getEdgeAnchor(src, sourcePosition, true);
      const end = getEdgeAnchor(tgt, targetPosition, false);
      const obstacles = routingObstacles(rects, edge.source, edge.target);
      const points = pathPoints(getOrthogonalStepPath({ sourceX: start.x, sourceY: start.y, targetX: end.x, targetY: end.y,
        sourcePosition, targetPosition, sourceNodeTop: src.y, sourceNodeHeight: src.height,
        laneDistance: Number(edge.data?.laneDistance), obstacles })[0]);
      if (edge.source === 'b') expect(points[0]).toEqual([center.x, center.y]);
      if (edge.target === 'b') expect(points.at(-1)).toEqual([center.x, center.y]);
      points.slice(1).forEach((point, i) => expect(segmentBlocked(points[i], point, obstacles)).toBe(false));
    }
  });

  it('routes an unrelated vertical connection around a point instead of implying a junction', () => {
    const rects = new Map([['unrelated', { x: 90, y: 190, width: 20, height: 20, isHidden: true }]]);
    const obstacles = routingObstacles(rects, 'a', 'c');
    const points = pathPoints(getOrthogonalStepPath({ sourceX: 100, sourceY: 400, targetX: 100, targetY: 0,
      sourcePosition: 'top', targetPosition: 'bottom', obstacles })[0]);
    expect(points.length).toBeGreaterThan(2);
    points.slice(1).forEach((point, i) => expect(segmentBlocked(points[i], point, obstacles)).toBe(false));
  });

  it.each([false, true])('exports points and every original edge with notes=%s', (includeNotes) => {
    const schema = fixture();
    schema.nodes[1].is_hidden = true;
    schema.nodes[3].is_hidden = true;
    const snapshot = JSON.stringify(schema);
    const layout = calculateVTALayout(schema);
    const svg = generateVTASVG(schema, layout.nodes, layout.edges, layout.laneBounds, { includeNotes });
    expect(svg.match(/data-node-kind="junction"/g)).toHaveLength(2);
    for (const edge of schema.edges) expect(svg).toContain(`<!-- Edge ${edge.source} -> ${edge.target} -->`);
    expect(svg).toContain('marker-start="url(#arrow-start-bidirectional-point)"');
    expect(svg).toContain('marker-end="url(#arrow-end-bidirectional-point)"');
    expect(svg).toContain('連絡内容');
    expect(svg).toContain('Break Barrier Marker');
    if (includeNotes) {
      expect(svg).toContain('非表示でも分析対象');
      expect(svg).toContain('【図上は接続点】');
    }
    expect(JSON.stringify(schema)).toBe(snapshot);
  });

  it('keeps all lanes and valid bounds when every card is a point, including isolated nodes', () => {
    const schema = fixture();
    schema.nodes.forEach((node) => { node.is_hidden = true; });
    schema.edges = [];
    const layout = calculateVTALayout(schema, undefined, undefined, { forceRecompute: true });
    expect(layout.nodes).toHaveLength(schema.nodes.length);
    expect(layout.laneBounds).toHaveLength(3);
    expect(layout.height).toBeGreaterThan(0);
    expect(layout.nodes.map(projectDisplayNode).every((node) => node.measured?.height === JUNCTION_SIZE)).toBe(true);
  });
});
