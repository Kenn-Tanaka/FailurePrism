import React, { useEffect, useState } from 'react';
import { Header } from './components/Header';
import { ControlPanel } from './components/ControlPanel';
import { VTACanvas } from './features/vta/components/VTACanvas';
import { useVTAStore } from './features/vta/store/vtaStore';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastContainer } from './components/ToastContainer';
import { AlertTriangle } from 'lucide-react';

export interface VTAAppProps {
  isActive?: boolean;
}

export const App: React.FC<VTAAppProps> = ({ isActive = true }) => {
  const loadPromptConfig = useVTAStore((state) => state.loadPromptConfig);
  const isDirty = useVTAStore((state) => state.isDirty);
  const undo = useVTAStore((state) => state.undo);
  const redo = useVTAStore((state) => state.redo);
  const canUndo = useVTAStore((state) => state.canUndo);
  const canRedo = useVTAStore((state) => state.canRedo);
  const exportProjectJSON = useVTAStore((state) => state.exportProjectJSON);
  const openSVGExportModal = useVTAStore((state) => state.openSVGExportModal);

  // Draft autosave recovery (FUNC-001)
  const hasDraftBackup = useVTAStore((state) => state.hasDraftBackup);
  const draftBackupTimestamp = useVTAStore((state) => state.draftBackupTimestamp);
  const checkDraftBackup = useVTAStore((state) => state.checkDraftBackup);
  const restoreDraftBackup = useVTAStore((state) => state.restoreDraftBackup);
  const clearDraftBackup = useVTAStore((state) => state.clearDraftBackup);
  const [showDraftBanner, setShowDraftBanner] = useState(false);

  useEffect(() => {
    loadPromptConfig();
    if (checkDraftBackup()) {
      setShowDraftBanner(true);
    }
  }, [loadPromptConfig, checkDraftBackup]);

  useEffect(() => {
    if (!isActive) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      // 1. プロジェクト保存 (Ctrl+S / Cmd+S)
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        exportProjectJSON();
        return;
      }

      // 2. プロジェクト開く (Ctrl+O / Cmd+O)
      if ((e.ctrlKey || e.metaKey) && (e.key === 'o' || e.key === 'O')) {
        e.preventDefault();
        document.getElementById('vta-project-file-input')?.click();
        return;
      }

      // 3. テキスト入力中はネイティブ入力操作（Undo/Redo等）を優先
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }

      // 4. キャンバス操作ショートカット
      if (e.ctrlKey || e.metaKey) {
        if ((e.key === 'z' || e.key === 'Z') && !e.shiftKey) {
          e.preventDefault();
          if (canUndo()) {
            undo();
          }
        } else if (
          e.key === 'y' ||
          e.key === 'Y' ||
          ((e.key === 'z' || e.key === 'Z') && e.shiftKey)
        ) {
          e.preventDefault();
          if (canRedo()) {
            redo();
          }
        } else if (e.key === 'e' || e.key === 'E') {
          e.preventDefault();
          openSVGExportModal();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isActive, undo, redo, canUndo, canRedo, exportProjectJSON, openSVGExportModal]);

  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [isDirty]);
  return (
    <ErrorBoundary fallbackTitle="Variation Tree Analysis Editor 描画エラー">
      <div className="flex flex-col flex-1 h-full w-full min-h-0 overflow-hidden bg-slate-950 text-slate-100 font-sans select-none">
        {/* Top Header */}
        <Header />

        {/* Draft Autosave Recovery Banner (FUNC-001) */}
        {showDraftBanner && hasDraftBackup && (
          <div className="bg-amber-950/90 border-b border-amber-600/70 px-4 py-2 flex items-center justify-between text-xs text-amber-200 z-40 shrink-0 animate-in slide-in-from-top duration-200 shadow-md">
            <div className="flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
              <span>
                前回の未保存下書き（{draftBackupTimestamp ? new Date(draftBackupTimestamp).toLocaleTimeString() : '自動保存'}）が見つかりました。復元しますか？
              </span>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  restoreDraftBackup();
                  setShowDraftBanner(false);
                }}
                className="px-3 py-1 bg-amber-600 hover:bg-amber-500 text-white font-semibold rounded-md shadow transition-colors cursor-pointer text-xs"
              >
                下書きを復元
              </button>
              <button
                type="button"
                onClick={() => {
                  clearDraftBackup();
                  setShowDraftBanner(false);
                }}
                className="px-3 py-1 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-md transition-colors cursor-pointer text-xs"
              >
                破棄
              </button>
            </div>
          </div>
        )}

        {/* Main 2-Pane Split Area */}
        <main className="flex flex-1 w-full min-h-0 overflow-hidden">
          {/* Left Pane: Control Panel (Scenario, LLM Settings, Results) */}
          <ControlPanel />

          {/* Right Pane: VTA Canvas (React Flow Diagram & Swimlanes) */}
          <section className="flex-1 h-full relative overflow-hidden">
            <VTACanvas isActive={isActive} />
          </section>
        </main>

        {/* Floating Toast Notifications Container (UI-002) */}
        <ToastContainer />
      </div>
    </ErrorBoundary>
  );
};

export default App;
