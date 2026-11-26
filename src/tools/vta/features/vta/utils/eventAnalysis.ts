import { readSourceRefs } from './eventLedger';
import { extractVariationFactorFromReason } from './variationFactor';
import { debugRecorder } from '../../../services/debugRecorder';
import { validateStoredRelationAttributes } from './relationContract';
import { MAX_TIME_NODES } from '../../../types/vta';
import type {
  SubjectPosetData,
  VTAAnalysisData, VTACardRef, VTAEdgeData, VTAEntity, VTAEvent, VTAEventRelation,
  VTAFact, VTAFineGrainedBase, VTALaneConsolidationState, VTANodeData, VTANodeType, VTAOutcomeKind, VTAParticipation, VTASchema, VTASource, VTASourceRef,
} from '../../../types/vta';
import { connectSharedEvents } from './sharedEvents';
import { maintainPresentation, planCardSimplification, visibleSchema, VTA_LANE_WIDTH } from './presentation';
import { isOtherActorsLaneName, mergeLaneOrderWithPriority } from './laneOrder';
import { validateDispositions } from './normalization';
import { repairGeneratedLaneSequence } from './generatedLaneSequence';
import { isIntentionallyUnprojectedRelation } from './graphDiagnostics';
import {
  createAnalysisPoset,
  participatesViaPoset,
  resolveCardsForRelationEndpoint,
  SubjectPoset,
} from './subjectPoset';
import { annotateNodeTopologyRules } from './nodeTopologyRules';
import {
  addEventToAnalysis,
  allocateNextEventId,
  buildEventTimeDAG,
  computeEventRowMap,
  ensureEventTimeDAG,
  EventTimeDAG,
} from './eventTimePoset';

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
  const fids = event.factIds ?? [];
  const refs = facts.filter((fact) => fids.includes(fact.id)).flatMap((fact) => fact.evidence);
  return unique(refs.map((ref) => {
    const paragraph = sources.find((source) => source.id === ref.sourceId)?.paragraphs.find((part) => part.id === ref.paragraphId);
    return paragraph ? paragraphTiming(paragraph.text) : '';
  }).filter(Boolean));
}

