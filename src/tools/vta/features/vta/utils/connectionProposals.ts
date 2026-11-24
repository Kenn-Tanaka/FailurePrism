import {relationAttributes} from './relationContract';
import { cardVisible, dependencyProblem, dependencyKey, isPrecedence } from './eventOrder';
import { compareEventTimeById, ensureEventTimeDAG } from './eventTimePoset';
import { createAnalysisPoset, participatesViaPoset, resolveCardsForRelationEndpoint, type SubjectPoset } from './subjectPoset';
import type { VTACardRef, VTAEventRelation, VTASchema, VTASourceRef } from '../../../types/vta';

export type ConnectionProposal = {
  evidenceBasis?: VTAEventRelation['evidenceBasis'];
  generation?: import('../../../types/vta').GenerationProvenance;
  id: string; operation: 'add' | 'refine'; targetLineId: string;
  kind: 'transfer' | 'impact' | 'mutual' | 'common' | 'dependency';
  sourceEventId: string; sourceEntityId: string; targetEventId: string; targetEntityId: string;
  sourceEntityOrigin?: string; targetEntityOrigin?: string;
  sourceRefs: VTASourceRef[]; resource: string; status: '-' | 'occurred' | 'omitted' | 'unknown';
  receipt: 'confirmed' | 'unconfirmed' | 'na'; reason: string; selected: boolean;
  proposalReason: string;
};
export type ConnectionReviewItem = { id: string; sourceRefs: VTASourceRef[]; reason: string };
export type PeripheralSubjectProposal = {
  id: string;
  entityId: string;
  sourceRefs: VTASourceRef[];
  reason: string;
};
export type ConnectionProposalResult = {
  proposals: ConnectionProposal[];
  reviews: ConnectionReviewItem[];
  invalidRows: string[];
  peripheralSubjects?: PeripheralSubjectProposal[];
  peripheralSectionPresent?: boolean;
};

const clean = (value: string) => value.trim().replace(/[\r\n\t]+/g, ' ');

type ResolvedProposalEndpoint = {
  participated: boolean;
  card?: VTACardRef;
  entityId?: string;
  originId?: string;
  visible: boolean;
};

function resolveProposalEndpoint(
  schema: VTASchema,
  poset: SubjectPoset | undefined,
  candidateCards: readonly VTACardRef[],
  eventId: string,
  entityId: string,
  originId: string | undefined,
  role: 'source' | 'target'
): ResolvedProposalEndpoint {
  const analysis = schema.analysis;
  if (!analysis || !poset) {
    return { participated: false, visible: false };
  }
  const participated =
    participatesViaPoset(analysis.participations, poset, eventId, entityId) ||
    Boolean(originId && participatesViaPoset(analysis.participations, poset, eventId, originId));
  if (!participated) {
    return { participated: false, visible: false };
  }
  const cards = resolveCardsForRelationEndpoint(
    candidateCards,
    analysis.participations,
    poset,
    eventId,
    entityId,
    originId,
    role
  );
  const card = cards[0];
  if (!card || !cardVisible(schema, card.id, card.laneEntityId)) {
    return { participated: true, card, entityId: card?.laneEntityId, visible: false };
  }
  const resolvedOrigin = originId ?? (card.laneEntityId !== entityId ? entityId : undefined);
  return {
    participated: true,
    card,
    entityId: card.laneEntityId,
    ...(resolvedOrigin && resolvedOrigin !== card.laneEntityId ? { originId: resolvedOrigin } : {}),
    visible: true,
  };
}

