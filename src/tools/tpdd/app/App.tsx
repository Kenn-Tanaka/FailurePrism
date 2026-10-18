import React, { useEffect } from 'react';
import { useApp } from './AppContext';
import { Toolbar } from '../features/editor/Toolbar';
import { DiagramTree } from '../features/editor/DiagramTree';
import { Canvas } from '../features/editor/Canvas';
import { RightSidebar } from '../features/editor/RightSidebar';
import { StatusBar } from '../features/editor/StatusBar';
import { RecoveryModal } from '../features/editor/RecoveryModal';
import { ToastNotification } from '../shared/ToastNotification';
import { findDescendantDiagramIds } from '../domain/commands';

export interface TPDDAppProps {
  isActive?: boolean;
}

export const AppContent: React.FC<TPDDAppProps> = ({ isActive = true }) => {
  const { state, dispatch } = useApp();

  // キーボードショートカット (Ctrl+Z, Ctrl+Y, Delete / Backspace)
  useEffect(() => {
    if (!isActive) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.isComposing) return;

      // モーダルオープン時または入力フォームフォーカス中は無視
      const isModalOpen = Boolean(document.querySelector('.fixed.inset-0.z-50'));
      if (
        isModalOpen ||
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement ||
        (e.target as HTMLElement)?.isContentEditable
      ) {
        return;
      }

      // Undo (Ctrl+Z)
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        dispatch({ type: 'UNDO' });
        return;
      }

      // Redo (Ctrl+Y or Ctrl+Shift+Z)
      if (
        ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') ||
        ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'z')
      ) {
        e.preventDefault();
        dispatch({ type: 'REDO' });
        return;
      }

      // Delete / Backspace: 選択中のノード（単一または複数）またはエッジを削除
      if ((e.key === 'Delete' || e.key === 'Backspace') && !e.ctrlKey && !e.metaKey && !e.altKey) {
        if (state.ui.selectedEdgeId) {
          e.preventDefault();
          dispatch({ type: 'REMOVE_EDGE', edgeId: state.ui.selectedEdgeId });
          return;
        }

        if (state.ui.selectedNodeIds.length > 0) {
          e.preventDefault();
          const currentDiagram = state.history.present.diagrams.find(
            (d) => d.id === state.ui.activeDiagramId
          );
          const selectedNodes = (currentDiagram?.nodes || []).filter((n) =>
            state.ui.selectedNodeIds.includes(n.id)
          );

          if (selectedNodes.length === 0) return;

          // 子図（詳細図）を持つノードをチェック
          const subDiagramNodes = selectedNodes.filter((n) => !!n.childDiagramId);
          if (subDiagramNodes.length > 0) {
            let totalSubCount = 0;
            for (const sn of subDiagramNodes) {
              const descendants = findDescendantDiagramIds(
                state.history.present,
                sn.childDiagramId!
              );
              totalSubCount += 1 + descendants.length;
            }
            if (
              !confirm(
                `選択された ${selectedNodes.length} 個のノードを削除しますか？\n紐づく詳細図 (${totalSubCount}件) もすべて削除されます！`
              )
            ) {
              return;
            }
          }

          dispatch({ type: 'REMOVE_SELECTED_ELEMENTS' });
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isActive, state, dispatch]);

  return (
    <div className="flex flex-col flex-1 h-full w-full min-h-0 overflow-hidden bg-slate-50 text-slate-900">
      {/* 上部ツールバー */}
      <Toolbar />

      {/* メイン領域 (左サイドバー + SVGキャンバス + 右サイドバー) */}
      <div className="flex flex-1 min-h-0 overflow-hidden relative">
        <DiagramTree />
        <Canvas isActive={isActive} />
        <RightSidebar />
      </div>

      {/* 下部ステータスバー */}
      <StatusBar />

      {/* 起動時自動復旧モーダル */}
      <RecoveryModal isActive={isActive} />

      {/* トースト通知 */}
      <ToastNotification />
    </div>
  );
};
