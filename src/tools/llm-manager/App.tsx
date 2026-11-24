import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  RefreshCw,
  RotateCcw,
  SlidersHorizontal,
  Upload,
  X,
} from 'lucide-react';
import {
  exportRegistryJson,
  importRegistryJson,
  loadLLMModelSeed,
  moveModelEntry,
  removeModelEntry,
  resetRegistryToSeed,
  setDefaultModelId,
  upsertModelEntry,
} from '../../shared/llm/modelRegistry';
import { classifyModel, ManagedModelEntry } from '../../shared/llm/modelTypes';
import { useLLMRegistry } from '../../shared/llm/useLLMRegistry';
import { DefaultModelsPanel } from './components/DefaultModelsPanel';
import { GatewayDiscoveryPanel } from './components/GatewayDiscoveryPanel';
import { ModelFormModal } from './components/ModelFormModal';
import { RecommendedCatalogPanel } from './components/RecommendedCatalogPanel';
import {
  DiscoveredGatewayModel,
  fetchGatewayModels,
  LLMManagerConnection,
  loadConnectionSettings,
  pingGatewayModel,
  saveConnectionSettings,
} from './services/gatewayModels';

export interface LLMManagerAppProps {
  isActive: boolean;
  gatewayToken: string;
  onGatewayTokenChange: (token: string) => void;
  onBusyChange?: (busy: boolean) => void;
}

interface FeedbackMessage {
  type: 'success' | 'error' | 'info' | 'warning';
  text: string;
}

const SOURCE_LABELS: Record<'user' | 'seed' | 'builtin', { text: string; className: string }> = {
  user: {
    text: 'ユーザー設定 (localStorage)',
    className: 'bg-emerald-950/80 text-emerald-300 border-emerald-700/70',
  },
  seed: {
    text: '配布シード (public/llm-models.json)',
    className: 'bg-blue-950/80 text-blue-300 border-blue-700/70',
  },
  builtin: {
    text: '組み込み既定値',
    className: 'bg-slate-800 text-slate-300 border-slate-700',
  },
};

