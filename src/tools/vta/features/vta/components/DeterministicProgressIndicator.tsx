import React from 'react';
import { createPortal } from 'react-dom';
import { RefreshCw } from 'lucide-react';
import { useVTAStore } from '../store/vtaStore';

export interface DeterministicProgressIndicatorProps {
  isActive?: boolean;
}

export const DeterministicProgressIndicator: React.FC<DeterministicProgressIndicatorProps> = ({
  isActive = true,
}) => {
  const uiTaskProgress = useVTAStore((state) => state.uiTaskProgress);
  const isExtracting = useVTAStore((state) => state.isExtracting);
  const isRegenerating = useVTAStore((state) => state.isRegenerating);
  const generationProgressActive = useVTAStore((state) => state.generationProgress.isActive);

  if (!isActive || !uiTaskProgress) return null;
  if (isExtracting || isRegenerating || generationProgressActive) return null;

  if (uiTaskProgress.level === 'inline') {
    return (
      <>
        <style>{`@keyframes vtaDelayedFadeIn { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }`}</style>
        <div
          role="status"
          aria-live="polite"
          data-vta-deterministic-progress="inline"
          style={{ animation: 'vtaDelayedFadeIn 140ms ease-out 100ms both' }}
          className="pointer-events-none absolute top-16 left-1/2 -translate-x-1/2 z-40 flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-slate-900/95 border border-cyan-500/50 text-xs text-cyan-200 shadow-lg shadow-cyan-950/50 backdrop-blur"
        >
          <RefreshCw className="w-3.5 h-3.5 text-cyan-400 animate-spin shrink-0" />
          <span className="font-semibold whitespace-nowrap">{uiTaskProgress.title}</span>
          {uiTaskProgress.detail && (
            <span className="text-[11px] text-slate-300 truncate max-w-[240px]">
              {uiTaskProgress.detail}
            </span>
          )}
        </div>
      </>
    );
  }

  const hasSteps =
    typeof uiTaskProgress.stepTotal === 'number' &&
    uiTaskProgress.stepTotal > 0 &&
    typeof uiTaskProgress.stepCurrent === 'number';
  const progressPercent = hasSteps
    ? Math.min(100, Math.max(12, Math.round((uiTaskProgress.stepCurrent! / uiTaskProgress.stepTotal!) * 100)))
    : 50;

  const overlay = (
    <div
      role="status"
      aria-live="polite"
      data-vta-deterministic-progress="overlay"
      className="fixed inset-0 z-[11500] bg-slate-950/55 backdrop-blur-[2px] flex items-center justify-center p-4 select-none"
    >
      <div className="w-full max-w-md rounded-2xl bg-slate-900/95 border border-cyan-500/40 p-5 shadow-2xl shadow-cyan-950/60 space-y-3.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-cyan-950/90 border border-cyan-700/80 flex items-center justify-center shrink-0">
              <RefreshCw className="w-4.5 h-4.5 text-cyan-300 animate-spin" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-bold text-slate-100 truncate">{uiTaskProgress.title}</div>
              {uiTaskProgress.detail && (
                <div className="text-xs text-slate-300 mt-0.5 truncate">{uiTaskProgress.detail}</div>
              )}
            </div>
          </div>
          {hasSteps && (
            <span className="shrink-0 px-2 py-0.5 rounded-full bg-cyan-950 border border-cyan-800 text-[11px] font-mono font-semibold text-cyan-200">
              Step {uiTaskProgress.stepCurrent}/{uiTaskProgress.stepTotal}
            </span>
          )}
        </div>

        <div className="w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
          <div
            className={`h-full bg-gradient-to-r from-cyan-500 via-sky-400 to-blue-500 transition-all duration-200 ${
              hasSteps ? '' : 'animate-pulse'
            }`}
            style={{ width: `${progressPercent}%` }}
          />
        </div>
      </div>
    </div>
  );

  return typeof document !== 'undefined' && document.body
    ? createPortal(overlay, document.body)
    : overlay;
};
