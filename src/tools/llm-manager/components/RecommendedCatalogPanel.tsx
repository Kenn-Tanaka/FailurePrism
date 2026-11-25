import React, { useEffect, useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Brain,
  CheckCircle2,
  CheckSquare,
  Download,
  Edit3,
  Plus,
  Search,
  Send,
  Sparkles,
  Square,
  Trash2,
  Zap,
} from 'lucide-react';
import {
  KNOWN_LLM_CONSUMER_TOOLS,
  ManagedLLMRegistryState,
  ManagedModelEntry,
  ModelProviderId,
} from '../../../shared/llm/modelTypes';

export interface RecommendedCatalogPanelProps {
  state: ManagedLLMRegistryState;
  discoveredIds: Set<string> | null;
  pingingModelId: string | null;
  onAddModelClick: () => void;
  onOpenImportModalClick: () => void;
  onEditModelClick: (model: ManagedModelEntry) => void;
  onUpsertModel: (entry: ManagedModelEntry) => void;
  onDeleteModel: (modelId: string) => void;
  onBulkDeleteModels: (modelIds: string[]) => void;
  onBulkUpdateFlags: (
    modelIds: string[],
    patch: Partial<Pick<ManagedModelEntry, 'isRecommended' | 'isPreset'>>
  ) => void;
  onMoveModel: (modelId: string, direction: -1 | 1) => void;
  onSetDefaultModel: (modelId: string, toolId?: string) => void;
  onPingModel: (modelId: string) => void;
}

type FilterMode = 'all' | 'recommended' | 'unrecommended' | 'preset' | 'tpdd' | 'vta' | 'reasoning';

const CATALOG_PAGE_STEP = 100;