export const LLMManagerApp: React.FC<LLMManagerAppProps> = ({
  isActive,
  gatewayToken,
  onGatewayTokenChange,
  onBusyChange,
}) => {
  const snapshot = useLLMRegistry();
  const { state, source, seedWarning } = snapshot;

  const [persistedConn, setPersistedConn] = useState(() => loadConnectionSettings());
  const connection: LLMManagerConnection = useMemo(
    () => ({
      ...persistedConn,
      gatewayToken,
    }),
    [persistedConn, gatewayToken]
  );

  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredGatewayModel[] | null>(null);
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [lastFetchedAt, setLastFetchedAt] = useState<string | null>(null);
  const [pingingModelId, setPingingModelId] = useState<string | null>(null);
  const [isReloadingSeed, setIsReloadingSeed] = useState(false);
  const [feedback, setFeedback] = useState<FeedbackMessage | null>(null);

  const [modalState, setModalState] = useState<{
    isOpen: boolean;
    mode: 'create' | 'edit';
    initialModel: Partial<ManagedModelEntry> | null;
  }>({
    isOpen: false,
    mode: 'create',
    initialModel: null,
  });

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void loadLLMModelSeed();
  }, []);

  useEffect(() => {
    onBusyChange?.(isFetchingModels || pingingModelId !== null);
  }, [isFetchingModels, pingingModelId, onBusyChange]);

  const discoveredIds = useMemo(
    () => (discoveredModels ? new Set(discoveredModels.map((m) => m.id)) : null),
    [discoveredModels]
  );
  const registeredIds = useMemo(
    () => new Set(state.models.map((m) => m.id)),
    [state.models]
  );

  const handleConnectionChange = (patch: Partial<LLMManagerConnection>) => {
    if (patch.gatewayToken !== undefined) {
      onGatewayTokenChange(patch.gatewayToken);
    }
    if (patch.gatewayUrl !== undefined || patch.gatewayAuthEnabled !== undefined) {
      const next = {
        gatewayUrl: patch.gatewayUrl ?? persistedConn.gatewayUrl,
        gatewayAuthEnabled: patch.gatewayAuthEnabled ?? persistedConn.gatewayAuthEnabled,
      };
      setPersistedConn(next);
      saveConnectionSettings(next);
    }
  };

  const handleSetDefaultModel = (modelId: string, toolId?: string) => {
    try {
      setDefaultModelId(modelId, toolId);
      setFeedback({
        type: 'success',
        text: toolId
          ? `${toolId.toUpperCase()} のデフォルトLLMを ${modelId || '共通設定の継承'} に更新しました。`
          : `共通デフォルトLLMを ${modelId} に更新しました。`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'デフォルトLLMの更新に失敗しました。',
      });
    }
  };

  const handleUpsertModel = (
    entry: Omit<ManagedModelEntry, 'order'> & { order?: number },
    previousId?: string
  ) => {
    try {
      upsertModelEntry(entry, previousId);
      setFeedback({
        type: 'success',
        text: `モデル「${entry.name}」(${entry.id}) を保存しました。`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'モデルの保存に失敗しました。',
      });
    }
  };

  const handleDeleteModel = (modelId: string) => {
    const target = state.models.find((m) => m.id === modelId);
    const label = target ? `${target.name} (${target.id})` : modelId;
    if (
      typeof window !== 'undefined' &&
      typeof window.confirm === 'function' &&
      !window.confirm(`「${label}」をカタログから削除しますか？`)
    ) {
      return;
    }
    try {
      removeModelEntry(modelId);
      setFeedback({ type: 'info', text: `モデル「${label}」を削除しました。` });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'モデルの削除に失敗しました。',
      });
    }
  };

  const handleFetchModels = async () => {
    setIsFetchingModels(true);
    setFetchError(null);
    try {
      const models = await fetchGatewayModels(connection);
      setDiscoveredModels(models);
      setLastFetchedAt(new Date().toLocaleTimeString());
      setFeedback({
        type: 'success',
        text: `Gateway から ${models.length} 件のモデルを取得しました。`,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setFetchError(msg);
      setFeedback({ type: 'error', text: msg });
    } finally {
      setIsFetchingModels(false);
    }
  };

  const handlePingModel = async (modelId: string) => {
    setPingingModelId(modelId);
    try {
      const res = await pingGatewayModel(connection, modelId);
      setFeedback({
        type: res.success ? 'success' : 'error',
        text: res.success
          ? `疎通成功: ${res.message}`
          : `疎通失敗 (${modelId}): ${res.message}`,
      });
    } finally {
      setPingingModelId(null);
    }
  };

  const handleQuickAddRecommended = (item: DiscoveredGatewayModel) => {
    const classified = classifyModel(item.id, item.name);
    handleUpsertModel({
      id: item.id,
      name: classified.name,
      provider: classified.provider,
      description: 'Gateway経由で取得したモデルです。',
      isRecommended: true,
      isPreset: true,
      isReasoning: classified.isReasoning,
      targetTools: ['tpdd', 'vta'],
    });
  };

  const handleOpenCustomAddFromGateway = (item: DiscoveredGatewayModel) => {
    const classified = classifyModel(item.id, item.name);
    setModalState({
      isOpen: true,
      mode: 'create',
      initialModel: {
        id: item.id,
        name: classified.name,
        provider: classified.provider,
        description: '',
        isRecommended: true,
        isPreset: true,
        isReasoning: classified.isReasoning,
        targetTools: ['tpdd', 'vta'],
      },
    });
  };

  const handleExportJson = () => {
    const json = exportRegistryJson();
    if (typeof document !== 'undefined' && typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
      const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'failureprism-llm-models.json';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    setFeedback({
      type: 'success',
      text: 'LLM設定ファイルをエクスポートしました (failureprism-llm-models.json)。',
    });
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      const res = importRegistryJson(text);
      if (!res.success) {
        setFeedback({ type: 'error', text: res.error || 'インポートに失敗しました。' });
        return;
      }
      setFeedback({
        type: 'success',
        text: `JSONから ${res.state?.models.length ?? 0} 件のモデル定義をインポートしました。`,
      });
    } catch (err) {
      setFeedback({
        type: 'error',
        text: `ファイル読込に失敗しました: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const handleReloadSeed = async () => {
    setIsReloadingSeed(true);
    try {
      const res = await loadLLMModelSeed({ force: true });
      if (res.loadedFromSeedFile) {
        setFeedback({
          type: source === 'user' ? 'info' : 'success',
          text:
            source === 'user'
              ? '配布シード (public/llm-models.json) を再読込しました（現在はユーザー設定が優先されています。「初期設定に戻す」でシード値に切り替えられます）。'
              : '配布シード (public/llm-models.json) を再読込しました。',
        });
      } else {
        setFeedback({
          type: 'warning',
          text: res.warning || '配布シードを読み込めませんでした。',
        });
      }
    } finally {
      setIsReloadingSeed(false);
    }
  };

  const handleResetToSeed = () => {
    if (
      typeof window !== 'undefined' &&
      typeof window.confirm === 'function' &&
      !window.confirm('ユーザーのLLM設定変更を破棄し、配布シード／既定値に戻しますか？')
    ) {
      return;
    }
    resetRegistryToSeed();
    setFeedback({
      type: 'info',
      text: 'ユーザーカスタマイズを解除し、配布シード／組み込み既定値へ復元しました。',
    });
  };

  const sourceBadge = SOURCE_LABELS[source];

  return (
    <div className="flex flex-col flex-1 h-full w-full min-h-0 overflow-hidden bg-slate-950 text-slate-100 select-text">
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        className="hidden"
        onChange={handleImportFile}
      />

      {/* ヘッダー */}
      <header className="px-5 py-3.5 bg-slate-900/95 border-b border-slate-800 flex flex-col lg:flex-row lg:items-center justify-between gap-3 shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-gradient-to-br from-emerald-600 to-teal-600 text-white shadow-md">
            <SlidersHorizontal className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-base font-bold text-white">LLMモデル管理</h1>
              <span
                className={`px-2 py-0.5 rounded-full text-[10px] font-medium border ${sourceBadge.className}`}
              >
                適用元: {sourceBadge.text}
              </span>
            </div>
            <p className="text-xs text-slate-400">
              TPDD-Editor および VTA-Editor のデフォルトLLM・推奨LLMカタログを一元管理します
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap text-xs">
          <button
            type="button"
            onClick={handleReloadSeed}
            disabled={isReloadingSeed}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 flex items-center gap-1.5 cursor-pointer"
            title="public/llm-models.json を再読込"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isReloadingSeed ? 'animate-spin text-emerald-400' : ''}`} />
            <span>シード再読込</span>
          </button>

          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 flex items-center gap-1.5 cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5 text-cyan-400" />
            <span>JSONインポート</span>
          </button>

          <button
            type="button"
            onClick={handleExportJson}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 flex items-center gap-1.5 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5 text-emerald-400" />
            <span>JSONエクスポート</span>
          </button>

          {source === 'user' && (
            <button
              type="button"
              onClick={handleResetToSeed}
              className="px-3 py-1.5 rounded-lg bg-rose-950/70 hover:bg-rose-900/80 text-rose-200 border border-rose-800/80 flex items-center gap-1.5 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>初期設定へ戻す</span>
            </button>
          )}
        </div>
      </header>

      {/* メイン領域 */}
      <main className="flex-1 overflow-y-auto p-5 space-y-4">
        {seedWarning && (
          <div className="p-3 rounded-xl bg-amber-950/60 border border-amber-700/70 text-amber-200 text-xs flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            <span>{seedWarning}</span>
          </div>
        )}

        {feedback && (
          <div
            role="status"
            className={`p-3 rounded-xl border text-xs flex items-center justify-between gap-3 ${
              feedback.type === 'success'
                ? 'bg-emerald-950/60 border-emerald-700/80 text-emerald-200'
                : feedback.type === 'error'
                ? 'bg-rose-950/70 border-rose-800 text-rose-200'
                : feedback.type === 'warning'
                ? 'bg-amber-950/60 border-amber-700/80 text-amber-200'
                : 'bg-slate-900 border-slate-700 text-slate-200'
            }`}
          >
            <div className="flex items-center gap-2">
              {feedback.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              ) : (
                <AlertTriangle className="w-4 h-4 shrink-0" />
              )}
              <span>{feedback.text}</span>
            </div>
            <button
              type="button"
              onClick={() => setFeedback(null)}
              className="p-0.5 hover:bg-white/10 rounded cursor-pointer"
              aria-label="通知を閉じる"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
          <div className="xl:col-span-5 space-y-5">
            <DefaultModelsPanel
              state={state}
              discoveredIds={discoveredIds}
              pingingModelId={pingingModelId}
              onSetDefaultModel={handleSetDefaultModel}
              onPingModel={handlePingModel}
            />

            <GatewayDiscoveryPanel
              connection={connection}
              onConnectionChange={handleConnectionChange}
              discoveredModels={discoveredModels}
              registeredIds={registeredIds}
              isFetching={isFetchingModels}
              fetchError={fetchError}
              lastFetchedAt={lastFetchedAt}
              onFetchModels={handleFetchModels}
              onQuickAddRecommended={handleQuickAddRecommended}
              onOpenCustomAdd={handleOpenCustomAddFromGateway}
            />
          </div>

          <div className="xl:col-span-7">
            <RecommendedCatalogPanel
              state={state}
              discoveredIds={discoveredIds}
              pingingModelId={pingingModelId}
              onAddModelClick={() =>
                setModalState({
                  isOpen: true,
                  mode: 'create',
                  initialModel: null,
                })
              }
              onEditModelClick={(model) =>
                setModalState({
                  isOpen: true,
                  mode: 'edit',
                  initialModel: model,
                })
              }
              onUpsertModel={(entry) => handleUpsertModel(entry)}
              onDeleteModel={handleDeleteModel}
              onMoveModel={(id, dir) => moveModelEntry(id, dir)}
              onSetDefaultModel={handleSetDefaultModel}
              onPingModel={handlePingModel}
            />
          </div>
        </div>
      </main>

      <ModelFormModal
        isOpen={modalState.isOpen}
        isActive={isActive}
        mode={modalState.mode}
        initialModel={modalState.initialModel}
        existingIds={state.models.map((m) => m.id)}
        onSave={handleUpsertModel}
        onClose={() => setModalState((prev) => ({ ...prev, isOpen: false }))}
      />
    </div>
  );
};
