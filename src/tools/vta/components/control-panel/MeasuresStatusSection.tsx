import React, { useState, useEffect } from 'react';
import {
  Layers,
  Lightbulb,
  Sparkles,
  RefreshCw,
  StopCircle,
} from 'lucide-react';
import { useVTAStore } from '../../features/vta/store/vtaStore';
import { regenerateScenario } from '../../services/llm/client';
import { computeVTADataHash } from '../../features/vta/utils/hash';

export const MeasuresStatusSection: React.FC = () => {
  const vtaData = useVTAStore((state) => state.vtaData);
  const scenarioText = useVTAStore((state) => state.scenarioText);
  const llmConfig = useVTAStore((state) => state.llmConfig);
  const isExtracting = useVTAStore((state) => state.isExtracting);
  const isRegenerating = useVTAStore((state) => state.isRegenerating);
  const setIsRegenerating = useVTAStore((state) => state.setIsRegenerating);
  const generationProgress = useVTAStore((state) => state.generationProgress);
  const setRegenerationResult = useVTAStore((state) => state.setRegenerationResult);
  const setActiveTab = useVTAStore((state) => state.setActiveTab);
  const setIsProposalModalOpen = useVTAStore((state) => state.setIsProposalModalOpen);
  const setError = useVTAStore((state) => state.setError);
  const createAbortController = useVTAStore((state) => state.createAbortController);
  const cancelCurrentOperation = useVTAStore((state) => state.cancelCurrentOperation);

  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  // Live timer during scenario regeneration
  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;
    if (isRegenerating) {
      setElapsedSeconds(0);
      interval = setInterval(() => {
        setElapsedSeconds((prev) => prev + 1);
      }, 1000);
    } else {
      setElapsedSeconds(0);
    }
    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isRegenerating]);

  const eliminationCount = vtaData.nodes.filter((n) => n.measure_type === 'elimination').length;
  const breakCount = vtaData.edges.filter((e) => e.is_break).length;

  const handleRegenerate = async () => {
    if (!scenarioText.trim()) {
      setError('元となるシナリオテキストがありません。');
      return;
    }

    const currentProjectId = useVTAStore.getState().currentProjectId;
    const reqId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    useVTAStore.getState().setActiveRequestId(reqId);
    const requestHash = computeVTADataHash(vtaData, scenarioText);

    const controller = createAbortController();
    setIsRegenerating(true);
    setError(null);

    try {
      const result = await regenerateScenario(llmConfig, scenarioText, vtaData, controller.signal);
      if (
        controller.signal.aborted ||
        useVTAStore.getState().activeAbortController !== controller ||
        useVTAStore.getState().currentProjectId !== currentProjectId ||
        useVTAStore.getState().activeRequestId !== reqId
      ) {
        // Discard result if aborted or project was switched during generation (REL-001)
        return;
      }
      setRegenerationResult(result, requestHash);
      setActiveTab('idealFlow');
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        (err.name === 'UserCancelledError' || err.message === 'USER_CANCELLED' || controller.signal.aborted)
      ) {
        return;
      }
      if (useVTAStore.getState().currentProjectId !== currentProjectId) {
        // Suppress error if project was switched
        return;
      }
      setError(
        err instanceof Error
          ? err.message
          : '改善業務フロー・分析レポートの生成処理中にエラーが発生しました。'
      );
    } finally {
      if (useVTAStore.getState().currentProjectId === currentProjectId) {
        setIsRegenerating(false);
      }
    }
  };

  return (
    <section className="bg-slate-900/80 border border-slate-800 rounded-xl p-3.5 space-y-3 shadow-md">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
          <Layers className="w-4 h-4 text-emerald-400" />
          <span>対策の適用状況</span>
        </div>

        {/* Badges */}
        <div className="flex items-center gap-2">
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-300 border border-emerald-800 font-semibold font-mono">
            排除: {eliminationCount}件
          </span>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-rose-950 text-rose-300 border border-rose-800 font-semibold font-mono">
            ブレイク: {breakCount}件
          </span>
        </div>
      </div>

      <p className="text-[11px] text-slate-400 leading-relaxed">
        右側のキャンバスでノードの「対策: 排除」やエッジの「BREAK」を手動指定するか、AIに対策候補を自動推薦させることができます。
      </p>

      <div className="space-y-2">
        <button
          type="button"
          onClick={() => setIsProposalModalOpen(true)}
          disabled={isExtracting || isRegenerating || !scenarioText.trim()}
          className="w-full py-2 px-3 bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 disabled:opacity-50 text-white rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-2 shadow-md shadow-amber-950/40 cursor-pointer"
        >
          <Lightbulb className="w-3.5 h-3.5 text-amber-200" />
          <span>💡 AIに対策（排除・ブレイク）を提案させる</span>
        </button>

        {isRegenerating && (
          <div className="p-2.5 bg-emerald-950/70 border border-emerald-800/80 rounded-lg text-xs text-emerald-300 space-y-2 animate-in fade-in-50">
            <div className="flex items-center justify-between font-semibold">
              <span className="flex items-center gap-1.5">
                <Sparkles className="w-3.5 h-3.5 text-emerald-400 animate-pulse" />
                <span>{generationProgress.title || '改善業務フロー・分析レポートを生成中...'}</span>
              </span>
              <div className="flex items-center gap-2">
                <span className="font-mono text-[10px]">{elapsedSeconds}秒経過</span>
                <button
                  type="button"
                  onClick={cancelCurrentOperation}
                  className="px-2 py-0.5 bg-rose-900/80 hover:bg-rose-800 text-rose-200 border border-rose-600/80 rounded text-[10px] font-bold flex items-center gap-1 transition-colors cursor-pointer shadow-sm"
                  title="生成処理を即座に中断・キャンセル"
                >
                  <StopCircle className="w-3 h-3 text-rose-300" />
                  <span>中断</span>
                </button>
              </div>
            </div>
            <p className="text-[11px] text-slate-300 font-sans leading-tight">
              {generationProgress.detail}
            </p>
          </div>
        )}

        {isRegenerating ? (
          <div className="flex gap-2">
            <div className="flex-1 py-2 px-3 rounded-lg text-xs font-bold bg-slate-800 text-slate-400 flex items-center justify-center gap-2 cursor-wait">
              <RefreshCw className="w-3.5 h-3.5 animate-spin text-emerald-400" />
              <span>改善業務フロー・分析レポートを生成中... ({elapsedSeconds}s)</span>
            </div>
            <button
              type="button"
              onClick={cancelCurrentOperation}
              className="px-3 py-2 bg-rose-950/90 hover:bg-rose-900 border border-rose-700/80 text-rose-200 rounded-lg text-xs font-bold flex items-center gap-1.5 transition-colors cursor-pointer shadow-md shrink-0"
              title="生成処理を中断"
            >
              <StopCircle className="w-4 h-4 text-rose-400" />
              <span>中断</span>
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={handleRegenerate}
            disabled={!scenarioText.trim()}
            className="w-full py-2.5 px-3 rounded-lg text-xs font-bold transition-all flex items-center justify-center gap-2 shadow-lg cursor-pointer bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white shadow-emerald-950/40 disabled:opacity-50"
          >
            <Sparkles className="w-3.5 h-3.5 text-emerald-200" />
            <span>✨ 改善された業務フロー＆レポートを生成</span>
          </button>
        )}
      </div>
    </section>
  );
};
