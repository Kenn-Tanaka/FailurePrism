import type { VTASchema, VTAPresentation, VTAAnalysisData } from '../../../types/vta';
import { SubjectPoset } from './subjectPoset';

// Shared with layout; kept here so presentation never depends on the renderer.
export const VTA_LANE_WIDTH = 380;

/**
 * Checks whether an entity can be drill-down expanded into sub-entities (ADR-0011).
 */
export function canDrilldownEntity(entityId: string, analysis: VTAAnalysisData): boolean {
  const ent = analysis.entities.find((e) => e.id === entityId);
  if (!ent) return false;
  if (ent.mergedFrom && ent.mergedFrom.length > 0) return true;
  if (analysis.subjectRanking?.ranks?.some((r) => r.mergedInto === entityId && r.entityId !== entityId)) return true;
  if (analysis.participations.some((p) => p.entityId === entityId && p.mergedFrom?.some((m) => m.entityId !== entityId))) return true;
  const poset = analysis.subjectPoset
    ? SubjectPoset.fromData(analysis.subjectPoset)
    : SubjectPoset.fromEntities(analysis.entities);
  return poset.getImmediateChildren(entityId).length > 0;
}

/**
 * Returns sub-entities associated with a parent entity under Subject Poset and mergedFrom (ADR-0011).
 */
export function getDrilldownSubEntities(
  parentId: string,
  analysis: VTAAnalysisData
): Array<{ id: string; name: string; laneName: string }> {
  const parent = analysis.entities.find((e) => e.id === parentId);
  if (!parent) return [];

  const poset = analysis.subjectPoset
    ? SubjectPoset.fromData(analysis.subjectPoset)
    : SubjectPoset.fromEntities(analysis.entities);

  const childIds = new Set<string>();
  for (const c of poset.getImmediateChildren(parentId)) {
    if (c !== parentId) childIds.add(c);
  }
  if (parent.mergedFrom) {
    for (const m of parent.mergedFrom) {
      if (m !== parentId) childIds.add(m);
    }
  }
  if (analysis.subjectRanking?.ranks) {
    for (const r of analysis.subjectRanking.ranks) {
      if (r.mergedInto === parentId && r.entityId !== parentId) {
        childIds.add(r.entityId);
      }
    }
  }
  for (const p of analysis.participations) {
    if (p.entityId === parentId && p.mergedFrom) {
      for (const m of p.mergedFrom) {
        if (m.entityId !== parentId) childIds.add(m.entityId);
      }
    }
  }

  // 名称解決マップ (analysis.entities + subjectRanking.originalEntities)
  const nameMap = new Map<string, string>();
  for (const e of analysis.entities) nameMap.set(e.id, e.name);
  if (analysis.subjectRanking?.originalEntities) {
    for (const e of analysis.subjectRanking.originalEntities) {
      if (!nameMap.has(e.id)) nameMap.set(e.id, e.name);
    }
  }

  const result: Array<{ id: string; name: string; laneName: string }> = [];
  for (const cid of childIds) {
    const childName = nameMap.get(cid) ?? cid;
    const laneName = childName.includes(parent.name) ? childName : `${parent.name}（${childName}）`;
    result.push({ id: cid, name: childName, laneName });
  }

  return result;
}

