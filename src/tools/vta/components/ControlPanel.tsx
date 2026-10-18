import React from 'react';
import { AlertCircle, X } from 'lucide-react';
import { useVTAStore } from '../features/vta/store/vtaStore';
import { LLMConfigSection } from './control-panel/LLMConfigSection';
import { ScenarioInputSection } from './control-panel/ScenarioInputSection';
import { MeasuresStatusSection } from './control-panel/MeasuresStatusSection';
import { ResultsSection } from './control-panel/ResultsSection';
import { DebugLogsSection } from './control-panel/DebugLogsSection';

export const ControlPanel: React.FC = () => {
  const error = useVTAStore((state) => state.error);
  const setError = useVTAStore((state) => state.setError);

  return (
    <aside className="w-[420px] lg:w-[480px] h-full bg-slate-950 border-r border-slate-800 flex flex-col shrink-0 overflow-hidden">
      {/* Scrollable Container */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Global Error Alert Banner */}
        {error && (
          <div className="p-3 bg-rose-950/80 border border-rose-800 rounded-xl text-xs text-rose-200 flex items-start gap-2 animate-in fade-in-50 shadow-lg shadow-rose-950/40">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <div className="flex-1 whitespace-pre-wrap leading-relaxed">{error}</div>
            <button
              type="button"
              onClick={() => setError(null)}
              className="text-rose-400 hover:text-rose-200 p-0.5 rounded cursor-pointer"
              title="アラートを閉じる"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {/* Section 1: LLM Gateway Connection Config */}
        <LLMConfigSection />

        {/* Section 2: Scenario Input & Document Parsing */}
        <ScenarioInputSection />

        {/* Section 3: Measures Status & Scenario Regeneration */}
        <MeasuresStatusSection />

        {/* Section 4: Generated Results Display (Markdown / JSON) */}
        <ResultsSection />

        {/* Section 5: Real-time Debug & Communication Logs */}
        <DebugLogsSection />
      </div>
    </aside>
  );
};
