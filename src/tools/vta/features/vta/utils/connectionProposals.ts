import {relationAttributes} from './relationContract';
import { cardVisible, dependencyProblem, dependencyKey, isPrecedence } from './eventOrder';
import type { VTAEventRelation, VTASchema, VTASourceRef } from '../../../types/vta';

export type ConnectionProposal = {
  evidenceBasis?: VTAEventRelation['evidenceBasis'];
  generation?: import('../../../types/vta').GenerationProvenance;
  id: string; operation: 'add' | 'refine'; targetLineId: string;
  kind: 'transfer' | 'impact' | 'mutual' | 'common' | 'dependency';
  sourceEventId: string; sourceEntityId: string; targetEventId: string; targetEntityId: string;
  sourceRefs: VTASourceRef[]; resource: string; status: '-' | 'occurred' | 'omitted' | 'unknown';
  receipt: 'confirmed' | 'unconfirmed' | 'na'; reason: string; selected: boolean;
  proposalReason: string;
};
export type ConnectionReviewItem = { id: string; sourceRefs: VTASourceRef[]; reason: string };
export type ConnectionProposalResult = { proposals: ConnectionProposal[]; reviews: ConnectionReviewItem[]; invalidRows: string[] };

const clean = (value: string) => value.trim().replace(/[\r\n\t]+/g, ' ');
export function parseConnectionProposalTSV(text: string, schema: VTASchema, scopeCardIds?: string[], allowedRefs?: Set<string>): ConnectionProposalResult {
  const proposals: ConnectionProposal[] = [], reviews: ConnectionReviewItem[] = [], invalidRows: string[] = [];
  const lines = text.replace(/^```[^\n]*\n|\n```$/g, '').split(/\r?\n/).map((line) => line.trimEnd());
  let mode: 'proposal' | 'review' | '' = '';
  let sawProposalTable = false;
  for (const line of lines) {
    if (line === '[接続提案]') { mode = 'proposal'; sawProposalTable = true; continue; }
    if (line === '[要確認]') { mode = 'review'; continue; }
    if (!line || line === '[完了]' || line.startsWith('ID\t')) continue;
    const parts = line.split('\t').map(clean);
    try {
      if (mode === 'proposal') {
        if (parts.length !== 14) throw new Error('列数不正');
        const [id, operation, targetLineId, kind, sourceEventId, sourceEntityId, targetEventId, targetEntityId, refs, resource, status, receipt, basis, reason] = parts;
        const relationKind = kind === 'transfer' || kind === 'impact' || kind === 'mutual' || kind === 'common' || kind === 'dependency';
        const source = schema.analysis?.sources.flatMap((s) => s.paragraphs.map((p) => ({ sourceId:s.id, paragraphId:p.id }))).map((r) => r.sourceId + '/' + r.paragraphId) ?? [];
        const sourceRefs = refs.split(',').filter(Boolean).map((ref) => { const [sourceId, paragraphId] = ref.split('/'); return { sourceId, paragraphId }; });
        const eventExists = (id: string) => schema.analysis?.events.some((e) => e.id === id);
        const entityExists = (eventId: string, entityId: string) => schema.analysis?.participations.some((p) => p.eventId === eventId && p.entityId === entityId);
        const cards = (schema.analysis?.cards ?? []).filter((card) => !scopeCardIds || scopeCardIds.includes(card.id));
        const visible = (eventId: string, entityId: string) => cards.some((c) => c.eventIds.includes(eventId) && c.laneEntityId === entityId
          && cardVisible(schema,c.id,entityId));
        const refineEdge = operation === 'refine' ? schema.edges.find((edge) => edge.id === targetLineId && edge.meaning === 'association' && edge.eventId === sourceEventId
          && (!scopeCardIds || scopeCardIds.includes(edge.source) && scopeCardIds.includes(edge.target))
          && !schema.presentation?.omittedEdges?.includes(targetLineId)) : undefined;
        relationAttributes(kind,resource,status,receipt);
        if(!['recorded','source-assessment','source-context'].includes(basis))throw new Error('根拠区分が不正');
        let problem = '';
        if (!id || proposals.some((p) => p.id === id)) problem='提案ID';
        else if (!['add','refine'].includes(operation) || !relationKind) problem='操作または関係種別';
        else if (!eventExists(sourceEventId) || !eventExists(targetEventId)) problem='イベント参照';
        else if (sourceEntityId === targetEntityId || !entityExists(sourceEventId, sourceEntityId) || !entityExists(targetEventId, targetEntityId)) problem='主体参照';
        else if (!visible(sourceEventId, sourceEntityId) || !visible(targetEventId, targetEntityId)) problem='表示カード参照';
        else if (kind === 'common' && sourceEventId !== targetEventId) problem='共通イベントのイベントID';
        else if (sourceRefs.length === 0 || sourceRefs.some((r) => (!source.includes(r.sourceId + '/' + r.paragraphId) || allowedRefs && !allowedRefs.has(r.sourceId+'/'+r.paragraphId))) || !resource
          || !reason) problem='根拠または属性';
        else if (operation === 'add' && targetLineId !== '-') problem='追加対象線ID';
        else if (operation === 'refine' && (!targetLineId.startsWith('shared:') || sourceEventId !== targetEventId || !refineEdge
          || ![refineEdge.source,refineEdge.target].every((cardId) => cards.some((c) => c.id === cardId && c.eventIds.includes(sourceEventId) && (c.laneEntityId === sourceEntityId || c.laneEntityId === targetEntityId))))) problem='具体化対象線';
        if (!problem && kind==='dependency') problem = operation!=='add' ? '作業依存は追加のみです。' : dependencyProblem(schema.analysis!,{kind:'dependency',sourceEventId,targetEventId,sourceEntityId,targetEntityId,factIds:[]}) ?? '';
        if (problem) throw new Error(problem);
        proposals.push({ evidenceBasis:basis as ConnectionProposal['evidenceBasis'], id, operation: operation as 'add'|'refine', targetLineId, kind: kind as ConnectionProposal['kind'], sourceEventId, sourceEntityId, targetEventId, targetEntityId, sourceRefs, resource, status: status as ConnectionProposal['status'], receipt: receipt as ConnectionProposal['receipt'], reason, proposalReason:reason, selected: false });
      } else if (mode === 'review') {
        if (parts.length !== 3) throw new Error('列数不正');
        const [id, refs, reason] = parts;
        const sourceRefs = refs.split(',').filter(Boolean).map((ref) => { const [sourceId, paragraphId] = ref.split('/'); return { sourceId, paragraphId }; });
        if (!id || !reason || sourceRefs.some((r) => allowedRefs && !allowedRefs.has(r.sourceId+'/'+r.paragraphId) || !schema.analysis?.sources.some((s) => s.id === r.sourceId && s.paragraphs.some((p) => p.id === r.paragraphId)))) throw new Error('参照が不正');
        reviews.push({ id, sourceRefs, reason });
      }
    } catch (error) { invalidRows.push(`${line}　[${error instanceof Error ? error.message : '検証失敗'}]`); }
  }
  if (!text.includes('[完了]')) invalidRows.push('応答に[完了]がありません。');
  if (!sawProposalTable) invalidRows.push('応答に[接続提案]がありません。');
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
  for (const proposal of selected) {
    if(proposal.evidenceBasis!==undefined&&!['recorded','source-assessment','source-context','user'].includes(proposal.evidenceBasis))errors.push(proposal.id+': 根拠区分が不正です。');
    try { relationAttributes(proposal.kind,proposal.resource,proposal.status,proposal.receipt); }
    catch(error) { errors.push(`${proposal.id}: ${error instanceof Error?error.message:String(error)}`); }
    const visibleParticipation = (eventId:string,entityId:string) => schema.analysis?.participations.some((p)=>p.eventId===eventId&&p.entityId===entityId)
      && schema.analysis?.cards.some((c)=>c.eventIds.includes(eventId)&&c.laneEntityId===entityId&&cardVisible(schema,c.id,entityId));
    if (!['transfer','impact','mutual','common','dependency'].includes(proposal.kind) || proposal.kind==='dependency' && proposal.operation!=='add'
      || !proposal.sourceRefs.length || proposal.sourceRefs.some(ref=>!schema.analysis?.sources.some(s=>s.id===ref.sourceId&&s.paragraphs.some(p=>p.id===ref.paragraphId)))
      || !['confirmed','unconfirmed','na'].includes(proposal.receipt) || !proposal.resource.trim() || !proposal.reason.trim()
      || proposal.kind==='common' && proposal.sourceEventId!==proposal.targetEventId
      || !visibleParticipation(proposal.sourceEventId,proposal.sourceEntityId) || !visibleParticipation(proposal.targetEventId,proposal.targetEntityId)
      || proposal.sourceEventId===proposal.targetEventId && proposal.sourceEntityId===proposal.targetEntityId) errors.push(`${proposal.id}: 修正後の候補属性または端点が不正です。`);
    const relation = proposalRelation(proposal);
    const problem=dependencyProblem(schema.analysis!,relation);
    if(problem) errors.push(proposal.id+': '+problem);
    if(proposal.kind==='dependency' && schema.presentation?.omittedDependencies?.includes(dependencyKey(relation))) errors.push(proposal.id+': 削除済みの作業依存です。');
    const key = relationKey(relation);
    if (keys.has(key)) errors.push(`${proposal.id}: 既存関係または選択候補と重複しています。`);
    keys.add(key);
    const fromCard=schema.analysis?.cards.find((card)=>card.eventIds.includes(proposal.sourceEventId)&&card.laneEntityId===proposal.sourceEntityId);
    const toCard=schema.analysis?.cards.find((card)=>card.eventIds.includes(proposal.targetEventId)&&card.laneEntityId===proposal.targetEntityId);
    const manualConflict=fromCard&&toCard&&schema.edges.some((edge)=>(edge.source===fromCard.id&&edge.target===toCard.id||edge.source===toCard.id&&edge.target===fromCard.id)
      &&(!edge.generated||edge.is_break||edge.meaning!=='association'));
    if(manualConflict) errors.push(`${proposal.id}: 同じ端点に手動線またはBREAKがあります。先に既存線を確認してください。`);
    if (proposal.operation === 'refine') {
      const eventCards = schema.analysis?.cards.filter((c) => c.eventIds.includes(proposal.sourceEventId)) ?? [];
      const participants = eventCards.filter((c) => schema.presentation?.lanes[c.laneEntityId] !== 'hide' && !schema.presentation?.suppressedCards[c.id]);
      if (proposal.sourceEventId !== proposal.targetEventId || !participants.some((c) => c.laneEntityId === proposal.sourceEntityId) || !participants.some((c) => c.laneEntityId === proposal.targetEntityId)) errors.push(`${proposal.id}: 共通イベントの表示対象が変わっています。`);
    }
    if (isPrecedence(relation)) {
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
export function proposalRelation(p: ConnectionProposal): VTAEventRelation { return { id: `proposal:${p.id}`, evidenceBasis:p.evidenceBasis, explanation:p.reason, generation:p.generation, sourceEventId:p.sourceEventId,targetEventId:p.targetEventId,sourceEntityId:p.sourceEntityId,targetEntityId:p.targetEntityId,kind:p.kind,factIds:[],sourceRefs:p.sourceRefs,resource:p.kind==='dependency'?undefined:p.resource,status:p.status==='-'?undefined:p.status,receipt:p.receipt,proposalId:p.id,proposalReason:p.proposalReason,adoptionReason:p.reason,provenance:'llm-proposal' }; }
