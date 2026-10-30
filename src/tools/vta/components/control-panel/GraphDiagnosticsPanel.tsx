import { connectionDiagnostics } from '../../features/vta/utils/connectionDiagnostics';
import React from 'react';
import type { VTASchema } from '../../types/vta';
import { graphDiagnostics } from '../../features/vta/utils/graphDiagnostics';
export function GraphDiagnosticsPanel({schema,onChange}:{schema:VTASchema;onChange:(s:VTASchema)=>void}) {
 const d=graphDiagnostics(schema),a=schema.analysis;
 if(!a)return null;
 return <section className="rounded border border-amber-700 p-2 space-y-2" aria-label="図全体の接続診断">
 <strong>{d.complete?'構造上の接続を確認しました（意味・根拠は別途確認）':'図全体に確認が必要です'}</strong>
 <p>全体 {d.canonical.length} 成分／表示 {d.display.length} 成分・未割当 {d.unassigned.length} 件・未投影関係 {d.missingRelations.length} 件</p>
 {d.unassigned.map(id=><p key={id}>{id}：{a.events.find(e=>e.id===id)?.title} — 主体未割当のためカード・接続端点がありません。</p>)}
 {!!d.provisional.length&&<p>主体未特定の仮レーン {d.provisional.length}件：{a.entities.filter(e=>d.provisional.includes(e.id)).map(e=>e.name).join('、')}</p>}
 {!!d.unshownOutcomes.length&&<p>帰結の図上未表示：{d.unshownOutcomes.join(', ')}（抽出済みでも図の完成ではありません）</p>}
 <div><strong>帰結の抽出確認</strong><p>{a.outcome?.status==='identified'?'帰結候補（原文と照合してください）':a.outcome?.status==='not_found'?'原文に損失の記録がないとの応答です':a.outcome?.status==='uncertain'?'帰結を特定できていません':'帰結の抽出確認がありません'}</p><p>{a.outcome?.reason}</p>
 {a.outcome?.eventIds.map(id=>{const event=a.events.find(e=>e.id===id);return <div key={id} className="border border-amber-800 p-1"><p>{id}：{event?.title}</p><p>{event?.description}</p><p>{a.cards.some(c=>c.eventIds.includes(id))?'割当済み':'主体未割当：イベントは保持されていますが図には表示されません'}</p></div>;})}
 </div>
 <label>分析対象の事象<select className="bg-slate-800 p-1 ml-2" value={a.context?.selectedTargetEventIds[0]??''} onChange={e=>onChange({...schema,analysis:{...a,context:{...a.context,selectedTargetEventIds:e.target.value?[e.target.value]:[]}}})}><option value="">未選択</option>{a.events.map(e=><option key={e.id} value={e.id}>{e.title}</option>)}</select></label>
 {d.canonical.length>1&&d.canonical.map((ids,i)=><p key={i}>成分 {i+1}：{ids.map(id=>schema.nodes.find(n=>n.id===id)).filter(Boolean).map(n=>n!.lane+'：'+n!.title).join(' ／ ')}</p>)}
 {connectionDiagnostics(schema).map((issue,i)=><p key={i}>{issue.code}：{issue.reason}</p>)}
 <p>不足を残したまま保存・編集できます。根拠のない線やレーンの除外で接続を補わないでください。</p>
 </section>;
}
