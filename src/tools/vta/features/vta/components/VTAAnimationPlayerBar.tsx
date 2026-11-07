import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  Play,
  Pause,
  RotateCcw,
  SkipBack,
  SkipForward,
  Film,
  Download,
  X,
  Sparkles,
  Clock,
  Zap,
} from 'lucide-react';
import { useVTAStore } from '../store/vtaStore';
import {
  buildCausalFlowSequence,
  buildPipelineEvolutionSequence,
  type AnimationMode,
  type AnimationSequence,
  type AnimationStep,
} from '../utils/animationSequencer';
import { exportAnimatedVTAToSVGFile } from '../utils/animatedSvgExport';

export interface VTAAnimationPlayerBarProps {
  onStepChange: (step: AnimationStep | null) => void;
  onClose: () => void;
}

export const VTAAnimationPlayerBar: React.FC<VTAAnimationPlayerBarProps> = ({
  onStepChange,
  onClose,
}) => {
  const { vtaData, nodes, edges, laneBounds, showToast, addLog } = useVTAStore();

  const [mode, setMode] = useState<AnimationMode>('causal_flow');
  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [currentStepIndex, setCurrentStepIndex] = useState<number>(0);
  const [speed, setSpeed] = useState<number>(1);

  // Compute sequence based on selected mode
  const sequence: AnimationSequence = useMemo(() => {
    return mode === 'causal_flow'
      ? buildCausalFlowSequence(vtaData)
      : buildPipelineEvolutionSequence(vtaData);
  }, [vtaData, mode]);

  // Keep step index within valid bounds when mode changes
  useEffect(() => {
    setCurrentStepIndex(0);
  }, [mode]);

  const currentStep = sequence.steps[currentStepIndex] ?? sequence.steps[0];

  // Notify parent of current step
  useEffect(() => {
    if (currentStep) {
      onStepChange(currentStep);
    }
    return () => {
      onStepChange(null);
    };
  }, [currentStep, onStepChange]);

  // Playback timer
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!isPlaying) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      return;
    }

    const intervalMs = Math.max(250, Math.round(1100 / speed));

    timerRef.current = window.setInterval(() => {
      setCurrentStepIndex((prev) => {
        if (prev >= sequence.steps.length - 1) {
          // Loop back to start after a pause at the end
          return 0;
        }
        return prev + 1;
      });
    }, intervalMs);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [isPlaying, speed, sequence.steps.length]);

  const handleTogglePlay = () => {
    setIsPlaying((prev) => !prev);
  };

  const handleStepBack = () => {
    setIsPlaying(false);
    setCurrentStepIndex((prev) => Math.max(0, prev - 1));
  };

  const handleStepForward = () => {
    setIsPlaying(false);
    setCurrentStepIndex((prev) => Math.min(sequence.steps.length - 1, prev + 1));
  };

  const handleReset = () => {
    setCurrentStepIndex(0);
  };

  const handleExportAnimatedSVG = () => {
    try {
      const res = exportAnimatedVTAToSVGFile(vtaData, nodes, edges, laneBounds, {
        animationMode: mode,
      });
      showToast('success', `Animated SVG「${res.filename}」を出力しました。`);
      addLog('success', `[Animated SVG] 「${res.filename}」をダウンロード保存しました。`, 'エクスポート');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      showToast('error', `Animated SVG出力失敗: ${msg}`);
      addLog('error', `[Animated SVG失敗] ${msg}`, 'エクスポート');
    }
  };

  return (
    <div
      role="region"
      aria-label="VTAアニメーション再生バー"
      className="absolute bottom-5 left-1/2 -translate-x-1/2 z-30 w-[94%] max-w-4xl bg-slate-950/95 border border-cyan-500/60 rounded-2xl shadow-2xl shadow-cyan-950/50 backdrop-blur-md p-3 space-y-2.5 text-slate-100"
    >
      {/* Top Bar: Title, Mode Toggles, Export, Close */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-cyan-950/80 border border-cyan-700/70 text-cyan-300 font-semibold text-xs">
            <Film className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
            <span>VTA動的リプレイ</span>
          </div>

          {/* Mode Switcher */}
          <div className="flex items-center rounded-lg bg-slate-900 border border-slate-700 p-0.5 text-xs">
            <button
              type="button"
              onClick={() => setMode('causal_flow')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md transition-colors ${
                mode === 'causal_flow'
                  ? 'bg-cyan-600 text-white font-semibold shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Clock className="w-3 h-3" />
              <span>⏱ 事故時系列因果</span>
            </button>
            <button
              type="button"
              onClick={() => setMode('pipeline_evolution')}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md transition-colors ${
                mode === 'pipeline_evolution'
                  ? 'bg-amber-600 text-white font-semibold shadow-sm'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Sparkles className="w-3 h-3" />
              <span>🧠 AI生成プロセス</span>
            </button>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleExportAnimatedSVG}
            className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-cyan-600/80 text-cyan-200 hover:text-white text-xs font-semibold shadow transition-colors"
            title="現在のモードのアニメーション付きSVG（Animated SVG）を保存"
          >
            <Download className="w-3.5 h-3.5 text-cyan-400" />
            <span>Animated SVG 出力</span>
          </button>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
            title="プレイヤーを閉じる（全図面表示に戻る）"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Center Bar: Current Step Information */}
      <div className="flex items-center justify-between gap-3 bg-slate-900/90 border border-slate-800 rounded-xl px-3 py-1.5 text-xs">
        <div className="flex items-center gap-2 min-w-0">
          <span className="px-2 py-0.5 rounded bg-slate-800 text-cyan-300 font-mono text-[11px] font-bold shrink-0">
            {currentStepIndex + 1} / {sequence.steps.length}
          </span>
          <span className="font-bold text-slate-100 truncate">
            {currentStep?.title || '準備中'}
          </span>
          {currentStep?.description && (
            <span className="text-slate-400 text-[11px] truncate hidden sm:inline">
              — {currentStep.description}
            </span>
          )}
        </div>
        <div className="text-[11px] text-slate-400 font-mono shrink-0">
          約 {sequence.totalDuration}s
        </div>
      </div>

      {/* Bottom Controls: Slider & Playback Buttons */}
      <div className="flex items-center gap-3">
        {/* Play/Pause & Step Buttons */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={handleReset}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
            title="先頭に巻き戻し"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={handleStepBack}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
            title="前へコマ送り"
          >
            <SkipBack className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={handleTogglePlay}
            className={`p-2 rounded-xl flex items-center justify-center transition-colors shadow ${
              isPlaying
                ? 'bg-amber-600 hover:bg-amber-500 text-white'
                : 'bg-cyan-600 hover:bg-cyan-500 text-white'
            }`}
            title={isPlaying ? '一時停止' : '再生'}
          >
            {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
          </button>
          <button
            type="button"
            onClick={handleStepForward}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors"
            title="次へコマ送り"
          >
            <SkipForward className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Timeline Slider */}
        <div className="flex-1 flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={Math.max(0, sequence.steps.length - 1)}
            value={currentStepIndex}
            onChange={(e) => {
              setIsPlaying(false);
              setCurrentStepIndex(Number(e.target.value));
            }}
            className="w-full h-1.5 bg-slate-800 rounded-lg appearance-none cursor-pointer accent-cyan-400"
          />
        </div>

        {/* Speed Selector */}
        <div className="flex items-center rounded-lg bg-slate-900 border border-slate-800 p-0.5 text-[11px] font-mono">
          {[0.5, 1, 2, 4].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSpeed(s)}
              className={`px-1.5 py-0.5 rounded transition-colors ${
                speed === s
                  ? 'bg-slate-700 text-cyan-300 font-bold'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {s}x
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};