export const RecommendedCatalogPanel: React.FC<RecommendedCatalogPanelProps> = ({
  state,
  discoveredIds,
  pingingModelId,
  onAddModelClick,
  onOpenImportModalClick,
  onEditModelClick,
  onUpsertModel,
  onDeleteModel,
  onBulkDeleteModels,
  onBulkUpdateFlags,
  onMoveModel,
  onSetDefaultModel,
  onPingModel,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [providerFilter, setProviderFilter] = useState<'all' | ModelProviderId>('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [visibleLimit, setVisibleLimit] = useState<number>(CATALOG_PAGE_STEP);

  // Prune stale selected IDs when catalog changes
  useEffect(() => {
    const validSet = new Set(state.models.map((m) => m.id));
    setSelectedIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (validSet.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [state.models]);

  const activeDefaultIdSet = useMemo(() => {
    const ids = new Set<string>();
    if (state.defaultModelId) ids.add(state.defaultModelId);
    for (const val of Object.values(state.toolDefaultModelIds)) {
      if (val) ids.add(val);
    }
    return ids;
  }, [state.defaultModelId, state.toolDefaultModelIds]);

  const filteredModels = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return state.models.filter((m) => {
      if (filterMode === 'recommended' && !m.isRecommended) return false;
      if (filterMode === 'unrecommended' && m.isRecommended) return false;
      if (filterMode === 'preset' && !m.isPreset) return false;
      if (filterMode === 'tpdd' && !m.targetTools.includes('tpdd')) return false;
      if (filterMode === 'vta' && !m.targetTools.includes('vta')) return false;
      if (filterMode === 'reasoning' && !m.isReasoning) return false;
      if (providerFilter !== 'all' && m.provider !== providerFilter) return false;
      if (q) {
        const hit =
          m.id.toLowerCase().includes(q) ||
          m.name.toLowerCase().includes(q) ||
          m.description.toLowerCase().includes(q) ||
          m.provider.toLowerCase().includes(q);
        if (!hit) return false;
      }
      return true;
    });
  }, [state.models, filterMode, providerFilter, searchQuery]);

  const counts = useMemo(
    () => ({
      all: state.models.length,
      recommended: state.models.filter((m) => m.isRecommended).length,
      unrecommended: state.models.filter((m) => !m.isRecommended).length,
      preset: state.models.filter((m) => m.isPreset).length,
      tpdd: state.models.filter((m) => m.targetTools.includes('tpdd')).length,
      vta: state.models.filter((m) => m.targetTools.includes('vta')).length,
      reasoning: state.models.filter((m) => m.isReasoning).length,
    }),
    [state.models]
  );

  const toggleTargetTool = (model: ManagedModelEntry, toolId: string) => {
    const exists = model.targetTools.includes(toolId);
    if (exists && model.targetTools.length <= 1) return;
    const nextTools = exists
      ? model.targetTools.filter((id) => id !== toolId)
      : [...model.targetTools, toolId];
    onUpsertModel({ ...model, targetTools: nextTools });
  };

  const toggleSelectOne = (modelId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) {
        next.delete(modelId);
      } else {
        next.add(modelId);
      }
      return next;
    });
  };

  const handleSelectAllFiltered = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const m of filteredModels) {
        next.add(m.id);
      }
      return next;
    });
  };

  const handleSelectNonDefaultFiltered = () => {
    const next = new Set<string>();
    for (const m of filteredModels) {
      if (!activeDefaultIdSet.has(m.id)) {
        next.add(m.id);
      }
    }
    setSelectedIds(next);
  };

  const handleClearSelection = () => {
    setSelectedIds(new Set());
  };

  const handleTriggerBulkDelete = () => {
    if (selectedIds.size === 0) return;
    onBulkDeleteModels(Array.from(selectedIds));
  };

  const canReorder = filterMode === 'all' && providerFilter === 'all' && !searchQuery.trim();
  const displayedModels = filteredModels.slice(0, visibleLimit);
  const selectedArray = useMemo(() => Array.from(selectedIds), [selectedIds]);

  return (
    <section
      aria-label="推奨LLMカタログ管理"
      className="rounded-2xl bg-slate-900/90 border border-slate-800 p-4 space-y-4 shadow-lg flex flex-col"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-3">
        <div>
          <h2 className="text-sm font-bold text-white flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-amber-400" />
            <span>推奨 LLM・プリセットカタログ ({state.models.length}件)</span>
          </h2>
          <p className="text-[11px] text-slate-400 mt-0.5">
            TPDD / VTA のモデル選択画面やクイック切替ドロップダウンに表示されるモデルを管理します
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap shrink-0">
          <button
            type="button"
            onClick={onOpenImportModalClick}
            className="px-3.5 py-2 rounded-xl bg-cyan-700 hover:bg-cyan-600 text-white text-xs font-semibold flex items-center justify-center gap-1.5 shadow-md cursor-pointer"
          >
            <Download className="w-4 h-4" />
            <span>モデル一覧から一括取込</span>
          </button>

          <button
            type="button"
            onClick={onAddModelClick}
            className="px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center justify-center gap-1.5 shadow-md cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>モデルを新規登録</span>
          </button>
        </div>
      </div>

      {/* 検索 & フィルタ */}
      <div className="space-y-2.5">
        <div className="flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                setVisibleLimit(CATALOG_PAGE_STEP);
              }}
              placeholder="モデル名、ID、プロバイダ、説明で絞り込み..."
              className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500"
            />
          </div>

          <select
            aria-label="プロバイダで絞り込み"
            value={providerFilter}
            onChange={(e) => {
              setProviderFilter(e.target.value as 'all' | ModelProviderId);
              setVisibleLimit(CATALOG_PAGE_STEP);
            }}
            className="bg-slate-950 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-emerald-500 cursor-pointer"
          >
            <option value="all">全プロバイダ</option>
            <option value="google">Google (Gemini)</option>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI (GPT/o系)</option>
            <option value="deepseek">DeepSeek</option>
            <option value="qwen">Qwen</option>
            <option value="local">ローカルLLM</option>
            <option value="other">その他</option>
          </select>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
          {(
            [
              { key: 'all', label: 'すべて', count: counts.all },
              { key: 'recommended', label: '⭐ 推奨', count: counts.recommended },
              { key: 'unrecommended', label: '推奨OFF', count: counts.unrecommended },
              { key: 'preset', label: '⚡ クイック切替', count: counts.preset },
              { key: 'tpdd', label: 'TPDD対象', count: counts.tpdd },
              { key: 'vta', label: 'VTA対象', count: counts.vta },
              { key: 'reasoning', label: '🧠 思考モデル', count: counts.reasoning },
            ] as const
          ).map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => {
                setFilterMode(item.key);
                setVisibleLimit(CATALOG_PAGE_STEP);
              }}
              className={`px-2.5 py-1 rounded-lg font-medium transition-colors cursor-pointer ${
                filterMode === item.key
                  ? 'bg-emerald-600 text-white shadow-sm'
                  : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
              }`}
            >
              {item.label} <span className="opacity-75 font-mono">({item.count})</span>
            </button>
          ))}
        </div>

        {/* 選択・一括操作バー */}
        <div className="p-2.5 rounded-xl bg-slate-950/80 border border-slate-800 flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex items-center gap-1.5 flex-wrap">
            <button
              type="button"
              onClick={handleSelectAllFiltered}
              disabled={filteredModels.length === 0}
              className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 border border-slate-700 text-[11px] cursor-pointer"
            >
              表示中を全選択
            </button>
            <button
              type="button"
              onClick={handleSelectNonDefaultFiltered}
              disabled={filteredModels.length === 0}
              className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-40 text-slate-200 border border-slate-700 text-[11px] cursor-pointer"
              title="共通既定・ツール別既定に設定されているモデルを除いて一括選択します"
            >
              既定モデル以外を選択
            </button>
            {selectedIds.size > 0 && (
              <button
                type="button"
                onClick={handleClearSelection}
                className="px-2.5 py-1 rounded-lg bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-slate-200 border border-slate-800 text-[11px] cursor-pointer"
              >
                選択解除
              </button>
            )}
          </div>

          {selectedIds.size > 0 ? (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-[11px] text-emerald-300 font-semibold mr-1">
                {selectedIds.size} 件選択中:
              </span>
              <button
                type="button"
                onClick={() => onBulkUpdateFlags(selectedArray, { isRecommended: true })}
                className="px-2 py-1 rounded-lg bg-amber-950/70 hover:bg-amber-900/80 text-amber-200 border border-amber-700/70 text-[11px] cursor-pointer"
              >
                推奨ON
              </button>
              <button
                type="button"
                onClick={() => onBulkUpdateFlags(selectedArray, { isRecommended: false })}
                className="px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 border border-slate-700 text-[11px] cursor-pointer"
              >
                推奨OFF
              </button>
              <button
                type="button"
                onClick={handleTriggerBulkDelete}
                disabled={state.models.length <= 1}
                className="px-2.5 py-1 rounded-lg bg-rose-950/80 hover:bg-rose-900 disabled:opacity-40 text-rose-200 border border-rose-700/80 text-[11px] font-semibold flex items-center gap-1 cursor-pointer"
                title={
                  state.models.length <= 1
                    ? '最後の1件は削除できません'
                    : '選択中のモデルをカタログから一括削除します'
                }
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>選択した {selectedIds.size} 件を一括削除</span>
              </button>
            </div>
          ) : (
            <span className="text-[11px] text-slate-500">
              チェックボックスで複数選択して一括削除・推奨切替ができます
            </span>
          )}
        </div>
      </div>

      {/* モデルカード一覧 */}
      <div className="space-y-2.5">
        {filteredModels.length === 0 ? (
          <div className="text-center py-10 text-xs text-slate-500 border border-dashed border-slate-800 rounded-xl">
            条件に一致するモデルがありません。
          </div>
        ) : (
          displayedModels.map((model, idx) => {
            const isGlobalDefault = state.defaultModelId === model.id;
            const isTpddDefault = state.toolDefaultModelIds.tpdd === model.id;
            const isVtaDefault = state.toolDefaultModelIds.vta === model.id;
            const isPresentInGateway = discoveredIds ? discoveredIds.has(model.id) : null;
            const isSelected = selectedIds.has(model.id);

            return (
              <div
                key={model.id}
                className={`p-3.5 rounded-xl border transition-colors space-y-2.5 ${
                  isSelected
                    ? 'bg-cyan-950/25 border-cyan-600/70 ring-1 ring-cyan-600/40'
                    : isGlobalDefault || isTpddDefault || isVtaDefault
                    ? 'bg-emerald-950/20 border-emerald-700/60'
                    : 'bg-slate-950/75 border-slate-800 hover:border-slate-700'
                }`}
              >
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
                  <div className="flex items-start gap-2.5 min-w-0">
                    <button
                      type="button"
                      onClick={() => toggleSelectOne(model.id)}
                      aria-label={`${model.name} (${model.id}) を選択`}
                      aria-pressed={isSelected}
                      className="mt-0.5 text-slate-400 hover:text-cyan-300 shrink-0 cursor-pointer"
                    >
                      {isSelected ? (
                        <CheckSquare className="w-4 h-4 text-cyan-400" />
                      ) : (
                        <Square className="w-4 h-4" />
                      )}
                    </button>

                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-xs font-bold text-white">{model.name}</span>
                        <span className="px-1.5 py-0.5 rounded text-[10px] uppercase font-bold bg-slate-800 text-slate-300 border border-slate-700">
                          {model.provider}
                        </span>
                        {isGlobalDefault && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-900/80 text-emerald-200 border border-emerald-600/70">
                            共通既定
                          </span>
                        )}
                        {isTpddDefault && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-900/80 text-blue-200 border border-blue-600/70">
                            TPDD既定
                          </span>
                        )}
                        {isVtaDefault && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-cyan-900/80 text-cyan-200 border border-cyan-600/70">
                            VTA既定
                          </span>
                        )}
                        {model.isReasoning && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] bg-purple-950/80 text-purple-300 border border-purple-700/60 flex items-center gap-1">
                            <Brain className="w-2.5 h-2.5" />
                            思考
                          </span>
                        )}
                        {isPresentInGateway === true && (
                          <span className="px-1.5 py-0.5 rounded text-[10px] bg-emerald-950/60 text-emerald-300 border border-emerald-800/70 flex items-center gap-1">
                            <CheckCircle2 className="w-2.5 h-2.5" />
                            取得一覧に存在
                          </span>
                        )}
                      </div>

                      <div className="font-mono text-[11px] text-slate-400 break-all select-all">
                        {model.id}
                      </div>
                    </div>
                  </div>

                  {/* 並び替え・編集・削除 */}
                  <div className="flex items-center gap-1 shrink-0">
                    {canReorder && (
                      <>
                        <button
                          type="button"
                          onClick={() => onMoveModel(model.id, -1)}
                          disabled={idx === 0}
                          className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-30 text-slate-300 cursor-pointer"
                          title="上へ移動"
                        >
                          <ArrowUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => onMoveModel(model.id, 1)}
                          disabled={idx === filteredModels.length - 1}
                          className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-30 text-slate-300 cursor-pointer"
                          title="下へ移動"
                        >
                          <ArrowDown className="w-3.5 h-3.5" />
                        </button>
                      </>
                    )}
                    <button
                      type="button"
                      onClick={() => onPingModel(model.id)}
                      disabled={pingingModelId === model.id}
                      className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-emerald-300 cursor-pointer"
                      title="疎通テスト (Ping)"
                    >
                      <Send className={`w-3.5 h-3.5 ${pingingModelId === model.id ? 'animate-pulse' : ''}`} />
                    </button>
                    <button
                      type="button"
                      onClick={() => onEditModelClick(model)}
                      className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 cursor-pointer"
                      title="編集"
                    >
                      <Edit3 className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteModel(model.id)}
                      disabled={state.models.length <= 1}
                      className="p-1.5 rounded-lg bg-slate-800 hover:bg-rose-900/80 disabled:opacity-30 text-rose-300 cursor-pointer"
                      title={state.models.length <= 1 ? '最後の1件は削除できません' : 'カタログから削除'}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {model.description && (
                  <p className="text-[11px] text-slate-300 leading-relaxed pl-6">{model.description}</p>
                )}

                {/* クイック属性トグル & 既定モデル割当 */}
                <div className="pt-2 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-2 text-[11px] pl-6">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <button
                      type="button"
                      onClick={() => onUpsertModel({ ...model, isRecommended: !model.isRecommended })}
                      className={`px-2 py-1 rounded-md border flex items-center gap-1 transition-colors cursor-pointer ${
                        model.isRecommended
                          ? 'bg-amber-950/70 border-amber-600/70 text-amber-200'
                          : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      <Sparkles className="w-3 h-3" />
                      <span>推奨 {model.isRecommended ? 'ON' : 'OFF'}</span>
                    </button>

                    <button
                      type="button"
                      onClick={() => onUpsertModel({ ...model, isPreset: !model.isPreset })}
                      className={`px-2 py-1 rounded-md border flex items-center gap-1 transition-colors cursor-pointer ${
                        model.isPreset
                          ? 'bg-emerald-950/70 border-emerald-600/70 text-emerald-200'
                          : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      <Zap className="w-3 h-3" />
                      <span>クイック切替 {model.isPreset ? 'ON' : 'OFF'}</span>
                    </button>

                    {KNOWN_LLM_CONSUMER_TOOLS.map((tool) => {
                      const active = model.targetTools.includes(tool.id);
                      return (
                        <button
                          key={tool.id}
                          type="button"
                          onClick={() => toggleTargetTool(model, tool.id)}
                          className={`px-2 py-1 rounded-md border text-[10px] font-semibold transition-colors cursor-pointer ${
                            active
                              ? tool.id === 'tpdd'
                                ? 'bg-blue-950/70 border-blue-600/70 text-blue-200'
                                : 'bg-cyan-950/70 border-cyan-600/70 text-cyan-200'
                              : 'bg-slate-900 border-slate-700 text-slate-500 hover:text-slate-300'
                          }`}
                        >
                          {tool.id.toUpperCase()}
                        </button>
                      );
                    })}
                  </div>

                  <div className="flex items-center gap-1.5">
                    {!isGlobalDefault && (
                      <button
                        type="button"
                        onClick={() => onSetDefaultModel(model.id)}
                        className="px-2 py-1 rounded-md bg-slate-800 hover:bg-emerald-700 text-slate-200 hover:text-white border border-slate-700 text-[10px] font-medium cursor-pointer"
                      >
                        共通既定に設定
                      </button>
                    )}
                    {!isTpddDefault && (
                      <button
                        type="button"
                        onClick={() => onSetDefaultModel(model.id, 'tpdd')}
                        className="px-2 py-1 rounded-md bg-slate-800 hover:bg-blue-700 text-slate-200 hover:text-white border border-slate-700 text-[10px] font-medium cursor-pointer"
                      >
                        TPDD既定に
                      </button>
                    )}
                    {!isVtaDefault && (
                      <button
                        type="button"
                        onClick={() => onSetDefaultModel(model.id, 'vta')}
                        className="px-2 py-1 rounded-md bg-slate-800 hover:bg-cyan-700 text-slate-200 hover:text-white border border-slate-700 text-[10px] font-medium cursor-pointer"
                      >
                        VTA既定に
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}

        {filteredModels.length > visibleLimit && (
          <div className="flex items-center justify-center gap-3 pt-2">
            <button
              type="button"
              onClick={() => setVisibleLimit((prev) => prev + CATALOG_PAGE_STEP)}
              className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-semibold cursor-pointer"
            >
              さらに表示（表示中 {displayedModels.length} / {filteredModels.length} 件）
            </button>
            <button
              type="button"
              onClick={() => setVisibleLimit(filteredModels.length)}
              className="px-3 py-2 rounded-xl bg-slate-950 hover:bg-slate-900 text-slate-400 hover:text-slate-200 border border-slate-800 text-xs cursor-pointer"
            >
              全件表示
            </button>
          </div>
        )}
      </div>
    </section>
  );
};
