import React, { useMemo, useState } from 'react';
import {
  AlertCircle,
  Check,
  Download,
  Eye,
  EyeOff,
  Globe,
  Key,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
} from 'lucide-react';
import { classifyModel, normalizeImportedModelId } from '../../../shared/llm/modelTypes';
import {
  DiscoveredGatewayModel,
  LLMManagerConnection,
  ModelCatalogSourceId,
} from '../services/gatewayModels';

export interface GatewayDiscoveryPanelProps {
  connection: LLMManagerConnection;
  onConnectionChange: (patch: Partial<LLMManagerConnection>) => void;
  discoveredModels: DiscoveredGatewayModel[] | null;
  activeSourceId: ModelCatalogSourceId;
  activeSourceLabel: string;
  registeredIds: Set<string>;
  isFetching: boolean;
  fetchError: string | null;
  lastFetchedAt: string | null;
  onFetchModels: () => void;
  onFetchOpenRouterModels: () => void;
  onOpenImportModal: () => void;
  onQuickAddCatalog: (model: DiscoveredGatewayModel, normalizedId: string) => void;
  onQuickAddRecommended: (model: DiscoveredGatewayModel, normalizedId: string) => void;
  onOpenCustomAdd: (model: DiscoveredGatewayModel, normalizedId: string) => void;
}

