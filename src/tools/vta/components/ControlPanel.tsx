import React from 'react';
import {
  AlertCircle,
  X,
  Sparkles,
  BookOpen,
  ClipboardCheck,
  ShieldCheck,
  PanelLeftOpen,
} from 'lucide-react';
import { useVTAStore } from '../features/vta/store/vtaStore';
import { isIdentifiedOutcomeEvent } from '../features/vta/utils/eventAnalysis';
import { debugRecorder } from '../services/debugRecorder';
import { ScenarioInputSection } from './control-panel/ScenarioInputSection';
import { MeasuresStatusSection } from './control-panel/MeasuresStatusSection';
import { ResultsSection } from './control-panel/ResultsSection';
import { DebugLogsSection } from './control-panel/DebugLogsSection';
import type { VTAWorkflowStep } from '../types/vta';

export const ControlPanel: React.FC = () => {
  const error = useVTAStore((state) => state.error);
  const setError = useVTAStore((state) => state.setError);
  const workflowStep = useVTAStore((state) => state.workflowStep);
  const setWorkflowStep = useVTAStore((state) => state.setWorkflowStep);
  const vtaData = useVTAStore((state) => state.vtaData);
  const regenerationResult = useVTAStore((state) => state.regenerationResult);
  const isReportOutdated = useVTAStore((state) => state.isReportOutdated);
  const isLeftPanelCollapsed = useVTAStore((state) => state.isLeftPanelCollapsed);
  const setIsLeftPanelCollapsed = useVTAStore((state) => state.setIsLeftPanelCollapsed);

  const unclassifiedCount =
    vtaData.analysis?.events.filter(
      (e) => !e.ignored && e.classification === 'unclassified' && !isIdentifiedOutcomeEvent(vtaData.analysis, e)
    ).length ?? 0;
  const totalEventsCount = vtaData.analysis?.events.filter((e) => !e.ignored).length ?? 0;
  const activeMeasuresCount =
    vtaData.nodes.filter((n) => n.measure_type === 'elimination').length +
    vtaData.edges.filter((e) => e.is_break).length;

  const steps: Array<{
    id: VTAWorkflowStep;
    num: string;
    label: string;
    icon: React.ReactNode;
    badge?: string | number;
    badgeColor?: string;
    title: string;
  }> = [
    {
      id: 'input',
      num: '①',
      label: 'シナリオ・抽出',
      icon: <BookOpen className="w-3.5 h-3.5 shrink-0" />,
      title: 'ステップ1: 事故シナリオの入力・ファイル読込・VTAツリー自動生成',
    },
    {
      id: 'review',
      num: '②',
      label: '検証・要因判定',
      icon: <ClipboardCheck className="w-3.5 h-3.5 shrink-0" />,
      badge: unclassifiedCount > 0 ? `未判定 ${unclassifiedCount}` : totalEventsCount > 0 ? totalEventsCount : undefined,
      badgeColor:
        unclassifiedCount > 0
          ? 'bg-amber-950 text-amber-300 border-amber-600/80'
          : 'bg-slate-800 text-slate-300 border-slate-700',
      title: 'ステップ2: イベント・主体の確認と変動要因判定',
    },
    {
      id: 'measures',
      num: '③',
      label: '対策・改善生成',
      icon: <ShieldCheck className="w-3.5 h-3.5 shrink-0" />,
      badge:
        regenerationResult && isReportOutdated
          ? '要更新'
          : activeMeasuresCount > 0
          ? activeMeasuresCount
          : undefined,
      badgeColor:
        regenerationResult && isReportOutdated
          ? 'bg-amber-950 text-amber-300 border-amber-600/80'
          : 'bg-emerald-950 text-emerald-300 border-emerald-700/80',
      title: 'ステップ3: 排除・ブレイク対策の推薦と改善業務フロー・分析レポート生成',
    },
  ];

  if (isLeftPanelCollapsed) {
    return (
      <aside
        aria-label="ワークフローパネル（折りたたみ中）"
        className="w-11 h-full bg-slate-950 border-r border-slate-800 flex flex-col items-center py-2.5 gap-2 shrink-0"
      >
        <button
          type="button"
          onClick={() => setIsLeftPanelCollapsed(false)}
          className="p-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 border border-slate-700/80 text-cyan-400 hover:text-cyan-300 transition-colors cursor-pointer"
          title="左ワークフローパネルを展開"
        >
          <PanelLeftOpen className="w-4 h-4" />
        </button>

        {error && (
          <button
            type="button"
            onClick={() => setIsLeftPanelCollapsed(false)}
            className="p-1.5 rounded-lg bg-rose-950/90 border border-rose-700 text-rose-400 cursor-pointer"
            title={`エラーがあります: ${error}`}
          >
            <AlertCircle className="w-3.5 h-3.5" />
          </button>
        )}

        <div className="w-6 h-px bg-slate-800 my-0.5" />

        <nav aria-label="VTA分析ステップ（アイコン）" className="flex flex-col gap-1.5">
          {steps.map((step) => {
            const isActive = workflowStep === step.id;
            return (
              <button
                key={step.id}
                type="button"
                onClick={() => {
                  setWorkflowStep(step.id);
                  setIsLeftPanelCollapsed(false);
                }}
                title={step.title}
                className={`w-8 h-9 rounded-lg flex flex-col items-center justify-center gap-0.5 text-[10px] font-bold border transition-colors cursor-pointer ${
                  isActive
                    ? 'bg-cyan-950/90 text-cyan-200 border-cyan-600/80'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900 border-slate-800/80'
                }`}
              >
                <span className={isActive ? 'text-cyan-300' : 'text-slate-500'}>{step.num}</span>
                {step.icon}
              </button>
            );
          })}
        </nav>
      </aside>
    );
  }

  return (
    <aside className="w-[360px] lg:w-[400px] h-full bg-slate-950 border-r border-slate-800 flex flex-col shrink-0 overflow-hidden">
      {/* Scrollable Container */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2.5">
        {/* Global Error Alert Banner */}
        {error && (
          <div className="p-3 bg-rose-950/80 border border-rose-800 rounded-xl text-xs text-rose-200 flex flex-col gap-2 animate-in fade-in-50 shadow-lg shadow-rose-950/40">
            <div className="flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div className="flex-1 whitespace-pre-wrap leading-relaxed">{error}</div>
              <button
                type="button"
                onClick={() => setError(null)}
                className="text-rose-400 hover:text-rose-200 p-0.5 rounded cursor-pointer shrink-0"
                title="アラートを閉じる"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex items-center gap-2 pl-6">
              <button
                type="button"
                onClick={() => {
                  const current = useVTAStore.getState();
                  const md = debugRecorder.exportAIDiagnostics(current.scenarioText, error);
                  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
                    void navigator.clipboard.writeText(md);
                  }
                  current.showToast('success', 'AI診断データをクリップボードにコピーしました（Claude/ChatGPT用）');
                }}
                className="inline-flex items-center gap-1 px-2 py-1 rounded bg-rose-900 hover:bg-rose-800 text-rose-100 border border-rose-700 text-[11px] font-medium cursor-pointer transition-colors shadow-sm"
                title="ClaudeやChatGPTに貼り付けてエラー調査を依頼できるMarkdown診断データをコピーします"
              >
                <Sparkles className="w-3 h-3 text-amber-300" />
                <span>AI診断データをコピー (Claude/ChatGPT用)</span>
              </button>
            </div>
          </div>
        )}

        {/* Workflow Step Navigation Bar */}
        <nav
          aria-label="VTA分析ワークフローステップ"
          className="grid grid-cols-3 gap-1 bg-slate-900/95 border border-slate-800 p-1 rounded-xl shadow-inner"
        >
          {steps.map((step) => {
            const isActive = workflowStep === step.id;
            return (
              <button
                key={step.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                onClick={() => setWorkflowStep(step.id)}
                title={step.title}
                className={`flex items-center justify-center gap-1 px-1.5 py-2 rounded-lg text-[11px] font-semibold transition-all cursor-pointer min-w-0 ${
                  isActive
                    ? 'bg-cyan-950/90 text-cyan-200 border border-cyan-600/80 shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60 border border-transparent'
                }`}
              >
                <span className={isActive ? 'text-cyan-400 font-bold' : 'text-slate-500'}>{step.num}</span>
                <span className="truncate">{step.label}</span>
                {step.badge !== undefined && (
                  <span
                    className={`px-1 py-0.2 rounded-full text-[9px] font-mono border shrink-0 ${step.badgeColor}`}
                  >
                    {step.badge}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Active Step Content (Mounted with hidden attribute to preserve internal state) */}
        <ScenarioInputSection />

        <div
          hidden={workflowStep !== 'measures'}
          className={workflowStep === 'measures' ? 'space-y-3' : 'hidden'}
        >
          <MeasuresStatusSection />
          <ResultsSection />
        </div>

        {/* Compact Collapsible Status & Execution Log Footer */}
        <DebugLogsSection />
      </div>
    </aside>
  );
};
