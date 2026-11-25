import { isValidLoopbackUrl, validateCatalogFetchUrl } from '../../../shared/llm/gatewayUrl';
import { validateModelId } from '../../../shared/llm/modelTypes';

export interface LLMManagerConnection {
  gatewayUrl: string;
  gatewayAuthEnabled: boolean;
  gatewayToken: string;
}

export interface DiscoveredGatewayModel {
  id: string;
  name?: string;
  description?: string;
  contextLength?: number;
  isReasoningHint?: boolean;
}

export type ModelCatalogSourceId = 'gateway' | 'openrouter' | 'custom_https' | 'vta_cache';

export interface DiscoveredModelsCacheSnapshot {
  sourceId: ModelCatalogSourceId;
  sourceLabel: string;
  fetchedAt: string;
  models: DiscoveredGatewayModel[];
}

export interface PingModelResult {
  success: boolean;
  latencyMs: number;
  message: string;
}

const CONNECTION_STORAGE_KEY = 'failureprism_llm_manager_connection';
export const DISCOVERED_CACHE_STORAGE_KEY = 'failureprism_llm_discovered_models_v1';
export const VTA_DISCOVERED_STORAGE_KEY = 'vta_discovered_models';
export const DEFAULT_GATEWAY_URL = '/v1';
export const OPENROUTER_PUBLIC_API_URL = 'https://openrouter.ai/api/v1';
const MAX_EXTERNAL_CATALOG_BYTES = 8 * 1024 * 1024;
const MAX_CACHED_DESCRIPTION_CHARS = 240;

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

function sanitizeBriefDescription(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const compact = raw.replace(/\s+/g, ' ').trim();
  if (!compact) return undefined;
  if (compact.length <= MAX_CACHED_DESCRIPTION_CHARS) return compact;
  return `${compact.slice(0, MAX_CACHED_DESCRIPTION_CHARS - 1).trimEnd()}…`;
}

function extractDiscoveredModelRecord(item: unknown): DiscoveredGatewayModel | null {
  if (!item || typeof item !== 'object' || !('id' in item)) return null;
  const rawId = (item as { id?: unknown }).id;
  if (typeof rawId !== 'string' || !rawId.trim()) return null;

  const rec = item as {
    id: string;
    name?: unknown;
    description?: unknown;
    context_length?: unknown;
    contextLength?: unknown;
    isReasoning?: unknown;
    isReasoningHint?: unknown;
    supported_parameters?: unknown;
  };

  const name = typeof rec.name === 'string' && rec.name.trim() ? rec.name.trim() : undefined;
  const description = sanitizeBriefDescription(rec.description);
  const rawCtx =
    typeof rec.context_length === 'number'
      ? rec.context_length
      : typeof rec.contextLength === 'number'
      ? rec.contextLength
      : undefined;
  const contextLength =
    typeof rawCtx === 'number' && Number.isFinite(rawCtx) && rawCtx > 0
      ? Math.floor(rawCtx)
      : undefined;

  const hasReasoningParam =
    Array.isArray(rec.supported_parameters) &&
    rec.supported_parameters.some(
      (p) => typeof p === 'string' && (p === 'reasoning' || p === 'include_reasoning')
    );
  const isReasoningHint =
    rec.isReasoning === true || rec.isReasoningHint === true || hasReasoningParam
      ? true
      : undefined;

  return {
    id: rec.id.trim(),
    ...(name ? { name } : {}),
    ...(description ? { description } : {}),
    ...(contextLength !== undefined ? { contextLength } : {}),
    ...(isReasoningHint ? { isReasoningHint: true } : {}),
  };
}

/**
 * Fetches `/models` from an external HTTPS catalog (e.g. OpenRouter `https://openrouter.ai/api/v1`)
 * or local endpoint WITHOUT ever reading or sending the shared Gateway Token (COM-N01).
 */
