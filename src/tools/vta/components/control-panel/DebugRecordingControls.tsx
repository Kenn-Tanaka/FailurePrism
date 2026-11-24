import React, { useSyncExternalStore } from 'react';
import { debugRecorder } from '../../services/debugRecorder';
import { useVTAStore } from '../../features/vta/store/vtaStore';

export function DebugRecordingControls({ compact = false }: { compact?: boolean }) {
  const state = useSyncExternalStore(
    debugRecorder.subscribe,
    debugRecorder.getSnapshot,
    debugRecorder.getSnapshot
  );
  const hasAnyEntries = state.count > 0 || state.flightCount > 0;

  const save = () => {
    const current = useVTAStore.getState();
    const text = debugRecorder.exportText({
      deduplicate: true,
      scenarioText: current.scenarioText,
      lastError: current.error ?? undefined,
    });
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `FailurePrism-debug-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const copyDiagnostics = (profile: 'standard' | 'deep' = 'standard') => {
    const current = useVTAStore.getState();
    const md = debugRecorder.exportAIDiagnostics(current.scenarioText, current.error ?? undefined, {
      profile,
      scope: 'latest_run',
    });
    navigator.clipboard.writeText(md);
    current.showToast(
      'success',
      profile === 'deep'
        ? 'AI詳細監査データ（全イベント台帳・除外監査付き）をコピーしました'
        : 'AI診断データをクリップボードにコピーしました（Claude/ChatGPT用）'
    );
  };

  if (compact) {
    return state.enabled ? (
      <button
        type="button"
        onClick={() => debugRecorder.setEnabled(false)}
        className="text-xs rounded border border-rose-500 bg-rose-950 px-2 py-1 text-rose-200 shrink-0"
        title="クリックしてデバッグ記録を停止"
      >
        ● デバッグ記録中・停止
      </button>
    ) : null;
  }

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-950 p-2 space-y-2 text-xs">
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={state.enabled}
          onChange={(e) => {
            debugRecorder.setEnabled(e.target.checked);
            if (e.target.checked) {
              const current = useVTAStore.getState();
              debugRecorder.record(
                'recording.start',
                () => ({
                  projectId: current.currentProjectId,
                  scenarioText: current.scenarioText,
                  schema: current.vtaData,
                }),
                undefined,
                [current.llmConfig.gatewayToken ?? '']
              );
            }
          }}
        />
        デバッグログを記録する
      </label>
      <div role="status" className={state.enabled ? 'text-rose-300' : 'text-slate-400'}>
        {state.enabled ? '● 記録中' : '記録OFF'}・{state.count}件
        <span className="ml-1.5 text-[10px] text-emerald-400/90">
          （常時軽量診断: {state.flightCount}件）
        </span>
      </div>
      <p className="text-[10px] text-slate-400">
        軽量診断ログ（イベント・主体統合・除外監査）は常時この画面のメモリ内のみに保持され、事後でもAI診断コピーが可能です。原文・プロンプト・LLM生応答も含める場合はチェックをONにしてください。
      </p>
      {(state.dropped > 0 || state.truncated > 0 || state.flightDropped > 0) && (
        <p className="text-amber-300">
          容量制限：古い記録の破棄 {state.dropped + state.flightDropped}件、長文の省略 {state.truncated}件
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={!hasAnyEntries}
          onClick={save}
          className="rounded border border-cyan-700 bg-cyan-950 px-2 py-1 text-cyan-200 disabled:opacity-40"
          title="重複排除された軽量デバッグJSONを保存"
        >
          デバッグログを保存
        </button>
        <button
          type="button"
          disabled={!hasAnyEntries}
          onClick={() => copyDiagnostics('standard')}
          className="rounded border border-emerald-700 bg-emerald-950 px-2 py-1 text-emerald-200 disabled:opacity-40"
          title="ClaudeやChatGPTに貼り付け可能な構造化AI診断サマリー（直近実行・標準）をコピー"
        >
          📋 AI診断コピー
        </button>
        <button
          type="button"
          disabled={!hasAnyEntries}
          onClick={() => copyDiagnostics('deep')}
          className="rounded border border-indigo-700 bg-indigo-950 px-2 py-1 text-indigo-200 disabled:opacity-40"
          title="有効イベント全台帳・除外イベント・未参照危険段落を含む詳細AI監査パッケージをコピー"
        >
          🔍 AI詳細監査コピー
        </button>
        <button
          type="button"
          disabled={!hasAnyEntries}
          onClick={() => debugRecorder.clear()}
          className="rounded border border-slate-600 bg-slate-800 px-2 py-1 disabled:opacity-40"
        >
          記録を消去
        </button>
      </div>
    </div>
  );
}
