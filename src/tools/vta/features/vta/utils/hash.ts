import { VTASchema } from '../../../types/vta';

/**
 * Computes a deterministic 32-bit FNV-1a hash hex string from an input string.
 */
export function fnv1a(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    // 32-bit FNV prime: 16777619
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Computes a deterministic semantic hash of VTA data and scenario text.
 * Visual coordinates (position: x, y) are excluded so that moving nodes on the
 * canvas does not unnecessarily mark analysis reports as outdated.
 */
export function computeVTADataHash(vtaData: VTASchema, scenarioText: string = ''): string {
  const normalizedNodes = (vtaData.nodes || [])
    .map((n) => ({
      id: n.id,
      lane: n.lane || '',
      time: n.time || '',
      title: n.title || '',
      description: n.description || '',
      type: n.type,
      measure_type: n.measure_type || null,
      supplementary_note: n.supplementary_note || '',
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const normalizedEdges = (vtaData.edges || []).filter((edge) => !((edge.generated || edge.meaning === 'association') && edge.eventId && !edge.relationId))
    .map((e) => ({
      source: e.source,
      target: e.target,
      is_break: Boolean(e.is_break),
      direction: e.direction || 'unidirectional',
      label: e.label || '',
    }))
    .sort((a, b) => {
      const srcCmp = a.source.localeCompare(b.source);
      return srcCmp !== 0 ? srcCmp : a.target.localeCompare(b.target);
    });

  const normalizedCustomNotes = (vtaData.custom_notes || [])
    .map((cn) => ({
      id: cn.id,
      nodeId: cn.nodeId || '',
      title: cn.title || '',
      content: cn.content || '',
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  const payload = JSON.stringify({
    scenario: scenarioText.trim(),
    lanes: (vtaData.lanes || []).slice().sort(),
    nodes: normalizedNodes,
    edges: normalizedEdges,
    custom_notes: normalizedCustomNotes,
    summary: (vtaData.supplementary_summary || '').trim(),
    analysis: vtaData.analysis ? {
      context: vtaData.analysis.context, outcome:vtaData.analysis.outcome,
      background: vtaData.analysis.dispositions?.filter((item) => item.kind !== 'excluded'),
      sources: [...vtaData.analysis.sources].sort((a, b) => a.id.localeCompare(b.id)),
      facts: [...vtaData.analysis.facts].sort((a, b) => a.id.localeCompare(b.id)),
      events: [...vtaData.analysis.events].sort((a, b) => a.id.localeCompare(b.id)),
      entities: [...vtaData.analysis.entities].sort((a, b) => a.id.localeCompare(b.id)),
      participations: [...vtaData.analysis.participations].sort((a, b) => `${a.eventId}/${a.entityId}`.localeCompare(`${b.eventId}/${b.entityId}`)),
      relations: [...vtaData.analysis.relations].sort((a, b) => `${a.sourceEventId}/${a.targetEventId}`.localeCompare(`${b.sourceEventId}/${b.targetEventId}`)),
      cards: [...vtaData.analysis.cards].sort((a, b) => a.id.localeCompare(b.id)),
      unassignedEventIds: [...vtaData.analysis.unassignedEventIds].sort(),
    } : undefined,
  });

  return fnv1a(payload);
}
