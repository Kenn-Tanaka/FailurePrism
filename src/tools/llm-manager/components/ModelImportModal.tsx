import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  Brain,
  Check,
  CheckSquare,
  Download,
  Globe,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import {
  classifyModel,
  KNOWN_LLM_CONSUMER_TOOLS,
  ManagedModelEntry,
  ModelProviderId,
  normalizeImportedModelId,
  validateModelId,
} from '../../../shared/llm/modelTypes';
import {
  DiscoveredGatewayModel,
  ModelCatalogSourceId,
  OPENROUTER_PUBLIC_API_URL,
} from '../services/gatewayModels';

export interface ModelImportModalProps {
  isOpen: boolean;
  isActive: boolean;
  registeredIds: Set<string>;
  discoveredModels: DiscoveredGatewayModel[] | null;
  activeSourceId: ModelCatalogSourceId;
  customCatalogUrl: string;
  onCustomCatalogUrlChange: (url: string) => void;
  isFetching: boolean;
  fetchError: string | null;
  lastFetchedAt: string | null;
  onFetchFromSource: (
    sourceId: ModelCatalogSourceId,
    options?: { customUrl?: string; upstreamApiKey?: string }
  ) => void;
  onBulkImport: (
    entries: Array<Omit<ManagedModelEntry, 'order'>>,
    conflictStrategy: 'skip' | 'overwrite'
  ) => void;
  onClose: () => void;
}

const PAGE_STEP = 120;

const PROVIDER_TABS: ReadonlyArray<{ key: 'all' | ModelProviderId; label: string }> = [
  { key: 'all', label: 'すべて' },
  { key: 'google', label: 'Google (Gemini)' },
  { key: 'anthropic', label: 'Anthropic (Claude)' },
  { key: 'openai', label: 'OpenAI (GPT/o系)' },
  { key: 'deepseek', label: 'DeepSeek' },
  { key: 'qwen', label: 'Qwen' },
  { key: 'local', label: 'ローカルLLM' },
  { key: 'other', label: 'その他' },
];

