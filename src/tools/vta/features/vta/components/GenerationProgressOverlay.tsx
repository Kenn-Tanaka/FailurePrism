import React, { useEffect, useState } from 'react';
import { useVTAStore } from '../store/vtaStore';
import {
  Sparkles,
  RefreshCw,
  CheckCircle2,
  Cpu,
  Layers,
  Clock,
  ArrowRight,
  ShieldAlert,
  Zap,
  StopCircle,
} from 'lucide-react';

const STEPS_EXTRACT = [
  { id: 'preparing', num: 1, label: '準備', desc: 'シナリオ解析' },
  { id: 'calling_llm', num: 2, label: '推論', desc: 'Gateway通信' },
  { id: 'parsing', num: 3, label: '解析', desc: 'JSON検証' },
  { id: 'layouting', num: 4, label: '描画', desc: 'BT階層整列' },
];

const STEPS_REGEN = [
  { id: 'preparing', num: 1, label: '集計', desc: '対策情報集計' },
  { id: 'calling_llm', num: 2, label: '推論', desc: 'Gateway通信' },
  { id: 'parsing', num: 3, label: '整形', desc: 'レポート構築' },
];

export const GenerationProgressOverlay: React.FC = () => {
  const { generationProgress, isExtracting, isRegenerating, llmConfig, cancelCurrentOperation } = useVTAStore();
  const [timerSeconds, setTimerSeconds] = useState(0);

  const isActive = generationProgress.isActive || isExtracting || isRegenerating;

  // Real-time ticking timer while active
  useEffect(() => {
    let interval: any = null;
    if (isActive) {
      setTimerSeconds(0);
      interval = setInterval(() => {
        setTimerSeconds((prev) => prev + 1);
      }, 1000);
    } else {
      setTimerSeconds(0);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isActive]);

  if (!isActive) return null;

  const mode = generationProgress.mode || (isExtracting ? 'extract' : 'regenerate');
  const steps = mode === 'extract' ? STEPS_EXTRACT : STEPS_REGEN;
  const currentStep = generationProgress.stepCurrent || (isExtracting ? 2 : 2);
  const stage = generationProgress.stage;

  const formatTimer = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="absolute inset-0 z-50 bg-slate-950/75 backdrop-blur-md flex items-center justify-center p-6 animate-in fade-in duration-200">
      <div className="relative w-full max-w-xl bg-slate-900/95 border border-cyan-500/40 rounded-2xl shadow-2xl shadow-cyan-950/60 p-6 overflow-hidden flex flex-col gap-5">
        
        {/* Animated Background Glow Orbs */}
        <div className="absolute -top-20 -left-20 w-48 h-48 bg-cyan-500/15 rounded-full blur-3xl pointer-events-none animate-pulse" />
        <div className="absolute -bottom-20 -right-20 w-48 h-48 bg-blue-600/15 rounded-full blur-3xl pointer-events-none animate-pulse" />

        {/* Header: Title, Mode & Timer */}
        <div className="flex items-start justify-between relative z-10 border-b border-slate-800 pb-4">
          <div className="flex items-center gap-3">
            <div className="relative flex items-center justify-center w-11 h-11 rounded-xl bg-gradient-to-tr from-cyan-600 to-blue-600 shadow-lg shadow-cyan-500/25">
              {stage === 'completed' ? (
                <CheckCircle2 className="w-6 h-6 text-white" />
              ) : (
                <RefreshCw className="w-6 h-6 text-white animate-spin" />
              )}
            </div>

            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-bold text-slate-100 text-base tracking-tight">
                  {mode === 'extract'
                    ? '⚡ VTAツリー図 生成中'
                    : '✨ 改善された業務フロー & レポート再生成中'}
                </h3>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-cyan-950 text-cyan-300 border border-cyan-800">
                  AI推論実行中
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5 font-mono truncate max-w-sm">
                モデル: <span className="text-cyan-400">{llmConfig.selectedModel}</span>
              </p>
            </div>
          </div>

          {/* Realtime Elapsed Timer & Cancel Button */}
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-950/90 border border-slate-700/80 rounded-xl text-slate-200 shadow-inner">
              <Clock className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
              <span className="text-xs font-mono font-bold">{formatTimer(timerSeconds)}</span>
            </div>
            {stage !== 'completed' && (
              <button
                type="button"
                onClick={cancelCurrentOperation}
                className="px-2.5 py-1.5 bg-rose-950/90 hover:bg-rose-900 border border-rose-700/80 text-rose-200 rounded-xl text-xs font-bold flex items-center gap-1 transition-colors cursor-pointer shadow-md"
                title="推論処理を中断"
              >
                <StopCircle className="w-3.5 h-3.5 text-rose-400" />
                <span>中断</span>
              </button>
            )}
          </div>
        </div>

        {/* Stepper Progress Bar */}
        <div className="relative z-10 py-1">
          <div className="grid grid-cols-4 gap-2">
            {steps.map((s, idx) => {
              const isDone = s.num < currentStep || stage === 'completed';
              const isCurrent = s.num === currentStep && stage !== 'completed';

              return (
                <div
                  key={s.id}
                  className={`relative flex flex-col p-2.5 rounded-xl border transition-all ${
                    isCurrent
                      ? 'bg-cyan-950/60 border-cyan-500/80 shadow-md shadow-cyan-950/50'
                      : isDone
                      ? 'bg-slate-950/80 border-emerald-800/80 text-emerald-300'
                      : 'bg-slate-950/40 border-slate-800/80 text-slate-500 opacity-60'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span
                      className={`w-5 h-5 rounded-full text-[10px] font-bold flex items-center justify-center font-mono ${
                        isDone
                          ? 'bg-emerald-500 text-white'
                          : isCurrent
                          ? 'bg-cyan-500 text-slate-950 animate-pulse'
                          : 'bg-slate-800 text-slate-400'
                      }`}
                    >
                      {isDone ? '✓' : s.num}
                    </span>
                    <span className="text-[10px] font-semibold">
                      {isCurrent ? '進行中' : isDone ? '完了' : '待機'}
                    </span>
                  </div>

                  <span
                    className={`text-xs font-bold leading-tight ${
                      isCurrent ? 'text-cyan-200' : isDone ? 'text-emerald-300' : 'text-slate-400'
                    }`}
                  >
                    {s.label}
                  </span>
                  <span className="text-[10px] text-slate-400 truncate mt-0.5">
                    {s.desc}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Detailed Stage Status Message */}
        <div className="relative z-10 bg-slate-950/90 border border-slate-800 rounded-xl p-3.5 space-y-1.5 shadow-inner">
          <div className="flex items-center gap-2 text-xs font-semibold text-cyan-300">
            <Zap className="w-3.5 h-3.5 text-cyan-400 animate-pulse" />
            <span>{generationProgress.title || '処理を実行しています...'}</span>
          </div>
          <p className="text-xs text-slate-300 leading-relaxed font-sans">
            {generationProgress.detail || 'Lightweight LLM Gatewayへリクエストを送信し、結果を待機しています。'}
          </p>
        </div>

        {/* Bottom Shimmer Progress Bar */}
        <div className="relative z-10 w-full bg-slate-800 h-1.5 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-cyan-500 via-blue-500 to-indigo-500 transition-all duration-300 relative"
            style={{
              width: `${stage === 'completed' ? 100 : Math.min(100, Math.max(15, (currentStep / steps.length) * 100))}%`,
            }}
          >
            <div className="absolute inset-0 bg-white/25 animate-[shimmer_1.5s_infinite]" />
          </div>
        </div>

      </div>
    </div>
  );
};