export function parseConnectionProposalTSV(text: string, schema: VTASchema, scopeCardIds?: string[], allowedRefs?: Set<string>): ConnectionProposalResult {
  const proposals: ConnectionProposal[] = [], reviews: ConnectionReviewItem[] = [], invalidRows: string[] = [];
  const peripheralSubjects: PeripheralSubjectProposal[] = [];
  const lines = text.replace(/^```[^\n]*\n|\n```$/g, '').split(/\r?\n/).map((line) => line.trimEnd());
  const poset = schema.analysis ? createAnalysisPoset(schema.analysis.entities, schema.analysis.subjectPoset) : undefined;
  const primarySourceId = schema.analysis?.sources[0]?.id ?? 'source_1';
  let mode: 'proposal' | 'review' | 'peripheral' | '' = '';
  let sawProposalTable = false;
  let sawPeripheralSection = false;
  let sawDone = false;
  for (const line of lines) {
    if (line === '[完了]') { sawDone = true; break; }
    if (line === '[接続提案]') { mode = 'proposal'; sawProposalTable = true; continue; }
    if (line === '[要確認]') { mode = 'review'; continue; }
    if (line === '[周辺主体候補]') { mode = 'peripheral'; sawPeripheralSection = true; continue; }
    if (!line || line.startsWith('ID\t')) continue;
    const parts = line.split('\t').map(clean);
    try {
      if (mode === 'proposal') {
        if (parts.length !== 14) throw new Error('列数不正');
        const [rawId, operation, targetLineId, kind, sourceEventId, sourceEntityId, targetEventId, targetEntityId, refs, resource, status, receipt, basis, reason] = parts;
        let id = rawId.trim();
        if (!id || id === '-') {
          let counter = proposals.length + 1;
          while (proposals.some((p) => p.id === `P${counter}`)) counter++;
          id = `P${counter}`;
        } else if (proposals.some((p) => p.id === id)) {
          let suffix = 2;
          while (proposals.some((p) => p.id === `${id}_${suffix}`)) suffix++;
          id = `${id}_${suffix}`;
        }
        const relationKind = kind === 'transfer' || kind === 'impact' || kind === 'mutual' || kind === 'common' || kind === 'dependency';
        const source = schema.analysis?.sources.flatMap((s) => s.paragraphs.map((p) => ({ sourceId:s.id, paragraphId:p.id }))).map((r) => r.sourceId + '/' + r.paragraphId) ?? [];
        const sourceRefs = refs.split(',').filter(Boolean).map((ref) => { const [sourceId, paragraphId] = ref.split('/'); return { sourceId, paragraphId }; });
        const eventExists = (evId: string) => schema.analysis?.events.some((e) => e.id === evId);
        const cards = (schema.analysis?.cards ?? []).filter((card) => !scopeCardIds || scopeCardIds.includes(card.id));
        const srcEndpoint = resolveProposalEndpoint(schema, poset, cards, sourceEventId, sourceEntityId, undefined, 'source');
        const tgtEndpoint = resolveProposalEndpoint(schema, poset, cards, targetEventId, targetEntityId, undefined, 'target');
        const resolvedSourceEntityId = srcEndpoint.entityId ?? sourceEntityId;
        const resolvedTargetEntityId = tgtEndpoint.entityId ?? targetEntityId;
        const refineEdge = operation === 'refine' ? schema.edges.find((edge) => edge.id === targetLineId && edge.meaning === 'association' && edge.eventId === sourceEventId
          && (!scopeCardIds || scopeCardIds.includes(edge.source) && scopeCardIds.includes(edge.target))
          && !schema.presentation?.omittedEdges?.includes(targetLineId)) : undefined;
        relationAttributes(kind,resource,status,receipt);
        if(!['recorded','source-assessment','source-context'].includes(basis))throw new Error('根拠区分が不正');
        let problem = '';
        if (!id || proposals.some((p) => p.id === id)) problem='提案ID';
        else if (!['add','refine'].includes(operation) || !relationKind) problem='操作または関係種別';
        else if (!eventExists(sourceEventId) || !eventExists(targetEventId)) problem='イベント参照';
        else if (sourceEntityId === targetEntityId || !srcEndpoint.participated || !tgtEndpoint.participated || resolvedSourceEntityId === resolvedTargetEntityId || (srcEndpoint.card && tgtEndpoint.card && srcEndpoint.card.id === tgtEndpoint.card.id)) problem='主体参照';
        else if (!srcEndpoint.visible || !tgtEndpoint.visible) problem='表示カード参照';
        else if (kind === 'common' && sourceEventId !== targetEventId) problem='共通イベントのイベントID';
        else if (sourceRefs.length === 0 || sourceRefs.some((r) => (!source.includes(r.sourceId + '/' + r.paragraphId) || allowedRefs && !allowedRefs.has(r.sourceId+'/'+r.paragraphId))) || !resource
          || !reason) problem='根拠または属性';
        else if (operation === 'add' && targetLineId !== '-') problem='追加対象線ID';
        else if (operation === 'refine' && (!targetLineId.startsWith('shared:') || sourceEventId !== targetEventId || !refineEdge
          || ![refineEdge.source,refineEdge.target].every((cardId) => cardId === srcEndpoint.card?.id || cardId === tgtEndpoint.card?.id))) problem='具体化対象線';
        if (!problem && kind==='dependency') problem = operation!=='add' ? '作業依存は追加のみです。' : dependencyProblem(schema.analysis!,{kind:'dependency',sourceEventId,targetEventId,sourceEntityId:resolvedSourceEntityId,targetEntityId:resolvedTargetEntityId,sourceEntityOrigin:srcEndpoint.originId,targetEntityOrigin:tgtEndpoint.originId,factIds:[]}) ?? '';
        if (problem) throw new Error(problem);
        proposals.push({
          evidenceBasis:basis as ConnectionProposal['evidenceBasis'],
          id,
          operation: operation as 'add'|'refine',
          targetLineId,
          kind: kind as ConnectionProposal['kind'],
          sourceEventId,
          sourceEntityId: resolvedSourceEntityId,
          targetEventId,
          targetEntityId: resolvedTargetEntityId,
          ...(srcEndpoint.originId ? { sourceEntityOrigin: srcEndpoint.originId } : {}),
          ...(tgtEndpoint.originId ? { targetEntityOrigin: tgtEndpoint.originId } : {}),
          sourceRefs,
          resource,
          status: status as ConnectionProposal['status'],
          receipt: receipt as ConnectionProposal['receipt'],
          reason,
          proposalReason:reason,
          selected: false,
        });
      } else if (mode === 'review') {
        if (parts.length !== 3) throw new Error('列数不正');
        const [rawId, refs, reason] = parts;
        let id = rawId.trim();
        if (!id || id === '-') {
          let counter = reviews.length + 1;
          while (reviews.some((r) => r.id === `Q${counter}`)) counter++;
          id = `Q${counter}`;
        } else if (reviews.some((r) => r.id === id)) {
          let suffix = 2;
          while (reviews.some((r) => r.id === `${id}_${suffix}`)) suffix++;
          id = `${id}_${suffix}`;
        }
        const sourceRefs = refs.split(',').filter(Boolean).map((ref) => { const [sourceId, paragraphId] = ref.split('/'); return { sourceId, paragraphId }; });
        if (!id || !reason || !sourceRefs.length || sourceRefs.some((r) => allowedRefs && !allowedRefs.has(r.sourceId+'/'+r.paragraphId) || !schema.analysis?.sources.some((s) => s.id === r.sourceId && s.paragraphs.some((p) => p.id === r.paragraphId)))) throw new Error('参照が不正');
        reviews.push({ id, sourceRefs, reason });
      } else if (mode === 'peripheral') {
        if (parts.length < 4) throw new Error('周辺主体候補の列数不正');
        const [rawId, entityId, refs, ...reasonParts] = parts;
        const reason = reasonParts.join(' ').trim();
        let id = rawId.trim();
        if (!id || id === '-') {
          let counter = peripheralSubjects.length + 1;
          while (peripheralSubjects.some((s) => s.id === `PS${counter}`)) counter++;
          id = `PS${counter}`;
        }
        const entityExists = schema.analysis?.entities.some((e) => !e.aggregate && e.id === entityId);
        if (!entityExists) throw new Error('周辺主体IDが不正');
        const sourceRefs = refs
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((ref) => {
            if (ref.includes('/')) {
              const [sourceId, paragraphId] = ref.split('/');
              return { sourceId, paragraphId };
            }
            return { sourceId: primarySourceId, paragraphId: ref };
          });
        const validRef =
          sourceRefs.length > 0 &&
          sourceRefs.every(
            (r) =>
              (!allowedRefs || allowedRefs.has(`${r.sourceId}/${r.paragraphId}`)) &&
              Boolean(
                schema.analysis?.sources.some(
                  (s) => s.id === r.sourceId && s.paragraphs.some((p) => p.id === r.paragraphId)
                )
              )
          );
        if (!reason || !validRef) throw new Error('周辺主体候補の参照または理由が不正');
        if (!peripheralSubjects.some((s) => s.entityId === entityId)) {
          peripheralSubjects.push({ id, entityId, sourceRefs, reason });
        }
      }
    } catch (error) { invalidRows.push(`${line}　[${error instanceof Error ? error.message : '検証失敗'}]`); }
  }
  if (!sawDone && !text.includes('[完了]')) invalidRows.push('応答に[完了]がありません。');
  if (!sawProposalTable) invalidRows.push('応答に[接続提案]がありません。');
  if (sawPeripheralSection) {
    return {
      proposals,
      reviews,
      invalidRows,
      peripheralSubjects,
      peripheralSectionPresent: true,
    };
  }
  return { proposals, reviews, invalidRows };
}

