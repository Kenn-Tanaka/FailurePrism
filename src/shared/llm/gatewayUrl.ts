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
