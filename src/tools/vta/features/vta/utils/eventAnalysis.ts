import { readSourceRefs } from './eventLedger';
import { debugRecorder } from '../../../services/debugRecorder';
import { validateStoredRelationAttributes } from './relationContract';
import type {
  VTAAnalysisData, VTACardRef, VTAEdgeData, VTAEntity, VTAEvent, VTAEventRelation,
  VTAFact, VTANodeData, VTANodeType, VTAParticipation, VTASchema, VTASource, VTASourceRef,
} from '../../../types/vta';
import { connectSharedEvents } from './sharedEvents';
import { maintainPresentation, planCardSimplification } from './presentation';
import { validateDispositions } from './normalization';
import { repairGeneratedLaneSequence } from './generatedLaneSequence';
import { SubjectPoset } from './subjectPoset';

const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const string = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const unique = <T>(items: T[]): T[] => [...new Set(items)];

export function sourceFromText(text: string): VTASource {
  const paragraphs: VTASource['paragraphs'] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let remaining = rawLine.trim();
    while (remaining.length > 2400) {
      const candidates = ['。', '．', '.', '！', '!', '？', '?', '、', '，', ',', ' ']
        .map((separator) => remaining.lastIndexOf(separator, 2400))
        .filter((position) => position >= 1200);
      const end = candidates.length ? Math.max(...candidates) + 1 : 2400;
      const part = remaining.slice(0, end).trim();
      if (part) paragraphs.push({ id: `p${paragraphs.length + 1}`, text: part });
      remaining = remaining.slice(end).trim();
    }
    if (remaining) paragraphs.push({ id: `p${paragraphs.length + 1}`, text: remaining });
  }
  return { id: 'source_1', text, paragraphs };
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} が配列ではありません。`);
  return value;
}

function requireId(raw: Record<string, unknown>, label: string): string {
  const id = string(raw.id);
  if (!id) throw new Error(`${label} のIDがありません。`);
  return id;
}

function rejectDuplicateIds(items: Array<{ id: string }>, label: string) {
  if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error(`${label} のIDが重複しています。`);
}

/** A citation must quote an exact span of the immutable source paragraph. */
export function validateFacts(raw: unknown, sources: VTASource[]): VTAFact[] {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const facts = requireArray(record(raw) ? raw.facts : undefined, '事実一覧').map((item, index) => {
    if (!record(item)) throw new Error(`事実 ${index + 1} が不正です。`);
    const id = requireId(item, '事実');
    const text = string(item.text);
    if (!text) throw new Error(`事実 ${id} の本文がありません。`);
    const kind = item.kind;
    if (kind !== 'recorded' && kind !== 'claim' && kind !== 'assessment') throw new Error(`事実 ${id} の区分が不正です。`);
    const evidence = requireArray(item.evidence, `事実 ${id} の根拠`).map((ref) => {
      if (!record(ref)) throw new Error(`事実 ${id} の根拠が不正です。`);
      const sourceId = string(ref.sourceId);
      const paragraphId = string(ref.paragraphId);
      const quote = string(ref.quote);
      const paragraph = sourceById.get(sourceId)?.paragraphs.find((part) => part.id === paragraphId);
      if (!quote || !paragraph?.text.includes(quote)) throw new Error(`事実 ${id} の引用が原文と一致しません。`);
      return { sourceId, paragraphId, quote };
    });
    if (!evidence.length) throw new Error(`事実 ${id} に根拠がありません。`);
    return { id, text, kind, evidence } satisfies VTAFact;
  });
  rejectDuplicateIds(facts, '事実');
  return facts;
}

/** Read only a leading temporal label; never infer a clock time from the narrative body. */
function paragraphTiming(text: string): string {
  const match = /^(?:[-*+]\s+)?((?:\d{4}-\d{2}-\d{2}\s+)?(?:\d{1,2}:\d{2}(?::\d{2})?|時刻記録なし|時刻不明)(?:\s*(?:ごろ|頃|以降|以前|以後))?(?:\s*[（(][^）)\n]+[）)])?(?:\s*(?:ごろ|頃|以降|以前|以後))?)/.exec(text.trim());
  return match?.[1].trim() ?? /^(?:[-*+]\s+)?(\d{4}-\d{2}-\d{2})(?=\s|$)/.exec(text.trim())?.[1] ?? '';
}

function eventSourceTimings(event: Pick<VTAEvent, 'factIds'>, facts: VTAFact[], sources: VTASource[]): string[] {
  const refs = facts.filter((fact) => event.factIds.includes(fact.id)).flatMap((fact) => fact.evidence);
  return unique(refs.map((ref) => {
    const paragraph = sources.find((source) => source.id === ref.sourceId)?.paragraphs.find((part) => part.id === ref.paragraphId);
    return paragraph ? paragraphTiming(paragraph.text) : '';
  }).filter(Boolean));
}

function eventFallbackTime(event: Pick<VTAEvent, 'factIds'>, facts: VTAFact[], sources: VTASource[]): string {
  const times = eventSourceTimings(event, facts, sources);
  if (times.length !== 1) return '';
  const refs = facts.filter((fact) => event.factIds.includes(fact.id)).flatMap((fact) => fact.evidence);
  for (const ref of refs) {
    const paragraph = sources.find((source) => source.id === ref.sourceId)?.paragraphs.find((part) => part.id === ref.paragraphId);
    if (!paragraph) continue;
    const prefix = paragraphTiming(paragraph.text);
    // A paragraph can describe later actions too; its heading time cannot be assigned to them blindly.
    if (prefix && /\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}/.test(paragraph.text.slice(paragraph.text.indexOf(prefix) + prefix.length))) return '';
  }
  return times[0];
}

function canShareTiming(events: VTAEvent[], facts: VTAFact[], sources: VTASource[]): boolean {
  // Missing timing is not evidence that an event happened at its neighbour's time.
  const times = events.map((event) => event.time);
  if (unique(times).length > 1) return false;
  const sourceTimes = events.map((event) => eventSourceTimings(event, facts, sources));
  if (unique(sourceTimes.flat()).length > 1) return false;
  if (sourceTimes.some((items) => items.length) && sourceTimes.some((items) => !items.length)) return false;
  return true;
}

export function validateEvents(raw: unknown, facts: VTAFact[], allowManual = false, allowEmpty = false,
  sources: VTASource[] = []): VTAEvent[] {
  const factById = new Map(facts.map((fact) => [fact.id, fact]));
  const events = requireArray(record(raw) ? raw.events : undefined, 'イベント一覧').map((item, index) => {
    if (!record(item)) throw new Error(`イベント ${index + 1} が不正です。`);
    const id = requireId(item, 'イベント');
    const factIds = unique(requireArray(item.factIds, `イベント ${id} の根拠ID`).map(string));
    const sourceRefs = item.sourceRefs === undefined ? undefined : readSourceRefs(item.sourceRefs, sources, item.origin !== 'manual');
    if ((!sourceRefs && !factIds.length && (!allowManual || item.origin !== 'manual')) || factIds.some((factId) => !factById.has(factId))) throw new Error(`イベント ${id} が存在しない事実を参照しています。`);
    const title = string(item.title);
    if (!title) throw new Error(`イベント ${id} の見出しがありません。`);
    if (item.recordKind !== undefined && !['recorded', 'claim', 'assessment'].includes(String(item.recordKind))) throw new Error('イベントの記録区分が不正です。');
    let time = string(item.time);
    const sourceTimes = eventSourceTimings({ factIds }, facts, sources);
    if (!sourceRefs && time && !factIds.some((factId) => factById.get(factId)!.evidence.some((ref) => ref.quote.includes(time)))
      && !sourceTimes.includes(time)) time = '';
    if (!sourceRefs && !allowManual && !time) time = eventFallbackTime({ factIds }, facts, sources);
    const evidenceOrder = factIds.flatMap((factId) => factById.get(factId)?.evidence ?? [])
      .map((ref) => /^p(\d+)$/.exec(ref.paragraphId))
      .filter((match): match is RegExpExecArray => Boolean(match))
      .map((match) => Number(match[1]) - 1);
    return {
      id, title, description: string(item.description), time, sourceRefs,
      recordKind: item.recordKind === undefined ? undefined : item.recordKind as VTAEvent['recordKind'],
      sourceOrder: !allowManual && evidenceOrder.length ? Math.min(...evidenceOrder)
        : typeof item.sourceOrder === 'number' && Number.isFinite(item.sourceOrder) ? item.sourceOrder : index,
      origin: allowManual && item.origin === 'manual' ? 'manual' : 'extraction', factIds, classification: 'unclassified',
    } satisfies VTAEvent;
  });
  rejectDuplicateIds(events, 'イベント');
  if (!events.length && !allowEmpty) throw new Error('根拠のあるイベントがありません。');
  return events.sort((a, b) => a.sourceOrder - b.sourceOrder);
}

export function validateParticipants(
  raw: unknown, events: VTAEvent[], facts: VTAFact[], allowManual = false,
  onOptionalWarning?: (message: string) => void, sources: VTASource[] = []
) {
  const eventById = new Map(events.map((event) => [event.id, event]));
  const factIds = new Set(facts.map((fact) => fact.id));
  const rawParentById = new Map<string, string[]>();
  const entities: VTAEntity[] = requireArray(record(raw) ? raw.entities : undefined, '主体一覧').map((item, index) => {
    if (!record(item)) throw new Error(`主体 ${index + 1} が不正です。`);
    const id = requireId(item, '主体');
    const name = string(item.name);
    if (!name) throw new Error(`主体 ${id} の名称がありません。`);
    const kind = item.kind;
    if (kind !== 'person' && kind !== 'organization' && kind !== 'machine' && kind !== 'other') throw new Error(`主体 ${id} の区分が不正です。`);
    if(item.resolution!==undefined&&item.resolution!=='unresolved')throw new Error('主体の確定状態が不正です。');
    const focus = item.focus !== undefined && ['reporter', 'high', 'mid', 'low'].includes(String(item.focus))
      ? (item.focus as VTAEntity['focus'])
      : undefined;
    let focusSourceRefs: VTASourceRef[] | undefined;
    if (Array.isArray(item.focusSourceRefs)) {
      const validRefs = item.focusSourceRefs.filter((ref): ref is VTASourceRef =>
        record(ref) && typeof ref.sourceId === 'string' && typeof ref.paragraphId === 'string'
        && (!sources.length || sources.some((s) => s.id === ref.sourceId && s.paragraphs.some((p) => p.id === ref.paragraphId)))
      ).map((ref) => ({ sourceId: ref.sourceId, paragraphId: ref.paragraphId }));
      if (validRefs.length) focusSourceRefs = validRefs;
    }
    const parentList: string[] = [];
    if (typeof item.parentEntityId === 'string' && item.parentEntityId.trim()) {
      parentList.push(item.parentEntityId.trim());
    }
    if (Array.isArray(item.parentEntityIds)) {
      for (const p of item.parentEntityIds) {
        if (typeof p === 'string' && p.trim()) parentList.push(p.trim());
      }
    }
    if (parentList.length) {
      rawParentById.set(id, unique(parentList));
    }
    return {
      id,
      name,
      kind,
      ...(item.resolution === 'unresolved' ? { resolution: 'unresolved' as const } : {}),
      ...(focus ? { focus } : {}),
      ...(focusSourceRefs ? { focusSourceRefs } : {}),
      ...(item.aggregate === true ? { aggregate: true as const } : {}),
      ...(item.parentEntityIds && Array.isArray(item.parentEntityIds) ? { parentEntityIds: unique(item.parentEntityIds.filter((p): p is string => typeof p === 'string' && Boolean(p.trim())).map(p => p.trim())) } : {}),
    };
  });
  rejectDuplicateIds(entities, '主体');
  if (new Set(entities.map((entity) => entity.name)).size !== entities.length) throw new Error('同名の主体が重複しています。');
  const entityIds = new Set(entities.map((entity) => entity.id));
  if (rawParentById.size) {
    const entityById = new Map(entities.map((e) => [e.id, e]));
    for (const [id, parents] of rawParentById) {
      const valid = parents.filter((p) => p !== id && entityById.has(p));
      if (valid.length) {
        const ent = entityById.get(id)!;
        ent.parentEntityId = valid[0];
        ent.parentEntityIds = valid;
      }
    }
    // SubjectPoset によるサイクル検証と安全除去
    const poset = SubjectPoset.fromEntities(entities);
    const { removedEdges } = poset.removeCycles();
    if (removedEdges.length > 0) {
      for (const edge of removedEdges) {
        const ent = entityById.get(edge.childId);
        if (ent) {
          if (ent.parentEntityId === edge.parentId) delete ent.parentEntityId;
          if (ent.parentEntityIds) {
            ent.parentEntityIds = ent.parentEntityIds.filter((p) => p !== edge.parentId);
            if (!ent.parentEntityIds.length) delete ent.parentEntityIds;
            else if (!ent.parentEntityId) ent.parentEntityId = ent.parentEntityIds[0];
          }
        }
      }
    }
  }
  const knownOriginEntityIds = new Set<string>(entityIds);
  if (record(raw) && record(raw.subjectRanking) && Array.isArray(raw.subjectRanking.originalEntities)) {
    for (const orig of raw.subjectRanking.originalEntities) {
      if (record(orig) && typeof orig.id === 'string' && orig.id.trim()) {
        knownOriginEntityIds.add(orig.id.trim());
      }
    }
  }
  const roles = new Set(['actor', 'target', 'affected', 'intended_recipient', 'confirmed_recipient']);
  const participations: VTAParticipation[] = requireArray(record(raw) ? raw.participations : undefined, '関与一覧').map((item) => {
    if (!record(item)) throw new Error('関与データが不正です。');
    const eventId = string(item.eventId);
    const entityId = string(item.entityId);
    const role = item.role;
    const related = eventById.get(eventId);
    const refs = unique(requireArray(item.factIds, `関与 ${eventId}/${entityId} の根拠`).map(string));
    if (!related || !entityIds.has(entityId) || !roles.has(String(role))
      || (!related.sourceRefs && !refs.length && !(allowManual && (item.origin === 'manual' || related.origin === 'manual'))) || refs.some((id) => !related.factIds.includes(id))) {
      throw new Error(`関与 ${eventId}/${entityId} の参照・役割が不正です。`);
    }
    if(item.evidenceBasis!==undefined&&!['recorded','source-context','user'].includes(String(item.evidenceBasis)))throw new Error('割当の根拠区分が不正です。');
    if(item.inferred!==undefined&&typeof item.inferred!=='boolean')throw new Error('主体の推定表示は真偽値で指定してください。');
    const sourceRefs=item.sourceRefs===undefined?undefined:readSourceRefs(item.sourceRefs,sources);
    if(item.evidenceBasis==='source-context'&&(!sourceRefs?.length||!string(item.reason)))throw new Error('文脈による割当には原文参照と理由が必要です。');
    let mergedFrom: VTAParticipation['mergedFrom'];
    if (Array.isArray(item.mergedFrom)) {
      const validMerged = item.mergedFrom.filter((m): m is { entityId: string; role: VTAParticipation['role'] } => {
        if (!record(m) || typeof m.entityId !== 'string' || !m.entityId.trim() || !roles.has(String(m.role))) {
          onOptionalWarning?.(`関与 ${eventId}/${entityId} の統合元データを除外しました。`);
          return false;
        }
        if (record(raw) && raw.subjectRanking !== undefined && !knownOriginEntityIds.has(m.entityId.trim())) {
          onOptionalWarning?.(`関与 ${eventId}/${entityId} の未定義統合元 (${m.entityId}) を除外しました。`);
          return false;
        }
        return true;
      }).map((m) => ({ entityId: m.entityId.trim(), role: m.role as VTAParticipation['role'] }));
      if (validMerged.length) mergedFrom = validMerged;
    }
    return { eventId, entityId, role: role as VTAParticipation['role'], factIds: refs,...(item.inferred!==undefined?{inferred:item.inferred}:{}),...(mergedFrom?{mergedFrom}:{}),sourceRefs,reason:string(item.reason)||undefined,evidenceBasis:item.evidenceBasis as VTAParticipation['evidenceBasis'],generation:validateGeneration(item.generation),
      origin: allowManual && item.origin === 'manual' ? 'manual' : 'extraction' };
  });
  const participationPairs = participations.map((part) => `${part.eventId}\u0000${part.entityId}`);
  if (unique(participationPairs).length !== participationPairs.length) throw new Error('同一イベントと主体の役割が重複しています。');
  const optionalArray = (value: unknown, label: string): unknown[] => {
    if (value == null) return [];
    if (Array.isArray(value)) return value;
    if (!onOptionalWarning) return requireArray(value, label);
    onOptionalWarning(`${label}を除外しました: 配列ではありません。`);
    return [];
  };
  const parseRelation = (item: unknown): VTAEventRelation => {
    if (!record(item)) throw new Error('関係データが不正です。');
    const sourceEventId = string(item.sourceEventId);
    const targetEventId = string(item.targetEventId);
    const sourceEntityId = string(item.sourceEntityId) || undefined;
    const targetEntityId = string(item.targetEntityId) || undefined;
    const kind = item.kind;
    const refs = unique(requireArray(item.factIds, '関係の根拠').map(string));
    const sourceRefs = item.sourceRefs === undefined ? undefined : readSourceRefs(item.sourceRefs, sources);
    if (!eventById.has(sourceEventId) || !eventById.has(targetEventId)
      || (sourceEntityId && !entityIds.has(sourceEntityId)) || (targetEntityId && !entityIds.has(targetEntityId))
      || !['before','transfer','impact','mutual','common','dependency'].includes(String(kind))
      || (!sourceRefs && !refs.length) || refs.some((id) => !factIds.has(id)
        || (!eventById.get(sourceEventId)?.factIds.includes(id) && !eventById.get(targetEventId)?.factIds.includes(id)))) {
      throw new Error('関係の参照または根拠が不正です。');
    }
    const rawPosetData = record(raw) && record(raw.subjectPoset) ? (raw.subjectPoset as any) : undefined;
    const validationPoset = rawPosetData ? SubjectPoset.fromData(rawPosetData) : SubjectPoset.fromEntities(entities);
    const participates = (eventId: string, entityId: string) =>
      participations.some((part) =>
        part.eventId === eventId && (
          part.entityId === entityId ||
          part.mergedFrom?.some((m) => m.entityId === entityId) ||
          validationPoset.isAncestor(part.entityId, entityId) ||
          validationPoset.isDescendant(part.entityId, entityId)
        )
      );
    if ((sourceEntityId && !participates(sourceEventId, sourceEntityId))
      || (targetEntityId && !participates(targetEventId, targetEntityId))) {
      throw new Error('関係の主体がイベントに関与していません。');
    }
    validateStoredRelationAttributes({...item,kind,sourceEventId,targetEventId,sourceEntityId,targetEntityId} as VTAEventRelation);
    if(item.evidenceBasis!==undefined&&!['recorded','source-assessment','source-context','user'].includes(String(item.evidenceBasis)))throw new Error('関係の根拠区分が不正です。');
    if(item.evidenceBasis==='source-context'&&(!sourceRefs?.length||!string(item.explanation||item.adoptionReason)))throw new Error('文脈による関係には原文参照と理由が必要です。');
    const provenance = item.provenance === 'llm-proposal' || item.provenance === 'user' ? item.provenance : undefined;
    const rawSourceOrigin = string(item.sourceEntityOrigin) || undefined;
    const rawTargetOrigin = string(item.targetEntityOrigin) || undefined;
    const sourceEntityOrigin = rawSourceOrigin && (!(record(raw) && raw.subjectRanking !== undefined) || knownOriginEntityIds.has(rawSourceOrigin)) ? rawSourceOrigin : undefined;
    const targetEntityOrigin = rawTargetOrigin && (!(record(raw) && raw.subjectRanking !== undefined) || knownOriginEntityIds.has(rawTargetOrigin)) ? rawTargetOrigin : undefined;
    return { explanation:string(item.explanation)||undefined,evidenceBasis:['recorded','source-assessment','source-context','user'].includes(String(item.evidenceBasis))?item.evidenceBasis as 'recorded':undefined, generation:validateGeneration(item.generation), sourceEventId, targetEventId, sourceEntityId, targetEntityId, ...(sourceEntityOrigin?{sourceEntityOrigin}:{}), ...(targetEntityOrigin?{targetEntityOrigin}:{}), kind: kind as VTAEventRelation['kind'], factIds: refs, sourceRefs, id: string(item.id) || undefined, resource: string(item.resource) || undefined, status: item.status as VTAEventRelation['status'], receipt: item.receipt as VTAEventRelation['receipt'], proposalId: string(item.proposalId) || undefined, proposalReason: string(item.proposalReason) || undefined, adoptionReason: string(item.adoptionReason) || undefined, provenance };
  };
  const relations: VTAEventRelation[] = [];
  optionalArray(record(raw) ? raw.relations : undefined, '関係一覧').forEach((item, index) => {
    try {
      relations.push(parseRelation(item));
    } catch (error) {
      if (!onOptionalWarning) throw error;
      onOptionalWarning(`関係 ${index + 1} を除外しました: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  rejectDuplicateIds(relations.filter((relation) => relation.id).map((relation) => ({ id: relation.id! })), '関係');
  if (onOptionalWarning) {
    const accepted: VTAEventRelation[] = [];
    const pathExists = (from: string, to: string, seen = new Set<string>()): boolean => {
      if (from === to) return true;
      if (seen.has(from)) return false;
      seen.add(from);
      return accepted.some((relation) => relation.kind === 'before' && relation.sourceEventId === from
        && pathExists(relation.targetEventId, to, seen));
    };
    for (const relation of relations) {
      if (relation.kind === 'before' && pathExists(relation.targetEventId, relation.sourceEventId)) {
        onOptionalWarning(`関係 ${relation.sourceEventId} → ${relation.targetEventId} を除外しました: 前後関係が循環します。`);
      } else accepted.push(relation);
    }
    relations.splice(0, relations.length, ...accepted);
  }
  const beforeTargets = new Map<string, string[]>();
  for (const relation of relations.filter((item) => item.kind === 'before')) {
    beforeTargets.set(relation.sourceEventId, [...(beforeTargets.get(relation.sourceEventId) ?? []), relation.targetEventId]);
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) throw new Error('イベントの前後関係が循環しています。');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const next of beforeTargets.get(id) ?? []) visit(next);
    visiting.delete(id);
    visited.add(id);
  };
  for (const event of events) visit(event.id);
  const parseGroup = (item: unknown) => {
    if (!record(item)) throw new Error('表示グループが不正です。');
    const entityId = string(item.entityId);
    const eventIds = unique(requireArray(item.eventIds, '表示グループのイベント').map(string));
    if (!entityIds.has(entityId) || eventIds.length < 2 || eventIds.some((id) => !eventById.has(id)
      || !participations.some((p) => p.eventId === id && p.entityId === entityId))) throw new Error('表示グループの主体またはイベントが不正です。');
    if (eventIds.some((from) => {
      const seen = new Set<string>();
      const reachesMember = (current: string): boolean => {
        if (seen.has(current)) return false;
        seen.add(current);
        return (beforeTargets.get(current) ?? []).some((next) => (next !== from && eventIds.includes(next)) || reachesMember(next));
      };
      return reachesMember(from);
    })) {
      throw new Error('前後関係が明示されたイベントは一枚にまとめられません。');
    }
    const times = unique(eventIds.map((id) => eventById.get(id)!.time).filter(Boolean));
    if (times.length > 1) throw new Error('異なる時刻が明示されたイベントは一枚にまとめられません。');
    if (!allowManual && !canShareTiming(eventIds.map((id) => eventById.get(id)!), facts, sources)) {
      throw new Error('原文の日時が異なる、または時刻不明と時刻付きのイベントは一枚にまとめられません。');
    }
    return { entityId, eventIds };
  };
  const groups: Array<{ entityId: string; eventIds: string[] }> = [];
  const groupedPairs = new Set<string>();
  optionalArray(record(raw) ? raw.cardGroups : undefined, '表示グループ').forEach((item, index) => {
    try {
      const group = parseGroup(item);
      const pairs = group.eventIds.map((eventId) => `${eventId}\u0000${group.entityId}`);
      if (pairs.some((pair) => groupedPairs.has(pair))) throw new Error('同じイベントと主体が複数の表示グループに含まれます。');
      pairs.forEach((pair) => groupedPairs.add(pair));
      groups.push(group);
    } catch (error) {
      if (!onOptionalWarning) throw error;
      onOptionalWarning(`表示グループ ${index + 1} を除外しました: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  return { entities, participations, relations, groups };
}

export function buildAnalysis(
  source: VTASource, facts: VTAFact[], events: VTAEvent[],
  parsed: ReturnType<typeof validateParticipants>
): VTAAnalysisData {
  // Rendering also checks original paragraph timing, even if an LLM omitted/generalised event.time.
  events = events.map((event) => {
    if (event.sourceRefs || event.time || event.origin === 'manual') return event;
    const time = eventFallbackTime(event, facts, [source]);
    return time ? { ...event, time } : event;
  });
  const eventById = new Map(events.map((event) => [event.id, event]));
  const cards: VTACardRef[] = [];
  const occupied = new Set<string>();
  for (const group of parsed.groups) {
    if (!canShareTiming(group.eventIds.map((id) => eventById.get(id)!), facts, [source])) continue;
    for (const eventId of group.eventIds) {
      const key = `${eventId}\u0000${group.entityId}`;
      if (occupied.has(key)) throw new Error('同じイベントと主体が複数カードに割り当てられています。');
      occupied.add(key);
    }
    cards.push({ id: `card_${cards.length + 1}`, laneEntityId: group.entityId, eventIds: group.eventIds });
  }
  const hasExplicitOrder = (left: string, right: string) => {
    const visited = new Set<string>();
    const reaches = (source: string, target: string): boolean => {
      if (source === target) return true;
      if (visited.has(source)) return false;
      visited.add(source);
      return parsed.relations.some((relation) => relation.kind === 'before' && relation.sourceEventId === source
        && reaches(relation.targetEventId, target));
    };
    if (reaches(left, right)) return true;
    visited.clear();
    return reaches(right, left);
  };
  // Events without demonstrable order share one card on that entity's lane.
  for (const entity of parsed.entities) {
    const ordered = parsed.participations.filter((item) => item.entityId === entity.id)
      .map((item) => eventById.get(item.eventId)!).sort((a, b) => a.sourceOrder - b.sourceOrder);
    let open: VTACardRef | undefined;
    for (const event of ordered) {
      const key = `${event.id}\u0000${entity.id}`;
      if (occupied.has(key)) { open = undefined; continue; }
      occupied.add(key);
      const openEvents = open?.eventIds.map((id) => eventById.get(id)!) ?? [];
      const canGroup = !event.sourceRefs && open && canShareTiming([...openEvents, event], facts, [source])
        && openEvents.every((item) => !hasExplicitOrder(item.id, event.id));
      if (canGroup) open!.eventIds.push(event.id);
      else {
        open = { id: `card_${cards.length + 1}`, laneEntityId: entity.id, eventIds: [event.id] };
        cards.push(open);
      }
    }
  }
  return {
    version: 5, sources: [source], facts, events, entities: parsed.entities,
    participations: parsed.participations, relations: parsed.relations, cards,
    unassignedEventIds: events.filter((event) => !cards.some((card) => card.eventIds.includes(event.id))).map((event) => event.id),
  };
}

/** Only event data owns shared text and classification; cards own placement. */
export function projectAnalysis(analysis: VTAAnalysisData, previous?: VTASchema): VTASchema {
  const eventById = new Map(analysis.events.map((event) => [event.id, event]));
  const entityById = new Map(analysis.entities.map((entity) => [entity.id, entity]));
  const previousById = new Map(previous?.nodes.map((node) => [node.id, node]) ?? []);
  const preserveCardOrder = Boolean(previous?.analysis && analysis.cards.length === previous.analysis.cards.length
    && analysis.cards.every((card) => previous.analysis!.cards.some((old) => old.id === card.id
      && old.laneEntityId === card.laneEntityId && old.eventIds.join('\u0000') === card.eventIds.join('\u0000'))));
  const orderedCards = [...analysis.cards].sort((a, b) => preserveCardOrder
    ? (previous!.nodes.findIndex((node) => node.id === a.id) + 1 || Infinity) - (previous!.nodes.findIndex((node) => node.id === b.id) + 1 || Infinity)
    :
    Math.min(...a.eventIds.map((id) => eventById.get(id)?.sourceOrder ?? Infinity))
    - Math.min(...b.eventIds.map((id) => eventById.get(id)?.sourceOrder ?? Infinity)));
  const lanes = unique([...orderedCards.map((card) => entityById.get(card.laneEntityId)?.name ?? ''), ...analysis.entities.map((entity) => entity.name)].filter(Boolean));
  const laneOrder = previous?.lanes ?? [];
  const allLanes = [...laneOrder, ...lanes.filter((name) => !laneOrder.includes(name))];
  const laneSequence = new Map<string, number>();
  const nodes: VTANodeData[] = orderedCards.map((card) => {
    const events = card.eventIds.map((id) => eventById.get(id)).filter((event): event is VTAEvent => Boolean(event));
    if (!events.length) throw new Error(`カード ${card.id} にイベントがありません。`);
    const lane = entityById.get(card.laneEntityId)?.name;
    if (!lane) throw new Error(`カード ${card.id} の主体がありません。`);
    const matchedPrevNodes = previous?.nodes.filter((node) =>
      node.id === card.id || node.event_ids?.some((evId) => card.eventIds.includes(evId))
    ) ?? [];
    const previousNode = matchedPrevNodes.find((n) => n.id === card.id)
      ?? matchedPrevNodes.find((n) => n.lane === lane)
      ?? matchedPrevNodes[0];
    const notes = unique(
      matchedPrevNodes.map((n) => n.supplementary_note).filter((note): note is string => Boolean(note && note.trim()))
    );
    const supplementary_note = notes.join('\n\n');
    const types = unique(events.map((event) => event.classification));
    const isOutcome = card.eventIds.some((id) => analysis.outcome?.status === 'identified' && analysis.outcome.eventIds.includes(id))
      || types.includes('outcome');
    const type: VTANodeType = isOutcome ? 'outcome'
      : types.length === 1 ? types[0]
      : types.includes('variation') ? 'variation'
      : types.includes('unclassified') ? 'unclassified' : 'undetermined';
    const outcome_kind: import('../../../types/vta').VTAOutcomeKind | undefined = type === 'outcome'
      ? (analysis.outcome?.kind ?? events.find((e) => e.outcome_kind)?.outcome_kind ?? previousNode?.outcome_kind ?? 'loss')
      : undefined;
    const variation_factor: import('../../../types/vta').VariationFactorDetail | undefined = type === 'variation'
      ? (events.find((e) => e.variationFactor)?.variationFactor ?? previousNode?.variation_factor)
      : undefined;
    const sequence_order = preserveCardOrder ? (previousNode?.sequence_order ?? laneSequence.get(lane) ?? 0)
      : (laneSequence.get(lane) ?? 0);
    laneSequence.set(lane, sequence_order + 1);

    const partRoles = analysis.participations
      .filter((p) => p.entityId === card.laneEntityId && card.eventIds.includes(p.eventId))
      .map((p) => p.role);
    const isTargetRole = partRoles.some((r) => r === 'target' || r === 'affected' || r === 'intended_recipient' || r === 'confirmed_recipient');
    const entity_role: import('../../../types/vta').VTANodeEntityRole = previousNode?.entity_role
      ?? (isTargetRole ? 'object' : 'subject');
    const object_display_style = previousNode?.object_display_style;

    return {
      id: card.id, event_ids: [...card.eventIds], lane,
      time: unique(events.map((event) => event.time).filter(Boolean)).join(' / '),
      title: events.map((event) => event.title).join('／'),
      description: events.map((event) => event.description).filter(Boolean).join('\n'),
      type, measure_type: events.some((event) => event.measure_type === 'elimination') ? 'elimination' : null,
      sequence_order, supplementary_note,
      entity_role,
      ...(object_display_style ? { object_display_style } : {}),
      ...(outcome_kind ? { outcome_kind } : {}),
      ...(variation_factor ? { variation_factor } : {}),
      ...(previousNode?.position ? { position: previousNode.position } : {}),
      ...(previousNode?.compact_position ? { compact_position: previousNode.compact_position } : {}),
      ...(previousNode?.is_hidden ? { is_hidden: true, hidden_card_height: previousNode.hidden_card_height } : {}),
    };
  });
  const resolveCurrentNodeId = (oldCardId: string): string | undefined => {
    if (nodes.some((n) => n.id === oldCardId)) return oldCardId;
    const oldNode = previousById.get(oldCardId);
    if (!oldNode || !oldNode.event_ids?.length) return undefined;
    const sameLane = nodes.find((n) => n.lane === oldNode.lane && n.event_ids?.some((id) => oldNode.event_ids!.includes(id)));
    if (sameLane) return sameLane.id;
    const anyLane = nodes.find((n) => n.event_ids?.some((id) => oldNode.event_ids!.includes(id)));
    return anyLane?.id;
  };
  const manualEdges: VTAEdgeData[] = [];
  if (previous?.edges) {
    for (const oldEdge of previous.edges) {
      if (oldEdge.generated && oldEdge.relationId) continue;
      const newSource = resolveCurrentNodeId(oldEdge.source);
      const newTarget = resolveCurrentNodeId(oldEdge.target);
      if (newSource && newTarget && newSource !== newTarget) {
        manualEdges.push({
          ...oldEdge,
          source: newSource,
          target: newTarget,
        });
      }
    }
  }
  const edges = [...manualEdges];
  const schema: VTASchema = {
    lanes: allLanes.length ? allLanes : ['主体未設定'], nodes, edges,
    analysis, supplementary_summary: previous?.supplementary_summary,
    custom_notes: previous?.custom_notes,
    presentation: previous?.presentation,
  };
  if (!previous) schema.presentation = planCardSimplification(schema);
  for (const relation of analysis.relations.filter((item) => item.kind !== 'before' && item.sourceEventId !== item.targetEventId)) {
    // An unspecified endpoint is ambiguous when an event appears on several lanes.
    const sourceCandidates = orderedCards.filter((card) => card.eventIds.includes(relation.sourceEventId)
      && (!relation.sourceEntityId || card.laneEntityId === relation.sourceEntityId));
    const targetCandidates = orderedCards.filter((card) => card.eventIds.includes(relation.targetEventId)
      && (!relation.targetEntityId || card.laneEntityId === relation.targetEntityId));
    const source = sourceCandidates.length === 1 ? sourceCandidates[0] : undefined;
    const target = targetCandidates.length === 1 ? targetCandidates[0] : undefined;
    if (source && target && source.id !== target.id && !schema.presentation?.omittedEdges?.includes('relation:'+relation.id) && !edges.some((edge) => edge.relationId === relation.id)) {
      const prevEdge = previous?.edges.find((e) => relation.id ? e.relationId === relation.id : (resolveCurrentNodeId(e.source) === source.id && resolveCurrentNodeId(e.target) === target.id));
      const hasManualOverride = prevEdge && prevEdge.generated === false;
      edges.push({
        source: source.id, target: target.id, id: relation.id ? 'relation:' + relation.id : undefined, relationId: relation.id,
        generated: hasManualOverride ? false : true,
        meaning: hasManualOverride && prevEdge.meaning ? prevEdge.meaning : relation.kind as import('../../../types/vta').VTAEdgeData['meaning'],
        resource: hasManualOverride && prevEdge.resource !== undefined ? prevEdge.resource : relation.resource,
        status: hasManualOverride && prevEdge.status !== undefined ? prevEdge.status : relation.status,
        receipt: hasManualOverride && prevEdge.receipt !== undefined ? prevEdge.receipt : relation.receipt,
        label: hasManualOverride && prevEdge.label !== undefined ? prevEdge.label : (relation.kind === 'dependency' ? '作業依存' : relation.status === 'omitted' ? '未実施' : relation.kind === 'common' ? '共通影響' : relation.kind === 'mutual' ? '相互確認' : ({ information: '情報', material: '物・資機材', person: '人員', money: '資金', other: 'リソース' }[relation.resource ?? ''] || undefined)),
        direction: hasManualOverride && prevEdge.direction !== undefined ? prevEdge.direction : (relation.kind === 'dependency' ? 'unidirectional' : relation.kind === 'common' || relation.status === 'omitted' || relation.status === 'unknown' ? 'undirected' : relation.kind === 'mutual' ? 'bidirectional' : 'unidirectional'),
        category: hasManualOverride && prevEdge.category !== undefined ? prevEdge.category : (relation.kind === 'dependency' ? 'dependency' : relation.kind === 'impact' ? 'impact' : relation.resource === 'person' ? 'person' : relation.resource === 'material' ? 'material' : relation.resource === 'money' ? 'other' : 'information'),
        is_break: prevEdge?.is_break ?? false,
      });
    }
  }
  const maintained = maintainPresentation(connectSharedEvents(schema));
  const projected=previous ? maintained : { ...repairGeneratedLaneSequence(maintained).schema, analysis };
  debugRecorder.record('graph.projection',()=>({generation:analysis.generation,relations:analysis.relations,cards:analysis.cards,nodes:projected.nodes,edges:projected.edges,presentation:projected.presentation,
    subjectPoset:analysis.subjectPoset,entities:analysis.entities,
    excludedBeforeIds:analysis.relations.filter(r=>r.kind==='before').map(r=>r.id),
    missingRelations:analysis.relations.filter(r=>r.kind!=='before'&&!projected.edges.some(e=>r.id&&e.relationId===r.id)).map(r=>({id:r.id,sourceEventId:r.sourceEventId,targetEventId:r.targetEventId,sourceEntityId:r.sourceEntityId,targetEntityId:r.targetEntityId}))}));
  return projected;
}

export function applyEventClassification(analysis: VTAAnalysisData, raw: unknown): VTAAnalysisData {
  const items = requireArray(record(raw) ? raw.classifications : undefined, '変動判定');
  const pendingIds = new Set(analysis.events.filter((event) => event.classification === 'unclassified').map((event) => event.id));
  const byId = new Map<string, { value: VTANodeType; reason: string; factIds: string[] }>();
  for (const item of items) {
    if (!record(item)) throw new Error('変動判定の形式が不正です。');
    const id = string(item.eventId);
    const value = item.value;
    const event = analysis.events.find((candidate) => candidate.id === id);
    const factIds = unique(requireArray(item.factIds, `判定 ${id} の根拠`).map(string));
    if (!event || !pendingIds.has(id) || (value !== 'normal' && value !== 'variation' && value !== 'undetermined')
      || (value !== 'undetermined' && !factIds.length)
      || (value !== 'undetermined' && !string(item.reason))
      || factIds.some((factId) => !event.factIds.includes(factId)) || byId.has(id)) throw new Error(`判定 ${id} の参照が不正です。`);
    byId.set(id, { value, reason: string(item.reason), factIds });
  }
  if (byId.size !== pendingIds.size) throw new Error('未判定イベントすべての判定結果が必要です。');
  return { ...analysis, events: analysis.events.map((event) => {
    const result = byId.get(event.id);
    if (!result) return event;
    return { ...event, classification: result.value, classificationReason: result.reason, classificationFactIds: result.factIds };
  }) };
}

export function validateSavedAnalysis(raw: unknown, onOptionalWarning?: (message: string) => void): VTAAnalysisData {
  if (!record(raw) || raw.version !== 5) throw new Error('イベント分析データの形式が不正です。');
  const sources = requireArray(raw.sources, '入力資料').map((source) => {
    if (!record(source) || !string(source.id) || typeof source.text !== 'string') throw new Error('入力資料が不正です。');
    const paragraphs = requireArray(source.paragraphs, '入力資料の段落').map((paragraph) => {
      if (!record(paragraph) || !string(paragraph.id) || typeof paragraph.text !== 'string') throw new Error('入力資料の段落が不正です。');
      if (!(source.text as string).includes(paragraph.text)) throw new Error('入力資料の段落が原文と一致しません。');
      return { id: string(paragraph.id), text: paragraph.text };
    });
    rejectDuplicateIds(paragraphs, '入力資料の段落');
    return { id: string(source.id), text: source.text, paragraphs } satisfies VTASource;
  });
  rejectDuplicateIds(sources, '入力資料');
  const facts = validateFacts({ facts: raw.facts }, sources);
  const events = Array.isArray(raw.events) && raw.events.length === 0 ? [] : validateEvents({ events: raw.events }, facts, true, false, sources);
  const savedEvents = new Map(requireArray(raw.events, 'イベント一覧').filter(record).map((item) => [string(item.id), item]));
  for (let index = 0; index < events.length; index++) {
    const item = savedEvents.get(events[index].id)!;
    if (item.classification !== 'normal' && item.classification !== 'variation'
      && item.classification !== 'outcome'
      && item.classification !== 'unclassified' && item.classification !== 'undetermined') throw new Error('イベントの判定状態が不正です。');
    events[index].classification = item.classification;
    if (item.outcome_kind && ['loss', 'near_miss', 'recovery'].includes(String(item.outcome_kind))) {
      events[index].outcome_kind = item.outcome_kind as import('../../../types/vta').VTAOutcomeKind;
    }
    if (record(item.variationFactor)) {
      const vf = item.variationFactor;
      const categories = ['response', 'internal', 'departure', 'external'];
      const polarities = ['negative', 'resilient'];
      const levels = ['skill', 'rule', 'knowledge', 'other'];
      if (categories.includes(String(vf.category)) && polarities.includes(String(vf.polarity))) {
        events[index].variationFactor = {
          category: vf.category as any,
          polarity: vf.polarity as any,
          ...(levels.includes(String(vf.cognitiveLevel)) ? { cognitiveLevel: vf.cognitiveLevel as any } : {}),
          ...(typeof vf.description === 'string' && vf.description.trim() ? { description: vf.description.trim() } : {}),
        };
      }
    }
    events[index].origin = item.origin === 'manual' ? 'manual' : 'extraction';
    if (events[index].origin === 'manual') events[index].time = typeof item.time === 'string' ? item.time : events[index].time;
    else if (typeof item.time === 'string' && item.time !== events[index].time) throw new Error('イベントの時刻が根拠と一致しません。');
    events[index].measure_type = item.measure_type === 'elimination' ? 'elimination' : null;
    events[index].classificationReason = string(item.classificationReason) || undefined;
    const classificationFactIds = Array.isArray(item.classificationFactIds) ? item.classificationFactIds.map(string) : undefined;
    if (classificationFactIds?.some((id) => !events[index].factIds.includes(id))) throw new Error('変動判定の根拠IDが不正です。');
    events[index].classificationFactIds = classificationFactIds;
    events[index].classificationSourceRefs = item.classificationSourceRefs === undefined ? undefined : readSourceRefs(item.classificationSourceRefs, sources, false);
    if (events[index].classificationSourceRefs?.some((ref) => !events[index].sourceRefs?.some((own) => own.sourceId === ref.sourceId && own.paragraphId === ref.paragraphId))) throw new Error('変動判定の原文参照がイベントの範囲外です。');
    const preliminary = readPreliminary(item.preliminary, events[index].sourceRefs, sources);
    if (preliminary) events[index].preliminary = preliminary;
    else delete events[index].preliminary;
  }
  const cardsRaw = requireArray(raw.cards, 'カード参照');
  const parsed = validateParticipants({ ...raw, cardGroups: cardsRaw.filter((card) => record(card) && Array.isArray(card.eventIds) && card.eventIds.length > 1)
    .map((card) => ({ entityId: (card as Record<string, unknown>).laneEntityId, eventIds: (card as Record<string, unknown>).eventIds })) }, events, facts, true, onOptionalWarning, sources);
  const cards: VTACardRef[] = cardsRaw.map((item) => {
    if (!record(item)) throw new Error('カード参照が不正です。');
    const id = requireId(item, 'カード');
    const laneEntityId = string(item.laneEntityId);
    const eventIds = unique(requireArray(item.eventIds, `カード ${id} のイベント`).map(string));
    if (!parsed.entities.some((entity) => entity.id === laneEntityId) || !eventIds.length || eventIds.some((eventId) =>
      !parsed.participations.some((part) => part.eventId === eventId && part.entityId === laneEntityId))) throw new Error(`カード ${id} の参照が不正です。`);
    return { id, laneEntityId, eventIds };
  });
  rejectDuplicateIds(cards, 'カード');
  const pairs = cards.flatMap((card) => card.eventIds.map((eventId) => `${eventId}\u0000${card.laneEntityId}`));
  if (unique(pairs).length !== pairs.length) throw new Error('同一イベントと主体のカードが重複しています。');
  const expectedPairs = unique(parsed.participations.map((part) => `${part.eventId}\u0000${part.entityId}`));
  if (pairs.length !== expectedPairs.length || expectedPairs.some((pair) => !pairs.includes(pair))) throw new Error('関与している主体に対応するカードが不足しています。');
  const subjectRanking = readSubjectRanking(raw.subjectRanking, parsed.entities, sources);
  const validOriginIds = new Set<string>([
    ...parsed.entities.map((e) => e.id),
    ...(subjectRanking?.originalEntities.map((e) => e.id) ?? []),
  ]);
  for (const part of parsed.participations) {
    if (part.mergedFrom) {
      const filtered = part.mergedFrom.filter((m) => validOriginIds.has(m.entityId));
      if (filtered.length) part.mergedFrom = filtered;
      else delete part.mergedFrom;
    }
  }
  for (const rel of parsed.relations) {
    if (rel.sourceEntityOrigin && !validOriginIds.has(rel.sourceEntityOrigin)) delete rel.sourceEntityOrigin;
    if (rel.targetEntityOrigin && !validOriginIds.has(rel.targetEntityOrigin)) delete rel.targetEntityOrigin;
  }
  const normalizationAudit = readAudit(raw.normalizationAudit, events, sources);
  return {
    version: 5, sources, facts, events, entities: parsed.entities,
    context: readContext(raw.context,events), outcome: readOutcome(raw.outcome,events,sources),
    ...(subjectRanking ? { subjectRanking } : {}),
    ...(normalizationAudit ? { normalizationAudit } : {}),
    subjectPoset: record(raw.subjectPoset)
      ? SubjectPoset.fromData(raw.subjectPoset as any).toJSON()
      : SubjectPoset.fromEntities(parsed.entities).toJSON(),
    generation: validateGeneration(raw.generation), generationRuns: Array.isArray(raw.generationRuns)?raw.generationRuns.map(validateGeneration).filter((r):r is NonNullable<typeof r>=>!!r):undefined,
    dispositions: raw.dispositions === undefined ? undefined : validateDispositions(raw.dispositions, sources),
    participations: parsed.participations, relations: parsed.relations, cards,
    unassignedEventIds: events.filter((event) => !cards.some((card) => card.eventIds.includes(event.id))).map((event) => event.id),
  };
}

/** Samples and user-created cards enter the new model as explicit manual events. */
export function createManualAnalysis(schema: VTASchema): VTAAnalysisData {
  const lanes = unique([...schema.lanes, ...schema.nodes.map((node) => node.lane)]);
  const entities: VTAEntity[] = lanes.map((name, index) => ({ id: `manual_entity_${index + 1}`, name, kind: 'other' }));
  const entityByLane = new Map(entities.map((entity) => [entity.name, entity.id]));
  const events: VTAEvent[] = schema.nodes.map((node, index) => ({
    id: `manual_event_${node.id}`, origin: 'manual', title: node.title, description: node.description,
    time: node.time, sourceOrder: index, factIds: [], classification: node.type,
    measure_type: node.measure_type,
  }));
  const cards: VTACardRef[] = schema.nodes.map((node, index) => ({
    id: node.id, laneEntityId: entityByLane.get(node.lane)!, eventIds: [events[index].id],
  }));
  return {
    version: 5, sources: [], facts: [], events, entities,
    participations: cards.map((card) => ({ eventId: card.eventIds[0], entityId: card.laneEntityId, role: 'actor', factIds: [] })),
    relations: [], cards, unassignedEventIds: [],
  };
}

/** Keep the existing canvas API as a projection while event records own shared content. */
export function reconcileAnalysis(previous: VTASchema, changed: VTASchema): VTASchema {
  const original = changed.analysis ?? previous.analysis ?? createManualAnalysis(previous);
  const analysis: VTAAnalysisData = {
    ...original,
    events: original.events.map((event) => ({ ...event })),
    entities: original.entities.map((entity) => ({ ...entity })),
    participations: original.participations.map((part) => ({ ...part })),
    cards: original.cards.map((card) => ({ ...card, eventIds: [...card.eventIds] })),
  };
  const previousById = new Map(previous.nodes.map((node) => [node.id, node]));
  const changedIds = new Set(changed.nodes.map((node) => node.id));
  analysis.cards = analysis.cards.filter((card) => changedIds.has(card.id));
  const entityByName = new Map(analysis.entities.map((entity) => [entity.name, entity]));
  const cardLaneChanges = new Map<string, { oldEntityId: string; newEntityId: string; eventIds: string[] }>();
  for (const node of changed.nodes) {
    let entity = entityByName.get(node.lane);
    if (!entity) {
      entity = { id: `manual_entity_${analysis.entities.length + 1}`, name: node.lane, kind: 'other' };
      analysis.entities.push(entity);
      entityByName.set(node.lane, entity);
    }
    let card = analysis.cards.find((item) => item.id === node.id);
    if (!card) {
      const eventId = `manual_event_${node.id}`;
      analysis.events.push({ id: eventId, origin: 'manual', title: node.title, description: node.description,
        time: node.time, sourceOrder: analysis.events.length, factIds: [], classification: node.type,
        measure_type: node.measure_type, outcome_kind: node.outcome_kind, variationFactor: node.variation_factor });
      card = { id: node.id, laneEntityId: entity.id, eventIds: [eventId] };
      analysis.cards.push(card);
      analysis.participations.push({ eventId, entityId: entity.id, role: node.entity_role === 'object' ? 'target' : 'actor', factIds: [] });
      if (node.type === 'outcome') {
        const kind = node.outcome_kind ?? 'loss';
        if (!analysis.outcome) {
          analysis.outcome = {
            status: 'identified',
            kind,
            eventIds: [eventId],
            sourceRefs: [],
            reason: '追加された手動帰結イベント',
          };
        } else {
          analysis.outcome = {
            ...analysis.outcome,
            status: 'identified',
            kind: kind ?? analysis.outcome.kind,
            eventIds: unique([...analysis.outcome.eventIds, eventId]),
          };
        }
      }
      continue;
    }
    if (card.laneEntityId !== entity.id) {
      const oldEntityId = card.laneEntityId;
      cardLaneChanges.set(card.id, {
        oldEntityId,
        newEntityId: entity.id,
        eventIds: [...card.eventIds],
      });
      card.laneEntityId = entity.id;
    }
    const old = previousById.get(node.id);
    if (!old || !card.eventIds.length) continue;
    const event = analysis.events.find((item) => item.id === card.eventIds[0]);
    if (!event) continue;
    // Grouped text is edited event by event. A card-level elimination applies to
    // every event shown by the grouped card.
    if (card.eventIds.length > 1) {
      if (node.measure_type !== old.measure_type) {
        for (const eventId of card.eventIds) {
          const member = analysis.events.find((item) => item.id === eventId);
          if (member) member.measure_type = node.measure_type;
        }
      }
      continue;
    }
    const contentChanged = node.title !== old.title || node.description !== old.description || node.time !== old.time;
    if (node.title !== old.title) { event.title = node.title; event.origin = 'manual'; }
    if (node.description !== old.description) { event.description = node.description; event.origin = 'manual'; }
    if (node.time !== old.time) { event.time = node.time; event.origin = 'manual'; }
    if (contentChanged && node.type === old.type) {
      event.classification = 'unclassified';
      event.classificationReason = undefined;
      event.classificationFactIds = undefined;
      event.classificationSourceRefs = undefined;
    }
    if (node.type !== old.type) {
      event.classification = node.type;
      if (changed.analysis === previous.analysis) {
        event.classificationReason = undefined;
        event.classificationFactIds = undefined;
      event.classificationSourceRefs = undefined;
      }
    }
    if (old.type === 'outcome' && node.type !== 'outcome') {
      delete event.outcome_kind;
      if (analysis.outcome) {
        analysis.outcome = {
          ...analysis.outcome,
          eventIds: analysis.outcome.eventIds.filter((id) => id !== event.id),
        };
        if (analysis.outcome.eventIds.length === 0) {
          analysis.outcome.status = 'not_found';
          analysis.outcome.reason = '帰結ノードが解除されました。';
        }
      }
    }
    if (old.type === 'variation' && node.type !== 'variation') {
      delete event.variationFactor;
    }
    if (node.type === 'outcome' || node.outcome_kind) {
      if (node.type === 'outcome') {
        event.outcome_kind = node.outcome_kind ?? event.outcome_kind ?? 'loss';
        const kind = event.outcome_kind;
        if (!analysis.outcome) {
          analysis.outcome = {
            status: 'identified',
            kind,
            eventIds: [event.id],
            sourceRefs: event.sourceRefs ?? [],
            reason: '指定された帰結イベント',
          };
        } else {
          analysis.outcome = {
            ...analysis.outcome,
            status: 'identified',
            kind: kind ?? analysis.outcome.kind,
            eventIds: unique([...analysis.outcome.eventIds, event.id]),
          };
        }
      }
    }
    if (node.type === 'variation' && node.variation_factor) {
      event.variationFactor = { ...node.variation_factor };
    }
    if (node.measure_type !== old.measure_type) event.measure_type = node.measure_type;
    if (node.entity_role && node.entity_role !== old.entity_role) {
      for (const eventId of card.eventIds) {
        const part = analysis.participations.find((p) => p.eventId === eventId && p.entityId === card.laneEntityId);
        if (part) {
          part.role = node.entity_role === 'object' ? 'target' : 'actor';
          part.origin = 'manual';
        }
      }
    }
  }
  const seenPairs = new Set<string>();
  analysis.cards = analysis.cards.slice().reverse().map((card) => ({ ...card, eventIds: card.eventIds.filter((eventId) => {
    const pair = `${eventId}\u0000${card.laneEntityId}`;
    if (seenPairs.has(pair)) return false;
    seenPairs.add(pair);
    return true;
  }) })).reverse().filter((card) => card.eventIds.length > 0);

  const oldParts = new Map(analysis.participations.map((part) => [`${part.eventId}\u0000${part.entityId}`, part]));
  analysis.participations = analysis.cards.flatMap((card) =>
    card.eventIds.map((eventId) => {
      const existing = oldParts.get(`${eventId}\u0000${card.laneEntityId}`);
      if (existing) return existing;
      for (const [, change] of cardLaneChanges) {
        if (change.newEntityId === card.laneEntityId && change.eventIds.includes(eventId)) {
          const oldPart = oldParts.get(`${eventId}\u0000${change.oldEntityId}`);
          if (oldPart) {
            return {
              ...oldPart,
              entityId: card.laneEntityId,
              inferred: false,
              evidenceBasis: 'user' as const,
              reason: '利用者が図上で割当先を変更',
              origin: 'manual' as const,
              generation: undefined,
            };
          }
        }
      }
      return { eventId, entityId: card.laneEntityId, role: 'actor' as const, factIds: [], origin: 'manual' as const };
    })
  );

  // 関係線の端点更新（レーン変更対応）
  if (cardLaneChanges.size > 0) {
    analysis.relations = analysis.relations.map((relation) => {
      let updated = { ...relation };
      const edge = changed.edges.find((e) => e.relationId === relation.id)
        ?? previous.edges.find((e) => e.relationId === relation.id);
      if (edge) {
        const srcChange = cardLaneChanges.get(edge.source);
        if (srcChange && srcChange.eventIds.includes(relation.sourceEventId) && (!relation.sourceEntityId || relation.sourceEntityId === srcChange.oldEntityId)) {
          updated.sourceEntityId = srcChange.newEntityId;
        }
        const tgtChange = cardLaneChanges.get(edge.target);
        if (tgtChange && tgtChange.eventIds.includes(relation.targetEventId) && (!relation.targetEntityId || relation.targetEntityId === tgtChange.oldEntityId)) {
          updated.targetEntityId = tgtChange.newEntityId;
        }
      } else {
        for (const [, change] of cardLaneChanges) {
          if (change.eventIds.includes(relation.sourceEventId) && relation.sourceEntityId === change.oldEntityId) {
            updated.sourceEntityId = change.newEntityId;
          }
          if (change.eventIds.includes(relation.targetEventId) && relation.targetEntityId === change.oldEntityId) {
            updated.targetEntityId = change.newEntityId;
          }
        }
      }
      return updated;
    });
  }

  // 関係線の保持・削除判定
  const activePairs = new Set(
    analysis.participations.map((part) => `${part.eventId}\u0000${part.entityId}`)
  );
  const activeEventIds = new Set(analysis.events.map((e) => e.id));

  analysis.relations = analysis.relations.filter((relation) => {
    // 1. 端点イベントの存在確認
    if (!activeEventIds.has(relation.sourceEventId) || !activeEventIds.has(relation.targetEventId)) {
      return false;
    }

    // 2. 端点主体の関与確認（指定主体が有効な参加主体として存在するか）
    if (relation.sourceEntityId && !activePairs.has(`${relation.sourceEventId}\u0000${relation.sourceEntityId}`)) {
      return false;
    }
    if (relation.targetEntityId && !activePairs.has(`${relation.targetEventId}\u0000${relation.targetEntityId}`)) {
      return false;
    }

    // 3. エッジ削除との整合確認
    // previous に対応する edge があったが changed で明示的またはカード削除によりエッジが失われた場合
    const oldEdge = previous.edges.find((edge) =>
      relation.id ? edge.relationId === relation.id : (edge.source && edge.target)
    );
    if (oldEdge) {
      const stillHasEdge = changed.edges.some((edge) =>
        relation.id ? edge.relationId === relation.id : edge.id === oldEdge.id
      );
      if (!stillHasEdge) {
        return false;
      }
    }

    return true;
  });

  analysis.relations = analysis.relations.map((relation) => {
    const override = changed.edges.find((edge) => edge.relationId && edge.relationId === relation.id && edge.generated === false);
    return override ? { ...relation, resource: override.meaning==='dependency'?undefined:override.resource ?? relation.resource, status: override.meaning==='dependency'?undefined:override.status ?? relation.status, receipt: override.meaning==='dependency'?'na':override.receipt ?? relation.receipt,
      kind: override.meaning && override.meaning !== 'association' ? override.meaning : relation.kind,
      evidenceBasis:'user' as const,explanation:'利用者が図上で関係属性を手動編集。',
      ...(relation.proposalId ? { provenance: 'user' as const, adoptionReason: '利用者が図上で関係属性を手動編集。' } : {}) } : relation;
  });
  const activeCardEventIds = new Set(analysis.cards.flatMap((c) => c.eventIds));
  analysis.events = analysis.events.filter((e) => e.origin !== 'manual' || activeCardEventIds.has(e.id));
  if (analysis.outcome && analysis.outcome.status === 'identified') {
    const existingEventIds = new Set(analysis.events.map((e) => e.id));
    const validOutcomeIds = analysis.outcome.eventIds.filter((id) => existingEventIds.has(id));
    if (validOutcomeIds.length !== analysis.outcome.eventIds.length) {
      if (validOutcomeIds.length === 0) {
        analysis.outcome.status = 'not_found';
        analysis.outcome.eventIds = [];
        analysis.outcome.reason = '帰結イベントが削除されました。';
      } else {
        analysis.outcome.eventIds = validOutcomeIds;
      }
    }
  }
  analysis.unassignedEventIds = analysis.events.filter((event) => !analysis.cards.some((card) => card.eventIds.includes(event.id))).map((event) => event.id);
  return projectAnalysis(analysis, changed);
}

function validateGeneration(raw:unknown):import('../../../types/vta').GenerationProvenance|undefined {
 if(raw===undefined)return; if(!record(raw)||!['runId','schemeId','schemeVersion','ruleVersion','model','promptFingerprint','inputFingerprint'].every(k=>typeof raw[k]==='string')) throw new Error('生成来歴が不正です。');
 return Object.fromEntries(['runId','schemeId','schemeVersion','ruleVersion','model','promptFingerprint','inputFingerprint'].map(k=>[k,raw[k]])) as unknown as import('../../../types/vta').GenerationProvenance;
}

function readContext(raw:unknown,events:VTAEvent[]):VTAAnalysisData['context'] {if(raw===undefined)return; if(!record(raw)||!Array.isArray(raw.selectedTargetEventIds)||raw.selectedTargetEventIds.some(id=>typeof id!=='string'||!events.some(e=>e.id===id)))throw new Error('分析対象の参照が不正です。');return {selectedTargetEventIds:raw.selectedTargetEventIds as string[],objective:typeof raw.objective==='string'?raw.objective:undefined};}

function readOutcome(raw:unknown,events:VTAEvent[],sources:VTASource[]):VTAAnalysisData['outcome'] {
 if(raw===undefined)return;
 if(!record(raw)||!['identified','not_found','uncertain'].includes(String(raw.status))||!Array.isArray(raw.eventIds)||raw.eventIds.some(id=>typeof id!=='string'||!events.some(e=>e.id===id))||typeof raw.reason!=='string'||!raw.reason.trim()||raw.status==='identified'&&!raw.eventIds.length||raw.status!=='identified'&&raw.eventIds.length)throw new Error('帰結の確認データが不正です。');
 const kind = ['loss', 'near_miss', 'recovery'].includes(String(raw.kind))
   ? (raw.kind as import('../../../types/vta').VTAOutcomeKind)
   : undefined;
 return {
   status:raw.status as NonNullable<VTAAnalysisData['outcome']>['status'],
   ...(kind ? { kind } : {}),
   eventIds:raw.eventIds as string[],
   sourceRefs:readSourceRefs(raw.sourceRefs,sources,raw.status==='identified'),
   reason:raw.reason
 };
}

function readSubjectRanking(
  raw: unknown,
  currentEntities: VTAEntity[],
  sources: VTASource[]
): VTAAnalysisData['subjectRanking'] {
  if (raw === undefined || raw === null) return undefined;
  if (!record(raw) || raw.version !== 1 || typeof raw.maxSubjects !== 'number' || !Number.isFinite(raw.maxSubjects) || raw.maxSubjects < 1) {
    return undefined;
  }
  const w = raw.weights;
  if (!record(w) || !(['A', 'O', 'F', 'C', 'T'] as const).every((k) => typeof w[k] === 'number' && Number.isFinite(w[k] as number))) {
    return undefined;
  }
  if (!Array.isArray(raw.originalEntities) || !Array.isArray(raw.ranks)) return undefined;
  const origEntities: VTAEntity[] = [];
  const seenOrigIds = new Set<string>();
  for (const item of raw.originalEntities) {
    if (!record(item)) continue;
    const id = string(item.id);
    const name = string(item.name);
    const kind = item.kind;
    if (!id || !name || seenOrigIds.has(id) || (kind !== 'person' && kind !== 'organization' && kind !== 'machine' && kind !== 'other')) continue;
    seenOrigIds.add(id);
    const focus = item.focus !== undefined && ['reporter', 'high', 'mid', 'low'].includes(String(item.focus))
      ? (item.focus as VTAEntity['focus'])
      : undefined;
    let focusSourceRefs: VTASourceRef[] | undefined;
    if (Array.isArray(item.focusSourceRefs)) {
      const validRefs = item.focusSourceRefs.filter((ref): ref is VTASourceRef =>
        record(ref) && typeof ref.sourceId === 'string' && typeof ref.paragraphId === 'string'
        && (!sources.length || sources.some((s) => s.id === ref.sourceId && s.paragraphs.some((p) => p.id === ref.paragraphId)))
      ).map((ref) => ({ sourceId: ref.sourceId, paragraphId: ref.paragraphId }));
      if (validRefs.length) focusSourceRefs = validRefs;
    }
    origEntities.push({
      id,
      name,
      kind,
      ...(focus ? { focus } : {}),
      ...(focusSourceRefs ? { focusSourceRefs } : {}),
      ...(typeof item.parentEntityId === 'string' && item.parentEntityId.trim() ? { parentEntityId: item.parentEntityId.trim() } : {}),
    });
  }
  for (const ent of origEntities) {
    if (ent.parentEntityId && (ent.parentEntityId === ent.id || !seenOrigIds.has(ent.parentEntityId))) {
      delete ent.parentEntityId;
    }
  }
  const currentIds = new Set(currentEntities.map((e) => e.id));
  const ranks: NonNullable<VTAAnalysisData['subjectRanking']>['ranks'] = [];
  for (const r of raw.ranks) {
    if (!record(r)) continue;
    const entityId = string(r.entityId);
    if (!entityId || !seenOrigIds.has(entityId)) continue;
    if (typeof r.rank !== 'number' || typeof r.score !== 'number' || typeof r.retained !== 'boolean' || typeof r.reason !== 'string') continue;
    const bd = r.breakdown;
    if (!record(bd) || !(['A', 'O', 'F', 'C', 'T'] as const).every((k) => typeof bd[k] === 'number' && Number.isFinite(bd[k] as number))) continue;
    const priority = r.priority === 'reporter' || r.priority === 'outcome-actor' ? r.priority : undefined;
    const mergedIntoRaw = string(r.mergedInto) || undefined;
    const mergedInto = mergedIntoRaw && (currentIds.has(mergedIntoRaw) || seenOrigIds.has(mergedIntoRaw)) ? mergedIntoRaw : undefined;
    ranks.push({
      entityId,
      rank: r.rank,
      score: r.score,
      breakdown: { A: bd.A as number, O: bd.O as number, F: bd.F as number, C: bd.C as number, T: bd.T as number },
      ...(priority ? { priority } : {}),
      retained: r.retained,
      ...(mergedInto ? { mergedInto } : {}),
      reason: r.reason,
    });
  }
  return {
    version: 1,
    maxSubjects: Math.round(raw.maxSubjects),
    weights: { A: w.A as number, O: w.O as number, F: w.F as number, C: w.C as number, T: w.T as number },
    originalEntities: origEntities,
    ranks,
    ...(typeof raw.warning === 'string' && raw.warning.trim() ? { warning: raw.warning.trim() } : {}),
  };
}

/** Lenient readers for optional audit data: an unusable entry is dropped, never the whole project. */
function readRefsLenient(raw: unknown, sources: VTASource[]): VTASourceRef[] | undefined {
  try { return readSourceRefs(raw, sources, false); } catch { return undefined; }
}

function readPreliminary(raw: unknown, eventRefs: VTASourceRef[] | undefined, sources: VTASource[]): VTAEvent['preliminary'] {
  if (!record(raw)) return undefined;
  const value = raw.value;
  if (value !== 'normal' && value !== 'variation' && value !== 'undetermined') return undefined;
  const sourceRefs = readRefsLenient(raw.sourceRefs ?? [], sources);
  const reason = string(raw.reason);
  if (!sourceRefs) return undefined;
  if (value !== 'undetermined' && (!sourceRefs.length || !reason)) return undefined;
  if (sourceRefs.some((ref) => !eventRefs?.some((own) => own.sourceId === ref.sourceId && own.paragraphId === ref.paragraphId))) return undefined;
  return { value, reason, sourceRefs };
}

function readAudit(raw: unknown, events: VTAEvent[], sources: VTASource[]): VTAAnalysisData['normalizationAudit'] {
  if (raw === undefined) return undefined;
  if (!record(raw) || raw.version !== 1) {
    debugRecorder.record('audit.dropped', () => ({ reason: 'unsupported normalizationAudit' }), undefined, []);
    return undefined;
  }
  let dropped = 0;
  const eventIds = new Set(events.map((event) => event.id));
  const corrections: NonNullable<VTAAnalysisData['normalizationAudit']>['corrections'] = [];
  for (const item of Array.isArray(raw.corrections) ? raw.corrections : []) {
    const refs = record(item) ? readRefsLenient(item.sourceRefs, sources) : undefined;
    if (!record(item) || !string(item.id) || (item.kind !== 'alias_unification' && item.kind !== 'typo_fix')
      || !string(item.from) || !string(item.to) || !string(item.reason) || !refs?.length) { dropped++; continue; }
    corrections.push({ id: string(item.id), kind: item.kind, from: string(item.from), to: string(item.to), sourceRefs: refs, reason: string(item.reason), detectedBy: 'llm' });
  }
  const subjectiveNotices: NonNullable<VTAAnalysisData['normalizationAudit']>['subjectiveNotices'] = [];
  const treatments = ['evaluative_word_removed', 'kept_as_quoted_claim', 'action_only'];
  for (const item of Array.isArray(raw.subjectiveNotices) ? raw.subjectiveNotices : []) {
    const refs = record(item) ? readRefsLenient(item.sourceRefs, sources) : undefined;
    if (!record(item) || !string(item.id) || !string(item.phrase) || !refs?.length
      || !['app', 'llm', 'both'].includes(String(item.detectedBy))
      || (item.treatment !== undefined && !treatments.includes(String(item.treatment)))) { dropped++; continue; }
    subjectiveNotices.push({
      id: string(item.id), sourceRefs: refs, phrase: string(item.phrase),
      ...(item.treatment !== undefined ? { treatment: item.treatment as 'action_only' } : {}),
      eventIds: Array.isArray(item.eventIds) ? item.eventIds.map(string).filter((id) => eventIds.has(id)) : [],
      detectedBy: item.detectedBy as 'app',
    });
  }
  const iterations: NonNullable<NonNullable<VTAAnalysisData['normalizationAudit']>['iterations']> = [];
  for (const item of Array.isArray(raw.iterations) ? raw.iterations : []) {
    const m = record(item) && record(item.metrics) ? item.metrics : undefined;
    if (!record(item) || !m || typeof item.index !== 'number' || typeof item.score !== 'number'
      || typeof m.c1 !== 'number' || typeof m.c3 !== 'number' || typeof m.c5 !== 'number' || typeof item.adopted !== 'boolean') { dropped++; continue; }
    iterations.push({
      index: item.index, score: item.score, adopted: item.adopted,
      metrics: { c1: m.c1, c3: m.c3, c5: m.c5, ...(typeof m.c2 === 'number' ? { c2: m.c2 } : {}), ...(typeof m.c4 === 'number' ? { c4: m.c4 } : {}) },
      gateViolations: Array.isArray(item.gateViolations) ? item.gateViolations.map(string).filter(Boolean) : [],
      operations: Array.isArray(item.operations) ? item.operations.map(string).filter(Boolean) : [],
    });
  }
  if (dropped) debugRecorder.record('audit.dropped', () => ({ dropped }), undefined, []);
  return { version: 1, corrections, subjectiveNotices, ...(iterations.length ? { iterations } : {}) };
}

export type BatchAdoptMode = 'variation_only' | 'all';

export interface BatchAdoptResult {
  updatedAnalysis: VTAAnalysisData;
  variationCount: number;
  normalCount: number;
  totalCount: number;
}

/**
 * Adopts preliminary classifications into formal event classifications.
 * Protects events that already have a manual/formal classification (i.e. classification !== 'unclassified').
 */
export function batchAdoptPreliminary(
  analysis: VTAAnalysisData,
  mode: BatchAdoptMode = 'variation_only'
): BatchAdoptResult {
  let variationCount = 0;
  let normalCount = 0;

  const events = analysis.events.map((event) => {
    if (event.classification !== 'unclassified' || !event.preliminary) {
      return event;
    }

    const isVariation = event.preliminary.value === 'variation';
    const isNormal = event.preliminary.value === 'normal';

    if (mode === 'variation_only' && !isVariation) {
      return event;
    }

    if (mode === 'all' && !isVariation && !isNormal) {
      return event;
    }

    if (isVariation) variationCount++;
    if (isNormal) normalCount++;

    return {
      ...event,
      classification: event.preliminary.value,
      classificationReason: event.preliminary.reason || event.classificationReason,
      classificationSourceRefs: event.preliminary.sourceRefs?.length
        ? event.preliminary.sourceRefs
        : event.classificationSourceRefs,
    };
  });

  return {
    updatedAnalysis: {
      ...analysis,
      events,
    },
    variationCount,
    normalCount,
    totalCount: variationCount + normalCount,
  };
}

