import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Search,
  Star,
  RefreshCw,
  Check,
  X,
  AlertCircle,
  ThumbsUp,
  Clock,
} from 'lucide-react';
import { gatewayClient } from '../../services/llm/gatewayClient';
import { LlmConnection, LlmModelOption } from '../../services/llm/types';
import { getModelMetadata } from './modelCatalog';
import { loadAppSettings, saveAppSettings } from '../../services/persistence/appStorage';

interface ModelExploreModalProps {
  isOpen: boolean;
  currentModelId: string;
  connection: LlmConnection;
  onSelect: (modelId: string) => void;
  onClose: () => void;
}

export const ModelExploreModal: React.FC<ModelExploreModalProps> = ({
  isOpen,
  currentModelId,
  connection,
  onSelect,
  onClose,
}) => {
  const [activeTab, setActiveTab] = useState<'all' | 'favorites'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCandidateId, setSelectedCandidateId] = useState<string>(currentModelId);

  // 取得状態
  const [fetchedModels, setFetchedModels] = useState<LlmModelOption[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [lastFetchTime, setLastFetchTime] = useState<string | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);

  // お気に入りIDリスト
  const [favorites, setFavorites] = useState<string[]>(() => loadAppSettings().favoriteModelIds);

  const abortControllerRef = useRef<AbortController | null>(null);

  // 一覧取得
  const fetchModels = async (isRefetch = false) => {
    if (isLoading) return;

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsLoading(true);
    setFetchError(null);

    try {
      const models = await gatewayClient.listModels(connection, controller.signal);
      setFetchedModels(models);
      setLastFetchTime(new Date().toLocaleTimeString());
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setFetchError(err instanceof Error ? err.message : String(err));
      // 再取得失敗時は前回のリストを保持する (仕様書 8.4.3)
      if (!isRefetch) {
        setFetchedModels([]);
      }
    } finally {
      setIsLoading(false);
    }
  };

  // モーダルオープン時に初回取得
  useEffect(() => {
    if (isOpen) {
      setSelectedCandidateId(currentModelId);
      setSearchQuery('');
      setFavorites(loadAppSettings().favoriteModelIds);
      if (fetchedModels.length === 0 && !isLoading && !lastFetchTime) {
        fetchModels(false);
      }
    } else {
      // 仕様書 8.4.3 / M08: モーダルを閉じる場合、取得用リクエストを取り消す
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // お気に入りの切り替え
  const toggleFavorite = (e: React.MouseEvent, modelId: string) => {
    e.stopPropagation();
    let next: string[];
    if (favorites.includes(modelId)) {
      next = favorites.filter((id) => id !== modelId);
    } else {
      next = [...favorites, modelId];
    }
    setFavorites(next);
    saveAppSettings({ favoriteModelIds: next });
  };

  // 表示モデルの加工・結合
  const displayedModels = useMemo(() => {
    const fetchedIds = new Set(fetchedModels.map((m) => m.id));
    const allKnownIds = new Set<string>();

    if (activeTab === 'all') {
      // 取得済み一覧を基本とし、選択中モデルも表示対象に含める
      fetchedModels.forEach((m) => allKnownIds.add(m.id));
      if (selectedCandidateId) allKnownIds.add(selectedCandidateId);
    } else {
      // お気に入りタブ: 登録済みのお気に入りID一覧
      favorites.forEach((id) => allKnownIds.add(id));
    }

    const list = Array.from(allKnownIds).map((id) => {
      const meta = getModelMetadata(id);
      const isPresentInGateway = fetchedIds.has(id);
      const isFav = favorites.includes(id);

      return {
        id,
        ...meta,
        isPresentInGateway,
        isFav,
      };
    });

    // 検索フィルター (ローカル絞り込み)
    const q = searchQuery.trim().toLowerCase();
    const filtered = q
      ? list.filter((m) => m.id.toLowerCase().includes(q) || m.displayName.toLowerCase().includes(q))
      : list;

    // ソート: 推奨モデルとお気に入りを優先
    return filtered.sort((a, b) => {
      if (a.isRecommended && !b.isRecommended) return -1;
      if (!a.isRecommended && b.isRecommended) return 1;
      if (a.isFav && !b.isFav) return -1;
      if (!a.isFav && b.isFav) return 1;
      return a.displayName.localeCompare(b.displayName);
    });
  }, [fetchedModels, activeTab, favorites, searchQuery, selectedCandidateId]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleCommitSelection = () => {
    if (selectedCandidateId) {
      onSelect(selectedCandidateId);
    }
    onClose();
  };

  return createPortal(
    <div
      className="fixed inset-0 bg-slate-900/40 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-2xl border border-slate-200 w-full max-w-2xl overflow-hidden flex flex-col h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div className="px-5 py-3.5 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Search className="w-4 h-4 text-blue-600" />
            <h2 className="text-sm font-bold text-slate-800">モデル詳細選択・探索</h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 p-1 rounded">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* サブバー: タブ・検索・再取得 */}
        <div className="px-5 py-3 border-b border-slate-200 space-y-2.5 bg-white">
          <div className="flex items-center justify-between gap-3">
            {/* タブ */}
            <div className="flex bg-slate-100 p-0.5 rounded-lg text-xs font-medium">
              <button
                onClick={() => setActiveTab('all')}
                className={`px-3 py-1 rounded-md transition-colors ${
                  activeTab === 'all' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                すべて ({fetchedModels.length})
              </button>
              <button
                onClick={() => setActiveTab('favorites')}
                className={`px-3 py-1 rounded-md flex items-center gap-1 transition-colors ${
                  activeTab === 'favorites' ? 'bg-white text-blue-600 shadow-sm' : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                お気に入り ({favorites.length})
              </button>
            </div>

            {/* 再取得ボタン */}
            <button
              onClick={() => fetchModels(true)}
              disabled={isLoading}
              className="px-2.5 py-1 text-xs border border-slate-300 hover:bg-slate-50 rounded text-slate-700 flex items-center gap-1.5 disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isLoading ? 'animate-spin text-blue-600' : ''}`} />
              <span>{isLoading ? '取得中...' : '再取得'}</span>
            </button>
          </div>

          {/* 検索バー */}
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="モデル名またはモデルIDで検索..."
              className="w-full pl-8 pr-3 py-1.5 text-xs border border-slate-300 rounded focus:outline-blue-500"
            />
          </div>

          {lastFetchTime && (
            <div className="text-[10px] text-slate-400 flex items-center gap-1">
              <Clock className="w-3 h-3" />
              <span>Gateway取得時刻: {lastFetchTime}</span>
              {fetchError && <span className="text-red-500 ml-2">（最新の再取得に失敗しました）</span>}
            </div>
          )}
        </div>

        {/* モデル一覧エリア */}
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {/* 初回取得中のローディング */}
          {isLoading && fetchedModels.length === 0 && (
            <div className="text-center py-12 text-slate-500 text-xs flex flex-col items-center gap-2">
              <RefreshCw className="w-6 h-6 animate-spin text-blue-600" />
              <span>Gatewayからモデル一覧を取得中...</span>
            </div>
          )}

          {/* エラー表示 */}
          {fetchError && fetchedModels.length === 0 && (
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-xs space-y-2">
              <div className="flex items-center gap-1.5 font-bold">
                <AlertCircle className="w-4 h-4" />
                <span>モデル一覧の取得に失敗しました</span>
              </div>
              <p className="text-[11px] leading-relaxed">{fetchError}</p>
              <button
                onClick={() => fetchModels(false)}
                className="px-3 py-1 bg-red-600 hover:bg-red-700 text-white rounded text-xs font-medium"
              >
                再試行
              </button>
            </div>
          )}

          {/* 0件状態の表示 */}
          {!isLoading && !fetchError && displayedModels.length === 0 && (
            <div className="text-center py-12 text-slate-400 text-xs">
              {searchQuery ? (
                <span>検索条件に一致するモデルがありません。</span>
              ) : activeTab === 'favorites' ? (
                <span>星マークでお気に入りに登録できます。</span>
              ) : (
                <span>Gateway到達、利用可能モデルなし（allowlistまたはロード状態を確認してください）。</span>
              )}
            </div>
          )}

          {/* モデル行 */}
          {displayedModels.map((m) => {
            const isSelected = selectedCandidateId === m.id;

            return (
              <div
                key={m.id}
                onClick={() => setSelectedCandidateId(m.id)}
                className={`p-3 rounded-lg border text-xs cursor-pointer transition-colors flex items-start justify-between gap-3 ${
                  isSelected
                    ? 'border-blue-500 bg-blue-50/50 shadow-sm ring-1 ring-blue-400'
                    : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50/50 bg-white'
                }`}
              >
                <div className="space-y-1 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-bold text-slate-800 text-[13px]">{m.displayName}</span>
                    {m.isRecommended && (
                      <span className="bg-amber-100 text-amber-800 text-[10px] px-1.5 py-0.5 rounded font-medium flex items-center gap-0.5">
                        <ThumbsUp className="w-2.5 h-2.5" />
                        推奨
                      </span>
                    )}
                    {!m.isPresentInGateway && (
                      <span className="bg-slate-100 text-slate-500 text-[10px] px-1.5 py-0.5 rounded border border-slate-200">
                        今回の取得一覧にありません
                      </span>
                    )}
                  </div>

                  <div className="font-mono text-[11px] text-slate-500 break-all select-all">
                    {m.id}
                  </div>

                  <p className="text-[11px] text-slate-600 leading-relaxed pt-0.5">
                    {m.description}
                  </p>
                </div>

                {/* お気に入り星ボタン */}
                <button
                  type="button"
                  onClick={(e) => toggleFavorite(e, m.id)}
                  className="p-1 hover:bg-slate-100 rounded text-slate-300 hover:text-amber-400 transition-colors flex-shrink-0"
                  title={m.isFav ? 'お気に入りから解除' : 'お気に入りに登録'}
                >
                  <Star
                    className={`w-4 h-4 ${
                      m.isFav ? 'fill-amber-400 text-amber-400' : 'text-slate-300'
                    }`}
                  />
                </button>
              </div>
            );
          })}
        </div>

        {/* フッター */}
        <div className="px-5 py-3.5 bg-slate-50 border-t border-slate-200 flex items-center justify-between">
          <div className="text-xs text-slate-600 truncate max-w-[320px]">
            選択中: <strong className="font-mono text-slate-800">{selectedCandidateId || '未選択'}</strong>
          </div>

          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-3.5 py-1.5 border border-slate-300 rounded text-xs text-slate-600 hover:bg-slate-100"
            >
              閉じる
            </button>
            <button
              onClick={handleCommitSelection}
              disabled={!selectedCandidateId}
              className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white rounded text-xs font-medium flex items-center gap-1.5 shadow-sm"
            >
              <Check className="w-3.5 h-3.5" />
              このモデルを選択
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
