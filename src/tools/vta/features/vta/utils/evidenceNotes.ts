import type {VTASchema} from '../../../types/vta';
import {isSubjectInferred} from './subjectInference';
export const evidenceLabel=(basis:string|undefined)=>basis==='source-context'?'文脈からの判断（原文明示ではない）':basis==='source-assessment'?'原文の評価・推定':basis==='user'?'利用者の判断':basis==='recorded'?'原文明示':'根拠区分未記録';
export function evidenceNotes(schema:VTASchema,nodeId?:string):string[]{
 const a=schema.analysis;if(!a)return [];
 const cards=nodeId?a.cards.filter(c=>c.id===nodeId):a.cards;
 const parts=a.participations.filter(p=>cards.some(c=>c.laneEntityId===p.entityId&&c.eventIds.includes(p.eventId)));
 const refs=(items:{sourceId:string;paragraphId:string}[]|undefined)=>(items??[]).map(r=>r.sourceId+'/'+r.paragraphId).join(',');
 const origMap=new Map((a.subjectRanking?.originalEntities??[]).map(e=>[e.id,e.name]));
 const mergedNotes=parts.flatMap(p=>{
  const laneName=a.entities.find(e=>e.id===p.entityId)?.name??p.entityId;
  return (p.mergedFrom??[]).filter(m=>m.entityId!==p.entityId).map(m=>`${laneName} へ統合：${origMap.get(m.entityId)??a.entities.find(e=>e.id===m.entityId)?.name??m.entityId}（${m.role}）`);
 });
 return [
  ...a.entities.filter(e=>e.resolution==='unresolved'&&(!nodeId||cards.some(c=>c.laneEntityId===e.id))).map(e=>'主体未特定の仮レーン：'+e.name),
  ...parts.filter(isSubjectInferred).map(p=>`${a.entities.find(e=>e.id===p.entityId)?.name??p.entityId}：主体は推定`),
  ...new Set(mergedNotes),
  ...a.relations.filter(r=>r.evidenceBasis&&(!nodeId||cards.some(c=>c.eventIds.includes(r.sourceEventId)&&c.laneEntityId===r.sourceEntityId||c.eventIds.includes(r.targetEventId)&&c.laneEntityId===r.targetEntityId))).map(r=>`関係 ${r.sourceEventId} → ${r.targetEventId} (${r.kind})：${evidenceLabel(r.evidenceBasis)}。${r.explanation??r.adoptionReason??''} [${refs(r.sourceRefs)}]`),
 ];
}
