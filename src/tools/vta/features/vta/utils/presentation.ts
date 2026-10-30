import type { VTASchema, VTAPresentation } from '../../../types/vta';

// Shared with layout; kept here so presentation never depends on the renderer.
export const VTA_LANE_WIDTH = 380;

export function visibleSchema(schema: VTASchema): VTASchema {
  if (!schema.presentation || !schema.analysis) return schema;
  const { presentation, analysis } = schema;
  const entityByName = new Map(analysis.entities.map((entity) => [entity.name, entity.id]));
  const nodes = schema.nodes.filter((node) => {
    const mode = presentation.lanes[entityByName.get(node.lane) ?? ''] ?? 'auto';
    return mode !== 'hide' && (mode === 'show' || !presentation.suppressedCards[node.id]);
  });
  const active = new Set(nodes.map((node) => node.lane));
  const lanes = schema.lanes.filter((name) => {
    const mode = presentation.lanes[entityByName.get(name) ?? ''] ?? 'auto';
    return mode === 'show' || (mode !== 'hide' && active.has(name));
  });
  const ids = new Set(nodes.map((node) => node.id));
  return { ...schema, presentation: undefined, lanes,
    nodes: nodes.map((node) => {
      const dx = (lanes.indexOf(node.lane) - schema.lanes.indexOf(node.lane)) * VTA_LANE_WIDTH;
      return { ...node,
        ...(node.position ? { position: { x: node.position.x + dx, y: node.position.y } } : {}),
        ...(node.compact_position ? { compact_position: { x: node.compact_position.x + dx, y: node.compact_position.y } } : {}),
      };
    }),
    edges: schema.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)),
    custom_notes: schema.custom_notes?.filter((note) => !note.nodeId || ids.has(note.nodeId)),
  };
}

/** Stored positions use all lanes; display positions use visible lanes only. */
export function canonicalPosition(schema: VTASchema, lane: string, position: { x: number; y: number }) {
  const visible = visibleSchema(schema);
  return { x: position.x + (schema.lanes.indexOf(lane) - visible.lanes.indexOf(lane)) * VTA_LANE_WIDTH, y: position.y };
}

export function protectedCardIds(schema: VTASchema): Set<string> {
  const analysis = schema.analysis;
  const protectedIds = new Set<string>();
  if (!analysis) return protectedIds;
  for (const card of analysis.cards) {
    const node = schema.nodes.find((item) => item.id === card.id);
    if (schema.presentation?.lanes[card.laneEntityId] === 'show' || node?.is_hidden
      || node?.supplementary_note?.trim() || node?.measure_type
      || schema.custom_notes?.some((note) => note.nodeId === card.id)
      || card.eventIds.some((id) => analysis.events.find((event) => event.id === id)?.origin === 'manual')
      || analysis.participations.some((part) => part.entityId === card.laneEntityId && card.eventIds.includes(part.eventId) && part.origin === 'manual')
      || schema.edges.some((edge) => (edge.source === card.id || edge.target === card.id)
        && (edge.is_break || (!edge.generated && (edge.label || edge.direction !== 'sequential'))))) protectedIds.add(card.id);
  }
  // Resolve against ALL cards, never against the reduced drawing. Ambiguous endpoints stay protected.
  for (const relation of analysis.relations.filter((item) => item.kind !== 'before')) {
    for (const [eventId, entityId] of [[relation.sourceEventId, relation.sourceEntityId], [relation.targetEventId, relation.targetEntityId]]) {
      analysis.cards.filter((card) => card.eventIds.includes(eventId!) && (!entityId || card.laneEntityId === entityId))
        .forEach((card) => protectedIds.add(card.id));
    }
  }
  return protectedIds;
}

