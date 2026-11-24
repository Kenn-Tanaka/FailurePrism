import React, { useState, useEffect, useRef, useCallback, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import {
  GitFork,
  HelpCircle,
  Shield,
  CheckCircle2,
  GripHorizontal,
  RotateCcw,
  X,
  FolderOpen,
  Save,
  Download,
  Undo2,
  Redo2,
  FileText,
  Film,
  ChevronDown,
  PanelLeftClose,
  PanelLeftOpen,
  Sparkles,
  Bug,
  RefreshCw,
} from 'lucide-react';
import { useVTAStore } from '../features/vta/store/vtaStore';
import { runDeterministicUiTask, isUiActionBusy, importProjectJsonWithOverlay } from '../features/vta/utils/uiProgressRunner';
import { debugRecorder } from '../services/debugRecorder';
import { DebugRecordingControls } from './control-panel/DebugRecordingControls';
import { LLMConfigSection } from './control-panel/LLMConfigSection';

export const Header: React.FC = () => {
  const [showGuide, setShowGuide] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const exportMenuRef = useRef<HTMLDivElement>(null);

  const debugState = useSyncExternalStore(
    debugRecorder.subscribe,
    debugRecorder.getSnapshot,
    debugRecorder.getSnapshot
  );

  const exportProjectJSON = useVTAStore((state) => state.exportProjectJSON);
  const openSVGExportModal = useVTAStore((state) => state.openSVGExportModal);
  const openAnimationPlayer = useVTAStore((state) => state.openAnimationPlayer);
  const openNormalizationAuditExportModal = useVTAStore((state) => state.openNormalizationAuditExportModal);
  const isExtracting = useVTAStore((state) => state.isExtracting);
  const isRegenerating = useVTAStore((state) => state.isRegenerating);
  const isParsingFile = useVTAStore((state) => state.isParsingFile);
  const generationProgress = useVTAStore((state) => state.generationProgress);
  const uiTaskProgress = useVTAStore((state) => state.uiTaskProgress);
  const undo = useVTAStore((state) => state.undo);
  const redo = useVTAStore((state) => state.redo);
  const canUndo = useVTAStore((state) => state.past.length > 0);
  const canRedo = useVTAStore((state) => state.future.length > 0);
  const isDirty = useVTAStore((state) => state.isDirty);
  const isLeftPanelCollapsed = useVTAStore((state) => state.isLeftPanelCollapsed);
  const toggleLeftPanel = useVTAStore((state) => state.toggleLeftPanel);

  const dragStartRef = useRef<{ startX: number; startY: number; initX: number; initY: number }>({
    startX: 0,
    startY: 0,
    initX: 0,
    initY: 0,
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    void importProjectJsonWithOverlay(file);
  };

  const handleSaveProject = () => {
    void runDeterministicUiTask(
      {
        actionKey: 'project_save',
        level: 'inline',
        title: 'プロジェクトJSONを保存中...',
      },
      () => exportProjectJSON()
    );
  };

  const handleCopyAIDiagnostics = () => {
    const current = useVTAStore.getState();
    const md = debugRecorder.exportAIDiagnostics(current.scenarioText, current.error ?? undefined);
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(md);
    }
    current.showToast('success', 'AI診断データをクリップボードにコピーしました（Claude/ChatGPT用）');
    setShowExportMenu(false);
  };

  const handleSaveDebugJson = () => {
    const current = useVTAStore.getState();
    const text = debugRecorder.exportText({
      deduplicate: true,
      scenarioText: current.scenarioText,
      lastError: current.error ?? undefined,
    });
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `FailurePrism-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setShowExportMenu(false);
  };

  const handleOpenGuide = () => {
    setPosition({ x: 0, y: 0 });
    setShowGuide(true);
  };

  // Close menus/modals on Escape or outside click
  useEffect(() => {
    if (!showGuide && !showExportMenu) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (showGuide) setShowGuide(false);
        if (showExportMenu) setShowExportMenu(false);
      }
    };
    const handlePointerDown = (e: MouseEvent) => {
      if (showExportMenu && exportMenuRef.current && !exportMenuRef.current.contains(e.target as Node)) {
        setShowExportMenu(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handlePointerDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handlePointerDown);
    };
  }, [showGuide, showExportMenu]);

  // Dragging logic for guide modal
  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      if ((e.target as HTMLElement).closest('button')) return;

      setIsDragging(true);
      dragStartRef.current = {
        startX: e.clientX,
        startY: e.clientY,
        initX: position.x,
        initY: position.y,
      };
      e.preventDefault();
    },
    [position]
  );

  useEffect(() => {
    if (!isDragging) return;
    const handleMouseMove = (e: MouseEvent) => {
      const deltaX = e.clientX - dragStartRef.current.startX;
      const deltaY = e.clientY - dragStartRef.current.startY;
      setPosition({
        x: dragStartRef.current.initX + deltaX,
        y: dragStartRef.current.initY + deltaY,
      });
    };
    const handleMouseUp = () => setIsDragging(false);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  const guideModal =
    showGuide && typeof document !== 'undefined'
      ? createPortal(
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[9999] flex items-center justify-center p-4 overflow-hidden"
            onClick={(e) => {
              if (e.target === e.currentTarget) setShowGuide(false);
            }}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-labelledby="vta-guide-modal-title"
              style={{
                transform: `translate(${position.x}px, ${position.y}px)`,
                transition: isDragging ? 'none' : 'box-shadow 0.2s',
              }}
              className="bg-slate-900 border border-slate-700/90 rounded-2xl max-w-2xl w-full max-h-[85vh] shadow-2xl flex flex-col overflow-hidden select-text"
            >
              {/* Draggable Header */}
              <div
                onMouseDown={handleMouseDown}
                className={`flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/60 shrink-0 ${
                  isDragging ? 'cursor-grabbing' : 'cursor-grab'
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <div className="p-1.5 rounded-lg bg-cyan-950/80 border border-cyan-800 text-cyan-400">
                    <Shield className="w-4 h-4" />
                  </div>
                  <div>
                    <h3 id="vta-guide-modal-title" className="font-bold text-sm text-slate-100 flex items-center gap-2">
                      VTA（バリエーションツリー分析）の記法とルール
                    </h3>
                    <span className="text-[10px] text-slate-400 flex items-center gap-1">
                      <GripHorizontal className="w-3 h-3 text-slate-500" />
                      ここをドラッグして位置を移動できます
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-1">
                  {(position.x !== 0 || position.y !== 0) && (
                    <button
                      type="button"
                      onClick={() => setPosition({ x: 0, y: 0 })}
                      className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-slate-200 bg-slate-800 hover:bg-slate-700 px-2 py-1 rounded transition-colors"
                      title="位置を中央に戻す"
                    >
                      <RotateCcw className="w-3 h-3" />
                      <span>位置リセット</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setShowGuide(false)}
                    className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
                    title="閉じる (Esc)"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>

              {/* Scrollable Body */}
              <div className="p-6 overflow-y-auto space-y-3 text-xs text-slate-300 leading-relaxed max-h-[calc(85vh-130px)]">
                <div className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800/90 space-y-1.5 shadow-sm">
                  <div className="font-semibold text-cyan-300 flex items-center gap-2 text-xs">
                    <CheckCircle2 className="w-4 h-4 text-cyan-400 shrink-0" />
                    <span>1. 時間軸（下から上へ経過）</span>
                  </div>
                  <p className="text-slate-400 pl-6">
                    VTA図は時間が下から上に向かって進行します。最下層が発端事象、最上層が最終的な事故・不具合事象となります。
                  </p>
                </div>

                <div className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800/90 space-y-1.5 shadow-sm">
                  <div className="font-semibold text-cyan-300 flex items-center gap-2 text-xs">
                    <CheckCircle2 className="w-4 h-4 text-cyan-400 shrink-0" />
                    <span>2. スイムレーン（当事者別の縦列配置）</span>
                  </div>
                  <p className="text-slate-400 pl-6">
                    横軸には関与した部門・担当者・設備をレーンとして配置し、誰のどのような作業・事象であるかを明確にします。キャンバスをドラッグして左右のレーンへスクロール可能です。
                  </p>
                </div>

                <div className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800/90 space-y-1.5 shadow-sm">
                  <div className="font-semibold text-cyan-300 flex items-center gap-2 text-xs">
                    <CheckCircle2 className="w-4 h-4 text-cyan-400 shrink-0" />
                    <span>3. ノード表現（通常作業 vs 変動要因）</span>
                  </div>
                  <div className="text-slate-400 pl-6 space-y-1">
                    <div>
                      <span className="inline-block px-1.5 py-0.5 rounded bg-slate-800 text-slate-200 font-medium border border-slate-700 mr-1.5">
                        通常作業
                      </span>
                      細枠線のカード。規定通りの定常作業や確認行動。
                    </div>
                    <div>
                      <span className="inline-block px-1.5 py-0.5 rounded bg-amber-950 text-amber-300 font-medium border border-amber-500 mr-1.5">
                        変動要因
                      </span>
                      太枠線のカード。連絡漏れ、手順省略、誤認など、通常と異なる事象。
                    </div>
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800/90 space-y-1.5 shadow-sm">
                  <div className="font-semibold text-cyan-300 flex items-center gap-2 text-xs">
                    <CheckCircle2 className="w-4 h-4 text-cyan-400 shrink-0" />
                    <span>4. 対策ポイントの付与（排除ノード & ブレイク）</span>
                  </div>
                  <div className="text-slate-400 pl-6 space-y-2">
                    <div className="flex items-start gap-2">
                      <span className="w-5 h-5 rounded-full bg-emerald-500 text-white flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5">
                        ○
                      </span>
                      <div>
                        <span className="font-semibold text-emerald-400">排除ノード: </span>
                        ノードカードをクリックして右上に「○印」を付与します。その変動要因自体の発生を根本的に排除する対策です。
                      </div>
                    </div>
                    <div className="flex items-start gap-2">
                      <span className="px-1.5 py-0.5 rounded-full bg-rose-950 text-rose-300 border border-rose-500 text-[9px] font-bold shrink-0 mt-0.5">
                        BREAK
                      </span>
                      <div>
                        <span className="font-semibold text-rose-400">ブレイク: </span>
                        ノード間の矢印線をクリックして波線/赤色遮断を付与します。前段の変動要因が悪影響を後続へ及ぼすのを途中で遮断する対策です。
                      </div>
                    </div>
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-slate-950/80 border border-slate-800/90 space-y-1.5 shadow-sm">
                  <div className="font-semibold text-cyan-300 flex items-center gap-2 text-xs">
                    <CheckCircle2 className="w-4 h-4 text-cyan-400 shrink-0" />
                    <span>5. レーン間の情報伝達と方向性（一方向 vs 双方向）</span>
                  </div>
                  <div className="text-slate-400 pl-6 space-y-1.5">
                    <p>
                      異なるレーン（部門・当事者）間を結ぶ横の線は「情報伝達・コミュニケーション」を表します。
                    </p>
                    <div className="flex items-center gap-2 text-slate-300">
                      <span className="text-cyan-400 font-mono font-bold">──▶ (一方向):</span>
                      <span>指示、報告、連絡、通達などの片方向伝達（シアン色ライン）</span>
                    </div>
                    <div className="flex items-center gap-2 text-slate-300">
                      <span className="text-purple-400 font-mono font-bold">◀──▶ (双方向):</span>
                      <span>相互確認、打ち合わせ、協議、対面点呼などの双方向伝達（パープル色・両端矢印）</span>
                    </div>
                    <p className="text-[11px] text-slate-500">
                      ※線の中心にあるバッジをクリックすると、一方向と双方向を手動で切り替えることができます。
                    </p>
                  </div>
                </div>
              </div>

              {/* Sticky Footer */}
              <div className="px-6 py-3.5 border-t border-slate-800 bg-slate-950/60 flex items-center justify-between shrink-0">
                <span className="text-[11px] text-slate-500">[Esc] または枠外クリックで閉じられます</span>
                <button
                  type="button"
                  onClick={() => setShowGuide(false)}
                  className="px-4 py-2 text-xs font-semibold bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg transition-colors cursor-pointer shadow-md"
                >
                  理解しました
                </button>
              </div>
            </div>
          </div>,
          document.body
        )
      : null;

  const isAnyAiActive = isExtracting || isRegenerating || generationProgress.isActive;
  const isAnyBusy = isAnyAiActive || isParsingFile || Boolean(uiTaskProgress);
  const saveBusy = isUiActionBusy(uiTaskProgress, 'project_save');
  const importBusy = isUiActionBusy(uiTaskProgress, 'project_import');

  const centerStatusLabel = uiTaskProgress
    ? uiTaskProgress.title
    : isParsingFile
      ? '文書ファイルを解析中...'
      : isExtracting
        ? `⚡ VTA構造抽出中... [Step ${generationProgress.stepCurrent || 1}/${generationProgress.stepTotal || 3}]`
        : isRegenerating
          ? `✨ シナリオ再生成中... [Step ${generationProgress.stepCurrent || 2}/${generationProgress.stepTotal || 3}]`
          : '⚡ AI推論処理中...';

  return (
    <header className="h-12 border-b border-slate-800 bg-slate-950/90 backdrop-blur px-3 flex items-center justify-between gap-2 z-30 shrink-0 select-none">
      {/* Left: Panel Toggle, Brand & File / History */}
      <div className="flex items-center gap-1.5 min-w-0">
        <button
          type="button"
          onClick={toggleLeftPanel}
          data-vta-focus-id="toggle-left-panel"
          className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700/80 text-slate-300 hover:text-white transition-colors cursor-pointer shrink-0"
          title={isLeftPanelCollapsed ? '左ワークフローパネルを開く' : '左ワークフローパネルを折りたたむ'}
          aria-expanded={!isLeftPanelCollapsed}
        >
          {isLeftPanelCollapsed ? (
            <PanelLeftOpen className="w-4 h-4 text-cyan-400" />
          ) : (
            <PanelLeftClose className="w-4 h-4 text-slate-400" />
          )}
        </button>

        <div className="flex items-center gap-2 mr-1 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-tr from-cyan-600 to-blue-500 flex items-center justify-center shadow-md shadow-cyan-500/20 shrink-0">
            <GitFork className="w-4 h-4 text-white" />
          </div>
          <div className="flex items-center gap-1.5 min-w-0">
            <h1 className="font-bold text-sm text-slate-100 tracking-tight truncate">
              <span className="xl:hidden">VTA Editor</span>
              <span className="hidden xl:inline">Variation Tree Analysis Editor</span>
            </h1>
            {isDirty && (
              <span
                className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-950/90 text-amber-300 border border-amber-700/80 shrink-0"
                title="未保存の変更があります (Ctrl+S で保存)"
              >
                未保存
              </span>
            )}
          </div>
        </div>

        <div className="w-px h-5 bg-slate-800 mx-0.5 shrink-0" />

        {/* Hidden File Input for Import */}
        <input
          id="vta-project-file-input"
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          accept=".json,application/json"
          className="hidden"
        />

        <button
          type="button"
          disabled={importBusy || isAnyAiActive}
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-slate-900 hover:bg-slate-800 border border-slate-700/80 rounded-lg transition-colors cursor-pointer disabled:opacity-50 shrink-0"
          title="保存したVTAプロジェクトファイル（.json）を開く (Ctrl+O)"
        >
          {importBusy ? (
            <RefreshCw className="w-3.5 h-3.5 text-amber-400 animate-spin" />
          ) : (
            <FolderOpen className="w-3.5 h-3.5 text-amber-400" />
          )}
          <span>{importBusy ? '読込中...' : '開く'}</span>
        </button>

        <button
          type="button"
          disabled={saveBusy}
          onClick={handleSaveProject}
          className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:text-white bg-slate-900 hover:bg-slate-800 border border-slate-700/80 rounded-lg transition-colors cursor-pointer disabled:opacity-50 shrink-0"
          title="現在の作業内容（シナリオ・VTA図・補足説明・分析レポート）をJSON保存 (Ctrl+S)"
        >
          {saveBusy ? (
            <RefreshCw className="w-3.5 h-3.5 text-emerald-400 animate-spin" />
          ) : (
            <Save className="w-3.5 h-3.5 text-emerald-400" />
          )}
          <span>{saveBusy ? '保存中...' : '保存'}</span>
        </button>

        <div className="w-px h-5 bg-slate-800 mx-0.5 shrink-0" />

        {/* Single Canonical Undo / Redo */}
        <div className="flex items-center gap-0.5 bg-slate-900 border border-slate-700/80 rounded-lg p-0.5 shrink-0">
          <button
            type="button"
            onClick={undo}
            disabled={!canUndo}
            className={`p-1 rounded-md text-xs font-medium transition-colors ${
              canUndo
                ? 'text-slate-300 hover:text-white hover:bg-slate-800 cursor-pointer'
                : 'text-slate-600 cursor-not-allowed opacity-40'
            }`}
            title="元に戻す (Ctrl+Z)"
          >
            <Undo2 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={redo}
            disabled={!canRedo}
            className={`p-1 rounded-md text-xs font-medium transition-colors ${
              canRedo
                ? 'text-slate-300 hover:text-white hover:bg-slate-800 cursor-pointer'
                : 'text-slate-600 cursor-not-allowed opacity-40'
            }`}
            title="やり直す (Ctrl+Y / Ctrl+Shift+Z)"
          >
            <Redo2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Central Live Processing Indicator (Unified AI & Deterministic) */}
      {isAnyBusy && (
        <div className="hidden lg:flex items-center gap-2 px-3 py-1 bg-cyan-950/80 border border-cyan-500/50 rounded-full shadow-md max-w-[320px]">
          <RefreshCw className="w-3 h-3 text-cyan-400 animate-spin shrink-0" />
          <span className="text-[11px] font-semibold text-cyan-200 truncate">
            {centerStatusLabel}
          </span>
        </div>
      )}

      {/* Right: LLM Selector Pill, Replay, Export/Diagnostics Dropdown, Help */}
      <div className="flex items-center gap-1.5 shrink-0">
        <DebugRecordingControls compact />

        <LLMConfigSection variant="popover" />

        <button
          type="button"
          onClick={() => openAnimationPlayer()}
          className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-bold text-amber-200 hover:text-white bg-amber-950/80 hover:bg-amber-900 border border-amber-600/80 rounded-lg transition-colors cursor-pointer shadow-sm"
          title="VTAツリーの時系列因果推移およびAI生成プロセスを動的にリプレイ再生"
        >
          <Film className="w-3.5 h-3.5 text-amber-400" />
          <span>リプレイ</span>
        </button>

        {/* Export & Diagnostics Dropdown */}
        <div ref={exportMenuRef} className="relative">
          <button
            type="button"
            onClick={() => setShowExportMenu((prev) => !prev)}
            aria-expanded={showExportMenu}
            data-vta-focus-id="header-export-menu"
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-bold text-cyan-200 hover:text-white bg-cyan-950/80 hover:bg-cyan-900 border border-cyan-700/80 rounded-lg transition-colors cursor-pointer shadow-sm"
            title="SVG画像出力・監査レポート出力・AI診断エクスポート"
          >
            <Download className="w-3.5 h-3.5 text-cyan-400" />
            <span>出力・診断</span>
            <ChevronDown className="w-3 h-3 text-cyan-400" />
          </button>

          {showExportMenu && (
            <div className="absolute right-0 top-full mt-2 w-64 bg-slate-900/98 border border-slate-700 rounded-xl p-1.5 shadow-2xl z-50 text-xs text-slate-200 space-y-0.5">
              <button
                type="button"
                onClick={() => {
                  setShowExportMenu(false);
                  openSVGExportModal();
                }}
                className="w-full flex items-center justify-between px-2.5 py-2 rounded-lg hover:bg-slate-800 text-left cursor-pointer transition-colors"
              >
                <span className="flex items-center gap-2 font-medium">
                  <Download className="w-3.5 h-3.5 text-cyan-400" />
                  <span>SVG出力 (図+補足)...</span>
                </span>
                <span className="text-[10px] font-mono text-slate-500">Ctrl+E</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setShowExportMenu(false);
                  openNormalizationAuditExportModal();
                }}
                className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg hover:bg-slate-800 text-left cursor-pointer transition-colors font-medium"
              >
                <FileText className="w-3.5 h-3.5 text-cyan-400" />
                <span>正規化監査レポート出力...</span>
              </button>

              <div className="my-1 border-t border-slate-800" />

              <button
                type="button"
                onClick={handleCopyAIDiagnostics}
                className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg hover:bg-slate-800 text-left cursor-pointer transition-colors font-medium text-emerald-300"
              >
                <Sparkles className="w-3.5 h-3.5 text-amber-300" />
                <span>AI診断データをコピー</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  const next = !debugState.enabled;
                  debugRecorder.setEnabled(next);
                  if (next) {
                    const current = useVTAStore.getState();
                    debugRecorder.record(
                      'recording.start',
                      () => ({
                        projectId: current.currentProjectId,
                        scenarioText: current.scenarioText,
                        schema: current.vtaData,
                      }),
                      undefined,
                      [current.llmConfig.gatewayToken ?? '']
                    );
                  }
                }}
                className="w-full flex items-center justify-between px-2.5 py-2 rounded-lg hover:bg-slate-800 text-left cursor-pointer transition-colors"
              >
                <span className="flex items-center gap-2">
                  <Bug className={`w-3.5 h-3.5 ${debugState.enabled ? 'text-rose-400' : 'text-slate-400'}`} />
                  <span>デバッグ記録</span>
                </span>
                <span
                  className={`text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                    debugState.enabled
                      ? 'bg-rose-950 text-rose-300 border border-rose-700'
                      : 'bg-slate-800 text-slate-400'
                  }`}
                >
                  {debugState.enabled ? `ON (${debugState.count})` : 'OFF'}
                </span>
              </button>

              {debugState.count > 0 && (
                <button
                  type="button"
                  onClick={handleSaveDebugJson}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-slate-800 text-left cursor-pointer transition-colors text-[11px] text-cyan-300"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>デバッグログJSONを保存 ({debugState.count}件)</span>
                </button>
              )}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={handleOpenGuide}
          className="flex items-center gap-1 px-2 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-slate-900 hover:bg-slate-800 border border-slate-700/80 rounded-lg transition-colors cursor-pointer"
          title="VTA利用ガイドを開く"
        >
          <HelpCircle className="w-3.5 h-3.5 text-cyan-400" />
          <span className="hidden xl:inline">ガイド</span>
        </button>
      </div>

      {guideModal}
    </header>
  );
};
