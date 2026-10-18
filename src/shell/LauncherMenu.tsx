import React from 'react';
import {
  ArrowRight,
  ExternalLink,
  Cpu,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Wrench,
  Check,
} from 'lucide-react';
import { ActiveView, GatewayHealthStatus, openViewInNewBrowserTab } from './gatewayBridge';
import { ToolManifest, ToolRuntimeStatus, ToolThemeColor } from './types';

export interface LauncherMenuProps {
  onSelectView: (view: ActiveView) => void;
  tools: ToolManifest[];
  toolStatuses: Record<string, ToolRuntimeStatus | undefined>;
  gatewayHealth: GatewayHealthStatus;
  isCheckingHealth: boolean;
  onRefreshHealth: () => void;
}

const CARD_THEME_CLASSES: Record<
  ToolThemeColor,
  {
    cardHover: string;
    iconBox: string;
    subtitle: string;
    titleHover: string;
    badge: string;
    featureIcon: string;
    primaryBtn: string;
    extIcon: string;
  }
> = {
  blue: {
    cardHover: 'hover:border-blue-500/80 hover:shadow-blue-950/30',
    iconBox: 'from-blue-600 to-indigo-600 shadow-blue-600/25',
    subtitle: 'text-blue-400',
    titleHover: 'group-hover:text-blue-300',
    badge: 'bg-blue-950/80 text-blue-300 border-blue-800/80',
    featureIcon: 'text-blue-400',
    primaryBtn: 'bg-blue-600 hover:bg-blue-500 shadow-blue-950/50',
    extIcon: 'text-blue-400',
  },
  indigo: {
    cardHover: 'hover:border-cyan-500/80 hover:shadow-cyan-950/30',
    iconBox: 'from-cyan-600 to-teal-600 shadow-cyan-600/25',
    subtitle: 'text-cyan-400',
    titleHover: 'group-hover:text-cyan-300',
    badge: 'bg-cyan-950/80 text-cyan-300 border-cyan-800/80',
    featureIcon: 'text-cyan-400',
    primaryBtn: 'bg-cyan-600 hover:bg-cyan-500 shadow-cyan-950/50',
    extIcon: 'text-cyan-400',
  },
  emerald: {
    cardHover: 'hover:border-emerald-500/80 hover:shadow-emerald-950/30',
    iconBox: 'from-emerald-600 to-teal-600 shadow-emerald-600/25',
    subtitle: 'text-emerald-400',
    titleHover: 'group-hover:text-emerald-300',
    badge: 'bg-emerald-950/80 text-emerald-300 border-emerald-800/80',
    featureIcon: 'text-emerald-400',
    primaryBtn: 'bg-emerald-600 hover:bg-emerald-500 shadow-emerald-950/50',
    extIcon: 'text-emerald-400',
  },
  amber: {
    cardHover: 'hover:border-amber-500/80 hover:shadow-amber-950/30',
    iconBox: 'from-amber-600 to-orange-600 shadow-amber-600/25',
    subtitle: 'text-amber-400',
    titleHover: 'group-hover:text-amber-300',
    badge: 'bg-amber-950/80 text-amber-300 border-amber-800/80',
    featureIcon: 'text-amber-400',
    primaryBtn: 'bg-amber-600 hover:bg-amber-500 shadow-amber-950/50',
    extIcon: 'text-amber-400',
  },
  rose: {
    cardHover: 'hover:border-rose-500/80 hover:shadow-rose-950/30',
    iconBox: 'from-rose-600 to-pink-600 shadow-rose-600/25',
    subtitle: 'text-rose-400',
    titleHover: 'group-hover:text-rose-300',
    badge: 'bg-rose-950/80 text-rose-300 border-rose-800/80',
    featureIcon: 'text-rose-400',
    primaryBtn: 'bg-rose-600 hover:bg-rose-500 shadow-rose-950/50',
    extIcon: 'text-rose-400',
  },
  purple: {
    cardHover: 'hover:border-purple-500/80 hover:shadow-purple-950/30',
    iconBox: 'from-purple-600 to-fuchsia-600 shadow-purple-600/25',
    subtitle: 'text-purple-400',
    titleHover: 'group-hover:text-purple-300',
    badge: 'bg-purple-950/80 text-purple-300 border-purple-800/80',
    featureIcon: 'text-purple-400',
    primaryBtn: 'bg-purple-600 hover:bg-purple-500 shadow-purple-950/50',
    extIcon: 'text-purple-400',
  },
};

