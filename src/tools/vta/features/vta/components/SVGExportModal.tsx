import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Download, X, Layers, CheckCircle2, AlertCircle, Sparkles, FileText, Check, Film, PlayCircle } from 'lucide-react';
import { useVTAStore } from '../store/vtaStore';
import type { AnimationMode } from '../utils/animationSequencer';

interface SVGExportModalProps {
  isActive?: boolean;
}

export const SVGExportModal: React.FC<SVGExportModalProps> = ({ isActive = true }) => {
  const { isSVGExportModalOpen, closeSVGExportModal, exportVTASVG, exportAnimatedVTASVG, vtaData } = useVTAStore();
  const compactView = useVTAStore((state) => state.compactView);

  const [includeEmptyLanes, setIncludeEmptyLanes] = useState<boolean>(false);
  const [includeNotes, setIncludeNotes] = useState<boolean>(true);
  const [includeHeader, setIncludeHeader] = useState<boolean>(true);
  const [compact, setCompact] = useState(compactView);
  const [isAnimated, setIsAnimated] = useState<boolean>(false);
  const [animationMode, setAnimationMode] = useState<AnimationMode>('causal_flow');
  const [customFilename, setCustomFilename] = useState<string>('');
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [exportSuccess, setExportSuccess] = useState<boolean>(false);
  const [exportError, setExportError] = useState<string | null>(null);

  // Initialize or reset default filename and state when modal opens
  useEffect(() => {
    if (isSVGExportModalOpen) {
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      setCustomFilename(`vta-diagram-${timestamp}.svg`);
      setIsExporting(false);
      setExportSuccess(false);
      setExportError(null);
      setCompact(compactView);
      setIsAnimated(false);
      setAnimationMode('causal_flow');
    }
  }, [isSVGExportModalOpen, compactView]);

  // Handle filename adjustment when toggling isAnimated
  const handleToggleAnimated = (checked: boolean) => {
    setIsAnimated(checked);
    setCustomFilename((prev) => {
      if (checked && prev.startsWith('vta-diagram-')) {
        return prev.replace('vta-diagram-', 'vta-animated-');
      } else if (!checked && prev.startsWith('vta-animated-')) {
        return prev.replace('vta-animated-', 'vta-diagram-');
      }
      return prev;
    });
  };

  // Close on Escape key
  useEffect(() => {
    if (!isSVGExportModalOpen || !isActive) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        closeSVGExportModal();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSVGExportModalOpen, isActive, closeSVGExportModal]);

  if (!isSVGExportModalOpen || !isActive || typeof document === 'undefined') return null;

  const rawLanes = vtaData.lanes && vtaData.lanes.length > 0
    ? vtaData.lanes
    : Array.from(new Set(vtaData.nodes.map((n) => n.lane || '主要部門')));

  // Compute node count per lane
  const laneStats = rawLanes.map((lane) => {
    const count = vtaData.nodes.filter((n) => (n.lane || '主要部門') === lane).length;
    return {
      name: lane,
      count,
      isEmpty: count === 0,
    };
  });

  const emptyLaneCount = laneStats.filter((l) => l.isEmpty).length;
  const activeLaneCount = laneStats.filter((l) => !l.isEmpty).length;
  const targetLaneCount = includeEmptyLanes ? rawLanes.length : (activeLaneCount > 0 ? activeLaneCount : rawLanes.length);

  const handleDownload = () => {
    setIsExporting(true);
    setExportError(null);
    try {
      if (isAnimated) {
        exportAnimatedVTASVG({
          filename: customFilename.trim() || undefined,
          includeEmptyLanes,
          includeNotes,
          includeHeader,
          compact,
          animationMode,
        });
      } else {
        exportVTASVG({
          filename: customFilename.trim() || undefined,
          includeEmptyLanes,
          includeNotes,
          includeHeader,
          compact,
        });
      }
      setExportSuccess(true);
      setTimeout(() => {
        closeSVGExportModal();
      }, 600);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setExportError(msg);
      setIsExporting(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[9999] flex items-center justify-center p-4 overflow-y-auto"
      onClick={(e) => {
        if (e.target === e.currentTarget) closeSVGExportModal();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="svg-export-modal-title"
        className="bg-slate-900 border border-slate-700/90 rounded-2xl max-w-xl w-full shadow-2xl overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-150 select-text"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-950/60">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-cyan-950/90 border border-cyan-800 text-cyan-400 shadow-inner">
              <Download className="w-5 h-5" />
            </div>
            <div>
              <h3 id="svg-export-modal-title" className="font-bold text-base text-slate-100 flex items-center gap-2">
                VTA図＆補足説明 SVG出力設定
              </h3>
              <p className="text-xs text-slate-400">
                バリエーションツリー分析（VTA）の単一ベクター画像（.svg）
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={closeSVGExportModal}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 space-y-5 text-sm text-slate-200">
          {/* Lane Status Overview */}
          <div className="bg-slate-950/70 border border-slate-800 rounded-xl p-3.5 space-y-2">
            <div className="flex items-center justify-between text-xs text-slate-300 font-semibold">
              <span className="flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-cyan-400" />
                検出されたスイムレーン一覧 ({rawLanes.length} レーン)
              </span>
              <span className="text-[11px] text-slate-400">
                {emptyLaneCount > 0 ? (
                  <span className="text-amber-400 font-medium">⚠️ 空レーン: {emptyLaneCount} 件</span>
                ) : (
                  <span className="text-emerald-400 font-medium">✓ 空レーンなし（全レーンにノードあり）</span>
                )}
              </span>
            </div>

            {/* Badges of Lanes */}
            <div className="flex flex-wrap gap-1.5 pt-1">
              {laneStats.map((l) => (
                <div
                  key={l.name}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs border transition-colors ${
                    l.isEmpty
                      ? includeEmptyLanes
                        ? 'bg-slate-800/80 border-dashed border-amber-600/70 text-amber-300'
                        : 'bg-slate-900/60 border-slate-800 text-slate-500 opacity-60 line-through'
                      : 'bg-slate-800/90 border-slate-700 text-slate-200'
                  }`}
                >
                  <span className="font-medium">{l.name}</span>
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                      l.isEmpty
                        ? 'bg-amber-950/80 text-amber-400 border border-amber-800/60'
                        : 'bg-cyan-950 text-cyan-300 border border-cyan-800/60'
                    }`}
                  >
                    {l.count} ノード
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Setting 1: Empty Lane Exclusion */}
          <div className="space-y-2.5">
            <label className="block text-xs font-bold text-slate-300 tracking-wide uppercase">
              1. 空のレーンの出力設定
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {/* Option: Exclude empty lanes (Default) */}
              <label
                className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
                  !includeEmptyLanes
                    ? 'bg-cyan-950/50 border-cyan-500/80 shadow-md shadow-cyan-950/40 text-cyan-100 ring-1 ring-cyan-500/40'
                    : 'bg-slate-950/40 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-300'
                }`}
              >
                <input
                  type="radio"
                  name="includeEmptyLanes"
                  checked={!includeEmptyLanes}
                  onChange={() => setIncludeEmptyLanes(false)}
                  className="mt-0.5 text-cyan-500 focus:ring-cyan-500"
                />
                <div className="space-y-1">
                  <div className="text-xs font-bold flex items-center gap-1.5">
                    <span>空レーンを除外する</span>
                    <span className="text-[10px] px-1.5 py-0.2 rounded bg-cyan-900/80 text-cyan-300 font-normal">
                      推奨
                    </span>
                  </div>
                  <p className="text-[11px] leading-relaxed opacity-85">
                    ノードが0件の空レーンを省略し、図をコンパクトに整列して出力します。
                  </p>
                </div>
              </label>

              {/* Option: Include empty lanes */}
              <label
                className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
                  includeEmptyLanes
                    ? 'bg-cyan-950/50 border-cyan-500/80 shadow-md shadow-cyan-950/40 text-cyan-100 ring-1 ring-cyan-500/40'
                    : 'bg-slate-950/40 border-slate-800 text-slate-400 hover:border-slate-700 hover:text-slate-300'
                }`}
              >
                <input
                  type="radio"
                  name="includeEmptyLanes"
                  checked={includeEmptyLanes}
                  onChange={() => setIncludeEmptyLanes(true)}
                  className="mt-0.5 text-cyan-500 focus:ring-cyan-500"
                />
                <div className="space-y-1">
                  <div className="text-xs font-bold">
                    <span>空レーンも含めて出力する</span>
                  </div>
                  <p className="text-[11px] leading-relaxed opacity-85">
                    ノードが配置されていないレーンも空白列として残して出力します。
                  </p>
                </div>
              </label>
            </div>
          </div>

          {/* Setting 2: Supplementary Notes Panel */}
          <div className="space-y-2.5">
            <label className="block text-xs font-bold text-slate-300 tracking-wide uppercase">
              2. 表示形式・補足説明パネル・上部見出し
            </label>
            <label className="flex items-start gap-3 p-3 rounded-xl bg-slate-950/40 border border-slate-800 hover:border-slate-700 text-slate-200 cursor-pointer transition-colors">
              <input type="checkbox" checked={includeHeader} onChange={(e) => setIncludeHeader(e.target.checked)} className="mt-0.5 w-4 h-4 cursor-pointer" />
              <span className="text-xs">上部見出し（タイトル・出力日時・件数）を含めて出力する</span>
            </label>
            <label className="flex items-start gap-3 p-3 rounded-xl bg-slate-950/40 border border-slate-800 text-slate-200 cursor-pointer">
              <input type="checkbox" checked={compact} onChange={(e) => setCompact(e.target.checked)} className="mt-0.5" />
              <span className="text-xs">見出しだけの高さに詰めて出力する{includeNotes ? '（本文は右側補足欄に表示）' : ''}</span>
            </label>
            <label className="flex items-start gap-3 p-3 rounded-xl bg-slate-950/40 border border-slate-800 hover:border-slate-700 text-slate-200 cursor-pointer transition-colors">
              <input
                type="checkbox"
                checked={includeNotes}
                onChange={(e) => setIncludeNotes(e.target.checked)}
                className="mt-0.5 w-4 h-4 rounded text-cyan-500 focus:ring-cyan-500 border-slate-700 bg-slate-900 cursor-pointer"
              />
              <div className="space-y-1">
                <div className="text-xs font-semibold text-slate-100 flex items-center gap-2">
                  <FileText className="w-3.5 h-3.5 text-cyan-400" />
                  <span>ノード内容・補足説明パネル（右側）を含めて出力する</span>
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  ノードの内容、背後要因・環境要因・メモ、全体総括を図の右側に配置します。OFFにするとVTA図のみを出力します。
                </p>
              </div>
            </label>
            {!includeNotes && (
              <p className="text-[11px] text-amber-300">右側補足欄を含めない場合、ノードの内容と補足説明はSVGに出力されません。</p>
            )}
          </div>

          {/* Setting 3: Animation / Replay Option */}
          <div className="space-y-2.5">
            <label className="block text-xs font-bold text-slate-300 tracking-wide uppercase flex items-center justify-between">
              <span className="flex items-center gap-1.5">
                <Film className="w-3.5 h-3.5 text-amber-400" />
                3. 動的アニメーション（Animated SVG）出力
              </span>
              <span className="text-[10px] text-amber-400/90 font-mono">CSS @keyframes</span>
            </label>
            <label
              className={`flex items-start gap-3 p-3 rounded-xl border cursor-pointer transition-all ${
                isAnimated
                  ? 'bg-amber-950/40 border-amber-500/80 shadow-md shadow-amber-950/30 text-amber-100 ring-1 ring-amber-500/40'
                  : 'bg-slate-950/40 border-slate-800 hover:border-slate-700 text-slate-300'
              }`}
            >
              <input
                type="checkbox"
                checked={isAnimated}
                onChange={(e) => handleToggleAnimated(e.target.checked)}
                className="mt-0.5 w-4 h-4 rounded text-amber-500 focus:ring-amber-500 border-slate-700 bg-slate-900 cursor-pointer"
              />
              <div className="space-y-1">
                <div className="text-xs font-semibold text-slate-100 flex items-center gap-2">
                  <span>アニメーション付きSVGとして出力する（自律ループ再生）</span>
                  <span className="text-[10px] px-1.5 py-0.2 rounded bg-amber-900/70 text-amber-300 font-normal">
                    PowerPoint / ブラウザ対応
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 leading-relaxed">
                  JavaScriptを使用せず、SVG内部の純粋なCSSアニメーション（@keyframes）で動作します。ブラウザやスライド資料への貼り付けでそのまま動的再生されます。
                </p>
              </div>
            </label>

            {/* Animation Mode Selection (visible when isAnimated is true) */}
            {isAnimated && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pl-6 animate-in fade-in duration-200">
                <label
                  className={`flex items-start gap-2.5 p-3 rounded-xl border cursor-pointer transition-all ${
                    animationMode === 'causal_flow'
                      ? 'bg-cyan-950/50 border-cyan-500/80 text-cyan-100 ring-1 ring-cyan-500/40'
                      : 'bg-slate-950/40 border-slate-800 text-slate-400 hover:border-slate-700'
                  }`}
                >
                  <input
                    type="radio"
                    name="modalAnimationMode"
                    value="causal_flow"
                    checked={animationMode === 'causal_flow'}
                    onChange={() => setAnimationMode('causal_flow')}
                    className="mt-0.5 text-cyan-500 focus:ring-cyan-500"
                  />
                  <div className="space-y-1">
                    <div className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                      <PlayCircle className="w-3.5 h-3.5 text-cyan-400" />
                      <span>① 事故因果リプレイ</span>
                    </div>
                    <p className="text-[11px] text-slate-400 leading-relaxed">
                      事故の物理的時間と因果関係に沿ってノードとエッジが段階的に出現・パルス発光します（報告・プレゼン用）。
                    </p>
                  </div>
                </label>

                <label
                  className={`flex items-start gap-2.5 p-3 rounded-xl border cursor-pointer transition-all ${
                    animationMode === 'pipeline_evolution'
                      ? 'bg-indigo-950/50 border-indigo-500/80 text-indigo-100 ring-1 ring-indigo-500/40'
                      : 'bg-slate-950/40 border-slate-800 text-slate-400 hover:border-slate-700'
                  }`}
                >
                  <input
                    type="radio"
                    name="modalAnimationMode"
                    value="pipeline_evolution"
                    checked={animationMode === 'pipeline_evolution'}
                    onChange={() => setAnimationMode('pipeline_evolution')}
                    className="mt-0.5 text-indigo-500 focus:ring-indigo-500"
                  />
                  <div className="space-y-1">
                    <div className="text-xs font-bold text-slate-200 flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
                      <span>② AIパイプライン進化リプレイ</span>
                    </div>
                    <p className="text-[11px] text-slate-400 leading-relaxed">
                      全文正規化 → 反復最適化 → 自動接続 → 変動要因判定のAI推論ステージ推移を可視化します（推論過程の検証用）。
                    </p>
                  </div>
                </label>
              </div>
            )}
          </div>

          {/* Setting 4: Custom Filename */}
          <div className="space-y-1.5">
            <label className="block text-xs font-bold text-slate-300 tracking-wide uppercase">
              4. 出力ファイル名 (.svg)
            </label>
            <input
              type="text"
              value={customFilename}
              onChange={(e) => setCustomFilename(e.target.value)}
              placeholder="vta-diagram.svg"
              className="w-full px-3 py-2 bg-slate-950 border border-slate-800 rounded-lg text-xs text-slate-200 font-mono focus:outline-none focus:ring-1 focus:ring-cyan-500 focus:border-cyan-500"
            />
          </div>

          {/* Export Summary Banner */}
          <div className="flex items-center justify-between px-3.5 py-2.5 bg-slate-950/80 border border-slate-800/80 rounded-lg text-xs text-slate-400">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
              <span>出力レーン: <strong className="text-cyan-300">{targetLaneCount}</strong> / {rawLanes.length}</span>
              <span>ノード: <strong className="text-slate-200">{vtaData.nodes.length}</strong> 件</span>
              <span>右側補足欄: <strong className={includeNotes ? 'text-emerald-400' : 'text-slate-500'}>{includeNotes ? 'あり' : 'なし'}</strong></span>
              <span>形式: <strong className={isAnimated ? 'text-amber-400' : 'text-cyan-300'}>{isAnimated ? (animationMode === 'causal_flow' ? 'Animated SVG (因果リプレイ)' : 'Animated SVG (AI進化)') : '静的SVG'}</strong></span>
            </div>
            <span className="text-[10px] text-slate-500 font-mono">SVG 1.1 Vector</span>
          </div>

          {/* Export Error Alert (UI-002) */}
          {exportError && (
            <div className="flex items-start gap-2.5 p-3 rounded-lg bg-rose-950/80 border border-rose-500/70 text-rose-200 text-xs shadow-sm">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div className="space-y-0.5">
                <span className="font-semibold text-rose-200">SVG出力エラー</span>
                <p className="text-[11px] text-rose-300/90 leading-relaxed">{exportError}</p>
              </div>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-end gap-2.5 px-6 py-4 border-t border-slate-800 bg-slate-950/60">
          <button
            type="button"
            onClick={closeSVGExportModal}
            className="px-4 py-2 text-xs font-medium text-slate-400 hover:text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors cursor-pointer"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={handleDownload}
            disabled={isExporting}
            className="flex items-center gap-2 px-5 py-2 text-xs font-bold text-white bg-cyan-600 hover:bg-cyan-500 active:bg-cyan-700 disabled:opacity-50 rounded-lg transition-all shadow-lg shadow-cyan-950/50 cursor-pointer"
          >
            {exportSuccess ? (
              <>
                <Check className="w-4 h-4 text-emerald-300 animate-bounce" />
                <span>出力完了！</span>
              </>
            ) : (
              <>
                <Download className="w-4 h-4" />
                <span>SVGファイルをダウンロード</span>
              </>
            )}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
