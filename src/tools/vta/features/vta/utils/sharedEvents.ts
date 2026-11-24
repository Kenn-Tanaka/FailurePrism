import type { VTASchema, VTAEdgeData, VTAEventRelation } from '../../../types/vta';
import { createAnalysisPoset, resolveCardsForRelationEndpoint } from './subjectPoset';

const SHARED_KIND_PRIORITY: Record<string, number> = {
  impact: 5,
  mutual: 4,
  transfer: 3,
  dependency: 2,
  common: 1,
};

function formatSharedRelationLabel(relation: VTAEventRelation): string {
  if (relation.status === 'omitted') return '未実施';
  if (relation.status === 'unknown') return '関係未判定';
  if (relation.kind === 'common') return '共通影響';
  if (relation.kind === 'mutual') return '相互確認';
  if (relation.receipt === 'unconfirmed') return '送信・受信未確認';
  return (
    {
      information: '情報',
      material: '物・資機材',
      person: '人員',
      money: '資金',
      other: 'リソース',
    }[relation.resource ?? ''] ||
    relation.resource ||
    '伝達'
  );
}

/** Shared identity supplies a neutral connection; resource movement requires explicit evidence. */
export function connectSharedEvents(schema: VTASchema): VTASchema {
  if (!schema.analysis) return schema;
  const analysis = schema.analysis;
  const entityById = new Map(analysis.entities.map((e) => [e.id, e]));
  const poset = createAnalysisPoset(analysis.entities, analysis.subjectPoset);
  const edges = schema.edges.filter((edge) => !edge.generated || !edge.eventId || edge.is_break);
  const excluded = new Set(schema.presentation?.omittedEdges ?? []);
  const add = (edge: VTAEdgeData) => {
    if (!excluded.has(edge.id!) && !edges.some((old) => old.id === edge.id)) {
      const hasPrevBreak = schema.edges.some(
        (old) =>
          old.is_break &&
          (old.id === edge.id ||
            (old.source === edge.source && old.target === edge.target) ||
            Boolean(
              old.relationId &&
                (old.relationId === edge.relationId || edge.bundledRelationIds?.includes(old.relationId))
            ))
      );
      edges.push({ ...edge, ...(hasPrevBreak ? { is_break: true } : {}) });
    }
  };
  for (const event of analysis.events) {
    const cards = analysis.cards.filter((card) => card.eventIds.includes(event.id));
    const connected = new Map(cards.map((card) => [card.id, card.id]));
    const root = (id: string): string => (connected.get(id) === id ? id : root(connected.get(id)!));
    const union = (a: string, b: string) => {
      if (connected.has(a) && connected.has(b)) connected.set(root(a), root(b));
    };
    const sameEventBundles = new Map<
      string,
      Array<{ relation: VTAEventRelation; fromId: string; toId: string }>
    >();
    let unbundledSeq = 0;
    for (const relation of analysis.relations.filter(
      (item) => item.sourceEventId === event.id && item.targetEventId === event.id && item.kind !== 'before'
    )) {
      if (relation.id && excluded.has(`relation:${relation.id}`)) continue;
      const from = resolveCardsForRelationEndpoint(
        cards,
        analysis.participations,
        poset,
        event.id,
        relation.sourceEntityId,
        relation.sourceEntityOrigin,
        'source'
      )[0];
      const to = resolveCardsForRelationEndpoint(
        cards,
        analysis.participations,
        poset,
        event.id,
        relation.targetEntityId,
        relation.targetEntityOrigin,
        'target'
      )[0];
      if (!from || !to || from.id === to.id) continue;
      const fromEnt = entityById.get(from.laneEntityId);
      const toEnt = entityById.get(to.laneEntityId);
      const isConsolidatedPair = Boolean(
        relation.sourceEntityOrigin ||
          relation.targetEntityOrigin ||
          fromEnt?.mergedFrom?.length ||
          toEnt?.mergedFrom?.length ||
          fromEnt?.aggregate ||
          toEnt?.aggregate
      );
      const pairKey = isConsolidatedPair
        ? `consolidated:${[from.id, to.id].sort().join('\u0000')}`
        : `single:${relation.id ?? unbundledSeq++}`;
      const list = sameEventBundles.get(pairKey) ?? [];
      list.push({ relation, fromId: from.id, toId: to.id });
      sameEventBundles.set(pairKey, list);
    }
    for (const group of sameEventBundles.values()) {
      const sorted = [...group].sort((a, b) => {
        const aOmitted = a.relation.status === 'omitted' ? 1 : 0;
        const bOmitted = b.relation.status === 'omitted' ? 1 : 0;
        if (bOmitted !== aOmitted) return bOmitted - aOmitted;
        return (SHARED_KIND_PRIORITY[b.relation.kind] ?? 0) - (SHARED_KIND_PRIORITY[a.relation.kind] ?? 0);
      });
      const primary = sorted[0];
      const rel = primary.relation;
      const allRelIds = [...new Set(group.map((g) => g.relation.id).filter((id): id is string => Boolean(id)))];
      const hasForward = group.some(
        (g) =>
          g.fromId === primary.fromId &&
          g.toId === primary.toId &&
          g.relation.kind !== 'common' &&
          g.relation.status === 'occurred'
      );
      const hasReverse = group.some(
        (g) =>
          g.fromId === primary.toId &&
          g.toId === primary.fromId &&
          g.relation.kind !== 'common' &&
          g.relation.status === 'occurred'
      );
      const hasOmittedOrUnknown = group.some(
        (g) => !g.relation.status || g.relation.status === 'omitted' || g.relation.status === 'unknown'
      );
      const direction: VTAEdgeData['direction'] =
        hasOmittedOrUnknown || rel.kind === 'common'
          ? 'undirected'
          : rel.kind === 'mutual' || (hasForward && hasReverse)
            ? 'bidirectional'
            : 'unidirectional';
      const labels = [...new Set(group.map((g) => formatSharedRelationLabel(g.relation)).filter(Boolean))];
      const id = `relation:${rel.id ?? [event.id, primary.fromId, primary.toId, rel.kind].join(':')}`;
      add({
        id,
        meaning: rel.kind as VTAEdgeData['meaning'],
        relationId: rel.id,
        ...(allRelIds.length > 1 ? { bundledRelationIds: allRelIds } : {}),
        eventId: event.id,
        source: primary.fromId,
        target: primary.toId,
        generated: true,
        direction,
        status: group.some((g) => g.relation.status === 'omitted') ? 'omitted' : rel.status,
        receipt: rel.receipt,
        resource: rel.resource,
        category:
          rel.kind === 'common'
            ? 'other'
            : rel.kind === 'impact'
              ? 'impact'
              : rel.resource === 'person'
                ? 'person'
                : rel.resource === 'material'
                  ? 'material'
                  : rel.resource === 'money'
                    ? 'other'
                    : 'information',
        label: labels.join('・'),
      });
    }
    for (const edge of edges) union(edge.source, edge.target);
    const shown = cards
      .filter(
        (card) =>
          schema.presentation?.lanes[card.laneEntityId] !== 'hide' &&
          (schema.presentation?.lanes[card.laneEntityId] === 'show' ||
            !schema.presentation?.suppressedCards[card.id])
      )
      .sort(
        (a, b) =>
          schema.lanes.indexOf(schema.nodes.find((node) => node.id === a.id)!.lane) -
          schema.lanes.indexOf(schema.nodes.find((node) => node.id === b.id)!.lane)
      );
    for (let i = 1; i < shown.length; i++) {
      const from = shown[i - 1].id,
        to = shown[i].id;
      if (root(from) === root(to)) continue;
      const pair = [from, to].sort();
      add({
        id: `shared:${event.id}:${pair.join(':')}`,
        eventId: event.id,
        meaning: 'association',
        source: from,
        target: to,
        generated: true,
        direction: 'undirected',
        category: 'other',
        label: schema.presentation?.eventNotes?.[event.id] || '同一イベント・関係未判定',
      });
      union(from, to);
    }
  }
  const order = (edge: VTAEdgeData) => {
    const index = edge.id ? schema.edges.findIndex((old) => old.id === edge.id) : schema.edges.indexOf(edge);
    return index < 0 ? Infinity : index;
  };
  edges.sort((a, b) => order(a) - order(b));
  return { ...schema, edges };
}
