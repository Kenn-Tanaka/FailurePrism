import type { VTAAnalysisData, VTAEventRelation, VTASchema } from '../../../types/vta';

export const CONNECTION_RULE_VERSION = 'adjacent-dependency-1';
export function isPrecedence(r: VTAEventRelation) {
  return r.sourceEventId !== r.targetEventId && (r.kind === 'before' || r.kind === 'dependency'
    || (r.kind === 'transfer' || r.kind === 'impact') && r.status === 'occurred');
}
/** Canonical order, including suppressed cards. New candidates never order themselves. */
export function eventOrder(analysis: VTAAnalysisData, relations = analysis.relations) {
  const parent = new Map(analysis.events.map(e => [e.id,e.id]));
  const root = (id:string):string => parent.get(id) && parent.get(id)!==id ? root(parent.get(id)!) : id;
  for(const card of analysis.cards) for(const id of card.eventIds.slice(1)) parent.set(root(id),root(card.eventIds[0]));
  const groups = new Map<string,string[]>();
  for(const e of analysis.events) { const k=root(e.id); groups.set(k,[...(groups.get(k)??[]),e.id]); }
  const arcs=new Map<string,Set<string>>(), bad=new Set<string>();
  for(const r of relations.filter(isPrecedence)) {
    const a=root(r.sourceEventId),b=root(r.targetEventId);
    if(a===b) { bad.add(a); continue; }
    const next=arcs.get(a)??new Set(); next.add(b); arcs.set(a,next);
  }
  const degree=new Map([...groups.keys()].map(k=>[k,0]));
  for(const next of arcs.values()) for(const k of next) degree.set(k,(degree.get(k)??0)+1);
  const order=(k:string)=>Math.min(...analysis.events.filter(e=>root(e.id)===k).map(e=>e.sourceOrder));
  const ready=[...groups.keys()].filter(k=>!degree.get(k)).sort((a,b)=>order(a)-order(b)||a.localeCompare(b));
  const sorted:string[]=[];
  while(ready.length) { const k=ready.shift()!; sorted.push(k); for(const n of arcs.get(k)??[]) {degree.set(n,degree.get(n)!-1); if(!degree.get(n)){ready.push(n);ready.sort((a,b)=>order(a)-order(b)||a.localeCompare(b));}} }
  for(const k of groups.keys()) if(!sorted.includes(k)) bad.add(k);
  return { groups, root, sorted, bad, arcs };
}
export function dependencyCandidates(analysis:VTAAnalysisData, relations=analysis.relations) {
  const order=eventOrder(analysis,relations), result:Array<{sourceEventId:string;sourceEntityId:string;targetEventId:string;targetEntityId:string}>=[];
  for(let i=0;i<analysis.entities.length;i++) for(let j=i+1;j<analysis.entities.length;j++) {
    const a=analysis.entities[i].id,b=analysis.entities[j].id;
    const contains=(group:string,entity:string)=>analysis.participations.some(p=>p.entityId===entity&&order.groups.get(group)?.includes(p.eventId));
    if([...order.bad].some(k=>contains(k,a)||contains(k,b))) continue;
    const sequence=order.sorted.filter(k=>contains(k,a)||contains(k,b));
    for(let n=1;n<sequence.length;n++) {
      const left=sequence[n-1],right=sequence[n];
      // A grouped occurrence has no unique event endpoint; require explicit review.
      if(order.bad.has(left)||order.bad.has(right)||order.groups.get(left)!.length!==1||order.groups.get(right)!.length!==1) continue;
      for(const [from,to] of [[a,b],[b,a]]) if(contains(left,from)&&contains(right,to)) result.push({sourceEventId:order.groups.get(left)![0],sourceEntityId:from,targetEventId:order.groups.get(right)![0],targetEntityId:to});
    }
  }
  return result;
}
export function dependencyKey(r:Pick<VTAEventRelation,'sourceEventId'|'sourceEntityId'|'targetEventId'|'targetEntityId'>) {
  return JSON.stringify([r.sourceEventId,r.sourceEntityId,r.targetEventId,r.targetEntityId,'dependency']);
}
export function dependencyProblem(analysis:VTAAnalysisData,r:VTAEventRelation,relations=analysis.relations):string|undefined {
  if(r.kind!=='dependency') return;
  const srcEnt=r.sourceEntityOrigin??r.sourceEntityId;
  const tgtEnt=r.targetEntityOrigin??r.targetEntityId;
  if(r.sourceEventId===r.targetEventId||!r.sourceEntityId||!r.targetEntityId||srcEnt===tgtEnt) return '作業依存は別イベント・別主体が必要です。';
  const order=eventOrder(analysis,relations);
  if(order.root(r.sourceEventId)===order.root(r.targetEventId))return '共有カード内の順序未確定イベントには依存を指定できません。';
  const pending=[r.targetEventId],seen=new Set<string>();
  while(pending.length){const id=pending.pop()!;if(id===r.sourceEventId)return '作業依存の前後関係が循環します。';if(seen.has(id))continue;seen.add(id);pending.push(...relations.filter(x=>isPrecedence(x)&&x.sourceEventId===id&&x!==r).map(x=>x.targetEventId));}
}
export function cardVisible(schema:VTASchema,id:string,entity:string) {
  const mode=schema.presentation?.lanes[entity];
  return mode!=='hide'&&(mode==='show'||!schema.presentation?.suppressedCards[id]);
}