export function visibleSchema(schema: VTASchema): VTASchema {
  if (!schema.presentation || !schema.analysis) return schema;
  const { presentation, analysis } = schema;

  // 1. OLAP Drill-down & Roll-up resolution (ADR-0011)
  let effectiveLanes = [...schema.lanes];
  let effectiveNodes = schema.nodes.map((n) => ({ ...n }));
  const drilldownLanes = presentation.drilldownLanes ?? {};

  // Check which parent entities are drill-down expanded
  const expandedParents = Object.entries(drilldownLanes)
    .filter(([_, isExpanded]) => isExpanded)
    .map(([parentId]) => parentId);

  if (expandedParents.length > 0) {
    const cardById = new Map(analysis.cards.map((c) => [c.id, c]));
    const participationsByEvent = new Map<string, string[]>();
    for (const part of analysis.participations) {
      const list = participationsByEvent.get(part.eventId) ?? [];
      list.push(part.entityId);
      participationsByEvent.set(part.eventId, list);
    }

    for (const parentId of expandedParents) {
      const parent = analysis.entities.find((e) => e.id === parentId);
      if (!parent) continue;

      const subEntities = getDrilldownSubEntities(parentId, analysis);
      if (subEntities.length === 0) continue;

      // Insert sub-entity lanes directly after parent lane in effectiveLanes
      const parentLaneIdx = effectiveLanes.indexOf(parent.name);
      if (parentLaneIdx >= 0) {
        const subLaneNames = subEntities.map((s) => s.laneName).filter((name) => !effectiveLanes.includes(name));
        effectiveLanes.splice(parentLaneIdx + 1, 0, ...subLaneNames);
      }

      // Reassign nodes whose events participate via sub-entities
      const subEntityMap = new Map(subEntities.map((s) => [s.id, s.laneName]));
      effectiveNodes = effectiveNodes.map((node) => {
        if (node.lane !== parent.name) return node;

        const card = cardById.get(node.id);
        if (!card) return node;

        // Check if card's events participate under any sub-entity
        let matchedSubLane: string | undefined;
        for (const eventId of card.eventIds) {
          const participants = participationsByEvent.get(eventId) ?? [];
          for (const p of participants) {
            if (subEntityMap.has(p)) {
              matchedSubLane = subEntityMap.get(p);
              break;
            }
          }
          if (matchedSubLane) break;
        }

        if (matchedSubLane) {
          return { ...node, lane: matchedSubLane };
        }
        return node;
      });
    }
  }

  const entityByName = new Map(analysis.entities.map((entity) => [entity.name, entity.id]));
  const nodes = effectiveNodes.filter((node) => {
    // Look up mode using entity name, or strip sub-entity suffix if drilldown lane
    let entityId = entityByName.get(node.lane);
    if (!entityId) {
      const match = node.lane.match(/^(.*?)（.*?）$/);
      if (match) entityId = entityByName.get(match[1]);
    }
    const mode = presentation.lanes[entityId ?? ''] ?? 'auto';
    return mode !== 'hide' && (mode === 'show' || !presentation.suppressedCards[node.id]);
  });

  const active = new Set(nodes.map((node) => node.lane));
  const lanes = effectiveLanes.filter((name) => {
    let entityId = entityByName.get(name);
    if (!entityId) {
      const match = name.match(/^(.*?)（.*?）$/);
      if (match) entityId = entityByName.get(match[1]);
    }
    const mode = presentation.lanes[entityId ?? ''] ?? 'auto';
    return mode === 'show' || (mode !== 'hide' && active.has(name));
  });

  const ids = new Set(nodes.map((node) => node.id));
  return { ...schema, presentation: undefined, lanes,
    nodes: nodes.map((node) => {
      const origLaneIdx = schema.lanes.indexOf(node.lane);
      const safeOrigIdx = origLaneIdx >= 0 ? origLaneIdx : 0;
      const newLaneIdx = lanes.indexOf(node.lane);
      const dx = ((newLaneIdx >= 0 ? newLaneIdx : 0) - safeOrigIdx) * VTA_LANE_WIDTH;
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
  const candidates = analysis.cards.filter((card) => analysis.generation?.schemeId!=='event-chain' && analysis.generation?.schemeId!=='refined-chain' && laneCounts.get(card.laneEntityId) === 1 && !protectedIds.has(card.id)
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
  const result: VTAPresentation = {
    lanes: { ...value.lanes },
    suppressedCards: { ...value.suppressedCards },
    omittedEdges: value.omittedEdges,
    omittedDependencies: Array.isArray(value.omittedDependencies) && value.omittedDependencies.every(k=>typeof k==='string') ? value.omittedDependencies : undefined,
    eventNotes: value.eventNotes,
    defaultObjectDisplayStyle: value.defaultObjectDisplayStyle === 'card' || value.defaultObjectDisplayStyle === 'dot' ? value.defaultObjectDisplayStyle : undefined,
  };
  const maintained = maintainPresentation({ ...schema, presentation: result }).presentation!;
  if (Object.keys(result.suppressedCards).some((id) => !maintained.suppressedCards[id])) {
    throw new Error('除外カードの設定が不正です。イベントの最後のカードまたは保護対象は自動除外できません。');
  }
  return result;
}
