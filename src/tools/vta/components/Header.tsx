import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { GitFork, HelpCircle, Shield, CheckCircle2, GripHorizontal, RotateCcw, X, FolderOpen, Save, Upload, Download, Undo2, Redo2 } from 'lucide-react';
import { useVTAStore } from '../features/vta/store/vtaStore';

export const Header: React.FC = () => {
  const [showGuide, setShowGuide] = useState(false);
  const [position, setPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const exportProjectJSON = useVTAStore((state) => state.exportProjectJSON);
  const importProjectJSON = useVTAStore((state) => state.importProjectJSON);
  const openSVGExportModal = useVTAStore((state) => state.openSVGExportModal);
  const isExtracting = useVTAStore((state) => state.isExtracting);
  const isRegenerating = useVTAStore((state) => state.isRegenerating);
  const generationProgress = useVTAStore((state) => state.generationProgress);
  const undo = useVTAStore((state) => state.undo);
  const redo = useVTAStore((state) => state.redo);
  const canUndo = useVTAStore((state) => state.past.length > 0);
  const canRedo = useVTAStore((state) => state.future.length > 0);
  const isDirty = useVTAStore((state) => state.isDirty);
  const showToast = useVTAStore((state) => state.showToast);

  const dragStartRef = useRef<{ startX: number; startY: number; initX: number; initY: number }>({
    startX: 0,
    startY: 0,
    initX: 0,
    initY: 0,
  });

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (isDirty) {
      const confirmDiscard = window.confirm(
        '現在のプロジェクトに変更が保存されていません。\n破棄して別のファイルを読み込みますか？\n（キャンセルして先に「プロジェクト保存」を行うことができます）'
      );
      if (!confirmDiscard) {
        e.target.value = '';
        return;
      }
    }

    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      if (content) {
        importProjectJSON(content);
      }
    };
    reader.onerror = () => {
      showToast('error', 'ファイルの読み込み中にエラーが発生しました。アクセス権限やファイル破損をご確認ください。');
    };
    reader.readAsText(file);

    // Reset input so same file can be selected again
    e.target.value = '';
  };

  // Reset position when guide is opened
  const handleOpenGuide = () => {
    setPosition({ x: 0, y: 0 });
    setShowGuide(true);
  };

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && showGuide) {
        setShowGuide(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [showGuide]);

  // Dragging logic
  const handleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      // Only drag if left mouse button is pressed on header (not on buttons)
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

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  const guideModal = showGuide && typeof document !== 'undefined'
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
              <span className="text-[11px] text-slate-500">
                [Esc] または枠外クリックで閉じられます
              </span>
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

  return (
    <header className="h-14 border-b border-slate-800 bg-slate-950/80 backdrop-blur px-5 flex items-center justify-between z-30 shrink-0 select-none">
      {/* Brand & Title */}
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-cyan-600 to-blue-500 flex items-center justify-center shadow-md shadow-cyan-500/20">
          <GitFork className="w-5 h-5 text-white" />
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="font-bold text-base text-slate-100 tracking-tight">
              Variation Tree Analysis Editor
            </h1>
            {isDirty && (
              <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-amber-950/90 text-amber-300 border border-amber-700/80 animate-pulse" title="未保存の変更があります (Ctrl+S で保存)">
                未保存
              </span>
            )}
          </div>
          <p className="text-[11px] text-slate-400">
            バリエーションツリー分析（ヒューマンファクタ分析）
          </p>
        </div>
      </div>

      {/* Central Processing Indicator */}
      {(isExtracting || isRegenerating || generationProgress.isActive) && (
        <div className="hidden md:flex items-center gap-2 px-3 py-1 bg-cyan-950/80 border border-cyan-500/50 rounded-full shadow-lg shadow-cyan-950/50 animate-pulse">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500"></span>
          </span>
          <span className="text-xs font-semibold text-cyan-200">
            {isExtracting
              ? `⚡ VTA構造抽出中... [Step ${generationProgress.stepCurrent || 2}/4]`
              : isRegenerating
              ? `✨ シナリオ再生成中... [Step ${generationProgress.stepCurrent || 2}/3]`
              : '⚡ AI推論処理中...'}
          </span>
        </div>
      )}

      {/* Actions & Help */}
      <div className="flex items-center gap-2">
        {/* Undo / Redo */}
        <div className="flex items-center gap-0.5 bg-slate-900 border border-slate-700/80 rounded-lg p-0.5">
          <button
            type="button"
            onClick={undo}
            disabled={!canUndo}
            className={`p-1.5 rounded-md text-xs font-medium transition-colors ${
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
            className={`p-1.5 rounded-md text-xs font-medium transition-colors ${
              canRedo
                ? 'text-slate-300 hover:text-white hover:bg-slate-800 cursor-pointer'
                : 'text-slate-600 cursor-not-allowed opacity-40'
            }`}
            title="やり直す (Ctrl+Y / Ctrl+Shift+Z)"
          >
            <Redo2 className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="w-px h-5 bg-slate-800 mx-0.5" />

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
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-slate-900 hover:bg-slate-800 border border-slate-700/80 rounded-lg transition-colors cursor-pointer"
          title="保存したVTAプロジェクトファイル（.json）を読み込む (Ctrl+O)"
        >
          <FolderOpen className="w-3.5 h-3.5 text-amber-400" />
          <span>プロジェクト読込</span>
        </button>

        <button
          type="button"
          onClick={() => exportProjectJSON()}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-200 hover:text-white bg-slate-900 hover:bg-slate-800 border border-slate-700/80 rounded-lg transition-colors cursor-pointer"
          title="現在の作業内容（シナリオ・VTA図・補足説明・分析レポート）を1つのJSONファイルとして保存 (Ctrl+S)"
        >
          <Save className="w-3.5 h-3.5 text-emerald-400" />
          <span>プロジェクト保存</span>
        </button>

        <button
          type="button"
          onClick={() => openSVGExportModal()}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-cyan-200 hover:text-white bg-cyan-950/80 hover:bg-cyan-900 border border-cyan-700/80 rounded-lg transition-colors cursor-pointer shadow-sm"
          title="VTAツリー図とノード補足説明を1枚のSVGベクター画像として出力・ダウンロード (Ctrl+E)"
        >
          <Download className="w-3.5 h-3.5 text-cyan-400" />
          <span>SVG出力 (図+補足)</span>
        </button>

        <div className="w-px h-5 bg-slate-800 mx-1" />

        <button
          type="button"
          onClick={handleOpenGuide}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-slate-900 hover:bg-slate-800 border border-slate-700/80 rounded-lg transition-colors cursor-pointer"
        >
          <HelpCircle className="w-3.5 h-3.5 text-cyan-400" />
          <span>VTA利用ガイド</span>
        </button>
      </div>

      {/* Portal Rendered Guide Modal */}
      {guideModal}
    </header>
  );
};
