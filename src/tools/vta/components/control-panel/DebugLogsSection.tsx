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

  const [showLogs, setShowLogs] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const prevLogCountRef = useRef(logs.length);

  // Auto-expand when a new error log arrives so errors are never hidden
  useEffect(() => {
    if (logs.length > prevLogCountRef.current) {
      const latest = logs[logs.length - 1];
      if (latest?.type === 'error') {
        setShowLogs(true);
      }
    }
    prevLogCountRef.current = logs.length;
  }, [logs]);

  // Auto-scroll logs when expanded
  useEffect(() => {
    if (showLogs && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, showLogs]);

  const latestLog = logs.length > 0 ? logs[logs.length - 1] : null;

  return (
    <section className="bg-slate-900/75 border border-slate-800 rounded-xl px-3 py-2 space-y-2 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setShowLogs(!showLogs)}
          aria-expanded={showLogs}
          className="flex items-center gap-1.5 text-xs font-semibold text-slate-300 hover:text-cyan-300 cursor-pointer min-w-0 flex-1 text-left"
        >
          {showLogs ? (
            <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          )}
          <Terminal className="w-3.5 h-3.5 text-amber-400 shrink-0" />
          <span className="shrink-0">実行・通信ログ</span>
          <span className="text-[10px] font-mono px-1.5 py-0.2 rounded-full bg-slate-800 text-slate-300 border border-slate-700 shrink-0">
            {logs.length}
          </span>
          {!showLogs && latestLog && (
            <span
              className={`text-[10px] font-mono truncate ${
                latestLog.type === 'error'
                  ? 'text-rose-300'
                  : latestLog.type === 'warn'
                    ? 'text-amber-300'
                    : latestLog.type === 'success'
                      ? 'text-emerald-300'
                      : 'text-slate-400'
              }`}
              title={latestLog.message}
            >
              {latestLog.message}
            </span>
          )}
        </button>

        {showLogs && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                const current = useVTAStore.getState();
                const md = debugRecorder.exportAIDiagnostics(current.scenarioText, current.error ?? undefined, {
                  profile: 'standard',
                  scope: 'latest_run',
                });
                if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
                  void navigator.clipboard.writeText(md);
                }
                current.showToast('success', 'AI診断データをクリップボードにコピーしました（Claude/ChatGPT用）');
              }}
              className="text-[10px] text-emerald-400 hover:text-emerald-200 flex items-center gap-1 cursor-pointer font-medium"
              title="ClaudeやChatGPTに貼り付け可能な構造化AI診断サマリー（直近実行・標準）をコピー"
            >
              <Sparkles className="w-3 h-3 text-amber-300" />
              <span>AI診断</span>
            </button>
            <button
              type="button"
              onClick={() => {
                const current = useVTAStore.getState();
                const md = debugRecorder.exportAIDiagnostics(current.scenarioText, current.error ?? undefined, {
                  profile: 'deep',
                  scope: 'latest_run',
                });
                if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
                  void navigator.clipboard.writeText(md);
                }
                current.showToast('success', 'AI詳細監査データ（全イベント台帳・除外監査付き）をコピーしました');
              }}
              className="text-[10px] text-indigo-400 hover:text-indigo-200 flex items-center gap-1 cursor-pointer font-medium"
              title="有効イベント全台帳・除外イベント・未参照危険段落を含む詳細AI監査パッケージをコピー"
            >
              <span>詳細監査</span>
            </button>
            <button
              type="button"
              onClick={() => {
                const text = logs.map((l) => `[${l.timestamp}] [${l.type}] ${l.message}`).join('\n');
                if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
                  void navigator.clipboard.writeText(text);
                }
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
        <div className="space-y-2 pt-1">
          <div className="bg-slate-950 border border-slate-800 rounded-lg p-2.5 font-mono text-[10px] max-h-[200px] overflow-y-auto space-y-1.5 select-text">
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

          <details className="rounded-lg border border-slate-800 bg-slate-950/60 px-2.5 py-1.5 text-[11px] text-slate-400">
            <summary className="cursor-pointer select-none font-medium text-slate-300 hover:text-cyan-300">
              デバッグ記録設定・詳細出力
            </summary>
            <div className="pt-2">
              <DebugRecordingControls />
            </div>
          </details>
        </div>
      )}
    </section>
  );
};
