import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import type { ConnectionRepairPlan } from '../utils/connectionRepairPlan';
import type { VTAEdgeData } from '../../../types/vta';

interface Props {
  plan: ConnectionRepairPlan;
  onApply: () => void;
  onClose: () => void;
}

const categories: Record<string, string> = {
  information: '情報・指示・連絡', material: '物・機材・現品', person: '人・移動',
  handover: '作業引継ぎ・交代', impact: '物理的影響・波及', sequential: '時系列・手順順序', other: 'その他・未分類',
};
const directions: Record<string, string> = { sequential: '時系列', unidirectional: '一方向', bidirectional: '双方向' };
const metadata = (edge: VTAEdgeData) => [
  edge.label ? `ラベル：${edge.label}` : '',
  edge.category ? `分類：${categories[edge.category] ?? edge.category}` : '',
  edge.is_break ? 'BREAKあり' : '',
  edge.direction ? `方向：${directions[edge.direction]}` : '',
].filter(Boolean).join(' ／ ');

export const ConnectionRepairModal: React.FC<Props> = ({ plan, onApply, onClose }) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      // Keep canvas shortcuts (delete/undo/save) from editing the graph behind the preview.
      event.stopPropagation();
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key === 'Tab') {
        const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)');
        if (!buttons?.length) return;
        const first = buttons[0];
        const last = buttons[buttons.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) {
          event.preventDefault(); first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKey, true);
    return () => { document.removeEventListener('keydown', handleKey, true); previous?.focus(); };
  }, [onClose]);
  const titleById = new Map(plan.schema.nodes.map((node) => [node.id, `${node.lane}：${node.title || node.id}`]));
  const describe = (edge: VTAEdgeData) => `${titleById.get(edge.source) ?? edge.source} → ${titleById.get(edge.target) ?? edge.target}`;
  const content = (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-slate-950/80 p-4" onClick={onClose}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="connection-repair-title"
        onClick={(event) => event.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl border border-slate-700 bg-slate-900 text-slate-200 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-700 p-4">
          <h2 id="connection-repair-title" className="font-semibold">接続を自動修正</h2>
          <button type="button" onClick={onClose} className="rounded px-3 py-1 hover:bg-slate-800">閉じる</button>
        </div>
        <div className="space-y-4 overflow-y-auto p-4 text-sm">
          <p>{plan.viewMode === 'compact' ? '見出しのみ表示' : '詳細表示'}の上下順に沿って、同じレーンの隣接ノードを下から上へ接続します。必要な場合は他方の表示の配置もそろえます。変更は1回の「元に戻す」で取り消せます。</p>
          {plan.issues.length > 0 ? (
            <div role="alert" className="rounded-lg border border-amber-700 bg-amber-950/40 p-3">
              <p className="mb-2 font-semibold">位置や接続を確認してから再実行してください。</p>
              <ul className="list-inside list-disc space-y-1">{plan.issues.map((issue, i) => <li key={i}>{issue}</li>)}</ul>
            </div>
          ) : !plan.changes.length && !plan.layoutChanges.length ? <p className="text-emerald-300">接続と両表示の配置は正常です。修正は不要です。</p> : null}
          {plan.layoutChanges.length > 0 && <div className="rounded-lg border border-cyan-800 bg-cyan-950/30 p-3">
            <p className="font-semibold">他方の表示のレーン内順序をそろえます</p>
            <ul className="mt-2 list-inside list-disc space-y-1">{plan.layoutChanges.map((item) => <li key={item.lane}>{item.lane}：{item.nodeIds.length}ノード（{item.nodeIds.map((id) => titleById.get(id) ?? id).join(' → ')}）</li>)}</ul>
          </div>}
          {plan.changes.length > 0 && <>
            <p className="font-semibold">追加 {plan.addedEdges}本 ／ 削除 {plan.removedEdges}本 ／ 方向修正 {plan.correctedDirections}本</p>
            {plan.changes.some((change) => change.kind === 'removed' && (change.edge.label || change.edge.category || change.edge.is_break)) && (
              <p className="text-amber-300">削除する線のラベル・分類・BREAKも削除されます。他の線には引き継ぎません。以下の対象を確認してください。</p>
            )}
            <ul className="space-y-2">
              {plan.changes.map((change, index) => <li key={index} className="rounded-lg border border-slate-700 bg-slate-950/50 p-3 break-words">
                <p className="font-semibold">{change.kind === 'added' ? '追加' : change.kind === 'removed' ? '削除' : '方向修正'}：{change.reason}</p>
                {change.previous && <p className="mt-1 text-slate-400">変更前：{describe(change.previous)}（{metadata(change.previous)}）</p>}
                <p className="mt-1">{describe(change.edge)}</p>
                {metadata(change.edge) && <p className="mt-1 text-xs text-slate-400">{metadata(change.edge)}</p>}
              </li>)}
            </ul>
          </>}
        </div>
        <div className="flex justify-end border-t border-slate-700 p-4">
          <button type="button" onClick={onApply} disabled={!!plan.issues.length || (!plan.changes.length && !plan.layoutChanges.length)}
            className="rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-white hover:bg-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed">修正を適用</button>
        </div>
      </div>
    </div>
  );
  return typeof document === 'undefined' ? content : createPortal(content, document.body);
};
