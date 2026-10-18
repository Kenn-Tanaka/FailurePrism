import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActiveView,
  GatewayHealthStatus,
  checkGatewayHealth,
  getHashForView,
  getTitleForView,
  resolveViewFromLocation,
} from './gatewayBridge';
import { installedTools } from './toolLoader';
import { ToolManifest, ToolRuntimeStatus } from './types';
import { TopTabBar } from './TopTabBar';
import { LauncherMenu } from './LauncherMenu';

export interface FailurePrismAppProps {
  /** テスト注入用のカスタムツール一覧（省略時は src/tools/<tool-id>/manifest.tsx から自動検出された installedTools） */
  tools?: ToolManifest[];
}

export const FailurePrismApp: React.FC<FailurePrismAppProps> = ({ tools = installedTools }) => {
  const [activeView, setActiveView] = useState<ActiveView>(() => {
    if (typeof window === 'undefined') return 'menu';
    return resolveViewFromLocation(window.location.hash, window.location.search, tools);
  });

  // 全ツール間で共有される単一のメモリ内 Gateway Token (Single Source of Truth)
  const [sharedGatewayToken, setSharedGatewayToken] = useState<string>('');

  // 各ツールから通知されるリアルタイム状態（バッジ数・未保存フラグ・Busy状態等）
  const [toolStatuses, setToolStatuses] = useState<Record<string, ToolRuntimeStatus | undefined>>(
    {}
  );

  const [gatewayHealth, setGatewayHealth] = useState<GatewayHealthStatus>({
    online: false,
    checkedAt: '-',
  });
  const [isCheckingHealth, setIsCheckingHealth] = useState(false);

  // ツール別のステータス更新コールバックをメモ化して不要な再レンダリングを防止
  const statusHandlers = useMemo(() => {
    const map: Record<string, (status: ToolRuntimeStatus) => void> = {};
    for (const tool of tools) {
      map[tool.id] = (status: ToolRuntimeStatus) => {
        setToolStatuses((prev) => {
          const prevStatus = prev[tool.id];
          if (
            prevStatus &&
            prevStatus.badgeCount === status.badgeCount &&
            prevStatus.badgeTooltip === status.badgeTooltip &&
            prevStatus.isDirty === status.isDirty &&
            prevStatus.isBusy === status.isBusy &&
            prevStatus.busyLabel === status.busyLabel
          ) {
            return prev;
          }
          return { ...prev, [tool.id]: status };
        });
      };
    }
    return map;
  }, [tools]);

  // URL Hash 同期 & ブラウザタイトル更新
  const handleSelectView = useCallback(
    (view: ActiveView) => {
      const resolved = view === 'menu' ? 'menu' : resolveViewFromLocation(`#${view}`, '', tools);
      setActiveView(resolved);
      if (typeof window !== 'undefined') {
        const targetHash = getHashForView(resolved, tools);
        if (window.location.hash !== targetHash) {
          window.history.pushState(null, '', targetHash);
        }
        document.title = getTitleForView(resolved, tools);
      }
    },
    [tools]
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    document.title = getTitleForView(activeView, tools);

    const onHashOrPopState = () => {
      const next = resolveViewFromLocation(window.location.hash, window.location.search, tools);
      setActiveView(next);
      document.title = getTitleForView(next, tools);
    };

    window.addEventListener('hashchange', onHashOrPopState);
    window.addEventListener('popstate', onHashOrPopState);
    return () => {
      window.removeEventListener('hashchange', onHashOrPopState);
      window.removeEventListener('popstate', onHashOrPopState);
    };
  }, [activeView, tools]);

  // LLM-Gateway v2.0 Health Check
  const refreshHealth = useCallback(async () => {
    setIsCheckingHealth(true);
    try {
      const status = await checkGatewayHealth();
      setGatewayHealth(status);
    } finally {
      setIsCheckingHealth(false);
    }
  }, []);

  useEffect(() => {
    refreshHealth();
    const timer = setInterval(refreshHealth, 15000);
    return () => clearInterval(timer);
  }, [refreshHealth]);

  return (
    <div className="flex flex-col h-screen w-screen overflow-hidden bg-slate-950">
      {/* 常設グローバルタブバー（メニュー + インストール済み全ツールを動的描画） */}
      <TopTabBar
        activeView={activeView}
        onSelectView={handleSelectView}
        tools={tools}
        toolStatuses={toolStatuses}
        gatewayHealth={gatewayHealth}
        isCheckingHealth={isCheckingHealth}
        onRefreshHealth={refreshHealth}
      />

      {/* メインコンテンツ領域: メニューおよび全登録ツールをマウント保持したまま表示切替 */}
      <div className="flex flex-1 min-h-0 w-full overflow-hidden relative">
        {activeView === 'menu' && (
          <LauncherMenu
            onSelectView={handleSelectView}
            tools={tools}
            toolStatuses={toolStatuses}
            gatewayHealth={gatewayHealth}
            isCheckingHealth={isCheckingHealth}
            onRefreshHealth={refreshHealth}
          />
        )}

        {tools.map((tool) => {
          const isToolActive = activeView === tool.id;
          const ToolComponent = tool.component;
          return (
            <div
              key={tool.id}
              data-tool-id={tool.id}
              className={
                isToolActive
                  ? 'flex flex-col flex-1 h-full w-full min-h-0 overflow-hidden'
                  : 'hidden'
              }
              aria-hidden={!isToolActive}
            >
              <ToolComponent
                isActive={isToolActive}
                gatewayToken={sharedGatewayToken}
                onGatewayTokenChange={setSharedGatewayToken}
                onStatusChange={statusHandlers[tool.id]}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
};

export default FailurePrismApp;
