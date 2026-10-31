import type {VTASchema} from '../../../types/vta';
import {isSubjectInferred} from './subjectInference';
export const evidenceLabel=(basis:string|undefined)=>basis==='source-context'?'文脈からの判断（原文明示ではない）':basis==='source-assessment'?'原文の評価・推定':basis==='user'?'利用者の判断':basis==='recorded'?'原文明示':'根拠区分未記録';
const prelimValueLabel=(v:'normal'|'variation'|'undetermined')=>v==='normal'?'通常作業':v==='variation'?'変動要因':'判定保留';
const treatmentLabel=(t:string|undefined)=>t==='evaluative_word_removed'?'評価語を除去':t==='kept_as_quoted_claim'?'供述として保持':t==='action_only'?'客観的行為のみ記録':'検知';
export function evidenceNotes(schema:VTASchema,nodeId?:string):string[]{
 const a=schema.analysis;if(!a)return [];
 const cards=nodeId?a.cards.filter(c=>c.id===nodeId):a.cards;
 const cardEventIds=new Set(cards.flatMap(c=>c.eventIds));
 const cardEvents=a.events.filter(e=>cardEventIds.has(e.id));
 const cardSourceKeys=new Set(cardEvents.flatMap(e=>(e.sourceRefs??[]).map(r=>`${r.sourceId}/${r.paragraphId}`)));
 const parts=a.participations.filter(p=>cards.some(c=>c.laneEntityId===p.entityId&&c.eventIds.includes(p.eventId)));
 const refs=(items:{sourceId:string;paragraphId:string}[]|undefined)=>(items??[]).map(r=>r.sourceId+'/'+r.paragraphId).join(',');
 const origMap=new Map((a.subjectRanking?.originalEntities??[]).map(e=>[e.id,e.name]));
 const mergedNotes=parts.flatMap(p=>{
  const laneName=a.entities.find(e=>e.id===p.entityId)?.name??p.entityId;
  return (p.mergedFrom??[]).filter(m=>m.entityId!==p.entityId).map(m=>`${laneName} へ統合：${origMap.get(m.entityId)??a.entities.find(e=>e.id===m.entityId)?.name??m.entityId}（${m.role}）`);
 });
 const prelimNotes=cardEvents.filter(e=>e.classification==='unclassified'&&e.preliminary).map(e=>`仮判定（参考） ${e.id}：${prelimValueLabel(e.preliminary!.value)}${e.preliminary!.reason?` — ${e.preliminary!.reason}`:''}${e.preliminary!.sourceRefs.length?` [${refs(e.preliminary!.sourceRefs)}]`:''}`);
 const auditCorrections=(a.normalizationAudit?.corrections??[]).filter(c=>!nodeId||c.sourceRefs.some(r=>cardSourceKeys.has(`${r.sourceId}/${r.paragraphId}`))).map(c=>`${c.kind==='alias_unification'?'表記統一':'誤字補正'}：「${c.from}」→「${c.to}」（${c.reason}） [${refs(c.sourceRefs)}]`);
 const auditNotices=(a.normalizationAudit?.subjectiveNotices??[]).filter(n=>!nodeId||n.eventIds.some(id=>cardEventIds.has(id))||n.sourceRefs.some(r=>cardSourceKeys.has(`${r.sourceId}/${r.paragraphId}`))).map(n=>`原文の主観・評価表現：「${n.phrase}」（${treatmentLabel(n.treatment)}） [${refs(n.sourceRefs)}]`);
 return [
  ...a.entities.filter(e=>e.resolution==='unresolved'&&(!nodeId||cards.some(c=>c.laneEntityId===e.id))).map(e=>'主体未特定の仮レーン：'+e.name),
  ...parts.filter(isSubjectInferred).map(p=>`${a.entities.find(e=>e.id===p.entityId)?.name??p.entityId}：主体は推定`),
  ...new Set(mergedNotes),
  ...prelimNotes,
  ...auditCorrections,
  ...auditNotices,
  ...a.relations.filter(r=>r.evidenceBasis&&(!nodeId||cards.some(c=>c.eventIds.includes(r.sourceEventId)&&c.laneEntityId===r.sourceEntityId||c.eventIds.includes(r.targetEventId)&&c.laneEntityId===r.targetEntityId))).map(r=>`関係 ${r.sourceEventId} → ${r.targetEventId} (${r.kind})：${evidenceLabel(r.evidenceBasis)}。${r.explanation??r.adoptionReason??''} [${refs(r.sourceRefs)}]`),
 ];
}