function eventFallbackTime(event: Pick<VTAEvent, 'factIds'>, facts: VTAFact[], sources: VTASource[]): string {
  const times = eventSourceTimings(event, facts, sources);
  if (times.length !== 1) return '';
  const fids = event.factIds ?? [];
  const refs = facts.filter((fact) => fids.includes(fact.id)).flatMap((fact) => fact.evidence);
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

export function validateEvents(raw: unknown, facts: VTAFact[] = [], allowManual = false, allowEmpty = false,
  sources: VTASource[] = []): VTAEvent[] {
  const factById = new Map(facts.map((fact) => [fact.id, fact]));
  const events = requireArray(record(raw) ? raw.events : undefined, 'イベント一覧').map((item, index) => {
    if (!record(item)) throw new Error(`イベント ${index + 1} が不正です。`);
    const id = requireId(item, 'イベント');
    const factIds = item.factIds === undefined ? [] : unique(requireArray(item.factIds, `イベント ${id} の根拠ID`).map(string));
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
  raw: unknown, events: VTAEvent[], facts: VTAFact[] = [], allowManual = false,
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
    const validEntityMergedFrom = Array.isArray(item.mergedFrom)
      ? unique(
          item.mergedFrom
            .filter((m): m is string => typeof m === 'string' && Boolean(m.trim()))
            .map((m) => m.trim())
        )
      : [];
    const validCompositeOf = Array.isArray(item.compositeOf)
      ? unique(
          item.compositeOf
            .filter((m): m is string => typeof m === 'string' && Boolean(m.trim()))
            .map((m) => m.trim())
        )
      : [];
    const coreEntityId =
      typeof item.coreEntityId === 'string' && item.coreEntityId.trim()
        ? item.coreEntityId.trim()
        : undefined;
    return {
      id,
      name,
      kind,
      ...(item.resolution === 'unresolved' ? { resolution: 'unresolved' as const } : {}),
      ...(focus ? { focus } : {}),
      ...(focusSourceRefs ? { focusSourceRefs } : {}),
      ...(item.aggregate === true ? { aggregate: true as const } : {}),
      ...(validEntityMergedFrom.length ? { mergedFrom: validEntityMergedFrom } : {}),
      ...(validCompositeOf.length ? { compositeOf: validCompositeOf } : {}),
      ...(coreEntityId ? { coreEntityId } : {}),
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
    const refs = item.factIds === undefined ? [] : unique(requireArray(item.factIds, `関与 ${eventId}/${entityId} の根拠`).map(string));
    if (!related || !entityIds.has(entityId) || !roles.has(String(role))
      || (!related.sourceRefs && !refs.length && !(allowManual && (item.origin === 'manual' || related.origin === 'manual'))) || refs.some((id) => !(related.factIds ?? []).includes(id))) {
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
  const rawPoset = record(raw) && record(raw.subjectPoset) ? raw.subjectPoset : undefined;
  const rawPosetData = rawPoset
    && (!rawPoset.nodes || Array.isArray(rawPoset.nodes))
    && (!rawPoset.relations || Array.isArray(rawPoset.relations))
    && (!rawPoset.aliases || record(rawPoset.aliases))
    ? (rawPoset as unknown as SubjectPosetData)
    : undefined;
  const validationPoset = createAnalysisPoset(entities, rawPosetData);
  const parseRelation = (item: unknown): VTAEventRelation => {
    if (!record(item)) throw new Error('関係データが不正です。');
    const sourceEventId = string(item.sourceEventId);
    const targetEventId = string(item.targetEventId);
    const sourceEntityId = string(item.sourceEntityId) || undefined;
    const targetEntityId = string(item.targetEntityId) || undefined;
    const kind = item.kind;
    const refs = item.factIds === undefined && item.sourceRefs !== undefined ? [] : unique(requireArray(item.factIds, '関係の根拠').map(string));
    const sourceRefs = item.sourceRefs === undefined ? undefined : readSourceRefs(item.sourceRefs, sources);
    if (!eventById.has(sourceEventId) || !eventById.has(targetEventId)
      || (sourceEntityId && !entityIds.has(sourceEntityId)) || (targetEntityId && !entityIds.has(targetEntityId))
      || !['before','transfer','impact','mutual','common','dependency'].includes(String(kind))
      || (!sourceRefs && !refs.length) || refs.some((id) => !factIds.has(id)
        || (!(eventById.get(sourceEventId)?.factIds ?? []).includes(id) && !(eventById.get(targetEventId)?.factIds ?? []).includes(id)))) {
      throw new Error('関係の参照または根拠が不正です。');
    }
    const rawSourceOrigin = string(item.sourceEntityOrigin) || undefined;
    const rawTargetOrigin = string(item.targetEntityOrigin) || undefined;
    const sourceEntityOrigin = rawSourceOrigin && (!(record(raw) && raw.subjectRanking !== undefined) || knownOriginEntityIds.has(rawSourceOrigin)) ? rawSourceOrigin : undefined;
    const targetEntityOrigin = rawTargetOrigin && (!(record(raw) && raw.subjectRanking !== undefined) || knownOriginEntityIds.has(rawTargetOrigin)) ? rawTargetOrigin : undefined;
    const participates = (eventId: string, entityId: string, originId?: string) =>
      participatesViaPoset(participations, validationPoset, eventId, entityId) ||
      Boolean(originId && participatesViaPoset(participations, validationPoset, eventId, originId));
    if ((sourceEntityId && !participates(sourceEventId, sourceEntityId, sourceEntityOrigin))
      || (targetEntityId && !participates(targetEventId, targetEntityId, targetEntityOrigin))) {
      throw new Error('関係の主体がイベントに関与していません。');
    }
    validateStoredRelationAttributes({...item,kind,sourceEventId,targetEventId,sourceEntityId,targetEntityId} as VTAEventRelation);
    if(item.evidenceBasis!==undefined&&!['recorded','source-assessment','source-context','user'].includes(String(item.evidenceBasis)))throw new Error('関係の根拠区分が不正です。');
    if(item.evidenceBasis==='source-context'&&(!sourceRefs?.length||!string(item.explanation||item.adoptionReason)))throw new Error('文脈による関係には原文参照と理由が必要です。');
    const provenance = item.provenance === 'llm-proposal' || item.provenance === 'user' ? item.provenance : undefined;
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
  source: VTASource, facts: VTAFact[] = [], events: VTAEvent[],
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
  let maxSeq = 0;
  for (const ev of events) {
    const m = /^E(\d+)$/i.exec(ev.id.trim());
    if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
  }
  const result: VTAAnalysisData = {
    version: 5, sources: [source], facts, events, entities: parsed.entities,
    participations: parsed.participations, relations: parsed.relations, cards,
    unassignedEventIds: events.filter((event) => !event.ignored && !cards.some((card) => card.eventIds.includes(event.id))).map((event) => event.id),
    nextEventSeq: Math.max(maxSeq + 1, events.length + 1),
  };
  ensureEventTimeDAG(result);
  return result;
}

/** Only event data owns shared text and classification; cards own placement. */
export function projectAnalysis(
  analysis: VTAAnalysisData,
  previous?: VTASchema,
  options?: { silentDebug?: boolean; preferredLanes?: string[] }
): VTASchema {
  const dag = ensureEventTimeDAG(analysis);
  const eventRowMap = computeEventRowMap(analysis, dag);
  const eventById = new Map(analysis.events.map((event) => [event.id, event]));
  const entityById = new Map(analysis.entities.map((entity) => [entity.id, entity]));
  const previousById = new Map(previous?.nodes.map((node) => [node.id, node]) ?? []);
  const cardRow = (card: VTACardRef): number => {
    const rows = card.eventIds
      .map((id) => eventRowMap.get(id))
      .filter((r): r is number => r !== undefined);
    return rows.length ? Math.min(...rows) : Number.MAX_SAFE_INTEGER;
  };
  const cardSourceOrder = (card: VTACardRef): number =>
    Math.min(...card.eventIds.map((id) => eventById.get(id)?.sourceOrder ?? Number.MAX_SAFE_INTEGER));
  const compareCardsByDAG = (a: VTACardRef, b: VTACardRef): number => {
    const rA = cardRow(a);
    const rB = cardRow(b);
    if (rA !== rB) return rA < rB ? -1 : 1;
    const sA = cardSourceOrder(a);
    const sB = cardSourceOrder(b);
    if (sA !== sB) return sA < sB ? -1 : 1;
    return a.id.localeCompare(b.id, undefined, { numeric: true });
  };

  const hasUnchangedCards = Boolean(
    previous?.analysis &&
      analysis.cards.length === previous.analysis.cards.length &&
      analysis.cards.every((card) =>
        previous.analysis!.cards.some(
          (old) =>
            old.id === card.id &&
            old.laneEntityId === card.laneEntityId &&
            old.eventIds.join('\u0000') === card.eventIds.join('\u0000')
        )
      )
  );
  const hasDagSignatures = Boolean(
    previous?.analysis?.eventTimeDAG?.relationSignature !== undefined &&
      analysis.eventTimeDAG?.relationSignature !== undefined
  );
  const dagSignatureUnchanged =
    !hasDagSignatures ||
    (previous!.analysis!.eventTimeDAG!.relationSignature === analysis.eventTimeDAG!.relationSignature &&
      previous!.analysis!.eventTimeDAG!.eventSignature === analysis.eventTimeDAG!.eventSignature);
  const prevHasSavedPositions = Boolean(
    previous?.nodes?.some((node) => node.position && Number.isFinite(node.position.x) && Number.isFinite(node.position.y))
  );
  const prevOrderConsistentWithDAG = (() => {
    if (!previous?.nodes?.length) return false;
    const prevPosMap = new Map(previous.nodes.map((node, idx) => [node.id, { seq: node.sequence_order, idx }]));
    const cardsByLane = new Map<string, VTACardRef[]>();
    for (const card of analysis.cards) {
      const list = cardsByLane.get(card.laneEntityId) ?? [];
      list.push(card);
      cardsByLane.set(card.laneEntityId, list);
    }
    for (const group of cardsByLane.values()) {
      const sortedByPrev = [...group].sort((a, b) => {
        const pa = prevPosMap.get(a.id);
        const pb = prevPosMap.get(b.id);
        const sa = pa?.seq !== undefined && Number.isFinite(pa.seq) ? pa.seq : (pa?.idx ?? 0);
        const sb = pb?.seq !== undefined && Number.isFinite(pb.seq) ? pb.seq : (pb?.idx ?? 0);
        return sa - sb || (pa?.idx ?? 0) - (pb?.idx ?? 0);
      });
      for (let i = 1; i < sortedByPrev.length; i++) {
        const rPrev = cardRow(sortedByPrev[i - 1]);
        const rCurr = cardRow(sortedByPrev[i]);
        if (rPrev !== Number.MAX_SAFE_INTEGER && rCurr !== Number.MAX_SAFE_INTEGER && rPrev > rCurr) {
          return false;
        }
      }
    }
    return true;
  })();

  const preserveCardOrder =
    hasUnchangedCards &&
    dagSignatureUnchanged &&
    (prevHasSavedPositions || prevOrderConsistentWithDAG);

  const allOrderedCards: VTACardRef[] = (() => {
    if (preserveCardOrder) {
      return [...analysis.cards].sort(
        (a, b) =>
          (previous!.nodes.findIndex((node) => node.id === a.id) + 1 || Number.MAX_SAFE_INTEGER) -
          (previous!.nodes.findIndex((node) => node.id === b.id) + 1 || Number.MAX_SAFE_INTEGER)
      );
    }
    if (previous?.nodes?.length) {
      // Preserve cross-lane slot interleaving from previous.nodes while strictly ordering each lane via EventTimeDAG.
      const prevEntityByCardId = new Map<string, string>();
      const entityIdByName = new Map(analysis.entities.map((e) => [e.name, e.id]));
      for (const pn of previous.nodes) {
        const oldCard = previous.analysis?.cards.find((c) => c.id === pn.id);
        const entId = oldCard?.laneEntityId ?? entityIdByName.get(pn.lane);
        if (entId) prevEntityByCardId.set(pn.id, entId);
      }
      const grouped = new Map<string, VTACardRef[]>();
      for (const c of analysis.cards) {
        const list = grouped.get(c.laneEntityId) ?? [];
        list.push(c);
        grouped.set(c.laneEntityId, list);
      }
      for (const list of grouped.values()) {
        list.sort(compareCardsByDAG);
      }
      const result: VTACardRef[] = [];
      const seenCardIds = new Set<string>();
      for (const pn of previous.nodes) {
        const entId = prevEntityByCardId.get(pn.id);
        if (!entId) continue;
        const queue = grouped.get(entId);
        if (queue && queue.length > 0) {
          const nextCard = queue.shift()!;
          result.push(nextCard);
          seenCardIds.add(nextCard.id);
        }
      }
      const remaining = [...grouped.values()].flat().filter((c) => !seenCardIds.has(c.id));
      remaining.sort(compareCardsByDAG);
      result.push(...remaining);
      return result;
    }
    return [...analysis.cards].sort(compareCardsByDAG);
  })();
  const orderedCards = allOrderedCards.filter((card) => {
    const allEvents = card.eventIds.map((id) => eventById.get(id)).filter((event): event is VTAEvent => Boolean(event));
    if (!allEvents.length) throw new Error(`カード ${card.id} にイベントがありません。`);
    return allEvents.some((event) => !event.ignored);
  });
  const reorderedLanes = new Set<string>();
  if (!preserveCardOrder && previous?.analysis) {
    // Only mark a lane as reordered when cards belonging to that lane changed their relative order.
    const prevNodesSorted = [...previous.nodes].sort((a, b) => {
      const sa = typeof a.sequence_order === 'number' && Number.isFinite(a.sequence_order) ? a.sequence_order : Number.MAX_SAFE_INTEGER;
      const sb = typeof b.sequence_order === 'number' && Number.isFinite(b.sequence_order) ? b.sequence_order : Number.MAX_SAFE_INTEGER;
      return sa - sb;
    });
    const prevRankByEventLane = new Map<string, number>();
    const laneCounter = new Map<string, number>();
    for (const pn of prevNodesSorted) {
      const idx = laneCounter.get(pn.lane) ?? 0;
      laneCounter.set(pn.lane, idx + 1);
      for (const evId of pn.event_ids ?? []) {
        prevRankByEventLane.set(`${pn.lane}\u0000${evId}`, idx);
      }
    }
    const currIndicesByLane = new Map<string, number[]>();
    for (const card of orderedCards) {
      const laneName = entityById.get(card.laneEntityId)?.name;
      if (!laneName) continue;
      const prevRanks = card.eventIds
        .map((evId) => prevRankByEventLane.get(`${laneName}\u0000${evId}`))
        .filter((r): r is number => r !== undefined);
      if (prevRanks.length > 0) {
        const list = currIndicesByLane.get(laneName) ?? [];
        list.push(Math.min(...prevRanks));
        currIndicesByLane.set(laneName, list);
      }
    }
    for (const [laneName, seq] of currIndicesByLane) {
      for (let i = 1; i < seq.length; i++) {
        if (seq[i] < seq[i - 1]) {
          reorderedLanes.add(laneName);
          break;
        }
      }
    }
  }
  const lanes = unique([...orderedCards.map((card) => entityById.get(card.laneEntityId)?.name ?? ''), ...analysis.entities.map((entity) => entity.name)].filter(Boolean));
  const laneOrder = options?.preferredLanes ?? previous?.lanes ?? [];
  const allLanes = mergeLaneOrderWithPriority(laneOrder, lanes, analysis.entities);
  const previousLaneIndexMap = previous?.lanes?.length
    ? new Map(previous.lanes.map((name, idx) => [name, idx]))
    : null;
  const currentLaneIndexMap = new Map(allLanes.map((name, idx) => [name, idx]));
  const laneSequence = new Map<string, number>();
  const nodes: VTANodeData[] = orderedCards.map((card) => {
    const events = card.eventIds.map((id) => eventById.get(id)).filter((event): event is VTAEvent => Boolean(event && !event.ignored));
    if (!events.length) throw new Error(`カード ${card.id} にイベントがありません。`);
    const activeEventIds = events.map((e) => e.id);
    const lane = entityById.get(card.laneEntityId)?.name;
    if (!lane) throw new Error(`カード ${card.id} の主体がありません。`);
    const matchedPrevNodes = previous?.nodes.filter((node) =>
      node.id === card.id || node.event_ids?.some((evId) => activeEventIds.includes(evId))
    ) ?? [];
    const previousNode = preserveCardOrder
      ? (matchedPrevNodes.find((n) => n.id === card.id)
        ?? matchedPrevNodes.find((n) => n.lane === lane)
        ?? matchedPrevNodes[0])
      : (matchedPrevNodes.find((n) => n.lane === lane && n.event_ids?.some((evId) => activeEventIds.includes(evId)))
        ?? matchedPrevNodes.find((n) => n.id === card.id && (!n.event_ids?.length || n.event_ids.some((evId) => activeEventIds.includes(evId))))
        ?? matchedPrevNodes.find((n) => n.event_ids?.some((evId) => activeEventIds.includes(evId)))
        ?? (!previous?.analysis ? matchedPrevNodes.find((n) => n.id === card.id) : undefined));
    const notes = unique(
      matchedPrevNodes.map((n) => n.supplementary_note).filter((note): note is string => Boolean(note && note.trim()))
    );
    const supplementary_note = notes.join('\n\n');
    const types = unique(events.map((event) => event.classification));
    const isOutcome =
      activeEventIds.some(
        (id) => analysis.outcome?.status === 'identified' && analysis.outcome.eventIds.includes(id)
      ) ||
      types.includes('outcome');
    const type: VTANodeType = isOutcome ? 'outcome'
      : types.length === 1 ? types[0]
      : types.includes('variation') ? 'variation'
      : types.includes('unclassified') ? 'unclassified' : 'undetermined';
    const explicitOutcomeKinds = events
      .map((e) => e.outcome_kind)
      .filter((k): k is import('../../../types/vta').VTAOutcomeKind => Boolean(k));
    const perEventOutcomeKind: import('../../../types/vta').VTAOutcomeKind | undefined =
      explicitOutcomeKinds.includes('loss')
        ? 'loss'
        : explicitOutcomeKinds.includes('near_miss')
          ? 'near_miss'
          : explicitOutcomeKinds.includes('recovery')
            ? 'recovery'
            : undefined;
    const outcome_kind: import('../../../types/vta').VTAOutcomeKind | undefined =
      type === 'outcome'
        ? (perEventOutcomeKind ?? previousNode?.outcome_kind ?? analysis.outcome?.kind ?? 'loss')
        : undefined;
    const variation_factor: import('../../../types/vta').VariationFactorDetail | undefined = type === 'variation'
      ? (events.find((e) => e.variationFactor)?.variationFactor ?? previousNode?.variation_factor)
      : undefined;
    const sequence_order = preserveCardOrder ? (previousNode?.sequence_order ?? laneSequence.get(lane) ?? 0)
      : (laneSequence.get(lane) ?? 0);
    laneSequence.set(lane, sequence_order + 1);

    const partRoles = analysis.participations
      .filter((p) => p.entityId === card.laneEntityId && activeEventIds.includes(p.eventId))
      .map((p) => p.role);
    const isTargetRole = partRoles.some((r) => r === 'target' || r === 'affected' || r === 'intended_recipient' || r === 'confirmed_recipient');
    const entity_role: import('../../../types/vta').VTANodeEntityRole = previousNode?.entity_role
      ?? (isTargetRole ? 'object' : 'subject');
    const object_display_style = previousNode?.object_display_style;
    const prevLaneIdx = previousLaneIndexMap && previousNode ? previousLaneIndexMap.get(previousNode.lane) : undefined;
    const currLaneIdx = currentLaneIndexMap.get(lane);
    const shiftX =
      prevLaneIdx !== undefined && currLaneIdx !== undefined && prevLaneIdx !== currLaneIdx
        ? (currLaneIdx - prevLaneIdx) * VTA_LANE_WIDTH
        : 0;
    const laneReordered = reorderedLanes.has(lane);
    const shiftedPosition = !laneReordered && previousNode?.position
      ? { x: previousNode.position.x + shiftX, y: previousNode.position.y }
      : undefined;
    const shiftedCompactPosition = !laneReordered && previousNode?.compact_position
      ? { x: previousNode.compact_position.x + shiftX, y: previousNode.compact_position.y }
      : undefined;

    return {
      id: card.id, event_ids: activeEventIds, lane,
      time: unique(events.map((event) => event.time).filter(Boolean)).join(' / '),
      title: events.map((event) => event.title).join('／'),
      description: events.map((event) => event.description).filter(Boolean).join('\n'),
      type, measure_type: events.some((event) => event.measure_type === 'elimination') ? 'elimination' : null,
      sequence_order, supplementary_note,
      entity_role,
      ...(object_display_style ? { object_display_style } : {}),
      ...(outcome_kind ? { outcome_kind } : {}),
      ...(variation_factor ? { variation_factor } : {}),
      ...(shiftedPosition ? { position: shiftedPosition } : {}),
      ...(shiftedCompactPosition ? { compact_position: shiftedCompactPosition } : {}),
      ...(previousNode?.is_hidden && (preserveCardOrder || previousNode.lane === lane) ? { is_hidden: true, hidden_card_height: previousNode.hidden_card_height } : {}),
    };
  });
  const resolveCurrentNodeId = (oldCardId: string): string | undefined => {
    if (preserveCardOrder && nodes.some((n) => n.id === oldCardId)) return oldCardId;
    const oldNode = previousById.get(oldCardId);
    if (!oldNode || !oldNode.event_ids?.length) {
      return preserveCardOrder ? undefined : (nodes.some((n) => n.id === oldCardId) ? oldCardId : undefined);
    }
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
        if (!preserveCardOrder && oldEdge.direction === 'sequential') {
          const sourceNode = nodes.find((n) => n.id === newSource);
          const targetNode = nodes.find((n) => n.id === newTarget);
          if (!sourceNode || !targetNode || sourceNode.lane !== targetNode.lane) {
            continue;
          }
        }
        manualEdges.push({
          ...oldEdge,
          source: newSource,
          target: newTarget,
        });
      }
    }
  }
  const edges = [...manualEdges];
  let presentation = previous?.presentation;
  if (presentation && !preserveCardOrder && presentation.suppressedCards) {
    const remappedSuppressed: Record<string, string> = {};
    for (const [oldCardId, reason] of Object.entries(presentation.suppressedCards)) {
      const newCardId = resolveCurrentNodeId(oldCardId);
      if (newCardId) {
        remappedSuppressed[newCardId] = reason;
      }
    }
    presentation = {
      ...presentation,
      suppressedCards: remappedSuppressed,
    };
  }
  const schema: VTASchema = {
    lanes: allLanes.length ? allLanes : ['主体未設定'], nodes, edges,
    analysis, supplementary_summary: previous?.supplementary_summary,
    custom_notes: previous?.custom_notes,
    ...(previous?.pipelineHistory ? { pipelineHistory: previous.pipelineHistory } : {}),
    presentation,
  };
  if (!previous) schema.presentation = planCardSimplification(schema);
  const projectionPoset = createAnalysisPoset(analysis.entities, analysis.subjectPoset);
  const CROSS_KIND_PRIORITY: Record<string, number> = {
    impact: 5,
    mutual: 4,
    transfer: 3,
    dependency: 2,
    common: 1,
  };
  const formatCrossRelationLabel = (rel: VTAEventRelation): string | undefined =>
    rel.kind === 'dependency'
      ? '作業依存'
      : rel.status === 'omitted'
        ? '未実施'
        : rel.kind === 'common'
          ? '共通影響'
          : rel.kind === 'mutual'
            ? '相互確認'
            : {
                information: '情報',
                material: '物・資機材',
                person: '人員',
                money: '資金',
                other: 'リソース',
              }[rel.resource ?? ''] || undefined;

  const laneSeqIdxByCardId = new Map<string, number>();
  const laneSeqCounter = new Map<string, number>();
  for (const c of orderedCards) {
    const idx = laneSeqCounter.get(c.laneEntityId) ?? 0;
    laneSeqIdxByCardId.set(c.id, idx);
    laneSeqCounter.set(c.laneEntityId, idx + 1);
  }

  const crossCardBundles = new Map<
    string,
    Array<{
      relation: VTAEventRelation;
      sourceId: string;
      targetId: string;
      prevEdge?: VTAEdgeData;
    }>
  >();
  for (const relation of analysis.relations.filter((item) => item.kind !== 'before' && item.sourceEventId !== item.targetEventId)) {
    const sourceEv = eventById.get(relation.sourceEventId);
    const targetEv = eventById.get(relation.targetEventId);
    if (!sourceEv || !targetEv || sourceEv.ignored || targetEv.ignored) continue;
    if (relation.id && schema.presentation?.omittedEdges?.includes('relation:' + relation.id)) continue;
    if (edges.some((edge) => edge.relationId === relation.id)) continue;
    // An unspecified endpoint is ambiguous when an event appears on several lanes.
    const sourceCandidates = resolveCardsForRelationEndpoint(
      orderedCards,
      analysis.participations,
      projectionPoset,
      relation.sourceEventId,
      relation.sourceEntityId,
      relation.sourceEntityOrigin,
      'source'
    );
    const targetCandidates = resolveCardsForRelationEndpoint(
      orderedCards,
      analysis.participations,
      projectionPoset,
      relation.targetEventId,
      relation.targetEntityId,
      relation.targetEntityOrigin,
      'target'
    );
    const source = relation.sourceEntityId
      ? sourceCandidates[0]
      : (sourceCandidates.length === 1 ? sourceCandidates[0] : undefined);
    const target = relation.targetEntityId
      ? targetCandidates[0]
      : (targetCandidates.length === 1 ? targetCandidates[0] : undefined);
    if (!source || !target || source.id === target.id) continue;
    const prevEdge = previous?.edges.find((e) =>
      relation.id
        ? e.relationId === relation.id || Boolean(e.bundledRelationIds?.includes(relation.id))
        : resolveCurrentNodeId(e.source) === source.id && resolveCurrentNodeId(e.target) === target.id
    );
    const hasManualOverride = Boolean(prevEdge && (prevEdge.generated === false || prevEdge.is_break));
    // ADR-0079 / ADR-0081: Absorb cross-entity relations collapsed into the same sequential lane,
    // plus same-origin non-dependency relations made non-adjacent by interleaved merged events.
    if (!hasManualOverride && source.laneEntityId === target.laneEntityId && relation.status !== 'omitted') {
      const laneEnt = entityById.get(source.laneEntityId);
      if (laneEnt && !isOtherActorsLaneName(laneEnt.name, analysis.entities)) {
        const origSrc = relation.sourceEntityOrigin ?? relation.sourceEntityId;
        const origTgt = relation.targetEntityOrigin ?? relation.targetEntityId;
        if (origSrc && origTgt && origSrc !== origTgt) {
          continue;
        }
        const isConsolidatedLane = Boolean(
          laneEnt.mergedFrom?.length || relation.sourceEntityOrigin || relation.targetEntityOrigin
        );
        const srcSeq = laneSeqIdxByCardId.get(source.id);
        const tgtSeq = laneSeqIdxByCardId.get(target.id);
        if (
          isConsolidatedLane &&
          relation.kind !== 'dependency' &&
          srcSeq !== undefined &&
          tgtSeq !== undefined &&
          Math.abs(tgtSeq - srcSeq) > 1
        ) {
          continue;
        }
      }
    }
    const srcEnt = entityById.get(source.laneEntityId);
    const tgtEnt = entityById.get(target.laneEntityId);
    const isConsolidatedPair =
      !hasManualOverride &&
      Boolean(
        relation.sourceEntityOrigin ||
          relation.targetEntityOrigin ||
          srcEnt?.mergedFrom?.length ||
          tgtEnt?.mergedFrom?.length ||
          srcEnt?.aggregate ||
          tgtEnt?.aggregate
      );
    const pairKey = isConsolidatedPair
      ? `consolidated:${[source.id, target.id].sort().join('\u0000')}`
      : `single:${relation.id ?? `${source.id}->${target.id}:${crossCardBundles.size}`}`;
    const group = crossCardBundles.get(pairKey) ?? [];
    group.push({ relation, sourceId: source.id, targetId: target.id, prevEdge });
    crossCardBundles.set(pairKey, group);
  }

  for (const group of crossCardBundles.values()) {
    const sorted = [...group].sort((a, b) => {
      const aManual = a.prevEdge && a.prevEdge.generated === false ? 1 : 0;
      const bManual = b.prevEdge && b.prevEdge.generated === false ? 1 : 0;
      if (bManual !== aManual) return bManual - aManual;
      const aOmitted = a.relation.status === 'omitted' ? 1 : 0;
      const bOmitted = b.relation.status === 'omitted' ? 1 : 0;
      if (bOmitted !== aOmitted) return bOmitted - aOmitted;
      return (CROSS_KIND_PRIORITY[b.relation.kind] ?? 0) - (CROSS_KIND_PRIORITY[a.relation.kind] ?? 0);
    });
    const primary = sorted[0];
    const relation = primary.relation;
    const prevEdge = primary.prevEdge;
    const hasManualOverride = Boolean(prevEdge && prevEdge.generated === false);
    const allRelIds = unique(group.map((g) => g.relation.id).filter((id): id is string => Boolean(id)));
    const hasForward = group.some(
      (g) =>
        g.sourceId === primary.sourceId &&
        g.targetId === primary.targetId &&
        g.relation.kind !== 'common' &&
        g.relation.status !== 'omitted' &&
        g.relation.status !== 'unknown'
    );
    const hasReverse = group.some(
      (g) =>
        g.sourceId === primary.targetId &&
        g.targetId === primary.sourceId &&
        g.relation.kind !== 'common' &&
        g.relation.status !== 'omitted' &&
        g.relation.status !== 'unknown'
    );
    const anyOmitted = group.some((g) => g.relation.status === 'omitted');
    const derivedDirection: VTAEdgeData['direction'] =
      relation.kind === 'dependency'
        ? hasForward && hasReverse
          ? 'bidirectional'
          : 'unidirectional'
        : relation.kind === 'common' || anyOmitted || relation.status === 'unknown'
          ? 'undirected'
          : relation.kind === 'mutual' || (hasForward && hasReverse)
            ? 'bidirectional'
            : 'unidirectional';
    const labels = unique(
      group.map((g) => formatCrossRelationLabel(g.relation)).filter((l): l is string => Boolean(l))
    );
    edges.push({
      source: primary.sourceId,
      target: primary.targetId,
      id: relation.id ? 'relation:' + relation.id : undefined,
      relationId: relation.id,
      ...(allRelIds.length > 1 ? { bundledRelationIds: allRelIds } : {}),
      generated: hasManualOverride ? false : true,
      meaning:
        hasManualOverride && prevEdge?.meaning
          ? prevEdge.meaning
          : (relation.kind as import('../../../types/vta').VTAEdgeData['meaning']),
      resource: hasManualOverride && prevEdge?.resource !== undefined ? prevEdge.resource : relation.resource,
      status:
        hasManualOverride && prevEdge?.status !== undefined
          ? prevEdge.status
          : anyOmitted
            ? 'omitted'
            : relation.status,
      receipt: hasManualOverride && prevEdge?.receipt !== undefined ? prevEdge.receipt : relation.receipt,
      label:
        hasManualOverride && prevEdge?.label !== undefined
          ? prevEdge.label
          : labels.length > 0
            ? labels.join('・')
            : undefined,
      direction:
        hasManualOverride && prevEdge?.direction !== undefined ? prevEdge.direction : derivedDirection,
      category:
        hasManualOverride && prevEdge?.category !== undefined
          ? prevEdge.category
          : relation.kind === 'dependency'
            ? 'dependency'
            : relation.kind === 'impact'
              ? 'impact'
              : relation.resource === 'person'
                ? 'person'
                : relation.resource === 'material'
                  ? 'material'
                  : relation.resource === 'money'
                    ? 'other'
                    : 'information',
      is_break: group.some((g) => Boolean(g.prevEdge?.is_break)),
    });
  }
  const maintained = connectSharedEvents(maintainPresentation(connectSharedEvents(schema)));
  const shouldRepairLaneSequence = !previous || (!preserveCardOrder && Boolean(previous.analysis));
  const rawProjected = shouldRepairLaneSequence
    ? {
        ...repairGeneratedLaneSequence(maintained, {
          preservePositions: Boolean(previous),
        }).schema,
        analysis,
      }
    : maintained;
  const nodeRankMap = new Map<string, number>();
  for (const card of orderedCards) {
    const row = cardRow(card);
    if (row !== Number.MAX_SAFE_INTEGER) {
      nodeRankMap.set(card.id, row);
    }
  }
  const projected = annotateNodeTopologyRules(rawProjected, nodeRankMap);
  if (!options?.silentDebug) {
    recordGraphProjectionDebug(projected, eventRowMap);
  }
  return projected;
}

export interface ProjectionWiringAudit {
  backwardIntraLaneEdges: Array<{ id?: string; lane: string; source: string; target: string; direction: string }>;
  skipSequentialEdges: Array<{ id?: string; lane: string; source: string; target: string; seqSpan: number }>;
  nonAdjacentSemanticIntraLaneEdges: Array<{ id?: string; lane: string; source: string; target: string; seqSpan: number }>;
  dagSequenceInversions: Array<{ lane: string; prevId: string; prevRow: number; nextId: string; nextRow: number }>;
  invalidSequenceLanes: string[];
}

/**
 * Inspects projected lane ordering, DAG ranks, and intra-lane edge connectivity
 * so topological inversions or skipped sequential edges surface in diagnostics.
 */
export function auditProjectionWiring(
  schema: VTASchema,
  eventRowMapOverride?: Map<string, number>
): ProjectionWiringAudit {
  const vis = visibleSchema(schema);
  const analysis = schema.analysis;
  const eventRowMap =
    eventRowMapOverride ?? (analysis?.events.length ? computeEventRowMap(analysis) : undefined);
  const cardEventsById = analysis?.cards.length
    ? new Map(analysis.cards.map((c) => [c.id, c.eventIds]))
    : undefined;

  const nodesByLane = new Map<string, Array<{ node: VTANodeData; index: number }>>();
  vis.nodes.forEach((node, index) => {
    const list = nodesByLane.get(node.lane) ?? [];
    list.push({ node, index });
    nodesByLane.set(node.lane, list);
  });

  const seqIndexById = new Map<string, number>();
  const laneById = new Map<string, string>();
  const invalidSequenceLanes: string[] = [];
  const dagSequenceInversions: ProjectionWiringAudit['dagSequenceInversions'] = [];

  const nodeRowOf = (node: VTANodeData): number | undefined => {
    if (!eventRowMap) return undefined;
    const evIds = node.event_ids?.length ? node.event_ids : (cardEventsById?.get(node.id) ?? []);
    const rows = evIds
      .map((id) => eventRowMap.get(id))
      .filter((r): r is number => r !== undefined);
    return rows.length ? Math.min(...rows) : undefined;
  };

  for (const [lane, group] of nodesByLane) {
    const seqs = group.map(({ node }) => node.sequence_order);
    const hasUniqueSeqs =
      seqs.every((seq) => typeof seq === 'number' && Number.isFinite(seq)) &&
      new Set(seqs).size === group.length;
    if (!hasUniqueSeqs && group.length > 1) {
      invalidSequenceLanes.push(lane);
    }
    const sorted = [...group].sort((a, b) => {
      if (hasUniqueSeqs) return a.node.sequence_order! - b.node.sequence_order!;
      const sa = typeof a.node.sequence_order === 'number' && Number.isFinite(a.node.sequence_order)
        ? a.node.sequence_order
        : a.index;
      const sb = typeof b.node.sequence_order === 'number' && Number.isFinite(b.node.sequence_order)
        ? b.node.sequence_order
        : b.index;
      return sa - sb || a.index - b.index;
    });
    sorted.forEach(({ node }, idx) => {
      seqIndexById.set(node.id, idx);
      laneById.set(node.id, lane);
    });
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1].node;
      const next = sorted[i].node;
      const prevRow = nodeRowOf(prev);
      const nextRow = nodeRowOf(next);
      if (prevRow !== undefined && nextRow !== undefined && prevRow > nextRow) {
        dagSequenceInversions.push({
          lane,
          prevId: prev.id,
          prevRow,
          nextId: next.id,
          nextRow,
        });
      }
    }
  }

  const backwardIntraLaneEdges: ProjectionWiringAudit['backwardIntraLaneEdges'] = [];
  const skipSequentialEdges: ProjectionWiringAudit['skipSequentialEdges'] = [];
  const nonAdjacentSemanticIntraLaneEdges: ProjectionWiringAudit['nonAdjacentSemanticIntraLaneEdges'] = [];

  for (const edge of vis.edges) {
    const srcLane = laneById.get(edge.source);
    const tgtLane = laneById.get(edge.target);
    if (!srcLane || !tgtLane || srcLane !== tgtLane) continue;
    const srcIdx = seqIndexById.get(edge.source);
    const tgtIdx = seqIndexById.get(edge.target);
    if (srcIdx === undefined || tgtIdx === undefined) continue;

    const dir = edge.direction ?? 'sequential';
    if (dir !== 'bidirectional' && dir !== 'undirected' && srcIdx > tgtIdx) {
      backwardIntraLaneEdges.push({
        id: edge.id,
        lane: srcLane,
        source: edge.source,
        target: edge.target,
        direction: dir,
      });
    }

    const span = Math.abs(tgtIdx - srcIdx);
    if (span > 1) {
      if (edge.relationId) {
        nonAdjacentSemanticIntraLaneEdges.push({
          id: edge.id,
          lane: srcLane,
          source: edge.source,
          target: edge.target,
          seqSpan: span,
        });
      } else {
        skipSequentialEdges.push({
          id: edge.id,
          lane: srcLane,
          source: edge.source,
          target: edge.target,
          seqSpan: span,
        });
      }
    }
  }

  return {
    backwardIntraLaneEdges,
    skipSequentialEdges,
    nonAdjacentSemanticIntraLaneEdges,
    dagSequenceInversions,
    invalidSequenceLanes,
  };
}

/**
 * Records a structured `graph.projection` entry including topological wiring diagnostics.
 */
export function recordGraphProjectionDebug(
  projected: VTASchema,
  eventRowMap?: Map<string, number>
): void {
  const analysis = projected.analysis;
  if (!analysis) return;
  const eventById = new Map(analysis.events.map((event) => [event.id, event]));
  const omittedEdges = new Set(projected.presentation?.omittedEdges ?? []);
  const projectionPoset = createAnalysisPoset(analysis.entities, analysis.subjectPoset);
  const isIntentionallyUnprojected = (r: VTAEventRelation): boolean =>
    isIntentionallyUnprojectedRelation(projected, r, {
      eventById,
      omittedEdges,
      poset: projectionPoset,
    });
  const activeEvents = analysis.events.filter((event) => !event.ignored);
  const activeEventIdSet = new Set(activeEvents.map((event) => event.id));
  const projectedEventIdSet = new Set<string>();
  for (const node of projected.nodes) {
    for (const evId of node.event_ids ?? []) {
      if (activeEventIdSet.has(evId)) projectedEventIdSet.add(evId);
    }
  }
  if (projectedEventIdSet.size === 0) {
    for (const card of analysis.cards) {
      for (const evId of card.eventIds) {
        if (activeEventIdSet.has(evId)) projectedEventIdSet.add(evId);
      }
    }
  }
  const unassignedEventsCount = (analysis.unassignedEventIds ?? []).filter((id) =>
    activeEventIdSet.has(id)
  ).length;
  debugRecorder.record('graph.projection', () => ({
    generation: analysis.generation,
    analysis: {
      ...analysis,
      sources: analysis.sources.map((s) => ({
        id: s.id,
        text: '',
        paragraphs: s.paragraphs.map((p) => ({ id: p.id, text: '' })),
      })),
    },
    relations: analysis.relations,
    cards: analysis.cards,
    nodes: projected.nodes,
    visibleNodeCount: visibleSchema(projected).nodes.length,
    eventsCount: activeEvents.length,
    projectedEventsCount: projectedEventIdSet.size,
    unassignedEventsCount,
    edges: projected.edges,
    presentation: projected.presentation,
    subjectPoset: analysis.subjectPoset,
    entities: analysis.entities,
    subjectRanking: analysis.subjectRanking,
    excludedBeforeIds: analysis.relations.filter((r) => r.kind === 'before').map((r) => r.id),
    missingRelations: analysis.relations
      .filter(
        (r) =>
          !isIntentionallyUnprojected(r) &&
          !projected.edges.some(
            (e) => r.id && (e.relationId === r.id || Boolean(e.bundledRelationIds?.includes(r.id)))
          )
      )
      .map((r) => ({
        id: r.id,
        sourceEventId: r.sourceEventId,
        targetEventId: r.targetEventId,
        sourceEntityId: r.sourceEntityId,
        targetEntityId: r.targetEntityId,
      })),
    wiringAudit: auditProjectionWiring(projected, eventRowMap),
  }));
}

export function applyEventClassification(analysis: VTAAnalysisData, raw: unknown): VTAAnalysisData {
  const items = requireArray(record(raw) ? raw.classifications : undefined, '変動判定');
  const pendingIds = new Set(
    analysis.events
      .filter((event) => !event.ignored && event.classification === 'unclassified' && !isIdentifiedOutcomeEvent(analysis, event))
      .map((event) => event.id)
  );
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
      || factIds.some((factId) => !(event.factIds ?? []).includes(factId)) || byId.has(id)) throw new Error(`判定 ${id} の参照が不正です。`);
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
  const facts = raw.facts === undefined ? [] : validateFacts({ facts: raw.facts }, sources);
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
    if (typeof item.timeNodeId === 'number' && Number.isInteger(item.timeNodeId) && item.timeNodeId >= 0 && item.timeNodeId < MAX_TIME_NODES) {
      events[index].timeNodeId = item.timeNodeId;
    }
    if (typeof item.ignored === 'boolean') {
      events[index].ignored = item.ignored;
    }
    if (item.ignoreReason === 'user' || item.ignoreReason === 'post_outcome') {
      events[index].ignoreReason = item.ignoreReason;
    }
    if (typeof item.ignoreRule === 'string' && item.ignoreRule.trim()) {
      events[index].ignoreRule = item.ignoreRule.trim();
    }
    events[index].origin = item.origin === 'manual' ? 'manual' : 'extraction';
    if (events[index].origin === 'manual') events[index].time = typeof item.time === 'string' ? item.time : events[index].time;
    else if (typeof item.time === 'string' && item.time !== events[index].time) throw new Error('イベントの時刻が根拠と一致しません。');
    events[index].measure_type = item.measure_type === 'elimination' ? 'elimination' : null;
    events[index].classificationReason = string(item.classificationReason) || undefined;
    const classificationFactIds = Array.isArray(item.classificationFactIds) ? item.classificationFactIds.map(string) : undefined;
    if (classificationFactIds?.some((id) => !(events[index].factIds ?? []).includes(id))) throw new Error('変動判定の根拠IDが不正です。');
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
  const ignoredEventIds = new Set(events.filter((e) => e.ignored).map((e) => e.id));
  const expectedPairs = unique(
    parsed.participations
      .filter((part) => !ignoredEventIds.has(part.eventId))
      .map((part) => `${part.eventId}\u0000${part.entityId}`)
  );
  const activePairsForCheck = pairs.filter((pair) => {
    const [evId] = pair.split('\u0000');
    return !ignoredEventIds.has(evId);
  });
  if (activePairsForCheck.length !== expectedPairs.length || expectedPairs.some((pair) => !activePairsForCheck.includes(pair))) {
    throw new Error('関与している主体に対応するカードが不足しています。');
  }
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
  const fineGrainedBase = readFineGrainedBase(raw.fineGrainedBase, events, sources);
  const laneConsolidation = readLaneConsolidation(raw.laneConsolidation);
  const result: VTAAnalysisData = {
    version: 5, sources, facts, events, entities: parsed.entities,
    context: readContext(raw.context,events), outcome: readOutcome(raw.outcome,events,sources),
    ...(subjectRanking ? { subjectRanking } : {}),
    ...(normalizationAudit ? { normalizationAudit } : {}),
    ...(fineGrainedBase ? { fineGrainedBase } : {}),
    ...(laneConsolidation ? { laneConsolidation } : {}),
    subjectPoset: record(raw.subjectPoset)
      ? SubjectPoset.fromData(raw.subjectPoset as any).toJSON()
      : SubjectPoset.fromEntities(parsed.entities).toJSON(),
    generation: validateGeneration(raw.generation), generationRuns: Array.isArray(raw.generationRuns)?raw.generationRuns.map(validateGeneration).filter((r):r is NonNullable<typeof r>=>!!r):undefined,
    dispositions: raw.dispositions === undefined ? undefined : validateDispositions(raw.dispositions, sources),
    participations: parsed.participations, relations: parsed.relations, cards,
    unassignedEventIds: events.filter((event) => !event.ignored && !cards.some((card) => card.eventIds.includes(event.id))).map((event) => event.id),
    ...(typeof raw.nextEventSeq === 'number' && Number.isInteger(raw.nextEventSeq) && raw.nextEventSeq >= 1 ? { nextEventSeq: raw.nextEventSeq } : {}),
    ...(record(raw.eventTimeDAG) && typeof raw.eventTimeDAG.nodeCount === 'number' && Array.isArray(raw.eventTimeDAG.matrix)
      ? { eventTimeDAG: raw.eventTimeDAG as unknown as import('../../../types/vta').EventTimeDAGData }
      : {}),
  };
  ensureEventTimeDAG(result);
  return result;
}

/** Samples and user-created cards enter the new model as explicit manual events. */
export function createManualAnalysis(schema: VTASchema): VTAAnalysisData {
  const lanes = unique([...schema.lanes, ...schema.nodes.map((node) => node.lane)]);
  const entities: VTAEntity[] = lanes.map((name, index) => ({ id: `manual_entity_${index + 1}`, name, kind: 'other' }));
  const entityByLane = new Map(entities.map((entity) => [entity.name, entity.id]));
  const events: VTAEvent[] = schema.nodes.map((node, index) => ({
    id: node.event_ids?.[0] ?? `E${index + 1}`,
    origin: 'manual',
    title: node.title,
    description: node.description,
    time: node.time,
    sourceOrder: index,
    factIds: [],
    classification: node.type,
    measure_type: node.measure_type,
    ...(node.outcome_kind ? { outcome_kind: node.outcome_kind } : {}),
    ...(node.variation_factor ? { variationFactor: node.variation_factor } : {}),
  }));
  const cards: VTACardRef[] = schema.nodes.map((node, index) => ({
    id: node.id, laneEntityId: entityByLane.get(node.lane)!, eventIds: [events[index].id],
  }));
  const edgeRelations: VTAEventRelation[] = [];
  const eventIdByNodeId = new Map(schema.nodes.map((node, index) => [node.id, events[index].id]));
  for (const edge of schema.edges) {
    if (edge.direction === 'bidirectional' || edge.direction === 'undirected') continue;
    if (edge.meaning === 'common' || edge.meaning === 'mutual') continue;
    if (edge.status === 'omitted' || edge.status === 'unknown') continue;
    const srcEv = eventIdByNodeId.get(edge.source);
    const tgtEv = eventIdByNodeId.get(edge.target);
    if (srcEv && tgtEv && srcEv !== tgtEv) {
      edgeRelations.push({
        id: edge.relationId ?? edge.id ?? `manual_rel_${edgeRelations.length + 1}`,
        sourceEventId: srcEv,
        targetEventId: tgtEv,
        kind: 'before',
        factIds: [],
      });
    }
  }
  const participations: VTAParticipation[] = cards.map((card) => ({
    eventId: card.eventIds[0],
    entityId: card.laneEntityId,
    role: 'actor',
    factIds: [],
  }));
  const dag = buildEventTimeDAG(events, participations, edgeRelations, [], { cards });
  for (const rel of edgeRelations) {
    const u = events.find((e) => e.id === rel.sourceEventId)?.timeNodeId;
    const v = events.find((e) => e.id === rel.targetEventId)?.timeNodeId;
    if (u !== undefined && v !== undefined && u !== v) {
      dag.manualEdges.push([u, v]);
    }
  }
  dag.relationSignature = '';
  const outcomeEvents = events.filter((e) => e.classification === 'outcome');
  const manualOutcome = outcomeEvents.length > 0
    ? {
        status: 'identified' as const,
        kind: resolveRepresentativeOutcomeKind(events, outcomeEvents.map((e) => e.id), 'loss') ?? 'loss',
        eventIds: outcomeEvents.map((e) => e.id),
        sourceRefs: [],
        reason: '手動作成された帰結イベント',
      }
    : undefined;
  return {
    version: 5, sources: [], facts: [], events, entities,
    participations,
    relations: [], cards, unassignedEventIds: [],
    ...(manualOutcome ? { outcome: manualOutcome } : {}),
    nextEventSeq: events.length + 1,
    eventTimeDAG: dag.toJSON(),
  };
}

/** Keep the existing canvas API as a projection while event records own shared content. */
export function reconcileAnalysis(previous: VTASchema, changed: VTASchema): VTASchema {
  const original = changed.analysis ?? previous.analysis ?? createManualAnalysis(previous);
  const previouslyAssignedEventIds = new Set(original.cards.flatMap((c) => c.eventIds));
  const analysis: VTAAnalysisData = {
    ...original,
    events: original.events.map((event) => ({ ...event })),
    entities: original.entities.map((entity) => ({ ...entity })),
    participations: original.participations.map((part) => ({ ...part })),
    cards: original.cards.map((card) => ({ ...card, eventIds: [...card.eventIds] })),
    // `original` may be the analysis object held by the store (and by undo snapshots). The outcome is updated
    // below when its events disappear, so it must be copied, never mutated in place.
    ...(original.outcome ? { outcome: { ...original.outcome, eventIds: [...original.outcome.eventIds] } } : {}),
    ...(original.fineGrainedBase ? { fineGrainedBase: structuredClone(original.fineGrainedBase) } : {}),
    ...(original.laneConsolidation ? { laneConsolidation: structuredClone(original.laneConsolidation) } : {}),
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
      const { event: newEvent } = addEventToAnalysis(analysis, {
        title: node.title,
        description: node.description,
        time: node.time,
        laneEntityId: entity.id,
        role: node.entity_role === 'object' ? 'target' : 'actor',
        classification: node.type,
        measure_type: node.measure_type,
        outcome_kind: node.outcome_kind,
        variationFactor: node.variation_factor,
        cardId: node.id,
      });
      const eventId = newEvent.id;
      card = analysis.cards.find((item) => item.id === node.id)!;
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
    if (contentChanged && node.type === old.type && old.type !== 'outcome') {
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
        const remainingIds = analysis.outcome.eventIds.filter((id) => id !== event.id);
        if (remainingIds.length === 0) {
          analysis.outcome = {
            ...analysis.outcome,
            status: 'not_found',
            kind: undefined,
            eventIds: [],
            reason: '帰結ノードが解除されました。',
          };
        } else {
          const nextKind = resolveRepresentativeOutcomeKind(analysis.events, remainingIds, analysis.outcome.kind);
          analysis.outcome = {
            ...analysis.outcome,
            eventIds: remainingIds,
            ...(nextKind ? { kind: nextKind } : { kind: undefined }),
          };
        }
      }
    }
    if (old.type === 'variation' && node.type !== 'variation') {
      delete event.variationFactor;
    }
    if (node.type === 'outcome' || node.outcome_kind) {
      if (node.type === 'outcome') {
        delete event.variationFactor;
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
          const mergedIds = unique([...analysis.outcome.eventIds, event.id]);
          const nextKind = resolveRepresentativeOutcomeKind(analysis.events, mergedIds, kind ?? analysis.outcome.kind);
          analysis.outcome = {
            ...analysis.outcome,
            status: 'identified',
            ...(nextKind ? { kind: nextKind } : {}),
            eventIds: mergedIds,
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

  const activeCardEventIds = new Set(analysis.cards.flatMap((c) => c.eventIds));
  // イベントは物理削除せず、図上のカードがすべて失われた場合は ignored フラグを立てる
  for (const e of analysis.events) {
    if (previouslyAssignedEventIds.has(e.id) && !activeCardEventIds.has(e.id)) {
      e.ignored = true;
      e.ignoreReason = 'user';
    }
  }

  // 関係線の保持・削除判定
  const activePairs = new Set(
    analysis.participations.map((part) => `${part.eventId}\u0000${part.entityId}`)
  );
  const reconcilePoset = createAnalysisPoset(analysis.entities, analysis.subjectPoset);
  const participatesInReconcile = (eventId: string, entityId: string, originId?: string): boolean => {
    if (activePairs.has(`${eventId}\u0000${entityId}`)) return true;
    return (
      participatesViaPoset(analysis.participations, reconcilePoset, eventId, entityId) ||
      Boolean(originId && participatesViaPoset(analysis.participations, reconcilePoset, eventId, originId))
    );
  };
  const activeEventIds = new Set(analysis.events.filter((e) => !e.ignored).map((e) => e.id));

  analysis.relations = analysis.relations.filter((relation) => {
    // 1. 端点イベントの存在確認
    if (!activeEventIds.has(relation.sourceEventId) || !activeEventIds.has(relation.targetEventId)) {
      return false;
    }

    // 2. 端点主体の関与確認（直接一致に加え、SubjectPoset / mergedFrom 推移性を考慮）
    if (relation.sourceEntityId && !participatesInReconcile(relation.sourceEventId, relation.sourceEntityId, relation.sourceEntityOrigin)) {
      return false;
    }
    if (relation.targetEntityId && !participatesInReconcile(relation.targetEventId, relation.targetEntityId, relation.targetEntityOrigin)) {
      return false;
    }

    // 3. エッジ削除との整合確認
    // previous に対応する edge があったが changed で明示的またはカード削除によりエッジが失われた場合
    const matchesEdge = (edge: VTAEdgeData) =>
      relation.id
        ? edge.relationId === relation.id || Boolean(edge.bundledRelationIds?.includes(relation.id))
        : Boolean(edge.source && edge.target);
    const oldEdge = previous.edges.find(matchesEdge);
    if (oldEdge) {
      const stillHasEdge = changed.edges.some((edge) =>
        relation.id ? matchesEdge(edge) : edge.id === oldEdge.id
      );
      if (!stillHasEdge) {
        return false;
      }
    }

    return true;
  });

  if (analysis.fineGrainedBase) {
    const activeRelIds = new Set(
      analysis.relations.map((r) => r.id).filter((id): id is string => Boolean(id))
    );
    const fgEntIds = new Set(analysis.fineGrainedBase.entities.map((e) => e.id));
    for (const ent of analysis.entities) {
      if (ent.id.startsWith('manual_entity_') && !fgEntIds.has(ent.id)) {
        analysis.fineGrainedBase.entities.push({ ...ent });
        fgEntIds.add(ent.id);
      }
    }
    const fgCardIds = new Set(analysis.fineGrainedBase.cards.map((c) => c.id));
    for (const card of analysis.cards) {
      if (!fgCardIds.has(card.id) && fgEntIds.has(card.laneEntityId)) {
        analysis.fineGrainedBase.cards.push({ ...card, eventIds: [...card.eventIds] });
        fgCardIds.add(card.id);
      }
    }
    const fgPartKeys = new Set(
      analysis.fineGrainedBase.participations.map((p) => `${p.eventId}\u0000${p.entityId}`)
    );
    for (const part of analysis.participations) {
      if (part.origin === 'manual' && fgEntIds.has(part.entityId)) {
        const key = `${part.eventId}\u0000${part.entityId}`;
        if (!fgPartKeys.has(key)) {
          analysis.fineGrainedBase.participations.push({ ...part });
          fgPartKeys.add(key);
        }
      }
    }
    analysis.fineGrainedBase.relations = analysis.fineGrainedBase.relations.filter(
      (r) =>
        activeEventIds.has(r.sourceEventId) &&
        activeEventIds.has(r.targetEventId) &&
        (!r.id || activeRelIds.has(r.id))
    );
  }

  analysis.relations = analysis.relations.map((relation) => {
    const override = changed.edges.find((edge) => edge.relationId && edge.relationId === relation.id && edge.generated === false);
    return override ? { ...relation, resource: override.meaning==='dependency'?undefined:override.resource ?? relation.resource, status: override.meaning==='dependency'?undefined:override.status ?? relation.status, receipt: override.meaning==='dependency'?'na':override.receipt ?? relation.receipt,
      kind: override.meaning && override.meaning !== 'association' ? override.meaning : relation.kind,
      evidenceBasis:'user' as const,explanation:'利用者が図上で関係属性を手動編集。',
      ...(relation.proposalId ? { provenance: 'user' as const, adoptionReason: '利用者が図上で関係属性を手動編集。' } : {}) } : relation;
  });
  if (analysis.outcome && analysis.outcome.status === 'identified') {
    const existingEventIds = new Set(analysis.events.filter((e) => !e.ignored).map((e) => e.id));
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
  analysis.unassignedEventIds = analysis.events.filter((event) => !event.ignored && !analysis.cards.some((card) => card.eventIds.includes(event.id))).map((event) => event.id);
  ensureEventTimeDAG(analysis);
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
    const rawParentIds = Array.isArray(item.parentEntityIds)
      ? unique(item.parentEntityIds.map(string).filter(Boolean))
      : undefined;
    origEntities.push({
      id,
      name,
      kind,
      ...(focus ? { focus } : {}),
      ...(focusSourceRefs ? { focusSourceRefs } : {}),
      ...(typeof item.parentEntityId === 'string' && item.parentEntityId.trim() ? { parentEntityId: item.parentEntityId.trim() } : {}),
      ...(rawParentIds?.length ? { parentEntityIds: rawParentIds } : {}),
    });
  }
  for (const ent of origEntities) {
    if (ent.parentEntityIds?.length) {
      const validParents = ent.parentEntityIds.filter((pid) => pid !== ent.id && seenOrigIds.has(pid));
      if (validParents.length > 0) {
        ent.parentEntityIds = validParents;
        if (!ent.parentEntityId || ent.parentEntityId === ent.id || !seenOrigIds.has(ent.parentEntityId)) {
          ent.parentEntityId = validParents[0];
        }
      } else {
        delete ent.parentEntityIds;
      }
    }
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
    const excluded = r.excluded === true;
    const validStages = new Set([
      'stage2_bnb',
      'stage2_llm_merge',
      'stage2.5_b0_prune',
      'stage2.5_b1_poset',
      'stage2.5_b2_others',
      'stage3_hc_poset',
      'stage3_hc_group',
      'stage3_hc_others',
      'stage3_hc_object',
      'stage3_hc_prune',
    ]);
    const consolidationStage =
      typeof r.consolidationStage === 'string' && validStages.has(r.consolidationStage)
        ? (r.consolidationStage as NonNullable<VTAAnalysisData['subjectRanking']>['ranks'][number]['consolidationStage'])
        : undefined;
    const mergeBlockedReason = string(r.mergeBlockedReason) || undefined;
    ranks.push({
      entityId,
      rank: r.rank,
      score: r.score,
      breakdown: { A: bd.A as number, O: bd.O as number, F: bd.F as number, C: bd.C as number, T: bd.T as number },
      ...(priority ? { priority } : {}),
      retained: r.retained,
      ...(mergedInto ? { mergedInto } : {}),
      ...(excluded ? { excluded: true } : {}),
      ...(consolidationStage ? { consolidationStage } : {}),
      ...(mergeBlockedReason ? { mergeBlockedReason } : {}),
      ...(typeof r.isInfluential === 'boolean' ? { isInfluential: r.isInfluential } : {}),
      reason: r.reason,
    });
  }
  return {
    version: 1,
    maxSubjects: Math.round(raw.maxSubjects),
    ...(typeof raw.preConsolidationMaxSubjects === 'number' && Number.isFinite(raw.preConsolidationMaxSubjects) && raw.preConsolidationMaxSubjects >= 1
      ? { preConsolidationMaxSubjects: Math.round(raw.preConsolidationMaxSubjects) }
      : {}),
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
  const polarity =
    raw.polarity === 'negative' || raw.polarity === 'resilient' ? raw.polarity : undefined;
  const scope =
    raw.scope === 'in_scope' || raw.scope === 'post_outcome' ? raw.scope : undefined;
  const promotedOutcomeKind =
    raw.promotedOutcomeKind === 'loss' ||
    raw.promotedOutcomeKind === 'near_miss' ||
    raw.promotedOutcomeKind === 'recovery'
      ? raw.promotedOutcomeKind
      : undefined;
  return {
    value,
    ...(polarity ? { polarity } : {}),
    ...(scope ? { scope } : {}),
    ...(promotedOutcomeKind ? { promotedOutcomeKind } : {}),
    reason,
    sourceRefs,
  };
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

function readFineGrainedBase(
  raw: unknown,
  events: VTAEvent[],
  sources: VTASource[]
): VTAFineGrainedBase | undefined {
  if (!record(raw)) return undefined;
  try {
    const cardsRaw = requireArray(raw.cards, '最細粒度カード参照');
    const parsed = validateParticipants(
      {
        entities: raw.entities,
        participations: raw.participations,
        relations: raw.relations,
        cardGroups: cardsRaw
          .filter((card) => record(card) && Array.isArray(card.eventIds) && card.eventIds.length > 1)
          .map((card) => ({
            entityId: (card as Record<string, unknown>).laneEntityId,
            eventIds: (card as Record<string, unknown>).eventIds,
          })),
      },
      events,
      [],
      true,
      () => {},
      sources
    );
    const entIds = new Set(parsed.entities.map((e) => e.id));
    const eventIds = new Set(events.map((e) => e.id));
    const cards: VTACardRef[] = [];
    const seenCardIds = new Set<string>();
    for (const item of cardsRaw) {
      if (!record(item)) continue;
      const id = string(item.id);
      const laneEntityId = string(item.laneEntityId);
      const evIds = Array.isArray(item.eventIds)
        ? unique(item.eventIds.map(string).filter((eid) => eventIds.has(eid)))
        : [];
      if (!id || seenCardIds.has(id) || !entIds.has(laneEntityId) || evIds.length === 0) continue;
      seenCardIds.add(id);
      cards.push({ id, laneEntityId, eventIds: evIds });
    }
    const subjectPoset = record(raw.subjectPoset)
      ? SubjectPoset.fromData(raw.subjectPoset as unknown as SubjectPosetData).toJSON()
      : SubjectPoset.fromEntities(parsed.entities).toJSON();
    return {
      entities: parsed.entities,
      participations: parsed.participations,
      relations: parsed.relations,
      cards,
      subjectPoset,
    };
  } catch {
    return undefined;
  }
}

function readLaneConsolidation(raw: unknown): VTALaneConsolidationState | undefined {
  if (!record(raw) || raw.version !== 1) return undefined;
  if (typeof raw.targetMaxSubjects !== 'number' || !Number.isFinite(raw.targetMaxSubjects)) return undefined;
  if (typeof raw.score !== 'number' || !Number.isFinite(raw.score)) return undefined;
  const m = record(raw.metrics) ? raw.metrics : undefined;
  if (
    !m ||
    typeof m.c1 !== 'number' ||
    typeof m.c2 !== 'number' ||
    typeof m.c3 !== 'number' ||
    typeof m.c4 !== 'number' ||
    typeof m.c5 !== 'number'
  ) {
    return undefined;
  }
  const laneAssignment: Record<string, string> = {};
  if (record(raw.laneAssignment)) {
    for (const [k, v] of Object.entries(raw.laneAssignment)) {
      if (k.trim() && typeof v === 'string' && v.trim()) {
        laneAssignment[k.trim()] = v.trim();
      }
    }
  }
  const validKinds = new Set(['poset_rollup', 'role_group', 'peripheral_others', 'object_absorb']);
  const candidates: VTALaneConsolidationState['candidates'] = [];
  for (const item of Array.isArray(raw.candidates) ? raw.candidates : []) {
    if (!record(item)) continue;
    const id = string(item.id);
    const kind = string(item.kind);
    const sourceEntityIds = Array.isArray(item.sourceEntityIds)
      ? unique(item.sourceEntityIds.map(string).filter(Boolean))
      : [];
    const semanticCost = typeof item.semanticCost === 'number' && Number.isFinite(item.semanticCost)
      ? Math.max(0, Math.min(1, item.semanticCost))
      : 0.2;
    if (!id || !validKinds.has(kind) || sourceEntityIds.length === 0) continue;
    const targetKind = ['person', 'organization', 'machine', 'other'].includes(String(item.targetKind))
      ? (item.targetKind as VTAEntity['kind'])
      : undefined;
    candidates.push({
      id,
      kind: kind as VTALaneConsolidationState['candidates'][number]['kind'],
      sourceEntityIds,
      ...(string(item.targetEntityId) ? { targetEntityId: string(item.targetEntityId) } : {}),
      ...(string(item.targetLabel) ? { targetLabel: string(item.targetLabel) } : {}),
      ...(targetKind ? { targetKind } : {}),
      semanticCost,
      reason: string(item.reason) || '統合候補',
      origin: item.origin === 'poset_fallback' ? 'poset_fallback' : 'llm',
    });
  }
  const separationConstraints: VTALaneConsolidationState['separationConstraints'] = [];
  for (const item of Array.isArray(raw.separationConstraints) ? raw.separationConstraints : []) {
    if (!record(item)) continue;
    const entityA = string(item.entityA);
    const entityB = string(item.entityB);
    if (!entityA || !entityB || entityA === entityB) continue;
    separationConstraints.push({
      entityA,
      entityB,
      severity: item.severity === 'soft' ? 'soft' : 'hard',
      reason: string(item.reason) || '分離維持',
    });
  }
  const composites: NonNullable<VTALaneConsolidationState['composites']> = {};
  if (record(raw.composites)) {
    for (const [cid, cval] of Object.entries(raw.composites)) {
      if (!record(cval)) continue;
      const id = string(cval.id) || cid.trim();
      const displayName = string(cval.displayName);
      const compositeOf = Array.isArray(cval.compositeOf)
        ? unique(cval.compositeOf.map(string).filter(Boolean))
        : [];
      const leafIds = Array.isArray(cval.leafIds)
        ? unique(cval.leafIds.map(string).filter(Boolean))
        : [];
      const kind = ['person', 'organization', 'machine', 'other'].includes(String(cval.kind))
        ? (cval.kind as VTAEntity['kind'])
        : 'organization';
      const focus = ['reporter', 'high', 'mid', 'low'].includes(String(cval.focus))
        ? (cval.focus as VTAEntity['focus'])
        : undefined;
      const stepSemanticCost =
        typeof cval.stepSemanticCost === 'number' && Number.isFinite(cval.stepSemanticCost)
          ? Math.max(0, cval.stepSemanticCost)
          : 0;
      if (!id || !displayName || compositeOf.length < 2) continue;
      composites[id] = {
        id,
        compositeOf,
        leafIds,
        ...(string(cval.coreEntityId) ? { coreEntityId: string(cval.coreEntityId) } : {}),
        ...(cval.aggregate === true ? { aggregate: true as const } : {}),
        displayName,
        kind,
        ...(focus ? { focus } : {}),
        stepSemanticCost,
      };
    }
  }
  return {
    version: 1,
    targetMaxSubjects: Math.round(raw.targetMaxSubjects),
    appliedCandidateIds: Array.isArray(raw.appliedCandidateIds)
      ? raw.appliedCandidateIds.map(string).filter(Boolean)
      : [],
    laneAssignment,
    ...(Object.keys(composites).length > 0 ? { composites } : {}),
    score: raw.score,
    metrics: {
      c1: m.c1,
      c2: m.c2,
      c3: m.c3,
      c4: m.c4,
      c5: m.c5,
      interactionRetention: typeof m.interactionRetention === 'number' ? m.interactionRetention : m.c3,
    },
    candidates,
    separationConstraints,
  };
}

export type BatchAdoptMode = 'variation_only' | 'all';

export interface BatchAdoptResult {
  updatedAnalysis: VTAAnalysisData;
  variationCount: number;
  normalCount: number;
  totalCount: number;
}

/**
 * Returns true when an event is already identified as a terminal outcome
 * (`classification === 'outcome'`, explicit `outcome_kind`, or listed in `analysis.outcome.eventIds`).
 */
export function isIdentifiedOutcomeEvent(
  analysis: Pick<VTAAnalysisData, 'outcome'> | undefined | null,
  event: Pick<VTAEvent, 'id' | 'classification' | 'outcome_kind'> | undefined | null
): boolean {
  if (!event) return false;
  if (event.classification === 'outcome' || Boolean(event.outcome_kind)) return true;
  return Boolean(
    analysis?.outcome?.status === 'identified' &&
      analysis.outcome.eventIds.includes(event.id)
  );
}

/**
 * Adopts preliminary classifications into formal event classifications.
 * Protects events that already have a manual/formal classification (i.e. classification !== 'unclassified')
 * as well as identified outcome events so outcome cards are never overwritten into variation/normal cards.
 */
export function batchAdoptPreliminary(
  analysis: VTAAnalysisData,
  mode: BatchAdoptMode = 'variation_only'
): BatchAdoptResult {
  let variationCount = 0;
  let normalCount = 0;

  const events = analysis.events.map((event) => {
    if (
      event.classification !== 'unclassified' ||
      !event.preliminary ||
      isIdentifiedOutcomeEvent(analysis, event)
    ) {
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

    const reasonText = event.preliminary.reason || event.classificationReason || '';
    const explicitPolarity = event.preliminary.polarity;
    const variationFactor = isVariation
      ? (event.variationFactor ??
          (() => {
            const baseFactor = extractVariationFactorFromReason(reasonText || event.title);
            return explicitPolarity
              ? {
                  ...baseFactor,
                  polarity: explicitPolarity,
                  ...(explicitPolarity === 'resilient' ? { category: 'response' as const } : {}),
                }
              : baseFactor;
          })())
      : event.variationFactor;

    return {
      ...event,
      classification: event.preliminary.value,
      classificationReason: event.preliminary.reason || event.classificationReason,
      classificationSourceRefs: event.preliminary.sourceRefs?.length
        ? event.preliminary.sourceRefs
        : event.classificationSourceRefs,
      ...(variationFactor ? { variationFactor } : {}),
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

/**
 * Promotes events whose `[仮判定]` carries `promotedOutcomeKind` (`outcome:loss` / `outcome:recovery` / `outcome:near_miss`)
 * into `analysis.outcome` (`classification: 'outcome'`) when the event has >= 1 participating entity
 * (unassigned events remain in-scope with `preliminary` so Stage 2 Gate G4 is never violated).
 */
export function promotePreliminaryOutcomes<T extends VTAAnalysisData>(
  analysis: T
): { analysis: T; promotedEventIds: string[] } {
  const participatingEventIds = new Set(analysis.participations.map((p) => p.eventId));
  const candidates = analysis.events.filter(
    (ev) =>
      !ev.ignored &&
      Boolean(ev.preliminary?.promotedOutcomeKind) &&
      participatingEventIds.has(ev.id) &&
      !isIdentifiedOutcomeEvent(analysis, ev)
  );
  if (candidates.length === 0) {
    return { analysis, promotedEventIds: [] };
  }

  const promotedIds = candidates.map((ev) => ev.id);
  const promotedById = new Map(candidates.map((ev) => [ev.id, ev.preliminary!.promotedOutcomeKind!]));
  const existingOutcome = analysis.outcome?.status === 'identified' ? analysis.outcome : undefined;
  const existingOutcomeIdSet = new Set(existingOutcome?.eventIds ?? []);

  const nextEvents = analysis.events.map((ev) => {
    const promotedKind = promotedById.get(ev.id);
    if (promotedKind) {
      return {
        ...ev,
        classification: 'outcome' as const,
        outcome_kind: promotedKind,
      };
    }
    if (existingOutcomeIdSet.has(ev.id) && !ev.outcome_kind) {
      return {
        ...ev,
        classification: 'outcome' as const,
        outcome_kind: (existingOutcome?.kind ?? 'loss') as VTAOutcomeKind,
      };
    }
    return ev;
  });

  const nextEventIds = [...new Set([...(existingOutcome?.eventIds ?? []), ...promotedIds])];
  const mergedRefsMap = new Map<string, VTASourceRef>();
  for (const ref of existingOutcome?.sourceRefs ?? []) {
    mergedRefsMap.set(`${ref.sourceId}/${ref.paragraphId}`, ref);
  }
  for (const ev of candidates) {
    const refs = ev.preliminary?.sourceRefs?.length ? ev.preliminary.sourceRefs : (ev.sourceRefs ?? []);
    for (const ref of refs) {
      mergedRefsMap.set(`${ref.sourceId}/${ref.paragraphId}`, ref);
    }
  }
  const promotedReasons = candidates
    .map((ev) => ev.preliminary?.reason?.trim() || ev.title)
    .filter(Boolean);
  const nextReason =
    existingOutcome?.reason?.trim() || promotedReasons.join(' / ') || '帰結イベントの補完特定';
  const nextKind = resolveRepresentativeOutcomeKind(
    nextEvents,
    nextEventIds,
    existingOutcome?.kind
  );

  return {
    analysis: {
      ...analysis,
      events: nextEvents,
      outcome: {
        status: 'identified',
        ...(nextKind ? { kind: nextKind } : {}),
        eventIds: nextEventIds,
        sourceRefs: [...mergedRefsMap.values()],
        reason: nextReason,
      },
    },
    promotedEventIds: promotedIds,
  };
}

/**
 * Computes the representative outcome kind across the remaining identified outcome events
 * using strict severity priority: `loss` > `near_miss` > `recovery`.
 */
export function resolveRepresentativeOutcomeKind(
  events: readonly VTAEvent[],
  outcomeEventIds: readonly string[],
  fallbackKind?: VTAOutcomeKind
): VTAOutcomeKind | undefined {
  if (!outcomeEventIds.length) return undefined;
  const byId = new Map(events.map((e) => [e.id, e]));
  const explicitKinds = outcomeEventIds
    .map((id) => byId.get(id)?.outcome_kind)
    .filter((k): k is VTAOutcomeKind => Boolean(k));
  if (!explicitKinds.length) return fallbackKind;
  const hasUnsuffixed = outcomeEventIds.some((id) => !byId.get(id)?.outcome_kind);
  if (hasUnsuffixed || explicitKinds.includes('loss')) return 'loss';
  if (explicitKinds.includes('near_miss')) return 'near_miss';
  return 'recovery';
}

/**
 * Manually updates a single event's classification and keeps `analysis.outcome` and `event.outcome_kind`
 * strictly synchronized (allowing users to demote a misclassified outcome back to unclassified/normal/variation,
 * or promote an event into an outcome).
 */
export function setEventClassificationWithOutcomeSync(
  analysis: VTAAnalysisData,
  eventId: string,
  classification: VTANodeType,
  options?: {
    outcomeKind?: VTAOutcomeKind;
    clearReason?: boolean;
  }
): VTAAnalysisData {
  const target = analysis.events.find((e) => e.id === eventId);
  if (!target) return analysis;

  const isPromotingToOutcome = classification === 'outcome';
  const wasOutcome = isIdentifiedOutcomeEvent(analysis, target);

  const nextEvents = analysis.events.map((event) => {
    if (event.id !== eventId) return event;
    const next: VTAEvent = {
      ...event,
      classification,
      ...(options?.clearReason
        ? {
            classificationReason: undefined,
            classificationFactIds: undefined,
            classificationSourceRefs: undefined,
          }
        : {}),
    };
    if (isPromotingToOutcome) {
      next.outcome_kind = options?.outcomeKind ?? event.outcome_kind ?? analysis.outcome?.kind ?? 'loss';
      delete next.variationFactor;
      next.measure_type = null;
    } else {
      delete next.outcome_kind;
      if (classification !== 'variation') {
        delete next.variationFactor;
      }
    }
    return next;
  });

  let nextOutcome = analysis.outcome;
  if (isPromotingToOutcome) {
    const mergedIds = unique([...(analysis.outcome?.eventIds ?? []), eventId]);
    const nextKind = resolveRepresentativeOutcomeKind(
      nextEvents,
      mergedIds,
      options?.outcomeKind ?? analysis.outcome?.kind ?? 'loss'
    );
    nextOutcome = {
      status: 'identified',
      ...(nextKind ? { kind: nextKind } : {}),
      eventIds: mergedIds,
      sourceRefs: analysis.outcome?.sourceRefs?.length ? analysis.outcome.sourceRefs : (target.sourceRefs ?? []),
      reason: analysis.outcome?.reason || '手動指定された帰結イベント',
    };
  } else if (wasOutcome && analysis.outcome) {
    const remainingIds = analysis.outcome.eventIds.filter((id) => id !== eventId);
    if (remainingIds.length === 0) {
      nextOutcome = {
        ...analysis.outcome,
        status: 'not_found',
        kind: undefined,
        eventIds: [],
        reason: '帰結ノードが解除されました。',
      };
    } else {
      const nextKind = resolveRepresentativeOutcomeKind(nextEvents, remainingIds, analysis.outcome.kind);
      nextOutcome = {
        ...analysis.outcome,
        eventIds: remainingIds,
        ...(nextKind ? { kind: nextKind } : { kind: undefined }),
      };
    }
  }

  return {
    ...analysis,
    events: nextEvents,
    ...(nextOutcome !== undefined ? { outcome: nextOutcome } : {}),
  };
}

