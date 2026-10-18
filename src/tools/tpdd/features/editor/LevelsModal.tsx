import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, Trash2, ArrowUp, ArrowDown, X, AlertTriangle } from 'lucide-react';
import { useApp } from '../../app/AppContext';

interface LevelsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const LevelsModal: React.FC<LevelsModalProps> = ({ isOpen, onClose }) => {
  const { state, dispatch } = useApp();
  const { levels } = state.history.present;

  const [newLevelName, setNewLevelName] = useState('');
  const [deletingLevelId, setDeletingLevelId] = useState<string | null>(null);
  const [targetLevelId, setTargetLevelId] = useState<string>('');

  // Escapeキーで閉じる
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const sortedLevels = [...levels].sort((a, b) => a.order - b.order);

  // 列追加
  const handleAdd = () => {
    if (!newLevelName.trim()) return;
    if (levels.length >= 12) {
      alert('抽象度列は最大12列までです');
      return;
    }
    dispatch({ type: 'ADD_LEVEL', label: newLevelName.trim() });
    setNewLevelName('');
  };

  // 順序入れ替え (上へ) - アトミック更新
  const handleMoveUp = (index: number) => {
    if (index === 0) return;
    const newLevels = [...sortedLevels];
    const temp = newLevels[index];
    newLevels[index] = newLevels[index - 1];
    newLevels[index - 1] = temp;
    const reordered = newLevels.map((l, idx) => ({ ...l, order: idx }));
    dispatch({ type: 'REORDER_LEVELS', levels: reordered });
  };

  // 順序入れ替え (下へ) - アトミック更新
  const handleMoveDown = (index: number) => {
    if (index === sortedLevels.length - 1) return;
    const newLevels = [...sortedLevels];
    const temp = newLevels[index];
    newLevels[index] = newLevels[index + 1];
    newLevels[index + 1] = temp;
    const reordered = newLevels.map((l, idx) => ({ ...l, order: idx }));
    dispatch({ type: 'REORDER_LEVELS', levels: reordered });
  };

  // 列削除開始
  const handleStartDelete = (levelId: string) => {
    if (levels.length <= 1) {
      alert('最低1つの抽象度列が必要です');
      return;
    }
    const otherLevels = levels.filter((l) => l.id !== levelId);
    setDeletingLevelId(levelId);
    setTargetLevelId(otherLevels[0]?.id || '');
  };

  // 列削除確定 (ノード移動先指定)
  const handleConfirmDelete = () => {
    if (!deletingLevelId || !targetLevelId) return;
    dispatch({
      type: 'REMOVE_LEVEL',
      levelIdToRemove: deletingLevelId,
      targetLevelId,
    });
    setDeletingLevelId(null);
  };

  const deletingLevel = levels.find((l) => l.id === deletingLevelId);

  return createPortal(
    <div
      className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-md overflow-hidden flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div className="px-5 py-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-slate-800">抽象度列の管理</h2>
            <p className="text-xs text-slate-500">列名や並び順の変更、列の追加・削除（1〜12列）</p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 p-1 rounded"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* コンテンツ */}
        <div className="p-5 overflow-y-auto space-y-4 flex-1">
          {/* 列一覧 */}
          <div className="space-y-2">
            {sortedLevels.map((lvl, idx) => (
              <div
                key={lvl.id}
                className="flex items-center gap-2 p-2 bg-slate-50 border border-slate-200 rounded-lg"
              >
                <span className="text-[11px] font-mono text-slate-400 w-5 text-center">
                  {idx + 1}
                </span>

                <input
                  type="text"
                  defaultValue={lvl.label}
                  onBlur={(e) => {
                    const val = e.target.value.trim();
                    if (val && val !== lvl.label) {
                      dispatch({
                        type: 'UPDATE_LEVEL',
                        levelId: lvl.id,
                        patch: { label: val },
                      });
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  className="flex-1 px-2 py-1 text-xs border border-slate-300 rounded bg-white"
                />

                {/* 順序変更ボタン */}
                <div className="flex items-center gap-0.5">
                  <button
                    disabled={idx === 0}
                    onClick={() => handleMoveUp(idx)}
                    className="p-1 text-slate-500 hover:text-slate-800 disabled:text-slate-300"
                    title="上へ移動"
                  >
                    <ArrowUp className="w-3.5 h-3.5" />
                  </button>
                  <button
                    disabled={idx === sortedLevels.length - 1}
                    onClick={() => handleMoveDown(idx)}
                    className="p-1 text-slate-500 hover:text-slate-800 disabled:text-slate-300"
                    title="下へ移動"
                  >
                    <ArrowDown className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* 削除ボタン */}
                <button
                  disabled={levels.length <= 1}
                  onClick={() => handleStartDelete(lvl.id)}
                  className="p-1 text-slate-400 hover:text-red-600 disabled:text-slate-200"
                  title="列を削除"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>

          {/* 新規列追加 */}
          {levels.length < 12 && (
            <div className="flex gap-2 pt-2 border-t border-slate-100">
              <input
                type="text"
                value={newLevelName}
                onChange={(e) => setNewLevelName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    handleAdd();
                  }
                }}
                placeholder="新規列名（例: 運用、施策など）"
                className="flex-1 px-2.5 py-1.5 text-xs border border-slate-300 rounded"
              />
              <button
                onClick={handleAdd}
                className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded text-xs font-medium flex items-center gap-1 shadow-sm"
              >
                <Plus className="w-3.5 h-3.5" />
                列を追加
              </button>
            </div>
          )}

          {/* 列削除時のノード移動先指定ダイアログ */}
          {deletingLevelId && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg space-y-2.5">
              <div className="flex items-center gap-1.5 text-red-700 text-xs font-bold">
                <AlertTriangle className="w-4 h-4" />
                <span>列「{deletingLevel?.label}」の削除確認</span>
              </div>
              <p className="text-[11px] text-red-600 leading-relaxed">
                この列に配置されているノードの移動先列を選択してください。
              </p>
              <select
                value={targetLevelId}
                onChange={(e) => setTargetLevelId(e.target.value)}
                className="w-full p-1.5 text-xs border border-red-300 rounded bg-white text-slate-800"
              >
                {levels
                  .filter((l) => l.id !== deletingLevelId)
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label} ({l.id})
                    </option>
                  ))}
              </select>
              <div className="flex justify-end gap-2 pt-1">
                <button
                  onClick={() => setDeletingLevelId(null)}
                  className="px-2.5 py-1 border border-slate-300 rounded text-[11px] text-slate-600 bg-white"
                >
                  キャンセル
                </button>
                <button
                  onClick={handleConfirmDelete}
                  className="px-2.5 py-1 bg-red-600 hover:bg-red-700 text-white rounded text-[11px] font-medium shadow-sm"
                >
                  ノードを移動して削除
                </button>
              </div>
            </div>
          )}
        </div>

        {/* フッター */}
        <div className="px-5 py-3 bg-slate-50 border-t border-slate-200 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 bg-slate-200 hover:bg-slate-300 rounded text-xs text-slate-700 font-medium"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
