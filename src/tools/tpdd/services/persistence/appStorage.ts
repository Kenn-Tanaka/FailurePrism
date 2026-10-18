export interface AppSettings {
  gatewayUrl: string;
  gatewayAuthEnabled: boolean;
  favoriteModelIds: string[];
}

const STORAGE_KEY = 'thought_expansion_settings';

export const DEFAULT_GATEWAY_URL = '/v1';

function normalizeGatewayUrl(value: unknown): string {
  if (typeof value !== 'string') return DEFAULT_GATEWAY_URL;
  const url = value.trim().replace(/\/+$/, '');
  // Migrate only the former default; preserve custom endpoints.
  return url === 'http://127.0.0.1:8765/v1' ? DEFAULT_GATEWAY_URL : url;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
  gatewayUrl: DEFAULT_GATEWAY_URL,
  gatewayAuthEnabled: false,
  favoriteModelIds: ['openrouter/google/gemini-3.8-flash'],
};

/**
 * 仕様書 8.2: loopback URLの厳格な検証
 * localhost, 127.0.0.1, [::1] のhttp URLのみ許可し、userinfo, query, fragmentを拒否
 */
export function isValidLoopbackUrl(urlStr: string): { valid: boolean; message?: string } {
  if (urlStr === '/v1' || urlStr === '/v1/') return { valid: true };
  try {
    const url = new URL(urlStr);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { valid: false, message: 'プロトコルはhttpまたはhttpsである必要があります' };
    }
    if (url.username || url.password) {
      return { valid: false, message: 'URLにユーザー情報（認証情報）を含めることはできません' };
    }
    if (url.search) {
      return { valid: false, message: 'URLにクエリパラメータを含めることはできません' };
    }
    if (url.hash) {
      return { valid: false, message: 'URLにフラグメントを含めることはできません' };
    }

    const host = url.hostname.toLowerCase();
    const isLoopback =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '[::1]';

    if (!isLoopback) {
      return { valid: false, message: '初版ではローカル loopback アドレス (127.0.0.1, localhost, ::1) のみ許可されています' };
    }

    return { valid: true };
  } catch {
    return { valid: false, message: 'URLの形式が正しくありません' };
  }
}

/**
 * 端末設定の読み込み
 */
export function loadAppSettings(): AppSettings {
  if (typeof localStorage === 'undefined') {
    return { ...DEFAULT_APP_SETTINGS };
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_APP_SETTINGS };

    const parsed = JSON.parse(raw);
    return {
      gatewayUrl: normalizeGatewayUrl(parsed.gatewayUrl),
      gatewayAuthEnabled: Boolean(parsed.gatewayAuthEnabled),
      favoriteModelIds: Array.isArray(parsed.favoriteModelIds) ? parsed.favoriteModelIds : ['openrouter/google/gemini-3.8-flash'],
    };
  } catch {
    return { ...DEFAULT_APP_SETTINGS };
  }
}

/**
 * 端末設定の保存 (Gateway Tokenは絶対に含めない)
 */
export function saveAppSettings(settings: Partial<AppSettings>): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const current = loadAppSettings();
    const next: AppSettings = {
      ...current,
      ...settings,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch (e) {
    console.warn('設定の保存に失敗しました:', e);
  }
}
