import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useVTAStore } from '../store/vtaStore';
import { proposeMeasures } from '../../../services/llm/client';
import {
  Lightbulb,
  Sparkles,
  ShieldAlert,
  CheckCircle2,
  X,
  RefreshCw,
  Layers,
  ArrowRight,
  ShieldCheck,
  CheckSquare,
  Square,
  AlertTriangle,
  Zap,
  StopCircle,
} from 'lucide-react';
import { MeasuresProposalResult } from '../../../types/vta';

interface AIMeasuresProposalModalProps {
  isActive?: boolean;
}

export const AIMeasuresProposalModal: React.FC<AIMeasuresProposalModalProps> = ({ isActive = true }) => {
  const {
    isProposalModalOpen,
    setIsProposalModalOpen,
    isProposing,
    setIsProposing,
    measuresProposal,
    setMeasuresProposal,
    applyMeasuresProposal,
    llmConfig,
    scenarioText,
    vtaData,
    setError,
    createAbortController,
    cancelCurrentOperation,
  } = useVTAStore();

  const [activeTab, setActiveTab] = useState<'all' | 'elimination' | 'break'>('all');
  const [selectedEliminations, setSelectedEliminations] = useState<string[]>([]);
  const [selectedBreaks, setSelectedBreaks] = useState<{ source: string; target: string }[]>([]);
  const [isApplying, setIsApplying] = useState(false);

  // Initialize selected items when proposal updates
  useEffect(() => {
    if (measuresProposal) {
      setSelectedEliminations(measuresProposal.eliminationProposals.map((p) => p.nodeId));
      setSelectedBreaks(
        measuresProposal.breakProposals.map((b) => ({
          source: b.sourceNodeId,
          target: b.targetNodeId,
        }))
      );
    }
  }, [measuresProposal]);

  // Close on Escape key
  useEffect(() => {
    if (!isProposalModalOpen || !isActive) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsProposalModalOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isProposalModalOpen, isActive, setIsProposalModalOpen]);

  if (!isProposalModalOpen || !isActive || typeof document === 'undefined') return null;

  const handleFetchProposal = async () => {
    if (!scenarioText.trim()) {
      setError('事故シナリオテキストがありません。');
      return;
    }
    if (vtaData.nodes.length === 0) {
      setError('分析対象のVTAノードが存在しません。');
      return;
    }

    const currentProjectId = useVTAStore.getState().currentProjectId;
    const reqId = `req_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    useVTAStore.getState().setActiveRequestId(reqId);

    const controller = createAbortController();
    setIsProposing(true);
    try {
      const res = await proposeMeasures(llmConfig, scenarioText, vtaData, controller.signal);
      if (
        controller.signal.aborted ||
        useVTAStore.getState().activeAbortController !== controller ||
        useVTAStore.getState().currentProjectId !== currentProjectId ||
        useVTAStore.getState().activeRequestId !== reqId
      ) {
        return;
      }
      setMeasuresProposal(res);
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        (err.name === 'UserCancelledError' || err.message === 'USER_CANCELLED' || controller.signal.aborted)
      ) {
        return;
      }
      if (useVTAStore.getState().currentProjectId !== currentProjectId) {
        return;
      }
      setError(err instanceof Error ? err.message : '対策提案の生成に失敗しました。');
    } finally {
      if (useVTAStore.getState().currentProjectId === currentProjectId) {
        setIsProposing(false);
      }
    }
  };

  const handleApplySelected = () => {
    setIsApplying(true);
    applyMeasuresProposal(selectedEliminations, selectedBreaks);
    setTimeout(() => {
      setIsApplying(false);
      setIsProposalModalOpen(false);
    }, 400);
  };

  const toggleElimination = (nodeId: string) => {
    setSelectedEliminations((prev) =>
      prev.includes(nodeId) ? prev.filter((id) => id !== nodeId) : [...prev, nodeId]
    );
  };

  const toggleBreak = (source: string, target: string) => {
    setSelectedBreaks((prev) => {
      const exists = prev.some((p) => p.source === source && p.target === target);
      if (exists) {
        return prev.filter((p) => !(p.source === source && p.target === target));
      } else {
        return [...prev, { source, target }];
      }
    });
  };

  const toggleAll = () => {
    if (!measuresProposal) return;
    const allElims = measuresProposal.eliminationProposals.map((p) => p.nodeId);
    const allBreaks = measuresProposal.breakProposals.map((b) => ({
      source: b.sourceNodeId,
      target: b.targetNodeId,
    }));

    if (
      selectedEliminations.length === allElims.length &&
      selectedBreaks.length === allBreaks.length
    ) {
      setSelectedEliminations([]);
      setSelectedBreaks([]);
    } else {
      setSelectedEliminations(allElims);
      setSelectedBreaks(allBreaks);
    }
  };

  const elimCount = measuresProposal?.eliminationProposals.length || 0;
  const breakCount = measuresProposal?.breakProposals.length || 0;

  return createPortal(
    <div
      className="fixed inset-0 bg-black/75 backdrop-blur-sm z-[9999] flex items-center justify-center p-4 overflow-hidden select-none"
      onClick={(e) => {
        if (e.target === e.currentTarget) setIsProposalModalOpen(false);
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="ai-measures-modal-title"
        className="bg-slate-900 border border-slate-700/90 rounded-2xl max-w-4xl w-full max-h-[88vh] shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-150"
      >
        
        {/* Modal Header */}
        <div className="p-5 border-b border-slate-800 bg-slate-950/70 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-amber-950/80 border border-amber-800/80 text-amber-400">
              <Lightbulb className="w-5 h-5" />
            </div>
            <div>
              <h3 id="ai-measures-modal-title" className="font-bold text-base text-slate-100 flex items-center gap-2">
                <span>AI対策提案（排除ノード・ブレイク推薦）</span>
              </h3>
              <p className="text-xs text-slate-400">
                事故再発防止に向けて、根本原因の排除と悪影響の伝播遮断ポイントを自動推薦します
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {isProposing ? (
              <button
                type="button"
                onClick={cancelCurrentOperation}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-rose-950 hover:bg-rose-900 text-rose-200 rounded-lg text-xs font-bold transition-colors border border-rose-700 cursor-pointer shadow-sm"
                title="推論処理を即座に中断"
              >
                <StopCircle className="w-3.5 h-3.5 text-rose-400" />
                <span>中断 (キャンセル)</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={handleFetchProposal}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-cyan-300 rounded-lg text-xs font-medium transition-colors border border-slate-700 cursor-pointer shadow-sm"
                title="LLMに対策の再検討を依頼"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>再提案を取得</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => {
                if (isProposing) cancelCurrentOperation();
                setIsProposalModalOpen(false);
              }}
              className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          
          {/* Loading State */}
          {isProposing && (
            <div className="py-16 flex flex-col items-center justify-center gap-4 text-center">
              <RefreshCw className="w-8 h-8 text-cyan-400 animate-spin" />
              <div className="space-y-1">
                <p className="text-sm font-semibold text-slate-200">
                  VTA図のツリー構造と事故シナリオを分析中...
                </p>
                <p className="text-xs text-slate-400 font-mono">
                  モデル: {llmConfig.selectedModel}
                </p>
              </div>

              <button
                type="button"
                onClick={cancelCurrentOperation}
                className="mt-2 px-4 py-2 bg-rose-950/80 hover:bg-rose-900 border border-rose-700/80 text-rose-200 rounded-xl text-xs font-bold flex items-center gap-2 transition-all cursor-pointer shadow-lg"
              >
                <StopCircle className="w-4 h-4 text-rose-400" />
                <span>処理を中断する</span>
              </button>
            </div>
          )}

          {/* Empty / Initial State */}
          {!isProposing && !measuresProposal && (
            <div className="py-12 flex flex-col items-center justify-center text-center space-y-4 max-w-md mx-auto">
              <div className="p-3 rounded-full bg-cyan-950/60 border border-cyan-800/80 text-cyan-400">
                <Sparkles className="w-8 h-8" />
              </div>
              <div className="space-y-1">
                <h4 className="font-semibold text-slate-200 text-sm">
                  まだ対策提案が生成されていません
                </h4>
                <p className="text-xs text-slate-400 leading-relaxed">
                  下のボタンを押すと、LLMが現在のVTA図（変動要因や伝播経路）を分析し、最適な排除ノードとブレイクの候補を提案します。
                </p>
              </div>
              <button
                type="button"
                onClick={handleFetchProposal}
                className="px-4 py-2 bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white rounded-xl text-xs font-bold transition-all shadow-lg shadow-cyan-950/50 flex items-center gap-2 cursor-pointer"
              >
                <Sparkles className="w-4 h-4" />
                <span>AIに対策を提案させる</span>
              </button>
            </div>
          )}

          {/* Proposal Results */}
          {!isProposing && measuresProposal && (
            <div className="space-y-4">
              
              {/* Summary Banner */}
              <div className="bg-slate-950/80 border border-slate-800 rounded-xl p-4 space-y-2">
                <div className="flex items-center gap-2 text-xs font-semibold text-cyan-300">
                  <ShieldCheck className="w-4 h-4 text-cyan-400" />
                  <span>AIによる対策立案方針・総括</span>
                </div>
                <p className="text-xs text-slate-300 leading-relaxed font-sans">
                  {measuresProposal.summary}
                </p>
              </div>

              {/* Tabs & Selection Controls */}
              <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                <div className="flex items-center gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => setActiveTab('all')}
                    className={`px-3 py-1.5 rounded-lg font-medium transition-colors cursor-pointer ${
                      activeTab === 'all'
                        ? 'bg-cyan-950 text-cyan-300 border border-cyan-800'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    すべて ({elimCount + breakCount})
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('elimination')}
                    className={`px-3 py-1.5 rounded-lg font-medium transition-colors cursor-pointer flex items-center gap-1.5 ${
                      activeTab === 'elimination'
                        ? 'bg-emerald-950 text-emerald-300 border border-emerald-800'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <span className="w-2 h-2 rounded-full bg-emerald-400" />
                    <span>排除ノード ({elimCount})</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('break')}
                    className={`px-3 py-1.5 rounded-lg font-medium transition-colors cursor-pointer flex items-center gap-1.5 ${
                      activeTab === 'break'
                        ? 'bg-rose-950 text-rose-300 border border-rose-800'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    <span className="w-2 h-2 rounded-full bg-rose-400" />
                    <span>ブレイク ({breakCount})</span>
                  </button>
                </div>

                <button
                  type="button"
                  onClick={toggleAll}
                  className="text-xs text-slate-400 hover:text-cyan-300 flex items-center gap-1 cursor-pointer font-medium"
                >
                  {selectedEliminations.length === elimCount && selectedBreaks.length === breakCount ? (
                    <>
                      <CheckSquare className="w-3.5 h-3.5 text-cyan-400" />
                      <span>全解除</span>
                    </>
                  ) : (
                    <>
                      <Square className="w-3.5 h-3.5" />
                      <span>全選択</span>
                    </>
                  )}
                </button>
              </div>

              {/* Proposals Cards List */}
              <div className="space-y-3">
                
                {/* 1. Elimination Proposals */}
                {(activeTab === 'all' || activeTab === 'elimination') &&
                  measuresProposal.eliminationProposals.map((elim) => {
                    const isChecked = selectedEliminations.includes(elim.nodeId);
                    return (
                      <div
                        key={`elim-${elim.nodeId}`}
                        onClick={() => toggleElimination(elim.nodeId)}
                        className={`p-4 rounded-xl border transition-all cursor-pointer flex items-start gap-3.5 ${
                          isChecked
                            ? 'bg-emerald-950/30 border-emerald-700/80 shadow-md shadow-emerald-950/40'
                            : 'bg-slate-950/50 border-slate-800/80 opacity-60 hover:opacity-100'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => {}}
                          className="mt-1 rounded accent-emerald-500 w-4 h-4 cursor-pointer"
                        />

                        <div className="flex-1 space-y-1.5">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-300 border border-emerald-800 font-bold">
                              ○ 排除ノード推薦
                            </span>
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700 font-medium">
                              {elim.lane}
                            </span>
                            <h5 className="font-bold text-xs text-slate-100">
                              {elim.nodeTitle}
                            </h5>
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px] pt-1">
                            <div className="bg-slate-900/90 p-2.5 rounded-lg border border-slate-800">
                              <span className="text-slate-400 font-semibold block mb-0.5">
                                📌 選定理由:
                              </span>
                              <span className="text-slate-300 leading-relaxed">
                                {elim.reason}
                              </span>
                            </div>
                            <div className="bg-emerald-950/50 p-2.5 rounded-lg border border-emerald-900/80 text-emerald-200">
                              <span className="text-emerald-400 font-semibold block mb-0.5">
                                🛠 推奨排除アクション:
                              </span>
                              <span className="leading-relaxed">
                                {elim.recommendedAction}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}

                {/* 2. Break Proposals */}
                {(activeTab === 'all' || activeTab === 'break') &&
                  measuresProposal.breakProposals.map((brk) => {
                    const isChecked = selectedBreaks.some(
                      (p) => p.source === brk.sourceNodeId && p.target === brk.targetNodeId
                    );
                    return (
                      <div
                        key={`break-${brk.sourceNodeId}-${brk.targetNodeId}`}
                        onClick={() => toggleBreak(brk.sourceNodeId, brk.targetNodeId)}
                        className={`p-4 rounded-xl border transition-all cursor-pointer flex items-start gap-3.5 ${
                          isChecked
                            ? 'bg-rose-950/30 border-rose-700/80 shadow-md shadow-rose-950/40'
                            : 'bg-slate-950/50 border-slate-800/80 opacity-60 hover:opacity-100'
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => {}}
                          className="mt-1 rounded accent-rose-500 w-4 h-4 cursor-pointer"
                        />

                        <div className="flex-1 space-y-1.5">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-rose-950 text-rose-300 border border-rose-800 font-bold">
                              BREAK 推薦
                            </span>
                            <div className="flex items-center gap-1.5 text-xs text-slate-200 font-semibold">
                              <span>{brk.sourceTitle}</span>
                              <ArrowRight className="w-3.5 h-3.5 text-rose-400" />
                              <span>{brk.targetTitle}</span>
                            </div>
                          </div>

                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-[11px] pt-1">
                            <div className="bg-slate-900/90 p-2.5 rounded-lg border border-slate-800">
                              <span className="text-slate-400 font-semibold block mb-0.5">
                                📌 遮断理由:
                              </span>
                              <span className="text-slate-300 leading-relaxed">
                                {brk.reason}
                              </span>
                            </div>
                            <div className="bg-rose-950/50 p-2.5 rounded-lg border border-rose-900/80 text-rose-200">
                              <span className="text-rose-400 font-semibold block mb-0.5">
                                🛡 推奨防護壁（バリア）:
                              </span>
                              <span className="leading-relaxed">
                                {brk.recommendedBarrier}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}

        </div>

        {/* Modal Footer */}
        <div className="p-4 border-t border-slate-800 bg-slate-950/80 flex items-center justify-between shrink-0">
          <div className="text-xs text-slate-400">
            {measuresProposal && (
              <span>
                選択中: 排除 <strong className="text-emerald-300">{selectedEliminations.length}</strong> 件 / ブレイク <strong className="text-rose-300">{selectedBreaks.length}</strong> 件
              </span>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsProposalModalOpen(false)}
              className="px-3.5 py-1.5 text-xs font-medium text-slate-300 hover:text-white bg-slate-800 hover:bg-slate-700 rounded-lg transition-colors cursor-pointer"
            >
              閉じる
            </button>

            {measuresProposal && (
              <button
                type="button"
                onClick={handleApplySelected}
                disabled={isApplying || (selectedEliminations.length === 0 && selectedBreaks.length === 0)}
                className="px-4 py-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 disabled:opacity-50 text-white rounded-xl text-xs font-bold transition-all shadow-lg shadow-emerald-950/40 flex items-center gap-2 cursor-pointer"
              >
                <CheckCircle2 className="w-4 h-4" />
                <span>選択した対策を図上に一括適用</span>
              </button>
            )}
          </div>
        </div>

      </div>
    </div>,
    document.body
  );
};
