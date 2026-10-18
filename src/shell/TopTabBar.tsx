import React from 'react';
import {
  Home,
  ExternalLink,
  RefreshCw,
  Cpu,
  CheckCircle2,
  AlertCircle,
  Sparkles,
} from 'lucide-react';
import {
  ActiveView,
  GatewayHealthStatus,
  getHashForView,
  openViewInNewBrowserTab,
} from './gatewayBridge';
import { ToolManifest, ToolRuntimeStatus, ToolThemeColor } from './types';

export interface TopTabBarProps {
  activeView: ActiveView;
  onSelectView: (view: ActiveView) => void;
  tools: ToolManifest[];
  toolStatuses: Record<string, ToolRuntimeStatus | undefined>;
  gatewayHealth: GatewayHealthStatus;
  isCheckingHealth: boolean;
  onRefreshHealth: () => void;
}

const TAB_THEME_CLASSES: Record<
  ToolThemeColor,
  {
    activeTab: string;
    activeExtBtn: string;
    icon: string;
    busyBadge: string;
  }
> = {
  blue: {
    activeTab: 'bg-blue-950/70 text-blue-200 border-blue-400',
    activeExtBtn: 'bg-blue-950/70 text-blue-300 hover:text-white border-blue-400',
    icon: 'text-blue-400',
    busyBadge: 'bg-blue-900/80 text-blue-200 border-blue-500/60',
  },
  indigo: {
    activeTab: 'bg-cyan-950/70 text-cyan-200 border-cyan-400',
    activeExtBtn: 'bg-cyan-950/70 text-cyan-300 hover:text-white border-cyan-400',
    icon: 'text-cyan-400',
    busyBadge: 'bg-cyan-900/80 text-cyan-200 border-cyan-500/60',
  },
  emerald: {
    activeTab: 'bg-emerald-950/70 text-emerald-200 border-emerald-400',
    activeExtBtn: 'bg-emerald-950/70 text-emerald-300 hover:text-white border-emerald-400',
    icon: 'text-emerald-400',
    busyBadge: 'bg-emerald-900/80 text-emerald-200 border-emerald-500/60',
  },
  amber: {
    activeTab: 'bg-amber-950/70 text-amber-200 border-amber-400',
    activeExtBtn: 'bg-amber-950/70 text-amber-300 hover:text-white border-amber-400',
    icon: 'text-amber-400',
    busyBadge: 'bg-amber-900/80 text-amber-200 border-amber-500/60',
  },
  rose: {
    activeTab: 'bg-rose-950/70 text-rose-200 border-rose-400',
    activeExtBtn: 'bg-rose-950/70 text-rose-300 hover:text-white border-rose-400',
    icon: 'text-rose-400',
    busyBadge: 'bg-rose-900/80 text-rose-200 border-rose-500/60',
  },
  purple: {
    activeTab: 'bg-purple-950/70 text-purple-200 border-purple-400',
    activeExtBtn: 'bg-purple-950/70 text-purple-300 hover:text-white border-purple-400',
    icon: 'text-purple-400',
    busyBadge: 'bg-purple-900/80 text-purple-200 border-purple-500/60',
  },
};

