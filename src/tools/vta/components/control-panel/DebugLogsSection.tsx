import React, { useState, useRef, useEffect } from 'react';
import {
  Terminal,
  ChevronDown,
  ChevronRight,
  Copy,
  Trash2,
  Sparkles,
} from 'lucide-react';
import { useVTAStore } from '../../features/vta/store/vtaStore';
import { debugRecorder } from '../../services/debugRecorder';
import { DebugRecordingControls } from './DebugRecordingControls';

export const DebugLogsSection: React.FC = () => {
  const logs = useVTAStore((state) => state.logs);
  const clearLogs = useVTAStore((state) => state.clearLogs);

  const [showLogs, setShowLogs] = useState(true);
  const logsEndRef = useRef<HTMLDivElement>(null);

  // Auto-scroll logs when new entries appear
  useEffect(() => {
    if (showLogs && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, showLogs]);

  return (
    <section className="bg-slate-900/80 border border-slate-800 rounded-xl p-3.5 space-y-2 shadow-md">
      <DebugRecordingControls />
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={() => setShowLogs(!showLogs)}
          className="flex items-center gap-2 text-xs font-semibold text-slate-200 hover:text-cyan-300 cursor-pointer"
        >
          <Terminal className="w-4 h-4 text-amber-400" />
          <span>実行・通信ログ ({logs.length})</span>
          {showLogs ? <ChevronDown className="w-3 h-3 text-slate-400" /> : <ChevronRight className="w-3 h-3 text-slate-400" />}
        </button>

        {showLogs && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                const current = useVTAStore.getState();
                const md = debugRecorder.exportAIDiagnostics(current.scenarioText, current.error ?? undefined);
                navigator.clipboard.writeText(md);
                current.showToast('success', 'AI診断データをクリップボードにコピーしました（Claude/ChatGPT用）');
              }}
              className="text-[10px] text-emerald-400 hover:text-emerald-200 flex items-center gap-1 cursor-pointer font-medium"
              title="ClaudeやChatGPTに貼り付け可能な構造化AI診断サマリー（約3,000トークン）をコピー"
            >
              <Sparkles className="w-3 h-3 text-amber-300" />
              <span>AI診断コピー</span>
            </button>
            <button
              type="button"
              onClick={() => {
                const text = logs.map((l) => `[${l.timestamp}] [${l.type}] ${l.message}`).join('\n');
                navigator.clipboard.writeText(text);
              }}
              className="text-[10px] text-slate-400 hover:text-slate-200 flex items-center gap-1 cursor-pointer"
              title="全ログをコピー"
            >
              <Copy className="w-3 h-3" />
              <span>コピー</span>
            </button>
            <button
              type="button"
              onClick={clearLogs}
              className="text-[10px] text-slate-400 hover:text-rose-300 flex items-center gap-1 cursor-pointer"
              title="ログをクリア"
            >
              <Trash2 className="w-3 h-3" />
              <span>クリア</span>
            </button>
          </div>
        )}
      </div>

      {showLogs && (
        <div className="bg-slate-950 border border-slate-800 rounded-lg p-2.5 font-mono text-[10px] max-h-[220px] overflow-y-auto space-y-1.5 select-text">
          {logs.length === 0 ? (
            <div className="text-slate-600 italic">ログはありません。</div>
          ) : (
            logs.map((log) => (
              <div key={log.id} className="leading-tight flex items-start gap-1.5 border-b border-slate-900/80 pb-1 last:border-0 last:pb-0">
                <span className="text-slate-500 shrink-0 select-none">[{log.timestamp}]</span>
                {log.stageTag && (
                  <span className="shrink-0 text-[9px] px-1 py-0.2 rounded bg-cyan-950 text-cyan-300 border border-cyan-800/80 font-semibold select-none">
                    {log.stageTag}
                  </span>
                )}
                <span
                  className={`shrink-0 uppercase text-[9px] px-1 rounded select-none ${
                    log.type === 'success'
                      ? 'bg-emerald-950 text-emerald-400 border border-emerald-800'
                      : log.type === 'error'
                      ? 'bg-rose-950 text-rose-400 border border-rose-800'
                      : log.type === 'warn'
                      ? 'bg-amber-950 text-amber-400 border border-amber-800'
                      : 'bg-slate-800 text-slate-300'
                  }`}
                >
                  {log.type}
                </span>
                <span
                  className={`break-all ${
                    log.type === 'success'
                      ? 'text-emerald-300'
                      : log.type === 'error'
                      ? 'text-rose-300'
                      : log.type === 'warn'
                      ? 'text-amber-300'
                      : 'text-slate-300'
                  }`}
                >
                  {log.message}
                </span>
              </div>
            ))
          )}
          <div ref={logsEndRef} />
        </div>
      )}
    </section>
  );
};
