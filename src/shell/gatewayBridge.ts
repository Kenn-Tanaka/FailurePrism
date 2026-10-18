import { ToolManifest } from './types';
import { installedTools } from './toolLoader';

export type ActiveView = 'menu' | string;

export interface GatewayHealthStatus {
  online: boolean;
  status?: string;
  pid?: number;
  version?: string;
  embedded?: string;
  latencyMs?: number;
  checkedAt: string;
  error?: string;
}

/**
 * URLハッシュまたはクエリ文字列から初期・現在のビューを動的に解決する
 * - インストール済みツール一覧 (availableTools) に存在するIDであればそのツールビューを返す
 */
export function resolveViewFromLocation(
  hash: string,
  search = '',
  availableTools: ReadonlyArray<Pick<ToolManifest, 'id'>> = installedTools
): ActiveView {
  const validToolIds = new Set(availableTools.map((t) => t.id.toLowerCase()));

  const cleanHash = hash.replace(/^#\/?/, '').trim().toLowerCase();
  if (cleanHash === 'menu' || cleanHash === 'home') {
    return 'menu';
  }

  if (cleanHash) {
    const baseSegment = cleanHash.split(/[/?]/)[0];
    if (validToolIds.has(baseSegment)) {
      return baseSegment;
    }
  }

  if (search) {
    try {
      const params = new URLSearchParams(search);
      const app = params.get('app')?.trim().toLowerCase();
      if (app && validToolIds.has(app)) {
        return app;
      }
    } catch {
      // ignore invalid search params
    }
  }

  return 'menu';
}

/**
 * ビューに対応するURLハッシュを返す
 */
export function getHashForView(
  view: ActiveView,
  availableTools: ReadonlyArray<Pick<ToolManifest, 'id'>> = installedTools
): string {
  const normalized = (view || '').trim().toLowerCase();
  if (!normalized || normalized === 'menu' || normalized === 'home') {
    return '#menu';
  }
  const exists = availableTools.some((t) => t.id.toLowerCase() === normalized);
  return exists ? `#${normalized}` : '#menu';
}

/**
 * ビューに対応するブラウザタブタイトルを動的に返す
 */
export function getTitleForView(
  view: ActiveView,
  availableTools: ReadonlyArray<Pick<ToolManifest, 'id' | 'title' | 'shortTitle'>> = installedTools
): string {
  const normalized = (view || '').trim().toLowerCase();
  if (normalized && normalized !== 'menu') {
    const tool = availableTools.find((t) => t.id.toLowerCase() === normalized);
    if (tool) {
      return `FailurePrism - ${tool.shortTitle} (${tool.title})`;
    }
  }
  return 'FailurePrism - 統合ランチャーメニュー';
}

/**
 * 新しいブラウザタブで指定のツール（またはメニュー）を開く
 */
export function openViewInNewBrowserTab(
  view: ActiveView,
  availableTools: ReadonlyArray<Pick<ToolManifest, 'id'>> = installedTools
): void {
  const targetHash = getHashForView(view, availableTools);
  const url = `${window.location.origin}${window.location.pathname}${targetHash}`;
  window.open(url, '_blank', 'noopener,noreferrer');
}

/**
 * フル機能版 LLM-Gateway (v2.0.0) の /health エンドポイントへ疎通確認を行う
 */
export async function checkGatewayHealth(signal?: AbortSignal): Promise<GatewayHealthStatus> {
  const checkedAt = new Date().toLocaleTimeString();
  const start = typeof performance !== 'undefined' ? performance.now() : Date.now();

  const candidateUrls = ['/health', 'http://127.0.0.1:8765/health'];

  for (const url of candidateUrls) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    const onAbort = () => controller.abort();
    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });

      if (res.ok) {
        const data = await res.json();
        if (data && data.status === 'ok') {
          const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
          return {
            online: true,
            status: data.status,
            pid: typeof data.pid === 'number' ? data.pid : undefined,
            version: typeof data.version === 'string' ? data.version : '2.0.0',
            embedded: typeof data.embedded === 'string' ? data.embedded : 'disabled',
            latencyMs: Math.max(1, Math.round(now - start)),
            checkedAt,
          };
        }
      }
    } catch {
      // try next candidate endpoint
    } finally {
      clearTimeout(timer);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    }
  }

  return {
    online: false,
    checkedAt,
    error: 'LLM-Gateway (127.0.0.1:8765) が応答していません',
  };
}

export interface ReconcileTokenResult {
  nextToken: string;
  updateTpdd: boolean;
  updateVta: boolean;
}

/**
 * Gateway Token 双方向同期ユーティリティ (後方互換・単体テスト用)
 */
export function reconcileGatewayTokens(
  lastSyncedToken: string,
  tpddToken: string,
  vtaToken: string
): ReconcileTokenResult {
  const tpddChanged = tpddToken !== lastSyncedToken;
  const vtaChanged = vtaToken !== lastSyncedToken;

  if (tpddChanged && !vtaChanged) {
    return {
      nextToken: tpddToken,
      updateTpdd: false,
      updateVta: vtaToken !== tpddToken,
    };
  }

  if (vtaChanged && !tpddChanged) {
    return {
      nextToken: vtaToken,
      updateTpdd: tpddToken !== vtaToken,
      updateVta: false,
    };
  }

  if (tpddChanged && vtaChanged) {
    const chosen = tpddToken || vtaToken;
    return {
      nextToken: chosen,
      updateTpdd: tpddToken !== chosen,
      updateVta: vtaToken !== chosen,
    };
  }

  return {
    nextToken: lastSyncedToken,
    updateTpdd: false,
    updateVta: false,
  };
}
