import React,{useSyncExternalStore} from 'react';
import {debugRecorder} from '../../services/debugRecorder';
import {useVTAStore} from '../../features/vta/store/vtaStore';

export function DebugRecordingControls({compact=false}:{compact?:boolean}){
 const state=useSyncExternalStore(debugRecorder.subscribe,debugRecorder.getSnapshot,debugRecorder.getSnapshot);
 const save=()=>{
  const current=useVTAStore.getState();
  const text=debugRecorder.exportText({deduplicate:true,scenarioText:current.scenarioText,lastError:current.error??undefined});
  const url=URL.createObjectURL(new Blob([text],{type:'application/json;charset=utf-8'}));
  const link=document.createElement('a');link.href=url;link.download=`FailurePrism-debug-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 };
 const copyDiagnostics=()=>{
  const current=useVTAStore.getState();
  const md=debugRecorder.exportAIDiagnostics(current.scenarioText,current.error??undefined);
  navigator.clipboard.writeText(md);
  current.showToast('success','AI診断データをクリップボードにコピーしました（Claude/ChatGPT用）');
 };
 if(compact)return state.enabled?<button type="button" onClick={()=>debugRecorder.setEnabled(false)} className="text-xs rounded border border-rose-500 bg-rose-950 px-2 py-1 text-rose-200 shrink-0" title="クリックしてデバッグ記録を停止">● デバッグ記録中・停止</button>:null;
 return <div className="rounded-lg border border-slate-700 bg-slate-950 p-2 space-y-2 text-xs">
  <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" checked={state.enabled} onChange={e=>{
   debugRecorder.setEnabled(e.target.checked);
   if(e.target.checked){const current=useVTAStore.getState();debugRecorder.record('recording.start',()=>({projectId:current.currentProjectId,scenarioText:current.scenarioText,schema:current.vtaData}),undefined,[current.llmConfig.gatewayToken??'']);}
  }}/>デバッグログを記録する</label>
  <div role="status" className={state.enabled?'text-rose-300':'text-slate-400'}>{state.enabled?'● 記録中':'記録OFF'}・{state.count}件</div>
  <p className="text-[10px] text-slate-400">原文・送信プロンプト・LLM応答・検証結果・図の接続情報を記録します。記録はこの画面のメモリ内のみで、再読み込みすると消去されます。</p>
  {(state.dropped>0||state.truncated>0)&&<p className="text-amber-300">容量制限：古い記録の破棄 {state.dropped}件、長文の省略 {state.truncated}件</p>}
  <div className="flex flex-wrap gap-2">
   <button type="button" disabled={!state.count} onClick={save} className="rounded border border-cyan-700 bg-cyan-950 px-2 py-1 text-cyan-200 disabled:opacity-40" title="重複排除された軽量デバッグJSON（約85%削減）を保存">デバッグログを保存</button>
   <button type="button" disabled={!state.count} onClick={copyDiagnostics} className="rounded border border-emerald-700 bg-emerald-950 px-2 py-1 text-emerald-200 disabled:opacity-40" title="ClaudeやChatGPTに貼り付け可能な構造化AI診断サマリー（約3,000トークン）をコピー">📋 AI診断コピー</button>
   <button type="button" disabled={!state.count} onClick={()=>debugRecorder.clear()} className="rounded border border-slate-600 bg-slate-800 px-2 py-1 disabled:opacity-40">記録を消去</button>
  </div>
 </div>;
}
