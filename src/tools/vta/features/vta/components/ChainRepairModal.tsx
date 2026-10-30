import { createPortal } from 'react-dom';
import React,{useState,useRef,useEffect} from 'react';
import { useVTAStore } from '../store/vtaStore';
import { connectionProposalSignature } from '../utils/connectionProposals';
import { applyChainDelta,selectChainDependencies,type ChainRow } from '../utils/chainRepair';
import { UnassignedEventsPanel } from '../../../components/control-panel/UnassignedEventsPanel';
import {debugRecorder} from '../../../services/debugRecorder';
import { graphDiagnostics } from '../utils/graphDiagnostics';
import { proposeChainRepair,type ChainRepairResult } from '../../../services/generation/chainRepairService';
export function ChainRepairModal({onClose}:{onClose:()=>void}){
 const store=useVTAStore(),[rows,setRows]=useState<ChainRow[]>([]),[selected,setSelected]=useState<string[]>([]),[busy,setBusy]=useState(false),[error,setError]=useState('');
 const [result,setResult]=useState<ChainRepairResult|null>(null),[progress,setProgress]=useState('');
 const captured=useRef({signature:connectionProposalSignature(store.vtaData),project:store.currentProjectId}),abort=useRef<AbortController|null>(null);
 const dialogRef=useRef<HTMLElement>(null),closeRef=useRef(onClose);closeRef.current=onClose;
 const close=()=>{abort.current?.abort();if(busy)useVTAStore.getState().cancelCurrentOperation();closeRef.current();};
 useEffect(()=>{
  const previous=document.activeElement instanceof HTMLElement?document.activeElement:null;
  dialogRef.current?.focus();
  const keydown=(event:KeyboardEvent)=>{
   const s=useVTAStore.getState();
   if(s.generationProgress.isActive||s.isExtracting||s.isRegenerating)return;
   event.stopPropagation();
   if(event.key==='Escape'){event.preventDefault();if(!s.isProposing)close();return;}
   if(event.key==='Tab'){
    const items=dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,[href]');
    if(!items?.length)return;const first=items[0],last=items[items.length-1];
    if(event.shiftKey&&(document.activeElement===first||document.activeElement===dialogRef.current||!dialogRef.current?.contains(document.activeElement))){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&(document.activeElement===last||document.activeElement===dialogRef.current||!dialogRef.current?.contains(document.activeElement))){event.preventDefault();first.focus();}
   }
  };
  document.addEventListener('keydown',keydown,true);
  return ()=>{abort.current?.abort();document.removeEventListener('keydown',keydown,true);if(previous?.isConnected)previous.focus();};
 },[]);
 const chosen=rows.filter(r=>selected.includes(r.section+'/'+r.id));let preview:ReturnType<typeof graphDiagnostics>|undefined,validation='';
 try{if(chosen.length)preview=graphDiagnostics(applyChainDelta(store.vtaData,chosen));}catch(e){validation=e instanceof Error?e.message:String(e);}
 const stale=captured.current.signature!==connectionProposalSignature(store.vtaData)||captured.current.project!==store.currentProjectId;
 const generate=async()=>{
  if(store.isProposing||store.isExtracting||store.isRegenerating)return;
  const snapshot=structuredClone(store.vtaData);
  captured.current={signature:connectionProposalSignature(snapshot),project:store.currentProjectId};
  abort.current=store.createAbortController();
  abort.current.signal.addEventListener('abort',()=>{setBusy(false);},{once:true});
  setBusy(true);store.setIsProposing(true);setError('');setRows([]);setSelected([]);setResult(null);setProgress('');
  store.setGenerationProgress({
   isActive:true,
   mode:'repair_chains',
   stage:'preparing',
   stepCurrent:1,
   stepTotal:3,
   title:'【1/3】孤立・分断要素の抽出',
   detail:'原文全文と現在の図から不足イベント・主体割当・関係を点検しています。',
   elapsedSeconds:0,
  });
  try{
   const response=await proposeChainRepair(store.llmConfig,snapshot,abort.current.signal,message=>{
    setProgress(message);
    const s=useVTAStore.getState();
    s.addLog('info',message,'連鎖点検');
    s.setGenerationProgress({
     isActive:true,
     mode:'repair_chains',
     stage:'calling_llm',
     stepCurrent:2,
     stepTotal:3,
     title:'【2/3】連鎖補完のAI推論',
     detail:message,
    });
   });
   const current=useVTAStore.getState();
   if(current.currentProjectId!==captured.current.project||connectionProposalSignature(current.vtaData)!==captured.current.signature)throw Error('図が変更されたため応答を破棄しました');
   current.setGenerationProgress({
    stage:'parsing',
    stepCurrent:3,
    title:'【3/3】修復プランの構築',
    detail:'提案候補の参照整合性を検証しています。',
   });
   setResult(response);setRows(response.rows);
   if(response.issues.length)setError('未修復 '+response.issues.length+' 件。正常な候補を保持しています。');
   else if(!response.rows.length)setError('根拠のある追加候補はありませんでした。');
  }catch(e){
   const isCancelled=abort.current?.signal.aborted||(e instanceof Error&&(e.name==='UserCancelledError'||e.message==='USER_CANCELLED'));
   if(!isCancelled)setError(e instanceof Error?e.message:String(e));
  }finally{
   setBusy(false);
   useVTAStore.getState().setIsProposing(false);
   useVTAStore.getState().resetGenerationProgress();
  }
 };
 const apply=()=>{const current=useVTAStore.getState();if(stale||validation||!chosen.length||!result?.complete)return;try{const schema=applyChainDelta(current.vtaData,chosen,true);debugRecorder.record('chain-repair.adoption',()=>({requestId:result?.requestId,chosen,schema}));current.commitVTAChange({schema,preserveDerivedRemovals:true});current.addLog('success','連鎖不足点検の差分 '+chosen.length+' 行を利用者確認後に適用しました','図面');onClose();}catch(e){setError(e instanceof Error?e.message:String(e));}};

 const actionClass='rounded-lg border px-4 py-2 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-400 disabled:opacity-40 disabled:cursor-not-allowed';
 const disabledReason=busy?'点検が終わるまで適用できません。閉じる操作で中断できます。':stale?'図が変更されています。もう一度点検してください。':!result?'先に「全文から点検する」を押してください。':!result.complete?'応答の完了形式を確認できないため適用できません。':!chosen.length?'採用する候補のチェックボックスを選んでください。':validation;
 const content=<div className="fixed inset-0 z-[11000] flex items-center justify-center bg-slate-950/90 p-3" onClick={e=>{if(e.target===e.currentTarget&&!busy)close();}}>
 <section ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="chain-repair-title" aria-describedby="chain-repair-description" className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-slate-600 bg-slate-900 text-slate-100 shadow-2xl" onClick={e=>e.stopPropagation()}>
 <header className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-700 px-5 py-4">
 <h2 id="chain-repair-title" className="text-lg font-semibold">連鎖不足をAIで点検</h2>
 <button type="button" onClick={close} className={actionClass+' border-slate-500 bg-slate-700 hover:bg-slate-600'}>{busy?'中断して閉じる':'閉じる'}</button></header>
 <div className="min-h-0 overflow-y-auto p-5 space-y-4">
 <p id="chain-repair-description" className="text-sm text-slate-300">原文全文から不足イベント・主体割当・関係を提案します。候補は自動適用しません。判断できない関係は要確認として残します。</p>
 <UnassignedEventsPanel schema={store.vtaData} disabled={busy||store.isExtracting||store.isRegenerating} onChange={schema=>{store.commitVTAChange({schema,preserveDerivedRemovals:true});setRows([]);setSelected([]);setResult(null);captured.current={signature:connectionProposalSignature(schema),project:store.currentProjectId};}}/>
 <button type="button" data-vta-focus-id="repair-chains-trigger" disabled={busy||store.isProposing||store.isExtracting||store.isRegenerating} onClick={generate} className={actionClass+' border-cyan-500 bg-cyan-700 text-white hover:bg-cyan-600'}>{busy?'点検中…':'全文から点検する'}</button>
 {busy&&<p role="status">{progress||'全文を点検しています（最大2パス・修復込み最大6照会）'}</p>}
 {(error||validation||stale)&&<p role="alert" className="rounded border border-amber-700 bg-amber-950/40 p-3 text-amber-200">{stale?'図が変わりました。再点検してください。':error||validation}</p>}
 {result&&<details className="rounded border border-slate-700 p-3"><summary className="cursor-pointer">候補の処理履歴（通信 {result.calls}/6）</summary><p>実行ID：{result.requestId}</p>{result.trace.map((t,i)=><p key={i}>{t.pass+1}パス／{t.stage}／{t.candidateId??'-'}／{t.status}：{t.reason}</p>)}{!result.complete&&<p>応答全体の完了形式を確認できません。採用はできません。</p>}</details>}
 {rows.map(r=><div key={r.section+'/'+r.id} className="rounded border border-slate-700 p-3"><label className="flex items-start gap-2"><input type="checkbox" className="mt-1 accent-cyan-500" checked={selected.includes(r.section+'/'+r.id)} onChange={e=>setSelected(old=>e.target.checked?[...old,r.section+'/'+r.id]:old.filter(k=>k!==r.section+'/'+r.id))}/> <span className="break-all">{r.section}：{r.cells.join(' ／ ')}</span></label><details><summary className="mt-2 cursor-pointer text-cyan-300">原文を照合</summary>{store.vtaData.analysis?.sources.map(s=><pre key={s.id} className="mt-2 whitespace-pre-wrap break-words text-xs">{s.paragraphs.map(p=>s.id+'/'+p.id+' '+p.text).join('\n')}</pre>)}</details></div>)}
 {preview&&<p>選択差分の適用後：全体 {preview.canonical.length} 成分／表示 {preview.display.length} 成分、未割当 {preview.unassigned.length} 件。未解決なら不足状態を維持します。</p>}
 {(()=>{const addedSubjects=chosen.filter(r=>r.section==='追加主体').length,currentSubjects=store.vtaData.analysis?.entities.length??store.vtaData.lanes.length,limit=store.vtaData.analysis?.subjectRanking?.maxSubjects??store.subjectLimit;return addedSubjects>0&&currentSubjects+addedSubjects>limit?<p className="rounded border border-cyan-700/70 bg-cyan-950/40 p-2 text-xs text-cyan-200">選択された追加主体（{addedSubjects}件）を含めると主体数が {currentSubjects+addedSubjects} 件となり、設定上限（{limit}件）を超えます（適用後にイベント・主体の確認画面から再統合できます）。</p>:null;})()}
 <p className="text-sm text-slate-400">関係には参照先イベントと主体割当の選択も必要です。関係のsource-contextは原文の文脈に基づく候補です。割当のinferredは「主体は推定」を表します。</p>
 {!!rows.length&&<button type="button" disabled={busy||!selected.length} className={actionClass+' border-cyan-600 bg-cyan-950'} onClick={()=>setSelected(selectChainDependencies(rows,selected))}>選択した関係に必要な候補も選択</button>}
 </div>
 <footer className="shrink-0 border-t border-slate-700 bg-slate-900 px-5 py-4 space-y-3">
 {disabledReason&&<p id="chain-repair-apply-help" role="status" className="text-sm text-slate-300">{disabledReason}</p>}
 <div className="flex flex-wrap justify-end gap-3"><button type="button" onClick={close} className={actionClass+' border-slate-500 bg-slate-800 hover:bg-slate-700'}>キャンセルして戻る</button>
 <button type="button" aria-describedby="chain-repair-apply-help" disabled={busy||stale||!!validation||!chosen.length||!result?.complete} onClick={apply} className={actionClass+' border-indigo-400 bg-indigo-600 text-white hover:bg-indigo-500'}>選択した差分を一括適用</button></div>
 </footer></section></div>;
 return typeof document==='undefined'?content:createPortal(content,document.body);
}