export async function fetchExternalCatalogModels(
  baseUrl: string,
  options?: {
    upstreamApiKey?: string;
    signal?: AbortSignal;
  }
): Promise<DiscoveredGatewayModel[]> {
  const urlCheck = validateCatalogFetchUrl(baseUrl);
  if (!urlCheck.valid || !urlCheck.normalizedBaseUrl) {
    throw new Error(urlCheck.message || 'カタログ取得先URLが不正です。');
  }

  const endpoint = `${urlCheck.normalizedBaseUrl}/models`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (options?.upstreamApiKey && options.upstreamApiKey.trim()) {
    headers.Authorization = `Bearer ${options.upstreamApiKey.trim()}`;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);
  const onExternalAbort = () => controller.abort();
  options?.signal?.addEventListener('abort', onExternalAbort, { once: true });

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
    if (text.length > MAX_EXTERNAL_CATALOG_BYTES) {
      throw new Error('モデル一覧の応答サイズが上限 (8 MiB) を超えています。');
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('エンドポイントからの応答が有効なJSONではありません。');
    }

    if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { data?: unknown }).data)) {
      throw new Error('モデル一覧の応答形式が不正です（data配列がありません）。');
    }

    const seen = new Set<string>();
    const results: DiscoveredGatewayModel[] = [];
    for (const item of (parsed as { data: unknown[] }).data) {
      const extracted = extractDiscoveredModelRecord(item);
      if (extracted && !seen.has(extracted.id)) {
        seen.add(extracted.id);
        results.push(extracted);
      }
    }
    return results;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('モデル一覧の取得がタイムアウトまたは中断されました。');
    }
    if (err instanceof TypeError || (err instanceof Error && err.message.includes('Failed to fetch'))) {
      throw new Error(
        'モデルカタログエンドポイントに接続できませんでした（ネットワーク状態またはCORS制限を確認してください）。'
      );
    }
    throw err instanceof Error ? err : new Error(String(err));
  } finally {
    clearTimeout(timeoutId);
    options?.signal?.removeEventListener('abort', onExternalAbort);
  }
}

/**
 * Reads models previously fetched inside VTA (`vta_discovered_models` in localStorage), if any.
 */
export function loadVtaDiscoveredModelsCache(): DiscoveredGatewayModel[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(VTA_DISCOVERED_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const results: DiscoveredGatewayModel[] = [];
    for (const item of parsed) {
      const extracted = extractDiscoveredModelRecord(item);
      if (extracted && !seen.has(extracted.id)) {
        seen.add(extracted.id);
        results.push(extracted);
      }
    }
    return results;
  } catch {
    return [];
  }
}

export function loadDiscoveredModelsCache(): DiscoveredModelsCacheSnapshot | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(DISCOVERED_CACHE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DiscoveredModelsCacheSnapshot>;
    if (!parsed || !Array.isArray(parsed.models)) return null;
    const seen = new Set<string>();
    const models: DiscoveredGatewayModel[] = [];
    for (const item of parsed.models) {
      const extracted = extractDiscoveredModelRecord(item);
      if (extracted && !seen.has(extracted.id)) {
        seen.add(extracted.id);
        models.push(extracted);
      }
    }
    if (models.length === 0) return null;
    const validSources: ModelCatalogSourceId[] = ['gateway', 'openrouter', 'custom_https', 'vta_cache'];
    const sourceId = validSources.includes(parsed.sourceId as ModelCatalogSourceId)
      ? (parsed.sourceId as ModelCatalogSourceId)
      : 'gateway';
    return {
      sourceId,
      sourceLabel: typeof parsed.sourceLabel === 'string' ? parsed.sourceLabel : sourceId,
      fetchedAt: typeof parsed.fetchedAt === 'string' ? parsed.fetchedAt : '',
      models,
    };
  } catch {
    return null;
  }
}

export function saveDiscoveredModelsCache(snapshot: DiscoveredModelsCacheSnapshot): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(
      DISCOVERED_CACHE_STORAGE_KEY,
      JSON.stringify({
        sourceId: snapshot.sourceId,
        sourceLabel: snapshot.sourceLabel,
        fetchedAt: snapshot.fetchedAt,
        models: snapshot.models,
      })
    );
  } catch {
    // Ignore storage quota / security errors
  }
}
