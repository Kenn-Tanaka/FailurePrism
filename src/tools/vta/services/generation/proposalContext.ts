import {isSubjectInferred} from '../../features/vta/utils/subjectInference';
import type {VTASchema} from '../../types/vta';
import {cardVisible} from '../../features/vta/utils/eventOrder';
import {sliceProposalSourceRows, type ProposalSourceRow} from './contextSlicer';
const cell=(value:unknown)=>String(value??'').replace(/[\t\r\n]+/g,' ').trim()||'-';
/** Reference labels come only from actual sourceRefs, never from neighboring passages. */
export function proposalSourceRows(schema:VTASchema): ProposalSourceRow[]{
 const a=schema.analysis!;
 const direct=new Map<string,string[]>();
 for(const event of a.events)for(const ref of event.sourceRefs??a.facts.filter(f=>event.factIds.includes(f.id)).flatMap(f=>f.evidence)){const key=ref.sourceId+'/'+ref.paragraphId;direct.set(key,[...(direct.get(key)??[]),event.id]);}
 return a.sources.flatMap(s=>s.paragraphs.map(p=>({ref:s.id+'/'+p.id,eventIds:direct.get(s.id+'/'+p.id)??[],purpose:(direct.has(s.id+'/'+p.id)?'direct':'context') as 'direct'|'context',text:p.text})));
}
export function proposalContext(schema:VTASchema,scopeCardIds?:string[],maxSourceChars=25000){
 const a=schema.analysis!;
 const state=(eventId:string)=>{
  const cards=a.cards.filter(c=>c.eventIds.includes(eventId));
  if(!cards.length)return 'unassigned';
  const shown=cards.filter(c=>cardVisible(schema,c.id,c.laneEntityId));
  if(!shown.length)return 'hidden';
  return scopeCardIds&&!shown.some(c=>scopeCardIds.includes(c.id))?'out-of-scope':'visible';
 };
 const assignedEntities=(eventId:string)=>{
  const parts=a.participations.filter(p=>p.eventId===eventId);
  return parts.length?parts.map(p=>`${p.entityId}:${p.role}`).join(','):'-';
 };
 const table=(title:string,headers:string[],rows:unknown[][])=>`[${title}]\n${headers.join('\t')}\n${rows.map(r=>r.map(cell).join('\t')).join('\n')}`;
 const allSources=proposalSourceRows(schema);
 const sources=sliceProposalSourceRows(allSources,maxSourceChars);
 return {
  sources,
  text:[
   table('全イベント',['eventId','time','title','description','recordKind','sourceRefs','state','assignedEntities'],a.events.map(e=>[e.id,e.time,e.title,e.description,e.recordKind??'recorded',(e.sourceRefs??[]).map(r=>r.sourceId+'/'+r.paragraphId).join(','),state(e.id),assignedEntities(e.id)])),
   table('主体',['entityId','name','kind','parents','resolution'],a.entities.map(e=>[e.id,e.name,e.kind,(e.parentEntityIds?.length?e.parentEntityIds.join(','):e.parentEntityId)??'-',e.resolution??'confirmed'])),
   ...(a.subjectPoset?.relations?.length?[table('主体包含関係',['childId','parentId','axis'],a.subjectPoset.relations.map(r=>[r.childId,r.parentId,r.axis??'-']))]:[]),
   table('全割当',['eventId','entityId','role','inferred'],a.participations.map(p=>[p.eventId,p.entityId,p.role,isSubjectInferred(p)?'inferred':'-'])),
   table('全カード',['cardId','entityId','eventIds','visible'],a.cards.map(c=>[c.id,c.laneEntityId,c.eventIds.join(','),cardVisible(schema,c.id,c.laneEntityId)])),
   table('全関係',['id','kind','fromEvent','fromEntity','toEvent','toEntity','refs','resource','status','receipt','basis','reason'],a.relations.map(r=>[r.id,r.kind,r.sourceEventId,r.sourceEntityId,r.targetEventId,r.targetEntityId,(r.sourceRefs??[]).map(x=>x.sourceId+'/'+x.paragraphId).join(','),r.resource,r.status,r.receipt,r.evidenceBasis,r.explanation??r.adoptionReason])),
   table('帰結',['status','eventIds','reason'],[[a.outcome?.status,a.outcome?.eventIds.join(','),a.outcome?.reason]]),
   table('要確認と背景',['id','kind','refs','text','reason'],(a.dispositions??[]).map(d=>[d.id,d.kind,d.sourceRefs?.map(r=>r.sourceId+'/'+r.paragraphId).join(','),d.text??d.quote,d.reason])),
   table('接続',['id','fromCard','toCard','meaning','direction','BREAK'],schema.edges.map(e=>[e.id,e.source,e.target,e.meaning,e.direction,e.is_break])),
   table('表示・削除指定',['lanes','suppressedCards','omittedEdges','omittedDependencies'],[[JSON.stringify(schema.presentation?.lanes??{}),JSON.stringify(schema.presentation?.suppressedCards??{}),(schema.presentation?.omittedEdges??[]).join(','),(schema.presentation?.omittedDependencies??[]).join(';')]]),
   table('原文',['ref','eventIds','purpose','text'],sources.map(p=>[p.ref,p.eventIds.join(','),p.purpose,p.text])),
  ].join('\n'),
 };
}