export function connectionProposalSignature(schema: VTASchema): string {
  const payload = { sources: schema.analysis?.sources, events: schema.analysis?.events, entities: schema.analysis?.entities,
    participations: schema.analysis?.participations, relations: schema.analysis?.relations,context:schema.analysis?.context,outcome:schema.analysis?.outcome,
    edges: schema.edges.filter((e) => !e.generated || e.meaning !== 'association').map(({ source,target,id,meaning,direction,status,receipt,resource,is_break }) => ({ source,target,id,meaning,direction,status,receipt,resource,is_break })),
    omittedEdges: schema.presentation?.omittedEdges ?? [], omittedDependencies:schema.presentation?.omittedDependencies, allCards:schema.analysis?.cards, lanes:schema.presentation?.lanes,
    cards: schema.analysis?.cards.filter((c) => schema.presentation?.lanes[c.laneEntityId] !== 'hide' && !schema.presentation?.suppressedCards[c.id]).map((c) => ({ id:c.id,entity:c.laneEntityId,events:c.eventIds })) };
  return JSON.stringify(payload);
}

export function validateSelectedConnectionProposals(schema: VTASchema, selected: ConnectionProposal[]): string[] {
  const errors: string[] = [], relations = [...(schema.analysis?.relations ?? [])];
  const keys = new Set(relations.filter((r) => r.kind !== 'before').map(relationKey));
  const transferGraph = new Map<string, Set<string>>();
  for (const relation of relations.filter(isPrecedence)) addArc(transferGraph, relation.sourceEventId, relation.targetEventId);
  const poset = schema.analysis ? createAnalysisPoset(schema.analysis.entities, schema.analysis.subjectPoset) : undefined;
  const timeDag = schema.analysis ? ensureEventTimeDAG(schema.analysis) : undefined;
  const allCards = schema.analysis?.cards ?? [];
  for (const proposal of selected) {
    if(proposal.evidenceBasis!==undefined&&!['recorded','source-assessment','source-context','user'].includes(proposal.evidenceBasis))errors.push(proposal.id+': 根拠区分が不正です。');
    try { relationAttributes(proposal.kind,proposal.resource,proposal.status,proposal.receipt); }
    catch(error) { errors.push(`${proposal.id}: ${error instanceof Error?error.message:String(error)}`); }
    const srcEndpoint = resolveProposalEndpoint(schema, poset, allCards, proposal.sourceEventId, proposal.sourceEntityId, proposal.sourceEntityOrigin, 'source');
    const tgtEndpoint = resolveProposalEndpoint(schema, poset, allCards, proposal.targetEventId, proposal.targetEntityId, proposal.targetEntityOrigin, 'target');
    const resolvedSourceEntityId = srcEndpoint.entityId ?? proposal.sourceEntityId;
    const resolvedTargetEntityId = tgtEndpoint.entityId ?? proposal.targetEntityId;
    const resolvedProposal: ConnectionProposal = {
      ...proposal,
      sourceEntityId: resolvedSourceEntityId,
      targetEntityId: resolvedTargetEntityId,
      ...(srcEndpoint.originId ? { sourceEntityOrigin: srcEndpoint.originId } : {}),
      ...(tgtEndpoint.originId ? { targetEntityOrigin: tgtEndpoint.originId } : {}),
    };
    if (!['transfer','impact','mutual','common','dependency'].includes(proposal.kind) || proposal.kind==='dependency' && proposal.operation!=='add'
      || !proposal.sourceRefs.length || proposal.sourceRefs.some(ref=>!schema.analysis?.sources.some(s=>s.id===ref.sourceId&&s.paragraphs.some(p=>p.id===ref.paragraphId)))
      || !['confirmed','unconfirmed','na'].includes(proposal.receipt) || !proposal.resource.trim() || !proposal.reason.trim()
      || proposal.kind==='common' && proposal.sourceEventId!==proposal.targetEventId
      || !srcEndpoint.visible || !tgtEndpoint.visible
      || resolvedSourceEntityId===resolvedTargetEntityId
      || srcEndpoint.card && tgtEndpoint.card && srcEndpoint.card.id===tgtEndpoint.card.id) errors.push(`${proposal.id}: 修正後の候補属性または端点が不正です。`);
    const relation = proposalRelation(resolvedProposal);
    const problem=dependencyProblem(schema.analysis!,relation);
    if(problem) errors.push(proposal.id+': '+problem);
    if(proposal.kind==='dependency' && schema.presentation?.omittedDependencies?.includes(dependencyKey(relation))) errors.push(proposal.id+': 削除済みの作業依存です。');
    const key = relationKey(relation);
    if (keys.has(key)) errors.push(`${proposal.id}: 既存関係または選択候補と重複しています。`);
    keys.add(key);
    const fromCard = srcEndpoint.card;
    const toCard = tgtEndpoint.card;
    const manualConflict=fromCard&&toCard&&schema.edges.some((edge)=>(edge.source===fromCard.id&&edge.target===toCard.id||edge.source===toCard.id&&edge.target===fromCard.id)
      &&(!edge.generated||edge.is_break||edge.meaning!=='association'));
    if(manualConflict) errors.push(`${proposal.id}: 同じ端点に手動線またはBREAKがあります。先に既存線を確認してください。`);
    if (proposal.operation === 'refine') {
      const eventCards = schema.analysis?.cards.filter((c) => c.eventIds.includes(proposal.sourceEventId)) ?? [];
      const participants = eventCards.filter((c) => schema.presentation?.lanes[c.laneEntityId] !== 'hide' && !schema.presentation?.suppressedCards[c.id]);
      if (proposal.sourceEventId !== proposal.targetEventId || !participants.some((c) => c.id === fromCard?.id) || !participants.some((c) => c.id === toCard?.id)) errors.push(`${proposal.id}: 共通イベントの表示対象が変わっています。`);
    }
    if (isPrecedence(relation)) {
      if (
        schema.analysis &&
        timeDag &&
        proposal.sourceEventId !== proposal.targetEventId &&
        compareEventTimeById(schema.analysis, proposal.targetEventId, proposal.sourceEventId, timeDag) === 'before'
      ) {
        errors.push(`${proposal.id}: 先行イベント (${proposal.sourceEventId}) が後続イベント (${proposal.targetEventId}) より時刻・因果順で後にあるため、逆行する有向関係を追加できません。`);
      }
      const reaches=(from:string,to:string,seen=new Set<string>()):boolean=>from===to||!seen.has(from)&&(seen.add(from),[...(transferGraph.get(from)??[])].some(n=>reaches(n,to,seen)));
      const cyclic=reaches(proposal.targetEventId,proposal.sourceEventId);
      addArc(transferGraph, proposal.sourceEventId, proposal.targetEventId);
      if (cyclic) errors.push(`${proposal.id}: 選択した伝達関係に循環があります。`);
    }
  }
  return [...new Set(errors)];
}
function addArc(graph: Map<string,Set<string>>, from: string, to: string) { if (!from || !to) return; const set=graph.get(from)??new Set(); set.add(to); graph.set(from,set); }
function relationKey(r: Pick<VTAEventRelation,'sourceEventId'|'targetEventId'|'sourceEntityId'|'targetEntityId'|'kind'|'resource'|'status'|'receipt'>) {
  const endpoints=[JSON.stringify([r.sourceEventId,r.sourceEntityId??'']),JSON.stringify([r.targetEventId,r.targetEntityId??''])];
  if (r.kind==='common'||r.kind==='mutual') endpoints.sort();
  return [...endpoints,r.kind,r.resource??'',r.status??'',r.receipt??''].join('|');
}
export function proposalRelation(p: ConnectionProposal): VTAEventRelation { return { id: `proposal:${p.id}`, evidenceBasis:p.evidenceBasis, explanation:p.reason, generation:p.generation, sourceEventId:p.sourceEventId,targetEventId:p.targetEventId,sourceEntityId:p.sourceEntityId,targetEntityId:p.targetEntityId,...(p.sourceEntityOrigin?{sourceEntityOrigin:p.sourceEntityOrigin}:{}),...(p.targetEntityOrigin?{targetEntityOrigin:p.targetEntityOrigin}:{}),kind:p.kind,factIds:[],sourceRefs:p.sourceRefs,resource:p.kind==='dependency'?undefined:p.resource,status:p.status==='-'?undefined:p.status,receipt:p.receipt,proposalId:p.id,proposalReason:p.proposalReason,adoptionReason:p.reason,provenance:'llm-proposal' }; }
