import { isValidLoopbackUrl } from '../../../shared/llm/gatewayUrl';
import { validateModelId } from '../../../shared/llm/modelTypes';

export interface LLMManagerConnection {
  gatewayUrl: string;
  gatewayAuthEnabled: boolean;
  gatewayToken: string;
}

export interface DiscoveredGatewayModel {
  id: string;
  name?: string;
}

export interface PingModelResult {
  success: boolean;
  latencyMs: number;
  message: string;
}

const CONNECTION_STORAGE_KEY = 'failureprism_llm_manager_connection';
export const DEFAULT_GATEWAY_URL = '/v1';

function normalizeGatewayUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return DEFAULT_GATEWAY_URL;
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed === 'http://127.0.0.1:8765/v1' ? DEFAULT_GATEWAY_URL : trimmed;
}

export function loadConnectionSettings(): Pick<LLMManagerConnection, 'gatewayUrl' | 'gatewayAuthEnabled'> {
  try {
    if (typeof localStorage === 'undefined') {
      return { gatewayUrl: DEFAULT_GATEWAY_URL, gatewayAuthEnabled: false };
    }
    const raw = localStorage.getItem(CONNECTION_STORAGE_KEY);
    if (!raw) {
      return { gatewayUrl: DEFAULT_GATEWAY_URL, gatewayAuthEnabled: false };
    }
    const parsed = JSON.parse(raw);
    return {
      gatewayUrl: normalizeGatewayUrl(parsed?.gatewayUrl),
      gatewayAuthEnabled: Boolean(parsed?.gatewayAuthEnabled),
    };
  } catch {
    return { gatewayUrl: DEFAULT_GATEWAY_URL, gatewayAuthEnabled: false };
  }
}

export function saveConnectionSettings(
  settings: Pick<LLMManagerConnection, 'gatewayUrl' | 'gatewayAuthEnabled'>
): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(
      CONNECTION_STORAGE_KEY,
      JSON.stringify({
        gatewayUrl: normalizeGatewayUrl(settings.gatewayUrl),
        gatewayAuthEnabled: Boolean(settings.gatewayAuthEnabled),
      })
    );
  } catch {
    // Ignore storage errors
  }
}

function buildAuthHeaders(connection: LLMManagerConnection): Record<string, string> {
  if (connection.gatewayAuthEnabled && !connection.gatewayToken.trim()) {
    throw new Error('Gateway認証が有効ですが、Gateway Tokenが入力されていません。');
  }
  const headers: Record<string, string> = {};
  if (connection.gatewayToken.trim()) {
    headers.Authorization = `Bearer ${connection.gatewayToken.trim()}`;
  }
  return headers;
}

async function readGatewayErrorMessage(response: Response): Promise<string> {
  const status = response.status;
  let detail = response.statusText || '';
  try {
    const text = await response.text();
    if (text) {
      try {
        const json = JSON.parse(text);
        detail = json?.error?.message || text;
      } catch {
        detail = text;
      }
    }
  } catch {
    // Ignore body read error
  }

  if (status === 401) {
    return `Gateway認証エラー (401): トークンを確認してください。${detail ? ` (${detail})` : ''}`;
  }
  if (status === 403) {
    return `Gatewayアクセス拒否 (403): allowlist で許可されていないモデルまたは操作です。${detail ? ` (${detail})` : ''}`;
  }
  if (status === 503) {
    return `上流プロバイダ未設定または利用不可 (503): ${detail || 'APIキーやプロバイダ状態を確認してください'}`;
  }
  return `HTTP ${status}: ${detail || 'Gatewayエラー'}`;
}

export async function fetchGatewayModels(
  connection: LLMManagerConnection,
  externalSignal?: AbortSignal
): Promise<DiscoveredGatewayModel[]> {
  const urlCheck = isValidLoopbackUrl(connection.gatewayUrl);
  if (!urlCheck.valid) {
    throw new Error(urlCheck.message || 'Gateway URLが不正です。');
  }

  const base = normalizeGatewayUrl(connection.gatewayUrl);
  const endpoint = `${base}/models`;
  const headers = buildAuthHeaders(connection);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(await readGatewayErrorMessage(response));
    }

    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) {
      throw new Error('モデル一覧の応答サイズが上限 (2 MiB) を超えています。');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Gatewayからの応答が有効なJSONではありません。');
    }

    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { data?: unknown }).data)) {
      throw new Error('モデル一覧の応答形式が不正です（data配列がありません）。');
    }

    const seen = new Set<string>();
    const results: DiscoveredGatewayModel[] = [];
    for (const item of (parsed as { data: unknown[] }).data) {
      if (item && typeof item === 'object' && 'id' in item && typeof (item as { id: unknown }).id === 'string') {
        const id = (item as { id: string }).id;
        const name =
          'name' in item && typeof (item as { name?: unknown }).name === 'string'
            ? (item as { name: string }).name
            : undefined;
        if (id.trim() && !seen.has(id)) {
          seen.add(id);
          results.push({ id, name });
        }
      }
    }
    return results;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('モデル一覧の取得がタイムアウトまたは中断されました。');
    }
    if (err instanceof TypeError || (err instanceof Error && err.message.includes('Failed to fetch'))) {
      throw new Error('LLM-Gatewayに接続できませんでした。Gatewayが起動しているか確認してください。');
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}

export async function pingGatewayModel(
  connection: LLMManagerConnection,
  modelId: string,
  externalSignal?: AbortSignal
): Promise<PingModelResult> {
  const urlCheck = isValidLoopbackUrl(connection.gatewayUrl);
  if (!urlCheck.valid) {
    return { success: false, latencyMs: 0, message: urlCheck.message || 'Gateway URLが不正です。' };
  }
  const modelCheck = validateModelId(modelId);
  if (!modelCheck.valid) {
    return { success: false, latencyMs: 0, message: modelCheck.message || 'モデルIDが不正です。' };
  }

  let headers: Record<string, string>;
  try {
    headers = {
      'Content-Type': 'application/json',
      ...buildAuthHeaders(connection),
    };
  } catch (err) {
    return {
      success: false,
      latencyMs: 0,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const base = normalizeGatewayUrl(connection.gatewayUrl);
  const endpoint = `${base}/chat/completions`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);
  const onExternalAbort = () => controller.abort();
  externalSignal?.addEventListener('abort', onExternalAbort, { once: true });

  const startedAt = typeof performance !== 'undefined' ? performance.now() : Date.now();

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelId.trim(),
        messages: [{ role: 'user', content: 'Ping' }],
        max_tokens: 5,
        stream: false,
      }),
      signal: controller.signal,
    });

    const elapsed = Math.max(
      1,
      Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt)
    );

    if (!response.ok) {
      return {
        success: false,
        latencyMs: elapsed,
        message: await readGatewayErrorMessage(response),
      };
    }

    return {
      success: true,
      latencyMs: elapsed,
      message: `${modelId.trim()} の疎通に成功しました (${elapsed} ms)`,
    };
  } catch (err) {
    const elapsed = Math.max(
      1,
      Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - startedAt)
    );
    const msg =
      err instanceof DOMException && err.name === 'AbortError'
        ? '疎通テストがタイムアウト（20秒）または中断されました。'
        : err instanceof Error
        ? err.message
        : String(err);
    return {
      success: false,
      latencyMs: elapsed,
      message: msg,
    };
  } finally {
    clearTimeout(timeoutId);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}