export const TopTabBar: React.FC<TopTabBarProps> = ({
  activeView,
  onSelectView,
  tools,
  toolStatuses,
  gatewayHealth,
  isCheckingHealth,
  onRefreshHealth,
}) => {
  const handleTabClick = (e: React.MouseEvent<HTMLAnchorElement>, view: ActiveView) => {
    // Ctrl+Click / Cmd+Click / 中クリックはブラウザ標準の「別タブで開く」動作に委ねる
    if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) {
      return;
    }
    e.preventDefault();
    onSelectView(view);
  };

  return (
    <nav
      aria-label="FailurePrism アプリケーション切替バー"
      className="h-10 bg-slate-900 border-b border-slate-800 px-3 flex items-center justify-between text-xs text-slate-200 shrink-0 select-none z-40"
    >
      {/* 左側: ブランドロゴ & 動的タブ切替 */}
      <div className="flex items-center gap-1.5 h-full overflow-x-auto no-scrollbar">
        {/* ブランドバッジ */}
        <a
          href={getHashForView('menu', tools)}
          onClick={(e) => handleTabClick(e, 'menu')}
          className="flex items-center gap-2 px-2.5 py-1 rounded-md hover:bg-slate-800 transition-colors mr-1 group shrink-0"
          title="FailurePrism 起動メニュー画面へ戻る"
        >
          <span className="w-5 h-5 rounded-md bg-gradient-to-br from-indigo-500 via-blue-500 to-cyan-400 flex items-center justify-center text-white font-bold text-[11px] shadow-sm">
            FP
          </span>
          <span className="font-bold tracking-tight text-slate-100 group-hover:text-white">
            FailurePrism
          </span>
        </a>

        <div className="h-4 w-px bg-slate-800 mx-0.5 shrink-0" />

        {/* タブ 1: メニュー */}
        <a
          href={getHashForView('menu', tools)}
          onClick={(e) => handleTabClick(e, 'menu')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-t-lg border-b-2 font-medium transition-all h-full shrink-0 ${
            activeView === 'menu'
              ? 'bg-slate-800/90 text-white border-indigo-400 shadow-inner'
              : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40 border-transparent'
          }`}
        >
          <Home className="w-3.5 h-3.5 text-indigo-400" />
          <span>メニュー</span>
        </a>

        {/* 動的インストール済みツールタブ一覧 */}
        {tools.map((tool) => {
          const isCurrent = activeView === tool.id;
          const themeColor: ToolThemeColor = tool.theme?.color || 'blue';
          const themeClasses = TAB_THEME_CLASSES[themeColor] || TAB_THEME_CLASSES.blue;
          const IconComponent = tool.icon;
          const status = toolStatuses[tool.id];

          return (
            <div key={tool.id} className="flex items-center h-full shrink-0">
              <a
                href={getHashForView(tool.id, tools)}
                onClick={(e) => handleTabClick(e, tool.id)}
                className={`flex items-center gap-1.5 pl-3 pr-2 py-1.5 rounded-tl-lg border-b-2 font-medium transition-all h-full ${
                  isCurrent
                    ? themeClasses.activeTab
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/40 border-transparent'
                }`}
                title={`${tool.title} (${tool.shortTitle}) に切り替え（Ctrl+クリックで別ブラウザタブ起動）`}
              >
                <IconComponent className={`w-3.5 h-3.5 ${themeClasses.icon}`} />
                <span>{tool.shortTitle}</span>
                <span className="hidden md:inline text-[10px] text-slate-400 font-normal">
                  ({tool.title})
                </span>

                {status?.badgeTooltip ? (
                  <span className="ml-1 px-1.5 py-0.2 rounded-full text-[10px] font-mono bg-slate-800 text-slate-300 border border-slate-700">
                    {status.badgeTooltip}
                  </span>
                ) : typeof status?.badgeCount === 'number' ? (
                  <span className="ml-1 px-1.5 py-0.2 rounded-full text-[10px] font-mono bg-slate-800 text-slate-300 border border-slate-700">
                    {status.badgeCount}
                  </span>
                ) : null}

                {status?.isBusy && (
                  <span
                    className={`ml-1 px-1.5 py-0.2 rounded-full text-[10px] border flex items-center gap-1 animate-pulse ${themeClasses.busyBadge}`}
                  >
                    <Sparkles className="w-2.5 h-2.5" />
                    {status.busyLabel || '処理中'}
                  </span>
                )}

                {status?.isDirty && (
                  <span
                    className="ml-1 w-2 h-2 rounded-full bg-amber-400 inline-block"
                    title={`${tool.shortTitle} に未保存の変更があります`}
                  />
                )}
              </a>

              <button
                type="button"
                onClick={() => openViewInNewBrowserTab(tool.id, tools)}
                className={`px-1.5 h-full border-b-2 transition-colors flex items-center rounded-tr-lg ${
                  isCurrent
                    ? themeClasses.activeExtBtn
                    : 'text-slate-500 hover:text-slate-300 hover:bg-slate-800/40 border-transparent'
                }`}
                title={`${tool.shortTitle} を新しいブラウザタブで開く`}
              >
                <ExternalLink className="w-3 h-3" />
              </button>
            </div>
          );
        })}
      </div>

      {/* 右側: LLM-Gateway フル機能版 (v2.0) ステータス */}
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={onRefreshHealth}
          disabled={isCheckingHealth}
          className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-[11px] transition-colors cursor-pointer ${
            gatewayHealth.online
              ? 'bg-emerald-950/60 border-emerald-700/70 text-emerald-300 hover:bg-emerald-900/60'
              : 'bg-rose-950/60 border-rose-800/70 text-rose-300 hover:bg-rose-900/60'
          }`}
          title={
            gatewayHealth.online
              ? `LLM-Gateway v${gatewayHealth.version || '2.0.0'} 稼働中 (PID: ${gatewayHealth.pid ?? '-'}, Embedded: ${gatewayHealth.embedded ?? 'disabled'}, 応答: ${gatewayHealth.latencyMs ?? '-'}ms) - クリックで再診断`
              : `${gatewayHealth.error || 'LLM-Gateway 未接続'} - クリックで再確認`
          }
        >
          <Cpu className="w-3.5 h-3.5 shrink-0" />
          <span className="hidden sm:inline font-medium">
            LLM-Gateway {gatewayHealth.version ? `v${gatewayHealth.version}` : 'v2.0'}:
          </span>
          {gatewayHealth.online ? (
            <span className="flex items-center gap-1 font-semibold text-emerald-300">
              <CheckCircle2 className="w-3 h-3 text-emerald-400" />
              <span>Online</span>
              {gatewayHealth.embedded && gatewayHealth.embedded !== 'disabled' && (
                <span className="hidden lg:inline text-[10px] px-1.5 rounded bg-emerald-900/80 text-emerald-200 border border-emerald-700">
                  GGUF:{gatewayHealth.embedded}
                </span>
              )}
            </span>
          ) : (
            <span className="flex items-center gap-1 font-semibold text-rose-300">
              <AlertCircle className="w-3 h-3 text-rose-400" />
              <span>Offline</span>
            </span>
          )}
          <RefreshCw
            className={`w-3 h-3 ml-0.5 opacity-75 ${isCheckingHealth ? 'animate-spin' : ''}`}
          />
        </button>
      </div>
    </nav>
  );
};
