import React, { useState, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import {
  Search,
  Sparkles,
  Star,
  Check,
  X,
  Cpu,
  RefreshCw,
  Filter,
  CheckCircle2,
  SlidersHorizontal,
  Layers,
  ArrowRight,
} from 'lucide-react';
import { LLMModelOption, DEFAULT_MODELS, classifyModel } from '../features/vta/data/modelCatalog';
import { useVTAStore } from '../features/vta/store/vtaStore';

interface ModelSelectorModalProps {
  isOpen: boolean;
  selectedModel: string;
  onSelectModel: (modelId: string) => void;
  onClose: () => void;
}

const STORAGE_KEY_FAVORITES = 'vta_favorite_models';
const STORAGE_KEY_DISCOVERED = 'vta_discovered_models';

export const ModelSelectorModal: React.FC<ModelSelectorModalProps> = ({
  isOpen,
  selectedModel,
  onSelectModel,
  onClose,
}) => {
  const { llmConfig, addLog } = useVTAStore();

  const [models, setModels] = useState<LLMModelOption[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_DISCOVERED);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) return parsed;
      }
    } catch {}
    return DEFAULT_MODELS;
  });

  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_FAVORITES);
      if (saved) {
        return JSON.parse(saved);
      }
    } catch {}
    return [
      'openrouter/anthropic/claude-3.7-sonnet',
      'openrouter/deepseek/deepseek-r1',
      'openrouter/google/gemini-2.0-flash-001',
      'openrouter/openai/gpt-4o',
    ];
  });

  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [excludeBatch, setExcludeBatch] = useState<boolean>(true);
  const [isFetching, setIsFetching] = useState<boolean>(false);
  const [fetchMessage, setFetchMessage] = useState<string | null>(null);

  // Toggle favorite
  const toggleFavorite = (modelId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setFavorites((prev) => {
      const next = prev.includes(modelId) ? prev.filter((id) => id !== modelId) : [...prev, modelId];
      try {
        localStorage.setItem(STORAGE_KEY_FAVORITES, JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  // Fetch live models from Gateway
  const handleFetchFromGateway = async () => {
    setIsFetching(true);
    setFetchMessage('Gatewayからモデル一覧を取得中...');
    const startTime = performance.now();

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    try {
      const endpoint = `${llmConfig.baseUrl.replace(/\/+$/, '')}/models`;
      const headers: Record<string, string> = {};
      if (llmConfig.gatewayToken && llmConfig.gatewayToken.trim().length > 0) {
        headers['Authorization'] = `Bearer ${llmConfig.gatewayToken.trim()}`;
      }

      const res = await fetch(endpoint, { headers, signal: controller.signal });
      clearTimeout(timeoutId);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }

      const data = await res.json();
      if (!data.data || !Array.isArray(data.data)) {
        throw new Error('モデルデータの形式が無効です');
      }

      const classified: LLMModelOption[] = data.data.map((item: any) =>
        classifyModel(item.id, item.name)
      );

      // Merge with default local models if not present
      DEFAULT_MODELS.forEach((def) => {
        if (!classified.some((m) => m.id === def.id)) {
          classified.push(def);
        }
      });

      setModels(classified);
      try {
        localStorage.setItem(STORAGE_KEY_DISCOVERED, JSON.stringify(classified));
      } catch {}

      const elapsed = Math.round(performance.now() - startTime);
      setFetchMessage(`✔ ${classified.length}件のモデルを取得完了 (${elapsed}ms)`);
      addLog('success', `[モデル一覧取得] Gatewayから${classified.length}件のモデルを取得しました (${elapsed}ms)`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setFetchMessage(`✖ 取得失敗: ${msg}`);
      addLog('error', `[モデル一覧取得失敗] ${msg}`);
    } finally {
      setIsFetching(false);
    }
  };

  // Filter models
  const filteredModels = useMemo(() => {
    return models.filter((m) => {
      // 1. Batch filter
      if (excludeBatch && m.id.includes(':batch')) {
        return false;
      }

      // 2. Category filter
      if (selectedCategory === 'recommended' && !m.isRecommended && !favorites.includes(m.id)) {
        return false;
      }
      if (selectedCategory === 'favorites' && !favorites.includes(m.id)) {
        return false;
      }
      if (
        selectedCategory !== 'all' &&
        selectedCategory !== 'recommended' &&
        selectedCategory !== 'favorites' &&
        m.provider !== selectedCategory
      ) {
        return false;
      }

      // 3. Search query
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        const matchId = m.id.toLowerCase().includes(q);
        const matchName = m.name.toLowerCase().includes(q);
        const matchDesc = m.description ? m.description.toLowerCase().includes(q) : false;
        if (!matchId && !matchName && !matchDesc) return false;
      }

      return true;
    });
  }, [models, selectedCategory, searchQuery, excludeBatch, favorites]);

  // Provider counts
  const counts = useMemo(() => {
    const list = excludeBatch ? models.filter((m) => !m.id.includes(':batch')) : models;
    return {
      all: list.length,
      recommended: list.filter((m) => m.isRecommended || favorites.includes(m.id)).length,
      favorites: list.filter((m) => favorites.includes(m.id)).length,
      anthropic: list.filter((m) => m.provider === 'anthropic').length,
      deepseek: list.filter((m) => m.provider === 'deepseek').length,
      google: list.filter((m) => m.provider === 'google').length,
      openai: list.filter((m) => m.provider === 'openai').length,
      qwen: list.filter((m) => m.provider === 'qwen').length,
      local: list.filter((m) => m.provider === 'local').length,
    };
  }, [models, excludeBatch, favorites]);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen || typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 bg-black/70 backdrop-blur-sm z-[9999] flex items-center justify-center p-4 overflow-hidden"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-selector-modal-title"
        className="bg-slate-900 border border-slate-700/90 rounded-2xl max-w-4xl w-full max-h-[88vh] shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-150"
      >
        {/* Modal Header */}
        <div className="p-5 border-b border-slate-800 bg-slate-950/70 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-cyan-950 border border-cyan-800 text-cyan-400">
              <Cpu className="w-5 h-5" />
            </div>
            <div>
              <h3 id="model-selector-modal-title" className="font-bold text-base text-slate-100 flex items-center gap-2">
                <span>LLMモデル選択・フィルタ</span>
                <span className="text-xs font-mono px-2 py-0.5 rounded-full bg-slate-800 text-cyan-300 border border-slate-700">
                  {filteredModels.length} / {counts.all}件
                </span>
              </h3>
              <p className="text-xs text-slate-400">
                プロバイダや推論性能・おすすめ度でモデルを絞り込み選択できます
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleFetchFromGateway}
              disabled={isFetching}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-cyan-300 rounded-lg text-xs font-medium transition-colors border border-slate-700 cursor-pointer shadow-sm"
              title="Gatewayから現在利用可能なモデル一覧を再取得"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
              <span>{isFetching ? '取得中...' : 'Gatewayから更新'}</span>
            </button>

            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-800 rounded-lg transition-colors cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Filter Controls Bar */}
        <div className="p-4 border-b border-slate-800 bg-slate-950/40 space-y-3 shrink-0">
          {/* Search Bar & Toggles */}
          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="モデル名やIDで検索（例: sonnet, deepseek, gemini, gpt-4o, flash）..."
                className="w-full bg-slate-900 border border-slate-700 rounded-xl pl-9 pr-8 py-2 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <label className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer select-none px-2 shrink-0">
              <input
                type="checkbox"
                checked={excludeBatch}
                onChange={(e) => setExcludeBatch(e.target.checked)}
                className="rounded border-slate-700 bg-slate-900 text-cyan-600 focus:ring-0 w-3.5 h-3.5"
              />
              <span>バッチモデル (:batch) を除外</span>
            </label>
          </div>

          {/* Category Filter Pills */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs">
            {[
              { key: 'all', label: 'すべて', count: counts.all },
              { key: 'recommended', label: '⭐ 推奨モデル', count: counts.recommended },
              { key: 'favorites', label: '📌 お気に入り', count: counts.favorites },
              { key: 'anthropic', label: 'Anthropic (Claude)', count: counts.anthropic },
              { key: 'deepseek', label: 'DeepSeek', count: counts.deepseek },
              { key: 'google', label: 'Google (Gemini)', count: counts.google },
              { key: 'openai', label: 'OpenAI (GPT)', count: counts.openai },
              { key: 'qwen', label: 'Qwen', count: counts.qwen },
              { key: 'local', label: '💻 ローカルLLM', count: counts.local },
            ].map((cat) => (
              <button
                key={cat.key}
                type="button"
                onClick={() => setSelectedCategory(cat.key)}
                className={`px-3 py-1.5 rounded-lg font-medium transition-all shrink-0 cursor-pointer ${
                  selectedCategory === cat.key
                    ? 'bg-cyan-600 text-white shadow-md shadow-cyan-950/40'
                    : 'bg-slate-800/80 text-slate-400 hover:text-slate-200 hover:bg-slate-700/80'
                }`}
              >
                <span>{cat.label}</span>
                <span className="ml-1.5 text-[10px] opacity-75 font-mono">({cat.count})</span>
              </button>
            ))}
          </div>

          {fetchMessage && (
            <div className="text-[11px] text-slate-400 bg-slate-950/80 px-3 py-1.5 rounded-lg border border-slate-800 flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-cyan-400" />
              <span>{fetchMessage}</span>
            </div>
          )}
        </div>

        {/* Model Cards Grid */}
        <div className="flex-1 p-5 overflow-y-auto grid grid-cols-1 md:grid-cols-2 gap-3">
          {filteredModels.length === 0 ? (
            <div className="col-span-2 text-center py-12 text-slate-500 text-xs">
              条件に一致するモデルが見つかりませんでした。「Gatewayから更新」または検索条件を変更してください。
            </div>
          ) : (
            filteredModels.map((m) => {
              const isCurrent = m.id === selectedModel;
              const isFav = favorites.includes(m.id);

              return (
                <div
                  key={m.id}
                  onClick={() => {
                    onSelectModel(m.id);
                    onClose();
                  }}
                  className={`p-3.5 rounded-xl border transition-all cursor-pointer flex flex-col justify-between group ${
                    isCurrent
                      ? 'bg-cyan-950/40 border-cyan-500/90 ring-1 ring-cyan-500 shadow-md shadow-cyan-950/30'
                      : 'bg-slate-950/80 border-slate-800 hover:border-slate-600 hover:bg-slate-900/90'
                  }`}
                >
                  <div>
                    {/* Card Top: Badges & Favorite */}
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        {/* Provider Badge */}
                        <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded-md bg-slate-800 text-slate-300 border border-slate-700">
                          {m.provider}
                        </span>

                        {m.isRecommended && (
                          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-amber-950/80 text-amber-300 border border-amber-500/60 flex items-center gap-1">
                            <Sparkles className="w-2.5 h-2.5" />
                            推奨
                          </span>
                        )}

                        {m.isReasoning && (
                          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-purple-950/80 text-purple-300 border border-purple-500/60">
                            🧠 思考モデル
                          </span>
                        )}
                      </div>

                      {/* Favorite Button */}
                      <button
                        type="button"
                        onClick={(e) => toggleFavorite(m.id, e)}
                        className={`p-1 rounded hover:bg-slate-800 transition-colors ${
                          isFav ? 'text-amber-400' : 'text-slate-600 hover:text-slate-400'
                        }`}
                        title={isFav ? 'お気に入りから外す' : 'お気に入りに追加'}
                      >
                        <Star className="w-4 h-4 fill-current" />
                      </button>
                    </div>

                    {/* Model Name & ID */}
                    <h4 className="font-bold text-sm text-slate-100 mb-0.5 group-hover:text-cyan-300 transition-colors">
                      {m.name}
                    </h4>
                    <p className="text-[11px] font-mono text-slate-400 truncate mb-2">
                      {m.id}
                    </p>

                    {/* Description if any */}
                    {m.description && (
                      <p className="text-xs text-slate-300 leading-relaxed bg-slate-900/60 p-2 rounded-lg border border-slate-800/80 mb-3">
                        {m.description}
                      </p>
                    )}
                  </div>

                  {/* Card Bottom: Selection Status */}
                  <div className="pt-2 border-t border-slate-800/60 flex items-center justify-between text-xs">
                    {isCurrent ? (
                      <span className="flex items-center gap-1 text-cyan-400 font-semibold text-[11px]">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        選択中
                      </span>
                    ) : (
                      <span className="text-[11px] text-slate-500 group-hover:text-cyan-400 transition-colors flex items-center gap-1">
                        <span>クリックして選択</span>
                        <ArrowRight className="w-3 h-3 group-hover:translate-x-0.5 transition-transform" />
                      </span>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Modal Footer */}
        <div className="p-4 border-t border-slate-800 bg-slate-950/80 flex items-center justify-between text-xs shrink-0">
          <span className="text-slate-400 text-[11px]">
            現在の選択: <strong className="font-mono text-cyan-300">{selectedModel}</strong>
          </span>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg transition-colors cursor-pointer"
          >
            閉じる
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
