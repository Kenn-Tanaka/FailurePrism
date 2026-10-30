import React,{useState} from 'react';
import type {VTASchema,VTAParticipation} from '../../types/vta';
import {assignUnassignedEvent,confirmProvisionalEntity} from '../../features/vta/utils/unassignedEvents';
export function UnassignedEventsPanel({schema,onChange,disabled=false}:{schema:VTASchema;onChange:(s:VTASchema)=>void;disabled?:boolean}){
 const [entities,setEntities]=useState<Record<string,string>>({}),[roles,setRoles]=useState<Record<string,VTAParticipation['role']>>({}),[names,setNames]=useState<Record<string,string>>({}),[error,setError]=useState('');
 const a=schema.analysis;if(!a)return null;
 const unassigned=a.events.filter(e=>!a.cards.some(c=>c.eventIds.includes(e.id))),provisional=a.entities.filter(e=>e.resolution==='unresolved');
 if(!unassigned.length&&!provisional.length)return null;
 const perform=(action:()=>VTASchema)=>{try{onChange(action());setError('');}catch(e){setError(String(e));}};
 const button='rounded border border-cyan-700 bg-cyan-950 px-2 py-1 text-cyan-200 disabled:opacity-40';
 return <section aria-label="未割当イベントの主体確認" className="space-y-2 rounded border border-amber-700 p-3 text-sm">
  <h3 className="font-semibold">主体の確認：未割当 {unassigned.length}件／仮レーン {provisional.length}件</h3>
  <p>実施主体と責任主体は別です。特定できなければ未割当のまま保持できます。仮レーンは実在主体の確定を意味しません。</p>
  {unassigned.map(e=><div key={e.id} className="space-y-2 border-t border-slate-700 pt-2">
   <strong>{e.id}：{e.title}</strong><p>{e.description}</p>
   <details><summary>原文を確認</summary>{e.sourceRefs?.map(r=><p key={r.sourceId+'/'+r.paragraphId}>{r.sourceId}/{r.paragraphId}：{a.sources.find(s=>s.id===r.sourceId)?.paragraphs.find(p=>p.id===r.paragraphId)?.text}</p>)}</details>
   <label>割当先<select aria-label={`${e.id}の割当先`} disabled={disabled} value={entities[e.id]??''} onChange={v=>setEntities({...entities,[e.id]:v.target.value})} className="m-1 max-w-full bg-slate-800 p-1"><option value="">主体を選択</option>{a.entities.map(s=><option key={s.id} value={s.id}>{s.name}{s.resolution?'（仮レーン）':''}</option>)}</select></label>
   <label>役割<select aria-label={`${e.id}の役割`} disabled={disabled} value={roles[e.id]??'actor'} onChange={v=>setRoles({...roles,[e.id]:v.target.value as VTAParticipation['role']})} className="m-1 bg-slate-800 p-1"><option value="actor">実施・動作主体</option><option value="affected">直接影響先</option><option value="target">対象となる主体</option></select></label>
   <div className="flex flex-wrap gap-2"><button type="button" disabled={disabled||!entities[e.id]} className={button} onClick={()=>perform(()=>assignUnassignedEvent(schema,e.id,entities[e.id],roles[e.id]??'actor'))}>選択した主体に割り当てる</button><button type="button" disabled={disabled} className={button} onClick={()=>perform(()=>assignUnassignedEvent(schema,e.id,undefined,roles[e.id]??'actor'))}>このイベントの仮レーンを作成</button></div>
  </div>)}
  {provisional.map(s=><div key={s.id} className="border-t border-slate-700 pt-2"><label>未特定の主体名<input disabled={disabled} aria-label={`${s.id}の主体名`} value={names[s.id]??s.name} onChange={e=>setNames({...names,[s.id]:e.target.value})} className="m-1 max-w-full bg-slate-800 p-1"/></label><button type="button" disabled={disabled} className={button} onClick={()=>perform(()=>confirmProvisionalEntity(schema,s.id,names[s.id]??s.name))}>この主体名で確定</button></div>)}
  {error&&<p role="alert">{error}</p>}
 </section>;
}
