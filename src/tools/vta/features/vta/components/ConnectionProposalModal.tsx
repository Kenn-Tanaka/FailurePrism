import { cardVisible } from '../utils/eventOrder';
import { ChainRepairModal } from './ChainRepairModal';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { proposeVTAConnections } from '../../../services/llm/client';
import { useVTAStore } from '../store/vtaStore';
import { connectionProposalSignature, validateSelectedConnectionProposals, type ConnectionProposal, type ConnectionProposalResult } from '../utils/connectionProposals';

export const ConnectionProposalModal: React.FC<{ onClose:()=>void }> = ({onClose}) => {
  const schema = useVTAStore((s)=>s.vtaData), config = useVTAStore((s)=>s.llmConfig);
  const currentProjectId=useVTAStore((s)=>s.currentProjectId);
  const busy = useVTAStore((s)=>s.isProposing), setBusy=useVTAStore((s)=>s.setIsProposing), createAbort=useVTAStore((s)=>s.createAbortController), cancel=useVTAStore((s)=>s.cancelCurrentOperation);
  const apply=useVTAStore((s)=>s.applyConnectionProposals), showToast=useVTAStore((s)=>s.showToast);
  const [result,setResult]=useState<ConnectionProposalResult|null>(null), [signature,setSignature]=useState(''), [projectId,setProjectId]=useState(''), [error,setError]=useState('');
  const visibleCards=useMemo(()=>schema.analysis?.cards.filter((c)=>cardVisible(schema,c.id,c.laneEntityId))??[],[schema]);
  const [customScope,setCustomScope]=useState(false),[scopeIds,setScopeIds]=useState<string[]>([]);
  const [showChain,setShowChain]=useState(false);
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const unassigned=schema.analysis?.events.filter(e=>!schema.analysis?.cards.some(c=>c.eventIds.includes(e.id)))??[];
  const selected=useMemo(()=>result?.proposals.filter((p)=>p.selected)??[],[result]);
  const validation=useMemo(()=>{
    if(!result)return [];
    const errors=validateSelectedConnectionProposals(schema,selected);
    if(result.invalidRows.some((row)=>row.startsWith('応答に[完了]がありません')||row.startsWith('応答に[接続提案]がありません'))) errors.unshift('応答全体が完了形式ではありません。途中の候補は適用できません。');
    return errors;
  },[result,schema,selected]);
  const stale=Boolean(signature && (signature!==connectionProposalSignature(schema) || projectId!==currentProjectId));
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    if (showChain || typeof document === 'undefined') return;
    if (!dialogRef.current?.contains(document.activeElement)) {
      dialogRef.current?.focus();
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      const s = useVTAStore.getState();
      if (s.generationProgress.isActive || s.isExtracting || s.isRegenerating || s.isProposing) return;
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab') {
        const items = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary,[href],[tabindex]:not([tabindex="-1"])'
        );
        if (!items?.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (
          e.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === dialogRef.current ||
            !dialogRef.current?.contains(document.activeElement))
        ) {
          e.preventDefault();
          last.focus();
        } else if (
          !e.shiftKey &&
          (document.activeElement === last ||
            document.activeElement === dialogRef.current ||
            !dialogRef.current?.contains(document.activeElement))
        ) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [showChain]);
  const generate=async()=>{
    if(busy)return;
    if(useVTAStore.getState().isExtracting||useVTAStore.getState().isRegenerating){showToast('warn','他のLLM処理が完了してから実行してください。');return;}
    const snapshot=useVTAStore.getState().vtaData, project=useVTAStore.getState().currentProjectId, captured=connectionProposalSignature(snapshot);
    const controller=createAbort(); setBusy(true); setError(''); setResult(null); setSignature(captured); setProjectId(project);
    try {
      const selectedScope=customScope?scopeIds:undefined;
      if(selectedScope && selectedScope.length<2) throw new Error('対象カードを2枚以上選択してください。');
      const response=await proposeVTAConnections(config,snapshot,controller.signal,selectedScope);
      const current=useVTAStore.getState();
      if(current.currentProjectId!==project || connectionProposalSignature(current.vtaData)!==captured) { setError('図またはプロジェクトが変更されたため、応答を破棄しました。');return; }
      setResult(response);
      if(response.invalidRows.length) setError(`一部の応答行を検証できませんでした（${response.invalidRows.length}件）。正常な候補だけを確認できます。`);
      else if(!response.proposals.length) setError(response.reviews.length?'接続候補はありません。要確認事項を確認してください。':'適用できる接続候補はありませんでした。');
    } catch(e) {
      const isCancelled = controller.signal.aborted || (e instanceof Error && (e.name === 'UserCancelledError' || e.message === 'USER_CANCELLED'));
      if (!isCancelled) setError(e instanceof Error?e.message:String(e));
    } finally {
      setBusy(false);
      useVTAStore.getState().resetGenerationProgress();
    }
  };
  const toggle=(id:string)=>setResult((old)=>old?({...old,proposals:old.proposals.map((p)=>p.id===id?{...p,selected:!p.selected}:p)}):old);
  const update=(id:string, patch:Partial<ConnectionProposal>)=>setResult((old)=>old?({...old,proposals:old.proposals.map((p)=>p.id===id?{...p,...patch,...(Object.keys(patch).some(k=>k!=='reason')?{evidenceBasis:'user' as const}:{})}:p)}):old);
  const toggleScope=(id:string)=>{setScopeIds((ids)=>ids.includes(id)?ids.filter((x)=>x!==id):[...ids,id]);setResult(null);setError('');};
  const toggleScopeMode=()=>{if(!customScope)setScopeIds(visibleCards.map((c)=>c.id));setCustomScope((value)=>!value);setResult(null);setError('');};
  const close=()=>{ if(busy)cancel(); onClose(); };
  const doApply=()=>{ if(!result||stale||validation.length)return; if(apply(projectId,signature,selected)){setResult(null);onClose();} };
  const sourceText=(refs:{sourceId:string;paragraphId:string}[])=>refs.map((r)=>{const source=schema.analysis?.sources.find((s)=>s.id===r.sourceId);const para=source?.paragraphs.find((p)=>p.id===r.paragraphId);return `${source?.id??r.sourceId}/${r.paragraphId}: ${para?.text??'原文なし'}`;}).join('\n');
  const cardLabel=(eventId:string,entityId:string)=>{const event=schema.analysis?.events.find((e)=>e.id===eventId),entity=schema.analysis?.entities.find((e)=>e.id===entityId);return `${entity?.name??entityId}：${event?.title??eventId}`;};
  const panel=(<div className="fixed inset-0 z-[10000] flex items-center justify-center bg-slate-950/80 p-4" onClick={(e)=>{if(e.target===e.currentTarget&&!busy)close();}}>
    <section ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="connection-proposal-title" onClick={(e)=>e.stopPropagation()} onKeyDown={(e)=>e.stopPropagation()} className="flex max-h-[88vh] w-full max-w-3xl flex-col rounded-xl border border-slate-700 bg-slate-900 text-slate-100 shadow-2xl focus:outline-none">
      <header className="flex items-center justify-between border-b border-slate-700 p-4"><h2 id="connection-proposal-title" className="font-semibold">レーン間接続をAIに提案</h2><button type="button" data-vta-focus-id="propose-connections-close" onClick={close}>閉じる</button></header>
      <div className="space-y-3 overflow-y-auto p-4 text-sm">
        <p>確定済みイベントと参照原文を確認し、不足するレーン間関係を提案します。候補は自動適用されません。</p>
        {!!unassigned.length&&<div role="status" className="rounded border border-amber-700 bg-amber-950/30 p-3"><p>未割当 {unassigned.length}件は接続専用提案の端点にできません。</p>{unassigned.map(e=><p key={e.id}>{e.id}：{e.title}（主体未割当・カードなし）</p>)}<button type="button" disabled={busy} onClick={()=>setShowChain(true)} className="mt-2 rounded border border-cyan-600 bg-cyan-800 px-3 py-2 disabled:opacity-40">主体・不足イベントも含めて点検</button></div>}
        {!unassigned.length&&<button type="button" disabled={busy} onClick={()=>setShowChain(true)} className="rounded border border-cyan-700 px-3 py-2">主体・不足イベントも含めて点検</button>}
        {!busy&&!result&&<div className="rounded border border-slate-700 p-3"><label className="flex items-center gap-2"><input type="checkbox" checked={customScope} onChange={toggleScopeMode}/>対象カードを選んで範囲を絞る（既定は全表示カード）</label>
          {customScope&&<div className="mt-2 grid max-h-40 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">{visibleCards.map((card)=><label key={card.id} className="flex items-center gap-2 text-xs"><input type="checkbox" checked={scopeIds.includes(card.id)} onChange={()=>toggleScope(card.id)}/>{cardLabel(card.eventIds[0],card.laneEntityId)}{card.eventIds.length>1?`ほか${card.eventIds.length-1}件`:''}</label>)}</div>}
          <p className="mt-1 text-xs text-slate-400">対象 {customScope?scopeIds.length:visibleCards.length} / 表示カード {visibleCards.length} 枚</p></div>}
        {!result && <button type="button" data-vta-focus-id="propose-connections-trigger" disabled={busy} onClick={()=>void generate()} className="rounded bg-cyan-700 px-4 py-2 disabled:opacity-50">{busy?'提案を生成中…':'提案を生成'}</button>}
        {busy&&<button onClick={cancel} className="ml-2 rounded border border-slate-600 px-3 py-2">キャンセル</button>}
        {result&&selected.length>0&&<section aria-label="選択候補の接続プレビュー" className="space-y-2 rounded border border-indigo-800 bg-indigo-950/20 p-3"><h3 className="font-semibold">選択候補の図上プレビュー（まだ未適用）</h3>{selected.map((p)=><div key={p.id} className="flex items-center gap-2 text-center text-xs">
          <div className="min-w-0 flex-1 rounded border border-slate-600 bg-slate-900 p-2"><strong>{schema.analysis?.entities.find(e=>e.id===p.sourceEntityId)?.name}</strong><div className="truncate">{schema.analysis?.events.find(e=>e.id===p.sourceEventId)?.title}</div></div>
          <div className="min-w-24 px-1 text-indigo-200">{p.kind==='dependency'?'作業依存 →':p.kind==='mutual'?'↔':p.kind==='common'||p.status!=='occurred'?'—':p.receipt==='unconfirmed'?'⇢':'→'}<div>{p.operation==='refine'?'既存線を具体化':'追加'}</div></div>
          <div className="min-w-0 flex-1 rounded border border-slate-600 bg-slate-900 p-2"><strong>{schema.analysis?.entities.find(e=>e.id===p.targetEntityId)?.name}</strong><div className="truncate">{schema.analysis?.events.find(e=>e.id===p.targetEventId)?.title}</div></div>
        </div>)}</section>}
        {error&&<p role="status" className="rounded border border-amber-700 bg-amber-950/40 p-3">{error}</p>}
        {stale&&<p role="alert" className="text-amber-300">図が変更されています。候補は適用できません。再提案してください。</p>}
        {!!validation.length&&<ul role="alert" className="list-inside list-disc rounded border border-rose-700 p-3 text-rose-300">{validation.map((e)=><li key={e}>{e}</li>)}</ul>}
        {result?.proposals.map((p)=><article key={p.id} className="rounded border border-slate-700 bg-slate-950/50 p-3">
          <label className="flex gap-2 font-semibold"><input type="checkbox" checked={p.selected} onChange={()=>toggle(p.id)}/>{p.operation==='refine'?'関係未判定の線を具体化':'接続を追加'}：{cardLabel(p.sourceEventId,p.sourceEntityId)} → {cardLabel(p.targetEventId,p.targetEntityId)}</label>
          <p className="mt-2">{p.kind} / {p.resource} / {p.status} / 受領 {p.receipt} / 根拠 {p.evidenceBasis==='source-context'?'文脈からの候補（原文明示ではありません）':p.evidenceBasis}</p><p className="mt-1">{p.reason}</p><details className="mt-2"><summary className="cursor-pointer">根拠原文</summary><pre className="mt-2 whitespace-pre-wrap text-xs text-slate-300">{sourceText(p.sourceRefs)}</pre></details>
          <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
            <label>関係<select value={p.kind} onChange={(e)=>update(p.id,{kind:e.target.value as ConnectionProposal['kind'],...(e.target.value==='dependency'?{resource:'-',status:'-',receipt:'na',operation:'add',targetLineId:'-'}:{resource:'information',status:'unknown',receipt:'na'})})} className="ml-2 rounded bg-slate-800 p-1"><option value="dependency">作業依存</option><option value="transfer">資源移動</option><option value="impact">影響</option><option value="mutual">相互確認</option><option value="common">共通影響</option></select></label>
            <label>リソース<input value={p.resource} onChange={(e)=>update(p.id,{resource:e.target.value})} className="ml-2 w-28 rounded bg-slate-800 p-1"/></label>
            <label>実施<select disabled={p.kind==='dependency'} value={p.status} onChange={(e)=>update(p.id,{status:e.target.value as ConnectionProposal['status']})} className="ml-2 rounded bg-slate-800 p-1"><option value="-">対象外</option><option value="occurred">実施済み</option><option value="omitted">未実施</option><option value="unknown">不明</option></select></label>
            <label>受領<select disabled={p.kind==='dependency'} value={p.receipt} onChange={(e)=>update(p.id,{receipt:e.target.value as ConnectionProposal['receipt']})} className="ml-2 rounded bg-slate-800 p-1"><option value="confirmed">確認済み</option><option value="unconfirmed">未確認</option><option value="na">該当なし</option></select></label>
          </div>
          <label className="mt-2 block text-xs">採用理由<input value={p.reason} onChange={(e)=>update(p.id,{reason:e.target.value})} className="mt-1 w-full rounded bg-slate-800 p-2"/></label>
        </article>)}
        {result?.reviews.map((r)=><article key={r.id} className="rounded border border-amber-800 p-3"><strong>要確認</strong><p>{r.reason}</p><pre className="mt-2 whitespace-pre-wrap text-xs">{sourceText(r.sourceRefs)}</pre></article>)}
        {result?.invalidRows.length ? <details><summary>検証できなかった行 {result.invalidRows.length}件</summary><pre className="mt-2 whitespace-pre-wrap text-xs">{result.invalidRows.join('\n')}</pre></details>:null}
      </div>
      <footer className="flex justify-end gap-2 border-t border-slate-700 p-4"><button onClick={close} className="rounded border border-slate-600 px-4 py-2">閉じる</button><button disabled={!selected.length||!!validation.length||stale||busy} onClick={doApply} className="rounded bg-cyan-700 px-4 py-2 disabled:opacity-40">選択した {selected.length}件を適用</button></footer>
    </section></div>);
  if(showChain)return <ChainRepairModal onClose={()=>setShowChain(false)}/>;
  return typeof document==='undefined'?panel:createPortal(panel,document.body);
};