export const LauncherMenu: React.FC<LauncherMenuProps> = ({
  onSelectView,
  tools,
  toolStatuses,
  gatewayHealth,
  isCheckingHealth,
  onRefreshHealth,
}) => {
  return (
    <div className="flex-1 h-full w-full overflow-y-auto bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950 text-slate-100 select-none">
      <div className="max-w-6xl mx-auto px-6 py-8 md:py-12 space-y-8">
        {/* ヒーローヘッダー */}
        <header className="text-center space-y-3">
          <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-indigo-950/80 border border-indigo-700/60 text-indigo-300 text-xs font-medium shadow-sm">
            <Sparkles className="w-3.5 h-3.5 text-indigo-400" />
            <span>
              モジュラー統合スイート（登録ツール数: {tools.length}）
            </span>
          </div>
          <h1 className="text-3xl md:text-4xl font-extrabold tracking-tight text-white">
            FailurePrism ワークベンチ
          </h1>
          <p className="text-sm text-slate-400 max-w-2xl mx-auto leading-relaxed">
            起動するツールを選択してください。画面上部のタブバー、またはブラウザの別タブ起動を使って、
            作業データを保持したままいつでも各ツールを切り替えられます。
          </p>
        </header>

        {/* 動的ツール選択カード一覧 */}
        <section
          className="grid grid-cols-1 md:grid-cols-2 gap-6"
          aria-label="ツール選択メニュー"
        >
          {tools.map((tool) => {
            const themeColor: ToolThemeColor = tool.theme?.color || 'blue';
            const classes = CARD_THEME_CLASSES[themeColor] || CARD_THEME_CLASSES.blue;
            const IconComponent = tool.icon;
            const status = toolStatuses[tool.id];

            return (
              <div
                key={tool.id}
                className={`group relative rounded-2xl bg-slate-900/90 border border-slate-800 p-6 flex flex-col justify-between shadow-xl transition-all ${classes.cardHover}`}
              >
                <div className="space-y-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex items-center gap-3.5">
                      <div
                        className={`w-12 h-12 rounded-xl bg-gradient-to-br flex items-center justify-center text-white shadow-lg shrink-0 ${classes.iconBox}`}
                      >
                        <IconComponent className="w-6 h-6" />
                      </div>
                      <div>
                        {tool.subtitle && (
                          <span
                            className={`text-[11px] font-mono uppercase tracking-wider font-semibold ${classes.subtitle}`}
                          >
                            {tool.subtitle}
                          </span>
                        )}
                        <h2
                          className={`text-xl font-bold text-white transition-colors ${classes.titleHover}`}
                        >
                          {tool.shortTitle}（{tool.title}）
                        </h2>
                      </div>
                    </div>

                    {status?.badgeTooltip && (
                      <span
                        className={`px-2.5 py-1 rounded-full text-[11px] font-mono border shrink-0 ${classes.badge}`}
                      >
                        {status.badgeTooltip}
                        {status.isDirty ? ' (編集中)' : ''}
                      </span>
                    )}
                  </div>

                  <p className="text-xs text-slate-300 leading-relaxed">{tool.description}</p>

                  {tool.features && tool.features.length > 0 && (
                    <ul className="space-y-2 text-xs text-slate-400 bg-slate-950/60 p-4 rounded-xl border border-slate-800/80">
                      {tool.features.map((feat, idx) => (
                        <li key={idx} className="flex items-center gap-2">
                          <Check className={`w-4 h-4 shrink-0 ${classes.featureIcon}`} />
                          <span>{feat}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="pt-6 mt-6 border-t border-slate-800/80 flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                  <button
                    type="button"
                    onClick={() => onSelectView(tool.id)}
                    className={`flex-1 px-4 py-2.5 rounded-xl text-white font-semibold text-xs flex items-center justify-center gap-2 shadow-md transition-colors cursor-pointer ${classes.primaryBtn}`}
                  >
                    <span>{tool.shortTitle} を開く</span>
                    <ArrowRight className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => openViewInNewBrowserTab(tool.id, tools)}
                    className="px-3.5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 font-medium text-xs flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                    title={`新しいブラウザタブで ${tool.shortTitle} を開く`}
                  >
                    <ExternalLink className={`w-3.5 h-3.5 ${classes.extIcon}`} />
                    <span>別タブで開く</span>
                  </button>
                </div>
              </div>
            );
          })}
        </section>

        {/* フル機能版 LLM-Gateway v2.0 ステータス & メンテナンス案内 */}
        <section
          aria-label="LLM-Gateway ステータス"
          className="rounded-2xl bg-slate-900/80 border border-slate-800 p-5 space-y-4 shadow-lg"
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-3.5">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-slate-950 border border-slate-800 text-indigo-400">
                <Cpu className="w-5 h-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-sm font-bold text-white">
                    LLM-Gateway フル機能版 (v2.0.0) バックエンド状態
                  </h3>
                  {gatewayHealth.online ? (
                    <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-950 text-emerald-300 border border-emerald-700/80 flex items-center gap-1">
                      <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                      稼働中 (127.0.0.1:8765)
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded-full text-[11px] font-semibold bg-rose-950 text-rose-300 border border-rose-700/80 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3 text-rose-400" />
                      停止中 / 未接続
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-400 mt-0.5">
                  全登録ツール共通のOpenAI互換ローカルゲートウェイ（外部Provider中継 + 組み込みGGUF Embedding / Rerank 対応）
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={onRefreshHealth}
              disabled={isCheckingHealth}
              className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 border border-slate-700 text-xs font-medium flex items-center gap-1.5 self-start sm:self-auto cursor-pointer"
            >
              <RefreshCw
                className={`w-3.5 h-3.5 ${isCheckingHealth ? 'animate-spin text-indigo-400' : ''}`}
              />
              <span>ステータス再確認</span>
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
            <div className="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800/90 space-y-1">
              <div className="text-slate-400 font-medium flex items-center gap-1.5">
                <Cpu className="w-3.5 h-3.5 text-indigo-400" />
                <span>プロセス・エンドポイント情報</span>
              </div>
              {gatewayHealth.online ? (
                <div className="text-slate-200 font-mono space-y-0.5 pt-1 text-[11px]">
                  <div>
                    Version: v{gatewayHealth.version || '2.0.0'} (PID: {gatewayHealth.pid ?? '-'})
                  </div>
                  <div>Embedded Engine: {gatewayHealth.embedded || 'disabled'}</div>
                  <div>Health Latency: {gatewayHealth.latencyMs ?? '-'} ms</div>
                </div>
              ) : (
                <p className="text-rose-300/90 pt-1 leading-relaxed text-[11px]">
                  {gatewayHealth.error}。<code className="text-slate-200">start-all.bat</code> または{' '}
                  <code className="text-slate-200">MaintenanceTool.exe</code> から Gateway を起動してください。
                </p>
              )}
            </div>

            <div className="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800/90 space-y-1">
              <div className="text-slate-400 font-medium flex items-center gap-1.5">
                <Wrench className="w-3.5 h-3.5 text-cyan-400" />
                <span>GUI設定・APIキー管理 (MaintenanceTool.exe)</span>
              </div>
              <p className="text-slate-300 pt-1 leading-relaxed text-[11px]">
                同梱の <code className="text-cyan-300 font-mono">maintenance-tool.bat</code>（
                <code className="font-mono">gateway/MaintenanceTool.exe</code>
                ）から、OpenRouter等のAPIキー登録、プロバイダルーティング、組み込みGGUFモデル指定、ログ監視をGUIで完結できます。
              </p>
            </div>

            <div className="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800/90 space-y-1">
              <div className="text-slate-400 font-medium flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                <span>セキュリティ＆プラグイン拡張設計</span>
              </div>
              <p className="text-slate-300 pt-1 leading-relaxed text-[11px]">
                APIキーはWindows資格情報マネージャーに安全に保管されます。新しいツールは{' '}
                <code className="text-emerald-300 font-mono">src/tools/&lt;id&gt;/manifest.tsx</code>{' '}
                を配置するだけで自動的にインストール・認識されます。
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
};
