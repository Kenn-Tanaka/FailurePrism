import type { VTASchema, VTAEdgeData } from '../../../types/vta';

/** Shared identity supplies a neutral connection; resource movement requires explicit evidence. */
export function connectSharedEvents(schema: VTASchema): VTASchema {
  if (!schema.analysis) return schema;
  const analysis = schema.analysis;
  const edges = schema.edges.filter((edge) => !edge.generated || !edge.eventId || edge.is_break);
  const excluded = new Set(schema.presentation?.omittedEdges ?? []);
  const add = (edge: VTAEdgeData) => {
    if (!excluded.has(edge.id!) && !edges.some((old) => old.id === edge.id)) edges.push({...edge,...(schema.edges.some(old=>old.id===edge.id&&old.is_break)?{is_break:true}:{})});
  };
  for (const event of analysis.events) {
    const cards = analysis.cards.filter((card) => card.eventIds.includes(event.id));
    const connected = new Map(cards.map((card) => [card.id, card.id]));
    const root = (id: string): string => connected.get(id) === id ? id : root(connected.get(id)!);
    const union = (a: string, b: string) => { if (connected.has(a) && connected.has(b)) connected.set(root(a), root(b)); };
    for (const relation of analysis.relations.filter((item) => item.sourceEventId === event.id && item.targetEventId === event.id && item.kind !== 'before')) {
      const from = cards.find((card) => card.laneEntityId === relation.sourceEntityId);
      const to = cards.find((card) => card.laneEntityId === relation.targetEntityId);
      if (!from || !to || from.id === to.id) continue;
      const id = `relation:${relation.id ?? [event.id, from.id, to.id, relation.kind].join(':')}`;
      const direction = !relation.status || relation.status === 'omitted' || relation.status === 'unknown' || relation.kind === 'common' ? 'undirected' : relation.kind === 'mutual' ? 'bidirectional' : 'unidirectional';
      add({ id, meaning: relation.kind as VTAEdgeData['meaning'], relationId: relation.id, eventId: event.id, source: from.id, target: to.id, generated: true,
        direction, status: relation.status, receipt: relation.receipt, resource: relation.resource,
        category: relation.kind === 'common' ? 'other' : relation.kind === 'impact' ? 'impact' : relation.resource === 'person' ? 'person' : relation.resource === 'material' ? 'material' : relation.resource === 'money' ? 'other' : 'information',
        label: relation.status === 'omitted' ? '未実施' : relation.status === 'unknown' ? '関係未判定' : relation.kind === 'common' ? '共通影響' : relation.kind === 'mutual' ? '相互確認' : relation.receipt === 'unconfirmed' ? '送信・受信未確認' : ({ information: '情報', material: '物・資機材', person: '人員', money: '資金', other: 'リソース' }[relation.resource ?? ''] || relation.resource || '伝達') });
    }
    for (const edge of edges) union(edge.source, edge.target);
    const shown = cards.filter((card) => schema.presentation?.lanes[card.laneEntityId] !== 'hide'
      && (schema.presentation?.lanes[card.laneEntityId] === 'show' || !schema.presentation?.suppressedCards[card.id]))
      .sort((a, b) => schema.lanes.indexOf(schema.nodes.find((node) => node.id === a.id)!.lane) - schema.lanes.indexOf(schema.nodes.find((node) => node.id === b.id)!.lane));
    for (let i = 1; i < shown.length; i++) {
      const from = shown[i - 1].id, to = shown[i].id;
      if (root(from) === root(to)) continue;
      const pair = [from, to].sort();
      add({ id: `shared:${event.id}:${pair.join(':')}`, eventId: event.id, meaning: 'association', source: from, target: to, generated: true, direction: 'undirected', category: 'other', label: schema.presentation?.eventNotes?.[event.id] || '同一イベント・関係未判定' });
      union(from, to);
    }
  }
  const order = (edge: VTAEdgeData) => { const index = edge.id ? schema.edges.findIndex((old) => old.id === edge.id) : schema.edges.indexOf(edge); return index < 0 ? Infinity : index; };
  edges.sort((a,b) => order(a) - order(b));
  return { ...schema, edges };
}
