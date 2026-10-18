import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { FolderKanban, X, Save, Clock, Hash, Network, Layers } from 'lucide-react';
import { useApp } from '../../app/AppContext';
import { TPDD_LIMITS } from '../../domain/schema';

interface ProjectSettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const ProjectSettingsModal: React.FC<ProjectSettingsModalProps> = ({ isOpen, onClose }) => {
  const { state, dispatch } = useApp();
  const { present: project } = state.history;

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  useEffect(() => {
    if (isOpen) {
      setTitle(project.title);
      setDescription(project.description || '');
    }
  }, [isOpen, project.title, project.description]);

  // Escapeキーで閉じる
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const totalNodes = project.diagrams.reduce((sum, d) => sum + d.nodes.length, 0);
  const totalEdges = project.diagrams.reduce((sum, d) => sum + d.edges.length, 0);
  const trimmedTitle = title.trim();
  const isTitleOverLimit = trimmedTitle.length > TPDD_LIMITS.LABEL_MAX_LENGTH;
  const isDescOverLimit = description.length > TPDD_LIMITS.DESCRIPTION_MAX_LENGTH;

  const handleSave = () => {
    if (!trimmedTitle) {
      dispatch({
        type: 'SET_NOTIFICATION',
        notification: {
          id: `title-err-${Date.now()}`,
          type: 'error',
          message: 'プロジェクト名は空にできません。',
        },
      });
      return;
    }

    if (isTitleOverLimit) {
      dispatch({
        type: 'SET_NOTIFICATION',
        notification: {
          id: `title-len-err-${Date.now()}`,
          type: 'error',
          message: `プロジェクト名は${TPDD_LIMITS.LABEL_MAX_LENGTH}文字以内で入力してください（現在${trimmedTitle.length}文字）。`,
        },
      });
      return;
    }

    if (isDescOverLimit) {
      dispatch({
        type: 'SET_NOTIFICATION',
        notification: {
          id: `desc-len-err-${Date.now()}`,
          type: 'error',
          message: `プロジェクト詳細説明は${TPDD_LIMITS.DESCRIPTION_MAX_LENGTH.toLocaleString()}文字以内で入力してください（現在${description.length.toLocaleString()}文字）。`,
        },
      });
      return;
    }

    dispatch({
      type: 'UPDATE_PROJECT_META',
      patch: {
        title: trimmedTitle,
        description,
      },
    });

    dispatch({
      type: 'SET_NOTIFICATION',
      notification: {
        id: `meta-saved-${Date.now()}`,
        type: 'success',
        message: 'プロジェクト情報を更新しました。',
      },
    });

    onClose();
  };

  return createPortal(
    <div
      className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4 select-none"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-xl overflow-hidden flex flex-col max-h-[85vh] animate-in fade-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div className="px-5 py-4 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <FolderKanban className="w-5 h-5 text-blue-600" />
            <div>
              <h2 className="text-sm font-bold text-slate-800">プロジェクト情報設定</h2>
              <p className="text-[11px] text-slate-500">プロジェクト全体のタイトル・背景・説明文を管理します</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 p-1 rounded-lg hover:bg-slate-200 transition-colors"
            title="閉じる"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* フォーム本文 */}
        <div className="p-5 overflow-y-auto space-y-4 flex-1 select-text">
          {/* プロジェクト名 */}
          <div>
            <div className="flex justify-between items-center mb-1">
              <label className="text-xs font-bold text-slate-700 block">
                プロジェクト名 <span className="text-red-500">*</span>
              </label>
              <span
                className={`text-[10px] ${
                  isTitleOverLimit ? 'text-red-600 font-bold' : 'text-slate-400'
                }`}
              >
                {trimmedTitle.length} / {TPDD_LIMITS.LABEL_MAX_LENGTH}文字
              </span>
            </div>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="例: スマートオフィス環境制御システム"
              className={`w-full px-3 py-2 text-xs border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-medium text-slate-800 ${
                isTitleOverLimit ? 'border-red-500 bg-red-50/30' : 'border-slate-300'
              }`}
            />
            {isTitleOverLimit && (
              <p className="text-[10px] text-red-600 mt-1">
                プロジェクト名は{TPDD_LIMITS.LABEL_MAX_LENGTH}文字以内にしてください。
              </p>
            )}
          </div>

          {/* 説明文 */}
          <div>
            <div className="flex justify-between items-center mb-1">
              <label className="text-xs font-bold text-slate-700 block">
                プロジェクト詳細説明
              </label>
              <span
                className={`text-[10px] ${
                  isDescOverLimit
                    ? 'text-red-600 font-bold'
                    : description.length > 9500
                    ? 'text-amber-600 font-bold'
                    : 'text-slate-400'
                }`}
              >
                {description.length.toLocaleString()} / {TPDD_LIMITS.DESCRIPTION_MAX_LENGTH.toLocaleString()}文字
              </span>
            </div>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={6}
              placeholder="要求の背景、システムの目的、全体スコープ、前提条件、関係者メモなどを入力してください。"
              className={`w-full p-3 text-xs border rounded-lg resize-y focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 leading-relaxed text-slate-800 ${
                isDescOverLimit ? 'border-red-500 bg-red-50/30' : 'border-slate-300'
              }`}
            />
            {isDescOverLimit && (
              <p className="text-[10px] text-red-600 mt-1">
                プロジェクト詳細説明は{TPDD_LIMITS.DESCRIPTION_MAX_LENGTH.toLocaleString()}文字以内にしてください。
              </p>
            )}
          </div>

          {/* 統計情報 */}
          <div className="bg-slate-50 p-3.5 rounded-lg border border-slate-200 text-xs space-y-2">
            <span className="font-bold text-slate-600 block text-[11px] uppercase tracking-wider">
              プロジェクト統計
            </span>
            <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-600">
              <div className="flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-slate-400" />
                <span>作成: {new Date(project.createdAt).toLocaleDateString()}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-slate-400" />
                <span>更新: {new Date(project.updatedAt).toLocaleDateString()}</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-slate-400" />
                <span>図数: {project.diagrams.length} 件</span>
              </div>
              <div className="flex items-center gap-1.5">
                <Network className="w-3.5 h-3.5 text-slate-400" />
                <span>ノード: {totalNodes} 件 / エッジ: {totalEdges} 件</span>
              </div>
            </div>
          </div>
        </div>

        {/* フッター */}
        <div className="px-5 py-3.5 bg-slate-50 border-t border-slate-200 flex justify-between items-center text-xs">
          <span className="text-slate-400 text-[11px] flex items-center gap-1">
            <Hash className="w-3.5 h-3.5" />
            ID: {project.id}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="px-3.5 py-1.5 border border-slate-300 rounded-lg text-slate-600 hover:bg-slate-100 transition-colors"
            >
              キャンセル
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium shadow-sm transition-colors flex items-center gap-1.5"
            >
              <Save className="w-3.5 h-3.5" />
              保存する
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
