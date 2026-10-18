import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Clock, History, Trash2, X } from 'lucide-react';
import {
  AutoSaveSnapshot,
  getAllAutoSaveSnapshots,
  deleteAutoSaveSnapshot,
  clearAllAutoSaveSnapshots,
} from '../../services/persistence/indexedDb';
import { useApp } from '../../app/AppContext';

export const RecoveryModal: React.FC<{ isActive?: boolean }> = ({ isActive = true }) => {
  const { dispatch } = useApp();
  const [snapshots, setSnapshots] = useState<AutoSaveSnapshot[]>([]);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    // 起動時にIndexedDBのスナップショットを確認
    getAllAutoSaveSnapshots().then((data) => {
      // ノード総数が0件の空スナップショットは除外
      const meaningfulSnapshots = data.filter((s) => {
        const totalNodes = s.project.diagrams.reduce((sum, d) => sum + d.nodes.length, 0);
        return totalNodes > 0;
      });

      if (meaningfulSnapshots.length > 0) {
        setSnapshots(meaningfulSnapshots);
        setIsOpen(true);
      }
    });
  }, []);

  const handleDismiss = () => {
    setIsOpen(false);
  };

  useEffect(() => {
    if (!isOpen || !isActive) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) {
        handleDismiss();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isActive]);

  if (!isActive || !isOpen || snapshots.length === 0) return null;

  const handleRestore = async (snapshot: AutoSaveSnapshot) => {
    dispatch({ type: 'LOAD_PROJECT', project: snapshot.project });
    if (snapshot.validationErrors && snapshot.validationErrors.length > 0) {
      const detail = snapshot.validationErrors.map((e) => e.message).join(' / ');
      dispatch({
        type: 'SET_NOTIFICATION',
        notification: {
          id: `recover-warn-${Date.now()}`,
          type: 'warning',
          message: `自動保存データを救出復元しました。上限超過箇所を修正してから保存してください (${detail})`,
        },
      });
    }
    // 復元したスナップショットは消費済みとして削除
    await deleteAutoSaveSnapshot(snapshot.id);
    setIsOpen(false);
  };

  const handleDeleteSnapshot = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    await deleteAutoSaveSnapshot(id);
    const remaining = snapshots.filter((s) => s.id !== id);
    setSnapshots(remaining);
    if (remaining.length === 0) {
      setIsOpen(false);
    }
  };

  const handleClearAll = async () => {
    if (confirm('すべての自動復元候補を削除しますか？\n（この操作は取り消せません）')) {
      await clearAllAutoSaveSnapshots();
      setSnapshots([]);
      setIsOpen(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={handleDismiss}
    >
      <div
        className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-lg overflow-hidden flex flex-col max-h-[80vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div className="px-5 py-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <History className="w-5 h-5 text-blue-600" />
            <div>
              <h2 className="text-sm font-bold text-slate-800">未保存の自動復元候補が見つかりました</h2>
              <p className="text-xs text-slate-500">前回の作業内容を復元して再開できます</p>
            </div>
          </div>
          <button
            onClick={handleDismiss}
            className="text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-200 transition-colors"
            title="閉じる"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* 候補一覧 */}
        <div className="p-5 overflow-y-auto space-y-3 flex-1">
          {snapshots.map((snap) => {
            const totalNodes = snap.project.diagrams.reduce((sum, d) => sum + d.nodes.length, 0);
            const totalEdges = snap.project.diagrams.reduce((sum, d) => sum + d.edges.length, 0);

            return (
              <div
                key={snap.id}
                className="border border-slate-200 hover:border-blue-400 p-3.5 rounded-lg bg-slate-50/50 hover:bg-blue-50/30 transition-colors flex items-center justify-between"
              >
                <div className="space-y-1 flex-1 pr-3">
                  <div className="font-semibold text-slate-800 text-xs">{snap.projectTitle}</div>
                  <div className="text-[11px] text-slate-500 flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5" />
                    <span>{new Date(snap.savedAt).toLocaleString()}</span>
                  </div>
                  <div className="text-[10px] text-slate-400">
                    図: {snap.project.diagrams.length} 件 / ノード: {totalNodes} 件 / エッジ: {totalEdges} 件
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-shrink-0">
                  <button
                    onClick={(e) => handleDeleteSnapshot(snap.id, e)}
                    className="p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                    title="この候補を破棄"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleRestore(snap)}
                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-medium shadow-sm transition-colors"
                  >
                    復元する
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* フッター */}
        <div className="px-5 py-3 bg-slate-50 border-t border-slate-200 flex justify-between items-center text-xs">
          <button
            onClick={handleClearAll}
            className="text-red-500 hover:text-red-700 hover:underline text-[11px] flex items-center gap-1"
          >
            <Trash2 className="w-3.5 h-3.5" />
            すべての候補を破棄
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={handleDismiss}
              className="px-3 py-1.5 border border-slate-300 rounded text-slate-600 hover:bg-slate-100"
            >
              新規作成してスキップ
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
