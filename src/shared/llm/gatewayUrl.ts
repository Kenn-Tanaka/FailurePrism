/**
 * Validates Gateway API base URLs (allows same-origin `/v1` proxy and local loopback HTTP(S) URLs).
 */
export function isValidLoopbackUrl(urlStr: string): { valid: boolean; message?: string } {
  const trimmed = urlStr.trim();
  if (trimmed === '/v1' || trimmed === '/v1/') {
    return { valid: true };
  }
  try {
    const url = new URL(trimmed);
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
      return {
        valid: false,
        message: '初版ではローカル loopback アドレス (127.0.0.1, localhost, ::1) のみ許可されています',
      };
    }

    return { valid: true };
  } catch {
    return { valid: false, message: 'URLの形式が正しくありません' };
  }
}

export interface CatalogFetchUrlValidation {
  valid: boolean;
  isExternal: boolean;
  normalizedBaseUrl?: string;
  message?: string;
}

function isPrivateOrReservedHost(host: string): boolean {
  const clean = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (
    clean === '0.0.0.0' ||
    clean.startsWith('10.') ||
    clean.startsWith('192.168.') ||
    clean.startsWith('169.254.') ||
    clean.startsWith('127.') ||
    clean.startsWith('fc') ||
    clean.startsWith('fd') ||
    clean.startsWith('fe80:')
  ) {
    return true;
  }
  const m172 = clean.match(/^172\.(\d{1,3})\./);
  if (m172) {
    const second = Number(m172[1]);
    if (second >= 16 && second <= 31) return true;
  }
  return false;
}

/**
 * Validates model-catalog discovery endpoints.
 * Allows `/v1`, local loopback HTTP(S), and public external `https://` endpoints (e.g. OpenRouter).
 * Credentials, query strings, fragments, plain HTTP on remote hosts, and private LAN IPs are rejected.
 */
export function validateCatalogFetchUrl(urlStr: string): CatalogFetchUrlValidation {
  const trimmed = urlStr.trim();
  if (!trimmed) {
    return { valid: false, isExternal: false, message: 'エンドポイントURLを入力してください' };
  }
  if (trimmed === '/v1' || trimmed === '/v1/') {
    return { valid: true, isExternal: false, normalizedBaseUrl: '/v1' };
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return { valid: false, isExternal: false, message: 'プロトコルはhttpまたはhttpsである必要があります' };
    }
    if (url.username || url.password) {
      return { valid: false, isExternal: false, message: 'URLにユーザー情報（認証情報）を含めることはできません' };
    }
    if (url.search) {
      return { valid: false, isExternal: false, message: 'URLにクエリパラメータを含めることはできません' };
    }
    if (url.hash) {
      return { valid: false, isExternal: false, message: 'URLにフラグメントを含めることはできません' };
    }

    const host = url.hostname.toLowerCase();
    const isLoopback =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '[::1]';

    const normalizedBaseUrl = trimmed.replace(/\/+$/, '');
    if (isLoopback) {
      return { valid: true, isExternal: false, normalizedBaseUrl };
    }

    if (url.protocol !== 'https:') {
      return {
        valid: false,
        isExternal: true,
        message: '外部エンドポイントからモデル一覧を取得する場合は https:// のみ許可されています',
      };
    }

    if (isPrivateOrReservedHost(host)) {
      return {
        valid: false,
        isExternal: true,
        message: 'プライベートIPまたは予約済みアドレスは外部カタログURLに指定できません',
      };
    }

    return { valid: true, isExternal: true, normalizedBaseUrl };
  } catch {
    return { valid: false, isExternal: false, message: 'URLの形式が正しくありません' };
  }
}
