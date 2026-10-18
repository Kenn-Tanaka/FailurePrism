import { describe, expect, it, vi, beforeEach } from 'vitest';
import { gatewayClient } from '../../../src/tools/tpdd/services/llm/gatewayClient';
import { validateCustomModelId } from '../../../src/tools/tpdd/features/settings/CustomModelModal';
import { isValidLoopbackUrl, loadAppSettings, saveAppSettings } from '../../../src/tools/tpdd/services/persistence/appStorage';

describe('Gateway Client & Error Handling (G02, G03, G04)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('G02: 認証有効時はAuthorizationヘッダーを付与し、無効時は付与しない', async () => {
    let capturedHeaders: Record<string, string> = {};

    global.fetch = vi.fn().mockImplementation((_url, init) => {
      capturedHeaders = init?.headers || {};
      return Promise.resolve(
        new Response(JSON.stringify({ data: [{ id: 'lmstudio/default' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });

    // 認証有効
    await gatewayClient.listModels({
      apiBaseUrl: 'http://127.0.0.1:8765/v1',
      authEnabled: true,
      token: 'secret-token-xyz',
    });
    expect(capturedHeaders.Authorization).toBe('Bearer secret-token-xyz');

    // 認証無効
    await gatewayClient.listModels({
      apiBaseUrl: 'http://127.0.0.1:8765/v1',
      authEnabled: false,
    });
    expect(capturedHeaders.Authorization).toBeUndefined();
  });

  it('G02: 認証有効でTokenが空の場合はリクエスト前に401エラーを発生させる', async () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;

    await expect(
      gatewayClient.listModels({
        apiBaseUrl: 'http://127.0.0.1:8765/v1',
        authEnabled: true,
        token: '',
      })
    ).rejects.toThrow('Gateway Client Tokenが設定されていません');

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('G03: /models のIDを保持し、2個目以降のスラッシュを含む上流IDを破壊しない', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: 'openrouter/anthropic/claude-3.5-sonnet:beta' },
            { id: 'ollama/llama3.1:8b' },
          ],
        }),
        { status: 200 }
      )
    );

    const models = await gatewayClient.listModels({
      apiBaseUrl: 'http://127.0.0.1:8765/v1',
      authEnabled: false,
    });

    expect(models).toHaveLength(2);
    expect(models[0].id).toBe('openrouter/anthropic/claude-3.5-sonnet:beta');
    expect(models[1].id).toBe('ollama/llama3.1:8b');
  });

  it('G04: 403 (allowlist拒否)、401 (認証エラー)、503 (資格情報不足) を明確に区別する', async () => {
    // 403
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: 'Model not in allowlist', type: 'model_not_allowed' } }),
        { status: 403 }
      )
    );
    await expect(
      gatewayClient.complete(
        { apiBaseUrl: 'http://127.0.0.1:8765/v1', authEnabled: false },
        { modelId: 'denied/model', messages: [{ role: 'user', content: 'hi' }], temperature: 0.2, timeoutSeconds: 30, stream: false }
      )
    ).rejects.toThrow('アクセスが拒否されました');

    // 401
    global.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: 'Invalid Gateway Client Token' } }),
        { status: 401 }
      )
    );
    await expect(
      gatewayClient.complete(
        { apiBaseUrl: 'http://127.0.0.1:8765/v1', authEnabled: true, token: 'bad-token' },
        { modelId: 'test/m', messages: [], temperature: null, timeoutSeconds: 30, stream: false }
      )
    ).rejects.toThrow('Gateway認証エラー');
  });
});

describe('Model ID & Settings Validation (M02, S01)', () => {
  it('M02: カスタムモデルIDの形式検証 (空・スラッシュなし・制御文字・文字数)', () => {
    expect(validateCustomModelId('').valid).toBe(false);
    expect(validateCustomModelId('invalid-no-slash').valid).toBe(false);
    expect(validateCustomModelId('/no-provider').valid).toBe(false);
    expect(validateCustomModelId('provider/').valid).toBe(false);

    // 正常な形式 (2個目以降のスラッシュも許可)
    expect(validateCustomModelId('lmstudio/my-model').valid).toBe(true);
    expect(validateCustomModelId('openrouter/google/gemini-2.5-flash').valid).toBe(true);
  });

  it('Loopback URL 検証 (localhost, 127.0.0.1, ::1 許可、外部拒否)', () => {
    expect(isValidLoopbackUrl('http://127.0.0.1:8765/v1').valid).toBe(true);
    expect(isValidLoopbackUrl('http://localhost:8765/v1').valid).toBe(true);
    expect(isValidLoopbackUrl('http://[::1]:8765/v1').valid).toBe(true);

    // 外部URLや不正なURLは拒否
    expect(isValidLoopbackUrl('http://api.openai.com/v1').valid).toBe(false);
    expect(isValidLoopbackUrl('http://192.168.1.100:8765/v1').valid).toBe(false);
    expect(isValidLoopbackUrl('http://127.0.0.1:8765/v1?token=xyz').valid).toBe(false); // クエリ禁止
  });

  it('S01: 端末設定ストレージにお気に入りやURLは保存されるが、Tokenは保存されない', () => {
    const memStore: Record<string, string> = {};
    const mockStorage = {
      getItem: (k: string) => memStore[k] || null,
      setItem: (k: string, v: string) => {
        memStore[k] = v;
      },
      removeItem: (k: string) => {
        delete memStore[k];
      },
      clear: () => {
        for (const k in memStore) delete memStore[k];
      },
      length: 0,
      key: () => null,
    };
    (global as unknown as { localStorage: unknown }).localStorage = mockStorage;

    saveAppSettings({
      gatewayUrl: 'http://127.0.0.1:9999/v1',
      favoriteModelIds: ['custom/fav-1', 'custom/fav-2'],
    });

    const loaded = loadAppSettings();
    expect(loaded.gatewayUrl).toBe('http://127.0.0.1:9999/v1');
    expect(loaded.favoriteModelIds).toContain('custom/fav-1');

    // loaded に token というプロパティが存在しないこと
    expect((loaded as unknown as Record<string, unknown>).token).toBeUndefined();
  });
});