/** No LLM, no mutation, no dependence on the current visual lane order. */
export function planCardSimplification(schema: VTASchema): VTAPresentation {
  const lanes = { ...schema.presentation?.lanes };
  const suppressedCards: Record<string, string> = {};
  const analysis = schema.analysis;
  if (!analysis) return { lanes, suppressedCards, omittedEdges: schema.presentation?.omittedEdges, omittedDependencies:schema.presentation?.omittedDependencies, eventNotes: schema.presentation?.eventNotes };
  const protectedIds = protectedCardIds(schema);
  const laneCounts = new Map<string, number>();
  const eventCounts = new Map<string, number>();
  for (const card of analysis.cards) {
    laneCounts.set(card.laneEntityId, (laneCounts.get(card.laneEntityId) ?? 0) + 1);
    // A manually hidden lane cannot serve as the last displayed representative.
    if (lanes[card.laneEntityId] !== 'hide') card.eventIds.forEach((id) => eventCounts.set(id, (eventCounts.get(id) ?? 0) + 1));
  }
  const entityOrder = new Map(analysis.entities.map((entity, index) => [entity.id, index]));
  const candidates = analysis.cards.filter((card) => analysis.generation?.schemeId!=='event-chain' && laneCounts.get(card.laneEntityId) === 1 && !protectedIds.has(card.id)
    && lanes[card.laneEntityId] !== 'hide').sort((a, b) =>
    (entityOrder.get(b.laneEntityId)! - entityOrder.get(a.laneEntityId)!) || b.id.localeCompare(a.id));
  for (const card of candidates) {
    if (!card.eventIds.every((id) => (eventCounts.get(id) ?? 0) > 1)) continue;
    suppressedCards[card.id] = `単独カードのイベント ${card.eventIds.join('、')} は他レーンにも表示されています。`;
    card.eventIds.forEach((id) => eventCounts.set(id, eventCounts.get(id)! - 1));
  }
  return { lanes, suppressedCards };
}

/** Editing may restore cards to maintain invariants, but must never newly suppress one. */
export function maintainPresentation(schema: VTASchema): VTASchema {
  if (!schema.presentation || !schema.analysis) return schema;
  const protectedIds = protectedCardIds(schema);
  const cards = schema.analysis.cards;
  const suppressedCards = Object.fromEntries(Object.entries(schema.presentation.suppressedCards).filter(([id]) => {
    const card = cards.find((item) => item.id === id);
    return card && !protectedIds.has(id) && cards.filter((item) => item.laneEntityId === card.laneEntityId).length === 1;
  }));
  // Explicitly hidden lanes still count here: a visibility edit must not reopen another lane.
  // A real deletion, however, must restore the last remaining canonical representative.
  const represented = new Set(cards.filter((card) => !suppressedCards[card.id]).flatMap((card) => card.eventIds));
  for (const card of cards) {
    if (suppressedCards[card.id] && card.eventIds.some((id) => !represented.has(id))) {
      delete suppressedCards[card.id];
      card.eventIds.forEach((id) => represented.add(id));
    }
  }
  return { ...schema, presentation: { ...schema.presentation, lanes: { ...schema.presentation.lanes }, suppressedCards } };
}

export function validatePresentation(raw: unknown, schema: VTASchema): VTAPresentation | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object') throw new Error('レーン表示設定が不正です。');
  const value = raw as VTAPresentation;
  if (!value.lanes || Array.isArray(value.lanes) || typeof value.lanes !== 'object'
    || !value.suppressedCards || Array.isArray(value.suppressedCards) || typeof value.suppressedCards !== 'object') throw new Error('表示設定が不正です。');
  if (Object.entries(value.lanes).some(([id, mode]) => !schema.analysis?.entities.some((entity) => entity.id === id)
    || !['auto', 'show', 'hide'].includes(mode))) throw new Error('レーン表示設定の主体または状態が不正です。');
  if (Object.entries(value.suppressedCards).some(([id, reason]) => !schema.analysis?.cards.some((card) => card.id === id)
    || typeof reason !== 'string' || !reason.trim())) throw new Error('除外カードの参照が不正です。');
  if (value.omittedEdges !== undefined && (!Array.isArray(value.omittedEdges) || value.omittedEdges.some((id) => typeof id !== 'string' || !id.trim()))) throw new Error('削除済み接続の設定が不正です。');
  if (value.eventNotes !== undefined && (!value.eventNotes || Array.isArray(value.eventNotes) || typeof value.eventNotes !== 'object' || Object.entries(value.eventNotes).some(([id,note]) => !schema.analysis?.events.some((event) => event.id === id) || typeof note !== 'string'))) throw new Error('共通イベント注記が不正です。');
  const result = { lanes: { ...value.lanes }, suppressedCards: { ...value.suppressedCards }, omittedEdges: value.omittedEdges, omittedDependencies: Array.isArray(value.omittedDependencies) && value.omittedDependencies.every(k=>typeof k==='string') ? value.omittedDependencies : undefined, eventNotes: value.eventNotes };
  const maintained = maintainPresentation({ ...schema, presentation: result }).presentation!;
  if (Object.keys(result.suppressedCards).some((id) => !maintained.suppressedCards[id])) {
    throw new Error('除外カードの設定が不正です。イベントの最後のカードまたは保護対象は自動除外できません。');
  }
  return result;
}
