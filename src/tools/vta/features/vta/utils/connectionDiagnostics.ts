import type { VTASchema } from '../../../types/vta';
import { visibleSchema } from './presentation';
export function connectionDiagnostics(schema:VTASchema){
 const issues:Array<{code:string;cardId?:string;relationId?:string;reason:string}>=[];
 const visible=new Set(visibleSchema(schema).nodes.map(n=>n.id));
 for(const node of schema.nodes){const visited=new Set<string>(),q=[node.id];while(q.length){const id=q.pop()!;if(visited.has(id))continue;visited.add(id);for(const e of schema.edges)if(e.source===id||e.target===id)q.push(e.source===id?e.target:e.source);}
  if(schema.lanes.length>1&&![...visited].some(id=>schema.nodes.find(n=>n.id===id)?.lane!==node.lane))issues.push({code:'no_cross_lane_bridge',cardId:node.id,reason:node.lane+'：'+node.title+'は他レーンの成分へ接続していません（生成時の詳細は履歴がなければ不明）'});
 }
 for(const r of schema.analysis?.relations??[]){if(r.kind==='before')continue;
  const from=schema.analysis!.cards.filter(c=>c.eventIds.includes(r.sourceEventId)&&(!r.sourceEntityId||c.laneEntityId===r.sourceEntityId)),to=schema.analysis!.cards.filter(c=>c.eventIds.includes(r.targetEventId)&&(!r.targetEntityId||c.laneEntityId===r.targetEntityId));
  let code='',reason='';
  if(from.length!==1||to.length!==1){code='ambiguous_endpoint';reason='端点カードを一意に特定できません';}
  else if(schema.presentation?.omittedEdges?.includes('relation:'+r.id)){code='user_deleted';reason='利用者の削除指定があります';}
  else if(!visible.has(from[0].id)||!visible.has(to[0].id)){code='display_filtered';reason='端点が非表示です';}
  else if(!schema.edges.some(e=>{
   const endpoints=e.source===from[0].id&&e.target===to[0].id||['common','mutual'].includes(r.kind)&&e.target===from[0].id&&e.source===to[0].id;
   const direction=r.kind==='dependency'?'unidirectional':!r.status||r.status==='omitted'||r.status==='unknown'||r.kind==='common'?'undirected':r.kind==='mutual'?'bidirectional':'unidirectional';
   return e.relationId===r.id&&endpoints&&e.meaning===r.kind&&e.direction===direction&&e.status===r.status&&e.receipt===r.receipt&&e.resource===r.resource;
  })){code='projection_missing';reason='採用済み関係の端点・意味・方向・実施／受領属性が描画へ反映されていません';}
  if(code)issues.push({code,relationId:r.id,reason});
 }return issues;
}