export const ModelImportModal: React.FC<ModelImportModalProps> = ({
  isOpen,
  isActive,
  registeredIds,
  discoveredModels,
  activeSourceId,
  customCatalogUrl,
  onCustomCatalogUrlChange,
  isFetching,
  fetchError,
  lastFetchedAt,
  onFetchFromSource,
  onBulkImport,
  onClose,
}) => {
  const [sourceTab, setSourceTab] = useState<ModelCatalogSourceId>(activeSourceId);
  const [ephemeralUpstreamKey, setEphemeralUpstreamKey] = useState('');

  // Prefix & Default Flags (Recommended defaults: isRecommended=false, isPreset=false, openrouter/ prefix ON for openrouter)
  const [applyPrefix, setApplyPrefix] = useState<boolean>(activeSourceId === 'openrouter');
  const [prefixText, setPrefixText] = useState<string>('openrouter');
  const [importAsRecommended, setImportAsRecommended] = useState<boolean>(false);
  const [importAsPreset, setImportAsPreset] = useState<boolean>(false);
  const [targetTools, setTargetTools] = useState<string[]>(['tpdd', 'vta']);
  const [conflictStrategy, setConflictStrategy] = useState<'skip' | 'overwrite'>('skip');
  const [includeUpstreamDescription, setIncludeUpstreamDescription] = useState<boolean>(true);

  // Filter & Selection states
  const [searchQuery, setSearchQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState<'all' | ModelProviderId>('all');
  const [onlyUnregistered, setOnlyUnregistered] = useState(true);
  const [excludeBatch, setExcludeBatch] = useState(true);
  const [onlyReasoning, setOnlyReasoning] = useState(false);
  const [visibleLimit, setVisibleLimit] = useState(PAGE_STEP);
  const [selectedRawIds, setSelectedRawIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!isOpen) return;
    setSourceTab(activeSourceId);
    setApplyPrefix(activeSourceId === 'openrouter');
    setVisibleLimit(PAGE_STEP);
  }, [isOpen, activeSourceId]);

  useEffect(() => {
    if (!isOpen || !isActive) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isActive, onClose]);

  const effectivePrefix = applyPrefix ? prefixText.trim() : '';

  const preparedModels = useMemo(() => {
    if (!discoveredModels) return [];
    return discoveredModels.map((raw) => {
      const normalizedId = normalizeImportedModelId(raw.id, {
        gatewayProviderPrefix: effectivePrefix || undefined,
      });
      const classified = classifyModel(normalizedId, raw.name);
      const isReasoning = Boolean(raw.isReasoningHint || classified.isReasoning);
      const isRegistered = registeredIds.has(normalizedId);
      const validId = validateModelId(normalizedId).valid;
      return {
        raw,
        rawId: raw.id,
        normalizedId,
        name: classified.name,
        provider: classified.provider,
        isReasoning,
        isRegistered,
        validId,
      };
    });
  }, [discoveredModels, effectivePrefix, registeredIds]);

  const baseFilteredForCounts = useMemo(() => {
    return preparedModels.filter((item) => {
      if (excludeBatch && item.normalizedId.includes(':batch')) return false;
      if (onlyUnregistered && item.isRegistered) return false;
      if (onlyReasoning && !item.isReasoning) return false;
      return true;
    });
  }, [preparedModels, excludeBatch, onlyUnregistered, onlyReasoning]);

  const providerCounts = useMemo(() => {
    const counts: Record<string, number> = {
      all: baseFilteredForCounts.length,
      google: 0,
      anthropic: 0,
      openai: 0,
      deepseek: 0,
      qwen: 0,
      local: 0,
      other: 0,
    };
    for (const m of baseFilteredForCounts) {
      counts[m.provider] = (counts[m.provider] || 0) + 1;
    }
    return counts;
  }, [baseFilteredForCounts]);

  const filteredModels = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return baseFilteredForCounts.filter((m) => {
      if (providerFilter !== 'all' && m.provider !== providerFilter) return false;
      if (q) {
        const hitId = m.normalizedId.toLowerCase().includes(q) || m.rawId.toLowerCase().includes(q);
        const hitName = m.name.toLowerCase().includes(q);
        const hitDesc = m.raw.description ? m.raw.description.toLowerCase().includes(q) : false;
        if (!hitId && !hitName && !hitDesc) return false;
      }
      return true;
    });
  }, [baseFilteredForCounts, providerFilter, searchQuery]);

  const selectableFiltered = useMemo(
    () =>
      filteredModels.filter(
        (m) => m.validId && (conflictStrategy === 'overwrite' || !m.isRegistered)
      ),
    [filteredModels, conflictStrategy]
  );

  const selectedImportableItems = useMemo(
    () =>
      preparedModels.filter(
        (m) =>
          selectedRawIds.has(m.rawId) &&
          m.validId &&
          (conflictStrategy === 'overwrite' || !m.isRegistered)
      ),
    [preparedModels, selectedRawIds, conflictStrategy]
  );

  if (!isOpen || !isActive || typeof document === 'undefined') {
    return null;
  }

  const handleSourceSelect = (nextSource: ModelCatalogSourceId) => {
    setSourceTab(nextSource);
    if (nextSource === 'openrouter') {
      setApplyPrefix(true);
      if (!prefixText.trim()) setPrefixText('openrouter');
    } else if (nextSource === 'gateway' || nextSource === 'vta_cache') {
      setApplyPrefix(false);
    }
  };

  const handleTriggerFetch = () => {
    onFetchFromSource(sourceTab, {
      customUrl: sourceTab === 'custom_https' ? customCatalogUrl : undefined,
      upstreamApiKey: sourceTab === 'custom_https' ? ephemeralUpstreamKey : undefined,
    });
  };

  const toggleItemSelection = (rawId: string, disabled: boolean) => {
    if (disabled) return;
    setSelectedRawIds((prev) => {
      const next = new Set(prev);
      if (next.has(rawId)) {
        next.delete(rawId);
      } else {
        next.add(rawId);
      }
      return next;
    });
  };

  const handleSelectAllFiltered = () => {
    setSelectedRawIds((prev) => {
      const next = new Set(prev);
      for (const item of selectableFiltered) {
        next.add(item.rawId);
      }
      return next;
    });
  };

  const handleClearSelection = () => {
    setSelectedRawIds(new Set());
  };

  const toggleTargetTool = (toolId: string) => {
    setTargetTools((prev) => {
      if (prev.includes(toolId)) {
        if (prev.length <= 1) return prev; // Keep at least 1 tool selected
        return prev.filter((id) => id !== toolId);
      }
      return [...prev, toolId];
    });
  };

  const handleExecuteImport = () => {
    if (selectedImportableItems.length === 0 || targetTools.length === 0) return;

    const fallbackDesc =
      activeSourceId === 'openrouter'
        ? 'OpenRouter公開カタログから取り込んだモデルです。'
        : 'モデル一覧から一括取り込みしたモデルです。';

    const entries: Array<Omit<ManagedModelEntry, 'order'>> = selectedImportableItems.map((item) => ({
      id: item.normalizedId,
      name: item.name,
      provider: item.provider,
      description:
        includeUpstreamDescription && item.raw.description
          ? item.raw.description
          : fallbackDesc,
      isRecommended: importAsRecommended,
      isPreset: importAsPreset,
      isReasoning: item.isReasoning,
      targetTools: [...targetTools],
    }));

    onBulkImport(entries, conflictStrategy);
    setSelectedRawIds(new Set());
    onClose();
  };

  const displayedSlice = filteredModels.slice(0, visibleLimit);

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] bg-black/75 backdrop-blur-sm flex items-center justify-center p-4 overflow-hidden"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="llm-model-import-modal-title"
        className="w-full max-w-5xl max-h-[90vh] rounded-2xl bg-slate-900 border border-slate-700/90 shadow-2xl flex flex-col overflow-hidden text-slate-100"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 bg-slate-950/80 flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-emerald-950 border border-emerald-700/80 text-emerald-400">
              <Download className="w-5 h-5" />
            </div>
            <div>
              <h3 id="llm-model-import-modal-title" className="text-base font-bold text-white flex items-center gap-2">
                <span>利用可能なモデル一覧の取得・一括取込</span>
                {discoveredModels && (
                  <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-slate-800 text-emerald-300 border border-slate-700">
                    取得済 {discoveredModels.length} 件
                  </span>
                )}
              </h3>
              <p className="text-xs text-slate-400">
                OpenRouter 公式API や LLM-Gateway から最新モデル一覧を取得し、必要なモデルを選択してカタログへ一括登録できます
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer"
            aria-label="閉じる"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Source & Fetch Bar */}
        <div className="px-5 py-3.5 border-b border-slate-800 bg-slate-950/50 space-y-3 shrink-0">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 flex-wrap text-xs">
              <span className="text-[11px] font-semibold text-slate-400 mr-1">取得元:</span>
              {(
                [
                  { id: 'openrouter', label: '🌐 OpenRouter 公式カタログ', icon: Globe },
                  { id: 'gateway', label: '🖥️ LLM-Gateway (/v1)', icon: Server },
                  { id: 'custom_https', label: '🔗 カスタム HTTPS URL', icon: Globe },
                  { id: 'vta_cache', label: '🔄 VTA取得済みキャッシュ', icon: RefreshCw },
                ] as const
              ).map((src) => (
                <button
                  key={src.id}
                  type="button"
                  onClick={() => handleSourceSelect(src.id)}
                  className={`px-3 py-1.5 rounded-lg font-medium transition-colors border cursor-pointer ${
                    sourceTab === src.id
                      ? 'bg-emerald-600 border-emerald-500 text-white shadow-sm'
                      : 'bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  {src.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={handleTriggerFetch}
              disabled={isFetching}
              className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-bold flex items-center gap-1.5 shadow-md cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
              <span>
                {isFetching
                  ? '一覧を取得中...'
                  : sourceTab === 'vta_cache'
                  ? 'VTAキャッシュから読込'
                  : '最新モデル一覧を取得'}
              </span>
            </button>
          </div>

          {sourceTab === 'openrouter' && (
            <div className="flex items-center justify-between gap-2 flex-wrap text-[11px] text-slate-400 bg-slate-900/70 border border-slate-800 rounded-lg px-3 py-1.5">
              <span>
                取得先: <code className="font-mono text-emerald-300">{OPENROUTER_PUBLIC_API_URL}/models</code>（認証不要の公開カタログ）
              </span>
              <span className="flex items-center gap-1 text-emerald-400">
                <ShieldCheck className="w-3.5 h-3.5" />
                <span>Gateway Tokenは外部へ送信されません</span>
              </span>
            </div>
          )}

          {sourceTab === 'custom_https' && (
            <div className="grid grid-cols-1 md:grid-cols-12 gap-2 text-xs bg-slate-900/70 border border-slate-800 rounded-xl p-2.5">
              <div className="md:col-span-7">
                <label className="block text-[11px] text-slate-400 mb-1">
                  OpenAI互換 API ベースURL (https:// のみ)
                </label>
                <input
                  type="text"
                  value={customCatalogUrl}
                  onChange={(e) => onCustomCatalogUrlChange(e.target.value)}
                  placeholder="https://openrouter.ai/api/v1"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-slate-100 focus:outline-none focus:border-emerald-500"
                />
              </div>
              <div className="md:col-span-5">
                <label className="block text-[11px] text-slate-400 mb-1">
                  一時APIキー (任意・保存されません)
                </label>
                <input
                  type="password"
                  value={ephemeralUpstreamKey}
                  onChange={(e) => setEphemeralUpstreamKey(e.target.value)}
                  placeholder="公開エンドポイントの場合は空欄"
                  className="w-full bg-slate-950 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs font-mono text-slate-100 focus:outline-none focus:border-emerald-500"
                />
              </div>
            </div>
          )}

          {fetchError && (
            <div className="p-2.5 rounded-lg bg-rose-950/70 border border-rose-800 text-rose-200 text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
              <span>{fetchError}</span>
            </div>
          )}

          {/* Import Transformation & Initial Flag Settings */}
          <div className="p-2.5 rounded-xl bg-slate-900/90 border border-slate-800 flex flex-wrap items-center justify-between gap-3 text-xs">
            <div className="flex items-center gap-3 flex-wrap">
              <label className="flex items-center gap-1.5 cursor-pointer select-none text-slate-200">
                <input
                  type="checkbox"
                  checked={applyPrefix}
                  onChange={(e) => setApplyPrefix(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-950 text-emerald-500"
                />
                <span>Gatewayプレフィックス付与:</span>
              </label>
              <input
                type="text"
                value={prefixText}
                disabled={!applyPrefix}
                onChange={(e) => setPrefixText(e.target.value)}
                aria-label="Gatewayプレフィックス"
                className="w-28 bg-slate-950 border border-slate-700 disabled:opacity-40 rounded-md px-2 py-1 text-xs font-mono text-emerald-300 focus:outline-none focus:border-emerald-500"
                placeholder="openrouter"
              />

              <span className="text-slate-700">|</span>

              <span className="text-[11px] text-slate-400">初期フラグ:</span>
              <label className="flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={importAsRecommended}
                  onChange={(e) => setImportAsRecommended(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-950 text-amber-500"
                />
                <span className="text-amber-200">推奨ON</span>
              </label>

              <label className="flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={importAsPreset}
                  onChange={(e) => setImportAsPreset(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-950 text-emerald-500"
                />
                <span className="text-emerald-200">クイック切替ON</span>
              </label>

              <div className="flex items-center gap-1">
                {KNOWN_LLM_CONSUMER_TOOLS.map((tool) => {
                  const active = targetTools.includes(tool.id);
                  return (
                    <button
                      key={tool.id}
                      type="button"
                      onClick={() => toggleTargetTool(tool.id)}
                      className={`px-2 py-0.5 rounded border text-[10px] font-semibold cursor-pointer ${
                        active
                          ? 'bg-cyan-950/80 border-cyan-600/80 text-cyan-200'
                          : 'bg-slate-950 border-slate-700 text-slate-500'
                      }`}
                    >
                      {tool.id.toUpperCase()}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap text-[11px]">
              <label className="flex items-center gap-1.5 cursor-pointer select-none text-slate-300">
                <input
                  type="checkbox"
                  checked={includeUpstreamDescription}
                  onChange={(e) => setIncludeUpstreamDescription(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-950 text-emerald-500"
                />
                <span>説明文を取込</span>
              </label>

              <select
                aria-label="重複モデルの扱い"
                value={conflictStrategy}
                onChange={(e) => setConflictStrategy(e.target.value as 'skip' | 'overwrite')}
                className="bg-slate-950 border border-slate-700 rounded-md px-2 py-1 text-[11px] text-slate-200 cursor-pointer"
              >
                <option value="skip">登録済はスキップ</option>
                <option value="overwrite">登録済を上書き更新</option>
              </select>
            </div>
          </div>
        </div>

        {/* Filter & Selection Toolbar */}
        <div className="px-5 py-3 border-b border-slate-800 bg-slate-900/80 space-y-2.5 shrink-0">
          <div className="flex flex-col md:flex-row md:items-center gap-2.5">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setVisibleLimit(PAGE_STEP);
                }}
                placeholder="モデル名やIDで絞り込み（例: gemini-2.5, claude, sonnet, gpt-4.1, deepseek, qwen）..."
                className="w-full bg-slate-950 border border-slate-700 rounded-xl pl-9 pr-8 py-1.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-white cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="flex items-center gap-3 flex-wrap text-xs text-slate-300">
              <label className="flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={onlyUnregistered}
                  onChange={(e) => setOnlyUnregistered(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-950 text-emerald-500"
                />
                <span>未登録のみ</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={excludeBatch}
                  onChange={(e) => setExcludeBatch(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-950 text-emerald-500"
                />
                <span>:batch 除外</span>
              </label>
              <label className="flex items-center gap-1.5 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={onlyReasoning}
                  onChange={(e) => setOnlyReasoning(e.target.checked)}
                  className="rounded border-slate-700 bg-slate-950 text-purple-500"
                />
                <span>🧠 思考モデルのみ</span>
              </label>
            </div>
          </div>

          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5 text-[11px]">
              {PROVIDER_TABS.map((tab) => (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => {
                    setProviderFilter(tab.key);
                    setVisibleLimit(PAGE_STEP);
                  }}
                  className={`px-2.5 py-1 rounded-lg font-medium shrink-0 cursor-pointer transition-colors ${
                    providerFilter === tab.key
                      ? 'bg-emerald-600 text-white'
                      : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  <span>{tab.label}</span>
                  <span className="ml-1 opacity-75 font-mono">({providerCounts[tab.key] || 0})</span>
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2 text-xs">
              <button
                type="button"
                onClick={handleSelectAllFiltered}
                disabled={selectableFiltered.length === 0}
                className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-emerald-300 border border-slate-700 text-[11px] font-medium cursor-pointer"
              >
                表示中をすべて選択 ({selectableFiltered.length}件)
              </button>
              {selectedRawIds.size > 0 && (
                <button
                  type="button"
                  onClick={handleClearSelection}
                  className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-[11px] cursor-pointer"
                >
                  選択解除
                </button>
              )}
            </div>
          </div>
        </div>

        {/* Model List Grid */}
        <div className="flex-1 overflow-y-auto p-4 bg-slate-950/40">
          {!discoveredModels ? (
            <div className="text-center py-14 space-y-3 text-xs text-slate-400">
              <p className="text-sm font-semibold text-slate-200">
                まだモデル一覧を取得していません
              </p>
              <p>
                上部の「OpenRouter 公式カタログ」や「LLM-Gateway (/v1)」を選択し、
                <strong>「最新モデル一覧を取得」</strong>をクリックしてください。
              </p>
            </div>
          ) : filteredModels.length === 0 ? (
            <div className="text-center py-12 text-xs text-slate-500">
              条件に一致するモデルがありません。検索語や「未登録のみ」フィルタを調整してください。
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                {displayedSlice.map((item) => {
                  const isDisabled =
                    !item.validId || (item.isRegistered && conflictStrategy === 'skip');
                  const isChecked = !isDisabled && selectedRawIds.has(item.rawId);

                  return (
                    <div
                      key={item.rawId}
                      onClick={() => toggleItemSelection(item.rawId, isDisabled)}
                      className={`p-3 rounded-xl border transition-all flex items-start gap-2.5 ${
                        isDisabled
                          ? 'bg-slate-950/40 border-slate-800/60 opacity-60 cursor-not-allowed'
                          : isChecked
                          ? 'bg-emerald-950/35 border-emerald-500/80 ring-1 ring-emerald-500/60 cursor-pointer'
                          : 'bg-slate-900/90 border-slate-800 hover:border-slate-600 cursor-pointer'
                      }`}
                    >
                      <div className="pt-0.5 text-emerald-400 shrink-0">
                        {isChecked ? (
                          <CheckSquare className="w-4 h-4" />
                        ) : (
                          <Square className="w-4 h-4 text-slate-500" />
                        )}
                      </div>

                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                            <span className="text-xs font-bold text-slate-100 truncate">
                              {item.name}
                            </span>
                            <span className="px-1.5 py-0.5 rounded text-[9px] uppercase font-bold bg-slate-800 text-slate-300 border border-slate-700">
                              {item.provider}
                            </span>
                            {item.isReasoning && (
                              <span className="px-1.5 py-0.5 rounded text-[9px] bg-purple-950/80 text-purple-300 border border-purple-700/60 flex items-center gap-0.5">
                                <Brain className="w-2.5 h-2.5" />
                                思考
                              </span>
                            )}
                          </div>

                          {item.isRegistered && (
                            <span className="px-1.5 py-0.5 rounded bg-slate-800 text-emerald-300 border border-slate-700 text-[10px] flex items-center gap-1 shrink-0">
                              <Check className="w-3 h-3" />
                              登録済
                            </span>
                          )}
                        </div>

                        <div className="font-mono text-[11px] text-emerald-300/90 break-all">
                          {item.normalizedId}
                        </div>

                        {item.raw.contextLength && (
                          <div className="text-[10px] text-slate-400">
                            Context: {item.raw.contextLength.toLocaleString()} tokens
                          </div>
                        )}

                        {item.raw.description && (
                          <p className="text-[11px] text-slate-400 line-clamp-2 leading-relaxed">
                            {item.raw.description}
                          </p>
                        )}

                        {!item.validId && (
                          <p className="text-[10px] text-amber-300">
                            ※ &lt;provider&gt;/&lt;model&gt; 形式にするためプレフィックス付与を有効にしてください
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {filteredModels.length > visibleLimit && (
                <div className="flex items-center justify-center gap-3 pt-2">
                  <button
                    type="button"
                    onClick={() => setVisibleLimit((prev) => prev + PAGE_STEP)}
                    className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold cursor-pointer"
                  >
                    さらに {Math.min(PAGE_STEP, filteredModels.length - visibleLimit)} 件表示（表示中{' '}
                    {displayedSlice.length} / {filteredModels.length} 件）
                  </button>
                  <button
                    type="button"
                    onClick={() => setVisibleLimit(filteredModels.length)}
                    className="px-3 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-800 text-xs cursor-pointer"
                  >
                    全件表示
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 border-t border-slate-800 bg-slate-950/90 flex flex-wrap items-center justify-between gap-3 text-xs shrink-0">
          <div className="flex items-center gap-3 text-slate-400">
            <span>
              選択中:{' '}
              <strong className="text-emerald-300 font-mono">
                {selectedImportableItems.length}
              </strong>{' '}
              件
            </span>
            {lastFetchedAt && (
              <span className="text-[11px] text-slate-500">最終取得: {lastFetchedAt}</span>
            )}
            <span className="text-[11px] flex items-center gap-1 text-slate-400">
              <Sparkles className="w-3 h-3 text-amber-400" />
              <span>
                推奨:{importAsRecommended ? 'ON' : 'OFF'} / クイック切替:
                {importAsPreset ? 'ON' : 'OFF'}
              </span>
            </span>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium cursor-pointer"
            >
              キャンセル
            </button>
            <button
              type="button"
              onClick={handleExecuteImport}
              disabled={selectedImportableItems.length === 0}
              className="px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-bold flex items-center gap-1.5 shadow-md cursor-pointer"
            >
              <Download className="w-4 h-4" />
              <span>選択した {selectedImportableItems.length} 件をカタログへ取り込む</span>
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