export const GatewayDiscoveryPanel: React.FC<GatewayDiscoveryPanelProps> = ({
  connection,
  onConnectionChange,
  discoveredModels,
  activeSourceId,
  activeSourceLabel,
  registeredIds,
  isFetching,
  fetchError,
  lastFetchedAt,
  onFetchModels,
  onFetchOpenRouterModels,
  onOpenImportModal,
  onQuickAddCatalog,
  onQuickAddRecommended,
  onOpenCustomAdd,
}) => {
  const [showToken, setShowToken] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [excludeBatch, setExcludeBatch] = useState(true);
  const [onlyUnregistered, setOnlyUnregistered] = useState(true);

  const normalizedList = useMemo(() => {
    if (!discoveredModels) return [];
    const prefix = activeSourceId === 'openrouter' ? 'openrouter' : undefined;
    return discoveredModels.map((m) => {
      const normalizedId = normalizeImportedModelId(m.id, { gatewayProviderPrefix: prefix });
      return { raw: m, normalizedId };
    });
  }, [discoveredModels, activeSourceId]);

  const filteredDiscovered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return normalizedList.filter(({ raw, normalizedId }) => {
      if (excludeBatch && normalizedId.includes(':batch')) return false;
      if (onlyUnregistered && registeredIds.has(normalizedId)) return false;
      if (q) {
        const matchId =
          normalizedId.toLowerCase().includes(q) || raw.id.toLowerCase().includes(q);
        const matchName = raw.name ? raw.name.toLowerCase().includes(q) : false;
        if (!matchId && !matchName) return false;
      }
      return true;
    });
  }, [normalizedList, searchQuery, excludeBatch, onlyUnregistered, registeredIds]);

  return (
    <section
      aria-label="Gateway接続とモデル取得"
      className="rounded-2xl bg-slate-900/90 border border-slate-800 p-4 space-y-3.5 shadow-lg"
    >
      <div className="flex items-center justify-between gap-2 border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-xl bg-slate-950 border border-slate-800 text-emerald-400">
            <Server className="w-4 h-4" />
          </div>
          <div>
            <h2 className="text-sm font-bold text-white">LLM-Gateway 連携・モデル取込</h2>
            <p className="text-[11px] text-slate-400">
              OpenRouter 公式API または稼働中の Gateway (/v1/models) から実在モデルを取得・検証します
            </p>
          </div>
        </div>
      </div>

      {/* 接続設定 */}
      <div className="space-y-2.5 text-xs">
        <div>
          <label className="block text-[11px] text-slate-400 mb-1">Gateway API URL</label>
          <input
            type="text"
            value={connection.gatewayUrl}
            onChange={(e) => onConnectionChange({ gatewayUrl: e.target.value })}
            placeholder="/v1 または http://127.0.0.1:8765/v1"
            className="w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs font-mono text-slate-200 focus:outline-none focus:border-emerald-500"
          />
        </div>

        <div className="p-2.5 rounded-xl bg-slate-950/70 border border-slate-800 space-y-2">
          <label className="flex items-center gap-2 cursor-pointer select-none text-[11px] text-slate-300">
            <input
              type="checkbox"
              checked={connection.gatewayAuthEnabled}
              onChange={(e) => onConnectionChange({ gatewayAuthEnabled: e.target.checked })}
              className="rounded border-slate-700 bg-slate-900 text-emerald-500"
            />
            <span>Gateway Client 認証を使用する（他ツールとメモリ共有）</span>
          </label>

          <div className="space-y-1">
            <div className="flex items-center justify-between text-[11px] text-slate-400">
              <span>Gateway Token (任意 / メモリ限定保持)</span>
              <button
                type="button"
                onClick={() => setShowToken((prev) => !prev)}
                className="flex items-center gap-1 text-[10px] hover:text-white cursor-pointer"
              >
                {showToken ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                <span>{showToken ? '隠す' : '表示'}</span>
              </button>
            </div>
            <div className="relative">
              <input
                type={showToken ? 'text' : 'password'}
                value={connection.gatewayToken}
                onChange={(e) => onConnectionChange({ gatewayToken: e.target.value })}
                placeholder="Bearer トークン"
                className="w-full bg-slate-900 border border-slate-800 rounded-lg pl-7 pr-2.5 py-1.5 text-xs font-mono text-slate-200 focus:outline-none focus:border-emerald-500"
              />
              <Key className="w-3.5 h-3.5 text-slate-500 absolute left-2 top-2" />
            </div>
            <div className="flex items-center gap-1 text-[10px] text-emerald-400/90">
              <ShieldCheck className="w-3 h-3" />
              <span>Tokenは永続ストレージやJSON出力、外部公開APIには送信・保存されません</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onFetchOpenRouterModels}
            disabled={isFetching}
            className="py-2 px-3 rounded-xl bg-cyan-900/70 hover:bg-cyan-800/80 disabled:opacity-50 text-cyan-200 border border-cyan-700/80 font-semibold text-xs flex items-center justify-center gap-1.5 cursor-pointer"
            title="OpenRouter公開モデル一覧APIから最新モデルを取得します"
          >
            <Globe className={`w-3.5 h-3.5 ${isFetching ? 'animate-pulse' : ''}`} />
            <span>OpenRouter 最新一覧を取得</span>
          </button>

          <button
            type="button"
            onClick={onFetchModels}
            disabled={isFetching}
            className="py-2 px-3 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-emerald-300 border border-slate-700 font-semibold text-xs flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isFetching ? 'animate-spin' : ''}`} />
            <span>Gateway から一覧取得</span>
          </button>
        </div>

        <button
          type="button"
          onClick={onOpenImportModal}
          className="w-full py-2 px-3 rounded-xl bg-emerald-700/90 hover:bg-emerald-600 text-white font-semibold text-xs flex items-center justify-center gap-2 shadow-sm cursor-pointer"
        >
          <Download className="w-3.5 h-3.5" />
          <span>モデル一覧の検索・複数選択・一括取込モーダルを開く</span>
        </button>

        {lastFetchedAt && !fetchError && discoveredModels && (
          <div className="text-[11px] text-emerald-300 bg-emerald-950/40 border border-emerald-800/60 px-3 py-1.5 rounded-lg">
            ✔ {activeSourceLabel} から {discoveredModels.length} 件のモデルを取得済（{lastFetchedAt}）
          </div>
        )}

        {fetchError && (
          <div className="text-[11px] text-rose-200 bg-rose-950/70 border border-rose-800 px-3 py-2 rounded-lg flex items-start gap-2">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <span>{fetchError}</span>
          </div>
        )}
      </div>

      {/* 取得済みモデルからの取込一覧 */}
      {discoveredModels && (
        <div className="space-y-2.5 pt-2 border-t border-slate-800">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="取得モデルを検索..."
              className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-8 pr-2.5 py-1.5 text-xs text-slate-100 focus:outline-none focus:border-emerald-500"
            />
          </div>

          <div className="flex items-center justify-between text-[11px] text-slate-300 gap-2 flex-wrap">
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={onlyUnregistered}
                onChange={(e) => setOnlyUnregistered(e.target.checked)}
                className="rounded border-slate-700 bg-slate-900 text-emerald-500"
              />
              <span>未登録のみ表示</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={excludeBatch}
                onChange={(e) => setExcludeBatch(e.target.checked)}
                className="rounded border-slate-700 bg-slate-900 text-emerald-500"
              />
              <span>:batch を除外</span>
            </label>
          </div>

          <div className="max-h-64 overflow-y-auto space-y-1.5 pr-1">
            {filteredDiscovered.length === 0 ? (
              <div className="text-[11px] text-slate-500 text-center py-4">
                表示できるモデルはありません。
              </div>
            ) : (
              filteredDiscovered.slice(0, 60).map(({ raw, normalizedId }) => {
                const isRegistered = registeredIds.has(normalizedId);
                const info = classifyModel(normalizedId, raw.name);
                return (
                  <div
                    key={raw.id}
                    className="p-2 rounded-lg bg-slate-950/80 border border-slate-800 flex items-center justify-between gap-2 text-[11px]"
                  >
                    <div className="min-w-0">
                      <div className="font-semibold text-slate-200 truncate flex items-center gap-1.5">
                        <span className="truncate">{info.name}</span>
                        <span className="text-[9px] uppercase px-1 rounded bg-slate-800 text-slate-400">
                          {info.provider}
                        </span>
                      </div>
                      <div className="font-mono text-[10px] text-slate-400 truncate">
                        {normalizedId}
                      </div>
                    </div>

                    {isRegistered ? (
                      <span className="px-2 py-1 rounded bg-slate-800 text-slate-400 text-[10px] flex items-center gap-1 shrink-0">
                        <Check className="w-3 h-3 text-emerald-400" />
                        登録済
                      </span>
                    ) : (
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => onQuickAddCatalog(raw, normalizedId)}
                          className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-cyan-200 border border-slate-700 text-[10px] font-medium flex items-center gap-1 cursor-pointer"
                          title="推奨OFFでカタログへ追加"
                        >
                          <Plus className="w-3 h-3" />
                          <span>取込</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => onQuickAddRecommended(raw, normalizedId)}
                          className="px-2 py-1 rounded bg-emerald-700 hover:bg-emerald-600 text-white text-[10px] font-semibold flex items-center gap-1 cursor-pointer"
                          title="推奨・クイック切替ONで即座に登録"
                        >
                          <Plus className="w-3 h-3" />
                          <span>推奨追加</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => onOpenCustomAdd(raw, normalizedId)}
                          className="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-[10px] cursor-pointer"
                        >
                          詳細
                        </button>
                      </div>
                    )}
                  </div>
                );
              })
            )}
            {filteredDiscovered.length > 60 && (
              <div className="text-center py-1.5">
                <button
                  type="button"
                  onClick={onOpenImportModal}
                  className="text-[11px] text-emerald-300 hover:text-emerald-200 underline cursor-pointer"
                >
                  残り {filteredDiscovered.length - 60} 件を含む全モデルを一括取込モーダルで開く
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
};
