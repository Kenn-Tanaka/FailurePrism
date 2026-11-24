import React, { useMemo, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Brain,
  CheckCircle2,
  Edit3,
  Plus,
  Search,
  Send,
  Sparkles,
  Trash2,
  Zap,
} from 'lucide-react';
import {
  KNOWN_LLM_CONSUMER_TOOLS,
  ManagedLLMRegistryState,
  ManagedModelEntry,
} from '../../../shared/llm/modelTypes';

export interface RecommendedCatalogPanelProps {
  state: ManagedLLMRegistryState;
  discoveredIds: Set<string> | null;
  pingingModelId: string | null;
  onAddModelClick: () => void;
  onEditModelClick: (model: ManagedModelEntry) => void;
  onUpsertModel: (entry: ManagedModelEntry) => void;
  onDeleteModel: (modelId: string) => void;
  onMoveModel: (modelId: string, direction: -1 | 1) => void;
  onSetDefaultModel: (modelId: string, toolId?: string) => void;
  onPingModel: (modelId: string) => void;
}

type FilterMode = 'all' | 'recommended' | 'preset' | 'tpdd' | 'vta' | 'reasoning';

export const RecommendedCatalogPanel: React.FC<RecommendedCatalogPanelProps> = ({
  state,
  discoveredIds,
  pingingModelId,
  onAddModelClick,
  onEditModelClick,
  onUpsertModel,
  onDeleteModel,
  onMoveModel,
  onSetDefaultModel,
  onPingModel,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');

  const filteredModels = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return state.models.filter((m) => {
      if (filterMode === 'recommended' && !m.isRecommended) return false;
      if (filterMode === 'preset' && !m.isPreset) return false;
      if (filterMode === 'tpdd' && !m.targetTools.includes('tpdd')) return false;
      if (filterMode === 'vta' && !m.targetTools.includes('vta')) return false;
      if (filterMode === 'reasoning' && !m.isReasoning) return false;
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
  }, [state.models, filterMode, searchQuery]);

  const counts = useMemo(
    () => ({
      all: state.models.length,
      recommended: state.models.filter((m) => m.isRecommended).length,
      preset: state.models.filter((m) => m.isPreset).length,
      tpdd: state.models.filter((m) => m.targetTools.includes('tpdd')).length,
      vta: state.models.filter((m) => m.targetTools.includes('vta')).length,
      reasoning: state.models.filter((m) => m.isReasoning).length,
    }),
    [state.models]
  );

  const toggleTargetTool = (model: ManagedModelEntry, toolId: string) => {
    const exists = model.targetTools.includes(toolId);
    const nextTools = exists
      ? model.targetTools.filter((id) => id !== toolId)
      : [...model.targetTools, toolId];
    onUpsertModel({ ...model, targetTools: nextTools });
  };

  const canReorder = filterMode === 'all' && !searchQuery.trim();

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

        <button
          type="button"
          onClick={onAddModelClick}
          className="px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-semibold flex items-center justify-center gap-1.5 shadow-md shrink-0 cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>モデルを新規登録</span>
        </button>
      </div>

      {/* 検索 & フィルタ */}
      <div className="space-y-2.5">
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="モデル名、ID、プロバイダ、説明で絞り込み..."
            className="w-full bg-slate-950 border border-slate-800 rounded-xl pl-9 pr-3 py-2 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-emerald-500"
          />
        </div>

        <div className="flex items-center gap-1.5 flex-wrap text-[11px]">
          {(
            [
              { key: 'all', label: 'すべて', count: counts.all },
              { key: 'recommended', label: '⭐ 推奨', count: counts.recommended },
              { key: 'preset', label: '⚡ クイック切替', count: counts.preset },
              { key: 'tpdd', label: 'TPDD対象', count: counts.tpdd },
              { key: 'vta', label: 'VTA対象', count: counts.vta },
              { key: 'reasoning', label: '🧠 思考モデル', count: counts.reasoning },
            ] as const
          ).map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setFilterMode(item.key)}
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
      </div>

      {/* モデルカード一覧 */}
      <div className="space-y-2.5">
        {filteredModels.length === 0 ? (
          <div className="text-center py-10 text-xs text-slate-500 border border-dashed border-slate-800 rounded-xl">
            条件に一致するモデルがありません。
          </div>
        ) : (
          filteredModels.map((model, idx) => {
            const isGlobalDefault = state.defaultModelId === model.id;
            const isTpddDefault = state.toolDefaultModelIds.tpdd === model.id;
            const isVtaDefault = state.toolDefaultModelIds.vta === model.id;
            const isPresentInGateway = discoveredIds ? discoveredIds.has(model.id) : null;

            return (
              <div
                key={model.id}
                className={`p-3.5 rounded-xl border transition-colors space-y-2.5 ${
                  isGlobalDefault || isTpddDefault || isVtaDefault
                    ? 'bg-emerald-950/20 border-emerald-700/60'
                    : 'bg-slate-950/75 border-slate-800 hover:border-slate-700'
                }`}
              >
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2">
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
                          Gateway実在
                        </span>
                      )}
                    </div>

                    <div className="font-mono text-[11px] text-slate-400 break-all select-all">
                      {model.id}
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
                  <p className="text-[11px] text-slate-300 leading-relaxed">{model.description}</p>
                )}

                {/* クイック属性トグル & 既定モデル割当 */}
                <div className="pt-2 border-t border-slate-800/80 flex flex-wrap items-center justify-between gap-2 text-[11px]">
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
      </div>
    </section>
  );
};
