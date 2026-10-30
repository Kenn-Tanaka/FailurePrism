import type { VTASchema } from '../../../types/vta';
import { visibleSchema } from './presentation';
export function graphDiagnostics(schema:VTASchema) {
 const components=(s:VTASchema)=>{
  const adj=new Map(s.nodes.map(n=>[n.id,new Set<string>()]));
  for(const e of s.edges) if(adj.has(e.source)&&adj.has(e.target)){adj.get(e.source)!.add(e.target);adj.get(e.target)!.add(e.source);}
  const seen=new Set<string>(),groups:string[][]=[];
  for(const id of adj.keys())if(!seen.has(id)){const group:string[]=[],q=[id];while(q.length){const n=q.pop()!;if(seen.has(n))continue;seen.add(n);group.push(n);q.push(...adj.get(n)!);}groups.push(group);}
  return groups;
 };
 const effective=(s:VTASchema):VTASchema=>!schema.analysis?s:{...s,edges:s.edges.filter(e=>{
  const from=s.nodes.find(n=>n.id===e.source),to=s.nodes.find(n=>n.id===e.target);if(!from||!to)return false;
  if(from.lane===to.lane)return true;
  if(e.meaning==='association')return !!e.eventId&&!!from.event_ids?.includes(e.eventId)&&!!to.event_ids?.includes(e.eventId);
  return !!e.meaning&&['transfer','impact','dependency','mutual','common'].includes(e.meaning);
 })};
 const canonical=components(effective(schema)),display=components(effective(visibleSchema(schema)));
 const target=schema.analysis?.context?.selectedTargetEventIds??[];
 const missingRelations=schema.analysis?.relations.filter(r=>r.kind!=='before'&&!schema.edges.some(e=>e.relationId===r.id)&&!schema.presentation?.omittedEdges?.includes('relation:'+r.id)).map(r=>r.id)??[];
 const outcome=schema.analysis?.outcome; const outcomeUnchecked=outcome?.status!=='identified';
 const unassigned=schema.analysis?.unassignedEventIds??[];
 const provisional=schema.analysis?.entities.filter(e=>e.resolution==='unresolved').map(e=>e.id)??[];
 const unshownOutcomes=outcome?.eventIds.filter(id=>!visibleSchema(schema).nodes.some(n=>n.event_ids?.includes(id)))??[];
 return {canonical,display,outcomeUnchecked,targetUnset:!target.length,missingRelations,unassigned,provisional,unshownOutcomes,
  complete:!outcomeUnchecked&&!!schema.nodes.length&&canonical.length===1&&display.length===1&&!!target.length&&!missingRelations.length&&!unassigned.length&&!provisional.length&&!unshownOutcomes.length};
}
